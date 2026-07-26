"""Rendering media probes with explicit optional dependencies."""

from __future__ import annotations

import json
import subprocess
from typing import Dict, Optional, Tuple

from .artifact_contracts import ArtifactBindingError


def probe_video_frame_size_ffprobe(
    source_path: str,
    runner=None,
) -> Optional[Tuple[int, int]]:
    """Read the first video stream dimensions without importing OpenCV."""
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
                "stream=width,height",
                "-of",
                "json",
                source_path,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout or "{}")
        streams = payload.get("streams") if isinstance(payload, dict) else None
        stream = streams[0] if isinstance(streams, list) and streams else None
        width = int(stream.get("width", 0)) if isinstance(stream, dict) else 0
        height = int(stream.get("height", 0)) if isinstance(stream, dict) else 0
    except (
        FileNotFoundError,
        subprocess.CalledProcessError,
        TypeError,
        ValueError,
        json.JSONDecodeError,
    ):
        return None
    return (width, height) if width > 0 and height > 0 else None


def probe_rendered_video(path: str) -> Dict:
    """Decode only metadata required by the production render gate."""
    try:
        import cv2  # type: ignore
    except ImportError as error:  # pragma: no cover
        raise RuntimeError(
            "opencv-python is required for production render probing"
        ) from error
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise ArtifactBindingError("render output cannot be opened")
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    finally:
        cap.release()
    return {
        "fps": fps,
        "frameCount": frames,
        "durationSeconds": frames / fps if fps > 0 else 0.0,
        "width": width,
        "height": height,
    }


__all__ = [
    "probe_rendered_video",
    "probe_video_frame_size_ffprobe",
]
