import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shorts_generator.local.clipper import (
    _raw_video_command,
    _resolve_v4_viral_music_binding,
    crop_highlights_local,
)
from shorts_generator.music_router import route_music_for_candidate
from shorts_generator.profiles import (
    BF_EDITORIAL_INSET_V4,
    MUSIC_ROTATION_VERSION,
    SEMANTIC_MUSIC_ROUTER_VERSION,
    VIRAL_MUSIC_CATALOG_VERSION,
)


def _content_hash(value):
    body = {key: item for key, item in value.items() if key != "contentHash"}
    encoded = json.dumps(
        body,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class BfEditorialInsetV4RendererTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.repo_root = Path(self.temporary.name)
        music_dir = self.repo_root / "assets" / "music"
        music_dir.mkdir(parents=True)
        self.asset_bytes = b"sealed-v4-music-asset"
        self.asset_path = music_dir / "track.mp3"
        self.asset_path.write_bytes(self.asset_bytes)
        self.track = {
            "trackId": "pixabay:1",
            "relativePath": "assets/music/track.mp3",
            "title": "Fixture Track",
            "creator": "Fixture Creator",
            "sourcePageUrl": "https://pixabay.com/music/fixture-1/",
            "contentUrl": "https://cdn.pixabay.com/audio/fixture.mp3",
            "licenseUrl": "https://pixabay.com/service/license-summary/",
            "sha256": hashlib.sha256(self.asset_bytes).hexdigest(),
            "byteLength": len(self.asset_bytes),
            "durationSeconds": 120.0,
            "codec": "mp3",
            "sampleRate": 48000,
            "channels": 2,
            "aiGenerated": False,
            "contentIdRegistered": "unknown",
            "semanticFamilies": ["confidence"],
            "treatmentProfile": "driving",
            "recommendedOffsetSeconds": 12.5,
            "catalogOrder": 1,
        }
        self.catalog = self._write_catalog(self.track)
        semantic_candidate = {
            "background_music": True,
            "music_profile": "driving",
            "whole_point_summary": "Confidence and discipline reveal identity.",
        }
        self.decision = route_music_for_candidate(
            semantic_candidate,
            catalog_path=(
                self.repo_root / "assets" / "music" / "catalog.v1.json"
            ),
            catalog=self.catalog,
            repository_root=self.repo_root,
            verify_assets=True,
        )
        self.candidate = {
            **semantic_candidate,
            "musicRoutingDecision": self.decision,
            "musicCatalogTrack": self.track,
        }

    def tearDown(self):
        self.temporary.cleanup()

    def _write_catalog(self, track):
        catalog = {
            "schemaVersion": 1,
            "artifactType": "ViralMusicCatalog",
            "catalogVersion": VIRAL_MUSIC_CATALOG_VERSION,
            "licenseUrl": "https://pixabay.com/service/license-summary/",
            "retrievedAt": "2026-08-08T00:00:00Z",
            "sourceReplacement": {
                "explicit": True,
                "requestedTrack": {
                    "title": "Unavailable fixture",
                    "sourcePageUrl": "https://pixabay.com/music/unavailable-2/",
                    "pixabayContentId": 2,
                },
                "replacementTrackId": track["trackId"],
                "note": "Explicit test-only replacement.",
            },
            "tracks": [track],
        }
        catalog["contentHash"] = _content_hash(catalog)
        path = self.repo_root / "assets" / "music" / "catalog.v1.json"
        path.write_text(
            json.dumps(catalog, indent=2, ensure_ascii=True) + "\n",
            encoding="utf-8",
        )
        return catalog

    @staticmethod
    def _seal_decision(body):
        decision = dict(body)
        decision["contentHash"] = _content_hash(decision)
        return decision

    def _resolve(self, candidate=None):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch(
                "shorts_generator.local.clipper.LOCAL_MOTIVATIONAL_MUSIC_TRACK",
                "",
            ),
            patch(
                "shorts_generator.local.clipper.LOCAL_MOTIVATIONAL_MUSIC_PROFILE",
                "auto",
            ),
            patch(
                "shorts_generator.local.clipper.LOCAL_MOTIVATIONAL_MUSIC_START_SECONDS",
                8.0,
            ),
            patch(
                "shorts_generator.local.clipper.VIRAL_MUSIC_CATALOG_CONTENT_HASH",
                self.catalog["contentHash"],
            ),
        ):
            return _resolve_v4_viral_music_binding(
                self.candidate if candidate is None else candidate,
                repo_root=self.repo_root,
            )

    def test_resolves_one_verified_path_profile_offset_and_receipt(self):
        binding = self._resolve()

        self.assertEqual(binding["path"], str(self.asset_path.resolve()))
        self.assertEqual(binding["profile"], "driving")
        self.assertEqual(binding["startSeconds"], 12.5)
        self.assertEqual(
            binding["assetReceipt"],
            {
                "assetId": f"sha256:{self.track['sha256']}",
                "sha256": self.track["sha256"],
                "byteLength": len(self.asset_bytes),
            },
        )
        receipt = binding["viralAssetReceipt"]
        self.assertEqual(receipt["trackId"], self.track["trackId"])
        self.assertEqual(receipt["catalogContentHash"], self.catalog["contentHash"])
        self.assertEqual(receipt["routingDecisionHash"], self.decision["contentHash"])
        self.assertTrue(receipt["verifiedBeforeFfmpeg"])

    def test_rejects_each_legacy_music_override(self):
        cases = (
            ("LOCAL_MOTIVATIONAL_MUSIC_TRACK", "/tmp/operator.mp3"),
            ("LOCAL_MOTIVATIONAL_MUSIC_PROFILE", "warm"),
            ("LOCAL_MOTIVATIONAL_MUSIC_START_SECONDS", 99.0),
        )
        for name, value in cases:
            with self.subTest(name=name):
                with (
                    patch.dict(os.environ, {}, clear=True),
                    patch("shorts_generator.local.clipper." + name, value),
                ):
                    with self.assertRaisesRegex(RuntimeError, name):
                        _resolve_v4_viral_music_binding(
                            self.candidate,
                            repo_root=self.repo_root,
                        )

    def test_rejects_a_resealed_but_unreviewed_catalog_hash(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch(
                "shorts_generator.local.clipper.LOCAL_MOTIVATIONAL_MUSIC_TRACK",
                "",
            ),
            patch(
                "shorts_generator.local.clipper.LOCAL_MOTIVATIONAL_MUSIC_PROFILE",
                "auto",
            ),
            patch(
                "shorts_generator.local.clipper.LOCAL_MOTIVATIONAL_MUSIC_START_SECONDS",
                8.0,
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "unauthorized"):
                _resolve_v4_viral_music_binding(
                    self.candidate,
                    repo_root=self.repo_root,
                )

    def test_rejects_tampered_asset_and_routing_bindings(self):
        self.asset_path.write_bytes(self.asset_bytes + b"tampered")
        with self.assertRaisesRegex(RuntimeError, "sha256|byteLength"):
            self._resolve()

        self.asset_path.write_bytes(self.asset_bytes)
        wrong_start = dict(self.decision)
        wrong_start["startSeconds"] = 13.0
        wrong_start = self._seal_decision(wrong_start)
        candidate = {**self.candidate, "musicRoutingDecision": wrong_start}
        with self.assertRaisesRegex(RuntimeError, "startSeconds.*catalog"):
            self._resolve(candidate)

        wrong_catalog_hash = dict(self.decision)
        wrong_catalog_hash["catalogContentHash"] = "0" * 64
        wrong_catalog_hash = self._seal_decision(wrong_catalog_hash)
        candidate = {**self.candidate, "musicRoutingDecision": wrong_catalog_hash}
        with self.assertRaisesRegex(RuntimeError, "another catalog"):
            self._resolve(candidate)

    def test_rejects_semantic_transplant_and_sibling_track_mutation(self):
        transplanted = {
            **self.candidate,
            "whole_point_summary": "A completely different relationship point.",
        }
        with self.assertRaisesRegex(RuntimeError, "other semantics"):
            self._resolve(transplanted)

        changed_track = {**self.track, "title": "Mutated sibling metadata"}
        changed_sibling = {
            **self.candidate,
            "musicCatalogTrack": changed_track,
        }
        with self.assertRaisesRegex(RuntimeError, "does not match the sealed"):
            self._resolve(changed_sibling)

    def test_invalid_v4_binding_fails_before_prewarm_or_ffmpeg_boundary(self):
        highlight = {"render_profile": BF_EDITORIAL_INSET_V4}
        with (
            tempfile.TemporaryDirectory() as output_dir,
            patch(
                "shorts_generator.local.clipper._resolve_v4_viral_music_binding",
                side_effect=RuntimeError("V4 music asset sha256 mismatch"),
            ),
            patch(
                "shorts_generator.local.clipper._prewarm_bf_editorial_realesrgan_cache"
            ) as prewarm,
            patch("shorts_generator.local.clipper.crop_clip_local") as render,
        ):
            with self.assertRaisesRegex(RuntimeError, "sha256 mismatch"):
                crop_highlights_local(
                    "source.mp4",
                    [highlight],
                    out_dir=output_dir,
                    render_profile=BF_EDITORIAL_INSET_V4,
                )

        prewarm.assert_not_called()
        render.assert_not_called()

    def test_v4_threads_verified_route_into_plan_command_and_metadata(self):
        asset_receipt = {
            "assetId": "sha256:" + "a" * 64,
            "sha256": "a" * 64,
            "byteLength": 123,
        }
        viral_receipt = {
            **asset_receipt,
            "trackId": "pixabay:1",
            "catalogVersion": VIRAL_MUSIC_CATALOG_VERSION,
            "relativePath": "assets/music/track.mp3",
            "sourcePageUrl": "https://pixabay.com/music/fixture-1/",
            "licenseUrl": "https://pixabay.com/service/license-summary/",
            "startSeconds": 12.5,
        }
        binding = {
            "path": "/repo/assets/music/track.mp3",
            "profile": "driving",
            "startSeconds": 12.5,
            "assetReceipt": asset_receipt,
            "viralAssetReceipt": viral_receipt,
            "routingDecision": self.decision,
        }
        transcript = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 10.75,
                    "words": [{"word": "Truth.", "start": 0.0, "end": 0.3}],
                }
            ]
        }
        highlight = {
            "title": "Sealed route",
            "start_time": 0.0,
            "end_time": 10.75,
            "speech_end_time": 0.3,
            "render_profile": BF_EDITORIAL_INSET_V4,
            "background_music": True,
        }
        with (
            tempfile.TemporaryDirectory() as output_dir,
            patch(
                "shorts_generator.local.clipper._resolve_v4_viral_music_binding",
                return_value=binding,
            ) as resolve,
            patch(
                "shorts_generator.local.clipper._prewarm_bf_editorial_realesrgan_cache"
            ),
            patch(
                "shorts_generator.local.clipper.crop_clip_local",
                return_value="/tmp/short.mp4",
            ) as render,
        ):
            [result] = crop_highlights_local(
                "source.mp4",
                [highlight],
                out_dir=output_dir,
                transcript=transcript,
                render_profile=BF_EDITORIAL_INSET_V4,
            )

        resolve.assert_called_once_with(highlight)
        kwargs = render.call_args.kwargs
        self.assertEqual(kwargs["resolved_music_path"], binding["path"])
        self.assertEqual(kwargs["resolved_music_start_seconds"], 12.5)
        self.assertEqual(kwargs["music_profile"], "driving")
        self.assertEqual(kwargs["dynamic_music_plan"]["musicProfile"], "driving")
        self.assertEqual(result["dynamic_music_asset_receipt"], asset_receipt)
        self.assertEqual(result["viral_music_asset_receipt"], viral_receipt)
        self.assertEqual(result["music_routing_decision"], self.decision)
        self.assertTrue(result["dynamic_music_applied"])

        command = _raw_video_command(
            "cut.mkv",
            "short.mp4",
            (1080, 1920),
            30.0,
            duration=10.0,
            music_path=binding["path"],
            music_start_seconds=binding["startSeconds"],
            music_profile=binding["profile"],
            dynamic_music_plan=kwargs["dynamic_music_plan"],
        )
        start_index = command.index("-ss")
        self.assertEqual(command[start_index + 1], "12.500")
        self.assertEqual(command[start_index + 2], "-i")
        self.assertEqual(command[start_index + 3], binding["path"])


if __name__ == "__main__":
    unittest.main()
