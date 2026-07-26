import tempfile
import unittest
from pathlib import Path

from shorts_generator.youtube_uploader import (
    YouTubeMetadata,
    build_short_metadata,
    find_video_by_upload_marker,
    load_metadata_file,
    normalize_publish_at,
    resumable_upload,
    update_video_privacy,
    upload_video,
    verify_authenticated_channel,
)


class FakeExecute:
    def __init__(self, payload):
        self.payload = payload

    def execute(self):
        return self.payload


class FakeChannels:
    def __init__(self, payload):
        self.payload = payload
        self.kwargs = None

    def list(self, **kwargs):
        self.kwargs = kwargs
        return FakeExecute(self.payload)


class FakeYouTubeChannel:
    def __init__(self, custom_url="@BudgetFriendlyShorts"):
        self.resource = FakeChannels(
            {
                "items": [
                    {
                        "id": "channel-123",
                        "snippet": {
                            "title": "Budget Friendly",
                            "customUrl": custom_url,
                        },
                    }
                ]
            }
        )

    def channels(self):
        return self.resource


class FakeStatus:
    def __init__(self, value):
        self.value = value

    def progress(self):
        return self.value


class FakeUploadRequest:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)

    def next_chunk(self):
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class FakeVideos:
    def __init__(self, request):
        self.request = request
        self.insert_kwargs = None

    def insert(self, **kwargs):
        self.insert_kwargs = kwargs
        return self.request


class FakeYouTubeUpload:
    def __init__(self, request):
        self.resource = FakeVideos(request)

    def videos(self):
        return self.resource


class FakeVideosUpdate:
    def __init__(self, video_id, status):
        self.video_id = video_id
        self.status = status
        self.update_kwargs = None
        self.list_kwargs = None

    def list(self, **kwargs):
        self.list_kwargs = kwargs
        return FakeExecute(
            {"items": [{"id": self.video_id, "status": dict(self.status)}]}
        )

    def update(self, **kwargs):
        self.update_kwargs = kwargs
        return FakeExecute(
            {
                "id": kwargs["body"]["id"],
                "status": dict(kwargs["body"]["status"]),
            }
        )


class FakeYouTubeUpdate:
    def __init__(self, video_id, status):
        self.resource = FakeVideosUpdate(video_id, status)

    def videos(self):
        return self.resource


class FakeYouTubeReconcile:
    def __init__(self, marker):
        self.marker = marker

    def channels(self):
        class Channels:
            def list(_self, **_kwargs):
                return FakeExecute(
                    {
                        "items": [
                            {
                                "id": "channel-123",
                                "contentDetails": {
                                    "relatedPlaylists": {"uploads": "uploads-123"}
                                },
                            }
                        ]
                    }
                )

        return Channels()

    def playlistItems(self):
        class PlaylistItems:
            def list(_self, **_kwargs):
                return FakeExecute(
                    {
                        "items": [
                            {"contentDetails": {"videoId": "video-123"}}
                        ]
                    }
                )

        return PlaylistItems()

    def videos(self):
        marker = self.marker

        class Videos:
            def list(_self, **_kwargs):
                return FakeExecute(
                    {
                        "items": [
                            {
                                "id": "video-123",
                                "snippet": {
                                    "channelId": "channel-123",
                                    "title": "A private short",
                                    "tags": ["shorts", marker],
                                },
                                "status": {"privacyStatus": "private"},
                            }
                        ]
                    }
                )

        return Videos()


