import unittest

from shorts_generator.local.clipper import _build_word_cues
from shorts_generator.ranker import rank_highlights
from shorts_generator.semantic_closure import resolve_semantic_endpoint


def timed_sentence(start, words):
    timed = []
    cursor = start
    for text, duration in words:
        timed.append({"word": text, "start": cursor, "end": cursor + duration})
        cursor += duration
    return {
        "start": timed[0]["start"],
        "end": timed[-1]["end"],
        "text": " ".join(word["word"] for word in timed),
        "words": timed,
    }


class SemanticClosureTests(unittest.TestCase):
    def setUp(self):
        setup = timed_sentence(
            4.06,
            [
                ("Humans", 8.0),
                ("recognize", 8.0),
                ("different", 8.0),
                ("digits", 8.0),
                ("effortlessly.", 12.02),
            ],
        )
        contrast = timed_sentence(
            49.0,
            [
                ("But", 0.32),
                ("if", 2.0),
                ("you", 2.0),
                ("write", 3.0),
                ("a", 1.0),
                ("program", 3.0),
                ("the", 1.0),
                ("task", 1.5),
                ("is", 1.0),
                ("difficult.", 2.28),
            ],
        )
        unrelated = timed_sentence(
            66.94,
            [("Unless", 1.0), ("you", 1.0), ("want", 1.0), ("more", 1.0), ("context.", 1.0)],
        )
        self.transcript = {
            "duration": 80.0,
            "segments": [setup, contrast, unrelated],
        }

    def test_partial_but_extends_but_remains_semantically_unresolved(self):
        resolved = resolve_semantic_endpoint(
            {"title": "Digits", "start_time": 0.0, "end_time": 49.04},
            self.transcript,
        )

        self.assertEqual(resolved["original_endpoint_cut_word"], "But")
        self.assertAlmostEqual(resolved["speech_start_time"], 4.06)
        self.assertAlmostEqual(resolved["speech_end_time"], 66.1)
        self.assertAlmostEqual(resolved["render_start_time"], 3.61)
        self.assertAlmostEqual(resolved["render_end_time"], 66.55)
        self.assertTrue(resolved["semantic_extension_applied"])
        self.assertFalse(resolved["open_loop_resolved"])
        self.assertTrue(resolved["continuation_required"])
        self.assertTrue(resolved["composite_required"])
        self.assertFalse(resolved["payoff_present"])
        self.assertEqual(resolved["arc_stage_at_end"], "problem_escalation")
        self.assertEqual(resolved["closure_score"], 30)
        self.assertNotIn("Unless", resolved["closure_sentence"])

    def test_caption_cues_stop_at_semantic_speech_end(self):
        resolved = resolve_semantic_endpoint(
            {"start_time": 0.0, "end_time": 49.04},
            self.transcript,
        )
        cues = _build_word_cues(
            self.transcript,
            resolved["render_start_time"],
            resolved["speech_end_time"],
        )

        caption_words = [word for cue in cues for word in cue["words"]]
        self.assertIn("difficult.", caption_words)
        self.assertNotIn("Unless", caption_words)
        self.assertLess(resolved["render_end_time"], 66.94)

    def test_complete_standalone_clip_is_not_extended(self):
        transcript = {
            "duration": 40.0,
            "segments": [
                timed_sentence(
                    5.0,
                    [("The", 3.0), ("answer", 3.0), ("works.", 4.0)],
                ),
                timed_sentence(
                    20.0,
                    [("A", 2.0), ("new", 2.0), ("topic", 2.0), ("starts.", 2.0)],
                ),
            ],
        }
        resolved = resolve_semantic_endpoint(
            {"start_time": 4.5, "end_time": 15.4},
            transcript,
        )

        self.assertAlmostEqual(resolved["speech_end_time"], 15.0)
        self.assertFalse(resolved["semantic_extension_applied"])
        self.assertTrue(resolved["open_loop_resolved"])

    def test_unresolved_semantic_candidate_is_hard_rejected(self):
        candidate = {
            "start_time": 0.0,
            "end_time": 30.0,
            "score": 95,
            "semantic_boundary_valid": False,
            "continuation_required": True,
            "open_loop_resolved": False,
            "topic_completeness_score": 55,
            "closure_score": 40,
        }
        ranked = rank_highlights(
            [candidate],
            {"duration": 60.0, "segments": []},
            content_type="tutorial",
        )
        self.assertTrue(ranked[0]["rejected"])

    def test_extension_never_exceeds_ninety_seconds(self):
        setup = timed_sentence(
            4.0,
            [("A", 10.0), ("complete", 10.0), ("setup.", 24.0)],
        )
        long_continuation = timed_sentence(
            49.0,
            [("But", 0.4), ("the", 20.0), ("answer", 20.0), ("is", 20.0), ("difficult.", 20.0)],
        )
        transcript = {"duration": 140.0, "segments": [setup, long_continuation]}
        resolved = resolve_semantic_endpoint(
            {"start_time": 0.0, "end_time": 49.1},
            transcript,
        )

        self.assertFalse(resolved["semantic_extension_applied"])
        self.assertTrue(resolved["continuation_required"])
        self.assertLessEqual(resolved["end_time"] - resolved["start_time"], 90.0)


if __name__ == "__main__":
    unittest.main()
