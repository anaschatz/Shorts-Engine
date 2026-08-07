import builtins
import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from shorts_generator.artifact_contracts import content_hash
from shorts_generator.dynamic_music import (
    DYNAMIC_MUSIC_PLAN_VERSION,
    build_dynamic_music_plan,
)
from shorts_generator.editorial_qa import (
    _decode_sampled_frames_ffmpeg,
    _probe_video_metadata_ffprobe,
    analyze_editorial_frame,
    evaluate_editorial_render,
    expected_inset_box,
)
from shorts_generator.pipeline import build_editorial_render_evidence
from shorts_generator.music_router import route_music_for_candidate


class EditorialQaFrameTests(unittest.TestCase):
    def test_expected_geometry_matches_versioned_1080_contract(self):
        self.assertEqual(expected_inset_box((1080, 1920)), (30, 673, 1020, 574))

    def test_frame_metrics_accept_black_canvas_monochrome_rounded_inset(self):
        import cv2

        frame = np.zeros((1920, 1080, 3), dtype=np.uint8)
        x, y, width, height = expected_inset_box((1080, 1920))
        mask = np.zeros((height, width), dtype=np.uint8)
        radius = int(height * 0.18)
        cv2.rectangle(mask, (radius, 0), (width - radius, height), 255, -1)
        cv2.rectangle(mask, (0, radius), (width, height - radius), 255, -1)
        for center in (
            (radius, radius),
            (width - radius - 1, radius),
            (radius, height - radius - 1),
            (width - radius - 1, height - radius - 1),
        ):
            cv2.circle(mask, center, radius, 255, -1)
        panel = np.full((height, width, 3), 140, dtype=np.uint8)
        region = frame[y:y + height, x:x + width]
        region[mask > 0] = panel[mask > 0]

        report = analyze_editorial_frame(frame)

        self.assertGreaterEqual(report["outsideBlackRatio"], 0.999)
        self.assertLessEqual(report["grayscaleMeanChannelDelta"], 0.001)
        self.assertGreater(report["roundedCornerBlackRatio"], 0.08)
        self.assertAlmostEqual(report["insetWidthRatio"], 0.9444, places=3)

    def test_color_panel_fails_monochrome_measurement(self):
        frame = np.zeros((1280, 720, 3), dtype=np.uint8)
        x, y, width, height = expected_inset_box((720, 1280))
        frame[y:y + height, x:x + width] = (20, 90, 220)

        report = analyze_editorial_frame(frame)

        self.assertGreater(report["grayscaleMeanChannelDelta"], 0.25)


