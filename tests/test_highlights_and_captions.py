import re
import unittest

import cv2
import numpy as np

from shorts_generator.highlights import (
    HIGHLIGHT_PADDING_SECONDS,
    _sanitize_highlights,
    _snap_highlights_to_transcript,
    build_transcript_text,
    call_highlight_api,
)
from shorts_generator.local.clipper import (
    CAPTION_FORBIDDEN_ENDINGS,
    CAPTION_MAX_PHRASE_WORDS,
    CAPTION_SPLIT_VERTICAL_POSITION_RATIO,
    CAPTION_VISUAL_LEAD_SECONDS,
    _build_word_cues,
    _blend_realesrgan_reference,
    _caption_group_metrics,
    _CaptionRenderer,
    _classify_facecam_candidates,
    _compose_presentation,
    _compose_split_screen,
    _crop_safe_center,
    _cut_subclip_command,
    _draw_context_overlay,
    _detect_clip_layout,
    _group_caption_words,
    _mask_bbox,
    _motivational_music_volume_filter,
    _motivational_payoff_start,
    _mux_audio_command,
    _MotionTracker,
    _output_dimensions,
    _presentation_subject,
    _raw_video_command,
    _realesrgan_command,
    _realesrgan_scale,
    _trim_opening_dead_air,
)
from shorts_generator.local.visual_features import visual_metrics_from_frames


class HighlightPaddingTests(unittest.TestCase):
    def test_long_video_chunk_prompt_uses_relative_timestamps(self):
        text = build_transcript_text(
            {
                "_offset": 1140.0,
                "segments": [
                    {"start": 1140.0, "end": 1142.0, "text": "Chunk begins."},
                    {"start": 1205.5, "end": 1208.0, "text": "Action payoff."},
                ],
            }
        )

        self.assertIn("[0.0s] Chunk begins.", text)
        self.assertIn("[65.5s] Action payoff.", text)
        self.assertNotIn("[1205.5s]", text)

    def test_gaming_prompt_requires_action_cause_and_outcome(self):
        prompts = []

        def fake_llm(prompt):
            prompts.append(prompt)
            return (
                '{"highlights":[{"title":"Escape","start_time":10,"end_time":45,'
                '"speech_start_time":10,"speech_end_time":45,"score":90}]}'
            )

        call_highlight_api(
            "[10.0s] The police found us and we escaped across the bridge.",
            {"content_type": "gaming", "density": "medium"},
            duration=60.0,
            num_clips=1,
            llm_fn=fake_llm,
        )

        self.assertIn("complete micro-story", prompts[0])
        self.assertIn("never exceed 75 seconds", prompts[0])
        self.assertIn("visible cause", prompts[0])
        self.assertIn("what mode/activity is being played", prompts[0])
        self.assertIn("is not sufficient by itself", prompts[0])
        self.assertIn("challenge -> escalation -> result", prompts[0])

    def test_sanitizer_preserves_semantic_speech_boundaries(self):
        highlights = _sanitize_highlights(
            [
                {
                    "title": "Complete thought",
                    "speech_start_time": 1.0,
                    "speech_end_time": 19.0,
                    "start_time": 1.0,
                    "end_time": 19.0,
                    "score": 91,
                }
            ],
            duration=20.0,
        )

        self.assertEqual(len(highlights), 1)
        self.assertEqual(highlights[0]["start_time"], 1.0)
        self.assertEqual(highlights[0]["end_time"], 19.0)

    def test_legacy_response_preserves_model_boundaries_before_alignment(self):
        highlights = _sanitize_highlights(
            [{"start_time": 10.0, "end_time": 20.0, "score": 80}],
            duration=30.0,
        )

        self.assertEqual(highlights[0]["start_time"], 10.0)
        self.assertEqual(highlights[0]["end_time"], 20.0)

    def test_padding_uses_only_available_silence_between_sentences(self):
        highlights = _snap_highlights_to_transcript(
            [
                {
                    "start_time": 14.0,
                    "end_time": 18.0,
                    "speech_start_time": 14.0,
                    "speech_end_time": 18.0,
                }
            ],
            {
                "duration": 24.0,
                "segments": [
                    {"start": 10.0, "end": 12.0, "text": "Previous sentence."},
                    {"start": 14.0, "end": 18.0, "text": "Target sentence."},
                    {"start": 20.0, "end": 22.0, "text": "Next sentence."},
                ],
            },
        )

        self.assertAlmostEqual(
            highlights[0]["start_time"],
            14.0 - HIGHLIGHT_PADDING_SECONDS,
        )
        self.assertAlmostEqual(
            highlights[0]["end_time"],
            18.0 + HIGHLIGHT_PADDING_SECONDS,
        )

    def test_padding_does_not_enter_adjacent_sentence(self):
        highlights = _snap_highlights_to_transcript(
            [
                {
                    "start_time": 13.0,
                    "end_time": 16.0,
                    "speech_start_time": 13.0,
                    "speech_end_time": 16.0,
                }
            ],
            {
                "duration": 20.0,
                "segments": [
                    {"start": 10.0, "end": 13.0, "text": "Previous sentence."},
                    {"start": 13.0, "end": 16.0, "text": "Target sentence."},
                    {"start": 16.0, "end": 19.0, "text": "Next sentence."},
                ],
            },
        )

        self.assertEqual(highlights[0]["start_time"], 13.0)
        self.assertEqual(highlights[0]["end_time"], 16.0)


