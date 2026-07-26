"""Opt-in single-axis experiment for the Budget Friendly black brand tail."""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence

from .profiles import (
    BF_EDITORIAL_INSET_V2,
    BF_NATURAL_TAIL_V6,
)


BRAND_TAIL_EXPERIMENT_VERSION = "bf_short_brand_tail_v1"
BRAND_TAIL_EXPERIMENT_ID = "bf-short-brand-tail-v1"
BRAND_TAIL_CHANGED_AXIS = "brandTailDuration"
CONTROL_BRAND_TAIL_SECONDS = 0.85
VARIANT_BRAND_TAIL_SECONDS = 0.40

_EXPERIMENT_ONLY_FIELDS = frozenset(
    {
        "brand_tail_seconds",
        "brand_tail_experiment_id",
        "brand_tail_experiment_version",
        "brand_tail_experiment_arm",
        "experiment_id",
        "experiment_cohort",
    }
)


def _canonical_hash(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            default=str,
        ).encode("utf-8")
    ).hexdigest()


def _sha256(value: object, field: str) -> str:
    normalized = str(value or "").strip().lower().removeprefix("sha256:")
    if (
        len(normalized) != 64
        or any(character not in "0123456789abcdef" for character in normalized)
    ):
        raise ValueError(f"{field} must be a sha256 hash")
    return normalized


def _frozen_render_contract(render_settings: Optional[Dict]) -> Dict:
    settings = dict(render_settings or {})
    render_profile = str(
        settings.get("render_profile") or BF_EDITORIAL_INSET_V2
    ).strip().lower()
    layout = str(
        settings.get("layout_hint") or "editorial_inset"
    ).strip().lower()
    caption = str(
        settings.get("caption_style") or BF_EDITORIAL_INSET_V2
    ).strip().lower()
    ending = str(
        settings.get("brand_tail_profile") or BF_NATURAL_TAIL_V6
    ).strip().lower()
    if render_profile != BF_EDITORIAL_INSET_V2:
        raise ValueError("brand-tail experiment requires bf_editorial_inset_v2")
    if layout != "editorial_inset":
        raise ValueError("brand-tail experiment requires editorial_inset layout")
    if caption != BF_EDITORIAL_INSET_V2:
        raise ValueError("brand-tail experiment must keep existing captions")
    if ending != BF_NATURAL_TAIL_V6:
        raise ValueError("brand-tail experiment requires bf_natural_tail_v6")
    return {
        "renderProfile": render_profile,
        "layout": layout,
        "captionProfile": caption,
        "enhancement": {
            "enabled": True,
            "engine": "real-esrgan",
            "workingScale": 2,
            "silentInterpolationFallbackAllowed": False,
        },
        "musicProfile": str(
            settings.get("music_mix_profile") or "licensed_low_bed_v1"
        ),
        "endingProfile": ending,
        "authenticSourceCutsOnly": True,
        "artificialCutCount": 0,
        "digitalSpeakerReframeCount": 0,
        "freezeFrameCount": 0,
        "naturalTailPolicy": {
            "minimumSeconds": 0.35,
            "maximumSeconds": 0.55,
            "captionsEndAtAcousticSpeechEnd": True,
            "fadeStartsAfterAuthenticTail": True,
            "nextPhonemeExcluded": True,
        },
    }


