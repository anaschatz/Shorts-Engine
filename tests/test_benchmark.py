import json
import tempfile
import unittest
from pathlib import Path

from shorts_generator.benchmark import (
    BenchmarkValidationError,
    benchmark_generate_call,
    build_benchmark_report,
    build_cold_warm_comparison,
    isolated_cache_environment,
    write_benchmark_report,
)


def performance_report(*, warm=False, duplicate_download=False, include_qa=True):
    stages = [
        {
            "name": "pipeline",
            "sequence": 0,
            "status": "ok",
            "startedOffsetSeconds": 0.0,
            "durationSeconds": 20.0,
        },
        {
            "name": "download",
            "sequence": 1,
            "status": "ok",
            "startedOffsetSeconds": 0.0,
            "durationSeconds": 4.0,
        },
        {
            "name": "transcription",
            "sequence": 2,
            "status": "ok",
            "startedOffsetSeconds": 4.0,
            "durationSeconds": 3.0,
        },
        {
            "name": "candidate_generation",
            "sequence": 3,
            "status": "ok",
            "startedOffsetSeconds": 7.0,
            "durationSeconds": 5.0,
        },
        {
            "name": "candidate_ranking",
            "sequence": 4,
            "status": "ok",
            "startedOffsetSeconds": 11.5,
            "durationSeconds": 1.5,
        },
        {
            "name": "render_batch",
            "sequence": 5,
            "status": "ok",
            "startedOffsetSeconds": 13.0,
            "durationSeconds": 5.0,
        },
    ]
    if duplicate_download:
        stages.append(
            {
                "name": "download",
                "sequence": 6,
                "status": "ok",
                "startedOffsetSeconds": 3.0,
                "durationSeconds": 1.0,
            }
        )
    if include_qa:
        stages.append(
            {
                "name": "editorial_qa",
                "sequence": 7,
                "status": "ok",
                "startedOffsetSeconds": 18.0,
                "durationSeconds": 2.0,
            }
        )
    return {
        "schemaVersion": 1,
        "artifactType": "PerformanceReport",
        "runId": "run-warm" if warm else "run-cold",
        "startedAt": "2026-07-21T00:00:00Z",
        "finishedAt": "2026-07-21T00:00:20Z",
        "durationSeconds": 20.0,
        "metadata": {"sourceInput": "https://example.test/video"},
        "stages": stages,
        "cacheCounters": {
            "source": {
                "hits": 1 if warm else 0,
                "misses": 0 if warm else 1,
            },
            "transcript": {
                "hits": 1 if warm else 0,
                "misses": 0 if warm else 1,
            },
            "llm_candidates": {
                "hits": 4 if warm else 0,
                "misses": 0 if warm else 4,
            },
        },
    }


def successful_result(report_path):
    return {
        "shorts": [
            {"clip_url": "/tmp/short-1.mp4"},
            {"clip_url": "/tmp/short-2.mp4"},
            {"clip_url": "/tmp/short-3.mp4"},
        ],
        "ranking": {"target_clips": 3},
        "performance": {"report_path": str(report_path)},
    }


