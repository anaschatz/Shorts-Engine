import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np

from shorts_generator.dynamic_music import build_dynamic_music_plan
from shorts_generator.local.clipper import (
    BF_EDITORIAL_INSET_CORNER_RADIUS_RATIO,
    BF_EDITORIAL_INSET_LAYOUT,
    BF_EDITORIAL_INSET_RENDER_PROFILE,
    BF_EDITORIAL_OUTPUT_FPS,
    BUDGET_FRIENDLY_CAPTION_STYLE,
    BF_SMOOTH_TAIL_V3,
    BF_SMOOTH_TAIL_V4,
    _CaptionRenderer,
    _EditorialInsetComposer,
    _apply_bf_editorial_grade,
    _blend_realesrgan_reference,
    _blend_caption_kinetic_roi,
    _bf_brand_transition_progress,
    _bf_editorial_tail_plan,
    _build_word_cues,
    _compose_editorial_inset,
    _compose_editorial_panel,
    crop_highlights_local,
    _cut_subclip_command,
    _detect_clip_layout,
    _detect_hard_source_cuts,
    _draw_bf_brand_tail,
    _extract_editorial_panel,
    _editorial_inset_box,
    _editorial_kinetic_state,
    _editorial_panel_source_coverage,
    _get_or_create_lossless_cut,
    _lossless_cut_cache_key,
    _local_temporary_directory,
    _motivational_audio_filter,
    _music_asset_receipt,
    _output_dimensions,
    _prewarm_bf_editorial_realesrgan_cache,
    _prune_lossless_cut_cache,
    _prune_realesrgan_cache,
    _read_realesrgan_cache_frame,
    _realesrgan_cache_key,
    _realesrgan_cache_path,
    _realesrgan_command,
    _realesrgan_runtime_scale,
    _realesrgan_unique_frame_index,
    _realesrgan_working_geometry,
    _resolve_bf_brand_tail_seconds,
    _resolve_motivational_music_profile,
    _raw_video_command,
    _should_bypass_editorial_realesrgan,
    _trim_opening_dead_air,
    _read_visual_analysis_cache,
    _visual_analysis_cache_key,
    _write_visual_analysis_cache,
    _write_realesrgan_cache_frame,
)


