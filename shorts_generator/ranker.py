"""Deterministic highlight ranking and hard quality guardrails."""
import re
from typing import Dict, List, Optional, Set

from . import profiles as _profiles
from .profiles import CONTENT_PROFILES, MOTIVATIONAL_PODCAST, is_motivational_profile


MOTIVATIONAL_TENSION_MICRO_V1 = getattr(
    _profiles,
    "MOTIVATIONAL_TENSION_MICRO_V1",
    "motivational_tension_micro_v1",
)
MOTIVATIONAL_TENSION_MICRO_V2 = getattr(
    _profiles,
    "MOTIVATIONAL_TENSION_MICRO_V2",
    "motivational_tension_micro_v2",
)
MICRO_SELECTION_PROFILES = frozenset(
    {MOTIVATIONAL_TENSION_MICRO_V1, MOTIVATIONAL_TENSION_MICRO_V2}
)


CTA_PHRASES = (
    "subscribe",
    "stay notified",
    "notifications",
    "support the channel",
    "this channel",
    "patreon",
    "link in the description",
    "hit the bell",
    "like and subscribe",
    "recommended to you",
)

OUTRO_PHRASES = (
    "thanks for watching",
    "thank you for watching",
    "see you next time",
    "stay posted for more",
    "next video",
    "before you go",
)

DEFAULT_WEIGHTS = {
    "hook_score": 0.25,
    "standalone_score": 0.20,
    "payoff_score": 0.20,
    "educational_value_score": 0.15,
    "visual_action_score": 0.10,
    "boundary_quality_score": 0.10,
}

EMOTIONAL_TENSION_TERMS = {
    "horrifying": 4.0,
    "terrifying": 4.0,
    "shocking": 4.0,
    "one exit left": 3.0,
    "the truth was": 3.0,
    "completely wrong": 3.0,
    "impossible": 2.0,
}

GAMING_MENU_TERMS = (
    "garage", "inventory", "loadout", "loading screen", "lobby", "map screen",
    "menu", "pause screen", "settings", "upgrade screen", "character selection",
)
GAMING_ACTION_TERMS = (
    "attack", "boss", "chase", "crash", "enemy", "escape", "explosion", "fight",
    "helicopter", "jump", "low health", "mission", "police", "shortcut", "shoot",
    "stunt", "wanted level",
)
GAMING_OUTCOME_TERMS = (
    "back in first", "clutch", "escaped", "failed", "finished", "first place", "get away",
    "got away", "in our favor", "land on", "landed", "lost", "made it", "mission passed",
    "saved", "turned it around", "won",
)
GAMING_REACTION_TERMS = (
    "are you serious", "did you see that", "no way", "oh my god", "that was insane",
    "what just happened",
)
GAMING_MAX_DURATION_SECONDS = 75.0
GAMING_PREFERRED_MIN_SECONDS = 25.0
GAMING_PREFERRED_MAX_SECONDS = 60.0

EDUCATIONAL_MAX_DURATION_SECONDS = 90.0
EDUCATIONAL_PREFERRED_MIN_SECONDS = 72.0
EDUCATIONAL_PREFERRED_MAX_SECONDS = 82.0
EDUCATIONAL_MAX_COMPOSITE_BEATS = 6

BATCH_MAX_TEMPORAL_OVERLAP_RATIO = 0.15
BATCH_MAX_TOKEN_OVERLAP_RATIO = 0.72
BATCH_TOKEN_STOPWORDS = {
    "a", "about", "after", "again", "all", "an", "and", "are", "as", "at",
    "be", "because", "but", "by", "can", "do", "for", "from", "get", "go",
    "got", "had", "has", "have", "he", "here", "how", "i", "if", "in", "is",
    "it", "just", "like", "me", "my", "now", "of", "on", "or", "our", "so",
    "that", "the", "then", "there", "they", "this", "to", "up", "was", "we",
    "were", "what", "when", "with", "you", "your",
}

MOTIVATIONAL_WEIGHTS = {
    "hook_score": 0.24,
    "standalone_score": 0.20,
    "takeaway_score": 0.18,
    "development_score": 0.12,
    "emotional_conviction_score": 0.10,
    "quotability_score": 0.08,
    "closure_score": 0.08,
}
MOTIVATIONAL_FILLER_RE = re.compile(
    r"^(?:yeah|yes|right|exactly|you know|i mean|like|as i said)\b[,. ]*",
    re.IGNORECASE,
)
MOTIVATIONAL_CONNECTOR_RE = re.compile(r"^(?:and|but|so)\b[,. ]*", re.IGNORECASE)
MOTIVATIONAL_ATTRIBUTION_RE = re.compile(
    r"\b(?:according to|paraphrasing|once said|writes? that|the author of)\b",
    re.IGNORECASE,
)
MOTIVATIONAL_CONTEXT_CALLBACK_RE = re.compile(
    r"\b(?:as i said|as we said|coming back to|back to the|the [a-z']+ thing)\b",
    re.IGNORECASE,
)
MOTIVATIONAL_FILLER_PATTERNS = (
    re.compile(r"\b(?:yeah|right|exactly)\b", re.IGNORECASE),
    re.compile(r"\bi['’]?m like\b", re.IGNORECASE),
    re.compile(r"\byou know\b", re.IGNORECASE),
    re.compile(r"\bi mean\b", re.IGNORECASE),
    re.compile(r"\bso coming back\b", re.IGNORECASE),
    re.compile(r"\bcoming back to\b", re.IGNORECASE),
)
INCOMPLETE_END_WORDS = {
    "and", "because", "but", "first", "if", "or", "so", "then", "to", "when", "which",
}

