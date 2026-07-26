"""Deterministic semantic-closure and natural-tail policy for growth V2.

The model proposes an exact closing quote.  Python verifies that quote against
the timed transcript, seals the spoken endpoint, and plans only authentic
source footage between the final word and the next spoken word.  The renderer
is not allowed to create semantic completion with a freeze, black frames, or a
longer fade.
"""
from __future__ import annotations

import math
import re
from typing import Dict, List, Optional, Sequence, Tuple


SEMANTIC_CLOSURE_DECISION_VERSION = "semantic-closure-decision-v1.0.0"
NATURAL_TAIL_POLICY_VERSION = "natural-source-tail-v1.0.0"

CLOSURE_PREFERRED_MIN_SECONDS = 15.0
CLOSURE_PREFERRED_MAX_SECONDS = 21.0
CLOSURE_SOFT_MAX_SECONDS = 25.0
CLOSURE_HARD_MIN_SECONDS = 8.0
CLOSURE_HARD_MAX_SECONDS = 30.0
CLOSURE_STRONG_EVIDENCE_MIN_SCORE = 85.0
CLOSURE_WORD_END_TOLERANCE_SECONDS = 0.05
NATURAL_TAIL_MAX_SECONDS = 0.75
NEXT_SPEECH_SAFETY_SECONDS = 0.04
POST_SOURCE_FADE_SECONDS = 0.13

_TOKEN_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?", re.IGNORECASE)
_INCOMPLETE_FINAL_WORDS = frozenset(
    {
        "and",
        "because",
        "but",
        "if",
        "or",
        "so",
        "then",
        "though",
        "unless",
        "until",
        "when",
        "whenever",
        "where",
        "whereas",
        "which",
        "while",
        "yet",
    }
)
_INCOMPLETE_FINAL_PHRASES = (
    ("and", "then"),
    ("because", "of"),
    ("but", "then"),
    ("if", "you"),
    ("the", "reason", "is"),
    ("what", "happens", "is"),
    ("which", "means"),
)


