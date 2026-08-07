"""Deterministic semantic music envelopes for motivational Shorts.

The planner is intentionally pure: it does not inspect audio, call a model, or
run FFmpeg.  It converts already-approved semantic and word-timing evidence
into a small, versioned gain envelope.  Rendering remains a separate concern.
"""
from __future__ import annotations

import math
import re
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


DYNAMIC_MUSIC_PLAN_VERSION = "bf_dynamic_music_v1.0.0"
DYNAMIC_MUSIC_SCHEMA_VERSION = 1
DYNAMIC_MUSIC_MIN_GAIN = 0.42
DYNAMIC_MUSIC_MAX_GAIN = 1.02
DYNAMIC_MUSIC_MIN_TRANSITION_SECONDS = 0.12

_TOKEN_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?", re.IGNORECASE)

# These are amplitude multipliers applied after the existing quiet music-bed
# loudness normalization.  They deliberately stay close to the established
# licensed_low_bed_v1 range; dynamics communicate structure without competing
# with speech.
DYNAMIC_MUSIC_PROFILE_GAINS: Dict[str, Dict[str, float]] = {
    "reflective": {
        "entry": 0.46,
        "bed": 0.66,
        "build": 0.82,
        "pocket": 0.52,
        "emphasis": 0.92,
        "release": 0.66,
    },
    "driving": {
        "entry": 0.48,
        "bed": 0.70,
        "build": 0.88,
        "pocket": 0.54,
        "emphasis": 0.98,
        "release": 0.70,
    },
    "warm": {
        "entry": 0.46,
        "bed": 0.68,
        "build": 0.84,
        "pocket": 0.52,
        "emphasis": 0.94,
        "release": 0.68,
    },
}


def _finite(value: object) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _tokens(value: object) -> List[str]:
    return _TOKEN_RE.findall(
        str(value or "")
        .lower()
        .replace("’", "'")
        .replace("‘", "'")
        .replace("`", "'")
    )


def _caption_words(caption_cues: Sequence[Dict]) -> List[Dict]:
    """Return one ordered record per spoken word from progressive cues."""
    records: Dict[Tuple[str, float, float], Dict] = {}
    for cue in caption_cues:
        for event in cue.get("reveal_events") or ():
            token = _tokens(event.get("word"))
            start = _finite(event.get("spoken_start"))
            end = _finite(event.get("spoken_end"))
            if not token or start is None or end is None or end < start:
                continue
            key = (token[0], round(start, 6), round(end, 6))
            records[key] = {
                "token": token[0],
                "text": str(event.get("word") or "").strip(),
                "start": start,
                "end": end,
                "sentence_id": cue.get("sentence_id"),
                "phrase_id": cue.get("phrase_id"),
            }

    # Lightweight fixtures and external callers may provide one cue per word
    # instead of the renderer's progressive reveal_events contract.
    if not records:
        for cue in caption_cues:
            text_tokens = _tokens(cue.get("word", cue.get("text")))
            start = _finite(cue.get("spoken_start", cue.get("start")))
            end = _finite(cue.get("spoken_end", cue.get("end")))
            if len(text_tokens) != 1 or start is None or end is None or end < start:
                continue
            key = (text_tokens[0], round(start, 6), round(end, 6))
            records[key] = {
                "token": text_tokens[0],
                "text": str(cue.get("word", cue.get("text")) or "").strip(),
                "start": start,
                "end": end,
                "sentence_id": cue.get("sentence_id"),
                "phrase_id": cue.get("phrase_id"),
            }
    return sorted(records.values(), key=lambda word: (word["start"], word["end"]))


def _phrase_span(words: Sequence[Dict], phrase: object) -> Optional[Tuple[float, float]]:
    phrase_tokens = _tokens(phrase)
    if not phrase_tokens or len(phrase_tokens) > len(words):
        return None
    word_tokens = [str(word["token"]) for word in words]
    width = len(phrase_tokens)
    for index in range(0, len(word_tokens) - width + 1):
        if word_tokens[index : index + width] == phrase_tokens:
            return float(words[index]["start"]), float(words[index + width - 1]["end"])
    return None


def _candidate_relative_seconds(candidate: Dict, *keys: str) -> Optional[float]:
    duration = _finite(candidate.get("duration_seconds"))
    origin = _finite(candidate.get("render_start_time", candidate.get("start_time")))
    for key in keys:
        value = _finite(candidate.get(key))
        if value is None:
            continue
        if value >= 0.0 and (duration is None or value <= duration + 0.5):
            return value
        if origin is not None and value >= origin:
            return value - origin
    return None


def _nested_measurement(candidate: Dict, key: str) -> Optional[float]:
    for report_key in ("hook_gate_report", "hookGateReport", "hook_gate_v3_report"):
        report = candidate.get(report_key)
        if not isinstance(report, dict):
            continue
        measurements = report.get("measurements")
        if isinstance(measurements, dict):
            value = _finite(measurements.get(key))
            if value is not None:
                return value
    return None


