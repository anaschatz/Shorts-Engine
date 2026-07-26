"""Fast, word-timed YouTube caption ingestion with a Whisper fallback contract.

The normal local pipeline downloads the source before transcription.  When the
same YouTube video exposes JSON3 captions, those timings are already good enough
to drive discovery and kinetic captions, and parsing them is dramatically
faster than decoding several hours of audio with Whisper.  This module is
deliberately optional: missing, sparse, malformed, or inaccessible captions
return ``None`` so callers can fall back to the existing exact-word Whisper
path without weakening output quality.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import statistics
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

from .downloader import _extract_youtube_video_id, _import_ytdlp


YOUTUBE_CAPTION_CACHE_SCHEMA_VERSION = 1
YOUTUBE_CAPTION_PARSER_VERSION = "json3-words-v1"
MAX_CAPTION_BYTES = 32 * 1024 * 1024
_WORD_RE = re.compile(r"\S+")
_NON_SPEECH_TOKEN_RE = re.compile(r"^(?:>>+|[>♪♫]+|\[[^\]]+\]|\([^)]*(?:music|applause|laughter)[^)]*\))$", re.IGNORECASE)
_NON_SPEECH_PIECE_RE = re.compile(
    r"^\s*(?:\[[^\]]+\]|\([^)]*(?:music|applause|laughter)[^)]*\)|[♪♫]+)\s*$",
    re.IGNORECASE,
)


def _atomic_write_json(path: Path, value: Dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _caption_cache_path(
    cache_dir: str,
    video_id: str,
    language: Optional[str],
) -> Path:
    identity = hashlib.sha256(
        (
            f"{YOUTUBE_CAPTION_CACHE_SCHEMA_VERSION}\0"
            f"{YOUTUBE_CAPTION_PARSER_VERSION}\0{video_id}\0"
            f"{str(language or 'auto').strip().lower()}"
        ).encode("utf-8")
    ).hexdigest()
    return Path(cache_dir) / "youtube-json3-v1" / f"{identity}.transcript.json"


def _media_duration(media_path: Optional[str]) -> float:
    if not media_path:
        return 0.0
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                str(media_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        duration = float(result.stdout.strip())
        return duration if math.isfinite(duration) and duration > 0 else 0.0
    except (FileNotFoundError, subprocess.CalledProcessError, TypeError, ValueError):
        return 0.0


def _language_base(value: Optional[str]) -> str:
    normalized = str(value or "").strip().lower().replace("_", "-")
    return normalized.split("-", 1)[0]


def _json3_format(formats: object) -> Optional[Dict]:
    if not isinstance(formats, list):
        return None
    exact = [item for item in formats if isinstance(item, dict) and item.get("ext") == "json3"]
    candidates = exact or [
        item
        for item in formats
        if isinstance(item, dict)
        and "json3" in str(item.get("url") or "").lower()
    ]
    return candidates[0] if candidates else None


def _caption_track_candidates(
    info: Dict,
    language: Optional[str],
) -> Iterable[Tuple[int, str, str, Dict]]:
    """Yield usable tracks in deterministic quality/language priority order."""
    requested = _language_base(language)
    declared = _language_base(
        info.get("original_language") or info.get("language")
    )
    preferred = requested or declared or "en"
    catalogs = (
        ("subtitles", info.get("subtitles"), 0),
        ("automatic_captions", info.get("automatic_captions"), 1),
    )
    for source, catalog, source_penalty in catalogs:
        if not isinstance(catalog, dict):
            continue
        for track_language, formats in catalog.items():
            selected = _json3_format(formats)
            if selected is None or not selected.get("url"):
                continue
            normalized = str(track_language or "").strip().lower().replace("_", "-")
            base = _language_base(normalized)
            original = normalized.endswith("-orig")
            if base == preferred and original:
                language_penalty = 0
            elif normalized == preferred and source == "subtitles":
                language_penalty = 1
            elif normalized == preferred:
                language_penalty = 2
            elif base == preferred:
                language_penalty = 3
            elif normalized == "en-orig":
                language_penalty = 4
            elif base == "en":
                language_penalty = 5
            elif original:
                language_penalty = 6
            else:
                language_penalty = 8
            # Original-language ASR JSON3 normally contains genuine word
            # offsets. Prefer it over sentence-timed manual subtitles; a
            # manual exact-language track remains the next quality choice.
            priority = language_penalty * 10 + source_penalty
            yield priority, source, normalized, selected


def _select_caption_track(
    info: Dict,
    language: Optional[str],
) -> Optional[Tuple[str, str, Dict]]:
    candidates = sorted(
        _caption_track_candidates(info, language),
        key=lambda item: (item[0], item[1], item[2]),
    )
    if not candidates:
        return None
    _, source, track_language, selected = candidates[0]
    return source, track_language, selected


def _fetch_caption_json3(
    video_url: str,
    language: Optional[str],
    video_info: Optional[Dict] = None,
) -> Optional[Tuple[bytes, str, str]]:
    yt_dlp = _import_ytdlp()
    options = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "skip_download": True,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        # A cold source download has already resolved this exact watch page.
        # Reuse that successful response when available: a second immediate
        # extraction can be rate-limited or transiently report the video as
        # unavailable even though the media download just completed.
        info = (
            video_info
            if isinstance(video_info, dict)
            else ydl.extract_info(video_url, download=False)
        )
        track = _select_caption_track(info, language)
        if track is None:
            return None
        source, track_language, selected = track
        with ydl.urlopen(str(selected["url"])) as response:
            payload = response.read(MAX_CAPTION_BYTES + 1)
    if len(payload) > MAX_CAPTION_BYTES:
        raise RuntimeError("YouTube JSON3 caption payload is unexpectedly large")
    return payload, track_language, source


def _piece_word_timings(
    text: str,
    start: float,
    end: float,
) -> list[Dict]:
    normalized_text = str(text or "").replace("\n", " ")
    if _NON_SPEECH_PIECE_RE.fullmatch(normalized_text):
        return []
    tokens = [
        token
        for token in _WORD_RE.findall(normalized_text)
        if not _NON_SPEECH_TOKEN_RE.fullmatch(token)
    ]
    if not tokens:
        return []
    safe_start = max(0.0, float(start))
    safe_end = max(safe_start + 0.001, float(end))
    interval = (safe_end - safe_start) / len(tokens)
    return [
        {
            "word": token,
            "start": round(safe_start + interval * index, 3),
            "end": round(safe_start + interval * (index + 1), 3),
        }
        for index, token in enumerate(tokens)
    ]


def parse_json3_transcript(
    payload: bytes | str | Dict,
    *,
    media_duration: float = 0.0,
) -> Dict:
    """Convert YouTube JSON3 events into exact-word transcript segments."""
    if isinstance(payload, bytes):
        value = json.loads(payload.decode("utf-8"))
    elif isinstance(payload, str):
        value = json.loads(payload)
    elif isinstance(payload, dict):
        value = payload
    else:
        raise TypeError("JSON3 payload must be bytes, text, or a dictionary")

    events = value.get("events")
    if not isinstance(events, list):
        raise ValueError("JSON3 caption payload has no events list")

    segments = []
    seen = set()
    last_caption_end = 0.0
    for event in events:
        if not isinstance(event, dict) or not isinstance(event.get("segs"), list):
            continue
        event_start = max(0.0, float(event.get("tStartMs") or 0.0) / 1000.0)
        event_duration = max(0.0, float(event.get("dDurationMs") or 0.0) / 1000.0)
        raw_pieces = []
        for raw in event["segs"]:
            if not isinstance(raw, dict):
                continue
            text = str(raw.get("utf8") or "").replace("\n", " ")
            if not text.strip():
                continue
            offset = max(0.0, float(raw.get("tOffsetMs") or 0.0) / 1000.0)
            raw_pieces.append((offset, text))
        if not raw_pieces:
            continue
        raw_pieces.sort(key=lambda item: item[0])
        positive_gaps = [
            raw_pieces[index + 1][0] - raw_pieces[index][0]
            for index in range(len(raw_pieces) - 1)
            if raw_pieces[index + 1][0] > raw_pieces[index][0]
        ]
        inferred_step = (
            max(0.08, min(0.60, statistics.median(positive_gaps)))
            if positive_gaps
            else 0.24
        )
        words = []
        for index, (offset, text) in enumerate(raw_pieces):
            piece_start = event_start + offset
            if index + 1 < len(raw_pieces):
                piece_end = event_start + raw_pieces[index + 1][0]
            else:
                token_count = max(1, len(_WORD_RE.findall(text)))
                piece_end = piece_start + inferred_step * token_count
                if event_duration > 0:
                    piece_end = min(piece_end, event_start + event_duration)
            words.extend(_piece_word_timings(text, piece_start, piece_end))
        if not words:
            continue
        segment_text = " ".join(word["word"] for word in words)
        identity = (round(words[0]["start"], 3), segment_text)
        if identity in seen:
            continue
        seen.add(identity)
        segment = {
            "start": words[0]["start"],
            "end": words[-1]["end"],
            "text": segment_text,
            "words": words,
        }
        segments.append(segment)
        last_caption_end = max(last_caption_end, float(segment["end"]))

    segments.sort(key=lambda segment: (segment["start"], segment["end"]))
    duration = max(float(media_duration or 0.0), last_caption_end)
    return {"duration": duration, "segments": segments}


def _caption_quality(transcript: Dict) -> Tuple[bool, str]:
    segments = transcript.get("segments")
    if not isinstance(segments, list) or not segments:
        return False, "no caption segments"
    words = [
        word
        for segment in segments
        for word in segment.get("words", [])
        if isinstance(word, dict)
        and str(word.get("word") or "").strip()
        and float(word.get("end") or 0.0) > float(word.get("start") or 0.0)
    ]
    if len(words) < 20:
        return False, "too few timed words"
    duration = max(0.0, float(transcript.get("duration") or 0.0))
    spoken_span = float(words[-1]["end"]) - float(words[0]["start"])
    if duration > 120.0 and spoken_span < min(60.0, duration * 0.25):
        return False, "caption track covers too little of the source"
    return True, "ok"


def _cache_matches(
    transcript: Dict,
    video_id: str,
    requested_language: Optional[str],
) -> bool:
    metadata = transcript.get("_cache")
    if not isinstance(metadata, dict):
        return False
    expected_language = str(requested_language or "auto").strip().lower()
    passed, _ = _caption_quality(transcript)
    return (
        metadata.get("schema_version") == YOUTUBE_CAPTION_CACHE_SCHEMA_VERSION
        and metadata.get("parser_version") == YOUTUBE_CAPTION_PARSER_VERSION
        and metadata.get("video_id") == video_id
        and metadata.get("requested_language") == expected_language
        and passed
    )


def transcribe_youtube_captions(
    video_url: str,
    media_path: Optional[str],
    language: Optional[str] = None,
    telemetry: Optional[Any] = None,
    cache_dir: Optional[str] = None,
    video_info: Optional[Dict] = None,
) -> Optional[Dict]:
    """Return a cached/fetched exact-word transcript, or ``None`` for Whisper."""
    video_id = _extract_youtube_video_id(video_url)
    if not video_id:
        return None
    if cache_dir is None:
        from ..config import LOCAL_TRANSCRIPT_CACHE_DIR

        cache_dir = LOCAL_TRANSCRIPT_CACHE_DIR
    cache_path = _caption_cache_path(cache_dir, video_id, language)
    if cache_path.is_file():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cached = {}
        if _cache_matches(cached, video_id, language):
            if telemetry is not None:
                telemetry.cache_hit("youtube_captions")
            print(
                f"[transcribe/youtube] reusing word-timed caption cache: {cache_path}",
                flush=True,
            )
            return cached

    if telemetry is not None:
        telemetry.cache_miss("youtube_captions")
    try:
        try:
            fetched = _fetch_caption_json3(
                video_url,
                language,
                video_info=video_info,
            )
        except Exception as hint_error:
            if not isinstance(video_info, dict):
                raise
            # The signed subtitle URL in the download response can expire on
            # an exceptionally slow acquisition. Preserve the old live probe
            # as a fallback before paying for a full Whisper transcription.
            print(
                "[transcribe/youtube] downloaded caption metadata failed "
                f"({type(hint_error).__name__}: {hint_error}); retrying live metadata",
                flush=True,
            )
            fetched = _fetch_caption_json3(video_url, language)
        if fetched is None and isinstance(video_info, dict):
            # A downloader client may omit a subtitle catalog that another
            # YouTube client exposes. Retain the prior live-probe behavior.
            fetched = _fetch_caption_json3(video_url, language)
        if fetched is None:
            print("[transcribe/youtube] no JSON3 captions; using Whisper", flush=True)
            return None
        payload, track_language, source = fetched
        transcript = parse_json3_transcript(
            payload,
            media_duration=_media_duration(media_path),
        )
        passed, reason = _caption_quality(transcript)
        if not passed:
            print(
                f"[transcribe/youtube] caption track rejected ({reason}); using Whisper",
                flush=True,
            )
            return None
        transcript["_cache"] = {
            "schema_version": YOUTUBE_CAPTION_CACHE_SCHEMA_VERSION,
            "parser_version": YOUTUBE_CAPTION_PARSER_VERSION,
            "provider": source,
            "video_id": video_id,
            "requested_language": str(language or "auto").strip().lower(),
            "track_language": track_language,
        }
        _atomic_write_json(cache_path, transcript)
        word_count = sum(len(segment["words"]) for segment in transcript["segments"])
        print(
            f"[transcribe/youtube] {track_language} {source}: "
            f"{word_count} timed words in {len(transcript['segments'])} segments",
            flush=True,
        )
        return transcript
    except Exception as error:
        print(
            f"[transcribe/youtube] captions unavailable ({type(error).__name__}: {error}); "
            "using Whisper",
            flush=True,
        )
        return None
