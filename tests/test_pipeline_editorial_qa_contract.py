import copy
import unittest

from shorts_generator.artifact_contracts import content_hash
from shorts_generator.dynamic_music import (
    DYNAMIC_MUSIC_PLAN_VERSION,
    build_dynamic_music_plan,
)
from shorts_generator.pipeline import build_editorial_render_evidence
from shorts_generator.music_router import route_music_for_candidate


class PipelineEditorialQaContractTests(unittest.TestCase):
    def test_v4_render_evidence_binds_semantic_selection_and_catalog_receipt(self):
        semantic_candidate = {
            "whole_point_summary": (
                "You do not owe every argument a response; protect your boundary."
            ),
            "payoff_exact_quote": "Leave their opinion with them.",
        }
        decision = route_music_for_candidate(
            semantic_candidate,
            verify_assets=False,
        )
        track = decision["catalogTrack"]
        plan = build_dynamic_music_plan(
            {"music_profile": decision["treatmentProfile"]},
            [],
            duration=10.0,
            speech_end_seconds=9.0,
            natural_tail_end_seconds=9.5,
            music_profile=decision["treatmentProfile"],
        )
        viral_receipt = {
            "assetId": f"sha256:{track['sha256']}",
            "sha256": track["sha256"],
            "byteLength": track["byteLength"],
            "trackId": track["trackId"],
            "relativePath": track["relativePath"],
            "title": track["title"],
            "creator": track["creator"],
            "sourcePageUrl": track["sourcePageUrl"],
            "licenseUrl": track["licenseUrl"],
            "aiGenerated": track["aiGenerated"],
            "contentIdRegistered": track["contentIdRegistered"],
            "catalogVersion": decision["catalogVersion"],
            "catalogContentHash": decision["catalogContentHash"],
            "routerVersion": decision["routerVersion"],
            "rotationVersion": decision["rotationVersion"],
            "routingDecisionHash": decision["contentHash"],
            "treatmentProfile": decision["treatmentProfile"],
            "startSeconds": decision["startSeconds"],
            "verifiedBeforeFfmpeg": True,
        }
        short = {
            **semantic_candidate,
            "format_profile": "bf_feed_stop_format_v4",
            "selection_profile": "bf_feed_stop_v2",
            "render_profile": "bf_editorial_inset_v4",
            "music_profile": decision["treatmentProfile"],
            "resolved_music_profile": decision["treatmentProfile"],
            "music_mix_profile": DYNAMIC_MUSIC_PLAN_VERSION,
            "dynamic_music_plan": plan,
            "dynamic_music_applied": True,
            "dynamic_music_asset_receipt": {
                "assetId": f"sha256:{track['sha256']}",
                "sha256": track["sha256"],
                "byteLength": track["byteLength"],
            },
            "musicRoutingDecision": decision,
            "musicCatalogTrack": track,
            "music_routing_decision": decision,
            "viral_music_asset_receipt": viral_receipt,
        }

        evidence = build_editorial_render_evidence(short)
        self.assertEqual(evidence["music"]["selection"], decision)
        self.assertEqual(evidence["music"]["selectionHash"], decision["contentHash"])
        self.assertEqual(evidence["music"]["catalogAsset"], viral_receipt)
        self.assertEqual(evidence["music"]["startSeconds"], decision["startSeconds"])
        self.assertEqual(evidence["contentHash"], content_hash(evidence))

        tampered = copy.deepcopy(short)
        tampered["viral_music_asset_receipt"]["startSeconds"] += 0.25
        with self.assertRaisesRegex(ValueError, "does not bind"):
            build_editorial_render_evidence(tampered)

    def test_render_evidence_binds_versions_timeline_typography_and_cuts(self):
        evidence = build_editorial_render_evidence(
            {
                "format_profile": "bf_viral_micro_v1",
                "selection_profile": "motivational_tension_micro_v1",
                "render_profile": "bf_editorial_inset_v1",
                "layout_profile": "editorial_inset",
                "grade_profile": "high_contrast_grayscale_v1",
                "typography_profile": "kinetic_editorial_v1",
                "first_visible_text_seconds": 0.0,
                "semantic_end_seconds": 10.4,
                "max_hero_scale": 2.2,
                "source_cut_count": 1,
                "artificial_cut_count": 0,
                "brand_tail_profile": "bf_reference_tail_v2",
                "brand_tail_seconds": 1.25,
                "brand_tail_start_seconds": 11.45,
                "brand_tail_clearance_seconds": 1.05,
                "natural_tail_seconds": 0.75,
                "transition_tail_seconds": 0.3,
                "freeze_hold_seconds": 0.0,
                "source_content_end_time": 11.45,
                "next_spoken_word_start": 12.0,
                "next_speech_safety_seconds": 0.04,
                "acoustic_speech_end_time": 10.35,
                "transcript_next_spoken_word_start": 11.45,
                "acoustic_boundary_source": "candidate_verified_acoustic",
                "verified_acoustic_speech_end_time": 10.35,
                "verified_next_spoken_word_start": 12.0,
                "verified_next_speech_safety_seconds": 0.04,
                "verified_acoustic_boundary_evidence": "waveform review",
                "source_speech_leak_guard_passed": True,
                "effective_source_cut_limit": 2,
                "semantic_completion_source_cut_exception": False,
            }
        )

        self.assertEqual(evidence["cuts"]["artificialCutCount"], 0)
        self.assertEqual(evidence["brandTail"]["mark"], "BF.")
        self.assertEqual(
            evidence["brandTail"]["profile"],
            "bf_reference_tail_v2",
        )
        self.assertEqual(evidence["brandTail"]["freezeHoldSeconds"], 0.0)
        self.assertTrue(evidence["brandTail"]["sourceSpeechLeakGuardPassed"])
        self.assertEqual(
            evidence["brandTail"]["acousticBoundarySource"],
            "candidate_verified_acoustic",
        )
        self.assertEqual(
            evidence["brandTail"]["verifiedAcousticBoundaryEvidence"],
            "waveform review",
        )
        self.assertEqual(evidence["cuts"]["sourceCutLimit"], 2)
        self.assertEqual(evidence["timeline"]["firstVisibleTextSeconds"], 0.0)
        self.assertNotIn("music", evidence)
        self.assertGreaterEqual(
            evidence["brandTail"]["startSeconds"],
            evidence["timeline"]["semanticEndSeconds"],
        )
        self.assertEqual(evidence["contentHash"], content_hash(evidence))
        self.assertEqual(
            evidence["contentHash"],
            "99e91e7aae43a1c5c675a677a9b72d78f8731c47134faa83435e4f4da77999e3",
        )

    def test_render_evidence_keeps_visual_cap_separate_from_next_speech(self):
        evidence = build_editorial_render_evidence(
            {
                "brand_tail_profile": "bf_smooth_tail_v4",
                "source_content_end_time": 1213.828,
                "next_spoken_word_start": 1213.98,
                "verified_visual_safe_end_time": 1213.828,
                "verified_visual_boundary_evidence": "scene-cut review",
                "visual_safe_end_guard_passed": True,
                "source_speech_leak_guard_passed": True,
            }
        )

        tail = evidence["brandTail"]
        self.assertAlmostEqual(tail["verifiedVisualSafeEndTime"], 1213.828)
        self.assertAlmostEqual(tail["nextSpokenWordStart"], 1213.98)
        self.assertEqual(
            tail["verifiedVisualBoundaryEvidence"],
            "scene-cut review",
        )
        self.assertTrue(tail["visualSafeEndGuardPassed"])
        self.assertEqual(evidence["contentHash"], content_hash(evidence))

    def test_v3_render_evidence_seals_exact_dynamic_music_plan(self):
        plan = build_dynamic_music_plan(
            {"music_profile": "reflective"},
            [],
            duration=10.0,
            speech_end_seconds=9.0,
            natural_tail_end_seconds=9.5,
        )
        short = {
            "format_profile": "bf_feed_stop_format_v3",
            "selection_profile": "bf_feed_stop_v2",
            "render_profile": "bf_editorial_inset_v3",
            "music_profile": "reflective",
            "resolved_music_profile": "reflective",
            "music_mix_profile": DYNAMIC_MUSIC_PLAN_VERSION,
            "dynamic_music_plan": plan,
            "dynamic_music_applied": True,
            "dynamic_music_asset_receipt": {
                "assetId": f"sha256:{'a' * 64}",
                "sha256": "a" * 64,
                "byteLength": 1234,
            },
        }

        evidence = build_editorial_render_evidence(short)
        sealed = evidence["music"]["plan"]

        self.assertEqual(evidence["music"]["version"], DYNAMIC_MUSIC_PLAN_VERSION)
        self.assertEqual(evidence["music"]["planHash"], sealed["contentHash"])
        self.assertEqual(sealed["contentHash"], content_hash(sealed))
        self.assertEqual(evidence["contentHash"], content_hash(evidence))

        # The evidence owns a deep snapshot, not the mutable renderer metadata.
        original_end_gain = plan["events"][0]["endGain"]
        plan["events"][0]["endGain"] += 0.01
        self.assertNotEqual(
            plan["events"][0]["endGain"],
            sealed["events"][0]["endGain"],
        )
        plan["events"][0]["endGain"] = original_end_gain

        changed_plan = copy.deepcopy(short["dynamic_music_plan"])
        # Keep the envelope valid while changing an exact output-affecting gain.
        changed_plan["events"][0]["startGain"] += 0.01
        changed_short = {**short, "dynamic_music_plan": changed_plan}
        changed_evidence = build_editorial_render_evidence(changed_short)
        self.assertNotEqual(
            evidence["music"]["planHash"],
            changed_evidence["music"]["planHash"],
        )
        self.assertNotEqual(evidence["contentHash"], changed_evidence["contentHash"])

    def test_v3_render_evidence_fails_closed_without_music_plan(self):
        with self.assertRaisesRegex(ValueError, "requires a dynamic music plan"):
            build_editorial_render_evidence(
                {
                    "format_profile": "bf_feed_stop_format_v3",
                    "selection_profile": "bf_feed_stop_v2",
                    "render_profile": "bf_editorial_inset_v3",
                    "music_mix_profile": DYNAMIC_MUSIC_PLAN_VERSION,
                }
            )

    def test_v3_render_evidence_fails_closed_without_executed_music_mix(self):
        plan = build_dynamic_music_plan(
            {"music_profile": "reflective"},
            [],
            duration=10.0,
            speech_end_seconds=9.0,
            natural_tail_end_seconds=9.5,
        )
        with self.assertRaisesRegex(ValueError, "encoded dynamic-music mix"):
            build_editorial_render_evidence(
                {
                    "format_profile": "bf_feed_stop_format_v3",
                    "selection_profile": "bf_feed_stop_v2",
                    "render_profile": "bf_editorial_inset_v3",
                    "music_mix_profile": DYNAMIC_MUSIC_PLAN_VERSION,
                    "dynamic_music_plan": plan,
                    "dynamic_music_applied": False,
                    "resolved_music_profile": "reflective",
                    "dynamic_music_asset_receipt": {
                        "assetId": f"sha256:{'a' * 64}",
                        "sha256": "a" * 64,
                        "byteLength": 1234,
                    },
                }
            )

    def test_v3_render_evidence_rejects_profile_or_asset_drift(self):
        plan = build_dynamic_music_plan(
            {"music_profile": "reflective"},
            [],
            duration=10.0,
            speech_end_seconds=9.0,
            natural_tail_end_seconds=9.5,
        )
        base = {
            "format_profile": "bf_feed_stop_format_v3",
            "selection_profile": "bf_feed_stop_v2",
            "render_profile": "bf_editorial_inset_v3",
            "music_profile": "reflective",
            "music_mix_profile": DYNAMIC_MUSIC_PLAN_VERSION,
            "dynamic_music_plan": plan,
            "dynamic_music_applied": True,
            "resolved_music_profile": "driving",
            "dynamic_music_asset_receipt": {
                "assetId": f"sha256:{'a' * 64}",
                "sha256": "a" * 64,
                "byteLength": 1234,
            },
        }
        with self.assertRaisesRegex(ValueError, "resolved music profile"):
            build_editorial_render_evidence(base)

        invalid_asset = {
            **base,
            "resolved_music_profile": "reflective",
            "dynamic_music_asset_receipt": {
                "assetId": "sha256:wrong",
                "sha256": "a" * 64,
                "byteLength": 1234,
            },
        }
        with self.assertRaisesRegex(ValueError, "asset receipt is invalid"):
            build_editorial_render_evidence(invalid_asset)


if __name__ == "__main__":
    unittest.main()