def _first_sentence_end(words: Sequence[Dict]) -> Optional[float]:
    if not words:
        return None
    first_id = words[0].get("sentence_id")
    if first_id is not None:
        sentence = [word for word in words if word.get("sentence_id") == first_id]
        if sentence:
            return max(float(word["end"]) for word in sentence)
    return None


def _last_phrase_start(words: Sequence[Dict]) -> Optional[float]:
    phrase_ids = [word.get("phrase_id") for word in words]
    concrete_ids = [value for value in phrase_ids if value is not None]
    if not concrete_ids:
        return None
    final_id = concrete_ids[-1]
    final_words = [word for word in words if word.get("phrase_id") == final_id]
    return min((float(word["start"]) for word in final_words), default=None)


def resolve_semantic_music_anchors(
    candidate: Dict,
    caption_cues: Sequence[Dict],
    duration: float,
    speech_end_seconds: float,
    natural_tail_end_seconds: Optional[float] = None,
) -> Dict:
    """Resolve clip-relative hook/payoff anchors with explicit provenance."""
    clip_duration = _finite(duration)
    speech_end = _finite(speech_end_seconds)
    if clip_duration is None or clip_duration <= 0.0:
        raise ValueError("duration must be a positive finite number")
    if speech_end is None or not 0.0 < speech_end <= clip_duration + 0.001:
        raise ValueError("speech_end_seconds must be inside the clip")
    candidate_with_duration = {**candidate, "duration_seconds": clip_duration}
    words = _caption_words(caption_cues)
    fallbacks: List[str] = []

    # HookGate V4 owns the complete opening proposition. Prefer that exact
    # aligned quote over the legacy hook sentence so the envelope follows the
    # meaning-bearing unit, not an arbitrary early phrase.
    hook_phrase = (
        candidate.get("opening_unit_exact_quote")
        or candidate.get("hook_sentence")
    )
    hook_span = _phrase_span(words, hook_phrase)
    if hook_span is not None:
        hook_end = hook_span[1]
        hook_source = (
            "opening_unit_exact_quote"
            if candidate.get("opening_unit_exact_quote")
            else "hook_sentence_phrase"
        )
    else:
        hook_end = _candidate_relative_seconds(
            candidate_with_duration,
            "hook_sentence_end_seconds",
            "hook_end_seconds",
        )
        hook_source = "candidate_timing"
        if hook_end is None:
            hook_end = _nested_measurement(candidate, "firstClauseEndSeconds")
            hook_source = "hook_gate_first_clause"
        if hook_end is None:
            hook_end = _first_sentence_end(words)
            hook_source = "caption_first_sentence"
        if hook_end is None:
            hook_end = min(2.0, speech_end * 0.25)
            hook_source = "duration_fallback"
        fallbacks.append(f"hook:{hook_source}")

    payoff_start = None
    payoff_end = None
    payoff_source = ""
    payoff_phrases: Iterable[Tuple[str, object]] = (
        ("strong_point_phrase", candidate.get("strong_point_phrase")),
        ("payoff_exact_quote", candidate.get("payoff_exact_quote")),
        ("hook_payoff_phrase", candidate.get("hook_payoff_phrase")),
        ("final_takeaway_sentence", candidate.get("final_takeaway_sentence")),
    )
    for label, phrase in payoff_phrases:
        span = _phrase_span(words, phrase)
        if span is not None:
            payoff_start, payoff_end = span
            payoff_source = label
            break
    if payoff_start is None:
        payoff_start = _candidate_relative_seconds(
            candidate_with_duration,
            "strong_point_start_seconds",
            "payoff_start_seconds",
            "hook_payoff_start_seconds",
        )
        payoff_source = "candidate_timing"
    if payoff_start is None:
        payoff_start = _nested_measurement(candidate, "firstPayoffSeconds")
        payoff_source = "hook_gate_first_payoff"
    if payoff_start is None:
        payoff_start = _last_phrase_start(words)
        payoff_source = "caption_last_phrase"
    if payoff_start is None:
        payoff_start = speech_end * 0.72
        payoff_source = "duration_fallback"
    if payoff_source not in {
        "strong_point_phrase",
        "payoff_exact_quote",
        "hook_payoff_phrase",
        "final_takeaway_sentence",
    }:
        fallbacks.append(f"payoff:{payoff_source}")

    if payoff_end is None:
        strong_end = _candidate_relative_seconds(
            candidate_with_duration,
            "strong_point_end_seconds",
            "payoff_end_seconds",
        )
        payoff_end = strong_end if strong_end is not None else payoff_start + 0.90

    hook_end = _clamp(float(hook_end), 0.0, speech_end)
    payoff_start = _clamp(float(payoff_start), 0.0, speech_end)
    payoff_end = _clamp(float(payoff_end), payoff_start, speech_end)
    tail_end = _finite(natural_tail_end_seconds)
    if tail_end is None:
        tail_end = clip_duration
    tail_end = _clamp(tail_end, speech_end, clip_duration)
    return {
        "hookEndSeconds": round(hook_end, 3),
        "payoffStartSeconds": round(payoff_start, 3),
        "payoffEndSeconds": round(payoff_end, 3),
        "speechEndSeconds": round(speech_end, 3),
        "naturalTailEndSeconds": round(tail_end, 3),
        "hookSource": hook_source,
        "payoffSource": payoff_source,
        "fallbackReasons": fallbacks,
    }


