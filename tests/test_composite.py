import unittest

from shorts_generator.composite import (
    COMPOSITE_TRANSITION_SECONDS,
    MAX_COMPOSITE_BEATS,
    MAX_COMPOSITE_SECONDS,
    PREFERRED_COMPOSITE_MAX_SECONDS,
    PREFERRED_COMPOSITE_MIN_SECONDS,
    plan_educational_composite,
)
from shorts_generator.local.clipper import (
    _build_word_cues,
    _composite_encode_command,
    _raw_video_command,
)
from shorts_generator.ranker import eligible_highlights, rank_highlights
from shorts_generator.semantic_closure import resolve_semantic_endpoint


def sentence(start, end, text):
    tokens = text.split()
    step = (end - start) / len(tokens)
    words = [
        {"word": token, "start": start + index * step, "end": start + (index + 1) * step}
        for index, token in enumerate(tokens)
    ]
    return {"start": start, "end": end, "text": text, "words": words}


class EducationalCompositeTests(unittest.TestCase):
    def setUp(self):
        self.transcript = {
            "duration": 660.0,
            "segments": [
                sentence(4.06, 5.30, "This is a 3."),
                sentence(5.80, 13.62, "It is low resolution but your brain recognizes the pixels as a 3."),
                sentence(14.18, 19.04, "Brains can do this effortlessly."),
                sentence(49.0, 66.1, "But writing a program for the same task is dauntingly difficult."),
                sentence(66.94, 74.6, "Unless you live under a rock this video introduction continues."),
                sentence(163.26, 166.76, "As the name suggests neural networks are inspired by the brain."),
                sentence(167.3, 168.4, "But let's break that down."),
                sentence(168.4, 171.64, "What are the neurons and how are they linked together?"),
                sentence(172.44, 180.34, "A neuron is a thing that holds a number between zero and one."),
                sentence(183.44, 194.14, "For example 784 neurons correspond to pixels of the input image."),
                sentence(194.14, 203.86, "Each input neuron holds a grayscale number from black pixels to white pixels."),
                sentence(204.5, 221.52, "These activations form the first layer."),
                sentence(226.22, 231.2, "Now jumping to the last layer its neurons represent the digits."),
                sentence(231.92, 242.02, "Their activation represents how much the system thinks an image is a given digit."),
                sentence(297.90, 303.2, "This network has already been trained to recognize digits."),
                sentence(303.64, 322.02, "If you feed an input image into the network its neurons cause patterns in each layer and finally a pattern in the output layer."),
                sentence(322.50, 329.36, "The brightest output neuron is the network's choice for the digit this image represents."),
                sentence(548.56, 555.48, "What we'll do is assign a weight to each connection between our neuron and the input neurons."),
                sentence(556.02, 557.56, "These weights are numbers."),
                sentence(558.52, 565.26, "Then compute the activations' weighted sum according to these weights."),
                sentence(614.32, 623.40, "When you compute a weighted sum like this it can be any number but activations must be between zero and one."),
                sentence(624.08, 631.78, "A function squishes the weighted sum into the range between zero and one."),
                sentence(632.54, 646.44, "The sigmoid function maps negative inputs near zero and positive inputs near one."),
                sentence(649.10, 656.16, "So the activation is basically a measure of how positive the relevant weighted sum is."),
            ],
        }
        self.candidate = {
            "title": "Digit recognition",
            "start_time": 0.0,
            "end_time": 49.04,
            "payoff_score": 99,
            "hook_score": 95,
            "standalone_score": 90,
            "educational_value_score": 95,
            "visual_action_score": 70,
            "boundary_quality_score": 100,
        }

    def test_problem_escalation_is_not_payoff_even_with_model_score(self):
        contiguous = resolve_semantic_endpoint(self.candidate, self.transcript)
        self.assertEqual(contiguous["arc_stage_at_end"], "problem_escalation")
        self.assertFalse(contiguous["payoff_present"])
        self.assertTrue(contiguous["composite_required"])
        self.assertFalse(contiguous["resolution_answers_hook"])

    def test_composite_is_compact_complete_and_non_redundant(self):
        contiguous = resolve_semantic_endpoint(self.candidate, self.transcript)
        composite = plan_educational_composite(contiguous, self.transcript)

        self.assertTrue(composite["composite_plan_valid"])
        self.assertEqual(
            [beat["role"] for beat in composite["source_beats"]],
            [
                "hook",
                "definition",
                "demonstration",
                "connection_mechanism",
                "activation_transform",
                "payoff",
            ],
        )
        self.assertTrue(
            all(beat["layout_hint"] == "presentation" for beat in composite["source_beats"])
        )
        self.assertEqual(
            [(beat["speech_start_time"], beat["speech_end_time"]) for beat in composite["source_beats"]],
            [
                (4.06, 13.62),
                (167.3, 180.34),
                (303.64, 322.02),
                (548.56, 565.26),
                (624.08, 631.78),
                (649.1, 656.16),
            ],
        )
        self.assertEqual(len(composite["source_beats"]), MAX_COMPOSITE_BEATS)
        self.assertLessEqual(composite["composite_duration_seconds"], MAX_COMPOSITE_SECONDS)
        self.assertGreaterEqual(
            composite["composite_duration_seconds"], PREFERRED_COMPOSITE_MIN_SECONDS
        )
        self.assertLessEqual(
            composite["composite_duration_seconds"], PREFERRED_COMPOSITE_MAX_SECONDS
        )
        self.assertTrue(composite["preferred_duration_met"])
        self.assertLessEqual(composite["core_mechanism_start_ratio"], 0.55)
        self.assertEqual(composite["duplicate_claim_count"], 0)
        self.assertTrue(composite["final_takeaway_present"])
        self.assertFalse(composite["dangling_context"])
        self.assertTrue(composite["resolution_answers_hook"])
        self.assertEqual(
            composite["source_beats"][3]["context_overlay"]["text"],
            "FOCUSING ON ONE EXAMPLE",
        )

        for previous, following in zip(
            composite["source_beats"], composite["source_beats"][1:]
        ):
            transition_start = previous["output_end_time"] - COMPOSITE_TRANSITION_SECONDS
            transition_end = previous["output_end_time"]
            self.assertGreaterEqual(
                transition_start - previous["output_speech_end_time"], 0.09
            )
            self.assertGreaterEqual(
                following["output_speech_start_time"] - transition_end, 0.09
            )

    def test_caption_and_timeline_mapping_exclude_removed_ranges(self):
        composite = plan_educational_composite(
            resolve_semantic_endpoint(self.candidate, self.transcript),
            self.transcript,
        )
        caption_words = []
        for beat in composite["source_beats"]:
            cues = _build_word_cues(
                self.transcript,
                beat["render_start_time"],
                beat["speech_end_time"],
            )
            caption_words.extend(word.lower() for cue in cues for word in cue["words"])
            expected = (
                beat["output_start_time"]
                + beat["speech_start_time"]
                - beat["render_start_time"]
            )
            self.assertAlmostEqual(beat["output_speech_start_time"], expected, places=3)

        self.assertNotIn("introduction", caption_words)
        self.assertIn("weighted", caption_words)
        self.assertNotIn("sigmoid", caption_words)

    def test_planner_is_not_tied_to_neural_network_vocabulary(self):
        transcript = {
            "duration": 130.0,
            "segments": [
                sentence(1.0, 4.0, "This coffee tastes unexpectedly bitter."),
                sentence(4.4, 9.0, "One small brewing change can fix the coffee."),
                sentence(20.0, 21.0, "But let's break that down."),
                sentence(21.0, 24.0, "What is extraction and why does it matter?"),
                sentence(24.6, 31.0, "When I say extraction think of material dissolved from coffee."),
                sentence(42.0, 55.0, "If you pour water through coffee the input causes a dissolved result and finally an output drink."),
                sentence(72.0, 78.0, "What we'll do is assign a setting to each brewing step."),
                sentence(78.5, 80.0, "Those settings are numbers."),
                sentence(80.5, 87.0, "Then compute the extraction result using those settings."),
                sentence(96.0, 103.0, "A simple function converts that result into a useful range."),
                sentence(110.0, 117.0, "So extraction is basically a measure of the dissolved coffee result."),
            ],
        }
        planned = plan_educational_composite(
            {"title": "Coffee extraction", "start_time": 1.0, "end_time": 12.0},
            transcript,
        )

        self.assertTrue(planned["composite_plan_valid"])
        self.assertEqual(len(planned["source_beats"]), 6)
        self.assertLessEqual(planned["composite_duration_seconds"], 90.0)
        self.assertEqual(planned["duplicate_claim_count"], 0)

    def test_composite_transition_and_lossless_intermediate_commands(self):
        command = _composite_encode_command(
            ["one.mkv", "two.mkv"],
            [10.0, 12.0],
            "short.mp4",
            COMPOSITE_TRANSITION_SECONDS,
        )
        filters = command[command.index("-filter_complex") + 1]
        self.assertIn("xfade=transition=fade:", filters)
        self.assertNotIn("fadeblack", filters)
        self.assertIn("acrossfade", filters)
        self.assertIn("c1=qsin:c2=qsin", filters)

        lossless = _raw_video_command(
            "audio.mkv", "beat.mkv", (720, 1280), 30.0, lossless=True
        )
        self.assertIn("ffv1", lossless)
        self.assertIn("pcm_s16le", lossless)
        self.assertNotIn("libx264", lossless)

        cut_command = _composite_encode_command(
            ["setup.mkv", "action.mkv"],
            [2.0, 50.0],
            "short.mp4",
            0.0,
        )
        cut_filters = cut_command[cut_command.index("-filter_complex") + 1]
        self.assertIn("concat=n=2:v=1:a=1", cut_filters)
        self.assertNotIn("xfade", cut_filters)
        self.assertNotIn("acrossfade", cut_filters)

    def test_complete_composite_is_ranker_eligible(self):
        composite = plan_educational_composite(
            resolve_semantic_endpoint(self.candidate, self.transcript),
            self.transcript,
        )
        ranked = rank_highlights([composite], self.transcript, content_type="tutorial")
        self.assertEqual(len(eligible_highlights(ranked)), 1)
        self.assertFalse(ranked[0]["rejected"])


if __name__ == "__main__":
    unittest.main()
