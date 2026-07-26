"""Deterministic QA for the Budget Friendly editorial-inset render profile.

The checks in this module deliberately inspect both the encoded video and the
immutable render manifest.  Pixel checks can prove geometry and grade, while
timeline checks such as hook latency and artificial-cut count must come from
the edit plan that produced the render.
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
from pathlib import Path
from typing import Dict, Iterable, Optional, Tuple

from .profiles import (
    BF_EDITORIAL_INSET_V2,
    BF_GROWTH_V2,
    BF_NATURAL_TAIL_V6,
    BF_REFERENCE_TAIL_V2,
    BF_SMOOTH_TAIL_V3,
    BF_SMOOTH_TAIL_V4,
    BF_SMOOTH_TAIL_V5,
)


BF_EDITORIAL_INSET_PROFILE = "bf_editorial_inset_v1"
BF_VIRAL_MICRO_FORMAT = "bf_viral_micro_v1"
BF_EDITORIAL_QA_PROFILE = "bf_editorial_qa_v2"
_SMOOTH_TAIL_PROFILES = {
    BF_SMOOTH_TAIL_V3,
    BF_SMOOTH_TAIL_V4,
    BF_SMOOTH_TAIL_V5,
    BF_NATURAL_TAIL_V6,
}


def _canonical_hash(payload: Dict) -> str:
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def expected_inset_box(
    frame_size: Tuple[int, int],
    width_ratio: float = 0.9444,
    source_ratio: float = 16.0 / 9.0,
) -> Tuple[int, int, int, int]:
    """Return the versioned 16:9 panel geometry for a vertical frame."""
    width, height = frame_size
    inset_width = max(2, int(round(width * width_ratio)))
    inset_height = max(2, int(round(inset_width / source_ratio)))
    return (
        (width - inset_width) // 2,
        (height - inset_height) // 2,
        inset_width,
        inset_height,
    )


def analyze_editorial_frame(frame, black_threshold: int = 8) -> Dict:
    """Measure black-canvas, grayscale and rounded-corner signals on one frame."""
    import numpy as np

    if frame is None or getattr(frame, "ndim", 0) != 3 or frame.shape[2] < 3:
        raise ValueError("frame must be a BGR image")
    height, width = frame.shape[:2]
    left, top, inset_width, inset_height = expected_inset_box((width, height))
    right = left + inset_width
    bottom = top + inset_height

    outside = np.ones((height, width), dtype=bool)
    outside[top:bottom, left:right] = False
    outside_pixels = frame[outside]
    outside_black_ratio = float(
        np.mean(np.max(outside_pixels[:, :3], axis=1) <= black_threshold)
    ) if outside_pixels.size else 1.0

    inset = frame[top:bottom, left:right, :3]
    channel_delta = np.max(inset, axis=2).astype(np.int16) - np.min(
        inset,
        axis=2,
    ).astype(np.int16)
    grayscale_mean_delta = float(np.mean(channel_delta) / 255.0)
    inset_nonblack_ratio = float(
        np.mean(np.max(inset, axis=2) > black_threshold)
    )
    nonblack_y, nonblack_x = np.where(np.max(frame[:, :, :3], axis=2) > black_threshold)
    if len(nonblack_x):
        observed_left = int(nonblack_x.min())
        observed_top = int(nonblack_y.min())
        observed_width = int(nonblack_x.max() - observed_left + 1)
        observed_height = int(nonblack_y.max() - observed_top + 1)
        observed_box = {
            "x": observed_left,
            "y": observed_top,
            "width": observed_width,
            "height": observed_height,
        }
        observed_width_ratio = observed_width / width
        observed_height_ratio = observed_height / height
    else:
        observed_box = None
        observed_width_ratio = 0.0
        observed_height_ratio = 0.0

    radius = max(1, int(round(inset_height * 0.18)))
    corner_patches = (
        inset[:radius, :radius],
        inset[:radius, -radius:],
        inset[-radius:, :radius],
        inset[-radius:, -radius:],
    )
    rounded_corner_black_ratio = float(
        np.mean(
            [
                np.mean(np.max(patch, axis=2) <= black_threshold)
                for patch in corner_patches
                if patch.size
            ]
        )
    )
    return {
        "frameWidth": width,
        "frameHeight": height,
        "insetBox": {
            "x": left,
            "y": top,
            "width": inset_width,
            "height": inset_height,
        },
        "insetWidthRatio": inset_width / width,
        "insetHeightRatio": inset_height / height,
        "outsideBlackRatio": outside_black_ratio,
        "grayscaleMeanChannelDelta": grayscale_mean_delta,
        "insetNonBlackRatio": inset_nonblack_ratio,
        "observedNonBlackBox": observed_box,
        "observedNonBlackWidthRatio": observed_width_ratio,
        "observedNonBlackHeightRatio": observed_height_ratio,
        "roundedCornerBlackRatio": rounded_corner_black_ratio,
    }


def _sample_indices(frame_count: int, sample_count: int) -> Iterable[int]:
    if frame_count <= 1:
        return (0,)
    count = max(2, min(sample_count, frame_count))
    return tuple(
        sorted(
            {
                int(round(index * (frame_count - 1) / (count - 1)))
                for index in range(count)
            }
        )
    )


def _gate(code: str, passed: bool, actual, expected: str, category: str) -> Dict:
    return {
        "code": code,
        "category": category,
        "passed": bool(passed),
        "actual": actual,
        "expected": expected,
    }


def _safe_float(value, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _safe_int(value, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _parse_frame_rate(value) -> float:
    """Return a positive finite FPS value from an ffprobe rate field."""
    try:
        numerator, separator, denominator = str(value).partition("/")
        rate = (
            float(numerator) / float(denominator)
            if separator
            else float(numerator)
        )
    except (TypeError, ValueError, ZeroDivisionError):
        return 0.0
    return rate if rate > 0.0 and math.isfinite(rate) else 0.0


def _probe_video_metadata_ffprobe(
    video_path: str,
    runner=None,
) -> Optional[Tuple[int, int, float, int]]:
    """Read legacy QA metadata without importing or starting OpenCV."""
    run = runner or subprocess.run
    try:
        result = run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                (
                    "stream=width,height,avg_frame_rate,r_frame_rate,"
                    "nb_frames,duration:format=duration"
                ),
                "-of",
                "json",
                video_path,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        if getattr(result, "returncode", 0) not in (None, 0):
            return None
        payload = json.loads(result.stdout or "{}")
        streams = payload.get("streams") if isinstance(payload, dict) else None
        stream = streams[0] if isinstance(streams, list) and streams else None
        if not isinstance(stream, dict):
            return None

        width = _safe_int(stream.get("width"), 0)
        height = _safe_int(stream.get("height"), 0)
        fps = _parse_frame_rate(stream.get("avg_frame_rate"))
        if fps <= 0.0:
            fps = _parse_frame_rate(stream.get("r_frame_rate"))
        frame_count = _safe_int(stream.get("nb_frames"), 0)
        if frame_count <= 0:
            duration = _safe_float(stream.get("duration"), 0.0)
            if duration <= 0.0:
                format_metadata = payload.get("format")
                if isinstance(format_metadata, dict):
                    duration = _safe_float(format_metadata.get("duration"), 0.0)
            if duration > 0.0 and math.isfinite(duration) and fps > 0.0:
                frame_count = max(1, int(round(duration * fps)))
    except (
        AttributeError,
        json.JSONDecodeError,
        OSError,
        OverflowError,
        subprocess.SubprocessError,
        TypeError,
        ValueError,
    ):
        return None

    if width <= 0 or height <= 0 or fps <= 0.0 or frame_count <= 0:
        return None
    return width, height, fps, frame_count


def _decode_sampled_frames_ffmpeg(
    video_path: str,
    width: int,
    height: int,
    frame_indices: Iterable[int],
    runner=None,
):
    """Decode selected frames as BGR arrays, returning ``None`` on failure."""
    import numpy as np

    indices = tuple(sorted({int(index) for index in frame_indices if int(index) >= 0}))
    if width <= 0 or height <= 0 or not indices:
        return None
    select_filter = "select=" + "+".join(
        f"eq(n\\,{frame_index})" for frame_index in indices
    )
    run = runner or subprocess.run
    try:
        result = run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-nostdin",
                "-noautorotate",
                "-i",
                video_path,
                "-map",
                "0:v:0",
                "-vf",
                select_filter,
                "-vsync",
                "0",
                "-an",
                "-sn",
                "-dn",
                "-pix_fmt",
                "bgr24",
                "-f",
                "rawvideo",
                "pipe:1",
            ],
            check=True,
            capture_output=True,
        )
        if getattr(result, "returncode", 0) not in (None, 0):
            return None
        raw_frames = result.stdout
        if not isinstance(raw_frames, (bytes, bytearray, memoryview)):
            return None
        bytes_per_frame = width * height * 3
        if not raw_frames or len(raw_frames) % bytes_per_frame:
            return None
        decoded_count = len(raw_frames) // bytes_per_frame
        if decoded_count > len(indices):
            return None
        decoded = np.frombuffer(raw_frames, dtype=np.uint8).reshape(
            decoded_count,
            height,
            width,
            3,
        )
    except (
        AttributeError,
        OSError,
        OverflowError,
        subprocess.SubprocessError,
        TypeError,
        ValueError,
    ):
        return None
    return [decoded[index] for index in range(decoded_count)]


def _inspect_video_cv2(
    video_path: str,
    sample_count: int,
) -> Tuple[int, int, float, int, list]:
    """Inspect with OpenCV when the ffmpeg fast path is unavailable."""
    try:
        import cv2  # type: ignore
    except ImportError as error:  # pragma: no cover - exercised in minimal envs
        raise RuntimeError("opencv-python is required for editorial render QA") from error

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"could not open {video_path}")
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    frame_count = max(1, int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 1))
    samples = []
    try:
        for frame_index in _sample_indices(frame_count, sample_count):
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            ok, frame = cap.read()
            if ok and frame is not None:
                samples.append(analyze_editorial_frame(frame))
    finally:
        cap.release()
    if not samples:
        raise RuntimeError(f"could not sample frames from {video_path}")
    return width, height, fps, frame_count, samples


def evaluate_editorial_render(
    video_path: str,
    render_manifest: Optional[Dict] = None,
    sample_count: int = 9,
    runner=None,
) -> Dict:
    """Return a hash-bound QA report for ``bf_editorial_inset_v1``.

    The function is read-only and performs no repair.  Any missing timeline
    evidence fails closed when a render manifest is supplied.
    """
    path = Path(video_path)
    if not path.is_file():
        raise FileNotFoundError(video_path)
    metadata = _probe_video_metadata_ffprobe(str(path), runner=runner)
    if metadata is not None:
        width, height, fps, frame_count = metadata
        frames = _decode_sampled_frames_ffmpeg(
            str(path),
            width,
            height,
            _sample_indices(frame_count, sample_count),
            runner=runner,
        )
    else:
        frames = None
    if frames:
        samples = [analyze_editorial_frame(frame) for frame in frames]
    else:
        width, height, fps, frame_count, samples = _inspect_video_cv2(
            str(path),
            sample_count,
        )
    duration = frame_count / fps if fps > 0 else 0.0

    outside_black = min(item["outsideBlackRatio"] for item in samples)
    grayscale_delta = max(item["grayscaleMeanChannelDelta"] for item in samples)
    rounded_corners = min(item["roundedCornerBlackRatio"] for item in samples)
    content_samples = [
        item for item in samples if item["insetNonBlackRatio"] >= 0.10
    ]
    inset_width_ratio = max(
        (item["observedNonBlackWidthRatio"] for item in content_samples),
        default=0.0,
    )
    inset_height_ratio = max(
        (item["observedNonBlackHeightRatio"] for item in content_samples),
        default=0.0,
    )
    declared_tail_profile = str(
        (
            (render_manifest or {}).get("brandTail")
            if isinstance((render_manifest or {}).get("brandTail"), dict)
            else {}
        ).get("profile")
        or ""
    ).strip().lower()
    duration_max = (
        31.5
        if declared_tail_profile == BF_NATURAL_TAIL_V6
        else 24.5
    )

    gates = [
        _gate("OUTPUT_DIMENSIONS", (width, height) == (1080, 1920), f"{width}x{height}", "1080x1920", "output"),
        _gate("OUTPUT_FPS", 29.5 <= fps <= 30.5, round(fps, 3), "30fps +/- 0.5", "output"),
        _gate("DURATION_MICRO", 8.0 <= duration <= duration_max, round(duration, 3), f"8.0..{duration_max:.1f}s including the versioned tail", "timeline"),
        _gate("INSET_WIDTH", 0.90 <= inset_width_ratio <= 0.95, round(inset_width_ratio, 4), "observed 0.90..0.95", "geometry"),
        _gate("INSET_HEIGHT", 0.24 <= inset_height_ratio <= 0.36, round(inset_height_ratio, 4), "observed 0.24..0.36", "geometry"),
        _gate("BLACK_CANVAS", outside_black >= 0.99, round(outside_black, 5), ">=0.99 black outside inset", "geometry"),
        _gate("MONOCHROME_GRADE", grayscale_delta <= 0.025, round(grayscale_delta, 5), "mean channel delta <=0.025", "grade"),
        _gate("ROUNDED_INSET", rounded_corners >= 0.08, round(rounded_corners, 5), "corner black ratio >=0.08", "geometry"),
    ]

    manifest_hash = None
    if render_manifest is not None:
        manifest = dict(render_manifest)
        declared_hash = manifest.pop("contentHash", None)
        manifest_hash = _canonical_hash(manifest)
        timeline = manifest.get("timeline") or {}
        typography = manifest.get("typography") or {}
        cuts = manifest.get("cuts") or {}
        semantic_cut_exception = bool(
            cuts.get("semanticCompletionSourceCutException")
        )
        source_cut_limit = _safe_int(cuts.get("sourceCutLimit"), 2)
        valid_source_cut_policy = (
            source_cut_limit == 3
            if semantic_cut_exception
            else source_cut_limit == 2
        )
        brand_tail = manifest.get("brandTail") or {}
        tail_profile = str(brand_tail.get("profile") or "").strip().lower()
        growth_v2_tail = tail_profile == BF_NATURAL_TAIL_V6
        expected_render_profile = (
            BF_EDITORIAL_INSET_V2
            if growth_v2_tail
            else BF_EDITORIAL_INSET_PROFILE
        )
        expected_format_profile = (
            BF_GROWTH_V2
            if growth_v2_tail
            else BF_VIRAL_MICRO_FORMAT
        )
        source_content_end = _safe_float(
            brand_tail.get("sourceContentEndTime"),
            -1.0,
        )
        next_spoken_word = brand_tail.get("nextSpokenWordStart")
        next_speech_safety = _safe_float(
            brand_tail.get("nextSpeechSafetySeconds"),
            0.04,
        )
        acoustic_boundary_source = str(
            brand_tail.get("acousticBoundarySource") or "transcript"
        ).strip().lower()
        verified_acoustic_end = brand_tail.get(
            "verifiedAcousticSpeechEndTime"
        )
        verified_next_word = brand_tail.get("verifiedNextSpokenWordStart")
        verified_safety = brand_tail.get(
            "verifiedNextSpeechSafetySeconds"
        )
        verified_values = (
            verified_acoustic_end,
            verified_next_word,
            verified_safety,
        )
        has_verified_boundary = any(
            value is not None for value in verified_values
        )
        verified_boundary_evidence = (
            acoustic_boundary_source == "transcript"
            and not has_verified_boundary
        )
        if (
            acoustic_boundary_source == "candidate_verified_acoustic"
            and all(value is not None for value in verified_values)
        ):
            verified_boundary_evidence = (
                brand_tail.get("acousticSpeechEndTime") is not None
                and abs(
                    _safe_float(brand_tail.get("acousticSpeechEndTime"), -99.0)
                    - _safe_float(verified_acoustic_end, 99.0)
                )
                <= 0.001
                and next_spoken_word is not None
                and abs(
                    _safe_float(next_spoken_word, -99.0)
                    - _safe_float(verified_next_word, 99.0)
                )
                <= 0.001
                and abs(
                    next_speech_safety
                    - _safe_float(verified_safety, 99.0)
                )
                <= 0.001
                and source_content_end
                <= (
                    _safe_float(verified_next_word, -1.0)
                    - _safe_float(verified_safety, 99.0)
                    + 0.001
                )
            )
        verified_visual_end = brand_tail.get("verifiedVisualSafeEndTime")
        visual_boundary_evidence_text = brand_tail.get(
            "verifiedVisualBoundaryEvidence"
        )
        visual_guard_declared = brand_tail.get("visualSafeEndGuardPassed")
        has_verified_visual_end = verified_visual_end is not None
        verified_visual_boundary = (
            visual_boundary_evidence_text in (None, "")
            and visual_guard_declared in (None, False)
        )
        if has_verified_visual_end:
            visual_end = _safe_float(verified_visual_end, -99.0)
            verified_visual_boundary = (
                tail_profile
                in {
                    BF_SMOOTH_TAIL_V4,
                    BF_SMOOTH_TAIL_V5,
                    BF_NATURAL_TAIL_V6,
                }
                and visual_guard_declared is True
                and source_content_end >= 0.0
                and source_content_end <= visual_end + 0.001
                and (
                    brand_tail.get("acousticSpeechEndTime") is None
                    or visual_end
                    >= _safe_float(
                        brand_tail.get("acousticSpeechEndTime"),
                        99.0,
                    )
                    - 0.001
                )
            )
        no_speech_leak = bool(brand_tail.get("sourceSpeechLeakGuardPassed"))
        if next_spoken_word is not None:
            allowed_source_end = _safe_float(next_spoken_word, -1.0)
            if tail_profile in _SMOOTH_TAIL_PROFILES:
                allowed_source_end -= next_speech_safety
            no_speech_leak = (
                no_speech_leak
                and source_content_end <= allowed_source_end + 0.001
            )
        tail_duration = _safe_float(brand_tail.get("durationSeconds"), -1.0)
        tail_duration_valid = (
            0.80 <= tail_duration <= 0.90
            if tail_profile in _SMOOTH_TAIL_PROFILES
            else 1.15 <= tail_duration <= 1.35
        )
        visual_crossfade = _safe_float(
            brand_tail.get(
                "visualCrossfadeSeconds",
                brand_tail.get("crossfadeSeconds"),
            ),
            -1.0,
        )
        crossfade_max = (
            0.13
            if tail_profile
            in {
                BF_SMOOTH_TAIL_V4,
                BF_SMOOTH_TAIL_V5,
                BF_NATURAL_TAIL_V6,
            }
            else 0.35
            if tail_profile == BF_SMOOTH_TAIL_V3
            else 0.30
        )
        smooth_audio_fade = _safe_float(
            brand_tail.get("audioFadeSeconds"),
            -1.0,
        )
        smooth_music_release = _safe_float(
            brand_tail.get("musicReleaseSeconds"),
            -1.0,
        )
        speech_audio_end = brand_tail.get("speechAudioEndTime")
        smooth_audio_preserved = (
            tail_profile not in _SMOOTH_TAIL_PROFILES
            or (
                speech_audio_end is not None
                and abs(
                    _safe_float(speech_audio_end, -99.0)
                    - source_content_end
                )
                <= 0.001
            )
        )
        tail_start = _safe_float(brand_tail.get("startSeconds"), -99.0)
        v5_transition_start = tail_start - visual_crossfade
        semantic_end = _safe_float(
            timeline.get("semanticEndSeconds"),
            99.0,
        )
        semantic_source_margin = _safe_float(
            brand_tail.get("semanticSourceMarginSeconds"),
            -99.0,
        )
        freeze_hold = _safe_float(
            brand_tail.get("freezeHoldSeconds"),
            99.0,
        )
        v5_fade_after_source = (
            tail_profile not in {BF_SMOOTH_TAIL_V5, BF_NATURAL_TAIL_V6}
            or (
                source_content_end >= 0.0
                and abs(
                    v5_transition_start
                    - (semantic_end + semantic_source_margin + freeze_hold)
                )
                <= 0.002
                and (
                    brand_tail.get("acousticSpeechEndTime") is None
                    or source_content_end
                    >= _safe_float(
                        brand_tail.get("acousticSpeechEndTime"),
                        99.0,
                    )
                    - 0.001
                )
            )
        )
        freeze_hold_valid = (
            abs(freeze_hold) <= 0.001
            if tail_profile == BF_NATURAL_TAIL_V6
            else 0.0 <= freeze_hold <= 0.08
            if tail_profile == BF_SMOOTH_TAIL_V5
            else abs(freeze_hold) <= 0.001
        )
        closure_version = str(
            brand_tail.get("semanticClosureDecisionVersion") or ""
        ).strip()
        closure_status = str(
            brand_tail.get("semanticClosureStatus") or ""
        ).strip().lower()
        closure_speech_end = _safe_float(
            brand_tail.get("semanticClosureSpeechEndTime"),
            -99.0,
        )
        captions_source_end = _safe_float(
            brand_tail.get("captionsSourceEndTime"),
            -99.0,
        )
        planned_natural_tail_end = _safe_float(
            brand_tail.get("plannedNaturalTailEndTime"),
            -99.0,
        )
        sealed_closure_valid = (
            not growth_v2_tail
            or (
                bool(closure_version)
                and closure_status == "pass"
                and closure_speech_end >= 0.0
                and abs(captions_source_end - closure_speech_end) <= 0.001
                and planned_natural_tail_end
                >= closure_speech_end - 0.001
                and abs(planned_natural_tail_end - source_content_end)
                <= 0.001
                and freeze_hold <= 0.001
            )
        )
        gates.extend(
            [
                _gate("PROFILE_BINDING", manifest.get("renderProfile") == expected_render_profile, manifest.get("renderProfile"), expected_render_profile, "binding"),
                _gate("FORMAT_BINDING", manifest.get("formatProfile") == expected_format_profile, manifest.get("formatProfile"), expected_format_profile, "binding"),
                _gate("MANIFEST_HASH", declared_hash in (None, manifest_hash), declared_hash, manifest_hash, "binding"),
                _gate("HOOK_LATENCY", _safe_float(timeline.get("firstVisibleTextSeconds"), 99.0) <= 0.25, timeline.get("firstVisibleTextSeconds"), "<=0.25s", "creative"),
                _gate("HERO_SCALE", _safe_float(typography.get("maxHeroScale"), 0.0) >= 1.8, typography.get("maxHeroScale"), ">=1.8x", "creative"),
                _gate("ARTIFICIAL_CUTS", _safe_int(cuts.get("artificialCutCount"), -1) == 0, cuts.get("artificialCutCount"), "0", "timeline"),
                _gate("SOURCE_CUT_POLICY", valid_source_cut_policy, {"limit": source_cut_limit, "semanticCompletionException": semantic_cut_exception}, "limit=2, or limit=3 only for sealed semantic completion", "timeline"),
                _gate("SOURCE_CUTS", 0 <= _safe_int(cuts.get("sourceCutCount"), -1) <= source_cut_limit, cuts.get("sourceCutCount"), f"0..{source_cut_limit}", "timeline"),
                _gate("TAIL_POLICY_BINDING", tail_profile in {BF_REFERENCE_TAIL_V2, *_SMOOTH_TAIL_PROFILES}, tail_profile, f"{BF_REFERENCE_TAIL_V2}|{BF_SMOOTH_TAIL_V3}|{BF_SMOOTH_TAIL_V4}|{BF_SMOOTH_TAIL_V5}|{BF_NATURAL_TAIL_V6}", "binding"),
                _gate("YOUTUBE_BRAND_TAIL", tail_duration_valid, brand_tail.get("durationSeconds"), "0.80..0.90s (v3/v4/v5) or 1.15..1.35s (v2)", "branding"),
                _gate("NATURAL_REACTION_TAIL", 0.0 <= _safe_float(brand_tail.get("naturalReactionSeconds"), -1.0) <= 0.75, brand_tail.get("naturalReactionSeconds"), "0.0..0.75s authentic source only", "timeline"),
                _gate("TAIL_CROSSFADE", 0.0 <= visual_crossfade <= crossfade_max, visual_crossfade, f"0.0..{crossfade_max:.2f}s", "timeline"),
                _gate("AUDIO_TAIL_FADE", tail_profile not in _SMOOTH_TAIL_PROFILES or 0.0 <= smooth_audio_fade <= 0.04, brand_tail.get("audioFadeSeconds"), "0.0..0.04s for smooth tails", "timeline"),
                _gate("MUSIC_TAIL_RELEASE", tail_profile not in _SMOOTH_TAIL_PROFILES or 0.0 <= smooth_music_release <= 0.30, brand_tail.get("musicReleaseSeconds"), "0.0..0.30s for smooth tails", "timeline"),
                _gate("SPEECH_AUDIO_TO_SAFE_END", smooth_audio_preserved, {"speechAudioEnd": speech_audio_end, "sourceContentEnd": source_content_end}, "smooth-tail source audio reaches the guarded source end", "timeline"),
                _gate("FADE_AFTER_SOURCE_LANDING", v5_fade_after_source, {"profile": tail_profile, "fadeStart": round(v5_transition_start, 3), "semanticEnd": timeline.get("semanticEndSeconds"), "semanticSourceMargin": brand_tail.get("semanticSourceMarginSeconds"), "sourceContentEnd": brand_tail.get("sourceContentEndTime"), "acousticSpeechEnd": brand_tail.get("acousticSpeechEndTime")}, "v5/v6 keep guarded speaker footage full-strength, then fade", "timeline"),
                _gate("SEMANTIC_SOURCE_MARGIN", tail_profile not in _SMOOTH_TAIL_PROFILES or _safe_float(brand_tail.get("semanticSourceMarginSeconds"), -1.0) >= 0.0, brand_tail.get("semanticSourceMarginSeconds"), ">=0s for smooth tails", "timeline"),
                _gate("NO_FREEZE_HOLD", freeze_hold_valid, brand_tail.get("freezeHoldSeconds"), "0s, or <=0.08s safe-frame settle for v5", "timeline"),
                _gate("SEMANTIC_CLOSURE_SEAL", sealed_closure_valid, {"profile": tail_profile, "decisionVersion": closure_version or None, "status": closure_status or None, "speechEnd": brand_tail.get("semanticClosureSpeechEndTime"), "captionsEnd": brand_tail.get("captionsSourceEndTime"), "plannedNaturalTailEnd": brand_tail.get("plannedNaturalTailEndTime"), "sourceContentEnd": brand_tail.get("sourceContentEndTime"), "freezeHold": brand_tail.get("freezeHoldSeconds")}, "v6 requires a passing closure seal, captions ending at speech end, authentic source through the planned tail end, and zero freeze", "timeline"),
                _gate("ACOUSTIC_BOUNDARY_EVIDENCE", verified_boundary_evidence, {"source": acoustic_boundary_source, "acousticSpeechEnd": brand_tail.get("acousticSpeechEndTime"), "nextSpokenWordStart": next_spoken_word, "safetySeconds": next_speech_safety, "verifiedAcousticSpeechEnd": verified_acoustic_end, "verifiedNextSpokenWordStart": verified_next_word, "verifiedSafetySeconds": verified_safety, "evidence": brand_tail.get("verifiedAcousticBoundaryEvidence")}, "transcript timing, or internally consistent candidate-verified acoustic timing", "timeline"),
                _gate("VISUAL_SAFE_END_BOUNDARY", verified_visual_boundary, {"profile": tail_profile, "sourceContentEnd": brand_tail.get("sourceContentEndTime"), "verifiedVisualSafeEnd": verified_visual_end, "guardPassed": visual_guard_declared, "evidence": visual_boundary_evidence_text}, "absent, or v4/v5/v6 source content ends at/before a candidate-verified visual boundary", "timeline"),
                _gate("NO_NEXT_SPEECH_LEAK", no_speech_leak, {"sourceContentEnd": brand_tail.get("sourceContentEndTime"), "nextSpokenWordStart": next_spoken_word, "safetySeconds": next_speech_safety}, "source content ends before next spoken word", "timeline"),
                _gate("TAIL_AFTER_SEMANTIC_END", _safe_float(brand_tail.get("startSeconds"), -1.0) >= _safe_float(timeline.get("semanticEndSeconds"), 99.0), {"tailStart": brand_tail.get("startSeconds"), "semanticEnd": timeline.get("semanticEndSeconds")}, "tail starts at or after semantic end", "branding"),
            ]
        )

    payload = {
        "schemaVersion": 1,
        "artifactType": "CreativeQaReport",
        "qaProfile": BF_EDITORIAL_QA_PROFILE,
        "renderProfile": (
            (render_manifest or {}).get("renderProfile")
            or BF_EDITORIAL_INSET_PROFILE
        ),
        "videoPath": str(path.resolve()),
        "video": {
            "width": width,
            "height": height,
            "fps": round(fps, 3),
            "frameCount": frame_count,
            "durationSeconds": round(duration, 3),
        },
        "sampleCount": len(samples),
        "measurements": {
            "minimumOutsideBlackRatio": round(outside_black, 6),
            "maximumGrayscaleMeanChannelDelta": round(grayscale_delta, 6),
            "minimumRoundedCornerBlackRatio": round(rounded_corners, 6),
            "insetWidthRatio": round(inset_width_ratio, 6),
            "insetHeightRatio": round(inset_height_ratio, 6),
        },
        "renderManifestHash": manifest_hash,
        "gates": gates,
        "passed": all(gate["passed"] for gate in gates),
    }
    return {**payload, "contentHash": _canonical_hash(payload)}


__all__ = [
    "BF_EDITORIAL_INSET_PROFILE",
    "BF_EDITORIAL_QA_PROFILE",
    "BF_VIRAL_MICRO_FORMAT",
    "analyze_editorial_frame",
    "evaluate_editorial_render",
    "expected_inset_box",
]
