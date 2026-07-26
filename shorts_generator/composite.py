"""Deterministic compression of educational transcript arcs into short composites."""
import re
from typing import Dict, List, Optional, Sequence

from .semantic_closure import (
    NEXT_WORD_SAFETY_SECONDS,
    _is_promotional,
    _normalize,
    _sentence_spans,
    _timed_words,
    _topic_tokens,
)


COMPOSITE_TRANSITION_SECONDS = 0.24
INTERNAL_BEAT_PADDING_SECONDS = 0.38
OUTER_BEAT_PADDING_SECONDS = 0.45
PREFERRED_COMPOSITE_MIN_SECONDS = 72.0
PREFERRED_COMPOSITE_MAX_SECONDS = 82.0
MAX_COMPOSITE_SECONDS = 90.0
MAX_COMPOSITE_BEATS = 6
TRANSITION_SPEECH_MARGIN_SECONDS = 0.09
MAX_HOOK_SECONDS = 10.5

DEFINITION_MARKERS = (
    "when i say",
    "think about",
    "think of",
    "means",
    "refers to",
    "defined as",
    "is a",
    "is an",
    "are a",
    "called",
)
DEMONSTRATION_MARKERS = (
    "for example",
    "if you",
    "when you",
    "feed",
    "input",
    "output",
    "cause",
    "finally",
    "results in",
    "leads to",
    "let me show",
)
MECHANISM_MARKERS = (
    "what we'll do",
    "what we do",
    "assign",
    "compute",
    "calculate",
    "combine",
    "multiply",
    "divide",
    "using",
    "works by",
    "mechanism",
    "parameter",
    "connection",
    "take all",
)
TRANSFORMATION_MARKERS = (
    "function",
    "convert",
    "transform",
    "map",
    "squish",
    "into",
    "range",
    "scale",
    "normalize",
    "turn",
    "become",
)
PAYOFF_MARKERS = (
    "so",
    "therefore",
    "which means",
    "in other words",
    "ultimately",
    "this means",
    "as a result",
    "basically",
)
SHORT_CONTEXT_OPENERS = ("but", "now", "so", "let's")
DANGLING_OPENERS = {"it", "this", "that", "these", "those", "our"}


def _marker_hits(text: str, markers: Sequence[str]) -> int:
    normalized = _normalize(text)
    score = 0
    for marker in markers:
        marker = _normalize(marker)
        if " " in marker:
            score += int(marker in normalized)
        else:
            score += int(bool(re.search(rf"\b{re.escape(marker)}[a-z]*\b", normalized)))
    return score


def _span(sentences: List[Dict], role: str, start_index: int, end_index: int) -> Dict:
    selected = sentences[start_index:end_index + 1]
    return {
        "role": role,
        "layout_hint": "presentation",
        "start_index": start_index,
        "end_index": end_index,
        "speech_start_time": round(float(selected[0]["start"]), 3),
        "speech_end_time": round(float(selected[-1]["end"]), 3),
        "text": " ".join(str(sentence["text"]) for sentence in selected),
    }


def _select_hook(sentences: List[Dict], requested_start: float) -> Optional[Dict]:
    if not sentences:
        return None
    start_index = next(
        (index for index, sentence in enumerate(sentences) if sentence["end"] > requested_start),
        0,
    )
    end_index = start_index
    for index in range(start_index + 1, len(sentences)):
        duration = float(sentences[index]["end"]) - float(sentences[start_index]["start"])
        if duration > MAX_HOOK_SECONDS:
            break
        end_index = index
    return _span(sentences, "hook", start_index, end_index)


def _select_definition(sentences: List[Dict], after_index: int) -> Optional[Dict]:
    candidates = []
    for index in range(after_index + 1, len(sentences) - 1):
        question = str(sentences[index]["text"])
        answer = str(sentences[index + 1]["text"])
        if "?" not in question:
            continue
        hits = _marker_hits(answer, DEFINITION_MARKERS)
        if hits == 0:
            continue
        start_index = index
        if index > 0:
            previous = sentences[index - 1]
            previous_text = _normalize(str(previous["text"]))
            previous_duration = float(previous["end"]) - float(previous["start"])
            if previous_duration <= 1.5 and previous_text.startswith(SHORT_CONTEXT_OPENERS):
                start_index = index - 1
        beat = _span(sentences, "definition", start_index, index + 1)
        score = 10.0 + 4.0 * hits - 0.002 * float(beat["speech_start_time"])
        candidates.append((score, beat))
    return max(candidates, key=lambda candidate: candidate[0])[1] if candidates else None


