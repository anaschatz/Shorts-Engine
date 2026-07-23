import json
import unittest

from shorts_generator.highlights import (
    _discovery_prompt_contract,
    call_highlight_api,
)
from shorts_generator.hook_gate import (
    HOOK_GATE_PROMPT_VERSION,
    HOOK_GATE_V2_PROMPT,
    normalize_hook_gate_v2_fields,
)
from shorts_generator.profiles import (
    MOTIVATIONAL_PODCAST,
    MOTIVATIONAL_TENSION_MICRO_V1,
    MOTIVATIONAL_TENSION_MICRO_V2,
)


class HookGateV2PromptTests(unittest.TestCase):
    def test_prompt_requires_exact_first_second_evidence(self):
        self.assertIn(HOOK_GATE_PROMPT_VERSION, HOOK_GATE_V2_PROMPT)
        self.assertIn("within 3.0 seconds", HOOK_GATE_V2_PROMPT)
        self.assertIn("Choose hook_signal_phrase FIRST", HOOK_GATE_V2_PROMPT)
        self.assertIn("MUST be a prefix", HOOK_GATE_V2_PROMPT)
        self.assertIn("8.0-30.0 seconds", HOOK_GATE_V2_PROMPT)
        self.assertIn("Mandatory pass self-check", HOOK_GATE_V2_PROMPT)
        self.assertIn("opening_exact_quote", HOOK_GATE_V2_PROMPT)
        self.assertIn("hook_signal_phrase", HOOK_GATE_V2_PROMPT)
        self.assertIn("0-24: filler", HOOK_GATE_V2_PROMPT)
        self.assertIn("70-84:", HOOK_GATE_V2_PROMPT)
        self.assertIn("A title, famous speaker", HOOK_GATE_V2_PROMPT)
        self.assertIn("contains_external_antecedent", HOOK_GATE_V2_PROMPT)
        self.assertIn("returning fewer", HOOK_GATE_V2_PROMPT)

    def test_micro_discovery_uses_one_call_and_preserves_hook_evidence(self):
        prompts = []

        def fake_llm(prompt):
            prompts.append(prompt)
            return json.dumps(
                {
                    "highlights": [
                        {
                            "title": "Less creates consistency",
                            "speech_start_time": 0.0,
                            "speech_end_time": 18.0,
                            "start_time": 0.0,
                            "end_time": 18.0,
                            "score": 91,
                            "hook_sentence": "Do less than you think you can do.",
                            "hook_payoff_phrase": "Do less than you think",
                            "opening_exact_quote": (
                                "Do less than you think you can do."
                            ),
                            "hook_signal_phrase": "Do less",
                            "hook_family": "contradiction",
                            "new_viewer_understands_opening": True,
                            "opens_with_context_connector": False,
                            "contains_external_antecedent": False,
                            "contains_host_setup": False,
                            "first_second_value_score": 88,
                            "specificity_score": 92,
                            "relatability_score": 85,
                            "stop_scroll_score": 94,
                            "hook_gate_recommendation": "pass",
                            "hook_gate_reasons": [
                                "self_contained",
                                "clear_contradiction",
                                "immediate_payoff",
                            ],
                        }
                    ]
                }
            )

        result = call_highlight_api(
            "[0.0s] Do less than you think you can do.",
            {"content_type": MOTIVATIONAL_PODCAST, "density": "high"},
            duration=30.0,
            num_clips=1,
            llm_fn=fake_llm,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V2,
        )

        self.assertEqual(len(prompts), 1)
        self.assertIn(HOOK_GATE_PROMPT_VERSION, prompts[0])
        self.assertIn('"hook_signal_phrase":"string"', prompts[0])
        self.assertIn('"hook_gate_recommendation":"pass|reject|review"', prompts[0])
        base_contract_index = prompts[0].rfind(
            "Respond ONLY with valid JSON"
        )
        v2_contract_index = prompts[0].rfind(
            "HOOK GATE V2 AUTHORITATIVE FINAL RESPONSE EXTENSION"
        )
        self.assertEqual(
            prompts[0].count(
                "HOOK GATE V2 AUTHORITATIVE FINAL RESPONSE EXTENSION"
            ),
            1,
        )
        transcript_index = prompts[0].rfind("Transcript:")
        self.assertLess(base_contract_index, v2_contract_index)
        self.assertLess(v2_contract_index, transcript_index)
        candidate = result["highlights"][0]
        self.assertEqual(candidate["hook_family"], "contradiction")
        self.assertEqual(candidate["hook_signal_phrase"], "Do less")
        self.assertEqual(candidate["hook_gate_recommendation"], "pass")
        self.assertTrue(candidate["hook_gate_response_complete"])
        self.assertTrue(candidate["hook_gate_pass_evidence_complete"])
        self.assertEqual(
            candidate["hook_gate_prompt_version"],
            HOOK_GATE_PROMPT_VERSION,
        )
        self.assertEqual(candidate["stop_scroll_score"], 94)

    def test_v1_prompt_remains_unchanged_and_has_no_hook_gate_marker(self):
        prompts = []

        def fake_llm(prompt):
            prompts.append(prompt)
            return json.dumps(
                {
                    "highlights": [
                        {
                            "title": "Existing v1 candidate",
                            "speech_start_time": 0.0,
                            "speech_end_time": 10.0,
                            "start_time": 0.0,
                            "end_time": 10.0,
                            "score": 80,
                        }
                    ]
                }
            )

        result = call_highlight_api(
            "[0.0s] Existing source words.",
            {"content_type": MOTIVATIONAL_PODCAST, "density": "high"},
            duration=20.0,
            num_clips=1,
            llm_fn=fake_llm,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        )

        self.assertEqual(len(prompts), 1)
        self.assertNotIn(HOOK_GATE_PROMPT_VERSION, prompts[0])
        self.assertNotIn("opening_exact_quote", prompts[0])
        self.assertNotIn("hook_gate_recommendation", prompts[0])
        self.assertNotIn("hook_gate_prompt_version", result["highlights"][0])
        self.assertNotIn("hook_signal_phrase", result["highlights"][0])

    def test_v1_and_v2_use_isolated_discovery_prompt_contracts(self):
        legacy_contract = (
            "330cdfc7e26c9b8dcbd76fe521b9192497ecf737926c366a630f56316fa7c049"
        )

        self.assertEqual(_discovery_prompt_contract(), legacy_contract)
        self.assertEqual(
            _discovery_prompt_contract(MOTIVATIONAL_TENSION_MICRO_V1),
            legacy_contract,
        )
        self.assertNotEqual(
            _discovery_prompt_contract(MOTIVATIONAL_TENSION_MICRO_V2),
            legacy_contract,
        )


