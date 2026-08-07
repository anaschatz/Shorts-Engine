"""Local LLM backend — OpenAI or Gemini, selected by LLM_PROVIDER."""
from copy import deepcopy
import json
import ssl
from urllib.parse import quote
from urllib.request import Request, urlopen

from ..hook_gate import (
    HOOK_FAMILIES,
    HOOK_GATE_PROMPT_VERSION,
    HOOK_GATE_REASON_CODES,
    HOOK_GATE_RECOMMENDATIONS,
)
from ..config import (
    GEMINI_FALLBACK_MODEL,
    GEMINI_MODEL,
    LLM_PROVIDER,
    OPENAI_MODEL,
    require_gemini_key,
    require_openai_key,
)


CONTENT_TYPE_SCHEMA = {
    "type": "object",
    "properties": {
        "content_type": {
            "type": "string",
            "enum": [
                "motivational_podcast",
                "podcast",
                "interview",
                "tutorial",
                "lecture",
                "commentary",
                "debate",
                "vlog",
                "gaming",
                "sports",
                "other",
            ],
        },
        "density": {
            "type": "string",
            "enum": ["low", "medium", "high"],
        },
    },
    "required": ["content_type", "density"],
}

HIGHLIGHTS_SCHEMA = {
    "type": "object",
    "properties": {
        "highlights": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "speech_start_time": {"type": "number"},
                    "speech_end_time": {"type": "number"},
                    "start_time": {"type": "number"},
                    "end_time": {"type": "number"},
                    "score": {"type": "integer"},
                    "hook_sentence": {"type": "string"},
                    "final_takeaway_sentence": {"type": "string"},
                    "thesis": {"type": "string"},
                    "topic": {"type": "string"},
                    "hook_type": {"type": "string"},
                    "development_type": {"type": "string"},
                    "virality_reason": {"type": "string"},
                    "context_summary": {"type": "string"},
                    "title_options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 3,
                        "maxItems": 3,
                    },
                    "has_hook": {"type": "boolean"},
                    "has_development": {"type": "boolean"},
                    "has_takeaway": {"type": "boolean"},
                    "has_complete_ending": {"type": "boolean"},
                    "has_clear_setup": {"type": "boolean"},
                    "has_escalation": {"type": "boolean"},
                    "has_visible_cause": {"type": "boolean"},
                    "has_complete_outcome": {"type": "boolean"},
                    "narrative_coherence_score": {"type": "integer"},
                    "micro_story_score": {"type": "integer"},
                    "is_promotional": {"type": "boolean"},
                    "is_outro": {"type": "boolean"},
                    "requires_previous_context": {"type": "boolean"},
                    "is_standalone_one_liner": {"type": "boolean"},
                    "contains_profanity": {"type": "boolean"},
                    "hook_score": {"type": "integer"},
                    "standalone_score": {"type": "integer"},
                    "development_score": {"type": "integer"},
                    "takeaway_score": {"type": "integer"},
                    "emotional_conviction_score": {"type": "integer"},
                    "quotability_score": {"type": "integer"},
                    "closure_score": {"type": "integer"},
                    "title_fit_score": {"type": "integer"},
                    "payoff_score": {"type": "integer"},
                    "educational_value_score": {"type": "integer"},
                    "visual_action_score": {"type": "integer"},
                },
                "required": [
                    "title",
                    "speech_start_time",
                    "speech_end_time",
                    "start_time",
                    "end_time",
                    "score",
                    "hook_sentence",
                    "final_takeaway_sentence",
                    "thesis",
                    "topic",
                    "hook_type",
                    "development_type",
                    "virality_reason",
                    "context_summary",
                    "title_options",
                    "has_hook",
                    "has_development",
                    "has_takeaway",
                    "has_complete_ending",
                    "has_clear_setup",
                    "has_escalation",
                    "has_visible_cause",
                    "has_complete_outcome",
                    "narrative_coherence_score",
                    "micro_story_score",
                    "is_promotional",
                    "is_outro",
                    "requires_previous_context",
                    "is_standalone_one_liner",
                    "contains_profanity",
                    "hook_score",
                    "standalone_score",
                    "development_score",
                    "takeaway_score",
                    "emotional_conviction_score",
                    "quotability_score",
                    "closure_score",
                    "title_fit_score",
                    "payoff_score",
                    "educational_value_score",
                    "visual_action_score",
                ],
            },
        }
    },
    "required": ["highlights"],
}