MICRO_HARD_MIN_SECONDS = 8.0
MICRO_IDEAL_MIN_SECONDS = 9.0
MICRO_IDEAL_MAX_SECONDS = 13.0
MICRO_PREFERRED_MAX_SECONDS = 18.0
MICRO_HARD_MAX_SECONDS = 22.0
MICRO_SEMANTIC_WEIGHTS = {
    "semantic_tension_score": 0.18,
    "contrast_score": 0.14,
    "conflict_score": 0.14,
    "reversal_score": 0.12,
    "listener_payoff_score": 0.18,
    "self_contained_micro_arc_score": 0.17,
    "reaction_tail_compatibility_score": 0.07,
}
MICRO_TENSION_TERMS = (
    "afraid", "approval", "boundary", "conflict", "fear", "hate", "lie",
    "mistake", "pressure", "problem", "rejection", "risk", "struggle",
    "uncomfortable", "wrong",
)
MICRO_CONTRAST_TERMS = (
    " but ", " instead ", " rather than ", " versus ", " vs ", " while ",
    " yet ", "the difference", "not the same", "not about", "isn't about",
)
MICRO_REVERSAL_TERMS = (
    "actually", "instead", "opposite", "the truth is", "turns out",
    "what looks like", "what seems like", "not because", "isn't",
)
MICRO_PAYOFF_TERMS = (
    "because", "means", "so that", "that's why", "the difference is",
    "what matters", "what you need", "which means", "you have to",
)
MICRO_GENERIC_MOTIVATION_TERMS = (
    "believe in yourself", "dream big", "keep going", "never give up",
    "stay positive", "success will come", "trust the process", "work hard",
    "you can do anything", "you got this",
)
MICRO_CONTEXT_OPENING_RE = re.compile(
    r"^(?:and|but|so|this|that|these|those|they|he|she|it)\b",
    re.IGNORECASE,
)


