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
from research.fixture_pack_v2 import (
    assess_capture_data_readiness,
    build_fixture_pack,
    build_fixture_pack_from_captures,
)
from research.historical_replay_integrity_v2 import inspect_historical_replay
from research.offline_test_runner import ExcludingTestLoader, offline_network_boundary
from research.runner_v2 import _compare_evidence, _experiment_id, execute
from shorts_generator.replay_capture import (
    HUMAN_PREVIEW_REJECTION_ARTIFACT_TYPE,
    HUMAN_PREVIEW_REJECTION_LEGACY_VERSION,
    HUMAN_REJECTION_ARTIFACT_TYPE,
    LABEL_ARTIFACT_TYPE,
)


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


def capture_dataset_fixture(*, candidate_hashes=("e" * 64,)):
    return {
        "artifactType": "BudgetFriendlyReplayCaptureDatasetV2",
        "datasetId": "d" * 64,
        "contentHash": "a" * 64,
        "rankingManifestHash": "b" * 64,
        "sourceId": "youtube:negative-fixture",
        "sourceHash": "c" * 64,
        "candidates": [
            {"candidate_hash": candidate_hash_value}
            for candidate_hash_value in candidate_hashes
        ],
        "replayTranscriptManifest": {"transcript": transcript()},
        "replayTranscriptManifestHash": "1" * 64,
        "transcriptHash": "2" * 64,
        "transcriptTimingHash": "3" * 64,
        "engineSelectedCandidateHashes": list(candidate_hashes[:1]),
        "engineSelectionSemantics": "unknown_not_human_label",
    }


def capture_approval_fixture(dataset, *, candidate_hash_value="e" * 64):
    return {
        "artifactType": LABEL_ARTIFACT_TYPE,
        "datasetHash": dataset["contentHash"],
        "candidateHash": candidate_hash_value,
        "contentHash": "4" * 64,
    }


def capture_rejection_fixture(
    dataset,
    *,
    candidate_hash_value="e" * 64,
    content_hash_value="5" * 64,
):
    return {
        "artifactType": HUMAN_REJECTION_ARTIFACT_TYPE,
        "datasetHash": dataset["contentHash"],
        "candidateHash": candidate_hash_value,
        "contentHash": content_hash_value,
    }


def capture_preview_rejection_fixture(
    dataset,
    *,
    content_hash_value="6" * 64,
    media_hash="7" * 64,
    start_ms=580920,
    end_ms=603500,
):
    return {
        "artifactType": HUMAN_PREVIEW_REJECTION_ARTIFACT_TYPE,
        "rejectionVersion": HUMAN_PREVIEW_REJECTION_LEGACY_VERSION,
        "datasetHash": dataset["contentHash"],
        "contentHash": content_hash_value,
        "sourceIntervalMs": {"startMs": start_ms, "endMs": end_ms},
        "reviewMedia": {
            "sha256": media_hash,
            "byteLength": 13,
            "durationMs": end_ms - start_ms,
            "container": "mp4",
        },
    }


