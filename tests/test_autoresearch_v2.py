import copy
import json
import os
import socket
import subprocess
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from research.autoresearch_v2 import (
    ReplayDataUnavailable,
    assess_replay_data_readiness,
    classify_source_changes,
    evaluate_budget_friendly_selection,
    load_autoresearch_contract,
    verify_local_seal,
    workspace_source_fingerprints,
    _offline_evaluation_boundary,
)
from research.fixture_pack_v2 import build_fixture_pack
from research.historical_replay_integrity_v2 import inspect_historical_replay
from research.offline_test_runner import ExcludingTestLoader, offline_network_boundary
from research.runner_v2 import _compare_evidence, _experiment_id, execute


ROOT = Path(__file__).resolve().parents[1]


def transcript():
    tokens = [
        "Pressure",
        "creates",
        "bad",
        "decisions.",
        "Small",
        "steps",
        "protect",
        "your",
        "discipline.",
        "That",
        "is",
        "how",
        "consistency",
        "becomes",
        "sustainable.",
    ]
    words = [
        {
            "start": round(index * 1.05, 3),
            "end": round((index + 1) * 1.05, 3),
            "word": token,
        }
        for index, token in enumerate(tokens)
    ]
    return {
        "duration": 18.0,
        "segments": [
            {
                "start": 0.0,
                "end": 15.75,
                "text": " ".join(tokens),
                "words": words,
            }
        ],
    }


def candidate(title="Human choice", selected=True):
    return {
        "title": title,
        "topic": title,
        "start_time": 0.0,
        "end_time": 15.75,
        "speech_start_time": 0.0,
        "speech_end_time": 15.75,
        "score": 92,
        "hook_sentence": "Pressure creates bad decisions.",
        "hook_payoff_phrase": "Pressure creates bad decisions",
        "earliest_complete_takeaway_sentence": (
            "That is how consistency becomes sustainable."
        ),
        "semantic_closure_sentence": (
            "That is how consistency becomes sustainable."
        ),
        "has_hook": True,
        "hook_score": 92,
        "has_complete_ending": True,
        "has_takeaway": True,
        "takeaway_score": 92,
        "listener_payoff_score": 92,
        "self_contained_micro_arc_score": 92,
        "closure_score": 92,
        "has_semantic_tension": True,
        "semantic_tension_score": 92,
        "generic_motivation_score": 5,
        "context_dependence_score": 5,
        "stop_scroll_score": 92,
        "selected_for_render": selected,
        "rejected": False,
    }


def contract(manifest_path):
    base = json.loads(
        (ROOT / "research/autoresearch-v2-contract.json").read_text(encoding="utf-8")
    )
    base["replayManifest"] = str(manifest_path)
    base["dataReadinessGates"] = {
        "minimumSources": 1,
        "minimumCandidates": 1,
        "minimumHumanPositives": 1,
        "minimumPositiveLabelMatchCoverage": 1.0,
    }
    base["keepRules"].update(
        {
            "minimumClosurePositivePassCount": 1,
            "minimumTopKKnownPositiveHitCount": 1,
            "minimumTopKFilledSlotCount": 1,
            "minimumSourceSuccessAtKCount": 1,
            "minimumKnownPositiveHitRateAmongSelected": 0.0,
        }
    )
    return base


def write_source_fixture(root):
    artifact = root / "source.json"
    artifact.write_text(
        json.dumps({"candidates": [candidate()], "transcript": transcript()}),
        encoding="utf-8",
    )
    manifest = {
        "datasets": [
            {
                "id": "fixture",
                "source_id": "source-id",
                "candidate_path": "source.json",
                "candidate_key": "candidates",
                "transcript_path": "source.json",
                "transcript_key": "transcript",
                "positive_path": "source.json",
                "positive_key": "candidates",
            }
        ]
    }
    manifest_path = root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return manifest, manifest_path


