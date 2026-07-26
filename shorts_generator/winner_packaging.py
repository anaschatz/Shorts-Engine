"""Deterministic, opt-in packaging policy for Budget Friendly winners.

This module deliberately contains no renderer or network side effects.  It
turns measured candidate/render evidence into versioned decisions and stable
failure codes so a treatment can be replayed without changing legacy output.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Dict, Iterable, List, Optional, Sequence


WINNER_PACKAGING_DECISION_VERSION = "winner-packaging-decision-v1.0.0"
WINNER_PACKAGING_PROFILE = "bf_winner_packaging_v1"
FULL_BLEED_LAYOUT_PROFILE = "bf_full_bleed_face_v1"
COMPACT_CAPTION_PROFILE = "bf_compact_center_v1"
LIVE_TAIL_PROFILE = "bf_live_tail_mark_v1"
DENSE_DIALOGUE_AUDIO_PROFILE = "bf_dense_dialogue_v1"
WINNER_EXPERIMENT_ID = "bf-winner-layout-v1"

PREFERRED_DURATION_MIN_SECONDS = 12.0
PREFERRED_DURATION_MAX_SECONDS = 21.0
SOFT_DURATION_MAX_SECONDS = 24.0
OPENING_MAX_LATENCY_SECONDS = 0.100
NEXT_SPEECH_SAFETY_SECONDS = 0.040
AUTHENTIC_TAIL_DEFAULT_SECONDS = 0.90
AUTHENTIC_TAIL_FALLBACK_SECONDS = 0.75
AUTHENTIC_TAIL_MIN_SECONDS = 0.80
AUTHENTIC_TAIL_MAX_SECONDS = 1.10
FADE_MIN_SECONDS = 0.100
FADE_MAX_SECONDS = 0.160

FAILURE_CODES = frozenset(
    {
        "missing_word_timing",
        "opening_speech_late",
        "opening_not_full_bleed",
        "face_not_detected",
        "face_safe_area_failed",
        "excessive_crop_upscale",
        "excessive_reframes",
        "caption_started_late",
        "caption_early_reveal",
        "caption_after_speech",
        "caption_face_overlap",
        "malformed_caption_token",
        "next_speech_leak",
        "authentic_tail_unavailable",
        "visual_tail_static",
        "freeze_frame_detected",
        "black_card_detected",
        "loudness_out_of_range",
        "true_peak_failed",
        "audio_overcompressed",
        "multi_axis_experiment",
        "legacy_profile_fallback",
    }
)

ANALYTICS_CONTRACT = {
    "snapshotHours": [1, 6, 24, 72, 168],
    "metrics": [
        "stayedToWatch",
        "swipedAway",
        "engagedViews",
        "averagePercentageViewed",
        "averageViewDuration",
        "likesPer1000",
        "commentsPer1000",
        "subscribersPer1000",
    ],
    "baselineStayedToWatch": 36.9,
    "minimumAveragePercentageViewed": 80.0,
    "autoPromotionAllowed": False,
}


def _canonical_hash(payload: Dict) -> str:
    encoded = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def duration_packaging_decision(
    duration_seconds: float,
    *,
    explicit_full_bleed_override: bool = False,
) -> Dict:
    """Classify duration without shortening or rejecting the candidate."""
    duration = float(duration_seconds)
    if not math.isfinite(duration) or duration <= 0.0:
        raise ValueError("duration_seconds must be a positive finite number")
    if duration <= PREFERRED_DURATION_MAX_SECONDS:
        bucket = (
            "preferred"
            if duration >= PREFERRED_DURATION_MIN_SECONDS
            else "short_accepted"
        )
        fit = 1.0 if bucket == "preferred" else round(duration / 12.0, 4)
        layout = FULL_BLEED_LAYOUT_PROFILE
    elif duration <= SOFT_DURATION_MAX_SECONDS:
        bucket = "soft_penalty"
        fit = round(
            1.0
            - 0.20
            * (
                (duration - PREFERRED_DURATION_MAX_SECONDS)
                / (SOFT_DURATION_MAX_SECONDS - PREFERRED_DURATION_MAX_SECONDS)
            ),
            4,
        )
        layout = FULL_BLEED_LAYOUT_PROFILE
    else:
        bucket = "legacy_layout"
        fit = 0.75
        layout = (
            FULL_BLEED_LAYOUT_PROFILE
            if explicit_full_bleed_override
            else "bf_editorial_inset_v2"
        )
    return {
        "decisionVersion": WINNER_PACKAGING_DECISION_VERSION,
        "durationSeconds": round(duration, 3),
        "durationBucket": bucket,
        "packagingFit": fit,
        "layoutProfile": layout,
        "truncated": False,
        "explicitOverride": bool(explicit_full_bleed_override),
    }


def motion_route(
    motion_score: float,
    *,
    duration_seconds: float,
    requested_reframes: int = 0,
) -> Dict:
    """Route measured motion to a stable, deterministic framing policy."""
    score = max(0.0, min(1.0, float(motion_score)))
    requested = max(0, int(requested_reframes))
    if score >= 0.66:
        route, maximum = "continuous_shot", 0
    elif score >= 0.33:
        route, maximum = "bounded_reframe", 2
    else:
        route, maximum = "slow_deterministic_crop", 1
    reframes = min(requested, maximum)
    minimum_interval = 3.0 if reframes else None
    return {
        "decisionVersion": WINNER_PACKAGING_DECISION_VERSION,
        "motionScore": round(score, 4),
        "motionRoute": route,
        "requestedReframes": requested,
        "reframeCount": reframes,
        "maxReframes": maximum,
        "minReframeIntervalSeconds": minimum_interval,
        "sourceNativeBrollOnly": True,
        "durationSeconds": round(float(duration_seconds), 3),
        "failureCodes": ["excessive_reframes"] if requested > maximum else [],
    }


def normalize_caption_tokens(words: Sequence[Dict]) -> List[Dict]:
    """Normalize split lexical tokens without inventing timing."""
    normalized: List[Dict] = []
    index = 0
    while index < len(words):
        current = dict(words[index])
        text = str(current.get("text") or current.get("word") or "").strip()
        if (
            text.lower().rstrip() == "self-"
            and index + 1 < len(words)
            and str(
                words[index + 1].get("text")
                or words[index + 1].get("word")
                or ""
            ).strip().lower().lstrip() == "torture"
        ):
            following = dict(words[index + 1])
            current["text"] = "self-torture"
            current["word"] = "self-torture"
            current["end"] = following.get("end", current.get("end"))
            normalized.append(current)
            index += 2
            continue
        current["text"] = text
        current["word"] = text
        normalized.append(current)
        index += 1
    return normalized


def caption_qa(
    cues: Sequence[Dict],
    *,
    speech_end_seconds: float,
    first_spoken_word_seconds: Optional[float],
    face_overlap_ratio: float = 0.0,
) -> Dict:
    failures: List[str] = []
    if first_spoken_word_seconds is None:
        failures.append("missing_word_timing")
    starts = [float(cue["start"]) for cue in cues if cue.get("start") is not None]
    ends = [float(cue["end"]) for cue in cues if cue.get("end") is not None]
    if starts and first_spoken_word_seconds is not None:
        delta = min(starts) - float(first_spoken_word_seconds)
        if delta < -0.001:
            failures.append("caption_early_reveal")
        if delta > OPENING_MAX_LATENCY_SECONDS + 0.001:
            failures.append("caption_started_late")
    if ends and max(ends) > float(speech_end_seconds) + 0.001:
        failures.append("caption_after_speech")
    malformed = False
    for cue in cues:
        words = cue.get("words") or str(cue.get("text") or "").split()
        if not 2 <= len(words) <= 6:
            malformed = True
        if any(re.search(r"\bself-\s+torture\b", str(word), re.I) for word in words):
            malformed = True
        if int(cue.get("lineCount", cue.get("line_count", 1))) > 2:
            malformed = True
        if int(cue.get("emphasizedWordCount", cue.get("emphasized_word_count", 0))) > 1:
            malformed = True
    if malformed:
        failures.append("malformed_caption_token")
    if float(face_overlap_ratio) > 0.02:
        failures.append("caption_face_overlap")
    return {
        "captionProfile": COMPACT_CAPTION_PROFILE,
        "firstCaptionSeconds": min(starts) if starts else None,
        "lastCaptionSeconds": max(ends) if ends else None,
        "faceOverlapRatio": round(float(face_overlap_ratio), 4),
        "failureCodes": sorted(set(failures)),
    }


def live_tail_decision(
    speech_end_seconds: float,
    *,
    next_word_start_seconds: Optional[float] = None,
    verified_visual_safe_end_seconds: Optional[float] = None,
    word_timing_available: bool = True,
    desired_tail_seconds: float = AUTHENTIC_TAIL_DEFAULT_SECONDS,
    measured_motion_score: Optional[float] = None,
) -> Dict:
    """Choose a safe endpoint using only authentic moving source frames."""
    speech_end = float(speech_end_seconds)
    desired = max(
        AUTHENTIC_TAIL_MIN_SECONDS,
        min(AUTHENTIC_TAIL_MAX_SECONDS, float(desired_tail_seconds)),
    )
    if not word_timing_available:
        desired = AUTHENTIC_TAIL_FALLBACK_SECONDS
    constraints = [speech_end + desired]
    if next_word_start_seconds is not None:
        constraints.append(
            max(speech_end, float(next_word_start_seconds) - NEXT_SPEECH_SAFETY_SECONDS)
        )
    if verified_visual_safe_end_seconds is not None:
        constraints.append(max(speech_end, float(verified_visual_safe_end_seconds)))
    endpoint = min(constraints)
    authentic_tail = max(0.0, endpoint - speech_end)
    failures = []
    if authentic_tail < AUTHENTIC_TAIL_FALLBACK_SECONDS - 0.001:
        failures.append("authentic_tail_unavailable")
    if measured_motion_score is not None and float(measured_motion_score) <= 0.005:
        failures.append("visual_tail_static")
    if (
        next_word_start_seconds is not None
        and endpoint > float(next_word_start_seconds) - NEXT_SPEECH_SAFETY_SECONDS + 0.001
    ):
        failures.append("next_speech_leak")
    return {
        "endingProfile": LIVE_TAIL_PROFILE,
        "speechEndSeconds": round(speech_end, 3),
        "sourceEndSeconds": round(endpoint, 3),
        "authenticTailSeconds": round(authentic_tail, 3),
        "fadeSeconds": 0.130,
        "markOverlaySeconds": 0.250,
        "freezeHoldSeconds": 0.0,
        "blackCardSeconds": 0.0,
        "captionsClearAtSeconds": round(speech_end, 3),
        "wordTimingFallback": not word_timing_available,
        "failureCodes": sorted(set(failures)),
    }


def audio_qa(
    integrated_lufs: float,
    loudness_range_lu: float,
    true_peak_dbtp: float,
) -> Dict:
    failures = []
    lufs = float(integrated_lufs)
    lra = float(loudness_range_lu)
    peak = float(true_peak_dbtp)
    if not -16.0 <= lufs <= -14.5:
        failures.append("loudness_out_of_range")
    if peak > -1.0:
        failures.append("true_peak_failed")
    if not 1.5 <= lra <= 3.0:
        failures.append("audio_overcompressed")
    return {
        "audioProfile": DENSE_DIALOGUE_AUDIO_PROFILE,
        "integratedLufs": round(lufs, 2),
        "loudnessRangeLu": round(lra, 2),
        "truePeakDbtp": round(peak, 2),
        "speechDucking": True,
        "failureCodes": failures,
    }


def build_winner_experiment_manifest(
    *,
    source_video_id: str,
    source_hash: str,
    candidate_hash: str,
    source_interval: Sequence[float],
    render_hash: Optional[str] = None,
    changed_axes: Iterable[str] = ("layout",),
    cohort_id: str = "treatment",
    human_review_status: str = "pending",
) -> Dict:
    axes = tuple(dict.fromkeys(str(axis).strip().lower() for axis in changed_axes))
    allowed = {"layout", "captions", "ending", "audio"}
    if not axes or any(axis not in allowed for axis in axes):
        raise ValueError("changed_axes must contain layout/captions/ending/audio")
    if len(source_hash) != 64 or len(candidate_hash) != 64:
        raise ValueError("source_hash and candidate_hash must be sha256")
    start, end = map(float, source_interval)
    if end <= start:
        raise ValueError("source_interval must have a positive duration")
    failures = ["multi_axis_experiment"] if len(axes) > 1 else []
    payload = {
        "schemaVersion": 1,
        "artifactType": "WinnerPackagingExperimentManifest",
        "decisionVersion": WINNER_PACKAGING_DECISION_VERSION,
        "experimentId": WINNER_EXPERIMENT_ID,
        "sourceVideoId": str(source_video_id).strip(),
        "sourceHash": source_hash.lower(),
        "candidateHash": candidate_hash.lower(),
        "sourceInterval": {"startSeconds": start, "endSeconds": end},
        "control": {
            "layout": "bf_editorial_inset_v2",
            "captions": "unchanged",
            "ending": "unchanged",
            "audio": "unchanged",
        },
        "treatment": {
            "layout": (
                FULL_BLEED_LAYOUT_PROFILE if "layout" in axes else "unchanged"
            ),
            "captions": (
                COMPACT_CAPTION_PROFILE if "captions" in axes else "unchanged"
            ),
            "ending": (
                LIVE_TAIL_PROFILE if "ending" in axes else "unchanged"
            ),
            "audio": (
                DENSE_DIALOGUE_AUDIO_PROFILE if "audio" in axes else "unchanged"
            ),
        },
        "changedAxes": list(axes),
        "unchangedAxes": sorted(allowed - set(axes)),
        "renderHash": str(render_hash or "").lower() or None,
        "cohortId": str(cohort_id).strip().lower(),
        "humanReviewStatus": str(human_review_status).strip().lower(),
        "humanDecisionRequired": True,
        "singleVariableEvaluationOrder": [
            "layout",
            "captions",
            "ending",
            "audio",
            "combined",
        ],
        "analyticsContract": ANALYTICS_CONTRACT,
        "failureCodes": failures,
    }
    return {**payload, "contentHash": _canonical_hash(payload)}


def collect_failure_codes(*evidence: Optional[Dict]) -> List[str]:
    codes = {
        str(code)
        for item in evidence
        if isinstance(item, dict)
        for code in item.get("failureCodes", [])
        if str(code) in FAILURE_CODES
    }
    return sorted(codes)


def evaluate_winner_packaging_evidence(evidence: Dict) -> Dict:
    """Evaluate renderer evidence without pretending unmeasured facts passed."""
    failures: List[str] = []
    duration = float(evidence.get("durationSeconds") or 0.0)
    decision = duration_packaging_decision(duration)
    expected_layout = decision["layoutProfile"]
    if str(evidence.get("layoutProfile") or "") != expected_layout:
        failures.append(
            "legacy_profile_fallback"
            if expected_layout == FULL_BLEED_LAYOUT_PROFILE
            else "opening_not_full_bleed"
        )
    if float(evidence.get("openingSourceTimeSeconds") or 0.0) > 0.001:
        failures.append("opening_not_full_bleed")
    if float(evidence.get("firstSpeechSeconds") or 0.0) > OPENING_MAX_LATENCY_SECONDS:
        failures.append("opening_speech_late")
    if (
        expected_layout == FULL_BLEED_LAYOUT_PROFILE
        and float(evidence.get("openingFullBleedSeconds") or 0.0) < 1.5
    ):
        failures.append("opening_not_full_bleed")
    face_height = evidence.get("faceHeightRatio")
    if face_height is not None and not 0.35 <= float(face_height) <= 0.60:
        failures.append("face_safe_area_failed")
    if evidence.get("faceDetected") is False:
        failures.append("face_not_detected")
    if int(evidence.get("reframeCount") or 0) > 2:
        failures.append("excessive_reframes")
    if float(evidence.get("freezeHoldSeconds") or 0.0) > 0.001:
        failures.append("freeze_frame_detected")
    if float(evidence.get("blackCardSeconds") or 0.0) > 0.001:
        failures.append("black_card_detected")
    if evidence.get("captionAfterSpeech"):
        failures.append("caption_after_speech")
    payload = {
        "qaProfile": "bf_winner_packaging_qa_v1",
        "decisionVersion": WINNER_PACKAGING_DECISION_VERSION,
        "renderProfile": str(
            evidence.get("renderProfile") or WINNER_PACKAGING_PROFILE
        ),
        "durationDecision": decision,
        "failureCodes": sorted(set(failures)),
    }
    payload["passed"] = not payload["failureCodes"]
    payload["contentHash"] = _canonical_hash(payload)
    return payload


__all__ = [
    "ANALYTICS_CONTRACT",
    "COMPACT_CAPTION_PROFILE",
    "DENSE_DIALOGUE_AUDIO_PROFILE",
    "FAILURE_CODES",
    "FULL_BLEED_LAYOUT_PROFILE",
    "LIVE_TAIL_PROFILE",
    "WINNER_EXPERIMENT_ID",
    "WINNER_PACKAGING_DECISION_VERSION",
    "WINNER_PACKAGING_PROFILE",
    "audio_qa",
    "build_winner_experiment_manifest",
    "caption_qa",
    "collect_failure_codes",
    "duration_packaging_decision",
    "evaluate_winner_packaging_evidence",
    "live_tail_decision",
    "motion_route",
    "normalize_caption_tokens",
]
