"""Deterministic narrative context for standalone gaming shorts."""
import re
from typing import Dict, List, Optional, Tuple


MAX_CONTEXT_EXTENSION_SECONDS = 8.0
MAX_OBJECTIVE_LOOKBACK_SECONDS = 75.0
MAX_PREMISE_LOOKBACK_SECONDS = 120.0
MAX_GAMING_DURATION_SECONDS = 75.0
CONTEXT_OVERLAY_START_SECONDS = 0.12
CONTEXT_OVERLAY_END_SECONDS = 1.25
MIN_USEFUL_CONTEXT_LEAD_SECONDS = 0.30
CONTEXT_TERMS = (
    "contact", "everyone died", "everyone's died", "last man", "level", "mission", "only",
    "pistol", "problem", "round", "survival", "trying", "wave", "wanted",
    "with one eye",
)
REACTION_OPENINGS = (
    "are you serious", "did you see", "no way", "oh god", "oh jesus",
    "oh my god", "uh oh", "what just happened",
)
OBJECTIVE_TERMS = (
    "goal", "have to", "need to", "reach", "survive", "take out", "win",
)
LIMITATION_TERMS = (
    "all i got", "can't use", "cannot use", "level one", "level 1", "only",
    "pistol", "without",
)
MODE_TERMS = ("game mode", "heist", "minigame", "mission", "race", "survival")
CHALLENGE_PREMISE_TERMS = (
    "double money", "double rp", "first time", "low level", "never played",
    "only a", "pistol", "stone hatchet",
)
OUTCOME_TERMS = ("complete", "died", "failed", "survived", "won")
TITLE_SPOILER_RE = re.compile(
    r"\b(?:attempt|clutch|escape|escaped|fail|failed|failure|win|won|victory|death|died)\b",
    re.IGNORECASE,
)


