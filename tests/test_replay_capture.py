import io
import json
import math
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from research.autoresearch_v2 import verify_local_seal
from research.fixture_pack_v2 import (
    CaptureActivationUnavailable,
    _portable_capture_candidate,
    assess_capture_data_readiness,
    build_capture_activation_readiness,
    build_fixture_pack_from_captures,
    ingest_capture_artifacts,
    main as fixture_pack_main,
)
from shorts_generator import config as config_module
from shorts_generator.artifact_contracts import (
    ArtifactBindingError,
    build_candidate_decision,
    candidate_hash,
    content_hash,
    file_sha256,
    transcript_timing_hash,
    verify_seal,
)
from shorts_generator.growth_replay import load_replay_dataset, verify_replay_pack
from shorts_generator.pipeline import build_ranking_manifest
from shorts_generator.profiles import (
    BF_FEED_STOP_FORMAT_V3,
    BF_VIRAL_MICRO_V1,
    resolve_profile_bundle,
)
from shorts_generator.replay_capture import (
    ENGINE_SELECTION_SEMANTICS,
    HUMAN_LABEL_SEMANTICS,
    HUMAN_PREVIEW_REJECTION_ARTIFACT_TYPE,
    HUMAN_PREVIEW_REJECTION_LEGACY_VERSION,
    HUMAN_PREVIEW_REJECTION_SEMANTICS,
    HUMAN_PREVIEW_REJECTION_VERSION,
    HUMAN_REJECTION_ARTIFACT_TYPE,
    HUMAN_REJECTION_SEMANTICS,
    archive_rejected_preview,
    archive_rejected_candidate,
    archive_approved_candidate,
    build_replay_capture_dataset,
    build_replay_capture_label,
    build_replay_human_preview_rejection,
    build_replay_human_rejection,
    verify_replay_capture_dataset,
    verify_replay_capture_label,
    verify_replay_human_preview_rejection,
    verify_replay_human_rejection,
)
from shorts_generator.speech_cleanliness import (
    evaluate_speech_cleanliness_evidence,
)
from shorts_generator import preview_provenance as preview_provenance_module
from tests.test_artifact_contracts import feed_stop_v3_candidate


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
                        "word": "creates",
                        "start": 1.345678912,
                        "end": 4.876543219,
                        "confidence": 0.981234567,
                    },
                    {
                        "word": "choices.",
                        "start": 4.976543219,
                        "end": 9.876543219,
                        "confidence": 0.976234567,
                    },
                    {
                        "word": "Boundaries",
                        "start": 11.000000123,
                        "end": 12.345678912,
                        "confidence": 0.971234567,
                    },
                    {
                        "word": "protect",
                        "start": 12.456789123,
                        "end": 16.876543219,
                        "confidence": 0.961234567,
                    },
                    {
                        "word": "peace.",
                        "start": 16.976543219,
                        "end": 21.876543219,
                        "confidence": 0.951234567,
                    },
                ],
            }
        ],
    }


def passing_preview_provenance_report(
    source_hash,
    preview_hash,
    start_ms,
    end_ms,
):
    duration_ms = end_ms - start_ms
    sample_count = int(round(duration_ms * 8.0))
    frame_count = max(1, int(math.floor(duration_ms / 1000.0 + 0.5)))
    payload = {
        "schemaVersion": 1,
        "artifactType": "PreviewSourceProvenanceReport",
        "analyzer": {
            "id": "budget_friendly_preview_source_provenance",
            "version": "bf-preview-source-provenance-v1.0.0",
        },
        "runtime": {
            "ffmpegVersion": "fixture",
            "ffprobeVersion": "fixture",
            "numpyVersion": "fixture",
            "pythonVersion": "fixture",
        },
        "config": json.loads(
            json.dumps(preview_provenance_module._CONFIG)
        ),
        "bindings": {
            "sourceSha256": source_hash,
            "previewSha256": preview_hash,
            "sourceIntervalMs": {
                "startMs": start_ms,
                "endMs": end_ms,
            },
        },
        "analysisStatus": "complete",
        "failureCode": None,
        "decodedEvidence": {
            "sourceAudioF32leSha256": "a" * 64,
            "previewAudioF32leSha256": "b" * 64,
            "sourceVideoRgb24Sha256": "c" * 64,
            "previewVideoRgb24Sha256": "d" * 64,
        },
        "metrics": {
            "expectedDurationMs": duration_ms,
            "previewDurationMs": duration_ms,
            "durationDeltaMs": 0,
            "audio": {
                "alignedSampleCount": sample_count,
                "alignmentOffsetMs": 0.0,
                "alignmentOffsetSamples": 0,
                "correlation": 1.0,
                "coverageRatio": 1.0,
                "expectedSampleCount": sample_count,
                "previewSampleCount": sample_count,
                "sourceSampleCount": sample_count,
            },
            "video": {
                "alignedFrameCount": frame_count,
                "alignmentOffsetFrames": 0,
                "coverageRatio": 1.0,
                "expectedFrameCount": frame_count,
                "maximumFrameMeanAbsoluteError": 0.0,
                "meanCorrelation": 1.0,
                "meanFrameMeanAbsoluteError": 0.0,
                "minimumFrameCorrelation": 1.0,
                "previewFrameCount": frame_count,
                "sourceFrameCount": frame_count,
            },
        },
        "gates": [
            {"code": code, "passed": True}
            for code in preview_provenance_module._GATE_CODES
        ],
        "passed": True,
        "decision": "pass",
    }
    return {**payload, "contentHash": content_hash(payload)}


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


