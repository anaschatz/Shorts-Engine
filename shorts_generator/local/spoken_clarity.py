"""Local evidence provider for the sealed spoken-clarity gate.

Only the exact candidate interval is inspected.  Reference word timing is read
from the immutable transcript and a short, source-contiguous opening window is
decoded for ASR confidence evidence.  No source audio is rewritten and no
attempt is made to remove, conceal, or repair a disfluency.
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
from ..spoken_clarity import (
    OPENING_WINDOW_SECONDS,
    SPOKEN_CLARITY_DECISION_VERSION,
    SPOKEN_CLARITY_POLICY,
    evaluate_spoken_clarity_evidence,
    verify_spoken_clarity_report,
)


SPOKEN_CLARITY_ANALYZER_VERSION = "bf-spoken-clarity-analyzer-v1.2.0"
SPOKEN_CLARITY_SAMPLE_RATE = 16_000
OPENING_CLARITY_MODEL_NAME = "base"
OPENING_CLARITY_PROVIDER_NAME = "faster-whisper-base-opening-clarity-v1"

_SENTENCE_END_RE = re.compile(r"[.!?][\"')\]]*\s*$")


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
    clarity_transcriber: Optional[Callable],
    *,
    language: Optional[str],
) -> Dict:
    return {
        "analyzerVersion": SPOKEN_CLARITY_ANALYZER_VERSION,
        "decisionVersion": SPOKEN_CLARITY_DECISION_VERSION,
        "audioDecoder": _callable_identity(audio_decoder, "ffmpeg-f32le-v1"),
        "openingClarityTranscriber": _callable_identity(
            clarity_transcriber,
            OPENING_CLARITY_PROVIDER_NAME,
        ),
        "fasterWhisperVersion": _faster_whisper_version(),
        "model": OPENING_CLARITY_MODEL_NAME,
        "language": language or "auto",
        "modelLifecycle": "one_instance_per_analyze_batch",
        "localFilesOnly": True,
        "sampleRate": SPOKEN_CLARITY_SAMPLE_RATE,
        "openingWindowSeconds": OPENING_WINDOW_SECONDS,
        "confidenceEvidence": "word_probability_v1",
        "confidencePolicy": dict(SPOKEN_CLARITY_POLICY),
        "audioPolicy": "read_only_source_contiguous_selection",
    }


def _cache_identity(
    *,
    source_hash: str,
    transcript_hash: str,
    speech_start: float,
    speech_end: float,
    point_exact_quote: str,
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
        "pointExactQuote": point_exact_quote,
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
    return Path(cache_dir) / "spoken-clarity-v1" / digest[:2] / f"{digest}.json"


def _read_cached_report(
    path: Path,
    *,
    source_hash: str,
    transcript_hash: str,
    speech_start: float,
    speech_end: float,
    point_exact_quote: str,
    provider_identity: object,
) -> Optional[Dict]:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
        verify_spoken_clarity_report(
            report,
            source_hash=source_hash,
            transcript_timing_hash=transcript_hash,
            speech_interval=(speech_start, speech_end),
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if (
        report.get("providerIdentity") != provider_identity
        or (report.get("inputs") or {}).get("pointExactQuote") != point_exact_quote
    ):
        return None
    return report


def _write_cached_report(path: Path, report: Dict) -> None:
    verify_spoken_clarity_report(report)
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


def _timed_words_in_half_open_interval(
    transcript: Dict,
    speech_start: float,
    speech_end: float,
) -> List[Dict]:
    words: List[Dict] = []
    for segment_index, segment in enumerate(transcript.get("segments") or []):
        if not isinstance(segment, dict):
            continue
        all_segment_words = []
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
            ):
                all_segment_words.append(
                    {
                        "text": text,
                        "start": start,
                        "end": end,
                        "segmentIndex": segment_index,
                    }
                )
        segment_words = [
            dict(word)
            for word in all_segment_words
            if speech_start <= float(word["start"]) < speech_end
            and float(word["end"]) <= speech_end + 1e-9
        ]
        if (
            segment_words
            and all_segment_words
            and segment_words[-1] == all_segment_words[-1]
            and _SENTENCE_END_RE.search(str(segment.get("text") or ""))
        ):
            segment_words[-1]["sentenceBoundaryAfter"] = True
        words.extend(segment_words)
    return sorted(
        words,
        key=lambda word: (word["start"], word["end"], word["segmentIndex"]),
    )


def _point_exact_quote(candidate: Mapping[str, object]) -> str:
    for field in (
        "semantic_closure_exact_quote",
        "semantic_closure_sentence",
        "earliest_complete_takeaway_sentence",
        "final_takeaway_sentence",
    ):
        value = str(candidate.get(field) or "").strip()
        if value:
            return value
    return ""


def _decode_opening_mono_16k(
    source_path: str,
    speech_start: float,
    opening_end: float,
    *,
    sample_rate: int = SPOKEN_CLARITY_SAMPLE_RATE,
):
    duration = opening_end - speech_start
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
        raise RuntimeError("ffmpeg is required for spoken-clarity analysis") from error
    except subprocess.CalledProcessError as error:
        raise RuntimeError("ffmpeg spoken-clarity decode failed") from error
    if not result.stdout:
        raise RuntimeError("ffmpeg returned no spoken-clarity audio")
    import numpy as np  # type: ignore

    audio = np.frombuffer(result.stdout, dtype="<f4")
    if not audio.size:
        raise RuntimeError("ffmpeg returned no spoken-clarity samples")
    return audio


class _FasterWhisperOpeningClarityTranscriber:
    """One local model instance reused for every candidate in one batch."""

    provider_identity = OPENING_CLARITY_PROVIDER_NAME

    def __init__(self) -> None:
        from faster_whisper import WhisperModel  # type: ignore

        from .transcriber import _resolve_device

        device = _resolve_device()
        compute_type = "float16" if device == "cuda" else "int8"
        self._model = WhisperModel(
            OPENING_CLARITY_MODEL_NAME,
            device=device,
            compute_type=compute_type,
            local_files_only=True,
        )

    def __call__(
        self,
        audio: object,
        *,
        sample_rate: int = SPOKEN_CLARITY_SAMPLE_RATE,
        language: Optional[str] = None,
    ) -> List[Dict]:
        if int(sample_rate) != SPOKEN_CLARITY_SAMPLE_RATE:
            raise RuntimeError("opening clarity transcription requires 16kHz audio")
        segments, _info = self._model.transcribe(
            audio,
            language=language,
            beam_size=5,
            condition_on_previous_text=False,
            word_timestamps=True,
            vad_filter=False,
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
        direct = result.get("opening_asr_words") or result.get("words")
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


def _raw_asr_word(raw: object) -> tuple[str, float, float, float]:
    if isinstance(raw, Mapping):
        text = str(raw.get("text") or raw.get("word") or "").strip()
        start_value = raw.get("startSeconds", raw.get("start"))
        end_value = raw.get("endSeconds", raw.get("end"))
        confidence_value = raw.get("confidence", raw.get("probability"))
    else:
        text = str(getattr(raw, "word", None) or getattr(raw, "text", None) or "").strip()
        start_value = getattr(raw, "start", None)
        end_value = getattr(raw, "end", None)
        confidence_value = getattr(raw, "probability", None)
        if confidence_value is None:
            confidence_value = getattr(raw, "confidence", None)
    try:
        start = float(start_value)
        end = float(end_value)
        confidence = float(confidence_value)
    except (TypeError, ValueError) as error:
        raise RuntimeError("opening clarity provider returned incomplete evidence") from error
    if (
        not text
        or not math.isfinite(start)
        or not math.isfinite(end)
        or end <= start
        or not math.isfinite(confidence)
        or not 0.0 <= confidence <= 1.0
    ):
        raise RuntimeError("opening clarity provider returned invalid evidence")
    return text, start, end, confidence


def _extract_opening_asr_words(
    result: object,
    *,
    speech_start: float,
    opening_end: float,
) -> List[Dict]:
    duration = opening_end - speech_start
    words = []
    for raw in _iter_transcriber_words(result):
        text, start, end, confidence = _raw_asr_word(raw)
        # The local model reports relative timestamps.  Injected providers may
        # instead return absolute source timestamps, which remain accepted.
        if 0.0 <= start < duration and end <= duration + 1e-9:
            start += speech_start
            end += speech_start
        elif not (
            speech_start <= start < opening_end and end <= opening_end + 1e-9
        ):
            raise RuntimeError("opening clarity timing is outside the decoded window")
        words.append(
            {
                "text": text,
                "start": start,
                "end": end,
                "confidence": confidence,
            }
        )
    return sorted(words, key=lambda word: (word["start"], word["end"], word["text"]))


def _invoke_audio_decoder(
    decoder: Callable,
    source_path: str,
    speech_start: float,
    opening_end: float,
):
    return decoder(
        source_path,
        speech_start,
        opening_end,
        sample_rate=SPOKEN_CLARITY_SAMPLE_RATE,
    )


def _invoke_clarity_transcriber(
    transcriber: object,
    audio: object,
    language: Optional[str],
):
    callable_value = transcriber
    if not callable(callable_value):
        callable_value = getattr(transcriber, "transcribe", None)
    if not callable(callable_value):
        raise RuntimeError("opening clarity transcriber is not callable")
    return callable_value(
        audio,
        sample_rate=SPOKEN_CLARITY_SAMPLE_RATE,
        language=language,
    )


def _candidate_with_report(candidate: Dict, report: Dict) -> Dict:
    verified = verify_spoken_clarity_report(report)
    evidence = verified["evidence"]
    counts = verified["counts"]
    asr = evidence["openingAsr"]
    item = dict(candidate)
    item.update(
        {
            "spokenClarityReport": verified,
            "spokenClarityStatus": verified["status"],
            "spokenClarityEligible": verified["eligible"],
            "spokenClarityRejectionReasons": list(verified["rejectionReasons"]),
            "spokenClarityReviewReasons": list(verified["reviewReasons"]),
            "spoken_clarity_decision_version": verified["decisionVersion"],
            "spoken_clarity_status": verified["status"],
            "spoken_clarity_eligible": verified["eligible"],
            "spoken_clarity_reject_reasons": list(verified["rejectionReasons"]),
            "spoken_clarity_review_reasons": list(verified["reviewReasons"]),
            "spoken_clarity_deterministic_reasons": list(
                verified["deterministicReasons"]
            ),
            "spoken_clarity_provider_status": verified["providerStatus"],
            "spoken_clarity_adjacent_duplicate_count": counts[
                "adjacentDuplicates"
            ],
            "spoken_clarity_repeated_phrase_count": counts[
                "repeatedPhraseRestarts"
            ],
            "spoken_clarity_searching_pause_count": counts[
                "searchingInternalPauses"
            ],
            "spoken_clarity_opening_asr_mean_confidence": asr[
                "meanWordConfidence"
            ],
            "spoken_clarity_opening_asr_low_ratio": asr[
                "lowConfidenceWordRatio"
            ],
            "spoken_clarity_opening_asr_token_match_ratio": asr[
                "tokenMatchRatio"
            ],
        }
    )
    return item


def analyze_motivational_spoken_clarity(
    source_path: str,
    candidates: Sequence[Dict],
    transcript: Dict,
    source_hash: str,
    cache_dir: str,
    telemetry: Optional[Any] = None,
    audio_decoder: Optional[Callable] = None,
    clarity_transcriber: Optional[Callable] = None,
) -> List[Dict]:
    """Attach sealed spoken-clarity decisions to candidate copies.

    The default faster-whisper model is created lazily at most once for this
    whole call, then reused for every uncached candidate.  A missing or failed
    provider produces an ineligible review report; it can never silently pass.
    """

    transcript_hash = transcript_timing_hash(transcript)
    language = _language_hint(transcript)
    provider_identity = _provider_identity(
        audio_decoder,
        clarity_transcriber,
        language=language,
    )
    decoder = audio_decoder or _decode_opening_mono_16k
    default_runner: Optional[_FasterWhisperOpeningClarityTranscriber] = None
    default_runner_error = False
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

        point_quote = _point_exact_quote(item)
        identity = _cache_identity(
            source_hash=source_hash,
            transcript_hash=transcript_hash,
            speech_start=speech_start,
            speech_end=speech_end,
            point_exact_quote=point_quote,
            provider_identity=provider_identity,
        )
        path = _cache_path(cache_dir, identity)
        cached = _read_cached_report(
            path,
            source_hash=source_hash,
            transcript_hash=transcript_hash,
            speech_start=speech_start,
            speech_end=speech_end,
            point_exact_quote=point_quote,
            provider_identity=provider_identity,
        )
        if cached is not None:
            if telemetry is not None:
                telemetry.cache_hit("spoken_clarity")
            output.append(_candidate_with_report(item, cached))
            continue
        if telemetry is not None:
            telemetry.cache_miss("spoken_clarity")

        reference_words = _timed_words_in_half_open_interval(
            transcript,
            speech_start,
            speech_end,
        )
        opening_asr_words: List[Dict] = []
        provider_status = "ok"

        if not reference_words:
            provider_status = "reference_word_timing_missing"
        else:
            opening_end = min(speech_end, speech_start + OPENING_WINDOW_SECONDS)
            try:
                audio = _invoke_audio_decoder(
                    decoder,
                    source_path,
                    speech_start,
                    opening_end,
                )
            except Exception:
                provider_status = "audio_decode_error"

        runner: Optional[object] = clarity_transcriber
        if provider_status == "ok" and runner is None:
            if not default_runner_error and default_runner is None:
                try:
                    default_runner = _FasterWhisperOpeningClarityTranscriber()
                except Exception:
                    default_runner_error = True
            runner = default_runner
        if provider_status == "ok" and runner is None:
            provider_status = "clarity_transcriber_error"
        elif provider_status == "ok":
            try:
                result = _invoke_clarity_transcriber(runner, audio, language)
                opening_asr_words = _extract_opening_asr_words(
                    result,
                    speech_start=speech_start,
                    opening_end=opening_end,
                )
                if not opening_asr_words:
                    provider_status = "opening_asr_words_missing"
            except Exception:
                provider_status = "clarity_transcriber_error"

        report = evaluate_spoken_clarity_evidence(
            source_hash=source_hash,
            transcript_timing_hash=transcript_hash,
            speech_start=speech_start,
            speech_end=speech_end,
            reference_words=reference_words,
            point_exact_quote=point_quote,
            opening_asr_words=opening_asr_words,
            provider_status=provider_status,
            provider_identity=provider_identity,
        )
        # Runtime/model failures are transient operational state, not reusable
        # source evidence.  Retry them on the next run instead of pinning an
        # ineligible result in the content-addressed cache forever.
        if provider_status == "ok":
            _write_cached_report(path, report)
        output.append(_candidate_with_report(item, report))

    return output


__all__ = [
    "OPENING_CLARITY_MODEL_NAME",
    "OPENING_CLARITY_PROVIDER_NAME",
    "SPOKEN_CLARITY_ANALYZER_VERSION",
    "SPOKEN_CLARITY_SAMPLE_RATE",
    "analyze_motivational_spoken_clarity",
]
