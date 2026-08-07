import json
import unittest

from shorts_generator.local.llm import (
    CONTENT_TYPE_SCHEMA,
    HIGHLIGHTS_SCHEMA,
    HOOK_GATE_V2_HIGHLIGHTS_SCHEMA,
    HOOK_GATE_V4_HIGHLIGHTS_SCHEMA,
    HOOK_GATE_V4_PROMPT_VERSION,
    HOOK_GATE_V4_REASON_CODES,
    MICRO_HIGHLIGHTS_SCHEMA,
    _generate_gemini_with_fallback,
    _generate_gemini_rest_with_fallback,
    _response_schema_for_prompt,
)
from shorts_generator.hook_gate import HOOK_GATE_PROMPT_VERSION


class FakeGeminiError(Exception):
    def __init__(self, status_code):
        super().__init__(f"Gemini error {status_code}")
        self.status_code = status_code


class FakeGeminiTimeout(Exception):
    pass


class FakeModels:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return type("Response", (), {"text": response})()


class FakeClient:
    def __init__(self, responses):
        self.models = FakeModels(responses)


class FakeRestResponse:
    def __init__(self, text):
        self.payload = json.dumps(
            {
                "candidates": [
                    {"content": {"parts": [{"text": text}]}}
                ]
            }
        ).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, limit):
        return self.payload[:limit]


class FakeRestOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, request, timeout):
        self.calls.append((request, timeout))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return FakeRestResponse(response)