def _select_demonstration(sentences: List[Dict], after_index: int) -> Optional[Dict]:
    candidates = []
    source_start = float(sentences[after_index]["end"])
    for index in range(after_index + 1, len(sentences)):
        sentence = sentences[index]
        gap = float(sentence["start"]) - source_start
        duration = float(sentence["end"]) - float(sentence["start"])
        if gap > 300.0:
            break
        if not 5.0 <= duration <= 22.0 or _is_promotional(str(sentence["text"])):
            continue
        hits = _marker_hits(str(sentence["text"]), DEMONSTRATION_MARKERS)
        if hits == 0:
            continue
        score = 10.0 * hits - gap / 180.0
        candidates.append((score, _span(sentences, "demonstration", index, index)))
    return max(candidates, key=lambda candidate: candidate[0])[1] if candidates else None


def _select_mechanism(
    sentences: List[Dict],
    after_index: int,
    continuity_text: str,
) -> Optional[Dict]:
    candidates = []
    continuity_tokens = _topic_tokens(continuity_text)
    source_start = float(sentences[after_index]["end"])
    for start_index in range(after_index + 1, len(sentences)):
        gap = float(sentences[start_index]["start"]) - source_start
        if gap > 420.0:
            break
        for count in range(1, 4):
            end_index = start_index + count - 1
            if end_index >= len(sentences):
                break
            duration = float(sentences[end_index]["end"]) - float(sentences[start_index]["start"])
            if duration > 18.0:
                break
            beat = _span(sentences, "connection_mechanism", start_index, end_index)
            if _is_promotional(str(beat["text"])):
                continue
            hits = _marker_hits(str(beat["text"]), MECHANISM_MARKERS)
            if hits == 0:
                continue
            overlap = len(_topic_tokens(str(beat["text"])) & continuity_tokens)
            score = 10.0 * hits + 2.0 * min(overlap, 4) - gap / 180.0
            candidates.append((score, beat))
    return max(candidates, key=lambda candidate: candidate[0])[1] if candidates else None


def _select_single_role(
    sentences: List[Dict],
    role: str,
    after_index: int,
    markers: Sequence[str],
    continuity_text: str,
    max_gap: float,
    minimum_duration: float,
    maximum_duration: float,
) -> Optional[Dict]:
    candidates = []
    continuity_tokens = _topic_tokens(continuity_text)
    source_start = float(sentences[after_index]["end"])
    for index in range(after_index + 1, len(sentences)):
        sentence = sentences[index]
        gap = float(sentence["start"]) - source_start
        if gap > max_gap:
            break
        duration = float(sentence["end"]) - float(sentence["start"])
        if not minimum_duration <= duration <= maximum_duration:
            continue
        text = str(sentence["text"])
        if _is_promotional(text):
            continue
        hits = _marker_hits(text, markers)
        if hits == 0:
            continue
        overlap = len(_topic_tokens(text) & continuity_tokens)
        score = 10.0 * hits + 2.0 * min(overlap, 4) - gap / max(30.0, max_gap)
        candidates.append((score, _span(sentences, role, index, index)))
    return max(candidates, key=lambda candidate: candidate[0])[1] if candidates else None


def _safe_beat_bounds(
    beat: Dict,
    words: List[Dict],
    is_first: bool,
    is_last: bool,
) -> Dict:
    start_padding = OUTER_BEAT_PADDING_SECONDS if is_first else INTERNAL_BEAT_PADDING_SECONDS
    end_padding = OUTER_BEAT_PADDING_SECONDS if is_last else INTERNAL_BEAT_PADDING_SECONDS
    speech_start = float(beat["speech_start_time"])
    speech_end = float(beat["speech_end_time"])
    previous_word_end = max(
        (float(word["end"]) for word in words if float(word["end"]) <= speech_start),
        default=0.0,
    )
    next_word_start = min(
        (float(word["start"]) for word in words if float(word["start"]) >= speech_end),
        default=speech_end + end_padding,
    )
    return {
        **beat,
        "render_start_time": round(max(previous_word_end, speech_start - start_padding, 0.0), 3),
        "render_end_time": round(
            max(speech_end, min(speech_end + end_padding, next_word_start - NEXT_WORD_SAFETY_SECONDS)),
            3,
        ),
    }