def _number(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalized_words(text: str) -> List[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def _timed_words(transcript: Dict) -> List[Dict]:
    words = []
    for segment in transcript.get("segments", []):
        exact = segment.get("words") if isinstance(segment.get("words"), list) else []
        for word in exact:
            text = str(word.get("word") or word.get("text") or "").strip()
            start = _number(word.get("start"), -1.0)
            end = _number(word.get("end"), -1.0)
            if text and start >= 0.0 and end > start:
                words.append({"text": text, "start": start, "end": end})
    return words


def _find_hook_span(
    hook_sentence: str,
    transcript: Dict,
    search_start: float,
    search_end: float,
) -> Optional[Tuple[float, float]]:
    hook_tokens = _normalized_words(hook_sentence)
    if len(hook_tokens) < 4:
        return None
    words = [
        word
        for word in _timed_words(transcript)
        if word["end"] > search_start and word["start"] < search_end
    ]
    tokens = [_normalized_words(word["text"]) for word in words]
    flat_tokens = [token[0] if token else "" for token in tokens]
    window_size = min(len(hook_tokens), 12)
    target = hook_tokens[:window_size]
    for index in range(0, len(flat_tokens) - window_size + 1):
        if flat_tokens[index:index + window_size] == target:
            return float(words[index]["start"]), float(words[index + window_size - 1]["end"])
    return None


def _text_between(transcript: Dict, start: float, end: float) -> str:
    parts = []
    for segment in transcript.get("segments", []):
        exact_words = segment.get("words") if isinstance(segment.get("words"), list) else []
        selected_words = [
            str(word.get("word") or word.get("text") or "").strip()
            for word in exact_words
            if _number(word.get("end")) > start and _number(word.get("start")) < end
        ]
        selected_words = [word for word in selected_words if word]
        if selected_words:
            parts.extend(selected_words)
        elif (
            not exact_words
            and _number(segment.get("end")) > start
            and _number(segment.get("start")) < end
        ):
            parts.append(str(segment.get("text") or "").strip())
    return " ".join(part for part in parts if part).strip()


def _has_context(text: str) -> bool:
    normalized = re.sub(r"\s+", " ", text.lower())
    return any(term in normalized for term in CONTEXT_TERMS)


def _has_any_term(text: str, terms: Tuple[str, ...]) -> bool:
    normalized = re.sub(r"\s+", " ", text.lower())
    return any(term in normalized for term in terms)


def _objective_setup_segment(transcript: Dict, before: float) -> Optional[Dict]:
    """Return one concise source sentence that states the gameplay objective."""
    candidates = []
    for segment in transcript.get("segments", []):
        start = _number(segment.get("start"), -1.0)
        end = _number(segment.get("end"), -1.0)
        text = str(segment.get("text") or "").strip()
        if (
            start < 0.0
            or end <= start
            or end > before
            or end < before - MAX_OBJECTIVE_LOOKBACK_SECONDS
            or end - start > 5.0
            or not _has_any_term(text, OBJECTIVE_TERMS)
        ):
            continue
        normalized = text.lower()
        score = sum(term in normalized for term in OBJECTIVE_TERMS)
        score += int(bool(re.search(r"\b\d+\b", normalized)))
        score += int(any(noun in normalized for noun in ("mission", "round", "wave")))
        candidates.append((score, end, segment))
    if not candidates:
        return None
    return max(candidates, key=lambda candidate: (candidate[0], candidate[1]))[2]


def _objective_overlay(text: str) -> str:
    normalized = re.sub(
        r"^(?:okay[, ]+)?(?:so )?(?:i )?(?:just )?(?:have|need) to ",
        "",
        text.strip(),
        flags=re.IGNORECASE,
    )
    normalized = re.sub(r"\s+", " ", normalized).strip(" .,!?:;-")
    return f"THE CHALLENGE: {' '.join(normalized.split()[:6]).upper()}"


def _segment_text(segment: Dict) -> str:
    return str(segment.get("text") or "").strip()


def _cluster_forward(segments: List[Dict], index: int, max_duration: float) -> List[Dict]:
    cluster = [segments[index]]
    for segment in segments[index + 1:]:
        if _number(segment.get("start")) - _number(cluster[-1].get("end")) > 0.35:
            break
        if _number(segment.get("end")) - _number(cluster[0].get("start")) > max_duration:
            break
        cluster.append(segment)
    return cluster


def _cluster_backward(segments: List[Dict], index: int, max_duration: float) -> List[Dict]:
    cluster = [segments[index]]
    for segment in reversed(segments[:index]):
        if _number(cluster[0].get("start")) - _number(segment.get("end")) > 0.35:
            break
        if _number(cluster[-1].get("end")) - _number(segment.get("start")) > max_duration:
            break
        cluster.insert(0, segment)
    return cluster


def _premise_setup_beats(transcript: Dict, before: float) -> List[Dict]:
    segments = [
        segment
        for segment in transcript.get("segments", [])
        if _number(segment.get("end")) <= before
        and _number(segment.get("end")) >= before - MAX_PREMISE_LOOKBACK_SECONDS
    ]
    mode_candidates = []
    for index, segment in enumerate(segments):
        text = _segment_text(segment).lower()
        score = 4 * int("game mode" in text)
        score += sum(term in text for term in MODE_TERMS[1:])
        if score:
            mode_candidates.append((score, _number(segment.get("end")), index))
    if not mode_candidates:
        return []

    _, _, mode_index = max(mode_candidates, key=lambda candidate: (candidate[0], candidate[1]))
    mode_cluster = _cluster_forward(segments, mode_index, 9.0)
    mode_end = _number(mode_cluster[-1].get("end"))

    challenge_candidates = []
    for index, segment in enumerate(segments):
        start = _number(segment.get("start"))
        if start < mode_end:
            continue
        text = _segment_text(segment).lower()
        score = sum(term in text for term in CHALLENGE_PREMISE_TERMS)
        if score:
            challenge_candidates.append((score, _number(segment.get("end")), index))

    beats = [
        {
            "role": "premise",
            "speech_start_time": _number(mode_cluster[0].get("start")),
            "speech_end_time": _number(mode_cluster[-1].get("end")),
            "render_start_time": _number(mode_cluster[0].get("start")),
            "render_end_time": _number(mode_cluster[-1].get("end")),
            "layout_hint": "motion",
            "context_overlay": {
                "text": "THE MODE: SURVIVAL",
                "start": CONTEXT_OVERLAY_START_SECONDS,
                "end": CONTEXT_OVERLAY_END_SECONDS,
            },
        }
    ]
    if challenge_candidates:
        _, _, challenge_index = max(
            challenge_candidates,
            key=lambda candidate: (candidate[0], candidate[1]),
        )
        challenge_cluster = _cluster_backward(segments, challenge_index, 10.5)
        beats.append(
            {
                "role": "premise_stakes",
                "transition_style": "cut",
                "speech_start_time": _number(challenge_cluster[0].get("start")),
                "speech_end_time": _number(challenge_cluster[-1].get("end")),
                "render_start_time": _number(challenge_cluster[0].get("start")),
                "render_end_time": _number(challenge_cluster[-1].get("end")),
                "layout_hint": "motion",
                "context_overlay": {
                    "text": "FIRST ATTEMPT - LOW LEVEL",
                    "start": CONTEXT_OVERLAY_START_SECONDS,
                    "end": CONTEXT_OVERLAY_END_SECONDS,
                },
            }
        )
    return beats


def _first_outcome_boundary(
    transcript: Dict,
    start: float,
    end: float,
) -> Optional[Tuple[float, float]]:
    segments = list(transcript.get("segments", []))
    for index, segment in enumerate(segments):
        segment_start = _number(segment.get("start"))
        segment_end = _number(segment.get("end"))
        if segment_start < start + 10.0 or segment_end > end:
            continue
        if not _has_any_term(_segment_text(segment), OUTCOME_TERMS):
            continue
        next_start = (
            _number(segments[index + 1].get("start"), segment_end)
            if index + 1 < len(segments)
            else segment_end
        )
        return segment_end, min(next_start, segment_end + 0.30)
    return None


def _previous_setup_start(
    transcript: Dict,
    current_start: float,
    end: float,
) -> Optional[float]:
    candidates = [
        segment
        for segment in transcript.get("segments", [])
        if _number(segment.get("end")) <= current_start + 0.05
        and _number(segment.get("end")) >= current_start - MAX_CONTEXT_EXTENSION_SECONDS
    ]
    for segment in reversed(candidates):
        start = _number(segment.get("start"))
        if end - start > MAX_GAMING_DURATION_SECONDS:
            continue
        text = _text_between(transcript, start, current_start)
        if _has_context(text):
            return start
    return None


def gaming_context_label(highlight: Dict) -> str:
    model_summary = str(highlight.get("context_summary") or "").strip()
    source = model_summary or str(highlight.get("title") or "GAMEPLAY CHALLENGE")
    source = TITLE_SPOILER_RE.sub("", source)
    source = re.sub(r"\s+", " ", source).strip(" -:,.!")
    words = source.split()[:6]
    return " ".join(words).upper() or "GAMEPLAY CHALLENGE"


def enrich_gaming_context(highlights: List[Dict], transcript: Dict) -> List[Dict]:
    """Align openings to setup/hook and add a concise non-spoiler context label."""
    enriched = []
    for highlight in highlights:
        item = dict(highlight)
        speech_start = _number(item.get("speech_start_time"), _number(item.get("start_time")))
        speech_end = _number(item.get("speech_end_time"), _number(item.get("end_time")))
        hook = _find_hook_span(
            str(item.get("hook_sentence") or ""),
            transcript,
            speech_start - 2.0,
            min(speech_end, speech_start + 12.0),
        )
        if hook and hook[0] > speech_start:
            leading_text = _text_between(transcript, speech_start, hook[0])
            if not _has_context(leading_text):
                speech_start = hook[0]

        opening_end = min(speech_end, speech_start + 6.0)
        opening_text = _text_between(transcript, speech_start, opening_end)
        normalized_opening = re.sub(r"\s+", " ", opening_text.lower()).strip()
        opening_is_reaction = any(normalized_opening.startswith(term) for term in REACTION_OPENINGS)
        if not _has_context(opening_text) and opening_is_reaction:
            setup_start = _previous_setup_start(transcript, speech_start, speech_end)
            if setup_start is not None:
                speech_start = setup_start
                opening_text = _text_between(transcript, speech_start, min(speech_end, speech_start + 8.0))

        previous_render_start = _number(item.get("start_time"), speech_start)
        available_lead = max(0.0, _number(item.get("speech_start_time"), speech_start) - previous_render_start)
        context_lead = min(0.55, available_lead)
        if context_lead < MIN_USEFUL_CONTEXT_LEAD_SECONDS:
            context_lead = 0.0
        render_start = max(0.0, speech_start - context_lead)
        if speech_end - render_start <= MAX_GAMING_DURATION_SECONDS:
            item["speech_start_time"] = speech_start
            item["start_time"] = render_start

        context_clear = _has_context(opening_text) or bool(item.get("context_summary"))
        if (
            _has_any_term(opening_text, LIMITATION_TERMS)
            and not _has_any_term(opening_text, OBJECTIVE_TERMS)
            and not item.get("source_beats")
        ):
            objective = _objective_setup_segment(transcript, speech_start)
            if objective is not None:
                objective_start = _number(objective.get("start"))
                objective_end = _number(objective.get("end"))
                action_end = _number(item.get("end_time"), speech_end)
                setup_beats = _premise_setup_beats(transcript, objective_start)
                objective_beat = {
                    "role": "objective",
                    "transition_style": "cut" if setup_beats else None,
                    "speech_start_time": objective_start,
                    "speech_end_time": objective_end,
                    "render_start_time": objective_start,
                    "render_end_time": objective_end,
                    "layout_hint": "motion",
                    "context_overlay": {
                        "text": _objective_overlay(str(objective.get("text") or "")),
                        "start": CONTEXT_OVERLAY_START_SECONDS,
                        "end": min(CONTEXT_OVERLAY_END_SECONDS, objective_end - objective_start),
                    },
                }
                if objective_beat["transition_style"] is None:
                    objective_beat.pop("transition_style")
                composite_duration = sum(
                    _number(beat.get("render_end_time"))
                    - _number(beat.get("render_start_time"))
                    for beat in [*setup_beats, objective_beat]
                ) + action_end - speech_start
                action_speech_end = speech_end
                if composite_duration > MAX_GAMING_DURATION_SECONDS:
                    outcome = _first_outcome_boundary(
                        transcript,
                        speech_start,
                        min(speech_end, action_end),
                    )
                    if outcome is not None:
                        action_speech_end, action_end = outcome
                        composite_duration = sum(
                            _number(beat.get("render_end_time"))
                            - _number(beat.get("render_start_time"))
                            for beat in [*setup_beats, objective_beat]
                        ) + action_end - speech_start
                if composite_duration <= MAX_GAMING_DURATION_SECONDS:
                    item["source_beats"] = [
                        *setup_beats,
                        objective_beat,
                        {
                            "role": "action",
                            "transition_style": "cut",
                            "speech_start_time": speech_start,
                            "speech_end_time": action_speech_end,
                            "render_start_time": speech_start,
                            "render_end_time": action_end,
                            "layout_hint": "motion",
                        },
                    ]
                    item["duration_seconds"] = round(composite_duration, 3)
                    context_clear = True
        item["gaming_context_clear"] = context_clear
        item["gaming_opening_text"] = opening_text
        item["context_overlay"] = {
            "text": gaming_context_label(item),
            "start": CONTEXT_OVERLAY_START_SECONDS,
            "end": CONTEXT_OVERLAY_END_SECONDS,
        }
        enriched.append(item)
    return enriched
