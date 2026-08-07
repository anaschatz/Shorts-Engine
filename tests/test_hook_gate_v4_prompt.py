import json
import unittest
from unittest.mock import patch

from shorts_generator.highlights import (
    BF_FEED_STOP_V1,
    BF_FEED_STOP_V2,
    HOOK_GATE_V4_PROMPT_VERSION,
    HOOK_GATE_V4_REASON_CODES,
    _build_highlight_prompt,
    _discovery_prompt_contract,
    _sanitize_highlights,
    align_motivational_boundaries,
    call_highlight_api,
)
from shorts_generator.local.llm import (
    HOOK_GATE_V4_PROMPT_VERSION as TRANSPORT_HOOK_GATE_V4_PROMPT_VERSION,
)


def v4_candidate():
    return {
        "title": "You do not owe every argument a response",
        "speech_start_time": 0.0,
        "speech_end_time": 13.0,
        "start_time": 0.0,
        "end_time": 13.0,
        "score": 94,
        "hook_sentence": "Don't attend every argument you're invited to.",
        "hook_payoff_phrase": "does not mean you must answer",
        "opening_unit_exact_quote": (
            "Don't attend every argument you're invited to."
        ),
        "topic_comprehension_exact_quote": (
            "Don't attend every argument you're invited to."
        ),
        "payoff_exact_quote": (
            "does not mean that you must give your opinion right back."
        ),
        "opening_unit_type": "rule",
        "hook_mechanism": "concrete_rule",
        "hook_semantic_topic": "choosing not to engage in arguments",
        "opening_claim_summary": "You need not enter every argument.",
        "whole_point_summary": (
            "Another person's opinion does not obligate a response."
        ),
        "opening_sentence_clarity_score": 96,
        "topic_explicitness_score": 94,
        "standalone_comprehension_score": 97,
        "tension_or_relevance_score": 91,
        "opening_point_coherence_score": 95,
        "payoff_resolution_score": 94,
        "single_idea_focus_score": 98,
        "lexical_delivery_strength_score": 93,
        "hook_semantic_confidence_score": 95,
        "opening_unit_is_complete_claim": True,
        "requires_external_context": False,
        "unresolved_deictic_reference": False,
        "host_or_attribution_setup": False,
        "topic_intro_only": False,
        "payoff_changes_topic": False,
        "hook_semantic_reason_codes": [
            "clear_complete_claim",
            "topic_explicit_by_opening_end",
            "standalone_without_prior_context",
            "specific_rule_or_consequence",
            "opening_and_payoff_coherent",
            "payoff_resolves_opening",
            "single_focused_idea",
        ],
    }


