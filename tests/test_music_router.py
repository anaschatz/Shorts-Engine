import copy
import hashlib
import json
import unittest

from shorts_generator.music_router import (
    DEFAULT_MUSIC_CATALOG_PATH,
    MUSIC_CATALOG_VERSION,
    MUSIC_ROTATION_LOOKBACK,
    MUSIC_ROTATION_POLICY_VERSION,
    MUSIC_ROTATION_WINDOW_SIZE,
    MUSIC_ROUTER_DECISION_VERSION,
    MusicRouterError,
    load_music_catalog,
    resolve_music_asset_path,
    route_music_for_candidate,
    verify_music_catalog,
    verify_music_routing_decision,
)


def reseal(value):
    body = {key: item for key, item in value.items() if key != "contentHash"}
    encoded = json.dumps(
        body,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return {**body, "contentHash": hashlib.sha256(encoded).hexdigest()}


class MusicRouterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = load_music_catalog()

    def route(self, candidate, recent=(), reserved=()):
        return route_music_for_candidate(
            candidate,
            recent,
            reserved,
            catalog=self.catalog,
            verify_assets=False,
        )

    def test_production_catalog_and_exact_assets_verify(self):
        catalog = load_music_catalog()

        self.assertEqual(catalog["catalogVersion"], MUSIC_CATALOG_VERSION)
        self.assertEqual(len(catalog["tracks"]), 5)
        for track in catalog["tracks"]:
            path = resolve_music_asset_path(track)
            self.assertTrue(path.is_file())
            self.assertEqual(path.stat().st_size, track["byteLength"])
            self.assertLess(
                track["recommendedOffsetSeconds"],
                track["durationSeconds"],
            )

    def test_complete_point_and_payoff_override_misleading_opening(self):
        opening_only = {
            "opening_unit_exact_quote": (
                "Confidence under criticism shows who you are."
            ),
            "topic_comprehension_exact_quote": (
                "Confidence under criticism shows who you are."
            ),
        }
        opening_route = self.route(opening_only)
        complete_route = self.route(
            {
                **opening_only,
                "whole_point_summary": (
                    "A manipulative partner betrays your trust and controls you."
                ),
                "payoff_exact_quote": (
                    "Betrayal destroys intimacy, so leave manipulation behind."
                ),
                "full_text": (
                    "Confidence can hide the truth: manipulation and betrayal "
                    "destroy intimacy and trust."
                ),
            }
        )

        self.assertEqual(opening_route["trackId"], "pixabay:113386")
        self.assertEqual(complete_route["trackId"], "pixabay:422055")
        self.assertIn(
            complete_route["semanticFamily"],
            {"manipulation", "betrayal", "intimacy"},
        )
        self.assertIn("whole_point", complete_route["reasons"][3])
        self.assertIn("payoff", complete_route["reasons"][3])

    def test_recent_and_reserved_tracks_are_excluded_without_hidden_state(self):
        candidate = {
            "hook_semantic_topic": "boundaries and rejection",
            "whole_point_summary": (
                "You do not owe everyone access. Protect your boundaries and "
                "stop needing approval."
            ),
            "payoff_exact_quote": (
                "Walk away from arguments and choose self respect."
            ),
        }
        first = self.route(candidate)
        next_published = self.route(candidate, recent=(first["trackId"],))
        next_reserved = self.route(candidate, reserved=(first["trackId"],))

        self.assertNotEqual(next_published["trackId"], first["trackId"])
        self.assertNotEqual(next_reserved["trackId"], first["trackId"])
        self.assertIn(first["trackId"], next_published["recentTrackIds"])
        self.assertIn(first["trackId"], next_reserved["reservedTrackIds"])

    def test_rotation_uses_bounded_window_and_four_track_lookback(self):
        history = tuple(track["trackId"] for track in self.catalog["tracks"])
        decision = self.route({}, recent=history)

        self.assertEqual(len(decision["recentTrackIds"]), MUSIC_ROTATION_WINDOW_SIZE)
        self.assertEqual(MUSIC_ROTATION_LOOKBACK, 4)
        # The oldest of five is outside the four-track exclusion lookback and
        # therefore becomes the deterministic zero-signal fallback.
        self.assertEqual(decision["trackId"], history[0])

    def test_ties_and_short_history_have_deterministic_fallback(self):
        candidate = {"title": "Unmapped neutral vocabulary"}
        first = self.route(candidate)
        second = self.route(copy.deepcopy(candidate))

        self.assertEqual(first, second)
        self.assertEqual(first["trackId"], "pixabay:126884")
        self.assertIn(
            "semantic_evidence_insufficient_catalog_order_fallback",
            first["reasons"],
        )
        self.assertIn("rotation_history_short:0/4", first["reasons"])

    def test_unknown_history_is_bound_and_warned_but_not_excluded(self):
        decision = self.route({}, recent=("external:unknown",))

        self.assertEqual(decision["trackId"], "pixabay:126884")
        self.assertEqual(decision["recentTrackIds"], ["external:unknown"])
        self.assertIn(
            "unknown_recent_track_ids_ignored:external:unknown",
            decision["reasons"],
        )

    def test_malformed_history_fails_closed(self):
        with self.assertRaisesRegex(MusicRouterError, "valid track ID"):
            self.route({}, recent=("",))
        with self.assertRaisesRegex(MusicRouterError, "sequence"):
            route_music_for_candidate(
                {},
                recent_track_ids=None,
                catalog=self.catalog,
                verify_assets=False,
            )

    def test_catalog_hash_tampering_fails_closed(self):
        tampered = copy.deepcopy(self.catalog)
        tampered["tracks"][0]["title"] = "Tampered title"

        with self.assertRaisesRegex(MusicRouterError, "contentHash"):
            verify_music_catalog(
                tampered,
                catalog_path=DEFAULT_MUSIC_CATALOG_PATH,
                verify_assets=False,
            )

    def test_bad_asset_identity_fails_even_with_fresh_catalog_seal(self):
        wrong_bytes = copy.deepcopy(self.catalog)
        wrong_bytes["tracks"][0]["byteLength"] += 1
        wrong_bytes = reseal(wrong_bytes)
        with self.assertRaisesRegex(MusicRouterError, "byteLength mismatch"):
            verify_music_catalog(
                wrong_bytes,
                catalog_path=DEFAULT_MUSIC_CATALOG_PATH,
            )

        wrong_sha = copy.deepcopy(self.catalog)
        wrong_sha["tracks"][0]["sha256"] = "0" * 64
        wrong_sha = reseal(wrong_sha)
        with self.assertRaisesRegex(MusicRouterError, "sha256 mismatch"):
            verify_music_catalog(
                wrong_sha,
                catalog_path=DEFAULT_MUSIC_CATALOG_PATH,
            )

    def test_bad_track_schema_and_unsafe_asset_path_fail_closed(self):
        extra_metadata = copy.deepcopy(self.catalog)
        extra_metadata["tracks"][0]["unsealedRuntimeHint"] = "ignore integrity"
        extra_metadata = reseal(extra_metadata)
        with self.assertRaisesRegex(MusicRouterError, "versioned schema"):
            verify_music_catalog(
                extra_metadata,
                catalog_path=DEFAULT_MUSIC_CATALOG_PATH,
                verify_assets=False,
            )

        traversal = copy.deepcopy(self.catalog)
        traversal["tracks"][0]["relativePath"] = "assets/music/../../secret.mp3"
        traversal = reseal(traversal)
        with self.assertRaisesRegex(MusicRouterError, "stay inside"):
            verify_music_catalog(
                traversal,
                catalog_path=DEFAULT_MUSIC_CATALOG_PATH,
                verify_assets=False,
            )

        unknown_family = copy.deepcopy(self.catalog)
        unknown_family["tracks"][0]["semanticFamilies"][0] = "unversioned_family"
        unknown_family = reseal(unknown_family)
        with self.assertRaisesRegex(MusicRouterError, "unsupported family"):
            verify_music_catalog(
                unknown_family,
                catalog_path=DEFAULT_MUSIC_CATALOG_PATH,
                verify_assets=False,
            )

    def test_decision_is_sealed_versioned_and_binds_exact_catalog_track(self):
        decision = self.route(
            {
                "whole_point_summary": (
                    "Discipline and consistency build confidence through adversity."
                )
            },
            recent=("pixabay:126884",),
        )
        verified = verify_music_routing_decision(
            decision,
            candidate={
                "whole_point_summary": (
                    "Discipline and consistency build confidence through adversity."
                )
            },
            catalog=self.catalog,
            verify_assets=False,
        )

        self.assertEqual(verified["routerVersion"], MUSIC_ROUTER_DECISION_VERSION)
        self.assertEqual(verified["catalogVersion"], MUSIC_CATALOG_VERSION)
        self.assertEqual(verified["rotationVersion"], MUSIC_ROTATION_POLICY_VERSION)
        self.assertEqual(
            verified["startSeconds"],
            verified["catalogTrack"]["recommendedOffsetSeconds"],
        )
        self.assertEqual(verified["trackId"], verified["catalogTrack"]["trackId"])

        with self.assertRaisesRegex(MusicRouterError, "other semantics"):
            verify_music_routing_decision(
                decision,
                candidate={"whole_point_summary": "Betrayal and manipulation."},
                catalog=self.catalog,
                verify_assets=False,
            )

        tampered = reseal({**decision, "startSeconds": decision["startSeconds"] + 1})
        with self.assertRaisesRegex(MusicRouterError, "startSeconds"):
            verify_music_routing_decision(
                tampered,
                catalog=self.catalog,
                verify_assets=False,
            )

    def test_router_has_no_hidden_mutable_history_or_input_mutation(self):
        candidate = {
            "whole_point_summary": "Boundaries protect self worth after rejection."
        }
        catalog = copy.deepcopy(self.catalog)
        candidate_before = copy.deepcopy(candidate)
        catalog_before = copy.deepcopy(catalog)

        baseline = route_music_for_candidate(
            candidate,
            catalog=catalog,
            verify_assets=False,
        )
        _ = route_music_for_candidate(
            candidate,
            recent_track_ids=(baseline["trackId"],),
            catalog=catalog,
            verify_assets=False,
        )
        repeated = route_music_for_candidate(
            candidate,
            catalog=catalog,
            verify_assets=False,
        )

        self.assertEqual(baseline, repeated)
        self.assertEqual(candidate, candidate_before)
        self.assertEqual(catalog, catalog_before)


if __name__ == "__main__":
    unittest.main()
