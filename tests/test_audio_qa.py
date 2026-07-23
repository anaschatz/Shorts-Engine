import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from shorts_generator.artifact_contracts import file_sha256, verify_seal
from shorts_generator.audio_qa import evaluate_audio_delivery
from shorts_generator.profiles import BF_SMOOTH_TAIL_V4


class AudioQaTests(unittest.TestCase):
    def test_delivery_report_enforces_loudness_peak_and_silent_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.write_bytes(b"fixture")

            def runner(command, **_kwargs):
                if "ebur128=peak=true" in command:
                    return SimpleNamespace(
                        returncode=0,
                        stdout="",
                        stderr=(
                            "Summary:\nIntegrated loudness:\n I: -15.5 LUFS\n"
                            "Loudness range:\n LRA: 2.5 LU\n"
                            "True peak:\n Peak: -1.8 dBFS\n"
                        ),
                    )
                return SimpleNamespace(
                    returncode=0,
                    stdout=struct.pack("<4f", 0.0, 0.0, 0.0, 0.0),
                    stderr=b"",
                )

            report = evaluate_audio_delivery(
                str(video),
                brand_tail_seconds=1.25,
                runner=runner,
            )
            self.assertEqual(report["outputHash"], file_sha256(str(video)))

        self.assertTrue(report["passed"])
        self.assertEqual(report["measurements"]["truePeakDbfs"], -1.8)
        self.assertLessEqual(report["measurements"]["brandTailRmsDbfs"], -45)
        self.assertEqual(report["brandTailProfile"], "bf_reference_tail_v2")
        self.assertTrue(
            next(
                gate
                for gate in report["gates"]
                if gate["code"] == "BRAND_TAIL_DURATION_POLICY"
            )["passed"]
        )
        self.assertIs(verify_seal(report, "AudioQaReport"), report)

    def test_smooth_tail_probes_silence_after_music_release_window(self):
        calls = []
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "short.mp4"
            video.write_bytes(b"fixture")

            def runner(command, **_kwargs):
                calls.append(command)
                if "ebur128=peak=true" in command:
                    return SimpleNamespace(
                        returncode=0,
                        stdout="",
                        stderr=(
                            "Summary:\nIntegrated loudness:\n I: -15.5 LUFS\n"
                            "Loudness range:\n LRA: 2.5 LU\n"
                            "True peak:\n Peak: -1.8 dBFS\n"
                        ),
                    )
                return SimpleNamespace(
                    returncode=0,
                    stdout=struct.pack("<4f", 0.0, 0.0, 0.0, 0.0),
                    stderr=b"",
                )

            report = evaluate_audio_delivery(
                str(video),
                brand_tail_seconds=0.85,
                brand_tail_profile=BF_SMOOTH_TAIL_V4,
                runner=runner,
            )

        self.assertTrue(report["passed"])
        self.assertEqual(
            report["measurements"]["brandTailQuietProbeSeconds"],
            0.65,
        )
        self.assertIn("-0.650", calls[1])


if __name__ == "__main__":
    unittest.main()
