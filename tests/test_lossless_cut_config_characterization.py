import ast
import importlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import shorts_generator.local.clipper as clipper
import shorts_generator.local.lossless_cut_config as lossless_config


_ENV_NAMES = (
    "LOCAL_LOSSLESS_CUT_CACHE",
    "LOCAL_LOSSLESS_CUT_CACHE_DIR",
    "LOCAL_LOSSLESS_CUT_CACHE_MAX_GB",
)
_RESULT_PREFIX = "LOSSLESS_CONFIG_RESULT="
_TEMP_ROOT = Path(tempfile.gettempdir()) / "lossless-config-characterization"
_PROBE_HOME = _TEMP_ROOT / "home"
_PROBE_CACHE_BASE = _TEMP_ROOT / "lossless config base"


class LosslessCutConfigCharacterizationTests(unittest.TestCase):
    def _probe_import(self, overrides=None, *, remove=()):
        env = os.environ.copy()
        for name in (*_ENV_NAMES, *remove):
            env.pop(name, None)
        env.update(
            {
                "HOME": str(_PROBE_HOME),
                "LOCAL_CACHE_DIR": str(_PROBE_CACHE_BASE),
                **(overrides or {}),
            }
        )
        code = f"""
import json
try:
    import shorts_generator.local.clipper as clipper
    result = {{
        "enabled": clipper.LOSSLESS_CUT_CACHE_ENABLED,
        "enabledType": type(clipper.LOSSLESS_CUT_CACHE_ENABLED).__name__,
        "directory": str(clipper.LOSSLESS_CUT_CACHE_DIR),
        "directoryType": type(clipper.LOSSLESS_CUT_CACHE_DIR).__name__,
        "maxBytes": clipper.LOSSLESS_CUT_CACHE_MAX_BYTES,
        "maxBytesType": type(clipper.LOSSLESS_CUT_CACHE_MAX_BYTES).__name__,
    }}
except BaseException as error:
    result = {{
        "errorType": type(error).__name__,
        "errorMessage": str(error),
    }}
print({_RESULT_PREFIX!r} + json.dumps(result, sort_keys=True))
"""
        completed = subprocess.run(
            [sys.executable, "-c", code],
            cwd=Path(__file__).resolve().parents[1],
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )
        result_line = next(
            line
            for line in completed.stdout.splitlines()
            if line.startswith(_RESULT_PREFIX)
        )
        return json.loads(result_line.removeprefix(_RESULT_PREFIX))

    def test_absent_environment_uses_exact_defaults_and_export_types(self):
        self.assertEqual(
            self._probe_import(),
            {
                "enabled": True,
                "enabledType": "bool",
                "directory": str(_PROBE_CACHE_BASE / "lossless-cuts-v1"),
                "directoryType": type(Path()).__name__,
                "maxBytes": 20 * 1024**3,
                "maxBytesType": "int",
            },
        )

    def test_enabled_values_are_stripped_case_insensitive_and_allowlisted(self):
        for value in ("1", "true", "yes", "on", " TRUE ", "\tYeS\n"):
            with self.subTest(value=value):
                self.assertIs(
                    self._probe_import({"LOCAL_LOSSLESS_CUT_CACHE": value})[
                        "enabled"
                    ],
                    True,
                )

        for value in ("0", "false", "no", "off", "", "2", "enabled"):
            with self.subTest(value=value):
                self.assertIs(
                    self._probe_import({"LOCAL_LOSSLESS_CUT_CACHE": value})[
                        "enabled"
                    ],
                    False,
                )

    def test_directory_preserves_relative_empty_unicode_and_space_values(self):
        absolute = _TEMP_ROOT / "absolute lossless cache"
        cases = (
            ("relative/cache", "relative/cache"),
            ("", "."),
            ("cache with spaces", "cache with spaces"),
            ("κρυφή μνήμη/κοπές", "κρυφή μνήμη/κοπές"),
            (str(absolute), str(absolute)),
        )
        for configured, expected in cases:
            with self.subTest(configured=configured):
                self.assertEqual(
                    self._probe_import(
                        {"LOCAL_LOSSLESS_CUT_CACHE_DIR": configured}
                    )["directory"],
                    expected,
                )

    def test_directory_expands_user_at_import_time(self):
        self.assertEqual(
            self._probe_import(
                {"LOCAL_LOSSLESS_CUT_CACHE_DIR": "~/lossless cache"}
            )["directory"],
            str(_PROBE_HOME / "lossless cache"),
        )

    def test_max_gb_uses_binary_gib_integer_conversion_and_two_gib_floor(self):
        cases = {
            "0": 2 * 1024**3,
            "-4": 2 * 1024**3,
            "1.999": 2 * 1024**3,
            "2": 2 * 1024**3,
            "2.5": int(2.5 * 1024**3),
            " 3 ": 3 * 1024**3,
            "1e1": 10 * 1024**3,
            "1000": 1000 * 1024**3,
        }
        for configured, expected in cases.items():
            with self.subTest(configured=configured):
                self.assertEqual(
                    self._probe_import(
                        {"LOCAL_LOSSLESS_CUT_CACHE_MAX_GB": configured}
                    )["maxBytes"],
                    expected,
                )

    def test_malformed_max_gb_preserves_exact_exception_contract(self):
        cases = {
            "": ("ValueError", "could not convert string to float: ''"),
            "not-a-number": (
                "ValueError",
                "could not convert string to float: 'not-a-number'",
            ),
            "nan": ("ValueError", "cannot convert float NaN to integer"),
            "inf": ("OverflowError", "cannot convert float infinity to integer"),
        }
        for configured, (error_type, message) in cases.items():
            with self.subTest(configured=configured):
                result = self._probe_import(
                    {"LOCAL_LOSSLESS_CUT_CACHE_MAX_GB": configured}
                )
                self.assertEqual(result["errorType"], error_type)
                self.assertEqual(result["errorMessage"], message)

    def test_environment_is_snapshotted_until_clipper_reload(self):
        original_enabled = clipper.LOSSLESS_CUT_CACHE_ENABLED
        original_directory = clipper.LOSSLESS_CUT_CACHE_DIR
        original_max_bytes = clipper.LOSSLESS_CUT_CACHE_MAX_BYTES
        with patch.dict(
            os.environ,
            {
                "LOCAL_LOSSLESS_CUT_CACHE": "false",
                "LOCAL_LOSSLESS_CUT_CACHE_DIR": "reloaded cache",
                "LOCAL_LOSSLESS_CUT_CACHE_MAX_GB": "3",
            },
        ):
            self.assertIs(clipper.LOSSLESS_CUT_CACHE_ENABLED, original_enabled)
            self.assertEqual(clipper.LOSSLESS_CUT_CACHE_DIR, original_directory)
            self.assertEqual(
                clipper.LOSSLESS_CUT_CACHE_MAX_BYTES,
                original_max_bytes,
            )
            reloaded = importlib.reload(clipper)
            self.assertIs(reloaded.LOSSLESS_CUT_CACHE_ENABLED, False)
            self.assertEqual(reloaded.LOSSLESS_CUT_CACHE_DIR, Path("reloaded cache"))
            self.assertEqual(
                reloaded.LOSSLESS_CUT_CACHE_MAX_BYTES,
                3 * 1024**3,
            )

        importlib.reload(clipper)

    def test_clipper_globals_remain_direct_monkeypatch_points(self):
        with (
            patch.object(clipper, "LOSSLESS_CUT_CACHE_ENABLED", False),
            patch.object(
                clipper,
                "LOSSLESS_CUT_CACHE_DIR",
                Path("patched cache"),
            ),
            patch.object(clipper, "LOSSLESS_CUT_CACHE_MAX_BYTES", 17),
        ):
            self.assertIs(clipper.LOSSLESS_CUT_CACHE_ENABLED, False)
            self.assertEqual(
                clipper._lossless_cut_cache_path("ab" * 24),
                Path("patched cache") / "ab" / f"{'ab' * 24}.mkv",
            )
            with patch.object(clipper, "prune_bounded_cache") as prune:
                clipper._prune_lossless_cut_cache()
            prune.assert_called_once_with(Path("patched cache"), "*/*.mkv", 17)

    def test_import_does_not_create_the_configured_cache_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "not-created" / "lossless"
            result = self._probe_import(
                {"LOCAL_LOSSLESS_CUT_CACHE_DIR": str(target)}
            )
            self.assertNotIn("errorType", result)
            self.assertFalse(target.exists())

    def test_config_module_is_a_standard_library_pure_leaf(self):
        tree = ast.parse(Path(lossless_config.__file__).read_text(encoding="utf-8"))
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
        self.assertEqual(imports, {"dataclasses", "pathlib", "typing"})

        clipper_source = Path(clipper.__file__).read_text(encoding="utf-8")
        self.assertIn(
            "parse_lossless_cut_config(os.environ, LOCAL_CACHE_DIR)",
            clipper_source,
        )
        for name in _ENV_NAMES:
            self.assertNotIn(f'os.getenv("{name}"', clipper_source)

    def test_parser_uses_only_the_supplied_mapping(self):
        supplied = {
            "LOCAL_LOSSLESS_CUT_CACHE": "off",
            "LOCAL_LOSSLESS_CUT_CACHE_DIR": "mapping cache",
            "LOCAL_LOSSLESS_CUT_CACHE_MAX_GB": "4",
        }
        with patch.dict(
            os.environ,
            {
                "LOCAL_LOSSLESS_CUT_CACHE": "true",
                "LOCAL_LOSSLESS_CUT_CACHE_DIR": "process cache",
                "LOCAL_LOSSLESS_CUT_CACHE_MAX_GB": "99",
            },
        ):
            parsed = lossless_config.parse_lossless_cut_config(
                supplied,
                "unused default root",
            )
        self.assertIs(parsed.enabled, False)
        self.assertEqual(parsed.directory, Path("mapping cache"))
        self.assertEqual(parsed.max_bytes, 4 * 1024**3)


if __name__ == "__main__":
    unittest.main()
