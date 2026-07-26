"""Pure HookGate V3 report serialization.

This module deliberately owns no caches, policy evaluation, transcript
normalization, or rendering imports.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Dict, Optional


HOOK_GATE_V3_REPORT_SCHEMA_VERSION = 3


def _number(value: object, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def build_hook_gate_v3_report(
    candidate: Dict,
    *,
    render_settings: Optional[Dict] = None,
    experiment: Optional[Dict] = None,
) -> Dict:
    """Build the versioned, machine-readable candidate report."""
    render = dict(render_settings or {})
    experiment_data = dict(experiment or {})
    source_start = _number(
        candidate.get("speech_start_time", candidate.get("start_time"))
    )
    source_end = _number(
        candidate.get("speech_end_time", candidate.get("end_time"))
    )
    next_word_start = candidate.get(
        "verified_next_spoken_word_start",
        candidate.get("next_spoken_word_start"),
    )
    next_word_boundary = (
        _number(next_word_start)
        - _number(
            candidate.get("verified_next_speech_safety_seconds"),
            _number(candidate.get("next_speech_safety_seconds"), 0.04),
        )
        if next_word_start is not None
        else None
    )
    payload = {
        "schemaVersion": HOOK_GATE_V3_REPORT_SCHEMA_VERSION,
        "artifactType": "HookGateV3CandidateReport",
        "hookGateVersion": str(candidate.get("hookGateVersion") or ""),
        "selectionPolicyVersion": str(
            candidate.get("selectionPolicyVersion")
            or candidate.get("selection_policy_version")
            or ""
        ),
        "sourceInterval": {
            "startSeconds": source_start,
            "endSeconds": source_end,
        },
        "openingExactQuote": str(
            candidate.get("opening_exact_quote")
            or candidate.get("openingQuote")
            or ""
        ),
        "payoffExactQuote": str(
            candidate.get("hook_payoff_phrase")
            or candidate.get("payoffQuote")
            or ""
        ),
        "speechDurationSeconds": round(max(0.0, source_end - source_start), 3),
        "renderDurationSeconds": _number(
            candidate.get("render_duration_seconds"),
            _number(candidate.get("end_time")) - _number(candidate.get("start_time")),
        ),
        "firstWordLatencyMs": candidate.get("firstWordLatencyMs"),
        "firstTensionSignalSeconds": candidate.get("firstTensionSignalSeconds"),
        "firstActionableRuleSeconds": candidate.get("firstActionableRuleSeconds"),
        "firstPayoffSeconds": candidate.get("firstPayoffSeconds"),
        "hookFamily": candidate.get("hookFamily"),
        "openingAbstractionScore": candidate.get("openingAbstractionScore"),
        "openingSpecificityScore": candidate.get("openingSpecificityScore"),
        "openingContextDependence": candidate.get("openingContextDependence"),
        "hookGateScore": candidate.get("hookGateScore"),
        "naturalTailDurationSeconds": _number(
            candidate.get("planned_natural_tail_seconds"),
            _number(candidate.get("natural_tail_seconds")),
        ),
        "nextWordStartSeconds": next_word_start,
        "nextWordSafetyBoundarySeconds": (
            round(next_word_boundary, 3)
            if next_word_boundary is not None
            else None
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
        "layoutProfile": str(
            render.get("layout_hint")
            or candidate.get("layout_hint")
            or ""
        ),
        "captionProfile": str(
            render.get("caption_style")
            or candidate.get("caption_style")
            or ""
        ),
        "experimentId": experiment_data.get("experimentId"),
        "experimentCohort": experiment_data.get("cohortId"),
        "changedAxes": list(experiment_data.get("changedAxes") or []),
    }
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return {**payload, "contentHash": hashlib.sha256(encoded).hexdigest()}


__all__ = [
    "HOOK_GATE_V3_REPORT_SCHEMA_VERSION",
    "build_hook_gate_v3_report",
]