class YouTubeUploaderTests(unittest.TestCase):
    def test_metadata_file_extracts_title_description_and_hashtags(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metadata.txt"
            path.write_text(
                "TITLE\nDoing LESS Builds CONSISTENCY!\n\n"
                "DESCRIPTION\nBuild habits that last.\n\n#motivation #shorts\n",
                encoding="utf-8",
            )

            metadata = load_metadata_file(str(path))

        self.assertEqual(metadata.title, "Doing LESS Builds CONSISTENCY!")
        self.assertEqual(metadata.tags, ("motivation", "shorts"))
        self.assertIn("Build habits", metadata.description)

    def test_generated_metadata_preserves_source_attribution(self):
        metadata = build_short_metadata(
            {"title": "Discipline", "thesis": "Discipline creates freedom."},
            source_url="https://youtube.test/source",
        )

        self.assertEqual(metadata.title, "Discipline")
        self.assertIn("Source: https://youtube.test/source", metadata.description)
        self.assertTrue(metadata.description.endswith("#shorts"))

    def test_expected_channel_handle_is_verified_before_upload(self):
        channel = verify_authenticated_channel(
            FakeYouTubeChannel(),
            expected_handle="@BudgetFriendlyShorts",
        )

        self.assertEqual(channel["id"], "channel-123")
        self.assertEqual(channel["title"], "Budget Friendly")

    def test_wrong_authenticated_channel_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "does not match"):
            verify_authenticated_channel(
                FakeYouTubeChannel(custom_url="@WrongChannel"),
                expected_handle="@BudgetFriendlyShorts",
            )

    def test_resumable_upload_retries_transport_error_without_new_request(self):
        sleeps = []
        request = FakeUploadRequest(
            [
                OSError("temporary disconnect"),
                (FakeStatus(0.5), None),
                (FakeStatus(1.0), {"id": "video-123"}),
            ]
        )

        response = resumable_upload(
            request,
            sleep=sleeps.append,
            random_value=lambda: 0.0,
        )

        self.assertEqual(response["id"], "video-123")
        self.assertEqual(sleeps, [0.0])

    def test_upload_uses_private_audience_safe_resource_by_default(self):
        request = FakeUploadRequest([(FakeStatus(1.0), {"id": "video-123"})])
        youtube = FakeYouTubeUpload(request)
        media_calls = []

        def media_factory(*args, **kwargs):
            media_calls.append((args, kwargs))
            return "media-body"

        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.write_bytes(b"fake-video")
            result = upload_video(
                youtube,
                str(video),
                YouTubeMetadata(
                    title="Doing Less",
                    description="A complete thought.",
                    tags=("shorts",),
                ),
                media_factory=media_factory,
                upload_marker="bf_publish_test_marker",
            )

        body = youtube.resource.insert_kwargs["body"]
        self.assertEqual(body["status"]["privacyStatus"], "private")
        self.assertFalse(body["status"]["selfDeclaredMadeForKids"])
        self.assertFalse(body["status"]["containsSyntheticMedia"])
        self.assertIn("bf_publish_test_marker", body["snippet"]["tags"])
        self.assertFalse(youtube.resource.insert_kwargs["notifySubscribers"])
        self.assertTrue(media_calls[0][1]["resumable"])
        self.assertEqual(result["url"], "https://www.youtube.com/watch?v=video-123")

    def test_upload_can_schedule_a_private_video_with_timezone_normalization(self):
        request = FakeUploadRequest([(FakeStatus(1.0), {"id": "video-123"})])
        youtube = FakeYouTubeUpload(request)

        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.write_bytes(b"fake-video")
            result = upload_video(
                youtube,
                str(video),
                YouTubeMetadata(
                    title="Scheduled Short",
                    description="#shorts",
                ),
                publish_at="2026-07-20T22:00:00+03:00",
                media_factory=lambda *_args, **_kwargs: "media-body",
            )

        body = youtube.resource.insert_kwargs["body"]
        self.assertEqual(body["status"]["privacyStatus"], "private")
        self.assertEqual(body["status"]["publishAt"], "2026-07-20T19:00:00Z")
        self.assertEqual(result["publish_at"], "2026-07-20T19:00:00Z")

    def test_schedule_requires_private_privacy_and_explicit_timezone(self):
        self.assertEqual(
            normalize_publish_at("2026-07-20T22:00:00+03:00"),
            "2026-07-20T19:00:00Z",
        )
        with self.assertRaisesRegex(ValueError, "explicit timezone"):
            normalize_publish_at("2026-07-20T22:00:00")

        request = FakeUploadRequest([(FakeStatus(1.0), {"id": "video-123"})])
        youtube = FakeYouTubeUpload(request)
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.write_bytes(b"fake-video")
            with self.assertRaisesRegex(ValueError, "must use private"):
                upload_video(
                    youtube,
                    str(video),
                    YouTubeMetadata(
                        title="Scheduled Short",
                        description="#shorts",
                    ),
                    privacy_status="public",
                    publish_at="2026-07-20T22:00:00+03:00",
                    media_factory=lambda *_args, **_kwargs: "media-body",
                )

    def test_privacy_update_preserves_existing_mutable_status_fields(self):
        youtube = FakeYouTubeUpdate(
            "video-123",
            {
                "privacyStatus": "private",
                "containsSyntheticMedia": False,
                "embeddable": False,
                "license": "youtube",
                "publicStatsViewable": False,
                "selfDeclaredMadeForKids": True,
                "madeForKids": True,
                "uploadStatus": "processed",
            },
        )

        result = update_video_privacy(youtube, "video-123", "public")

        self.assertEqual(result["privacy_status"], "public")
        self.assertEqual(
            youtube.resource.update_kwargs["body"]["status"],
            {
                "containsSyntheticMedia": False,
                "embeddable": False,
                "license": "youtube",
                "publicStatsViewable": False,
                "selfDeclaredMadeForKids": True,
                "privacyStatus": "public",
            },
        )
        self.assertNotIn("madeForKids", youtube.resource.update_kwargs["body"]["status"])
        self.assertNotIn("uploadStatus", youtube.resource.update_kwargs["body"]["status"])

    def test_upload_marker_reconciles_exact_video_without_inserting(self):
        marker = "bf_publish_" + ("a" * 64)
        video = find_video_by_upload_marker(
            FakeYouTubeReconcile(marker),
            "channel-123",
            marker,
        )

        self.assertEqual(video["video_id"], "video-123")
        self.assertEqual(video["privacy_status"], "private")
        self.assertEqual(video["upload_marker"], marker)


if __name__ == "__main__":
    unittest.main()
