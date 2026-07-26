import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from shorts_generator.local.visual_features import (
    _compute_uncached_visual_metrics,
    analyze_candidate_visuals,
    build_source_shot_index,
)
from shorts_generator.performance import PerformanceTelemetry


def metrics(value):
    return {
        "motion_score": float(value),
        "scene_change_count": int(value),
        "scene_change_score": float(value + 1),
        "face_visibility_score": float(value + 2),
        "subject_visibility_score": float(value + 3),
        "static_frame_ratio": 0.25,
        "visual_action_score": float(value + 4),
    }


class CandidateVisualPerformanceTests(unittest.TestCase):
    def test_exact_metric_cache_preserves_order_and_skips_warm_compute(self):
        highlights = [
            {"title": "first", "start_time": 10.0, "end_time": 20.0},
            {"title": "second", "start_time": 30.0, "end_time": 40.0},
        ]
        compute_calls = []

        def fake_compute(_source, jobs, _samples, _cv2, workers):
            compute_calls.append((list(jobs), workers))
            return {
                cache_key: metrics(index + 1)
                for index, (cache_key, _start, _end) in enumerate(jobs)
            }

        telemetry = PerformanceTelemetry(run_id="visual-cache")
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"source")
            cache = Path(directory) / "visual-cache"
            patches = (
                patch(
                    "shorts_generator.local.visual_features._source_sha256",
                    return_value="a" * 64,
                ),
                patch(
                    "shorts_generator.local.visual_features._visual_detector_identity",
                    return_value={"algorithm": "fixture", "opencvVersion": "fixture"},
                ),
                patch(
                    "shorts_generator.local.visual_features._visual_detector_identity_without_cv2",
                    return_value={"algorithm": "fixture", "opencvVersion": "fixture"},
                ),
                patch(
                    "shorts_generator.local.visual_features._load_cv2",
                    return_value=object(),
                ),
                patch(
                    "shorts_generator.local.visual_features._compute_uncached_visual_metrics",
                    side_effect=fake_compute,
                ),
            )
            with patches[0], patches[1], patches[2], patches[3] as load_cv2, patches[4]:
                cold = analyze_candidate_visuals(
                    str(source),
                    highlights,
                    cache_dir=str(cache),
                    cache_enabled=True,
                    max_workers=2,
                    telemetry=telemetry,
                )
                warm = analyze_candidate_visuals(
                    str(source),
                    highlights,
                    cache_dir=str(cache),
                    cache_enabled=True,
                    max_workers=2,
                    telemetry=telemetry,
                )
            self.assertEqual(load_cv2.call_count, 1)

            cache_files = list(cache.rglob("*.json"))

        self.assertEqual([item["title"] for item in cold], ["first", "second"])
        self.assertEqual(cold, warm)
        self.assertEqual(len(compute_calls), 1)
        self.assertEqual(compute_calls[0][1], 2)
        self.assertEqual(len(cache_files), 2)
        counter = telemetry.finish()["cacheCounters"]["candidate_visual_metrics"]
        self.assertEqual(counter["misses"], 2)
        self.assertEqual(counter["hits"], 2)

    def test_uncached_work_uses_bounded_workers_and_propagates_failure(self):
        jobs = [(str(index), float(index), float(index + 1)) for index in range(6)]
        lock = threading.Lock()
        active = 0
        peak = 0

        def fake_chunk(_source, chunk, _samples, _cv2):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.03)
            with lock:
                active -= 1
            return [(key, metrics(int(key))) for key, _start, _end in chunk]

        with patch(
            "shorts_generator.local.visual_features._score_visual_chunk",
            side_effect=fake_chunk,
        ):
            result = _compute_uncached_visual_metrics(
                "source.mp4",
                jobs,
                12,
                object(),
                max_workers=2,
            )

        self.assertEqual(set(result), {str(index) for index in range(6)})
        self.assertEqual(peak, 2)

        def failing_chunk(_source, chunk, _samples, _cv2):
            if any(key == "1" for key, _start, _end in chunk):
                raise RuntimeError("decoder failed")
            return [(key, metrics(int(key))) for key, _start, _end in chunk]

        with patch(
            "shorts_generator.local.visual_features._score_visual_chunk",
            side_effect=failing_chunk,
        ):
            with self.assertRaisesRegex(RuntimeError, "decoder failed"):
                _compute_uncached_visual_metrics(
                    "source.mp4",
                    jobs,
                    12,
                    object(),
                    max_workers=2,
                )

    def test_cache_identity_changes_with_sampling_contract(self):
        calls = 0

        def fake_compute(_source, jobs, _samples, _cv2, _workers):
            nonlocal calls
            calls += 1
            return {key: metrics(1) for key, _start, _end in jobs}

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"source")
            cache = Path(directory) / "cache"
            with (
                patch(
                    "shorts_generator.local.visual_features._source_sha256",
                    return_value="a" * 64,
                ),
                patch(
                    "shorts_generator.local.visual_features._visual_detector_identity",
                    return_value={"algorithm": "fixture"},
                ),
                patch(
                    "shorts_generator.local.visual_features._visual_detector_identity_without_cv2",
                    return_value={"algorithm": "fixture"},
                ),
                patch(
                    "shorts_generator.local.visual_features._load_cv2",
                    return_value=object(),
                ),
                patch(
                    "shorts_generator.local.visual_features._compute_uncached_visual_metrics",
                    side_effect=fake_compute,
                ),
            ):
                for sample_count in (12, 13, 12):
                    analyze_candidate_visuals(
                        str(source),
                        [{"start_time": 1.0, "end_time": 2.0}],
                        sample_count=sample_count,
                        cache_enabled=True,
                        cache_dir=str(cache),
                    )

        self.assertEqual(calls, 2)


class ShotAnalysisPerformanceTests(unittest.TestCase):
    def test_cold_intervals_run_concurrently_and_warm_index_is_exact(self):
        lock = threading.Lock()
        active = 0
        peak = 0
        calls = 0

        def fake_runner(command, **_kwargs):
            nonlocal active, peak, calls
            with lock:
                active += 1
                calls += 1
                peak = max(peak, active)
            time.sleep(0.03)
            with lock:
                active -= 1
            return SimpleNamespace(returncode=0, stderr="pts_time:1.0", stdout="")

        intervals = [(10.0, 15.0), (20.0, 25.0), (30.0, 35.0), (40.0, 45.0)]
        telemetry = PerformanceTelemetry(run_id="shot-cache")
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"source")
            cache = Path(directory) / "shot-cache"
            with patch(
                "shorts_generator.local.visual_features._source_sha256",
                return_value="b" * 64,
            ):
                cold = build_source_shot_index(
                    str(source),
                    intervals,
                    str(cache),
                    runner=fake_runner,
                    max_workers=2,
                    telemetry=telemetry,
                )
                warm = build_source_shot_index(
                    str(source),
                    intervals,
                    str(cache),
                    runner=fake_runner,
                    max_workers=2,
                    telemetry=telemetry,
                )

            temporary_files = list(cache.rglob("*.tmp"))

        self.assertEqual(peak, 2)
        self.assertEqual(calls, 4)
        self.assertEqual(cold["intervals"], warm["intervals"])
        self.assertEqual(
            list(cold["intervals"]),
            ["10.000:15.000", "20.000:25.000", "30.000:35.000", "40.000:45.000"],
        )
        self.assertEqual(temporary_files, [])
        counter = telemetry.finish()["cacheCounters"]["shot_analysis"]
        self.assertEqual(counter["misses"], 4)
        self.assertEqual(counter["hits"], 4)


if __name__ == "__main__":
    unittest.main()
