import json
import unittest
from pathlib import Path

from shorts_generator.ranker import (
    candidate_text,
    emotional_tension_bonus,
    eligible_highlights,
    gaming_language_signals,
    rank_highlights,
    select_diverse_highlights,
)
from shorts_generator.pipeline import resolve_clip_count


FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "aircAruvnKk_selection.json").read_text()
)


def candidate(start, end, **overrides):
    base = {
        "title": "Candidate",
        "start_time": start,
        "end_time": end,
        "speech_start_time": start,
        "speech_end_time": end,
        "score": 80,
        "hook_score": 80,
        "standalone_score": 80,
        "payoff_score": 80,
        "educational_value_score": 80,
        "visual_action_score": 50,
        "boundary_quality_score": 100,
        "is_promotional": False,
        "is_outro": False,
        "requires_previous_context": False,
        "is_standalone_one_liner": False,
    }
    base.update(overrides)
    return base


class RankerRegressionTests(unittest.TestCase):
    def setUp(self):
        self.transcript = {
            "duration": 1106.78,
            "segments": [
                {
                    "start": 762.42,
                    "end": 804.6,
                    "text": (
                        "One thought experiment that is at once fun and kind of horrifying "
                        "is to imagine setting all of these weights and biases by hand. "
                        "Understanding them gives you a starting place for improving the network."
                    ),
                },
                {
                    "start": 986.7,
                    "end": 1010.7,
                    "text": (
                        "Subscribe to stay notified. Most of you do not receive notifications. "
                        "Subscribe so this channel gets recommended to you. Stay posted for more."
                    ),
                },
            ],
        }

    def test_promotional_outro_is_rejected_despite_higher_model_score(self):
        preferred = FIXTURE["preferred"][0]
        rejected = FIXTURE["hard_reject"][0]
        ranked = rank_highlights(
            [
                candidate(
                    rejected["start"],
                    rejected["end"],
                    title="Algorithm hack",
                    score=95,
                    hook_score=95,
                ),
                candidate(
                    preferred["start"],
                    preferred["end"],
                    title="Manual tuning",
                    score=88,
                    hook_score=92,
                    standalone_score=95,
                    payoff_score=94,
                    educational_value_score=96,
                ),
            ],
            self.transcript,
            content_type="tutorial",
        )

        self.assertEqual(eligible_highlights(ranked)[0]["title"], "Manual tuning")
        outro = next(item for item in ranked if item["title"] == "Algorithm hack")
        self.assertTrue(outro["rejected"])
        self.assertIn("promotional_language", outro["rejection_reasons"])

    def test_emotional_tension_bonus_is_small_and_deterministic(self):
        self.assertEqual(
            emotional_tension_bonus("This thought experiment is fun and horrifying."),
            4.0,
        )
        self.assertEqual(emotional_tension_bonus("A neutral technical definition."), 0.0)

    def test_short_clip_requires_explicit_one_liner_flag(self):
        transcript = {
            "duration": 60.0,
            "segments": [{"start": 0.0, "end": 10.0, "text": "A complete insight."}],
        }
        rejected = rank_highlights([candidate(0.0, 10.0)], transcript)[0]
        accepted = rank_highlights(
            [candidate(0.0, 10.0, is_standalone_one_liner=True)],
            transcript,
        )[0]

        self.assertTrue(rejected["rejected"])
        self.assertFalse(accepted["rejected"])

    def test_late_position_is_only_a_small_penalty(self):
        transcript = {
            "duration": 100.0,
            "segments": [{"start": 92.0, "end": 100.0, "text": "A substantive ending insight."}],
        }
        ranked = rank_highlights(
            [candidate(70.0, 95.0, educational_value_score=95)],
            transcript,
            content_type="tutorial",
        )
        self.assertFalse(ranked[0]["rejected"])

    def test_educational_duration_override_cannot_exceed_ninety_seconds(self):
        transcript = {
            "duration": 180.0,
            "segments": [{"start": 0.0, "end": 95.0, "text": "A long complete lesson."}],
        }
        ranked = rank_highlights(
            [candidate(0.0, 95.0, max_duration_seconds=180.0)],
            transcript,
            content_type="tutorial",
        )[0]

        self.assertTrue(ranked["rejected"])
        self.assertIn("duration_over_limit", ranked["rejection_reasons"])

    def test_composite_semantic_quality_guardrails_are_hard_rejections(self):
        item = candidate(
            0.0,
            76.0,
            source_beats=[{"speech_start_time": 0.0, "speech_end_time": 1.0}] * 7,
            composite_duration_seconds=76.0,
            duplicate_claim_count=1,
            dangling_context=True,
            final_takeaway_present=False,
        )
        ranked = rank_highlights(
            [item],
            {"duration": 100.0, "segments": []},
            content_type="tutorial",
        )[0]

        self.assertTrue(ranked["rejected"])
        self.assertIn("too_many_composite_beats", ranked["rejection_reasons"])
        self.assertIn("duplicate_claims", ranked["rejection_reasons"])
        self.assertIn("dangling_context", ranked["rejection_reasons"])
        self.assertIn("missing_final_takeaway", ranked["rejection_reasons"])

    def test_small_next_video_tail_is_penalized_not_hard_rejected(self):
        transcript = {
            "duration": 100.0,
            "segments": [
                {
                    "start": 20.0,
                    "end": 60.0,
                    "text": (
                        "This complete explanation contains a useful technical payoff and several "
                        "concrete details. I will show the next step in the next video."
                    ),
                }
            ],
        }
        ranked = rank_highlights([candidate(20.0, 60.0)], transcript)

        self.assertFalse(ranked[0]["rejected"])
        self.assertLess(ranked[0]["final_score"], 80.0)

    def test_static_garage_menu_is_rejected_for_gaming(self):
        transcript = {
            "duration": 120.0,
            "segments": [
                {
                    "start": 10.0,
                    "end": 45.0,
                    "text": "We are choosing upgrades in the garage menu before the race.",
                }
            ],
        }
        ranked = rank_highlights(
            [
                candidate(
                    10.0,
                    45.0,
                    measured_visual_action_score=8.0,
                    visual_metrics={"static_frame_ratio": 0.92},
                )
            ],
            transcript,
            content_type="gaming",
        )[0]

        self.assertTrue(ranked["rejected"])
        self.assertIn("static_menu_or_loading", ranked["rejection_reasons"])

    def test_gta_action_arc_beats_setup_and_reaction_only(self):
        transcript = {
            "duration": 150.0,
            "segments": [
                {"start": 10.0, "end": 42.0, "text": "We wait in the lobby and choose a loadout."},
                {
                    "start": 55.0,
                    "end": 103.0,
                    "text": (
                        "The police helicopter starts the chase. We take the shortcut, jump "
                        "the barrier, land on the train, and get away."
                    ),
                },
                {"start": 110.0, "end": 138.0, "text": "Oh my god, no way, that was insane."},
            ],
        }
        ranked = rank_highlights(
            [
                candidate(10.0, 42.0, title="Loadout", measured_visual_action_score=10),
                candidate(
                    55.0,
                    103.0,
                    title="Train escape",
                    hook_score=92,
                    payoff_score=96,
                    measured_visual_action_score=95,
                    visual_metrics={"static_frame_ratio": 0.05},
                ),
                candidate(
                    110.0,
                    138.0,
                    title="Reaction",
                    measured_visual_action_score=20,
                ),
            ],
            transcript,
            content_type="gaming",
        )

        self.assertEqual(eligible_highlights(ranked)[0]["title"], "Train escape")
        self.assertGreater(eligible_highlights(ranked)[0]["gaming_arc_score"], 70.0)
        reaction = next(item for item in ranked if item["title"] == "Reaction")
        self.assertIn("reaction_without_visible_cause", reaction["rejection_reasons"])

    def test_gaming_duration_cannot_override_seventy_five_seconds(self):
        ranked = rank_highlights(
            [candidate(0.0, 80.0, max_duration_seconds=120.0)],
            {"duration": 100.0, "segments": []},
            content_type="gaming",
        )[0]

        self.assertTrue(ranked["rejected"])
        self.assertIn("duration_over_limit", ranked["rejection_reasons"])

    def test_gaming_language_signals_require_cause_not_only_reaction(self):
        reaction = gaming_language_signals("Oh my god, no way, what just happened?")
        action = gaming_language_signals("The police chase ends when we escaped over the bridge.")

        self.assertTrue(reaction["reaction_without_cause"])
        self.assertFalse(action["reaction_without_cause"])
        self.assertTrue(action["gaming_action_hits"])
        self.assertTrue(action["gaming_outcome_hits"])

    def test_gaming_candidate_requires_complete_model_reported_arc(self):
        ranked = rank_highlights(
            [
                candidate(
                    10.0,
                    50.0,
                    narrative_coherence_score=50,
                    has_clear_setup=False,
                    has_visible_cause=True,
                    has_complete_outcome=False,
                )
            ],
            {"duration": 80.0, "segments": []},
            content_type="gaming",
        )[0]

        self.assertTrue(ranked["rejected"])
        self.assertIn("low_narrative_coherence", ranked["rejection_reasons"])
        self.assertIn("missing_clear_setup", ranked["rejection_reasons"])
        self.assertIn("missing_complete_outcome", ranked["rejection_reasons"])

    def test_gaming_candidate_requires_escalation_for_micro_story(self):
        ranked = rank_highlights(
            [
                candidate(
                    10.0,
                    50.0,
                    micro_story_score=52,
                    has_escalation=False,
                )
            ],
            {"duration": 80.0, "segments": []},
            content_type="gaming",
        )[0]

        self.assertTrue(ranked["rejected"])
        self.assertIn("weak_micro_story", ranked["rejection_reasons"])
        self.assertIn("missing_escalation", ranked["rejection_reasons"])

    def test_auto_clip_count_scales_for_long_video_but_stays_bounded(self):
        self.assertEqual(resolve_clip_count(None, 2755.0), 8)
        self.assertEqual(resolve_clip_count(None, 300.0), 1)
        self.assertEqual(resolve_clip_count(None, 10000.0), 8)
        self.assertEqual(resolve_clip_count(4, 2755.0), 4)

    def test_candidate_text_excludes_words_outside_exact_speech_boundary(self):
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 13.0,
                    "text": "Complete ending. Oh next thought",
                    "words": [
                        {"start": 10.0, "end": 10.5, "word": "Complete"},
                        {"start": 10.5, "end": 11.0, "word": "ending."},
                        {"start": 11.5, "end": 11.8, "word": "Oh"},
                        {"start": 11.8, "end": 12.2, "word": "next"},
                        {"start": 12.2, "end": 13.0, "word": "thought"},
                    ],
                }
            ]
        }

        text = candidate_text(
            {"speech_start_time": 10.0, "speech_end_time": 11.0},
            transcript,
        )

        self.assertEqual(text, "Complete ending.")

    def test_batch_selection_keeps_rank_order_and_removes_duplicate_stories(self):
        ranked = [
            {
                **candidate(100.0, 145.0, title="Bridge escape"),
                "candidate_text": "Police chase over the bridge ends with a clean escape downtown.",
                "final_score": 95.0,
                "rejected": False,
            },
            {
                **candidate(110.0, 150.0, title="Same bridge escape"),
                "candidate_text": "Police chase over the bridge ends with a clean escape downtown.",
                "final_score": 93.0,
                "rejected": False,
            },
            {
                **candidate(600.0, 642.0, title="Casino comeback"),
                "candidate_text": "The final casino hand turns a complete loss into a comeback win.",
                "final_score": 89.0,
                "rejected": False,
            },
        ]

        selected = select_diverse_highlights(ranked, limit=3)

        self.assertEqual([item["title"] for item in selected], ["Bridge escape", "Casino comeback"])
        self.assertEqual([item["output_rank"] for item in selected], [1, 2])
        self.assertEqual(ranked[1]["batch_exclusion_reason"], "overlaps_higher_ranked_clip")


if __name__ == "__main__":
    unittest.main()
