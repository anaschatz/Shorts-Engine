"""Versioned prompt contract for the first-second motivational hook gate.

HookGateV2 is intentionally embedded in the existing candidate-discovery call.
It collects structured semantic evidence without adding another LLM roundtrip.
Exact timing and publication eligibility remain deterministic Python decisions.
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional, Sequence, Tuple


HOOK_GATE_SCHEMA_VERSION = 2
HOOK_GATE_PROMPT_VERSION = "hook-gate-v2.1.0"
HOOK_GATE_DECISION_VERSION = "hook-gate-decision-v1.1.0"
HOOK_SIGNAL_MAX_LATENCY_SECONDS = 1.0
HOOK_SIGNAL_LATENCY_TOLERANCE_SECONDS = 0.05
HOOK_PAYOFF_MAX_LATENCY_SECONDS = 3.0
HOOK_OPENING_START_TOLERANCE_SECONDS = 0.05

HOOK_FAMILIES = frozenset(
    {
        "contradiction",
        "identity_stakes",
        "concrete_rule",
        "specific_consequence",
        "outcome_first",
        "none",
    }
)
HOOK_GATE_RECOMMENDATIONS = frozenset({"pass", "reject", "review"})
HOOK_GATE_REASON_CODES = frozenset(
    {
        "self_contained",
        "immediate_payoff",
        "concrete_stakes",
        "clear_contradiction",
        "identity_stakes",
        "actionable_rule",
        "relatable_consequence",
        "context_connector",
        "external_antecedent",
        "host_setup",
        "attribution_lead_in",
        "slow_payoff",
        "generic_motivation",
        "weak_specificity",
        "weak_relatability",
        "no_clear_tension",
        "transcript_evidence_missing",
    }
)

HOOK_GATE_V2_RESPONSE_CONTRACT = """HOOK GATE V2 AUTHORITATIVE FINAL RESPONSE EXTENSION:
The final output remains the existing top-level "highlights" array. Every
highlight object MUST contain all base fields plus every key in this fragment:
{"opening_exact_quote":"string","hook_signal_phrase":"string","hook_family":"contradiction|identity_stakes|concrete_rule|specific_consequence|outcome_first|none","new_viewer_understands_opening":bool,"opens_with_context_connector":bool,"contains_external_antecedent":bool,"contains_host_setup":bool,"first_second_value_score":int,"specificity_score":int,"relatability_score":int,"stop_scroll_score":int,"hook_gate_recommendation":"pass|reject|review","hook_gate_reasons":["reason_code"]}
Do not omit these keys and do not return a second array."""


HOOK_GATE_V2_PROMPT = f"""HOOK GATE V2 — version {HOOK_GATE_PROMPT_VERSION}

Mission:
- Select spoken openings that make a new viewer understand why to keep watching
  before the surrounding interview context is known.
- Judge the spoken opening itself. A title, famous speaker, caption overlay, or
  later explanation may not rescue a weak first line.
- Python will verify exact words and timing after the response. Never estimate
  timestamps by inventing or paraphrasing speech.

Passing evidence:
- Choose hook_signal_phrase FIRST. Then set speech_start_time to the timestamp
  of its first word. Do not preserve an earlier lead-in, setup, or weaker
  version of the thought.
- opening_exact_quote is the exact first 4-12 consecutive source words at
  speech_start_time. Its first word must also be the first word of
  hook_signal_phrase.
- The base hook_sentence field must begin with the same hook_signal_phrase and
  the same first selected word; it may not restore an earlier setup.
- hook_signal_phrase is the earliest shortest exact 1-8 consecutive source
  words that identify a concrete subject plus a tension, reversal, rule,
  outcome, or consequence. It MUST be a prefix of opening_exact_quote and its
  final word MUST land within 1.0 seconds of speech_start_time. Return an empty
  string when no such opening signal exists.
- hook_payoff_phrase is the earliest exact 3-12 spoken words that make the
  tension, contradiction, rule, identity stake, outcome, or consequence clear.
