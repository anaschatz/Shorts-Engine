"""Pure planning helpers for lossless FFV1/PCM source cuts."""

import hashlib
import json
from pathlib import Path
from typing import List, Tuple


SourceIdentity = Tuple[str, int, int]


def build_lossless_cut_command(
    source_path: str,
    start: float,
    end: float,
    out_path: str,
    fps: float,
) -> List[str]:
    """Return the canonical FFmpeg argv without executing it."""
    duration = max(0.001, end - start)
    return [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{start:.3f}",
        "-i", source_path,
        "-t", f"{duration:.3f}",
        "-vf", f"fps={float(fps):g}",
        "-c:v", "ffv1", "-level", "3",
        "-c:a", "pcm_s16le",
        out_path,
    ]


def build_lossless_cut_cache_key(
    schema: str,
    source_identity: SourceIdentity,
    start: float,
    end: float,
    fps: float,
) -> str:
    """Hash canonical source and interval inputs into the existing key format."""
    payload = json.dumps(
        {
            "schema": schema,
            "source": source_identity,
            "start": round(float(start), 6),
            "end": round(float(end), 6),
            "fps": round(float(fps), 6),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.blake2b(payload.encode("utf-8"), digest_size=24).hexdigest()


def build_lossless_cut_cache_path(cache_dir: Path, cache_key: str) -> Path:
    """Return the existing two-character-sharded MKV cache path."""
    return cache_dir / cache_key[:2] / f"{cache_key}.mkv"
