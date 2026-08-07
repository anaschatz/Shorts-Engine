"""Local source-audio evidence for the Budget Friendly cleanliness gate.

The analyzer examines only exact candidate intervals.  It finds reference-word
gaps, runs Silero VAD in those gaps, and conditionally performs one
filler-aware faster-whisper pass.  Audio remains in memory; only sealed reports
are cached.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import re
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence

from ..artifact_contracts import ArtifactBindingError, transcript_timing_hash
from ..atomic_file import atomic_write_text
from ..profiles import (
    SPEECH_CLEANLINESS_INTERNAL_GAP_MIN_SECONDS,
    SPEECH_CLEANLINESS_VAD_EVENT_MIN_SECONDS,
    SPEECH_CLEANLINESS_WORD_EDGE_GUARD_SECONDS,
)
from ..speech_cleanliness import (
    SPEECH_CLEANLINESS_DECISION_VERSION,
    evaluate_speech_cleanliness_evidence,
    verify_speech_cleanliness_report,
)


SPEECH_CLEANLINESS_ANALYZER_VERSION = "bf-speech-cleanliness-analyzer-v1.0.0"
SPEECH_CLEANLINESS_SAMPLE_RATE = 16_000
REFERENCE_GAP_MIN_SECONDS = SPEECH_CLEANLINESS_INTERNAL_GAP_MIN_SECONDS
REFERENCE_GAP_SHRINK_SECONDS = SPEECH_CLEANLINESS_WORD_EDGE_GUARD_SECONDS
UNCOVERED_EVENT_MIN_SECONDS = SPEECH_CLEANLINESS_VAD_EVENT_MIN_SECONDS
FILLER_MODEL_NAME = "base"
FILLER_PROMPT = (
    "Transcribe every audible hesitation and backchannel exactly, including "
    "ah, uh, um, er, hmm, uh-huh, mm-hmm, yeah, right, okay, and laughter."
)
FILLER_HOTWORDS = "ah uh um er hmm uh-huh mm-hmm yeah right okay laughter"

_LEXICAL_FILLER_TOKENS = frozenset(
    {
        "ah",
        "uh",
        "um",
        "er",
        "hmm",
        "uh huh",
        "mm hmm",
        "laughter",
    }
)
_PROMPTED_FILLER_TOKENS = frozenset(
    {
        *_LEXICAL_FILLER_TOKENS,
        "yeah",
        "right",
        "okay",
        "ok",
    }
)


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


def _faster_whisper_version() -> str:
    try:
        return importlib.metadata.version("faster-whisper")
    except importlib.metadata.PackageNotFoundError:
        return "unavailable"


def _provider_identity(
    audio_decoder: Optional[Callable],
    gap_vad: Optional[Callable],
    filler_transcriber: Optional[Callable],
) -> Dict:
    return {
        "analyzerVersion": SPEECH_CLEANLINESS_ANALYZER_VERSION,
        "decisionVersion": SPEECH_CLEANLINESS_DECISION_VERSION,
        "audioDecoder": _callable_identity(audio_decoder, "ffmpeg-f32le-v1"),
        "gapVad": _callable_identity(gap_vad, "faster-whisper-silero-v1"),
        "fillerTranscriber": _callable_identity(
            filler_transcriber,
            "faster-whisper-base-fillers-v1",
        ),
        "fasterWhisperVersion": _faster_whisper_version(),
        "model": FILLER_MODEL_NAME,
        "localFilesOnly": True,
        "sampleRate": SPEECH_CLEANLINESS_SAMPLE_RATE,
        "referenceGapMinSeconds": REFERENCE_GAP_MIN_SECONDS,
        "referenceGapShrinkSeconds": REFERENCE_GAP_SHRINK_SECONDS,
        "uncoveredEventMinSeconds": UNCOVERED_EVENT_MIN_SECONDS,
        "fillerPrompt": FILLER_PROMPT,
        "fillerHotwords": FILLER_HOTWORDS,
    }


def _cache_identity(
    *,
    source_hash: str,
    transcript_hash: str,
    speech_start: float,
    speech_end: float,
    provider_identity: object,
) -> Dict:
    return {
        "sourceHash": source_hash,
        "transcriptTimingHash": transcript_hash,
        "speechInterval": {
            "startHex": float(speech_start).hex(),
            "endHex": float(speech_end).hex(),
            "semantics": "half-open",
        },
        "providerIdentity": provider_identity,
    }


def _cache_path(cache_dir: str, identity: Dict) -> Path:
    encoded = json.dumps(
        identity,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    return (
        Path(cache_dir)
        / "speech-cleanliness-v1"
        / digest[:2]
        / f"{digest}.json"
    )


def _read_cached_report(
    path: Path,
    *,
    source_hash: str,
    transcript_hash: str,
    speech_start: float,
    speech_end: float,
    provider_identity: object,
) -> Optional[Dict]:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
        verify_speech_cleanliness_report(
            report,
            source_hash=source_hash,
            transcript_timing_hash=transcript_hash,
            speech_interval=(speech_start, speech_end),
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if report.get("providerIdentity") != provider_identity:
        return None
    return report


def _write_cached_report(path: Path, report: Dict) -> None:
    verify_speech_cleanliness_report(report)
    atomic_write_text(
        path,
        json.dumps(
            report,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ),
    )


def _word_text(raw: Mapping[str, object]) -> str:
    return str(raw.get("word") or raw.get("text") or "").strip()


def _normalised_token(value: object) -> str:
    text = str(value or "").lower().replace("’", "'").replace("-", " ")
    return re.sub(r"[^a-z' ]+", "", text).replace("'", "").strip()


def _timed_words_in_half_open_interval(
    transcript: Dict,
    speech_start: float,
    speech_end: float,
) -> List[Dict]:
    words: List[Dict] = []
    for segment in transcript.get("segments") or []:
        if not isinstance(segment, dict):
            continue
        for raw in segment.get("words") or []:
            if not isinstance(raw, dict):
                continue
            text = _word_text(raw)
            try:
                start = float(raw["start"])
                end = float(raw["end"])
            except (KeyError, TypeError, ValueError):
                continue
            if (
                text
                and math.isfinite(start)
                and math.isfinite(end)
                and end > start
                and speech_start <= start < speech_end
                and end <= speech_end + 1e-9
            ):
                words.append({"text": text, "start": start, "end": end})
    return sorted(words, key=lambda word: (word["start"], word["end"]))


def _lexical_fillers(words: Sequence[Dict]) -> List[Dict]:
    return [
        {
            "text": word["text"],
            "start": word["start"],
            "end": word["end"],
        }
        for word in words
        if _normalised_token(word["text"]) in _LEXICAL_FILLER_TOKENS
    ]


def _reference_gaps(words: Sequence[Dict]) -> List[Dict]:
    gaps = []
    for left, right in zip(words, words[1:]):
        raw_duration = float(right["start"]) - float(left["end"])
        if raw_duration + 1e-9 < REFERENCE_GAP_MIN_SECONDS:
            continue
        start = float(left["end"]) + REFERENCE_GAP_SHRINK_SECONDS
        end = float(right["start"]) - REFERENCE_GAP_SHRINK_SECONDS
        if end - start + 1e-9 >= UNCOVERED_EVENT_MIN_SECONDS:
            gaps.append({"start": start, "end": end})
    return gaps


def _decode_interval_mono_16k(
    source_path: str,
    speech_start: float,
    speech_end: float,
    *,
    sample_rate: int = SPEECH_CLEANLINESS_SAMPLE_RATE,
):
    duration = speech_end - speech_start
    command = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(source_path),
        "-ss",
        f"{speech_start:.9f}",
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
        raise RuntimeError("ffmpeg is required for speech-cleanliness analysis") from error
    except subprocess.CalledProcessError as error:
        raise RuntimeError("ffmpeg speech-cleanliness decode failed") from error
    if not result.stdout:
        raise RuntimeError("ffmpeg returned no speech-cleanliness audio")
    import numpy as np  # type: ignore

    audio = np.frombuffer(result.stdout, dtype="<f4")
    if not audio.size:
        raise RuntimeError("ffmpeg returned no speech-cleanliness samples")
    return audio


def _slice_audio(audio: object, start_sample: int, end_sample: int):
    if isinstance(audio, (bytes, bytearray, memoryview)):
        first = max(0, int(start_sample)) * 4
        last = max(first, int(end_sample)) * 4
        import numpy as np  # type: ignore

        return np.frombuffer(bytes(audio)[first:last], dtype="<f4")
    try:
        return audio[max(0, int(start_sample)) : max(0, int(end_sample))]
    except (TypeError, AttributeError) as error:
        raise RuntimeError("decoded speech-cleanliness audio is not sliceable") from error


def _silero_gap_vad(
    gap_audio: object,
    *,
    sample_rate: int = SPEECH_CLEANLINESS_SAMPLE_RATE,
) -> List[Dict]:
    if int(sample_rate) != SPEECH_CLEANLINESS_SAMPLE_RATE:
        raise RuntimeError("Silero speech-cleanliness VAD requires 16kHz audio")
    from faster_whisper.vad import VadOptions, get_speech_timestamps  # type: ignore

    events = get_speech_timestamps(
        gap_audio,
        vad_options=VadOptions(
            threshold=0.5,
            min_speech_duration_ms=int(UNCOVERED_EVENT_MIN_SECONDS * 1000),
            min_silence_duration_ms=80,
            speech_pad_ms=0,
        ),
    )
    return [
        {
            "start": float(event["start"]) / sample_rate,
            "end": float(event["end"]) / sample_rate,
        }
        for event in events
    ]


def _event_times(raw: object) -> tuple[float, float, Optional[float]]:
    if isinstance(raw, Mapping):
        start_value = raw.get("startSeconds", raw.get("start"))
        end_value = raw.get("endSeconds", raw.get("end"))
        confidence_value = raw.get("confidence")
    else:
        start_value = getattr(raw, "start", None)
        end_value = getattr(raw, "end", None)
        confidence_value = getattr(raw, "confidence", None)
    start = float(start_value)
    end = float(end_value)
    confidence = float(confidence_value) if confidence_value is not None else None
    if not math.isfinite(start) or not math.isfinite(end) or end <= start:
        raise RuntimeError("speech-cleanliness provider returned invalid timing")
    if confidence is not None and (
        not math.isfinite(confidence) or not 0.0 <= confidence <= 1.0
    ):
        raise RuntimeError("speech-cleanliness provider returned invalid confidence")
    return start, end, confidence


def _uncovered_vocalizations(
    audio: object,
    gaps: Sequence[Dict],
    speech_start: float,
    vad: Callable,
) -> List[Dict]:
    uncovered = []
    for gap in gaps:
        relative_start = float(gap["start"]) - speech_start
        relative_end = float(gap["end"]) - speech_start
        first = max(0, int(math.floor(relative_start * SPEECH_CLEANLINESS_SAMPLE_RATE)))
        last = max(first, int(math.ceil(relative_end * SPEECH_CLEANLINESS_SAMPLE_RATE)))
        gap_audio = _slice_audio(audio, first, last)
        events = vad(gap_audio, sample_rate=SPEECH_CLEANLINESS_SAMPLE_RATE)
        if events is None:
            events = []
        for raw in events:
            start, end, confidence = _event_times(raw)
            absolute_start = float(gap["start"]) + start
            absolute_end = min(float(gap["end"]), float(gap["start"]) + end)
            if absolute_end - absolute_start + 1e-9 < UNCOVERED_EVENT_MIN_SECONDS:
                continue
            event = {"start": absolute_start, "end": absolute_end}
            if confidence is not None:
                event["confidence"] = confidence
            uncovered.append(event)
    return uncovered


class _FasterWhisperFillerTranscriber:
    provider_identity = "faster-whisper-base-fillers-v1"

    def __init__(self) -> None:
        from faster_whisper import WhisperModel  # type: ignore

        from .transcriber import _resolve_device

        device = _resolve_device()
        compute_type = "float16" if device == "cuda" else "int8"
        self._model = WhisperModel(
            FILLER_MODEL_NAME,
            device=device,
            compute_type=compute_type,
            local_files_only=True,
        )

    def __call__(
        self,
        audio: object,
        *,
        sample_rate: int = SPEECH_CLEANLINESS_SAMPLE_RATE,
        language: Optional[str] = None,
    ) -> List[Dict]:
        if int(sample_rate) != SPEECH_CLEANLINESS_SAMPLE_RATE:
            raise RuntimeError("filler transcription requires 16kHz audio")
        segments, _info = self._model.transcribe(
            audio,
            language=language,
            beam_size=5,
            condition_on_previous_text=False,
            word_timestamps=True,
            vad_filter=False,
            initial_prompt=FILLER_PROMPT,
            hotwords=FILLER_HOTWORDS,
        )
        output = []
        for segment in segments:
            for word in getattr(segment, "words", None) or []:
                if word.start is None or word.end is None:
                    continue
                output.append(
                    {
                        "text": str(word.word or "").strip(),
                        "start": float(word.start),
                        "end": float(word.end),
                        "confidence": float(word.probability or 0.0),
                    }
                )
        return output


def _language_hint(transcript: Dict) -> Optional[str]:
    metadata = transcript.get("_cache")
    if isinstance(metadata, dict):
        value = (
            metadata.get("track_language")
            or metadata.get("language")
            or metadata.get("requested_language")
        )
        normalized = str(value or "").strip().lower()
        if normalized not in {"", "auto", "none"}:
            return normalized.split("-", 1)[0]
    normalized = str(transcript.get("language") or "").strip().lower()
    return normalized.split("-", 1)[0] if normalized else None


def _iter_transcriber_words(result: object) -> Iterable[object]:
    if isinstance(result, Mapping):
        direct = result.get("prompted_fillers") or result.get("words")
        if isinstance(direct, list):
            yield from direct
            return
        segments = result.get("segments") or []
    elif isinstance(result, tuple) and result:
        segments = result[0]
    else:
        segments = result
    if segments is None:
        return
    for segment in segments:
        if isinstance(segment, Mapping):
            words = segment.get("words")
            if words is None and any(key in segment for key in ("start", "startSeconds")):
                yield segment
                continue
        else:
            words = getattr(segment, "words", None)
            if words is None and getattr(segment, "start", None) is not None:
                yield segment
                continue
        for word in words or []:
            yield word


def _raw_event_text(raw: object) -> str:
    if isinstance(raw, Mapping):
        return str(raw.get("text") or raw.get("word") or raw.get("token") or "").strip()
    return str(getattr(raw, "word", None) or getattr(raw, "text", None) or "").strip()


def _overlaps_reference(start: float, end: float, words: Sequence[Dict]) -> bool:
    return any(
        end > float(word["start"]) + 0.01
        and start < float(word["end"]) - 0.01
        for word in words
    )


def _extract_prompted_fillers(
    result: object,
    *,
    speech_start: float,
    speech_end: float,
    reference_words: Sequence[Dict],
    uncovered: Sequence[Dict],
) -> List[Dict]:
    duration = speech_end - speech_start
    prompted = []
    for raw in _iter_transcriber_words(result):
        text = _raw_event_text(raw)
        if _normalised_token(text) not in _PROMPTED_FILLER_TOKENS:
            continue
        start, end, confidence = _event_times(raw)
        if 0.0 <= start < duration + 1e-9 and end <= duration + 1e-9:
            start += speech_start
            end += speech_start
        elif not (speech_start <= start < speech_end and end <= speech_end + 1e-9):
            raise RuntimeError("filler transcriber timing is outside the candidate")
        if _overlaps_reference(start, end, reference_words):
            continue
        if uncovered and not any(
            end > float(event["start"]) and start < float(event["end"])
            for event in uncovered
        ):
            continue
        event = {"text": text, "start": start, "end": end}
        if confidence is not None:
            event["confidence"] = confidence
        prompted.append(event)

    unique: Dict[tuple, Dict] = {}
    for event in prompted:
        key = (
            _normalised_token(event["text"]),
            round(float(event["start"]), 6),
            round(float(event["end"]), 6),
        )
        unique.setdefault(key, event)
    return sorted(unique.values(), key=lambda event: (event["start"], event["end"]))


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
        sample_rate=SPEECH_CLEANLINESS_SAMPLE_RATE,
    )


def _invoke_filler_transcriber(
    transcriber: object,
    audio: object,
    language: Optional[str],
):
    callable_value = transcriber
    if not callable(callable_value):
        callable_value = getattr(transcriber, "transcribe", None)
    if not callable(callable_value):
        raise RuntimeError("filler transcriber is not callable")
    return callable_value(
        audio,
        sample_rate=SPEECH_CLEANLINESS_SAMPLE_RATE,
        language=language,
    )


def _candidate_with_report(candidate: Dict, report: Dict) -> Dict:
    verified = verify_speech_cleanliness_report(report)
    item = dict(candidate)
    item.update(
        {
            "speechCleanlinessReport": verified,
            "speechCleanlinessStatus": verified["status"],
            "speechCleanlinessEligible": verified["eligible"],
            "speechCleanlinessRejectionReasons": list(
                verified["rejectionReasons"]
            ),
            "speechCleanlinessReviewReasons": list(verified["reviewReasons"]),
            "speech_cleanliness_decision_version": verified["decisionVersion"],
            "speech_cleanliness_status": verified["status"],
            "speech_cleanliness_eligible": verified["eligible"],
            "speech_cleanliness_reject_reasons": list(
                verified["rejectionReasons"]
            ),
            "speech_cleanliness_review_reasons": list(verified["reviewReasons"]),
            "speech_cleanliness_deterministic_reasons": list(
                verified["deterministicReasons"]
            ),
            "speech_cleanliness_provider_status": verified["providerStatus"],
            "speech_cleanliness_lexical_filler_count": verified[
                "lexicalFillerCount"
            ],
            "speech_cleanliness_uncovered_vocalization_count": verified[
                "uncoveredVocalizationCount"
            ],
            "speech_cleanliness_prompted_filler_count": verified[
                "promptedFillerCount"
            ],
        }
    )
    return item


def analyze_motivational_speech_cleanliness(
    source_path: str,
    candidates: Sequence[Dict],
    transcript: Dict,
    source_hash: str,
    cache_dir: str,
    telemetry: Optional[Any] = None,
    audio_decoder: Optional[Callable] = None,
    gap_vad: Optional[Callable] = None,
    filler_transcriber: Optional[Callable] = None,
) -> List[Dict]:
    """Attach sealed speech-cleanliness decisions to candidate copies.

    Injected providers follow three small call contracts used by the focused
    tests: ``audio_decoder(path, start, end, sample_rate=...)``;
    ``gap_vad(gap_audio, sample_rate=...)``; and
    ``filler_transcriber(candidate_audio, sample_rate=..., language=...)``.
    Provider/model failures are converted to review reports and never pass.
    """

    transcript_hash = transcript_timing_hash(transcript)
    provider_identity = _provider_identity(
        audio_decoder,
        gap_vad,
        filler_transcriber,
    )
    decoder = audio_decoder or _decode_interval_mono_16k
    vad = gap_vad or _silero_gap_vad
    language = _language_hint(transcript)
    default_filler_runner: Optional[_FasterWhisperFillerTranscriber] = None
    default_filler_error = False
    output: List[Dict] = []

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

        identity = _cache_identity(
            source_hash=source_hash,
            transcript_hash=transcript_hash,
            speech_start=speech_start,
            speech_end=speech_end,
            provider_identity=provider_identity,
        )
        path = _cache_path(cache_dir, identity)
        cached = _read_cached_report(
            path,
            source_hash=source_hash,
            transcript_hash=transcript_hash,
            speech_start=speech_start,
            speech_end=speech_end,
            provider_identity=provider_identity,
        )
        if cached is not None:
            if telemetry is not None:
                telemetry.cache_hit("speech_cleanliness")
            output.append(_candidate_with_report(item, cached))
            continue
        if telemetry is not None:
            telemetry.cache_miss("speech_cleanliness")

        words = _timed_words_in_half_open_interval(
            transcript,
            speech_start,
            speech_end,
        )
        lexical = _lexical_fillers(words)
        uncovered: List[Dict] = []
        prompted: List[Dict] = []
        provider_status = "ok"
        decoded_audio = None

        if not words:
            provider_status = "reference_word_timing_missing"
        else:
            try:
                decoded_audio = _invoke_audio_decoder(
                    decoder,
                    source_path,
                    speech_start,
                    speech_end,
                )
            except Exception:
                provider_status = "audio_decode_error"

        if provider_status == "ok":
            try:
                uncovered = _uncovered_vocalizations(
                    decoded_audio,
                    _reference_gaps(words),
                    speech_start,
                    vad,
                )
            except Exception:
                provider_status = "gap_vad_error"

        if provider_status == "ok" and (len(uncovered) >= 2 or lexical):
            runner: Optional[object] = filler_transcriber
            if runner is None and not default_filler_error:
                if default_filler_runner is None:
                    try:
                        default_filler_runner = _FasterWhisperFillerTranscriber()
                    except Exception:
                        default_filler_error = True
                runner = default_filler_runner
            if runner is None:
                provider_status = "filler_transcriber_error"
            else:
                try:
                    result = _invoke_filler_transcriber(
                        runner,
                        decoded_audio,
                        language,
                    )
                    prompted = _extract_prompted_fillers(
                        result,
                        speech_start=speech_start,
                        speech_end=speech_end,
                        reference_words=words,
                        uncovered=uncovered,
                    )
                except Exception:
                    provider_status = "filler_transcriber_error"

        report = evaluate_speech_cleanliness_evidence(
            source_hash=source_hash,
            transcript_timing_hash=transcript_hash,
            speech_start=speech_start,
            speech_end=speech_end,
            lexical_fillers=lexical,
            uncovered_vocalizations=uncovered,
            prompted_fillers=prompted,
            provider_status=provider_status,
            provider_identity=provider_identity,
        )
        _write_cached_report(path, report)
        output.append(_candidate_with_report(item, report))

    return output


__all__ = [
    "FILLER_HOTWORDS",
    "FILLER_MODEL_NAME",
    "FILLER_PROMPT",
    "REFERENCE_GAP_MIN_SECONDS",
    "REFERENCE_GAP_SHRINK_SECONDS",
    "SPEECH_CLEANLINESS_ANALYZER_VERSION",
    "SPEECH_CLEANLINESS_SAMPLE_RATE",
    "UNCOVERED_EVENT_MIN_SECONDS",
    "analyze_motivational_speech_cleanliness",
]
