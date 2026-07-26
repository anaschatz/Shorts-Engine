"""Truthful direct-pipeline URL-to-output benchmark reports for the Shorts engine.

This module consumes the raw :class:`PerformanceTelemetry` report emitted by
the pipeline.  It intentionally uses interval unions instead of summing stage
durations: nested stages and future audio/video overlap would otherwise make a
run appear slower than its actual wall time.

Run a real isolated cold/warm pair with::

    python -m shorts_generator.benchmark URL --cold-warm \
        --cache-root /tmp/shorts-benchmark-cache --num-clips 3

The cold/warm command never deletes a cache.  It requires a new or empty cache
root and runs the same URL/configuration twice in one process.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any


BENCHMARK_SCHEMA_VERSION = 1
CANONICAL_STAGE_ORDER = (
    "download",
    "transcript",
    "discoveryRanking",
    "render",
    "qa",
)

_EXACT_STAGE_GROUPS = {
    "download": "download",
    "source_download": "download",
    "transcription": "transcript",
    "transcript": "transcript",
    "candidate_generation": "discoveryRanking",
    "candidate_visual_analysis": "discoveryRanking",
    "candidate_ranking": "discoveryRanking",
    "source_hash": "discoveryRanking",
    "ranking_manifest": "discoveryRanking",
    "render_cache_lookup": "render",
    "render_batch": "render",
    "rendered_cut_analysis": "qa",
    "editorial_qa": "qa",
    "audio_qa": "qa",
    "creative_qa": "qa",
}

_ONE_PASS_EXACT_BOUNDARIES = {
    "download": ("download", "source_download"),
    "transcript": ("transcription", "transcript"),
    "candidateGeneration": ("candidate_generation",),
    "candidateRanking": ("candidate_ranking",),
    "renderBatch": ("render_batch", "production.render_batch"),
}


class BenchmarkValidationError(RuntimeError):
    """Raised when an enforced benchmark is not a complete one-pass run."""


def _round_seconds(value: float) -> float:
    return round(max(0.0, float(value)), 6)


def _round_delta(value: float) -> float:
    """Round a signed comparison without hiding a warm-run regression."""

    return round(float(value), 6)


def _canonical_group(stage_name: str) -> str | None:
    name = str(stage_name or "").strip()
    exact = _EXACT_STAGE_GROUPS.get(name)
    if exact:
        return exact
    if name.startswith("production.render"):
        return "render"
    if name.startswith("production.qa"):
        return "qa"
    if name.startswith("production.prepare"):
        return "discoveryRanking"
    return None


def _validated_events(performance_report: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw_events = performance_report.get("stages")
    if not isinstance(raw_events, list):
        raise BenchmarkValidationError("performance report must contain a stages list")
    overall = performance_report.get("durationSeconds")
    if isinstance(overall, bool) or not isinstance(overall, (int, float)) or overall < 0:
        raise BenchmarkValidationError("performance report durationSeconds is invalid")
    events = []
    for index, raw in enumerate(raw_events):
        if not isinstance(raw, Mapping):
            raise BenchmarkValidationError(f"stage event {index} must be an object")
        name = str(raw.get("name") or "").strip()
        start = raw.get("startedOffsetSeconds")
        duration = raw.get("durationSeconds")
        if not name:
            raise BenchmarkValidationError(f"stage event {index} has no name")
        if (
            isinstance(start, bool)
            or not isinstance(start, (int, float))
            or start < 0
            or isinstance(duration, bool)
            or not isinstance(duration, (int, float))
            or duration < 0
        ):
            raise BenchmarkValidationError(f"stage event {name!r} has invalid timing")
        end = float(start) + float(duration)
        if end > float(overall) + 0.05:
            raise BenchmarkValidationError(
                f"stage event {name!r} extends beyond overall wall time"
            )
        events.append(
            {
                "name": name,
                "status": str(raw.get("status") or ""),
                "start": float(start),
                "end": end,
                "duration": float(duration),
            }
        )
    return events


def _union_seconds(events: Sequence[Mapping[str, Any]]) -> float:
    intervals = sorted(
        (float(event["start"]), float(event["end"]))
        for event in events
        if float(event["end"]) > float(event["start"])
    )
    if not intervals:
        return 0.0
    total = 0.0
    current_start, current_end = intervals[0]
    for start, end in intervals[1:]:
        if start <= current_end:
            current_end = max(current_end, end)
        else:
            total += current_end - current_start
            current_start, current_end = start, end
    total += current_end - current_start
    return _round_seconds(total)


def _cache_summary(raw_counters: Any) -> dict[str, Any]:
    if raw_counters is None:
        raw_counters = {}
    if not isinstance(raw_counters, Mapping):
        raise BenchmarkValidationError("cacheCounters must be an object")
    by_cache: dict[str, Any] = {}
    total_hits = 0
    total_misses = 0
    for raw_name in sorted(raw_counters):
        name = str(raw_name)
        counter = raw_counters[raw_name]
        if not isinstance(counter, Mapping):
            raise BenchmarkValidationError(f"cache counter {name!r} must be an object")
        hits = counter.get("hits", 0)
        misses = counter.get("misses", 0)
        if (
            isinstance(hits, bool)
            or not isinstance(hits, int)
            or hits < 0
            or isinstance(misses, bool)
            or not isinstance(misses, int)
            or misses < 0
        ):
            raise BenchmarkValidationError(f"cache counter {name!r} is invalid")
        requests = hits + misses
        state = (
            "unobserved"
            if requests == 0
            else "cold"
            if hits == 0
            else "warm"
            if misses == 0
            else "mixed"
        )
        by_cache[name] = {
            "state": state,
            "hits": hits,
            "misses": misses,
            "requests": requests,
            "hitRate": round(hits / requests, 6) if requests else 0.0,
        }
        total_hits += hits
        total_misses += misses
    requests = total_hits + total_misses
    observed_state = (
        "unobserved"
        if requests == 0
        else "cold"
        if total_hits == 0
        else "warm"
        if total_misses == 0
        else "mixed"
    )
    return {
        "observedState": observed_state,
        "hits": total_hits,
        "misses": total_misses,
        "requests": requests,
        "hitRate": round(total_hits / requests, 6) if requests else 0.0,
        "byCache": by_cache,
    }


def _output_summary(result: Mapping[str, Any] | None) -> dict[str, int | None]:
    if result is None:
        return {"expected": None, "succeeded": 0, "failed": 0}
    if isinstance(result.get("results"), list):
        outputs = result["results"]
        succeeded = sum(
            isinstance(item, Mapping) and item.get("status") == "succeeded"
            for item in outputs
        )
        failed = len(outputs) - succeeded
        expected = result.get("requestedCount", len(outputs))
        return {"expected": int(expected), "succeeded": succeeded, "failed": failed}
    shorts = result.get("shorts")
    if not isinstance(shorts, list):
        return {"expected": None, "succeeded": 0, "failed": 0}
    succeeded = sum(
        isinstance(item, Mapping)
        and bool(item.get("clip_url"))
        and not bool(item.get("error"))
        for item in shorts
    )
    failed = len(shorts) - succeeded
    ranking = result.get("ranking")
    expected = ranking.get("target_clips") if isinstance(ranking, Mapping) else None
    if not isinstance(expected, int):
        expected = len(shorts)
    return {"expected": expected, "succeeded": succeeded, "failed": failed}


def _boundary_count(events: Sequence[Mapping[str, Any]], names: Sequence[str]) -> int:
    accepted = set(names)
    return sum(event["name"] in accepted for event in events)


def _one_pass_summary(
    events: Sequence[Mapping[str, Any]],
    outputs: Mapping[str, Any],
    *,
    require_outputs: bool,
    require_qa: bool,
) -> dict[str, Any]:
    violations: list[str] = []
    pipeline_count = _boundary_count(events, ("pipeline",))
    if pipeline_count != 1:
        violations.append(f"expected one pipeline pass, observed {pipeline_count}")

    boundary_counts = {
        label: _boundary_count(events, names)
        for label, names in _ONE_PASS_EXACT_BOUNDARIES.items()
    }
    for label in ("download", "transcript", "candidateGeneration", "candidateRanking"):
        if boundary_counts[label] != 1:
            violations.append(
                f"expected one {label} pass, observed {boundary_counts[label]}"
            )
    if require_outputs and boundary_counts["renderBatch"] != 1:
        violations.append(
            f"expected one render batch, observed {boundary_counts['renderBatch']}"
        )

    qa_count = sum(_canonical_group(event["name"]) == "qa" for event in events)
    if require_qa and qa_count == 0:
        violations.append("QA timing is missing")
    failed_stage_names = [event["name"] for event in events if event["status"] != "ok"]
    if failed_stage_names:
        violations.append("failed stages: " + ", ".join(failed_stage_names))

    if require_outputs:
        if int(outputs.get("succeeded") or 0) <= 0:
            violations.append("no successful output was produced")
        if int(outputs.get("failed") or 0) > 0:
            violations.append(f"{outputs['failed']} output(s) failed")
        expected = outputs.get("expected")
        if isinstance(expected, int) and outputs.get("succeeded") != expected:
            violations.append(
                f"expected {expected} successful outputs, observed {outputs.get('succeeded')}"
            )
    return {
        "passed": not violations,
        "violations": violations,
        "pipelinePasses": pipeline_count,
        "boundaryCounts": boundary_counts,
        "qaEventCount": qa_count,
    }


def build_benchmark_report(
    performance_report: Mapping[str, Any],
    *,
    result: Mapping[str, Any] | None = None,
    outer_wall_seconds: float | None = None,
    expected_cache_state: str | None = None,
    require_outputs: bool = True,
    require_qa: bool = True,
    enforce_one_pass: bool = False,
) -> dict[str, Any]:
    """Build one canonical, non-double-counted end-to-end benchmark report."""

    if performance_report.get("artifactType") != "PerformanceReport":
        raise BenchmarkValidationError("expected a PerformanceReport artifact")
    if performance_report.get("finishedAt") is None:
        raise BenchmarkValidationError("performance report is not finished")
    events = _validated_events(performance_report)
    internal_wall = _round_seconds(float(performance_report["durationSeconds"]))
    external_wall = (
        internal_wall
        if outer_wall_seconds is None
        else _round_seconds(float(outer_wall_seconds))
    )
    if external_wall + 0.05 < internal_wall:
        raise BenchmarkValidationError(
            "outer wall time cannot be shorter than pipeline telemetry"
        )

    grouped: dict[str, list[dict[str, Any]]] = {
        name: [] for name in CANONICAL_STAGE_ORDER
    }
    for event in events:
        group = _canonical_group(event["name"])
        if group:
            grouped[group].append(event)
    stage_summary = {}
    for name in CANONICAL_STAGE_ORDER:
        group_events = grouped[name]
        stage_summary[name] = {
            "wallSeconds": _union_seconds(group_events),
            "eventCount": len(group_events),
            "errorCount": sum(event["status"] != "ok" for event in group_events),
            "eventNames": sorted({event["name"] for event in group_events}),
        }

    canonical_events = [event for values in grouped.values() for event in values]
    covered_wall = _union_seconds(canonical_events)
    summed_group_wall = sum(
        float(stage_summary[name]["wallSeconds"])
        for name in CANONICAL_STAGE_ORDER
    )
    cache = _cache_summary(performance_report.get("cacheCounters"))
    expected_state = str(expected_cache_state or "").strip().lower() or None
    if expected_state not in {None, "cold", "warm", "mixed", "unobserved"}:
        raise ValueError("expected_cache_state must be cold, warm, mixed, or unobserved")
    cache_expectation_passed = (
        expected_state is None or cache["observedState"] == expected_state
    )
    outputs = _output_summary(result)
    one_pass = _one_pass_summary(
        events,
        outputs,
        require_outputs=require_outputs,
        require_qa=require_qa,
    )
    validation_violations = list(one_pass["violations"])
    if expected_state is not None and not cache_expectation_passed:
        validation_violations.append(
            f"expected {expected_state} cache state, observed {cache['observedState']}"
        )
    validation_passed = not validation_violations
    if enforce_one_pass and not validation_passed:
        raise BenchmarkValidationError("; ".join(validation_violations))

    metadata = performance_report.get("metadata")
    if not isinstance(metadata, Mapping):
        metadata = {}
    return {
        "schemaVersion": BENCHMARK_SCHEMA_VERSION,
        "artifactType": "EndToEndBenchmarkReport",
        "runId": performance_report.get("runId"),
        "startedAt": performance_report.get("startedAt"),
        "finishedAt": performance_report.get("finishedAt"),
        "sourceInput": metadata.get("sourceInput"),
        "overallWallSeconds": external_wall,
        "pipelineReportedSeconds": internal_wall,
        "wrapperOverheadSeconds": _round_seconds(external_wall - internal_wall),
        "canonicalCoveredWallSeconds": covered_wall,
        "uninstrumentedPipelineSeconds": _round_seconds(internal_wall - covered_wall),
        "parallelOverlapSeconds": _round_seconds(summed_group_wall - covered_wall),
        "stages": stage_summary,
        "cache": {
            **cache,
            "expectedState": expected_state,
            "expectationPassed": cache_expectation_passed,
        },
        "outputs": outputs,
        "onePass": one_pass,
        "validation": {
            "passed": validation_passed,
            "violations": validation_violations,
        },
        "performanceReportSchemaVersion": performance_report.get("schemaVersion"),
    }


def _read_performance_report(result: Mapping[str, Any]) -> dict[str, Any]:
    performance = result.get("performance")
    if not isinstance(performance, Mapping):
        raise BenchmarkValidationError("pipeline result has no performance block")
    report_path = performance.get("report_path")
    if not report_path:
        raise BenchmarkValidationError("pipeline result has no performance report path")
    try:
        payload = json.loads(Path(str(report_path)).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BenchmarkValidationError("performance report could not be read") from error
    if not isinstance(payload, dict):
        raise BenchmarkValidationError("performance report must be an object")
    return payload


def benchmark_generate_call(
    generate: Callable[..., Mapping[str, Any]],
    generate_kwargs: Mapping[str, Any],
    *,
    expected_cache_state: str | None = None,
    require_outputs: bool = True,
    require_qa: bool = True,
    enforce_one_pass: bool = True,
    clock: Callable[[], float] = time.perf_counter,
) -> tuple[dict[str, Any], Mapping[str, Any]]:
    """Measure one generate call from invocation through returned outputs."""

    started = float(clock())
    result = generate(**dict(generate_kwargs))
    ended = float(clock())
    performance_report = _read_performance_report(result)
    benchmark = build_benchmark_report(
        performance_report,
        result=result,
        outer_wall_seconds=ended - started,
        expected_cache_state=expected_cache_state,
        require_outputs=require_outputs,
        require_qa=require_qa,
        enforce_one_pass=enforce_one_pass,
    )
    return benchmark, result


def build_cold_warm_comparison(
    cold: Mapping[str, Any],
    warm: Mapping[str, Any],
) -> dict[str, Any]:
    """Compare two already validated runs without hiding regressions."""

    if cold.get("artifactType") != "EndToEndBenchmarkReport":
        raise BenchmarkValidationError("cold input is not an end-to-end benchmark")
    if warm.get("artifactType") != "EndToEndBenchmarkReport":
        raise BenchmarkValidationError("warm input is not an end-to-end benchmark")
    if cold.get("sourceInput") != warm.get("sourceInput"):
        raise BenchmarkValidationError("cold and warm runs use different source inputs")
    if cold.get("outputs", {}).get("expected") != warm.get("outputs", {}).get("expected"):
        raise BenchmarkValidationError("cold and warm runs target different output counts")
    cold_wall = float(cold.get("overallWallSeconds") or 0.0)
    warm_wall = float(warm.get("overallWallSeconds") or 0.0)
    stage_comparison = {}
    for name in CANONICAL_STAGE_ORDER:
        cold_stage = float(cold.get("stages", {}).get(name, {}).get("wallSeconds") or 0.0)
        warm_stage = float(warm.get("stages", {}).get(name, {}).get("wallSeconds") or 0.0)
        stage_comparison[name] = {
            "coldSeconds": _round_seconds(cold_stage),
            "warmSeconds": _round_seconds(warm_stage),
            "savedSeconds": _round_delta(cold_stage - warm_stage),
            "speedup": round(cold_stage / warm_stage, 4) if warm_stage > 0 else None,
        }
    return {
        "schemaVersion": BENCHMARK_SCHEMA_VERSION,
        "artifactType": "ColdWarmBenchmarkComparison",
        "cold": dict(cold),
        "warm": dict(warm),
        "comparison": {
            "coldSeconds": _round_seconds(cold_wall),
            "warmSeconds": _round_seconds(warm_wall),
            "savedSeconds": _round_delta(cold_wall - warm_wall),
            "speedup": round(cold_wall / warm_wall, 4) if warm_wall > 0 else None,
            "bothOnePass": bool(cold.get("onePass", {}).get("passed"))
            and bool(warm.get("onePass", {}).get("passed")),
            "cacheTransitionPassed": cold.get("cache", {}).get("observedState") == "cold"
            and warm.get("cache", {}).get("observedState") == "warm",
            "stages": stage_comparison,
        },
    }


def write_benchmark_report(
    report: Mapping[str, Any],
    path: str | os.PathLike[str],
) -> Path:
    """Atomically persist one benchmark or comparison report."""

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
        dir=target.parent,
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


def isolated_cache_environment(
    cache_root: str | os.PathLike[str],
    output_root: str | os.PathLike[str],
    *,
    require_empty: bool,
) -> dict[str, str]:
    """Return explicit cache/output variables for a reproducible benchmark."""

    cache = Path(cache_root).expanduser().resolve()
    output = Path(output_root).expanduser().resolve()
    if require_empty and cache.exists() and any(cache.iterdir()):
        raise BenchmarkValidationError(
            f"cold benchmark cache root is not empty: {cache}"
        )
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    return {
        "LOCAL_CACHE_DIR": str(cache),
        "LOCAL_WORK_DIR": str(cache / "work"),
        "LOCAL_SOURCE_CACHE_DIR": str(cache / "sources"),
        "LOCAL_TRANSCRIPT_CACHE_DIR": str(cache / "transcripts"),
        "LOCAL_CANDIDATE_CACHE_DIR": str(cache / "candidate-cache"),
        "LOCAL_SHOT_CACHE_DIR": str(cache / "shot-cache"),
        "LOCAL_VISUAL_ANALYSIS_CACHE_DIR": str(cache / "visual-analysis-v1"),
        "LOCAL_CANDIDATE_VISUAL_CACHE_DIR": str(
            cache / "visual-analysis-v1" / "candidate-metrics-v1"
        ),
        "LOCAL_RENDER_CACHE_DIR": str(cache / "production-renders-v1"),
        "LOCAL_REAL_ESRGAN_CACHE_DIR": str(cache / "realesrgan-v2"),
        "LOCAL_OUTPUT_DIR": str(output),
        "LOCAL_PERFORMANCE_REPORT_DIR": str(output / "performance"),
    }


def _parse_positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _print_run(label: str, report: Mapping[str, Any]) -> None:
    print(f"{label}: {report['overallWallSeconds']:.2f}s ({report['cache']['observedState']})")
    for name in CANONICAL_STAGE_ORDER:
        stage = report["stages"][name]
        print(f"  {name:18s} {stage['wallSeconds']:8.2f}s")
    print(
        f"  outputs            {report['outputs']['succeeded']}/"
        f"{report['outputs']['expected']}  one-pass={report['onePass']['passed']}"
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Measure truthful direct generate_shorts wall time",
    )
    parser.add_argument("url")
    parser.add_argument("--cache-root", required=True)
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--report", default=None)
    parser.add_argument("--cold-warm", action="store_true")
    parser.add_argument("--expected-cache-state", choices=["cold", "warm", "mixed"])
    parser.add_argument("--mode", choices=["local", "api"], default="local")
    parser.add_argument("--num-clips", type=_parse_positive_int, default=3)
    parser.add_argument("--format", default="720")
    parser.add_argument("--language", default=None)
    parser.add_argument("--content-profile", default=None)
    parser.add_argument("--selection-profile", default=None)
    parser.add_argument("--render-profile", default=None)
    parser.add_argument("--format-profile", default=None)
    parser.add_argument(
        "--allow-missing-qa",
        action="store_true",
        help="Diagnostic only: do not fail when the selected profile has no QA stage",
    )
    args = parser.parse_args(argv)

    cache_root = Path(args.cache_root).expanduser().resolve()
    output_root = (
        Path(args.output_dir).expanduser().resolve()
        if args.output_dir
        else cache_root / "benchmark-output"
    )
    try:
        environment = isolated_cache_environment(
            cache_root,
            output_root,
            require_empty=args.cold_warm,
        )
    except BenchmarkValidationError as error:
        parser.error(str(error))
    os.environ.update(environment)

    # Config reads environment at import time; importing lazily here keeps the
    # isolated cache contract truthful.
    from shorts_generator import generate_shorts

    kwargs = {
        "youtube_url": args.url,
        "num_clips": args.num_clips,
        "download_format": args.format,
        "language": args.language,
        "mode": args.mode,
        "content_profile": args.content_profile,
        "selection_profile": args.selection_profile,
        "render_profile": args.render_profile,
        "format_profile": args.format_profile,
    }
    try:
        if args.cold_warm:
            cold, _ = benchmark_generate_call(
                generate_shorts,
                kwargs,
                expected_cache_state="cold",
                require_qa=not args.allow_missing_qa,
            )
            warm, _ = benchmark_generate_call(
                generate_shorts,
                kwargs,
                expected_cache_state="warm",
                require_qa=not args.allow_missing_qa,
            )
            report = build_cold_warm_comparison(cold, warm)
            _print_run("cold", cold)
            _print_run("warm", warm)
            print(f"speedup: {report['comparison']['speedup']}x")
        else:
            report, _ = benchmark_generate_call(
                generate_shorts,
                kwargs,
                expected_cache_state=args.expected_cache_state,
                require_qa=not args.allow_missing_qa,
            )
            _print_run("run", report)
    except (BenchmarkValidationError, RuntimeError, ValueError) as error:
        print(f"BENCHMARK FAILED: {error}", file=sys.stderr)
        return 1

    report_path = (
        Path(args.report).expanduser().resolve()
        if args.report
        else output_root / "benchmark.json"
    )
    written = write_benchmark_report(report, report_path)
    print(f"report: {written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