MICRO_HIGHLIGHT_FIELDS = {
    "hook_payoff_phrase": {"type": "string"},
    "earliest_complete_takeaway_sentence": {"type": "string"},
    "second_topic_begins_after_takeaway": {"type": "boolean"},
    "contains_attribution_lead_in": {"type": "boolean"},
    "contains_context_callback": {"type": "boolean"},
    "has_semantic_tension": {"type": "boolean"},
    "has_contrast": {"type": "boolean"},
    "has_conflict": {"type": "boolean"},
    "has_reversal": {"type": "boolean"},
    "semantic_tension_score": {"type": "integer"},
    "contrast_score": {"type": "integer"},
    "conflict_score": {"type": "integer"},
    "reversal_score": {"type": "integer"},
    "listener_payoff_score": {"type": "integer"},
    "self_contained_micro_arc_score": {"type": "integer"},
    "generic_motivation_score": {"type": "integer"},
    "context_dependence_score": {"type": "integer"},
    "reaction_tail_compatible": {"type": "boolean"},
    "reaction_tail_compatibility_score": {"type": "integer"},
    "reaction_tail_start_time": {"type": ["number", "null"]},
    "tension_kind": {"type": "string"},
    "contrast_pair": {"type": "string"},
    "listener_payoff": {"type": "string"},
    "reaction_tail_reason": {"type": "string"},
}
MICRO_HIGHLIGHTS_SCHEMA = deepcopy(HIGHLIGHTS_SCHEMA)
_micro_item_schema = MICRO_HIGHLIGHTS_SCHEMA["properties"]["highlights"]["items"]
_micro_item_schema["properties"].update(MICRO_HIGHLIGHT_FIELDS)
_micro_item_schema["required"].extend(MICRO_HIGHLIGHT_FIELDS)

HOOK_GATE_V2_FIELDS = {
    "opening_exact_quote": {"type": "string"},
    "hook_signal_phrase": {"type": "string"},
    "hook_family": {
        "type": "string",
        "enum": sorted(HOOK_FAMILIES),
    },
    "new_viewer_understands_opening": {"type": "boolean"},
    "opens_with_context_connector": {"type": "boolean"},
    "contains_external_antecedent": {"type": "boolean"},
    "contains_host_setup": {"type": "boolean"},
    "first_second_value_score": {"type": "integer"},
    "specificity_score": {"type": "integer"},
    "relatability_score": {"type": "integer"},
    "stop_scroll_score": {"type": "integer"},
    "hook_gate_recommendation": {
        "type": "string",
        "enum": sorted(HOOK_GATE_RECOMMENDATIONS),
    },
    "hook_gate_reasons": {
        "type": "array",
        "items": {
            "type": "string",
            "enum": sorted(HOOK_GATE_REASON_CODES),
        },
        "minItems": 1,
        "maxItems": 8,
    },
}
HOOK_GATE_V2_HIGHLIGHTS_SCHEMA = deepcopy(MICRO_HIGHLIGHTS_SCHEMA)
_hook_gate_item_schema = (
    HOOK_GATE_V2_HIGHLIGHTS_SCHEMA["properties"]["highlights"]["items"]
)
_hook_gate_item_schema["properties"].update(HOOK_GATE_V2_FIELDS)
_hook_gate_item_schema["required"].extend(HOOK_GATE_V2_FIELDS)

# Keep the semantic prompt marker local to the transport layer.  The V4
# decision module is intentionally not imported here: structured-output
# routing must remain lightweight and must not make local provider startup
# depend on the deterministic evaluator.  A version-mirror test protects this
# literal from drifting from the selection prompt contract.
HOOK_GATE_V4_PROMPT_VERSION = "hook-gate-v4-semantic-v1.0.0"