def build_short_brand_tail_experiment_manifest(
    *,
    candidate_hash: str,
    source_hash: str,
    source_interval: Sequence[float],
    render_settings: Optional[Dict] = None,
) -> Dict:
    """Seal a two-arm declaration before either render begins."""
    candidate_hash = _sha256(candidate_hash, "candidate_hash")
    source_hash = _sha256(source_hash, "source_hash")
    if len(source_interval) != 2:
        raise ValueError("source_interval must contain start and end")
    start, end = map(float, source_interval)
    if end <= start:
        raise ValueError("source_interval must have positive duration")
    frozen = _frozen_render_contract(render_settings)
    payload = {
        "schemaVersion": 1,
        "artifactType": "ShortBrandTailExperimentManifest",
        "experimentVersion": BRAND_TAIL_EXPERIMENT_VERSION,
        "experimentId": BRAND_TAIL_EXPERIMENT_ID,
        "candidateHash": candidate_hash,
        "sourceHash": source_hash,
        "sourceInterval": {
            "startSeconds": round(start, 3),
            "endSeconds": round(end, 3),
        },
        "control": {
            "cohortId": "control",
            "brandTailDuration": CONTROL_BRAND_TAIL_SECONDS,
        },
        "variant": {
            "cohortId": "variant",
            "brandTailDuration": VARIANT_BRAND_TAIL_SECONDS,
        },
        "changedAxes": [BRAND_TAIL_CHANGED_AXIS],
        "frozenAxes": frozen,
        "preTailDecodedFramesMustMatch": True,
        "humanDecisionRequired": True,
    }
    return {**payload, "contentHash": _canonical_hash(payload)}


def verify_brand_tail_manifest(manifest: Dict) -> Dict:
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be an object")
    if manifest.get("artifactType") != "ShortBrandTailExperimentManifest":
        raise ValueError("unexpected experiment artifact type")
    declared_hash = _sha256(manifest.get("contentHash"), "contentHash")
    body = {key: value for key, value in manifest.items() if key != "contentHash"}
    if declared_hash != _canonical_hash(body):
        raise ValueError("experiment manifest seal is invalid")
    if manifest.get("experimentId") != BRAND_TAIL_EXPERIMENT_ID:
        raise ValueError("unexpected experiment id")
    if manifest.get("changedAxes") != [BRAND_TAIL_CHANGED_AXIS]:
        raise ValueError("brand-tail experiment must change exactly one axis")
    _frozen_render_contract(
        {
            "render_profile": manifest["frozenAxes"]["renderProfile"],
            "layout_hint": manifest["frozenAxes"]["layout"],
            "caption_style": manifest["frozenAxes"]["captionProfile"],
            "brand_tail_profile": manifest["frozenAxes"]["endingProfile"],
            "music_mix_profile": manifest["frozenAxes"]["musicProfile"],
        }
    )
    return manifest


def build_brand_tail_render_candidates(
    sealed_candidate: Dict,
    manifest: Dict,
) -> List[Dict]:
    """Return control and variant candidates differing only by experiment data."""
    verify_brand_tail_manifest(manifest)
    observed_hash = str(
        sealed_candidate.get("candidate_hash")
        or sealed_candidate.get("candidateHash")
        or sealed_candidate.get("contentHash")
        or ""
    ).strip().lower()
    if not observed_hash:
        raise ValueError("sealed candidate hash is required")
    if observed_hash != manifest["candidateHash"]:
        raise ValueError("candidate does not match the experiment manifest")
    expected_fields = {
        "render_profile": BF_EDITORIAL_INSET_V2,
        "layout_hint": "editorial_inset",
        "caption_style": BF_EDITORIAL_INSET_V2,
        "brand_tail_profile": BF_NATURAL_TAIL_V6,
    }
    for field, expected in expected_fields.items():
        observed = str(sealed_candidate.get(field) or "").strip().lower()
        if observed and observed != expected:
            raise ValueError(
                f"sealed candidate {field} violates the frozen render contract"
            )
    variants = []
    for arm in ("control", "variant"):
        arm_contract = manifest[arm]
        variants.append(
            {
                **sealed_candidate,
                "render_profile": BF_EDITORIAL_INSET_V2,
                "layout_hint": "editorial_inset",
                "caption_style": BF_EDITORIAL_INSET_V2,
                "brand_tail_profile": BF_NATURAL_TAIL_V6,
                "brand_tail_seconds": float(
                    arm_contract["brandTailDuration"]
                ),
                "brand_tail_experiment_id": BRAND_TAIL_EXPERIMENT_ID,
                "brand_tail_experiment_version": (
                    BRAND_TAIL_EXPERIMENT_VERSION
                ),
                "brand_tail_experiment_arm": arm,
                "experiment_id": BRAND_TAIL_EXPERIMENT_ID,
                "experiment_cohort": str(arm_contract["cohortId"]),
                "changedAxes": [BRAND_TAIL_CHANGED_AXIS],
            }
        )
    verify_only_brand_tail_axis(variants[0], variants[1])
    return variants


