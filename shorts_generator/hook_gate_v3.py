"""Deterministic feed-stop selection for authentic short-form speech.

HookGate V3 consumes only an existing candidate and transcript word timings.
It never decodes video, retranscribes audio, rewrites speech, or invokes the
renderer.  Model-proposed exact quotes remain useful evidence, but every
timing and score in the decision is recomputed from source-contiguous words.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .hook_gate_report import (
    HOOK_GATE_V3_REPORT_SCHEMA_VERSION,
    build_hook_gate_v3_report,
)

HOOK_GATE_V3_SCHEMA_VERSION = HOOK_GATE_V3_REPORT_SCHEMA_VERSION
HOOK_GATE_V3_VERSION = "hook-gate-v3.0.0"
HOOK_GATE_V3_PROMPT_VERSION = HOOK_GATE_V3_VERSION
HOOK_GATE_V3_DECISION_VERSION = HOOK_GATE_V3_VERSION
BF_FEED_STOP_POLICY_VERSION = "bf_feed_stop_v1"

HOOK_GATE_V3_RESPONSE_CONTRACT = """HookGate V3 response extension:
- Return opening_exact_quote as the exact first 6-12 source-contiguous words.
- Return hook_payoff_phrase as the exact source-contiguous phrase where the
  mechanism, reversal, rule, or consequence begins.
- Return hook_family as one of contradiction, concrete_rule, identity_threat,
  interpersonal_conflict, surprising_consequence, emotional_comparison,
  visual_metaphor, or common_belief_challenge.
- Do not invent HookGate measurements. Python derives all timing and scoring
  fields from the existing word timestamps.
- Do not rewrite, reorder, stitch, or remove internal spoken words."""

HOOK_GATE_V3_PROMPT = """HookGate V3 / bf_feed_stop_v1:
- Prefer 12-17 seconds of complete speech; allow 17-21 seconds only when the
  additional words complete the payoff. Treat 21-24 seconds as explicit review.
- Speech must begin within 100ms of the rendered start on a complete authentic
  word boundary.
- The first 6-8 words must create a contradiction, concrete rule, identity
  threat, interpersonal conflict, surprising consequence, emotionally charged
  comparison, specific visual metaphor, or challenge to a common belief.
- A tension, rule, or consequence must be audible by 2.0 seconds and the
  mechanism/reversal/payoff must begin by 6.0 seconds for speech under 18s.
- Reject topic introductions, attribution, host setup, unclear callbacks,
  repeated setup, slow abstract framing, incomplete endings, and multiple ideas.
