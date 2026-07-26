import io
import sys
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

import main as cli
from shorts_generator.pipeline import _run_api, generate_shorts
from shorts_generator.profiles import resolve_profile_bundle


class SelectOnlyTests(unittest.TestCase):
    def test_api_selection_skips_renderer_and_returns_selected_candidates(self):
        transcript = {
            "duration": 60.0,
            "segments": [{"start": 0.0, "end": 12.0, "text": "A complete thought."}],
        }
        candidate = {
            "start_time": 0.0,
            "end_time": 12.0,
            "title": "One decision",
            "rejected": False,
            "rejection_reasons": [],
        }
        selected = [{**candidate, "output_rank": 1, "selected_for_render": True}]
        with patch(
            "shorts_generator.pipeline.download_youtube",
            return_value="https://cdn.example/source.mp4",
        ), patch(
            "shorts_generator.pipeline.transcribe",
            return_value=transcript,
        ), patch(
            "shorts_generator.pipeline.get_highlights",
            return_value={
                "highlights": [candidate],
                "content_info": {"content_type": "other"},
            },
        ), patch(
            "shorts_generator.pipeline.rank_highlights",
            return_value=[candidate],
        ), patch(
            "shorts_generator.pipeline.select_diverse_highlights",
            return_value=selected,
        ), patch("shorts_generator.pipeline.crop_highlights") as crop:
            result = _run_api(
                "https://example.test/source",
                1,
                "9:16",
                "720",
                "en",
                resolve_profile_bundle(),
                select_only=True,
            )

        crop.assert_not_called()
        self.assertEqual(result["shorts"], [])
        self.assertEqual(result["selected_candidates"], selected)
        self.assertTrue(result["ranking"]["selection_only"])
        self.assertEqual(result["ranking"]["rendered_count"], 0)

    def test_approved_render_cannot_be_selection_only(self):
        with self.assertRaisesRegex(ValueError, "cannot use select_only"):
            generate_shorts(
                "/tmp/source.mp4",
                num_clips=1,
                mode="local",
                format_profile="bf_viral_micro_v1",
                approved_candidate_hash="a" * 64,
                approved_transcript={"duration": 12.0, "segments": []},
                select_only=True,
            )

    def test_selection_only_persists_an_empty_selection_instead_of_rendering(self):
        transcript = {
            "duration": 60.0,
            "segments": [{"start": 0.0, "end": 30.0, "text": "An incomplete thought."}],
        }
        rejected = {
            "start_time": 0.0,
            "end_time": 30.0,
            "rejected": True,
            "rejection_reasons": ["micro_duration_over_22s"],
        }
        with patch(
            "shorts_generator.pipeline.download_youtube",
            return_value="https://cdn.example/source.mp4",
        ), patch(
            "shorts_generator.pipeline.transcribe",
            return_value=transcript,
        ), patch(
            "shorts_generator.pipeline.get_highlights",
            return_value={
                "highlights": [rejected],
                "content_info": {"content_type": "other"},
            },
        ), patch(
            "shorts_generator.pipeline.rank_highlights",
            return_value=[rejected],
        ), patch(
            "shorts_generator.pipeline.select_diverse_highlights",
            return_value=[],
        ), patch("shorts_generator.pipeline.crop_highlights") as crop:
            result = _run_api(
                "https://example.test/source",
                1,
                "9:16",
                "720",
                "en",
                resolve_profile_bundle(),
                select_only=True,
            )

        crop.assert_not_called()
        self.assertEqual(result["selected_candidates"], [])
        self.assertEqual(result["shorts"], [])
        self.assertEqual(result["ranking"]["selected_count"], 0)
        self.assertEqual(result["ranking"]["rejected_count"], 1)

    def test_cli_blocks_selection_only_upload_before_running_pipeline(self):
        argv = [
            "main.py",
            "/tmp/source.mp4",
            "--select-only",
            "--upload-youtube",
        ]
        with patch.object(sys, "argv", argv), patch.object(
            cli,
            "generate_shorts",
        ) as generate, redirect_stderr(io.StringIO()) as errors:
            exit_code = cli.main()

        self.assertEqual(exit_code, 1)
        generate.assert_not_called()
        self.assertIn("cannot be combined", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
