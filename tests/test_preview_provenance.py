import copy
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from shorts_generator.artifact_contracts import (
    ArtifactBindingError,
    content_hash,
    file_sha256,
    verify_seal,
)
from shorts_generator.preview_provenance import (
    PREVIEW_PROVENANCE_ARTIFACT_TYPE,
    analyze_preview_source_provenance,
    verify_preview_source_provenance,
)


def _media_runtime_available() -> bool:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        return False
    try:
        import numpy  # noqa: F401
    except ImportError:
        return False
    return True


@unittest.skipUnless(_media_runtime_available(), "ffmpeg, ffprobe and numpy required")
class PreviewProvenanceDecodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._temporary_directory = tempfile.TemporaryDirectory()
        directory = Path(cls._temporary_directory.name)
        cls.source = directory / "source.mp4"
        cls.preview = directory / "preview.mp4"
        cls.unrelated = directory / "unrelated.mp4"
        try:
            cls._run_ffmpeg(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=30:duration=6",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000:duration=6",
                    "-shortest",
                    "-c:v",
                    "mpeg4",
                    "-q:v",
                    "2",
                    "-c:a",
                    "aac",
                    str(cls.source),
                ]
            )
            # This intentionally mirrors the production source-preview path:
            # input seek, bounded interval, and a real lossy re-encode.
            cls._run_ffmpeg(
                [
                    "-ss",
                    "1.000",
                    "-i",
                    str(cls.source),
                    "-t",
                    "4.000",
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a:0",
                    "-c:v",
                    "mpeg4",
                    "-q:v",
                    "2",
                    "-c:a",
                    "aac",
                    str(cls.preview),
                ]
            )
            cls._run_ffmpeg(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    "smptebars=size=320x180:rate=30:duration=4",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=880:sample_rate=48000:duration=4",
                    "-shortest",
                    "-c:v",
                    "mpeg4",
                    "-q:v",
                    "2",
                    "-c:a",
                    "aac",
                    str(cls.unrelated),
                ]
            )
        except subprocess.CalledProcessError as error:
            raise unittest.SkipTest(
                f"local ffmpeg cannot build provenance fixtures: {error.stderr!r}"
            ) from error

        cls.source_hash = file_sha256(str(cls.source))
        cls.preview_hash = file_sha256(str(cls.preview))
        cls.report = analyze_preview_source_provenance(
            str(cls.source),
            str(cls.preview),
            cls.source_hash,
            cls.preview_hash,
            1000,
            5000,
        )

    @classmethod
    def tearDownClass(cls):
        cls._temporary_directory.cleanup()

    @staticmethod
    def _run_ffmpeg(arguments):
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                *arguments,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )

    def _verify(self, report=None, **overrides):
        bindings = {
            "source_hash": self.source_hash,
            "preview_hash": self.preview_hash,
            "start_ms": 1000,
            "end_ms": 5000,
        }
        bindings.update(overrides)
        return verify_preview_source_provenance(report or self.report, **bindings)

    def test_exact_extracted_interval_passes_decode_provenance(self):
        report = self.report
        self.assertTrue(report["passed"])
        self.assertEqual(report["decision"], "pass")
        self.assertEqual(report["analysisStatus"], "complete")
        self.assertGreaterEqual(report["metrics"]["audio"]["correlation"], 0.995)
        self.assertGreaterEqual(report["metrics"]["video"]["meanCorrelation"], 0.995)
        self.assertGreaterEqual(
            report["metrics"]["video"]["minimumFrameCorrelation"], 0.98
        )
        self.assertLessEqual(report["metrics"]["durationDeltaMs"], 100)
        self.assertIs(
            verify_seal(report, PREVIEW_PROVENANCE_ARTIFACT_TYPE), report
        )
        self.assertIs(self._verify(), report)

    def test_unrelated_same_duration_media_is_fail_closed(self):
        unrelated_hash = file_sha256(str(self.unrelated))
        report = analyze_preview_source_provenance(
            str(self.source),
            str(self.unrelated),
            self.source_hash,
            unrelated_hash,
            1000,
            5000,
        )
        self.assertFalse(report["passed"])
        self.assertEqual(report["decision"], "review")
        self.assertIs(
            verify_preview_source_provenance(
                report,
                source_hash=self.source_hash,
                preview_hash=unrelated_hash,
                start_ms=1000,
                end_ms=5000,
                require_pass=False,
            ),
            report,
        )
        with self.assertRaisesRegex(
            ArtifactBindingError, "provenance did not pass"
        ):
            verify_preview_source_provenance(
                report,
                source_hash=self.source_hash,
                preview_hash=unrelated_hash,
                start_ms=1000,
                end_ms=5000,
            )

    def test_analysis_refuses_missing_or_stale_media_bindings(self):
        with self.assertRaisesRegex(ArtifactBindingError, "does not exist"):
            analyze_preview_source_provenance(
                str(self.source),
                str(self.preview.parent / "missing.mp4"),
                self.source_hash,
                self.preview_hash,
                1000,
                5000,
            )

    def test_media_probe_failure_returns_sealed_non_passing_report(self):
        invalid_preview = self.preview.parent / "invalid-preview.mp4"
        invalid_preview.write_bytes(b"not a media container")
        invalid_hash = file_sha256(str(invalid_preview))
        report = analyze_preview_source_provenance(
            str(self.source),
            str(invalid_preview),
            self.source_hash,
            invalid_hash,
            1000,
            5000,
        )
        self.assertEqual(report["analysisStatus"], "failed")
        self.assertEqual(report["failureCode"], "preview_duration_probe_failed")
        self.assertFalse(report["passed"])
        self.assertIs(
            verify_preview_source_provenance(
                report,
                source_hash=self.source_hash,
                preview_hash=invalid_hash,
                start_ms=1000,
                end_ms=5000,
                require_pass=False,
            ),
            report,
        )
        with self.assertRaisesRegex(ArtifactBindingError, "did not pass"):
            verify_preview_source_provenance(
                report,
                source_hash=self.source_hash,
                preview_hash=invalid_hash,
                start_ms=1000,
                end_ms=5000,
            )
        with self.assertRaisesRegex(ArtifactBindingError, "does not match"):
            analyze_preview_source_provenance(
                str(self.source),
                str(self.preview),
                self.source_hash,
                "1" * 64,
                1000,
                5000,
            )

    def test_verifier_rejects_wrong_hash_and_interval_bindings(self):
        with self.assertRaisesRegex(ArtifactBindingError, "bindings do not match"):
            self._verify(source_hash="2" * 64)
        with self.assertRaisesRegex(ArtifactBindingError, "bindings do not match"):
            self._verify(end_ms=4999)

    def test_verifier_rejects_body_tamper_even_when_claim_stays_passing(self):
        tampered = copy.deepcopy(self.report)
        tampered["metrics"]["audio"]["correlation"] = 0.1
        with self.assertRaisesRegex(ArtifactBindingError, "contentHash"):
            self._verify(tampered)

    def test_verifier_recomputes_gates_after_reseal(self):
        tampered = copy.deepcopy(self.report)
        tampered["metrics"]["audio"]["correlation"] = 0.1
        tampered["contentHash"] = content_hash(tampered)
        with self.assertRaisesRegex(ArtifactBindingError, "gates are stale"):
            self._verify(tampered)

    def test_verifier_rejects_inconsistent_derived_coverage(self):
        tampered = copy.deepcopy(self.report)
        tampered["metrics"]["audio"]["coverageRatio"] = 1.0
        tampered["contentHash"] = content_hash(tampered)
        with self.assertRaisesRegex(ArtifactBindingError, "coverageRatio"):
            self._verify(tampered)


if __name__ == "__main__":
    unittest.main()
