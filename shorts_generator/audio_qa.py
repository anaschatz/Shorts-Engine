"""Encoded-audio delivery checks for Budget Friendly production renders."""
from __future__ import annotations

import array
import math
import re
import subprocess
from pathlib import Path
from typing import Dict

from .artifact_contracts import content_hash, file_sha256
from .profiles import (
    BF_NATURAL_TAIL_V6,
    BF_REFERENCE_TAIL_V2,
    BF_SMOOTH_TAIL_V3,
    BF_SMOOTH_TAIL_V4,
    BF_SMOOTH_TAIL_V5,
)


_SMOOTH_TAIL_PROFILES = {
    BF_SMOOTH_TAIL_V3,
    BF_SMOOTH_TAIL_V4,
    BF_SMOOTH_TAIL_V5,
    BF_NATURAL_TAIL_V6,
}


def _parse_ebur128_summary(output: str) -> Dict[str, float]:
    summary = str(output or "").rsplit("Summary:", 1)[-1]
    integrated = re.search(r"Integrated loudness:\s*I:\s*(-?[0-9.]+)\s*LUFS", summary)
    loudness_range = re.search(r"Loudness range:\s*LRA:\s*([0-9.]+)\s*LU", summary)
    true_peak = re.search(r"True peak:\s*Peak:\s*(-?[0-9.]+)\s*dBFS", summary)
    if not (integrated and loudness_range and true_peak):
        raise RuntimeError("ffmpeg did not return a complete ebur128 summary")
    return {
        "integratedLufs": float(integrated.group(1)),
        "loudnessRangeLu": float(loudness_range.group(1)),
        "truePeakDbfs": float(true_peak.group(1)),
    }


def _tail_rms_dbfs(pcm: bytes) -> float:
    samples = array.array("f")
    samples.frombytes(pcm)
    if not samples:
        return float("-inf")
    rms = math.sqrt(sum(float(value) ** 2 for value in samples) / len(samples))
    return 20.0 * math.log10(max(rms, 1e-12))


def evaluate_audio_delivery(
    video_path: str,
    brand_tail_seconds: float,
    brand_tail_profile: str = BF_REFERENCE_TAIL_V2,
    runner=subprocess.run,
) -> Dict:
    path = Path(video_path)
    if not path.is_file():
        raise FileNotFoundError(video_path)
    loudness = runner(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(path),
            "-filter_complex",
            "ebur128=peak=true",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
    )
    if loudness.returncode != 0:
        raise RuntimeError("ffmpeg ebur128 analysis failed")
    measurements = _parse_ebur128_summary(
        (loudness.stderr or "") + "\n" + (loudness.stdout or "")
    )
    tail_profile = str(brand_tail_profile or "").strip().lower()
    # v3 intentionally allows the low music bed to resolve for the first
    # 180ms of the 850ms BF hold. Probe only the terminal quiet region (with a
    # 20ms guard) so QA permits that musical release but still proves the
    # remaining ~650ms is silent.
    quiet_tail_probe_seconds = (
        max(0.05, float(brand_tail_seconds) - 0.20)
        if tail_profile in _SMOOTH_TAIL_PROFILES
        else max(0.05, float(brand_tail_seconds) * 0.75)
    )
    tail = runner(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-sseof",
            f"-{quiet_tail_probe_seconds:.3f}",
            "-i",
            str(path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "-",
        ],
        capture_output=True,
    )
    if tail.returncode != 0:
        raise RuntimeError("ffmpeg tail-silence analysis failed")
    tail_rms = _tail_rms_dbfs(tail.stdout or b"")
    measurements["brandTailRmsDbfs"] = (
        round(tail_rms, 3) if math.isfinite(tail_rms) else -240.0
    )
    measurements["brandTailQuietProbeSeconds"] = round(
        quiet_tail_probe_seconds,
        3,
    )
    tail_duration_valid = (
        0.80 <= float(brand_tail_seconds) <= 0.90
        if tail_profile in _SMOOTH_TAIL_PROFILES
        else 1.15 <= float(brand_tail_seconds) <= 1.35
        if tail_profile == BF_REFERENCE_TAIL_V2
        else 0.2 <= float(brand_tail_seconds) <= 0.4
    )
    gates = [
        {
            "code": "INTEGRATED_LOUDNESS",
            "passed": -17.0 <= measurements["integratedLufs"] <= -14.0,
            "actual": measurements["integratedLufs"],
            "expected": "-17..-14 LUFS",
        },
        {
            "code": "TRUE_PEAK",
            "passed": measurements["truePeakDbfs"] <= -1.5,
            "actual": measurements["truePeakDbfs"],
            "expected": "<=-1.5 dBFS",
        },
        {
            "code": "BRAND_TAIL_DURATION_POLICY",
            "passed": tail_duration_valid,
            "actual": round(float(brand_tail_seconds), 3),
            "expected": (
                "0.80..0.90s"
                if tail_profile in _SMOOTH_TAIL_PROFILES
                else "1.15..1.35s"
                if tail_profile == BF_REFERENCE_TAIL_V2
                else "0.2..0.4s"
            ),
        },
        {
            "code": "BRAND_TAIL_SILENCE",
            "passed": measurements["brandTailRmsDbfs"] <= -45.0,
            "actual": measurements["brandTailRmsDbfs"],
            "expected": "<=-45 dBFS RMS",
        },
    ]
    payload = {
        "schemaVersion": 1,
        "artifactType": "AudioQaReport",
        "videoPath": str(path.resolve()),
        "outputHash": file_sha256(str(path)),
        "brandTailSeconds": round(float(brand_tail_seconds), 3),
        "brandTailProfile": tail_profile,
        "measurements": measurements,
        "gates": gates,
        "passed": all(gate["passed"] for gate in gates),
    }
    return {**payload, "contentHash": content_hash(payload)}


__all__ = ["evaluate_audio_delivery"]
