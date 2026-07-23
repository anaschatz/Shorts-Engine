import unittest
from unittest.mock import patch

from shorts_generator.local import clipper


class BfSmoothTailV5RegressionTests(unittest.TestCase):
    def _profile(self):
        self.assertTrue(
            hasattr(clipper, "BF_SMOOTH_TAIL_V5"),
            "the corrected post-source fade must be versioned as bf_smooth_tail_v5",
        )
        return clipper.BF_SMOOTH_TAIL_V5

    def test_live_source_stays_full_bright_until_verified_safe_end(self):
        acoustic_end = 4159.620
        next_word_start = 4159.740
        safety_seconds = 0.010
        safe_source_end = 4159.730
        visual_fade_seconds = 0.130
        brand_tail_seconds = 0.850

        plan = clipper._bf_editorial_tail_plan(
            {
                "duration": 4200.0,
                "segments": [
                    {
                        "start": 4159.0,
                        "end": 4160.0,
                        "words": [
                            {
                                "word": "point.",
                                "start": 4159.0,
                                "end": acoustic_end,
                            },
                            {
                                "word": "Next",
                                "start": next_word_start,
                                "end": 4159.940,
                            },
                        ],
                    }
                ],
            },
            speech_end_time=acoustic_end,
            brand_tail_seconds=brand_tail_seconds,
            tail_profile=self._profile(),
            verified_acoustic_speech_end_time=acoustic_end,
            verified_next_spoken_word_start=next_word_start,
            verified_next_speech_safety_seconds=safety_seconds,
            verified_acoustic_boundary_evidence="waveform review",
        )

        self.assertAlmostEqual(plan["acoustic_speech_end_time"], acoustic_end)
        self.assertAlmostEqual(plan["acoustic_safe_source_end_time"], safe_source_end)
        self.assertAlmostEqual(plan["source_content_end_time"], safe_source_end)
        self.assertAlmostEqual(plan["visual_transition_start_time"], safe_source_end)
        self.assertAlmostEqual(plan["transition_tail_seconds"], visual_fade_seconds)

        brand_tail_start = plan["output_end_time"] - brand_tail_seconds
        self.assertAlmostEqual(
            brand_tail_start,
            safe_source_end + visual_fade_seconds,
        )
        self.assertAlmostEqual(plan["freeze_hold_seconds"], 0.0)
        self.assertTrue(plan["source_speech_leak_guard_passed"])
        self.assertLessEqual(
            plan["source_content_end_time"],
            next_word_start - safety_seconds + 1e-9,
        )

    def test_renderer_does_not_dim_before_live_source_has_ended(self):
        source_end = 4159.730
        fade_seconds = 0.130
        brand_tail_start = source_end + fade_seconds

        self.assertIsNone(
            clipper._bf_brand_transition_progress(
                source_end - 0.001,
                brand_tail_start,
                fade_seconds,
                smooth=True,
            )
        )
        self.assertAlmostEqual(
            clipper._bf_brand_transition_progress(
                source_end,
                brand_tail_start,
                fade_seconds,
                smooth=True,
            ),
            0.0,
        )
        self.assertAlmostEqual(
            clipper._bf_brand_transition_progress(
                source_end + fade_seconds / 2.0,
                brand_tail_start,
                fade_seconds,
                smooth=True,
            ),
            0.5,
        )
        self.assertAlmostEqual(
            clipper._bf_brand_transition_progress(
                brand_tail_start,
                brand_tail_start,
                fade_seconds,
                smooth=True,
            ),
            1.0,
        )

    def test_visual_guard_uses_only_a_bounded_breath_before_fade(self):
        plan = clipper._bf_editorial_tail_plan(
            {"duration": 4200.0, "segments": []},
            speech_end_time=4159.810,
            brand_tail_seconds=0.850,
            tail_profile=self._profile(),
            verified_acoustic_speech_end_time=4159.810,
            verified_next_spoken_word_start=4159.890,
            verified_next_speech_safety_seconds=0.010,
            verified_acoustic_boundary_evidence="spectrogram review",
            verified_visual_safe_end_time=4159.840,
            verified_visual_boundary_evidence=(
                "last safe source frame is 4159.822333"
            ),
        )

        self.assertAlmostEqual(plan["source_content_end_time"], 4159.840)
        self.assertAlmostEqual(plan["freeze_hold_seconds"], 0.040)
        self.assertLessEqual(plan["freeze_hold_seconds"], 0.080)
        self.assertAlmostEqual(plan["visual_transition_start_time"], 4159.880)
        self.assertAlmostEqual(plan["transition_tail_seconds"], 0.130)
        self.assertAlmostEqual(
            plan["output_end_time"] - 0.850,
            4160.010,
        )
        self.assertTrue(plan["source_speech_leak_guard_passed"])

    @patch("shorts_generator.local.clipper.crop_clip_local")
    def test_crop_contract_places_brand_after_post_source_fade(self, crop_clip):
        crop_clip.return_value = "/tmp/ignored.mp4"
        acoustic_end = 10.500
        next_word_start = 10.620
        safety_seconds = 0.010
        safe_source_end = 10.610
        fade_seconds = 0.130
        brand_tail_start = 10.740

        [result] = clipper.crop_highlights_local(
            "source.mp4",
            [
                {
                    "title": "Complete point before the next sentence",
                    "start_time": 0.0,
                    "end_time": acoustic_end,
                    "speech_end_time": acoustic_end,
                    "brand_tail_profile": self._profile(),
                    "verified_acoustic_speech_end_time": acoustic_end,
                    "verified_next_spoken_word_start": next_word_start,
                    "verified_next_speech_safety_seconds": safety_seconds,
                    "verified_acoustic_boundary_evidence": "waveform review",
                    "render_profile": clipper.BF_EDITORIAL_INSET_RENDER_PROFILE,
                    "layout_hint": clipper.BF_EDITORIAL_INSET_LAYOUT,
                }
            ],
            out_dir="/tmp/bf-smooth-tail-v5-regression",
            transcript={
                "duration": 20.0,
                "segments": [
                    {
                        "start": 0.0,
                        "end": 10.900,
                        "words": [
                            {"word": "Start", "start": 0.0, "end": 0.250},
                            {
                                "word": "point.",
                                "start": 10.0,
                                "end": acoustic_end,
                            },
                            {
                                "word": "Next",
                                "start": next_word_start,
                                "end": 10.900,
                            },
                        ],
                    }
                ],
            },
            render_profile=clipper.BF_EDITORIAL_INSET_RENDER_PROFILE,
        )

        self.assertIsNotNone(result["clip_url"])
        self.assertAlmostEqual(result["source_content_end_time"], safe_source_end)
        self.assertAlmostEqual(result["visual_transition_start_time"], safe_source_end)
        self.assertAlmostEqual(result["transition_tail_seconds"], fade_seconds)
        self.assertAlmostEqual(result["brand_tail_start_seconds"], brand_tail_start)
        self.assertAlmostEqual(result["freeze_hold_seconds"], 0.0)
        self.assertTrue(result["source_speech_leak_guard_passed"])

        crop_clip.assert_called_once()
        call = crop_clip.call_args
        self.assertAlmostEqual(call.kwargs["source_content_end_time"], safe_source_end)
        self.assertAlmostEqual(
            call.kwargs["brand_tail_transition_seconds"],
            fade_seconds,
        )
        self.assertAlmostEqual(
            call.args[2] - float(result["brand_tail_seconds"]),
            brand_tail_start,
        )


if __name__ == "__main__":
    unittest.main()