class GeminiRoutingTests(unittest.TestCase):
    def test_selects_schema_from_prompt_shape(self):
        self.assertIs(
            _response_schema_for_prompt('Respond with {"content_type":"...","density":"..."}'),
            CONTENT_TYPE_SCHEMA,
        )
        self.assertIs(
            _response_schema_for_prompt('Respond with {"highlights":[]}'),
            HIGHLIGHTS_SCHEMA,
        )
        self.assertIs(
            _response_schema_for_prompt(
                'Respond with {"highlights":[]} including semantic_tension_score '
                "and reaction_tail_start_time"
            ),
            MICRO_HIGHLIGHTS_SCHEMA,
        )
        micro_item = MICRO_HIGHLIGHTS_SCHEMA["properties"]["highlights"]["items"]
        self.assertIn("semantic_tension_score", micro_item["required"])
        self.assertIn("reaction_tail_start_time", micro_item["required"])

        hook_gate_prompt = (
            f'{HOOK_GATE_PROMPT_VERSION} Respond with {{"highlights":[]}} '
            "including semantic_tension_score and reaction_tail_start_time"
        )
        self.assertIs(
            _response_schema_for_prompt(hook_gate_prompt),
            HOOK_GATE_V2_HIGHLIGHTS_SCHEMA,
        )
        hook_gate_item = HOOK_GATE_V2_HIGHLIGHTS_SCHEMA[
            "properties"
        ]["highlights"]["items"]
        for field in (
            "opening_exact_quote",
            "hook_signal_phrase",
            "hook_family",
            "new_viewer_understands_opening",
            "opens_with_context_connector",
            "contains_external_antecedent",
            "contains_host_setup",
            "first_second_value_score",
            "specificity_score",
            "relatability_score",
            "stop_scroll_score",
            "hook_gate_recommendation",
            "hook_gate_reasons",
        ):
            self.assertIn(field, hook_gate_item["required"])
        self.assertEqual(
            hook_gate_item["properties"]["hook_gate_reasons"]["minItems"],
            1,
        )
        self.assertEqual(
            hook_gate_item["properties"]["hook_gate_reasons"]["maxItems"],
            8,
        )

        v4_prompt = (
            f'{HOOK_GATE_V4_PROMPT_VERSION} Respond with {{"highlights":[]}} '
            "including semantic_tension_score and reaction_tail_start_time"
        )
        self.assertIs(
            _response_schema_for_prompt(v4_prompt),
            HOOK_GATE_V4_HIGHLIGHTS_SCHEMA,
        )
        v4_item = HOOK_GATE_V4_HIGHLIGHTS_SCHEMA[
            "properties"
        ]["highlights"]["items"]
        for field in (
            "opening_unit_exact_quote",
            "topic_comprehension_exact_quote",
            "payoff_exact_quote",
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
        ):
            self.assertIn(field, v4_item["required"])
        for field in (
            "opening_sentence_clarity_score",
            "topic_explicitness_score",
            "standalone_comprehension_score",
            "tension_or_relevance_score",
            "opening_point_coherence_score",
            "payoff_resolution_score",
            "single_idea_focus_score",
            "lexical_delivery_strength_score",
            "hook_semantic_confidence_score",
        ):
            self.assertEqual(v4_item["properties"][field]["minimum"], 0)
            self.assertEqual(v4_item["properties"][field]["maximum"], 100)
        reasons = v4_item["properties"]["hook_semantic_reason_codes"]
        self.assertEqual(reasons["minItems"], 1)
        self.assertEqual(reasons["maxItems"], 8)
        self.assertEqual(
            reasons["items"]["enum"],
            list(HOOK_GATE_V4_REASON_CODES),
        )

    def test_falls_back_on_temporary_model_error(self):
        client = FakeClient([FakeGeminiError(503), '{"highlights":[]}'])

        result = _generate_gemini_with_fallback(
            client,
            'Respond with {"highlights":[]}',
            ["gemini-3.5-flash", "gemini-3.1-flash-lite"],
        )

        self.assertEqual(result, '{"highlights":[]}')
        self.assertEqual(
            [call["model"] for call in client.models.calls],
            ["gemini-3.5-flash", "gemini-3.1-flash-lite"],
        )
        fallback_config = client.models.calls[-1]["config"]
        self.assertEqual(fallback_config["thinking_config"]["thinking_level"], "medium")
        self.assertIs(fallback_config["response_schema"], HIGHLIGHTS_SCHEMA)

    def test_falls_back_when_primary_model_times_out(self):
        client = FakeClient([FakeGeminiTimeout("request timed out"), '{"highlights":[]}'])

        result = _generate_gemini_with_fallback(
            client,
            'Respond with {"highlights":[]}',
            ["primary", "fallback"],
        )

        self.assertEqual(result, '{"highlights":[]}')
        self.assertEqual(
            [call["model"] for call in client.models.calls],
            ["primary", "fallback"],
        )

    def test_does_not_hide_authentication_error(self):
        client = FakeClient([FakeGeminiError(403), '{"highlights":[]}'])

        with self.assertRaises(FakeGeminiError):
            _generate_gemini_with_fallback(
                client,
                'Respond with {"highlights":[]}',
                ["gemini-3.5-flash", "gemini-3.1-flash-lite"],
            )

        self.assertEqual(len(client.models.calls), 1)

    def test_rest_transport_uses_header_schema_timeout_and_model_fallback(self):
        opener = FakeRestOpener(
            [FakeGeminiError(503), '{"highlights":[]}']
        )

        result = _generate_gemini_rest_with_fallback(
            'Respond with {"highlights":[]}',
            ["gemini-3.5-flash", "gemini-3.1-flash-lite"],
            "test-api-key",
            opener=opener,
        )

        self.assertEqual(result, '{"highlights":[]}')
        self.assertEqual(len(opener.calls), 2)
        first_request, timeout = opener.calls[0]
        second_request, _ = opener.calls[1]
        self.assertTrue(first_request.full_url.endswith("gemini-3.5-flash:generateContent"))
        self.assertTrue(second_request.full_url.endswith("gemini-3.1-flash-lite:generateContent"))
        self.assertNotIn("test-api-key", first_request.full_url)
        self.assertEqual(first_request.get_header("X-goog-api-key"), "test-api-key")
        self.assertEqual(timeout, 90.0)
        body = json.loads(first_request.data.decode("utf-8"))
        generation = body["generationConfig"]
        self.assertEqual(generation["responseMimeType"], "application/json")
        self.assertEqual(generation["responseJsonSchema"], HIGHLIGHTS_SCHEMA)
        self.assertEqual(generation["thinkingConfig"]["thinkingLevel"], "MEDIUM")

    def test_rest_transport_does_not_retry_authentication_failure(self):
        opener = FakeRestOpener(
            [FakeGeminiError(403), '{"highlights":[]}']
        )

        with self.assertRaises(FakeGeminiError):
            _generate_gemini_rest_with_fallback(
                'Respond with {"highlights":[]}',
                ["primary", "fallback"],
                "test-api-key",
                opener=opener,
            )

        self.assertEqual(len(opener.calls), 1)


if __name__ == "__main__":
    unittest.main()
