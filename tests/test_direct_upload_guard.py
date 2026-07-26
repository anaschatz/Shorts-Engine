import io
import sys
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

import main as cli


class DirectUploadGuardTests(unittest.TestCase):
    def test_editorial_profile_cannot_bypass_reviewed_publisher(self):
        result = {
            "mode": "local",
            "profiles": {"render_profile": "bf_editorial_inset_v1"},
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
            "bf_viral_micro_v1",
            "--upload-youtube",
        ]
        with patch.object(sys, "argv", argv), patch.object(
            cli,
            "generate_shorts",
            return_value=result,
        ), redirect_stderr(io.StringIO()) as errors:
            exit_code = cli.main()

        self.assertEqual(exit_code, 1)
        self.assertIn("reviewed hash-bound publisher workflow", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
