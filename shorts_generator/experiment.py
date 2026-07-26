"""Predeclared experiment contracts for controlled Budget Friendly cohorts."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, Iterable, Optional

from .artifact_contracts import ArtifactBindingError, content_hash
from .growth_analytics import SNAPSHOT_GATES_HOURS, duration_bucket


ALLOWED_HOOK_COHORTS = frozenset(
    {"contradiction", "concrete_rule", "identity_stakes", "legacy_control"}
)
ALLOWED_PRIMARY_VARIABLES = frozenset(
    {"hook_family", "caption_treatment", "duration_bucket", "music_treatment"}
)


def _seal(payload: Dict) -> Dict:
    return {**payload, "contentHash": content_hash(payload)}


def _iso_utc(value: str, field: str) -> str:
    raw = str(value or "").strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise ArtifactBindingError(f"{field} must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise ArtifactBindingError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def build_experiment_manifest(
    experiment_id: str,
    cohort_id: str,
    treatment_id: str,
    candidate_hash: str,
    hypothesis: str,
    primary_variable: str,
    pillar: str,
    duration_seconds: float,
    declared_at: str,
    decision_due_at: str,
    fixed_variables: Optional[Dict] = None,
    speaker_id: Optional[str] = None,
    source_popularity_bucket: Optional[str] = None,
) -> Dict:
    """Create a sealed declaration before rendering begins."""
    experiment_id = str(experiment_id or "").strip()
    cohort_id = str(cohort_id or "").strip().lower()
    treatment_id = str(treatment_id or "").strip()
    hypothesis = str(hypothesis or "").strip()
    primary_variable = str(primary_variable or "").strip().lower()
    pillar = str(pillar or "").strip().lower()
    if not all((experiment_id, treatment_id, hypothesis, pillar, declared_at, decision_due_at)):
        raise ArtifactBindingError("experiment declaration is incomplete")
    if cohort_id not in ALLOWED_HOOK_COHORTS:
        raise ArtifactBindingError("unknown cohort")
    if primary_variable not in ALLOWED_PRIMARY_VARIABLES:
        raise ArtifactBindingError("unknown primary experiment variable")
    if len(candidate_hash) != 64:
        raise ArtifactBindingError("candidateHash must be sha256")
    declared_at = _iso_utc(declared_at, "declared_at")
    decision_due_at = _iso_utc(decision_due_at, "decision_due_at")
    if datetime.fromisoformat(decision_due_at.replace("Z", "+00:00")) <= datetime.fromisoformat(
        declared_at.replace("Z", "+00:00")
    ):
        raise ArtifactBindingError("decision_due_at must be after declared_at")
    fixed = {
        "formatProfile": "bf_viral_micro_v1",
        "selectionProfile": "motivational_tension_micro_v1",
        "renderProfile": "bf_editorial_inset_v1",
        "language": "en",
        "uploadCadence": "one_per_day_five_per_week",
        **(fixed_variables or {}),
    }
    if fixed_variables and primary_variable in fixed_variables:
        raise ArtifactBindingError("primary variable cannot also be declared fixed")
    payload = {
        "schemaVersion": 1,
        "artifactType": "ExperimentManifest",
        "experimentId": experiment_id,
        "cohortId": cohort_id,
        "treatmentId": treatment_id,
        "candidateHash": candidate_hash.lower(),
        "formatProfile": "bf_viral_micro_v1",
        "selectionProfile": "motivational_tension_micro_v1",
        "renderProfile": "bf_editorial_inset_v1",
        "hypothesis": hypothesis,
        "primaryVariable": primary_variable,
        "pillar": pillar,
        "durationBucket": duration_bucket(duration_seconds),
        "declaredAt": str(declared_at),
        "decisionDueAt": str(decision_due_at),
        "snapshotGatesHours": list(SNAPSHOT_GATES_HOURS),
        "decisionGatesHours": [24, 72, 168, 672],
        "primaryMetric": "stayed_to_watch_percentile",
        "secondaryMetrics": [
            "engaged_views_equal_age",
            "average_percentage_viewed",
            "shares_comments_per_1000_engaged",
            "subscribers_per_1000_engaged",
        ],
        "fixedVariables": fixed,
        "balance": {
            "speakerId": str(speaker_id or "").strip() or None,
            "sourcePopularityBucket": str(source_popularity_bucket or "").strip() or None,
        },
        "humanDecisionRequired": True,
    }
    return _seal(payload)


def build_experiment_decision(
    experiment_manifest: Dict,
    cohort_evaluation: Dict,
    decision: str,
    approver: str,
    decided_at: str,
    notes: str,
) -> Dict:
    if experiment_manifest.get("contentHash") != content_hash(experiment_manifest):
        raise ArtifactBindingError("experiment manifest seal is invalid")
    if cohort_evaluation.get("contentHash") != content_hash(cohort_evaluation):
        raise ArtifactBindingError("cohort evaluation seal is invalid")
    decision = str(decision or "").strip().lower()
    if decision not in {"keep", "change", "retire", "continue_collecting"}:
        raise ArtifactBindingError("invalid experiment decision")
    if not str(approver or "").strip() or not str(decided_at or "").strip():
        raise ArtifactBindingError("human approver and timestamp are required")
    if decision != "continue_collecting" and cohort_evaluation.get("decision") == "keep_collecting":
        raise ArtifactBindingError("cohort evidence is not decision-ready")
    payload = {
        "schemaVersion": 1,
        "artifactType": "ExperimentDecision",
        "experimentManifestHash": experiment_manifest["contentHash"],
        "cohortEvaluationHash": cohort_evaluation["contentHash"],
        "experimentId": experiment_manifest["experimentId"],
        "decision": decision,
        "winnerCohortId": cohort_evaluation.get("winnerCohortId"),
        "approver": str(approver).strip(),
        "decidedAt": str(decided_at).strip(),
        "notes": str(notes or "").strip(),
    }
    return _seal(payload)


__all__ = [
    "ALLOWED_HOOK_COHORTS",
    "ALLOWED_PRIMARY_VARIABLES",
    "build_experiment_decision",
    "build_experiment_manifest",
]
