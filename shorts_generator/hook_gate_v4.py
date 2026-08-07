"""Whole-claim and whole-point HookGate V4 evaluation.

V3 deliberately measured early lexical anchors.  That made its timings easy to
audit, but it also made ordinary, semantically forceful language depend on a
small vocabulary.  V4 keeps the auditable source boundaries while moving the
decision unit to the complete opening proposition and its relationship to the
complete point/payoff.

This module is pure.  It does not call an LLM, decode audio, mutate speech, or
render media.  Semantic observations are supplied on the candidate, exact
quotes are independently aligned to source-timed words, and Python applies the
versioned policy fail-closed.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .hook_gate_v4_report import (
    HOOK_GATE_V4_DECISION_VERSION,
    HOOK_GATE_V4_PROMPT_VERSION,
    HOOK_GATE_V4_REPORT_SCHEMA_VERSION,
    HOOK_GATE_V4_VERSION,
    build_hook_gate_v4_report,
    verify_hook_gate_v4_report,
)


HOOK_GATE_V4_SCHEMA_VERSION = HOOK_GATE_V4_REPORT_SCHEMA_VERSION
BF_FEED_STOP_V2_POLICY_VERSION = "bf_feed_stop_v2"

HOOK_GATE_V4_RESPONSE_CONTRACT = """HOOK GATE V4 AUTHORITATIVE FINAL RESPONSE EXTENSION:
- Judge the complete first independent proposition, not a fixed first-word
  window, and then judge that proposition against the complete selected point.
- Return opening_unit_exact_quote and topic_comprehension_exact_quote as exact
  source prefixes. Return payoff_exact_quote as an exact source-contiguous
  suffix ending on the selected interval's final spoken token.
- Return all HookGate V4 semantic scores and flags. Never rewrite, paraphrase,
  stitch, reorder, or delete spoken words in an exact-quote field.
- Isolated trigger words are not evidence. Judge what the sentence means, what
  it is about, whether a new viewer understands it, whether the delivery is
  decisive in language, and whether the full point resolves the opening.
- Required fields: opening_unit_exact_quote,
  topic_comprehension_exact_quote, payoff_exact_quote, opening_unit_type,
  hook_mechanism, hook_semantic_topic, opening_claim_summary,
  whole_point_summary, opening_sentence_clarity_score,
  topic_explicitness_score, standalone_comprehension_score,
  tension_or_relevance_score, opening_point_coherence_score,
  payoff_resolution_score, single_idea_focus_score,
  lexical_delivery_strength_score, hook_semantic_confidence_score,
  opening_unit_is_complete_claim, requires_external_context,
  unresolved_deictic_reference, host_or_attribution_setup, topic_intro_only,
  payoff_changes_topic, and hook_semantic_reason_codes.
"""

HOOK_GATE_V4_PROMPT = """HookGate V4 / bf_feed_stop_v2:
1. Read the complete selected speech interval.
2. Identify the complete first independent claim/rule/tension proposition.
   It may be longer than eight words; do not reward or reject vocabulary in
   isolation. The preferred proposition lands within 3.5 seconds and the hard
   maximum is 5.0 seconds.
3. Judge the opening's meaning: a new viewer must know what is being discussed,
   understand the claim without previous dialogue, and hear a specific tension,
   rule, contradiction, stake, or consequence.
4. Judge the whole context: the development must stay on one idea and the exact
   final payoff must resolve or sharpen the opening rather than switch topics.
5. Reject host setup, attribution, external antecedents, deictic callbacks,
   topic-only introductions, generic hype, hedged/uncertain delivery, and
   incomplete or unrelated payoffs.
