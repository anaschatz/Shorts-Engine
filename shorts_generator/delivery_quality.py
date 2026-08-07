"""Sealed, affect-free evidence for spoken delivery quality.

DeliveryQuality does not decide whether an idea is interesting and never
infers confidence, emotion, or personality.  It combines a verified
SpokenClarity v1.2 report with observable timing and read-only RMS measurements
for the exact source-contiguous speech interval.
"""
from __future__ import annotations

import json
import math
import re
import statistics
from typing import Dict, Iterable, Mapping, Optional, Sequence

from .artifact_contracts import ArtifactBindingError, content_hash, verify_seal
from .spoken_clarity import (
    SPOKEN_CLARITY_DECISION_VERSION,
    verify_spoken_clarity_report,
)


DELIVERY_QUALITY_REPORT_TYPE = "DeliveryQualityReport"
DELIVERY_QUALITY_REPORT_SCHEMA_VERSION = 1
DELIVERY_QUALITY_DECISION_VERSION = "bf-delivery-quality-v1.0.0"
DELIVERY_QUALITY_ANALYZER_VERSION = "bf-delivery-quality-analyzer-v1.0.0"
DELIVERY_QUALITY_ACOUSTIC_PROVIDER = "ffmpeg-f32le-mono16k-rms-dynamics-v1"
DELIVERY_QUALITY_SAMPLE_RATE = 16_000

DELIVERY_QUALITY_POLICY = {
    "decisionVersion": DELIVERY_QUALITY_DECISION_VERSION,
    "spokenClarityDecisionVersion": SPOKEN_CLARITY_DECISION_VERSION,
    "pauseMinimumSeconds": 0.25,
    "longPauseMinimumSeconds": 0.80,
    "idealWordsPerMinute": [120.0, 195.0],
    "moderateWordsPerMinute": [90.0, 235.0],
    "severeWordsPerMinute": [60.0, 285.0],
    "moderateInternalPauseRatio": 0.28,
    "severeInternalPauseRatio": 0.45,
    "moderateRmsDynamicRangeDb": 2.0,
    "severeRmsDynamicRangeDb": 1.0,
    "moderateActiveFrameRatio": 0.25,
    "severeActiveFrameRatio": 0.12,
    "moderateOverallRmsDbfs": -44.0,
    "severeOverallRmsDbfs": -52.0,
    "borderlineStrengthMaximum": 65.0,
    "veryLowStrengthMaximum": 50.0,
    "veryLowMinimumCorroboratingCategories": 2,
    "calmDeliverySingleLowDynamicsDisposition": "pass",
    "affectInferenceAllowed": False,
}

_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_STATUS_VALUES = frozenset({"pass", "review", "reject"})

_PRESERVED_REJECT_REASONS = frozenset(
    {
        "spoken_clarity_repeated_disfluencies",
        "spoken_clarity_repeated_searching_pauses",
        "spoken_clarity_opening_asr_severely_unclear",
    }
)
_PRESERVED_REVIEW_REASONS = frozenset(
    {
        "spoken_clarity_single_disfluency",
        "spoken_clarity_single_searching_pause",
        "spoken_clarity_provider_not_ok",
        "spoken_clarity_opening_asr_evidence_missing",
        "spoken_clarity_opening_asr_uncertain",
        "spoken_clarity_opening_asr_alignment_unavailable",
        "spoken_clarity_opening_asr_token_mismatch",
    }
)


def _sha256(value: object, field: str) -> str:
    normalized = str(value or "").strip().lower().removeprefix("sha256:")
    if not _SHA256_RE.fullmatch(normalized):
        raise ArtifactBindingError(f"{field} must be a sha256 hash")
    return normalized


def _finite(value: object, field: str) -> float:
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


def _provider_status(value: object) -> str:
    normalized = str(value or "").strip().lower().replace(" ", "_")
    if not normalized or not re.fullmatch(r"[a-z0-9_.:-]{1,96}", normalized):
        raise ArtifactBindingError("provider_status is invalid")
    return normalized