def write_capture_fixture(
    capture_dir,
    dataset,
    approvals=(),
    rejections=(),
    preview_rejections=(),
):
    dataset_dir = capture_dir / "datasets"
    dataset_dir.mkdir(parents=True)
    (dataset_dir / "dataset.json").write_text(
        json.dumps(dataset),
        encoding="utf-8",
    )
    for index, approval in enumerate(approvals):
        path = capture_dir / "labels" / dataset["rankingManifestHash"]
        path.mkdir(parents=True, exist_ok=True)
        (path / f"approval-{index}.json").write_text(
            json.dumps(approval),
            encoding="utf-8",
        )
    for index, rejection in enumerate(rejections):
        path = capture_dir / "negative-labels" / dataset["rankingManifestHash"]
        path.mkdir(parents=True, exist_ok=True)
        (path / f"rejection-{index}.json").write_text(
            json.dumps(rejection),
            encoding="utf-8",
        )
    for index, rejection in enumerate(preview_rejections):
        path = (
            capture_dir
            / "negative-preview-labels"
            / dataset["rankingManifestHash"]
        )
        path.mkdir(parents=True, exist_ok=True)
        (path / f"preview-rejection-{index}.json").write_text(
            json.dumps(rejection),
            encoding="utf-8",
        )
        media = rejection["reviewMedia"]
        media_dir = capture_dir / "review-media"
        media_dir.mkdir(parents=True, exist_ok=True)
        (media_dir / f"{media['sha256']}.{media['container']}").write_bytes(
            b"preview-bytes"
        )


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

    def test_negative_only_capture_is_verified_but_never_promotable(self):
        with tempfile.TemporaryDirectory() as directory:
            capture_dir = Path(directory) / "evidence"
            dataset = capture_dataset_fixture()
            rejection = capture_rejection_fixture(dataset)
            write_capture_fixture(
                capture_dir,
                dataset,
                rejections=[rejection],
            )
            with patch(
                "research.fixture_pack_v2.verify_replay_capture_dataset",
                side_effect=lambda artifact: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_human_rejection",
                side_effect=lambda artifact, matching_dataset: artifact,
            ) as rejection_verifier:
                report = assess_capture_data_readiness(
                    capture_dir,
                    contract("unused.json"),
                )

        rejection_verifier.assert_called_once()
        self.assertEqual(
            rejection_verifier.call_args.args[1]["contentHash"],
            dataset["contentHash"],
        )
        self.assertEqual(report["datasetArtifactCount"], 1)
        self.assertEqual(report["labelArtifactCount"], 0)
        self.assertEqual(report["negativeLabelArtifactCount"], 1)
        self.assertEqual(report["explicitHumanRejectionCount"], 1)
        self.assertEqual(report["rejectedCandidateCount"], 1)
        self.assertEqual(report["approvalEventCount"], 0)
        self.assertEqual(report["humanPositiveCount"], 0)
        self.assertEqual(report["sourceCount"], 0)
        self.assertEqual(report["candidateCount"], 0)
        self.assertEqual(report["promotableDatasetCount"], 0)
        self.assertEqual(report["skippedOrphanDatasetCount"], 1)
        self.assertFalse(report["replayable"])
        self.assertFalse(report["activationReady"])
        verify_local_seal(
            report,
            "BudgetFriendlyAutoresearchCaptureReadiness",
        )

    def test_preview_rejection_is_verified_but_never_changes_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            capture_dir = Path(directory) / "evidence"
            dataset = capture_dataset_fixture()
            rejection = capture_preview_rejection_fixture(dataset)
            write_capture_fixture(
                capture_dir,
                dataset,
                preview_rejections=[rejection],
            )
            with patch(
                "research.fixture_pack_v2.verify_replay_capture_dataset",
                side_effect=lambda artifact: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_human_preview_rejection",
                side_effect=lambda artifact, matching_dataset, **kwargs: artifact,
            ) as preview_verifier:
                report = assess_capture_data_readiness(
                    capture_dir,
                    contract("unused.json"),
                )

        preview_verifier.assert_called_once()
        self.assertEqual(
            preview_verifier.call_args.args[0]["rejectionVersion"],
            HUMAN_PREVIEW_REJECTION_LEGACY_VERSION,
        )
        self.assertEqual(
            preview_verifier.call_args.args[1]["contentHash"],
            dataset["contentHash"],
        )
        self.assertEqual(
            preview_verifier.call_args.kwargs["review_media_path"].name,
            f"{'7' * 64}.mp4",
        )
        self.assertEqual(report["datasetArtifactCount"], 1)
        self.assertEqual(report["negativeLabelArtifactCount"], 0)
        self.assertEqual(report["negativePreviewArtifactCount"], 1)
        self.assertEqual(report["explicitHumanRejectionCount"], 0)
        self.assertEqual(report["rejectedCandidateCount"], 0)
        self.assertEqual(report["explicitHumanPreviewRejectionCount"], 1)
        self.assertEqual(report["rejectedSourceIntervalCount"], 1)
        self.assertEqual(report["approvalEventCount"], 0)
        self.assertEqual(report["humanPositiveCount"], 0)
        self.assertEqual(report["sourceCount"], 0)
        self.assertEqual(report["candidateCount"], 0)
        self.assertEqual(report["promotableDatasetCount"], 0)
        self.assertEqual(report["skippedOrphanDatasetCount"], 1)
        self.assertFalse(report["replayable"])
        self.assertFalse(report["activationReady"])
        verify_local_seal(
            report,
            "BudgetFriendlyAutoresearchCaptureReadiness",
        )

    def test_preview_rejection_diagnostics_do_not_change_positive_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            capture_dir = Path(directory) / "evidence"
            dataset = capture_dataset_fixture()
            approval = capture_approval_fixture(dataset)
            rejection = capture_preview_rejection_fixture(dataset)
            write_capture_fixture(
                capture_dir,
                dataset,
                approvals=[approval],
                preview_rejections=[rejection],
            )
            with patch(
                "research.fixture_pack_v2.verify_replay_capture_dataset",
                side_effect=lambda artifact: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_capture_label",
                side_effect=lambda artifact, matching_dataset: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_human_preview_rejection",
                side_effect=lambda artifact, matching_dataset, **kwargs: artifact,
            ):
                report = assess_capture_data_readiness(
                    capture_dir,
                    contract("unused.json"),
                )

        self.assertEqual(report["sourceCount"], 1)
        self.assertEqual(report["candidateCount"], 1)
        self.assertEqual(report["humanPositiveCount"], 1)
        self.assertEqual(report["approvalEventCount"], 1)
        self.assertEqual(report["explicitHumanPreviewRejectionCount"], 1)
        self.assertEqual(report["rejectedSourceIntervalCount"], 1)
        self.assertTrue(report["replayable"])
        self.assertTrue(report["activationReady"])

    def test_preview_rejection_counts_deduplicate_events_and_source_intervals(self):
        with tempfile.TemporaryDirectory() as directory:
            capture_dir = Path(directory) / "evidence"
            dataset = capture_dataset_fixture()
            first = capture_preview_rejection_fixture(dataset)
            duplicate = copy.deepcopy(first)
            repeated_interval = capture_preview_rejection_fixture(
                dataset,
                content_hash_value="8" * 64,
                media_hash="9" * 64,
            )
            write_capture_fixture(
                capture_dir,
                dataset,
                preview_rejections=[first, duplicate, repeated_interval],
            )
            with patch(
                "research.fixture_pack_v2.verify_replay_capture_dataset",
                side_effect=lambda artifact: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_human_preview_rejection",
                side_effect=lambda artifact, matching_dataset, **kwargs: artifact,
            ):
                report = assess_capture_data_readiness(
                    capture_dir,
                    contract("unused.json"),
                )

        self.assertEqual(report["negativePreviewArtifactCount"], 3)
        self.assertEqual(report["explicitHumanPreviewRejectionCount"], 2)
        self.assertEqual(report["rejectedSourceIntervalCount"], 1)
        self.assertEqual(report["sourceCount"], 0)
        self.assertEqual(report["candidateCount"], 0)
        self.assertEqual(report["humanPositiveCount"], 0)
        self.assertFalse(report["replayable"])
        self.assertFalse(report["activationReady"])

    def test_missing_or_tampered_preview_media_fails_preflight_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            capture_dir = Path(directory) / "evidence"
            dataset = capture_dataset_fixture()
            rejection = capture_preview_rejection_fixture(dataset)
            write_capture_fixture(
                capture_dir,
                dataset,
                preview_rejections=[rejection],
            )
            with patch(
                "research.fixture_pack_v2.verify_replay_capture_dataset",
                side_effect=lambda artifact: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_human_preview_rejection",
                side_effect=ValueError("review media bytes do not match"),
            ):
                report = assess_capture_data_readiness(
                    capture_dir,
                    contract("unused.json"),
                )

        self.assertIn("review media bytes do not match", report["integrityError"])
        self.assertEqual(report["explicitHumanPreviewRejectionCount"], 0)
        self.assertEqual(report["rejectedSourceIntervalCount"], 0)
        self.assertEqual(report["humanPositiveCount"], 0)
        self.assertEqual(report["sourceCount"], 0)
        self.assertFalse(report["replayable"])
        self.assertFalse(report["activationReady"])

    def test_rejection_diagnostics_deduplicate_events_and_do_not_change_positives(self):
        with tempfile.TemporaryDirectory() as directory:
            capture_dir = Path(directory) / "evidence"
            dataset = capture_dataset_fixture(
                candidate_hashes=("e" * 64, "f" * 64),
            )
            approval = capture_approval_fixture(dataset)
            first = capture_rejection_fixture(
                dataset,
                candidate_hash_value="f" * 64,
            )
            duplicate = copy.deepcopy(first)
            repeated_candidate = capture_rejection_fixture(
                dataset,
                candidate_hash_value="f" * 64,
                content_hash_value="6" * 64,
            )
            write_capture_fixture(
                capture_dir,
                dataset,
                approvals=[approval],
                rejections=[first, duplicate, repeated_candidate],
            )
            with patch(
                "research.fixture_pack_v2.verify_replay_capture_dataset",
                side_effect=lambda artifact: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_capture_label",
                side_effect=lambda artifact, matching_dataset: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_human_rejection",
                side_effect=lambda artifact, matching_dataset: artifact,
            ):
                report = assess_capture_data_readiness(
                    capture_dir,
                    contract("unused.json"),
                )

        self.assertEqual(report["negativeLabelArtifactCount"], 3)
        self.assertEqual(report["explicitHumanRejectionCount"], 2)
        self.assertEqual(report["rejectedCandidateCount"], 1)
        self.assertEqual(report["labelArtifactCount"], 1)
        self.assertEqual(report["approvalEventCount"], 1)
        self.assertEqual(report["humanPositiveCount"], 1)
        self.assertEqual(report["sourceCount"], 1)
        self.assertEqual(report["candidateCount"], 2)
        self.assertTrue(report["replayable"])
        self.assertTrue(report["activationReady"])

    def test_tampered_human_rejection_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            capture_dir = Path(directory) / "evidence"
            dataset = capture_dataset_fixture()
            approval = capture_approval_fixture(dataset)
            rejection = capture_rejection_fixture(dataset)
            write_capture_fixture(
                capture_dir,
                dataset,
                approvals=[approval],
                rejections=[rejection],
            )
            with patch(
                "research.fixture_pack_v2.verify_replay_capture_dataset",
                side_effect=lambda artifact: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_capture_label",
                side_effect=lambda artifact, matching_dataset: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_human_rejection",
                side_effect=ValueError("contentHash mismatch"),
            ):
                report = assess_capture_data_readiness(
                    capture_dir,
                    contract("unused.json"),
                )

        self.assertIn("contentHash mismatch", report["integrityError"])
        self.assertEqual(report["negativeLabelArtifactCount"], 1)
        self.assertEqual(report["explicitHumanRejectionCount"], 0)
        self.assertEqual(report["rejectedCandidateCount"], 0)
        self.assertEqual(report["approvalEventCount"], 0)
        self.assertEqual(report["humanPositiveCount"], 0)
        self.assertEqual(report["sourceCount"], 0)
        self.assertEqual(report["candidateCount"], 0)
        self.assertFalse(report["replayable"])
        self.assertFalse(report["activationReady"])
        verify_local_seal(
            report,
            "BudgetFriendlyAutoresearchCaptureReadiness",
        )

    def test_same_candidate_approval_and_rejection_fails_preflight_and_pack(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture_dir = root / "evidence"
            dataset = capture_dataset_fixture()
            approval = capture_approval_fixture(dataset)
            rejection = capture_rejection_fixture(dataset)
            write_capture_fixture(
                capture_dir,
                dataset,
                approvals=[approval],
                rejections=[rejection],
            )
            dataset_paths = list((capture_dir / "datasets").glob("*.json"))
            label_paths = list((capture_dir / "labels").glob("*/*.json"))
            negative_paths = list(
                (capture_dir / "negative-labels").glob("*/*.json")
            )

            with patch(
                "research.fixture_pack_v2.verify_replay_capture_dataset",
                side_effect=lambda artifact: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_capture_label",
                side_effect=lambda artifact, matching_dataset: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_human_rejection",
                side_effect=lambda artifact, matching_dataset: artifact,
            ):
                report = assess_capture_data_readiness(
                    capture_dir,
                    contract("unused.json"),
                )

            output_dir = root / "pack"
            with patch(
                "research.fixture_pack_v2.verify_replay_capture_dataset",
                side_effect=lambda artifact: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_capture_label",
                side_effect=lambda artifact, matching_dataset: artifact,
            ), patch(
                "research.fixture_pack_v2.verify_replay_human_rejection",
                side_effect=lambda artifact, matching_dataset: artifact,
            ), self.assertRaisesRegex(
                ValueError,
                "conflicting explicit human approval and rejection",
            ):
                build_fixture_pack_from_captures(
                    root=root,
                    dataset_paths=dataset_paths,
                    label_paths=label_paths,
                    negative_label_paths=negative_paths,
                    output_dir=output_dir,
                    activation_contract=contract("unused.json"),
                )

            self.assertFalse(output_dir.exists())

        self.assertIn(
            "conflicting explicit human approval and rejection",
            report["integrityError"],
        )
        self.assertEqual(report["approvalEventCount"], 0)
        self.assertEqual(report["humanPositiveCount"], 0)
        self.assertEqual(report["explicitHumanRejectionCount"], 0)
        self.assertEqual(report["rejectedCandidateCount"], 0)
        self.assertEqual(report["sourceCount"], 0)
        self.assertEqual(report["candidateCount"], 0)
        self.assertFalse(report["replayable"])
        self.assertFalse(report["activationReady"])
        verify_local_seal(
            report,
            "BudgetFriendlyAutoresearchCaptureReadiness",
        )


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