class HookGateV2NormalizationTests(unittest.TestCase):
    @staticmethod
    def _complete_pass_evidence():
        return {
            "opening_exact_quote": "Do less than you think you can do",
            "hook_signal_phrase": "Do less",
            "hook_payoff_phrase": "Do less than you think",
            "hook_family": "contradiction",
            "new_viewer_understands_opening": True,
            "opens_with_context_connector": False,
            "contains_external_antecedent": False,
            "contains_host_setup": False,
            "first_second_value_score": 88,
            "specificity_score": 92,
            "relatability_score": 85,
            "stop_scroll_score": 94,
            "hook_gate_recommendation": "pass",
            "hook_gate_reasons": ["self_contained", "clear_contradiction"],
        }

    def test_missing_or_invalid_evidence_never_silently_passes(self):
        normalized = normalize_hook_gate_v2_fields(
            {
                "hook_family": "invented-family",
                "hook_gate_recommendation": "definitely-pass",
                "first_second_value_score": 140,
                "specificity_score": -3,
                "new_viewer_understands_opening": "unknown",
                "hook_gate_reasons": [
                    "self_contained",
                    "not-a-real-reason",
                    "self_contained",
                ],
            }
        )

        self.assertEqual(normalized["hook_family"], "none")
        self.assertEqual(normalized["hook_gate_recommendation"], "review")
        self.assertEqual(normalized["first_second_value_score"], 100)
        self.assertEqual(normalized["specificity_score"], 0)
        self.assertIsNone(normalized["new_viewer_understands_opening"])
        self.assertEqual(normalized["hook_gate_reasons"], ["self_contained"])

    def test_missing_scores_remain_unknown(self):
        normalized = normalize_hook_gate_v2_fields({})

        self.assertIsNone(normalized["first_second_value_score"])
        self.assertIsNone(normalized["stop_scroll_score"])
        self.assertEqual(normalized["hook_gate_recommendation"], "review")
        self.assertFalse(normalized["hook_gate_response_complete"])
        self.assertFalse(normalized["hook_gate_pass_evidence_complete"])

    def test_incomplete_pass_is_downgraded_to_review(self):
        normalized = normalize_hook_gate_v2_fields(
            {"hook_gate_recommendation": "pass"}
        )

        self.assertEqual(normalized["hook_gate_recommendation"], "review")
        self.assertFalse(normalized["hook_gate_response_complete"])
        self.assertFalse(normalized["hook_gate_pass_evidence_complete"])
        self.assertIn(
            "transcript_evidence_missing",
            normalized["hook_gate_reasons"],
        )

    def test_pass_with_contradictory_context_is_rejected(self):
        evidence = self._complete_pass_evidence()
        evidence["opens_with_context_connector"] = True
        normalized = normalize_hook_gate_v2_fields(evidence)

        self.assertTrue(normalized["hook_gate_response_complete"])
        self.assertFalse(normalized["hook_gate_pass_evidence_complete"])
        self.assertEqual(normalized["hook_gate_recommendation"], "reject")
        self.assertIn("context_connector", normalized["hook_gate_reasons"])

    def test_pass_with_no_hook_family_is_rejected(self):
        evidence = self._complete_pass_evidence()
        evidence["hook_family"] = "none"
        normalized = normalize_hook_gate_v2_fields(evidence)

        self.assertTrue(normalized["hook_gate_response_complete"])
        self.assertFalse(normalized["hook_gate_pass_evidence_complete"])
        self.assertEqual(normalized["hook_gate_recommendation"], "reject")
        self.assertIn("no_clear_tension", normalized["hook_gate_reasons"])

    def test_non_binary_numeric_boolean_is_unknown(self):
        evidence = self._complete_pass_evidence()
        evidence["new_viewer_understands_opening"] = 2
        normalized = normalize_hook_gate_v2_fields(evidence)

        self.assertIsNone(normalized["new_viewer_understands_opening"])
        self.assertFalse(normalized["hook_gate_response_complete"])
        self.assertFalse(normalized["hook_gate_pass_evidence_complete"])
        self.assertEqual(normalized["hook_gate_recommendation"], "review")

    def test_advisory_score_below_rubric_downgrades_pass_to_review(self):
        evidence = self._complete_pass_evidence()
        evidence["first_second_value_score"] = 69
        normalized = normalize_hook_gate_v2_fields(evidence)

        self.assertTrue(normalized["hook_gate_response_complete"])
        self.assertTrue(normalized["hook_gate_pass_evidence_complete"])
        self.assertEqual(normalized["hook_gate_recommendation"], "review")
        self.assertIn("slow_payoff", normalized["hook_gate_reasons"])

    def test_empty_reason_array_is_incomplete(self):
        evidence = self._complete_pass_evidence()
        evidence["hook_gate_reasons"] = []
        normalized = normalize_hook_gate_v2_fields(evidence)

        self.assertFalse(normalized["hook_gate_response_complete"])
        self.assertFalse(normalized["hook_gate_pass_evidence_complete"])
        self.assertEqual(normalized["hook_gate_recommendation"], "review")
        self.assertIn(
            "transcript_evidence_missing",
            normalized["hook_gate_reasons"],
        )


if __name__ == "__main__":
    unittest.main()
