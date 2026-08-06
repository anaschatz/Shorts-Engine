import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from shorts_generator.artifact_contracts import (
    build_candidate_decision,
    build_replay_transcript_manifest,
    candidate_hash,
)
from shorts_generator.growth_replay import (
    build_growth_replay_report,
    load_replay_dataset,
    verify_replay_pack,
)


def _transcript():
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
    words = []
    for index, token in enumerate(tokens):
        words.append(
            {
                "start": round(index * 1.05, 3),
                "end": round((index + 1) * 1.05, 3),
                "word": token,
            }
        )
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


def _candidate(title, selected=False):
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
        "rejection_reasons": [],
        "content_profile": "motivational_podcast",
        "selection_profile": "motivational_tension_micro_v1",
        "render_profile": "bf_editorial_inset_v1",
        "format_profile": "bf_viral_micro_v1",
        "source_cut_count": 0,
    }


def _canonical_hash(value):
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _seal(payload):
    body = dict(payload)
    body.pop("contentHash", None)
    return {**body, "contentHash": _canonical_hash(body)}


def _write_exact_v2_pack(root):
    pack = root / "pack"
    (pack / "datasets").mkdir(parents=True)
    (pack / "labels").mkdir(parents=True)
    source_hash = "a" * 64
    ranking_hash = "b" * 64
    capture_dataset_hash = "3" * 64
    source_id = "youtube:source-1"
    transcript = _transcript()
    transcript_manifest = build_replay_transcript_manifest(
        transcript,
        source_hash,
    )
    first_body = _candidate("First overlapping candidate")
    second_body = _candidate("Approved overlapping candidate")
    first_body["selection_rank"] = 1
    second_body["selection_rank"] = 2
    first = {
        **first_body,
        "candidate_hash": candidate_hash(first_body, source_hash),
    }
    second = {
        **second_body,
        "candidate_hash": candidate_hash(second_body, source_hash),
    }
    decision = build_candidate_decision(
        second,
        source_hash,
        reviewer="operator_1",
        decided_at="2026-08-06T12:00:00Z",
        ranking_manifest_hash=ranking_hash,
    )
    capture_label = _seal(
        {
            "schemaVersion": 1,
            "artifactType": "BudgetFriendlyReplayCaptureLabelV2",
            "labelVersion": "bf-replay-capture-label-v2.0.0",
            "decision": "approved",
            "labelSemantics": "explicit_human_approval",
            "datasetId": ranking_hash,
            "datasetHash": capture_dataset_hash,
            "rankingManifestHash": ranking_hash,
            "sourceHash": source_hash,
            "candidateHash": second["candidate_hash"],
            "candidateDecisionHash": decision["contentHash"],
            "candidateDecision": decision,
            "approvedRank": 2,
            "reviewer": decision["reviewer"],
            "decidedAt": decision["decidedAt"],
            "notes": decision.get("notes", ""),
        }
    )
    dataset = _seal(
        {
            "schemaVersion": 1,
            "artifactType": "BudgetFriendlyReplayDatasetV2",
            "packVersion": "bf-replay-pack-v2.0.0",
            "datasetId": ranking_hash,
            "sourceId": source_id,
            "candidates": [first, second],
            "transcript": transcript,
            "captureProvenance": {
                "sourceHash": source_hash,
                "rankingManifestHash": ranking_hash,
                "captureDatasetHash": capture_dataset_hash,
                "replayTranscriptManifestHash": transcript_manifest["contentHash"],
                "transcriptHash": transcript_manifest["transcriptHash"],
                "transcriptTimingHash": transcript_manifest["transcriptTimingHash"],
                "engineSelectedCandidateHashes": [],
                "engineSelectionSemantics": "unknown_not_human_label",
            },
        }
    )
    labels = _seal(
        {
            "schemaVersion": 1,
            "artifactType": "BudgetFriendlyReplayDatasetLabelsV2",
            "labelsVersion": "bf-replay-labels-v2.0.0",
            "datasetId": ranking_hash,
            "sourceId": source_id,
            "labelSemantics": "explicit_human_approval",
            "positives": [second],
            "labels": [
                {
                    "labelId": _canonical_hash(
                        [ranking_hash, second["candidate_hash"], "approved"]
                    ),
                    "decision": "approved",
                    "candidateHash": second["candidate_hash"],
                    "candidate": second,
                    "matchScore": 1.0,
                    "matchStatus": "hash_bound",
                    "provenance": {
                        "captureDatasetHash": capture_dataset_hash,
                        "captureLabelHashes": [capture_label["contentHash"]],
                        "captureLabels": [capture_label],
                    },
                }
            ],
        }
    )
    dataset_path = pack / "datasets/dataset-1.json"
    labels_path = pack / "labels/dataset-1.json"
    dataset_path.write_text(json.dumps(dataset), encoding="utf-8")
    labels_path.write_text(json.dumps(labels), encoding="utf-8")
    corpus = _seal(
        {
            "schemaVersion": 1,
            "artifactType": "BudgetFriendlyReplayCorpusV2",
            "corpusVersion": "bf-replay-corpus-v2.0.0",
            "datasetCount": 1,
            "datasets": [
                {
                    "datasetId": ranking_hash,
                    "sourceId": source_id,
                    "candidateCount": 2,
                    "datasetHash": dataset["contentHash"],
                }
            ],
        }
    )
    label_index = _seal(
        {
            "schemaVersion": 1,
            "artifactType": "BudgetFriendlyReplayLabelsV2",
            "labelsVersion": "bf-replay-labels-v2.0.0",
            "datasets": [
                {
                    "datasetId": ranking_hash,
                    "approvedCount": 1,
                    "labelsHash": labels["contentHash"],
                }
            ],
        }
    )
    (pack / "corpus.json").write_text(json.dumps(corpus), encoding="utf-8")
    (pack / "labels.json").write_text(json.dumps(label_index), encoding="utf-8")
    spec = {
        "id": ranking_hash,
        "source_id": source_id,
        "candidate_path": "pack/datasets/dataset-1.json",
        "candidate_key": "candidates",
        "transcript_path": "pack/datasets/dataset-1.json",
        "transcript_key": "transcript",
        "positive_path": "pack/labels/dataset-1.json",
        "positive_key": "positives",
        "positive_all": True,
        "append_unmatched_positives": False,
        "candidate_identity_key": "candidate_hash",
        "label_binding_mode": "candidate_hash_exact_v1",
        "candidate_artifact_hash": dataset["contentHash"],
        "positive_artifact_hash": labels["contentHash"],
    }
    manifest = _seal(
        {
            "schemaVersion": 1,
            "artifactType": "BudgetFriendlyReplayManifestV2",
            "packVersion": "bf-replay-pack-v2.0.0",
            "labelBindingMode": "candidate_hash_exact_v1",
            "corpusHash": corpus["contentHash"],
            "labelsHash": label_index["contentHash"],
            "datasets": [spec],
        }
    )
    manifest_path = pack / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return manifest, manifest_path, spec