def _unique(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _normalise_timed_words(
    values: Iterable[object],
    *,
    speech_start: float,
    speech_end: float,
) -> list[Dict]:
    if isinstance(values, (str, bytes, Mapping)) or values is None:
        raise ArtifactBindingError("timed_words must be a list")
    output = []
    try:
        iterator = iter(values)
    except TypeError as error:
        raise ArtifactBindingError("timed_words must be a list") from error
    for index, raw in enumerate(iterator):
        if not isinstance(raw, Mapping):
            raise ArtifactBindingError("timed word entries must be objects")
        text = str(raw.get("text") or raw.get("word") or "").strip()
        start = _finite(
            raw.get("startSeconds", raw.get("start")),
            f"timed_words[{index}].start",
        )
        end = _finite(
            raw.get("endSeconds", raw.get("end")),
            f"timed_words[{index}].end",
        )
        if (
            not text
            or end <= start
            or start < speech_start - 1e-9
            or start >= speech_end
            or end > speech_end + 1e-9
        ):
            raise ArtifactBindingError("timed word is outside the speech interval")
        item: Dict[str, object] = {
            "text": text,
            "startSeconds": start,
            "endSeconds": end,
        }
        if raw.get("sentenceBoundaryAfter") is not None:
            if type(raw.get("sentenceBoundaryAfter")) is not bool:
                raise ArtifactBindingError(
                    "timed word sentenceBoundaryAfter must be boolean"
                )
            item["sentenceBoundaryAfter"] = raw["sentenceBoundaryAfter"]
        output.append(item)
    output.sort(
        key=lambda word: (
            float(word["startSeconds"]),
            float(word["endSeconds"]),
            str(word["text"]),
        )
    )
    return output


def _normalise_acoustic_measurements(value: object) -> Dict:
    if not isinstance(value, Mapping):
        raise ArtifactBindingError("acoustic_measurements must be an object")
    available = value.get("available")
    if type(available) is not bool:
        raise ArtifactBindingError("acoustic measurement availability is invalid")
    sample_rate = value.get("sampleRate")
    sample_count = value.get("sampleCount")
    frame_count = value.get("frameCount")
    if isinstance(sample_rate, bool) or isinstance(sample_count, bool) or isinstance(frame_count, bool):
        raise ArtifactBindingError("acoustic measurement counts are invalid")
    try:
        sample_rate = int(sample_rate)
        sample_count = int(sample_count)
        frame_count = int(frame_count)
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError("acoustic measurement counts are invalid") from error
    if sample_rate != DELIVERY_QUALITY_SAMPLE_RATE or sample_count < 0 or frame_count < 0:
        raise ArtifactBindingError("acoustic measurement counts are invalid")

    def optional_number(key: str, minimum: float, maximum: float):
        raw = value.get(key)
        if raw is None:
            return None
        number = _finite(raw, f"acoustic_measurements.{key}")
        if not minimum <= number <= maximum:
            raise ArtifactBindingError(f"acoustic measurement {key} is invalid")
        return round(number, 6)

    normalized = {
        "available": available,
        "sampleRate": sample_rate,
        "sampleCount": sample_count,
        "frameCount": frame_count,
        "frameWindowMilliseconds": optional_number(
            "frameWindowMilliseconds", 10.0, 200.0
        ),
        "overallRmsDbfs": optional_number("overallRmsDbfs", -240.0, 6.0),
        "peakDbfs": optional_number("peakDbfs", -240.0, 6.0),
        "activeFrameRatio": optional_number("activeFrameRatio", 0.0, 1.0),
        "activeFrameThresholdDbfs": optional_number(
            "activeFrameThresholdDbfs", -240.0, 6.0
        ),
        "rmsDynamicRangeDb": optional_number("rmsDynamicRangeDb", 0.0, 120.0),
        "crestFactorDb": optional_number("crestFactorDb", 0.0, 120.0),
    }
    required = (
        "frameWindowMilliseconds",
        "overallRmsDbfs",
        "peakDbfs",
        "activeFrameRatio",
        "activeFrameThresholdDbfs",
        "rmsDynamicRangeDb",
        "crestFactorDb",
    )
    if available and (sample_count == 0 or frame_count == 0 or any(normalized[key] is None for key in required)):
        raise ArtifactBindingError("available acoustic evidence is incomplete")
    if not available and any(normalized[key] is not None for key in required):
        raise ArtifactBindingError("unavailable acoustic evidence must not claim measurements")
    return normalized


def _speech_timing_metrics(words: Sequence[Mapping[str, object]], start: float, end: float) -> Dict:
    duration = end - start
    if not words:
        return {
            "available": False,
            "wordCount": 0,
            "wordsPerMinute": None,
            "articulationWordsPerMinute": None,
            "speechCoverageRatio": None,
            "internalPauseCount": 0,
            "longInternalPauseCount": 0,
            "internalPauseSeconds": 0.0,
            "internalPauseRatio": None,
            "medianInternalGapSeconds": None,
            "firstWordLatencySeconds": None,
            "finalWordMarginSeconds": None,
        }
    word_duration = sum(
        float(word["endSeconds"]) - float(word["startSeconds"])
        for word in words
    )
    gaps = []
    internal_pauses = []
    for left, right in zip(words, words[1:]):
        gap = max(0.0, float(right["startSeconds"]) - float(left["endSeconds"]))
        gaps.append(gap)
        if gap >= float(DELIVERY_QUALITY_POLICY["pauseMinimumSeconds"]):
            if not bool(left.get("sentenceBoundaryAfter")):
                internal_pauses.append(gap)
    internal_pause_seconds = sum(internal_pauses)
    return {
        "available": True,
        "wordCount": len(words),
        "wordsPerMinute": round(60.0 * len(words) / duration, 6),
        "articulationWordsPerMinute": round(
            60.0 * len(words) / max(word_duration, 1e-9), 6
        ),
        "speechCoverageRatio": round(min(1.0, word_duration / duration), 6),
        "internalPauseCount": len(internal_pauses),
        "longInternalPauseCount": sum(
            gap >= float(DELIVERY_QUALITY_POLICY["longPauseMinimumSeconds"])
            for gap in internal_pauses
        ),
        "internalPauseSeconds": round(internal_pause_seconds, 6),
        "internalPauseRatio": round(internal_pause_seconds / duration, 6),
        "medianInternalGapSeconds": round(statistics.median(gaps), 6) if gaps else 0.0,
        "firstWordLatencySeconds": round(
            max(0.0, float(words[0]["startSeconds"]) - start), 6
        ),
        "finalWordMarginSeconds": round(
            max(0.0, end - float(words[-1]["endSeconds"])), 6
        ),
    }


def _linear_score(value: float, points: Sequence[tuple[float, float]]) -> float:
    if value <= points[0][0]:
        return points[0][1]
    for (left_x, left_y), (right_x, right_y) in zip(points, points[1:]):
        if value <= right_x:
            ratio = (value - left_x) / max(1e-9, right_x - left_x)
            return left_y + (right_y - left_y) * ratio
    return points[-1][1]


def _delivery_strength(timing: Mapping[str, object], acoustic: Mapping[str, object]) -> Dict:
    if not timing.get("available"):
        return {
            "score": None,
            "components": {},
            "moderateSignals": ["timing:missing"],
            "severeSignals": [],
            "corroboratingCategories": ["timing"],
        }
    wpm = float(timing["wordsPerMinute"])
    pause_ratio = float(timing["internalPauseRatio"])
    pacing = _linear_score(
        wpm,
        ((0.0, 10.0), (60.0, 20.0), (90.0, 65.0), (120.0, 100.0),
         (195.0, 100.0), (235.0, 60.0), (285.0, 20.0), (360.0, 10.0)),
    )
    continuity = _linear_score(
        pause_ratio,
        ((0.0, 100.0), (0.10, 100.0), (0.28, 55.0), (0.45, 20.0), (1.0, 10.0)),
    )
    components = {"pacing": pacing, "continuity": continuity}
    weights = {"pacing": 0.40, "continuity": 0.30}
    moderate: list[str] = []
    severe: list[str] = []
    if wpm < 60.0 or wpm > 285.0:
        severe.append("pacing:extreme_rate")
    elif wpm < 90.0 or wpm > 235.0:
        moderate.append("pacing:outside_moderate_range")
    if pause_ratio > 0.45 or int(timing["longInternalPauseCount"]) >= 3:
        severe.append("continuity:excessive_internal_pauses")
    elif pause_ratio > 0.28 or int(timing["longInternalPauseCount"]) >= 2:
        moderate.append("continuity:frequent_internal_pauses")

    if acoustic.get("available"):
        dynamic_range = float(acoustic["rmsDynamicRangeDb"])
        active_ratio = float(acoustic["activeFrameRatio"])
        overall_rms = float(acoustic["overallRmsDbfs"])
        # Dynamics has a deliberate floor: calm, even delivery is not weak by
        # itself and can pass when timing, continuity, and audibility agree.
        dynamics = _linear_score(
            dynamic_range,
            ((0.0, 62.0), (1.0, 64.0), (2.0, 70.0), (3.0, 80.0),
             (6.0, 100.0), (30.0, 100.0)),
        )
        signal = min(
            _linear_score(
                overall_rms,
                ((-240.0, 10.0), (-52.0, 20.0), (-44.0, 70.0),
                 (-36.0, 100.0), (0.0, 100.0)),
            ),
            _linear_score(
                active_ratio,
                ((0.0, 10.0), (0.12, 20.0), (0.25, 70.0),
                 (0.35, 100.0), (1.0, 100.0)),
            ),
        )
        components.update({"rmsDynamics": dynamics, "activeSignal": signal})
        weights.update({"rmsDynamics": 0.20, "activeSignal": 0.10})
        if dynamic_range < 1.0:
            severe.append("dynamics:very_low_rms_variation")
        elif dynamic_range < 2.0:
            moderate.append("dynamics:low_rms_variation")
        if overall_rms < -52.0 or active_ratio < 0.12:
            severe.append("signal:very_low_active_signal")
        elif overall_rms < -44.0 or active_ratio < 0.25:
            moderate.append("signal:low_active_signal")

    total_weight = sum(weights.values())
    score = sum(components[key] * weights[key] for key in weights) / total_weight
    categories = sorted(
        {
            signal.split(":", 1)[0]
            for signal in [*moderate, *severe]
        }
    )
    return {
        "score": round(max(0.0, min(100.0, score)), 3),
        "components": {
            key: round(float(value), 3) for key, value in components.items()
        },
        "moderateSignals": moderate,
        "severeSignals": severe,
        "corroboratingCategories": categories,
    }


def _clarity_delivery_reasons(report: Optional[Dict]) -> tuple[list[str], list[str], list[str]]:
    if report is None:
        return [], ["delivery_quality_spoken_clarity_report_missing"], []
    all_reasons = _unique(
        [
            *report.get("rejectionReasons", []),
            *report.get("reviewReasons", []),
        ]
    )
    rejects = [reason for reason in all_reasons if reason in _PRESERVED_REJECT_REASONS]
    reviews = [reason for reason in all_reasons if reason in _PRESERVED_REVIEW_REASONS]
    non_delivery = [reason for reason in all_reasons if reason not in {*rejects, *reviews}]
    return rejects, reviews, non_delivery


def evaluate_delivery_quality_evidence(
    *,
    source_hash: str,
    transcript_timing_hash: str,
    speech_start: float,
    speech_end: float,
    timed_words: Iterable[object],
    spoken_clarity_report: Optional[Dict],
    acoustic_measurements: Mapping[str, object],
    provider_status: str = "ok",
    provider_identity: Optional[object] = None,
) -> Dict:
    """Build one canonical DeliveryQuality report from bounded evidence."""
    normalized_source_hash = _sha256(source_hash, "source_hash")
    normalized_transcript_hash = _sha256(
        transcript_timing_hash, "transcript_timing_hash"
    )
    start = _finite(speech_start, "speech_start")
    end = _finite(speech_end, "speech_end")
    if start < 0.0 or end <= start:
        raise ArtifactBindingError("speech interval is invalid")
    words = _normalise_timed_words(
        timed_words, speech_start=start, speech_end=end
    )
    provider = _provider_status(provider_status)
    identity = _strict_json(provider_identity, "provider_identity")
    acoustic = _normalise_acoustic_measurements(acoustic_measurements)
    if acoustic["available"]:
        expected_samples = round((end - start) * DELIVERY_QUALITY_SAMPLE_RATE)
        tolerance = max(2, round(DELIVERY_QUALITY_SAMPLE_RATE * 0.020))
        if abs(int(acoustic["sampleCount"]) - expected_samples) > tolerance:
            raise ArtifactBindingError(
                "acoustic evidence does not cover the exact speech interval"
            )
    clarity = None
    if spoken_clarity_report is not None:
        clarity = verify_spoken_clarity_report(
            spoken_clarity_report,
            source_hash=normalized_source_hash,
            transcript_timing_hash=normalized_transcript_hash,
            speech_interval=(start, end),
        )
        clarity_words = [
            {
                "text": str(word["text"]),
                "startSeconds": float(word["startSeconds"]),
                "endSeconds": float(word["endSeconds"]),
                **(
                    {"sentenceBoundaryAfter": word["sentenceBoundaryAfter"]}
                    if word.get("sentenceBoundaryAfter") is not None
                    else {}
                ),
            }
            for word in clarity["inputs"]["referenceWords"]
        ]
        if clarity_words != words:
            raise ArtifactBindingError(
                "delivery-quality timed words disagree with SpokenClarity evidence"
            )

    timing = _speech_timing_metrics(words, start, end)
    strength = _delivery_strength(timing, acoustic)
    rejects, reviews, non_delivery = _clarity_delivery_reasons(clarity)
    if clarity is not None and clarity.get("providerStatus") != "ok":
        reviews.append("delivery_quality_spoken_clarity_provider_not_ok")
    if provider != "ok":
        reviews.append("delivery_quality_provider_not_ok")
    if not timing["available"]:
        reviews.append("delivery_quality_timed_words_missing")
    if not acoustic["available"]:
        reviews.append("delivery_quality_acoustic_evidence_missing")

    score = strength["score"]
    categories = strength["corroboratingCategories"]
    severe = strength["severeSignals"]
    evidence_complete = (
        provider == "ok"
        and timing["available"]
        and acoustic["available"]
        and clarity is not None
        and clarity.get("providerStatus") == "ok"
    )
    if evidence_complete and score is not None:
        if (
            score < float(DELIVERY_QUALITY_POLICY["veryLowStrengthMaximum"])
            and len(categories)
            >= int(
                DELIVERY_QUALITY_POLICY[
                    "veryLowMinimumCorroboratingCategories"
                ]
            )
            and bool(severe)
        ):
            rejects.append("delivery_quality_very_low_strength_corroborated")
        elif (
            score < float(DELIVERY_QUALITY_POLICY["borderlineStrengthMaximum"])
            and (len(categories) >= 2 or bool(severe))
        ):
            reviews.append("delivery_quality_borderline_strength")

    rejects = _unique(rejects)
    reviews = _unique(reviews)
    if rejects:
        status = "reject"
    elif reviews:
        status = "review"
    else:
        status = "pass"
    payload = {
        "schemaVersion": DELIVERY_QUALITY_REPORT_SCHEMA_VERSION,
        "artifactType": DELIVERY_QUALITY_REPORT_TYPE,
        "decisionVersion": DELIVERY_QUALITY_DECISION_VERSION,
        "analyzerVersion": DELIVERY_QUALITY_ANALYZER_VERSION,
        "sourceHash": normalized_source_hash,
        "transcriptTimingHash": normalized_transcript_hash,
        "speechInterval": {
            "startSeconds": start,
            "endSeconds": end,
            "semantics": "half-open",
        },
        "providerStatus": provider,
        "providerIdentity": identity,
        "policy": dict(DELIVERY_QUALITY_POLICY),
        "inputs": {
            "timedWords": words,
            "spokenClarityReport": clarity,
            "acousticMeasurements": acoustic,
        },
        "evidence": {
            "speechTiming": timing,
            "rmsDynamics": acoustic,
            "spokenClarity": (
                {
                    "reportHash": clarity["contentHash"],
                    "decisionVersion": clarity["decisionVersion"],
                    "status": clarity["status"],
                    "providerStatus": clarity["providerStatus"],
                    "preservedRejectionReasons": [
                        reason
                        for reason in clarity.get("rejectionReasons", [])
                        if reason in _PRESERVED_REJECT_REASONS
                    ],
                    "preservedReviewReasons": [
                        reason
                        for reason in clarity.get("reviewReasons", [])
                        if reason in _PRESERVED_REVIEW_REASONS
                    ],
                    "nonDeliveryReasons": non_delivery,
                }
                if clarity is not None
                else None
            ),
        },
        "deliveryStrength": score,
        "deliveryStrengthComponents": strength["components"],
        "deliveryStrengthSignals": {
            "moderate": strength["moderateSignals"],
            "severe": strength["severeSignals"],
            "corroboratingCategories": categories,
        },
        "status": status,
        "eligible": status == "pass",
        "rejectionReasons": rejects,
        "reviewReasons": reviews,
        "deterministicReasons": rejects + reviews,
        "audioHandling": {
            "sourceAudioModified": False,
            "readOnlyDecode": True,
            "affectInferenceUsed": False,
            "confidenceOrEmotionInferred": False,
            "policy": "measure_delivery_without_rewriting_source_speech",
        },
    }
    return {**payload, "contentHash": content_hash(payload)}


def verify_delivery_quality_report(
    report: Dict,
    source_hash: Optional[str] = None,
    transcript_timing_hash: Optional[str] = None,
    speech_interval: Optional[Sequence[float]] = None,
    require_pass: bool = False,
) -> Dict:
    """Verify the report seal, exact bindings, and canonical decision."""
    verified = verify_seal(report, DELIVERY_QUALITY_REPORT_TYPE)
    if (
        verified.get("schemaVersion") != DELIVERY_QUALITY_REPORT_SCHEMA_VERSION
        or verified.get("decisionVersion") != DELIVERY_QUALITY_DECISION_VERSION
        or verified.get("analyzerVersion") != DELIVERY_QUALITY_ANALYZER_VERSION
    ):
        raise ArtifactBindingError("unsupported delivery-quality report version")
    actual_source = _sha256(verified.get("sourceHash"), "report.sourceHash")
    actual_transcript = _sha256(
        verified.get("transcriptTimingHash"), "report.transcriptTimingHash"
    )
    if source_hash is not None and actual_source != _sha256(source_hash, "source_hash"):
        raise ArtifactBindingError("delivery-quality report references another source")
    if transcript_timing_hash is not None and actual_transcript != _sha256(
        transcript_timing_hash, "transcript_timing_hash"
    ):
        raise ArtifactBindingError("delivery-quality report references another transcript")
    interval = verified.get("speechInterval")
    if not isinstance(interval, dict) or interval.get("semantics") != "half-open":
        raise ArtifactBindingError("delivery-quality interval contract is invalid")
    start = _finite(interval.get("startSeconds"), "report.speechInterval.start")
    end = _finite(interval.get("endSeconds"), "report.speechInterval.end")
    if start < 0.0 or end <= start:
        raise ArtifactBindingError("delivery-quality interval is invalid")
    if speech_interval is not None:
        if len(speech_interval) != 2:
            raise ArtifactBindingError("speech_interval must contain start and end")
        expected = (
            _finite(speech_interval[0], "speech_interval.start"),
            _finite(speech_interval[1], "speech_interval.end"),
        )
        if (start, end) != expected:
            raise ArtifactBindingError("delivery-quality report interval is stale")
    inputs = verified.get("inputs")
    if not isinstance(inputs, dict) or set(inputs) != {
        "timedWords",
        "spokenClarityReport",
        "acousticMeasurements",
    }:
        raise ArtifactBindingError("delivery-quality inputs are invalid")
    expected_report = evaluate_delivery_quality_evidence(
        source_hash=actual_source,
        transcript_timing_hash=actual_transcript,
        speech_start=start,
        speech_end=end,
        timed_words=inputs["timedWords"],
        spoken_clarity_report=inputs["spokenClarityReport"],
        acoustic_measurements=inputs["acousticMeasurements"],
        provider_status=verified.get("providerStatus"),
        provider_identity=verified.get("providerIdentity"),
    )
    if expected_report != verified:
        raise ArtifactBindingError("delivery-quality report is not canonical")
    if verified.get("status") not in _STATUS_VALUES:
        raise ArtifactBindingError("delivery-quality status is invalid")
    if require_pass and verified.get("status") != "pass":
        raise ArtifactBindingError("delivery-quality report is not eligible")
    return verified


__all__ = [
    "DELIVERY_QUALITY_ACOUSTIC_PROVIDER",
    "DELIVERY_QUALITY_ANALYZER_VERSION",
    "DELIVERY_QUALITY_DECISION_VERSION",
    "DELIVERY_QUALITY_POLICY",
    "DELIVERY_QUALITY_REPORT_SCHEMA_VERSION",
    "DELIVERY_QUALITY_REPORT_TYPE",
    "DELIVERY_QUALITY_SAMPLE_RATE",
    "evaluate_delivery_quality_evidence",
    "verify_delivery_quality_report",
]
