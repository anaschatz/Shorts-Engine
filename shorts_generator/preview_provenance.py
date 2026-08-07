"""Decode-based provenance for a human-review source preview.

The report produced here proves only one narrow, measurable property: the
review media decodes like the exact source interval named in its bindings.  It
does not infer editorial quality, speaker identity, or any other semantic
claim.
"""
from __future__ import annotations

import hashlib
import json
import math
import platform
import shutil
import subprocess
from pathlib import Path
from typing import Dict, Mapping, Optional, Sequence, Tuple

from .artifact_contracts import (
    ArtifactBindingError,
    content_hash,
    file_sha256,
    verify_seal,
)


PREVIEW_PROVENANCE_VERSION = "bf-preview-source-provenance-v1.0.0"
PREVIEW_PROVENANCE_ARTIFACT_TYPE = "PreviewSourceProvenanceReport"
PREVIEW_PROVENANCE_ANALYZER_ID = "budget_friendly_preview_source_provenance"

_GATE_CODES = (
    "DURATION_MATCH",
    "AUDIO_SAMPLE_COVERAGE",
    "AUDIO_CORRELATION",
    "VIDEO_FRAME_COVERAGE",
    "VIDEO_MEAN_CORRELATION",
    "VIDEO_MIN_CORRELATION",
)
_FAILURE_CODES = frozenset(
    {
        "ffmpeg_unavailable",
        "ffmpeg_runtime_probe_failed",
        "preview_duration_probe_failed",
        "preview_duration_mismatch",
        "source_audio_decode_failed",
        "preview_audio_decode_failed",
        "source_video_decode_failed",
        "preview_video_decode_failed",
        "audio_alignment_failed",
        "video_alignment_failed",
        "numeric_analysis_failed",
    }
)

_CONFIG: Dict[str, object] = {
    "audio": {
        "channels": 1,
        "sampleFormat": "f32le",
        "sampleRateHz": 8000,
        "maximumAlignmentMs": 250,
        "minimumCoverageRatio": 0.99,
        "minimumCorrelation": 0.995,
    },
    "durationToleranceMs": 100,
    "video": {
        "framesPerSecond": 1,
        "height": 90,
        "maximumAlignmentFrames": 1,
        "minimumCoverageRatio": 0.90,
        "minimumFrameCorrelation": 0.98,
        "minimumMeanCorrelation": 0.995,
        "pixelFormat": "rgb24",
        "width": 160,
    },
}


def _strict_snapshot(value: object, field: str) -> object:
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError(f"{field} must be strict JSON") from error
    return json.loads(encoded)


def _seal(payload: Mapping[str, object]) -> Dict:
    snapshot = _strict_snapshot(dict(payload), "preview provenance report")
    if not isinstance(snapshot, dict):  # pragma: no cover - defensive
        raise ArtifactBindingError("preview provenance report must be an object")
    snapshot.pop("contentHash", None)
    return {**snapshot, "contentHash": content_hash(snapshot)}


def _sha256(value: object, field: str) -> str:
    normalized = str(value or "").strip().lower().removeprefix("sha256:")
    if (
        len(normalized) != 64
        or any(character not in "0123456789abcdef" for character in normalized)
        or normalized == "0" * 64
    ):
        raise ArtifactBindingError(f"{field} must be a non-placeholder sha256 hash")
    return normalized


