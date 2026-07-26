"""Local transcription via faster-whisper.

Reads a local media file and returns the same shape the highlight generator
expects: {duration, segments[start, end, text]}.
"""
import json
import hashlib
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

from ..config import (
    LOCAL_OUTPUT_DIR,
    LOCAL_TRANSCRIPT_CACHE_DIR,
    LOCAL_WHISPER_DEVICE,
    LOCAL_WHISPER_MODEL,
)


TRANSCRIPT_CACHE_SCHEMA_VERSION = 3
LEGACY_TRANSCRIPT_CACHE_SCHEMA_VERSION = 2
SOURCE_FINGERPRINT_SCHEMA_VERSION = 1
FFMPEG_DECODE_ENV = "LOCAL_WHISPER_FFMPEG_DECODE"


def _atomic_write_text(path: Path, content: str) -> None:
    """Atomically replace a small cache file in its destination directory."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def _source_stat_fingerprint(path: Path) -> Dict:
    stat = path.stat()
    return {
        "path": str(path),
        "size": int(stat.st_size),
        "mtime_ns": int(stat.st_mtime_ns),
        "ctime_ns": int(stat.st_ctime_ns),
        "device": int(stat.st_dev),
        "inode": int(stat.st_ino),
    }


def _source_fingerprint_path(media_path: str) -> Path:
    resolved = Path(media_path).resolve()
    cache_dir = Path(LOCAL_TRANSCRIPT_CACHE_DIR)
    path_key = hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()
    return cache_dir / "source-fingerprints-v1" / path_key[:2] / f"{path_key}.json"


def _hash_file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_sha256(media_path: str) -> str:
    """Return a stable media digest, avoiding repeat full reads on a warm path."""
    source_path = Path(media_path).resolve()
    fingerprint_path = _source_fingerprint_path(str(source_path))

    for _attempt in range(2):
        before = _source_stat_fingerprint(source_path)
        try:
            fingerprint = json.loads(fingerprint_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            fingerprint = {}

        cached_digest = str(fingerprint.get("sha256") or "").lower()
        if (
            fingerprint.get("schema_version") == SOURCE_FINGERPRINT_SCHEMA_VERSION
            and fingerprint.get("source") == before
            and re.fullmatch(r"[0-9a-f]{64}", cached_digest)
        ):
            return cached_digest

        digest = _hash_file_sha256(source_path)
        after = _source_stat_fingerprint(source_path)
        if before != after:
            continue

        _atomic_write_text(
            fingerprint_path,
            json.dumps(
                {
                    "schema_version": SOURCE_FINGERPRINT_SCHEMA_VERSION,
                    "source": after,
                    "sha256": digest,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
        )
        return digest

    raise RuntimeError(f"Media changed while hashing for transcript cache: {source_path}")


def _cache_identity(media_path: str, language: Optional[str]) -> tuple[Dict, str]:
    metadata = _cache_metadata(media_path, language)
    payload = json.dumps(
        metadata,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return metadata, hashlib.sha256(payload).hexdigest()


def _transcript_cache_path(
    media_path: str,
    language: Optional[str] = None,
) -> Path:
    """Return the content-addressed .srt cache path for a media file."""
    cache_dir = Path(LOCAL_TRANSCRIPT_CACHE_DIR)
    cache_dir.mkdir(parents=True, exist_ok=True)
    _metadata, identity = _cache_identity(media_path, language)
    return cache_dir / f"v{TRANSCRIPT_CACHE_SCHEMA_VERSION}-{identity}.srt"


def _word_cache_path(
    media_path: str,
    language: Optional[str] = None,
) -> Path:
    cache_dir = Path(LOCAL_TRANSCRIPT_CACHE_DIR)
    cache_dir.mkdir(parents=True, exist_ok=True)
    _metadata, identity = _cache_identity(media_path, language)
    return cache_dir / f"v{TRANSCRIPT_CACHE_SCHEMA_VERSION}-{identity}.transcript.json"


def _format_srt_timestamp(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    ms = total_ms % 1000
    total_s = total_ms // 1000
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _parse_srt_timestamp(value: str) -> float:
    match = re.fullmatch(r"(\d{2}):(\d{2}):(\d{2}),(\d{3})", value.strip())
    if not match:
        raise ValueError(f"Invalid SRT timestamp: {value!r}")
    hours, minutes, seconds, millis = map(int, match.groups())
    return hours * 3600 + minutes * 60 + seconds + (millis / 1000.0)


def _transcript_language(transcript: Dict, language: Optional[str]) -> Optional[str]:
    if language is not None:
        return language
    cached_language = transcript.get("_cache", {}).get("language")
    if cached_language in {None, "auto"}:
        return None
    return str(cached_language)


def _write_srt_cache(
    media_path: str,
    transcript: Dict,
    language: Optional[str] = None,
) -> Path:
    language = _transcript_language(transcript, language)
    cache_path = _transcript_cache_path(media_path, language)
    lines = []
    for idx, segment in enumerate(transcript.get("segments", []), start=1):
        start = _format_srt_timestamp(float(segment["start"]))
        end = _format_srt_timestamp(float(segment["end"]))
        text = str(segment.get("text", "")).strip().replace("\r", "").replace("\n", " ")
        lines.append(str(idx))
        lines.append(f"{start} --> {end}")
        lines.append(text)
        lines.append("")

    _atomic_write_text(cache_path, "\n".join(lines))
    return cache_path


def _write_word_cache(
    media_path: str,
    transcript: Dict,
    language: Optional[str] = None,
) -> Path:
    language = _transcript_language(transcript, language)
    cache_path = _word_cache_path(media_path, language)
    _atomic_write_text(
        cache_path,
        json.dumps(transcript, ensure_ascii=False, indent=2),
    )
    return cache_path


def _legacy_source_signature(media_path: str) -> str:
    path = Path(media_path).resolve()
    stat = path.stat()
    payload = f"{path}\0{stat.st_size}\0{stat.st_mtime_ns}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _cache_metadata(media_path: str, language: Optional[str]) -> Dict:
    return {
        "schema_version": TRANSCRIPT_CACHE_SCHEMA_VERSION,
        "source_sha256": _source_sha256(media_path),
        "model": LOCAL_WHISPER_MODEL,
        "language": language or "auto",
    }


def _legacy_cache_metadata(media_path: str, language: Optional[str]) -> Dict:
    return {
        "schema_version": LEGACY_TRANSCRIPT_CACHE_SCHEMA_VERSION,
        "source_signature": _legacy_source_signature(media_path),
        "model": LOCAL_WHISPER_MODEL,
        "language": language or "auto",
    }


def _has_exact_word_timestamps(transcript: Dict) -> bool:
    speech_segments = [
        segment
        for segment in transcript.get("segments", [])
        if str(segment.get("text") or "").strip()
    ]
    return bool(speech_segments) and all(
        isinstance(segment.get("words"), list) and bool(segment["words"])
        for segment in speech_segments
    )


def _cache_matches(transcript: Dict, media_path: str, language: Optional[str]) -> bool:
    return (
        transcript.get("_cache") == _cache_metadata(media_path, language)
        and float(transcript.get("duration", 0.0)) > 0.0
        and _has_exact_word_timestamps(transcript)
    )


def _legacy_cache_matches(
    transcript: Dict,
    media_path: str,
    language: Optional[str],
) -> bool:
    return (
        transcript.get("_cache") == _legacy_cache_metadata(media_path, language)
        and float(transcript.get("duration", 0.0)) > 0.0
        and _has_exact_word_timestamps(transcript)
    )


def _legacy_word_cache_candidates(media_path: str) -> Iterable[Path]:
    stem_cache_name = f"{Path(media_path).stem}.transcript.json"
    seen = set()
    for directory in (Path(LOCAL_TRANSCRIPT_CACHE_DIR), Path(LOCAL_OUTPUT_DIR)):
        candidate = directory / stem_cache_name
        key = str(candidate.resolve())
        if key not in seen:
            seen.add(key)
            yield candidate


def _migrate_legacy_word_cache(
    media_path: str,
    language: Optional[str],
) -> Optional[Dict]:
    """Safely migrate a valid stem/path cache into content-addressed storage."""
    current_metadata = _cache_metadata(media_path, language)
    current_sha256 = current_metadata["source_sha256"]

    for legacy_word_cache in _legacy_word_cache_candidates(media_path):
        if not legacy_word_cache.is_file():
            continue
        try:
            cached = json.loads(legacy_word_cache.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if (
            float(cached.get("duration", 0.0)) <= 0.0
            or not _has_exact_word_timestamps(cached)
        ):
            continue

        valid_provenance = cached.get("_cache") == current_metadata
        if not valid_provenance and _legacy_cache_matches(
            cached,
            media_path,
            language,
        ):
            # The old cache still refers to this exact path and stat tuple.
            valid_provenance = True

        if not valid_provenance:
            provenance_media = [
                Path(LOCAL_OUTPUT_DIR) / Path(media_path).name,
                legacy_word_cache.parent / Path(media_path).name,
            ]
            for original_media in provenance_media:
                if not original_media.is_file():
                    continue
                if not _legacy_cache_matches(cached, str(original_media), language):
                    continue
                if _source_sha256(str(original_media)) == current_sha256:
                    valid_provenance = True
                    break

        if not valid_provenance:
            continue

        migrated = json.loads(json.dumps(cached))
        migrated["_cache"] = current_metadata
        _write_srt_cache(media_path, migrated, language)
        _write_word_cache(media_path, migrated, language)
        return migrated
    return None


def _load_srt_cache(cache_path: Path) -> Dict:
    content = cache_path.read_text(encoding="utf-8-sig").strip()
    if not content:
        return {"duration": 0.0, "segments": []}

    segments = []
    for block in re.split(r"\n\s*\n", content):
        lines = [line.strip("\ufeff") for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        if "-->" not in lines[0] and len(lines) > 1 and "-->" in lines[1]:
            lines = lines[1:]
        if not lines or "-->" not in lines[0]:
            continue
        start_raw, end_raw = [part.strip() for part in lines[0].split("-->", 1)]
        text = "\n".join(lines[1:]).strip()
        segments.append(
            {
                "start": _parse_srt_timestamp(start_raw),
                "end": _parse_srt_timestamp(end_raw),
                "text": text,
            }
        )

    duration = segments[-1]["end"] if segments else 0.0
    return {"duration": duration, "segments": segments}


def _resolve_device() -> str:
    if LOCAL_WHISPER_DEVICE != "auto":
        return LOCAL_WHISPER_DEVICE
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            # Test that CUDA actually works (catches missing cuBLAS/cuDNN libs)
            torch.zeros(1, device="cuda")
            return "cuda"
    except (ImportError, OSError, RuntimeError):
        pass
    return "cpu"


def _decode_audio_with_ffmpeg(
    media_path: str,
    sampling_rate: int = 16000,
    runner=None,
):
    """Decode mono float32 audio without routing media reads through PyAV."""
    run = runner or subprocess.run
    command = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        media_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(int(sampling_rate)),
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-",
    ]
    try:
        result = run(command, check=True, capture_output=True)
    except FileNotFoundError as error:
        raise RuntimeError("ffmpeg is required for Whisper audio decoding") from error
    except subprocess.CalledProcessError as error:
        details = (error.stderr or b"").decode("utf-8", errors="replace")[-1200:]
        raise RuntimeError(f"ffmpeg audio decode failed: {details}") from error

    import numpy as np  # type: ignore

    audio = np.frombuffer(result.stdout, dtype="<f4")
    if not audio.size:
        raise RuntimeError("ffmpeg produced no decodable audio samples")
    return audio


def transcribe_local(
    media_path: str,
    language: Optional[str] = None,
    telemetry: Optional[Any] = None,
) -> Dict:
    """Run faster-whisper and require a versioned exact-word cache."""
    cache_path = _transcript_cache_path(media_path, language)
    word_cache_path = _word_cache_path(media_path, language)

    if word_cache_path.exists():
        try:
            cached = json.loads(word_cache_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            cached = {}
        if _cache_matches(cached, media_path, language):
            if telemetry is not None:
                telemetry.cache_hit("transcript")
            print(f"[transcribe/local] reusing word cache: {word_cache_path}", flush=True)
            print(
                f"[transcribe/local] {len(cached['segments'])} cached segments, "
                f"{float(cached['duration']):.0f}s of audio",
                flush=True,
            )
            return cached
        print(f"[transcribe/local] stale/inexact word cache ignored: {word_cache_path}", flush=True)

    migrated = _migrate_legacy_word_cache(media_path, language)
    if migrated is not None:
        if telemetry is not None:
            telemetry.cache_hit("transcript")
        print(
            f"[transcribe/local] migrated exact word cache to content address: "
            f"{word_cache_path}",
            flush=True,
        )
        return migrated

    if telemetry is not None:
        telemetry.cache_miss("transcript")
    if cache_path.exists():
        print(
            f"[transcribe/local] segment-only SRT cannot drive word captions; "
            f"regenerating exact timestamps",
            flush=True,
        )

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "faster-whisper is required for --mode local. Install it with:\n"
            "    pip install -r requirements-local.txt"
        ) from e

    device = _resolve_device()
    compute_type = "float16" if device == "cuda" else "int8"
    print(f"[transcribe/local] faster-whisper model={LOCAL_WHISPER_MODEL} device={device}", flush=True)

    from ..config import LOCAL_WHISPER_VAD_FILTER, LOCAL_WHISPER_VAD_PARAMETERS

    model = WhisperModel(LOCAL_WHISPER_MODEL, device=device, compute_type=compute_type)

    use_ffmpeg_decode = os.getenv(FFMPEG_DECODE_ENV, "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    audio_input = media_path
    if use_ffmpeg_decode:
        print("[transcribe/local] decoding audio through ffmpeg", flush=True)
        audio_input = _decode_audio_with_ffmpeg(media_path)

    transcribe_kwargs = {
        "audio": audio_input,
        "language": language,
        "beam_size": 5,
        "condition_on_previous_text": False,
        "word_timestamps": True,
    }
    if LOCAL_WHISPER_VAD_FILTER:
        transcribe_kwargs["vad_filter"] = True
        transcribe_kwargs["vad_parameters"] = LOCAL_WHISPER_VAD_PARAMETERS
    else:
        transcribe_kwargs["vad_filter"] = False

    segments_iter, info = model.transcribe(**transcribe_kwargs)

    segments = []
    for s in segments_iter:
        words = []
        for word in getattr(s, "words", None) or []:
            text = str(getattr(word, "word", "") or "").strip()
            start = getattr(word, "start", None)
            end = getattr(word, "end", None)
            if text and start is not None and end is not None and float(end) > float(start):
                words.append({"word": text, "start": float(start), "end": float(end)})

        segment = {
            "start": float(s.start),
            "end": float(s.end),
            "text": (s.text or "").strip(),
        }
        if words:
            segment["words"] = words
        segments.append(segment)

    duration = float(getattr(info, "duration", 0.0)) or (segments[-1]["end"] if segments else 0.0)
    print(f"[transcribe/local] {len(segments)} segments, {duration:.0f}s of audio", flush=True)
    transcript = {
        "duration": duration,
        "segments": segments,
        "_cache": _cache_metadata(media_path, language),
    }
    cache_path = _write_srt_cache(media_path, transcript, language)
    word_cache_path = _write_word_cache(media_path, transcript, language)
    print(f"[transcribe/local] wrote caches: {cache_path}, {word_cache_path}", flush=True)
    return transcript
