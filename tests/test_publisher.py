import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from shorts_generator.artifact_contracts import content_hash, file_sha256, verify_seal
from shorts_generator.publisher import (
    PublishConflict,
    PublishReceiptStore,
    publish_idempotency_key,
    publish_reviewed_short,
    release_uploaded_short,
)


def sealed(payload):
    return {**payload, "contentHash": content_hash(payload)}


def publish_contracts(directory):
    output = Path(directory) / "short.mp4"
    output.write_bytes(b"final-render")
    output_hash = file_sha256(str(output))
    render = sealed(
        {
            "schemaVersion": 1,
            "artifactType": "RenderManifest",
            "outputPath": str(output),
            "outputHash": output_hash,
        }
    )
    publish = sealed(
        {
            "schemaVersion": 1,
            "artifactType": "PublishManifest",
            "candidateHash": "a" * 64,
            "renderManifestHash": render["contentHash"],
            "renderOutputHash": output_hash,
            "rightsManifestHash": "b" * 64,
            "experimentManifestHash": "c" * 64,
            "metadata": {"title": "Title", "description": "Description"},
            "privacyStatus": "private",
            "relatedVideoId": None,
            "relatedVideoWaiverReason": "first episode",
            "containsSyntheticMedia": False,
        }
    )
    return render, publish


class CrashAfterUploadStore(PublishReceiptStore):
    def __init__(self, path):
        super().__init__(path)
        self.crash_once = True

    def save(self, receipt):
        if receipt.get("responseState") == "uploaded" and self.crash_once:
            self.crash_once = False
            raise OSError("simulated crash after external upload")
        return super().save(receipt)


class CrashAfterReleaseStore(PublishReceiptStore):
    def __init__(self, path):
        super().__init__(path)
        self.crash_once = True

    def save_release(self, release):
        if release.get("responseState") == "released" and self.crash_once:
            self.crash_once = False
            raise OSError("simulated crash after privacy update")
        return super().save_release(release)