def _strict_integer(value: object, field: str, *, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ArtifactBindingError(f"{field} must be an integer >= {minimum}")
    return value


def _finite_float(
    value: object,
    field: str,
    *,
    minimum: Optional[float] = None,
    maximum: Optional[float] = None,
) -> float:
    if isinstance(value, bool):
        raise ArtifactBindingError(f"{field} must be finite")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError(f"{field} must be finite") from error
    if not math.isfinite(number):
        raise ArtifactBindingError(f"{field} must be finite")
    if minimum is not None and number < minimum:
        raise ArtifactBindingError(f"{field} must be >= {minimum}")
    if maximum is not None and number > maximum:
        raise ArtifactBindingError(f"{field} must be <= {maximum}")
    return number


def _validate_interval(start_ms: object, end_ms: object) -> Tuple[int, int]:
    start = _strict_integer(start_ms, "sourceIntervalMs.startMs", minimum=0)
    end = _strict_integer(end_ms, "sourceIntervalMs.endMs", minimum=1)
    if end <= start:
        raise ArtifactBindingError(
            "sourceIntervalMs.endMs must be greater than startMs"
        )
    return start, end


def _validate_media_binding(path_value: object, declared_hash: object, field: str) -> Tuple[Path, str]:
    path = Path(str(path_value or "")).expanduser()
    if not path.is_file():
        raise ArtifactBindingError(f"{field} media file does not exist")
    normalized_hash = _sha256(declared_hash, f"{field}Sha256")
    if file_sha256(str(path)) != normalized_hash:
        raise ArtifactBindingError(f"{field}Sha256 does not match the media file")
    return path, normalized_hash


def _run_binary(command: Sequence[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            list(command),
            check=False,
            capture_output=True,
        )
    except (FileNotFoundError, OSError) as error:
        raise RuntimeError("media binary is unavailable") from error


def _runtime_identity(ffmpeg_path: str, ffprobe_path: str, numpy_version: str) -> Dict[str, str]:
    identities: Dict[str, str] = {}
    for field, binary in (("ffmpegVersion", ffmpeg_path), ("ffprobeVersion", ffprobe_path)):
        result = _run_binary([binary, "-version"])
        if result.returncode != 0:
            raise RuntimeError("media runtime version probe failed")
        first_line = (result.stdout or b"").decode("utf-8", errors="replace").splitlines()
        if not first_line or not first_line[0].strip():
            raise RuntimeError("media runtime version probe failed")
        identities[field] = first_line[0].strip()
    identities["numpyVersion"] = str(numpy_version)
    identities["pythonVersion"] = platform.python_version()
    return identities


def _best_effort_binary_version(binary_path: Optional[str]) -> str:
    if not binary_path:
        return "unavailable"
    try:
        result = _run_binary([binary_path, "-version"])
    except RuntimeError:
        return "unavailable"
    lines = (result.stdout or b"").decode("utf-8", errors="replace").splitlines()
    if result.returncode != 0 or not lines or not lines[0].strip():
        return "probe_failed"
    return lines[0].strip()


def _partial_runtime_identity(
    ffmpeg_path: Optional[str],
    ffprobe_path: Optional[str],
    numpy_version: str,
) -> Dict[str, str]:
    return {
        "ffmpegVersion": _best_effort_binary_version(ffmpeg_path),
        "ffprobeVersion": _best_effort_binary_version(ffprobe_path),
        "numpyVersion": numpy_version,
        "pythonVersion": platform.python_version(),
    }


def _probe_duration_ms(ffprobe_path: str, preview_path: Path) -> int:
    result = _run_binary(
        [
            ffprobe_path,
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=duration",
            "-of",
            "json",
            str(preview_path),
        ]
    )
    if result.returncode != 0:
        raise RuntimeError("preview duration probe failed")
    try:
        payload = json.loads((result.stdout or b"").decode("utf-8"))
        candidates = []
        format_payload = payload.get("format")
        if isinstance(format_payload, dict):
            candidates.append(format_payload.get("duration"))
        streams = payload.get("streams")
        if isinstance(streams, list):
            candidates.extend(
                stream.get("duration")
                for stream in streams
                if isinstance(stream, dict)
            )
        durations = [float(value) for value in candidates if value is not None]
        duration = max(value for value in durations if math.isfinite(value) and value > 0)
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
        raise RuntimeError("preview duration probe failed") from error
    return int(round(duration * 1000.0))


def _decode_audio(
    ffmpeg_path: str,
    media_path: Path,
    *,
    start_ms: Optional[int] = None,
    duration_ms: Optional[int] = None,
) -> bytes:
    command = [ffmpeg_path, "-hide_banner", "-loglevel", "error"]
    if start_ms is not None:
        # Input-side seek is intentional: provenance analysis must not decode
        # an entire long-form source just to inspect a short interval.
        command.extend(["-ss", f"{start_ms / 1000.0:.3f}"])
    command.extend(["-i", str(media_path)])
    if duration_ms is not None:
        command.extend(["-t", f"{duration_ms / 1000.0:.3f}"])
    command.extend(
        [
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "f32le",
            "pipe:1",
        ]
    )
    result = _run_binary(command)
    if result.returncode != 0 or not result.stdout or len(result.stdout) % 4:
        raise RuntimeError("audio decode failed")
    return bytes(result.stdout)


def _decode_video(
    ffmpeg_path: str,
    media_path: Path,
    *,
    start_ms: Optional[int] = None,
    duration_ms: Optional[int] = None,
) -> bytes:
    command = [ffmpeg_path, "-hide_banner", "-loglevel", "error"]
    if start_ms is not None:
        command.extend(["-ss", f"{start_ms / 1000.0:.3f}"])
    command.extend(["-i", str(media_path)])
    if duration_ms is not None:
        command.extend(["-t", f"{duration_ms / 1000.0:.3f}"])
    command.extend(
        [
            "-map",
            "0:v:0",
            "-an",
            "-vf",
            "fps=1,scale=160:90:flags=bilinear",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
        ]
    )
    result = _run_binary(command)
    frame_bytes = 160 * 90 * 3
    if (
        result.returncode != 0
        or not result.stdout
        or len(result.stdout) % frame_bytes
    ):
        raise RuntimeError("video decode failed")
    return bytes(result.stdout)


def _pearson(left, right, np) -> float:
    if left.size != right.size or left.size < 2:
        raise ValueError("correlation inputs are not aligned")
    left64 = left.astype(np.float64, copy=False)
    right64 = right.astype(np.float64, copy=False)
    left_centered = left64 - float(left64.mean())
    right_centered = right64 - float(right64.mean())
    denominator = math.sqrt(
        float(np.dot(left_centered, left_centered))
        * float(np.dot(right_centered, right_centered))
    )
    if denominator <= 1e-12:
        maximum_error = float(np.max(np.abs(left64 - right64)))
        return 1.0 if maximum_error <= 1e-7 else 0.0
    correlation = float(np.dot(left_centered, right_centered)) / denominator
    return max(-1.0, min(1.0, correlation))


def _aligned_slices(source, preview, offset: int):
    if offset >= 0:
        count = min(source.size - offset, preview.size)
        return source[offset : offset + count], preview[:count]
    preview_offset = -offset
    count = min(source.size, preview.size - preview_offset)
    return source[:count], preview[preview_offset : preview_offset + count]


def _audio_alignment(
    source_pcm: bytes,
    preview_pcm: bytes,
    expected_duration_ms: int,
    np,
) -> Dict[str, object]:
    source = np.frombuffer(source_pcm, dtype="<f4")
    preview = np.frombuffer(preview_pcm, dtype="<f4")
    if source.size < 4000 or preview.size < 4000:
        raise ValueError("audio evidence is too short")

    maximum_offset = int(_CONFIG["audio"]["maximumAlignmentMs"] * 8)  # type: ignore[index]
    coarse_step = 16
    source_coarse = source[::coarse_step]
    preview_coarse = preview[::coarse_step]
    coarse_limit = maximum_offset // coarse_step
    best_coarse: Optional[Tuple[float, int]] = None
    for coarse_offset in range(-coarse_limit, coarse_limit + 1):
        left, right = _aligned_slices(source_coarse, preview_coarse, coarse_offset)
        if left.size < 250:
            continue
        correlation = _pearson(left, right, np)
        candidate = (correlation, -abs(coarse_offset))
        if best_coarse is None or candidate > (best_coarse[0], -abs(best_coarse[1])):
            best_coarse = (correlation, coarse_offset)
    if best_coarse is None:
        raise ValueError("audio alignment could not be measured")

    center = best_coarse[1] * coarse_step
    best_full: Optional[Tuple[float, int, int]] = None
    for offset in range(
        max(-maximum_offset, center - coarse_step),
        min(maximum_offset, center + coarse_step) + 1,
    ):
        left, right = _aligned_slices(source, preview, offset)
        if left.size < 4000:
            continue
        correlation = _pearson(left, right, np)
        candidate = (correlation, -abs(offset))
        if best_full is None or candidate > (best_full[0], -abs(best_full[1])):
            best_full = (correlation, offset, int(left.size))
    if best_full is None:
        raise ValueError("audio alignment could not be measured")

    correlation, offset, aligned_count = best_full
    expected_sample_count = int(round(expected_duration_ms * 8.0))
    aligned_coverage = aligned_count / max(int(source.size), int(preview.size))
    source_coverage = min(int(source.size), expected_sample_count) / max(
        int(source.size), expected_sample_count
    )
    preview_coverage = min(int(preview.size), expected_sample_count) / max(
        int(preview.size), expected_sample_count
    )
    coverage = min(aligned_coverage, source_coverage, preview_coverage)
    return {
        "alignedSampleCount": aligned_count,
        "alignmentOffsetMs": round(offset / 8.0, 3),
        "alignmentOffsetSamples": offset,
        "correlation": round(correlation, 9),
        "coverageRatio": round(coverage, 9),
        "expectedSampleCount": expected_sample_count,
        "previewSampleCount": int(preview.size),
        "sourceSampleCount": int(source.size),
    }


def _frame_correlation(source_frame, preview_frame, np) -> Tuple[float, float]:
    source = source_frame.astype(np.float64, copy=False) / 255.0
    preview = preview_frame.astype(np.float64, copy=False) / 255.0
    correlation = _pearson(source.reshape(-1), preview.reshape(-1), np)
    mean_absolute_error = float(np.mean(np.abs(source - preview)))
    return correlation, mean_absolute_error


def _video_alignment(
    source_raw: bytes,
    preview_raw: bytes,
    expected_duration_ms: int,
    np,
) -> Dict[str, object]:
    width = int(_CONFIG["video"]["width"])  # type: ignore[index]
    height = int(_CONFIG["video"]["height"])  # type: ignore[index]
    frame_bytes = width * height * 3
    source_count = len(source_raw) // frame_bytes
    preview_count = len(preview_raw) // frame_bytes
    if source_count < 1 or preview_count < 1:
        raise ValueError("video evidence has no frames")
    source = np.frombuffer(source_raw, dtype=np.uint8).reshape(
        source_count, height, width, 3
    )
    preview = np.frombuffer(preview_raw, dtype=np.uint8).reshape(
        preview_count, height, width, 3
    )

    maximum_offset = int(_CONFIG["video"]["maximumAlignmentFrames"])  # type: ignore[index]
    best: Optional[Tuple[float, int, list[float], list[float]]] = None
    for offset in range(-maximum_offset, maximum_offset + 1):
        if offset >= 0:
            pair_count = min(source_count - offset, preview_count)
            source_frames = source[offset : offset + pair_count]
            preview_frames = preview[:pair_count]
        else:
            preview_offset = -offset
            pair_count = min(source_count, preview_count - preview_offset)
            source_frames = source[:pair_count]
            preview_frames = preview[preview_offset : preview_offset + pair_count]
        if pair_count < 1:
            continue
        correlations = []
        errors = []
        for source_frame, preview_frame in zip(source_frames, preview_frames):
            correlation, error = _frame_correlation(source_frame, preview_frame, np)
            correlations.append(correlation)
            errors.append(error)
        mean_correlation = sum(correlations) / len(correlations)
        coverage = pair_count / max(source_count, preview_count)
        # Correlation is the primary evidence; the coverage penalty prevents a
        # shorter shifted overlap from winning on a single unusually easy frame.
        alignment_score = mean_correlation - (1.0 - coverage)
        candidate = (alignment_score, -abs(offset))
        if best is None or candidate > (best[0], -abs(best[1])):
            best = (alignment_score, offset, correlations, errors)
    if best is None:
        raise ValueError("video alignment could not be measured")

    _, offset, correlations, errors = best
    aligned_count = len(correlations)
    expected_frame_count = max(1, int(math.floor(expected_duration_ms / 1000.0 + 0.5)))
    aligned_coverage = aligned_count / max(source_count, preview_count)
    source_coverage = min(source_count, expected_frame_count) / max(
        source_count, expected_frame_count
    )
    preview_coverage = min(preview_count, expected_frame_count) / max(
        preview_count, expected_frame_count
    )
    coverage = min(aligned_coverage, source_coverage, preview_coverage)
    return {
        "alignedFrameCount": aligned_count,
        "alignmentOffsetFrames": offset,
        "coverageRatio": round(coverage, 9),
        "expectedFrameCount": expected_frame_count,
        "maximumFrameMeanAbsoluteError": round(max(errors), 9),
        "meanCorrelation": round(sum(correlations) / aligned_count, 9),
        "meanFrameMeanAbsoluteError": round(sum(errors) / aligned_count, 9),
        "minimumFrameCorrelation": round(min(correlations), 9),
        "previewFrameCount": preview_count,
        "sourceFrameCount": source_count,
    }


def _gate_results(metrics: Mapping[str, object]) -> list[Dict[str, object]]:
    audio = metrics["audio"]
    video = metrics["video"]
    if not isinstance(audio, Mapping) or not isinstance(video, Mapping):
        raise ArtifactBindingError("provenance metrics are invalid")
    return [
        {
            "code": "DURATION_MATCH",
            "passed": int(metrics["durationDeltaMs"])
            <= int(_CONFIG["durationToleranceMs"]),
        },
        {
            "code": "AUDIO_SAMPLE_COVERAGE",
            "passed": float(audio["coverageRatio"])
            >= float(_CONFIG["audio"]["minimumCoverageRatio"]),  # type: ignore[index]
        },
        {
            "code": "AUDIO_CORRELATION",
            "passed": float(audio["correlation"])
            >= float(_CONFIG["audio"]["minimumCorrelation"]),  # type: ignore[index]
        },
        {
            "code": "VIDEO_FRAME_COVERAGE",
            "passed": float(video["coverageRatio"])
            >= float(_CONFIG["video"]["minimumCoverageRatio"]),  # type: ignore[index]
        },
        {
            "code": "VIDEO_MEAN_CORRELATION",
            "passed": float(video["meanCorrelation"])
            >= float(_CONFIG["video"]["minimumMeanCorrelation"]),  # type: ignore[index]
        },
        {
            "code": "VIDEO_MIN_CORRELATION",
            "passed": float(video["minimumFrameCorrelation"])
            >= float(_CONFIG["video"]["minimumFrameCorrelation"]),  # type: ignore[index]
        },
    ]


def _base_payload(
    *,
    source_hash: str,
    preview_hash: str,
    start_ms: int,
    end_ms: int,
    runtime: Mapping[str, str],
) -> Dict[str, object]:
    return {
        "schemaVersion": 1,
        "artifactType": PREVIEW_PROVENANCE_ARTIFACT_TYPE,
        "analyzer": {
            "id": PREVIEW_PROVENANCE_ANALYZER_ID,
            "version": PREVIEW_PROVENANCE_VERSION,
        },
        "runtime": dict(runtime),
        "config": _strict_snapshot(_CONFIG, "preview provenance config"),
        "bindings": {
            "sourceSha256": source_hash,
            "previewSha256": preview_hash,
            "sourceIntervalMs": {"startMs": start_ms, "endMs": end_ms},
        },
    }


def _failed_report(base: Mapping[str, object], failure_code: str) -> Dict:
    if failure_code not in _FAILURE_CODES:
        raise ArtifactBindingError("unknown preview provenance failure code")
    return _seal(
        {
            **base,
            "analysisStatus": "failed",
            "failureCode": failure_code,
            "decodedEvidence": None,
            "metrics": None,
            "gates": [{"code": code, "passed": False} for code in _GATE_CODES],
            "passed": False,
            "decision": "review",
        }
    )


def analyze_preview_source_provenance(
    source_path: str,
    preview_path: str,
    source_hash: str,
    preview_hash: str,
    start_ms: int,
    end_ms: int,
) -> Dict:
    """Analyze whether ``preview_path`` is the exact bound source interval.

    Hash and interval binding failures raise ``ArtifactBindingError``.  Media
    runtime/decode failures return a sealed, non-passing report so callers can
    archive the failed attempt while still blocking the human-label boundary.
    """
    source, normalized_source_hash = _validate_media_binding(
        source_path, source_hash, "source"
    )
    preview, normalized_preview_hash = _validate_media_binding(
        preview_path, preview_hash, "preview"
    )
    normalized_start, normalized_end = _validate_interval(start_ms, end_ms)

    ffmpeg_path = shutil.which("ffmpeg")
    ffprobe_path = shutil.which("ffprobe")
    if not ffmpeg_path or not ffprobe_path:
        runtime = _partial_runtime_identity(
            ffmpeg_path,
            ffprobe_path,
            "not_probed",
        )
        base = _base_payload(
            source_hash=normalized_source_hash,
            preview_hash=normalized_preview_hash,
            start_ms=normalized_start,
            end_ms=normalized_end,
            runtime=runtime,
        )
        return _failed_report(base, "ffmpeg_unavailable")

    try:
        import numpy as np  # type: ignore
    except ImportError:
        runtime = _partial_runtime_identity(
            ffmpeg_path,
            ffprobe_path,
            "unavailable",
        )
        base = _base_payload(
            source_hash=normalized_source_hash,
            preview_hash=normalized_preview_hash,
            start_ms=normalized_start,
            end_ms=normalized_end,
            runtime=runtime,
        )
        return _failed_report(base, "numeric_analysis_failed")

    try:
        runtime = _runtime_identity(ffmpeg_path, ffprobe_path, np.__version__)
    except RuntimeError:
        runtime = {
            "ffmpegVersion": "probe_failed",
            "ffprobeVersion": "probe_failed",
            "numpyVersion": str(np.__version__),
            "pythonVersion": platform.python_version(),
        }
        base = _base_payload(
            source_hash=normalized_source_hash,
            preview_hash=normalized_preview_hash,
            start_ms=normalized_start,
            end_ms=normalized_end,
            runtime=runtime,
        )
        return _failed_report(base, "ffmpeg_runtime_probe_failed")

    base = _base_payload(
        source_hash=normalized_source_hash,
        preview_hash=normalized_preview_hash,
        start_ms=normalized_start,
        end_ms=normalized_end,
        runtime=runtime,
    )
    expected_duration_ms = normalized_end - normalized_start
    try:
        preview_duration_ms = _probe_duration_ms(ffprobe_path, preview)
    except RuntimeError:
        return _failed_report(base, "preview_duration_probe_failed")
    if abs(preview_duration_ms - expected_duration_ms) > int(
        _CONFIG["durationToleranceMs"]
    ):
        return _failed_report(base, "preview_duration_mismatch")

    try:
        source_audio = _decode_audio(
            ffmpeg_path,
            source,
            start_ms=normalized_start,
            duration_ms=expected_duration_ms,
        )
    except RuntimeError:
        return _failed_report(base, "source_audio_decode_failed")
    try:
        preview_audio = _decode_audio(ffmpeg_path, preview)
    except RuntimeError:
        return _failed_report(base, "preview_audio_decode_failed")
    try:
        source_video = _decode_video(
            ffmpeg_path,
            source,
            start_ms=normalized_start,
            duration_ms=expected_duration_ms,
        )
    except RuntimeError:
        return _failed_report(base, "source_video_decode_failed")
    try:
        preview_video = _decode_video(ffmpeg_path, preview)
    except RuntimeError:
        return _failed_report(base, "preview_video_decode_failed")

    try:
        audio_metrics = _audio_alignment(
            source_audio,
            preview_audio,
            expected_duration_ms,
            np,
        )
    except (ValueError, ArithmeticError, FloatingPointError):
        return _failed_report(base, "audio_alignment_failed")
    try:
        video_metrics = _video_alignment(
            source_video,
            preview_video,
            expected_duration_ms,
            np,
        )
    except (ValueError, ArithmeticError, FloatingPointError):
        return _failed_report(base, "video_alignment_failed")

    metrics: Dict[str, object] = {
        "expectedDurationMs": expected_duration_ms,
        "previewDurationMs": preview_duration_ms,
        "durationDeltaMs": abs(preview_duration_ms - expected_duration_ms),
        "audio": audio_metrics,
        "video": video_metrics,
    }
    gates = _gate_results(metrics)
    passed = all(bool(gate["passed"]) for gate in gates)
    decoded_evidence = {
        "sourceAudioF32leSha256": hashlib.sha256(source_audio).hexdigest(),
        "previewAudioF32leSha256": hashlib.sha256(preview_audio).hexdigest(),
        "sourceVideoRgb24Sha256": hashlib.sha256(source_video).hexdigest(),
        "previewVideoRgb24Sha256": hashlib.sha256(preview_video).hexdigest(),
    }
    return _seal(
        {
            **base,
            "analysisStatus": "complete",
            "failureCode": None,
            "decodedEvidence": decoded_evidence,
            "metrics": metrics,
            "gates": gates,
            "passed": passed,
            "decision": "pass" if passed else "review",
        }
    )


def _verify_runtime(runtime: object) -> None:
    if not isinstance(runtime, dict) or set(runtime) != {
        "ffmpegVersion",
        "ffprobeVersion",
        "numpyVersion",
        "pythonVersion",
    }:
        raise ArtifactBindingError("preview provenance runtime is invalid")
    if any(not isinstance(value, str) or not value.strip() for value in runtime.values()):
        raise ArtifactBindingError("preview provenance runtime is invalid")


def _verify_decoded_evidence(evidence: object) -> None:
    expected = {
        "sourceAudioF32leSha256",
        "previewAudioF32leSha256",
        "sourceVideoRgb24Sha256",
        "previewVideoRgb24Sha256",
    }
    if not isinstance(evidence, dict) or set(evidence) != expected:
        raise ArtifactBindingError("decodedEvidence is invalid")
    for field in expected:
        _sha256(evidence.get(field), f"decodedEvidence.{field}")


def _verify_metrics(metrics: object, start_ms: int, end_ms: int) -> Dict:
    if not isinstance(metrics, dict) or set(metrics) != {
        "expectedDurationMs",
        "previewDurationMs",
        "durationDeltaMs",
        "audio",
        "video",
    }:
        raise ArtifactBindingError("preview provenance metrics are invalid")
    expected_duration = _strict_integer(
        metrics.get("expectedDurationMs"), "metrics.expectedDurationMs", minimum=1
    )
    if expected_duration != end_ms - start_ms:
        raise ArtifactBindingError("metrics.expectedDurationMs is stale")
    preview_duration = _strict_integer(
        metrics.get("previewDurationMs"), "metrics.previewDurationMs", minimum=1
    )
    duration_delta = _strict_integer(
        metrics.get("durationDeltaMs"), "metrics.durationDeltaMs", minimum=0
    )
    if duration_delta != abs(preview_duration - expected_duration):
        raise ArtifactBindingError("metrics.durationDeltaMs is inconsistent")

    audio = metrics.get("audio")
    if not isinstance(audio, dict) or set(audio) != {
        "alignedSampleCount",
        "alignmentOffsetMs",
        "alignmentOffsetSamples",
        "correlation",
        "coverageRatio",
        "expectedSampleCount",
        "previewSampleCount",
        "sourceSampleCount",
    }:
        raise ArtifactBindingError("metrics.audio is invalid")
    aligned_samples = _strict_integer(
        audio.get("alignedSampleCount"), "metrics.audio.alignedSampleCount", minimum=1
    )
    expected_samples = _strict_integer(
        audio.get("expectedSampleCount"), "metrics.audio.expectedSampleCount", minimum=1
    )
    if expected_samples != int(round(expected_duration * 8.0)):
        raise ArtifactBindingError("metrics.audio.expectedSampleCount is stale")
    source_samples = _strict_integer(
        audio.get("sourceSampleCount"), "metrics.audio.sourceSampleCount", minimum=1
    )
    preview_samples = _strict_integer(
        audio.get("previewSampleCount"), "metrics.audio.previewSampleCount", minimum=1
    )
    offset_samples_raw = audio.get("alignmentOffsetSamples")
    if isinstance(offset_samples_raw, bool) or not isinstance(offset_samples_raw, int):
        raise ArtifactBindingError("metrics.audio.alignmentOffsetSamples must be an integer")
    maximum_audio_offset = int(_CONFIG["audio"]["maximumAlignmentMs"] * 8)  # type: ignore[index]
    if abs(offset_samples_raw) > maximum_audio_offset:
        raise ArtifactBindingError("metrics.audio alignment exceeds config")
    offset_ms = _finite_float(
        audio.get("alignmentOffsetMs"), "metrics.audio.alignmentOffsetMs"
    )
    if abs(offset_ms - offset_samples_raw / 8.0) > 0.0005:
        raise ArtifactBindingError("metrics.audio alignment units are inconsistent")
    correlation = _finite_float(
        audio.get("correlation"), "metrics.audio.correlation", minimum=-1.0, maximum=1.0
    )
    coverage = _finite_float(
        audio.get("coverageRatio"), "metrics.audio.coverageRatio", minimum=0.0, maximum=1.0
    )
    expected_coverage = min(
        aligned_samples / max(source_samples, preview_samples),
        min(source_samples, expected_samples) / max(source_samples, expected_samples),
        min(preview_samples, expected_samples)
        / max(preview_samples, expected_samples),
    )
    if abs(coverage - expected_coverage) > 1e-8:
        raise ArtifactBindingError("metrics.audio.coverageRatio is inconsistent")

    video = metrics.get("video")
    if not isinstance(video, dict) or set(video) != {
        "alignedFrameCount",
        "alignmentOffsetFrames",
        "coverageRatio",
        "expectedFrameCount",
        "maximumFrameMeanAbsoluteError",
        "meanCorrelation",
        "meanFrameMeanAbsoluteError",
        "minimumFrameCorrelation",
        "previewFrameCount",
        "sourceFrameCount",
    }:
        raise ArtifactBindingError("metrics.video is invalid")
    aligned_frames = _strict_integer(
        video.get("alignedFrameCount"), "metrics.video.alignedFrameCount", minimum=1
    )
    expected_frames = _strict_integer(
        video.get("expectedFrameCount"), "metrics.video.expectedFrameCount", minimum=1
    )
    actual_expected_frames = max(
        1, int(math.floor(expected_duration / 1000.0 + 0.5))
    )
    if expected_frames != actual_expected_frames:
        raise ArtifactBindingError("metrics.video.expectedFrameCount is stale")
    source_frames = _strict_integer(
        video.get("sourceFrameCount"), "metrics.video.sourceFrameCount", minimum=1
    )
    preview_frames = _strict_integer(
        video.get("previewFrameCount"), "metrics.video.previewFrameCount", minimum=1
    )
    offset_frames = video.get("alignmentOffsetFrames")
    if isinstance(offset_frames, bool) or not isinstance(offset_frames, int):
        raise ArtifactBindingError("metrics.video.alignmentOffsetFrames must be an integer")
    if abs(offset_frames) > int(_CONFIG["video"]["maximumAlignmentFrames"]):  # type: ignore[index]
        raise ArtifactBindingError("metrics.video alignment exceeds config")
    video_coverage = _finite_float(
        video.get("coverageRatio"), "metrics.video.coverageRatio", minimum=0.0, maximum=1.0
    )
    expected_video_coverage = min(
        aligned_frames / max(source_frames, preview_frames),
        min(source_frames, expected_frames) / max(source_frames, expected_frames),
        min(preview_frames, expected_frames) / max(preview_frames, expected_frames),
    )
    if abs(video_coverage - expected_video_coverage) > 1e-8:
        raise ArtifactBindingError("metrics.video.coverageRatio is inconsistent")
    mean_correlation = _finite_float(
        video.get("meanCorrelation"), "metrics.video.meanCorrelation", minimum=-1.0, maximum=1.0
    )
    minimum_correlation = _finite_float(
        video.get("minimumFrameCorrelation"),
        "metrics.video.minimumFrameCorrelation",
        minimum=-1.0,
        maximum=1.0,
    )
    if minimum_correlation > mean_correlation + 1e-9:
        raise ArtifactBindingError("metrics.video correlations are inconsistent")
    mean_error = _finite_float(
        video.get("meanFrameMeanAbsoluteError"),
        "metrics.video.meanFrameMeanAbsoluteError",
        minimum=0.0,
        maximum=1.0,
    )
    maximum_error = _finite_float(
        video.get("maximumFrameMeanAbsoluteError"),
        "metrics.video.maximumFrameMeanAbsoluteError",
        minimum=0.0,
        maximum=1.0,
    )
    if mean_error > maximum_error + 1e-9:
        raise ArtifactBindingError("metrics.video errors are inconsistent")

    # Return a detached strict snapshot for deterministic gate re-evaluation.
    snapshot = _strict_snapshot(metrics, "preview provenance metrics")
    if not isinstance(snapshot, dict):  # pragma: no cover - defensive
        raise ArtifactBindingError("preview provenance metrics are invalid")
    return snapshot


def verify_preview_source_provenance(
    report: Dict,
    *,
    source_hash: str,
    preview_hash: str,
    start_ms: int,
    end_ms: int,
    require_pass: bool = True,
) -> Dict:
    """Verify seal, exact bindings, measured invariants, and gate outcome."""
    verify_seal(report, PREVIEW_PROVENANCE_ARTIFACT_TYPE)
    if set(report) != {
        "schemaVersion",
        "artifactType",
        "analyzer",
        "runtime",
        "config",
        "bindings",
        "analysisStatus",
        "failureCode",
        "decodedEvidence",
        "metrics",
        "gates",
        "passed",
        "decision",
        "contentHash",
    }:
        raise ArtifactBindingError("preview provenance report fields are invalid")
    if report.get("schemaVersion") != 1:
        raise ArtifactBindingError("preview provenance schemaVersion is invalid")
    if report.get("analyzer") != {
        "id": PREVIEW_PROVENANCE_ANALYZER_ID,
        "version": PREVIEW_PROVENANCE_VERSION,
    }:
        raise ArtifactBindingError("preview provenance analyzer identity is invalid")
    if report.get("config") != _CONFIG:
        raise ArtifactBindingError("preview provenance config is stale")
    _verify_runtime(report.get("runtime"))

    normalized_source_hash = _sha256(source_hash, "sourceSha256")
    normalized_preview_hash = _sha256(preview_hash, "previewSha256")
    normalized_start, normalized_end = _validate_interval(start_ms, end_ms)
    expected_bindings = {
        "sourceSha256": normalized_source_hash,
        "previewSha256": normalized_preview_hash,
        "sourceIntervalMs": {
            "startMs": normalized_start,
            "endMs": normalized_end,
        },
    }
    if report.get("bindings") != expected_bindings:
        raise ArtifactBindingError("preview provenance bindings do not match")

    status = report.get("analysisStatus")
    if status == "failed":
        if report.get("failureCode") not in _FAILURE_CODES:
            raise ArtifactBindingError("preview provenance failureCode is invalid")
        if report.get("decodedEvidence") is not None or report.get("metrics") is not None:
            raise ArtifactBindingError("failed provenance report contains measurements")
        expected_gates = [{"code": code, "passed": False} for code in _GATE_CODES]
        if report.get("gates") != expected_gates:
            raise ArtifactBindingError("failed provenance gates are invalid")
        if report.get("passed") is not False or report.get("decision") != "review":
            raise ArtifactBindingError("failed provenance decision is invalid")
    elif status == "complete":
        if report.get("failureCode") is not None:
            raise ArtifactBindingError("complete provenance report has a failureCode")
        _verify_decoded_evidence(report.get("decodedEvidence"))
        metrics = _verify_metrics(report.get("metrics"), normalized_start, normalized_end)
        expected_gates = _gate_results(metrics)
        if report.get("gates") != expected_gates:
            raise ArtifactBindingError("preview provenance gates are stale")
        expected_passed = all(bool(gate["passed"]) for gate in expected_gates)
        if report.get("passed") is not expected_passed:
            raise ArtifactBindingError("preview provenance passed flag is stale")
        expected_decision = "pass" if expected_passed else "review"
        if report.get("decision") != expected_decision:
            raise ArtifactBindingError("preview provenance decision is stale")
    else:
        raise ArtifactBindingError("preview provenance analysisStatus is invalid")

    if require_pass and report.get("passed") is not True:
        raise ArtifactBindingError("preview source provenance did not pass")
    return report


__all__ = [
    "PREVIEW_PROVENANCE_ANALYZER_ID",
    "PREVIEW_PROVENANCE_ARTIFACT_TYPE",
    "PREVIEW_PROVENANCE_VERSION",
    "analyze_preview_source_provenance",
    "verify_preview_source_provenance",
]