HOOK_GATE_V4_OPENING_UNIT_TYPES = (
    "claim",
    "rule",
    "contradiction",
    "tension",
    "question_with_immediate_answer",
    "story_setup",
    "topic_intro",
    "fragment",
)
HOOK_GATE_V4_MECHANISMS = (
    "contradiction",
    "concrete_rule",
    "identity_threat",
    "interpersonal_conflict",
    "surprising_consequence",
    "emotional_comparison",
    "visual_metaphor",
    "common_belief_challenge",
    "none",
)
HOOK_GATE_V4_SCORE_FIELDS = (
    "opening_sentence_clarity_score",
    "topic_explicitness_score",
    "standalone_comprehension_score",
    "tension_or_relevance_score",
    "opening_point_coherence_score",
    "payoff_resolution_score",
    "single_idea_focus_score",
    "lexical_delivery_strength_score",
    "hook_semantic_confidence_score",
)
HOOK_GATE_V4_BOOLEAN_FIELDS = (
    "opening_unit_is_complete_claim",
    "requires_external_context",
    "unresolved_deictic_reference",
    "host_or_attribution_setup",
    "topic_intro_only",
    "payoff_changes_topic",
)
HOOK_GATE_V4_REASON_CODES = (
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
)
HOOK_GATE_V4_FIELDS = {
    "opening_unit_exact_quote": {"type": "string"},
    "topic_comprehension_exact_quote": {"type": "string"},
    "payoff_exact_quote": {"type": "string"},
    "opening_unit_type": {
        "type": "string",
        "enum": list(HOOK_GATE_V4_OPENING_UNIT_TYPES),
    },
    "hook_mechanism": {
        "type": "string",
        "enum": list(HOOK_GATE_V4_MECHANISMS),
    },
    "hook_semantic_topic": {"type": "string"},
    "opening_claim_summary": {"type": "string"},
    "whole_point_summary": {"type": "string"},
    **{
        field: {"type": "integer", "minimum": 0, "maximum": 100}
        for field in HOOK_GATE_V4_SCORE_FIELDS
    },
    **{field: {"type": "boolean"} for field in HOOK_GATE_V4_BOOLEAN_FIELDS},
    "hook_semantic_reason_codes": {
        "type": "array",
        "items": {"type": "string", "enum": list(HOOK_GATE_V4_REASON_CODES)},
        "minItems": 1,
        "maxItems": 8,
    },
}
HOOK_GATE_V4_HIGHLIGHTS_SCHEMA = deepcopy(MICRO_HIGHLIGHTS_SCHEMA)
_hook_gate_v4_item_schema = (
    HOOK_GATE_V4_HIGHLIGHTS_SCHEMA["properties"]["highlights"]["items"]
)
_hook_gate_v4_item_schema["properties"].update(HOOK_GATE_V4_FIELDS)
_hook_gate_v4_item_schema["required"].extend(HOOK_GATE_V4_FIELDS)

FALLBACK_STATUS_CODES = {404, 429, 500, 502, 503, 504}
GEMINI_REQUEST_TIMEOUT_MS = 90_000
GEMINI_REST_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
GEMINI_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
LLM_RESPONSE_SCHEMA_VERSION = "structured-output-v2"


def _verified_urlopen(request, timeout):
    try:
        import certifi
    except ImportError:
        context = ssl.create_default_context()
    else:
        context = ssl.create_default_context(cafile=certifi.where())
    return urlopen(request, timeout=timeout, context=context)


def _gemini_models() -> list[str]:
    models = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]
    return list(dict.fromkeys(model.strip() for model in models if model.strip()))


def _response_schema_for_prompt(prompt: str) -> dict:
    if '"highlights"' not in prompt:
        return CONTENT_TYPE_SCHEMA
    if HOOK_GATE_V4_PROMPT_VERSION in prompt:
        return HOOK_GATE_V4_HIGHLIGHTS_SCHEMA
    if HOOK_GATE_PROMPT_VERSION in prompt:
        return HOOK_GATE_V2_HIGHLIGHTS_SCHEMA
    if "semantic_tension_score" in prompt and "reaction_tail_start_time" in prompt:
        return MICRO_HIGHLIGHTS_SCHEMA
    return HIGHLIGHTS_SCHEMA


def _gemini_status_code(error: Exception) -> int | None:
    status = getattr(error, "status_code", None) or getattr(error, "code", None)
    if status is None:
        response = getattr(error, "response", None)
        status = getattr(response, "status_code", None)
    try:
        return int(status) if status is not None else None
    except (TypeError, ValueError):
        return None


def _is_timeout_error(error: Exception) -> bool:
    return "timeout" in type(error).__name__.lower() or "timed out" in str(error).lower()


def _is_transport_error(error: Exception) -> bool:
    name = type(error).__name__.lower()
    return (
        _is_timeout_error(error)
        or "urlerror" in name
        or "connection" in name
        or "temporar" in str(error).lower()
    )


