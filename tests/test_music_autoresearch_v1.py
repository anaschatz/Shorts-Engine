import copy
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from research.music_autoresearch_v1 import (
    BLOCKED_EXIT_CODE,
    CALIBRATION_NOT_READY,
    CHANGED_AXES,
    DEFAULT_CONTRACT_PATH,
    DEFAULT_CONTROL_PATH,
    assess_music_data_readiness,
    assess_real_outcome_evidence,
    build_baseline_music_autoresearch_run,
    build_music_only_experiment_recipe,
    evaluate_dynamic_music_plan,
    load_music_autoresearch_contract,
    load_observed_music_control,
    main,
    search_dynamic_music_timing_variants,
)
from shorts_generator.artifact_contracts import content_hash, file_sha256
from shorts_generator.dynamic_music import (
    DYNAMIC_MUSIC_PLAN_VERSION,
    build_dynamic_music_plan,
    validate_dynamic_music_plan,
)
from shorts_generator.growth_analytics import build_analytics_snapshot
from shorts_generator.pipeline import build_editorial_render_evidence


def reseal(value):
    body = copy.deepcopy(value)
    body.pop("contentHash", None)
    return {**body, "contentHash": content_hash(body)}


class MusicAutoresearchV1Tests(unittest.TestCase):
    def setUp(self):
        self.contract = load_music_autoresearch_contract()
        self.control = load_observed_music_control()
        planning = self.control["planningInputs"]
        self.plan = build_dynamic_music_plan(
            candidate=planning["candidate"],
            caption_cues=planning["captionCues"],
            duration=planning["durationSeconds"],
            speech_end_seconds=planning["speechEndSeconds"],
            natural_tail_end_seconds=planning["naturalTailEndSeconds"],
        )

    def test_shipped_contract_and_observed_control_are_sealed(self):
        self.assertEqual(
            self.contract["changedAxes"],
            ["musicTreatment"],
        )
        self.assertFalse(self.contract["autoPromotionAllowed"])
        self.assertTrue(self.control["observedControlOnly"])
        self.assertIsNone(self.control["performanceLabel"])

    def test_control_cannot_smuggle_a_performance_label(self):
        tampered = reseal({**self.control, "performanceLabel": "winner"})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "control.json"
            path.write_text(json.dumps(tampered), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "performance label"):
                load_observed_music_control(path)

    def test_contract_cannot_loosen_code_owned_guardrails(self):
        tampered = copy.deepcopy(self.contract)
        tampered["planGuardrails"]["maximumSpeechMeanGain"] = 1.0
        tampered = reseal(tampered)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "contract.json"
            path.write_text(json.dumps(tampered), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "digest is not code-authorized"):
                load_music_autoresearch_contract(path)

    def test_baseline_exposes_short_context_build_instead_of_claiming_quality(self):
        evaluation = evaluate_dynamic_music_plan(self.plan)

        self.assertFalse(evaluation["planGuardrailsPass"])
        self.assertLess(evaluation["metrics"]["contextBuildCoverage"], 0.3)
        self.assertIsNone(evaluation["retentionPrediction"])
        self.assertIsNone(evaluation["viewerOutcomeLabel"])
        self.assertFalse(evaluation["autoPromotionAllowed"])
        self.assertFalse(evaluation["renderBindingPass"])

    def test_offline_search_is_deterministic_and_selects_safe_earlier_build(self):
        before = copy.deepcopy(self.plan)
        first = search_dynamic_music_timing_variants(self.plan)
        second = search_dynamic_music_timing_variants(copy.deepcopy(self.plan))
        selected = first["selectedOfflineProxyCandidate"]

        self.assertEqual(first, second)
        self.assertEqual(self.plan, before)
        self.assertEqual(selected["treatmentId"], "hook_plus_0.08s")
        self.assertTrue(selected["planEvaluation"]["planGuardrailsPass"])
        self.assertGreater(
            selected["planEvaluation"]["metrics"]["contextBuildCoverage"],
            0.98,
        )
        self.assertIsNone(first["winner"])
        self.assertFalse(first["autoPromotionAllowed"])

    def test_fallback_semantic_anchors_fail_closed(self):
        fallback_plan = build_dynamic_music_plan(
            {},
            [],
            duration=10.0,
            speech_end_seconds=9.0,
        )
        evaluation = evaluate_dynamic_music_plan(fallback_plan)
        gate = next(
            gate
            for gate in evaluation["safetyGuardrails"]
            if gate["code"] == "EXACT_SEMANTIC_ANCHORS"
        )

        self.assertFalse(gate["passed"])
        self.assertFalse(evaluation["planGuardrailsPass"])

    def test_excessive_but_continuous_ramp_fails_speech_guardrail(self):
        unsafe = copy.deepcopy(self.plan)
        by_type = {event["type"]: event for event in unsafe["events"]}
        by_type["semantic_build"]["endGain"] = 1.02
        by_type["clarity_pocket"]["startGain"] = 1.02
        by_type["clarity_pocket"]["endGain"] = 0.42
        by_type["stable_emphasis"]["startGain"] = 0.42
        validate_dynamic_music_plan(unsafe)

        evaluation = evaluate_dynamic_music_plan(unsafe)
        gate = next(
            gate
            for gate in evaluation["safetyGuardrails"]
            if gate["code"] == "RAMP_RATE_LIMIT"
        )
        self.assertFalse(gate["passed"])
        self.assertGreater(gate["actual"], gate["expected"])

    def test_exact_v3_render_evidence_is_required_and_bound(self):
        selected = search_dynamic_music_timing_variants(self.plan)[
            "selectedOfflineProxyCandidate"
        ]["plan"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            track = root / "track.mp3"
            track.write_bytes(b"licensed test track")
            asset_hash = file_sha256(str(track))
            assets = [
                {
                    "path": "track.mp3",
                    "role": "licensed_music_reflective",
                    "sha256": asset_hash,
                    "byteLength": track.stat().st_size,
                }
            ]
            evidence = build_editorial_render_evidence(
                {
                    "format_profile": "bf_feed_stop_format_v3",
                    "selection_profile": "bf_feed_stop_v2",
                    "render_profile": "bf_editorial_inset_v3",
                    "layout_profile": "editorial_inset",
                    "grade_profile": "high_contrast_grayscale_v1",
                    "typography_profile": "kinetic_editorial_v1",
                    "dynamic_music_plan": selected,
                    "dynamic_music_applied": True,
                    "music_profile": "reflective",
                    "resolved_music_profile": "reflective",
                    "music_mix_profile": DYNAMIC_MUSIC_PLAN_VERSION,
                    "dynamic_music_asset_receipt": {
                        "assetId": f"sha256:{asset_hash}",
                        "sha256": asset_hash,
                        "byteLength": track.stat().st_size,
                    },
                }
            )

            evaluation = evaluate_dynamic_music_plan(
                selected,
                render_evidence=evidence,
                authorized_music_assets=assets,
                asset_root=root,
            )
            self.assertTrue(evaluation["planGuardrailsPass"])
            self.assertTrue(evaluation["renderBindingPass"])
            self.assertTrue(evaluation["eligibleForHumanABPreview"])

            tampered = copy.deepcopy(evidence)
            tampered["music"]["plan"]["events"][0]["endGain"] += 0.01
            rejected = evaluate_dynamic_music_plan(
                selected,
                render_evidence=tampered,
                authorized_music_assets=assets,
                asset_root=root,
            )
            self.assertFalse(rejected["renderBindingPass"])

            track.write_bytes(b"stale bytes")
            stale = evaluate_dynamic_music_plan(
                selected,
                render_evidence=evidence,
                authorized_music_assets=assets,
                asset_root=root,
            )
            self.assertFalse(stale["renderBindingPass"])

    def test_raw_outcomes_are_rejected_and_fixed_axis_proof_fails_closed(self):
        selected = search_dynamic_music_timing_variants(self.plan)[
            "selectedOfflineProxyCandidate"
        ]
        recipe = build_music_only_experiment_recipe(
            self.control,
            selected["planEvaluation"],
        )
        snapshots = []
        for treatment in ("licensed_low_bed_v1", DYNAMIC_MUSIC_PLAN_VERSION):
            for index in range(3):
                snapshots.append(
                    build_analytics_snapshot(
                        video_id=f"{treatment}-{index}",
                        published_at="2026-01-01T00:00:00Z",
                        observed_at="2026-01-08T00:00:00Z",
                        metrics={
                            "views": 1000,
                            "engagedViews": 400,
                            "stayedToWatchPercent": 40,
                            "averageViewDurationSeconds": 12,
                            "averagePercentageViewed": 85,
                            "likes": 20,
                            "shares": 5,
                            "comments": 3,
                            "subscribersGained": 2,
                        },
                        source="youtube_analytics_api",
                        experiment_id="bf-dynamic-music-v1-calibration",
                        cohort_id=treatment,
                        treatment_id=treatment,
                        pillar="boundaries",
                        duration_seconds=18,
                    )
                )
        readiness = assess_real_outcome_evidence(
            snapshots,
            experiment_recipe=recipe,
            contract=self.contract,
            artifact_root=Path.cwd(),
            control_treatment_id="licensed_low_bed_v1",
            candidate_treatment_id=DYNAMIC_MUSIC_PLAN_VERSION,
        )

        self.assertFalse(readiness["realOutcomeEvidenceReady"])
        self.assertFalse(readiness["fixedAxisRenderProofImplemented"])
        self.assertIn(
            "fixed_axis_render_proof_not_implemented",
            readiness["globalBlockers"],
        )
        self.assertEqual(readiness["acceptedRealSnapshotCount"], 0)
        self.assertIn(
            "outcome_observation_required",
            readiness["rejectedSnapshots"][0]["reasons"],
        )
        self.assertIsNone(readiness["winner"])
        self.assertFalse(readiness["autoPromotionAllowed"])

        manual = copy.deepcopy(snapshots[0])
        manual["source"] = "manual"
        manual = reseal(manual)
        rejected = assess_real_outcome_evidence(
            [manual],
            experiment_recipe=recipe,
            contract=self.contract,
            artifact_root=Path.cwd(),
            control_treatment_id="licensed_low_bed_v1",
            candidate_treatment_id=DYNAMIC_MUSIC_PLAN_VERSION,
        )
        self.assertIn(
            "not_real_analytics_source",
            rejected["rejectedSnapshots"][0]["reasons"],
        )

    def test_asset_inventory_can_be_ready_while_control_binding_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            track = root / "track.mp3"
            reference = root / "reference.m4a"
            control_video = root / "control.mp4"
            track.write_bytes(b"track")
            reference.write_bytes(b"reference")
            control_video.write_bytes(b"control")
            contract = {
                **self.contract,
                "licensedMusicAssets": [
                    {
                        "path": "track.mp3",
                        "role": "licensed_music",
                        "sha256": file_sha256(str(track)),
                        "byteLength": track.stat().st_size,
                    }
                ],
                "styleReferenceMedia": [
                    {
                        "path": "reference.m4a",
                        "role": "style_reference",
                        "sha256": file_sha256(str(reference)),
                        "byteLength": reference.stat().st_size,
                    }
                ],
            }
            control = {
                **self.control,
                "renderArtifact": {
                    "path": "control.mp4",
                    "role": "observed_control",
                    "sha256": file_sha256(str(control_video)),
                    "byteLength": control_video.stat().st_size,
                },
            }
            selected = search_dynamic_music_timing_variants(self.plan)[
                "selectedOfflineProxyCandidate"
            ]
            recipe = build_music_only_experiment_recipe(
                control,
                selected["planEvaluation"],
            )
            readiness = assess_music_data_readiness(
                root,
                contract,
                control,
                experiment_recipe=recipe,
            )

        self.assertTrue(readiness["licensedAssetsReady"])
        self.assertTrue(readiness["referenceMediaAvailable"])
        self.assertFalse(readiness["observedControlReady"])
        self.assertFalse(readiness["calibrationReady"])
        self.assertIn(
            "observed_control_render_unavailable_or_stale",
            readiness["blockers"],
        )

    def test_recipe_changes_exactly_music_and_never_promotes(self):
        selected = search_dynamic_music_timing_variants(self.plan)[
            "selectedOfflineProxyCandidate"
        ]
        recipe = build_music_only_experiment_recipe(
            self.control,
            selected["planEvaluation"],
        )

        self.assertEqual(recipe["changedAxes"], CHANGED_AXES)
        self.assertEqual(recipe["decisionState"], CALIBRATION_NOT_READY)
        self.assertTrue(recipe["humanDecisionRequired"])
        self.assertFalse(recipe["autoPromotionAllowed"])
        self.assertIsNone(recipe["control"]["retentionClaim"])

    def test_full_baseline_run_is_offline_and_non_promoting(self):
        run = build_baseline_music_autoresearch_run(
            Path.cwd(),
            self.contract,
            self.control,
        )

        self.assertTrue(run["planDeterministic"])
        self.assertEqual(run["finalStatus"], CALIBRATION_NOT_READY)
        self.assertEqual(
            run["experimentRecipe"]["changedAxes"],
            ["musicTreatment"],
        )
        self.assertEqual(run["networkCalls"], 0)
        self.assertEqual(run["renders"], 0)
        self.assertEqual(run["uploads"], 0)
        self.assertFalse(run["autoPromotionAllowed"])
        self.assertEqual(run["lifecycle"]["state"], "blocked")
        self.assertEqual(
            run["inputAndCodeBindings"]["contractHash"],
            self.contract["contentHash"],
        )
        self.assertEqual(
            run["inputAndCodeBindings"]["controlHash"],
            self.control["contentHash"],
        )
        self.assertRegex(
            run["inputAndCodeBindings"]["evaluatorCodeSha256"],
            r"^[0-9a-f]{64}$",
        )

    def test_cli_emits_sealed_report_without_writes(self):
        output = StringIO()
        with redirect_stdout(output):
            return_code = main(
                [
                    "--root",
                    str(Path.cwd()),
                    "--contract",
                    str(DEFAULT_CONTRACT_PATH),
                    "--control",
                    str(DEFAULT_CONTROL_PATH),
                    "--compact",
                ]
            )
        report = json.loads(output.getvalue())

        self.assertEqual(return_code, BLOCKED_EXIT_CODE)
        self.assertEqual(report["contentHash"], content_hash(report))
        self.assertEqual(report["finalStatus"], CALIBRATION_NOT_READY)

    def test_cli_output_is_atomic_and_matches_stdout_report(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "nested" / "baseline.json"
            output = StringIO()
            with redirect_stdout(output):
                return_code = main(
                    [
                        "--root",
                        str(Path.cwd()),
                        "--output",
                        str(target),
                        "--compact",
                    ]
                )
            stdout_report = json.loads(output.getvalue())
            stored_report = json.loads(target.read_text(encoding="utf-8"))
            leftovers = list(target.parent.glob(".*.tmp"))

        self.assertEqual(return_code, BLOCKED_EXIT_CODE)
        self.assertEqual(stored_report, stdout_report)
        self.assertEqual(leftovers, [])

    def test_direct_script_cli_works_outside_repo_current_directory(self):
        script = Path(__file__).resolve().parents[1] / "research" / (
            "music_autoresearch_v1.py"
        )
        with tempfile.TemporaryDirectory() as directory:
            process = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "--root",
                    str(Path.cwd()),
                    "--compact",
                ],
                cwd=directory,
                capture_output=True,
                text=True,
                check=False,
                timeout=30,
            )

        self.assertEqual(process.returncode, BLOCKED_EXIT_CODE, process.stderr)
        report = json.loads(process.stdout)
        self.assertEqual(report["artifactType"], "DynamicMusicAutoresearchRun")
        self.assertEqual(report["finalStatus"], CALIBRATION_NOT_READY)


if __name__ == "__main__":
    unittest.main()
