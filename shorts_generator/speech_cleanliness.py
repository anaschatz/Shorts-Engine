"""Versioned, sealed decisions for Budget Friendly speech cleanliness.

The evaluator in this module is deliberately pure.  It consumes already
measured lexical/acoustic evidence, makes one deterministic decision, and binds
that decision to the source bytes, transcript timing, and exact half-open
speech interval.  Media decoding and model execution live in
``shorts_generator.local.speech_cleanliness``.
"""

from __future__ import annotations

import json
import math
import re
from typing import Dict, Iterable, Mapping, Optional, Sequence, Tuple

from .artifact_contracts import ArtifactBindingError, content_hash, verify_seal
from .profiles import (
    SPEECH_CLEANLINESS_DECISION_VERSION,
    SPEECH_CLEANLINESS_FILLER_REJECT_COUNT,
    SPEECH_CLEANLINESS_UNCOVERED_REVIEW_COUNT,
)


SPEECH_CLEANLINESS_REPORT_TYPE = "SpeechCleanlinessReport"
SPEECH_CLEANLINESS_REPORT_SCHEMA_VERSION = 1

_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_STATUS_VALUES = frozenset({"pass", "review", "reject"})


def _sha256(value: object, field: str) -> str:
    normalized = str(value or "").strip().lower().removeprefix("sha256:")
    if not _SHA256_RE.fullmatch(normalized):
        raise ArtifactBindingError(f"{field} must be a sha256 hash")
    return normalized