class WordCaptionTests(unittest.TestCase):
    def test_does_not_estimate_word_cues_from_legacy_segments(self):
        cues = _build_word_cues(
            {
                "segments": [
                    {"start": 10.0, "end": 12.0, "text": "Hello world"},
                ]
            },
            clip_start=8.0,
            clip_end=14.0,
        )

        self.assertEqual(cues, [])

    def test_prefers_exact_whisper_word_timestamps(self):
        cues = _build_word_cues(
            {
                "segments": [
                    {
                        "start": 10.0,
                        "end": 11.0,
                        "text": "Exact timing",
                        "words": [
                            {"word": "Exact", "start": 10.1, "end": 10.4},
                            {"word": "timing", "start": 10.5, "end": 10.9},
                        ],
                    }
                ]
            },
            clip_start=10.0,
            clip_end=11.0,
        )

        self.assertEqual(cues[0]["words"], ["Exact", "timing"])
        self.assertEqual(cues[0]["active_index"], 0)
        self.assertEqual(cues[1]["active_index"], 1)
        self.assertAlmostEqual(
            cues[0]["start"],
            0.1 - CAPTION_VISUAL_LEAD_SECONDS,
        )
        self.assertAlmostEqual(cues[1]["end"], 0.9)

    def test_excludes_words_before_selected_speech_start(self):
        cues = _build_word_cues(
            {
                "segments": [
                    {
                        "start": 9.5,
                        "end": 11.0,
                        "text": "Little bit but yeah all I got",
                        "words": [
                            {"word": "Little", "start": 9.5, "end": 9.8},
                            {"word": "but", "start": 9.9, "end": 10.1},
                            {"word": "Yeah", "start": 10.2, "end": 10.5},
                            {"word": "all", "start": 10.55, "end": 10.7},
                            {"word": "I", "start": 10.72, "end": 10.8},
                            {"word": "got", "start": 10.82, "end": 11.0},
                        ],
                    }
                ]
            },
            clip_start=9.4,
            clip_end=11.0,
            speech_start=10.2,
        )

        self.assertTrue(cues)
        self.assertEqual(cues[0]["words"], ["Yeah", "all", "I", "got"])
        self.assertNotIn("Little", {word for cue in cues for word in cue["words"]})

    def test_caption_groups_avoid_orphans_and_weak_endings(self):
        tokens = (
            "But your brain has no trouble recognizing it as a three and the brightest "
            "neuron of that layer wins. Assign a weight to each connection and put this "
            "weighted sum into a function because that is useful."
        ).split()
        words = [
            {
                "text": token,
                "start": index * 0.22,
                "end": index * 0.22 + 0.18,
            }
            for index, token in enumerate(tokens)
        ]

        groups = _group_caption_words(words)
        metrics = _caption_group_metrics(groups)

        self.assertEqual(metrics["singleton_count"], 0)
        self.assertEqual(metrics["forbidden_ending_count"], 0)
        self.assertLessEqual(metrics["max_words_per_group"], CAPTION_MAX_PHRASE_WORDS)
        self.assertTrue(
            all(
                re.sub(r"[^a-z']", "", group[-1]["text"].lower())
                not in CAPTION_FORBIDDEN_ENDINGS
                for group in groups
            )
        )

    def test_trims_long_opening_dead_air_to_measured_first_word(self):
        transcript = {
            "segments": [
                {
                    "start": 4.0,
                    "end": 5.0,
                    "text": "Real speech",
                    "words": [
                        {"word": "Real", "start": 4.06, "end": 4.3},
                        {"word": "speech", "start": 4.35, "end": 4.8},
                    ],
                }
            ]
        }
        self.assertAlmostEqual(_trim_opening_dead_air(transcript, 0.0, 10.0), 3.61)

    def test_renderer_draws_phrase_in_lower_third(self):
        frame = np.zeros((360, 202, 3), dtype=np.uint8)
        renderer = _CaptionRenderer(frame_width=202, frame_height=360)
        rendered = renderer.draw(
            frame,
            {"words": ["active", "caption", "phrase"], "active_index": 1},
        )

        self.assertEqual(rendered.shape, frame.shape)
        lower_region = rendered[210:310, 10:192]
        upper_region = rendered[:150, 10:192]
        self.assertGreater(int(np.count_nonzero(lower_region)), 0)
        self.assertEqual(int(np.count_nonzero(upper_region)), 0)
        self.assertLessEqual(renderer.last_layout_line_count, 2)