def _number(value: object, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _tokens(value: object) -> List[str]:
    normalized = (
        str(value or "")
        .lower()
        .replace("’", "'")
        .replace("‘", "'")
        .replace("`", "'")
    )
    return _TOKEN_RE.findall(normalized)


def _timed_words(transcript: Dict) -> List[Dict]:
    words: List[Dict] = []
    source_index = 0
    for segment in transcript.get("segments", []):
        if not isinstance(segment, dict):
            continue
        measured = segment.get("words")
        if not isinstance(measured, list):
            continue
        for word in measured:
            if not isinstance(word, dict):
                continue
            try:
                start = float(word["start"])
                end = float(word["end"])
            except (KeyError, TypeError, ValueError):
                continue
            word_tokens = _tokens(word.get("word") or word.get("text"))
            if not word_tokens or not (math.isfinite(start) and math.isfinite(end)):
                continue
            if end <= start:
                continue
            for token in word_tokens:
                words.append(
                    {
                        "token": token,
                        "text": str(word.get("word") or word.get("text") or ""),
                        "start": start,
                        "end": end,
                        "source_index": source_index,
                    }
                )
            source_index += 1
    return words


def _exact_suffix_span(
    words: Sequence[Dict],
    phrase: object,
    speech_start: float,
    speech_end: float,
    tolerance: float,
) -> Optional[Tuple[int, int]]:
    phrase_tokens = _tokens(phrase)
    if not phrase_tokens:
        return None
    matches: List[Tuple[int, int]] = []
    width = len(phrase_tokens)
    for index in range(0, len(words) - width + 1):
        end_index = index + width - 1
        if [word["token"] for word in words[index : end_index + 1]] != phrase_tokens:
            continue
        start = float(words[index]["start"])
        end = float(words[end_index]["end"])
        if start < speech_start - tolerance or end > speech_end + tolerance:
            continue
        matches.append((index, end_index))
    if not matches:
        return None
    matches.sort(
        key=lambda span: (
            abs(float(words[span[1]]["end"]) - speech_end),
            -float(words[span[1]]["end"]),
        )
    )
    return matches[0]


def _span_payload(words: Sequence[Dict], span: Optional[Tuple[int, int]]) -> Optional[Dict]:
    if span is None:
        return None
    start_index, end_index = span
    return {
        "start_time": round(float(words[start_index]["start"]), 3),
        "end_time": round(float(words[end_index]["end"]), 3),
        "start_source_word_index": int(words[start_index]["source_index"]),
        "end_source_word_index": int(words[end_index]["source_index"]),
        "exact_text": " ".join(
            str(word["text"]).strip() for word in words[start_index : end_index + 1]
        ),
    }


def _unique(values: Sequence[str]) -> List[str]:
    return list(dict.fromkeys(value for value in values if value))


def _closing_quote(candidate: Dict) -> str:
    return str(
        candidate.get("semantic_closure_sentence")
        or candidate.get("earliest_complete_takeaway_sentence")
        or candidate.get("final_takeaway_sentence")
        or ""
    ).strip()


def _duration_bucket(duration: float, policy: Dict) -> str:
    preferred_min = _number(
        policy.get("closure_preferred_min_seconds"),
        CLOSURE_PREFERRED_MIN_SECONDS,
    )
    preferred_max = _number(
        policy.get("closure_preferred_max_seconds"),
        CLOSURE_PREFERRED_MAX_SECONDS,
    )
    soft_max = _number(
        policy.get("closure_soft_max_seconds"),
        CLOSURE_SOFT_MAX_SECONDS,
    )
    hard_max = _number(
        policy.get("closure_hard_max_seconds"),
        CLOSURE_HARD_MAX_SECONDS,
    )
    if duration < preferred_min:
        return "short_complete"
    if duration <= preferred_max:
        return "preferred"
    if duration <= soft_max:
        return "soft_penalty"
    if duration <= hard_max:
        return "strong_evidence_only"
    return "over_hard_limit"


def _duration_fit_score(duration: float, policy: Dict) -> float:
    hard_min = _number(
        policy.get("closure_hard_min_seconds"),
        CLOSURE_HARD_MIN_SECONDS,
    )
    preferred_min = _number(
        policy.get("closure_preferred_min_seconds"),
        CLOSURE_PREFERRED_MIN_SECONDS,
    )
    preferred_max = _number(
        policy.get("closure_preferred_max_seconds"),
        CLOSURE_PREFERRED_MAX_SECONDS,
    )
    soft_max = _number(
        policy.get("closure_soft_max_seconds"),
        CLOSURE_SOFT_MAX_SECONDS,
    )
    hard_max = _number(
        policy.get("closure_hard_max_seconds"),
        CLOSURE_HARD_MAX_SECONDS,
    )
    if preferred_min <= duration <= preferred_max:
        return 100.0
    if hard_min <= duration < preferred_min:
        width = max(0.001, preferred_min - hard_min)
        return 70.0 + (duration - hard_min) / width * 30.0
    if preferred_max < duration <= soft_max:
        width = max(0.001, soft_max - preferred_max)
        return 100.0 - (duration - preferred_max) / width * 20.0
    if soft_max < duration <= hard_max:
        width = max(0.001, hard_max - soft_max)
        return 80.0 - (duration - soft_max) / width * 30.0
    return 0.0


def _strong_long_clip_evidence(candidate: Dict, policy: Dict) -> bool:
    minimum = _number(
        policy.get("closure_strong_evidence_min_score"),
        CLOSURE_STRONG_EVIDENCE_MIN_SCORE,
    )
    required_scores = (
        candidate.get("stop_scroll_score"),
        candidate.get("listener_payoff_score"),
        candidate.get("self_contained_micro_arc_score"),
        candidate.get("closure_score"),
    )
    return all(_number(value, -1.0) >= minimum for value in required_scores)


def evaluate_motivational_closure_v1(
    candidate: Dict,
    transcript: Dict,
    policy: Optional[Dict] = None,
) -> Dict:
    """Seal a V2 spoken endpoint and plan a source-authentic natural tail."""
    item = dict(candidate)
    active_policy = dict(policy or {})
    reject_reasons: List[str] = []
    review_reasons: List[str] = []

    speech_start = _number(
        item.get("speech_start_time", item.get("start_time")),
        -1.0,
    )
    speech_end = _number(
        item.get("speech_end_time", item.get("end_time")),
        -1.0,
    )
    duration = max(0.0, speech_end - speech_start)
    transcript_duration = _number(transcript.get("duration"), -1.0)
    words = _timed_words(transcript)
    tolerance = _number(
        active_policy.get("closure_word_end_tolerance_seconds"),
        CLOSURE_WORD_END_TOLERANCE_SECONDS,
    )
    closing_quote = _closing_quote(item)
    closing_span = (
        _exact_suffix_span(
            words,
            closing_quote,
            speech_start,
            speech_end,
            tolerance,
        )
        if speech_start >= 0.0 and speech_end > speech_start
        else None
    )
    closing_payload = _span_payload(words, closing_span)

    if speech_start < 0.0 or speech_end <= speech_start:
        review_reasons.append("closure_invalid_speech_interval")
    if not words:
        review_reasons.append("closure_word_timing_missing")
    if not closing_quote:
        review_reasons.append("closure_exact_quote_missing")
    elif words and closing_span is None:
        reject_reasons.append("closure_exact_quote_unaligned")
    if closing_span is not None:
        aligned_end = float(words[closing_span[1]]["end"])
        if abs(aligned_end - speech_end) > tolerance:
            reject_reasons.append("closure_speech_end_mismatch")

    if item.get("takeaway_boundary_aligned") is not True:
        reject_reasons.append("closure_takeaway_boundary_unaligned")
    if item.get("semantic_continuation_required") is True:
        reject_reasons.append("closure_required_continuation_missing")
    elif "semantic_continuation_required" not in item:
        review_reasons.append("closure_continuation_evidence_missing")
    if item.get("has_complete_ending") is False:
        reject_reasons.append("closure_model_incomplete_ending")
    elif item.get("has_complete_ending") is not True:
        review_reasons.append("closure_complete_ending_evidence_missing")
    if item.get("has_takeaway") is False:
        reject_reasons.append("closure_model_takeaway_missing")
    elif item.get("has_takeaway") is not True:
        review_reasons.append("closure_takeaway_evidence_missing")
    if item.get("second_topic_begins_after_takeaway") is True:
        reject_reasons.append("closure_second_topic_inside_interval")

    closing_tokens = _tokens(closing_quote)
    if closing_tokens:
        if closing_tokens[-1] in _INCOMPLETE_FINAL_WORDS:
            reject_reasons.append("closure_ends_with_connector")
        if any(
            len(closing_tokens) >= len(phrase)
            and tuple(closing_tokens[-len(phrase) :]) == phrase
            for phrase in _INCOMPLETE_FINAL_PHRASES
        ):
            reject_reasons.append("closure_ends_with_connector")

    hard_min = _number(
        active_policy.get("closure_hard_min_seconds"),
        CLOSURE_HARD_MIN_SECONDS,
    )
    soft_max = _number(
        active_policy.get("closure_soft_max_seconds"),
        CLOSURE_SOFT_MAX_SECONDS,
    )
    hard_max = _number(
        active_policy.get("closure_hard_max_seconds"),
        CLOSURE_HARD_MAX_SECONDS,
    )
    strong_long_clip_evidence = _strong_long_clip_evidence(item, active_policy)
    if duration < hard_min - 0.000001:
        reject_reasons.append("closure_duration_under_hard_min")
    if duration > hard_max + 0.000001:
        reject_reasons.append("closure_duration_over_hard_max")
    elif duration > soft_max + 0.000001 and not strong_long_clip_evidence:
        review_reasons.append("closure_long_clip_requires_strong_evidence")

    final_source_index = (
        int(words[closing_span[1]]["source_index"])
        if closing_span is not None
        else None
    )
    next_word_start = None
    if final_source_index is not None:
        following = [
            float(word["start"])
            for word in words
            if int(word["source_index"]) > final_source_index
        ]
        if following:
            next_word_start = min(following)
    if next_word_start is None and transcript_duration < speech_end:
        review_reasons.append("closure_source_duration_missing")

    safety_seconds = _number(
        active_policy.get("next_speech_safety_seconds"),
        NEXT_SPEECH_SAFETY_SECONDS,
    )
    natural_tail_max = _number(
        active_policy.get("natural_tail_max_seconds"),
        NATURAL_TAIL_MAX_SECONDS,
    )
    fade_seconds = _number(
        active_policy.get("post_source_fade_seconds"),
        POST_SOURCE_FADE_SECONDS,
    )
    safe_tail_end = speech_end
    if speech_end >= 0.0:
        safe_tail_end = speech_end + max(0.0, natural_tail_max)
        if transcript_duration >= speech_end:
            safe_tail_end = min(safe_tail_end, transcript_duration)
        if next_word_start is not None:
            safe_tail_end = min(
                safe_tail_end,
                max(speech_end, next_word_start - max(0.0, safety_seconds)),
            )
        safe_tail_end = max(speech_end, safe_tail_end)

    reject_reasons = _unique(reject_reasons)
    review_reasons = _unique(review_reasons)
    if reject_reasons:
        status = "reject"
    elif review_reasons:
        status = "review"
    else:
        status = "pass"

    item.update(
        {
            "semantic_closure_decision_version": str(
                active_policy.get("semantic_closure_decision_version")
                or SEMANTIC_CLOSURE_DECISION_VERSION
            ),
            "natural_tail_policy_version": str(
                active_policy.get("natural_tail_policy_version")
                or NATURAL_TAIL_POLICY_VERSION
            ),
            "semantic_closure_status": status,
            "semantic_closure_eligible": status == "pass",
            "semantic_closure_reject_reasons": reject_reasons,
            "semantic_closure_review_reasons": review_reasons,
            "semantic_closure_deterministic_reasons": _unique(
                [*reject_reasons, *review_reasons]
            ),
            "semantic_closure_exact_quote": closing_quote,
            "semantic_closure_exact_span": closing_payload,
            "semantic_closure_exact_aligned": closing_span is not None,
            "semantic_closure_speech_start_time": round(speech_start, 3),
            "semantic_closure_speech_end_time": round(speech_end, 3),
            "semantic_closure_duration_seconds": round(duration, 3),
            "semantic_closure_duration_bucket": _duration_bucket(
                duration,
                active_policy,
            ),
            "semantic_closure_duration_fit_score": round(
                _duration_fit_score(duration, active_policy),
                3,
            ),
            "semantic_closure_strong_long_clip_evidence": (
                strong_long_clip_evidence
            ),
            "captions_source_end_time": round(speech_end, 3),
            "natural_tail_start_time": round(speech_end, 3),
            "natural_tail_end_time": round(safe_tail_end, 3),
            "planned_natural_tail_seconds": round(
                max(0.0, safe_tail_end - speech_end),
                3,
            ),
            "next_spoken_word_start": (
                round(next_word_start, 3)
                if next_word_start is not None
                else None
            ),
            "next_speech_safety_seconds": round(safety_seconds, 3),
            "post_source_fade_start_time": round(safe_tail_end, 3),
            "post_source_fade_seconds": round(fade_seconds, 3),
            "freeze_hold_seconds": 0.0,
            "semantic_closure_thresholds": {
                "hard_min_seconds": hard_min,
                "preferred_min_seconds": _number(
                    active_policy.get("closure_preferred_min_seconds"),
                    CLOSURE_PREFERRED_MIN_SECONDS,
                ),
                "preferred_max_seconds": _number(
                    active_policy.get("closure_preferred_max_seconds"),
                    CLOSURE_PREFERRED_MAX_SECONDS,
                ),
                "soft_max_seconds": soft_max,
                "hard_max_seconds": hard_max,
                "strong_evidence_min_score": _number(
                    active_policy.get("closure_strong_evidence_min_score"),
                    CLOSURE_STRONG_EVIDENCE_MIN_SCORE,
                ),
                "natural_tail_max_seconds": natural_tail_max,
                "next_speech_safety_seconds": safety_seconds,
                "post_source_fade_seconds": fade_seconds,
            },
        }
    )
    return item


__all__ = [
    "CLOSURE_HARD_MAX_SECONDS",
    "CLOSURE_HARD_MIN_SECONDS",
    "CLOSURE_PREFERRED_MAX_SECONDS",
    "CLOSURE_PREFERRED_MIN_SECONDS",
    "CLOSURE_SOFT_MAX_SECONDS",
    "CLOSURE_STRONG_EVIDENCE_MIN_SCORE",
    "CLOSURE_WORD_END_TOLERANCE_SECONDS",
    "NATURAL_TAIL_MAX_SECONDS",
    "NATURAL_TAIL_POLICY_VERSION",
    "NEXT_SPEECH_SAFETY_SECONDS",
    "POST_SOURCE_FADE_SECONDS",
    "SEMANTIC_CLOSURE_DECISION_VERSION",
    "evaluate_motivational_closure_v1",
]