class AutoresearchEvaluationV2Tests(unittest.TestCase):
    def test_real_contract_is_versioned_semantic_closure_only(self):
        value = load_autoresearch_contract()
        self.assertEqual(value["contractVersion"], "bf-autoresearch-v2.0.0")
        self.assertEqual(value["evaluationLane"], "semantic_closure")
        self.assertNotIn("shorts_generator/local/llm.py", value["editableScope"])
        self.assertNotIn("shorts_generator/hook_gate_v3.py", value["editableScope"])
        self.assertEqual(
            value["offlineExcludedTestModules"], ["test_youtube_publish"]
        )

    def test_missing_replay_data_fails_closed_with_sealed_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "datasets": [
                            {
                                "id": "missing",
                                "candidate_path": "gone.json",
                                "transcript_path": "gone.json",
                                "positive_path": "gone.json",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            value = contract("manifest.json")
            readiness = assess_replay_data_readiness(root, value)
            self.assertFalse(readiness["replayable"])
            self.assertEqual(readiness["missingArtifactCount"], 1)
            verify_local_seal(
                readiness, "BudgetFriendlyAutoresearchDataReadiness"
            )
            with self.assertRaises(ReplayDataUnavailable):
                evaluate_budget_friendly_selection(root, value)

    def test_synthetic_replay_evaluation_is_deterministic_and_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, manifest_path = write_source_fixture(root)
            value = contract(manifest_path.name)
            first = evaluate_budget_friendly_selection(root, value)
            second = evaluate_budget_friendly_selection(root, value)
        self.assertEqual(first, second)
        self.assertTrue(first["hardGuardrailsPass"])
        self.assertEqual(first["counts"]["closurePositivePassCount"], 1)
        self.assertEqual(first["counts"]["topKKnownPositiveHitCount"], 1)
        self.assertEqual(first["rawComponents"]["macroNdcgAtK"], 1.0)
        self.assertEqual(first["networkCalls"], 0)
        self.assertEqual(first["renders"], 0)
        verify_local_seal(first, "BudgetFriendlyAutoresearchEvaluation")

    def test_real_evaluation_entry_verifies_v2_pack_indexes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_manifest, _ = write_source_fixture(root)
            build_fixture_pack(
                root=root,
                source_manifest=source_manifest,
                output_dir=root / "pack",
            )
            corpus_path = root / "pack/corpus.json"
            corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
            corpus["datasetCount"] = 2
            corpus_path.write_text(json.dumps(corpus), encoding="utf-8")

            readiness = assess_replay_data_readiness(
                root,
                contract("pack/manifest.json"),
            )
            self.assertFalse(readiness["replayable"])
            self.assertIn("seal is invalid", readiness["integrityError"])
            verify_local_seal(
                readiness,
                "BudgetFriendlyAutoresearchDataReadiness",
            )

            with self.assertRaises(ReplayDataUnavailable) as raised:
                evaluate_budget_friendly_selection(
                    root,
                    contract("pack/manifest.json"),
                )
            self.assertIn("seal is invalid", raised.exception.report["integrityError"])

    def test_offline_boundary_denies_network_subprocess_and_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "forbidden.txt"
            directory_path = Path(directory) / "forbidden-directory"
            with _offline_evaluation_boundary() as activity:
                with self.assertRaisesRegex(RuntimeError, "network and subprocess"):
                    socket.socket()
                with self.assertRaisesRegex(RuntimeError, "network and subprocess"):
                    socket.getaddrinfo("example.com", 443)
                with self.assertRaisesRegex(RuntimeError, "network and subprocess"):
                    subprocess.Popen(["true"])
                with self.assertRaisesRegex(RuntimeError, "read-only"):
                    path.write_text("forbidden", encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "read-only"):
                    os.open(path, os.O_WRONLY | os.O_CREAT)
                with self.assertRaisesRegex(RuntimeError, "read-only"):
                    directory_path.mkdir()
            self.assertFalse(path.exists())
            self.assertFalse(directory_path.exists())
            self.assertEqual(activity["networkAttempts"], 2)
            self.assertEqual(activity["subprocessAttempts"], 1)
            self.assertEqual(activity["writeAttempts"], 3)

    def test_test_lane_network_boundary_denies_dns_and_connect(self):
        with offline_network_boundary() as activity:
            with self.assertRaisesRegex(RuntimeError, "outbound network"):
                socket.getaddrinfo("example.com", 443)
            with socket.socket() as client:
                with self.assertRaisesRegex(RuntimeError, "outbound network"):
                    client.connect(("127.0.0.1", 9))
        self.assertEqual(activity["networkAttempts"], 2)

    def test_offline_loader_excludes_only_declared_manual_module(self):
        blocked = types.ModuleType("test_youtube_publish")
        allowed = types.ModuleType("test_engine_unit")

        class SyntheticTest(unittest.TestCase):
            def test_example(self):
                pass

        blocked.SyntheticTest = SyntheticTest
        allowed.SyntheticTest = SyntheticTest
        loader = ExcludingTestLoader(["test_youtube_publish"])

        self.assertEqual(loader.loadTestsFromModule(blocked).countTestCases(), 0)
        self.assertEqual(loader.loadTestsFromModule(allowed).countTestCases(), 1)

    def test_surviving_historical_report_is_valid_but_not_rerunnable(self):
        historical = json.loads(
            (
                ROOT
                / "research/replay/budget-friendly-growth-v2-replay.json"
            ).read_text(encoding="utf-8")
        )
        integrity = inspect_historical_replay(historical)
        self.assertTrue(integrity["historicalEvidenceValid"])
        self.assertFalse(integrity["rerunnable"])
        self.assertFalse(integrity["engineChangeEvaluationAllowed"])
        self.assertEqual(integrity["counts"]["closurePositivePassCount"], 11)
        self.assertEqual(integrity["counts"]["topKKnownPositiveHitCount"], 7)
        self.assertEqual(integrity["hookGate"]["status"], "not_evaluable")
        verify_local_seal(
            integrity, "BudgetFriendlyHistoricalReplayIntegrityV2"
        )


class FixturePackV2Tests(unittest.TestCase):
    def test_pack_is_self_contained_and_never_infers_negative_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, _ = write_source_fixture(root)
            report = build_fixture_pack(
                root=root,
                source_manifest=manifest,
                output_dir=root / "pack",
            )
            corpus = json.loads((root / "pack/corpus.json").read_text())
            labels = json.loads((root / "pack/labels.json").read_text())
            packed_manifest = json.loads((root / "pack/manifest.json").read_text())
            dataset = json.loads((root / "pack/datasets/fixture.json").read_text())
            dataset_labels = json.loads((root / "pack/labels/fixture.json").read_text())

        self.assertEqual(report["datasetCount"], 1)
        self.assertEqual(report["approvedLabelCount"], 1)
        self.assertEqual(labels["labelSemantics"]["unlisted"], "unknown, never inferred rejected")
        self.assertEqual(dataset_labels["labels"][0]["decision"], "approved")
        self.assertNotIn("rejected", dataset["candidates"][0])
        self.assertNotIn("selected_for_render", dataset["candidates"][0])
        self.assertFalse(
            Path(packed_manifest["datasets"][0]["candidate_path"]).is_absolute()
        )
        self.assertEqual(
            packed_manifest["labelBindingMode"],
            "legacy_interval_v1",
        )
        self.assertEqual(
            packed_manifest["datasets"][0]["label_binding_mode"],
            "legacy_interval_v1",
        )
        verify_local_seal(corpus, "BudgetFriendlyReplayCorpusV2")
        verify_local_seal(labels, "BudgetFriendlyReplayLabelsV2")


class AutoresearchRunnerV2Tests(unittest.TestCase):
    def test_experiment_identity_is_stable_and_hypothesis_sensitive(self):
        fingerprint = {"b.py": "2", "a.py": "1"}
        first = _experiment_id("one hypothesis", fingerprint, "a" * 64)
        second = _experiment_id(" one   hypothesis ", dict(reversed(list(fingerprint.items()))), "a" * 64)
        changed = _experiment_id("different hypothesis", fingerprint, "a" * 64)
        self.assertEqual(first, second)
        self.assertNotEqual(first, changed)

    def test_source_changes_are_classified_fail_closed(self):
        value = {
            "editableScope": ["shorts_generator/ranker.py"],
            "protectedScope": ["research/eval.py"],
        }
        changes = classify_source_changes(
            {
                "shorts_generator/ranker.py": "a",
                "research/eval.py": "a",
                "shorts_generator/pipeline.py": "a",
                "tests/test_ranker.py": "a",
            },
            {
                "shorts_generator/ranker.py": "b",
                "research/eval.py": "b",
                "shorts_generator/pipeline.py": "b",
                "tests/test_ranker.py": "b",
            },
            value,
        )
        self.assertEqual(changes["editable"], ["shorts_generator/ranker.py"])
        self.assertEqual(changes["protected"], ["research/eval.py"])
        self.assertEqual(changes["support"], ["tests/test_ranker.py"])
        self.assertEqual(changes["outOfScope"], ["shorts_generator/pipeline.py"])

    def test_integer_evidence_requires_gain_and_no_candidate_regression(self):
        rules = {
            "keepRules": {
                "minimumClosurePositivePassCount": 11,
                "minimumTopKKnownPositiveHitCount": 7,
                "minimumTopKFilledSlotCount": 9,
                "minimumSourceSuccessAtKCount": 4,
                "minimumKnownPositiveHitRateAmongSelected": 0.6,
                "minimumAdditionalKnownPositiveCount": 1,
            }
        }
        reference = {
            "counts": {
                "closurePositivePassCount": 11,
                "topKKnownPositiveHitCount": 7,
                "topKFilledSlotCount": 9,
                "sourceSuccessAtKCount": 4,
            },
            "approvedCandidateOutcomes": [
                {"replayId": "approved-a", "closurePassed": True}
            ],
        }
        current = {
            "counts": {
                "closurePositivePassCount": 12,
                "topKKnownPositiveHitCount": 7,
                "topKFilledSlotCount": 9,
                "sourceSuccessAtKCount": 4,
            },
            "rawComponents": {"knownPositiveHitRateAmongSelected": 0.7},
            "approvedCandidateOutcomes": [
                {"replayId": "approved-a", "closurePassed": True}
            ],
        }
        comparison = _compare_evidence(reference, current, rules)
        self.assertTrue(comparison["improved"])
        self.assertTrue(comparison["eligibleForFullTests"])
        regressed = copy.deepcopy(current)
        regressed["approvedCandidateOutcomes"][0]["closurePassed"] = False
        comparison = _compare_evidence(reference, regressed, rules)
        self.assertFalse(comparison["eligibleForFullTests"])

    def test_runner_records_missing_data_without_running_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with patch(
                "research.runner_v2.workspace_source_fingerprints",
                return_value={"fixture": "sealed"},
            ), patch(
                "research.runner_v2.git_workspace_state",
                return_value={"head": None, "trackedDirty": None},
            ):
                report = execute(
                    root=ROOT,
                    contract_path=ROOT / "research/autoresearch-v2-contract.json",
                    output_dir=output,
                    baseline=True,
                    hypothesis="",
                )
        self.assertEqual(report["status"], "crash")
        self.assertEqual(report["reason"], "replay_artifacts_missing")
        self.assertIsNone(report["testLanes"]["fast"])
        self.assertGreater(report["dataReadiness"]["missingArtifactCount"], 0)
        verify_local_seal(report, "BudgetFriendlyAutoresearchRunV2")

    def test_runner_distinguishes_invalid_replay_integrity_from_missing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            invalid = {
                "replayable": False,
                "integrityError": "ValueError: replay pack seal is invalid",
                "missingArtifactCount": 0,
            }
            with patch(
                "research.runner_v2.assess_replay_data_readiness",
                return_value=invalid,
            ), patch(
                "research.runner_v2.workspace_source_fingerprints",
                return_value={"fixture": "sealed"},
            ), patch(
                "research.runner_v2.git_workspace_state",
                return_value={"head": None, "trackedDirty": None},
            ):
                report = execute(
                    root=ROOT,
                    contract_path=ROOT / "research/autoresearch-v2-contract.json",
                    output_dir=output,
                    baseline=True,
                    hypothesis="",
                )

        self.assertEqual(report["status"], "crash")
        self.assertEqual(report["reason"], "replay_integrity_invalid")
        self.assertIsNone(report["testLanes"]["fast"])

    def test_workspace_fingerprint_is_content_based(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "shorts_generator").mkdir()
            file = root / "shorts_generator/ranker.py"
            file.write_text("a", encoding="utf-8")
            value = {
                "editableScope": ["shorts_generator/ranker.py"],
                "protectedScope": ["research/eval.py"],
            }
            first = workspace_source_fingerprints(root, value)
            file.write_text("b", encoding="utf-8")
            second = workspace_source_fingerprints(root, value)
        self.assertNotEqual(
            first["shorts_generator/ranker.py"],
            second["shorts_generator/ranker.py"],
        )
        self.assertEqual(second["research/eval.py"], "missing")

    def test_workspace_fingerprint_observes_undeclared_engine_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "shorts_generator").mkdir()
            (root / "shorts_generator/ranker.py").write_text(
                "ranker", encoding="utf-8"
            )
            pipeline = root / "shorts_generator/pipeline.py"
            pipeline.write_text("first", encoding="utf-8")
            value = {
                "editableScope": ["shorts_generator/ranker.py"],
                "protectedScope": ["research/eval.py"],
            }
            first = workspace_source_fingerprints(root, value)
            pipeline.write_text("second-and-different-size", encoding="utf-8")
            second = workspace_source_fingerprints(root, value)

        self.assertIn("shorts_generator/pipeline.py", first)
        changes = classify_source_changes(first, second, value)
        self.assertEqual(
            changes["outOfScope"], ["shorts_generator/pipeline.py"]
        )


if __name__ == "__main__":
    unittest.main()