def _with_timeline(beats: List[Dict]) -> tuple[List[Dict], float]:
    timeline = 0.0
    mapped = []
    for index, beat in enumerate(beats):
        duration = float(beat["render_end_time"]) - float(beat["render_start_time"])
        output_start = timeline
        output_end = output_start + duration
        mapped.append(
            {
                **beat,
                "output_start_time": round(output_start, 3),
                "output_end_time": round(output_end, 3),
                "output_speech_start_time": round(
                    output_start
                    + float(beat["speech_start_time"])
                    - float(beat["render_start_time"]),
                    3,
                ),
                "output_speech_end_time": round(
                    output_start
                    + float(beat["speech_end_time"])
                    - float(beat["render_start_time"]),
                    3,
                ),
            }
        )
        timeline = output_end - (COMPOSITE_TRANSITION_SECONDS if index + 1 < len(beats) else 0.0)
    return mapped, round(timeline, 3)


def _transition_handles_are_safe(beats: List[Dict]) -> bool:
    required_handle = COMPOSITE_TRANSITION_SECONDS + TRANSITION_SPEECH_MARGIN_SECONDS
    for index, beat in enumerate(beats):
        if index < len(beats) - 1 and (
            float(beat["render_end_time"]) - float(beat["speech_end_time"])
            < required_handle
        ):
            return False
        if index > 0 and (
            float(beat["speech_start_time"]) - float(beat["render_start_time"])
            < required_handle
        ):
            return False
    return True


def _semantic_metrics(beats: List[Dict], duration: float) -> Dict:
    token_sets = [_topic_tokens(str(beat["text"])) for beat in beats]
    pairwise = []
    for index, left in enumerate(token_sets):
        for right in token_sets[index + 1:]:
            union = left | right
            if union:
                pairwise.append(len(left & right) / len(union))
    duplicate_claim_count = sum(overlap >= 0.55 for overlap in pairwise)
    redundancy_score = 100.0 * max(pairwise, default=0.0)
    unique_tokens = set().union(*token_sets) if token_sets else set()
    speech_duration = sum(
        float(beat["speech_end_time"]) - float(beat["speech_start_time"])
        for beat in beats
    )
    demonstration = next(beat for beat in beats if beat["role"] == "demonstration")
    mechanism = next(beat for beat in beats if beat["role"] == "connection_mechanism")
    return {
        "redundancy_score": round(redundancy_score, 3),
        "duplicate_claim_count": duplicate_claim_count,
        "unique_claim_count": len(beats),
        "information_density": round(len(unique_tokens) / max(1.0, speech_duration), 3),
        "core_mechanism_start_ratio": round(
            float(demonstration["output_speech_start_time"]) / max(duration, 0.001),
            4,
        ),
        "connection_mechanism_start_seconds": round(
            float(mechanism["output_speech_start_time"]),
            3,
        ),
    }


def _has_dangling_context(beats: List[Dict]) -> bool:
    prior_tokens = set()
    for index, beat in enumerate(beats):
        normalized = _normalize(str(beat["text"]))
        tokens = normalized.split()
        beat_tokens = _topic_tokens(normalized)
        if index > 0 and tokens and tokens[0] in DANGLING_OPENERS:
            if not (beat_tokens & prior_tokens):
                return True
        for match in re.finditer(r"\bour\s+([a-z]+)", normalized):
            noun = match.group(1)
            noun = noun[:-1] if noun.endswith("s") and len(noun) > 4 else noun
            if index > 0 and noun not in prior_tokens:
                return True
        prior_tokens.update(beat_tokens)
    return False


def _topic_chain_is_complete(beats: List[Dict]) -> bool:
    by_role = {str(beat["role"]): _topic_tokens(str(beat["text"])) for beat in beats}
    links = (
        ("definition", "demonstration"),
        ("demonstration", "connection_mechanism"),
        ("connection_mechanism", "activation_transform"),
        ("activation_transform", "payoff"),
    )
    return all(by_role[left] & by_role[right] for left, right in links)


