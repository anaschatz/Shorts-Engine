import json
import unittest

from shorts_generator.highlights import call_highlight_api, get_highlights
from shorts_generator.profiles import (
    MOTIVATIONAL_PODCAST,
    MOTIVATIONAL_TENSION_MICRO_V1,
)
from shorts_generator.ranker import eligible_highlights, rank_highlights


def micro_candidate(start=0.0, end=10.5, **overrides):
    item = {
        "title": "Approval versus integrity",
        "topic": "approval and integrity",
        "thesis": "Integrity can require disappointing people.",
        "start_time": start,
        "end_time": end,
        "speech_start_time": start,
        "speech_end_time": end,
        "score": 88,
        "hook_score": 92,
        "standalone_score": 94,
        "development_score": 88,
        "takeaway_score": 94,
        "emotional_conviction_score": 88,
        "quotability_score": 91,
        "closure_score": 95,
        "title_fit_score": 92,
        "boundary_quality_score": 100,
        "has_hook": True,
        "has_development": True,
        "has_takeaway": True,
        "has_complete_ending": True,
        "is_promotional": False,
        "is_outro": False,
        "requires_previous_context": False,
        "is_standalone_one_liner": True,
        "semantic_tension_score": 92,
        "contrast_score": 94,
        "conflict_score": 90,
        "reversal_score": 84,
        "listener_payoff_score": 93,
        "self_contained_micro_arc_score": 95,
        "generic_motivation_score": 3,
        "context_dependence_score": 2,
        "reaction_tail_compatibility_score": 50,
    }
    item.update(overrides)
    return item


class MotivationalTensionMicroPromptTests(unittest.TestCase):
    def test_profile_prompt_requests_micro_arc_scores_and_reaction_evidence(self):
        prompts = []

        def fake_llm(prompt):
            prompts.append(prompt)
            return json.dumps(
                {
                    "highlights": [
                        {
                            **micro_candidate(),
                            "reaction_tail_compatible": True,
                            "reaction_tail_start_time": 10.2,
                            "reaction_tail_reason": "The listener nods after the payoff.",
                        }
                    ]
                }
            )

        result = call_highlight_api(
            "[0.0s] Being liked is not the same as being good.",
            {"content_type": MOTIVATIONAL_PODCAST, "density": "high"},
            duration=120.0,
            num_clips=2,
            llm_fn=fake_llm,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        )

        self.assertIn("TENSION -> CONTRAST/REFRAME -> LISTENER PAYOFF", prompts[0])
        self.assertIn("8-22 seconds", prompts[0])
        self.assertIn("Prefer 10-18 seconds", prompts[0])
        self.assertIn("generic_motivation_score", prompts[0])
        self.assertIn("reaction_tail_start_time", prompts[0])
        self.assertIn("Generate up to 10 distinct qualified highlights", prompts[0])
        self.assertEqual(
            result["highlights"][0]["selection_profile"],
            MOTIVATIONAL_TENSION_MICRO_V1,
        )
        self.assertEqual(
            result["highlights"][0]["reaction_tail_compatibility_score"],
            50,
        )

    def test_get_highlights_propagates_selection_profile_metadata(self):
        def fake_llm(_prompt):
            return json.dumps({"highlights": [micro_candidate()]})

        result = get_highlights(
            {
                "duration": 12.0,
                "segments": [
                    {
                        "start": 0.0,
                        "end": 10.5,
                        "text": "Approval feels kind, but integrity tells the truth.",
                    }
                ],
            },
            num_clips=1,
            llm_fn=fake_llm,
            profile_override=MOTIVATIONAL_PODCAST,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        )

        self.assertEqual(
            result["content_info"]["selection_profile"],
            MOTIVATIONAL_TENSION_MICRO_V1,
        )
        self.assertEqual(
            result["highlights"][0]["selection_policy_version"],
            MOTIVATIONAL_TENSION_MICRO_V1,
        )


