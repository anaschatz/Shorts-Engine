import copy
import unittest

from shorts_generator.dynamic_music import (
    DYNAMIC_MUSIC_MAX_GAIN,
    DYNAMIC_MUSIC_MIN_GAIN,
    DYNAMIC_MUSIC_MIN_TRANSITION_SECONDS,
    DYNAMIC_MUSIC_PLAN_VERSION,
    build_dynamic_music_plan,
    resolve_semantic_music_anchors,
    validate_dynamic_music_plan,
    volume_filter_from_plan,
)


def word_cues(text, start=0.05, word_seconds=0.22, gap_seconds=0.02):
    cues = []
    cursor = start
    sentence_id = 0
    phrase_id = 0
    for raw in text.split():
        end = cursor + word_seconds
        cues.append(
            {
                "text": raw,
                "start": cursor,
                "end": end,
                "spoken_start": cursor,
                "spoken_end": end,
                "sentence_id": sentence_id,
                "phrase_id": phrase_id,
            }
        )
        if raw.endswith((".", "?", "!")):
            sentence_id += 1
            phrase_id += 1
        elif len(cues) % 4 == 0:
            phrase_id += 1
        cursor = end + gap_seconds
    return cues


class DynamicMusicPlanTests(unittest.TestCase):
    def setUp(self):
        self.text = (
            "Don't attend every argument you're invited to. Just because "
            "somebody pushes an opinion does not mean you owe one back."
        )
        self.cues = word_cues(self.text)
        self.candidate = {
            "music_profile": "reflective",
            "hook_sentence": "Don't attend every argument you're invited to.",
            "hook_payoff_phrase": "Just because somebody pushes an opinion",
            "final_takeaway_sentence": "does not mean you owe one back.",
        }

    def test_exact_phrases_drive_hook_and_payoff_anchors(self):
        anchors = resolve_semantic_music_anchors(
            self.candidate,
            self.cues,
            duration=6.0,
            speech_end_seconds=4.85,
            natural_tail_end_seconds=5.40,
        )

        self.assertEqual(anchors["hookSource"], "hook_sentence_phrase")
        self.assertEqual(anchors["payoffSource"], "hook_payoff_phrase")
        self.assertAlmostEqual(anchors["hookEndSeconds"], 1.71, places=2)
        self.assertAlmostEqual(anchors["payoffStartSeconds"], 1.73, places=2)
        self.assertAlmostEqual(anchors["payoffEndSeconds"], 3.15, places=2)
        self.assertEqual(anchors["fallbackReasons"], [])

    def test_hookgate_v4_opening_and_payoff_quotes_are_authoritative(self):
        candidate = {
            **self.candidate,
            # Deliberately make both legacy fields point somewhere else.  The
            # V4 semantic units must be the musical anchors.
            "hook_sentence": "Just because somebody pushes an opinion",
            "hook_payoff_phrase": "Don't attend every argument",
            "opening_unit_exact_quote": (
                "Don't attend every argument you're invited to."
            ),
            "payoff_exact_quote": "does not mean you owe one back.",
            "strong_point_phrase": None,
        }
        anchors = resolve_semantic_music_anchors(
            candidate,
            self.cues,
            duration=6.0,
            speech_end_seconds=4.85,
            natural_tail_end_seconds=5.40,
        )

        self.assertEqual(anchors["hookSource"], "opening_unit_exact_quote")
        self.assertEqual(anchors["payoffSource"], "payoff_exact_quote")
        self.assertAlmostEqual(anchors["hookEndSeconds"], 1.71, places=2)
        self.assertGreater(anchors["payoffStartSeconds"], 3.0)
        self.assertEqual(anchors["fallbackReasons"], [])

    def test_plan_is_deterministic_contiguous_and_bounded(self):
        first = build_dynamic_music_plan(
            self.candidate,
            self.cues,
            duration=6.0,
            speech_end_seconds=4.85,
            natural_tail_end_seconds=5.40,
        )
        second = build_dynamic_music_plan(
            copy.deepcopy(self.candidate),
            copy.deepcopy(self.cues),
            duration=6.0,
            speech_end_seconds=4.85,
            natural_tail_end_seconds=5.40,
        )

        self.assertEqual(first, second)
        self.assertEqual(first["planVersion"], DYNAMIC_MUSIC_PLAN_VERSION)
        self.assertFalse(first["constraints"]["randomEffectsAllowed"])
        self.assertFalse(first["constraints"]["soundEffectsAllowed"])
        self.assertFalse(first["constraints"]["visualEventsAllowed"])
        previous_end = 0.0
        previous_gain = None
        for event in first["events"]:
            self.assertAlmostEqual(event["startSeconds"], previous_end, places=3)
            self.assertGreaterEqual(
                event["endSeconds"] - event["startSeconds"],
                DYNAMIC_MUSIC_MIN_TRANSITION_SECONDS - 0.001,
            )
            self.assertGreaterEqual(event["startGain"], DYNAMIC_MUSIC_MIN_GAIN)
            self.assertLessEqual(event["endGain"], DYNAMIC_MUSIC_MAX_GAIN)
            if previous_gain is not None:
                self.assertAlmostEqual(event["startGain"], previous_gain, places=3)
            previous_end = event["endSeconds"]
            previous_gain = event["endGain"]
        self.assertAlmostEqual(previous_end, 5.40, places=3)

    def test_plan_contains_restrained_semantic_arc(self):
        plan = build_dynamic_music_plan(
            self.candidate,
            self.cues,
            duration=6.0,
            speech_end_seconds=4.85,
            natural_tail_end_seconds=5.40,
        )
        by_type = {event["type"]: event for event in plan["events"]}

        self.assertIn("semantic_build", by_type)
        self.assertIn("clarity_pocket", by_type)
        self.assertIn("stable_emphasis", by_type)
        self.assertIn("controlled_release", by_type)
        self.assertIn("natural_tail_hold", by_type)
        self.assertGreater(
            by_type["semantic_build"]["endGain"],
            by_type["clarity_pocket"]["endGain"],
        )
        self.assertGreater(
            by_type["stable_emphasis"]["endGain"],
            by_type["controlled_release"]["endGain"],
        )

    def test_ffmpeg_filter_uses_only_continuous_linear_ramps(self):
        plan = build_dynamic_music_plan(
            self.candidate,
            self.cues,
            duration=6.0,
            speech_end_seconds=4.85,
            natural_tail_end_seconds=5.40,
        )
        compiled = volume_filter_from_plan(plan)

        self.assertTrue(compiled.startswith("volume='if(lt(t,"))
        self.assertTrue(compiled.endswith("':eval=frame"))
        self.assertIn("*(t-", compiled)
        self.assertNotIn("random", compiled.lower())
        self.assertNotIn("sin(", compiled.lower())

    def test_nested_hookgate_measurements_are_explicit_fallbacks(self):
        candidate = {
            "hookGateReport": {
                "measurements": {
                    "firstClauseEndSeconds": 1.7,
                    "firstPayoffSeconds": 3.2,
                }
            }
        }
        anchors = resolve_semantic_music_anchors(
            candidate,
            [],
            duration=10.0,
            speech_end_seconds=9.2,
        )

        self.assertEqual(anchors["hookEndSeconds"], 1.7)
        self.assertEqual(anchors["payoffStartSeconds"], 3.2)
        self.assertIn("hook:hook_gate_first_clause", anchors["fallbackReasons"])
        self.assertIn("payoff:hook_gate_first_payoff", anchors["fallbackReasons"])

    def test_absolute_candidate_timings_are_made_clip_relative(self):
        candidate = {
            "start_time": 100.0,
            "hook_sentence_end_seconds": 101.5,
            "payoff_start_seconds": 103.0,
            "payoff_end_seconds": 104.0,
        }
        anchors = resolve_semantic_music_anchors(
            candidate,
            [],
            duration=10.0,
            speech_end_seconds=9.0,
        )

        self.assertEqual(anchors["hookEndSeconds"], 1.5)
        self.assertEqual(anchors["payoffStartSeconds"], 3.0)
        self.assertEqual(anchors["payoffEndSeconds"], 4.0)

    def test_missing_semantics_fail_visibly_to_bounded_defaults(self):
        anchors = resolve_semantic_music_anchors(
            {},
            [],
            duration=10.0,
            speech_end_seconds=9.0,
        )

        self.assertEqual(anchors["hookSource"], "duration_fallback")
        self.assertEqual(anchors["payoffSource"], "duration_fallback")
        self.assertEqual(anchors["hookEndSeconds"], 2.0)
        self.assertEqual(anchors["payoffStartSeconds"], 6.48)
        self.assertEqual(len(anchors["fallbackReasons"]), 2)

    def test_early_payoff_folds_short_phases_without_gaps(self):
        candidate = {
            "hook_sentence_end_seconds": 0.18,
            "payoff_start_seconds": 0.22,
            "payoff_end_seconds": 0.50,
            "music_profile": "driving",
        }
        plan = build_dynamic_music_plan(
            candidate,
            [],
            duration=8.0,
            speech_end_seconds=7.4,
            natural_tail_end_seconds=7.9,
        )

        validate_dynamic_music_plan(plan)
        self.assertEqual(plan["events"][0]["startSeconds"], 0.0)
        self.assertEqual(plan["events"][-1]["endSeconds"], 7.9)

    def test_invalid_profile_and_invalid_plan_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "unknown dynamic music profile"):
            build_dynamic_music_plan(
                {}, [], 10.0, 9.0, music_profile="explosive"
            )

        plan = build_dynamic_music_plan({}, [], 10.0, 9.0)
        plan["events"][1]["startGain"] = DYNAMIC_MUSIC_MAX_GAIN
        with self.assertRaisesRegex(ValueError, "gain discontinuity"):
            validate_dynamic_music_plan(plan)

    def test_invalid_duration_and_speech_end_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "duration"):
            resolve_semantic_music_anchors({}, [], 0.0, 0.0)
        with self.assertRaisesRegex(ValueError, "speech_end_seconds"):
            resolve_semantic_music_anchors({}, [], 10.0, 11.0)


if __name__ == "__main__":
    unittest.main()
