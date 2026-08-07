"""Read-only local provider for sealed DeliveryQuality evidence."""
from __future__ import annotations

import array
import math
import subprocess
from typing import Any, Callable, Dict, Iterable, Optional, Sequence

from ..artifact_contracts import ArtifactBindingError, transcript_timing_hash
from ..delivery_quality import (
    DELIVERY_QUALITY_ACOUSTIC_PROVIDER,
    DELIVERY_QUALITY_ANALYZER_VERSION,
    DELIVERY_QUALITY_DECISION_VERSION,
    DELIVERY_QUALITY_SAMPLE_RATE,
    evaluate_delivery_quality_evidence,
    verify_delivery_quality_report,
)
from .spoken_clarity import _timed_words_in_half_open_interval


DELIVERY_QUALITY_RMS_WINDOW_MILLISECONDS = 50.0


def _callable_identity(value: object, default: str) -> object:
    if value is None:
        return default
    explicit = getattr(value, "provider_identity", None)
    if explicit is None:
        explicit = getattr(value, "identity", None)
    if callable(explicit):
        explicit = explicit()
    if explicit is not None:
        return explicit
    module = getattr(value, "__module__", value.__class__.__module__)
    name = getattr(value, "__qualname__", value.__class__.__qualname__)
    return f"{module}.{name}"


def _provider_identity(audio_decoder: Optional[Callable]) -> Dict:
    return {
        "analyzerVersion": DELIVERY_QUALITY_ANALYZER_VERSION,
        "decisionVersion": DELIVERY_QUALITY_DECISION_VERSION,
        "acousticProvider": DELIVERY_QUALITY_ACOUSTIC_PROVIDER,
        "audioDecoder": _callable_identity(audio_decoder, "ffmpeg-f32le-v1"),
        "sampleRate": DELIVERY_QUALITY_SAMPLE_RATE,
        "rmsWindowMilliseconds": DELIVERY_QUALITY_RMS_WINDOW_MILLISECONDS,
        "audioPolicy": "read_only_source_contiguous_selection",
        "affectInferenceUsed": False,
    }


def _decode_interval_mono_16k(
    source_path: str,
    speech_start: float,
    speech_end: float,
    *,
    sample_rate: int = DELIVERY_QUALITY_SAMPLE_RATE,
):
    duration = speech_end - speech_start
    command = [
        "ffmpeg",
        "-v",
        "error",
        "-ss",
        f"{speech_start:.9f}",
        "-i",
        str(source_path),
        "-t",
        f"{duration:.9f}",
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(int(sample_rate)),
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-",
    ]
    try:
        result = subprocess.run(command, check=True, capture_output=True)
    except FileNotFoundError as error:
        raise RuntimeError("ffmpeg is required for delivery-quality analysis") from error
    except subprocess.CalledProcessError as error:
        raise RuntimeError("ffmpeg delivery-quality decode failed") from error
    if not result.stdout:
        raise RuntimeError("ffmpeg returned no delivery-quality audio")
    samples = array.array("f")
    samples.frombytes(result.stdout)
    if not samples:
        raise RuntimeError("ffmpeg returned no delivery-quality samples")
    return samples


def _invoke_audio_decoder(
    decoder: Callable,
    source_path: str,
    speech_start: float,
    speech_end: float,
):
    return decoder(
        source_path,
        speech_start,
        speech_end,
        sample_rate=DELIVERY_QUALITY_SAMPLE_RATE,
    )


def _coerce_samples(value: object) -> list[float]:
    if isinstance(value, (bytes, bytearray, memoryview)):
        samples = array.array("f")
        samples.frombytes(bytes(value))
        raw: Iterable[object] = samples
    else:
        try:
            raw = iter(value)  # type: ignore[arg-type]
        except TypeError as error:
            raise RuntimeError("delivery-quality decoder returned invalid audio") from error
    output = []
    for sample in raw:
        try:
            number = float(sample)
        except (TypeError, ValueError) as error:
            raise RuntimeError("delivery-quality decoder returned invalid audio") from error
        if not math.isfinite(number):
            raise RuntimeError("delivery-quality decoder returned non-finite audio")
        output.append(number)
    if not output:
        raise RuntimeError("delivery-quality decoder returned no audio")
    return output


def _dbfs(amplitude: float) -> float:
    return max(-240.0, 20.0 * math.log10(max(float(amplitude), 1e-12)))


def _percentile(values: Sequence[float], quantile: float) -> float:
    if not values:
        return -240.0
    ordered = sorted(float(value) for value in values)
    position = max(0.0, min(1.0, quantile)) * (len(ordered) - 1)
    left = int(math.floor(position))
    right = int(math.ceil(position))
    if left == right:
        return ordered[left]
    weight = position - left
    return ordered[left] * (1.0 - weight) + ordered[right] * weight


