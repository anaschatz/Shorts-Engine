"""Sealed, versioned reports for HookGate V4 decisions.

The report layer intentionally has no profile, provider, renderer, or cache
imports.  That keeps the new V4 module safe to import from ``profiles.py``
without creating the ``artifact_contracts -> profiles`` cycle which the
existing spoken-clarity contract must avoid.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Dict, Mapping, Optional, Sequence


HOOK_GATE_V4_REPORT_SCHEMA_VERSION = 4
HOOK_GATE_V4_REPORT_TYPE = "HookGateV4CandidateReport"
HOOK_GATE_V4_VERSION = "hook-gate-v4.0.0"
HOOK_GATE_V4_PROMPT_VERSION = "hook-gate-v4-semantic-v1.0.0"
HOOK_GATE_V4_DECISION_VERSION = "hook-gate-v4.0.0"

_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_STATUS_VALUES = frozenset({"pass", "review", "reject"})


class HookGateV4ReportError(ValueError):
    """Raised when a V4 report is malformed, tampered, or stale."""


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise HookGateV4ReportError("report must contain strict JSON") from error


def _content_hash(value: Mapping[str, object]) -> str:
    body = {key: item for key, item in value.items() if key != "contentHash"}
    return hashlib.sha256(_canonical_json(body).encode("utf-8")).hexdigest()


def _finite(value: object, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise HookGateV4ReportError(f"{field} must be finite") from error
    if not math.isfinite(number):
        raise HookGateV4ReportError(f"{field} must be finite")
    return number


def _optional_hash(value: object, field: str) -> Optional[str]:
    normalized = str(value or "").strip().lower().removeprefix("sha256:")
    if not normalized:
        return None
    if not _SHA256_RE.fullmatch(normalized):
        raise HookGateV4ReportError(f"{field} must be a sha256 hash")
    return normalized


def _span(candidate: Mapping[str, object], prefix: str) -> Dict:
    start = candidate.get(f"{prefix}StartSeconds")
    end = candidate.get(f"{prefix}EndSeconds")
    start_token = candidate.get(f"{prefix}StartTokenIndex")
    end_token = candidate.get(f"{prefix}EndTokenIndex")
    return {
        "exactQuote": str(candidate.get(f"{prefix}ExactQuote") or ""),
        "startSeconds": start,
        "endSeconds": end,
        "startTokenIndex": start_token,
        "endTokenIndex": end_token,
        "exactAligned": bool(candidate.get(f"{prefix}ExactAligned")),
    }


def build_hook_gate_v4_report(
    candidate: Dict,
    *,
    source_hash: Optional[str] = None,
    transcript_timing_hash: Optional[str] = None,
    render_settings: Optional[Dict] = None,
    experiment: Optional[Dict] = None,
) -> Dict:
    """Serialize one evaluated candidate and seal its exact evidence.

    Source and transcript hashes are optional at this pure selection boundary,
    but whenever supplied they are normalized and become verifier-enforced
    provenance bindings.
    """

    render = dict(render_settings or {})
    experiment_data = dict(experiment or {})
    speech_start = _finite(
        candidate.get("speechStart", candidate.get("speech_start_time")),
        "speech start",
    )
    speech_end = _finite(
        candidate.get("speechEnd", candidate.get("speech_end_time")),
        "speech end",
    )
    if speech_start < 0.0 or speech_end <= speech_start:
        raise HookGateV4ReportError("speech interval is invalid")
    status = str(
        candidate.get("hookGateStatus")
        or candidate.get("hook_gate_status")
        or ""
    ).strip().lower()
    if status not in _STATUS_VALUES:
        raise HookGateV4ReportError("hook-gate status is invalid")

    payload = {
        "schemaVersion": HOOK_GATE_V4_REPORT_SCHEMA_VERSION,
        "artifactType": HOOK_GATE_V4_REPORT_TYPE,
        "hookGateVersion": str(candidate.get("hookGateVersion") or ""),
        "promptVersion": str(
            candidate.get("hookGatePromptVersion")
            or candidate.get("hook_gate_prompt_version")
            or ""
        ),
        "decisionVersion": str(
            candidate.get("hookGateDecisionVersion")
            or candidate.get("hook_gate_decision_version")
            or ""
        ),
        "selectionPolicyVersion": str(
            candidate.get("selectionPolicyVersion")
            or candidate.get("selection_policy_version")
            or ""
        ),
        "sourceHash": _optional_hash(
            source_hash if source_hash is not None else candidate.get("sourceHash"),
            "sourceHash",
        ),
        "transcriptTimingHash": _optional_hash(
            (
                transcript_timing_hash
                if transcript_timing_hash is not None
                else candidate.get("transcriptTimingHash")
            ),
            "transcriptTimingHash",
        ),
        "speechInterval": {
            "startSeconds": speech_start,
            "endSeconds": speech_end,
            "semantics": "half-open",
        },
        "firstWordLatencyMs": candidate.get("firstWordLatencyMs"),
        "openingUnit": _span(candidate, "openingUnit"),
        "topicComprehension": _span(candidate, "topicComprehension"),
        "payoff": _span(candidate, "payoff"),
        "semanticMeaning": {
            "openingUnitType": str(candidate.get("openingUnitType") or ""),
            "hookMechanism": str(candidate.get("hookMechanism") or ""),
            "topic": str(candidate.get("hookSemanticTopic") or ""),
            "openingClaimSummary": str(
                candidate.get("openingClaimSummary") or ""
            ),
            "wholePointSummary": str(candidate.get("wholePointSummary") or ""),
            "reasonCodes": list(candidate.get("hookSemanticReasonCodes") or []),
            "evidenceSource": str(candidate.get("hookSemanticEvidenceSource") or ""),
        },
        "semanticFlags": dict(candidate.get("hookSemanticFlags") or {}),
        "semanticScores": dict(candidate.get("hookSemanticScores") or {}),
        "hookGateScore": candidate.get("hookGateScore"),
        "hookGateScoreComponents": dict(
            candidate.get("hookGateScoreComponents") or {}
        ),
        "hookGatePenalties": list(candidate.get("hookGatePenalties") or []),
        "thresholds": dict(candidate.get("hookGateThresholds") or {}),
        "status": status,
        "eligible": bool(
            candidate.get("hookGateEligible", candidate.get("hook_gate_eligible"))
        ),
        "rejectionReasons": list(
            candidate.get("hookGateRejectionReasons")
            or candidate.get("hook_gate_reject_reasons")
            or []
        ),
        "reviewReasons": list(
            candidate.get("hookGateReviewReasons")
            or candidate.get("hook_gate_review_reasons")
            or []
        ),
        "renderProfile": str(
            render.get("render_profile")
            or candidate.get("render_profile")
            or ""
        ),
        "experimentId": experiment_data.get("experimentId"),
        "experimentCohort": experiment_data.get("cohortId"),
        "changedAxes": list(experiment_data.get("changedAxes") or []),
    }
    if payload["hookGateVersion"] != HOOK_GATE_V4_VERSION:
        raise HookGateV4ReportError("unsupported HookGate V4 version")
    if payload["promptVersion"] != HOOK_GATE_V4_PROMPT_VERSION:
        raise HookGateV4ReportError("unsupported HookGate V4 prompt version")
    if payload["decisionVersion"] != HOOK_GATE_V4_DECISION_VERSION:
        raise HookGateV4ReportError("unsupported HookGate V4 decision version")
    payload["contentHash"] = _content_hash(payload)
    return payload


def verify_hook_gate_v4_report(
    report: Dict,
    *,
    source_hash: Optional[str] = None,
    transcript_timing_hash: Optional[str] = None,
    speech_interval: Optional[Sequence[float]] = None,
    require_pass: bool = False,
) -> Dict:
    """Verify integrity, versions, optional provenance, and disposition."""

    if not isinstance(report, dict):
        raise HookGateV4ReportError("report must be an object")
    if report.get("artifactType") != HOOK_GATE_V4_REPORT_TYPE:
        raise HookGateV4ReportError(f"expected {HOOK_GATE_V4_REPORT_TYPE}")
    if report.get("schemaVersion") != HOOK_GATE_V4_REPORT_SCHEMA_VERSION:
        raise HookGateV4ReportError("unsupported HookGate V4 report schema")
    declared_hash = _optional_hash(report.get("contentHash"), "contentHash")
    if declared_hash is None or declared_hash != _content_hash(report):
        raise HookGateV4ReportError("report contentHash does not match its body")
    if report.get("hookGateVersion") != HOOK_GATE_V4_VERSION:
        raise HookGateV4ReportError("unsupported HookGate V4 version")
    if report.get("promptVersion") != HOOK_GATE_V4_PROMPT_VERSION:
        raise HookGateV4ReportError("unsupported HookGate V4 prompt version")
    if report.get("decisionVersion") != HOOK_GATE_V4_DECISION_VERSION:
        raise HookGateV4ReportError("unsupported HookGate V4 decision version")

    actual_source_hash = _optional_hash(report.get("sourceHash"), "sourceHash")
    actual_transcript_hash = _optional_hash(
        report.get("transcriptTimingHash"),
        "transcriptTimingHash",
    )
    if source_hash is not None and actual_source_hash != _optional_hash(
        source_hash,
        "source_hash",
    ):
        raise HookGateV4ReportError("report references another source")
    if (
        transcript_timing_hash is not None
        and actual_transcript_hash
        != _optional_hash(transcript_timing_hash, "transcript_timing_hash")
    ):
        raise HookGateV4ReportError("report references another transcript")

    interval = report.get("speechInterval")
    if not isinstance(interval, dict) or interval.get("semantics") != "half-open":
        raise HookGateV4ReportError("speech interval contract is invalid")
    start = _finite(interval.get("startSeconds"), "speechInterval.startSeconds")
    end = _finite(interval.get("endSeconds"), "speechInterval.endSeconds")
    if start < 0.0 or end <= start:
        raise HookGateV4ReportError("speech interval is invalid")
    if speech_interval is not None:
        if len(speech_interval) != 2:
            raise HookGateV4ReportError("speech_interval must contain start and end")
        expected = (
            _finite(speech_interval[0], "speech_interval.start"),
            _finite(speech_interval[1], "speech_interval.end"),
        )
        if (start, end) != expected:
            raise HookGateV4ReportError("report speech interval is stale")

    status = str(report.get("status") or "").strip().lower()
    if status not in _STATUS_VALUES:
        raise HookGateV4ReportError("report status is invalid")
    if bool(report.get("eligible")) != (status == "pass"):
        raise HookGateV4ReportError("report eligibility contradicts status")
    if require_pass and status != "pass":
        raise HookGateV4ReportError("report is not eligible")
    for name in ("openingUnit", "topicComprehension", "payoff"):
        span = report.get(name)
        if not isinstance(span, dict):
            raise HookGateV4ReportError(f"{name} evidence is missing")
        if status == "pass" and (
            not span.get("exactAligned") or not str(span.get("exactQuote") or "")
        ):
            raise HookGateV4ReportError(f"passing report lacks {name} evidence")
    return dict(report)


__all__ = [
    "HOOK_GATE_V4_DECISION_VERSION",
    "HOOK_GATE_V4_PROMPT_VERSION",
    "HOOK_GATE_V4_REPORT_SCHEMA_VERSION",
    "HOOK_GATE_V4_REPORT_TYPE",
    "HOOK_GATE_V4_VERSION",
    "HookGateV4ReportError",
    "build_hook_gate_v4_report",
    "verify_hook_gate_v4_report",
]