def _append_event(
    events: List[Dict],
    kind: str,
    start: float,
    end: float,
    end_gain: float,
    initial_gain: Optional[float] = None,
) -> None:
    if events:
        # Folding a sub-120ms phase must not leave an uncovered gap before the
        # next useful ramp.
        start = float(events[-1]["endSeconds"])
    if end - start < DYNAMIC_MUSIC_MIN_TRANSITION_SECONDS - 1e-9:
        return
    start_gain = (
        float(events[-1]["endGain"])
        if events
        else _clamp(
            end_gain if initial_gain is None else initial_gain,
            DYNAMIC_MUSIC_MIN_GAIN,
            DYNAMIC_MUSIC_MAX_GAIN,
        )
    )
    events.append(
        {
            "type": kind,
            "startSeconds": round(start, 3),
            "endSeconds": round(end, 3),
            "startGain": round(start_gain, 3),
            "endGain": round(
                _clamp(end_gain, DYNAMIC_MUSIC_MIN_GAIN, DYNAMIC_MUSIC_MAX_GAIN),
                3,
            ),
            "curve": "linear",
        }
    )


def build_dynamic_music_plan(
    candidate: Dict,
    caption_cues: Sequence[Dict],
    duration: float,
    speech_end_seconds: float,
    natural_tail_end_seconds: Optional[float] = None,
    music_profile: Optional[str] = None,
) -> Dict:
    """Build a restrained semantic build/pocket/emphasis/release envelope."""
    profile = str(music_profile or candidate.get("music_profile") or "reflective").lower()
    if profile not in DYNAMIC_MUSIC_PROFILE_GAINS:
        choices = ", ".join(sorted(DYNAMIC_MUSIC_PROFILE_GAINS))
        raise ValueError(f"unknown dynamic music profile {profile!r}; use {choices}")
    clip_duration = float(duration)
    anchors = resolve_semantic_music_anchors(
        candidate,
        caption_cues,
        clip_duration,
        speech_end_seconds,
        natural_tail_end_seconds,
    )
    gains = DYNAMIC_MUSIC_PROFILE_GAINS[profile]
    payoff = float(anchors["payoffStartSeconds"])
    payoff_end = float(anchors["payoffEndSeconds"])
    hook_end = float(anchors["hookEndSeconds"])
    speech_end = float(anchors["speechEndSeconds"])
    tail_end = float(anchors["naturalTailEndSeconds"])

    entry_end = min(0.35, max(0.12, min(payoff * 0.35, speech_end * 0.08)))
    pocket_start = max(entry_end, payoff - 0.18)
    build_start = max(
        entry_end,
        pocket_start - 1.20,
        hook_end if payoff - hook_end >= 0.30 else entry_end,
    )
    pocket_end = min(speech_end, payoff + 0.12)
    emphasis_end = min(speech_end, max(pocket_end, min(payoff_end, payoff + 0.90)))

    # Consecutive events form a continuous piecewise-linear envelope.  Short
    # phases are omitted instead of creating clicks or zero-duration ramps.
    events: List[Dict] = []
    _append_event(
        events,
        "entry",
        0.0,
        entry_end,
        gains["bed"],
        initial_gain=gains["entry"],
    )
    if build_start > entry_end:
        _append_event(events, "hook_hold", entry_end, build_start, gains["bed"])
    _append_event(events, "semantic_build", build_start, pocket_start, gains["build"])
    _append_event(events, "clarity_pocket", pocket_start, pocket_end, gains["pocket"])
    _append_event(events, "stable_emphasis", pocket_end, emphasis_end, gains["emphasis"])
    _append_event(events, "controlled_release", emphasis_end, speech_end, gains["release"])
    _append_event(events, "natural_tail_hold", speech_end, tail_end, gains["release"])

    # Ensure the envelope covers the complete requested timeline even when an
    # unusually early semantic anchor caused one or more named phases to fold.
    if not events:
        _append_event(
            events,
            "restrained_bed",
            0.0,
            clip_duration,
            gains["bed"],
            initial_gain=gains["entry"],
        )
    elif float(events[-1]["endSeconds"]) < tail_end - 0.001:
        remaining = tail_end - float(events[-1]["endSeconds"])
        if remaining < DYNAMIC_MUSIC_MIN_TRANSITION_SECONDS:
            events[-1]["endSeconds"] = round(tail_end, 3)
        else:
            _append_event(
                events,
                "controlled_release",
                float(events[-1]["endSeconds"]),
                tail_end,
                gains["release"],
            )

    plan = {
        "schemaVersion": DYNAMIC_MUSIC_SCHEMA_VERSION,
        "planVersion": DYNAMIC_MUSIC_PLAN_VERSION,
        "musicProfile": profile,
        "durationSeconds": round(clip_duration, 3),
        "anchors": anchors,
        "events": events,
        "constraints": {
            "minimumGain": DYNAMIC_MUSIC_MIN_GAIN,
            "maximumGain": DYNAMIC_MUSIC_MAX_GAIN,
            "minimumTransitionSeconds": DYNAMIC_MUSIC_MIN_TRANSITION_SECONDS,
            "speechDominant": True,
            "randomEffectsAllowed": False,
            "soundEffectsAllowed": False,
            "visualEventsAllowed": False,
        },
    }
    validate_dynamic_music_plan(plan)
    return plan