def verify_only_brand_tail_axis(control: Dict, variant: Dict) -> Dict:
    control_frozen = {
        key: value
        for key, value in control.items()
        if key not in _EXPERIMENT_ONLY_FIELDS
    }
    variant_frozen = {
        key: value
        for key, value in variant.items()
        if key not in _EXPERIMENT_ONLY_FIELDS
    }
    if _canonical_hash(control_frozen) != _canonical_hash(variant_frozen):
        raise ValueError("experiment variants differ outside brandTailDuration")
    if float(control.get("brand_tail_seconds") or 0.0) != CONTROL_BRAND_TAIL_SECONDS:
        raise ValueError("control brand tail is not 0.85 seconds")
    if float(variant.get("brand_tail_seconds") or 0.0) != VARIANT_BRAND_TAIL_SECONDS:
        raise ValueError("variant brand tail is not 0.40 seconds")
    return {
        "identicalFrozenCandidate": True,
        "changedAxes": [BRAND_TAIL_CHANGED_AXIS],
        "controlSeconds": CONTROL_BRAND_TAIL_SECONDS,
        "variantSeconds": VARIANT_BRAND_TAIL_SECONDS,
    }


def verify_decoded_frame_sequences(
    control_frames: Iterable[object],
    variant_frames: Iterable[object],
) -> Dict:
    """Compare already-decoded frames byte-for-byte."""
    control_hashes = [
        hashlib.sha256(
            frame.tobytes() if hasattr(frame, "tobytes") else bytes(frame)
        ).hexdigest()
        for frame in control_frames
    ]
    variant_hashes = [
        hashlib.sha256(
            frame.tobytes() if hasattr(frame, "tobytes") else bytes(frame)
        ).hexdigest()
        for frame in variant_frames
    ]
    if control_hashes != variant_hashes:
        mismatch = next(
            (
                index
                for index, pair in enumerate(
                    zip(control_hashes, variant_hashes)
                )
                if pair[0] != pair[1]
            ),
            min(len(control_hashes), len(variant_hashes)),
        )
        raise ValueError(
            f"decoded frames differ before brand-tail boundary at frame {mismatch}"
        )
    return {
        "identical": True,
        "verifiedFrameCount": len(control_hashes),
        "frameSequenceHash": _canonical_hash(control_hashes),
    }


def verify_pre_tail_decoded_frames(
    control_path: str,
    variant_path: str,
    boundary_seconds: float,
) -> Dict:
    """Decode both MP4s and prove equality before the shared tail boundary."""
    try:
        import cv2  # type: ignore
    except ImportError as error:  # pragma: no cover
        raise RuntimeError("opencv-python is required for frame verification") from error
    captures = [cv2.VideoCapture(str(path)) for path in (control_path, variant_path)]
    if not all(capture.isOpened() for capture in captures):
        for capture in captures:
            capture.release()
        raise ValueError("experiment render cannot be decoded")
    try:
        fps_values = [
            float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
            for capture in captures
        ]
        if min(fps_values) <= 0.0 or abs(fps_values[0] - fps_values[1]) > 0.001:
            raise ValueError("experiment renders have different frame rates")
        frame_count = max(
            0,
            int(math.floor(float(boundary_seconds) * fps_values[0] + 1e-6)),
        )
        frame_sets: List[List[object]] = [[], []]
        for index, capture in enumerate(captures):
            for _ in range(frame_count):
                ok, frame = capture.read()
                if not ok:
                    raise ValueError("render ended before brand-tail boundary")
                frame_sets[index].append(frame)
    finally:
        for capture in captures:
            capture.release()
    return {
        **verify_decoded_frame_sequences(frame_sets[0], frame_sets[1]),
        "boundarySeconds": round(float(boundary_seconds), 3),
        "fps": fps_values[0],
    }


