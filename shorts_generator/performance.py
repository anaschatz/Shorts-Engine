"""Dependency-free performance telemetry for Shorts engine runs.

The tracker is intentionally independent from pipeline code.  Callers can time
overlapping stages, record cache decisions, and atomically persist a compact
JSON report without changing any media-processing behavior.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, Mapping, Optional


PERFORMANCE_REPORT_SCHEMA_VERSION = 1


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_text(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _round_seconds(value: float) -> float:
    return round(max(0.0, float(value)), 6)


def _json_copy(value: Any, label: str) -> Any:
    """Return a detached JSON-compatible copy or fail at the API boundary."""
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
        )
    except (TypeError, ValueError) as error:
        raise TypeError(f"{label} must be JSON serializable") from error
    return json.loads(encoded)


class PerformanceTelemetry:
    """Collect monotonic stage timings and cache counters for one engine run.

    Instances are thread-safe.  This allows independent download, analysis,
    render, and QA workers to share one tracker when the pipeline runs stages
    concurrently.
    """

    def __init__(
        self,
        run_id: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        *,
        clock: Callable[[], float] = time.perf_counter,
        utc_clock: Callable[[], datetime] = _utc_now,
    ):
        normalized_run_id = str(run_id or uuid.uuid4().hex).strip()
        if not normalized_run_id:
            raise ValueError("run_id must not be empty")
        self.run_id = normalized_run_id
        self._metadata = _json_copy(dict(metadata or {}), "metadata")
        self._clock = clock
        self._utc_clock = utc_clock
        self._lock = threading.RLock()
        self._started_monotonic = float(self._clock())
        self._started_at = self._utc_clock()
        self._finished_monotonic: Optional[float] = None
        self._finished_at: Optional[datetime] = None
        self._stages = []
        self._cache_counters: Dict[str, Dict[str, int]] = {}
        self._active_stages = 0
        self._next_sequence = 0

    def _ensure_open(self) -> None:
        if self._finished_monotonic is not None:
            raise RuntimeError("performance telemetry is already finished")

    @contextmanager
    def stage(self, name: str, **attributes: Any) -> Iterator[None]:
        """Time one stage with a monotonic clock and record failures.

        Exceptions are never swallowed.  A failed stage is recorded with its
        exception type before the original exception is re-raised.
        """
        normalized_name = str(name or "").strip()
        if not normalized_name:
            raise ValueError("stage name must not be empty")
        safe_attributes = _json_copy(attributes, "stage attributes")
        with self._lock:
            self._ensure_open()
            sequence = self._next_sequence
            self._next_sequence += 1
            self._active_stages += 1
            started = float(self._clock())

        status = "ok"
        error_type = None
        try:
            yield
        except BaseException as error:
            status = "error"
            error_type = type(error).__name__
            raise
        finally:
            ended = float(self._clock())
            event = {
                "name": normalized_name,
                "sequence": sequence,
                "status": status,
                "startedOffsetSeconds": _round_seconds(
                    started - self._started_monotonic
                ),
                "durationSeconds": _round_seconds(ended - started),
            }
            if safe_attributes:
                event["attributes"] = safe_attributes
            if error_type:
                event["errorType"] = error_type
            with self._lock:
                self._stages.append(event)
                self._active_stages -= 1

    def record_cache(self, name: str, *, hit: bool, count: int = 1) -> None:
        """Record one or more cache lookups for a named cache."""
        normalized_name = str(name or "").strip()
        if not normalized_name:
            raise ValueError("cache name must not be empty")
        if not isinstance(hit, bool):
            raise TypeError("hit must be a bool")
        if isinstance(count, bool) or not isinstance(count, int) or count <= 0:
            raise ValueError("count must be a positive integer")
        with self._lock:
            self._ensure_open()
            counter = self._cache_counters.setdefault(
                normalized_name,
                {"hits": 0, "misses": 0},
            )
            counter["hits" if hit else "misses"] += count

    def cache_hit(self, name: str, count: int = 1) -> None:
        self.record_cache(name, hit=True, count=count)

    def cache_miss(self, name: str, count: int = 1) -> None:
        self.record_cache(name, hit=False, count=count)

    def _snapshot_locked(
        self,
        current_monotonic: float,
        finished_at: Optional[datetime],
    ) -> Dict[str, Any]:
        stages = sorted(
            (_json_copy(event, "stage event") for event in self._stages),
            key=lambda event: event["sequence"],
        )
        stage_totals: Dict[str, Dict[str, Any]] = {}
        for event in stages:
            total = stage_totals.setdefault(
                event["name"],
                {"count": 0, "errorCount": 0, "durationSeconds": 0.0},
            )
            total["count"] += 1
            total["errorCount"] += int(event["status"] == "error")
            total["durationSeconds"] += event["durationSeconds"]
        for total in stage_totals.values():
            total["durationSeconds"] = _round_seconds(total["durationSeconds"])

        cache_counters: Dict[str, Dict[str, Any]] = {}
        total_hits = 0
        total_misses = 0
        for name in sorted(self._cache_counters):
            hits = self._cache_counters[name]["hits"]
            misses = self._cache_counters[name]["misses"]
            requests = hits + misses
            cache_counters[name] = {
                "hits": hits,
                "misses": misses,
                "requests": requests,
                "hitRate": round(hits / requests, 6) if requests else 0.0,
            }
            total_hits += hits
            total_misses += misses
        total_requests = total_hits + total_misses
        elapsed = _round_seconds(current_monotonic - self._started_monotonic)
        return {
            "schemaVersion": PERFORMANCE_REPORT_SCHEMA_VERSION,
            "artifactType": "PerformanceReport",
            "runId": self.run_id,
            "startedAt": _utc_text(self._started_at),
            "finishedAt": _utc_text(finished_at) if finished_at else None,
            "durationSeconds": elapsed,
            "metadata": _json_copy(self._metadata, "metadata"),
            "stages": stages,
            "stageTotals": stage_totals,
            "cacheCounters": cache_counters,
            "summary": {
                "stageInvocationCount": len(stages),
                "stageErrorCount": sum(
                    event["status"] == "error" for event in stages
                ),
                "stageDurationSeconds": _round_seconds(
                    sum(event["durationSeconds"] for event in stages)
                ),
                "cacheHits": total_hits,
                "cacheMisses": total_misses,
                "cacheRequests": total_requests,
                "cacheHitRate": (
                    round(total_hits / total_requests, 6)
                    if total_requests
                    else 0.0
                ),
            },
        }

    def snapshot(self) -> Dict[str, Any]:
        """Return a detached report snapshot without closing the tracker."""
        with self._lock:
            current = (
                self._finished_monotonic
                if self._finished_monotonic is not None
                else float(self._clock())
            )
            return self._snapshot_locked(current, self._finished_at)

    def finish(self) -> Dict[str, Any]:
        """Freeze the run and return its final report.

        Finishing while a stage is still active is rejected so a persisted
        final report cannot silently omit work that is still running.
        """
        with self._lock:
            if self._finished_monotonic is None:
                if self._active_stages:
                    raise RuntimeError(
                        "cannot finish performance telemetry with active stages"
                    )
                self._finished_monotonic = float(self._clock())
                self._finished_at = self._utc_clock()
            return self._snapshot_locked(
                self._finished_monotonic,
                self._finished_at,
            )

    def write_report(
        self,
        path: os.PathLike[str] | str,
        *,
        finish: bool = True,
    ) -> Path:
        """Atomically write a JSON report and return its resolved target path."""
        report = self.finish() if finish else self.snapshot()
        encoded = json.dumps(
            report,
            indent=2,
            sort_keys=True,
            ensure_ascii=True,
            allow_nan=False,
        ) + "\n"
        target = Path(path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{target.name}.",
            suffix=".tmp",
            dir=str(target.parent),
        )
        descriptor_open = True
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                descriptor_open = False
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, target)
        finally:
            if descriptor_open:
                os.close(descriptor)
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
        return target