def _generate_gemini_with_fallback(client, prompt: str, models: list[str]) -> str:
    schema = _response_schema_for_prompt(prompt)
    last_error: Exception | None = None
    for index, model in enumerate(models):
        try:
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config={
                    "temperature": 0.2,
                    "response_mime_type": "application/json",
                    "response_schema": schema,
                    "max_output_tokens": 16384,
                    "thinking_config": {"thinking_level": "medium"},
                },
            )
            text = response.text or ""
            if text.strip():
                return text
            raise RuntimeError(f"Gemini model {model} returned an empty response")
        except Exception as error:
            last_error = error
            status = _gemini_status_code(error)
            has_fallback = index + 1 < len(models)
            if not has_fallback or (
                status not in FALLBACK_STATUS_CODES and not _is_timeout_error(error)
            ):
                raise
            print(
                f"[llm/gemini] {model} unavailable ({status or type(error).__name__}); "
                f"falling back to {models[index + 1]}",
                flush=True,
            )

    raise RuntimeError(f"All configured Gemini models failed: {last_error}")


def _gemini_rest_payload(prompt: str) -> bytes:
    return json.dumps(
        {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "responseMimeType": "application/json",
                "responseJsonSchema": _response_schema_for_prompt(prompt),
                "maxOutputTokens": 16384,
                "thinkingConfig": {"thinkingLevel": "MEDIUM"},
            },
        },
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _gemini_text_from_rest_response(payload: bytes, model: str) -> str:
    if len(payload) > GEMINI_MAX_RESPONSE_BYTES:
        raise RuntimeError(f"Gemini model {model} returned an oversized response")
    try:
        response = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Gemini model {model} returned invalid JSON") from error
    candidates = response.get("candidates") if isinstance(response, dict) else None
    if not isinstance(candidates, list) or not candidates:
        feedback = response.get("promptFeedback") if isinstance(response, dict) else None
        raise RuntimeError(
            f"Gemini model {model} returned no candidates"
            + (f": {feedback}" if feedback else "")
        )
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    text = "".join(
        str(part.get("text") or "")
        for part in parts
        if isinstance(part, dict)
    )
    if not text.strip():
        raise RuntimeError(f"Gemini model {model} returned an empty response")
    return text


def _generate_gemini_rest_with_fallback(
    prompt: str,
    models: list[str],
    api_key: str,
    opener=None,
) -> str:
    """Call the official REST endpoint without importing the heavy SDK stack."""
    opener = opener or _verified_urlopen
    body = _gemini_rest_payload(prompt)
    last_error: Exception | None = None
    for index, model in enumerate(models):
        safe_model = quote(str(model).strip(), safe="-.")
        request = Request(
            f"{GEMINI_REST_BASE_URL}/{safe_model}:generateContent",
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": api_key,
                "User-Agent": "shorts-engine-bf/1.0",
            },
            method="POST",
        )
        try:
            with opener(
                request,
                timeout=GEMINI_REQUEST_TIMEOUT_MS / 1000.0,
            ) as response:
                return _gemini_text_from_rest_response(
                    response.read(GEMINI_MAX_RESPONSE_BYTES + 1),
                    model,
                )
        except Exception as error:
            last_error = error
            status = _gemini_status_code(error)
            has_fallback = index + 1 < len(models)
            if not has_fallback or (
                status not in FALLBACK_STATUS_CODES and not _is_transport_error(error)
            ):
                raise
            print(
                f"[llm/gemini] {model} unavailable ({status or type(error).__name__}); "
                f"falling back to {models[index + 1]}",
                flush=True,
            )
    raise RuntimeError(f"All configured Gemini models failed: {last_error}")


def call_openai_llm(prompt: str) -> str:
    """OpenAI Chat Completions backend used by --mode local."""
    try:
        from openai import OpenAI  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "openai is required for --mode local. Install it with:\n"
            "    pip install -r requirements-local.txt"
        ) from e

    client = OpenAI(api_key=require_openai_key())
    response = client.chat.completions.create(
        model=OPENAI_MODEL,
        temperature=0.7,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.choices[0].message.content or ""


def call_gemini_llm(prompt: str) -> str:
    """Gemini REST backend with structured output and model fallback."""
    return _generate_gemini_rest_with_fallback(
        prompt,
        _gemini_models(),
        require_gemini_key(),
    )


def call_local_llm(prompt: str) -> str:
    """Dispatch to the configured local LLM provider."""
    provider = (LLM_PROVIDER or "openai").strip().lower()
    if provider == "openai":
        return call_openai_llm(prompt)
    if provider == "gemini":
        return call_gemini_llm(prompt)
    raise RuntimeError(
        f"Unknown LLM_PROVIDER={provider!r}. Use 'openai' or 'gemini'."
    )