def readiness_contract(
    *,
    minimum_sources=5,
    minimum_candidates=30,
    minimum_human_positives=12,
    minimum_match_coverage=0.9,
):
    return {
        "contractVersion": "bf-autoresearch-v2.0.0",
        "dataReadinessGates": {
            "minimumSources": minimum_sources,
            "minimumCandidates": minimum_candidates,
            "minimumHumanPositives": minimum_human_positives,
            "minimumPositiveLabelMatchCoverage": minimum_match_coverage,
        },
    }


class ReplayCaptureTests(unittest.TestCase):
    def test_v3_capture_rebuild_restores_top_level_hook_gate_evidence(self):
        candidate, transcript = feed_stop_v3_candidate(
            source_hash=self.source_hash
        )
        ranking = build_ranking_manifest(
            "https://example.test/v3-source",
            str(self.source),
            "motivational_podcast",
            [candidate],
            [candidate],
            profiles=resolve_profile_bundle(
                format_profile=BF_FEED_STOP_FORMAT_V3
            ),
            source_hash=self.source_hash,
            transcript=transcript,
        )
        dataset = build_replay_capture_dataset(ranking)
        decision = build_candidate_decision(
            ranking["candidates"][0],
            self.source_hash,
            reviewer="operator_1",
            decided_at="2026-08-07T12:00:00Z",
            ranking_manifest_hash=ranking["contentHash"],
            replay_transcript=ranking["replayTranscriptManifest"]["transcript"],
            transcript_timing_hash=ranking["replayTranscriptManifest"][
                "transcriptTimingHash"
            ],
        )

        label = build_replay_capture_label(
            dataset,
            decision,
            approved_rank=1,
        )

        self.assertEqual(
            decision["hookGateReport"],
            ranking["candidates"][0]["hookGateReport"],
        )
        self.assertNotIn("hookGateReport", decision["candidate"])
        self.assertIs(verify_replay_capture_label(label, dataset), label)

        reportless_ranking = json.loads(json.dumps(ranking))
        reportless_ranking["candidates"][0].pop("hookGateReport")
        reportless_ranking["contentHash"] = content_hash(reportless_ranking)
        reportless_dataset = build_replay_capture_dataset(reportless_ranking)
        report_bound_decision = build_candidate_decision(
            ranking["candidates"][0],
            self.source_hash,
            reviewer="operator_1",
            decided_at="2026-08-07T12:00:00Z",
            ranking_manifest_hash=reportless_ranking["contentHash"],
            replay_transcript=ranking["replayTranscriptManifest"]["transcript"],
            transcript_timing_hash=ranking["replayTranscriptManifest"][
                "transcriptTimingHash"
            ],
        )
        with self.assertRaisesRegex(
            ArtifactBindingError,
            "differs from the ranking candidate",
        ):
            build_replay_capture_label(
                reportless_dataset,
                report_bound_decision,
                approved_rank=1,
            )

    def test_v3_capture_rejects_self_consistent_evidence_for_stale_transcript(self):
        _, ranking_transcript = feed_stop_v3_candidate(
            source_hash=self.source_hash
        )
        stale_transcript = json.loads(json.dumps(ranking_transcript))
        stale_transcript["duration"] += 1.0
        stale_transcript["segments"][0]["end"] += 1.0
        stale_timing_hash = transcript_timing_hash(stale_transcript)
        stale_candidate, _ = feed_stop_v3_candidate(
            source_hash=self.source_hash,
            evidence_transcript_timing_hash=stale_timing_hash,
        )
        ranking = build_ranking_manifest(
            "https://example.test/v3-source",
            str(self.source),
            "motivational_podcast",
            [stale_candidate],
            [stale_candidate],
            profiles=resolve_profile_bundle(
                format_profile=BF_FEED_STOP_FORMAT_V3
            ),
            source_hash=self.source_hash,
            transcript=ranking_transcript,
        )
        # Recreate the adversarial pre-fix shape: all four reports consistently
        # reference the stale transcript while the sealed ranking references
        # another exact transcript. Candidate identity intentionally excludes
        # only the volatile HookGate report.
        ranking["candidates"][0]["hookGateReport"] = stale_candidate[
            "hookGateReport"
        ]
        ranking["contentHash"] = content_hash(ranking)
        dataset = build_replay_capture_dataset(ranking)
        decision = build_candidate_decision(
            stale_candidate,
            self.source_hash,
            reviewer="operator_1",
            decided_at="2026-08-07T12:00:00Z",
            ranking_manifest_hash=ranking["contentHash"],
            replay_transcript=stale_transcript,
            transcript_timing_hash=stale_timing_hash,
        )

        with self.assertRaisesRegex(ArtifactBindingError, "another transcript"):
            build_replay_capture_label(dataset, decision, approved_rank=1)

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

    def test_empty_capture_preflight_is_sealed_and_reports_exact_deficits(self):
        with tempfile.TemporaryDirectory() as directory:
            capture_dir = Path(directory) / "missing-inbox"
            report = assess_capture_data_readiness(
                capture_dir,
                readiness_contract(),
            )

        self.assertFalse(report["replayable"])
        self.assertFalse(report["activationReady"])
        self.assertEqual(report["sourceCount"], 0)
        self.assertEqual(report["candidateCount"], 0)
        self.assertEqual(report["humanPositiveCount"], 0)
        self.assertEqual(report["positiveLabelMatchCoverage"], 0.0)
        self.assertEqual(
            {gate["code"]: gate["deficit"] for gate in report["dataReadinessGates"]},
            {
                "SOURCE_COVERAGE": 5,
                "CANDIDATE_COVERAGE": 30,
                "HUMAN_POSITIVE_COVERAGE": 12,
                "POSITIVE_LABEL_MATCH_COVERAGE": 0.9,
            },
        )
        verify_local_seal(report, "BudgetFriendlyAutoresearchCaptureReadiness")

    def test_empty_capture_cli_refuses_preflight_and_promotion_without_a_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            capture_dir = Path(directory) / "evidence"
            for preflight in (True, False):
                output_dir = Path(directory) / f"pack-{preflight}"
                stream = io.StringIO()
                argv = [
                    "fixture_pack_v2.py",
                    "--capture-dir",
                    str(capture_dir),
                    "--output-dir",
                    str(output_dir),
                ]
                if preflight:
                    argv.append("--preflight")
                with patch("sys.argv", argv), redirect_stdout(stream):
                    exit_code = fixture_pack_main()
                report = json.loads(stream.getvalue())

                self.assertEqual(exit_code, 2)
                self.assertFalse(report["activationReady"])
                self.assertFalse(output_dir.exists())
                verify_local_seal(
                    report,
                    "BudgetFriendlyAutoresearchCaptureReadiness",
                )

    def test_label_only_capture_inbox_is_an_integrity_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            capture_dir = Path(directory) / "evidence"
            label_dir = capture_dir / "labels" / ("a" * 64)
            label_dir.mkdir(parents=True)
            (label_dir / f"{'b' * 64}.json").write_text("{}", encoding="utf-8")

            report = assess_capture_data_readiness(
                capture_dir,
                readiness_contract(),
            )

        self.assertFalse(report["replayable"])
        self.assertFalse(report["activationReady"])
        self.assertEqual(report["labelArtifactCount"], 1)
        self.assertEqual(
            report["integrityError"],
            "capture inbox has label artifacts but no dataset artifacts",
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

    def test_human_rejection_is_sealed_bound_and_archive_retry_is_idempotent(self):
        dataset = build_replay_capture_dataset(self.ranking)
        rejection = build_replay_human_rejection(
            dataset,
            self.candidates[0]["candidate_hash"],
            reviewer=" operator_1 ",
            decided_at=" 2026-08-06T12:30:00Z ",
            reason_codes=["Weak-Hook", " audible backchannels "],
            rejected_rank=1,
            notes=" Repeated listener sounds distract from the point. ",
        )

        self.assertEqual(rejection["artifactType"], HUMAN_REJECTION_ARTIFACT_TYPE)
        self.assertEqual(rejection["decision"], "rejected")
        self.assertEqual(
            rejection["labelSemantics"],
            HUMAN_REJECTION_SEMANTICS,
        )
        self.assertEqual(
            rejection["reasonCodes"],
            ["audible_backchannels", "weak_hook"],
        )
        self.assertEqual(rejection["candidateIndex"], 0)
        self.assertEqual(rejection["rejectedRank"], 1)
        self.assertEqual(rejection["datasetHash"], dataset["contentHash"])
        self.assertEqual(
            rejection["transcriptTimingHash"],
            dataset["transcriptTimingHash"],
        )
        verify_replay_human_rejection(rejection, dataset)

        evidence = self.root / "negative-evidence"
        first = archive_rejected_candidate(
            self.ranking,
            self.candidates[0]["candidate_hash"],
            reviewer="operator_1",
            decided_at="2026-08-06T12:30:00Z",
            reason_codes=["audible_backchannels"],
            rejected_rank=1,
            evidence_dir=evidence,
        )
        second = archive_rejected_candidate(
            self.ranking,
            self.candidates[0]["candidate_hash"],
            reviewer="operator_1",
            decided_at="2026-08-06T12:30:00Z",
            reason_codes=["audible_backchannels"],
            rejected_rank=1,
            evidence_dir=evidence,
        )

        self.assertTrue(first["datasetCreated"])
        self.assertTrue(first["rejectionCreated"])
        self.assertFalse(second["datasetCreated"])
        self.assertFalse(second["rejectionCreated"])
        self.assertEqual(first["rejectionHash"], second["rejectionHash"])
        negative_paths = list(
            (evidence / "negative-labels").glob("*/*.json")
        )
        self.assertEqual(len(negative_paths), 1)
        self.assertIn(
            self.ranking["contentHash"],
            negative_paths[0].parts,
        )
        self.assertEqual(list((evidence / "labels").glob("*/*.json")), [])
        archived = json.loads(negative_paths[0].read_text(encoding="utf-8"))
        verify_replay_human_rejection(
            archived,
            build_replay_capture_dataset(self.ranking),
        )
        negative_paths[0].write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(
            ArtifactBindingError,
            "immutable capture collision",
        ):
            archive_rejected_candidate(
                self.ranking,
                self.candidates[0]["candidate_hash"],
                reviewer="operator_1",
                decided_at="2026-08-06T12:30:00Z",
                reason_codes=["audible_backchannels"],
                rejected_rank=1,
                evidence_dir=evidence,
            )

    def test_human_rejection_normalizes_clarity_and_delivery_reason_codes(self):
        dataset = build_replay_capture_dataset(self.ranking)
        rejection = build_replay_human_rejection(
            dataset,
            self.candidates[0]["candidate_hash"],
            reviewer="operator_1",
            decided_at="2026-08-06T12:30:30Z",
            reason_codes=[
                " Unclear-Hook ",
                "unclear point",
                "UNINTELLIGIBLE SPEECH",
                "Hesitant-Or-Stuttered Delivery",
                "unclear_hook",
            ],
        )

        self.assertEqual(
            rejection["reasonCodes"],
            [
                "hesitant_or_stuttered_delivery",
                "unclear_hook",
                "unclear_point",
                "unintelligible_speech",
            ],
        )
        verify_replay_human_rejection(rejection, dataset)

        noncanonical = {
            **rejection,
            "reasonCodes": ["Unclear-Hook"],
        }
        noncanonical["contentHash"] = content_hash(noncanonical)
        with self.assertRaisesRegex(ArtifactBindingError, "not canonical"):
            verify_replay_human_rejection(noncanonical, dataset)

    def test_preview_rejection_is_sealed_nonproduction_and_has_no_candidate_identity(self):
        dataset = build_replay_capture_dataset(self.ranking)
        media = self.root / "review-preview.mp4"
        media.write_bytes(b"exact-reviewed-preview-bytes")
        provenance = passing_preview_provenance_report(
            self.source_hash,
            file_sha256(str(media)),
            0,
            23020,
        )
        rejection = build_replay_human_preview_rejection(
            dataset,
            interval_start_ms=0,
            interval_end_ms=23020,
            review_media_hash=file_sha256(str(media)),
            review_media_byte_length=media.stat().st_size,
            review_media_duration_ms=23020,
            review_media_container=" .MP4 ",
            reviewer=" operator_1 ",
            decided_at=" 2026-08-07T09:00:00Z ",
            reason_codes=[
                "Unclear-Hook",
                "unclear point",
                "hesitant or stuttered delivery",
            ],
            preview_source_provenance_report=provenance,
            notes=" The reviewed source preview is not a ranked candidate. ",
        )

        self.assertEqual(
            rejection["artifactType"],
            HUMAN_PREVIEW_REJECTION_ARTIFACT_TYPE,
        )
        self.assertEqual(
            rejection["labelSemantics"],
            HUMAN_PREVIEW_REJECTION_SEMANTICS,
        )
        self.assertFalse(rejection["productionEligible"])
        self.assertEqual(
            rejection["rejectionVersion"],
            HUMAN_PREVIEW_REJECTION_VERSION,
        )
        self.assertEqual(
            rejection["previewSourceProvenanceReportHash"],
            provenance["contentHash"],
        )
        self.assertEqual(
            rejection["sourceIntervalMs"],
            {"startMs": 0, "endMs": 23020},
        )
        self.assertEqual(
            rejection["reviewMedia"],
            {
                "sha256": file_sha256(str(media)),
                "byteLength": media.stat().st_size,
                "durationMs": 23020,
                "container": "mp4",
            },
        )
        self.assertEqual(
            rejection["reasonCodes"],
            [
                "hesitant_or_stuttered_delivery",
                "unclear_hook",
                "unclear_point",
            ],
        )
        for field in (
            "candidateHash",
            "candidateRecordHash",
            "candidateIndex",
            "rejectedRank",
        ):
            self.assertNotIn(field, rejection)
        verify_replay_human_preview_rejection(
            rejection,
            dataset,
            review_media_path=media,
        )
        frame_tolerant = build_replay_human_preview_rejection(
            dataset,
            interval_start_ms=0,
            interval_end_ms=23020,
            review_media_hash=file_sha256(str(media)),
            review_media_byte_length=media.stat().st_size,
            review_media_duration_ms=22920,
            review_media_container="mp4",
            reviewer="operator_1",
            decided_at="2026-08-07T09:00:01Z",
            reason_codes=["unclear_hook"],
            preview_source_provenance_report=provenance,
        )
        verify_replay_human_preview_rejection(frame_tolerant, dataset)

        legacy = json.loads(json.dumps(rejection))
        legacy["rejectionVersion"] = HUMAN_PREVIEW_REJECTION_LEGACY_VERSION
        legacy.pop("previewSourceProvenanceReport")
        legacy.pop("previewSourceProvenanceReportHash")
        legacy["contentHash"] = content_hash(legacy)
        verify_replay_human_preview_rejection(
            legacy,
            dataset,
            review_media_path=media,
        )

        legacy_root = self.root / "legacy-preview-capture"
        (legacy_root / "datasets").mkdir(parents=True)
        (legacy_root / "negative-preview-labels" / self.ranking["contentHash"]).mkdir(
            parents=True
        )
        (legacy_root / "review-media").mkdir(parents=True)
        (legacy_root / "datasets" / f"{self.ranking['contentHash']}.json").write_text(
            json.dumps(dataset), encoding="utf-8"
        )
        (
            legacy_root
            / "negative-preview-labels"
            / self.ranking["contentHash"]
            / f"{legacy['contentHash']}.json"
        ).write_text(json.dumps(legacy), encoding="utf-8")
        (
            legacy_root
            / "review-media"
            / f"{file_sha256(str(media))}.mp4"
        ).write_bytes(media.read_bytes())
        legacy_readiness = assess_capture_data_readiness(
            legacy_root,
            readiness_contract(),
        )
        self.assertIsNone(legacy_readiness["integrityError"])
        self.assertEqual(
            legacy_readiness["explicitHumanPreviewRejectionCount"],
            1,
        )
        with self.assertRaisesRegex(ArtifactBindingError, "CandidateDecision"):
            build_replay_capture_label(dataset, rejection, approved_rank=1)

    def test_preview_rejection_fails_closed_on_binding_media_and_shape_tamper(self):
        dataset = build_replay_capture_dataset(self.ranking)
        media = self.root / "review-preview.mp4"
        media.write_bytes(b"exact-reviewed-preview-bytes")
        provenance = passing_preview_provenance_report(
            self.source_hash,
            file_sha256(str(media)),
            100,
            23020,
        )
        rejection = build_replay_human_preview_rejection(
            dataset,
            interval_start_ms=100,
            interval_end_ms=23020,
            review_media_hash=file_sha256(str(media)),
            review_media_byte_length=media.stat().st_size,
            review_media_duration_ms=22920,
            review_media_container="mp4",
            reviewer="operator_1",
            decided_at="2026-08-07T09:01:00Z",
            reason_codes=["unintelligible_speech"],
            preview_source_provenance_report=provenance,
        )

        mutations = {}
        stale_source = json.loads(json.dumps(rejection))
        stale_source["sourceHash"] = "d" * 64
        mutations["sourceHash binding is stale"] = stale_source

        fractional_interval = json.loads(json.dumps(rejection))
        fractional_interval["sourceIntervalMs"]["endMs"] = 23020.5
        mutations["must be a positive integer"] = fractional_interval

        stale_media_length = json.loads(json.dumps(rejection))
        stale_media_length["reviewMedia"]["byteLength"] += 1
        mutations["bytes do not match"] = stale_media_length

        false_media_duration = json.loads(json.dumps(rejection))
        false_media_duration["reviewMedia"]["durationMs"] = 22819
        mutations["does not match sourceIntervalMs"] = false_media_duration

        noncanonical_container = json.loads(json.dumps(rejection))
        noncanonical_container["reviewMedia"]["container"] = "MP4"
        mutations["reviewMedia is not canonical"] = noncanonical_container

        candidate_identity = json.loads(json.dumps(rejection))
        candidate_identity["candidateHash"] = self.candidates[0]["candidate_hash"]
        mutations["must not contain candidate identity"] = candidate_identity

        missing_provenance = json.loads(json.dumps(rejection))
        missing_provenance.pop("previewSourceProvenanceReport")
        missing_provenance.pop("previewSourceProvenanceReportHash")
        mutations["lacks preview source provenance"] = missing_provenance

        tampered_provenance = json.loads(json.dumps(rejection))
        tampered_provenance["previewSourceProvenanceReport"]["passed"] = False
        mutations["contentHash"] = tampered_provenance

        for message, tampered in mutations.items():
            with self.subTest(message=message):
                tampered["contentHash"] = content_hash(tampered)
                kwargs = (
                    {"review_media_path": media}
                    if message == "bytes do not match"
                    else {}
                )
                with self.assertRaisesRegex(ArtifactBindingError, message):
                    verify_replay_human_preview_rejection(
                        tampered,
                        dataset,
                        **kwargs,
                    )

        media.write_bytes(b"different-reviewed-preview-bytes")
        with self.assertRaisesRegex(ArtifactBindingError, "bytes do not match"):
            verify_replay_human_preview_rejection(
                rejection,
                dataset,
                review_media_path=media,
            )

        invalid_builds = (
            {"interval_start_ms": 0.0},
            {"interval_end_ms": 25000},
            {"review_media_byte_length": 0},
            {"review_media_duration_ms": True},
            {"review_media_duration_ms": 22919},
        )
        base = {
            "interval_start_ms": 0,
            "interval_end_ms": 23020,
            "review_media_hash": file_sha256(str(media)),
            "review_media_byte_length": media.stat().st_size,
            "review_media_duration_ms": 23020,
            "review_media_container": "mp4",
            "reviewer": "operator_1",
            "decided_at": "2026-08-07T09:02:00Z",
            "reason_codes": ["unclear_hook"],
            "preview_source_provenance_report": passing_preview_provenance_report(
                self.source_hash,
                file_sha256(str(media)),
                0,
                23020,
            ),
        }
        for override in invalid_builds:
            with self.subTest(override=override), self.assertRaises(
                ArtifactBindingError
            ):
                build_replay_human_preview_rejection(
                    dataset,
                    **{**base, **override},
                )

    def test_preview_rejection_archive_copies_exact_media_and_retry_is_idempotent(self):
        evidence = self.root / "preview-negative-evidence"
        media = self.root / "review-preview.mp4"
        media.write_bytes(b"exact-reviewed-preview-bytes")
        provenance = passing_preview_provenance_report(
            self.source_hash,
            file_sha256(str(media)),
            0,
            23020,
        )
        arguments = {
            "interval_start_ms": 0,
            "interval_end_ms": 23020,
            "review_media_path": media,
            "review_media_duration_ms": 23020,
            "review_media_container": "mp4",
            "reviewer": "operator_1",
            "decided_at": "2026-08-07T09:03:00Z",
            "reason_codes": ["unclear_hook", "unclear_point"],
            "preview_source_provenance_report": provenance,
            "evidence_dir": evidence,
        }
        first = archive_rejected_preview(self.ranking, **arguments)
        second = archive_rejected_preview(self.ranking, **arguments)

        self.assertTrue(first["datasetCreated"])
        self.assertTrue(first["reviewMediaCreated"])
        self.assertTrue(first["rejectionCreated"])
        self.assertFalse(second["datasetCreated"])
        self.assertFalse(second["reviewMediaCreated"])
        self.assertFalse(second["rejectionCreated"])
        self.assertEqual(first["rejectionHash"], second["rejectionHash"])
        self.assertEqual(first["reviewMediaHash"], file_sha256(str(media)))
        self.assertEqual(
            first["previewSourceProvenanceHash"],
            provenance["contentHash"],
        )

        archived_media = Path(first["reviewMediaPath"])
        archived_rejection_path = Path(first["rejectionPath"])
        dataset_path = Path(first["datasetPath"])
        self.assertEqual(archived_media.read_bytes(), media.read_bytes())
        self.assertEqual(archived_media.parent.name, "review-media")
        self.assertEqual(
            archived_rejection_path.parent.parent.name,
            "negative-preview-labels",
        )
        archived_rejection = json.loads(
            archived_rejection_path.read_text(encoding="utf-8")
        )
        archived_dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
        verify_replay_human_preview_rejection(
            archived_rejection,
            archived_dataset,
            review_media_path=archived_media,
        )
        readiness = assess_capture_data_readiness(
            evidence,
            readiness_contract(),
        )
        self.assertIsNone(readiness["integrityError"])
        self.assertEqual(
            readiness["explicitHumanPreviewRejectionCount"],
            1,
        )

        unrelated = passing_preview_provenance_report(
            self.source_hash,
            "e" * 64,
            0,
            23020,
        )
        rejected_root = self.root / "unrelated-preview-evidence"
        with self.assertRaisesRegex(ArtifactBindingError, "bindings do not match"):
            archive_rejected_preview(
                self.ranking,
                **{
                    **arguments,
                    "evidence_dir": rejected_root,
                    "preview_source_provenance_report": unrelated,
                },
            )
        self.assertFalse(rejected_root.exists())

        archived_media.write_bytes(b"corrupted-archived-preview")
        with self.assertRaisesRegex(
            ArtifactBindingError,
            "immutable review media collision",
        ):
            archive_rejected_preview(self.ranking, **arguments)

    def test_human_rejection_binds_optional_speech_cleanliness_evidence(self):
        base_dataset = build_replay_capture_dataset(self.ranking)
        report = evaluate_speech_cleanliness_evidence(
            source_hash=self.source_hash,
            transcript_timing_hash=base_dataset["transcriptTimingHash"],
            speech_start=0.1,
            speech_end=10.6,
            lexical_fillers=[],
            uncovered_vocalizations=[
                {"start": 2.8, "end": 3.1},
                {"start": 4.8, "end": 5.1},
                {"start": 7.8, "end": 8.1},
            ],
            prompted_fillers=[
                {"text": "uh-huh", "start": 2.8, "end": 3.1},
                {"text": "uh-huh", "start": 4.8, "end": 5.1},
            ],
            provider_identity={"provider": "fixture"},
        )
        dirty_body = candidate_body(
            1,
            0.1,
            10.6,
            "Pressure",
            selected=False,
        )
        dirty_body["speechCleanlinessReport"] = report
        dirty_candidate = {
            **dirty_body,
            "candidate_hash": candidate_hash(dirty_body, self.source_hash),
        }
        dirty_ranking = build_ranking_manifest(
            "https://www.youtube.com/watch?v=fixture123",
            str(self.source),
            "motivational_podcast",
            [dirty_candidate],
            [],
            profiles=resolve_profile_bundle(format_profile=BF_VIRAL_MICRO_V1),
            source_hash=self.source_hash,
            transcript=exact_transcript(),
        )
        dataset = build_replay_capture_dataset(dirty_ranking)
        rejection = build_replay_human_rejection(
            dataset,
            dirty_candidate["candidate_hash"],
            reviewer="operator_1",
            decided_at="2026-08-06T12:31:00Z",
            reason_codes=["audible_backchannels"],
        )

        self.assertEqual(
            rejection["evidenceRefs"]["speechCleanlinessReportHash"],
            report["contentHash"],
        )
        verify_replay_human_rejection(rejection, dataset)

        evidence = self.root / "self-contained-negative"
        receipt = archive_rejected_candidate(
            dirty_ranking,
            dirty_candidate["candidate_hash"],
            reviewer="operator_1",
            decided_at="2026-08-06T12:31:00Z",
            reason_codes=["audible_backchannels"],
            evidence_dir=evidence,
        )
        reloaded_dataset = json.loads(
            Path(receipt["datasetPath"]).read_text(encoding="utf-8")
        )
        reloaded_rejection = json.loads(
            Path(receipt["rejectionPath"]).read_text(encoding="utf-8")
        )
        verify_replay_human_rejection(reloaded_rejection, reloaded_dataset)

        stale_ref = json.loads(json.dumps(rejection))
        stale_ref["evidenceRefs"]["speechCleanlinessReportHash"] = "d" * 64
        stale_ref["contentHash"] = content_hash(stale_ref)
        with self.assertRaisesRegex(ArtifactBindingError, "hash binding is stale"):
            verify_replay_human_rejection(stale_ref, dataset)

        external_only_root = self.root / "external-only-negative"
        with self.assertRaisesRegex(ArtifactBindingError, "not self-contained"):
            archive_rejected_candidate(
                self.ranking,
                self.candidates[0]["candidate_hash"],
                reviewer="operator_1",
                decided_at="2026-08-06T12:31:00Z",
                reason_codes=["audible_backchannels"],
                evidence_dir=external_only_root,
                speech_cleanliness_report=report,
            )
        self.assertFalse(external_only_root.exists())

    def test_human_rejection_rejects_tamper_unknown_candidate_reason_and_rank(self):
        dataset = build_replay_capture_dataset(self.ranking)
        rejection = build_replay_human_rejection(
            dataset,
            self.candidates[0]["candidate_hash"],
            reviewer="operator_1",
            decided_at="2026-08-06T12:32:00Z",
            reason_codes=["audible_backchannels"],
            rejected_rank=1,
        )

        tampered = {
            **rejection,
            "candidateRecordHash": "d" * 64,
        }
        tampered["contentHash"] = content_hash(tampered)
        with self.assertRaisesRegex(ArtifactBindingError, "candidateRecordHash"):
            verify_replay_human_rejection(tampered, dataset)

        with self.assertRaisesRegex(ArtifactBindingError, "exactly once"):
            build_replay_human_rejection(
                dataset,
                "e" * 64,
                reviewer="operator_1",
                decided_at="2026-08-06T12:32:00Z",
                reason_codes=["audible_backchannels"],
            )
        with self.assertRaisesRegex(ArtifactBindingError, "unknown human rejection"):
            build_replay_human_rejection(
                dataset,
                self.candidates[0]["candidate_hash"],
                reviewer="operator_1",
                decided_at="2026-08-06T12:32:00Z",
                reason_codes=["anything_goes"],
            )
        with self.assertRaisesRegex(ArtifactBindingError, "rejectedRank"):
            build_replay_human_rejection(
                dataset,
                self.candidates[0]["candidate_hash"],
                reviewer="operator_1",
                decided_at="2026-08-06T12:32:00Z",
                reason_codes=["audible_backchannels"],
                rejected_rank=2,
            )

    def test_human_rejection_cannot_become_candidate_decision_or_positive_label(self):
        dataset = build_replay_capture_dataset(self.ranking)
        rejection = build_replay_human_rejection(
            dataset,
            self.candidates[0]["candidate_hash"],
            reviewer="operator_1",
            decided_at="2026-08-06T12:33:00Z",
            reason_codes=["audible_backchannels"],
        )

        with self.assertRaisesRegex(ArtifactBindingError, "CandidateDecision"):
            build_replay_capture_label(dataset, rejection, approved_rank=1)
        with self.assertRaisesRegex(
            ArtifactBindingError,
            "BudgetFriendlyReplayCaptureLabelV2",
        ):
            verify_replay_capture_label(rejection, dataset)

        evidence = self.root / "negative-only"
        archive_rejected_candidate(
            self.ranking,
            self.candidates[0]["candidate_hash"],
            reviewer="operator_1",
            decided_at="2026-08-06T12:33:00Z",
            reason_codes=["audible_backchannels"],
            evidence_dir=evidence,
        )
        readiness = assess_capture_data_readiness(evidence, readiness_contract())
        self.assertEqual(readiness["humanPositiveCount"], 0)
        self.assertEqual(readiness["approvalEventCount"], 0)

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
            activation_contract=readiness_contract(
                minimum_sources=1,
                minimum_candidates=2,
                minimum_human_positives=1,
            ),
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
        self.assertRegex(report["captureReadinessHash"], r"^[0-9a-f]{64}$")
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

    def test_capture_readiness_counts_unique_approval_not_repeated_events(self):
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
                0,
                reviewer="operator_2",
                decided_at="2026-08-06T12:10:00Z",
            ),
            approved_rank=1,
            evidence_dir=evidence,
        )

        report = assess_capture_data_readiness(evidence, readiness_contract())
        gates = {gate["code"]: gate for gate in report["dataReadinessGates"]}

        self.assertTrue(report["replayable"])
        self.assertFalse(report["activationReady"])
        self.assertEqual(report["sourceCount"], 1)
        self.assertEqual(report["candidateCount"], 2)
        self.assertEqual(report["humanPositiveCount"], 1)
        self.assertEqual(report["humanPositiveMatchedCount"], 1)
        self.assertEqual(report["approvalEventCount"], 2)
        self.assertEqual(report["positiveLabelMatchCoverage"], 1.0)
        self.assertEqual(gates["SOURCE_COVERAGE"]["deficit"], 4)
        self.assertEqual(gates["CANDIDATE_COVERAGE"]["deficit"], 28)
        self.assertEqual(gates["HUMAN_POSITIVE_COVERAGE"]["deficit"], 11)
        self.assertEqual(gates["POSITIVE_LABEL_MATCH_COVERAGE"]["deficit"], 0.0)
        verify_local_seal(report, "BudgetFriendlyAutoresearchCaptureReadiness")

    def test_pack_builder_rechecks_the_exact_snapshot_before_writing(self):
        evidence = self.root / "evidence"
        archive_approved_candidate(
            self.ranking,
            self.decision(0),
            approved_rank=1,
            evidence_dir=evidence,
        )
        dataset_paths = list((evidence / "datasets").glob("*.json"))
        label_paths = list((evidence / "labels").glob("*/*.json"))
        output_dir = self.root / "under-threshold-pack"

        with self.assertRaises(CaptureActivationUnavailable) as raised:
            build_fixture_pack_from_captures(
                root=self.root,
                dataset_paths=dataset_paths,
                label_paths=label_paths,
                output_dir=output_dir,
                activation_contract=readiness_contract(),
            )

        self.assertFalse(output_dir.exists())
        self.assertTrue(raised.exception.report["replayable"])
        self.assertFalse(raised.exception.report["activationReady"])
        verify_local_seal(
            raised.exception.report,
            "BudgetFriendlyAutoresearchCaptureReadiness",
        )

    def test_capture_readiness_activates_only_at_all_exact_thresholds(self):
        approved_counts = [3, 3, 2, 2, 2]
        prepared = []
        for source_index, approved_count in enumerate(approved_counts):
            candidates = [
                {"candidate_hash": f"{100 + source_index * 10 + index:064x}"}
                for index in range(6)
            ]
            prepared.append(
                {
                    "sourceId": f"youtube:source-{source_index}",
                    "sourceHash": f"{source_index + 1:064x}",
                    "candidates": candidates,
                    "approvedCandidateHashes": [
                        candidate["candidate_hash"]
                        for candidate in candidates[:approved_count]
                    ],
                    "approvalEventCount": approved_count,
                }
            )
        diagnostics = {
            "capturedDatasetCount": 5,
            "promotableDatasetCount": 5,
            "skippedOrphanDatasetCount": 0,
            "skippedOrphanDatasetIds": [],
        }

        report = build_capture_activation_readiness(
            prepared=prepared,
            diagnostics=diagnostics,
            contract=readiness_contract(),
        )

        self.assertTrue(report["replayable"])
        self.assertTrue(report["activationReady"])
        self.assertEqual(report["sourceCount"], 5)
        self.assertEqual(report["candidateCount"], 30)
        self.assertEqual(report["humanPositiveCount"], 12)
        self.assertEqual(report["failedGateCodes"], [])
        self.assertTrue(all(gate["passed"] for gate in report["dataReadinessGates"]))
        verify_local_seal(report, "BudgetFriendlyAutoresearchCaptureReadiness")

    def test_capture_readiness_rejects_invalid_gate_values(self):
        invalid_values = [True, 0, -1, 1.5]
        diagnostics = {
            "capturedDatasetCount": 0,
            "promotableDatasetCount": 0,
            "skippedOrphanDatasetCount": 0,
            "skippedOrphanDatasetIds": [],
        }
        for value in invalid_values:
            invalid = readiness_contract(minimum_sources=value)
            with self.subTest(value=value), self.assertRaisesRegex(
                ValueError,
                "minimumSources",
            ):
                build_capture_activation_readiness(
                    prepared=[],
                    diagnostics=diagnostics,
                    contract=invalid,
                )
        for value in (True, -0.1, 1.1, float("nan")):
            invalid = readiness_contract(minimum_match_coverage=value)
            with self.subTest(coverage=value), self.assertRaisesRegex(
                ValueError,
                "minimumPositiveLabelMatchCoverage",
            ):
                build_capture_activation_readiness(
                    prepared=[],
                    diagnostics=diagnostics,
                    contract=invalid,
                )

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
        readiness = build_capture_activation_readiness(
            prepared=prepared,
            diagnostics=diagnostics,
            contract=readiness_contract(),
            dataset_artifact_count=2,
            label_artifact_count=1,
        )
        self.assertEqual(readiness["sourceCount"], 1)
        self.assertEqual(readiness["candidateCount"], 2)
        self.assertEqual(readiness["humanPositiveCount"], 1)
        self.assertEqual(readiness["skippedOrphanDatasetCount"], 1)

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
