import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from research.fixture_pack_v2 import (
    _portable_capture_candidate,
    build_fixture_pack_from_captures,
    ingest_capture_artifacts,
)
from shorts_generator import config as config_module
from shorts_generator.artifact_contracts import (
    ArtifactBindingError,
    build_candidate_decision,
    candidate_hash,
    content_hash,
    file_sha256,
    verify_seal,
)
from shorts_generator.growth_replay import load_replay_dataset, verify_replay_pack
from shorts_generator.pipeline import build_ranking_manifest
from shorts_generator.profiles import BF_VIRAL_MICRO_V1, resolve_profile_bundle
from shorts_generator.replay_capture import (
    ENGINE_SELECTION_SEMANTICS,
    HUMAN_LABEL_SEMANTICS,
    archive_approved_candidate,
    build_replay_capture_dataset,
    build_replay_capture_label,
    verify_replay_capture_dataset,
    verify_replay_capture_label,
)


def exact_transcript():
    return {
        "duration": 24.987654321,
        "language": "en",
        "_provenance": {
            "schema": "fixture-exact-words-v1",
            "confidence": 0.987654321,
        },
        "segments": [
            {
                "start": 0.000000123,
                "end": 24.876543219,
                "text": "Pressure creates choices. Boundaries protect peace.",
                "speaker": "speaker-a",
                "words": [
                    {
                        "word": "Pressure",
                        "start": 0.000000123,
                        "end": 1.234567891,
                        "confidence": 0.991234567,
                    },
                    {
                        "word": "creates choices.",
                        "start": 1.345678912,
                        "end": 9.876543219,
                        "confidence": 0.981234567,
                    },
                    {
                        "word": "Boundaries",
                        "start": 11.000000123,
                        "end": 12.345678912,
                        "confidence": 0.971234567,
                    },
                    {
                        "word": "protect peace.",
                        "start": 12.456789123,
                        "end": 21.876543219,
                        "confidence": 0.961234567,
                    },
                ],
            }
        ],
    }


def candidate_body(rank, start, end, title, *, selected=False):
    return {
        "start_time": start,
        "end_time": end,
        "speech_start_time": start,
        "speech_end_time": end,
        "title": title,
        "hook_sentence": f"{title} creates tension.",
        "final_takeaway_sentence": f"{title} protects your peace.",
        "semantic_closure_sentence": f"{title} protects your peace.",
        "candidate_text": f"{title} creates tension and protects your peace.",
        "content_profile": "motivational_podcast",
        "selection_profile": "motivational_tension_micro_v1",
        "render_profile": "bf_editorial_inset_v1",
        "format_profile": "bf_viral_micro_v1",
        "selection_rank": rank,
        "selected_for_render": selected,
        "rejected": False,
        "rejection_reasons": [],
        "source_cut_count": 0,
    }