class GrowthReplayTests(unittest.TestCase):
    def _write_fixture(self, root, candidates):
        artifact = {
            "candidates": candidates,
            "transcript": _transcript(),
        }
        path = root / "artifact.json"
        path.write_text(json.dumps(artifact), encoding="utf-8")
        return path

    def test_explicit_positive_artifact_filters_to_selected_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self._write_fixture(
                root,
                [
                    _candidate("Human choice", selected=True),
                    _candidate("Not selected"),
                ],
            )
            dataset = load_replay_dataset(
                {
                    "id": "fixture",
                    "candidate_path": str(path),
                    "candidate_key": "candidates",
                    "transcript_path": str(path),
                    "transcript_key": "transcript",
                    "positive_path": str(path),
                    "positive_key": "candidates",
                },
                root,
            )

        positives = [
            item
            for item in dataset["candidates"]
            if item["_replay_human_positive"]
        ]
        self.assertEqual([item["title"] for item in positives], ["Human choice"])

    def test_legacy_replay_never_synthesizes_hook_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self._write_fixture(
                root,
                [_candidate("Human choice", selected=True)],
            )
            manifest = {
                "datasets": [
                    {
                        "id": "fixture",
                        "source_id": "source",
                        "candidate_path": str(path),
                        "candidate_key": "candidates",
                        "transcript_path": str(path),
                        "transcript_key": "transcript",
                        "positive_path": str(path),
                        "positive_key": "candidates",
                    }
                ]
            }
            first = build_growth_replay_report(manifest, root)
            second = build_growth_replay_report(manifest, root)

        self.assertEqual(first["contentHash"], second["contentHash"])
        self.assertEqual(
            first["aggregate"]["hook_prompt_evidence_coverage"],
            0.0,
        )
        self.assertFalse(first["productionApprovalRecommended"])
        self.assertEqual(first["llmCalls"], 0)
        self.assertEqual(first["renders"], 0)
        record = first["datasets"][0]["candidates"][0]
        self.assertFalse(record["hook_gate"]["evidence_complete"])
        self.assertEqual(record["hook_gate"]["status"], "not_evaluable")
        self.assertEqual(
            record["hook_gate"]["reasons"],
            ["legacy_hook_prompt_evidence_missing"],
        )
        self.assertFalse(record["full_v2"]["eligible"])

    def test_positive_artifact_without_labels_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self._write_fixture(
                root,
                [_candidate("Unlabeled candidate")],
            )
            with self.assertRaisesRegex(
                ValueError,
                "no explicit selected positives",
            ):
                load_replay_dataset(
                    {
                        "id": "fixture",
                        "candidate_path": str(path),
                        "candidate_key": "candidates",
                        "transcript_path": str(path),
                        "transcript_key": "transcript",
                        "positive_path": str(path),
                        "positive_key": "candidates",
                    },
                    root,
                )

    def test_shadow_mode_counts_undiscovered_positive_as_false_negative(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate_path = self._write_fixture(
                root,
                [_candidate("Different interval")],
            )
            positive_path = root / "positives.json"
            positive = _candidate("Expected human choice", selected=True)
            positive.update(
                {
                    "start_time": 40.0,
                    "end_time": 56.0,
                    "speech_start_time": 40.0,
                    "speech_end_time": 56.0,
                }
            )
            positive_path.write_text(
                json.dumps({"candidates": [positive]}),
                encoding="utf-8",
            )
            manifest = {
                "datasets": [
                    {
                        "id": "fixture",
                        "source_id": "source",
                        "candidate_path": str(candidate_path),
                        "candidate_key": "candidates",
                        "transcript_path": str(candidate_path),
                        "transcript_key": "transcript",
                        "positive_path": str(positive_path),
                        "positive_key": "candidates",
                        "append_unmatched_positives": False,
                    }
                ]
            }
            report = build_growth_replay_report(manifest, root)

        metrics = report["datasets"][0]["metrics"]
        self.assertEqual(metrics["candidate_count"], 1)
        self.assertEqual(metrics["human_positive_count"], 1)
        self.assertEqual(metrics["human_positive_matched_count"], 0)
        self.assertEqual(metrics["human_positive_unmatched_count"], 1)
        self.assertEqual(metrics["human_positive_match_coverage"], 0.0)
        self.assertEqual(
            report["datasets"][0]["potential_false_negatives"][0]["status"],
            "not_discovered",
        )

    def test_v2_pack_binds_overlapping_positive_by_exact_candidate_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, manifest_path, spec = _write_exact_v2_pack(root)

            verification = verify_replay_pack(
                manifest,
                root,
                manifest_path=manifest_path,
            )
            dataset = load_replay_dataset(spec, root)

        self.assertTrue(verification["verified"])
        self.assertEqual(len(dataset["candidates"]), 2)
        self.assertFalse(dataset["candidates"][0]["_replay_human_positive"])
        self.assertTrue(dataset["candidates"][1]["_replay_human_positive"])
        self.assertEqual(
            dataset["candidates"][1]["_replay_positive_match_kind"],
            "exact_identity",
        )

    def test_v2_pack_requires_and_binds_the_on_disk_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, manifest_path, _ = _write_exact_v2_pack(root)

            with self.assertRaisesRegex(ValueError, "requires manifest_path"):
                verify_replay_pack(manifest, root)

            different = json.loads(json.dumps(manifest))
            different["description"] = "a different sealed manifest"
            manifest_path.write_text(json.dumps(_seal(different)), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "does not match supplied"):
                verify_replay_pack(
                    manifest,
                    root,
                    manifest_path=manifest_path,
                )

    def test_exact_positive_body_must_match_candidate_universe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, manifest_path, _ = _write_exact_v2_pack(root)
            labels_path = root / manifest["datasets"][0]["positive_path"]
            labels = json.loads(labels_path.read_text(encoding="utf-8"))
            labels["positives"][0]["title"] = "Mutated positive body"
            labels = _seal(labels)
            labels_path.write_text(json.dumps(labels), encoding="utf-8")
            manifest["datasets"][0]["positive_artifact_hash"] = labels[
                "contentHash"
            ]

            label_index_path = manifest_path.parent / "labels.json"
            label_index = json.loads(label_index_path.read_text(encoding="utf-8"))
            label_index["datasets"][0]["labelsHash"] = labels["contentHash"]
            label_index = _seal(label_index)
            label_index_path.write_text(json.dumps(label_index), encoding="utf-8")
            manifest["labelsHash"] = label_index["contentHash"]
            manifest = _seal(manifest)
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "body differs"):
                verify_replay_pack(
                    manifest,
                    root,
                    manifest_path=manifest_path,
                )

    def test_exact_positive_requires_explicit_human_approval_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, _, spec = _write_exact_v2_pack(root)
            labels_path = root / spec["positive_path"]
            labels = json.loads(labels_path.read_text(encoding="utf-8"))
            labels["labels"] = []
            labels = _seal(labels)
            labels_path.write_text(json.dumps(labels), encoding="utf-8")
            spec = {
                **spec,
                "positive_artifact_hash": labels["contentHash"],
            }

            with self.assertRaisesRegex(
                ValueError,
                "one detailed approval label each",
            ):
                load_replay_dataset(spec, root)

    def test_exact_dataset_without_a_human_positive_is_not_replayable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, _, spec = _write_exact_v2_pack(root)
            labels_path = root / spec["positive_path"]
            labels = json.loads(labels_path.read_text(encoding="utf-8"))
            labels["positives"] = []
            labels["labels"] = []
            labels = _seal(labels)
            labels_path.write_text(json.dumps(labels), encoding="utf-8")
            spec = {
                **spec,
                "positive_artifact_hash": labels["contentHash"],
            }

            with self.assertRaisesRegex(ValueError, "human-approved positive"):
                load_replay_dataset(spec, root)

    def test_exact_positive_requires_embedded_sealed_capture_event(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, _, spec = _write_exact_v2_pack(root)
            labels_path = root / spec["positive_path"]
            labels = json.loads(labels_path.read_text(encoding="utf-8"))
            labels["labels"][0]["provenance"].pop("captureLabels")
            labels = _seal(labels)
            labels_path.write_text(json.dumps(labels), encoding="utf-8")
            spec = {
                **spec,
                "positive_artifact_hash": labels["contentHash"],
            }

            with self.assertRaisesRegex(ValueError, "event bodies are incomplete"):
                load_replay_dataset(spec, root)

    def test_exact_dataset_recomputes_candidate_identity_from_source_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, _, spec = _write_exact_v2_pack(root)
            dataset_path = root / spec["candidate_path"]
            dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
            dataset["candidates"][0]["title"] = "Forged after capture"
            dataset = _seal(dataset)
            dataset_path.write_text(json.dumps(dataset), encoding="utf-8")
            spec = {
                **spec,
                "candidate_artifact_hash": dataset["contentHash"],
            }

            with self.assertRaisesRegex(ValueError, r"candidate\[0\] hash is stale"):
                load_replay_dataset(spec, root)

    def test_v2_pack_cannot_downgrade_or_omit_exact_binding_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, manifest_path, _ = _write_exact_v2_pack(root)
            downgraded = json.loads(json.dumps(manifest))
            downgraded["artifactType"] = "BudgetFriendlyGrowthReplayManifest"
            downgraded = _seal(downgraded)
            missing_identity = json.loads(json.dumps(manifest))
            missing_identity["datasets"][0].pop("candidate_identity_key")
            missing_identity = _seal(missing_identity)

            with self.assertRaisesRegex(ValueError, "downgraded V2"):
                verify_replay_pack(downgraded, root, manifest_path=manifest_path)
            with self.assertRaisesRegex(ValueError, "candidate_hash identity"):
                verify_replay_pack(
                    missing_identity,
                    root,
                    manifest_path=manifest_path,
                )


if __name__ == "__main__":
    unittest.main()