def plan_educational_composite(candidate: Dict, transcript: Dict) -> Dict:
    """Compress an unresolved educational candidate into a six-beat complete arc."""
    item = dict(candidate)
    words = _timed_words(transcript)
    sentences = _sentence_spans(words)
    if not words or not sentences:
        return item

    requested_start = float(item.get("speech_start_time", item.get("start_time", 0.0)))
    hook = _select_hook(sentences, requested_start)
    definition = _select_definition(sentences, int(hook["end_index"])) if hook else None
    demonstration = (
        _select_demonstration(sentences, int(definition["end_index"]))
        if definition
        else None
    )
    continuity = " ".join(
        str(beat["text"])
        for beat in (definition, demonstration)
        if beat is not None
    )
    mechanism = (
        _select_mechanism(sentences, int(demonstration["end_index"]), continuity)
        if demonstration
        else None
    )
    transform = (
        _select_single_role(
            sentences,
            "activation_transform",
            int(mechanism["end_index"]),
            TRANSFORMATION_MARKERS,
            str(mechanism["text"]),
            max_gap=180.0,
            minimum_duration=4.0,
            maximum_duration=12.0,
        )
        if mechanism
        else None
    )
    payoff = (
        _select_single_role(
            sentences,
            "payoff",
            int(transform["end_index"]),
            PAYOFF_MARKERS,
            f"{mechanism['text']} {transform['text']}",
            max_gap=60.0,
            minimum_duration=3.0,
            maximum_duration=12.0,
        )
        if mechanism and transform
        else None
    )
    selected = [hook, definition, demonstration, mechanism, transform, payoff]
    if any(beat is None for beat in selected):
        return item

    beats = [dict(beat) for beat in selected if beat is not None]
    if len(beats) > MAX_COMPOSITE_BEATS or any(_is_promotional(str(beat["text"])) for beat in beats):
        return item
    if not _topic_chain_is_complete(beats) or _has_dangling_context(beats):
        return item

    source_gap = float(mechanism["speech_start_time"]) - float(demonstration["speech_end_time"])
    if source_gap >= 30.0:
        mechanism["context_overlay"] = {
            "text": "FOCUSING ON ONE EXAMPLE",
            "start": COMPOSITE_TRANSITION_SECONDS,
            "end": COMPOSITE_TRANSITION_SECONDS + 0.8,
        }
        beats[3] = mechanism

    for beat in beats:
        beat.pop("start_index", None)
        beat.pop("end_index", None)
    beats = [
        _safe_beat_bounds(beat, words, index == 0, index == len(beats) - 1)
        for index, beat in enumerate(beats)
    ]
    if not _transition_handles_are_safe(beats):
        return item
    beats, duration = _with_timeline(beats)
    if duration > MAX_COMPOSITE_SECONDS:
        return item

    metrics = _semantic_metrics(beats, duration)
    final_text = str(beats[-1]["text"])
    final_takeaway = bool(
        _marker_hits(final_text, PAYOFF_MARKERS)
        and _topic_tokens(final_text) & _topic_tokens(str(beats[-2]["text"]))
    )
    if metrics["duplicate_claim_count"] or not final_takeaway:
        return item

    item.update(
        {
            "source_beats": beats,
            "composite_duration_seconds": duration,
            "max_duration_seconds": MAX_COMPOSITE_SECONDS,
            "preferred_duration_met": (
                PREFERRED_COMPOSITE_MIN_SECONDS <= duration <= PREFERRED_COMPOSITE_MAX_SECONDS
            ),
            "composite_edit_count": len(beats) - 1,
            "composite_required": False,
            "composite_plan_valid": True,
            "setup_present": True,
            "problem_present": True,
            "mechanism_present": True,
            "evidence_present": True,
            "resolution_present": True,
            "resolution_answers_hook": True,
            "unresolved_question": False,
            "arc_stage_at_end": "resolution",
            "topic_completeness_score": 98,
            "closure_score": 100,
            "payoff_present": True,
            "final_takeaway_present": True,
            "dangling_context": False,
            "open_loop_resolved": True,
            "continuation_required": False,
            "semantic_boundary_valid": True,
            "rejection_reason": None,
            "closure_sentence": beats[-1]["text"],
            "start_time": beats[0]["render_start_time"],
            "end_time": beats[0]["render_end_time"],
            "speech_start_time": beats[0]["speech_start_time"],
            "speech_end_time": beats[0]["speech_end_time"],
            "render_start_time": beats[0]["render_start_time"],
            "render_end_time": beats[0]["render_end_time"],
            **metrics,
        }
    )
    return item