class MotivationalTensionMicroRankingTests(unittest.TestCase):
    def test_specific_tension_beats_higher_scored_generic_motivation(self):
        transcript = {
            "duration": 40.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 10.5,
                    "text": (
                        "Being a nice guy is about approval, but being a good man means "
                        "doing what is right even when people dislike you."
                    ),
                },
                {
                    "start": 20.0,
                    "end": 30.5,
                    "text": (
                        "Believe in yourself and never give up. Work hard and success "
                        "will come."
                    ),
                },
            ],
        }
        specific = micro_candidate(title="Nice versus good")
        generic = micro_candidate(
            20.0,
            30.5,
            title="Never give up",
            score=99,
            hook_score=99,
            standalone_score=99,
            takeaway_score=99,
            semantic_tension_score=12,
            contrast_score=5,
            conflict_score=8,
            reversal_score=4,
            listener_payoff_score=35,
            self_contained_micro_arc_score=90,
            generic_motivation_score=96,
        )

        ranked = rank_highlights(
            [generic, specific],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        )

        self.assertEqual(eligible_highlights(ranked)[0]["title"], "Nice versus good")
        generic_ranked = next(item for item in ranked if item["title"] == "Never give up")
        self.assertIn("missing_semantic_tension", generic_ranked["rejection_reasons"])
        self.assertIn(
            "generic_motivation_without_tension",
            generic_ranked["rejection_reasons"],
        )
        self.assertGreater(generic_ranked["generic_motivation_penalty"], 20.0)

    def test_hard_duration_window_is_eight_to_twenty_two_seconds(self):
        ranked = rank_highlights(
            [
                micro_candidate(0.0, 7.9, title="Too short"),
                micro_candidate(10.0, 27.0, title="Seventeen seconds"),
                micro_candidate(30.0, 52.0, title="Twenty two seconds"),
                micro_candidate(60.0, 82.1, title="Too long"),
            ],
            {"duration": 90.0, "segments": []},
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        )

        by_title = {item["title"]: item for item in ranked}
        self.assertIn(
            "micro_duration_under_8s",
            by_title["Too short"]["rejection_reasons"],
        )
        self.assertFalse(by_title["Seventeen seconds"]["rejected"])
        self.assertFalse(by_title["Twenty two seconds"]["rejected"])
        self.assertIn(
            "micro_duration_over_22s",
            by_title["Too long"]["rejection_reasons"],
        )

    def test_context_dependence_and_weak_micro_arc_are_hard_rejections(self):
        ranked = rank_highlights(
            [
                micro_candidate(
                    title="Callback",
                    context_dependence_score=82,
                ),
                micro_candidate(
                    20.0,
                    30.5,
                    title="Open loop",
                    self_contained_micro_arc_score=42,
                ),
            ],
            {"duration": 40.0, "segments": []},
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        )

        by_title = {item["title"]: item for item in ranked}
        self.assertIn(
            "micro_context_dependent",
            by_title["Callback"]["rejection_reasons"],
        )
        self.assertIn(
            "weak_self_contained_micro_arc",
            by_title["Open loop"]["rejection_reasons"],
        )

    def test_more_than_two_measured_source_cuts_is_a_hard_rejection(self):
        ranked = rank_highlights(
            [
                micro_candidate(
                    title="Busy source edit",
                    source_cut_count=3,
                    source_scene_change_times=[2.0, 5.0, 8.0],
                ),
                micro_candidate(
                    20.0,
                    30.5,
                    title="Stable source edit",
                    source_cut_count=2,
                    source_scene_change_times=[23.0, 28.0],
                ),
            ],
            {"duration": 40.0, "segments": []},
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        )

        by_title = {item["title"]: item for item in ranked}
        self.assertIn(
            "source_cut_limit_exceeded",
            by_title["Busy source edit"]["rejection_reasons"],
        )
        self.assertFalse(by_title["Stable source edit"]["rejected"])

    def test_one_extra_natural_cut_is_allowed_only_inside_semantic_extension(self):
        completed = micro_candidate(
            title="Completed across source cut",
            source_cut_count=3,
            source_scene_change_times=[2.0, 5.0, 10.2],
            semantic_extension_applied=True,
            semantic_continuation_required=False,
            semantic_extension_start_time=10.0,
            semantic_extension_end_time=10.5,
            artificial_cut_count=0,
        )
        unrelated_extra_cut = micro_candidate(
            20.0,
            30.5,
            title="Unrelated third cut",
            source_cut_count=3,
            source_scene_change_times=[22.0, 25.0, 27.0],
            semantic_extension_applied=True,
            semantic_continuation_required=False,
            semantic_extension_start_time=29.0,
            semantic_extension_end_time=30.5,
        )

        ranked = rank_highlights(
            [completed, unrelated_extra_cut],
            {"duration": 40.0, "segments": []},
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        )
        by_title = {item["title"]: item for item in ranked}
        self.assertNotIn(
            "source_cut_limit_exceeded",
            by_title["Completed across source cut"]["rejection_reasons"],
        )
        self.assertTrue(
            by_title["Completed across source cut"][
                "semantic_completion_source_cut_exception"
            ]
        )
        self.assertEqual(
            by_title["Completed across source cut"]["effective_source_cut_limit"],
            3,
        )
        self.assertIn(
            "source_cut_limit_exceeded",
            by_title["Unrelated third cut"]["rejection_reasons"],
        )

    def test_reaction_tail_signal_breaks_an_otherwise_equal_tie(self):
        no_tail = micro_candidate(
            title="No reaction tail",
            reaction_tail_compatibility_score=5,
        )
        tail = micro_candidate(
            20.0,
            30.5,
            title="Authentic reaction tail",
            reaction_tail_compatible=True,
            reaction_tail_compatibility_score=95,
            reaction_tail_start_time=30.1,
            reaction_tail_reason="The listener smiles after the resolved line.",
        )

        ranked = rank_highlights(
            [no_tail, tail],
            {"duration": 40.0, "segments": []},
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        )

        self.assertEqual(ranked[0]["title"], "Authentic reaction tail")
        self.assertGreater(ranked[0]["final_score"], ranked[1]["final_score"])
        self.assertEqual(
            ranked[0]["selection_score_components"][
                "reaction_tail_compatibility_score"
            ],
            95.0,
        )
        self.assertIn("semantic_score", ranked[0]["selection_score_components"])

    def test_legacy_motivational_duration_guardrail_is_unchanged(self):
        ten_second = micro_candidate()
        legacy = rank_highlights(
            [ten_second],
            {"duration": 20.0, "segments": []},
            content_type=MOTIVATIONAL_PODCAST,
        )[0]
        micro = rank_highlights(
            [ten_second],
            {"duration": 20.0, "segments": []},
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        )[0]

        self.assertIn("duration_under_14s", legacy["rejection_reasons"])
        self.assertFalse(micro["rejected"])


if __name__ == "__main__":
    unittest.main()