6. Never manufacture a hook by changing authentic source speech.
"""

DEFAULT_POLICY: Dict[str, object] = {
    "policy_version": BF_FEED_STOP_V2_POLICY_VERSION,
    "require_canonical_semantic_fields": True,
    "minimum_score": 78.0,
    "first_word_max_latency_ms": 100.0,
    "opening_unit_preferred_max_seconds": 3.5,
    "opening_unit_hard_max_seconds": 5.0,
    "topic_comprehension_max_seconds": 3.5,
    "opening_sentence_clarity_min": 70.0,
    "topic_explicitness_min": 65.0,
    "standalone_comprehension_min": 70.0,
    "tension_or_relevance_min": 65.0,
    "opening_point_coherence_min": 72.0,
    "payoff_resolution_min": 70.0,
    "single_idea_focus_min": 75.0,
    "lexical_delivery_strength_min": 55.0,
    "lexical_delivery_review_min": 65.0,
    "semantic_confidence_min": 75.0,
    "generic_motivation_max": 35.0,
    "preferred_min_seconds": 12.0,
    "preferred_max_seconds": 17.0,
    "complete_payoff_max_seconds": 21.0,
    "hard_max_seconds": 24.0,
}

_TOKEN_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?", re.IGNORECASE)
_INCOMPLETE_FINAL_WORDS = frozenset(
    {
        "although", "and", "because", "but", "if", "or", "so", "then",
        "though", "unless", "until", "when", "whereas", "which", "while",
        "yet",
    }
)
_OPENING_UNIT_TYPES = frozenset(
    {
        "claim",
        "rule",
        "contradiction",
        "tension",
        "question_with_immediate_answer",
        "story_setup",
        "topic_intro",
        "fragment",
    }
)
_HOOK_MECHANISMS = frozenset(
    {
        "contradiction",
        "concrete_rule",
        "identity_threat",
        "interpersonal_conflict",
        "surprising_consequence",
        "emotional_comparison",
        "visual_metaphor",
        "common_belief_challenge",
        "none",
    }
)
_REASON_CODES = frozenset(
    {
        "clear_complete_claim",
        "topic_explicit_by_opening_end",
        "standalone_without_prior_context",
        "strong_relatable_tension",
        "specific_rule_or_consequence",
        "opening_and_payoff_coherent",
        "payoff_resolves_opening",
        "single_focused_idea",
        "opening_fragment",
        "topic_unclear",
        "requires_prior_context",
        "unresolved_reference",
        "host_or_attribution_setup",
        "topic_intro_without_claim",
        "weak_or_generic_tension",
        "payoff_unresolved",
        "payoff_topic_shift",
        "multiple_ideas",
        "uncertain_or_hedged_delivery",
    }
)

_MEMORY_CACHE: Dict[str, Dict] = {}
_MEMORY_CACHE_LIMIT = 1024
_WORD_BOUNDARY_TOLERANCE_SECONDS = 0.01

# Every raw candidate field that can change ``evaluate_hook_gate_v4`` belongs
# in this snapshot.  Keeping one explicit list prevents a newly-added
# fail-closed input from accidentally sharing a cache entry with an older
# decision.  Report-only context is bound separately in the cache identity.
_HOOK_GATE_V4_EVALUATION_INPUT_KEYS = (
    "speech_start_time",
    "speech_end_time",
    "start_time",
    "end_time",
    "render_start_time",
    "opening_unit_exact_quote",
    "hook_sentence",
    "opening_exact_quote",
    "topic_comprehension_exact_quote",
    "payoff_exact_quote",
    "earliest_complete_takeaway_sentence",
    "final_takeaway_sentence",
    "hook_payoff_phrase",
    "opening_unit_type",
    "hook_mechanism",
    "hook_semantic_topic",
    "opening_claim_summary",
    "whole_point_summary",
    "opening_sentence_clarity_score",
    "topic_explicitness_score",
    "standalone_comprehension_score",
    "tension_or_relevance_score",
    "opening_point_coherence_score",
    "payoff_resolution_score",
    "single_idea_focus_score",
    "lexical_delivery_strength_score",
    "hook_semantic_confidence_score",
    "opening_unit_is_complete_claim",
    "requires_external_context",
    "unresolved_deictic_reference",
    "host_or_attribution_setup",
    "topic_intro_only",
    "payoff_changes_topic",
    "hook_semantic_reason_codes",
    # Explicit deterministic eligibility inputs.
    "begins_on_complete_word_boundary",
    "new_viewer_understands_opening",
    "has_complete_ending",
    "has_takeaway",
    # Conservative legacy fallbacks used by semantic normalization.
    "has_hook",
    "hook_score",
    "standalone_score",
    "semantic_tension_score",
    "conflict_score",
    "contrast_score",
    "reversal_score",
    "self_contained_micro_arc_score",
    "narrative_coherence_score",
    "listener_payoff_score",
    "takeaway_score",
    "closure_score",
    "emotional_conviction_score",
    "context_dependence_score",
    "generic_motivation_score",
    "second_topic_begins_after_takeaway",
    "requires_previous_context",
    "contains_context_callback",
    "contains_host_setup",
    "contains_attribution_lead_in",
    "hook_type",
    "hook_family",
    "hookFamily",
    "topic",
    "thesis",
    "listener_payoff",
)


def _number(value: object, default: Optional[float] = 0.0) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _bool(value: object, default: Optional[bool] = False) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes"}:
            return True
        if normalized in {"false", "0", "no"}:
            return False
    if isinstance(value, (int, float)) and value in {0, 1}:
        return bool(value)
    return default


def _tokens(value: object) -> List[str]:
    return _TOKEN_RE.findall(
        str(value or "")
        .lower()
        .replace("’", "'")
        .replace("‘", "'")
        .replace("`", "'")
    )


def _unique(values: Iterable[str]) -> List[str]:
    return list(dict.fromkeys(value for value in values if value))


def _round_score(value: float) -> float:
    return round(max(0.0, min(100.0, value)), 3)


def _normalize_words(timed_words: Sequence[Dict]) -> List[Dict]:
    normalized: List[Dict] = []
    source_index = 0
    for raw in timed_words:
        if not isinstance(raw, dict):
            continue
        start = _number(raw.get("start"), -1.0)
        end = _number(raw.get("end"), -1.0)
        text = str(raw.get("word") or raw.get("text") or "").strip()
        if start is None or end is None or start < 0.0 or end <= start:
            continue
        word_tokens = _tokens(text)
        if not word_tokens:
            continue
        for token in word_tokens:
            normalized.append(
                {
                    "token": token,
                    "text": text,
                    "start": float(start),
                    "end": float(end),
                    "sourceIndex": source_index,
                }
            )
        source_index += 1
    return normalized


def _candidate_words(candidate: Mapping[str, object], timed_words: Sequence[Dict]) -> List[Dict]:
    speech_start = _number(
        candidate.get("speech_start_time", candidate.get("start_time")),
        -1.0,
    )
    speech_end = _number(
        candidate.get("speech_end_time", candidate.get("end_time")),
        -1.0,
    )
    if speech_start is None or speech_end is None:
        return []
    tolerance = _WORD_BOUNDARY_TOLERANCE_SECONDS
    return [
        word
        for word in _normalize_words(timed_words)
        # A word is evidence only when the selected speech interval contains
        # it completely.  Overlap matching allowed a clip beginning or ending
        # mid-phoneme to hide the cut behind an otherwise aligned quote.
        if word["start"] >= speech_start - tolerance
        and word["end"] <= speech_end + tolerance
    ]


def _phrase_span(
    words: Sequence[Dict],
    phrase: object,
    *,
    prefer_suffix: bool = False,
) -> Optional[Tuple[int, int]]:
    phrase_tokens = _tokens(phrase)
    if not phrase_tokens or len(phrase_tokens) > len(words):
        return None
    matches: List[Tuple[int, int]] = []
    for index in range(len(words) - len(phrase_tokens) + 1):
        if [
            str(word["token"])
            for word in words[index : index + len(phrase_tokens)]
        ] == phrase_tokens:
            matches.append((index, index + len(phrase_tokens) - 1))
    if not matches:
        return None
    return matches[-1] if prefer_suffix else matches[0]


def _span_fields(
    words: Sequence[Dict],
    quote: str,
    span: Optional[Tuple[int, int]],
    prefix: str,
) -> Dict:
    if span is None:
        return {
            f"{prefix}ExactQuote": quote,
            f"{prefix}StartSeconds": None,
            f"{prefix}EndSeconds": None,
            f"{prefix}StartTokenIndex": None,
            f"{prefix}EndTokenIndex": None,
            f"{prefix}ExactAligned": False,
        }
    first, last = span
    return {
        f"{prefix}ExactQuote": quote,
        f"{prefix}StartSeconds": round(float(words[first]["start"]), 3),
        f"{prefix}EndSeconds": round(float(words[last]["end"]), 3),
        f"{prefix}StartTokenIndex": first,
        f"{prefix}EndTokenIndex": last,
        f"{prefix}ExactAligned": True,
    }


def _quote(candidate: Mapping[str, object], *names: str) -> str:
    for name in names:
        value = str(candidate.get(name) or "").strip()
        if value:
            return value
    return ""


def _score_value(candidate: Mapping[str, object], *names: str) -> Optional[float]:
    for name in names:
        if candidate.get(name) is not None:
            value = _number(candidate.get(name), None)
            if value is not None:
                return _round_score(value)
    return None


def _minimum_available(*values: Optional[float]) -> Optional[float]:
    available = [float(value) for value in values if value is not None]
    return min(available) if available else None


def _maximum_available(*values: Optional[float]) -> Optional[float]:
    available = [float(value) for value in values if value is not None]
    return max(available) if available else None


def _semantic_fields(candidate: Mapping[str, object]) -> Dict:
    """Normalize canonical V4 fields with conservative legacy fallbacks."""

    opening_clarity = _score_value(
        candidate,
        "opening_sentence_clarity_score",
        "hook_score",
    )
    topic_explicitness = _score_value(
        candidate,
        "topic_explicitness_score",
        "standalone_score",
    )
    standalone = _score_value(
        candidate,
        "standalone_comprehension_score",
        "standalone_score",
    )
    tension = _score_value(candidate, "tension_or_relevance_score")
    if tension is None:
        tension = _maximum_available(
            _score_value(candidate, "semantic_tension_score"),
            _score_value(candidate, "conflict_score"),
            _score_value(candidate, "contrast_score"),
            _score_value(candidate, "reversal_score"),
        )
    coherence = _score_value(
        candidate,
        "opening_point_coherence_score",
        "self_contained_micro_arc_score",
        "narrative_coherence_score",
    )
    payoff = _score_value(candidate, "payoff_resolution_score")
    if payoff is None:
        payoff = _minimum_available(
            _score_value(candidate, "listener_payoff_score"),
            _score_value(candidate, "takeaway_score"),
            _score_value(candidate, "closure_score"),
        )
    single_idea = _score_value(candidate, "single_idea_focus_score")
    if single_idea is None and candidate.get("second_topic_begins_after_takeaway") is False:
        single_idea = _score_value(
            candidate,
            "self_contained_micro_arc_score",
            "narrative_coherence_score",
        )
    delivery = _score_value(
        candidate,
        "lexical_delivery_strength_score",
        "emotional_conviction_score",
    )
    confidence = _score_value(candidate, "hook_semantic_confidence_score")
    core_scores = [
        opening_clarity,
        topic_explicitness,
        standalone,
        tension,
        coherence,
        payoff,
        single_idea,
        delivery,
    ]
    if confidence is None and all(value is not None for value in core_scores):
        # Legacy candidates did not expose provider confidence. Their complete
        # score vector is still explicit evidence; the minimum score is a
        # conservative deterministic confidence proxy, never an implicit pass.
        confidence = min(float(value) for value in core_scores if value is not None)

    context_dependence = _score_value(candidate, "context_dependence_score")
    context_efficiency = (
        _round_score(100.0 - context_dependence)
        if context_dependence is not None
        else None
    )
    generic_motivation = _score_value(candidate, "generic_motivation_score")

    canonical_string_names = {
        "opening_unit_exact_quote",
        "topic_comprehension_exact_quote",
        "payoff_exact_quote",
        "opening_unit_type",
        "hook_mechanism",
        "hook_semantic_topic",
        "opening_claim_summary",
        "whole_point_summary",
    }
    canonical_names = canonical_string_names | {
        "opening_sentence_clarity_score",
        "topic_explicitness_score",
        "standalone_comprehension_score",
        "tension_or_relevance_score",
        "opening_point_coherence_score",
        "payoff_resolution_score",
        "single_idea_focus_score",
        "lexical_delivery_strength_score",
        "hook_semantic_confidence_score",
        "opening_unit_is_complete_claim",
        "requires_external_context",
        "unresolved_deictic_reference",
        "host_or_attribution_setup",
        "topic_intro_only",
        "payoff_changes_topic",
        "hook_semantic_reason_codes",
    }
    canonical_complete = all(
        candidate.get(name) is not None
        and (
            name not in canonical_string_names
            or bool(str(candidate.get(name) or "").strip())
        )
        for name in canonical_names
    )

    flags = {
        "openingUnitIsCompleteClaim": bool(
            _bool(
                candidate.get("opening_unit_is_complete_claim"),
                _bool(candidate.get("has_hook"), False),
            )
        ),
        "requiresExternalContext": bool(
            _bool(
                candidate.get("requires_external_context"),
                _bool(candidate.get("requires_previous_context"), False),
            )
        ),
        "unresolvedDeicticReference": bool(
            _bool(
                candidate.get("unresolved_deictic_reference"),
                _bool(candidate.get("contains_context_callback"), False),
            )
        ),
        "hostOrAttributionSetup": bool(
            _bool(
                candidate.get("host_or_attribution_setup"),
                bool(
                    _bool(candidate.get("contains_host_setup"), False)
                    or _bool(candidate.get("contains_attribution_lead_in"), False)
                ),
            )
        ),
        "topicIntroOnly": bool(
            _bool(candidate.get("topic_intro_only"), False)
        ),
        "payoffChangesTopic": bool(
            _bool(
                candidate.get("payoff_changes_topic"),
                _bool(candidate.get("second_topic_begins_after_takeaway"), False),
            )
        ),
    }
    scores = {
        "openingSentenceClarity": opening_clarity,
        "topicExplicitness": topic_explicitness,
        "standaloneComprehension": standalone,
        "tensionOrRelevance": tension,
        "openingPointCoherence": coherence,
        "payoffResolution": payoff,
        "singleIdeaFocus": single_idea,
        "lexicalDeliveryStrength": delivery,
        "semanticConfidence": confidence,
        "contextEfficiency": context_efficiency,
        "genericMotivation": generic_motivation,
    }
    return {
        "scores": scores,
        "flags": flags,
        "canonicalComplete": canonical_complete,
        "evidenceSource": (
            "hook_gate_v4_semantic_fields"
            if canonical_complete
            else "legacy_candidate_semantic_fields"
        ),
    }


def _semantic_text(candidate: Mapping[str, object]) -> Dict:
    opening_type = str(candidate.get("opening_unit_type") or "").strip().lower()
    if not opening_type:
        hook_type = str(candidate.get("hook_type") or "").strip().lower()
        opening_type = hook_type if hook_type in _OPENING_UNIT_TYPES else "claim"
    mechanism = str(
        candidate.get("hook_mechanism")
        or candidate.get("hook_family")
        or candidate.get("hookFamily")
        or candidate.get("hook_type")
        or "none"
    ).strip().lower()
    if mechanism not in _HOOK_MECHANISMS:
        mechanism = "none"
    raw_reasons = candidate.get("hook_semantic_reason_codes")
    reasons = (
        [str(value).strip() for value in raw_reasons]
        if isinstance(raw_reasons, list)
        else []
    )
    reasons = _unique(reason for reason in reasons if reason in _REASON_CODES)
    return {
        "openingUnitType": opening_type,
        "hookMechanism": mechanism,
        "hookSemanticTopic": str(
            candidate.get("hook_semantic_topic")
            or candidate.get("topic")
            or ""
        ).strip(),
        "openingClaimSummary": str(
            candidate.get("opening_claim_summary")
            or candidate.get("thesis")
            or ""
        ).strip(),
        "wholePointSummary": str(
            candidate.get("whole_point_summary")
            or candidate.get("thesis")
            or candidate.get("listener_payoff")
            or ""
        ).strip(),
        "hookSemanticReasonCodes": reasons,
    }


def _score(scores: Mapping[str, Optional[float]]) -> Tuple[float, Dict]:
    context = scores.get("contextEfficiency")
    topic = scores.get("topicExplicitness")
    topic_context = (
        (float(topic) + float(context)) / 2.0
        if topic is not None and context is not None
        else float(topic or context or 0.0)
    )
    components = {
        "openingSentenceClarity": float(scores.get("openingSentenceClarity") or 0.0),
        "topicAndContextExplicitness": topic_context,
        "tensionOrRelevance": float(scores.get("tensionOrRelevance") or 0.0),
        "openingPointCoherence": float(scores.get("openingPointCoherence") or 0.0),
        "payoffResolution": float(scores.get("payoffResolution") or 0.0),
        "singleIdeaFocus": float(scores.get("singleIdeaFocus") or 0.0),
        "standaloneComprehension": float(scores.get("standaloneComprehension") or 0.0),
        "lexicalDeliveryStrength": float(scores.get("lexicalDeliveryStrength") or 0.0),
    }
    # Standalone understanding is folded into the clarity share, keeping the
    # contract at 100% while still exposing both independent hard floors.
    combined_opening = (
        0.55 * components["openingSentenceClarity"]
        + 0.45 * components["standaloneComprehension"]
    )
    weighted = {
        "openingMeaning": (combined_opening, 0.16),
        "topicAndContextExplicitness": (topic_context, 0.14),
        "tensionOrRelevance": (components["tensionOrRelevance"], 0.12),
        "openingPointCoherence": (components["openingPointCoherence"], 0.18),
        "payoffResolution": (components["payoffResolution"], 0.14),
        "singleIdeaFocus": (components["singleIdeaFocus"], 0.08),
        # The remaining semantic clarity share is represented explicitly here;
        # a future acoustic report can replace/augment it without changing the
        # exact-quote contract.
        "deliveryClarityProxy": (components["standaloneComprehension"], 0.10),
        "lexicalDeliveryStrength": (components["lexicalDeliveryStrength"], 0.08),
    }
    total = sum(value * weight for value, weight in weighted.values())
    public_components = {
        **{key: _round_score(value) for key, value in components.items()},
        "openingMeaning": _round_score(combined_opening),
    }
    return _round_score(total), public_components


def evaluate_hook_gate_v4(
    candidate: Dict,
    timed_words: Sequence[Dict],
    policy: Optional[Dict] = None,
) -> Dict:
    """Evaluate full opening meaning and whole-point coherence fail-closed."""

    item = dict(candidate)
    active_policy = {**DEFAULT_POLICY, **(policy or {})}
    words = _candidate_words(item, timed_words)
    measured_speech_start = _number(
        item.get("speech_start_time", item.get("start_time")),
        -1.0,
    )
    measured_speech_end = _number(
        item.get("speech_end_time", item.get("end_time")),
        -1.0,
    )
    speech_start = float(
        measured_speech_start if measured_speech_start is not None else -1.0
    )
    speech_end = float(
        measured_speech_end if measured_speech_end is not None else -1.0
    )
    measured_render_start = _number(
        item.get("render_start_time", item.get("start_time")),
        speech_start,
    )
    render_start = float(
        measured_render_start
        if measured_render_start is not None
        else speech_start
    )
    duration = max(0.0, speech_end - speech_start)

    opening_quote = _quote(
        item,
        "opening_unit_exact_quote",
        "hook_sentence",
        "opening_exact_quote",
    )
    topic_quote = _quote(item, "topic_comprehension_exact_quote") or opening_quote
    payoff_quote = _quote(
        item,
        "payoff_exact_quote",
        "earliest_complete_takeaway_sentence",
        "final_takeaway_sentence",
        "hook_payoff_phrase",
    )
    opening_span = _phrase_span(words, opening_quote)
    topic_span = _phrase_span(words, topic_quote)
    payoff_span = _phrase_span(words, payoff_quote, prefer_suffix=True)

    span_fields: Dict[str, object] = {}
    span_fields.update(_span_fields(words, opening_quote, opening_span, "openingUnit"))
    span_fields.update(_span_fields(words, topic_quote, topic_span, "topicComprehension"))
    span_fields.update(_span_fields(words, payoff_quote, payoff_span, "payoff"))

    first_word = words[0] if words else None
    speech_origin = float(first_word["start"]) if first_word else speech_start
    first_word_latency = (
        round(max(0.0, float(first_word["start"]) - render_start) * 1000.0, 1)
        if first_word is not None
        else None
    )
    opening_duration = (
        round(float(words[opening_span[1]]["end"]) - speech_origin, 3)
        if opening_span is not None
        else None
    )
    topic_latency = (
        round(float(words[topic_span[1]]["end"]) - speech_origin, 3)
        if topic_span is not None
        else None
    )
    payoff_start = (
        round(float(words[payoff_span[0]]["start"]) - speech_origin, 3)
        if payoff_span is not None
        else None
    )
    payoff_end = (
        round(float(words[payoff_span[1]]["end"]) - speech_origin, 3)
        if payoff_span is not None
        else None
    )

    semantic = _semantic_fields(item)
    semantic_text = _semantic_text(item)
    scores = semantic["scores"]
    flags = semantic["flags"]
    score, score_components = _score(scores)
    rejects: List[str] = []
    reviews: List[str] = []
    penalties: List[Dict] = []

    if (
        bool(active_policy.get("require_canonical_semantic_fields", True))
        and not semantic["canonicalComplete"]
    ):
        rejects.append("hook_v4_semantic_evidence_incomplete")
    raw_opening_type = str(item.get("opening_unit_type") or "").strip().lower()
    if raw_opening_type not in _OPENING_UNIT_TYPES:
        rejects.append("hook_v4_opening_unit_type_invalid")
    raw_mechanism = str(item.get("hook_mechanism") or "").strip().lower()
    if raw_mechanism not in _HOOK_MECHANISMS:
        rejects.append("hook_v4_hook_mechanism_invalid")
    raw_reason_codes = item.get("hook_semantic_reason_codes")
    if isinstance(raw_reason_codes, list):
        normalized_raw_reasons = [str(value).strip() for value in raw_reason_codes]
        if (
            not normalized_raw_reasons
            or len(normalized_raw_reasons) > 8
            or any(reason not in _REASON_CODES for reason in normalized_raw_reasons)
        ):
            rejects.append("hook_v4_semantic_reason_codes_invalid")
    elif bool(active_policy.get("require_canonical_semantic_fields", True)):
        rejects.append("hook_v4_semantic_reason_codes_invalid")
    for field_name, reason in (
        ("hook_semantic_topic", "hook_v4_semantic_topic_missing"),
        ("opening_claim_summary", "hook_v4_opening_claim_summary_missing"),
        ("whole_point_summary", "hook_v4_whole_point_summary_missing"),
    ):
        if (
            bool(active_policy.get("require_canonical_semantic_fields", True))
            and not str(item.get(field_name) or "").strip()
        ):
            rejects.append(reason)

    if speech_start < 0.0 or speech_end <= speech_start:
        rejects.append("hook_v4_invalid_speech_interval")
    if not words:
        rejects.append("hook_v4_source_words_missing")
    if first_word_latency is None:
        rejects.append("hook_v4_word_timing_missing")
    elif first_word_latency > float(active_policy["first_word_max_latency_ms"]):
        rejects.append("hook_v4_first_word_after_100ms")
    starts_on_word_boundary = bool(
        first_word is not None
        and abs(float(first_word["start"]) - speech_start)
        <= _WORD_BOUNDARY_TOLERANCE_SECONDS
    )
    last_word = words[-1] if words else None
    ends_on_word_boundary = bool(
        last_word is not None
        and abs(float(last_word["end"]) - speech_end)
        <= _WORD_BOUNDARY_TOLERANCE_SECONDS
    )
    if first_word is not None and not starts_on_word_boundary:
        rejects.append("hook_v4_opening_not_on_word_boundary")
        rejects.append("hook_v4_opening_cuts_word")
    if last_word is not None and not ends_on_word_boundary:
        rejects.append("hook_v4_ending_not_on_word_boundary")
        rejects.append("hook_v4_ending_cuts_word")
    if first_word is not None and render_start > float(first_word["start"]) + 0.01:
        rejects.append("hook_v4_render_starts_inside_first_word")
    if item.get("begins_on_complete_word_boundary") is False:
        rejects.append("hook_v4_opening_cuts_word")

    if not opening_quote:
        rejects.append("hook_v4_opening_unit_quote_missing")
    elif opening_span is None:
        rejects.append("hook_v4_opening_unit_quote_unaligned")
    elif opening_span[0] != 0:
        rejects.append("hook_v4_opening_unit_not_prefix")
    if not topic_quote:
        rejects.append("hook_v4_topic_comprehension_quote_missing")
    elif topic_span is None:
        rejects.append("hook_v4_topic_comprehension_quote_unaligned")
    elif topic_span[0] != 0:
        rejects.append("hook_v4_topic_comprehension_not_prefix")
    elif opening_span is not None and topic_span[1] < opening_span[1]:
        rejects.append("hook_v4_topic_comprehension_before_opening_unit_end")
    if not payoff_quote:
        rejects.append("hook_v4_payoff_quote_missing")
    elif payoff_span is None:
        rejects.append("hook_v4_payoff_quote_unaligned")
    elif payoff_span[1] != len(words) - 1:
        rejects.append("hook_v4_payoff_not_at_speech_end")

    if opening_duration is not None:
        if opening_duration > float(active_policy["opening_unit_hard_max_seconds"]):
            rejects.append("hook_v4_opening_unit_after_5s")
        elif opening_duration > float(
            active_policy["opening_unit_preferred_max_seconds"]
        ):
            reviews.append("hook_v4_opening_unit_3_5_to_5s_review")
            penalties.append(
                {
                    "reason": "opening_unit_after_preferred_window",
                    "points": round(2.0 * (opening_duration - 3.5), 3),
                }
            )
    if topic_latency is not None and topic_latency > float(
        active_policy["topic_comprehension_max_seconds"]
    ):
        rejects.append("hook_v4_topic_comprehension_after_3_5s")

    if not flags["openingUnitIsCompleteClaim"]:
        rejects.append("hook_v4_opening_unit_incomplete")
    if flags["requiresExternalContext"]:
        rejects.append("hook_v4_requires_external_context")
    if flags["unresolvedDeicticReference"]:
        rejects.append("hook_v4_unresolved_reference")
    if flags["hostOrAttributionSetup"]:
        rejects.append("hook_v4_host_or_attribution_setup")
    if flags["topicIntroOnly"] or semantic_text["openingUnitType"] in {
        "topic_intro",
        "fragment",
    }:
        rejects.append("hook_v4_topic_intro_or_fragment")
    if flags["payoffChangesTopic"]:
        rejects.append("hook_v4_payoff_topic_shift")
    if item.get("new_viewer_understands_opening") is False:
        rejects.append("hook_v4_new_viewer_cannot_understand_opening")
    if item.get("has_complete_ending") is not True:
        rejects.append("hook_v4_incomplete_ending")
    if item.get("has_takeaway") is not True:
        rejects.append("hook_v4_takeaway_missing")
    if words and str(words[-1]["token"]) in _INCOMPLETE_FINAL_WORDS:
        rejects.append("hook_v4_incomplete_ending_connector")

    required_scores = {
        "openingSentenceClarity": (
            "opening_sentence_clarity_min",
            "hook_v4_opening_sentence_unclear",
        ),
        "topicExplicitness": (
            "topic_explicitness_min",
            "hook_v4_topic_unclear",
        ),
        "standaloneComprehension": (
            "standalone_comprehension_min",
            "hook_v4_not_standalone",
        ),
        "tensionOrRelevance": (
            "tension_or_relevance_min",
            "hook_v4_weak_tension_or_relevance",
        ),
        "openingPointCoherence": (
            "opening_point_coherence_min",
            "hook_v4_opening_point_incoherent",
        ),
        "payoffResolution": (
            "payoff_resolution_min",
            "hook_v4_payoff_unresolved",
        ),
        "singleIdeaFocus": (
            "single_idea_focus_min",
            "hook_v4_multiple_or_unfocused_ideas",
        ),
        "semanticConfidence": (
            "semantic_confidence_min",
            "hook_v4_semantic_confidence_low",
        ),
    }
    for score_name, (policy_name, reason) in required_scores.items():
        value = scores.get(score_name)
        if value is None:
            rejects.append(f"hook_v4_{score_name}_evidence_missing")
        elif float(value) < float(active_policy[policy_name]):
            rejects.append(reason)

    delivery = scores.get("lexicalDeliveryStrength")
    if delivery is None:
        rejects.append("hook_v4_lexical_delivery_evidence_missing")
    elif float(delivery) < float(active_policy["lexical_delivery_strength_min"]):
        rejects.append("hook_v4_lexical_delivery_too_weak")
    elif float(delivery) < float(active_policy["lexical_delivery_review_min"]):
        reviews.append("hook_v4_lexical_delivery_strength_review")

    generic = scores.get("genericMotivation")
    if generic is not None and float(generic) > float(
        active_policy["generic_motivation_max"]
    ):
        rejects.append("hook_v4_generic_motivation")
    if score < float(active_policy["minimum_score"]):
        rejects.append("hook_v4_score_below_78")

    if duration > float(active_policy["hard_max_seconds"]):
        rejects.append("hook_v4_duration_over_24s")
    elif duration > float(active_policy["complete_payoff_max_seconds"]):
        reviews.append("hook_v4_duration_21_to_24s_review")
    elif duration > float(active_policy["preferred_max_seconds"]):
        reviews.append("hook_v4_duration_17_to_21s_complete_payoff")
    elif duration < float(active_policy["preferred_min_seconds"]):
        reviews.append("hook_v4_duration_under_preferred_12s")

    rejects = _unique(rejects)
    reviews = _unique(reviews)
    status = "reject" if rejects else ("review" if reviews else "pass")
    eligible = status == "pass"
    thresholds = {
        key: value for key, value in active_policy.items() if key != "production_approval"
    }
    item.update(
        {
            "speechStart": speech_start,
            "speechEnd": speech_end,
            "speechDuration": round(duration, 3),
            "firstWordLatencyMs": first_word_latency,
            "startsOnCompleteWordBoundary": starts_on_word_boundary,
            "endsOnCompleteWordBoundary": ends_on_word_boundary,
            **span_fields,
            "openingUnitDurationSeconds": opening_duration,
            "topicComprehensionLatencySeconds": topic_latency,
            "payoffStartSeconds": payoff_start,
            "payoffEndSeconds": payoff_end,
            "openingUnitType": semantic_text["openingUnitType"],
            "hookMechanism": semantic_text["hookMechanism"],
            "hookSemanticTopic": semantic_text["hookSemanticTopic"],
            "openingClaimSummary": semantic_text["openingClaimSummary"],
            "wholePointSummary": semantic_text["wholePointSummary"],
            "hookSemanticReasonCodes": semantic_text["hookSemanticReasonCodes"],
            "hookSemanticScores": scores,
            "hookSemanticFlags": flags,
            "hookSemanticEvidenceSource": semantic["evidenceSource"],
            "hookSemanticCanonicalComplete": semantic["canonicalComplete"],
            "hookGateScore": score,
            "hookGateScoreComponents": score_components,
            "hookGatePenalties": penalties,
            "hookGateThresholds": thresholds,
            "hookGateVersion": HOOK_GATE_V4_VERSION,
            "hookGatePromptVersion": HOOK_GATE_V4_PROMPT_VERSION,
            "hookGateDecisionVersion": HOOK_GATE_V4_DECISION_VERSION,
            "selectionPolicyVersion": BF_FEED_STOP_V2_POLICY_VERSION,
            "hookGateStatus": status,
            "hookGateEligible": eligible,
            "hookGateRejectionReasons": rejects,
            "hookGateReviewReasons": reviews,
            # Stable aliases for ranker/artifact integration.
            "hook_gate_score": score,
            "hook_gate_version": HOOK_GATE_V4_VERSION,
            "hook_gate_prompt_version": HOOK_GATE_V4_PROMPT_VERSION,
            "hook_gate_decision_version": HOOK_GATE_V4_DECISION_VERSION,
            "hook_gate_status": status,
            "hook_gate_eligible": eligible,
            "hook_gate_reject_reasons": rejects,
            "hook_gate_review_reasons": reviews,
            "hook_gate_deterministic_reasons": rejects + reviews,
            "hook_family": semantic_text["hookMechanism"],
        }
    )
    return item


def transcript_word_timing_hash(timed_words: Sequence[Dict]) -> str:
    normalized = [
        {
            "start": round(float(_number(word.get("start"), 0.0) or 0.0), 4),
            "end": round(float(_number(word.get("end"), 0.0) or 0.0), 4),
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


def hook_gate_v4_cache_key(
    candidate: Dict,
    timed_words: Sequence[Dict],
    *,
    transcript_hash: Optional[str] = None,
    source_hash: Optional[str] = None,
    policy: Optional[Dict] = None,
) -> str:
    active_policy = {**DEFAULT_POLICY, **(policy or {})}
    effective_source_hash = str(
        source_hash
        if source_hash is not None
        else candidate.get("sourceHash", candidate.get("source_hash", ""))
    ).strip().lower().removeprefix("sha256:")
    effective_transcript_hash = (
        str(transcript_hash or "").strip().lower().removeprefix("sha256:")
        or transcript_word_timing_hash(timed_words)
    )
    identity = {
        "gateVersion": HOOK_GATE_V4_VERSION,
        "promptVersion": HOOK_GATE_V4_PROMPT_VERSION,
        "decisionVersion": HOOK_GATE_V4_DECISION_VERSION,
        "policyVersion": BF_FEED_STOP_V2_POLICY_VERSION,
        "policy": active_policy,
        "sourceHash": effective_source_hash,
        "transcriptHash": effective_transcript_hash,
        "reportContext": {
            "renderProfile": str(candidate.get("render_profile") or ""),
            "experimentId": candidate.get("experiment_id"),
            "experimentCohort": candidate.get("experiment_cohort"),
            "changedAxes": list(candidate.get("changedAxes") or []),
        },
        "evaluationInputs": {
            key: candidate.get(key)
            for key in _HOOK_GATE_V4_EVALUATION_INPUT_KEYS
        },
    }
    return hashlib.sha256(
        json.dumps(
            identity,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    ).hexdigest()


def _effective_report_hashes(
    candidate: Mapping[str, object],
    timed_words: Sequence[Dict],
    *,
    transcript_hash: Optional[str],
    source_hash: Optional[str],
) -> Tuple[str, Optional[str]]:
    """Return the exact provenance used by both cache and sealed report."""

    effective_transcript_hash = (
        str(transcript_hash or "").strip().lower().removeprefix("sha256:")
        or transcript_word_timing_hash(timed_words)
    )
    raw_source_hash = (
        source_hash
        if source_hash is not None
        else candidate.get("sourceHash", candidate.get("source_hash"))
    )
    effective_source_hash = (
        str(raw_source_hash or "").strip().lower().removeprefix("sha256:")
        or None
    )
    return effective_transcript_hash, effective_source_hash


def _hook_gate_v4_experiment(candidate: Mapping[str, object]) -> Dict:
    return {
        "experimentId": candidate.get("experiment_id"),
        "cohortId": candidate.get("experiment_cohort"),
        "changedAxes": list(candidate.get("changedAxes") or []),
    }


def _attach_hook_gate_v4_report(
    result: Dict,
    *,
    transcript_hash: str,
    source_hash: Optional[str],
) -> Dict:
    item = dict(result)
    item["hookGateReport"] = build_hook_gate_v4_report(
        item,
        source_hash=source_hash,
        transcript_timing_hash=transcript_hash,
        render_settings=item,
        experiment=_hook_gate_v4_experiment(item),
    )
    return item


def _cached_hook_gate_v4_payload_is_valid(
    payload: object,
    *,
    transcript_hash: str,
    source_hash: Optional[str],
) -> bool:
    """Reject stale, unsealed, or decision/report-divergent cache entries."""

    if not isinstance(payload, dict):
        return False
    report = payload.get("hookGateReport")
    if not isinstance(report, dict):
        return False
    if source_hash is None and report.get("sourceHash") is not None:
        return False
    try:
        verified = verify_hook_gate_v4_report(
            report,
            source_hash=source_hash,
            transcript_timing_hash=transcript_hash,
            speech_interval=(
                payload.get("speechStart", payload.get("speech_start_time")),
                payload.get("speechEnd", payload.get("speech_end_time")),
            ),
        )
        expected = build_hook_gate_v4_report(
            payload,
            source_hash=source_hash,
            transcript_timing_hash=transcript_hash,
            render_settings=payload,
            experiment=_hook_gate_v4_experiment(payload),
        )
    except Exception:
        return False
    return verified == expected


def evaluate_hook_gate_v4_cached(
    candidate: Dict,
    timed_words: Sequence[Dict],
    policy: Optional[Dict] = None,
    *,
    transcript_hash: Optional[str] = None,
    source_hash: Optional[str] = None,
    cache_dir: Optional[str] = None,
) -> Dict:
    """Evaluate V4 and attach a verified, provenance-bound sealed report."""

    effective_transcript_hash, effective_source_hash = _effective_report_hashes(
        candidate,
        timed_words,
        transcript_hash=transcript_hash,
        source_hash=source_hash,
    )

    key = hook_gate_v4_cache_key(
        candidate,
        timed_words,
        transcript_hash=effective_transcript_hash,
        source_hash=effective_source_hash,
        policy=policy,
    )

    def fresh_result() -> Dict:
        evaluated = evaluate_hook_gate_v4(candidate, timed_words, policy)
        return _attach_hook_gate_v4_report(
            evaluated,
            transcript_hash=effective_transcript_hash,
            source_hash=effective_source_hash,
        )

    def cache_hit_result(payload: Dict) -> Optional[Dict]:
        # Never merge a previous candidate wholesale over the current one.
        # Rebuilding this inexpensive deterministic layer preserves fresh
        # caller metadata/inputs while also proving that the cached sealed
        # decision still matches the current authoritative evaluation.
        evaluated = fresh_result()
        if payload.get("hookGateReport") != evaluated.get("hookGateReport"):
            return None
        evaluated["hook_gate_v4_cache_key"] = key
        evaluated["hook_gate_v4_cache_hit"] = True
        return evaluated

    cached = _MEMORY_CACHE.get(key)
    if _cached_hook_gate_v4_payload_is_valid(
        cached,
        transcript_hash=effective_transcript_hash,
        source_hash=effective_source_hash,
    ):
        hit = cache_hit_result(copy.deepcopy(cached))
        if hit is not None:
            return hit
    if cached is not None:
        _MEMORY_CACHE.pop(key, None)
    path = Path(cache_dir) / "hook-gate-v4" / f"{key}.json" if cache_dir else None
    if path is not None and path.is_file():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError):
            payload = None
        if _cached_hook_gate_v4_payload_is_valid(
            payload,
            transcript_hash=effective_transcript_hash,
            source_hash=effective_source_hash,
        ):
            hit = cache_hit_result(payload)
            if hit is not None:
                _MEMORY_CACHE[key] = copy.deepcopy(payload)
                return hit

    result = fresh_result()
    result["hook_gate_v4_cache_key"] = key
    result["hook_gate_v4_cache_hit"] = False
    if len(_MEMORY_CACHE) >= _MEMORY_CACHE_LIMIT:
        _MEMORY_CACHE.pop(next(iter(_MEMORY_CACHE)))
    _MEMORY_CACHE[key] = copy.deepcopy(result)
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
    "BF_FEED_STOP_V2_POLICY_VERSION",
    "DEFAULT_POLICY",
    "HOOK_GATE_V4_DECISION_VERSION",
    "HOOK_GATE_V4_PROMPT",
    "HOOK_GATE_V4_PROMPT_VERSION",
    "HOOK_GATE_V4_RESPONSE_CONTRACT",
    "HOOK_GATE_V4_SCHEMA_VERSION",
    "HOOK_GATE_V4_VERSION",
    "build_hook_gate_v4_report",
    "evaluate_hook_gate_v4",
    "evaluate_hook_gate_v4_cached",
    "hook_gate_v4_cache_key",
    "transcript_word_timing_hash",
    "verify_hook_gate_v4_report",
]