- The verified hook payoff must land within 3.0 seconds of speech_start_time.
- Before returning a candidate, calculate
  speech_end_time - speech_start_time from the supplied timestamps. It must be
  8.0-30.0 seconds. Prefer one complete point in 15-21 seconds.
- A new viewer must understand the subject and the stakes without earlier dialogue.
- Prefer one of: contradiction, identity_stakes, concrete_rule,
  specific_consequence, or outcome_first.

first_second_value_score rubric:
- 0-24: filler, attribution, greeting, or context with no standalone value.
- 25-49: the topic is visible, but the tension or stakes are still missing.
- 50-69: a meaningful subject or tension begins, but is vague or incomplete.
- 70-84: a specific hook signal is already legible in the opening second.
- 85-100: an immediate, standalone signal makes both subject and stakes clear.
This score is advisory. Python will align hook_signal_phrase to exact word
timestamps and calculate the real latency.

Mandatory pass self-check:
- hook_signal_phrase starts on the exact first selected word;
- hook_signal_phrase ends no later than 1.0 seconds after speech_start_time;
- hook_payoff_phrase ends no later than 3.0 seconds after speech_start_time;
- speech duration is no longer than 30.0 seconds;
- the exact closing quote completes the point without a following required
  answer, consequence, correction, or referential completion.
If any check fails, move speech_start_time to a later self-contained hook or do
not return the candidate. Never mark it pass because the title sounds strong.

Recommend rejection when:
- The opening begins with detachable context such as "and", "but", "so",
  "that's when", "as I said", "coming back to", or an equivalent callback.
- "This", "that", "it", "he", "she", "they", or another reference has no
  antecedent inside the selected interval.
- The interval begins with a host question, greeting, attribution, speaker
  introduction, book reference, or throat-clearing.
- The first hook signal ends after 1.0 second or its payoff ends after 3.0
  seconds.
- The claim is generic motivation without a specific tension, mechanism,
  consequence, distinction, or actionable rule.
- The clip only becomes interesting after reading the generated title.

Required HookGateV2 fields on every returned motivational micro candidate:
- opening_exact_quote: exact consecutive spoken words.
- hook_signal_phrase: exact consecutive spoken words, or an empty string.
- hook_family: contradiction | identity_stakes | concrete_rule |
  specific_consequence | outcome_first | none.
- new_viewer_understands_opening: boolean.
- opens_with_context_connector: boolean.
- contains_external_antecedent: boolean.
- contains_host_setup: boolean.
- first_second_value_score: integer 0-100.
- specificity_score: integer 0-100.
- relatability_score: integer 0-100.
- stop_scroll_score: integer 0-100.
- hook_gate_recommendation: pass | reject | review.
- hook_gate_reasons: 1-8 items using only the declared reason codes.

Allowed reason codes:
{", ".join(sorted(HOOK_GATE_REASON_CODES))}

