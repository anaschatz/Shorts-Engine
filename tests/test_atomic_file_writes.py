import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shorts_generator.atomic_file import atomic_write_text
from shorts_generator.highlights import _atomic_write_json as write_highlight_json
from shorts_generator.local.transcriber import _atomic_write_text
from shorts_generator.local.youtube_captions import (
    _atomic_write_json as write_youtube_caption_json,
)


class AtomicFileWriteCharacterizationTests(unittest.TestCase):
    def test_existing_writers_preserve_their_exact_serialization_contracts(self):
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            highlight_path = root / "highlight" / "entry.json"
            caption_path = root / "caption" / "entry.json"
            transcript_path = root / "transcript" / "entry.json"
            payload = {"z": 1, "a": "β"}

            write_highlight_json(highlight_path, payload)
            write_youtube_caption_json(caption_path, payload)
            _atomic_write_text(transcript_path, "line one\nline two")

            self.assertEqual(
                highlight_path.read_text(encoding="utf-8"),
                '{\n  "a": "\\u03b2",\n  "z": 1\n}',
            )
            self.assertEqual(
                caption_path.read_text(encoding="utf-8"),
                '{"z":1,"a":"β"}',
            )
            self.assertEqual(
                transcript_path.read_text(encoding="utf-8"),
                "line one\nline two",
            )
            self.assertEqual(list(root.rglob("*.tmp")), [])

    def test_existing_writers_atomically_replace_previous_contents(self):
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            highlight_path = root / "highlight.json"
            caption_path = root / "caption.json"
            transcript_path = root / "transcript.json"
            for path in (highlight_path, caption_path, transcript_path):
                path.write_text("stale", encoding="utf-8")

            write_highlight_json(highlight_path, {"fresh": True})
            write_youtube_caption_json(caption_path, {"fresh": True})
            _atomic_write_text(transcript_path, "fresh")

            self.assertEqual(
                highlight_path.read_text(encoding="utf-8"),
                '{\n  "fresh": true\n}',
            )
            self.assertEqual(
                caption_path.read_text(encoding="utf-8"),
                '{"fresh":true}',
            )
            self.assertEqual(
                transcript_path.read_text(encoding="utf-8"),
                "fresh",
            )

    def test_shared_writer_preserves_destination_and_removes_temp_on_failure(self):
        with tempfile.TemporaryDirectory() as temporary_dir:
            target = Path(temporary_dir) / "entry.json"
            target.write_text("stable", encoding="utf-8")

            with patch(
                "shorts_generator.atomic_file.os.replace",
                side_effect=OSError("synthetic replace failure"),
            ):
                with self.assertRaisesRegex(OSError, "synthetic replace failure"):
                    atomic_write_text(target, "replacement")

            self.assertEqual(target.read_text(encoding="utf-8"), "stable")
            self.assertEqual(list(target.parent.glob("*.tmp")), [])