class HookGateV4PromptTests(unittest.TestCase):
    def test_prompt_and_transport_share_the_version_marker(self):
        self.assertEqual(
            HOOK_GATE_V4_PROMPT_VERSION,
            TRANSPORT_HOOK_GATE_V4_PROMPT_VERSION,
        )

    def test_v4_prompt_scores_the_whole_opening_and_whole_point(self):
        prompt, profile = _build_highlight_prompt(
            "[0.0s] Don't attend every argument you're invited to.",
            {"content_type": "motivational_podcast", "density": "high"},
            duration=30.0,
            num_clips=1,
            is_chunk=False,
            selection_profile=BF_FEED_STOP_V2,
        )

        self.assertEqual(profile, BF_FEED_STOP_V2)
        self.assertIn(HOOK_GATE_V4_PROMPT_VERSION, prompt)
        self.assertNotIn("HookGate V3 / bf_feed_stop_v1:", prompt)
        self.assertIn("complete first independent spoken proposition", prompt)
        self.assertIn("Do not decide hook quality from a fixed number", prompt)
        self.assertIn("Then read the complete selected interval", prompt)
        self.assertIn("exact prefix from speech start", prompt)
        self.assertIn("final spoken token of the selected interval", prompt)
        self.assertIn("Do not infer volume, emotion", prompt)
        self.assertIn("lexical_delivery_strength_score", prompt)
        self.assertIn("HOOK GATE V4 AUTHORITATIVE FINAL RESPONSE EXTENSION", prompt)
        self.assertEqual(
            prompt.count("HOOK GATE V4 AUTHORITATIVE FINAL RESPONSE EXTENSION"),
            1,
        )
        for field in (
            "opening_unit_exact_quote",
            "topic_comprehension_exact_quote",
            "payoff_exact_quote",
            "opening_sentence_clarity_score",
            "opening_point_coherence_score",
            "whole_point_summary",
            "hook_semantic_reason_codes",
        ):
            self.assertIn(field, prompt)

    def test_v1_prompt_path_does_not_gain_v4_fields(self):
        prompt, _ = _build_highlight_prompt(
            "[0.0s] Existing source speech.",
            {"content_type": "motivational_podcast", "density": "high"},
            duration=30.0,
            num_clips=1,
            is_chunk=False,
            selection_profile=BF_FEED_STOP_V1,
        )

        self.assertIn("HookGate V3 / bf_feed_stop_v1:", prompt)
        self.assertNotIn(HOOK_GATE_V4_PROMPT_VERSION, prompt)
        self.assertNotIn("opening_unit_exact_quote", prompt)

    def test_v4_discovery_contract_is_deterministic_and_isolated(self):
        first = _discovery_prompt_contract(BF_FEED_STOP_V2)
        second = _discovery_prompt_contract(BF_FEED_STOP_V2)

        self.assertEqual(first, second)
        self.assertNotEqual(first, _discovery_prompt_contract(BF_FEED_STOP_V1))
        self.assertEqual(len(first), 64)

    def test_api_preserves_complete_v4_semantic_evidence(self):
        prompts = []

        def fake_llm(prompt):
            prompts.append(prompt)
            return json.dumps({"highlights": [v4_candidate()]})

        result = call_highlight_api(
            "[0.0s] Don't attend every argument you're invited to.",
            {"content_type": "motivational_podcast", "density": "high"},
            duration=30.0,
            num_clips=1,
            llm_fn=fake_llm,
            selection_profile=BF_FEED_STOP_V2,
        )

        self.assertEqual(len(prompts), 1)
        self.assertIn(HOOK_GATE_V4_PROMPT_VERSION, prompts[0])
        candidate = result["highlights"][0]
        self.assertEqual(candidate["selection_profile"], BF_FEED_STOP_V2)
        self.assertEqual(candidate["selection_policy_version"], BF_FEED_STOP_V2)
        self.assertEqual(
            candidate["opening_unit_exact_quote"],
            "Don't attend every argument you're invited to.",
        )
        self.assertEqual(candidate["opening_unit_type"], "rule")
        self.assertEqual(candidate["hook_mechanism"], "concrete_rule")
        self.assertEqual(candidate["opening_sentence_clarity_score"], 96)
        self.assertTrue(candidate["opening_unit_is_complete_claim"])
        self.assertEqual(
            candidate["hook_semantic_reason_codes"],
            v4_candidate()["hook_semantic_reason_codes"],
        )
        self.assertEqual(
            candidate["hook_gate_prompt_version"],
            HOOK_GATE_V4_PROMPT_VERSION,
        )

    def test_missing_v4_evidence_is_not_filled_from_legacy_fields(self):
        [candidate] = _sanitize_highlights(
            [
                {
                    "speech_start_time": 0.0,
                    "speech_end_time": 12.0,
                    "hook_sentence": "A legacy hook sentence.",
                    "hook_score": 99,
                }
            ],
            duration=20.0,
            selection_profile=BF_FEED_STOP_V2,
        )

        self.assertEqual(candidate["opening_unit_exact_quote"], "")
        self.assertEqual(candidate["topic_comprehension_exact_quote"], "")
        self.assertEqual(candidate["payoff_exact_quote"], "")
        self.assertIsNone(candidate["opening_sentence_clarity_score"])
        self.assertIsNone(candidate["opening_unit_is_complete_claim"])
        self.assertEqual(candidate["hook_semantic_reason_codes"], [])

    def test_sanitizer_bounds_scores_and_filters_reason_codes(self):
        raw = v4_candidate()
        raw["opening_sentence_clarity_score"] = 140
        raw["hook_semantic_confidence_score"] = -2
        raw["hook_semantic_reason_codes"] = [
            "clear_complete_claim",
            "invented_reason",
            "clear_complete_claim",
            *HOOK_GATE_V4_REASON_CODES[1:10],
        ]

        [candidate] = _sanitize_highlights(
            [raw],
            duration=30.0,
            selection_profile=BF_FEED_STOP_V2,
        )

        self.assertEqual(candidate["opening_sentence_clarity_score"], 100)
        self.assertEqual(candidate["hook_semantic_confidence_score"], 0)
        self.assertEqual(len(candidate["hook_semantic_reason_codes"]), 8)
        self.assertNotIn(
            "invented_reason",
            candidate["hook_semantic_reason_codes"],
        )

    def test_alignment_routes_v2_and_uses_complete_opening_unit_prefix(self):
        words = [
            {"start": 0.0, "end": 0.2, "word": "Well,"},
            {"start": 0.2, "end": 0.5, "word": "Don't"},
            {"start": 0.5, "end": 0.8, "word": "attend"},
            {"start": 0.8, "end": 1.1, "word": "every"},
            {"start": 1.1, "end": 1.5, "word": "argument."},
        ]
        transcript = {
            "duration": 2.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 1.5,
                    "text": "Well, Don't attend every argument.",
                    "words": words,
                }
            ],
        }
        candidate = {
            "selection_profile": BF_FEED_STOP_V2,
            "selection_policy_version": BF_FEED_STOP_V2,
            "start_time": 0.0,
            "end_time": 1.5,
            "speech_start_time": 0.0,
            "speech_end_time": 1.5,
            # If the legacy field won, alignment would incorrectly keep 0.0s.
            "hook_sentence": "Well",
            "opening_unit_exact_quote": "Don't attend every argument.",
        }

        with patch(
            "shorts_generator.highlights.evaluate_hook_gate_v4_cached",
            side_effect=lambda item, **_: {**item, "hookGateVersion": "v4-called"},
        ) as evaluate_v4, patch(
            "shorts_generator.highlights.evaluate_motivational_closure_v1",
            side_effect=lambda item, **_: item,
        ):
            [result] = align_motivational_boundaries([candidate], transcript)

        self.assertEqual(result["speech_start_time"], 0.2)
        self.assertEqual(result["hookGateVersion"], "v4-called")
        self.assertEqual(evaluate_v4.call_count, 1)
        evaluated_candidate = evaluate_v4.call_args.args[0]
        self.assertEqual(evaluated_candidate["speech_start_time"], 0.2)


if __name__ == "__main__":
    unittest.main()