class EditorialQaVideoInspectionTests(unittest.TestCase):
    def test_v4_qa_rejects_tampered_semantic_music_selection(self):
        frame = np.zeros((8, 6, 3), dtype=np.uint8)

        def runner(command, **_kwargs):
            if command[0] == "ffprobe":
                return SimpleNamespace(
                    returncode=0,
                    stdout=(
                        '{"streams":[{"width":6,"height":8,'
                        '"avg_frame_rate":"30/1","nb_frames":"300"}]}'
                    ),
                )
            return SimpleNamespace(returncode=0, stdout=frame.tobytes())

        semantic = {
            "whole_point_summary": "Stop chasing approval and protect your boundary.",
            "payoff_exact_quote": "You do not owe every argument a response.",
        }
        decision = route_music_for_candidate(semantic, verify_assets=False)
        track = decision["catalogTrack"]
        plan_body = build_dynamic_music_plan(
            {"music_profile": decision["treatmentProfile"]},
            [],
            duration=10.0,
            speech_end_seconds=8.5,
            natural_tail_end_seconds=9.15,
            music_profile=decision["treatmentProfile"],
        )
        plan = {**plan_body, "contentHash": content_hash(plan_body)}
        expected_receipt = {
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
        manifest = {
            "formatProfile": "bf_feed_stop_format_v4",
            "renderProfile": "bf_editorial_inset_v4",
            "timeline": {"firstVisibleTextSeconds": 0.0, "semanticEndSeconds": 8.5},
            "typography": {"maxHeroScale": 2.2},
            "cuts": {"sourceCutCount": 0, "sourceCutLimit": 2, "artificialCutCount": 0},
            "brandTail": {"profile": "bf_natural_tail_v6"},
            "music": {
                "profile": decision["treatmentProfile"],
                "resolvedProfile": decision["treatmentProfile"],
                "mixProfile": DYNAMIC_MUSIC_PLAN_VERSION,
                "version": DYNAMIC_MUSIC_PLAN_VERSION,
                "dynamic": True,
                "applied": True,
                "asset": {
                    "assetId": f"sha256:{track['sha256']}",
                    "sha256": track["sha256"],
                    "byteLength": track["byteLength"],
                },
                "planHash": plan["contentHash"],
                "plan": plan,
                "selectionHash": decision["contentHash"],
                "selection": decision,
                "catalogAsset": expected_receipt,
                "startSeconds": decision["startSeconds"],
            },
        }
        manifest["contentHash"] = content_hash(manifest)

        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.touch()
            report = evaluate_editorial_render(
                str(video), render_manifest=manifest, sample_count=1, runner=runner
            )
            tampered = copy.deepcopy(manifest)
            tampered["music"]["catalogAsset"]["trackId"] = "pixabay:tampered"
            tampered["contentHash"] = content_hash(tampered)
            tampered_report = evaluate_editorial_render(
                str(video), render_manifest=tampered, sample_count=1, runner=runner
            )

        gates = {gate["code"]: gate for gate in report["gates"]}
        self.assertTrue(gates["MUSIC_ROUTING_DECISION"]["passed"])
        self.assertTrue(gates["MUSIC_CATALOG_ASSET"]["passed"])
        tampered_gates = {gate["code"]: gate for gate in tampered_report["gates"]}
        self.assertFalse(tampered_gates["MUSIC_CATALOG_ASSET"]["passed"])

    def test_ffprobe_parses_fractional_fps_without_opencv(self):
        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(
                returncode=0,
                stdout=(
                    '{"streams":[{"width":1080,"height":1920,'
                    '"avg_frame_rate":"30000/1001","nb_frames":"391"}]}'
                ),
            )

        metadata = _probe_video_metadata_ffprobe("short.mp4", runner=runner)

        self.assertEqual(metadata[:2], (1080, 1920))
        self.assertAlmostEqual(metadata[2], 30000 / 1001)
        self.assertEqual(metadata[3], 391)
        command, kwargs = calls[0]
        self.assertEqual(command[0], "ffprobe")
        self.assertIn("stream=width,height,avg_frame_rate", " ".join(command))
        self.assertEqual(
            kwargs,
            {"check": True, "capture_output": True, "text": True},
        )

    def test_ffprobe_derives_frame_count_from_format_duration(self):
        def runner(_command, **_kwargs):
            return SimpleNamespace(
                returncode=0,
                stdout=(
                    '{"streams":[{"width":6,"height":8,'
                    '"avg_frame_rate":"24/1","nb_frames":"N/A"}],'
                    '"format":{"duration":"2.5"}}'
                ),
            )

        self.assertEqual(
            _probe_video_metadata_ffprobe("short.mp4", runner=runner),
            (6, 8, 24.0, 60),
        )

    def test_ffmpeg_decodes_selected_raw_bgr_frames(self):
        first = np.arange(12, dtype=np.uint8).reshape(2, 2, 3)
        second = np.full((2, 2, 3), 240, dtype=np.uint8)
        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(
                returncode=0,
                stdout=first.tobytes() + second.tobytes(),
            )

        frames = _decode_sampled_frames_ffmpeg(
            "short.mp4",
            2,
            2,
            (0, 9),
            runner=runner,
        )

        self.assertEqual(len(frames), 2)
        self.assertTrue(np.array_equal(frames[0], first))
        self.assertTrue(np.array_equal(frames[1], second))
        command, kwargs = calls[0]
        self.assertEqual(command[0], "ffmpeg")
        self.assertIn("select=eq(n\\,0)+eq(n\\,9)", command)
        self.assertIn("bgr24", command)
        self.assertEqual(kwargs, {"check": True, "capture_output": True})

    def test_successful_ffmpeg_path_never_imports_cv2(self):
        frame = np.zeros((8, 6, 3), dtype=np.uint8)
        commands = []

        def runner(command, **_kwargs):
            commands.append(command)
            if command[0] == "ffprobe":
                return SimpleNamespace(
                    returncode=0,
                    stdout=(
                        '{"streams":[{"width":6,"height":8,'
                        '"avg_frame_rate":"30/1","nb_frames":"300"}]}'
                    ),
                )
            return SimpleNamespace(
                returncode=0,
                stdout=frame.tobytes() + frame.tobytes(),
            )

        real_import = builtins.__import__

        def import_without_cv2(name, *args, **kwargs):
            if name == "cv2":
                raise AssertionError("successful ffmpeg QA imported cv2")
            return real_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.touch()
            with patch("builtins.__import__", side_effect=import_without_cv2):
                report = evaluate_editorial_render(
                    str(video),
                    sample_count=2,
                    runner=runner,
                )

        self.assertEqual([command[0] for command in commands], ["ffprobe", "ffmpeg"])
        self.assertEqual(
            report["video"],
            {
                "width": 6,
                "height": 8,
                "fps": 30.0,
                "frameCount": 300,
                "durationSeconds": 10.0,
            },
        )
        self.assertEqual(report["sampleCount"], 2)

    def test_candidate_verified_acoustic_boundary_passes_timing_qa(self):
        frame = np.zeros((8, 6, 3), dtype=np.uint8)

        def runner(command, **_kwargs):
            if command[0] == "ffprobe":
                return SimpleNamespace(
                    returncode=0,
                    stdout=(
                        '{"streams":[{"width":6,"height":8,'
                        '"avg_frame_rate":"30/1","nb_frames":"663"}]}'
                    ),
                )
            return SimpleNamespace(returncode=0, stdout=frame.tobytes())

        manifest = {
            "formatProfile": "bf_viral_micro_v1",
            "renderProfile": "bf_editorial_inset_v1",
            "timeline": {
                "firstVisibleTextSeconds": 0.0,
                "semanticEndSeconds": 20.8,
            },
            "typography": {"maxHeroScale": 2.2},
            "cuts": {
                "sourceCutCount": 0,
                "sourceCutLimit": 2,
                "semanticCompletionSourceCutException": False,
                "artificialCutCount": 0,
            },
            "brandTail": {
                "profile": "bf_reference_tail_v2",
                "durationSeconds": 1.25,
                "startSeconds": 20.85,
                "naturalReactionSeconds": 0.0,
                "crossfadeSeconds": 0.11,
                "freezeHoldSeconds": 0.0,
                "sourceContentEndTime": 20.85,
                "nextSpokenWordStart": 20.86,
                "nextSpeechSafetySeconds": 0.01,
                "acousticSpeechEndTime": 20.74,
                "transcriptNextSpokenWordStart": 20.8,
                "acousticBoundarySource": "candidate_verified_acoustic",
                "verifiedAcousticSpeechEndTime": 20.74,
                "verifiedNextSpokenWordStart": 20.86,
                "verifiedNextSpeechSafetySeconds": 0.01,
                "verifiedAcousticBoundaryEvidence": "waveform review",
                "sourceSpeechLeakGuardPassed": True,
            },
        }

        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.touch()
            report = evaluate_editorial_render(
                str(video),
                render_manifest=manifest,
                sample_count=1,
                runner=runner,
            )

        gates = {gate["code"]: gate for gate in report["gates"]}
        self.assertTrue(gates["ACOUSTIC_BOUNDARY_EVIDENCE"]["passed"])
        self.assertTrue(gates["NO_NEXT_SPEECH_LEAK"]["passed"])
        self.assertTrue(gates["TAIL_AFTER_SEMANTIC_END"]["passed"])

    def test_v4_verified_visual_safe_end_passes_without_relabeling_speech(self):
        frame = np.zeros((8, 6, 3), dtype=np.uint8)

        def runner(command, **_kwargs):
            if command[0] == "ffprobe":
                return SimpleNamespace(
                    returncode=0,
                    stdout=(
                        '{"streams":[{"width":6,"height":8,'
                        '"avg_frame_rate":"30/1","nb_frames":"650"}]}'
                    ),
                )
            return SimpleNamespace(returncode=0, stdout=frame.tobytes())

        manifest = {
            "formatProfile": "bf_viral_micro_v1",
            "renderProfile": "bf_editorial_inset_v1",
            "timeline": {
                "firstVisibleTextSeconds": 0.0,
                "semanticEndSeconds": 20.5,
            },
            "typography": {"maxHeroScale": 2.2},
            "cuts": {
                "sourceCutCount": 0,
                "sourceCutLimit": 2,
                "semanticCompletionSourceCutException": False,
                "artificialCutCount": 0,
            },
            "brandTail": {
                "profile": "bf_smooth_tail_v4",
                "durationSeconds": 0.85,
                "startSeconds": 20.828,
                "naturalReactionSeconds": 0.328,
                "visualCrossfadeSeconds": 0.13,
                "audioFadeSeconds": 0.04,
                "speechAudioEndTime": 20.828,
                "semanticSourceMarginSeconds": 0.328,
                "musicReleaseSeconds": 0.18,
                "freezeHoldSeconds": 0.0,
                "sourceContentEndTime": 20.828,
                "nextSpokenWordStart": 20.98,
                "nextSpeechSafetySeconds": 0.01,
                "acousticSpeechEndTime": 20.5,
                "acousticBoundarySource": "candidate_verified_acoustic",
                "verifiedAcousticSpeechEndTime": 20.5,
                "verifiedNextSpokenWordStart": 20.98,
                "verifiedNextSpeechSafetySeconds": 0.01,
                "verifiedAcousticBoundaryEvidence": "waveform review",
                "verifiedVisualSafeEndTime": 20.828,
                "verifiedVisualBoundaryEvidence": "scene-cut review",
                "visualSafeEndGuardPassed": True,
                "sourceSpeechLeakGuardPassed": True,
            },
        }

        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.touch()
            report = evaluate_editorial_render(
                str(video),
                render_manifest=manifest,
                sample_count=1,
                runner=runner,
            )

        gates = {gate["code"]: gate for gate in report["gates"]}
        self.assertTrue(gates["VISUAL_SAFE_END_BOUNDARY"]["passed"])
        self.assertTrue(gates["NO_NEXT_SPEECH_LEAK"]["passed"])
        self.assertEqual(
            gates["NO_NEXT_SPEECH_LEAK"]["actual"]["nextSpokenWordStart"],
            20.98,
        )

    def test_growth_v2_requires_sealed_live_source_tail_with_zero_freeze(self):
        frame = np.zeros((8, 6, 3), dtype=np.uint8)

        def runner(command, **_kwargs):
            if command[0] == "ffprobe":
                return SimpleNamespace(
                    returncode=0,
                    stdout=(
                        '{"streams":[{"width":6,"height":8,'
                        '"avg_frame_rate":"30/1","nb_frames":"646"}]}'
                    ),
                )
            return SimpleNamespace(returncode=0, stdout=frame.tobytes())

        manifest = {
            "formatProfile": "bf_growth_v2",
            "renderProfile": "bf_editorial_inset_v2",
            "timeline": {
                "firstVisibleTextSeconds": 0.0,
                "semanticEndSeconds": 20.0,
            },
            "typography": {"maxHeroScale": 2.2},
            "cuts": {
                "sourceCutCount": 0,
                "sourceCutLimit": 2,
                "semanticCompletionSourceCutException": False,
                "artificialCutCount": 0,
            },
            "brandTail": {
                "profile": "bf_natural_tail_v6",
                "durationSeconds": 0.85,
                "startSeconds": 20.69,
                "naturalReactionSeconds": 0.56,
                "visualCrossfadeSeconds": 0.13,
                "audioFadeSeconds": 0.04,
                "speechAudioEndTime": 20.56,
                "semanticSourceMarginSeconds": 0.56,
                "musicReleaseSeconds": 0.18,
                "freezeHoldSeconds": 0.0,
                "sourceContentEndTime": 20.56,
                "nextSpokenWordStart": 20.70,
                "nextSpeechSafetySeconds": 0.04,
                "acousticSpeechEndTime": 20.0,
                "acousticBoundarySource": "transcript",
                "sourceSpeechLeakGuardPassed": True,
                "semanticClosureDecisionVersion": (
                    "semantic-closure-decision-v1.0.0"
                ),
                "semanticClosureStatus": "pass",
                "semanticClosureSpeechEndTime": 20.0,
                "captionsSourceEndTime": 20.0,
                "plannedNaturalTailEndTime": 20.56,
            },
        }

        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.touch()
            report = evaluate_editorial_render(
                str(video),
                render_manifest=manifest,
                sample_count=1,
                runner=runner,
            )

        gates = {gate["code"]: gate for gate in report["gates"]}
        self.assertTrue(gates["PROFILE_BINDING"]["passed"])
        self.assertTrue(gates["FORMAT_BINDING"]["passed"])
        self.assertTrue(gates["SEMANTIC_CLOSURE_SEAL"]["passed"])
        self.assertTrue(gates["NO_FREEZE_HOLD"]["passed"])
        self.assertTrue(gates["FADE_AFTER_SOURCE_LANDING"]["passed"])

    def test_v3_qa_binds_format_version_and_sealed_music_plan(self):
        frame = np.zeros((8, 6, 3), dtype=np.uint8)

        def runner(command, **_kwargs):
            if command[0] == "ffprobe":
                return SimpleNamespace(
                    returncode=0,
                    stdout=(
                        '{"streams":[{"width":6,"height":8,'
                        '"avg_frame_rate":"30/1","nb_frames":"300"}]}'
                    ),
                )
            return SimpleNamespace(returncode=0, stdout=frame.tobytes())

        plan = build_dynamic_music_plan(
            {"music_profile": "reflective"},
            [],
            duration=10.0,
            speech_end_seconds=8.5,
            natural_tail_end_seconds=9.15,
        )
        manifest = build_editorial_render_evidence(
            {
                "format_profile": "bf_feed_stop_format_v3",
                "selection_profile": "bf_feed_stop_v2",
                "render_profile": "bf_editorial_inset_v3",
                "layout_profile": "editorial_inset_v1",
                "grade_profile": "high_contrast_grayscale_v1",
                "typography_profile": "kinetic_editorial_v1",
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
                "first_visible_text_seconds": 0.0,
                "semantic_end_seconds": 8.5,
                "max_hero_scale": 2.2,
                "source_cut_count": 0,
                "effective_source_cut_limit": 2,
                "artificial_cut_count": 0,
                "brand_tail_profile": "bf_natural_tail_v6",
                "brand_tail_seconds": 0.85,
                "brand_tail_start_seconds": 9.15,
                "natural_tail_seconds": 0.52,
                "transition_tail_seconds": 0.13,
                "audio_transition_tail_seconds": 0.04,
                "speech_audio_end_time": 9.02,
                "semantic_source_margin_seconds": 0.52,
                "music_release_tail_seconds": 0.18,
                "freeze_hold_seconds": 0.0,
                "source_content_end_time": 9.02,
                "next_spoken_word_start": 9.20,
                "next_speech_safety_seconds": 0.04,
                "acoustic_speech_end_time": 8.5,
                "acoustic_boundary_source": "transcript",
                "source_speech_leak_guard_passed": True,
                "semantic_closure_decision_version": (
                    "semantic-closure-decision-v1.0.0"
                ),
                "semantic_closure_status": "pass",
                "semantic_closure_speech_end_time": 8.5,
                "captions_source_end_time": 8.5,
                "planned_natural_tail_end_time": 9.02,
            }
        )

        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.touch()
            report = evaluate_editorial_render(
                str(video),
                render_manifest=manifest,
                sample_count=1,
                runner=runner,
            )
            tampered = copy.deepcopy(manifest)
            tampered["music"]["plan"]["events"][0]["startGain"] += 0.01
            tampered_report = evaluate_editorial_render(
                str(video),
                render_manifest=tampered,
                sample_count=1,
                runner=runner,
            )

        gates = {gate["code"]: gate for gate in report["gates"]}
        self.assertTrue(gates["PROFILE_BINDING"]["passed"])
        self.assertTrue(gates["FORMAT_BINDING"]["passed"])
        self.assertTrue(gates["MUSIC_PLAN_REQUIRED"]["passed"])
        self.assertTrue(gates["MUSIC_MIX_APPLIED"]["passed"])
        self.assertTrue(gates["MUSIC_PROFILE_BINDING"]["passed"])
        self.assertTrue(gates["MUSIC_ASSET_BINDING"]["passed"])
        self.assertTrue(gates["MUSIC_VERSION_BINDING"]["passed"])
        self.assertTrue(gates["MUSIC_PLAN_HASH"]["passed"])
        self.assertTrue(gates["MUSIC_PLAN_VALID"]["passed"])

        tampered_gates = {
            gate["code"]: gate for gate in tampered_report["gates"]
        }
        self.assertFalse(tampered_gates["MUSIC_PLAN_HASH"]["passed"])

        missing_mix = copy.deepcopy(manifest)
        missing_mix["music"]["applied"] = False
        missing_mix["contentHash"] = content_hash(missing_mix)
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.touch()
            missing_mix_report = evaluate_editorial_render(
                str(video),
                render_manifest=missing_mix,
                sample_count=1,
                runner=runner,
            )
        missing_mix_gates = {
            gate["code"]: gate for gate in missing_mix_report["gates"]
        }
        self.assertFalse(missing_mix_gates["MUSIC_MIX_APPLIED"]["passed"])

    def test_truncated_ffmpeg_output_uses_cv2_fallback(self):
        fallback_frame = np.zeros((8, 6, 3), dtype=np.uint8)
        fallback_sample = analyze_editorial_frame(fallback_frame)

        def runner(command, **_kwargs):
            if command[0] == "ffprobe":
                return SimpleNamespace(
                    returncode=0,
                    stdout=(
                        '{"streams":[{"width":6,"height":8,'
                        '"avg_frame_rate":"30/1","nb_frames":"300"}]}'
                    ),
                )
            return SimpleNamespace(returncode=0, stdout=b"truncated")

        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.touch()
            with patch(
                "shorts_generator.editorial_qa._inspect_video_cv2",
                return_value=(6, 8, 30.0, 300, [fallback_sample]),
            ) as fallback:
                report = evaluate_editorial_render(str(video), runner=runner)

        fallback.assert_called_once_with(str(video), 9)
        self.assertEqual(report["sampleCount"], 1)


if __name__ == "__main__":
    unittest.main()