def validate_dynamic_music_plan(plan: Dict) -> None:
    """Raise ``ValueError`` if a plan can click, jump, or escape its bounds."""
    if plan.get("planVersion") != DYNAMIC_MUSIC_PLAN_VERSION:
        raise ValueError("dynamic music plan version mismatch")
    duration = _finite(plan.get("durationSeconds"))
    events = plan.get("events")
    if duration is None or duration <= 0.0 or not isinstance(events, list) or not events:
        raise ValueError("dynamic music plan requires duration and events")
    previous_end = 0.0
    previous_gain: Optional[float] = None
    for event in events:
        start = _finite(event.get("startSeconds"))
        end = _finite(event.get("endSeconds"))
        start_gain = _finite(event.get("startGain"))
        end_gain = _finite(event.get("endGain"))
        if None in {start, end, start_gain, end_gain}:
            raise ValueError("dynamic music event contains a non-finite value")
        assert start is not None and end is not None
        assert start_gain is not None and end_gain is not None
        if abs(start - previous_end) > 0.001:
            raise ValueError("dynamic music events must be contiguous")
        if end - start < DYNAMIC_MUSIC_MIN_TRANSITION_SECONDS - 0.001:
            raise ValueError("dynamic music event is shorter than the click guard")
        if not (
            DYNAMIC_MUSIC_MIN_GAIN <= start_gain <= DYNAMIC_MUSIC_MAX_GAIN
            and DYNAMIC_MUSIC_MIN_GAIN <= end_gain <= DYNAMIC_MUSIC_MAX_GAIN
        ):
            raise ValueError("dynamic music gain is outside the restrained range")
        if previous_gain is not None and abs(start_gain - previous_gain) > 0.001:
            raise ValueError("dynamic music envelope has a gain discontinuity")
        if event.get("curve") != "linear":
            raise ValueError("dynamic music v1 allows only linear ramps")
        previous_end = end
        previous_gain = end_gain
    expected_end = float(plan["anchors"]["naturalTailEndSeconds"])
    if abs(previous_end - expected_end) > 0.001:
        raise ValueError("dynamic music envelope does not cover the semantic timeline")


def volume_filter_from_plan(plan: Dict) -> str:
    """Compile a validated plan to one deterministic FFmpeg volume filter."""
    validate_dynamic_music_plan(plan)
    events = list(plan["events"])
    expression = f"{float(events[-1]['endGain']):.3f}"
    for event in reversed(events):
        start = float(event["startSeconds"])
        end = float(event["endSeconds"])
        start_gain = float(event["startGain"])
        end_gain = float(event["endGain"])
        ramp = (
            f"{start_gain:.3f}+({end_gain:.3f}-{start_gain:.3f})"
            f"*(t-{start:.3f})/{end - start:.3f}"
        )
        expression = f"if(lt(t,{end:.3f}),{ramp},{expression})"
    return f"volume='{expression}':eval=frame"


__all__ = [
    "DYNAMIC_MUSIC_MAX_GAIN",
    "DYNAMIC_MUSIC_MIN_GAIN",
    "DYNAMIC_MUSIC_MIN_TRANSITION_SECONDS",
    "DYNAMIC_MUSIC_PLAN_VERSION",
    "DYNAMIC_MUSIC_PROFILE_GAINS",
    "build_dynamic_music_plan",
    "resolve_semantic_music_anchors",
    "validate_dynamic_music_plan",
    "volume_filter_from_plan",
]
