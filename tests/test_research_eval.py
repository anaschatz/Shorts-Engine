import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from research.eval import QUALITY_WEIGHTS, evaluate, load_fixtures
from research.runner import _best_reference_report


class ResearchEvalTests(unittest.TestCase):
    def test_offline_runner_import_does_not_load_live_evaluation(self):
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import sys; import research.runner; "
                    "assert 'research.live_eval' not in sys.modules"
                ),
            ],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_reference_set_covers_all_required_categories(self):
        categories = {fixture["category"] for fixture in load_fixtures()}
        self.assertTrue(
            {"tutorial", "gaming", "sports", "podcast", "commentary"}.issubset(categories)
        )
        gaming_layouts = {
            fixture["video_metadata"].get("layout")
            for fixture in load_fixtures()
            if fixture["category"] == "gaming"
        }
        self.assertEqual(gaming_layouts, {"facecam_split", "motion"})

    def test_quality_weights_are_positive_and_sum_to_one(self):
        self.assertTrue(all(weight > 0 for weight in QUALITY_WEIGHTS.values()))
        self.assertAlmostEqual(sum(QUALITY_WEIGHTS.values()), 1.0)

    def test_offline_reference_guardrails_pass(self):
        report = evaluate()
        self.assertEqual(report["fixture_count"], 7)
        self.assertTrue(report["hard_guardrails_pass"])
        self.assertTrue(all(value == 0.0 for value in report["guardrails"].values()))

    def test_tutorial_outro_never_becomes_top_one(self):
        report = evaluate()
        tutorial = next(item for item in report["details"] if item["id"] == "tutorial_aircAruvnKk")
        self.assertNotEqual(tutorial["selected_id"], "promotional_outro")
        self.assertTrue(tutorial["top1_accepted"])

    def test_best_reference_is_highest_scoring_kept_run(self):
        baseline = {
            "run_id": "baseline",
            "status": "baseline",
            "evaluation": {"quality_score": 80.0},
        }
        kept = {
            "run_id": "kept",
            "status": "keep",
            "evaluation": {"quality_score": 85.0},
        }
        discarded = {
            "run_id": "discarded",
            "status": "discard",
            "evaluation": {"quality_score": 99.0},
        }
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            for name, payload in (("kept.json", kept), ("discarded.json", discarded)):
                (runs_dir / name).write_text(json.dumps(payload), encoding="utf-8")
            baseline_path = runs_dir / "baseline.json"
            baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
            with patch("research.runner.BASELINE_PATH", baseline_path), patch(
                "research.runner.RUNS_DIR", runs_dir
            ):
                self.assertEqual(_best_reference_report()["run_id"], "kept")


if __name__ == "__main__":
    unittest.main()