def _number(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def candidate_text(highlight: Dict, transcript: Dict) -> str:
    def text_for_interval(start: float, end: float) -> str:
        parts = []
        for segment in transcript.get("segments", []):
            words = segment.get("words") if isinstance(segment.get("words"), list) else []
            timed_words = [
                str(word.get("word") or word.get("text") or "").strip()
                for word in words
                if _number(word.get("end")) > start and _number(word.get("start")) < end
            ]
            timed_words = [word for word in timed_words if word]
            if timed_words:
                parts.extend(timed_words)
            elif (
                not words
                and _number(segment.get("end")) > start
                and _number(segment.get("start")) < end
            ):
                parts.append(str(segment.get("text") or "").strip())
        return " ".join(part for part in parts if part).strip()

    beats = highlight.get("source_beats")
    if isinstance(beats, list) and beats:
        return " ".join(
            text_for_interval(
                _number(beat.get("speech_start_time")),
                _number(beat.get("speech_end_time")),
            )
            for beat in beats
        ).strip()
    start = _number(highlight.get("speech_start_time"), _number(highlight.get("start_time")))
    end = _number(highlight.get("speech_end_time"), _number(highlight.get("end_time")))
    return text_for_interval(start, end)


def promotional_language(text: str) -> Dict:
    normalized = re.sub(r"\s+", " ", text.lower()).strip()
    hits = [phrase for phrase in CTA_PHRASES if phrase in normalized]
    outro_hits = [phrase for phrase in OUTRO_PHRASES if phrase in normalized]
    word_count = max(1, len(re.findall(r"\b\w+\b", normalized)))
    matched_words = sum(len(phrase.split()) for phrase in hits + outro_hits)
    ratio = matched_words / word_count
    has_direct_subscribe = "subscribe" in normalized
    mostly_cta = (
        ratio >= 0.15
        or (has_direct_subscribe and len(hits) >= 2)
        or (len(hits) >= 3 and ratio >= 0.06)
        or (bool(outro_hits) and ratio >= 0.15)
    )
    return {
        "cta_hits": hits,
        "outro_hits": outro_hits,
        "cta_word_ratio": round(ratio, 4),
        "mostly_cta": mostly_cta,
    }


def emotional_tension_bonus(text: str) -> float:
    normalized = re.sub(r"\s+", " ", text.lower()).strip()
    return min(
        4.0,
        sum(weight for phrase, weight in EMOTIONAL_TENSION_TERMS.items() if phrase in normalized),
    )


def gaming_language_signals(text: str) -> Dict:
    normalized = re.sub(r"\s+", " ", text.lower()).strip()
    menu_hits = [term for term in GAMING_MENU_TERMS if term in normalized]
    action_hits = [term for term in GAMING_ACTION_TERMS if term in normalized]
    outcome_hits = [term for term in GAMING_OUTCOME_TERMS if term in normalized]
    reaction_hits = [term for term in GAMING_REACTION_TERMS if term in normalized]
    return {
        "gaming_menu_hits": menu_hits,
        "gaming_action_hits": action_hits,
        "gaming_outcome_hits": outcome_hits,
        "gaming_reaction_hits": reaction_hits,
        "reaction_without_cause": bool(reaction_hits and not action_hits and not outcome_hits),
    }


def _phrase_match_word_ratio(text: str, patterns) -> float:
    spans = []
    for pattern in patterns:
        spans.extend(match.span() for match in pattern.finditer(text))
    spans.sort()
    merged = []
    for start, end in spans:
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    filler_words = sum(
        len(re.findall(r"[a-z']+", text[start:end].lower()))
        for start, end in merged
    )
    total_words = max(1, len(re.findall(r"[a-z']+", text.lower())))
    return filler_words / total_words


def _information_density_score(text: str) -> float:
    words = re.findall(r"[a-z']+", text.lower())
    if not words:
        return 0.0
    content = [
        word for word in words
        if len(word) > 2 and word not in BATCH_TOKEN_STOPWORDS
    ]
    bigrams = list(zip(content, content[1:]))
    duplicate_bigrams = max(0, len(bigrams) - len(set(bigrams)))
    return max(
        0.0,
        min(100.0, len(content) / len(words) * 170.0 - duplicate_bigrams * 4.0),
    )


def _hook_timing_score(latency: object) -> float:
    if latency is None:
        return 80.0
    value = _number(latency, 99.0)
    if value <= 2.5:
        return 100.0
    if value <= 3.5:
        return 100.0 - (value - 2.5) * 20.0
    if value <= 5.0:
        return 80.0 - (value - 3.5) * (40.0 / 1.5)
    return 0.0


def _closure_alignment_score(item: Dict) -> float:
    observed = [
        item.get(key)
        for key in ("hook_payoff_aligned", "takeaway_boundary_aligned")
        if key in item
    ]
    if not observed:
        return 80.0
    return 100.0 if all(value is True for value in observed) else 0.0


def _duration_fit_score(duration: float) -> float:
    if 18.0 <= duration <= 35.0:
        return 100.0
    if 14.0 <= duration < 18.0:
        return 70.0 + (duration - 14.0) * 7.5
    if 35.0 < duration <= 45.0:
        return 100.0 - (duration - 35.0) * 4.0
    return 40.0


def _shot_stability_score(source_cut_count: object) -> float:
    if source_cut_count is None:
        return 80.0
    cuts = max(0, int(_number(source_cut_count)))
    if cuts <= 2:
        return 100.0 - cuts * 8.0
    if cuts == 3:
        return 70.0
    return max(0.0, 70.0 - (cuts - 3) * 18.0)


def motivational_language_signals(text: str) -> Dict:
    normalized = re.sub(r"\s+", " ", text).strip()
    words = re.findall(r"[a-z']+", normalized.lower())
    opening = " ".join(words[:14])
    connector_opening = bool(MOTIVATIONAL_CONNECTOR_RE.match(normalized))
    attribution_opening = bool(MOTIVATIONAL_ATTRIBUTION_RE.search(opening))
    context_callback = bool(MOTIVATIONAL_CONTEXT_CALLBACK_RE.search(normalized))
    filler_ratio = _phrase_match_word_ratio(normalized, MOTIVATIONAL_FILLER_PATTERNS)
    return {
        "starts_with_filler": bool(MOTIVATIONAL_FILLER_RE.match(normalized)),
        "connector_opening": connector_opening,
        "attribution_opening": attribution_opening,
        "connector_or_attribution_opening": connector_opening or attribution_opening,
        "context_callback": context_callback,
        "filler_ratio": round(filler_ratio, 4),
        "information_density_score": round(_information_density_score(normalized), 3),
        "opening_directness_score": (
            0.0
            if connector_opening or attribution_opening or context_callback
            else 55.0 if MOTIVATIONAL_FILLER_RE.match(normalized) else 100.0
        ),
        "ends_with_connector": bool(words and words[-1] in INCOMPLETE_END_WORDS),
    }


def _term_hits(normalized_text: str, terms) -> List[str]:
    return [term.strip() for term in terms if term in normalized_text]


def motivational_tension_micro_signals(text: str) -> Dict:
    """Return deterministic lexical fallbacks for the LLM's semantic scores.

    The model-provided scores remain authoritative when present. These signals
    make the policy deterministic for imported/manual candidates and expose why
    a candidate received a fallback score.
    """
    compact = re.sub(r"\s+", " ", text.lower()).strip()
    normalized = f" {compact} "
    tension_hits = _term_hits(normalized, MICRO_TENSION_TERMS)
    contrast_hits = _term_hits(normalized, MICRO_CONTRAST_TERMS)
    reversal_hits = _term_hits(normalized, MICRO_REVERSAL_TERMS)
    payoff_hits = _term_hits(normalized, MICRO_PAYOFF_TERMS)
    generic_hits = _term_hits(normalized, MICRO_GENERIC_MOTIVATION_TERMS)
    stripped = normalized.strip()
    context_opening = bool(MICRO_CONTEXT_OPENING_RE.match(stripped))

    tension_score = min(100.0, len(tension_hits) * 32.0)
    contrast_score = min(100.0, len(contrast_hits) * 45.0)
    reversal_score = min(100.0, len(reversal_hits) * 42.0)
    payoff_score = min(100.0, len(payoff_hits) * 36.0)
    conflict_score = min(
        100.0,
        tension_score * 0.65 + contrast_score * 0.35,
    )
    generic_score = min(100.0, len(generic_hits) * 38.0)
    context_score = 35.0 if context_opening else 0.0
    if re.search(r"\b(?:as (?:i|we) said|like (?:i|we) said|back to that)\b", stripped):
        context_score = max(context_score, 80.0)

    return {
        "micro_tension_term_hits": tension_hits,
        "micro_contrast_term_hits": contrast_hits,
        "micro_reversal_term_hits": reversal_hits,
        "micro_payoff_term_hits": payoff_hits,
        "micro_generic_motivation_hits": generic_hits,
        "micro_context_dependent_opening": context_opening,
        "fallback_semantic_tension_score": round(tension_score, 3),
        "fallback_contrast_score": round(contrast_score, 3),
        "fallback_conflict_score": round(conflict_score, 3),
        "fallback_reversal_score": round(reversal_score, 3),
        "fallback_listener_payoff_score": round(payoff_score, 3),
        "fallback_generic_motivation_score": round(generic_score, 3),
        "fallback_context_dependence_score": round(context_score, 3),
    }


def _micro_duration_fit_score(duration: float) -> float:
    if MICRO_IDEAL_MIN_SECONDS <= duration <= MICRO_IDEAL_MAX_SECONDS:
        return 100.0
    if MICRO_HARD_MIN_SECONDS <= duration < MICRO_IDEAL_MIN_SECONDS:
        return 70.0 + (duration - MICRO_HARD_MIN_SECONDS) * 30.0
    if MICRO_IDEAL_MAX_SECONDS < duration <= MICRO_PREFERRED_MAX_SECONDS:
        return 100.0 - (
            (duration - MICRO_IDEAL_MAX_SECONDS)
            / (MICRO_PREFERRED_MAX_SECONDS - MICRO_IDEAL_MAX_SECONDS)
            * 10.0
        )
    if MICRO_PREFERRED_MAX_SECONDS < duration <= MICRO_HARD_MAX_SECONDS:
        return 90.0 - (
            (duration - MICRO_PREFERRED_MAX_SECONDS)
            / (MICRO_HARD_MAX_SECONDS - MICRO_PREFERRED_MAX_SECONDS)
            * 25.0
        )
    return 0.0


def _micro_score(item: Dict, key: str, fallback: float) -> float:
    value = item.get(key)
    if value is None:
        value = fallback
    return max(0.0, min(100.0, _number(value, fallback)))


def _micro_selection_components(
    item: Dict,
    language: Dict,
    duration: float,
) -> Dict[str, float]:
    arc_fallback = min(
        _number(item.get("hook_score"), _number(item.get("score"))),
        _number(item.get("standalone_score"), _number(item.get("score"))),
        _number(
            item.get("takeaway_score"),
            _number(item.get("payoff_score"), _number(item.get("score"))),
        ),
        _number(item.get("closure_score"), _number(item.get("score"))),
    )
    visual_metrics = (
        item.get("visual_metrics")
        if isinstance(item.get("visual_metrics"), dict)
        else {}
    )
    reaction_fallback = max(
        100.0 if item.get("reaction_tail_compatible") is True else 0.0,
        100.0 if item.get("has_authentic_reaction_tail") is True else 0.0,
        _number(visual_metrics.get("reaction_tail_compatibility_score")),
    )
    components = {
        "semantic_tension_score": _micro_score(
            item,
            "semantic_tension_score",
            _number(language.get("fallback_semantic_tension_score")),
        ),
        "contrast_score": _micro_score(
            item,
            "contrast_score",
            _number(language.get("fallback_contrast_score")),
        ),
        "conflict_score": _micro_score(
            item,
            "conflict_score",
            _number(language.get("fallback_conflict_score")),
        ),
        "reversal_score": _micro_score(
            item,
            "reversal_score",
            _number(language.get("fallback_reversal_score")),
        ),
        "listener_payoff_score": _micro_score(
            item,
            "listener_payoff_score",
            _number(language.get("fallback_listener_payoff_score")),
        ),
        "self_contained_micro_arc_score": _micro_score(
            item,
            "self_contained_micro_arc_score",
            arc_fallback,
        ),
        "reaction_tail_compatibility_score": _micro_score(
            item,
            "reaction_tail_compatibility_score",
            reaction_fallback,
        ),
        "generic_motivation_score": _micro_score(
            item,
            "generic_motivation_score",
            _number(language.get("fallback_generic_motivation_score")),
        ),
        "context_dependence_score": _micro_score(
            item,
            "context_dependence_score",
            _number(language.get("fallback_context_dependence_score")),
        ),
        "duration_fit_score": _micro_duration_fit_score(duration),
    }
    semantic_score = sum(
        weight * components[name]
        for name, weight in MICRO_SEMANTIC_WEIGHTS.items()
    )
    components["semantic_score"] = semantic_score
    components["quality_score"] = (
        0.82 * semantic_score + 0.18 * components["duration_fit_score"]
    )
    components["generic_motivation_penalty"] = (
        0.22 * components["generic_motivation_score"]
    )
    components["context_dependence_penalty"] = (
        0.32 * components["context_dependence_score"]
    )
    return components


def _weights_for_content(content_type: str) -> Dict[str, float]:
    content_type = (content_type or "other").lower()
    weights = dict(DEFAULT_WEIGHTS)
    if content_type == "gaming":
        return {
            "hook_score": 0.20,
            "standalone_score": 0.15,
            "payoff_score": 0.25,
            "educational_value_score": 0.05,
            "visual_action_score": 0.25,
            "boundary_quality_score": 0.10,
        }
    if content_type == "sports":
        weights["visual_action_score"] = 0.20
        weights["educational_value_score"] = 0.05
    elif content_type in {"tutorial", "lecture", "podcast", "interview"}:
        weights["visual_action_score"] = 0.05
        weights["educational_value_score"] = 0.20
    return weights


def _quality_score(item: Dict, content_type: str) -> float:
    legacy_score = _number(item.get("score"), 0.0)
    if is_motivational_profile(content_type):
        motivational_values = {
            "hook_score": _number(item.get("hook_score"), legacy_score),
            "standalone_score": _number(item.get("standalone_score"), legacy_score),
            "takeaway_score": _number(
                item.get("takeaway_score"),
                _number(item.get("payoff_score"), legacy_score),
            ),
            "emotional_conviction_score": _number(
                item.get("emotional_conviction_score"), legacy_score
            ),
            "development_score": _number(
                item.get("development_score"),
                _number(item.get("educational_value_score"), legacy_score),
            ),
            "quotability_score": _number(item.get("quotability_score"), legacy_score),
            "closure_score": _number(
                item.get("closure_score"),
                _number(item.get("boundary_quality_score"), legacy_score),
            ),
        }
        return sum(
            MOTIVATIONAL_WEIGHTS[name] * value
            for name, value in motivational_values.items()
        )
    measured_visual = item.get("measured_visual_action_score")
    visual_score = (
        0.75 * _number(measured_visual) + 0.25 * _number(item.get("visual_action_score"))
        if measured_visual is not None
        else _number(item.get("visual_action_score"), legacy_score)
    )
    values = {
        "hook_score": _number(item.get("hook_score"), legacy_score),
        "standalone_score": _number(item.get("standalone_score"), legacy_score),
        "payoff_score": _number(item.get("payoff_score"), legacy_score),
        "educational_value_score": _number(item.get("educational_value_score"), legacy_score),
        "visual_action_score": visual_score,
        "boundary_quality_score": _number(item.get("boundary_quality_score"), 80.0),
    }
    return sum(_weights_for_content(content_type)[name] * value for name, value in values.items())


def rank_highlights(
    highlights: List[Dict],
    transcript: Dict,
    content_type: str = "other",
    selection_profile: Optional[str] = None,
) -> List[Dict]:
    """Score candidates deterministically and place hard rejects last."""
    duration_total = _number(transcript.get("duration"), 0.0)
    normalized_content_type = (content_type or "other").lower()
    normalized_selection_profile = str(
        selection_profile
        or (highlights[0].get("selection_profile") if highlights else "")
        or ""
    ).strip().lower()
    micro_selection = normalized_selection_profile in MICRO_SELECTION_PROFILES
    hook_gate_v2 = (
        normalized_selection_profile == MOTIVATIONAL_TENSION_MICRO_V2
    )
    educational_semantics = normalized_content_type in {"tutorial", "lecture"}
    gaming_content = normalized_content_type == "gaming"
    motivational_content = (
        is_motivational_profile(normalized_content_type) or micro_selection
    )
    motivational_policy = CONTENT_PROFILES[MOTIVATIONAL_PODCAST]
    ranked = []
    for highlight in highlights:
        item = dict(highlight)
        text = candidate_text(item, transcript)
        promotion = promotional_language(text)
        gaming = gaming_language_signals(text) if gaming_content else {}
        motivational = motivational_language_signals(text) if motivational_content else {}
        micro_language = (
            motivational_tension_micro_signals(text) if micro_selection else {}
        )
        visual_metrics = item.get("visual_metrics") if isinstance(item.get("visual_metrics"), dict) else {}
        measured_visual = item.get("measured_visual_action_score")
        measured_visual_score = (
            _number(measured_visual)
            if measured_visual is not None
            else _number(item.get("visual_action_score"))
        )
        static_frame_ratio = _number(visual_metrics.get("static_frame_ratio"), 0.0)
        edit_duration = _number(
            item.get("composite_duration_seconds"),
            _number(item.get("end_time")) - _number(item.get("start_time")),
        )
        speech_duration = (
            _number(item.get("speech_end_time"))
            - _number(item.get("speech_start_time"))
        )
        duration = (
            speech_duration
            if micro_selection and speech_duration > 0.0
            else edit_duration
        )
        micro_components = (
            _micro_selection_components(item, micro_language, duration)
            if micro_selection
            else {}
        )
        if hook_gate_v2 and micro_components:
            v2_duration_fit = _number(
                item.get("semantic_closure_duration_fit_score"),
                0.0,
            )
            micro_components["duration_fit_score"] = v2_duration_fit
            micro_components["quality_score"] = (
                0.82 * micro_components["semantic_score"]
                + 0.18 * v2_duration_fit
            )
        rejection_reasons = []
        if hook_gate_v2:
            gate_status = str(item.get("hook_gate_status") or "").strip().lower()
            expected_decision_version = str(
                _profiles.SELECTION_PROFILES[
                    MOTIVATIONAL_TENSION_MICRO_V2
                ].get("hook_gate_decision_version")
                or ""
            )
            observed_decision_version = str(
                item.get("hook_gate_decision_version") or ""
            )
            if not gate_status:
                rejection_reasons.append("hook_gate_decision_missing")
            elif gate_status != "pass" or item.get("hook_gate_eligible") is not True:
                gate_reasons = item.get("hook_gate_deterministic_reasons")
                if isinstance(gate_reasons, list):
                    for reason in gate_reasons:
                        normalized_reason = str(reason or "").strip()
                        if (
                            normalized_reason
                            and normalized_reason not in rejection_reasons
                        ):
                            rejection_reasons.append(normalized_reason)
                if not rejection_reasons:
                    rejection_reasons.append(
                        f"hook_gate_{gate_status}"
                        if gate_status != "pass"
                        else "hook_gate_not_eligible"
                    )
            if (
                expected_decision_version
                and observed_decision_version != expected_decision_version
            ):
                rejection_reasons.append("hook_gate_decision_version_mismatch")
            closure_status = str(
                item.get("semantic_closure_status") or ""
            ).strip().lower()
            expected_closure_version = str(
                _profiles.SELECTION_PROFILES[
                    MOTIVATIONAL_TENSION_MICRO_V2
                ].get("semantic_closure_decision_version")
                or ""
            )
            observed_closure_version = str(
                item.get("semantic_closure_decision_version") or ""
            )
            if not closure_status:
                rejection_reasons.append(
                    "semantic_closure_decision_missing"
                )
            elif (
                closure_status != "pass"
                or item.get("semantic_closure_eligible") is not True
            ):
                closure_reasons = item.get(
                    "semantic_closure_deterministic_reasons"
                )
                if isinstance(closure_reasons, list):
                    for reason in closure_reasons:
                        normalized_reason = str(reason or "").strip()
                        if (
                            normalized_reason
                            and normalized_reason not in rejection_reasons
                        ):
                            rejection_reasons.append(normalized_reason)
                if not closure_reasons:
                    rejection_reasons.append(
                        f"semantic_closure_{closure_status}"
                        if closure_status != "pass"
                        else "semantic_closure_not_eligible"
                    )
            if (
                expected_closure_version
                and observed_closure_version != expected_closure_version
            ):
                rejection_reasons.append(
                    "semantic_closure_decision_version_mismatch"
                )
        if bool(item.get("is_promotional")):
            rejection_reasons.append("model_promotional")
        if bool(item.get("is_outro")):
            rejection_reasons.append("model_outro")
        if bool(item.get("requires_previous_context")):
            rejection_reasons.append("requires_previous_context")
        if item.get("semantic_boundary_valid") is False:
            rejection_reasons.append("endpoint_cuts_word")
        if educational_semantics and item.get("continuation_required") is True:
            rejection_reasons.append("semantic_continuation_required")
        if educational_semantics and "open_loop_resolved" in item and item.get("open_loop_resolved") is False:
            rejection_reasons.append("open_loop_unresolved")
        if educational_semantics and item.get("composite_required") is True:
            rejection_reasons.append("composite_required")
        if educational_semantics and item.get("unresolved_question") is True:
            rejection_reasons.append("unresolved_question")
        if educational_semantics and item.get("arc_stage_at_end") == "problem_escalation":
            rejection_reasons.append("ends_at_problem_escalation")
        if (
            educational_semantics
            and isinstance(item.get("source_beats"), list)
            and len(item["source_beats"]) > EDUCATIONAL_MAX_COMPOSITE_BEATS
        ):
            rejection_reasons.append("too_many_composite_beats")
        if educational_semantics and _number(item.get("duplicate_claim_count")) > 0:
            rejection_reasons.append("duplicate_claims")
        if educational_semantics and item.get("dangling_context") is True:
            rejection_reasons.append("dangling_context")
        if educational_semantics and item.get("final_takeaway_present") is False:
            rejection_reasons.append("missing_final_takeaway")
        if (
            educational_semantics
            and
            "resolution_answers_hook" in item
            and item.get("resolution_answers_hook") is False
        ):
            rejection_reasons.append("resolution_does_not_answer_hook")
        if (
            educational_semantics
            and
            "topic_completeness_score" in item
            and _number(item.get("topic_completeness_score")) < 70.0
        ):
            rejection_reasons.append("topic_incomplete")
        if promotion["mostly_cta"]:
            rejection_reasons.append("promotional_language")
        if motivational_content:
            if item.get("semantic_continuation_required") is True:
                rejection_reasons.append("semantic_continuation_required")
            if item.get("has_hook") is False:
                rejection_reasons.append("missing_hook")
            if item.get("has_development") is False:
                rejection_reasons.append("missing_development")
            if item.get("has_takeaway") is False:
                rejection_reasons.append("missing_takeaway")
            if item.get("has_complete_ending") is False:
                rejection_reasons.append("incomplete_ending")
            if motivational.get("starts_with_filler"):
                rejection_reasons.append("opening_filler")
            if (
                motivational.get("connector_or_attribution_opening")
                or bool(item.get("contains_attribution_lead_in"))
            ):
                rejection_reasons.append("connector_or_attribution_opening")
            if motivational.get("context_callback") or bool(item.get("contains_context_callback")):
                rejection_reasons.append("context_callback")
            if bool(item.get("second_topic_begins_after_takeaway")):
                rejection_reasons.append("second_topic_after_takeaway")
            if item.get("hook_payoff_aligned") is False:
                rejection_reasons.append("unaligned_hook_payoff")
            if item.get("takeaway_boundary_aligned") is False:
                rejection_reasons.append("unaligned_takeaway")
            if (
                item.get("hook_payoff_latency_seconds") is not None
                and _number(item.get("hook_payoff_latency_seconds"), 99.0) > 5.0
            ):
                rejection_reasons.append("hook_payoff_too_late")
            if (
                _number(motivational.get("filler_ratio"), 0.0) > 0.12
                and not bool(item.get("filler_is_essential_quoted_dialogue"))
            ):
                rejection_reasons.append("high_filler_ratio")
            if _number(item.get("composite_edit_count"), 0.0) > 0.0:
                rejection_reasons.append("generated_cuts_not_allowed")
            if motivational.get("ends_with_connector"):
                rejection_reasons.append("incomplete_ending_connector")
        if micro_selection:
            tension_dimensions = (
                _number(micro_components.get("semantic_tension_score")),
                _number(micro_components.get("contrast_score")),
                _number(micro_components.get("conflict_score")),
                _number(micro_components.get("reversal_score")),
            )
            if max(tension_dimensions) < 40.0:
                rejection_reasons.append("missing_semantic_tension")
            if _number(
                micro_components.get("self_contained_micro_arc_score")
            ) < 60.0:
                rejection_reasons.append("weak_self_contained_micro_arc")
            if _number(micro_components.get("context_dependence_score")) >= 55.0:
                rejection_reasons.append("micro_context_dependent")
            if (
                _number(micro_components.get("generic_motivation_score")) >= 70.0
                and max(tension_dimensions) < 60.0
            ):
                rejection_reasons.append("generic_motivation_without_tension")
        if gaming_content and gaming.get("gaming_menu_hits") and (
            measured_visual_score < 30.0 or static_frame_ratio >= 0.55
        ):
            rejection_reasons.append("static_menu_or_loading")
        if gaming_content and gaming.get("reaction_without_cause") and measured_visual_score < 45.0:
            rejection_reasons.append("reaction_without_visible_cause")
        if gaming_content and static_frame_ratio >= 0.85 and measured_visual_score < 15.0:
            rejection_reasons.append("low_gameplay_activity")
        model_coherence_score = _number(item.get("narrative_coherence_score"), 0.0)
        model_micro_story_score = _number(item.get("micro_story_score"), 0.0)
        if gaming_content and model_coherence_score > 0.0:
            if model_coherence_score < 55.0:
                rejection_reasons.append("low_narrative_coherence")
            if item.get("has_clear_setup") is False:
                rejection_reasons.append("missing_clear_setup")
            if item.get("has_visible_cause") is False:
                rejection_reasons.append("missing_visible_cause")
            if item.get("has_complete_outcome") is False:
                rejection_reasons.append("missing_complete_outcome")
        if gaming_content and model_micro_story_score > 0.0:
            if model_micro_story_score < 60.0:
                rejection_reasons.append("weak_micro_story")
            if item.get("has_escalation") is False:
                rejection_reasons.append("missing_escalation")
        max_duration = _number(item.get("max_duration_seconds"), EDUCATIONAL_MAX_DURATION_SECONDS)
        if educational_semantics:
            max_duration = min(max_duration, EDUCATIONAL_MAX_DURATION_SECONDS)
        if gaming_content:
            max_duration = min(max_duration, GAMING_MAX_DURATION_SECONDS)
        if micro_selection:
            micro_policy = _profiles.SELECTION_PROFILES.get(
                normalized_selection_profile,
                {},
            )
            micro_hard_max = _number(
                micro_policy.get("hard_max_seconds"),
                MICRO_HARD_MAX_SECONDS,
            )
            micro_hard_min = _number(
                micro_policy.get("hard_min_seconds"),
                MICRO_HARD_MIN_SECONDS,
            )
            max_duration = min(max_duration, micro_hard_max)
        elif motivational_content:
            max_duration = min(max_duration, motivational_policy["hard_max_seconds"])
        if duration > max_duration:
            rejection_reasons.append("duration_over_limit")
        if micro_selection:
            if duration < micro_hard_min:
                rejection_reasons.append("micro_duration_under_8s")
            if duration > micro_hard_max:
                rejection_reasons.append(
                    "micro_duration_over_30s"
                    if hook_gate_v2
                    else "micro_duration_over_22s"
                )
            observed_source_cuts = []
            if item.get("source_cut_count") is not None:
                observed_source_cuts.append(
                    max(0, int(_number(item.get("source_cut_count"))))
                )
            scene_change_times = item.get("source_scene_change_times")
            if isinstance(scene_change_times, list):
                observed_source_cuts.append(len(scene_change_times))
            source_cut_limit = 2
            semantic_extension_cuts = []
            if (
                item.get("semantic_extension_applied") is True
                and item.get("semantic_continuation_required") is not True
                and isinstance(scene_change_times, list)
            ):
                extension_start = _number(
                    item.get("semantic_extension_start_time"),
                    -1.0,
                )
                extension_end = _number(
                    item.get("semantic_extension_end_time"),
                    -1.0,
                )
                semantic_extension_cuts = [
                    float(value)
                    for value in scene_change_times
                    if extension_start < float(value) <= extension_end + 0.001
                ]
                pre_extension_cuts = [
                    float(value)
                    for value in scene_change_times
                    if float(value) <= extension_start + 0.001
                ]
                declared_count = max(observed_source_cuts or [0])
                if (
                    len(semantic_extension_cuts) == 1
                    and len(pre_extension_cuts) <= 2
                    and len(scene_change_times) == 3
                    and declared_count == 3
                ):
                    source_cut_limit = 3
                    item["semantic_completion_source_cut_exception"] = True
                    item["semantic_completion_added_source_cuts"] = 1
            item["effective_source_cut_limit"] = source_cut_limit
            if observed_source_cuts and max(observed_source_cuts) > source_cut_limit:
                rejection_reasons.append("source_cut_limit_exceeded")
            if _number(item.get("artificial_cut_count"), 0.0) > 0.0:
                rejection_reasons.append("generated_cuts_not_allowed")
        elif motivational_content:
            if duration < motivational_policy["hard_min_seconds"]:
                rejection_reasons.append("duration_under_14s")
            elif (
                duration < motivational_policy["strong_min_seconds"]
                and not bool(item.get("is_standalone_one_liner"))
            ):
                rejection_reasons.append("short_clip_not_complete_aphorism")
        elif duration < 20.0 and not bool(item.get("is_standalone_one_liner")):
            rejection_reasons.append("duration_under_20s")

        final_score = _quality_score(
            item,
            MOTIVATIONAL_PODCAST if micro_selection else content_type,
        )
        motivational_semantic_score = final_score if motivational_content else 0.0
        motivational_hook_timing_score = 0.0
        motivational_closure_alignment_score = 0.0
        motivational_opening_directness_score = 0.0
        motivational_information_density_score = 0.0
        motivational_shot_stability_score = 0.0
        motivational_duration_fit_score = 0.0
        motivational_filler_penalty = 0.0
        motivational_cut_penalty = 0.0
        if motivational_content:
            motivational_hook_timing_score = _hook_timing_score(
                item.get("hook_payoff_latency_seconds")
            )
            motivational_closure_alignment_score = _closure_alignment_score(item)
            motivational_opening_directness_score = _number(
                motivational.get("opening_directness_score"),
                80.0,
            )
            motivational_information_density_score = _number(
                motivational.get("information_density_score"),
                80.0,
            )
            motivational_shot_stability_score = _shot_stability_score(
                item.get("source_cut_count")
            )
            motivational_duration_fit_score = (
                _number(micro_components.get("duration_fit_score"))
                if micro_selection
                else _duration_fit_score(duration)
            )
            filler_ratio = _number(motivational.get("filler_ratio"), 0.0)
            if filler_ratio > 0.05:
                motivational_filler_penalty = min(8.0, (filler_ratio - 0.05) * 80.0)
            source_cuts = int(_number(item.get("source_cut_count"), 0.0))
            source_cut_density = _number(
                item.get("source_cut_density_per_10s"),
                source_cuts / max(0.001, duration) * 10.0,
            )
            motivational_cut_penalty = min(
                18.0,
                max(0.0, source_cuts - 2) * 2.5
                + max(0.0, source_cut_density - 1.2) * 4.0,
            )
            final_score = (
                0.50 * motivational_semantic_score
                + 0.18 * motivational_hook_timing_score
                + 0.10 * motivational_closure_alignment_score
                + 0.08 * motivational_opening_directness_score
                + 0.06 * motivational_information_density_score
                + 0.05 * motivational_shot_stability_score
                + 0.03 * motivational_duration_fit_score
                - motivational_filler_penalty
                - motivational_cut_penalty
            )
        micro_generic_penalty = 0.0
        micro_context_penalty = 0.0
        if micro_selection:
            micro_generic_penalty = _number(
                micro_components.get("generic_motivation_penalty")
            )
            micro_context_penalty = _number(
                micro_components.get("context_dependence_penalty")
            )
            final_score = (
                0.45 * final_score
                + 0.55 * _number(micro_components.get("quality_score"))
                - micro_generic_penalty
                - micro_context_penalty
            )
        tension_bonus = emotional_tension_bonus(text)
        final_score += tension_bonus
        semantic_bonus = 0.0
        if "topic_completeness_score" in item and "closure_score" in item:
            semantic_bonus = (
                0.10 * _number(item.get("topic_completeness_score"))
                + 0.10 * _number(item.get("closure_score"))
            )
            final_score += semantic_bonus
        resolution_bonus = 5.0 if item.get("resolution_answers_hook") is True else 0.0
        edit_cut_penalty = 0.75 * _number(item.get("composite_edit_count"), 0.0)
        redundancy_penalty = 0.08 * _number(item.get("redundancy_score"), 0.0)
        mechanism_ratio = _number(item.get("core_mechanism_start_ratio"), 0.0)
        late_mechanism_penalty = max(0.0, (mechanism_ratio - 0.55) * 20.0)
        preferred_duration_bonus = 0.0
        if (
            educational_semantics
            and item.get("source_beats")
            and EDUCATIONAL_PREFERRED_MIN_SECONDS <= duration <= EDUCATIONAL_PREFERRED_MAX_SECONDS
        ):
            preferred_duration_bonus = 2.0
        gaming_arc_score = 0.0
        gaming_arc_bonus = 0.0
        gaming_static_penalty = 0.0
        gaming_coherence_bonus = 0.0
        gaming_micro_story_bonus = 0.0
        if gaming_content:
            gaming_arc_score = min(
                100.0,
                20.0 * min(2, len(gaming.get("gaming_action_hits", [])))
                + 25.0 * min(2, len(gaming.get("gaming_outcome_hits", [])))
                + 0.10 * _number(item.get("payoff_score")),
            )
            gaming_arc_bonus = 0.08 * gaming_arc_score
            gaming_static_penalty = 10.0 * static_frame_ratio
            gaming_coherence_bonus = 0.05 * model_coherence_score
            gaming_micro_story_bonus = 0.05 * model_micro_story_score
            if GAMING_PREFERRED_MIN_SECONDS <= duration <= GAMING_PREFERRED_MAX_SECONDS:
                preferred_duration_bonus += 2.0
        motivational_title_penalty = 0.0
        motivational_redundancy_penalty = 0.0
        motivational_boundary_penalty = 0.0
        if motivational_content:
            title_fit = _number(item.get("title_fit_score"), 70.0)
            motivational_title_penalty = max(0.0, 70.0 - title_fit) * 0.12
            motivational_redundancy_penalty = 0.10 * _number(
                item.get("redundancy_score"), 0.0
            )
            motivational_boundary_penalty = max(
                0.0,
                80.0 - _number(item.get("boundary_quality_score"), 80.0),
            ) * 0.10
        final_score += (
            resolution_bonus
            + preferred_duration_bonus
            + gaming_arc_bonus
            + gaming_coherence_bonus
            + gaming_micro_story_bonus
            - edit_cut_penalty
            - redundancy_penalty
            - late_mechanism_penalty
            - gaming_static_penalty
            - motivational_title_penalty
            - motivational_redundancy_penalty
            - motivational_boundary_penalty
        )
        if promotion["outro_hits"] and not promotion["mostly_cta"]:
            final_score -= 15.0
        if (
            not motivational_content
            and duration < 20.0
            and bool(item.get("is_standalone_one_liner"))
        ):
            final_score -= 12.0
        if not motivational_content and 20.0 <= duration < 25.0:
            final_score -= 5.0
        if not motivational_content and 25.0 <= duration <= 90.0:
            final_score += 2.0
        if duration_total > 0 and _number(item.get("start_time")) / duration_total >= 0.90:
            final_score -= 2.0

        item.update(promotion)
        item.update(gaming)
        item.update(motivational)
        item.update(micro_language)
        item["candidate_text"] = text
        item["duration_seconds"] = round(duration, 3)
        item["edit_duration_seconds"] = round(edit_duration, 3)
        if normalized_selection_profile:
            item["selection_profile"] = normalized_selection_profile
            item["selection_policy_version"] = normalized_selection_profile
        if micro_selection:
            rounded_components = {
                key: round(_number(value), 3)
                for key, value in micro_components.items()
            }
            item["selection_score_components"] = rounded_components
            item["micro_semantic_score"] = rounded_components["semantic_score"]
            item["micro_quality_score"] = rounded_components["quality_score"]
            item["reaction_tail_compatibility_score"] = rounded_components[
                "reaction_tail_compatibility_score"
            ]
            item["generic_motivation_penalty"] = round(
                micro_generic_penalty, 3
            )
            item["context_dependence_penalty"] = round(
                micro_context_penalty, 3
            )
        item["emotional_tension_bonus"] = tension_bonus
        item["semantic_closure_bonus"] = round(semantic_bonus, 3)
        item["semantic_resolution_bonus"] = round(resolution_bonus, 3)
        item["preferred_duration_bonus"] = round(preferred_duration_bonus, 3)
        item["composite_edit_penalty"] = round(edit_cut_penalty, 3)
        item["semantic_redundancy_penalty"] = round(redundancy_penalty, 3)
        item["late_mechanism_penalty"] = round(late_mechanism_penalty, 3)
        item["gaming_arc_score"] = round(gaming_arc_score, 3)
        item["gaming_arc_bonus"] = round(gaming_arc_bonus, 3)
        item["gaming_static_penalty"] = round(gaming_static_penalty, 3)
        item["gaming_coherence_bonus"] = round(gaming_coherence_bonus, 3)
        item["gaming_micro_story_bonus"] = round(gaming_micro_story_bonus, 3)
        item["motivational_title_penalty"] = round(motivational_title_penalty, 3)
        item["motivational_redundancy_penalty"] = round(
            motivational_redundancy_penalty, 3
        )
        item["motivational_boundary_penalty"] = round(
            motivational_boundary_penalty, 3
        )
        item["motivational_semantic_model_score"] = round(motivational_semantic_score, 3)
        item["hook_timing_score"] = round(motivational_hook_timing_score, 3)
        item["closure_alignment_score"] = round(
            motivational_closure_alignment_score, 3
        )
        item["opening_directness_score"] = round(
            motivational_opening_directness_score, 3
        )
        item["information_density_score"] = round(
            motivational_information_density_score, 3
        )
        item["shot_stability_score"] = round(motivational_shot_stability_score, 3)
        item["duration_fit_score"] = round(motivational_duration_fit_score, 3)
        item["motivational_filler_penalty"] = round(motivational_filler_penalty, 3)
        item["motivational_cut_penalty"] = round(motivational_cut_penalty, 3)
        item["final_score"] = round(max(0.0, min(100.0, final_score)), 3)
        item["rejected"] = bool(rejection_reasons)
        item["rejection_reasons"] = rejection_reasons
        ranked.append(item)

    if micro_selection:
        ranked.sort(
            key=lambda item: (
                bool(item["rejected"]),
                -float(item["final_score"]),
                -_number(item.get("micro_semantic_score")),
                -_number(item.get("reaction_tail_compatibility_score")),
                _number(item.get("hook_payoff_latency_seconds"), 999.0),
                float(item.get("start_time", 0.0)),
            )
        )
    elif motivational_content:
        ranked.sort(
            key=lambda item: (
                bool(item["rejected"]),
                -float(item["final_score"]),
                _number(item.get("hook_payoff_latency_seconds"), 999.0),
                _number(item.get("source_cut_count"), 999.0),
                _number(item.get("filler_ratio"), 1.0),
                float(item.get("start_time", 0.0)),
            )
        )
    else:
        ranked.sort(
            key=lambda item: (
                bool(item["rejected"]),
                -float(item["final_score"]),
                float(item.get("start_time", 0.0)),
            )
        )
    for index, item in enumerate(ranked, start=1):
        item["selection_rank"] = index
    return ranked


def eligible_highlights(ranked: List[Dict], limit: Optional[int] = None) -> List[Dict]:
    eligible = [item for item in ranked if not item.get("rejected")]
    return eligible[:limit] if limit is not None else eligible


def _temporal_overlap_ratio(left: Dict, right: Dict) -> float:
    left_start = _number(left.get("start_time"))
    left_end = _number(left.get("end_time"))
    right_start = _number(right.get("start_time"))
    right_end = _number(right.get("end_time"))
    overlap = max(0.0, min(left_end, right_end) - max(left_start, right_start))
    shorter_duration = min(left_end - left_start, right_end - right_start)
    return overlap / max(0.001, shorter_duration)


def _batch_tokens(item: Dict) -> Set[str]:
    source = " ".join(
        str(item.get(key) or "")
        for key in (
            "candidate_text", "title", "hook_sentence", "final_takeaway_sentence",
            "thesis", "topic",
        )
    ).lower()
    return {
        token
        for token in re.findall(r"[a-z0-9']+", source)
        if len(token) > 2 and token not in BATCH_TOKEN_STOPWORDS
    }


def _token_overlap_ratio(left: Dict, right: Dict) -> float:
    left_tokens = _batch_tokens(left)
    right_tokens = _batch_tokens(right)
    if min(len(left_tokens), len(right_tokens)) < 5:
        return 0.0
    return len(left_tokens & right_tokens) / min(len(left_tokens), len(right_tokens))


def select_diverse_highlights(
    ranked: List[Dict],
    limit: int,
    max_temporal_overlap_ratio: float = BATCH_MAX_TEMPORAL_OVERLAP_RATIO,
    max_token_overlap_ratio: float = BATCH_MAX_TOKEN_OVERLAP_RATIO,
) -> List[Dict]:
    """Select a ranked batch while suppressing duplicate moments and stories."""
    if limit <= 0:
        return []

    selected: List[Dict] = []
    for item in ranked:
        item["selected_for_render"] = False
        item.pop("output_rank", None)
        item.pop("batch_exclusion_reason", None)
        if item.get("rejected"):
            continue

        exclusion_reason = None
        for kept in selected:
            if _temporal_overlap_ratio(item, kept) > max_temporal_overlap_ratio:
                exclusion_reason = "overlaps_higher_ranked_clip"
                break
            item_topic = re.sub(r"\W+", " ", str(item.get("topic") or "").lower()).strip()
            kept_topic = re.sub(r"\W+", " ", str(kept.get("topic") or "").lower()).strip()
            if item_topic and item_topic == kept_topic:
                exclusion_reason = "duplicates_higher_ranked_topic"
                break
            if _token_overlap_ratio(item, kept) > max_token_overlap_ratio:
                exclusion_reason = "duplicates_higher_ranked_story"
                break

        if exclusion_reason:
            item["batch_exclusion_reason"] = exclusion_reason
            continue

        item["selected_for_render"] = True
        item["output_rank"] = len(selected) + 1
        selected.append(item)
        if len(selected) >= limit:
            break

    return selected
