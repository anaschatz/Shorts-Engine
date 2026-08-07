import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shorts_generator import config as config_module
from shorts_generator import production_workflow as production_workflow_module
from shorts_generator.artifact_contracts import (
    ArtifactBindingError,
    build_candidate_decision,
    candidate_hash,
    content_hash,
    file_sha256,
)
from shorts_generator.experiment import build_experiment_manifest
from shorts_generator.local import clipper as clipper_module
from shorts_generator.local import visual_features as visual_features_module
from shorts_generator.production_workflow import (
    _prepare_verified_candidate,
    _probe_video_frame_size_ffprobe,
    _real_esrgan_required_for_source,
    _verify_production_job,
    render_approved_candidate,
    render_approved_candidates,
)
from shorts_generator.speech_cleanliness import (
    evaluate_speech_cleanliness_evidence,
)


class ProductionWorkflowTests(unittest.TestCase):
    def test_feed_stop_review_decision_cannot_authorize_production_render(self):
        source_hash = "a" * 64
        candidate_body = {
            "start_time": 0.0,
            "end_time": 12.0,
            "candidate_text": "Approval is a trap choose a standard instead",
            "content_profile": "motivational_podcast",
            "selection_profile": "bf_feed_stop_v1",
            "render_profile": "bf_editorial_inset_v2",
            "format_profile": "bf_feed_stop_format_v1",
            "rejected": False,
            "rejection_reasons": [],
            "source_cut_count": 0,
        }
        report = evaluate_speech_cleanliness_evidence(
            source_hash=source_hash,
            transcript_timing_hash="b" * 64,
            speech_start=0.0,
            speech_end=12.0,
            lexical_fillers=[],
            uncovered_vocalizations=[],
            prompted_fillers=[],
            provider_identity={"provider": "test"},
        )
        candidate_body.update(
            {
                "speechCleanlinessReport": report,
                "speechCleanlinessStatus": report["status"],
                "speechCleanlinessEligible": report["eligible"],
                "speechCleanlinessRejectionReasons": report[
                    "rejectionReasons"
                ],
                "speechCleanlinessReviewReasons": report["reviewReasons"],
                "speech_cleanliness_decision_version": report[
                    "decisionVersion"
                ],
                "speech_cleanliness_status": report["status"],
                "speech_cleanliness_eligible": report["eligible"],
                "speech_cleanliness_reject_reasons": report[
                    "rejectionReasons"
                ],
                "speech_cleanliness_review_reasons": report[
                    "reviewReasons"
                ],
                "speech_cleanliness_deterministic_reasons": report[
                    "deterministicReasons"
                ],
                "speech_cleanliness_provider_status": report[
                    "providerStatus"
                ],
                "speech_cleanliness_lexical_filler_count": report[
                    "lexicalFillerCount"
                ],
                "speech_cleanliness_uncovered_vocalization_count": report[
                    "uncoveredVocalizationCount"
                ],
                "speech_cleanliness_prompted_filler_count": report[
                    "promptedFillerCount"
                ],
            }
        )
        candidate = {
            **candidate_body,
            "candidate_hash": candidate_hash(candidate_body, source_hash),
        }
        decision = build_candidate_decision(
            candidate,
            source_hash,
            reviewer="operator_1",
            decided_at="2026-08-07T12:00:00Z",
            ranking_manifest_hash="d" * 64,
        )
        experiment = build_experiment_manifest(
            experiment_id="feed_stop_review_only",
            cohort_id="contradiction",
            treatment_id="feed_stop_v1",
            candidate_hash=decision["candidateHash"],
            hypothesis="Feed-stop review candidate remains research-only.",
            primary_variable="hook_family",
            pillar="boundaries",
            duration_seconds=12.0,
            declared_at="2026-08-07T12:05:00Z",
            decision_due_at="2026-08-14T12:05:00Z",
        )

        with self.assertRaisesRegex(
            ArtifactBindingError,
            "does not authorize the production profile",
        ):
            _verify_production_job(decision, experiment)

    def test_gpu_scheduling_is_used_only_for_low_resolution_source_panels(self):
        with (
            patch.object(config_module, "LOCAL_REAL_ESRGAN", True),
            patch.object(
                clipper_module,
                "LOCAL_REAL_ESRGAN_BYPASS_HIGH_RES",
                True,
            ),
            patch.object(
                clipper_module,
                "LOCAL_REAL_ESRGAN_MIN_PANEL_COVERAGE",
                0.90,
            ),
            patch.object(
                production_workflow_module,
                "_probe_video_frame_size_ffprobe",
                return_value=(1920, 1080),
            ) as probe,
        ):
            self.assertFalse(_real_esrgan_required_for_source("source.mp4"))
            probe.return_value = (640, 360)
            self.assertTrue(_real_esrgan_required_for_source("source.mp4"))

    def test_ffprobe_source_size_avoids_opencv_startup(self):
        class Result:
            stdout = '{"streams":[{"width":1920,"height":1080}]}'

        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            return Result()

        self.assertEqual(
            _probe_video_frame_size_ffprobe("source.mp4", runner=runner),
            (1920, 1080),
        )
        self.assertEqual(calls[0][0][0], "ffprobe")
        self.assertIn("stream=width,height", calls[0][0])

    def test_prepare_respects_optional_brand_tail_and_preserves_default(self):
        base_candidate = {
            "start_time": 0.0,
            "end_time": 10.75,
            "speech_start_time": 0.0,
            "speech_end_time": 10.3,
        }

        with patch.object(
            production_workflow_module,
            "build_edit_plan",
            return_value={"artifactType": "EditPlan"},
        ), patch.object(
            clipper_module,
            "_build_word_cues",
            return_value=[],
        ) as build_word_cues:
            requested = _prepare_verified_candidate(
                {"segments": []},
                {
                    "candidate": {
                        **base_candidate,
                        "brand_tail_seconds": 0.25,
                    }
                },
                {},
            )
            requested_display_end = build_word_cues.call_args.kwargs["display_end"]

            default = _prepare_verified_candidate(
                {"segments": []},
                {"candidate": base_candidate},
                {},
            )
            default_display_end = build_word_cues.call_args.kwargs["display_end"]

        self.assertAlmostEqual(requested_display_end, 10.3)
        self.assertAlmostEqual(default_display_end, 10.3)
        self.assertAlmostEqual(
            requested["renderCandidate"]["brand_tail_seconds"],
            0.80,
        )
        self.assertAlmostEqual(
            default["renderCandidate"]["brand_tail_seconds"],
            0.85,
        )

    def test_exact_approved_candidate_is_bound_through_render_and_qa(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"source-fixture")
            output = Path(directory) / "short_01.mp4"
            output.write_bytes(b"render-fixture")
            candidate_body = {
                "start_time": 0.0,
                "end_time": 10.75,
                "speech_start_time": 0.0,
                "speech_end_time": 10.3,
                "title": "Nice versus good",
                "hook_sentence": "Nice seeks approval.",
                "final_takeaway_sentence": "Good protects a standard.",
                "source_cut_count": 0,
                "source_scene_change_times": [],
                "content_profile": "motivational_podcast",
                "selection_profile": "motivational_tension_micro_v1",
                "render_profile": "bf_editorial_inset_v1",
                "format_profile": "bf_viral_micro_v1",
                "rejected": False,
                "rejection_reasons": [],
            }
            source_hash = file_sha256(str(source))
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            decision = build_candidate_decision(
                candidate,
                source_hash,
                reviewer="operator_1",
                decided_at="2026-07-16T12:00:00Z",
                ranking_manifest_hash="d" * 64,
            )
            experiment = build_experiment_manifest(
                experiment_id="bf_content_001",
                cohort_id="identity_stakes",
                treatment_id="identity_01",
                candidate_hash=decision["candidateHash"],
                hypothesis="Identity stakes improve stop rate.",
                primary_variable="hook_family",
                pillar="identity_growth",
                duration_seconds=10.75,
                declared_at="2026-07-16T12:05:00Z",
                decision_due_at="2026-08-13T12:05:00Z",
            )
            transcript = {
                "segments": [
                    {
                        "start": 0.0,
                        "end": 10.3,
                        "text": "Nice seeks approval. Good protects a standard.",
                        "words": [
                            {"word": "Nice", "start": 0.0, "end": 0.2},
                            {"word": "seeks", "start": 0.2, "end": 0.4},
                            {"word": "approval.", "start": 0.4, "end": 0.8},
                            {"word": "Good", "start": 8.8, "end": 9.0},
                            {"word": "protects", "start": 9.0, "end": 9.3},
                            {"word": "a", "start": 9.3, "end": 9.4},
                            {"word": "standard.", "start": 9.4, "end": 10.3},
                        ],
                    }
                ]
            }
            short = {
                **candidate,
                "clip_url": str(output),
                "render_profile": "bf_editorial_inset_v1",
                "format_profile": "bf_viral_micro_v1",
                "selection_profile": "motivational_tension_micro_v1",
                "first_visible_text_seconds": 0.0,
                "max_hero_scale": 2.2,
                "brand_tail_profile": "bf_reference_tail_v2",
                "brand_tail_seconds": 1.25,
                "brand_tail_start_seconds": 10.45,
                "semantic_end_seconds": 10.3,
                "natural_tail_seconds": 0.15,
                "transition_tail_seconds": 0.0,
                "freeze_hold_seconds": 0.0,
                "source_content_end_time": 10.45,
                "next_speech_safety_seconds": 0.04,
                "source_speech_leak_guard_passed": True,
                "type_plan_summary": {"hero_count": 2},
                "render_timeline_events": [],
                "artificial_cut_count": 0,
                "artificial_cut_guardrail_pass": True,
            }
            def creative_qa(_path, render_manifest):
                payload = {
                    "schemaVersion": 1,
                    "artifactType": "CreativeQaReport",
                    "renderManifestHash": render_manifest["contentHash"],
                    "passed": True,
                    "gates": [],
                }
                return {**payload, "contentHash": content_hash(payload)}

            audio_payload = {
                "schemaVersion": 1,
                "artifactType": "AudioQaReport",
                "videoPath": str(output.resolve()),
                "outputHash": file_sha256(str(output)),
                "brandTailSeconds": 1.25,
                "measurements": {},
                "gates": [],
                "passed": True,
            }
            audio_qa = {
                **audio_payload,
                "contentHash": content_hash(audio_payload),
            }
            wrong_audio_payload = {**audio_payload, "outputHash": "b" * 64}
            wrong_audio_qa = {
                **wrong_audio_payload,
                "contentHash": content_hash(wrong_audio_payload),
            }
            with patch.object(
                clipper_module,
                "crop_highlights_local",
                return_value=[short],
            ) as renderer, patch.object(
                visual_features_module,
                "analyze_rendered_cut_metrics",
                side_effect=lambda values: values,
            ), patch.object(
                production_workflow_module,
                "_probe_video",
                return_value={
                    "fps": 30.0,
                    "frameCount": 351,
                    "durationSeconds": 11.7,
                    "width": 1080,
                    "height": 1920,
                },
            ), patch.object(
                production_workflow_module,
                "evaluate_editorial_render",
                side_effect=creative_qa,
            ), patch.object(
                production_workflow_module,
                "evaluate_audio_delivery",
                return_value=wrong_audio_qa,
            ) as audio_check, patch.object(
                config_module,
                "LOCAL_RENDER_CACHE",
                True,
            ), patch.object(
                config_module,
                "LOCAL_RENDER_CACHE_DIR",
                str(Path(directory) / "render-cache"),
            ), patch.object(
                config_module,
                "LOCAL_REAL_ESRGAN",
                False,
            ), patch.object(
                clipper_module,
                "_resolve_motivational_music_track",
                return_value=None,
            ):
                with self.assertRaisesRegex(
                    ArtifactBindingError,
                    "audio QA is not bound",
                ):
                    render_approved_candidate(
                        str(source),
                        transcript,
                        decision,
                        experiment,
                        directory,
                    )
                audio_check.return_value = audio_qa
                result = render_approved_candidate(
                    str(source),
                    transcript,
                    decision,
                    experiment,
                    directory,
                )
                cached_result = render_approved_candidate(
                    str(source),
                    transcript,
                    decision,
                    experiment,
                    directory,
                )

        self.assertEqual(
            result["editPlan"]["candidateDecisionHash"],
            decision["contentHash"],
        )
        self.assertEqual(
            result["renderManifest"]["candidateHash"],
            decision["candidateHash"],
        )
        self.assertEqual(result["renderManifest"]["cuts"]["artificialCutCount"], 0)
        self.assertEqual(result["audioQaReport"], audio_qa)
        self.assertTrue(cached_result["short"]["render_cache_hit"])
        self.assertEqual(renderer.call_count, 2)
        self.assertEqual(audio_check.call_count, 3)


class BatchProductionWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.directory = self.temporary_directory.name
        self.render_cache_patch = patch.object(
            config_module,
            "LOCAL_RENDER_CACHE_DIR",
            str(Path(self.directory) / "render-cache"),
        )
        self.render_cache_patch.start()
        self.source = Path(self.directory) / "source.mp4"
        self.source.write_bytes(b"shared-source-fixture")
        self.source_hash = file_sha256(str(self.source))
        self.transcript = {"duration": 80.0, "segments": []}

    def tearDown(self):
        self.render_cache_patch.stop()
        self.temporary_directory.cleanup()

    def _job(self, ordinal):
        start = float(ordinal * 20)
        candidate_body = {
            "start_time": start,
            "end_time": start + 10.75,
            "speech_start_time": start,
            "speech_end_time": start + 10.3,
            "title": f"Candidate {ordinal}",
            "hook_sentence": f"Hook {ordinal}.",
            "final_takeaway_sentence": f"Takeaway {ordinal}.",
            "source_cut_count": 0,
            "source_scene_change_times": [],
            "content_profile": "motivational_podcast",
            "selection_profile": "motivational_tension_micro_v1",
            "render_profile": "bf_editorial_inset_v1",
            "format_profile": "bf_viral_micro_v1",
            "rejected": False,
            "rejection_reasons": [],
        }
        candidate = {
            **candidate_body,
            "candidate_hash": candidate_hash(candidate_body, self.source_hash),
        }
        decision = build_candidate_decision(
            candidate,
            self.source_hash,
            reviewer="operator_1",
            decided_at="2026-07-16T12:00:00Z",
            ranking_manifest_hash="d" * 64,
        )
        experiment = build_experiment_manifest(
            experiment_id=f"bf_batch_{ordinal}",
            cohort_id="identity_stakes",
            treatment_id=f"identity_{ordinal}",
            candidate_hash=decision["candidateHash"],
            hypothesis="Identity stakes improve stop rate.",
            primary_variable="hook_family",
            pillar="identity_growth",
            duration_seconds=10.75,
            declared_at="2026-07-16T12:05:00Z",
            decision_due_at="2026-08-13T12:05:00Z",
        )
        return decision, experiment

    def _transcript_manifest(self, source_hash=None):
        payload = {
            "schemaVersion": 1,
            "artifactType": "TranscriptManifest",
            "sourceHash": source_hash or self.source_hash,
            "transcript": self.transcript,
        }
        return {**payload, "contentHash": content_hash(payload)}

    def test_batch_hashes_source_once_keeps_order_and_isolates_render_failure(self):
        jobs = [self._job(index) for index in range(3)]
        decisions = [job[0] for job in jobs]
        experiments = [job[1] for job in jobs]

        def render_side_effect(
            _source_path,
            resolved_transcript,
            prepared,
            _output_dir,
            **_kwargs,
        ):
            self.assertIs(resolved_transcript, self.transcript)
            decision = prepared["decision"]
            if decision["candidateHash"] == decisions[1]["candidateHash"]:
                raise RuntimeError("synthetic render failure")
            return {"candidateDecision": decision}

        with patch.object(
            production_workflow_module,
            "file_sha256",
            wraps=file_sha256,
        ) as source_hasher, patch.object(
            production_workflow_module,
            "_render_prepared_candidate",
            side_effect=render_side_effect,
        ) as renderer:
            result = render_approved_candidates(
                str(self.source),
                self._transcript_manifest(),
                decisions,
                experiments,
                self.directory,
                max_workers=2,
                serialize_gpu_renders=False,
            )

        source_hasher.assert_called_once_with(str(self.source))
        self.assertEqual(result["succeededCount"], 2)
        self.assertEqual(result["failedCount"], 1)
        self.assertEqual(
            [item["candidateHash"] for item in result["results"]],
            [decision["candidateHash"] for decision in decisions],
        )
        self.assertEqual(
            [item["status"] for item in result["results"]],
            ["succeeded", "failed", "succeeded"],
        )
        self.assertEqual(
            result["results"][1]["error"],
            {
                "type": "RuntimeError",
                "message": "synthetic render failure",
            },
        )
        self.assertEqual(renderer.call_count, 3)
        self.assertEqual(
            sorted(call.kwargs["output_index"] for call in renderer.call_args_list),
            [1, 2, 3],
        )
        self.assertTrue(
            all(call.kwargs["isolate_output"] for call in renderer.call_args_list)
        )

    def test_candidate_bound_to_another_source_fails_without_blocking_batch(self):
        valid_decision, valid_experiment = self._job(0)
        wrong_source_body = {
            key: value
            for key, value in valid_decision.items()
            if key != "contentHash"
        }
        wrong_source_body["sourceHash"] = "b" * 64
        wrong_source_decision = {
            **wrong_source_body,
            "contentHash": content_hash(wrong_source_body),
        }

        with patch.object(
            production_workflow_module,
            "_render_prepared_candidate",
            return_value={"candidateDecision": valid_decision},
        ) as renderer:
            result = render_approved_candidates(
                str(self.source),
                self.transcript,
                [wrong_source_decision, valid_decision],
                [valid_experiment, valid_experiment],
                self.directory,
                serialize_gpu_renders=False,
            )

        self.assertEqual(
            [item["status"] for item in result["results"]],
            ["failed", "succeeded"],
        )
        self.assertIn(
            "source file does not match",
            result["results"][0]["error"]["message"],
        )
        renderer.assert_called_once()

    def test_enhancer_batch_invokes_renderer_once_with_every_valid_highlight(self):
        jobs = [self._job(index) for index in range(3)]
        decisions = [job[0] for job in jobs]
        experiments = [job[1] for job in jobs]

        def crop_side_effect(
            _source_path,
            highlights,
            *,
            out_dir,
            **_kwargs,
        ):
            rendered = []
            for index, candidate in enumerate(highlights, 1):
                output = Path(out_dir) / f"short_{index:02d}.mp4"
                output.write_bytes(candidate["title"].encode("utf-8"))
                rendered.append({**candidate, "clip_url": str(output)})
            return rendered

        def finalize_side_effect(prepared, short):
            return {
                "candidateDecision": prepared["decision"],
                "short": short,
            }

        with patch.object(
            clipper_module,
            "crop_highlights_local",
            side_effect=crop_side_effect,
        ) as renderer, patch.object(
            production_workflow_module,
            "_finalize_rendered_candidate",
            side_effect=finalize_side_effect,
        ) as finalizer:
            result = render_approved_candidates(
                str(self.source),
                self.transcript,
                decisions,
                experiments,
                self.directory,
                max_workers=2,
                serialize_gpu_renders=True,
            )

        renderer.assert_called_once()
        rendered_highlights = renderer.call_args.args[1]
        self.assertEqual(
            [candidate["title"] for candidate in rendered_highlights],
            ["Candidate 0", "Candidate 1", "Candidate 2"],
        )
        self.assertFalse(renderer.call_args.kwargs["_allow_parallel"])
        self.assertEqual(finalizer.call_count, 3)
        self.assertEqual(
            [item["status"] for item in result["results"]],
            ["succeeded", "succeeded", "succeeded"],
        )
        self.assertEqual(
            [
                item["result"]["short"]["clip_url"]
                for item in result["results"]
            ],
            [
                str(Path(self.directory) / "short_01.mp4"),
                str(Path(self.directory) / "short_02.mp4"),
                str(Path(self.directory) / "short_03.mp4"),
            ],
        )

    def test_concurrent_batch_promotes_each_render_to_a_distinct_output_path(self):
        jobs = [self._job(index) for index in range(2)]
        decisions = [job[0] for job in jobs]
        experiments = [job[1] for job in jobs]

        def crop_side_effect(
            _source_path,
            highlights,
            *,
            out_dir,
            **_kwargs,
        ):
            candidate = highlights[0]
            output = Path(out_dir) / "short_01.mp4"
            output.write_bytes(candidate["title"].encode("utf-8"))
            return [
                {
                    **candidate,
                    "clip_url": str(output),
                    "first_visible_text_seconds": 0.0,
                    "max_hero_scale": 2.2,
                    "brand_tail_profile": "bf_reference_tail_v2",
                    "brand_tail_seconds": 1.25,
                    "brand_tail_start_seconds": 10.45,
                    "semantic_end_seconds": 10.3,
                    "natural_tail_seconds": 0.15,
                    "transition_tail_seconds": 0.0,
                    "freeze_hold_seconds": 0.0,
                    "source_content_end_time": 10.45,
                    "next_speech_safety_seconds": 0.04,
                    "source_speech_leak_guard_passed": True,
                    "type_plan_summary": {"hero_count": 2},
                    "render_timeline_events": [],
                    "artificial_cut_count": 0,
                    "artificial_cut_guardrail_pass": True,
                }
            ]

        def creative_qa(_path, render_manifest):
            payload = {
                "schemaVersion": 1,
                "artifactType": "CreativeQaReport",
                "renderManifestHash": render_manifest["contentHash"],
                "passed": True,
                "gates": [],
            }
            return {**payload, "contentHash": content_hash(payload)}

        def audio_qa(path, brand_tail_seconds, brand_tail_profile=None):
            payload = {
                "schemaVersion": 1,
                "artifactType": "AudioQaReport",
                "videoPath": str(Path(path).resolve()),
                "outputHash": file_sha256(path),
                "brandTailSeconds": brand_tail_seconds,
                "brandTailProfile": brand_tail_profile,
                "measurements": {},
                "gates": [],
                "passed": True,
            }
            return {**payload, "contentHash": content_hash(payload)}

        with patch.object(
            clipper_module,
            "crop_highlights_local",
            side_effect=crop_side_effect,
        ), patch.object(
            visual_features_module,
            "analyze_rendered_cut_metrics",
            side_effect=lambda shorts: shorts,
        ), patch.object(
            production_workflow_module,
            "_probe_video",
            return_value={
                "fps": 30.0,
                "frameCount": 351,
                "durationSeconds": 11.7,
                "width": 1080,
                "height": 1920,
            },
        ), patch.object(
            production_workflow_module,
            "evaluate_editorial_render",
            side_effect=creative_qa,
        ), patch.object(
            production_workflow_module,
            "evaluate_audio_delivery",
            side_effect=audio_qa,
        ):
            result = render_approved_candidates(
                str(self.source),
                self.transcript,
                decisions,
                experiments,
                self.directory,
                max_workers=2,
                serialize_gpu_renders=False,
            )

        self.assertEqual(
            [item["status"] for item in result["results"]],
            ["succeeded", "succeeded"],
        )
        output_paths = [
            Path(item["result"]["short"]["clip_url"])
            for item in result["results"]
        ]
        self.assertEqual(
            output_paths,
            [
                Path(self.directory) / "short_01.mp4",
                Path(self.directory) / "short_02.mp4",
            ],
        )
        self.assertEqual(
            [path.read_text(encoding="utf-8") for path in output_paths],
            ["Candidate 0", "Candidate 1"],
        )

    def test_batch_rejects_stale_shared_transcript_before_rendering(self):
        decision, experiment = self._job(0)
        with patch.object(
            production_workflow_module,
            "_prepare_verified_candidate",
        ) as renderer:
            with self.assertRaisesRegex(
                ArtifactBindingError,
                "transcript manifest references another source",
            ):
                render_approved_candidates(
                    str(self.source),
                    self._transcript_manifest("c" * 64),
                    [decision],
                    [experiment],
                    self.directory,
                )
        renderer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
