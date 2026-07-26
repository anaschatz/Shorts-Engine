import json
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from shorts_generator.performance import PerformanceTelemetry


class FakeClock:
    def __init__(self, value=100.0):
        self.value = float(value)

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += float(seconds)


class FakeUtcClock:
    def __init__(self):
        self.value = datetime(2026, 7, 20, 12, 0, tzinfo=timezone.utc)

    def __call__(self):
        value = self.value
        self.value += timedelta(seconds=1)
        return value


class PerformanceTelemetryTests(unittest.TestCase):
    def tracker(self):
        self.clock = FakeClock()
        self.utc_clock = FakeUtcClock()
        return PerformanceTelemetry(
            run_id="run-001",
            metadata={"sourceId": "video-001"},
            clock=self.clock,
            utc_clock=self.utc_clock,
        )

    def test_stage_uses_monotonic_time_and_builds_aggregates(self):
        tracker = self.tracker()
        with tracker.stage("transcribe", model="base"):
            self.clock.advance(1.25)
        self.clock.advance(0.5)
        with tracker.stage("transcribe", model="base"):
            self.clock.advance(2.0)

        report = tracker.finish()

        self.assertEqual(report["durationSeconds"], 3.75)
        self.assertEqual(
            [stage["durationSeconds"] for stage in report["stages"]],
            [1.25, 2.0],
        )
        self.assertEqual(report["stages"][1]["startedOffsetSeconds"], 1.75)
        self.assertEqual(report["stages"][0]["attributes"], {"model": "base"})
        self.assertEqual(
            report["stageTotals"]["transcribe"],
            {"count": 2, "errorCount": 0, "durationSeconds": 3.25},
        )
        self.assertEqual(report["summary"]["stageInvocationCount"], 2)
        self.assertEqual(report["startedAt"], "2026-07-20T12:00:00Z")
        self.assertEqual(report["finishedAt"], "2026-07-20T12:00:01Z")

    def test_failed_stage_is_recorded_and_exception_is_reraised(self):
        tracker = self.tracker()

        with self.assertRaisesRegex(RuntimeError, "render failed"):
            with tracker.stage("render"):
                self.clock.advance(0.75)
                raise RuntimeError("render failed")

        report = tracker.finish()
        self.assertEqual(report["stages"][0]["status"], "error")
        self.assertEqual(report["stages"][0]["errorType"], "RuntimeError")
        self.assertEqual(report["stageTotals"]["render"]["errorCount"], 1)
        self.assertEqual(report["summary"]["stageErrorCount"], 1)

    def test_cache_counters_include_per_cache_and_global_hit_rates(self):
        tracker = self.tracker()
        tracker.cache_hit("transcript", count=3)
        tracker.cache_miss("transcript")
        tracker.cache_miss("render", count=2)

        report = tracker.finish()

        self.assertEqual(
            report["cacheCounters"]["transcript"],
            {"hits": 3, "misses": 1, "requests": 4, "hitRate": 0.75},
        )
        self.assertEqual(report["summary"]["cacheHits"], 3)
        self.assertEqual(report["summary"]["cacheMisses"], 3)
        self.assertEqual(report["summary"]["cacheHitRate"], 0.5)

    def test_cache_counters_are_thread_safe(self):
        tracker = self.tracker()
        worker_count = 8
        iterations = 250

        def record():
            for _ in range(iterations):
                tracker.cache_hit("shared")
                tracker.cache_miss("shared")

        threads = [threading.Thread(target=record) for _ in range(worker_count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        counter = tracker.finish()["cacheCounters"]["shared"]
        self.assertEqual(counter["hits"], worker_count * iterations)
        self.assertEqual(counter["misses"], worker_count * iterations)
        self.assertEqual(counter["hitRate"], 0.5)

    def test_finish_is_idempotent_and_rejects_new_events(self):
        tracker = self.tracker()
        first = tracker.finish()
        self.clock.advance(10)
        second = tracker.finish()

        self.assertEqual(first, second)
        with self.assertRaisesRegex(RuntimeError, "already finished"):
            tracker.cache_hit("transcript")
        with self.assertRaisesRegex(RuntimeError, "already finished"):
            with tracker.stage("render"):
                pass

    def test_write_report_replaces_existing_file_with_valid_json(self):
        tracker = self.tracker()
        tracker.cache_hit("source")
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "nested" / "run-timings.json"
            target.parent.mkdir()
            target.write_text("old report", encoding="utf-8")

            written = tracker.write_report(target)
            payload = json.loads(target.read_text(encoding="utf-8"))

            self.assertEqual(written, target.resolve())
            self.assertEqual(payload["artifactType"], "PerformanceReport")
            self.assertEqual(payload["cacheCounters"]["source"]["hits"], 1)
            self.assertTrue(target.read_text(encoding="utf-8").endswith("\n"))
            self.assertEqual(list(target.parent.glob(f".{target.name}.*.tmp")), [])

    def test_failed_atomic_replace_preserves_previous_report_and_cleans_temp(self):
        tracker = self.tracker()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "run-timings.json"
            target.write_text("previous", encoding="utf-8")

            with mock.patch(
                "shorts_generator.performance.os.replace",
                side_effect=OSError("replace failed"),
            ):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    tracker.write_report(target)

            self.assertEqual(target.read_text(encoding="utf-8"), "previous")
            self.assertEqual(list(target.parent.glob(f".{target.name}.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
