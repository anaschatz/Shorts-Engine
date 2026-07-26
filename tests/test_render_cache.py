import errno
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from shorts_generator.render_cache import (
    CACHE_SCHEMA_VERSION,
    RenderCache,
    RenderCacheError,
    build_render_cache_key,
    file_sha256,
)


SOURCE_HASH = "a" * 64
EDIT_PLAN_HASH = "b" * 64
FONT_HASH = "c" * 64
MUSIC_HASH = "d" * 64


def cache_key(**changes):
    values = {
        "source_hash": SOURCE_HASH,
        "edit_plan_hash": EDIT_PLAN_HASH,
        "renderer_fingerprint": "clipper.py@renderer-v7",
        "renderer_config": {
            "fps": 30,
            "layout": {"height": 1920, "width": 1080},
            "captions": ["kinetic", "persistent"],
        },
        "asset_hashes": {
            "font/Inter-Bold.ttf": FONT_HASH,
            "music/bed.wav": MUSIC_HASH,
        },
    }
    values.update(changes)
    return build_render_cache_key(**values)


class RenderCacheKeyTests(unittest.TestCase):
    def test_key_is_order_independent_and_changes_with_every_render_input(self):
        first = cache_key()
        second = build_render_cache_key(
            source_hash=f"sha256:{SOURCE_HASH.upper()}",
            edit_plan_hash=EDIT_PLAN_HASH,
            renderer_fingerprint="clipper.py@renderer-v7",
            renderer_config={
                "captions": ("kinetic", "persistent"),
                "layout": {"width": 1080, "height": 1920},
                "fps": 30,
            },
            asset_hashes={
                "music/bed.wav": MUSIC_HASH,
                "font/Inter-Bold.ttf": FONT_HASH,
            },
        )
        self.assertEqual(first, second)
        self.assertNotEqual(first, cache_key(source_hash="e" * 64))
        self.assertNotEqual(first, cache_key(edit_plan_hash="e" * 64))
        self.assertNotEqual(
            first,
            cache_key(renderer_fingerprint="clipper.py@renderer-v8"),
        )
        self.assertNotEqual(
            first,
            cache_key(
                renderer_config={
                    "fps": 60,
                    "layout": {"height": 1920, "width": 1080},
                    "captions": ["kinetic", "persistent"],
                }
            ),
        )
        self.assertNotEqual(
            first,
            cache_key(
                asset_hashes={
                    "font/Inter-Bold.ttf": "e" * 64,
                    "music/bed.wav": MUSIC_HASH,
                }
            ),
        )

    def test_key_rejects_ambiguous_or_incomplete_inputs(self):
        with self.assertRaisesRegex(ValueError, "renderer_fingerprint"):
            cache_key(renderer_fingerprint="")
        with self.assertRaisesRegex(ValueError, "source_hash"):
            cache_key(source_hash="not-a-hash")
        with self.assertRaisesRegex(ValueError, "non-finite"):
            cache_key(renderer_config={"value": float("nan")})
        with self.assertRaisesRegex(TypeError, "unsupported"):
            cache_key(renderer_config={"value": {1, 2}})


class RenderCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.cache = RenderCache(self.root / "cache")
        self.key = cache_key()

    def tearDown(self):
        self.temporary_directory.cleanup()

    def render(self, name="render.mp4", content=b"production-render-bytes"):
        path = self.root / name
        path.write_bytes(content)
        return path

    def metadata_path(self):
        return (
            self.root
            / "cache"
            / "entries"
            / self.key[:2]
            / f"{self.key}.json"
        )

    def test_store_and_lookup_validate_exact_render_bytes(self):
        source = self.render()
        entry = self.cache.store(
            self.key,
            source,
            metadata={"short": {"brand_tail_seconds": 0.3}},
        )
        source.write_bytes(b"later-source-mutation")

        hit = self.cache.lookup(self.key)

        self.assertIsNotNone(hit)
        self.assertEqual(hit, entry)
        self.assertEqual(hit.cached_path.read_bytes(), b"production-render-bytes")
        self.assertEqual(hit.output_sha256, file_sha256(hit.cached_path))
        self.assertEqual(hit.size_bytes, len(b"production-render-bytes"))
        self.assertEqual(
            hit.metadata,
            {"short": {"brand_tail_seconds": 0.3}},
        )
        metadata = json.loads(self.metadata_path().read_text(encoding="utf-8"))
        self.assertEqual(metadata["schemaVersion"], CACHE_SCHEMA_VERSION)
        self.assertEqual(metadata["cacheKey"], self.key)
        self.assertEqual(metadata["outputSha256"], hit.output_sha256)
        self.assertEqual(metadata["sizeBytes"], hit.size_bytes)
        self.assertEqual(metadata["metadata"], hit.metadata)
        self.assertEqual(len(metadata["metadataSha256"]), 64)

    def test_lookup_rejects_corrupt_blob_and_tampered_metadata(self):
        entry = self.cache.store(self.key, self.render())
        entry.cached_path.write_bytes(b"corrupt")
        self.assertIsNone(self.cache.lookup(self.key))

        repaired = self.cache.store(self.key, self.render("repair.mp4", b"repaired"))
        metadata = json.loads(self.metadata_path().read_text(encoding="utf-8"))
        metadata["sizeBytes"] = repaired.size_bytes + 1
        self.metadata_path().write_text(json.dumps(metadata), encoding="utf-8")
        self.assertIsNone(self.cache.lookup(self.key))

        metadata["sizeBytes"] = repaired.size_bytes
        metadata["cacheKey"] = "e" * 64
        self.metadata_path().write_text(json.dumps(metadata), encoding="utf-8")
        self.assertIsNone(self.cache.lookup(self.key))

    def test_lookup_rejects_corrupt_cached_metadata(self):
        self.cache.store(
            self.key,
            self.render(),
            metadata={"short": {"brand_tail_seconds": 0.3}},
        )
        metadata = json.loads(self.metadata_path().read_text(encoding="utf-8"))
        metadata["metadata"]["short"]["brand_tail_seconds"] = 9.0
        self.metadata_path().write_text(json.dumps(metadata), encoding="utf-8")

        self.assertIsNone(self.cache.lookup(self.key))

    def test_materialize_atomically_replaces_output_with_a_hardlink(self):
        entry = self.cache.store(self.key, self.render())
        destination = self.root / "outputs" / "short.mp4"
        destination.parent.mkdir()
        destination.write_bytes(b"old-output")

        result = self.cache.materialize(self.key, destination)

        self.assertEqual(result, destination)
        self.assertEqual(destination.read_bytes(), entry.cached_path.read_bytes())
        self.assertEqual(destination.stat().st_ino, entry.cached_path.stat().st_ino)
        self.assertFalse(list(destination.parent.glob(".*.tmp")))

    def test_materialize_falls_back_to_verified_atomic_copy(self):
        entry = self.cache.store(self.key, self.render())
        destination = self.root / "outputs" / "short.mp4"
        with mock.patch(
            "shorts_generator.render_cache.os.link",
            side_effect=OSError(errno.EXDEV, "cross-device link"),
        ):
            result = self.cache.materialize(self.key, destination)

        self.assertEqual(result, destination)
        self.assertEqual(file_sha256(destination), entry.output_sha256)
        self.assertNotEqual(destination.stat().st_ino, entry.cached_path.stat().st_ino)
        self.assertFalse(list(destination.parent.glob(".*.tmp")))

    def test_cache_miss_does_not_replace_existing_output(self):
        destination = self.root / "short.mp4"
        destination.write_bytes(b"keep-me")

        self.assertIsNone(self.cache.materialize(self.key, destination))
        self.assertEqual(destination.read_bytes(), b"keep-me")

    def test_concurrent_writers_leave_one_valid_complete_entry(self):
        first = self.render("first.mp4", b"A" * 4096)
        second = self.render("second.mp4", b"B" * 8192)
        barrier = threading.Barrier(2)
        errors = []

        def store(path):
            try:
                barrier.wait()
                self.cache.store(self.key, path)
            except BaseException as error:  # pragma: no cover - surfaced below
                errors.append(error)

        threads = [
            threading.Thread(target=store, args=(first,)),
            threading.Thread(target=store, args=(second,)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [])
        hit = self.cache.lookup(self.key)
        self.assertIsNotNone(hit)
        self.assertIn(hit.cached_path.read_bytes(), {first.read_bytes(), second.read_bytes()})
        self.assertEqual(hit.output_sha256, file_sha256(hit.cached_path))
        self.assertFalse(list((self.root / "cache").rglob("*.tmp")))

    def test_store_rejects_missing_empty_and_non_mp4_outputs(self):
        with self.assertRaisesRegex(RenderCacheError, "does not exist"):
            self.cache.store(self.key, self.root / "missing.mp4")
        with self.assertRaisesRegex(RenderCacheError, "empty"):
            self.cache.store(self.key, self.render("empty.mp4", b""))
        with self.assertRaisesRegex(RenderCacheError, r"\.mp4"):
            self.cache.store(self.key, self.render("render.mov"))
