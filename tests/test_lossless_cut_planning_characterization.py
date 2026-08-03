import ast
import io
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import shorts_generator.local.clipper as clipper
import shorts_generator.local.lossless_cut_planning as planning


class LosslessCutPlanningCharacterizationTests(unittest.TestCase):
    def test_planning_module_is_a_pure_leaf(self):
        tree = ast.parse(Path(planning.__file__).read_text(encoding="utf-8"))
        imports = {
            alias.name.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        } | {
            node.module.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module
        }
        self.assertEqual(imports, {"hashlib", "json", "pathlib", "typing"})

    def _stable_key(
        self,
        *,
        resolved="/stable/source with spaces.mp4",
        size=1234,
        mtime_ns=5678,
        start=1.23456789,
        end=9.87654321,
        fps=29.97002997,
        schema="lossless-cut-v1",
    ):
        with (
            patch.object(Path, "resolve", return_value=Path(resolved)),
            patch.object(
                Path,
                "stat",
                return_value=SimpleNamespace(
                    st_size=size,
                    st_mtime_ns=mtime_ns,
                ),
            ),
            patch.object(clipper, "LOSSLESS_CUT_CACHE_SCHEMA", schema),
        ):
            return clipper._lossless_cut_cache_key(
                "source with spaces.mp4",
                start,
                end,
                fps,
            )

    def test_exact_ffmpeg_argv_preserves_rounding_codecs_audio_and_spaces(self):
        self.assertEqual(
            clipper._cut_subclip_command(
                "source with spaces.mp4",
                1.23456,
                9.87654,
                "output with spaces.mkv",
                fps=29.97002997,
            ),
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-ss",
                "1.235",
                "-i",
                "source with spaces.mp4",
                "-t",
                "8.642",
                "-vf",
                "fps=29.97",
                "-c:v",
                "ffv1",
                "-level",
                "3",
                "-c:a",
                "pcm_s16le",
                "output with spaces.mkv",
            ],
        )

    def test_subclip_execution_uses_exact_command_once_and_returns_output(self):
        expected = clipper._cut_subclip_command(
            "source.mp4",
            1.0,
            3.0,
            "cut.mkv",
            fps=30.0,
        )
        with patch.object(clipper.subprocess, "run") as run:
            result = clipper._cut_subclip(
                "source.mp4",
                1.0,
                3.0,
                "cut.mkv",
                fps=30.0,
            )
        run.assert_called_once_with(expected, check=True)
        self.assertEqual(result, "cut.mkv")

    def test_stable_cache_key_and_relevant_input_variation(self):
        baseline = self._stable_key()
        self.assertEqual(
            baseline,
            "0695f472054aaf1539bf518a8f1d7157f680447e6e79aa48",
        )

        changes = {
            "resolved_source": {"resolved": "/stable/other.mp4"},
            "source_size": {"size": 1235},
            "source_mtime": {"mtime_ns": 5679},
            "start": {"start": 1.2345689},
            "end": {"end": 9.87654421},
            "fps": {"fps": 30.0},
            "schema": {"schema": "lossless-cut-v2"},
        }
        for label, override in changes.items():
            with self.subTest(label=label):
                self.assertNotEqual(self._stable_key(**override), baseline)

    def test_missing_source_uses_literal_path_zero_identity(self):
        with patch.object(Path, "stat", side_effect=OSError("missing")):
            first = clipper._lossless_cut_cache_key(
                "missing source.mp4",
                1.0,
                2.0,
                30.0,
            )
            second = clipper._lossless_cut_cache_key(
                "missing source.mp4",
                1.0,
                2.0,
                30.0,
            )
        self.assertEqual(first, second)

    def test_cache_path_uses_two_character_shard_and_mkv_extension(self):
        cache_digest = "ab" * 24
        with patch.object(clipper, "LOSSLESS_CUT_CACHE_DIR", Path("cache root")):
            self.assertEqual(
                clipper._lossless_cut_cache_path(cache_digest),
                Path("cache root") / "ab" / f"{cache_digest}.mkv",
            )

    def test_cache_hit_touches_logs_and_skips_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source with spaces.mp4"
            source.write_bytes(b"source")
            cache_dir = root / "cache with spaces"
            with (
                patch.object(clipper, "LOSSLESS_CUT_CACHE_ENABLED", True),
                patch.object(clipper, "LOSSLESS_CUT_CACHE_DIR", cache_dir),
            ):
                key = clipper._lossless_cut_cache_key(
                    str(source),
                    1.0,
                    3.0,
                    30.0,
                )
                cached = clipper._lossless_cut_cache_path(key)
                cached.parent.mkdir(parents=True)
                cached.write_bytes(b"valid")
                output = io.StringIO()
                with (
                    patch.object(clipper, "_cut_subclip") as cut,
                    patch.object(clipper.os, "utime") as touch,
                    redirect_stdout(output),
                ):
                    result = clipper._get_or_create_lossless_cut(
                        str(source),
                        1.0,
                        3.0,
                        30.0,
                        str(root / "fallback.mkv"),
                    )

            cut.assert_not_called()
            touch.assert_called_once_with(cached, None)
            self.assertEqual(result, (str(cached), True))
            self.assertEqual(
                output.getvalue(),
                f"[clip/local] lossless cut cache hit: {key[:10]}\n",
            )

    def test_cache_miss_executes_once_publishes_and_prunes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            cache_dir = root / "cache"

            def write_cut(_source, _start, _end, output, fps):
                self.assertEqual(fps, 30.0)
                Path(output).write_bytes(b"lossless")
                return output

            with (
                patch.object(clipper, "LOSSLESS_CUT_CACHE_ENABLED", True),
                patch.object(clipper, "LOSSLESS_CUT_CACHE_DIR", cache_dir),
                patch.object(
                    clipper,
                    "_cut_subclip",
                    side_effect=write_cut,
                ) as cut,
                patch.object(clipper, "_prune_lossless_cut_cache") as prune,
            ):
                path, persistent = clipper._get_or_create_lossless_cut(
                    str(source),
                    1.0,
                    3.0,
                    30.0,
                    str(root / "fallback.mkv"),
                )

            self.assertEqual(cut.call_count, 1)
            prune.assert_called_once_with()
            self.assertTrue(persistent)
            self.assertEqual(Path(path).read_bytes(), b"lossless")

    def test_disabled_cache_uses_fallback_and_marks_it_nonpersistent(self):
        with patch.object(clipper, "LOSSLESS_CUT_CACHE_ENABLED", False), patch.object(
            clipper,
            "_cut_subclip",
            return_value="fallback with spaces.mkv",
        ) as cut:
            result = clipper._get_or_create_lossless_cut(
                "source with spaces.mp4",
                1.0,
                3.0,
                30.0,
                "fallback with spaces.mkv",
            )

        cut.assert_called_once_with(
            "source with spaces.mp4",
            1.0,
            3.0,
            "fallback with spaces.mkv",
            fps=30.0,
        )
        self.assertEqual(result, ("fallback with spaces.mkv", False))

    def test_zero_byte_cached_artifact_is_rebuilt_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            cache_dir = root / "cache"
            with (
                patch.object(clipper, "LOSSLESS_CUT_CACHE_ENABLED", True),
                patch.object(clipper, "LOSSLESS_CUT_CACHE_DIR", cache_dir),
            ):
                key = clipper._lossless_cut_cache_key(
                    str(source), 1.0, 3.0, 30.0
                )
                cached = clipper._lossless_cut_cache_path(key)
                cached.parent.mkdir(parents=True)
                cached.write_bytes(b"")

                def write_cut(_source, _start, _end, output, fps):
                    Path(output).write_bytes(b"rebuilt")
                    return output

                with (
                    patch.object(
                        clipper,
                        "_cut_subclip",
                        side_effect=write_cut,
                    ) as cut,
                    patch.object(clipper, "_prune_lossless_cut_cache"),
                ):
                    result = clipper._get_or_create_lossless_cut(
                        str(source),
                        1.0,
                        3.0,
                        30.0,
                        str(root / "fallback.mkv"),
                    )

            self.assertEqual(cut.call_count, 1)
            self.assertEqual(result, (str(cached), True))
            self.assertEqual(cached.read_bytes(), b"rebuilt")

    def test_subprocess_failure_propagates_and_removes_partial_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            cache_dir = root / "cache"

            def fail_after_partial(_source, _start, _end, output, fps):
                Path(output).write_bytes(b"partial")
                raise subprocess.CalledProcessError(1, ["ffmpeg"])

            with (
                patch.object(clipper, "LOSSLESS_CUT_CACHE_ENABLED", True),
                patch.object(clipper, "LOSSLESS_CUT_CACHE_DIR", cache_dir),
                patch.object(
                    clipper,
                    "_cut_subclip",
                    side_effect=fail_after_partial,
                ),
            ):
                with self.assertRaises(subprocess.CalledProcessError):
                    clipper._get_or_create_lossless_cut(
                        str(source),
                        1.0,
                        3.0,
                        30.0,
                        str(root / "fallback.mkv"),
                    )

            self.assertEqual(list(cache_dir.rglob("*.mkv")), [])

    def test_missing_output_after_success_propagates_file_not_found(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            cache_dir = root / "cache"
            with (
                patch.object(clipper, "LOSSLESS_CUT_CACHE_ENABLED", True),
                patch.object(clipper, "LOSSLESS_CUT_CACHE_DIR", cache_dir),
                patch.object(
                    clipper,
                    "_cut_subclip",
                    return_value="missing-output.mkv",
                ) as cut,
            ):
                with self.assertRaises(FileNotFoundError):
                    clipper._get_or_create_lossless_cut(
                        str(source),
                        1.0,
                        3.0,
                        30.0,
                        str(root / "fallback.mkv"),
                    )

            cut.assert_called_once()
            self.assertEqual(list(cache_dir.rglob("*.mkv")), [])


if __name__ == "__main__":
    unittest.main()