class SmartReframeTests(unittest.TestCase):
    def test_motion_hint_bypasses_false_facecam_detection(self):
        class FakeCap:
            def __init__(self):
                self.frames = [np.zeros((180, 320, 3), dtype=np.uint8) for _ in range(12)]
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

        class FalsePositiveCascade:
            def detectMultiScale(self, *args, **kwargs):
                return np.array([[5, 5, 30, 30]], dtype=np.int32)

        layout, box = _detect_clip_layout(
            cv2,
            FakeCap(),
            FalsePositiveCascade(),
            (320, 180),
            layout_hint="motion",
        )

        self.assertEqual(layout, "motion")
        self.assertIsNone(box)

    def test_realesrgan_winner_blends_twenty_five_percent_source_reference(self):
        enhanced = np.full((4, 4, 3), 200, dtype=np.uint8)
        reference = np.full((4, 4, 3), 100, dtype=np.uint8)

        blended = _blend_realesrgan_reference(cv2, enhanced, reference)

        self.assertTrue(np.all(blended == 175))

    def test_gameplay_hint_does_not_misclassify_game_character_as_speaker(self):
        class FakeCap:
            def __init__(self):
                self.frames = [np.zeros((180, 320, 3), dtype=np.uint8) for _ in range(12)]
                self.position = 0

            def get(self, prop):
                if prop == cv2.CAP_PROP_FRAME_COUNT:
                    return len(self.frames)
                return 0

            def set(self, prop, value):
                if prop == cv2.CAP_PROP_POS_FRAMES:
                    self.position = int(value)

            def read(self):
                frame = self.frames[min(self.position, len(self.frames) - 1)]
                self.position += 1
                return True, frame.copy()

        class FakeCascade:
            def detectMultiScale(self, *args, **kwargs):
                return np.array([[120, 45, 70, 80]], dtype=np.int32)

        layout, box = _detect_clip_layout(
            cv2,
            FakeCap(),
            FakeCascade(),
            (320, 180),
            layout_hint="gameplay",
        )

        self.assertEqual(layout, "motion")
        self.assertIsNone(box)

    def test_realesrgan_chooses_smallest_supported_upscale(self):
        self.assertEqual(_realesrgan_scale((720, 1280), (720, 1280)), 2)
        self.assertEqual(_realesrgan_scale((607, 1080), (720, 1280)), 2)
        self.assertEqual(_realesrgan_scale((300, 533), (720, 1280)), 3)
        self.assertEqual(_realesrgan_scale((202, 360), (720, 1280)), 4)

    def test_realesrgan_command_uses_video_model_and_explicit_models_path(self):
        command = _realesrgan_command(
            ("/runtime/realesrgan-ncnn-vulkan", "/runtime/models"),
            "/tmp/input",
            "/tmp/output",
            2,
        )

        self.assertIn("realesr-animevideov3", command)
        self.assertEqual(command[command.index("-s") + 1], "2")
        self.assertEqual(command[command.index("-m") + 1], "/runtime/models")

    def test_crop_center_never_exposes_vertical_frame_edges(self):
        left = _crop_safe_center((0.0, 180.0), (640, 360), 9.0 / 16.0)
        right = _crop_safe_center((640.0, 180.0), (640, 360), 9.0 / 16.0)

        self.assertAlmostEqual(left[0], 101.25)
        self.assertAlmostEqual(right[0], 538.75)

    def test_production_output_profile_is_vertical_h264(self):
        self.assertEqual(_output_dimensions("9:16"), (720, 1280))
        command = _mux_audio_command("silent.mp4", "source.mp4", "short.mp4")
        self.assertIn("libx264", command)
        self.assertEqual(command[command.index("-profile:v") + 1], "high")
        self.assertEqual(command[command.index("-crf") + 1], "21")
        self.assertIn("yuv420p", command)
        self.assertIn("aac", command)
        self.assertEqual(command[command.index("-b:a") + 1], "192k")
        self.assertEqual(command[command.index("-ar") + 1], "48000")
        self.assertIn("loudnorm=I=-15.0:LRA=7:TP=-1.5", command)

        raw_command = _raw_video_command(
            "audio.mkv",
            "short.mp4",
            (720, 1280),
            30.0,
            duration=10.0,
        )
        self.assertIn("rawvideo", raw_command)
        self.assertIn("pipe:0", raw_command)
        self.assertIn("libx264", raw_command)
        self.assertEqual(raw_command[raw_command.index("-ar") + 1], "48000")
        self.assertIn("fade=t=out:st=9.900:d=0.100", raw_command)
        self.assertIn(
            "loudnorm=I=-15.0:LRA=7:TP=-1.5,"
            "afade=t=out:st=9.900:d=0.100,apad,atrim=duration=10.000",
            raw_command,
        )

        music_command = _raw_video_command(
            "audio.mkv",
            "short.mp4",
            (720, 1280),
            30.0,
            duration=10.0,
            music_path="music.mp3",
        )
        self.assertIn("music.mp3", music_command)
        self.assertIn("-stream_loop", music_command)
        self.assertIn("-filter_complex", music_command)
        music_filter = music_command[music_command.index("-filter_complex") + 1]
        self.assertIn("loudnorm=I=-31.0:LRA=5:TP=-6", music_filter)
        self.assertIn("volume='if(lt(t,", music_filter)
        self.assertIn("sidechaincompress", music_filter)
        self.assertIn("threshold=0.055:ratio=4:attack=15:release=260", music_filter)
        self.assertIn("amix=inputs=2:duration=first:normalize=0", music_filter)
        self.assertIn("alimiter=limit=0.75:level=false", music_filter)
        self.assertIn("afade=t=in:st=0:d=0.350", music_filter)
        self.assertEqual(music_command[music_command.index("-map", 20) + 1], "0:v:0")
        self.assertIn("[aout]", music_command)

        payoff = _motivational_payoff_start(
            [
                {"start": 1.0, "phrase_id": 0},
                {"start": 7.2, "phrase_id": 3},
                {"start": 7.5, "phrase_id": 3},
            ],
            10.0,
        )
        self.assertEqual(payoff, 7.2)
        curve = _motivational_music_volume_filter(10.0, "reflective", payoff)
        self.assertIn("if(lt(t,6.880),0.720", curve)
        self.assertIn("if(lt(t,7.200),0.500,1.000)", curve)

        cut_command = _cut_subclip_command("source.mp4", 3.0, 10.0, "cut.mkv")
        self.assertIn("ffv1", cut_command)
        self.assertIn("pcm_s16le", cut_command)
        self.assertIn("fps=30", cut_command)
        self.assertLess(cut_command.index("-ss"), cut_command.index("-i"))
        self.assertNotIn("libx264", cut_command)

    def test_visual_metrics_distinguish_motion_from_static_frames(self):
        static_frames = [np.zeros((90, 160, 3), dtype=np.uint8) for _ in range(6)]
        moving_frames = []
        for index in range(6):
            frame = np.zeros((90, 160, 3), dtype=np.uint8)
            frame[30:60, 10 + index * 20:35 + index * 20] = 255
            moving_frames.append(frame)

        static_metrics = visual_metrics_from_frames(static_frames, cv2)
        moving_metrics = visual_metrics_from_frames(moving_frames, cv2)

        self.assertGreater(
            moving_metrics["visual_action_score"],
            static_metrics["visual_action_score"],
        )
        self.assertGreater(static_metrics["static_frame_ratio"], 0.9)

    def test_sparse_animation_is_classified_as_presentation(self):
        frames = []
        for index in range(6):
            frame = np.zeros((180, 320, 3), dtype=np.uint8)
            frame[45:115, 70 + index * 8:210 + index * 8] = 255
            frames.append(frame)

        subject = _presentation_subject(cv2, frames)

        self.assertIsNotNone(subject)
        self.assertLessEqual(subject[0], 70)
        self.assertGreaterEqual(subject[0] + subject[2], 250)

    def test_presentation_composition_preserves_subject_above_captions(self):
        frame = np.zeros((180, 320, 3), dtype=np.uint8)
        frame[35:145, 20:300] = 255

        rendered = _compose_presentation(
            cv2,
            frame,
            output_size=(100, 180),
            subject_box=(20, 35, 280, 110),
        )

        self.assertEqual(rendered.shape, (180, 100, 3))
        self.assertGreater(int(np.count_nonzero(rendered[:112])), 0)
        self.assertEqual(int(np.count_nonzero(rendered[120:])), 0)
        foreground_columns = np.where(np.any(rendered != 0, axis=(0, 2)))[0]
        self.assertGreaterEqual(foreground_columns[-1] - foreground_columns[0] + 1, 94)

    def test_context_overlay_is_confined_to_the_visual_region(self):
        frame = np.zeros((180, 100, 3), dtype=np.uint8)
        rendered = _draw_context_overlay(cv2, frame, "Focusing on one example")

        self.assertGreater(int(np.count_nonzero(rendered[:70])), 0)
        self.assertEqual(int(np.count_nonzero(rendered[100:])), 0)

    def test_persistent_small_corner_face_is_classified_as_facecam(self):
        candidates = [
            (index, (270 + index % 2, 125, 28, 28))
            for index in range(6)
        ]

        facecam = _classify_facecam_candidates(
            candidates,
            frame_size=(320, 180),
            sample_count=12,
        )

        self.assertIsNotNone(facecam)
        self.assertGreater(facecam[0], 250)
        self.assertGreater(facecam[1], 110)

    def test_split_screen_keeps_gameplay_above_and_facecam_below(self):
        frame = np.zeros((180, 320, 3), dtype=np.uint8)
        frame[:, :] = (0, 180, 0)
        frame[75:180, 225:320] = (0, 0, 255)

        rendered = _compose_split_screen(
            cv2,
            frame,
            output_size=(100, 180),
            face_box=(265, 115, 30, 30),
        )

        self.assertEqual(rendered.shape, (180, 100, 3))
        self.assertGreater(float(rendered[:100, :, 1].mean()), float(rendered[:100, :, 2].mean()))
        self.assertGreater(float(rendered[115:, :, 2].mean()), float(rendered[115:, :, 1].mean()))

    def test_split_screen_gameplay_panel_can_follow_action(self):
        frame = np.zeros((180, 320, 3), dtype=np.uint8)
        frame[:, :] = (0, 160, 0)
        frame[40:125, 250:315] = (0, 0, 255)

        centered = _compose_split_screen(
            cv2,
            frame,
            output_size=(100, 180),
            face_box=(5, 5, 25, 25),
        )
        tracked = _compose_split_screen(
            cv2,
            frame,
            output_size=(100, 180),
            face_box=(5, 5, 25, 25),
            gameplay_center=(285, 90),
        )

        self.assertGreater(float(tracked[:108, :, 2].mean()), float(centered[:108, :, 2].mean()))

    def test_facecam_region_is_removed_from_motion_analysis(self):
        frame = np.full((90, 160, 3), 40, dtype=np.uint8)
        frame[55:90, 120:160] = 255

        masked = _mask_bbox(frame, (120, 55, 40, 35), padding_ratio=0.0)

        self.assertEqual(int(np.count_nonzero(masked[55:90, 120:160])), 0)
        self.assertEqual(int(masked[20, 20, 0]), 40)

    def test_split_layout_captions_stay_above_facecam(self):
        frame = np.zeros((360, 202, 3), dtype=np.uint8)
        renderer = _CaptionRenderer(
            frame_width=202,
            frame_height=360,
            vertical_position_ratio=CAPTION_SPLIT_VERTICAL_POSITION_RATIO,
        )
        rendered = renderer.draw(
            frame,
            {"words": ["one", "exit", "left"], "active_index": 1},
        )

        self.assertGreater(int(np.count_nonzero(rendered[145:220])), 0)
        self.assertEqual(int(np.count_nonzero(rendered[245:])), 0)

    def test_motion_tracker_moves_smoothly_toward_action(self):
        tracker = _MotionTracker(cv2, frame_size=(320, 180), fps=30.0)
        empty = np.zeros((180, 320, 3), dtype=np.uint8)
        for _ in range(8):
            tracker.update(empty)

        moving = empty.copy()
        moving[70:120, 245:300] = 255
        centers = [tracker.update(moving) for _ in range(20)]

        self.assertGreater(centers[-1][0], 160)
        frame_to_frame_steps = [
            abs(centers[index + 1][0] - centers[index][0])
            for index in range(len(centers) - 1)
        ]
        self.assertLessEqual(max(frame_to_frame_steps), 3)


if __name__ == "__main__":
    unittest.main()
