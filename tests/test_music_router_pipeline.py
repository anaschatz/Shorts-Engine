import json
import unittest
from pathlib import Path

from shorts_generator.pipeline import _route_v4_music_candidates


ROOT = Path(__file__).resolve().parents[1]


class MusicRouterPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads(
            (ROOT / "assets" / "music" / "catalog.v1.json").read_text(
                encoding="utf-8"
            )
        )

    def test_full_point_routing_is_bound_and_batch_tracks_do_not_repeat(self):
        candidate = {
            "whole_point_summary": (
                "You do not owe every argument a response. Protect your "
                "boundaries instead of chasing approval."
            ),
            "payoff_exact_quote": "You can leave their opinion with them.",
            "rejected": False,
        }
        routed = _route_v4_music_candidates(
            [dict(candidate), dict(candidate)],
            [],
            catalog=self.catalog,
        )

        self.assertEqual(len(routed), 2)
        self.assertNotEqual(routed[0]["music_track_id"], routed[1]["music_track_id"])
        for item in routed:
            decision = item["musicRoutingDecision"]
            self.assertEqual(item["musicRoutingDecisionHash"], decision["contentHash"])
            self.assertEqual(item["musicCatalogTrack"], decision["catalogTrack"])
            self.assertEqual(item["music_profile"], decision["treatmentProfile"])
            self.assertEqual(item["music_start_seconds"], decision["startSeconds"])

    def test_public_and_scheduled_history_excludes_previous_four_tracks(self):
        history = [
            {"videoId": "one", "musicTrackId": "pixabay:126884"},
            {"videoId": "two", "music_track_id": "pixabay:112823"},
            {
                "videoId": "three",
                "musicRoutingDecision": {"trackId": "pixabay:113386"},
            },
            {"videoId": "scheduled", "musicTrackId": "pixabay:344247"},
        ]
        [routed] = _route_v4_music_candidates(
            [
                {
                    "whole_point_summary": "A relationship can reveal manipulation.",
                    "payoff_exact_quote": "Do not ignore betrayal and tension.",
                    "rejected": False,
                }
            ],
            history,
            catalog=self.catalog,
        )

        self.assertEqual(routed["music_track_id"], "pixabay:422055")
        self.assertEqual(
            routed["musicRoutingDecision"]["recentTrackIds"],
            [
                "pixabay:126884",
                "pixabay:112823",
                "pixabay:113386",
                "pixabay:344247",
            ],
        )

    def test_rejected_candidate_never_gets_a_music_authority(self):
        original = {"rejected": True, "whole_point_summary": "not selected"}
        [routed] = _route_v4_music_candidates(
            [original],
            [],
            catalog=self.catalog,
        )
        self.assertEqual(routed, original)
        self.assertNotIn("musicRoutingDecision", routed)


if __name__ == "__main__":
    unittest.main()
