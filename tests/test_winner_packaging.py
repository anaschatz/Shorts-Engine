import unittest

from shorts_generator.profiles import (
    BF_EDITORIAL_INSET_V2,
    BF_WINNER_LAYOUT_V1,
    BF_WINNER_PACKAGING_V1,
    render_settings_for_content,
    resolve_profile_bundle,
)
from shorts_generator.winner_packaging import (
    ANALYTICS_CONTRACT,
    COMPACT_CAPTION_PROFILE,
    DENSE_DIALOGUE_AUDIO_PROFILE,
    FULL_BLEED_LAYOUT_PROFILE,
    LIVE_TAIL_PROFILE,
    WINNER_PACKAGING_DECISION_VERSION,
    audio_qa,
    build_winner_experiment_manifest,
    caption_qa,
    duration_packaging_decision,
    evaluate_winner_packaging_evidence,
    live_tail_decision,
    motion_route,
    normalize_caption_tokens,
)


SHA_A = "a" * 64
SHA_B = "b" * 64


class WinnerPackagingDecisionTests(unittest.TestCase):
    def test_01_preferred_duration_bucket(self):
        decision = duration_packaging_decision(18.0)
        self.assertEqual(decision["durationBucket"], "preferred")
        self.assertEqual(decision["layoutProfile"], FULL_BLEED_LAYOUT_PROFILE)

    def test_02_short_candidate_is_not_rejected_or_truncated(self):
        decision = duration_packaging_decision(10.0)
        self.assertEqual(decision["durationBucket"], "short_accepted")
        self.assertFalse(decision["truncated"])

    def test_03_soft_duration_penalty_keeps_full_bleed(self):
        decision = duration_packaging_decision(23.5)
        self.assertEqual(decision["durationBucket"], "soft_penalty")
        self.assertLess(decision["packagingFit"], 1.0)
        self.assertEqual(decision["layoutProfile"], FULL_BLEED_LAYOUT_PROFILE)

    def test_04_over_24_seconds_falls_back_to_existing_layout(self):
        decision = duration_packaging_decision(24.001)
        self.assertEqual(decision["layoutProfile"], BF_EDITORIAL_INSET_V2)
        self.assertFalse(decision["truncated"])

    def test_05_explicit_override_allows_long_full_bleed(self):
        decision = duration_packaging_decision(
            27.0, explicit_full_bleed_override=True
        )
        self.assertEqual(decision["layoutProfile"], FULL_BLEED_LAYOUT_PROFILE)

    def test_06_decision_version_is_stable(self):
        self.assertEqual(
            duration_packaging_decision(17.0)["decisionVersion"],
            WINNER_PACKAGING_DECISION_VERSION,
        )

    def test_07_high_motion_is_continuous(self):
        route = motion_route(0.9, duration_seconds=18, requested_reframes=2)
        self.assertEqual(route["motionRoute"], "continuous_shot")
        self.assertEqual(route["reframeCount"], 0)
        self.assertIn("excessive_reframes", route["failureCodes"])

    def test_08_medium_motion_caps_reframes_at_two(self):
        route = motion_route(0.5, duration_seconds=18, requested_reframes=4)
        self.assertEqual(route["reframeCount"], 2)
        self.assertEqual(route["minReframeIntervalSeconds"], 3.0)

    def test_09_low_motion_uses_deterministic_crop(self):
        route = motion_route(0.1, duration_seconds=18)
        self.assertEqual(route["motionRoute"], "slow_deterministic_crop")
        self.assertTrue(route["sourceNativeBrollOnly"])

    def test_10_self_torture_tokens_are_merged(self):
        words = [
            {"text": "self-", "start": 0.0, "end": 0.2},
            {"text": "torture", "start": 0.2, "end": 0.6},
        ]
        normalized = normalize_caption_tokens(words)
        self.assertEqual(len(normalized), 1)
        self.assertEqual(normalized[0]["text"], "self-torture")
        self.assertEqual(normalized[0]["end"], 0.6)

    def test_11_caption_never_reveals_early(self):
        report = caption_qa(
            [{"start": 0.0, "end": 0.5, "words": ["think", "again"]}],
            speech_end_seconds=1.0,
            first_spoken_word_seconds=0.1,
        )
        self.assertIn("caption_early_reveal", report["failureCodes"])

    def test_12_caption_latency_is_bounded(self):
        report = caption_qa(
            [{"start": 0.21, "end": 0.5, "words": ["think", "again"]}],
            speech_end_seconds=1.0,
            first_spoken_word_seconds=0.1,
        )
        self.assertIn("caption_started_late", report["failureCodes"])

    def test_13_caption_clears_at_speech_end(self):
        report = caption_qa(
            [{"start": 0.1, "end": 1.1, "words": ["think", "again"]}],
            speech_end_seconds=1.0,
            first_spoken_word_seconds=0.1,
        )
        self.assertIn("caption_after_speech", report["failureCodes"])

    def test_14_caption_shape_is_two_to_six_words_and_two_lines(self):
        report = caption_qa(
            [
                {
                    "start": 0.1,
                    "end": 0.8,
                    "words": ["one"],
                    "lineCount": 3,
                }
            ],
            speech_end_seconds=1.0,
            first_spoken_word_seconds=0.1,
        )
        self.assertIn("malformed_caption_token", report["failureCodes"])

    def test_15_caption_face_overlap_fails(self):
        report = caption_qa(
            [{"start": 0.1, "end": 0.8, "words": ["think", "again"]}],
            speech_end_seconds=1.0,
            first_spoken_word_seconds=0.1,
            face_overlap_ratio=0.03,
        )
        self.assertIn("caption_face_overlap", report["failureCodes"])

    def test_16_live_tail_stops_before_next_word(self):
        decision = live_tail_decision(
            10.0,
            next_word_start_seconds=10.85,
            verified_visual_safe_end_seconds=11.0,
        )
        self.assertAlmostEqual(decision["sourceEndSeconds"], 10.81)
        self.assertNotIn("next_speech_leak", decision["failureCodes"])

    def test_17_missing_word_timing_uses_conservative_tail(self):
        decision = live_tail_decision(10.0, word_timing_available=False)
        self.assertAlmostEqual(decision["authenticTailSeconds"], 0.75)
        self.assertTrue(decision["wordTimingFallback"])

    def test_18_live_tail_never_freezes_or_adds_black_card(self):
        decision = live_tail_decision(10.0)
        self.assertEqual(decision["freezeHoldSeconds"], 0.0)
        self.assertEqual(decision["blackCardSeconds"], 0.0)
        self.assertEqual(decision["endingProfile"], LIVE_TAIL_PROFILE)

    def test_19_static_tail_is_reported(self):
        decision = live_tail_decision(10.0, measured_motion_score=0.0)
        self.assertIn("visual_tail_static", decision["failureCodes"])

    def test_20_audio_target_passes(self):
        report = audio_qa(-15.0, 2.2, -1.1)
        self.assertEqual(report["failureCodes"], [])
        self.assertEqual(report["audioProfile"], DENSE_DIALOGUE_AUDIO_PROFILE)

    def test_21_audio_failures_are_independent(self):
        report = audio_qa(-13.0, 1.0, -0.5)
        self.assertEqual(
            set(report["failureCodes"]),
            {
                "loudness_out_of_range",
                "true_peak_failed",
                "audio_overcompressed",
            },
        )

    def test_22_single_axis_manifest_declares_layout_treatment(self):
        manifest = build_winner_experiment_manifest(
            source_video_id="P91b4civBxA",
            source_hash=SHA_A,
            candidate_hash=SHA_B,
            source_interval=(10.0, 28.0),
        )
        self.assertEqual(manifest["changedAxes"], ["layout"])
        self.assertEqual(
            manifest["treatment"]["layout"], FULL_BLEED_LAYOUT_PROFILE
        )
        self.assertEqual(manifest["treatment"]["captions"], "unchanged")
        self.assertEqual(manifest["treatment"]["ending"], "unchanged")
        self.assertEqual(manifest["treatment"]["audio"], "unchanged")
        self.assertEqual(manifest["failureCodes"], [])

    def test_23_multi_axis_manifest_warns_and_requires_human_decision(self):
        manifest = build_winner_experiment_manifest(
            source_video_id="P91b4civBxA",
            source_hash=SHA_A,
            candidate_hash=SHA_B,
            source_interval=(10.0, 28.0),
            changed_axes=("layout", "captions"),
        )
        self.assertIn("multi_axis_experiment", manifest["failureCodes"])
        self.assertTrue(manifest["humanDecisionRequired"])

    def test_24_analytics_contract_has_equal_age_windows_and_no_autopromotion(self):
        self.assertEqual(ANALYTICS_CONTRACT["snapshotHours"], [1, 6, 24, 72, 168])
        self.assertFalse(ANALYTICS_CONTRACT["autoPromotionAllowed"])
        self.assertEqual(
            ANALYTICS_CONTRACT["minimumAveragePercentageViewed"], 80.0
        )