Use "review" only when the transcript evidence is genuinely ambiguous. Be
conservative: false positives waste a render and an upload; returning fewer
qualified candidates is better than padding the response."""


def _optional_bool(value: object) -> Optional[bool]:
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
    return None


def _optional_score(value: object) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        return max(0, min(100, int(float(value))))
    except (TypeError, ValueError):
        return None


def normalize_hook_gate_v2_fields(item: Dict) -> Dict:
    """Return a stable, bounded HookGateV2 evidence subset.

    Missing evidence remains ``None`` or ``review``. It is never silently
    converted into passing evidence.
    """
    hook_family_present = bool(str(item.get("hook_family") or "").strip())
    hook_family = str(item.get("hook_family") or "none").strip().lower()
    if hook_family not in HOOK_FAMILIES:
        hook_family = "none"

    recommendation = str(
        item.get("hook_gate_recommendation") or "review"
    ).strip().lower()
    if recommendation not in HOOK_GATE_RECOMMENDATIONS:
        recommendation = "review"

    raw_reasons = item.get("hook_gate_reasons")
    reasons = []
    if isinstance(raw_reasons, list):
        for value in raw_reasons:
            code = str(value or "").strip().lower()
            if code in HOOK_GATE_REASON_CODES and code not in reasons:
                reasons.append(code)
            if len(reasons) >= 8:
                break

    def add_reason(code: str) -> None:
        if code in reasons:
            return
        if len(reasons) >= 8:
            reasons[-1] = code
        else:
            reasons.append(code)

    opening_exact_quote = str(
        item.get("opening_exact_quote") or ""
    ).strip()
    hook_signal_phrase = str(
        item.get("hook_signal_phrase") or ""
    ).strip()
    hook_payoff_phrase = str(
        item.get("hook_payoff_phrase") or ""
    ).strip()
    new_viewer_understands_opening = _optional_bool(
        item.get("new_viewer_understands_opening")
    )
    opens_with_context_connector = _optional_bool(
        item.get("opens_with_context_connector")
    )
    contains_external_antecedent = _optional_bool(
        item.get("contains_external_antecedent")
    )
    contains_host_setup = _optional_bool(
        item.get("contains_host_setup")
    )
    first_second_value_score = _optional_score(
        item.get("first_second_value_score")
    )
    specificity_score = _optional_score(item.get("specificity_score"))
    relatability_score = _optional_score(item.get("relatability_score"))
    stop_scroll_score = _optional_score(item.get("stop_scroll_score"))

    response_complete = bool(
        opening_exact_quote
        and hook_family_present
        and new_viewer_understands_opening is not None
        and opens_with_context_connector is not None
        and contains_external_antecedent is not None
        and contains_host_setup is not None
        and first_second_value_score is not None
        and specificity_score is not None
        and relatability_score is not None
        and stop_scroll_score is not None
        and reasons
    )
    pass_evidence_complete = bool(
        response_complete
        and hook_signal_phrase
        and hook_payoff_phrase
        and hook_family != "none"
        and new_viewer_understands_opening is True
        and opens_with_context_connector is False
        and contains_external_antecedent is False
        and contains_host_setup is False
    )
    contradicts_pass = bool(
        (hook_family_present and hook_family == "none")
        or new_viewer_understands_opening is False
        or opens_with_context_connector is True
        or contains_external_antecedent is True
        or contains_host_setup is True
    )
    if recommendation == "pass" and contradicts_pass:
        recommendation = "reject"
        contradiction_reason = (
            "context_connector"
            if opens_with_context_connector is True
            else "external_antecedent"
            if contains_external_antecedent is True
            else "host_setup"
            if contains_host_setup is True
            else "no_clear_tension"
        )
        add_reason(contradiction_reason)
    elif recommendation == "pass" and (
        not pass_evidence_complete
        or (
            first_second_value_score is not None
            and first_second_value_score < 70
        )
    ):
        recommendation = "review"
        add_reason(
            "transcript_evidence_missing"
            if not pass_evidence_complete
            else "slow_payoff"
        )

    return {
        "hook_gate_schema_version": HOOK_GATE_SCHEMA_VERSION,
        "hook_gate_prompt_version": HOOK_GATE_PROMPT_VERSION,
        "hook_gate_response_complete": response_complete,
        "hook_gate_pass_evidence_complete": pass_evidence_complete,
        "opening_exact_quote": opening_exact_quote,
        "hook_signal_phrase": hook_signal_phrase,
        "hook_family": hook_family,
        "new_viewer_understands_opening": new_viewer_understands_opening,
        "opens_with_context_connector": opens_with_context_connector,
        "contains_external_antecedent": contains_external_antecedent,
        "contains_host_setup": contains_host_setup,
        "first_second_value_score": first_second_value_score,
        "specificity_score": specificity_score,
        "relatability_score": relatability_score,
        "stop_scroll_score": stop_scroll_score,
        "hook_gate_recommendation": recommendation,
        "hook_gate_reasons": reasons,
    }


_CONTEXT_CONNECTOR_PREFIXES = (
    ("and",),
    ("but",),
    ("so",),
    ("that's", "when"),
    ("as", "i", "said"),
    ("as", "we", "said"),
    ("coming", "back", "to"),
    ("back", "to", "that"),
)
_EXTERNAL_ANTECEDENT_OPENERS = frozenset(
    {"he", "it", "she", "that", "they", "this", "these", "those"}
)
_HOST_SETUP_PREFIXES = (
    ("can", "you", "tell"),
    ("how", "did", "you"),
    ("let", "me", "ask"),
    ("tell", "me"),
    ("what", "do", "you", "think"),
    ("welcome", "back"),
    ("welcome", "to"),
)
_ATTRIBUTION_PREFIXES = (
    ("according", "to"),
    ("in", "your", "book"),
    ("the", "author", "of"),
    ("you", "said"),
    ("you", "wrote"),
)
_NEGATIVE_MODEL_REASON_TO_DECISION = {
    "attribution_lead_in": "hook_gate_attribution_lead_in",
    "context_connector": "hook_gate_context_connector",
    "external_antecedent": "hook_gate_external_antecedent",
    "generic_motivation": "hook_gate_generic_motivation",
    "host_setup": "hook_gate_host_setup",
    "no_clear_tension": "hook_gate_no_clear_tension",
}


def _phrase_tokens(value: object) -> List[str]:
    normalized = (
        str(value or "")
        .lower()
        .replace("’", "'")
        .replace("‘", "'")
    )
    return re.findall(r"[a-z0-9']+", normalized)


def _starts_with(tokens: Sequence[str], prefix: Sequence[str]) -> bool:
    return list(tokens[: len(prefix)]) == list(prefix)


def _normalized_timed_words(words: Optional[Sequence[Dict]]) -> List[Dict]:
    normalized = []
    for source_index, word in enumerate(words or []):
        tokens = _phrase_tokens(
            word.get("token") or word.get("word") or word.get("text")
        )
        try:
            start = float(word.get("start"))
            end = float(word.get("end"))
        except (TypeError, ValueError):
            continue
        if not tokens or start < 0.0 or end <= start:
            continue
        source_text = str(
            word.get("text") or word.get("word") or " ".join(tokens)
        ).strip()
        for source_token_index, token in enumerate(tokens):
            normalized.append(
                {
                    "source_index": source_index,
                    "source_token_index": source_token_index,
                    "start": start,
                    "end": end,
                    "text": source_text,
                    "token": token,
                }
            )
    return sorted(
        normalized,
        key=lambda item: (
            item["start"],
            item["end"],
            item["source_index"],
            item["source_token_index"],
        ),
    )


def _strict_phrase_span(
    words: Sequence[Dict],
    phrase: object,
    speech_start: float,
    speech_end: float,
    tolerance: float,
    must_start_at_speech_start: bool = False,
) -> Optional[Tuple[int, int]]:
    """Return an exact consecutive match wholly inside the speech interval."""
    needle = _phrase_tokens(phrase)
    if not needle:
        return None
    start_tolerance = tolerance if must_start_at_speech_start else 0.001
    eligible = [
        (index, word)
        for index, word in enumerate(words)
        if word["start"] >= speech_start - start_tolerance
        and word["end"] <= speech_end + 0.001
    ]
    tokens = [word["token"] for _, word in eligible]
    matches = []
    for local_index in range(0, len(tokens) - len(needle) + 1):
        if tokens[local_index : local_index + len(needle)] != needle:
            continue
        first_index = eligible[local_index][0]
        last_index = eligible[local_index + len(needle) - 1][0]
        if (
            must_start_at_speech_start
            and abs(float(words[first_index]["start"]) - speech_start) > tolerance
        ):
            continue
        matches.append((first_index, last_index))
    return matches[0] if matches else None


def _span_payload(
    words: Sequence[Dict],
    span: Optional[Tuple[int, int]],
) -> Optional[Dict]:
    if span is None:
        return None
    first_index, last_index = span
    return {
        "start_time": round(float(words[first_index]["start"]), 3),
        "end_time": round(float(words[last_index]["end"]), 3),
        "source_word_start_index": int(words[first_index]["source_index"]),
        "source_word_end_index": int(words[last_index]["source_index"]),
    }


def evaluate_hook_gate_v2(
    candidate: Dict,
    timed_words: Optional[Sequence[Dict]],
    policy: Optional[Dict] = None,
) -> Dict:
    """Make the fail-closed HookGateV2 decision from exact timed words.

    The LLM supplies semantic evidence. This function independently verifies
    that its exact phrases occur consecutively inside the selected speech
    interval, measures latency, and emits stable reject/review reason codes.
    """
    item = dict(candidate or {})
    item.update(normalize_hook_gate_v2_fields(item))
    policy = dict(policy or {})
    signal_limit = float(
        policy.get(
            "hook_signal_max_latency_seconds",
            HOOK_SIGNAL_MAX_LATENCY_SECONDS,
        )
    )
    signal_tolerance = float(
        policy.get(
            "hook_signal_latency_tolerance_seconds",
            HOOK_SIGNAL_LATENCY_TOLERANCE_SECONDS,
        )
    )
    payoff_limit = float(
        policy.get(
            "hook_payoff_max_latency_seconds",
            HOOK_PAYOFF_MAX_LATENCY_SECONDS,
        )
    )
    opening_tolerance = float(
        policy.get(
            "hook_opening_start_tolerance_seconds",
            HOOK_OPENING_START_TOLERANCE_SECONDS,
        )
    )
    speech_start = float(
        item.get("speech_start_time", item.get("start_time", 0.0))
    )
    speech_end = float(
        item.get("speech_end_time", item.get("end_time", speech_start))
    )
    words = _normalized_timed_words(timed_words)
    interval_words = [
        word
        for word in words
        if word["start"] >= speech_start - opening_tolerance
        and word["end"] <= speech_end + 0.001
    ]
    opening_tokens = [word["token"] for word in interval_words[:12]]
    observed_opening_words = []
    observed_source_indexes = set()
    for word in interval_words:
        source_index = int(word["source_index"])
        if source_index in observed_source_indexes:
            continue
        observed_source_indexes.add(source_index)
        observed_opening_words.append(str(word["text"]))
        if len(observed_opening_words) >= 12:
            break
    observed_opening = " ".join(observed_opening_words).strip()

    opening_span = _strict_phrase_span(
        words,
        item.get("opening_exact_quote"),
        speech_start,
        speech_end,
        opening_tolerance,
        must_start_at_speech_start=True,
    )
    signal_span = _strict_phrase_span(
        words,
        item.get("hook_signal_phrase"),
        speech_start,
        speech_end,
        opening_tolerance,
    )
    payoff_span = _strict_phrase_span(
        words,
        item.get("hook_payoff_phrase"),
        speech_start,
        speech_end,
        opening_tolerance,
    )
    signal_latency = (
        float(words[signal_span[1]]["end"]) - speech_start
        if signal_span is not None
        else None
    )
    payoff_latency = (
        float(words[payoff_span[1]]["end"]) - speech_start
        if payoff_span is not None
        else None
    )

    reject_reasons: List[str] = []
    review_reasons: List[str] = []

    def reject(reason: str) -> None:
        if reason not in reject_reasons:
            reject_reasons.append(reason)

    def review(reason: str) -> None:
        if reason not in review_reasons:
            review_reasons.append(reason)

    if any(_starts_with(opening_tokens, prefix) for prefix in _CONTEXT_CONNECTOR_PREFIXES):
        reject("hook_gate_context_connector")
    if opening_tokens and opening_tokens[0] in _EXTERNAL_ANTECEDENT_OPENERS:
        reject("hook_gate_external_antecedent")
    if any(_starts_with(opening_tokens, prefix) for prefix in _HOST_SETUP_PREFIXES):
        reject("hook_gate_host_setup")
    if any(_starts_with(opening_tokens, prefix) for prefix in _ATTRIBUTION_PREFIXES):
        reject("hook_gate_attribution_lead_in")

    if item.get("opens_with_context_connector") is True:
        reject("hook_gate_context_connector")
    if item.get("contains_external_antecedent") is True:
        reject("hook_gate_external_antecedent")
    if item.get("contains_host_setup") is True:
        reject("hook_gate_host_setup")
    if item.get("contains_attribution_lead_in") is True:
        reject("hook_gate_attribution_lead_in")
    if item.get("contains_context_callback") is True:
        reject("hook_gate_context_callback")
    if item.get("requires_previous_context") is True:
        reject("hook_gate_requires_previous_context")
    if item.get("new_viewer_understands_opening") is False:
        reject("hook_gate_new_viewer_context_failed")
    if item.get("hook_family") == "none":
        reject("hook_gate_no_clear_tension")
    for reason in item.get("hook_gate_reasons", []):
        mapped = _NEGATIVE_MODEL_REASON_TO_DECISION.get(str(reason))
        if mapped:
            reject(mapped)

    recommendation = str(
        item.get("hook_gate_recommendation") or "review"
    ).strip().lower()
    if recommendation == "reject":
        reject("hook_gate_model_reject")
    elif recommendation == "review":
        review("hook_gate_model_review")
    if item.get("hook_gate_response_complete") is not True:
        review("hook_gate_response_incomplete")

    if not words or not interval_words or speech_end <= speech_start:
        review("hook_gate_word_timing_missing")
    else:
        if item.get("opening_exact_quote"):
            if opening_span is None:
                reject("hook_gate_opening_unaligned")
        else:
            review("hook_gate_opening_missing")

        if item.get("hook_signal_phrase"):
            if signal_span is None:
                reject("hook_gate_signal_unaligned")
            elif (
                signal_latency is not None
                and signal_latency
                > signal_limit + signal_tolerance + 1e-6
            ):
                reject("hook_gate_signal_after_1s")
        else:
            reject("hook_gate_signal_missing")

        if item.get("hook_payoff_phrase"):
            if payoff_span is None:
                reject("hook_gate_payoff_unaligned")
            elif payoff_latency is not None and payoff_latency > payoff_limit + 1e-6:
                reject("hook_gate_payoff_after_3s")
        else:
            reject("hook_gate_payoff_missing")

    status = "reject" if reject_reasons else "review" if review_reasons else "pass"
    item.update(
        {
            "hook_gate_decision_version": str(
                policy.get(
                    "hook_gate_decision_version",
                    HOOK_GATE_DECISION_VERSION,
                )
            ),
            "hook_gate_status": status,
            "hook_gate_eligible": status == "pass",
            "hook_gate_reject_reasons": reject_reasons,
            "hook_gate_review_reasons": review_reasons,
            "hook_gate_deterministic_reasons": reject_reasons + review_reasons,
            "hook_gate_word_timing_available": bool(words and interval_words),
            "hook_gate_observed_opening": observed_opening,
            "hook_gate_thresholds": {
                "signal_max_latency_seconds": signal_limit,
                "signal_timing_tolerance_seconds": signal_tolerance,
                "payoff_max_latency_seconds": payoff_limit,
                "opening_start_tolerance_seconds": opening_tolerance,
            },
            "hook_opening_aligned": opening_span is not None,
            "hook_signal_aligned": signal_span is not None,
            "hook_payoff_aligned": payoff_span is not None,
            "hook_opening_span": _span_payload(words, opening_span),
            "hook_signal_span": _span_payload(words, signal_span),
            "hook_payoff_span": _span_payload(words, payoff_span),
            "hook_signal_latency_seconds": (
                round(signal_latency, 3)
                if signal_latency is not None
                else None
            ),
            "hook_payoff_latency_seconds": (
                round(payoff_latency, 3)
                if payoff_latency is not None
                else None
            ),
        }
    )
    return item


__all__ = [
    "HOOK_FAMILIES",
    "HOOK_GATE_PROMPT_VERSION",
    "HOOK_GATE_DECISION_VERSION",
    "HOOK_GATE_REASON_CODES",
    "HOOK_GATE_RECOMMENDATIONS",
    "HOOK_GATE_SCHEMA_VERSION",
    "HOOK_GATE_V2_PROMPT",
    "HOOK_GATE_V2_RESPONSE_CONTRACT",
    "HOOK_OPENING_START_TOLERANCE_SECONDS",
    "HOOK_PAYOFF_MAX_LATENCY_SECONDS",
    "HOOK_SIGNAL_MAX_LATENCY_SECONDS",
    "HOOK_SIGNAL_LATENCY_TOLERANCE_SECONDS",
    "evaluate_hook_gate_v2",
    "normalize_hook_gate_v2_fields",
]