class BenchmarkReportTests(unittest.TestCase):
    def test_report_uses_interval_union_and_truthful_overall_wall(self):
        report = build_benchmark_report(
            performance_report(),
            result=successful_result("unused"),
            outer_wall_seconds=20.25,
            expected_cache_state="cold",
            enforce_one_pass=True,
        )

        self.assertEqual(report["overallWallSeconds"], 20.25)
        self.assertEqual(report["pipelineReportedSeconds"], 20.0)
        self.assertEqual(report["wrapperOverheadSeconds"], 0.25)
        self.assertEqual(report["stages"]["discoveryRanking"]["wallSeconds"], 6.0)
        self.assertEqual(report["canonicalCoveredWallSeconds"], 20.0)
        self.assertEqual(report["parallelOverlapSeconds"], 0.0)
        self.assertEqual(report["uninstrumentedPipelineSeconds"], 0.0)
        self.assertEqual(report["cache"]["observedState"], "cold")
        self.assertTrue(report["onePass"]["passed"])

    def test_one_pass_enforcement_rejects_duplicate_pass_and_missing_qa(self):
        with self.assertRaisesRegex(BenchmarkValidationError, "download pass"):
            build_benchmark_report(
                performance_report(duplicate_download=True),
                result=successful_result("unused"),
                enforce_one_pass=True,
            )
        with self.assertRaisesRegex(BenchmarkValidationError, "QA timing is missing"):
            build_benchmark_report(
                performance_report(include_qa=False),
                result=successful_result("unused"),
                enforce_one_pass=True,
            )

    def test_cache_expectation_is_enforced_and_reported_per_cache(self):
        report = build_benchmark_report(
            performance_report(warm=True),
            result=successful_result("unused"),
            expected_cache_state="warm",
            enforce_one_pass=True,
        )
        self.assertEqual(report["cache"]["observedState"], "warm")
        self.assertEqual(report["cache"]["byCache"]["source"]["state"], "warm")
        mismatch = build_benchmark_report(
            performance_report(warm=True),
            result=successful_result("unused"),
            expected_cache_state="cold",
        )
        self.assertTrue(mismatch["onePass"]["passed"])
        self.assertFalse(mismatch["validation"]["passed"])
        with self.assertRaisesRegex(BenchmarkValidationError, "expected cold cache"):
            build_benchmark_report(
                performance_report(warm=True),
                result=successful_result("unused"),
                expected_cache_state="cold",
                enforce_one_pass=True,
            )

    def test_failed_or_missing_outputs_fail_closed(self):
        result = successful_result("unused")
        result["shorts"][1] = {"error": "encode failed"}
        with self.assertRaisesRegex(BenchmarkValidationError, "output"):
            build_benchmark_report(
                performance_report(),
                result=result,
                enforce_one_pass=True,
            )

    def test_cold_warm_comparison_exposes_speedup_and_stage_deltas(self):
        cold = build_benchmark_report(
            performance_report(),
            result=successful_result("unused"),
            expected_cache_state="cold",
            enforce_one_pass=True,
        )
        warm = build_benchmark_report(
            performance_report(warm=True),
            result=successful_result("unused"),
            expected_cache_state="warm",
            enforce_one_pass=True,
        )
        # Use a shorter, internally consistent synthetic warm run.
        warm["overallWallSeconds"] = 10.0
        warm["stages"]["render"]["wallSeconds"] = 6.0
        comparison = build_cold_warm_comparison(cold, warm)

        self.assertEqual(comparison["comparison"]["speedup"], 2.0)
        self.assertTrue(comparison["comparison"]["cacheTransitionPassed"])
        self.assertTrue(comparison["comparison"]["bothOnePass"])
        self.assertIn("render", comparison["comparison"]["stages"])
        self.assertEqual(
            comparison["comparison"]["stages"]["render"]["savedSeconds"],
            -1.0,
        )

    def test_benchmark_generate_call_measures_wrapper_and_reads_pipeline_report(self):
        values = iter([100.0, 120.25])
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory) / "performance.json"
            report_path.write_text(json.dumps(performance_report()), encoding="utf-8")

            def generate(**kwargs):
                self.assertEqual(kwargs, {"youtube_url": "https://example.test/video"})
                return successful_result(report_path)

            benchmark, result = benchmark_generate_call(
                generate,
                {"youtube_url": "https://example.test/video"},
                expected_cache_state="cold",
                clock=lambda: next(values),
            )

        self.assertEqual(benchmark["overallWallSeconds"], 20.25)
        self.assertEqual(len(result["shorts"]), 3)

    def test_isolated_environment_refuses_nonempty_cold_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "cache"
            output = Path(directory) / "output"
            environment = isolated_cache_environment(cache, output, require_empty=True)
            self.assertEqual(environment["LOCAL_CACHE_DIR"], str(cache.resolve()))
            self.assertEqual(
                environment["LOCAL_PERFORMANCE_REPORT_DIR"],
                str((output / "performance").resolve()),
            )
            self.assertEqual(
                environment["LOCAL_CANDIDATE_VISUAL_CACHE_DIR"],
                str((cache / "visual-analysis-v1" / "candidate-metrics-v1").resolve()),
            )
            self.assertEqual(
                environment["LOCAL_REAL_ESRGAN_CACHE_DIR"],
                str((cache / "realesrgan-v2").resolve()),
            )
            (cache / "existing").write_text("data", encoding="utf-8")
            with self.assertRaisesRegex(BenchmarkValidationError, "not empty"):
                isolated_cache_environment(cache, output, require_empty=True)

    def test_atomic_report_write_replaces_previous_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "benchmark.json"
            path.parent.mkdir()
            path.write_text("old", encoding="utf-8")
            written = write_benchmark_report({"value": 1}, path)

            self.assertEqual(written, path.resolve())
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"value": 1})
            self.assertEqual(list(path.parent.glob(f".{path.name}.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