class BfEditorialInsetProfileTests(unittest.TestCase):
    def test_v3_music_override_drives_plan_and_asset_receipt(self):
        with patch(
            "shorts_generator.local.clipper.LOCAL_MOTIVATIONAL_MUSIC_PROFILE",
            "driving",
        ):
            resolved = _resolve_motivational_music_profile("reflective")
        plan = build_dynamic_music_plan(
            {"music_profile": "reflective"},
            [],
            duration=10.0,
            speech_end_seconds=9.0,
            natural_tail_end_seconds=9.5,
            music_profile=resolved,
        )
        self.assertEqual(resolved, "driving")
        self.assertEqual(plan["musicProfile"], "driving")

        with tempfile.TemporaryDirectory() as directory:
            asset = Path(directory) / "licensed.mp3"
            asset.write_bytes(b"licensed-dynamic-music-fixture")
            receipt = _music_asset_receipt(str(asset))
        self.assertEqual(receipt["byteLength"], 30)
        self.assertEqual(receipt["assetId"], f"sha256:{receipt['sha256']}")

    def test_source_cut_detector_preserves_real_camera_changes(self):
        stderr = "\n".join(
            [
                "frame:0 pts:7033 pts_time:7.033",
                "lavfi.scene_score=0.571937",
                "frame:1 pts:8300 pts_time:8.300",
                "lavfi.scene_score=0.562416",
                "frame:2 pts:8350 pts_time:8.350",
                "lavfi.scene_score=0.400000",
                "frame:3 pts:19367 pts_time:19.367",
                "lavfi.scene_score=0.537857",
            ]
        )
        with patch(
            "shorts_generator.local.clipper.subprocess.run",
            return_value=SimpleNamespace(returncode=0, stderr=stderr),
        ):
            cuts = _detect_hard_source_cuts("source.mkv", 21.9)
        self.assertEqual(cuts, [7.033, 8.3, 19.367])

    def test_heavy_frame_staging_uses_configured_local_work_dir(self):
        with tempfile.TemporaryDirectory() as directory:
            work_dir = Path(directory) / "work"
            with patch(
                "shorts_generator.local.clipper.LOCAL_WORK_DIR",
                str(work_dir),
            ):
                with _local_temporary_directory("frames-") as staging:
                    staging_path = Path(staging)
                    self.assertEqual(staging_path.parent, work_dir)
                    self.assertTrue(staging_path.is_dir())

            self.assertFalse(staging_path.exists())

    def test_profile_has_immutable_delivery_dimensions_and_fps(self):
        self.assertEqual(
            _output_dimensions("9:16", BF_EDITORIAL_INSET_RENDER_PROFILE),
            (1080, 1920),
        )
        command = _cut_subclip_command(
            "source.mp4",
            1.0,
            11.75,
            "cut.mkv",
            fps=BF_EDITORIAL_OUTPUT_FPS,
        )
        self.assertIn("fps=30", command)

    def test_lossless_cut_command_preserves_exact_ffmpeg_contract(self):
        self.assertEqual(
            _cut_subclip_command(
                "source.mp4",
                1.25,
                11.75,
                "cut.mkv",
                fps=30.0,
            ),
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-ss",
                "1.250",
                "-i",
                "source.mp4",
                "-t",
                "10.500",
                "-vf",
                "fps=30",
                "-c:v",
                "ffv1",
                "-level",
                "3",
                "-c:a",
                "pcm_s16le",
                "cut.mkv",
            ],
        )

    def test_cache_pruners_evict_oldest_entries_to_ninety_percent_target(self):
        for extension, prune in (
            ("png", lambda root: _prune_realesrgan_cache(root, 100)),
            ("mkv", lambda root: _prune_lossless_cut_cache(root, 100)),
        ):
            with self.subTest(extension=extension):
                with tempfile.TemporaryDirectory() as temporary_dir:
                    cache_dir = Path(temporary_dir)
                    entries = []
                    for index in range(3):
                        path = cache_dir / f"{index:02x}" / f"entry-{index}.{extension}"
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(bytes([index]) * 60)
                        timestamp_ns = 1_700_000_000_000_000_000 + index
                        os.utime(path, ns=(timestamp_ns, timestamp_ns))
                        entries.append(path)

                    removed, remaining_bytes = prune(cache_dir)

                    self.assertEqual((removed, remaining_bytes), (2, 60))
                    self.assertFalse(entries[0].exists())
                    self.assertFalse(entries[1].exists())
                    self.assertTrue(entries[2].exists())

    def test_panel_geometry_and_radius_match_reference_contract(self):
        source = np.full((1080, 1920, 3), 235, dtype=np.uint8)
        output_size = (720, 1280)
        left, top, width, height = _editorial_inset_box(
            (1920, 1080),
            output_size,
        )

        self.assertEqual((left, top, width, height), (22, 450, 676, 380))
        self.assertGreaterEqual(width / output_size[0], 0.92)
        self.assertLessEqual(width / output_size[0], 0.95)
        self.assertLessEqual(height / output_size[1], 0.36)

        composed = _compose_editorial_inset(cv2, source, output_size)
        radius = int(round(height * BF_EDITORIAL_INSET_CORNER_RADIUS_RATIO))
        self.assertEqual(composed.shape, (1280, 720, 3))
        self.assertEqual(int(composed[top + 8, left + 8].max()), 0)
        self.assertGreater(int(composed[top, left + radius].mean()), 220)
        self.assertGreater(int(composed[top + height // 2, left + width // 2].mean()), 220)
        self.assertEqual(int(composed[top - 1, left + width // 2].max()), 0)

    def test_prepared_panel_composition_matches_existing_editorial_geometry(self):
        source = np.zeros((1080, 1920, 3), dtype=np.uint8)
        source[:, :, 0] = np.arange(1920, dtype=np.uint16) % 256
        source[:, :, 1] = np.arange(1080, dtype=np.uint16)[:, None] % 256
        panel = _extract_editorial_panel(source)

        direct = _compose_editorial_inset(cv2, source, (1080, 1920))
        prepared = _compose_editorial_panel(cv2, panel, (1080, 1920))

        self.assertTrue(np.array_equal(prepared, direct))

    def test_reusable_editorial_composer_is_pixel_identical_to_full_canvas_grade(self):
        rng = np.random.default_rng(20260721)
        source = rng.integers(0, 256, (360, 640, 3), dtype=np.uint8)
        output_size = (720, 1280)
        expected = _apply_bf_editorial_grade(
            cv2,
            _compose_editorial_inset(cv2, source, output_size),
        )

        with (
            patch.object(cv2, "rectangle", wraps=cv2.rectangle) as rectangle,
            patch.object(cv2, "circle", wraps=cv2.circle) as circle,
        ):
            composer = _EditorialInsetComposer(
                cv2,
                (source.shape[1], source.shape[0]),
                output_size,
            )
            self.assertGreater(rectangle.call_count, 0)
            self.assertGreater(circle.call_count, 0)
            rectangle.reset_mock()
            circle.reset_mock()
            first = composer.compose_source(source, apply_bf_grade=True)
            first_pixels = first.copy()
            second = composer.compose_source(source, apply_bf_grade=True)

        np.testing.assert_array_equal(first_pixels, expected)
        np.testing.assert_array_equal(second, expected)
        self.assertIs(first, second)
        rectangle.assert_not_called()
        circle.assert_not_called()

    def test_caption_roi_blend_matches_previous_full_frame_algorithm(self):
        rng = np.random.default_rng(19)
        frame = rng.integers(0, 256, (180, 320, 3), dtype=np.uint8)
        captioned = frame.copy()
        captioned[45:132, 71:260] = rng.integers(
            0,
            256,
            (87, 189, 3),
            dtype=np.uint8,
        )
        box = (64, 38, 205, 102)
        for reveal, opacity in ((1.0, 0.35), (0.63, 0.72), (0.0, 1.0)):
            masked = frame.copy()
            x, y, width, height = box
            x0 = max(0, x)
            y0 = max(0, y)
            x1 = min(frame.shape[1], x + width)
            y1 = min(frame.shape[0], y + height)
            reveal_top = max(
                y0,
                min(y1, y0 + int(round((y1 - y0) * (1.0 - reveal)))),
            )
            masked[reveal_top:y1, x0:x1] = captioned[
                reveal_top:y1,
                x0:x1,
            ]
            expected = cv2.addWeighted(
                masked,
                opacity,
                frame,
                1.0 - opacity,
                0.0,
            )

            actual = _blend_caption_kinetic_roi(
                cv2,
                frame,
                captioned,
                box,
                mask_reveal=reveal,
                opacity=opacity,
            )

            np.testing.assert_array_equal(actual, expected)

    def test_editorial_caption_layout_cache_preserves_rendered_pixels(self):
        frame = np.zeros((1280, 720, 3), dtype=np.uint8)
        renderer = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BF_EDITORIAL_INSET_RENDER_PROFILE,
            render_profile=BF_EDITORIAL_INSET_RENDER_PROFILE,
        )
        cue = {
            "words": ["GOOD", "PEOPLE", "TELL", "TRUTH"],
            "visible_word_count": 4,
            "emphasis_index": 3,
            "phrase_id": 1,
            "sentence_id": 1,
            "sentence_phrase_index": 0,
            "sentence_phrase_count": 1,
            "caption_track_progress": 0.5,
            "typography_variant": "hero",
            "typography_base_scale": 0.8,
            "typography_anchor_scale": 2.25,
            "typography_accent_style": "base",
            "typography_body_style": "support",
            "phrase_start": 0.0,
            "start": 0.0,
            "end": 1.0,
            "_render_elapsed": 0.20,
        }
        safe_box = _editorial_inset_box((1920, 1080), (720, 1280))

        first = renderer.draw(frame, cue, safe_box=safe_box)
        second = renderer.draw(frame, cue, safe_box=safe_box)

        np.testing.assert_array_equal(second, first)
        self.assertEqual(renderer.editorial_layout_cache_misses, 1)
        self.assertEqual(renderer.editorial_layout_cache_hits, 1)

    def test_panel_reference_blend_matches_full_canvas_pixel_for_pixel(self):
        rng = np.random.default_rng(42)
        source = rng.integers(0, 256, (360, 640, 3), dtype=np.uint8)
        output_size = (1080, 1920)
        _, panel_target = _realesrgan_working_geometry(
            (640, 360),
            output_size,
            2,
            editorial_panel_only=True,
        )
        enhanced_panel = rng.integers(
            0,
            256,
            (panel_target[1], panel_target[0], 3),
            dtype=np.uint8,
        )

        previous = _blend_realesrgan_reference(
            cv2,
            _compose_editorial_panel(cv2, enhanced_panel, output_size),
            _compose_editorial_inset(cv2, source, output_size),
            reference_weight=0.25,
        )
        reference_panel = cv2.resize(
            _extract_editorial_panel(source),
            panel_target,
            interpolation=cv2.INTER_LANCZOS4,
        )
        optimized = _compose_editorial_panel(
            cv2,
            _blend_realesrgan_reference(
                cv2,
                enhanced_panel,
                reference_panel,
                reference_weight=0.25,
            ),
            output_size,
        )

        np.testing.assert_array_equal(optimized, previous)

    def test_editorial_realesrgan_enhances_only_the_visible_panel(self):
        panel_input, panel_target = _realesrgan_working_geometry(
            (1920, 1080),
            (1080, 1920),
            2,
            editorial_panel_only=True,
        )
        full_input, full_target = _realesrgan_working_geometry(
            (1920, 1080),
            (1080, 1920),
            2,
        )

        self.assertEqual(panel_input, (507, 285))
        self.assertEqual(panel_target, (1014, 570))
        self.assertEqual(full_input, (540, 960))
        self.assertEqual(full_target, (1080, 1920))
        self.assertLess(
            panel_input[0] * panel_input[1],
            0.29 * full_input[0] * full_input[1],
        )

    def test_sufficient_source_panel_uses_one_direct_resample(self):
        output_size = (1080, 1920)
        with (
            patch(
                "shorts_generator.local.clipper.LOCAL_REAL_ESRGAN_BYPASS_HIGH_RES",
                True,
            ),
            patch(
                "shorts_generator.local.clipper.LOCAL_REAL_ESRGAN_MIN_PANEL_COVERAGE",
                0.90,
            ),
        ):
            self.assertGreater(
                _editorial_panel_source_coverage((1920, 1080), output_size),
                1.0,
            )
            self.assertTrue(
                _should_bypass_editorial_realesrgan((1920, 1080), output_size)
            )
            self.assertTrue(
                _should_bypass_editorial_realesrgan((960, 540), output_size)
            )
            self.assertFalse(
                _should_bypass_editorial_realesrgan((854, 480), output_size)
            )

            source = np.full((1080, 1920, 3), 128, dtype=np.uint8)
            with patch.object(cv2, "resize", wraps=cv2.resize) as resize:
                composed = _compose_editorial_inset(cv2, source, output_size)

        self.assertEqual(composed.shape, (1920, 1080, 3))
        resize.assert_called_once()
        self.assertEqual(resize.call_args.args[1], (1014, 570))

    def test_high_resolution_shared_prewarm_skips_gpu_runtime(self):
        highlights = [
            {
                "start_time": float(index),
                "end_time": float(index + 1),
                "render_profile": BF_EDITORIAL_INSET_RENDER_PROFILE,
            }
            for index in range(2)
        ]
        with (
            patch(
                "shorts_generator.local.clipper.LOCAL_REAL_ESRGAN",
                True,
            ),
            patch(
                "shorts_generator.local.clipper.REAL_ESRGAN_CACHE_ENABLED",
                True,
            ),
            patch(
                "shorts_generator.local.clipper.REAL_ESRGAN_SHARED_PREWARM_ENABLED",
                True,
            ),
            patch(
                "shorts_generator.local.clipper._probe_video_frame_size",
                return_value=(1920, 1080),
            ),
            patch(
                "shorts_generator.local.clipper._resolve_realesrgan_runtime",
            ) as runtime,
        ):
            summary = _prewarm_bf_editorial_realesrgan_cache(
                "/source.mp4",
                highlights,
                None,
                "9:16",
                BF_EDITORIAL_INSET_RENDER_PROFILE,
            )

        self.assertEqual(summary["bypassed_clips"], 2)
        self.assertEqual(summary["enhanced_frames"], 0)
        runtime.assert_not_called()

    def test_x4plus_always_uses_its_native_runtime_scale(self):
        self.assertEqual(_realesrgan_runtime_scale("realesrgan-x4plus", 2), 4)
        self.assertEqual(_realesrgan_runtime_scale("realesr-animevideov3", 2), 2)

        command = _realesrgan_command(
            ("/runtime/realesrgan-ncnn-vulkan", "/runtime/models"),
            "/input",
            "/output",
            2,
            model_name="realesrgan-x4plus",
        )

        self.assertEqual(command[command.index("-s") + 1], "4")

    def test_realesrgan_cache_roundtrip_is_pixel_exact(self):
        frame = np.arange(48 * 80 * 3, dtype=np.uint16)
        frame = (frame % 256).astype(np.uint8).reshape((48, 80, 3))
        cache_key = _realesrgan_cache_key(
            frame.tobytes(),
            (80, 48),
            (160, 96),
            "realesrgan-x4plus",
            2,
            4,
            "runtime-fingerprint",
        )

        with tempfile.TemporaryDirectory() as temporary_dir:
            cache_path = _realesrgan_cache_path(Path(temporary_dir), cache_key)
            _write_realesrgan_cache_frame(cv2, cache_path, frame)
            restored = _read_realesrgan_cache_frame(cv2, cache_path, (80, 48))

        self.assertIsNotNone(restored)
        self.assertTrue(np.array_equal(restored, frame))

    def test_realesrgan_cache_key_includes_quality_contract(self):
        frame_bytes = b"same-frame"
        base = _realesrgan_cache_key(
            frame_bytes,
            (507, 285),
            (1014, 570),
            "realesrgan-x4plus",
            2,
            4,
            "runtime-a",
        )
        changed_model = _realesrgan_cache_key(
            frame_bytes,
            (507, 285),
            (1014, 570),
            "realesr-animevideov3",
            2,
            2,
            "runtime-a",
        )
        changed_runtime = _realesrgan_cache_key(
            frame_bytes,
            (507, 285),
            (1014, 570),
            "realesrgan-x4plus",
            2,
            4,
            "runtime-b",
        )

        self.assertNotEqual(base, changed_model)
        self.assertNotEqual(base, changed_runtime)

    def test_visual_analysis_cache_roundtrip_preserves_exact_boxes(self):
        plan = [
            {
                "start": 0.0,
                "end": 4.25,
                "bbox": (120, 35, 280, 280),
            }
        ]
        with tempfile.TemporaryDirectory() as temporary_dir:
            with patch(
                "shorts_generator.local.clipper.VISUAL_ANALYSIS_CACHE_DIR",
                Path(temporary_dir),
            ):
                _write_visual_analysis_cache(
                    "analysis-key",
                    BF_EDITORIAL_INSET_LAYOUT,
                    (120, 35, 280, 280),
                    plan,
                )
                restored = _read_visual_analysis_cache("analysis-key")

        self.assertEqual(restored["layout"], BF_EDITORIAL_INSET_LAYOUT)
        self.assertEqual(restored["tracked_face"], (120, 35, 280, 280))
        self.assertEqual(restored["locked_speaker_plan"], plan)

    def test_visual_analysis_key_changes_with_source_interval(self):
        with tempfile.NamedTemporaryFile() as source:
            source.write(b"source")
            source.flush()
            base = _visual_analysis_cache_key(
                source.name,
                10.0,
                20.0,
                30.0,
                BF_EDITORIAL_INSET_LAYOUT,
                BF_EDITORIAL_INSET_RENDER_PROFILE,
                [4.0],
            )
            changed = _visual_analysis_cache_key(
                source.name,
                10.0,
                21.0,
                30.0,
                BF_EDITORIAL_INSET_LAYOUT,
                BF_EDITORIAL_INSET_RENDER_PROFILE,
                [4.0],
            )

        self.assertNotEqual(base, changed)

    def test_lossless_cut_cache_reuses_the_exact_ffv1_cut(self):
        with tempfile.TemporaryDirectory() as temporary_dir:
            source_path = Path(temporary_dir) / "source.mp4"
            source_path.write_bytes(b"source")
            cache_dir = Path(temporary_dir) / "cuts"

            def fake_cut(_source, _start, _end, out_path, fps):
                self.assertEqual(fps, 30.0)
                Path(out_path).write_bytes(b"lossless-cut")
                return out_path

            with (
                patch(
                    "shorts_generator.local.clipper.LOSSLESS_CUT_CACHE_DIR",
                    cache_dir,
                ),
                patch(
                    "shorts_generator.local.clipper.LOSSLESS_CUT_CACHE_ENABLED",
                    True,
                ),
                patch(
                    "shorts_generator.local.clipper._cut_subclip",
                    side_effect=fake_cut,
                ) as cut_mock,
            ):
                first_path, first_persistent = _get_or_create_lossless_cut(
                    str(source_path),
                    1.0,
                    3.0,
                    30.0,
                    str(Path(temporary_dir) / "fallback.mkv"),
                )
                second_path, second_persistent = _get_or_create_lossless_cut(
                    str(source_path),
                    1.0,
                    3.0,
                    30.0,
                    str(Path(temporary_dir) / "fallback.mkv"),
                )

            self.assertEqual(first_path, second_path)
            self.assertTrue(first_persistent)
            self.assertTrue(second_persistent)
            self.assertEqual(Path(first_path).read_bytes(), b"lossless-cut")
            self.assertEqual(cut_mock.call_count, 1)

    def test_lossless_cut_key_changes_with_boundaries(self):
        with tempfile.NamedTemporaryFile() as source:
            source.write(b"source")
            source.flush()
            first = _lossless_cut_cache_key(source.name, 1.0, 3.0, 30.0)
            changed = _lossless_cut_cache_key(source.name, 1.0, 4.0, 30.0)

        self.assertNotEqual(first, changed)

    def test_shared_prewarm_deduplicates_frames_across_clips(self):
        frame = np.full((90, 160, 3), 90, dtype=np.uint8)

        class FakeCapture:
            def __init__(self, _path):
                self.frames = [frame.copy(), frame.copy()]
                self.index = 0

            def isOpened(self):
                return True

            def read(self):
                if self.index >= len(self.frames):
                    return False, None
                value = self.frames[self.index]
                self.index += 1
                return True, value

            def release(self):
                return None

        def fake_realesrgan(command, **_kwargs):
            input_dir = Path(command[command.index("-i") + 1])
            output_dir = Path(command[command.index("-o") + 1])
            for input_path in sorted(input_dir.glob("frame_*.png")):
                source_frame = cv2.imread(str(input_path), cv2.IMREAD_COLOR)
                enhanced = cv2.resize(source_frame, (1014, 570))
                cv2.imwrite(str(output_dir / input_path.name), enhanced)
            return SimpleNamespace(returncode=0, stderr="", stdout="")

        highlights = [
            {
                "start_time": 0.0,
                "end_time": 1.0,
                "render_profile": BF_EDITORIAL_INSET_RENDER_PROFILE,
                "enhancement_model": "realesrgan-x4plus",
            },
            {
                "start_time": 0.0,
                "end_time": 1.0,
                "render_profile": BF_EDITORIAL_INSET_RENDER_PROFILE,
                "enhancement_model": "realesrgan-x4plus",
            },
        ]
        with tempfile.TemporaryDirectory() as temporary_dir:
            with (
                patch(
                    "shorts_generator.local.clipper.REAL_ESRGAN_CACHE_DIR",
                    Path(temporary_dir) / "esrgan",
                ),
                patch(
                    "shorts_generator.local.clipper.LOCAL_WORK_DIR",
                    str(Path(temporary_dir) / "work"),
                ),
                patch(
                    "shorts_generator.local.clipper.REAL_ESRGAN_SHARED_PREWARM_ENABLED",
                    True,
                ),
                patch(
                    "shorts_generator.local.clipper._resolve_realesrgan_runtime",
                    return_value=("/runtime/realesrgan", "/runtime/models"),
                ),
                patch(
                    "shorts_generator.local.clipper._realesrgan_runtime_fingerprint",
                    return_value="runtime",
                ),
                patch(
                    "shorts_generator.local.clipper._get_or_create_lossless_cut",
                    return_value=("/cache/cut.mkv", True),
                ),
                patch("cv2.VideoCapture", side_effect=FakeCapture),
                patch(
                    "shorts_generator.local.clipper.subprocess.run",
                    side_effect=fake_realesrgan,
                ) as run_mock,
            ):
                summary = _prewarm_bf_editorial_realesrgan_cache(
                    "/source.mp4",
                    highlights,
                    None,
                    "9:16",
                    BF_EDITORIAL_INSET_RENDER_PROFILE,
                )

        self.assertEqual(summary["eligible_clips"], 2)
        self.assertEqual(summary["unique_frames"], 1)
        self.assertEqual(summary["enhanced_frames"], 1)
        self.assertEqual(run_mock.call_count, 1)

    def test_shared_prewarm_is_opt_in_to_avoid_extra_cold_decodes(self):
        highlights = [
            {
                "start_time": 0.0,
                "end_time": 1.0,
                "render_profile": BF_EDITORIAL_INSET_RENDER_PROFILE,
            },
            {
                "start_time": 2.0,
                "end_time": 3.0,
                "render_profile": BF_EDITORIAL_INSET_RENDER_PROFILE,
            },
        ]
        with (
            patch(
                "shorts_generator.local.clipper.REAL_ESRGAN_SHARED_PREWARM_ENABLED",
                False,
            ),
            patch(
                "shorts_generator.local.clipper._resolve_realesrgan_runtime",
            ) as runtime_mock,
        ):
            summary = _prewarm_bf_editorial_realesrgan_cache(
                "/source.mp4",
                highlights,
                None,
                "9:16",
                BF_EDITORIAL_INSET_RENDER_PROFILE,
            )

        self.assertEqual(summary["eligible_clips"], 0)
        runtime_mock.assert_not_called()

    def test_realesrgan_reuses_only_byte_identical_frames(self):
        unique_frame_bytes = []
        digest_buckets = {}
        frame = np.full((12, 20, 3), 90, dtype=np.uint8)

        first_index, first_is_unique = _realesrgan_unique_frame_index(
            frame,
            unique_frame_bytes,
            digest_buckets,
        )
        repeated_index, repeated_is_unique = _realesrgan_unique_frame_index(
            frame.copy(),
            unique_frame_bytes,
            digest_buckets,
        )
        changed = frame.copy()
        changed[0, 0, 0] = 91
        changed_index, changed_is_unique = _realesrgan_unique_frame_index(
            changed,
            unique_frame_bytes,
            digest_buckets,
        )

        self.assertEqual((first_index, first_is_unique), (0, True))
        self.assertEqual((repeated_index, repeated_is_unique), (0, False))
        self.assertEqual((changed_index, changed_is_unique), (1, True))

    def test_grade_is_high_contrast_monochrome_and_preserves_black(self):
        frame = np.zeros((32, 48, 3), dtype=np.uint8)
        frame[8:24, 12:36] = (30, 120, 230)

        graded = _apply_bf_editorial_grade(cv2, frame)

        self.assertTrue(np.array_equal(graded[:, :, 0], graded[:, :, 1]))
        self.assertTrue(np.array_equal(graded[:, :, 1], graded[:, :, 2]))
        self.assertEqual(int(graded[0, 0].max()), 0)
        self.assertGreater(int(graded[16, 24].mean()), 0)

    def test_micro_phrases_have_one_dominant_word_and_reaction_ceiling(self):
        spoken = "Nice people avoid conflict. Good people tell the truth. Wow!"
        words = spoken.split()
        transcript = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 3.0,
                    "text": spoken,
                    "words": [
                        {
                            "word": word,
                            "start": index * 0.25,
                            "end": index * 0.25 + 0.20,
                        }
                        for index, word in enumerate(words)
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            0.0,
            3.0,
            caption_style=BF_EDITORIAL_INSET_RENDER_PROFILE,
            render_profile=BF_EDITORIAL_INSET_RENDER_PROFILE,
            caption_context={"hook_sentence": "Nice people avoid conflict"},
        )
        phrases = {
            cue["phrase_id"]: cue
            for cue in cues
            if cue["visible_word_count"] == len(cue["words"])
        }

        self.assertTrue(phrases)
        self.assertTrue(all(1 <= len(cue["words"]) <= 4 for cue in phrases.values()))
        self.assertTrue(
            all(cue["typography_anchor_scale"] >= 1.8 for cue in phrases.values())
        )
        reaction = next(cue for cue in phrases.values() if cue["words"] == ["Wow!"])
        self.assertEqual(reaction["typography_role"], "reaction")
        self.assertEqual(reaction["typography_anchor_scale"], 4.0)

    def test_legacy_caption_profile_keeps_legacy_typography_budget(self):
        spoken = "Discipline creates real freedom every single day."
        transcript = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 2.4,
                    "words": [
                        {
                            "word": word,
                            "start": index * 0.28,
                            "end": index * 0.28 + 0.22,
                        }
                        for index, word in enumerate(spoken.split())
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            0.0,
            2.4,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )

        self.assertTrue(cues)
        self.assertTrue(all(len(cue["words"]) <= 6 for cue in cues))
        self.assertTrue(
            all(cue["typography_role"] not in {"hero", "reaction"} for cue in cues)
        )

    def test_kinetic_state_is_restrained_and_reaches_rest(self):
        cue = {"start": 1.0, "phrase_start": 1.0, "end": 2.0}

        opening = _editorial_kinetic_state(cue, 1.0)
        settled = _editorial_kinetic_state(cue, 1.18)

        self.assertAlmostEqual(opening["opacity"], 0.35)
        self.assertAlmostEqual(opening["scale"], 0.98)
        self.assertAlmostEqual(opening["mask_reveal"], 1.0)
        self.assertAlmostEqual(settled["opacity"], 1.0)
        self.assertAlmostEqual(settled["scale"], 1.0)
        self.assertAlmostEqual(settled["mask_reveal"], 1.0)

    def test_completed_phrase_fades_only_at_the_end_of_its_hold(self):
        cue = {
            "start": 1.0,
            "phrase_start": 1.0,
            "end": 2.0,
            "words": ["TRUTH"],
            "visible_word_count": 1,
        }

        held = _editorial_kinetic_state(cue, 1.80)
        exiting = _editorial_kinetic_state(cue, 1.94)

        self.assertAlmostEqual(held["opacity"], 1.0)
        self.assertGreater(exiting["opacity"], 0.0)
        self.assertLess(exiting["opacity"], held["opacity"])

    def test_caption_box_remains_inside_the_inset_coordinate_space(self):
        frame = np.zeros((1280, 720, 3), dtype=np.uint8)
        inset = _editorial_inset_box((1920, 1080), (720, 1280))
        renderer = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BF_EDITORIAL_INSET_RENDER_PROFILE,
            render_profile=BF_EDITORIAL_INSET_RENDER_PROFILE,
        )
        renderer.draw(
            frame,
            {
                "words": ["GOOD", "MAN"],
                "visible_word_count": 2,
                "emphasis_index": 1,
                "phrase_id": 1,
                "sentence_id": 1,
                "sentence_phrase_index": 0,
                "sentence_phrase_count": 1,
                "caption_track_progress": 0.5,
                "typography_variant": "hero",
                "typography_base_scale": 0.8,
                "typography_anchor_scale": 2.25,
                "typography_accent_style": "base",
                "typography_body_style": "support",
                "phrase_start": 0.0,
                "_render_elapsed": 0.18,
            },
            safe_box=inset,
        )

        self.assertIsNotNone(renderer.last_drawn_box)
        x, y, width, height = renderer.last_drawn_box
        inset_x, inset_y, inset_width, inset_height = inset
        self.assertGreaterEqual(x, inset_x)
        self.assertGreaterEqual(y, inset_y)
        self.assertLessEqual(x + width, inset_x + inset_width)
        self.assertLessEqual(y + height, inset_y + inset_height)

    def test_brand_tail_is_original_mark_on_black(self):
        tail = _draw_bf_brand_tail(cv2, (720, 1280), progress=1.0)

        self.assertEqual(tail.shape, (1280, 720, 3))
        self.assertGreater(int(tail.max()), 200)
        self.assertEqual(int(tail[40, 40].max()), 0)
        self.assertAlmostEqual(
            _resolve_bf_brand_tail_seconds(BF_EDITORIAL_INSET_RENDER_PROFILE),
            1.25,
        )
        self.assertEqual(
            _resolve_bf_brand_tail_seconds(BUDGET_FRIENDLY_CAPTION_STYLE),
            0.0,
        )

    def test_brand_tail_crossfades_audio_and_does_not_apply_ffmpeg_video_fade(self):
        command = _raw_video_command(
            "cut.mkv",
            "short.mp4",
            (1080, 1920),
            30.0,
            duration=10.75,
            brand_tail_start_seconds=10.45,
        )
        joined = " ".join(command)

        self.assertIn("afade=t=out:st=10.150:d=0.300", joined)
        self.assertIn("if(gte(t,10.450),0,1)", joined)
        self.assertNotIn("-vf", command)

        music_filter = _motivational_audio_filter(
            10.75,
            brand_tail_start_seconds=10.45,
        )
        self.assertIn("alimiter=limit=0.75", music_filter)
        self.assertIn("afade=t=out:st=10.150:d=0.300", music_filter)
        self.assertIn("if(gte(t,10.450),0,1)", music_filter)

        natural_pause_filter = _motivational_audio_filter(
            10.8,
            brand_tail_start_seconds=10.5,
            speech_end_seconds=10.0,
        )
        self.assertIn("atrim=end=10.000", natural_pause_filter)
        self.assertIn("afade=t=out:st=9.988:d=0.012", natural_pause_filter)
        self.assertNotIn("afade=t=out:st=9.920:d=0.080", natural_pause_filter)
        self.assertIn("afade=t=out:st=10.200:d=0.300", natural_pause_filter)

        dynamic_plan = build_dynamic_music_plan(
            {
                "hook_sentence_end_seconds": 1.5,
                "payoff_start_seconds": 6.0,
                "payoff_end_seconds": 7.0,
                "music_profile": "driving",
            },
            [],
            duration=10.8,
            speech_end_seconds=10.0,
            natural_tail_end_seconds=10.5,
        )
        dynamic_filter = _motivational_audio_filter(
            10.8,
            music_profile="driving",
            brand_tail_start_seconds=10.5,
            speech_end_seconds=10.0,
            brand_tail_music_release_seconds=0.18,
            dynamic_music_plan=dynamic_plan,
        )
        self.assertIn("volume='if(lt(t,", dynamic_filter)
        self.assertIn("sidechaincompress", dynamic_filter)
        self.assertIn("loudnorm=I=", dynamic_filter)
        self.assertIn("atrim=end=10.000", dynamic_filter)
        self.assertIn("afade=t=out:st=10.500:d=0.180", dynamic_filter)

        with self.assertRaisesRegex(RuntimeError, "requires an enabled"):
            _raw_video_command(
                "cut.mkv",
                "short.mp4",
                (1080, 1920),
                30.0,
                duration=10.8,
                dynamic_music_plan=dynamic_plan,
            )
        dynamic_command = _raw_video_command(
            "cut.mkv",
            "short.mp4",
            (1080, 1920),
            30.0,
            duration=10.8,
            music_path="licensed.mp3",
            dynamic_music_plan=dynamic_plan,
        )
        self.assertIn("[aout]", dynamic_command)
        self.assertIn("licensed.mp3", dynamic_command)

        zero_transition = _raw_video_command(
            "cut.mkv",
            "short.mp4",
            (1080, 1920),
            30.0,
            duration=10.75,
            brand_tail_start_seconds=10.45,
            brand_tail_transition_seconds=0.0,
        )
        zero_joined = " ".join(zero_transition)
        self.assertNotIn("afade=t=out:st=10.150:d=0.300", zero_joined)
        self.assertIn("if(gte(t,10.450),0,1)", zero_joined)
        self.assertIsNone(_bf_brand_transition_progress(10.44, 10.45, 0.0))
        self.assertEqual(
            _bf_brand_transition_progress(10.45, 10.45, 0.0),
            1.0,
        )

    def test_new_layout_hint_routes_to_inset_without_affecting_legacy_hint(self):
        class FakeCap:
            def __init__(self):
                self.frames = [np.zeros((180, 320, 3), dtype=np.uint8) for _ in range(8)]
                self.position = 0

            def get(self, prop):
                return len(self.frames) if prop == cv2.CAP_PROP_FRAME_COUNT else 0

            def set(self, prop, value):
                if prop == cv2.CAP_PROP_POS_FRAMES:
                    self.position = int(value)

            def read(self):
                frame = self.frames[min(self.position, len(self.frames) - 1)]
                self.position += 1
                return True, frame.copy()

        class SpeakerCascade:
            def detectMultiScale(self, *args, **kwargs):
                return np.array([[110, 30, 80, 80]], dtype=np.int32)

        inset_layout, _ = _detect_clip_layout(
            cv2,
            FakeCap(),
            SpeakerCascade(),
            (320, 180),
            layout_hint=BF_EDITORIAL_INSET_LAYOUT,
        )
        legacy_layout, _ = _detect_clip_layout(
            cv2,
            FakeCap(),
            SpeakerCascade(),
            (320, 180),
            layout_hint="motivational_editorial",
        )

        self.assertEqual(inset_layout, BF_EDITORIAL_INSET_LAYOUT)
        self.assertEqual(legacy_layout, "editorial_speaker")

    def test_profile_trim_places_first_caption_inside_hook_gate(self):
        transcript = {
            "segments": [
                {
                    "start": 1.0,
                    "end": 1.5,
                    "words": [{"word": "Listen.", "start": 1.0, "end": 1.3}],
                }
            ]
        }
        render_start = _trim_opening_dead_air(
            transcript,
            0.0,
            2.0,
            max_dead_air_seconds=0.25,
            speech_lead_seconds=0.08,
        )

        self.assertAlmostEqual(render_start, 0.92)
        cues = _build_word_cues(
            transcript,
            render_start,
            2.0,
            caption_style=BF_EDITORIAL_INSET_RENDER_PROFILE,
            render_profile=BF_EDITORIAL_INSET_RENDER_PROFILE,
        )
        self.assertLessEqual(cues[0]["start"], 0.25)

    @patch("shorts_generator.local.clipper.crop_clip_local")
    def test_render_result_declares_brand_tail_event_for_cut_qa(self, crop_clip):
        crop_clip.return_value = "/tmp/ignored.mp4"
        transcript = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 10.75,
                    "words": [
                        {"word": "Truth.", "start": 0.0, "end": 0.3},
                    ],
                }
            ]
        }
        highlights = [
            {
                "title": "Nice versus good",
                "start_time": 0.0,
                "end_time": 10.75,
                "speech_end_time": 0.3,
                "render_profile": BF_EDITORIAL_INSET_RENDER_PROFILE,
                "layout_hint": BF_EDITORIAL_INSET_LAYOUT,
            }
        ]

        [result] = crop_highlights_local(
            "source.mp4",
            highlights,
            out_dir="/tmp/bf-editorial-test-output",
            transcript=transcript,
            render_profile=BF_EDITORIAL_INSET_RENDER_PROFILE,
        )

        self.assertEqual(result["artificial_cut_limit"], 0)
        self.assertAlmostEqual(result["brand_tail_seconds"], 1.25)
        self.assertAlmostEqual(result["brand_tail_start_seconds"], 1.35)
        self.assertAlmostEqual(result["post_point_hold_seconds"], 0.75)
        self.assertAlmostEqual(result["natural_tail_seconds"], 0.75)
        self.assertAlmostEqual(result["speech_audio_tail_seconds"], 0.75)
        self.assertAlmostEqual(result["freeze_hold_seconds"], 0.0)
        self.assertAlmostEqual(result["transition_tail_seconds"], 0.3)
        self.assertGreaterEqual(result["brand_tail_clearance_seconds"], 1.0)
        self.assertTrue(result["source_speech_leak_guard_passed"])
        self.assertLessEqual(
            result["semantic_end_seconds"],
            result["brand_tail_start_seconds"],
        )
        self.assertEqual(result["declared_render_events"][0]["type"], "brand_tail")
        self.assertGreater(result["first_visible_text_seconds"], 0.0)
        self.assertLessEqual(result["first_visible_text_seconds"], 0.25)
        self.assertGreaterEqual(result["max_hero_scale"], 1.8)
        self.assertEqual(result["type_plan_summary"]["phrase_count"], 1)
        self.assertEqual(result["render_timeline_events"][0]["type"], "phrase_reveal")
        self.assertEqual(result["render_timeline_events"][-1]["type"], "brand_tail")
        self.assertAlmostEqual(crop_clip.call_args.args[2], 2.6)
        self.assertAlmostEqual(
            crop_clip.call_args.kwargs["speech_audio_end_time"],
            1.05,
        )

    @patch("shorts_generator.local.clipper.crop_clip_local")
    def test_short_source_tail_crossfades_instead_of_freezing_or_rejecting(self, crop_clip):
        transcript = {
            "duration": 10.7,
            "segments": [
                {
                    "start": 0.0,
                    "end": 10.7,
                    "words": [
                        {"word": "Ending.", "start": 10.45, "end": 10.68},
                    ],
                }
            ]
        }
        [result] = crop_highlights_local(
            "source.mp4",
            [
                {
                    "title": "No tail clearance",
                    "start_time": 0.0,
                    "end_time": 10.75,
                    "speech_end_time": 10.68,
                    "render_profile": BF_EDITORIAL_INSET_RENDER_PROFILE,
                    "layout_hint": BF_EDITORIAL_INSET_LAYOUT,
                }
            ],
            out_dir="/tmp/bf-editorial-tail-clearance-test",
            transcript=transcript,
            render_profile=BF_EDITORIAL_INSET_RENDER_PROFILE,
        )

        self.assertIsNotNone(result["clip_url"])
        self.assertAlmostEqual(result["post_point_hold_seconds"], 0.0)
        self.assertAlmostEqual(result["freeze_hold_seconds"], 0.0)
        self.assertAlmostEqual(result["transition_tail_seconds"], 0.02)
        self.assertTrue(result["source_speech_leak_guard_passed"])
        crop_clip.assert_called_once()

    def test_tail_plan_crossfades_before_immediate_next_sentence(self):
        transcript = {
            "duration": 20.0,
            "segments": [
                {
                    "start": 10.0,
                    "end": 11.0,
                    "words": [
                        {"word": "Done.", "start": 10.0, "end": 10.5},
                        {"word": "Next", "start": 10.5, "end": 10.8},
                    ],
                }
            ],
        }

        plan = _bf_editorial_tail_plan(transcript, 10.5, 1.25)

        self.assertAlmostEqual(plan["output_end_time"], 11.75)
        self.assertAlmostEqual(plan["natural_tail_seconds"], 0.0)
        self.assertAlmostEqual(plan["speech_audio_tail_seconds"], 0.0)
        self.assertAlmostEqual(plan["speech_audio_end_time"], 10.5)
        self.assertAlmostEqual(plan["freeze_hold_seconds"], 0.0)
        self.assertAlmostEqual(plan["transition_tail_seconds"], 0.0)
        self.assertAlmostEqual(plan["source_content_end_time"], 10.5)
        self.assertAlmostEqual(plan["next_spoken_word_start"], 10.5)
        self.assertTrue(plan["source_speech_leak_guard_passed"])

    def test_tail_plan_preserves_authentic_pause_audio_after_last_word(self):
        transcript = {
            "duration": 20.0,
            "segments": [
                {
                    "start": 10.0,
                    "end": 11.5,
                    "words": [
                        {"word": "Done.", "start": 10.0, "end": 10.5},
                        {"word": "Next", "start": 11.0, "end": 11.3},
                    ],
                }
            ],
        }

        plan = _bf_editorial_tail_plan(transcript, 10.5, 1.25)

        self.assertAlmostEqual(plan["natural_tail_seconds"], 0.16)
        self.assertAlmostEqual(plan["speech_audio_tail_seconds"], 0.16)
        self.assertAlmostEqual(plan["speech_audio_end_time"], 10.66)
        self.assertAlmostEqual(plan["transition_tail_seconds"], 0.3)
        self.assertAlmostEqual(plan["source_content_end_time"], 10.96)
        self.assertTrue(plan["source_speech_leak_guard_passed"])

    def test_verified_acoustic_boundary_recovers_real_margin_from_coarse_captions(self):
        transcript = {
            "duration": 30.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 0.3,
                    "words": [
                        {"word": "Know", "start": 0.0, "end": 0.3},
                    ],
                },
                {
                    "start": 20.4,
                    "end": 21.2,
                    "words": [
                        {"word": "you.", "start": 20.4, "end": 20.8},
                        # The caption track reports zero gap even though the
                        # reviewed waveform places the next onset at 20.860.
                        {"word": "The", "start": 20.8, "end": 21.0},
                    ],
                }
            ],
        }

        plan = _bf_editorial_tail_plan(
            transcript,
            speech_end_time=20.8,
            brand_tail_seconds=1.25,
            verified_acoustic_speech_end_time=20.74,
            verified_next_spoken_word_start=20.86,
            verified_next_speech_safety_seconds=0.01,
            verified_acoustic_boundary_evidence="waveform review",
        )

        self.assertAlmostEqual(plan["speech_end_time"], 20.8)
        self.assertAlmostEqual(plan["acoustic_speech_end_time"], 20.74)
        self.assertAlmostEqual(plan["transcript_next_spoken_word_start"], 20.8)
        self.assertAlmostEqual(plan["next_spoken_word_start"], 20.86)
        self.assertAlmostEqual(plan["next_speech_safety_seconds"], 0.01)
        self.assertAlmostEqual(plan["transition_tail_seconds"], 0.11)
        self.assertAlmostEqual(plan["source_content_end_time"], 20.85)
        self.assertAlmostEqual(plan["source_content_end_time"] - 20.8, 0.05)
        self.assertAlmostEqual(plan["output_end_time"], 22.1)
        self.assertEqual(
            plan["acoustic_boundary_source"],
            "candidate_verified_acoustic",
        )
        self.assertEqual(
            plan["verified_acoustic_boundary_evidence"],
            "waveform review",
        )
        self.assertAlmostEqual(plan["freeze_hold_seconds"], 0.0)
        self.assertTrue(plan["source_speech_leak_guard_passed"])

    def test_smooth_tail_separates_picture_voice_and_music_landings(self):
        transcript = {
            "duration": 30.0,
            "segments": [
                {
                    "start": 20.2,
                    "end": 21.0,
                    "words": [
                        {"word": "you.", "start": 20.2, "end": 20.8},
                        {"word": "The", "start": 20.8, "end": 21.0},
                    ],
                }
            ],
        }

        plan = _bf_editorial_tail_plan(
            transcript,
            speech_end_time=20.8,
            brand_tail_seconds=0.85,
            tail_profile=BF_SMOOTH_TAIL_V4,
            verified_acoustic_speech_end_time=20.74,
            verified_next_spoken_word_start=20.86,
            verified_next_speech_safety_seconds=0.01,
            verified_acoustic_boundary_evidence="waveform review",
        )

        self.assertAlmostEqual(plan["source_content_end_time"], 20.85)
        self.assertAlmostEqual(plan["speech_audio_end_time"], 20.85)
        self.assertAlmostEqual(plan["speech_audio_tail_seconds"], 0.11)
        self.assertAlmostEqual(plan["semantic_source_margin_seconds"], 0.05)
        self.assertAlmostEqual(plan["transition_tail_seconds"], 0.13)
        self.assertAlmostEqual(plan["visual_transition_start_time"], 20.72)
        self.assertAlmostEqual(plan["audio_transition_tail_seconds"], 0.04)
        self.assertAlmostEqual(plan["audio_transition_start_time"], 20.81)
        self.assertAlmostEqual(plan["music_release_tail_seconds"], 0.18)
        self.assertAlmostEqual(plan["output_end_time"], 21.70)
        self.assertTrue(plan["source_speech_leak_guard_passed"])

        self.assertAlmostEqual(
            _bf_brand_transition_progress(
                20.755,
                20.85,
                0.13,
                smooth=True,
            ),
            0.17842512517065628,
        )

    def test_v4_visual_safe_end_caps_picture_without_relabeling_next_speech(self):
        transcript = {
            "duration": 1300.0,
            "segments": [
                {
                    "start": 1213.0,
                    "end": 1214.2,
                    "words": [
                        {"word": "point.", "start": 1213.0, "end": 1213.5},
                        {"word": "Next", "start": 1213.98, "end": 1214.2},
                    ],
                }
            ],
        }

        plan = _bf_editorial_tail_plan(
            transcript,
            speech_end_time=1213.5,
            brand_tail_seconds=0.85,
            tail_profile=BF_SMOOTH_TAIL_V4,
            verified_acoustic_speech_end_time=1213.5,
            verified_next_spoken_word_start=1213.98,
            verified_next_speech_safety_seconds=0.01,
            verified_acoustic_boundary_evidence="waveform review",
            verified_visual_safe_end_time=1213.827625,
            verified_visual_boundary_evidence=(
                "scene cut PTS 1213.837625 minus 10ms visual safety"
            ),
        )

        self.assertAlmostEqual(plan["acoustic_safe_source_end_time"], 1213.97)
        self.assertAlmostEqual(plan["verified_visual_safe_end_time"], 1213.827625)
        self.assertAlmostEqual(plan["source_content_end_time"], 1213.827625)
        self.assertAlmostEqual(plan["speech_audio_end_time"], 1213.827625)
        self.assertAlmostEqual(plan["next_spoken_word_start"], 1213.98)
        self.assertAlmostEqual(plan["visual_transition_start_time"], 1213.697625)
        self.assertAlmostEqual(plan["transition_tail_seconds"], 0.13)
        self.assertAlmostEqual(plan["output_end_time"], 1214.677625)
        self.assertTrue(plan["visual_safe_end_guard_passed"])
        self.assertTrue(plan["source_speech_leak_guard_passed"])

    def test_verified_visual_safe_end_is_v4_only(self):
        with self.assertRaisesRegex(ValueError, "only by bf_smooth_tail_v4"):
            _bf_editorial_tail_plan(
                {"duration": 30.0, "segments": []},
                speech_end_time=20.8,
                brand_tail_seconds=0.85,
                tail_profile=BF_SMOOTH_TAIL_V3,
                verified_visual_safe_end_time=21.0,
            )

    def test_v3_tail_keeps_its_legacy_200ms_visual_fade(self):
        plan = _bf_editorial_tail_plan(
            {"duration": 30.0, "segments": []},
            speech_end_time=20.8,
            brand_tail_seconds=0.85,
            tail_profile=BF_SMOOTH_TAIL_V3,
            verified_acoustic_speech_end_time=20.74,
            verified_next_spoken_word_start=20.86,
            verified_next_speech_safety_seconds=0.01,
            verified_acoustic_boundary_evidence="waveform review",
        )

        self.assertAlmostEqual(plan["source_content_end_time"], 20.85)
        self.assertAlmostEqual(plan["transition_tail_seconds"], 0.20)
        self.assertAlmostEqual(plan["visual_transition_start_time"], 20.65)

    def test_smooth_tail_audio_keeps_voice_to_guard_then_releases_music(self):
        audio_filter = _motivational_audio_filter(
            21.70,
            brand_tail_start_seconds=20.85,
            speech_end_seconds=20.85,
            brand_tail_transition_seconds=0.13,
            brand_tail_audio_transition_seconds=0.04,
            brand_tail_music_release_seconds=0.18,
        )

        self.assertIn("atrim=end=20.850", audio_filter)
        self.assertIn("afade=t=out:st=20.810:d=0.040", audio_filter)
        self.assertIn("afade=t=out:st=20.850:d=0.180", audio_filter)
        self.assertIn("if(gte(t,21.030),0,1)", audio_filter)
        self.assertNotIn("if(gte(t,20.850),0,1)", audio_filter)

    @patch("shorts_generator.local.clipper.crop_clip_local")
    def test_verified_tail_keeps_captions_semantic_and_brand_after_margin(
        self,
        crop_clip,
    ):
        crop_clip.return_value = "/tmp/ignored.mp4"
        transcript = {
            "duration": 30.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 0.3,
                    "words": [
                        {"word": "Know", "start": 0.0, "end": 0.3},
                    ],
                },
                {
                    "start": 19.8,
                    "end": 21.2,
                    "words": [
                        {"word": "break", "start": 19.8, "end": 20.2},
                        {"word": "you.", "start": 20.2, "end": 20.74},
                        {"word": "The", "start": 20.8, "end": 21.0},
                    ],
                }
            ],
        }

        [result] = crop_highlights_local(
            "source.mp4",
            [
                {
                    "title": "Complete phrase with reviewed landing",
                    "start_time": 0.0,
                    "end_time": 20.8,
                    "speech_end_time": 20.8,
                    "verified_acoustic_speech_end_time": 20.74,
                    "verified_next_spoken_word_start": 20.86,
                    "verified_next_speech_safety_seconds": 0.01,
                    "verified_acoustic_boundary_evidence": "waveform review",
                    "render_profile": BF_EDITORIAL_INSET_RENDER_PROFILE,
                    "layout_hint": BF_EDITORIAL_INSET_LAYOUT,
                }
            ],
            out_dir="/tmp/bf-editorial-verified-tail-test",
            transcript=transcript,
            render_profile=BF_EDITORIAL_INSET_RENDER_PROFILE,
        )

        self.assertAlmostEqual(result["captions_clear_at_seconds"], 20.8)
        self.assertAlmostEqual(result["acoustic_speech_end_time"], 20.74)
        self.assertAlmostEqual(result["source_content_end_time"], 20.85)
        self.assertAlmostEqual(result["brand_tail_start_seconds"], 20.85)
        self.assertAlmostEqual(result["brand_tail_clearance_seconds"], 0.05)
        self.assertGreaterEqual(
            result["brand_tail_start_seconds"],
            result["semantic_end_seconds"],
        )
        self.assertAlmostEqual(result["next_spoken_word_start"], 20.86)
        self.assertAlmostEqual(result["next_speech_safety_seconds"], 0.01)
        self.assertEqual(
            result["acoustic_boundary_source"],
            "candidate_verified_acoustic",
        )
        self.assertEqual(
            result["verified_acoustic_boundary_evidence"],
            "waveform review",
        )
        self.assertAlmostEqual(result["freeze_hold_seconds"], 0.0)
        self.assertTrue(result["source_speech_leak_guard_passed"])
        self.assertAlmostEqual(crop_clip.call_args.args[2], 22.1)
        self.assertAlmostEqual(
            crop_clip.call_args.kwargs["source_content_end_time"],
            20.85,
        )

    @patch("shorts_generator.local.clipper.crop_clip_local")
    def test_v4_visual_safe_end_threads_into_crop_metadata(self, crop_clip):
        crop_clip.return_value = "/tmp/ignored.mp4"
        transcript = {
            "duration": 30.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 14.2,
                    "words": [
                        {"word": "Start", "start": 0.0, "end": 0.2},
                        {"word": "point.", "start": 13.0, "end": 13.5},
                        {"word": "Next", "start": 13.98, "end": 14.2},
                    ],
                }
            ],
        }

        [result] = crop_highlights_local(
            "source.mp4",
            [
                {
                    "title": "Visual-safe landing",
                    "start_time": 0.0,
                    "end_time": 13.5,
                    "speech_end_time": 13.5,
                    "brand_tail_profile": BF_SMOOTH_TAIL_V4,
                    "verified_acoustic_speech_end_time": 13.5,
                    "verified_next_spoken_word_start": 13.98,
                    "verified_next_speech_safety_seconds": 0.01,
                    "verified_acoustic_boundary_evidence": "waveform review",
                    "verified_visual_safe_end_time": 13.827625,
                    "verified_visual_boundary_evidence": "scene-cut review",
                    "render_profile": BF_EDITORIAL_INSET_RENDER_PROFILE,
                    "layout_hint": BF_EDITORIAL_INSET_LAYOUT,
                }
            ],
            out_dir="/tmp/bf-editorial-visual-safe-tail-test",
            transcript=transcript,
            render_profile=BF_EDITORIAL_INSET_RENDER_PROFILE,
        )

        self.assertAlmostEqual(result["source_content_end_time"], 13.828)
        self.assertAlmostEqual(result["visual_transition_start_time"], 13.698)
        self.assertAlmostEqual(result["verified_visual_safe_end_time"], 13.828)
        self.assertAlmostEqual(result["next_spoken_word_start"], 13.98)
        self.assertEqual(
            result["verified_visual_boundary_evidence"],
            "scene-cut review",
        )
        self.assertTrue(result["visual_safe_end_guard_passed"])
        self.assertAlmostEqual(
            crop_clip.call_args.kwargs["source_content_end_time"],
            13.827625,
        )

    def test_tail_plan_matches_measured_reference_landing_without_freeze(self):
        plan = _bf_editorial_tail_plan(
            {"duration": 10.75225, "segments": []},
            speech_end_time=8.34,
            brand_tail_seconds=1.25,
        )

        self.assertAlmostEqual(plan["natural_tail_seconds"], 0.75)
        self.assertAlmostEqual(plan["transition_tail_seconds"], 0.30)
        self.assertAlmostEqual(plan["source_content_end_time"], 9.39)
        self.assertAlmostEqual(plan["output_end_time"], 10.64)
        self.assertAlmostEqual(plan["freeze_hold_seconds"], 0.0)
        self.assertTrue(plan["source_speech_leak_guard_passed"])

    def test_caption_builder_excludes_a_partially_cut_next_word(self):
        transcript = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 1.2,
                    "words": [
                        {"word": "Done.", "start": 0.0, "end": 0.5},
                        {"word": "Next", "start": 0.5, "end": 0.9},
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            0.0,
            0.6,
            caption_style=BF_EDITORIAL_INSET_RENDER_PROFILE,
            render_profile=BF_EDITORIAL_INSET_RENDER_PROFILE,
            display_end=0.6,
        )
        words = [word for cue in cues for word in cue.get("words", [])]

        self.assertIn("Done.", words)
        self.assertNotIn("Next", words)


if __name__ == "__main__":
    unittest.main()