def _rms_dynamics(samples: object) -> Dict:
    values = _coerce_samples(samples)
    frame_size = max(
        1,
        int(
            round(
                DELIVERY_QUALITY_SAMPLE_RATE
                * DELIVERY_QUALITY_RMS_WINDOW_MILLISECONDS
                / 1000.0
            )
        ),
    )
    minimum_frame = max(1, int(DELIVERY_QUALITY_SAMPLE_RATE * 0.010))
    frame_db = []
    for offset in range(0, len(values), frame_size):
        frame = values[offset : offset + frame_size]
        if len(frame) < minimum_frame:
            continue
        rms = math.sqrt(sum(sample * sample for sample in frame) / len(frame))
        frame_db.append(_dbfs(rms))
    if not frame_db:
        raise RuntimeError("delivery-quality interval is shorter than one RMS frame")
    overall_rms = math.sqrt(sum(sample * sample for sample in values) / len(values))
    peak = max(abs(sample) for sample in values)
    overall_db = _dbfs(overall_rms)
    peak_db = _dbfs(peak)
    active_threshold = max(-55.0, peak_db - 35.0)
    active_frames = [value for value in frame_db if value >= active_threshold]
    dynamic_range = (
        max(0.0, _percentile(active_frames, 0.90) - _percentile(active_frames, 0.10))
        if active_frames
        else 0.0
    )
    return {
        "available": True,
        "sampleRate": DELIVERY_QUALITY_SAMPLE_RATE,
        "sampleCount": len(values),
        "frameCount": len(frame_db),
        "frameWindowMilliseconds": DELIVERY_QUALITY_RMS_WINDOW_MILLISECONDS,
        "overallRmsDbfs": round(overall_db, 6),
        "peakDbfs": round(peak_db, 6),
        "activeFrameRatio": round(len(active_frames) / len(frame_db), 6),
        "activeFrameThresholdDbfs": round(active_threshold, 6),
        "rmsDynamicRangeDb": round(dynamic_range, 6),
        "crestFactorDb": round(max(0.0, peak_db - overall_db), 6),
    }


def _missing_acoustic_measurements() -> Dict:
    return {
        "available": False,
        "sampleRate": DELIVERY_QUALITY_SAMPLE_RATE,
        "sampleCount": 0,
        "frameCount": 0,
        "frameWindowMilliseconds": None,
        "overallRmsDbfs": None,
        "peakDbfs": None,
        "activeFrameRatio": None,
        "activeFrameThresholdDbfs": None,
        "rmsDynamicRangeDb": None,
        "crestFactorDb": None,
    }


def _candidate_with_report(candidate: Dict, report: Dict) -> Dict:
    verified = verify_delivery_quality_report(report)
    item = dict(candidate)
    item.update(
        {
            "deliveryQualityReport": verified,
            "deliveryQualityStatus": verified["status"],
            "deliveryQualityEligible": verified["eligible"],
            "deliveryQualityStrength": verified["deliveryStrength"],
            "deliveryQualityRejectionReasons": list(verified["rejectionReasons"]),
            "deliveryQualityReviewReasons": list(verified["reviewReasons"]),
            "delivery_quality_decision_version": verified["decisionVersion"],
            "delivery_quality_status": verified["status"],
            "delivery_quality_eligible": verified["eligible"],
            "delivery_quality_strength": verified["deliveryStrength"],
            "delivery_quality_reject_reasons": list(verified["rejectionReasons"]),
            "delivery_quality_review_reasons": list(verified["reviewReasons"]),
            "delivery_quality_provider_status": verified["providerStatus"],
        }
    )
    return item


def analyze_motivational_delivery_quality(
    source_path: str,
    candidates: Sequence[Dict],
    transcript: Dict,
    source_hash: str,
    telemetry: Optional[Any] = None,
    audio_decoder: Optional[Callable] = None,
) -> list[Dict]:
    """Attach exact-interval DeliveryQuality reports to candidate copies.

    Decode/provider failures become review evidence.  Invalid or stale sealed
    SpokenClarity input remains an integrity error and is never downgraded.
    """
    transcript_hash = transcript_timing_hash(transcript)
    identity = _provider_identity(audio_decoder)
    decoder = audio_decoder or _decode_interval_mono_16k
    output = []
    for candidate in candidates:
        item = dict(candidate)
        try:
            speech_start = float(
                item.get("speech_start_time", item.get("start_time"))
            )
            speech_end = float(item.get("speech_end_time", item.get("end_time")))
        except (TypeError, ValueError) as error:
            raise ArtifactBindingError("candidate speech interval is invalid") from error
        if (
            not math.isfinite(speech_start)
            or not math.isfinite(speech_end)
            or speech_start < 0.0
            or speech_end <= speech_start
        ):
            raise ArtifactBindingError("candidate speech interval is invalid")
        timed_words = _timed_words_in_half_open_interval(
            transcript, speech_start, speech_end
        )
        clarity_report = item.get("spokenClarityReport")
        if clarity_report is None:
            clarity_report = item.get("spoken_clarity_report")

        provider_status = "ok"
        acoustic = _missing_acoustic_measurements()
        try:
            decoded = _invoke_audio_decoder(
                decoder, source_path, speech_start, speech_end
            )
            acoustic = _rms_dynamics(decoded)
        except Exception:
            provider_status = "audio_decode_error"

        if telemetry is not None:
            recorder = getattr(telemetry, "event", None)
            if callable(recorder):
                recorder(
                    "delivery_quality",
                    providerStatus=provider_status,
                    durationSeconds=round(speech_end - speech_start, 3),
                )
        report = evaluate_delivery_quality_evidence(
            source_hash=source_hash,
            transcript_timing_hash=transcript_hash,
            speech_start=speech_start,
            speech_end=speech_end,
            timed_words=timed_words,
            spoken_clarity_report=clarity_report,
            acoustic_measurements=acoustic,
            provider_status=provider_status,
            provider_identity=identity,
        )
        output.append(_candidate_with_report(item, report))
    return output


__all__ = [
    "DELIVERY_QUALITY_RMS_WINDOW_MILLISECONDS",
    "_decode_interval_mono_16k",
    "_rms_dynamics",
    "analyze_motivational_delivery_quality",
]
