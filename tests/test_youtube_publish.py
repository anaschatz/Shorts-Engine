import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("youtube_publish", ROOT / "tools" / "youtube_publish.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class YouTubePublishTests(unittest.TestCase):
    def test_fifa_manifest_has_twenty_unique_valid_items(self):
        manifest, items = MODULE.validate_manifest(ROOT / "publishing" / "youtube-fifa20.json")
        self.assertEqual(manifest["defaultPrivacy"], "private")
        self.assertEqual(len(items), 20)
        self.assertEqual(len({item["id"] for item in items}), 20)
        self.assertEqual(sum(bool(item["qaAcceptedWithoutEdit"]) for item in items), 6)
        for item in items:
            self.assertLessEqual(len(item["title"]), 100)
            self.assertIn("#Shorts", item["description"])
            self.assertIn("#Football", item["description"])

    def test_video_body_uses_sports_category_and_requested_privacy(self):
        _, items = MODULE.validate_manifest(ROOT / "publishing" / "youtube-fifa20.json")
        body = MODULE.build_video_body(items[0], "unlisted")
        self.assertEqual(body["snippet"]["categoryId"], "17")
        self.assertEqual(body["status"]["privacyStatus"], "unlisted")
        self.assertFalse(body["status"]["selfDeclaredMadeForKids"])

    def test_public_visibility_requires_explicit_confirmation(self):
        _, items = MODULE.validate_manifest(ROOT / "publishing" / "youtube-fifa20.json")
        with self.assertRaises(MODULE.PublishError):
            MODULE.validate_visibility(items, "public", True, False)
        with self.assertRaises(MODULE.PublishError):
            MODULE.validate_visibility(items, "public", False, True)
        MODULE.validate_visibility(items, "public", True, True)

    def test_state_writer_is_atomic_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            MODULE.atomic_write_json(path, {"schemaVersion": 1, "uploads": {}})
            self.assertEqual(json.loads(path.read_text())["schemaVersion"], 1)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_import_client_rejects_incomplete_desktop_config(self):
        incomplete = {"installed": {"client_id": "client-id"}}
        required = ("client_id", "client_secret", "auth_uri", "token_uri", "redirect_uris")
        self.assertTrue(any(not incomplete["installed"].get(key) for key in required))

    def test_google_error_reason_extracts_upload_limit(self):
        error = type(
            "FakeGoogleError",
            (),
            {"content": b'{"error":{"errors":[{"reason":"uploadLimitExceeded"}]}}'},
        )()
        self.assertEqual(MODULE.google_error_reason(error), "uploadLimitExceeded")

    def test_delete_scope_is_requested(self):
        self.assertIn("https://www.googleapis.com/auth/youtube.force-ssl", MODULE.SCOPES)

    def test_publish_scopes_match_existing_upload_authorization(self):
        self.assertEqual(
            MODULE.PUBLISH_SCOPES,
            (
                "https://www.googleapis.com/auth/youtube.upload",
                "https://www.googleapis.com/auth/youtube.readonly",
            ),
        )


if __name__ == "__main__":
    unittest.main()