- Never manufacture a hook by rewriting, stitching, reordering, or deleting
  internal source words."""

DEFAULT_POLICY: Dict[str, object] = {
    "policy_version": BF_FEED_STOP_POLICY_VERSION,
    "minimum_score": 80.0,
    "maximum_context_dependence": 15.0,
    "maximum_abstraction_score": 35.0,
    "maximum_tension_latency_seconds": 2.0,
    "maximum_payoff_latency_seconds": 6.0,
    "preferred_min_seconds": 12.0,
    "preferred_max_seconds": 17.0,
    "complete_payoff_max_seconds": 21.0,
    "review_max_seconds": 24.0,
}

_TOKEN_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?", re.IGNORECASE)
_CLAUSE_END_RE = re.compile(r"[.!?;:][\"')\]]*$")
_ACTION_WORDS = frozenset(
    {
        "ask", "avoid", "choose", "do", "don't", "leave", "let", "listen",
        "look", "never", "notice", "pluck", "protect", "remember", "say",
        "start", "stop", "tell", "trust", "walk", "water",
    }
)
_TENSION_WORDS = frozenset(
    {
        "afraid", "anxious", "anxiety", "behind", "betray", "break", "conflict",
        "criticize", "criticism", "danger", "die", "fear", "fake", "gossip",
        "gossiping", "hate", "hurt", "jealous", "lose", "nervous", "pain",
        "rejection", "self-conscious", "wrong",
    }
)
_CONSEQUENCE_WORDS = frozenset(
    {
        "behind", "break", "cost", "die", "fail", "hurt", "lose", "lost",
        "pluck", "regret", "water", "win",
    }
)
_CONCRETE_WORDS = frozenset(
    {
        "body", "door", "face", "flower", "friend", "garden", "hand", "money",
        "people", "person", "phone", "room", "sentence", "table", "water",
        "word", "work",
    }
)
_INTERPERSONAL_WORDS = frozenset(
    {
        "approval", "friend", "gossip", "gossiping", "like", "love", "partner",
        "people", "person", "relationship", "rejection", "they", "you", "your",
        "yourself",
    }
)
_CONTRAST_WORDS = frozenset(
    {"but", "instead", "not", "opposite", "rather", "versus", "while", "yet"}
)
_ABSTRACT_NOUNS = frozenset(
    {
        "anxiety", "communication", "confidence", "connection", "consciousness",
        "feeling", "happiness", "importance", "mindset", "nervousness",
        "relationship", "self-consciousness", "success",
    }
)
_ABSTRACT_OPENERS = (
    ("the", "reason", "is"),
    ("i", "think", "that"),
    ("what", "makes"),
    ("one", "of", "the", "things"),
    ("what", "i", "realized"),
    ("when", "we", "talk", "about"),
    ("the", "way", "i", "see", "it"),
    ("for", "example"),
)
_HOST_OR_ATTRIBUTION_TERMS = (
    "according to",
    "as you said",
    "my next guest",
    "our guest",
    "tell me about",
    "welcome back",
    "you wrote",
)
_UNCLEAR_OPENING_PRONOUNS = frozenset(
    {"he", "it", "she", "that", "these", "they", "this", "those"}
)
_INCOMPLETE_END_WORDS = frozenset(
    {
        "and", "because", "but", "if", "or", "so", "then", "though",
        "unless", "until", "when", "whereas", "which", "while", "yet",
    }
)
_STOPWORDS = frozenset(
    {
        "a", "about", "an", "and", "are", "as", "at", "be", "being", "by",
        "for", "from", "has", "have", "i", "in", "is", "it", "of", "on",
        "or", "that", "the", "to", "was", "we", "were", "what", "when",
        "with",
    }
)

_MEMORY_CACHE: Dict[str, Dict] = {}
_MEMORY_CACHE_LIMIT = 1024
_NORMALIZED_TIMING_CACHE: Dict[str, List[Dict]] = {}
_NORMALIZED_TIMING_CACHE_LIMIT = 4
_MEASUREMENT_FIELDS = frozenset(
    {
        "speechStart",
        "speechEnd",
        "speechDuration",
        "openingQuote",
        "payoffQuote",
        "firstWordLatencyMs",
        "firstClauseEndSeconds",
        "firstConcreteClaimSeconds",
        "firstTensionSignalSeconds",
        "firstActionableRuleSeconds",
        "firstConsequenceSeconds",
        "firstPayoffSeconds",
        "openingWordCountAtTwoSeconds",
        "openingSemanticDensity",
        "openingContextDependence",
        "openingAbstractionScore",
        "openingSpecificityScore",
        "hookCompressionScore",
        "hookFamily",
        "hookGateScore",
        "hookGateScoreComponents",
        "hookGatePenalties",
        "hookGateVersion",
        "selectionPolicyVersion",
        "hookGateStatus",
        "hookGateEligible",
        "hookGateRejectionReasons",
        "hookGateReviewReasons",
        "hook_family",
    }
)


def _number(value: object, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _tokens(value: object) -> List[str]:
    return _TOKEN_RE.findall(
        str(value or "")
        .lower()
        .replace("’", "'")
        .replace("‘", "'")
        .replace("`", "'")
    )


def _coerce_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes"}:
            return True
        if normalized in {"false", "0", "no"}:
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _normalize_words(timed_words: Sequence[Dict]) -> List[Dict]:
    normalized: List[Dict] = []
    source_index = 0
    for raw in timed_words:
        if not isinstance(raw, dict):
            continue
        start = _number(raw.get("start"), -1.0)
        end = _number(raw.get("end"), -1.0)
        text = str(raw.get("word") or raw.get("text") or "").strip()
        word_tokens = _tokens(text)
        if start < 0.0 or end <= start or not word_tokens:
            continue
        for token in word_tokens:
            normalized.append(
                {
                    "token": token,
                    "text": text,
                    "start": start,
                    "end": end,
                    "source_index": source_index,
                }
            )
        source_index += 1
    return normalized


def _candidate_words(
    candidate: Dict,
    timed_words: Sequence[Dict],
    *,
    already_normalized: bool = False,
) -> List[Dict]:
    speech_start = _number(
        candidate.get("speech_start_time", candidate.get("start_time")),
        -1.0,
    )
    speech_end = _number(
        candidate.get("speech_end_time", candidate.get("end_time")),
        -1.0,
    )
    return [
        word
        for word in (
            timed_words
            if already_normalized
            else _normalize_words(timed_words)
        )
        if word["end"] > speech_start - 0.001
        and word["start"] < speech_end + 0.001
    ]


def _relative_time(word: Optional[Dict], speech_origin: float) -> Optional[float]:
    if word is None:
        return None
    return round(max(0.0, float(word["start"]) - speech_origin), 3)


def _first_index(tokens: Sequence[str], accepted: Iterable[str]) -> Optional[int]:
    accepted_set = set(accepted)
    return next(
        (index for index, token in enumerate(tokens) if token in accepted_set),
        None,
    )


def _starts_with(tokens: Sequence[str], prefix: Sequence[str]) -> bool:
    return list(tokens[: len(prefix)]) == list(prefix)


def _phrase_start(
    words: Sequence[Dict],
    phrase: object,
) -> Optional[int]:
    phrase_tokens = _tokens(phrase)
    if not phrase_tokens or len(phrase_tokens) > len(words):
        return None
    for index in range(len(words) - len(phrase_tokens) + 1):
        if [
            word["token"] for word in words[index : index + len(phrase_tokens)]
        ] == phrase_tokens:
            return index
    return None


def _first_clause_end(words: Sequence[Dict], speech_origin: float) -> Optional[float]:
    if not words:
        return None
    for word in words:
        if _CLAUSE_END_RE.search(str(word["text"])):
            return round(max(0.0, float(word["end"]) - speech_origin), 3)
    # Punctuation-free ASR is common. Eight words is a deterministic proxy for
    # the opening clause, not permission to cut the source there.
    word = words[min(7, len(words) - 1)]
    return round(max(0.0, float(word["end"]) - speech_origin), 3)


def _opening_context_dependence(
    tokens: Sequence[str],
    candidate: Dict,
    has_early_concrete_signal: bool,
) -> float:
    score = 0.0
    if tokens and tokens[0] in _UNCLEAR_OPENING_PRONOUNS:
        score += 65.0
    if any(_starts_with(tokens, prefix) for prefix in _ABSTRACT_OPENERS):
        score += 10.0 if has_early_concrete_signal else 60.0
    if _coerce_bool(candidate.get("requires_previous_context")):
        score += 60.0
    if _coerce_bool(candidate.get("contains_context_callback")):
        score += 45.0
    if _coerce_bool(candidate.get("opens_with_context_connector")):
        score += 35.0
    if _coerce_bool(candidate.get("contains_external_antecedent")):
        score += 55.0
    if candidate.get("new_viewer_understands_opening") is False:
        score += 50.0
    return min(100.0, score)


def _opening_abstraction_score(
    opening_tokens: Sequence[str],
    has_action: bool,
    has_concrete: bool,
    has_consequence: bool,
    has_contrast: bool,
) -> float:
    abstract_hits = len(set(opening_tokens) & _ABSTRACT_NOUNS)
    score = 14.0 * abstract_hits
    if any(_starts_with(opening_tokens, prefix) for prefix in _ABSTRACT_OPENERS):
        score += 52.0
    if (
        len(opening_tokens) >= 3
        and opening_tokens[1] in {"is", "are", "means"}
        and opening_tokens[0] in _ABSTRACT_NOUNS
    ):
        score += 38.0
    if not (has_action or has_concrete or has_consequence or has_contrast):
        score += 25.0
    score -= 18.0 if has_action else 0.0
    score -= 18.0 if has_concrete else 0.0
    score -= 12.0 if has_consequence else 0.0
    score -= 10.0 if has_contrast else 0.0
    return max(0.0, min(100.0, score))


def _opening_specificity_score(
    opening_tokens: Sequence[str],
    has_action: bool,
    has_concrete: bool,
    has_consequence: bool,
    has_contrast: bool,
) -> float:
    content_words = [token for token in opening_tokens if token not in _STOPWORDS]
    score = 20.0 + min(18.0, 3.0 * len(set(content_words)))
    score += 24.0 if has_action else 0.0
    score += 24.0 if has_concrete else 0.0
    score += 18.0 if has_consequence else 0.0
    score += 12.0 if has_contrast else 0.0
    return max(0.0, min(100.0, score))


def _latency_component(
    value: Optional[float],
    excellent: float,
    allowed: float,
) -> float:
    if value is None:
        return 0.0
    if value <= excellent:
        return 100.0
    if value <= allowed:
        width = max(0.001, allowed - excellent)
        return 100.0 - 20.0 * (value - excellent) / width
    return max(0.0, 80.0 - 40.0 * (value - allowed))


def _hook_family(
    tokens: Sequence[str],
    action_index: Optional[int],
    consequence_index: Optional[int],
    concrete_index: Optional[int],
) -> str:
    token_set = set(tokens[:12])
    if concrete_index is not None and (
        "flower" in token_set or "garden" in token_set
    ):
        return "visual_metaphor"
    if action_index is not None and (
        (tokens and tokens[0] in {"do", "don't", "never", "stop"})
        or "if" in tokens[:3]
    ):
        return "concrete_rule"
    if consequence_index is not None:
        return "surprising_consequence"
    if token_set & {"gossip", "gossiping", "criticize", "criticism"}:
        return "interpersonal_conflict"
    if token_set & _CONTRAST_WORDS:
        return "contradiction"
    if token_set & {"you", "your", "yourself"} and token_set & _TENSION_WORDS:
        return "identity_threat"
    if token_set & {"like", "love", "hate"}:
        return "emotional_comparison"
    return "common_belief_challenge"


def _round_score(value: float) -> float:
    return round(max(0.0, min(100.0, value)), 3)


def _unique(values: Iterable[str]) -> List[str]:
    return list(dict.fromkeys(value for value in values if value))


def _semantic_measurements(
    candidate: Dict,
    timed_words: Sequence[Dict],
    *,
    already_normalized: bool = False,
) -> Dict:
    words = _candidate_words(
        candidate,
        timed_words,
        already_normalized=already_normalized,
    )
    speech_start = _number(
        candidate.get("speech_start_time", candidate.get("start_time")),
        -1.0,
    )
    render_start = _number(
        candidate.get("render_start_time", candidate.get("start_time")),
        speech_start,
    )
    speech_end = _number(
        candidate.get("speech_end_time", candidate.get("end_time")),
        -1.0,
    )
    tokens = [word["token"] for word in words]
    first_word = words[0] if words else None
    speech_origin = float(first_word["start"]) if first_word else speech_start
    opening_words = [
        word for word in words if float(word["start"]) - speech_origin <= 2.0
    ]
    opening_tokens = [word["token"] for word in opening_words]
    first_eight = tokens[:8]

    action_index = _first_index(tokens, _ACTION_WORDS)
    tension_index = _first_index(tokens, _TENSION_WORDS)
    consequence_index = _first_index(tokens, _CONSEQUENCE_WORDS)
    concrete_index = _first_index(tokens, _CONCRETE_WORDS)
    contrast_index = _first_index(tokens, _CONTRAST_WORDS)
    payoff_index = next(
        (
            index
            for index in (
                action_index,
                consequence_index,
                contrast_index,
                _phrase_start(words, candidate.get("hook_payoff_phrase")),
            )
            if index is not None
        ),
        None,
    )
    # A definition has a resolving predicate but remains heavily penalized as
    # abstract. This keeps the latency measurement honest without rewarding it.
    if payoff_index is None and "is" in tokens[:8]:
        is_index = tokens[:8].index("is")
        if is_index + 1 < len(tokens):
            payoff_index = is_index + 1

    signal_indexes = [
        index
        for index in (
            action_index,
            tension_index,
            consequence_index,
            concrete_index,
            contrast_index,
        )
        if index is not None
    ]
    tension_signal_index = min(signal_indexes) if signal_indexes else None
    claim_indexes = [
        index
        for index in (action_index, consequence_index, concrete_index)
        if index is not None
    ]
    concrete_claim_index = min(claim_indexes) if claim_indexes else None

    has_action = action_index is not None and action_index < len(opening_tokens)
    has_concrete = (
        concrete_index is not None and concrete_index < len(opening_tokens)
    )
    has_consequence = (
        consequence_index is not None
        and consequence_index < len(opening_tokens)
    )
    has_contrast = (
        contrast_index is not None and contrast_index < len(opening_tokens)
    )
    has_early_concrete_signal = any(
        index is not None
        and index < len(words)
        and float(words[index]["start"]) - speech_origin <= 2.0
        for index in (action_index, consequence_index, concrete_index)
    )
    abstraction = _opening_abstraction_score(
        first_eight,
        has_action,
        has_concrete,
        has_consequence,
        has_contrast,
    )
    specificity = _opening_specificity_score(
        first_eight,
        has_action,
        has_concrete,
        has_consequence,
        has_contrast,
    )
    context = _opening_context_dependence(
        first_eight,
        candidate,
        has_early_concrete_signal,
    )
    semantic_signal_tokens = (
        _ACTION_WORDS
        | _TENSION_WORDS
        | _CONSEQUENCE_WORDS
        | _CONCRETE_WORDS
        | _CONTRAST_WORDS
    )
    semantic_count = sum(token in semantic_signal_tokens for token in opening_tokens)
    density = (
        100.0 * semantic_count / max(1, len(opening_tokens))
    )
    tension_time = _relative_time(
        words[tension_signal_index] if tension_signal_index is not None else None,
        speech_origin,
    )
    payoff_time = _relative_time(
        words[payoff_index] if payoff_index is not None else None,
        speech_origin,
    )
    word_count_score = min(100.0, 14.0 * len(opening_words))
    compression = (
        0.45 * _latency_component(tension_time, 0.8, 2.0)
        + 0.25 * word_count_score
        + 0.30 * min(100.0, density * 2.6)
    )

    opening_quote = " ".join(word["text"] for word in words[: min(12, len(words))])
    payoff_quote = str(candidate.get("hook_payoff_phrase") or "").strip()
    if not payoff_quote and payoff_index is not None:
        payoff_quote = " ".join(
            word["text"] for word in words[payoff_index : payoff_index + 8]
        )
    first_word_latency_ms = (
        round(max(0.0, float(first_word["start"]) - render_start) * 1000.0, 1)
        if first_word
        else None
    )
    return {
        "words": words,
        "tokens": tokens,
        "speechStart": speech_start,
        "speechEnd": speech_end,
        "speechDuration": max(0.0, speech_end - speech_start),
        "openingQuote": opening_quote,
        "payoffQuote": payoff_quote,
        "firstWordLatencyMs": first_word_latency_ms,
        "firstClauseEndSeconds": _first_clause_end(words, speech_origin),
        "firstConcreteClaimSeconds": _relative_time(
            words[concrete_claim_index]
            if concrete_claim_index is not None
            else None,
            speech_origin,
        ),
        "firstTensionSignalSeconds": tension_time,
        "firstActionableRuleSeconds": _relative_time(
            words[action_index] if action_index is not None else None,
            speech_origin,
        ),
        "firstConsequenceSeconds": _relative_time(
            words[consequence_index]
            if consequence_index is not None
            else None,
            speech_origin,
        ),
        "firstPayoffSeconds": payoff_time,
        "openingWordCountAtTwoSeconds": len(opening_words),
        "openingSemanticDensity": _round_score(density),
        "openingContextDependence": _round_score(context),
        "openingAbstractionScore": _round_score(abstraction),
        "openingSpecificityScore": _round_score(specificity),
        "hookCompressionScore": _round_score(compression),
        "hookFamily": _hook_family(
            tokens,
            action_index,
            consequence_index,
            concrete_index,
        ),
        "hasEarlyConcreteSignal": has_early_concrete_signal,
        "firstSignalWordIndex": tension_signal_index,
    }


def _score(
    candidate: Dict,
    measurements: Dict,
) -> Tuple[float, Dict, List[Dict]]:
    tension = measurements["firstTensionSignalSeconds"]
    payoff = measurements["firstPayoffSeconds"]
    ending_complete = (
        candidate.get("has_complete_ending") is True
        and candidate.get("has_takeaway", True) is not False
    )
    interpersonal = bool(
        set(measurements["tokens"][:16]) & _INTERPERSONAL_WORDS
    )
    quotability = _number(candidate.get("quotability_score"), -1.0)
    if quotability < 0.0:
        quotability = min(
            95.0,
            58.0
            + 0.22 * measurements["openingSpecificityScore"]
            + (12.0 if ending_complete else 0.0),
        )
    components = {
        "immediateTensionOrRule": _latency_component(tension, 0.8, 2.0),
        "openingSpecificity": measurements["openingSpecificityScore"],
        "contextIndependence": 100.0
        - measurements["openingContextDependence"],
        "payoffLatency": _latency_component(payoff, 3.0, 6.0),
        "semanticCompression": measurements["hookCompressionScore"],
        "completeEnding": 100.0 if ending_complete else 0.0,
        "interpersonalRelevance": 100.0 if interpersonal else 55.0,
        "quotability": max(0.0, min(100.0, quotability)),
    }
    weights = {
        "immediateTensionOrRule": 0.25,
        "openingSpecificity": 0.15,
        "contextIndependence": 0.15,
        "payoffLatency": 0.15,
        "semanticCompression": 0.10,
        "completeEnding": 0.10,
        "interpersonalRelevance": 0.05,
        "quotability": 0.05,
    }
    base = sum(weights[key] * components[key] for key in weights)
    penalties: List[Dict] = []

    abstraction = measurements["openingAbstractionScore"]
    if abstraction > 20.0:
        amount = min(20.0, (abstraction - 20.0) * 0.40)
        penalties.append({"reason": "abstract_opening", "points": round(amount, 3)})
    strongest_claim = measurements["firstConcreteClaimSeconds"]
    if strongest_claim is None:
        strongest_claim = measurements["firstTensionSignalSeconds"]
    if strongest_claim is None:
        penalties.append({"reason": "strong_claim_missing", "points": 20.0})
    elif strongest_claim > 3.0:
        penalties.append(
            {
                "reason": "strongest_claim_after_3s",
                "points": round(min(20.0, 8.0 + 6.0 * (strongest_claim - 3.0)), 3),
            }
        )
    if payoff is None:
        penalties.append({"reason": "payoff_missing", "points": 15.0})
    elif payoff > 7.0:
        penalties.append(
            {
                "reason": "payoff_after_7s",
                "points": round(min(15.0, 6.0 + 4.5 * (payoff - 7.0)), 3),
            }
        )
    if _coerce_bool(candidate.get("repeated_setup_before_mechanism")):
        penalties.append({"reason": "repeated_setup", "points": 15.0})
    if (
        measurements["tokens"]
        and measurements["tokens"][0] in _UNCLEAR_OPENING_PRONOUNS
        and measurements["openingContextDependence"] > 15.0
    ):
        penalties.append({"reason": "unclear_opening_reference", "points": 20.0})

    score = base - sum(float(item["points"]) for item in penalties)
    return _round_score(score), {
        key: _round_score(value) for key, value in components.items()
    }, penalties


def evaluate_hook_gate_v3(
    candidate: Dict,
    timed_words: Sequence[Dict],
    policy: Optional[Dict] = None,
    *,
    _words_are_normalized: bool = False,
) -> Dict:
    """Return a fail-closed HookGate V3 decision and all measured features."""
    item = dict(candidate)
    active_policy = {**DEFAULT_POLICY, **(policy or {})}
    measurements = _semantic_measurements(
        item,
        timed_words,
        already_normalized=_words_are_normalized,
    )
    score, components, penalties = _score(item, measurements)
    rejects: List[str] = []
    reviews: List[str] = []

    latency = measurements["firstWordLatencyMs"]
    if latency is None:
        rejects.append("hook_v3_word_timing_missing")
    elif latency > 100.0:
        rejects.append("hook_v3_first_word_after_100ms")
    if measurements["words"] and abs(
        float(measurements["words"][0]["start"])
        - float(measurements["speechStart"])
    ) > 0.05:
        rejects.append("hook_v3_opening_not_on_word_boundary")
    if measurements["words"] and _number(
        item.get("render_start_time", item.get("start_time")),
        measurements["speechStart"],
    ) > float(measurements["words"][0]["start"]) + 0.01:
        rejects.append("hook_v3_render_starts_inside_first_word")
    if item.get("begins_on_complete_word_boundary") is False:
        rejects.append("hook_v3_opening_cuts_word")
    if not measurements["words"]:
        rejects.append("hook_v3_source_words_missing")

    opening_text = " ".join(measurements["tokens"][:14])
    host_setup = (
        _coerce_bool(item.get("contains_host_setup"))
        or _coerce_bool(item.get("contains_attribution_lead_in"))
        or any(term in opening_text for term in _HOST_OR_ATTRIBUTION_TERMS)
    )
    if host_setup:
        rejects.append("hook_v3_attribution_or_host_setup")
    if item.get("has_complete_ending") is not True:
        rejects.append("hook_v3_incomplete_ending")
    if (
        measurements["tokens"]
        and measurements["tokens"][-1] in _INCOMPLETE_END_WORDS
    ):
        rejects.append("hook_v3_incomplete_ending_connector")
    if _coerce_bool(item.get("second_topic_begins_after_takeaway")):
        rejects.append("hook_v3_multiple_ideas")
    if measurements["openingContextDependence"] > _number(
        active_policy["maximum_context_dependence"],
        15.0,
    ):
        rejects.append("hook_v3_context_dependent_opening")
    if measurements["openingAbstractionScore"] > _number(
        active_policy["maximum_abstraction_score"],
        35.0,
    ):
        rejects.append("hook_v3_abstract_opening")
    tension = measurements["firstTensionSignalSeconds"]
    explicit_review = str(
        item.get("hook_gate_review_reason")
        or item.get("explicit_review_reason")
        or ""
    ).strip()
    if tension is None:
        rejects.append("hook_v3_tension_signal_missing")
    elif (
        measurements.get("firstSignalWordIndex") is not None
        and int(measurements["firstSignalWordIndex"]) > 7
    ):
        rejects.append("hook_v3_signal_after_first_eight_words")
    elif tension > _number(active_policy["maximum_tension_latency_seconds"], 2.0):
        if explicit_review:
            reviews.append("hook_v3_late_tension_explicit_review")
        else:
            rejects.append("hook_v3_tension_after_2s")
    payoff = measurements["firstPayoffSeconds"]
    duration = measurements["speechDuration"]
    if payoff is None:
        rejects.append("hook_v3_payoff_missing")
    elif duration < 18.0 and payoff > _number(
        active_policy["maximum_payoff_latency_seconds"],
        6.0,
    ):
        if explicit_review:
            reviews.append("hook_v3_late_payoff_explicit_review")
        else:
            rejects.append("hook_v3_payoff_after_6s")
    if score < _number(active_policy["minimum_score"], 80.0):
        rejects.append("hook_v3_score_below_80")

    if duration > _number(active_policy["review_max_seconds"], 24.0):
        rejects.append("hook_v3_duration_over_24s")
    elif duration > _number(active_policy["complete_payoff_max_seconds"], 21.0):
        reviews.append("hook_v3_duration_21_to_24s_requires_review")
    elif duration > _number(active_policy["preferred_max_seconds"], 17.0):
        reviews.append("hook_v3_duration_17_to_21s_complete_payoff")
    elif duration < _number(active_policy["preferred_min_seconds"], 12.0):
        reviews.append("hook_v3_duration_under_preferred_12s")

    rejects = _unique(rejects)
    reviews = _unique(reviews)
    status = "reject" if rejects else ("review" if reviews and any(
        reason.endswith("requires_review")
        or "explicit_review" in reason
        for reason in reviews
    ) else "pass")
    eligible = status == "pass"

    public_measurements = {
        key: value
        for key, value in measurements.items()
        if key
        not in {
            "words",
            "tokens",
            "hasEarlyConcreteSignal",
            "firstSignalWordIndex",
        }
    }
    item.update(public_measurements)
    item.update(
        {
            "hookGateScore": score,
            "hookGateScoreComponents": components,
            "hookGatePenalties": penalties,
            "hookGateVersion": HOOK_GATE_V3_VERSION,
            "selectionPolicyVersion": BF_FEED_STOP_POLICY_VERSION,
            "hookGateStatus": status,
            "hookGateEligible": eligible,
            "hookGateRejectionReasons": rejects,
            "hookGateReviewReasons": reviews,
            # Stable snake_case aliases keep the existing ranker/artifact
            # pipeline version-aware without erasing the requested schema.
            "hook_gate_score": score,
            "hook_gate_version": HOOK_GATE_V3_VERSION,
            "hook_gate_decision_version": HOOK_GATE_V3_DECISION_VERSION,
            "hook_gate_status": status,
            "hook_gate_eligible": eligible,
            "hook_gate_reject_reasons": rejects,
            "hook_gate_review_reasons": reviews,
            "hook_gate_deterministic_reasons": rejects + reviews,
            "hook_family": measurements["hookFamily"],
        }
    )
    return item


def transcript_word_timing_hash(timed_words: Sequence[Dict]) -> str:
    normalized = [
        {
            "start": round(_number(word.get("start")), 4),
            "end": round(_number(word.get("end")), 4),
            "text": str(word.get("word") or word.get("text") or ""),
        }
        for word in timed_words
        if isinstance(word, dict)
    ]
    return hashlib.sha256(
        json.dumps(
            normalized,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
    ).hexdigest()


def hook_gate_v3_cache_key(
    candidate: Dict,
    timed_words: Sequence[Dict],
    transcript_hash: Optional[str] = None,
    policy: Optional[Dict] = None,
) -> str:
    transcript_identity = (
        str(transcript_hash or "").strip().lower()
        or transcript_word_timing_hash(timed_words)
    )
    identity = {
        "transcriptHash": transcript_identity,
        "policyVersion": BF_FEED_STOP_POLICY_VERSION,
        "policyContract": {
            key: value
            for key, value in {**DEFAULT_POLICY, **(policy or {})}.items()
            if key != "production_approval"
        },
        "gateVersion": HOOK_GATE_V3_VERSION,
        "interval": [
            _number(candidate.get("speech_start_time", candidate.get("start_time"))),
            _number(candidate.get("speech_end_time", candidate.get("end_time"))),
        ],
        "renderStart": _number(
            candidate.get("render_start_time", candidate.get("start_time"))
        ),
        "semanticEvidence": {
            key: candidate.get(key)
            for key in (
                "has_complete_ending",
                "has_takeaway",
                "hook_payoff_phrase",
                "contains_host_setup",
                "contains_attribution_lead_in",
                "requires_previous_context",
                "contains_context_callback",
                "second_topic_begins_after_takeaway",
                "repeated_setup_before_mechanism",
                "quotability_score",
                "hook_gate_review_reason",
                "new_viewer_understands_opening",
            )
        },
    }
    return hashlib.sha256(
        json.dumps(
            identity,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
    ).hexdigest()


def evaluate_hook_gate_v3_cached(
    candidate: Dict,
    timed_words: Sequence[Dict],
    policy: Optional[Dict] = None,
    *,
    transcript_hash: Optional[str] = None,
    cache_dir: Optional[str] = None,
) -> Dict:
    """Evaluate with an in-memory/disk cache keyed by transcript and policy."""
    timing_identity = (
        str(transcript_hash or "").strip().lower()
        or transcript_word_timing_hash(timed_words)
    )
    key = hook_gate_v3_cache_key(
        candidate,
        timed_words,
        timing_identity,
        policy,
    )
    cached = _MEMORY_CACHE.get(key)
    if cached is not None:
        return {
            **candidate,
            **{
                field: value
                for field, value in cached.items()
                if field in _MEASUREMENT_FIELDS
                or field.startswith("hook_gate_")
            },
            "hook_gate_v3_cache_hit": True,
        }
    path = Path(cache_dir) / "hook-gate-v3" / f"{key}.json" if cache_dir else None
    if path is not None and path.is_file():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError):
            payload = None
        if isinstance(payload, dict) and payload.get("hookGateVersion") == HOOK_GATE_V3_VERSION:
            _MEMORY_CACHE[key] = dict(payload)
            return {
                **candidate,
                **{
                    field: value
                    for field, value in payload.items()
                    if field in _MEASUREMENT_FIELDS
                    or field.startswith("hook_gate_")
                },
                "hook_gate_v3_cache_hit": True,
            }

    normalized_words = _NORMALIZED_TIMING_CACHE.get(timing_identity)
    if normalized_words is None:
        normalized_words = _normalize_words(timed_words)
        if len(_NORMALIZED_TIMING_CACHE) >= _NORMALIZED_TIMING_CACHE_LIMIT:
            _NORMALIZED_TIMING_CACHE.pop(next(iter(_NORMALIZED_TIMING_CACHE)))
        _NORMALIZED_TIMING_CACHE[timing_identity] = normalized_words
    result = evaluate_hook_gate_v3(
        candidate,
        normalized_words,
        policy,
        _words_are_normalized=True,
    )
    result["hook_gate_v3_cache_key"] = key
    result["hook_gate_v3_cache_hit"] = False
    if len(_MEMORY_CACHE) >= _MEMORY_CACHE_LIMIT:
        _MEMORY_CACHE.pop(next(iter(_MEMORY_CACHE)))
    _MEMORY_CACHE[key] = dict(result)
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
    return result


__all__ = [
    "BF_FEED_STOP_POLICY_VERSION",
    "DEFAULT_POLICY",
    "HOOK_GATE_V3_DECISION_VERSION",
    "HOOK_GATE_V3_PROMPT",
    "HOOK_GATE_V3_PROMPT_VERSION",
    "HOOK_GATE_V3_RESPONSE_CONTRACT",
    "HOOK_GATE_V3_SCHEMA_VERSION",
    "HOOK_GATE_V3_VERSION",
    "build_hook_gate_v3_report",
    "evaluate_hook_gate_v3",
    "evaluate_hook_gate_v3_cached",
    "hook_gate_v3_cache_key",
    "transcript_word_timing_hash",
]
