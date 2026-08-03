import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import budget_friendly_ops as ops
from shorts_generator import youtube_uploader as youtube_uploader_module
from shorts_generator.artifact_contracts import candidate_hash, content_hash, file_sha256
from shorts_generator.pipeline import build_ranking_manifest
from shorts_generator.profiles import BF_VIRAL_MICRO_V1, resolve_profile_bundle
from shorts_generator.publisher import PublishReceiptStore


class BudgetFriendlyOpsTests(unittest.TestCase):
    def test_render_approved_batch_cli_preserves_order_and_writes_bundles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "transcript.json"
            decisions = [root / "decision-1.json", root / "decision-2.json"]
            experiments = [root / "experiment-1.json", root / "experiment-2.json"]
            ops.write_json(str(transcript), {"segments": []})
            for index, path in enumerate(decisions, start=1):
                ops.write_json(str(path), {"candidateHash": str(index) * 64})
            for index, path in enumerate(experiments, start=1):
                ops.write_json(str(path), {"experimentId": f"experiment-{index}"})

            fake_result = {
                "schemaVersion": 1,
                "sourceHash": "a" * 64,
                "requestedCount": 2,
                "succeededCount": 2,
                "failedCount": 0,
                "maxWorkers": 2,
                "gpuRendersSerialized": False,
                "results": [
                    {
                        "index": 0,
                        "candidateHash": "1" * 64,
                        "status": "succeeded",
                        "result": {"short": {"clip_url": "short_01.mp4"}},
                    },
                    {
                        "index": 1,
                        "candidateHash": "2" * 64,
                        "status": "succeeded",
                        "result": {"short": {"clip_url": "short_02.mp4"}},
                    },
                ],
            }
            args = ops.build_parser().parse_args(
                [
                    "render-approved-batch",
                    "--source",
                    str(root / "source.mp4"),
                    "--transcript",
                    str(transcript),
                    "--candidate-decision",
                    str(decisions[0]),
                    "--candidate-decision",
                    str(decisions[1]),
                    "--experiment",
                    str(experiments[0]),
                    "--experiment",
                    str(experiments[1]),
                    "--output-dir",
                    directory,
                    "--max-workers",
                    "2",
                ]
            )

            with patch.object(
                ops,
                "render_approved_candidates",
                return_value=fake_result,
            ) as renderer, patch.object(
                ops,
                "LOCAL_PERFORMANCE_REPORT_DIR",
                directory,
            ):
                result = args.handler(args)

            batch_path = Path(result["batchPath"])
            bundle_paths = [
                Path(item["bundlePath"])
                for item in result["results"]
            ]

        self.assertEqual(
            renderer.call_args.args[2],
            [{"candidateHash": "1" * 64}, {"candidateHash": "2" * 64}],
        )
        self.assertEqual(renderer.call_args.kwargs["max_workers"], 2)
        self.assertEqual(batch_path.name, "production-batch.json")
        self.assertEqual(
            [path.name for path in bundle_paths],
            ["production-bundle-01.json", "production-bundle-02.json"],
        )

    def test_approve_candidate_cli_writes_a_sealed_decision(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"source")
            source_hash = file_sha256(str(source))
            candidate_body = {
                "start_time": 1.0,
                "end_time": 11.75,
                "title": "Test",
                "hook_sentence": "A tested tension hook.",
                "final_takeaway_sentence": "A complete takeaway.",
                "candidate_text": "A tested tension hook with a complete takeaway.",
                "content_profile": "motivational_podcast",
                "selection_profile": "motivational_tension_micro_v1",
                "render_profile": "bf_editorial_inset_v1",
                "format_profile": "bf_viral_micro_v1",
                "selection_rank": 1,
                "rejected": False,
                "rejection_reasons": [],
                "source_cut_count": 0,
            }
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            ranking = build_ranking_manifest(
                "https://example.test/source",
                str(source),
                "motivational_podcast",
                [candidate],
                [],
                profiles=resolve_profile_bundle(format_profile=BF_VIRAL_MICRO_V1),
                source_hash=source_hash,
            )
            ranking_path = Path(directory) / "ranking.json"
            ops.write_json(
                str(ranking_path),
                ranking,
            )
            output = Path(directory) / "decision.json"
            args = ops.build_parser().parse_args(
                [
                    "approve-candidate",
                    "--candidate-json",
                    str(ranking_path),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-07-16T12:00:00Z",
                    "--output",
                    str(output),
                ]
            )
            decision = args.handler(args)

        self.assertEqual(decision["artifactType"], "CandidateDecision")
        self.assertEqual(len(decision["candidateHash"]), 64)
        self.assertEqual(decision["rankingManifestHash"], ranking["contentHash"])

    def test_approve_rejects_legacy_unsealed_candidate_json(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"source")
            legacy = Path(directory) / "candidate.json"
            ops.write_json(
                str(legacy),
                {"start_time": 1.0, "end_time": 11.75, "title": "Legacy"},
            )
            args = ops.build_parser().parse_args(
                [
                    "approve-candidate",
                    "--candidate-json",
                    str(legacy),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-07-16T12:00:00Z",
                    "--output",
                    str(Path(directory) / "decision.json"),
                ]
            )
            with self.assertRaisesRegex(ValueError, "expected RankingManifest"):
                args.handler(args)

    def test_originality_rejects_tampered_candidate_decision(self):
        source_hash = "a" * 64
        candidate_body = {
            "start_time": 1.0,
            "end_time": 11.75,
            "hook_sentence": "A tested tension hook.",
            "candidate_text": "A tested tension hook with a complete takeaway.",
            "content_profile": "motivational_podcast",
            "selection_profile": "motivational_tension_micro_v1",
            "render_profile": "bf_editorial_inset_v1",
            "format_profile": "bf_viral_micro_v1",
            "rejected": False,
            "rejection_reasons": [],
        }
        candidate = {
            **candidate_body,
            "candidate_hash": candidate_hash(candidate_body, source_hash),
        }
        decision = ops.build_candidate_decision(
            candidate,
            source_hash,
            reviewer="operator_1",
            decided_at="2026-07-16T12:00:00Z",
            ranking_manifest_hash="d" * 64,
        )
        documents = {
            "decision.json": {**decision, "sourceHash": "b" * 64},
            "recent.json": {"publications": []},
        }
        args = SimpleNamespace(
            candidate_decision="decision.json",
            recent_publications="recent.json",
            output="originality.json",
        )
        with patch.object(
            ops,
            "read_json",
            side_effect=lambda path: documents[path],
        ):
            with self.assertRaisesRegex(ValueError, "contentHash does not match"):
                ops.command_originality(args)

    def test_rights_cli_persists_required_attribution_text(self):
        attribution = "Source: Example Podcast, used with permission."
        args = ops.build_parser().parse_args(
            [
                "rights",
                "--candidate-decision",
                "decision.json",
                "--status",
                "licensed",
                "--owner",
                "Example Podcast",
                "--evidence-reference",
                "license-001",
                "--music-license",
                "music-license-001",
                "--font-license",
                "font-license-001",
                "--attribution-text",
                attribution,
                "--output",
                "rights.json",
            ]
        )
        with patch.object(
            ops,
            "read_json",
            return_value={"sourceHash": "a" * 64},
        ), patch.object(ops, "write_json") as write_json:
            rights = args.handler(args)

        self.assertEqual(rights["attributionText"], attribution)
        write_json.assert_called_once_with("rights.json", rights)

    def test_publish_plan_passes_audio_qa_report_from_production_bundle(self):
        render = {"artifactType": "RenderManifest"}
        creative_qa = {"artifactType": "CreativeQaReport"}
        experiment = {"artifactType": "ExperimentManifest"}
        audio_qa = {"artifactType": "AudioQaReport"}
        bundle = {
            "candidateDecision": {"artifactType": "CandidateDecision"},
            "renderManifest": render,
            "creativeQaReport": creative_qa,
            "experimentManifest": experiment,
            "audioQaReport": audio_qa,
        }
        rights = {"artifactType": "SourceRightsManifest"}
        originality = {"artifactType": "OriginalityReport"}
        metadata = {"title": "Title", "description": "Description"}
        manifest = {"artifactType": "PublishManifest"}
        documents = {
            "bundle.json": bundle,
            "metadata.json": metadata,
            "rights.json": rights,
            "originality.json": originality,
        }
        args = SimpleNamespace(
            production_bundle="bundle.json",
            metadata="metadata.json",
            rights="rights.json",
            originality="originality.json",
            privacy="private",
            related_video_id=None,
            related_video_waiver="first episode",
            output="publish.json",
        )

        with patch.object(
            ops,
            "read_json",
            side_effect=lambda path: documents[path],
        ), patch.object(
            ops,
            "build_publish_manifest",
            return_value=manifest,
        ) as build_publish, patch.object(ops, "write_json") as write_json:
            result = ops.command_publish_plan(args)

        self.assertIs(result, manifest)
        self.assertIs(build_publish.call_args.kwargs["audio_qa_report"], audio_qa)
        write_json.assert_called_once_with("publish.json", manifest)

    def test_publish_rejects_stale_render_before_youtube_authentication(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "short.mp4"
            output.write_bytes(b"render")
            render_payload = {
                "schemaVersion": 1,
                "artifactType": "RenderManifest",
                "outputPath": str(output),
                "outputHash": file_sha256(str(output)),
            }
            render = {**render_payload, "contentHash": content_hash(render_payload)}
            publish_payload = {
                "schemaVersion": 1,
                "artifactType": "PublishManifest",
                "renderManifestHash": "f" * 64,
                "renderOutputHash": render["outputHash"],
                "privacyStatus": "private",
            }
            publish = {
                **publish_payload,
                "contentHash": content_hash(publish_payload),
            }
            args = SimpleNamespace(
                publish_manifest="publish.json",
                render_manifest="render.json",
                client_secrets=None,
                token_file=None,
                expected_channel_id="channel",
                receipt_store="receipts.json",
                confirm_public=False,
            )
            documents = {"publish.json": publish, "render.json": render}
            with patch.object(
                ops,
                "read_json",
                side_effect=lambda path: documents[path],
            ), patch.object(
                youtube_uploader_module,
                "get_authenticated_service",
            ) as authenticate:
                with self.assertRaisesRegex(ValueError, "another render"):
                    ops.command_publish(args)
                authenticate.assert_not_called()

    def test_release_requires_explicit_confirmation_before_authentication(self):
        args = ops.build_parser().parse_args(
            [
                "release",
                "--youtube-video-id",
                "video-123",
                "--receipt-store",
                "receipts.json",
                "--expected-channel-id",
                "channel-123",
            ]
        )
        with patch.object(
            youtube_uploader_module,
            "get_authenticated_service",
        ) as authenticate:
            with self.assertRaisesRegex(ValueError, "requires --confirm-public"):
                args.handler(args)
            authenticate.assert_not_called()

    def test_release_cli_updates_bound_video_without_uploading_again(self):
        with tempfile.TemporaryDirectory() as directory:
            store_path = str(Path(directory) / "receipts.json")
            receipt_payload = {
                "schemaVersion": 1,
                "artifactType": "PublishReceipt",
                "idempotencyKey": "a" * 64,
                "renderOutputHash": "b" * 64,
                "channelId": "channel-123",
                "youtubeVideoId": "video-123",
                "privacyStatus": "private",
                "responseState": "uploaded",
            }
            receipt = {
                **receipt_payload,
                "contentHash": content_hash(receipt_payload),
            }
            PublishReceiptStore(store_path).save(receipt)
            args = ops.build_parser().parse_args(
                [
                    "release",
                    "--youtube-video-id",
                    "video-123",
                    "--receipt-store",
                    store_path,
                    "--expected-channel-id",
                    "channel-123",
                    "--confirm-public",
                ]
            )
            youtube = object()
            with patch.object(
                youtube_uploader_module,
                "get_authenticated_service",
                return_value=youtube,
            ), patch.object(
                youtube_uploader_module,
                "verify_authenticated_channel",
                return_value={"id": "channel-123"},
            ) as verify_channel, patch.object(
                youtube_uploader_module,
                "update_video_privacy",
                return_value={
                    "video_id": "video-123",
                    "privacy_status": "public",
                },
            ) as update_privacy, patch.object(
                youtube_uploader_module,
                "upload_video",
            ) as upload_video:
                release = args.handler(args)

        self.assertEqual(release["responseState"], "released")
        verify_channel.assert_called_once_with(
            youtube,
            expected_channel_id="channel-123",
        )
        update_privacy.assert_called_once_with(youtube, "video-123", "public")
        upload_video.assert_not_called()


if __name__ == "__main__":
    unittest.main()