class WinnerPackagingIntegrationTests(unittest.TestCase):
    def test_profile_is_explicit_and_resolves_all_components(self):
        resolved = resolve_profile_bundle(format_profile=BF_WINNER_PACKAGING_V1)
        self.assertEqual(resolved["render_profile"], BF_WINNER_PACKAGING_V1)
        settings = render_settings_for_content(
            "motivational_podcast",
            render_profile=resolved["render_profile"],
            selection_profile=resolved["selection_profile"],
            format_profile=resolved["format_profile"],
        )
        self.assertEqual(settings["layout_hint"], FULL_BLEED_LAYOUT_PROFILE)
        self.assertEqual(settings["caption_style"], COMPACT_CAPTION_PROFILE)
        self.assertEqual(settings["brand_tail_profile"], LIVE_TAIL_PROFILE)

    def test_legacy_profile_resolution_is_unchanged(self):
        resolved = resolve_profile_bundle(render_profile=BF_EDITORIAL_INSET_V2)
        self.assertEqual(resolved["render_profile"], BF_EDITORIAL_INSET_V2)
        settings = render_settings_for_content(
            "motivational_podcast", render_profile=BF_EDITORIAL_INSET_V2
        )
        self.assertEqual(settings["layout_hint"], "editorial_inset")

    def test_layout_only_rollout_keeps_control_caption_ending_and_audio(self):
        settings = render_settings_for_content(
            "motivational_podcast", render_profile=BF_WINNER_LAYOUT_V1
        )
        self.assertEqual(settings["layout_hint"], FULL_BLEED_LAYOUT_PROFILE)
        self.assertEqual(settings["caption_style"], BF_EDITORIAL_INSET_V2)
        self.assertEqual(settings["brand_tail_profile"], "bf_natural_tail_v6")
        self.assertEqual(settings["music_mix_profile"], "licensed_low_bed_v1")

    def test_evidence_qa_passes_a_conforming_render(self):
        report = evaluate_winner_packaging_evidence(
            {
                "durationSeconds": 18.0,
                "layoutProfile": FULL_BLEED_LAYOUT_PROFILE,
                "openingSourceTimeSeconds": 0.0,
                "firstSpeechSeconds": 0.08,
                "openingFullBleedSeconds": 1.5,
                "faceHeightRatio": 0.47,
                "faceDetected": True,
                "reframeCount": 2,
                "freezeHoldSeconds": 0.0,
                "blackCardSeconds": 0.0,
                "captionAfterSpeech": False,
            }
        )
        self.assertTrue(report["passed"])
        self.assertEqual(len(report["contentHash"]), 64)


if __name__ == "__main__":
    unittest.main()
