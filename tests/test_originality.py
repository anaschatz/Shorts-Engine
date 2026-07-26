import unittest

from shorts_generator.originality import evaluate_originality, interval_iou, text_similarity


class OriginalityTests(unittest.TestCase):
    def test_text_and_interval_similarity_are_deterministic(self):
        self.assertEqual(text_similarity("discipline creates real freedom", "discipline creates real freedom"), 1.0)
        self.assertAlmostEqual(interval_iou((10, 20), (15, 25)), 1 / 3)

    def test_same_recent_source_moment_is_rejected(self):
        candidate = {
            "start_time": 10.0,
            "end_time": 20.0,
            "hook_sentence": "Discipline creates freedom",
            "candidate_text": "Discipline creates freedom because standards remove daily negotiation.",
        }
        report = evaluate_originality(
            candidate,
            candidate_hash="a" * 64,
            source_hash="b" * 64,
            candidate_decision_hash="c" * 64,
            recent_publications=[
                {
                    "videoId": "recent",
                    "sourceHash": "b" * 64,
                    "startTime": 10.1,
                    "endTime": 20.1,
                    "hook": "Discipline creates freedom",
                    "candidateText": candidate["candidate_text"],
                }
            ],
        )
        self.assertFalse(report["passed"])
        self.assertEqual(report["candidateDecisionHash"], "c" * 64)
        self.assertGreater(report["maximums"]["sameSourceIntervalIou"], 0.9)


if __name__ == "__main__":
    unittest.main()