class ReplayCaptureTests(unittest.TestCase):
    def test_default_evidence_root_is_durable_app_data_not_cache_or_output(self):
        with patch.object(config_module.sys, "platform", "darwin"), patch.object(
            config_module.Path,
            "home",
            return_value=Path("/Users/example"),
        ):
            root = config_module._default_local_data_dir()

        self.assertEqual(
            root,
            Path("/Users/example/Library/Application Support/Shorts-Engine"),
        )
        self.assertNotIn("Caches", root.parts)
        self.assertNotIn("output", root.parts)

        with patch.object(config_module.sys, "platform", "linux"), patch.object(
            config_module.os,
            "name",
            "posix",
        ), patch.object(
            config_module.Path,
            "home",
            return_value=Path("/home/example"),
        ), patch.dict(
            config_module.os.environ,
            {"XDG_DATA_HOME": ""},
        ):
            linux_root = config_module._default_local_data_dir()

        self.assertEqual(
            linux_root,
            Path("/home/example/.local/share/shorts-engine"),
        )

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source.mp4"
        self.source.write_bytes(b"source-bytes")
        self.source_hash = file_sha256(str(self.source))
        first_body = candidate_body(1, 0.1, 10.6, "Pressure", selected=True)
        second_body = candidate_body(2, 11.0, 21.8, "Boundaries")
        first_body["shot_index_cache_path"] = str(
            self.root / "private-cache/shot-index.json"
        )
        first_body["clip_url"] = str(self.root / "output/short_01.mp4")
        self.candidates = [
            {**first_body, "candidate_hash": candidate_hash(first_body, self.source_hash)},
            {**second_body, "candidate_hash": candidate_hash(second_body, self.source_hash)},
        ]
        self.ranking = build_ranking_manifest(
            "https://www.youtube.com/watch?v=fixture123",
            str(self.source),
            "motivational_podcast",
            self.candidates,
            [self.candidates[0]],
            profiles=resolve_profile_bundle(format_profile=BF_VIRAL_MICRO_V1),
            source_hash=self.source_hash,
            transcript=exact_transcript(),
        )

    def tearDown(self):
        self.temp.cleanup()

    def decision(self, index=0, *, reviewer="operator_1", decided_at="2026-08-06T12:00:00Z"):
        return build_candidate_decision(
            self.candidates[index],
            self.source_hash,
            reviewer=reviewer,
            decided_at=decided_at,
            ranking_manifest_hash=self.ranking["contentHash"],
        )

    def test_dataset_preserves_exact_transcript_and_complete_candidate_order(self):
        dataset = build_replay_capture_dataset(self.ranking)

        self.assertEqual(dataset["rankingManifest"], self.ranking)
        self.assertEqual(
            dataset["replayTranscriptManifest"]["transcript"],
            exact_transcript(),
        )
        self.assertEqual(
            [item["candidate_hash"] for item in dataset["candidates"]],
            [item["candidate_hash"] for item in self.candidates],
        )
        self.assertEqual(
            dataset["engineSelectedCandidateHashes"],
            [self.candidates[0]["candidate_hash"]],
        )
        self.assertEqual(
            dataset["engineSelectionSemantics"],
            ENGINE_SELECTION_SEMANTICS,
        )
        self.assertNotIn("local_path", dataset["source"])
        self.assertNotIn(str(self.source), json.dumps(dataset["source"]))
        verify_replay_capture_dataset(dataset)

    def test_resealed_capture_cannot_diverge_from_embedded_ranking_projection(self):
        dataset = build_replay_capture_dataset(self.ranking)
        mutations = {}

        trimmed = json.loads(json.dumps(dataset))
        trimmed["candidates"] = trimmed["candidates"][:1]
        trimmed["candidateBindings"] = trimmed["candidateBindings"][:1]
        mutations["candidates"] = trimmed

        profiles = json.loads(json.dumps(dataset))
        profiles["profiles"] = {"formatProfile": "forged"}
        mutations["profiles"] = profiles

        source = json.loads(json.dumps(dataset))
        source["sourceId"] = "youtube:another-video"
        mutations["sourceId"] = source

        transcript = json.loads(json.dumps(dataset))
        transcript["replayTranscriptManifest"]["transcript"]["language"] = "fr"
        mutations["replayTranscriptManifest"] = transcript

        for field, tampered in mutations.items():
            with self.subTest(field=field):
                tampered["contentHash"] = content_hash(tampered)
                with self.assertRaisesRegex(
                    ArtifactBindingError,
                    f"capture {field} is not exactly derived",
                ):
                    verify_replay_capture_dataset(tampered)

    def test_one_approval_writes_one_positive_and_retry_is_idempotent(self):
        evidence = self.root / "evidence"
        decision = self.decision()
        first = archive_approved_candidate(
            self.ranking,
            decision,
            approved_rank=1,
            evidence_dir=evidence,
        )
        second = archive_approved_candidate(
            self.ranking,
            decision,
            approved_rank=1,
            evidence_dir=evidence,
        )

        dataset_paths = list((evidence / "datasets").glob("*.json"))
        label_paths = list((evidence / "labels").glob("*/*.json"))
        self.assertEqual(len(dataset_paths), 1)
        self.assertEqual(len(label_paths), 1)
        self.assertTrue(first["datasetCreated"])
        self.assertTrue(first["labelCreated"])
        self.assertFalse(second["datasetCreated"])
        self.assertFalse(second["labelCreated"])
        dataset = json.loads(dataset_paths[0].read_text(encoding="utf-8"))
        label = json.loads(label_paths[0].read_text(encoding="utf-8"))
        self.assertEqual(label["labelSemantics"], HUMAN_LABEL_SEMANTICS)
        self.assertEqual(label["candidateHash"], self.candidates[0]["candidate_hash"])
        verify_replay_capture_label(label, dataset)

    def test_two_approvals_reuse_dataset_and_append_two_label_events(self):
        evidence = self.root / "evidence"
        archive_approved_candidate(
            self.ranking,
            self.decision(0),
            approved_rank=1,
            evidence_dir=evidence,
        )
        archive_approved_candidate(
            self.ranking,
            self.decision(
                1,
                reviewer="operator_2",
                decided_at="2026-08-06T12:05:00Z",
            ),
            approved_rank=2,
            evidence_dir=evidence,
        )

        self.assertEqual(len(list((evidence / "datasets").glob("*.json"))), 1)
        self.assertEqual(len(list((evidence / "labels").glob("*/*.json"))), 2)

    def test_capture_rejects_missing_word_timings_before_writing(self):
        ranking = json.loads(json.dumps(self.ranking))
        transcript_manifest = ranking["replayTranscriptManifest"]
        transcript_manifest["transcript"]["segments"][0].pop("words")
        transcript_manifest["transcriptHash"] = content_hash(
            transcript_manifest["transcript"]
        )
        # Rebuilding only the outer seals models a syntactically valid but
        # semantically unusable transcript artifact.
        transcript_manifest["contentHash"] = content_hash(transcript_manifest)
        ranking["contentHash"] = content_hash(ranking)
        evidence = self.root / "evidence"

        with self.assertRaisesRegex(ArtifactBindingError, "exact word timings"):
            build_replay_capture_dataset(ranking)
        self.assertFalse(evidence.exists())

    def test_stale_decision_binding_and_existing_collision_fail_closed(self):
        dataset = build_replay_capture_dataset(self.ranking)
        decision = self.decision()
        stale = {**decision, "rankingManifestHash": "b" * 64}
        stale["contentHash"] = content_hash(stale)
        with self.assertRaisesRegex(ArtifactBindingError, "another ranking"):
            build_replay_capture_label(dataset, stale, approved_rank=1)

        evidence = self.root / "evidence"
        collision = evidence / "datasets" / f"{self.ranking['contentHash']}.json"
        collision.parent.mkdir(parents=True)
        collision.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(ArtifactBindingError, "immutable capture collision"):
            archive_approved_candidate(
                self.ranking,
                decision,
                approved_rank=1,
                evidence_dir=evidence,
            )
        self.assertEqual(list((evidence / "labels").glob("*/*.json")), [])

    def test_immutable_retry_comparison_is_json_type_sensitive(self):
        dataset = build_replay_capture_dataset(self.ranking)
        evidence = self.root / "evidence"
        collision = evidence / "datasets" / f"{self.ranking['contentHash']}.json"
        collision.parent.mkdir(parents=True)
        type_changed = json.loads(json.dumps(dataset))
        type_changed["schemaVersion"] = True
        # Keep the expected hash deliberately: bool/int compare equal in Python,
        # but they are different canonical JSON and must be a collision.
        collision.write_text(json.dumps(type_changed), encoding="utf-8")

        with self.assertRaisesRegex(ArtifactBindingError, "immutable capture collision"):
            archive_approved_candidate(
                self.ranking,
                self.decision(),
                approved_rank=1,
                evidence_dir=evidence,
            )
        self.assertEqual(list((evidence / "labels").glob("*/*.json")), [])

    def test_tampered_dataset_and_label_seals_are_rejected(self):
        dataset = build_replay_capture_dataset(self.ranking)
        label = build_replay_capture_label(
            dataset,
            self.decision(),
            approved_rank=1,
        )
        tampered_dataset = json.loads(json.dumps(dataset))
        tampered_dataset["replayTranscriptManifest"]["transcript"][
            "language"
        ] = "fr"
        with self.assertRaisesRegex(ArtifactBindingError, "contentHash"):
            verify_replay_capture_dataset(tampered_dataset)
        tampered_label = {**label, "approvedRank": 2}
        with self.assertRaisesRegex(ArtifactBindingError, "contentHash"):
            verify_replay_capture_label(tampered_label, dataset)
        self.assertIs(verify_seal(label, label["artifactType"]), label)

    def test_capture_pack_keeps_engine_selection_unknown_and_exact_json(self):
        evidence = self.root / "evidence"
        archive_approved_candidate(
            self.ranking,
            self.decision(1),
            approved_rank=2,
            evidence_dir=evidence,
        )
        dataset_paths = list((evidence / "datasets").glob("*.json"))
        label_paths = list((evidence / "labels").glob("*/*.json"))
        report = build_fixture_pack_from_captures(
            root=self.root,
            dataset_paths=dataset_paths,
            label_paths=label_paths,
            output_dir=self.root / "pack",
        )
        dataset_id = self.ranking["contentHash"]
        packed_dataset = json.loads(
            (self.root / f"pack/datasets/{dataset_id}.json").read_text(
                encoding="utf-8"
            )
        )
        packed_labels = json.loads(
            (self.root / f"pack/labels/{dataset_id}.json").read_text(
                encoding="utf-8"
            )
        )
        manifest_path = self.root / "pack/manifest.json"
        packed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        verification = verify_replay_pack(
            packed_manifest,
            self.root,
            manifest_path=manifest_path,
        )
        replay_dataset = load_replay_dataset(
            packed_manifest["datasets"][0],
            self.root,
        )

        self.assertEqual(report["approvedLabelCount"], 1)
        self.assertTrue(verification["verified"])
        self.assertEqual(report["skippedOrphanDatasetCount"], 0)
        self.assertEqual(packed_dataset["transcript"], exact_transcript())
        self.assertEqual(
            [item["candidate_hash"] for item in packed_dataset["candidates"]],
            [item["candidate_hash"] for item in self.candidates],
        )
        self.assertEqual(
            packed_dataset["candidates"][0]["semantic_closure_sentence"],
            self.candidates[0]["semantic_closure_sentence"],
        )
        self.assertTrue(packed_dataset["candidates"][0]["selected_for_render"])
        self.assertNotIn("shot_index_cache_path", packed_dataset["candidates"][0])
        self.assertNotIn("clip_url", packed_dataset["candidates"][0])
        self.assertNotIn(str(self.root), json.dumps(packed_dataset))
        self.assertEqual(
            [item["candidate_hash"] for item in packed_labels["positives"]],
            [self.candidates[1]["candidate_hash"]],
        )
        self.assertEqual(packed_labels["labels"][0]["matchStatus"], "hash_bound")
        self.assertEqual(packed_labels["labels"][0]["matchScore"], 1.0)
        self.assertFalse(replay_dataset["candidates"][0]["_replay_human_positive"])
        self.assertTrue(replay_dataset["candidates"][1]["_replay_human_positive"])

    def test_orphan_dataset_is_skipped_and_reported_without_blocking_labels(self):
        dataset = build_replay_capture_dataset(self.ranking)
        label = build_replay_capture_label(
            dataset,
            self.decision(),
            approved_rank=1,
        )
        alternate_ranking = build_ranking_manifest(
            "https://www.youtube.com/watch?v=fixture123",
            str(self.source),
            "motivational_podcast",
            self.candidates,
            [],
            profiles=resolve_profile_bundle(format_profile=BF_VIRAL_MICRO_V1),
            source_hash=self.source_hash,
            transcript=exact_transcript(),
        )
        orphan = build_replay_capture_dataset(alternate_ranking)
        diagnostics = {}

        prepared = ingest_capture_artifacts(
            dataset_artifacts=[orphan, dataset],
            label_artifacts=[label],
            diagnostics=diagnostics,
        )

        self.assertEqual(len(prepared), 1)
        self.assertEqual(prepared[0]["datasetId"], dataset["datasetId"])
        self.assertEqual(diagnostics["capturedDatasetCount"], 2)
        self.assertEqual(diagnostics["promotableDatasetCount"], 1)
        self.assertEqual(diagnostics["skippedOrphanDatasetCount"], 1)
        self.assertEqual(
            diagnostics["skippedOrphanDatasetIds"],
            [orphan["datasetId"]],
        )

    def test_portable_projection_preserves_safe_errors_and_rejects_hidden_paths(self):
        portable = _portable_capture_candidate(
            {
                "candidate_hash": "a" * 64,
                "error": "decoder exited with status 1",
                "render_error": {"code": "decode_failed", "retryable": False},
                "clip_url": "/Users/private/output.mp4",
            }
        )
        self.assertEqual(portable["error"], "decoder exited with status 1")
        self.assertEqual(
            portable["render_error"],
            {"code": "decode_failed", "retryable": False},
        )
        self.assertNotIn("clip_url", portable)

        with self.assertRaisesRegex(ValueError, "nested local-path field"):
            _portable_capture_candidate(
                {
                    "candidate_hash": "a" * 64,
                    "nested": {
                        "shot_index_cache_path": r"C:\\private\\shots.json",
                    },
                }
            )

        with self.assertRaisesRegex(ValueError, "candidate.metadata.failure") as raised:
            _portable_capture_candidate(
                {
                    "candidate_hash": "a" * 64,
                    "metadata": {
                        "failure": "decoder failed at /Users/private/cache.bin",
                    },
                }
            )
        self.assertNotIn("/Users/private", str(raised.exception))

    def test_capture_ingestion_is_input_order_independent_and_collapses_events(self):
        dataset = build_replay_capture_dataset(self.ranking)
        first = build_replay_capture_label(
            dataset,
            self.decision(0),
            approved_rank=1,
        )
        second = build_replay_capture_label(
            dataset,
            self.decision(
                0,
                reviewer="operator_2",
                decided_at="2026-08-06T12:10:00Z",
            ),
            approved_rank=1,
        )
        forward = ingest_capture_artifacts(
            dataset_artifacts=[dataset],
            label_artifacts=[first, second],
        )
        reverse = ingest_capture_artifacts(
            dataset_artifacts=[dataset],
            label_artifacts=[second, first],
        )

        self.assertEqual(forward, reverse)
        self.assertEqual(forward[0]["approvedCandidateHashes"], [
            self.candidates[0]["candidate_hash"]
        ])
        self.assertEqual(forward[0]["approvalEventCount"], 2)
        self.assertEqual(
            forward[0]["labelEventHashesByCandidate"][
                self.candidates[0]["candidate_hash"]
            ],
            sorted([first["contentHash"], second["contentHash"]]),
        )


if __name__ == "__main__":
    unittest.main()
