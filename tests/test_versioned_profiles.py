import io
import sys
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import main as cli

from shorts_generator.artifact_contracts import verify_seal
from shorts_generator.delivery_quality import (
    DELIVERY_QUALITY_ACOUSTIC_PROVIDER,
    DELIVERY_QUALITY_ANALYZER_VERSION,
    DELIVERY_QUALITY_DECISION_VERSION,
    DELIVERY_QUALITY_POLICY,
    DELIVERY_QUALITY_SAMPLE_RATE,
)
from shorts_generator.pipeline import build_ranking_manifest, generate_shorts
from shorts_generator.profiles import (
    BF_EDITORIAL_INSET_V1,
    BF_EDITORIAL_INSET_V2,
    BF_EDITORIAL_INSET_V4,
    BF_FEED_STOP_FORMAT_V1,
    BF_FEED_STOP_FORMAT_V2,
    BF_FEED_STOP_FORMAT_V3,
    BF_FEED_STOP_FORMAT_V4,
    BF_FEED_STOP_V1,
    BF_GROWTH_V2,
    BF_NATURAL_TAIL_V6,
    BF_VIRAL_MICRO_V1,
    BUDGET_FRIENDLY_CAPTION_STYLE,
    MOTIVATIONAL_PODCAST,
    MOTIVATIONAL_TENSION_MICRO_V1,
    MOTIVATIONAL_TENSION_MICRO_V2,
    DELIVERY_QUALITY_DECISION_VERSION as PROFILE_DELIVERY_QUALITY_VERSION,
    DELIVERY_QUALITY_POLICY as PROFILE_DELIVERY_QUALITY_POLICY,
    DELIVERY_QUALITY_TRUSTED_PROVIDER_IDENTITY,
    SPEECH_CLEANLINESS_DECISION_VERSION,
    MUSIC_ROTATION_VERSION,
    SEMANTIC_MUSIC_ROUTER_VERSION,
    VIRAL_MUSIC_CATALOG_VERSION,
    VIRAL_MUSIC_CATALOG_CONTENT_HASH,
    SPOKEN_CLARITY_DECISION_VERSION as PROFILE_SPOKEN_CLARITY_VERSION,
    SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY,
    motivational_music_profile_for_candidate,
    profile_manifest_metadata,
    render_settings_for_content,
    resolve_profile_bundle,
    selection_settings,
)
from shorts_generator.spoken_clarity import (
    SPOKEN_CLARITY_DECISION_VERSION,
    SPOKEN_CLARITY_POLICY,
)
from shorts_generator.music_router import (
    MUSIC_CATALOG_CONTENT_HASH,
    MUSIC_CATALOG_VERSION,
    MUSIC_ROTATION_POLICY_VERSION,
    MUSIC_ROUTER_DECISION_VERSION,
)
from shorts_generator.motivational_closure import (
    NATURAL_TAIL_POLICY_VERSION,
    SEMANTIC_CLOSURE_DECISION_VERSION,
)
from shorts_generator.hook_gate import (
    HOOK_GATE_DECISION_VERSION,
    HOOK_GATE_PROMPT_VERSION,
    HOOK_OPENING_START_TOLERANCE_SECONDS,
    HOOK_PAYOFF_MAX_LATENCY_SECONDS,
    HOOK_SIGNAL_MAX_LATENCY_SECONDS,
)


