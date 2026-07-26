import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shorts_generator.pipeline import generate_shorts


class PipelinePerformanceTests(unittest.TestCase):
    def test_successful_run_returns_and_persists_stage_telemetry(self):
        with tempfile.TemporaryDirectory() as directory:
            expected = {
                "mode": "api",
                "source_video_url": "https://cdn.example/source.mp4",
                "transcript": {"duration": 1.0, "segments": []},
                "highlights": [],
                "selected_candidates": [],
                "shorts": [],
                "ranking": {},
            }
            with (
                patch(
                    "shorts_generator.pipeline._run_api",
                    return_value=expected,
                ) as run_api,
                patch(
                    "shorts_generator.config.LOCAL_PERFORMANCE_REPORT_DIR",
                    directory,
                ),
            ):
                result = generate_shorts(
                    "https://example.test/source",
                    mode="api",
                    num_clips=1,
                )

            report_path = Path(result["performance"]["report_path"])
            report = json.loads(report_path.read_text(encoding="utf-8"))

        self.assertEqual(report["artifactType"], "PerformanceReport")
        self.assertEqual(report["summary"]["stageErrorCount"], 0)
        self.assertIn("pipeline", report["stageTotals"])
        self.assertEqual(
            result["performance"]["run_id"],
            report["runId"],
        )
        self.assertEqual(
            run_api.call_args.kwargs["telemetry"].run_id,
            result["performance"]["run_id"],
        )

    def test_failed_run_persists_error_stage_without_swallowing_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch(
                    "shorts_generator.pipeline._run_api",
                    side_effect=RuntimeError("synthetic failure"),
                ),
                patch(
                    "shorts_generator.config.LOCAL_PERFORMANCE_REPORT_DIR",
                    directory,
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "synthetic failure"):
                    generate_shorts(
                        "https://example.test/source",
                        mode="api",
                        num_clips=1,
                    )

            reports = list(Path(directory).glob("*.json"))
            self.assertEqual(len(reports), 1)
            report = json.loads(reports[0].read_text(encoding="utf-8"))

        self.assertEqual(report["summary"]["stageErrorCount"], 1)
        self.assertEqual(report["stageTotals"]["pipeline"]["errorCount"], 1)


if __name__ == "__main__":
    unittest.main()
