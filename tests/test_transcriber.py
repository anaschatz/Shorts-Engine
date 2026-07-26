import json
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from shorts_generator.local.transcriber import (
    _cache_matches,
    _cache_metadata,
    _decode_audio_with_ffmpeg,
    _hash_file_sha256,
    _legacy_cache_metadata,
    _migrate_legacy_word_cache,
    _source_sha256,
    _write_word_cache,
    _word_cache_path,
    transcribe_local,
)
from shorts_generator.performance import PerformanceTelemetry


class WordTranscriptCacheTests(unittest.TestCase):
    @staticmethod
    def _exact_transcript(cache_metadata):
        return {
            "duration": 1.0,
            "segments": [
                {
                    "start": 0.1,
                    "end": 0.8,
                    "text": "Exact words",
                    "words": [
                        {"word": "Exact", "start": 0.1, "end": 0.4},
                        {"word": "words", "start": 0.5, "end": 0.8},
                    ],
                }
            ],
            "_cache": cache_metadata,
        }

    def test_migrates_exact_legacy_word_cache_without_whisper(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy_dir = root / "desktop-output"
            local_source_dir = root / "source-cache"
            transcript_dir = root / "transcript-cache"
            legacy_dir.mkdir()
            local_source_dir.mkdir()
            legacy_media = legacy_dir / "source_video_1080p.mp4"
            local_media = local_source_dir / legacy_media.name
            legacy_media.write_bytes(b"same-video")
            local_media.write_bytes(legacy_media.read_bytes())

            with (
                patch(
                    "shorts_generator.local.transcriber.LOCAL_OUTPUT_DIR",
                    str(legacy_dir),
                ),
                patch(
                    "shorts_generator.local.transcriber.LOCAL_TRANSCRIPT_CACHE_DIR",
                    str(transcript_dir),
                ),
            ):
                transcript = self._exact_transcript(
                    _legacy_cache_metadata(str(legacy_media), "en")
                )
                legacy_word = legacy_dir / "source_video_1080p.transcript.json"
                legacy_word.write_text(json.dumps(transcript), encoding="utf-8")
                migrated = _migrate_legacy_word_cache(str(local_media), "en")
                target = _word_cache_path(str(local_media), "en")
                self.assertIsNotNone(migrated)
                self.assertTrue(target.is_file())
                self.assertTrue(
                    _cache_matches(migrated, str(local_media), "en")
                )

    def test_content_cache_is_reused_after_identical_media_is_copied_and_renamed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache_dir = root / "transcript-cache"
            original = root / "original.mp4"
            copied = root / "renamed-copy.mov"
            original.write_bytes(b"byte-identical-media")
            copied.write_bytes(original.read_bytes())

            with patch(
                "shorts_generator.local.transcriber.LOCAL_TRANSCRIPT_CACHE_DIR",
                str(cache_dir),
            ):
                transcript = self._exact_transcript(
                    _cache_metadata(str(original), "en")
                )
                original_cache = _write_word_cache(
                    str(original),
                    transcript,
                    "en",
                )
                copied_cache = _word_cache_path(str(copied), "en")
                telemetry = PerformanceTelemetry(run_id="transcript-cache-test")
                reused = transcribe_local(
                    str(copied),
                    language="en",
                    telemetry=telemetry,
                )
                cache_counter = telemetry.finish()["cacheCounters"]["transcript"]

            self.assertEqual(original_cache, copied_cache)
            self.assertEqual(reused, transcript)
            self.assertEqual(
                reused["segments"][0]["words"],
                transcript["segments"][0]["words"],
            )
            self.assertEqual(cache_counter["hits"], 1)
            self.assertEqual(cache_counter["misses"], 0)

    def test_legacy_migration_does_not_trust_matching_filename(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy_dir = root / "desktop-output"
            source_dir = root / "source-cache"
            transcript_dir = root / "transcript-cache"
            legacy_dir.mkdir()
            source_dir.mkdir()
            legacy_media = legacy_dir / "source.mp4"
            current_media = source_dir / "source.mp4"
            legacy_media.write_bytes(b"original")
            current_media.write_bytes(b"different")

            with (
                patch(
                    "shorts_generator.local.transcriber.LOCAL_OUTPUT_DIR",
                    str(legacy_dir),
                ),
                patch(
                    "shorts_generator.local.transcriber.LOCAL_TRANSCRIPT_CACHE_DIR",
                    str(transcript_dir),
                ),
            ):
                transcript = self._exact_transcript(
                    _legacy_cache_metadata(str(legacy_media), "en")
                )
                legacy_word = legacy_dir / "source.transcript.json"
                legacy_word.write_text(json.dumps(transcript), encoding="utf-8")
                migrated = _migrate_legacy_word_cache(str(current_media), "en")

            self.assertIsNone(migrated)

    def test_source_fingerprint_avoids_rehash_until_file_stat_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache_dir = root / "transcript-cache"
            media = root / "source.mp4"
            media.write_bytes(b"first-media")

            with (
                patch(
                    "shorts_generator.local.transcriber.LOCAL_TRANSCRIPT_CACHE_DIR",
                    str(cache_dir),
                ),
                patch(
                    "shorts_generator.local.transcriber._hash_file_sha256",
                    wraps=_hash_file_sha256,
                ) as hasher,
            ):
                first = _source_sha256(str(media))
                second = _source_sha256(str(media))
                media.write_bytes(b"updated-media")
                third = _source_sha256(str(media))

            self.assertEqual(first, second)
            self.assertNotEqual(second, third)
            self.assertEqual(hasher.call_count, 2)

    def test_cache_requires_matching_source_model_language_and_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "source.mp4"
            cache_dir = root / "transcript-cache"
            media.write_bytes(b"media")
            with patch(
                "shorts_generator.local.transcriber.LOCAL_TRANSCRIPT_CACHE_DIR",
                str(cache_dir),
            ):
                transcript = self._exact_transcript(
                    _cache_metadata(str(media), "en")
                )
                self.assertTrue(_cache_matches(transcript, str(media), "en"))
                self.assertFalse(_cache_matches(transcript, str(media), "el"))
                with patch(
                    "shorts_generator.local.transcriber.LOCAL_WHISPER_MODEL",
                    "different-model",
                ):
                    self.assertFalse(_cache_matches(transcript, str(media), "en"))
                with patch(
                    "shorts_generator.local.transcriber.TRANSCRIPT_CACHE_SCHEMA_VERSION",
                    4,
                ):
                    self.assertFalse(_cache_matches(transcript, str(media), "en"))

    def test_cache_rejects_segment_only_transcript(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "source.mp4"
            cache_dir = root / "transcript-cache"
            media.write_bytes(b"media")
            with patch(
                "shorts_generator.local.transcriber.LOCAL_TRANSCRIPT_CACHE_DIR",
                str(cache_dir),
            ):
                transcript = {
                    "duration": 1.0,
                    "segments": [{"start": 0.0, "end": 1.0, "text": "No words"}],
                    "_cache": _cache_metadata(str(media), None),
                }
                self.assertFalse(_cache_matches(transcript, str(media), None))

    def test_ffmpeg_decoder_returns_mono_float32_waveform(self):
        calls = []

        def fake_runner(command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(stdout=struct.pack("<ff", 0.25, -0.5), stderr=b"")

        audio = _decode_audio_with_ffmpeg(
            "source.mp4",
            sampling_rate=16000,
            runner=fake_runner,
        )

        self.assertEqual(audio.dtype.str, "<f4")
        self.assertEqual(audio.tolist(), [0.25, -0.5])
        command, kwargs = calls[0]
        self.assertEqual(command[0], "ffmpeg")
        self.assertIn("source.mp4", command)
        self.assertIn("16000", command)
        self.assertIn("f32le", command)
        self.assertTrue(kwargs["check"])
        self.assertTrue(kwargs["capture_output"])

    def test_ffmpeg_decoder_fails_closed_on_empty_audio(self):
        def fake_runner(command, **kwargs):
            return SimpleNamespace(stdout=b"", stderr=b"")

        with self.assertRaisesRegex(RuntimeError, "no decodable audio"):
            _decode_audio_with_ffmpeg("silent.mp4", runner=fake_runner)

    def test_ffmpeg_decoder_reports_process_error(self):
        def fake_runner(command, **kwargs):
            raise subprocess.CalledProcessError(
                1,
                command,
                stderr=b"invalid media",
            )

        with self.assertRaisesRegex(RuntimeError, "invalid media"):
            _decode_audio_with_ffmpeg("broken.mp4", runner=fake_runner)


if __name__ == "__main__":
    unittest.main()