class VersionedProfileTests(unittest.TestCase):
    def test_feed_stop_v4_freezes_semantic_music_router_contract(self):
        resolved = resolve_profile_bundle(format_profile=BF_FEED_STOP_FORMAT_V4)
        metadata = profile_manifest_metadata(resolved)

        self.assertEqual(resolved["render_profile"], BF_EDITORIAL_INSET_V4)
        self.assertEqual(VIRAL_MUSIC_CATALOG_VERSION, MUSIC_CATALOG_VERSION)
        self.assertEqual(
            VIRAL_MUSIC_CATALOG_CONTENT_HASH,
            MUSIC_CATALOG_CONTENT_HASH,
        )
        self.assertEqual(
            SEMANTIC_MUSIC_ROUTER_VERSION,
            MUSIC_ROUTER_DECISION_VERSION,
        )
        self.assertEqual(MUSIC_ROTATION_VERSION, MUSIC_ROTATION_POLICY_VERSION)
        self.assertEqual(
            metadata["versions"]["music_catalog_version"],
            VIRAL_MUSIC_CATALOG_VERSION,
        )
        self.assertEqual(
            metadata["versions"]["music_catalog_content_hash"],
            VIRAL_MUSIC_CATALOG_CONTENT_HASH,
        )
        self.assertEqual(
            metadata["versions"]["music_router_version"],
            SEMANTIC_MUSIC_ROUTER_VERSION,
        )
        self.assertEqual(
            metadata["versions"]["music_rotation_version"],
            MUSIC_ROTATION_VERSION,
        )
        self.assertEqual(
            metadata["contract"]["music_selection"],
            {
                "catalog_version": VIRAL_MUSIC_CATALOG_VERSION,
                "catalog_content_hash": VIRAL_MUSIC_CATALOG_CONTENT_HASH,
                "router_version": SEMANTIC_MUSIC_ROUTER_VERSION,
                "rotation_version": MUSIC_ROTATION_VERSION,
                "rotation_window_size": 5,
                "rotation_lookback": 4,
                "semantic_scope": "complete_selected_point_and_payoff",
                "first_word_heuristic_allowed": False,
                "hidden_mutable_history_allowed": False,
                "catalog_asset_hash_required": True,
                "production_approval": False,
            },
        )
        self.assertNotIn(
            "music_selection",
            profile_manifest_metadata(
                resolve_profile_bundle(format_profile=BF_FEED_STOP_FORMAT_V3)
            )["contract"],
        )
        self.assertEqual(
            metadata["contract_sha256"],
            "5488b9a267c5d345a8b2f025230a6fa94e1dadc7fa3572c3ff1b57db49eb74fc",
        )

    def test_v4_whole_point_semantics_select_the_music_family(self):
        self.assertEqual(
            motivational_music_profile_for_candidate(
                {
                    "hook_semantic_topic": "confidence and discipline",
                    "whole_point_summary": (
                        "focus on the goal and do the work"
                    ),
                }
            ),
            "driving",
        )
        self.assertEqual(
            motivational_music_profile_for_candidate(
                {
                    "opening_claim_summary": (
                        "choose kindness in a relationship"
                    ),
                    "payoff_exact_quote": "love brings peace together",
                }
            ),
            "warm",
        )

    def test_feed_stop_v3_freezes_exact_delivery_quality_contract(self):
        expected_policy = {
            "decisionVersion": "bf-delivery-quality-v1.0.0",
            "spokenClarityDecisionVersion": "bf-spoken-clarity-v1.2.0",
            "pauseMinimumSeconds": 0.25,
            "longPauseMinimumSeconds": 0.80,
            "idealWordsPerMinute": [120.0, 195.0],
            "moderateWordsPerMinute": [90.0, 235.0],
            "severeWordsPerMinute": [60.0, 285.0],
            "moderateInternalPauseRatio": 0.28,
            "severeInternalPauseRatio": 0.45,
            "moderateRmsDynamicRangeDb": 2.0,
            "severeRmsDynamicRangeDb": 1.0,
            "moderateActiveFrameRatio": 0.25,
            "severeActiveFrameRatio": 0.12,
            "moderateOverallRmsDbfs": -44.0,
            "severeOverallRmsDbfs": -52.0,
            "borderlineStrengthMaximum": 65.0,
            "veryLowStrengthMaximum": 50.0,
            "veryLowMinimumCorroboratingCategories": 2,
            "calmDeliverySingleLowDynamicsDisposition": "pass",
            "affectInferenceAllowed": False,
        }
        expected_provider = {
            "analyzerVersion": "bf-delivery-quality-analyzer-v1.0.0",
            "decisionVersion": "bf-delivery-quality-v1.0.0",
            "acousticProvider": "ffmpeg-f32le-mono16k-rms-dynamics-v1",
            "audioDecoder": "ffmpeg-f32le-v1",
            "sampleRate": 16000,
            "rmsWindowMilliseconds": 50.0,
            "audioPolicy": "read_only_source_contiguous_selection",
            "affectInferenceUsed": False,
        }
        resolved = resolve_profile_bundle(format_profile=BF_FEED_STOP_FORMAT_V3)
        settings = selection_settings(resolved["selection_profile"])
        metadata = profile_manifest_metadata(resolved)

        self.assertEqual(
            DELIVERY_QUALITY_DECISION_VERSION,
            "bf-delivery-quality-v1.0.0",
        )
        self.assertEqual(
            PROFILE_DELIVERY_QUALITY_VERSION,
            DELIVERY_QUALITY_DECISION_VERSION,
        )
        self.assertEqual(DELIVERY_QUALITY_POLICY, expected_policy)
        self.assertEqual(PROFILE_DELIVERY_QUALITY_POLICY, expected_policy)
        self.assertEqual(
            DELIVERY_QUALITY_TRUSTED_PROVIDER_IDENTITY,
            expected_provider,
        )
        self.assertEqual(
            DELIVERY_QUALITY_ANALYZER_VERSION,
            expected_provider["analyzerVersion"],
        )
        self.assertEqual(
            DELIVERY_QUALITY_ACOUSTIC_PROVIDER,
            expected_provider["acousticProvider"],
        )
        self.assertEqual(
            DELIVERY_QUALITY_SAMPLE_RATE,
            expected_provider["sampleRate"],
        )
        self.assertNotIn("delivery_quality_decision_version", settings)
        self.assertNotIn("delivery_quality_policy", settings)
        self.assertEqual(
            metadata["versions"]["delivery_quality_decision_version"],
            DELIVERY_QUALITY_DECISION_VERSION,
        )
        self.assertEqual(
            metadata["contract"]["delivery_quality"],
            {
                "decision_version": DELIVERY_QUALITY_DECISION_VERSION,
                "policy": expected_policy,
                "provider_identity": expected_provider,
                "source_audio_modified": False,
                "affect_inference_allowed": False,
                "fail_closed": True,
                "production_approval": False,
            },
        )

    def test_feed_stop_freezes_fail_closed_spoken_clarity_contract(self):
        resolved = resolve_profile_bundle(format_profile=BF_FEED_STOP_FORMAT_V2)
        settings = selection_settings(resolved["selection_profile"])
        metadata = profile_manifest_metadata(resolved)

        self.assertEqual(
            PROFILE_SPOKEN_CLARITY_VERSION,
            SPOKEN_CLARITY_DECISION_VERSION,
        )
        self.assertEqual(
            metadata["versions"]["spoken_clarity_decision_version"],
            PROFILE_SPOKEN_CLARITY_VERSION,
        )
        self.assertNotIn("spoken_clarity_decision_version", settings)
        self.assertNotIn("spoken_clarity_policy", settings)
        self.assertEqual(
            metadata["contract"]["spoken_clarity"]["policy"][
                "asrTokenMatchReviewThreshold"
            ],
            0.72,
        )
        self.assertIsNone(
            metadata["contract"]["spoken_clarity"]["policy"][
                "asrTokenMatchRejectThreshold"
            ]
        )
        self.assertEqual(
            metadata["contract"]["spoken_clarity"]["policy"][
                "lowAsrTokenMatchDisposition"
            ],
            "review",
        )
        self.assertEqual(
            metadata["versions"]["spoken_clarity_decision_version"],
            SPOKEN_CLARITY_DECISION_VERSION,
        )
        self.assertEqual(
            metadata["contract"]["spoken_clarity"],
            {
                "decision_version": SPOKEN_CLARITY_DECISION_VERSION,
                "policy": SPOKEN_CLARITY_POLICY,
                "provider_identity": (
                    SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY
                ),
                "fail_closed": True,
                "production_approval": False,
            },
        )

    def test_feed_stop_v1_metadata_remains_exact_and_has_no_clarity_gate(self):
        metadata = profile_manifest_metadata(
            resolve_profile_bundle(format_profile=BF_FEED_STOP_FORMAT_V1)
        )

        self.assertEqual(
            metadata["contract_sha256"],
            "06ed8be7c0ea5c07a964a97d437b2a0a89f4ff5569555b4694856810aec9d498",
        )
        self.assertNotIn("spoken_clarity", metadata["contract"])
        self.assertNotIn(
            "spoken_clarity_decision_version",
            metadata["versions"],
        )

    def test_feed_stop_v2_metadata_hash_remains_exact_without_delivery_gate(self):
        metadata = profile_manifest_metadata(
            resolve_profile_bundle(format_profile=BF_FEED_STOP_FORMAT_V2)
        )

        self.assertEqual(
            metadata["contract_sha256"],
            "6da73250643936cb9b2ac72728ab012918095f5c3503e47d7312e8b9d32749c8",
        )
        self.assertNotIn("delivery_quality", metadata["contract"])
        self.assertNotIn(
            "delivery_quality_decision_version",
            metadata["versions"],
        )
        self.assertNotIn("dynamic_music", metadata["contract"])
        self.assertNotIn("dynamic_music_version", metadata["versions"])

    def test_feed_stop_selection_cannot_bypass_local_only_routing(self):
        resolved = resolve_profile_bundle(selection_profile=BF_FEED_STOP_V1)

        self.assertTrue(resolved["local_only"])
        with patch("shorts_generator.pipeline._run_api") as run_api:
            with self.assertRaisesRegex(ValueError, "local-only"):
                generate_shorts(
                    "https://example.test/source",
                    mode="api",
                    selection_profile=BF_FEED_STOP_V1,
                )
        run_api.assert_not_called()

    def test_new_feed_stop_generation_defaults_to_v2_and_rejects_explicit_v1(self):
        with patch(
            "shorts_generator.pipeline._run_local",
            return_value={"mode": "local"},
        ) as run_local, patch(
            "shorts_generator.pipeline._persist_performance_report",
            return_value=None,
        ):
            generate_shorts(
                "https://example.test/source",
                num_clips=1,
                mode="local",
                selection_profile=BF_FEED_STOP_V1,
                select_only=True,
            )

            resolved = run_local.call_args.args[5]
            self.assertEqual(
                resolved["format_profile"],
                BF_FEED_STOP_FORMAT_V2,
            )
            with self.assertRaisesRegex(ValueError, "legacy replay-only"):
                generate_shorts(
                    "https://example.test/source",
                    num_clips=1,
                    mode="local",
                    format_profile=BF_FEED_STOP_FORMAT_V1,
                    select_only=True,
                )

        run_local.assert_called_once()

    def test_hook_v4_generation_defaults_to_semantic_music_format_v4(self):
        with patch(
            "shorts_generator.pipeline._run_local",
            return_value={"mode": "local"},
        ) as run_local, patch(
            "shorts_generator.pipeline._persist_performance_report",
            return_value=None,
        ):
            generate_shorts(
                "https://example.test/source",
                num_clips=1,
                mode="local",
                selection_profile="bf_feed_stop_v2",
                select_only=True,
            )

        resolved = run_local.call_args.args[5]
        self.assertEqual(resolved["format_profile"], BF_FEED_STOP_FORMAT_V4)
        self.assertEqual(resolved["render_profile"], BF_EDITORIAL_INSET_V4)

    def test_feed_stop_freezes_fail_closed_speech_cleanliness_contract(self):
        metadata = profile_manifest_metadata(
            resolve_profile_bundle(format_profile=BF_FEED_STOP_FORMAT_V1)
        )

        self.assertEqual(
            metadata["versions"]["speech_cleanliness_decision_version"],
            SPEECH_CLEANLINESS_DECISION_VERSION,
        )
        self.assertEqual(
            metadata["contract"]["speech_cleanliness"],
            {
                "decision_version": SPEECH_CLEANLINESS_DECISION_VERSION,
                "filler_reject_count": 2,
                "uncovered_review_count": 3,
                "internal_gap_min_seconds": 0.24,
                "word_edge_guard_seconds": 0.04,
                "vad_event_min_seconds": 0.08,
                "fail_closed": True,
                "production_approval": False,
            },
        )

    def test_growth_v2_is_opt_in_and_carries_hook_contract(self):
        resolved = resolve_profile_bundle(format_profile=BF_GROWTH_V2)
        metadata = profile_manifest_metadata(resolved)

        self.assertEqual(resolved["selection_profile"], MOTIVATIONAL_TENSION_MICRO_V2)
        self.assertEqual(resolved["render_profile"], BF_EDITORIAL_INSET_V2)
        self.assertEqual(
            selection_settings(MOTIVATIONAL_TENSION_MICRO_V2)[
                "hook_gate_prompt_version"
            ],
            HOOK_GATE_PROMPT_VERSION,
        )
        self.assertFalse(
            selection_settings(MOTIVATIONAL_TENSION_MICRO_V2)[
                "production_approval"
            ]
        )
        self.assertEqual(
            metadata["versions"]["hook_gate_prompt_version"],
            HOOK_GATE_PROMPT_VERSION,
        )
        self.assertEqual(
            metadata["versions"]["hook_gate_decision_version"],
            HOOK_GATE_DECISION_VERSION,
        )
        self.assertEqual(
            metadata["versions"]["semantic_closure_decision_version"],
            SEMANTIC_CLOSURE_DECISION_VERSION,
        )
        self.assertEqual(
            metadata["versions"]["natural_tail_policy_version"],
            NATURAL_TAIL_POLICY_VERSION,
        )
        self.assertEqual(
            metadata["contract"]["brand_tail_profile"],
            BF_NATURAL_TAIL_V6,
        )
        self.assertTrue(
            metadata["contract"]["tail_policy"][
                "semantic_closure_seal_required"
            ]
        )
        self.assertTrue(
            metadata["contract"]["tail_policy"][
                "authentic_source_tail_only"
            ]
        )
        self.assertTrue(
            metadata["contract"]["tail_policy"][
                "fade_starts_after_source_end"
            ]
        )
        self.assertEqual(
            metadata["contract"]["semantic_closure"],
            {
                "decision_version": SEMANTIC_CLOSURE_DECISION_VERSION,
                "natural_tail_policy_version": NATURAL_TAIL_POLICY_VERSION,
                "hard_min_seconds": 8.0,
                "preferred_min_seconds": 15.0,
                "preferred_max_seconds": 21.0,
                "soft_max_seconds": 25.0,
                "hard_max_seconds": 30.0,
                "strong_evidence_min_score": 85.0,
                "word_end_tolerance_seconds": 0.05,
                "natural_tail_max_seconds": 0.75,
                "next_speech_safety_seconds": 0.04,
                "post_source_fade_seconds": 0.13,
                "production_approval": False,
            },
        )
        self.assertEqual(
            metadata["contract"]["hook_gate"],
            {
                "prompt_version": HOOK_GATE_PROMPT_VERSION,
                "decision_version": HOOK_GATE_DECISION_VERSION,
                "signal_max_latency_seconds": (
                    HOOK_SIGNAL_MAX_LATENCY_SECONDS
                ),
                "payoff_max_latency_seconds": (
                    HOOK_PAYOFF_MAX_LATENCY_SECONDS
                ),
                "opening_start_tolerance_seconds": (
                    HOOK_OPENING_START_TOLERANCE_SECONDS
                ),
                "production_approval": False,
            },
        )

    def test_combined_format_resolves_all_versioned_components(self):
        resolved = resolve_profile_bundle(format_profile=BF_VIRAL_MICRO_V1)

        self.assertEqual(resolved["content_profile"], MOTIVATIONAL_PODCAST)
        self.assertEqual(
            resolved["selection_profile"], MOTIVATIONAL_TENSION_MICRO_V1
        )
        self.assertEqual(resolved["render_profile"], BF_EDITORIAL_INSET_V1)
        self.assertTrue(resolved["local_only"])

    def test_combined_format_rejects_component_drift(self):
        with self.assertRaisesRegex(ValueError, "requires render_profile"):
            resolve_profile_bundle(
                format_profile=BF_VIRAL_MICRO_V1,
                render_profile=BUDGET_FRIENDLY_CAPTION_STYLE,
            )

    def test_micro_selection_contract_matches_frozen_duration_policy(self):
        settings = selection_settings(MOTIVATIONAL_TENSION_MICRO_V1)

        self.assertEqual(settings["preferred_min_seconds"], 10.0)
        self.assertEqual(settings["preferred_max_seconds"], 18.0)
        self.assertEqual(settings["hard_min_seconds"], 8.0)
        self.assertEqual(settings["hard_max_seconds"], 22.0)
        self.assertEqual(settings["artificial_cut_limit"], 0)

        settings["hard_max_seconds"] = 999
        self.assertEqual(
            selection_settings(MOTIVATIONAL_TENSION_MICRO_V1)["hard_max_seconds"],
            22.0,
        )

    def test_editorial_render_settings_are_explicit_and_legacy_is_unchanged(self):
        legacy = render_settings_for_content(MOTIVATIONAL_PODCAST)
        editorial = render_settings_for_content(
            MOTIVATIONAL_PODCAST,
            render_profile=BF_EDITORIAL_INSET_V1,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
            format_profile=BF_VIRAL_MICRO_V1,
        )

        self.assertEqual(legacy["layout_hint"], "motivational_editorial")
        self.assertEqual(legacy["caption_style"], BUDGET_FRIENDLY_CAPTION_STYLE)
        self.assertEqual(editorial["layout_hint"], "editorial_inset")
        self.assertEqual(editorial["caption_style"], BF_EDITORIAL_INSET_V1)
        self.assertEqual(editorial["grade_profile"], "high_contrast_grayscale_v1")
        self.assertEqual(editorial["typography_profile"], "kinetic_editorial_v1")
        self.assertEqual(editorial["artificial_cut_limit"], 0)

    def test_growth_v2_render_settings_bind_zero_freeze_tail(self):
        growth = render_settings_for_content(
            MOTIVATIONAL_PODCAST,
            render_profile=BF_EDITORIAL_INSET_V2,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V2,
            format_profile=BF_GROWTH_V2,
        )

        self.assertEqual(growth["render_profile"], BF_EDITORIAL_INSET_V2)
        self.assertEqual(growth["caption_style"], BF_EDITORIAL_INSET_V2)
        self.assertEqual(growth["brand_tail_profile"], BF_NATURAL_TAIL_V6)

    def test_manifest_binds_immutable_profile_contract_and_hash(self):
        profiles = resolve_profile_bundle(format_profile=BF_VIRAL_MICRO_V1)
        manifest = build_ranking_manifest(
            "https://example.test/source",
            "/cache/source.mp4",
            MOTIVATIONAL_PODCAST,
            [{"output_rank": 1, "final_score": 91.0}],
            [{"output_rank": 1, "clip_url": "/output/short.mp4"}],
            profiles=profiles,
            source_hash="a" * 64,
            transcript={
                "duration": 12.5,
                "segments": [
                    {
                        "start": 0.0,
                        "end": 12.0,
                        "text": "A complete exact thought.",
                        "words": [
                            {
                                "word": "A",
                                "start": 0.0,
                                "end": 1.0,
                            },
                            {
                                "word": "complete",
                                "start": 1.1,
                                "end": 5.0,
                            },
                            {
                                "word": "exact",
                                "start": 5.1,
                                "end": 8.0,
                            },
                            {
                                "word": "thought.",
                                "start": 8.1,
                                "end": 12.0,
                            }
                        ],
                    }
                ],
            },
        )

        metadata = manifest["profiles"]
        contract = metadata["contract"]
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(manifest["artifactType"], "RankingManifest")
        self.assertEqual(manifest["sourceHash"], "a" * 64)
        self.assertEqual(
            manifest["replayTranscriptManifest"]["sourceHash"],
            "a" * 64,
        )
        verify_seal(
            manifest["replayTranscriptManifest"],
            "BudgetFriendlyReplayTranscriptManifestV2",
        )
        verify_seal(manifest, "RankingManifest")
        self.assertEqual(contract["format_profile"], BF_VIRAL_MICRO_V1)
        self.assertEqual(
            contract["selection_profile"], MOTIVATIONAL_TENSION_MICRO_V1
        )
        self.assertEqual(contract["render_profile"], BF_EDITORIAL_INSET_V1)
        self.assertEqual(contract["layout_profile"], "editorial_inset_v1")
        self.assertEqual(contract["grade_profile"], "high_contrast_grayscale_v1")
        self.assertEqual(contract["caption_profile"], "kinetic_editorial_v1")
        self.assertEqual(contract["brand_tail_profile"], "bf_smooth_tail_v5")
        self.assertEqual(
            contract["tail_policy"],
            {
                "brand_hold_default_seconds": 0.85,
                "brand_hold_min_seconds": 0.8,
                "brand_hold_max_seconds": 0.9,
                "natural_reaction_max_seconds": 0.75,
                "safe_frame_settle_max_seconds": 0.08,
                "crossfade_max_seconds": 0.13,
                "audio_fade_max_seconds": 0.04,
                "output_max_seconds": 24.5,
                "freeze_allowed": False,
            },
        )
        self.assertEqual(contract["artificial_cut_limit"], 0)
        self.assertEqual(contract["semantic_completion_source_cut_allowance"], 1)
        self.assertEqual(contract["canvas"], {"width": 1080, "height": 1920, "fps": 30})
        self.assertEqual(len(metadata["contract_sha256"]), 64)
        self.assertEqual(metadata, profile_manifest_metadata(profiles))

    def test_api_mode_fails_before_any_remote_pipeline_call(self):
        with patch("shorts_generator.pipeline._run_api") as run_api:
            with self.assertRaisesRegex(ValueError, "local-only"):
                generate_shorts(
                    "https://example.test/source",
                    mode="api",
                    format_profile=BF_VIRAL_MICRO_V1,
                )

        run_api.assert_not_called()

    def test_editorial_profile_fails_closed_on_non_vertical_canvas(self):
        with patch("shorts_generator.pipeline._run_local") as run_local:
            with self.assertRaisesRegex(ValueError, "requires aspect_ratio='9:16'"):
                generate_shorts(
                    "/tmp/source.mp4",
                    mode="local",
                    aspect_ratio="1:1",
                    format_profile=BF_VIRAL_MICRO_V1,
                )

        run_local.assert_not_called()

    def test_local_dispatch_receives_resolved_profiles(self):
        expected = {"ok": True}
        with patch("shorts_generator.pipeline._run_local", return_value=expected) as run_local:
            result = generate_shorts(
                "/tmp/source.mp4",
                mode="local",
                format_profile=BF_VIRAL_MICRO_V1,
            )

        self.assertIs(result, expected)
        resolved = run_local.call_args.args[-1]
        self.assertEqual(resolved["render_profile"], BF_EDITORIAL_INSET_V1)
        self.assertEqual(
            resolved["selection_profile"], MOTIVATIONAL_TENSION_MICRO_V1
        )

    def test_cli_exposes_combined_format_profile(self):
        fake_result = {
            "mode": "local",
            "profiles": profile_manifest_metadata(
                resolve_profile_bundle(format_profile=BF_VIRAL_MICRO_V1)
            ),
            "source_video_url": "/tmp/source.mp4",
            "highlights": [],
            "shorts": [],
            "ranking": {"target_clips": 0, "requested_clips": 1},
        }
        argv = [
            "main.py",
            "/tmp/source.mp4",
            "--mode",
            "local",
            "--num-clips",
            "1",
            "--format-profile",
            BF_VIRAL_MICRO_V1,
        ]
        with patch.object(sys, "argv", argv), patch.object(
            cli, "generate_shorts", return_value=fake_result
        ) as generate, redirect_stdout(io.StringIO()):
            exit_code = cli.main()

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            generate.call_args.kwargs["format_profile"], BF_VIRAL_MICRO_V1
        )
        self.assertIsNone(generate.call_args.kwargs["selection_profile"])
        self.assertIsNone(generate.call_args.kwargs["render_profile"])


if __name__ == "__main__":
    unittest.main()
