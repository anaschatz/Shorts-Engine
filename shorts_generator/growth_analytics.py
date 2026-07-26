"""Equal-age analytics artifacts and cohort evaluation for Budget Friendly."""
from __future__ import annotations

import csv
import json
import os
import statistics
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from .artifact_contracts import ArtifactBindingError, content_hash


SNAPSHOT_GATES_HOURS = (1, 6, 24, 72, 168, 672)
DECISION_GATES_HOURS = (24, 72, 168, 672)
ANALYTICS_SOURCES = frozenset({"youtube_analytics_api", "studio_csv", "manual"})


def _parse_time(value: str) -> datetime:
    normalized = str(value or "").strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ArtifactBindingError(f"invalid ISO timestamp: {value}") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _number(value, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    if isinstance(value, str):
        value = value.strip().replace(",", "").replace("%", "")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError(f"invalid analytics number: {value}") from error
    if parsed < 0:
        raise ArtifactBindingError("analytics metrics cannot be negative")
    return parsed


def nearest_snapshot_gate(age_hours: float, tolerance_ratio: float = 0.20) -> Optional[int]:
    age = float(age_hours)
    candidates = [
        gate
        for gate in SNAPSHOT_GATES_HOURS
        if abs(age - gate) <= max(0.5, gate * tolerance_ratio)
    ]
    return min(candidates, key=lambda gate: abs(age - gate)) if candidates else None


def normalize_metrics(metrics: Dict) -> Dict:
    engaged = _number(metrics.get("engagedViews"))
    normalized = {
        "views": int(round(_number(metrics.get("views")))),
        "engagedViews": int(round(engaged)),
        "stayedToWatchPercent": round(_number(metrics.get("stayedToWatchPercent")), 4),
        "averageViewDurationSeconds": round(_number(metrics.get("averageViewDurationSeconds")), 4),
        "averagePercentageViewed": round(_number(metrics.get("averagePercentageViewed")), 4),
        "likes": int(round(_number(metrics.get("likes")))),
        "shares": int(round(_number(metrics.get("shares")))),
        "comments": int(round(_number(metrics.get("comments")))),
        "subscribersGained": int(round(_number(metrics.get("subscribersGained")))),
    }
    denominator = max(1.0, engaged)
    normalized.update(
        {
            "sharesPer1000Engaged": round(normalized["shares"] * 1000.0 / denominator, 6),
            "commentsPer1000Engaged": round(normalized["comments"] * 1000.0 / denominator, 6),
            "subscribersPer1000Engaged": round(
                normalized["subscribersGained"] * 1000.0 / denominator,
                6,
            ),
        }
    )
    return normalized


def build_analytics_snapshot(
    video_id: str,
    published_at: str,
    observed_at: str,
    metrics: Dict,
    source: str,
    experiment_id: str,
    cohort_id: str,
    treatment_id: str,
    pillar: str,
    duration_seconds: float,
) -> Dict:
    video_id = str(video_id or "").strip()
    if not video_id:
        raise ArtifactBindingError("video_id is required")
    published = _parse_time(published_at)
    observed = _parse_time(observed_at)
    age_hours = (observed - published).total_seconds() / 3600.0
    if age_hours < 0:
        raise ArtifactBindingError("snapshot predates publication")
    gate = nearest_snapshot_gate(age_hours)
    if gate is None:
        raise ArtifactBindingError("snapshot is outside all declared age gates")
    source = str(source or "").strip().lower()
    if source not in ANALYTICS_SOURCES:
        raise ArtifactBindingError("unsupported analytics source")
    normalized_metrics = normalize_metrics(metrics)
    completeness = {
        key: metrics.get(key) not in (None, "")
        for key in (
            "views",
            "engagedViews",
            "stayedToWatchPercent",
            "averagePercentageViewed",
            "shares",
            "comments",
            "subscribersGained",
        )
    }
    payload = {
        "schemaVersion": 1,
        "artifactType": "AnalyticsSnapshot",
        "videoId": video_id,
        "publishedAt": published.isoformat().replace("+00:00", "Z"),
        "observedAt": observed.isoformat().replace("+00:00", "Z"),
        "videoAgeHours": round(age_hours, 4),
        "snapshotGateHours": gate,
        "decisionEligible": gate in DECISION_GATES_HOURS,
        "source": source,
        "experimentId": str(experiment_id or "").strip(),
        "cohortId": str(cohort_id or "").strip(),
        "treatmentId": str(treatment_id or "").strip(),
        "pillar": str(pillar or "").strip(),
        "durationSeconds": round(_number(duration_seconds), 3),
        "durationBucket": duration_bucket(duration_seconds),
        "metrics": normalized_metrics,
        "completeness": completeness,
        "completeForPrimaryDecision": all(
            completeness[key]
            for key in (
                "engagedViews",
                "stayedToWatchPercent",
                "averagePercentageViewed",
                "shares",
                "comments",
                "subscribersGained",
            )
        ),
    }
    if not all((payload["experimentId"], payload["cohortId"], payload["treatmentId"], payload["pillar"])):
        raise ArtifactBindingError("experiment and cohort metadata are required")
    return {**payload, "contentHash": content_hash(payload)}


def duration_bucket(seconds: float) -> str:
    value = float(seconds)
    if value < 13:
        return "08_12s"
    if value < 17:
        return "13_16s"
    return "17_22s"


class GrowthAnalyticsStore:
    """Small durable store keyed by video and declared equal-age gate."""

    def __init__(self, path: str):
        self.path = Path(path)

    def _read(self) -> Dict:
        if not self.path.is_file():
            return {"schemaVersion": 1, "snapshots": {}}
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        if payload.get("schemaVersion") != 1 or not isinstance(payload.get("snapshots"), dict):
            raise ArtifactBindingError("analytics store is invalid")
        return payload

    def upsert(self, snapshot: Dict) -> Dict:
        if snapshot.get("artifactType") != "AnalyticsSnapshot" or snapshot.get("contentHash") != content_hash(snapshot):
            raise ArtifactBindingError("analytics snapshot seal is invalid")
        payload = self._read()
        key = f"{snapshot['videoId']}:{snapshot['snapshotGateHours']}"
        previous = payload["snapshots"].get(key)
        if previous and previous["contentHash"] == snapshot["contentHash"]:
            return {"snapshot": previous, "replayed": True}
        if previous and previous["observedAt"] > snapshot["observedAt"]:
            raise ArtifactBindingError("refusing to replace a newer analytics snapshot")
        payload["snapshots"][key] = snapshot
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.",
            dir=str(self.path.parent),
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, sort_keys=True, ensure_ascii=True)
                handle.write("\n")
            os.replace(temporary_name, self.path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
        return {"snapshot": snapshot, "replayed": False}

    def list(self, gate_hours: Optional[int] = None) -> List[Dict]:
        snapshots = list(self._read()["snapshots"].values())
        if gate_hours is not None:
            snapshots = [
                snapshot
                for snapshot in snapshots
                if snapshot["snapshotGateHours"] == int(gate_hours)
            ]
        return sorted(
            snapshots,
            key=lambda item: (item["snapshotGateHours"], item["videoId"]),
        )


def _median(items: Iterable[float]) -> float:
    values = list(items)
    return round(float(statistics.median(values)), 6) if values else 0.0


def _percentile(values: List[float], value: float) -> float:
    if not values:
        return 0.0
    below = sum(item < value for item in values)
    equal = sum(item == value for item in values)
    return round(100.0 * (below + 0.5 * equal) / len(values), 4)


def evaluate_cohorts(
    snapshots: Iterable[Dict],
    gate_hours: int = 168,
    minimum_per_cohort: int = 3,
) -> Dict:
    """Compare cohorts only at one age gate, returning medians and outliers."""
    eligible = [
        snapshot
        for snapshot in snapshots
        if snapshot.get("snapshotGateHours") == gate_hours
        and snapshot.get("completeForPrimaryDecision") is True
    ]
    groups: Dict[str, List[Dict]] = {}
    for snapshot in eligible:
        groups.setdefault(snapshot["cohortId"], []).append(snapshot)
    metric_keys = (
        "stayedToWatchPercent",
        "averagePercentageViewed",
        "engagedViews",
        "sharesPer1000Engaged",
        "commentsPer1000Engaged",
        "subscribersPer1000Engaged",
    )
    all_values = {
        key: [float(item["metrics"][key]) for item in eligible]
        for key in metric_keys
    }
    cohort_reports = []
    for cohort_id, items in sorted(groups.items()):
        medians = {
            key: _median(float(item["metrics"][key]) for item in items)
            for key in metric_keys
        }
        metric_percentiles = {
            key: _percentile(all_values[key], medians[key])
            for key in metric_keys
        }
        growth_score = round(
            0.30 * metric_percentiles["stayedToWatchPercent"]
            + 0.25 * metric_percentiles["averagePercentageViewed"]
            + 0.20 * metric_percentiles["engagedViews"]
            + 0.15
            * _median(
                (
                    metric_percentiles["sharesPer1000Engaged"],
                    metric_percentiles["commentsPer1000Engaged"],
                )
            )
            + 0.10 * metric_percentiles["subscribersPer1000Engaged"],
            4,
        )
        engaged_values = [item["metrics"]["engagedViews"] for item in items]
        median_engaged = medians["engagedViews"]
        outliers = sorted(
            item["videoId"]
            for item in items
            if median_engaged > 0 and item["metrics"]["engagedViews"] >= median_engaged * 3
        )
        cohort_reports.append(
            {
                "cohortId": cohort_id,
                "sampleSize": len(items),
                "sufficientSample": len(items) >= minimum_per_cohort,
                "medians": medians,
                "percentiles": metric_percentiles,
                "growthScore": growth_score,
                "engagedViewsRange": [min(engaged_values), max(engaged_values)],
                "outlierVideoIds": outliers,
            }
        )
    ranked = sorted(
        cohort_reports,
        key=lambda item: (-item["growthScore"], item["cohortId"]),
    )
    winner = ranked[0] if ranked and ranked[0]["sufficientSample"] else None
    decision = "keep_collecting"
    if winner and len(ranked) >= 2:
        other = ranked[1]
        lead_required = (
            winner["medians"]["stayedToWatchPercent"] > other["medians"]["stayedToWatchPercent"]
            and winner["medians"]["averagePercentageViewed"] > other["medians"]["averagePercentageViewed"]
            and winner["medians"]["engagedViews"] > other["medians"]["engagedViews"]
        )
        satisfaction_lead = any(
            winner["medians"][key] > other["medians"][key]
            for key in (
                "sharesPer1000Engaged",
                "commentsPer1000Engaged",
                "subscribersPer1000Engaged",
            )
        )
        if lead_required and satisfaction_lead and other["sufficientSample"]:
            decision = "human_review_winner"
        else:
            winner = None
    payload = {
        "schemaVersion": 1,
        "artifactType": "CohortEvaluation",
        "snapshotGateHours": gate_hours,
        "equalAgeComparison": True,
        "minimumPerCohort": minimum_per_cohort,
        "eligibleSnapshotCount": len(eligible),
        "cohorts": ranked,
        "decision": decision,
        "winnerCohortId": winner["cohortId"] if winner else None,
        "humanApprovalRequired": True,
    }
    return {**payload, "contentHash": content_hash(payload)}


_CSV_ALIASES = {
    "videoId": ("video id", "video", "content"),
    "views": ("views",),
    "engagedViews": ("engaged views",),
    "stayedToWatchPercent": ("stayed to watch (%)", "stayed to watch"),
    "averageViewDurationSeconds": ("average view duration (seconds)",),
    "averagePercentageViewed": ("average percentage viewed (%)", "average percentage viewed"),
    "likes": ("likes",),
    "shares": ("shares",),
    "comments": ("comments",),
    "subscribersGained": ("subscribers gained", "subscribers"),
}


def import_studio_csv(path: str) -> List[Dict]:
    """Parse exported Studio rows into normalized metric dictionaries."""
    with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = []
        for raw in reader:
            lowered = {str(key).strip().lower(): value for key, value in raw.items()}
            normalized = {}
            for field, aliases in _CSV_ALIASES.items():
                normalized[field] = next(
                    (lowered[alias] for alias in aliases if alias in lowered),
                    None,
                )
            if normalized["videoId"]:
                rows.append(
                    {
                        "videoId": str(normalized.pop("videoId")).strip(),
                        "metrics": normalize_metrics(normalized),
                    }
                )
    return rows


__all__ = [
    "ANALYTICS_SOURCES",
    "DECISION_GATES_HOURS",
    "GrowthAnalyticsStore",
    "SNAPSHOT_GATES_HOURS",
    "build_analytics_snapshot",
    "duration_bucket",
    "evaluate_cohorts",
    "import_studio_csv",
    "nearest_snapshot_gate",
    "normalize_metrics",
]