def _finite_number(value: object, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError(f"{field} must be finite") from error
    if not math.isfinite(number):
        raise ArtifactBindingError(f"{field} must be finite")
    return number


def _strict_json(value: object, field: str) -> object:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError(f"{field} must be strict JSON") from error
    return json.loads(encoded)


def _normalise_provider_status(value: object) -> str:
    normalized = str(value or "").strip().lower().replace(" ", "_")
    if not normalized or not re.fullmatch(r"[a-z0-9_.:-]{1,96}", normalized):
        raise ArtifactBindingError("provider_status is invalid")
    return normalized


def _normalise_event(
    raw: object,
    *,
    field: str,
    speech_start: float,
    speech_end: float,
) -> Dict:
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            raise ArtifactBindingError(f"{field} text is empty")
        return {"text": text, "durationSeconds": 0.0}
    if not isinstance(raw, Mapping):
        raise ArtifactBindingError(f"{field} entries must be objects or strings")

    text = str(
        raw.get("text")
        or raw.get("word")
        or raw.get("token")
        or raw.get("label")
        or ""
    ).strip()
    result: Dict[str, object] = {}
    if text:
        result["text"] = text

    start_value = raw.get("startSeconds", raw.get("start"))
    end_value = raw.get("endSeconds", raw.get("end"))
    if (start_value is None) != (end_value is None):
        raise ArtifactBindingError(f"{field} timing must include start and end")
    if start_value is not None:
        start = _finite_number(start_value, f"{field}.start")
        end = _finite_number(end_value, f"{field}.end")
        if (
            end <= start
            or start < speech_start - 1e-9
            or end > speech_end + 1e-9
        ):
            raise ArtifactBindingError(f"{field} timing is outside the speech interval")
        result.update(
            {
                "startSeconds": start,
                "endSeconds": end,
                "durationSeconds": end - start,
            }
        )
    else:
        duration_value = raw.get("durationSeconds", raw.get("duration", 0.0))
        duration = _finite_number(duration_value, f"{field}.duration")
        if duration < 0.0 or duration > speech_end - speech_start + 1e-9:
            raise ArtifactBindingError(f"{field} duration is invalid")
        result["durationSeconds"] = duration

    if not text and field != "uncoveredVocalizations":
        raise ArtifactBindingError(f"{field} entries require text")
    if raw.get("confidence") is not None:
        confidence = _finite_number(raw.get("confidence"), f"{field}.confidence")
        if not 0.0 <= confidence <= 1.0:
            raise ArtifactBindingError(f"{field} confidence is invalid")
        result["confidence"] = confidence
    return result


def _normalise_events(
    values: Iterable[object],
    *,
    field: str,
    speech_start: float,
    speech_end: float,
) -> list[Dict]:
    if isinstance(values, (str, bytes, Mapping)) or values is None:
        raise ArtifactBindingError(f"{field} must be a list")
    try:
        events = [
            _normalise_event(
                value,
                field=field,
                speech_start=speech_start,
                speech_end=speech_end,
            )
            for value in values
        ]
    except TypeError as error:
        raise ArtifactBindingError(f"{field} must be a list") from error
    return sorted(
        events,
        key=lambda event: (
            event.get("startSeconds") is None,
            float(event.get("startSeconds") or 0.0),
            float(event.get("endSeconds") or 0.0),
            str(event.get("text") or ""),
        ),
    )


def _decision(
    provider_status: str,
    lexical_count: int,
    uncovered_count: int,
    prompted_count: int,
) -> Tuple[str, list[str], list[str]]:
    if provider_status != "ok":
        return "review", [], ["speech_cleanliness_provider_not_ok"]

    filler_count = lexical_count + prompted_count
    rejects: list[str] = []
    reviews: list[str] = []
    if filler_count >= SPEECH_CLEANLINESS_FILLER_REJECT_COUNT:
        rejects.append("repeated_audible_fillers")
    if (
        uncovered_count >= SPEECH_CLEANLINESS_UNCOVERED_REVIEW_COUNT
        and prompted_count >= 1
    ):
        rejects.append("repeated_untranscribed_vocalizations")
    if rejects:
        return "reject", rejects, []
    if filler_count == 1:
        reviews.append("single_audible_filler")
    if (
        uncovered_count >= SPEECH_CLEANLINESS_UNCOVERED_REVIEW_COUNT
        and filler_count == 0
    ):
        reviews.append("unresolved_internal_vocalizations")
    return ("review" if reviews else "pass"), [], reviews


def _duration(events: Sequence[Mapping[str, object]]) -> float:
    return sum(float(event.get("durationSeconds") or 0.0) for event in events)


def evaluate_speech_cleanliness_evidence(
    *,
    source_hash: str,
    transcript_timing_hash: str,
    speech_start: float,
    speech_end: float,
    lexical_fillers: Iterable[object],
    uncovered_vocalizations: Iterable[object],
    prompted_fillers: Iterable[object],
    provider_status: str = "ok",
    provider_identity: Optional[object] = None,
) -> Dict:
    """Return one sealed, deterministic speech-cleanliness report.

    Evidence timings are absolute source seconds and must fall inside the exact
    half-open candidate interval.  Text-only events are accepted for pure
    decision fixtures, but the local provider always emits timed evidence.
    """

    normalized_source_hash = _sha256(source_hash, "source_hash")
    normalized_transcript_hash = _sha256(
        transcript_timing_hash,
        "transcript_timing_hash",
    )
    start = _finite_number(speech_start, "speech_start")
    end = _finite_number(speech_end, "speech_end")
    if start < 0.0 or end <= start:
        raise ArtifactBindingError("speech interval is invalid")
    normalized_provider_status = _normalise_provider_status(provider_status)
    normalized_provider_identity = _strict_json(
        provider_identity,
        "provider_identity",
    )

    lexical = _normalise_events(
        lexical_fillers,
        field="lexicalFillers",
        speech_start=start,
        speech_end=end,
    )
    uncovered = _normalise_events(
        uncovered_vocalizations,
        field="uncoveredVocalizations",
        speech_start=start,
        speech_end=end,
    )
    prompted = _normalise_events(
        prompted_fillers,
        field="promptedFillers",
        speech_start=start,
        speech_end=end,
    )
    status, rejection_reasons, review_reasons = _decision(
        normalized_provider_status,
        len(lexical),
        len(uncovered),
        len(prompted),
    )
    deterministic_reasons = rejection_reasons + review_reasons
    lexical_duration = _duration(lexical)
    uncovered_duration = _duration(uncovered)
    prompted_duration = _duration(prompted)
    filler_count = len(lexical) + len(prompted)
    filler_duration = lexical_duration + prompted_duration

    payload = {
        "schemaVersion": SPEECH_CLEANLINESS_REPORT_SCHEMA_VERSION,
        "artifactType": SPEECH_CLEANLINESS_REPORT_TYPE,
        "decisionVersion": SPEECH_CLEANLINESS_DECISION_VERSION,
        "sourceHash": normalized_source_hash,
        "transcriptTimingHash": normalized_transcript_hash,
        "speechInterval": {
            "startSeconds": start,
            "endSeconds": end,
            "semantics": "half-open",
        },
        "providerStatus": normalized_provider_status,
        "providerIdentity": normalized_provider_identity,
        "evidence": {
            "lexicalFillers": lexical,
            "uncoveredVocalizations": uncovered,
            "promptedFillers": prompted,
        },
        "counts": {
            "lexicalFillers": len(lexical),
            "uncoveredVocalizations": len(uncovered),
            "promptedFillers": len(prompted),
            "audibleFillers": filler_count,
        },
        "durationsSeconds": {
            "lexicalFillers": lexical_duration,
            "uncoveredVocalizations": uncovered_duration,
            "promptedFillers": prompted_duration,
            "audibleFillers": filler_duration,
        },
        "lexicalFillerCount": len(lexical),
        "uncoveredVocalizationCount": len(uncovered),
        "promptedFillerCount": len(prompted),
        "audibleFillerCount": filler_count,
        "lexicalFillerDurationSeconds": lexical_duration,
        "uncoveredVocalizationDurationSeconds": uncovered_duration,
        "promptedFillerDurationSeconds": prompted_duration,
        "audibleFillerDurationSeconds": filler_duration,
        "status": status,
        "eligible": status == "pass",
        "rejectionReasons": rejection_reasons,
        "reviewReasons": review_reasons,
        "deterministicReasons": deterministic_reasons,
    }
    return {**payload, "contentHash": content_hash(payload)}


def verify_speech_cleanliness_report(
    report: Dict,
    source_hash: Optional[str] = None,
    transcript_timing_hash: Optional[str] = None,
    speech_interval: Optional[Sequence[float]] = None,
    require_pass: bool = False,
) -> Dict:
    """Verify the seal, deterministic decision, and optional provenance bindings."""

    verified = verify_seal(report, SPEECH_CLEANLINESS_REPORT_TYPE)
    if (
        verified.get("schemaVersion") != SPEECH_CLEANLINESS_REPORT_SCHEMA_VERSION
        or verified.get("decisionVersion") != SPEECH_CLEANLINESS_DECISION_VERSION
    ):
        raise ArtifactBindingError("unsupported speech-cleanliness report version")
    actual_source_hash = _sha256(verified.get("sourceHash"), "report.sourceHash")
    actual_transcript_hash = _sha256(
        verified.get("transcriptTimingHash"),
        "report.transcriptTimingHash",
    )
    if source_hash is not None and actual_source_hash != _sha256(
        source_hash,
        "source_hash",
    ):
        raise ArtifactBindingError("speech-cleanliness report references another source")
    if transcript_timing_hash is not None and actual_transcript_hash != _sha256(
        transcript_timing_hash,
        "transcript_timing_hash",
    ):
        raise ArtifactBindingError("speech-cleanliness report references another transcript")

    interval = verified.get("speechInterval")
    if not isinstance(interval, dict) or interval.get("semantics") != "half-open":
        raise ArtifactBindingError("speech-cleanliness interval contract is invalid")
    start = _finite_number(interval.get("startSeconds"), "report.speechInterval.start")
    end = _finite_number(interval.get("endSeconds"), "report.speechInterval.end")
    if start < 0.0 or end <= start:
        raise ArtifactBindingError("speech-cleanliness interval is invalid")
    if speech_interval is not None:
        if len(speech_interval) != 2:
            raise ArtifactBindingError("speech_interval must contain start and end")
        expected = (
            _finite_number(speech_interval[0], "speech_interval.start"),
            _finite_number(speech_interval[1], "speech_interval.end"),
        )
        if (start, end) != expected:
            raise ArtifactBindingError("speech-cleanliness report interval is stale")

    evidence = verified.get("evidence")
    if not isinstance(evidence, dict):
        raise ArtifactBindingError("speech-cleanliness evidence is missing")
    lexical = _normalise_events(
        evidence.get("lexicalFillers"),
        field="lexicalFillers",
        speech_start=start,
        speech_end=end,
    )
    uncovered = _normalise_events(
        evidence.get("uncoveredVocalizations"),
        field="uncoveredVocalizations",
        speech_start=start,
        speech_end=end,
    )
    prompted = _normalise_events(
        evidence.get("promptedFillers"),
        field="promptedFillers",
        speech_start=start,
        speech_end=end,
    )
    if evidence != {
        "lexicalFillers": lexical,
        "uncoveredVocalizations": uncovered,
        "promptedFillers": prompted,
    }:
        raise ArtifactBindingError("speech-cleanliness evidence is not canonical")

    provider_status = _normalise_provider_status(verified.get("providerStatus"))
    _strict_json(verified.get("providerIdentity"), "report.providerIdentity")
    status, rejection_reasons, review_reasons = _decision(
        provider_status,
        len(lexical),
        len(uncovered),
        len(prompted),
    )
    deterministic_reasons = rejection_reasons + review_reasons
    expected_counts = {
        "lexicalFillers": len(lexical),
        "uncoveredVocalizations": len(uncovered),
        "promptedFillers": len(prompted),
        "audibleFillers": len(lexical) + len(prompted),
    }
    expected_durations = {
        "lexicalFillers": _duration(lexical),
        "uncoveredVocalizations": _duration(uncovered),
        "promptedFillers": _duration(prompted),
        "audibleFillers": _duration(lexical) + _duration(prompted),
    }
    if verified.get("counts") != expected_counts:
        raise ArtifactBindingError("speech-cleanliness counts are stale")
    if verified.get("durationsSeconds") != expected_durations:
        raise ArtifactBindingError("speech-cleanliness durations are stale")
    flat_measurements = {
        "lexicalFillerCount": expected_counts["lexicalFillers"],
        "uncoveredVocalizationCount": expected_counts["uncoveredVocalizations"],
        "promptedFillerCount": expected_counts["promptedFillers"],
        "audibleFillerCount": expected_counts["audibleFillers"],
        "lexicalFillerDurationSeconds": expected_durations["lexicalFillers"],
        "uncoveredVocalizationDurationSeconds": expected_durations[
            "uncoveredVocalizations"
        ],
        "promptedFillerDurationSeconds": expected_durations["promptedFillers"],
        "audibleFillerDurationSeconds": expected_durations["audibleFillers"],
    }
    if any(verified.get(key) != value for key, value in flat_measurements.items()):
        raise ArtifactBindingError("speech-cleanliness measurements are stale")
    if (
        status not in _STATUS_VALUES
        or verified.get("status") != status
        or verified.get("eligible") is not (status == "pass")
        or verified.get("rejectionReasons") != rejection_reasons
        or verified.get("reviewReasons") != review_reasons
        or verified.get("deterministicReasons") != deterministic_reasons
    ):
        raise ArtifactBindingError("speech-cleanliness decision is inconsistent")
    if require_pass and status != "pass":
        raise ArtifactBindingError("speech-cleanliness report is not eligible")
    return verified


__all__ = [
    "SPEECH_CLEANLINESS_DECISION_VERSION",
    "SPEECH_CLEANLINESS_REPORT_SCHEMA_VERSION",
    "SPEECH_CLEANLINESS_REPORT_TYPE",
    "evaluate_speech_cleanliness_evidence",
    "verify_speech_cleanliness_report",
]
