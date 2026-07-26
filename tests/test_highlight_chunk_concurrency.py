import json
import os
import re
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from shorts_generator.highlights import (
    IncompleteHighlightBatchError,
    _configured_llm_chunk_workers,
    _discovery_cache_path,
    _repairable_micro_near_misses,
    call_highlight_api,
    chunk_transcript,
    get_highlights,
)
from shorts_generator.performance import PerformanceTelemetry
from shorts_generator.profiles import (
    MOTIVATIONAL_PODCAST,
    MOTIVATIONAL_TENSION_MICRO_V1,
)


class HighlightChunkConcurrencyTests(unittest.TestCase):
    def test_redundant_tiny_trailing_chunk_is_not_emitted(self):
        starts = [10.0, 1150.0, 2290.0, 3430.0, 4570.0, 5710.0, 6845.0]
        transcript = {
            "duration": 6851.0,
            "segments": [
                {
                    "start": start,
                    "end": min(6851.0, start + 2.0),
                    "text": f"segment-{index}",
                }
                for index, start in enumerate(starts)
            ],
        }

        chunks = chunk_transcript(transcript)

        self.assertEqual(
            [chunk["_offset"] for chunk in chunks],
            [0, 1140, 2280, 3420, 4560, 5700],
        )
        self.assertIn("segment-6", chunks[-1]["segments"][-1]["text"])

    @staticmethod
    def _timed_long_transcript():
        starts = [100.0, 300.0, 1300.0, 1600.0, 2500.0, 2800.0, 3500.0]
        token_template = [
            "marker-{index}",
            "pressure",
            "feels",
            "wrong",
            "but",
            "the",
            "truth",
            "means",
            "growth.",
        ]
        return {
            "duration": 3600.0,
            "_provenance": {
                "schema": "youtube-json3-word-offsets-v1",
                "videoId": "timed-test-video",
                "language": "en-orig",
                "sourceSha256": "a" * 64,
            },
            "segments": [
                {
                    "start": start,
                    "end": start + 10.0,
                    "text": (
                        f"marker-{index} pressure feels wrong but the truth "
                        "means growth."
                    ),
                    "words": [
                        {
                            "word": token.format(index=index),
                            "start": start + token_index * (10.0 / 9.0),
                            "end": start + (token_index + 1) * (10.0 / 9.0),
                        }
                        for token_index, token in enumerate(token_template)
                    ],
                }
                for index, start in enumerate(starts)
            ],
        }

    @staticmethod
    def _qualified_candidate(index, start):
        return {
            "title": f"candidate-{index}",
            "speech_start_time": start,
            "speech_end_time": start + 10.0,
            "start_time": start,
            "end_time": start + 10.0,
            "score": 90 - index,
            "has_hook": True,
            "has_complete_ending": True,
            "has_takeaway": True,
            "hook_score": 90,
            "closure_score": 90,
            "takeaway_score": 90,
        }

    @staticmethod
    def _micro_candidate(index, start, *, invalid_takeaway=False):
        item = HighlightChunkConcurrencyTests._qualified_candidate(index, start)
        item.update(
            {
                "title": f"Unique tension {index}",
                "topic": f"distinct-topic-{index}",
                "thesis": (
                    f"orbit{index} cedar{index} quartz{index} ember{index} "
                    f"harbor{index} summit{index}"
                ),
                "hook_sentence": f"marker-{index} pressure feels wrong",
                "hook_payoff_phrase": "pressure feels wrong",
                "final_takeaway_sentence": "the truth means growth.",
                "earliest_complete_takeaway_sentence": (
                    "invented words outside source."
                    if invalid_takeaway
                    else "the truth means growth."
                ),
                "has_development": True,
                "standalone_score": 90,
                "development_score": 90,
                "emotional_conviction_score": 90,
                "quotability_score": 90,
                "title_fit_score": 90,
                "has_semantic_tension": True,
                "has_contrast": True,
                "has_conflict": True,
                "has_reversal": True,
                "semantic_tension_score": 90,
                "contrast_score": 90,
                "conflict_score": 90,
                "reversal_score": 90,
                "listener_payoff_score": 90,
                "self_contained_micro_arc_score": 90,
                "generic_motivation_score": 0,
                "context_dependence_score": 0,
                "reaction_tail_compatibility_score": 70,
                "is_promotional": False,
                "is_outro": False,
                "requires_previous_context": False,
                "contains_attribution_lead_in": False,
                "contains_context_callback": False,
                "second_topic_begins_after_takeaway": False,
            }
        )
        return item

    @staticmethod
    def _strategies(report):
        return [
            stage.get("attributes", {}).get("strategy")
            for stage in report["stages"]
            if stage["name"] == "highlight_discovery_strategy"
        ]

    def test_worker_configuration_is_safe_and_bounded(self):
        with patch.dict(os.environ, {"LOCAL_LLM_CHUNK_WORKERS": "99"}):
            self.assertEqual(_configured_llm_chunk_workers(10), 4)
        with patch.dict(os.environ, {"LOCAL_LLM_CHUNK_WORKERS": "0"}):
            self.assertEqual(_configured_llm_chunk_workers(10), 1)
        with patch.dict(os.environ, {"LOCAL_LLM_CHUNK_WORKERS": "invalid"}):
            self.assertEqual(_configured_llm_chunk_workers(10), 2)
        with patch.dict(os.environ, {"LOCAL_LLM_CHUNK_WORKERS": "4"}):
            self.assertEqual(_configured_llm_chunk_workers(2), 2)

    def test_long_video_chunks_run_concurrently_but_keep_source_order(self):
        transcript = {
            "duration": 3600.0,
            "segments": [
                {"start": 100.0, "end": 110.0, "text": "chunk-0."},
                {"start": 1400.0, "end": 1410.0, "text": "chunk-1."},
                {"start": 2500.0, "end": 2510.0, "text": "chunk-2."},
                {"start": 3500.0, "end": 3510.0, "text": "chunk-3."},
            ],
        }
        lock = threading.Lock()
        second_finished = threading.Event()
        active_calls = 0
        peak_active_calls = 0
        completion_order = []

        def fake_llm(prompt):
            nonlocal active_calls, peak_active_calls
            match = re.search(r"chunk-(\d)", prompt)
            self.assertIsNotNone(match)
            chunk_index = int(match.group(1))
            with lock:
                active_calls += 1
                peak_active_calls = max(peak_active_calls, active_calls)
            try:
                if chunk_index == 0:
                    self.assertTrue(
                        second_finished.wait(timeout=2.0),
                        "the second chunk never ran alongside the first",
                    )
                return json.dumps(
                    {
                        "highlights": [
                            {
                                "title": f"chunk-{chunk_index}",
                                "speech_start_time": 1.0,
                                "speech_end_time": 8.0,
                                "start_time": 1.0,
                                "end_time": 8.0,
                                "score": 80,
                            }
                        ]
                    }
                )
            finally:
                with lock:
                    active_calls -= 1
                    completion_order.append(chunk_index)
                if chunk_index == 1:
                    second_finished.set()

        with patch.dict(os.environ, {"LOCAL_LLM_CHUNK_WORKERS": "2"}):
            result = get_highlights(
                transcript,
                num_clips=1,
                llm_fn=fake_llm,
                profile_override="other",
            )

        self.assertEqual(peak_active_calls, 2)
        self.assertLess(completion_order.index(1), completion_order.index(0))
        self.assertEqual(
            [highlight["title"] for highlight in result["highlights"]],
            ["chunk-0", "chunk-1", "chunk-2", "chunk-3"],
        )

    def test_candidate_cache_records_miss_then_hit_without_changing_payload(self):
        calls = 0

        def fake_llm(_prompt):
            nonlocal calls
            calls += 1
            return json.dumps(
                {
                    "highlights": [
                        {
                            "title": "Cached candidate",
                            "speech_start_time": 1.0,
                            "speech_end_time": 8.0,
                            "start_time": 1.0,
                            "end_time": 8.0,
                            "score": 80,
                        }
                    ]
                }
            )

        telemetry = PerformanceTelemetry(run_id="candidate-cache-test")
        with tempfile.TemporaryDirectory() as cache:
            first = call_highlight_api(
                "[1.0s] A complete point.",
                {"content_type": "other", "density": "high"},
                10.0,
                num_clips=1,
                llm_fn=fake_llm,
                cache_dir=cache,
                telemetry=telemetry,
            )
            second = call_highlight_api(
                "[1.0s] A complete point.",
                {"content_type": "other", "density": "high"},
                10.0,
                num_clips=1,
                llm_fn=fake_llm,
                cache_dir=cache,
                telemetry=telemetry,
            )

        counter = telemetry.finish()["cacheCounters"]["llm_candidates"]
        self.assertEqual(first, second)
        self.assertEqual(calls, 1)
        self.assertEqual(counter["misses"], 1)
        self.assertEqual(counter["hits"], 1)

    def test_final_discovery_cache_skips_all_llm_work_on_warm_run(self):
        transcript = {
            "duration": 12.0,
            "segments": [
                {
                    "start": 1.0,
                    "end": 9.0,
                    "text": "A complete cached point.",
                }
            ],
        }
        calls = 0

        def fake_llm(_prompt):
            nonlocal calls
            calls += 1
            return json.dumps(
                {"highlights": [self._qualified_candidate(0, 1.0)]}
            )

        with tempfile.TemporaryDirectory() as cache:
            first = get_highlights(
                transcript,
                num_clips=1,
                llm_fn=fake_llm,
                profile_override="other",
                cache_dir=cache,
                cache_namespace="test-model",
            )
            telemetry = PerformanceTelemetry(run_id="final-discovery-cache")
            second = get_highlights(
                transcript,
                num_clips=1,
                llm_fn=lambda _prompt: self.fail("warm discovery called the LLM"),
                profile_override="other",
                cache_dir=cache,
                cache_namespace="test-model",
                telemetry=telemetry,
            )

        report = telemetry.finish()
        self.assertEqual(first, second)
        self.assertEqual(calls, 1)
        self.assertEqual(report["cacheCounters"]["highlight_discovery"]["hits"], 1)
        self.assertEqual(self._strategies(report), ["final_cache"])

    def test_cold_long_timed_transcript_uses_one_global_candidate_call(self):
        transcript = self._timed_long_transcript()
        global_starts = [100.0, 300.0, 1300.0, 1600.0, 2500.0, 2800.0]
        calls = []

        def fake_llm(prompt):
            calls.append(prompt)
            self.assertTrue(all(f"marker-{index}" in prompt for index in range(7)))
            return json.dumps(
                {
                    "highlights": [
                        self._qualified_candidate(index, start)
                        for index, start in enumerate(global_starts)
                    ]
                }
            )

        telemetry = PerformanceTelemetry(run_id="global-discovery")
        with tempfile.TemporaryDirectory() as cache:
            result = get_highlights(
                transcript,
                num_clips=3,
                llm_fn=fake_llm,
                profile_override="other",
                cache_dir=cache,
                cache_namespace="test-model",
                telemetry=telemetry,
            )

        report = telemetry.finish()
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(result["highlights"]), 6)
        self.assertEqual(self._strategies(report), ["global"])
        self.assertEqual(
            report["cacheCounters"]["highlight_global_quality"]["hits"],
            1,
        )

    def test_low_diversity_global_falls_back_once_then_caches_final_result(self):
        transcript = self._timed_long_transcript()
        calls = []

        def fake_llm(prompt):
            calls.append(prompt)
            marker_indexes = [
                index for index in range(7) if f"marker-{index}" in prompt
            ]
            if len(marker_indexes) == 7:
                return json.dumps(
                    {"highlights": [self._qualified_candidate(0, 100.0)]}
                )
            first_marker = marker_indexes[0]
            match = re.search(
                rf"\[([0-9.]+)s\]\s+marker-{first_marker}",
                prompt,
            )
            self.assertIsNotNone(match)
            return json.dumps(
                {
                    "highlights": [
                        self._qualified_candidate(first_marker, float(match.group(1)))
                    ]
                }
            )

        with tempfile.TemporaryDirectory() as cache, patch.dict(
            os.environ,
            {"LOCAL_LLM_CHUNK_WORKERS": "1"},
        ):
            first_telemetry = PerformanceTelemetry(run_id="global-fallback")
            first = get_highlights(
                transcript,
                num_clips=3,
                llm_fn=fake_llm,
                profile_override="other",
                cache_dir=cache,
                cache_namespace="test-model",
                telemetry=first_telemetry,
            )
            first_call_count = len(calls)

            warm_telemetry = PerformanceTelemetry(run_id="global-fallback-warm")
            warm = get_highlights(
                transcript,
                num_clips=3,
                llm_fn=lambda _prompt: self.fail("warm fallback repeated LLM work"),
                profile_override="other",
                cache_dir=cache,
                cache_namespace="test-model",
                telemetry=warm_telemetry,
            )

            # A future discovery algorithm invalidates the final entry, but the
            # complete legacy chunk set must still be reused before a global call.
            versioned_telemetry = PerformanceTelemetry(run_id="versioned-discovery")
            with patch(
                "shorts_generator.highlights.DISCOVERY_ALGORITHM_VERSION",
                "timed-long-context-test-next",
            ):
                versioned = get_highlights(
                    transcript,
                    num_clips=3,
                    llm_fn=lambda _prompt: self.fail(
                        "complete chunk caches should prevent a global call"
                    ),
                    profile_override="other",
                    cache_dir=cache,
                    cache_namespace="test-model",
                    telemetry=versioned_telemetry,
                )

        first_report = first_telemetry.finish()
        warm_report = warm_telemetry.finish()
        versioned_report = versioned_telemetry.finish()
        self.assertEqual(first_call_count, 5)  # one global pass + four chunks
        self.assertEqual(first, warm)
        self.assertEqual(first, versioned)
        self.assertEqual(self._strategies(first_report), ["chunks"])
        self.assertEqual(self._strategies(warm_report), ["final_cache"])
        self.assertEqual(self._strategies(versioned_report), ["chunks"])
        self.assertEqual(
            first_report["cacheCounters"]["highlight_global_quality"]["misses"],
            1,
        )
        self.assertEqual(
            versioned_report["cacheCounters"]["llm_candidates"]["hits"],
            5,  # four chunks plus the reusable global candidate set
        )

    def test_micro_global_gate_refines_near_miss_and_reuses_both_raw_caches(self):
        transcript = self._timed_long_transcript()
        global_candidates = [
            self._micro_candidate(0, 100.0),
            self._micro_candidate(2, 1300.0),
            self._micro_candidate(4, 2500.0, invalid_takeaway=True),
        ]
        corrected_candidate = self._micro_candidate(4, 2500.0)
        prompts = []

        def fake_llm(prompt):
            prompts.append(prompt)
            if "Boundary-refinement task" in prompt:
                self.assertIn("marker-4", prompt)
                return json.dumps({"highlights": [corrected_candidate]})
            marker_indexes = [
                index for index in range(7) if f"marker-{index}" in prompt
            ]
            if len(marker_indexes) == 7:
                return json.dumps({"highlights": global_candidates})
            first_marker = marker_indexes[0]
            match = re.search(
                rf"\[([0-9.]+)s\]\s+marker-{first_marker}",
                prompt,
            )
            self.assertIsNotNone(match)
            return json.dumps(
                {
                    "highlights": [
                        self._micro_candidate(
                            first_marker,
                            float(match.group(1)),
                            invalid_takeaway=True,
                        )
                    ]
                }
            )

        with tempfile.TemporaryDirectory() as cache:
            telemetry = PerformanceTelemetry(run_id="micro-refinement")
            first = get_highlights(
                transcript,
                num_clips=3,
                llm_fn=fake_llm,
                profile_override=MOTIVATIONAL_PODCAST,
                cache_dir=cache,
                cache_namespace="test-model",
                selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
                telemetry=telemetry,
            )

            warm_telemetry = PerformanceTelemetry(run_id="micro-refinement-warm")
            warm = get_highlights(
                transcript,
                num_clips=3,
                llm_fn=lambda _prompt: self.fail("final cache repeated LLM work"),
                profile_override=MOTIVATIONAL_PODCAST,
                cache_dir=cache,
                cache_namespace="test-model",
                selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
                telemetry=warm_telemetry,
            )

            versioned_telemetry = PerformanceTelemetry(
                run_id="micro-refinement-versioned"
            )
            with patch(
                "shorts_generator.highlights.DISCOVERY_ALGORITHM_VERSION",
                "timed-long-context-test-v3",
            ):
                versioned = get_highlights(
                    transcript,
                    num_clips=3,
                    llm_fn=lambda _prompt: self.fail(
                        "decision upgrade should reuse raw global/refinement caches"
                    ),
                    profile_override=MOTIVATIONAL_PODCAST,
                    cache_dir=cache,
                    cache_namespace="test-model",
                    selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
                    telemetry=versioned_telemetry,
                )

        report = telemetry.finish()
        warm_report = warm_telemetry.finish()
        versioned_report = versioned_telemetry.finish()
        self.assertEqual(len(prompts), 6)  # global + four chunks + refinement
        self.assertEqual(first, warm)
        self.assertEqual(first, versioned)
        self.assertGreaterEqual(len(first["highlights"]), 3)
        self.assertEqual(self._strategies(report), ["chunks"])
        self.assertEqual(self._strategies(warm_report), ["final_cache"])
        self.assertEqual(self._strategies(versioned_report), ["chunks"])
        self.assertEqual(
            report["cacheCounters"]["highlight_deterministic_quality"]["misses"],
            1,
        )
        self.assertEqual(
            report["cacheCounters"]["highlight_refinement_quality"]["hits"],
            1,
        )
        self.assertEqual(
            versioned_report["cacheCounters"]["llm_candidates"]["hits"],
            5,
        )
        self.assertEqual(
            versioned_report["cacheCounters"]["highlight_refinement"]["hits"],
            1,
        )
        refinement_stage = next(
            stage
            for stage in report["stages"]
            if stage["name"] == "highlight_discovery_refinement"
        )
        self.assertEqual(refinement_stage["attributes"]["strategy"], "refinement")
        self.assertEqual(
            refinement_stage["attributes"]["outcome"],
            "chunk-accepted",
        )

    def test_insufficient_merged_refinement_fails_without_final_cache(self):
        transcript = self._timed_long_transcript()
        global_candidates = [
            self._micro_candidate(0, 100.0),
            self._micro_candidate(2, 1300.0),
            self._micro_candidate(4, 2500.0, invalid_takeaway=True),
        ]
        calls = []

        def fake_llm(prompt):
            calls.append(prompt)
            if "Boundary-refinement task" in prompt:
                return json.dumps({"highlights": []})
            marker_indexes = [
                index for index in range(7) if f"marker-{index}" in prompt
            ]
            if len(marker_indexes) == 7:
                return json.dumps({"highlights": global_candidates})
            first_marker = marker_indexes[0]
            match = re.search(
                rf"\[([0-9.]+)s\]\s+marker-{first_marker}",
                prompt,
            )
            self.assertIsNotNone(match)
            return json.dumps(
                {
                    "highlights": [
                        self._micro_candidate(
                            first_marker,
                            float(match.group(1)),
                            invalid_takeaway=True,
                        )
                    ]
                }
            )

        with tempfile.TemporaryDirectory() as cache, patch.dict(
            os.environ,
            {"LOCAL_LLM_CHUNK_WORKERS": "1"},
        ):
            telemetry = PerformanceTelemetry(run_id="micro-refinement-fallback")
            with self.assertRaises(IncompleteHighlightBatchError):
                get_highlights(
                    transcript,
                    num_clips=3,
                    llm_fn=fake_llm,
                    profile_override=MOTIVATIONAL_PODCAST,
                    cache_dir=cache,
                    cache_namespace="test-model",
                    selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
                    telemetry=telemetry,
                )
            call_count = len(calls)
            final_cache_files = list(
                (Path(cache) / "discovery-v6").glob("*.json")
            )

        report = telemetry.finish()
        self.assertEqual(call_count, 6)  # global + four chunks + one refinement
        self.assertEqual(
            sum("Boundary-refinement task" in prompt for prompt in calls),
            1,
        )
        self.assertEqual(final_cache_files, [])
        self.assertEqual(self._strategies(report), [])
        self.assertEqual(
            report["cacheCounters"]["highlight_refinement_quality"]["misses"],
            1,
        )

    def test_complete_chunk_cache_gets_one_post_chunk_micro_refinement(self):
        transcript = self._timed_long_transcript()
        chunk_candidates = [
            self._micro_candidate(0, 100.0),
            self._micro_candidate(2, 1300.0),
            self._micro_candidate(4, 2500.0, invalid_takeaway=True),
        ]
        corrected_candidate = self._micro_candidate(4, 2500.0)
        prompts = []

        def fake_llm(prompt):
            prompts.append(prompt)
            self.assertIn("Boundary-refinement task", prompt)
            self.assertIn("marker-4", prompt)
            return json.dumps({"highlights": [corrected_candidate]})

        cached_result = ({"highlights": chunk_candidates}, Path("cached.json"))
        with tempfile.TemporaryDirectory() as cache, patch(
            "shorts_generator.highlights.chunk_transcript",
            return_value=[dict(transcript, _offset=0.0)],
        ), patch(
            "shorts_generator.highlights._cached_highlight_request",
            return_value=cached_result,
        ):
            telemetry = PerformanceTelemetry(run_id="post-chunk-refinement")
            result = get_highlights(
                transcript,
                num_clips=3,
                llm_fn=fake_llm,
                profile_override=MOTIVATIONAL_PODCAST,
                cache_dir=cache,
                cache_namespace="test-model",
                selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
                telemetry=telemetry,
            )

        report = telemetry.finish()
        self.assertEqual(len(prompts), 1)
        self.assertGreaterEqual(len(result["highlights"]), 3)
        self.assertEqual(self._strategies(report), ["chunks"])
        self.assertEqual(
            report["cacheCounters"]["highlight_refinement_quality"]["hits"],
            1,
        )
        refinement_stage = next(
            stage
            for stage in report["stages"]
            if stage["name"] == "highlight_discovery_refinement"
        )
        self.assertEqual(
            refinement_stage["attributes"]["outcome"],
            "chunk-accepted",
        )

    def test_long_duration_near_miss_can_be_recut_without_becoming_eligible(self):
        decision = {
            "eligible_count": 1,
            "selected_count": 1,
            "ranked": [
                {
                    "rejected": True,
                    "rejection_reasons": [
                        "duration_over_limit",
                        "micro_duration_over_22s",
                    ],
                    "duration_seconds": 35.0,
                    "final_score": 66.0,
                }
            ],
        }

        near_misses = _repairable_micro_near_misses(decision, num_clips=3)

        self.assertEqual(len(near_misses), 1)

    def test_discovery_cache_key_versions_schema_and_algorithm(self):
        transcript = self._timed_long_transcript()
        baseline, _ = _discovery_cache_path(
            "/tmp/highlight-discovery-test",
            transcript,
            3,
            "other",
            None,
            "test-model",
        )
        with patch(
            "shorts_generator.highlights.DISCOVERY_CACHE_SCHEMA_VERSION",
            999,
        ):
            changed_schema, _ = _discovery_cache_path(
                "/tmp/highlight-discovery-test",
                transcript,
                3,
                "other",
                None,
                "test-model",
            )
        with patch(
            "shorts_generator.highlights.DISCOVERY_ALGORITHM_VERSION",
            "next-algorithm",
        ):
            changed_algorithm, _ = _discovery_cache_path(
                "/tmp/highlight-discovery-test",
                transcript,
                3,
                "other",
                None,
                "test-model",
            )
        self.assertNotEqual(baseline, changed_schema)
        self.assertNotEqual(baseline, changed_algorithm)


if __name__ == "__main__":
    unittest.main()