class PublisherTests(unittest.TestCase):
    def test_upload_is_bound_and_replayed_without_second_network_call(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "short.mp4"
            output.write_bytes(b"final-render")
            from shorts_generator.artifact_contracts import file_sha256

            output_hash = file_sha256(str(output))
            render = sealed(
                {
                    "schemaVersion": 1,
                    "artifactType": "RenderManifest",
                    "outputPath": str(output),
                    "outputHash": output_hash,
                }
            )
            publish = sealed(
                {
                    "schemaVersion": 1,
                    "artifactType": "PublishManifest",
                    "candidateHash": "a" * 64,
                    "renderManifestHash": render["contentHash"],
                    "renderOutputHash": output_hash,
                    "rightsManifestHash": "b" * 64,
                    "experimentManifestHash": "c" * 64,
                    "metadata": {"title": "Title", "description": "Description"},
                    "privacyStatus": "private",
                    "relatedVideoId": "related123",
                    "relatedVideoWaiverReason": None,
                    "containsSyntheticMedia": False,
                }
            )
            calls = []

            def upload(path, metadata, privacy, synthetic):
                calls.append((path, metadata, privacy, synthetic))
                return {"video_id": "youtube123"}

            store = PublishReceiptStore(str(Path(directory) / "receipts.json"))
            options = dict(
                publish_manifest=publish,
                render_manifest=render,
                receipt_store=store,
                expected_channel_id="channel123",
                authenticated_channel={"id": "channel123"},
                upload=upload,
                now=lambda: datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc),
            )
            first = publish_reviewed_short(**options)
            second = publish_reviewed_short(**options)

            self.assertFalse(first["replayed"])
            self.assertTrue(second["replayed"])
            self.assertEqual(first["youtubeVideoId"], "youtube123")
            self.assertEqual(first["relatedVideoId"], "related123")
            self.assertEqual(first["relatedVideoState"], "studio_action_required")
            self.assertEqual(
                first["postUploadActions"],
                ["set_related_video_in_youtube_studio"],
            )
            self.assertEqual(len(calls), 1)

    def test_crash_after_upload_reconciles_without_second_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            render, publish = publish_contracts(directory)
            store = CrashAfterUploadStore(str(Path(directory) / "receipts.json"))
            key = publish_idempotency_key(publish, "channel123")
            upload_calls = []

            def upload(path, metadata, privacy, synthetic):
                upload_calls.append((path, metadata, privacy, synthetic))
                self.assertEqual(store.find(key)["responseState"], "pending")
                return {"video_id": "youtube-crash"}

            options = dict(
                publish_manifest=publish,
                render_manifest=render,
                receipt_store=store,
                expected_channel_id="channel123",
                authenticated_channel={"id": "channel123"},
                upload=upload,
                now=lambda: datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc),
            )
            with self.assertRaisesRegex(OSError, "simulated crash"):
                publish_reviewed_short(**options)

            self.assertEqual(store.find(key)["responseState"], "pending")
            with self.assertRaisesRegex(PublishConflict, "refusing a second upload"):
                publish_reviewed_short(**options, reconcile=lambda _pending: None)
            self.assertEqual(len(upload_calls), 1)

            reconciled = publish_reviewed_short(
                **options,
                reconcile=lambda pending: {
                    "video_id": "youtube-crash",
                    "channel_id": "channel123",
                    "privacy_status": "private",
                    "upload_marker": pending["uploadMarker"],
                },
            )

            self.assertTrue(reconciled["replayed"])
            self.assertTrue(reconciled["reconciled"])
            self.assertEqual(reconciled["youtubeVideoId"], "youtube-crash")
            self.assertEqual(len(upload_calls), 1)
            self.assertEqual(store.find(key)["responseState"], "uploaded")

    def test_private_release_updates_existing_video_and_replays_without_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            render, publish = publish_contracts(directory)
            store = PublishReceiptStore(str(Path(directory) / "receipts.json"))
            upload_calls = []

            def upload(*args):
                upload_calls.append(args)
                return {"video_id": "youtube-private", "privacy_status": "private"}

            publish_reviewed_short(
                publish,
                render,
                store,
                expected_channel_id="channel123",
                authenticated_channel={"id": "channel123"},
                upload=upload,
            )
            updates = []

            def update(video_id, privacy):
                updates.append((video_id, privacy))
                return {"video_id": video_id, "privacy_status": privacy}

            release_options = dict(
                receipt_store=store,
                youtube_video_id="youtube-private",
                expected_channel_id="channel123",
                authenticated_channel={"id": "channel123"},
                update_privacy=update,
                public_release_approved=True,
                now=lambda: datetime(2026, 7, 17, 12, 0, tzinfo=timezone.utc),
            )
            first = release_uploaded_short(**release_options)
            second = release_uploaded_short(**release_options)

            self.assertFalse(first["replayed"])
            self.assertTrue(second["replayed"])
            self.assertEqual(updates, [("youtube-private", "public")])
            self.assertEqual(len(upload_calls), 1)
            self.assertEqual(store.find_by_video_id("youtube-private")["privacyStatus"], "private")
            stored_release = store.find_release(first["releaseKey"])
            self.assertIs(
                verify_seal(stored_release, "VideoReleaseReceipt"),
                stored_release,
            )

    def test_pending_release_reconciles_public_state_without_second_update(self):
        with tempfile.TemporaryDirectory() as directory:
            render, publish = publish_contracts(directory)
            store = CrashAfterReleaseStore(str(Path(directory) / "receipts.json"))
            publish_reviewed_short(
                publish,
                render,
                store,
                expected_channel_id="channel123",
                authenticated_channel={"id": "channel123"},
                upload=lambda *_args: {
                    "video_id": "youtube-release-crash",
                    "privacy_status": "private",
                },
            )
            updates = []

            def update(video_id, privacy):
                updates.append((video_id, privacy))
                return {"video_id": video_id, "privacy_status": privacy}

            options = dict(
                receipt_store=store,
                youtube_video_id="youtube-release-crash",
                expected_channel_id="channel123",
                authenticated_channel={"id": "channel123"},
                update_privacy=update,
                public_release_approved=True,
            )
            with self.assertRaisesRegex(OSError, "simulated crash"):
                release_uploaded_short(**options)

            recovered = release_uploaded_short(
                **options,
                inspect_video=lambda video_id: {
                    "video_id": video_id,
                    "channel_id": "channel123",
                    "privacy_status": "public",
                },
            )

            self.assertTrue(recovered["replayed"])
            self.assertTrue(recovered["reconciled"])
            self.assertEqual(updates, [("youtube-release-crash", "public")])


if __name__ == "__main__":
    unittest.main()