def render_short_brand_tail_experiment(
    *,
    source_path: str,
    transcript: Dict,
    sealed_candidate: Dict,
    manifest: Dict,
    output_dir: str,
    renderer: Optional[Callable[..., List[Dict]]] = None,
) -> Dict:
    """Render both arms from one sealed candidate, then verify their prefix."""
    if renderer is None:
        from .local.clipper import crop_highlights_local

        renderer = crop_highlights_local
    candidates = build_brand_tail_render_candidates(sealed_candidate, manifest)
    rendered = renderer(
        source_path,
        [candidates[0]],
        aspect_ratio="9:16",
        out_dir=output_dir,
        transcript=transcript,
        render_profile=BF_EDITORIAL_INSET_V2,
        brand_tail_profile=BF_NATURAL_TAIL_V6,
    )
    if len(rendered) != 1 or any(
        item.get("error") or not item.get("clip_url") for item in rendered
    ):
        raise RuntimeError("brand-tail experiment control failed to render")
    control = {
        **rendered[0],
        "brand_tail_experiment_arm": "control",
        "brand_tail_seconds": CONTROL_BRAND_TAIL_SECONDS,
    }
    boundary = float(control.get("brand_tail_start_seconds") or -1.0)
    if boundary < 0.0:
        raise ValueError("control render has no measured brand-tail boundary")

    # Encode the expensive/common prefix exactly once. The variant is a
    # packet-preserving truncation of the control's black tail, so pre-tail
    # frames cannot drift through a second H.264 encode or Real-ESRGAN pass.
    control_path = Path(str(control["clip_url"]))
    variant_path = Path(output_dir) / "short_brand_tail_variant.mp4"
    command = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-i",
        str(control_path),
        "-t",
        f"{boundary + VARIANT_BRAND_TAIL_SECONDS:.3f}",
        "-map",
        "0",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(variant_path),
    ]
    subprocess.run(command, check=True)
    if not variant_path.is_file() or variant_path.stat().st_size <= 0:
        raise RuntimeError("brand-tail variant truncation produced no file")
    variant = {
        **control,
        "clip_url": str(variant_path),
        "brand_tail_experiment_arm": "variant",
        "brand_tail_seconds": VARIANT_BRAND_TAIL_SECONDS,
        "brand_tail_start_seconds": boundary,
        "render_duration_seconds": round(
            boundary + VARIANT_BRAND_TAIL_SECONDS,
            3,
        ),
    }
    frame_verification = verify_pre_tail_decoded_frames(
        str(control["clip_url"]),
        str(variant["clip_url"]),
        boundary,
    )
    payload = {
        "schemaVersion": 1,
        "artifactType": "ShortBrandTailExperimentResult",
        "experimentVersion": BRAND_TAIL_EXPERIMENT_VERSION,
        "experimentId": BRAND_TAIL_EXPERIMENT_ID,
        "experimentManifestHash": manifest["contentHash"],
        "changedAxes": [BRAND_TAIL_CHANGED_AXIS],
        "control": control,
        "variant": variant,
        "preTailFrameVerification": frame_verification,
    }
    return {**payload, "contentHash": _canonical_hash(payload)}


__all__ = [
    "BRAND_TAIL_CHANGED_AXIS",
    "BRAND_TAIL_EXPERIMENT_ID",
    "BRAND_TAIL_EXPERIMENT_VERSION",
    "CONTROL_BRAND_TAIL_SECONDS",
    "VARIANT_BRAND_TAIL_SECONDS",
    "build_brand_tail_render_candidates",
    "build_short_brand_tail_experiment_manifest",
    "render_short_brand_tail_experiment",
    "verify_brand_tail_manifest",
    "verify_decoded_frame_sequences",
    "verify_only_brand_tail_axis",
    "verify_pre_tail_decoded_frames",
]
