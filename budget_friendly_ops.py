#!/usr/bin/env python3
"""Operator CLI for the reviewed Budget Friendly production and growth loop."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import unicodedata
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

from shorts_generator.artifact_contracts import (
    ArtifactBindingError,
    CANDIDATE_DECISION_PROFILE_RULES,
    CANDIDATE_PROFILE_FIELDS,
    FEED_STOP_REPLAY_PROFILE_TUPLES,
    FEED_STOP_V2_REPLAY_PROFILE_TUPLE,
    FEED_STOP_V3_REPLAY_PROFILE_TUPLE,
    _verify_feed_stop_speech_cleanliness,
    _verify_feed_stop_spoken_clarity,
    _verify_feed_stop_v3_evidence,
    build_candidate_decision,
    build_publish_manifest,
    build_replay_transcript_manifest,
    build_rights_manifest,
    candidate_hash,
    content_hash,
    file_sha256,
    verify_replay_transcript_manifest,
    verify_seal,
)
from shorts_generator.config import (
    LOCAL_AUTORESEARCH_EVIDENCE_DIR,
    LOCAL_PERFORMANCE_REPORT_DIR,
    LOCAL_RENDER_WORKERS,
)
from shorts_generator.experiment import build_experiment_manifest
from shorts_generator.growth_analytics import (
    GrowthAnalyticsStore,
    build_analytics_snapshot,
    evaluate_cohorts,
    import_studio_csv,
)
from shorts_generator.originality import evaluate_originality
from shorts_generator.performance import PerformanceTelemetry
from shorts_generator.local.downloader import _extract_youtube_video_id
from shorts_generator.local.youtube_captions import (
    _cache_matches as _youtube_caption_cache_matches,
)
from shorts_generator.production_workflow import (
    render_approved_candidate,
    render_approved_candidates,
)
from shorts_generator.preview_provenance import (
    analyze_preview_source_provenance,
)
from shorts_generator.profiles import (
    BF_FEED_STOP_FORMAT_V1,
    profile_manifest_metadata,
    resolve_profile_bundle,
)
from shorts_generator.replay_capture import (
    HUMAN_PREVIEW_REJECTION_RECEIPT_TYPE,
    HUMAN_REJECTION_RECEIPT_TYPE,
    archive_approved_candidate,
    archive_rejected_candidate,
    archive_rejected_preview,
    build_replay_human_preview_rejection,
    build_replay_human_rejection,
    build_replay_capture_dataset,
    write_immutable_json,
)
from shorts_generator.speech_cleanliness import (
    verify_speech_cleanliness_report,
)
from shorts_generator.publisher import (
    PublishReceiptStore,
    publish_idempotency_key,
    publish_reviewed_short,
    publish_upload_marker,
    release_uploaded_short,
)


def read_json(path: str) -> dict:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object in {path}")
    return value


def write_json(path: str, value: dict) -> str:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True, ensure_ascii=True)
            handle.write("\n")
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return str(target.resolve())


def finish_performance_report(telemetry: PerformanceTelemetry) -> dict:
    report_path = (
        Path(LOCAL_PERFORMANCE_REPORT_DIR)
        / f"{telemetry.run_id}.json"
    )
    try:
        written = telemetry.write_report(report_path)
        written_path = str(written)
        write_error = None
    except (OSError, TypeError, ValueError, RuntimeError) as error:
        telemetry.finish()
        written_path = None
        write_error = str(error)
    report = telemetry.snapshot()
    payload = {
        "runId": telemetry.run_id,
        "reportPath": written_path,
        "durationSeconds": report["durationSeconds"],
        "stageTotals": report["stageTotals"],
        "cacheCounters": report["cacheCounters"],
    }
    if write_error:
        payload["reportWriteError"] = write_error
    return payload


def _review_candidate_from_file(
    path: str,
    rank: int | None,
    source_path: str,
    *,
    require_eligible: bool,
    require_replay_transcript: bool,
) -> tuple[dict, dict, str, dict | None, dict | None]:
    ranking = verify_seal(read_json(path), "RankingManifest")
    if rank is None:
        raise ValueError("--rank is required when reviewing from ranking.json")
    source_hash = file_sha256(source_path)
    if ranking.get("sourceHash") != source_hash:
        raise ArtifactBindingError("ranking manifest is not bound to the supplied source")
    profile_contracts = tuple(
        (
            profile_tuple,
            profile_manifest_metadata(
                resolve_profile_bundle(format_profile=profile_tuple[3])
            ),
        )
        for profile_tuple in CANDIDATE_DECISION_PROFILE_RULES
    )
    matching_contracts = [
        item for item in profile_contracts if ranking.get("profiles") == item[1]
    ]
    if len(matching_contracts) != 1:
        raise ArtifactBindingError(
            "ranking manifest does not freeze an approved review profile"
        )
    expected_profile_tuple = matching_contracts[0][0]
    candidates = ranking.get("candidates")
    if not isinstance(candidates, list):
        raise ArtifactBindingError("ranking manifest candidates are invalid")
    matches = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise ArtifactBindingError("ranking manifest candidate is invalid")
        raw_rank = candidate.get("selection_rank", candidate.get("output_rank", -1))
        try:
            candidate_rank = int(raw_rank)
        except (TypeError, ValueError):
            continue
        if candidate_rank == rank:
            matches.append(candidate)
    if len(matches) != 1:
        raise ValueError(f"Candidate rank {rank} did not resolve exactly once")
    candidate = matches[0]
    if require_eligible and (
        candidate.get("rejected") is not False
        or candidate.get("rejection_reasons")
    ):
        raise ArtifactBindingError("only an eligible non-rejected ranking candidate can be approved")
    expected_candidate_profiles = dict(
        zip(CANDIDATE_PROFILE_FIELDS, expected_profile_tuple)
    )
    for field, expected in expected_candidate_profiles.items():
        if str(candidate.get(field) or "").strip().lower() != expected:
            raise ArtifactBindingError(f"ranking candidate {field} is incompatible")
    transcript_manifest = ranking.get("replayTranscriptManifest")
    verified_transcript_manifest = None
    if (
        require_replay_transcript
        or expected_profile_tuple in FEED_STOP_REPLAY_PROFILE_TUPLES
    ):
        if not isinstance(transcript_manifest, dict):
            raise ArtifactBindingError("ranking lacks a replay transcript manifest")
        verified_transcript_manifest = verify_replay_transcript_manifest(
            transcript_manifest,
            source_hash=source_hash,
            require_timed_words=True,
        )
    declared_candidate_hash = str(candidate.get("candidate_hash") or "").strip().lower()
    if declared_candidate_hash != candidate_hash(candidate, source_hash):
        raise ArtifactBindingError("ranking candidate hash is stale")
    verified_speech_report = None
    if expected_profile_tuple in FEED_STOP_REPLAY_PROFILE_TUPLES:
        if verified_transcript_manifest is None:
            raise ArtifactBindingError(
                "feed-stop ranking lacks a replay transcript manifest"
            )
        if (
            require_eligible
            and expected_profile_tuple == FEED_STOP_V3_REPLAY_PROFILE_TUPLE
        ):
            verified_v3_evidence = _verify_feed_stop_v3_evidence(
                candidate,
                source_hash,
                transcript_timing_hash=verified_transcript_manifest[
                    "transcriptTimingHash"
                ],
                replay_transcript=verified_transcript_manifest["transcript"],
            )
            verified_speech_report = verified_v3_evidence[
                "speechCleanlinessReport"
            ]
        elif require_eligible:
            verified_speech_report = _verify_feed_stop_speech_cleanliness(
                candidate,
                source_hash,
                transcript_timing_hash=verified_transcript_manifest[
                    "transcriptTimingHash"
                ],
            )
        else:
            verified_speech_report = _verify_rejection_speech_cleanliness(
                candidate,
                source_hash,
                transcript_timing_hash=verified_transcript_manifest[
                    "transcriptTimingHash"
                ],
            )
        if (
            expected_profile_tuple == FEED_STOP_V2_REPLAY_PROFILE_TUPLE
            and require_eligible
        ):
            _verify_feed_stop_spoken_clarity(
                candidate,
                source_hash,
                transcript_timing_hash=verified_transcript_manifest[
                    "transcriptTimingHash"
                ],
            )
        elif expected_profile_tuple == FEED_STOP_V2_REPLAY_PROFILE_TUPLE:
            _verify_rejection_spoken_clarity(
                candidate,
                source_hash,
                transcript_timing_hash=verified_transcript_manifest[
                    "transcriptTimingHash"
                ],
            )
    return (
        ranking,
        candidate,
        source_hash,
        verified_transcript_manifest,
        verified_speech_report,
    )


def _verify_rejection_speech_cleanliness(
    candidate: dict,
    source_hash: str,
    *,
    transcript_timing_hash: str,
) -> dict | None:
    """Verify optional feed-stop audio evidence for a human rejection.

    Historical replay rankings may predate the speech-cleanliness report. A
    missing report cannot grant production authority and therefore does not
    invalidate an explicit human-negative event. If a report is present, it
    remains fully sealed, interval-bound, and fail-closed.
    """

    report = candidate.get("speechCleanlinessReport")
    if report is None:
        return None
    if not isinstance(report, dict):
        raise ArtifactBindingError("feed-stop speech-cleanliness report is invalid")
    verified = verify_speech_cleanliness_report(
        report,
        source_hash=source_hash,
        transcript_timing_hash=transcript_timing_hash,
        speech_interval=(
            candidate.get("speech_start_time", candidate.get("start_time")),
            candidate.get("speech_end_time", candidate.get("end_time")),
        ),
        require_pass=False,
    )
    aliases = {
        "speechCleanlinessStatus": verified["status"],
        "speechCleanlinessEligible": verified["eligible"],
        "speechCleanlinessRejectionReasons": verified["rejectionReasons"],
        "speechCleanlinessReviewReasons": verified["reviewReasons"],
        "speech_cleanliness_status": verified["status"],
        "speech_cleanliness_eligible": verified["eligible"],
        "speech_cleanliness_decision_version": verified["decisionVersion"],
        "speech_cleanliness_reject_reasons": verified["rejectionReasons"],
        "speech_cleanliness_review_reasons": verified["reviewReasons"],
        "speech_cleanliness_deterministic_reasons": verified[
            "deterministicReasons"
        ],
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
    if any(candidate.get(field) != expected for field, expected in aliases.items()):
        raise ArtifactBindingError(
            "speech-cleanliness candidate aliases do not match the sealed report"
        )
    return verified


def _verify_rejection_spoken_clarity(
    candidate: dict,
    source_hash: str,
    *,
    transcript_timing_hash: str,
) -> dict | None:
    """Verify optional clarity evidence without making it rejection authority."""

    report = candidate.get("spokenClarityReport")
    if report is None:
        return None
    if not isinstance(report, dict):
        raise ArtifactBindingError("feed-stop spoken-clarity report is invalid")
    from shorts_generator.spoken_clarity import verify_spoken_clarity_report

    verified = verify_spoken_clarity_report(
        report,
        source_hash=source_hash,
        transcript_timing_hash=transcript_timing_hash,
        speech_interval=(
            candidate.get("speech_start_time", candidate.get("start_time")),
            candidate.get("speech_end_time", candidate.get("end_time")),
        ),
        require_pass=False,
    )
    counts = verified["counts"]
    opening_asr = verified["evidence"]["openingAsr"]
    aliases = {
        "spokenClarityStatus": verified["status"],
        "spokenClarityEligible": verified["eligible"],
        "spokenClarityRejectionReasons": verified["rejectionReasons"],
        "spokenClarityReviewReasons": verified["reviewReasons"],
        "spoken_clarity_decision_version": verified["decisionVersion"],
        "spoken_clarity_status": verified["status"],
        "spoken_clarity_eligible": verified["eligible"],
        "spoken_clarity_reject_reasons": verified["rejectionReasons"],
        "spoken_clarity_review_reasons": verified["reviewReasons"],
        "spoken_clarity_deterministic_reasons": verified[
            "deterministicReasons"
        ],
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
        "spoken_clarity_opening_asr_mean_confidence": opening_asr[
            "meanWordConfidence"
        ],
        "spoken_clarity_opening_asr_low_ratio": opening_asr[
            "lowConfidenceWordRatio"
        ],
        "spoken_clarity_opening_asr_token_match_ratio": opening_asr[
            "tokenMatchRatio"
        ],
    }
    if any(candidate.get(field) != expected for field, expected in aliases.items()):
        raise ArtifactBindingError(
            "spoken-clarity candidate aliases do not match the sealed report"
        )
    return verified


def candidate_from_file(
    path: str,
    rank: int | None,
    source_path: str,
) -> tuple[dict, dict, str]:
    ranking, candidate, source_hash, _, _ = _review_candidate_from_file(
        path,
        rank,
        source_path,
        require_eligible=True,
        require_replay_transcript=False,
    )
    return ranking, candidate, source_hash


def rejection_candidate_from_file(
    path: str,
    rank: int | None,
    source_path: str,
) -> tuple[dict, dict, str, dict | None]:
    ranking, candidate, source_hash, _, speech_report = _review_candidate_from_file(
        path,
        rank,
        source_path,
        require_eligible=False,
        require_replay_transcript=True,
    )
    return ranking, candidate, source_hash, speech_report


def _normalize_backfill_text(value: object) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return "".join(character for character in normalized if character.isalnum())


def _verify_backfill_transcript_provenance(
    transcript: dict,
    *,
    source_input: str,
    source_hash: str,
) -> None:
    cache = transcript.get("_cache")
    if not isinstance(cache, dict):
        raise ArtifactBindingError("raw transcript lacks verifiable cache provenance")
    cached_source_hash = str(cache.get("source_sha256") or "").strip().lower()
    if cached_source_hash:
        if cache.get("schema_version") != 3 or cached_source_hash != source_hash:
            raise ArtifactBindingError("transcript cache references another source")
        return
    video_id = _extract_youtube_video_id(source_input)
    if (
        not video_id
        or not str(cache.get("provider") or "").strip()
        or not str(cache.get("track_language") or "").strip()
        or not _youtube_caption_cache_matches(
            transcript,
            video_id,
            str(cache.get("requested_language") or "auto"),
            allow_legacy_parser=True,
        )
    ):
        raise ArtifactBindingError("raw transcript cache provenance is incompatible")


def _verify_backfill_candidate_text(
    ranking: dict,
    transcript: dict,
) -> None:
    timed_words = []
    for segment in transcript.get("segments") or []:
        for word in segment.get("words") or []:
            token = str(word.get("word") or word.get("text") or "").strip()
            if any(character.isspace() for character in token):
                raise ArtifactBindingError(
                    "replay backfill word tokens must not contain whitespace"
                )
            timed_words.append(word)
    for index, candidate in enumerate(ranking.get("candidates") or []):
        speech_start = float(
            candidate.get("speech_start_time", candidate.get("start_time"))
        )
        speech_end = float(
            candidate.get("speech_end_time", candidate.get("end_time"))
        )
        interval_text = " ".join(
            str(word.get("word") or word.get("text") or "")
            for word in timed_words
            if float(word.get("end") or 0.0) >= speech_start - 0.05
            and float(word.get("start") or 0.0) <= speech_end + 0.05
        )
        expected = _normalize_backfill_text(candidate.get("candidate_text"))
        observed = _normalize_backfill_text(interval_text)
        if not expected or expected not in observed:
            raise ArtifactBindingError(
                f"ranking candidate[{index}] text is not supported by its timed interval"
            )


def command_bind_replay_transcript(args) -> dict:
    """Create a new replay-capable ranking without inventing a human label."""
    output = Path(args.output).expanduser().resolve()
    evidence_root = Path(args.evidence_dir).expanduser().resolve()
    try:
        output.relative_to(evidence_root)
    except ValueError:
        pass
    else:
        raise ValueError(
            "--output must be outside the append-only Autoresearch evidence root"
        )

    ranking = verify_seal(read_json(args.ranking), "RankingManifest")
    if ranking.get("schemaVersion") != 1:
        raise ArtifactBindingError("unsupported RankingManifest schema")
    if ranking.get("replayTranscriptManifest") is not None:
        raise ArtifactBindingError("ranking already has a replay transcript manifest")
    source_path = Path(args.source).expanduser().resolve()
    source_hash = file_sha256(str(source_path))
    if ranking.get("sourceHash") != source_hash:
        raise ArtifactBindingError("ranking manifest is not bound to the supplied source")
    source = ranking.get("source")
    if not isinstance(source, dict) or not str(source.get("input") or "").strip():
        raise ArtifactBindingError("ranking manifest source is invalid")

    transcript_document = read_json(args.transcript)
    if transcript_document.get("artifactType") == "BudgetFriendlyReplayTranscriptManifestV2":
        transcript_manifest = verify_replay_transcript_manifest(
            transcript_document,
            source_hash=source_hash,
            require_timed_words=True,
        )
    else:
        _verify_backfill_transcript_provenance(
            transcript_document,
            source_input=str(source["input"]),
            source_hash=source_hash,
        )
        transcript_manifest = build_replay_transcript_manifest(
            transcript_document,
            source_hash,
        )
    verified_transcript = verify_replay_transcript_manifest(
        transcript_manifest,
        source_hash=source_hash,
        require_timed_words=True,
    )["transcript"]
    _verify_backfill_candidate_text(ranking, verified_transcript)

    ranking_body = {
        key: value for key, value in ranking.items() if key != "contentHash"
    }
    ranking_body["source"] = {
        **source,
        "local_path": str(source_path),
    }
    ranking_body["replayTranscriptManifest"] = transcript_manifest
    ranking_body["replayBackfillProvenance"] = {
        "method": "bind_exact_transcript_v1",
        "legacyRankingManifestHash": ranking["contentHash"],
        "humanLabelSemantics": "unknown_not_human_label",
    }
    replay_ranking = {
        **ranking_body,
        "contentHash": content_hash(ranking_body),
    }
    capture_dataset = build_replay_capture_dataset(replay_ranking)
    created = write_immutable_json(output, replay_ranking)
    return {
        "rankingPath": str(output),
        "created": created,
        "legacyRankingManifestHash": ranking["contentHash"],
        "rankingManifestHash": replay_ranking["contentHash"],
        "replayTranscriptManifestHash": transcript_manifest["contentHash"],
        "captureDatasetHash": capture_dataset["contentHash"],
        "candidateCount": len(capture_dataset["candidates"]),
        "engineSelectedCandidateCount": len(
            capture_dataset["engineSelectedCandidateHashes"]
        ),
        "engineSelectionSemantics": capture_dataset["engineSelectionSemantics"],
        "humanPositiveCount": 0,
        "approvalRequired": True,
    }


def command_approve(args) -> dict:
    evidence_root = Path(args.evidence_dir).expanduser().resolve()
    decision_output = Path(args.output).expanduser().resolve()
    try:
        decision_output.relative_to(evidence_root)
    except ValueError:
        pass
    else:
        raise ValueError(
            "--output must be outside the append-only Autoresearch evidence root"
        )
    (
        ranking,
        candidate,
        source_hash,
        replay_transcript_manifest,
        _,
    ) = _review_candidate_from_file(
        args.candidate_json,
        args.rank,
        args.source,
        require_eligible=True,
        require_replay_transcript=False,
    )
    if candidate.get("format_profile") == BF_FEED_STOP_FORMAT_V1:
        raise ArtifactBindingError(
            "bf_feed_stop_format_v1 is legacy replay-only and cannot create "
            "a new positive approval; regenerate with bf_feed_stop_format_v2"
        )
    decision = build_candidate_decision(
        candidate,
        source_hash,
        reviewer=args.reviewer,
        decided_at=args.decided_at,
        ranking_manifest_hash=ranking["contentHash"],
        notes=args.notes,
        replay_transcript=(
            replay_transcript_manifest["transcript"]
            if replay_transcript_manifest is not None
            else None
        ),
        transcript_timing_hash=(
            replay_transcript_manifest["transcriptTimingHash"]
            if replay_transcript_manifest is not None
            else None
        ),
    )
    archive_approved_candidate(
        ranking,
        decision,
        approved_rank=args.rank,
        evidence_dir=evidence_root,
    )
    write_json(args.output, decision)
    return decision


def _rejection_reason_codes(raw_values: list[str]) -> list[str]:
    reason_codes = []
    for raw_value in raw_values:
        for value in str(raw_value or "").split(","):
            normalized = value.strip()
            if normalized and normalized not in reason_codes:
                reason_codes.append(normalized)
    if not reason_codes:
        raise ValueError("at least one non-empty --reason-code is required")
    return reason_codes


PREVIEW_DURATION_TOLERANCE_MS = 100


def _nonnegative_milliseconds(value: str) -> int:
    """Parse an exact CLI millisecond value without a float round-trip."""

    normalized = str(value or "").strip()
    if not normalized or not normalized.isascii() or not normalized.isdigit():
        raise argparse.ArgumentTypeError("must be a nonnegative integer in milliseconds")
    return int(normalized)


def _probe_review_media(path: str) -> tuple[int, str]:
    """Return exact millisecond duration and canonical container for a preview."""

    media_path = Path(path).expanduser()
    if not media_path.is_file() or media_path.stat().st_size < 1:
        raise ArtifactBindingError("review preview must be a nonempty file")
    container = media_path.suffix.lower().lstrip(".")
    if not container or not container.isalnum():
        raise ArtifactBindingError(
            "review preview must have a canonical media container suffix"
        )
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration,format_name:stream=codec_type",
                "-of",
                "json",
                str(media_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout or "{}")
        format_metadata = payload.get("format")
        streams = payload.get("streams")
        duration = Decimal(str(format_metadata.get("duration")))
    except (
        FileNotFoundError,
        subprocess.CalledProcessError,
        json.JSONDecodeError,
        AttributeError,
        InvalidOperation,
    ) as error:
        raise ArtifactBindingError("review preview metadata is unverifiable") from error
    stream_types = {
        str(stream.get("codec_type") or "").strip().lower()
        for stream in (streams if isinstance(streams, list) else [])
        if isinstance(stream, dict)
    }
    if not {"audio", "video"}.issubset(stream_types):
        raise ArtifactBindingError("review preview must contain audio and video")
    if not duration.is_finite() or duration <= 0:
        raise ArtifactBindingError("review preview duration must be positive")
    duration_ms = int(
        (duration * Decimal(1000)).quantize(
            Decimal("1"),
            rounding=ROUND_HALF_UP,
        )
    )
    if duration_ms < 1:
        raise ArtifactBindingError("review preview duration must be positive")
    format_names = {
        item.strip().lower()
        for item in str(format_metadata.get("format_name") or "").split(",")
        if item.strip()
    }
    if format_names and container not in format_names:
        # ffprobe calls ISO-BMFF files "mov,mp4,..."; membership therefore
        # accepts an ordinary .mp4 while still rejecting a misleading suffix.
        raise ArtifactBindingError(
            "review preview suffix does not match its media container"
        )
    return duration_ms, container


def _preview_context_from_file(
    path: str,
    source_path: str,
) -> tuple[dict, dict, Path]:
    """Verify a ranking/source/transcript context without resolving a candidate."""

    ranking = verify_seal(read_json(path), "RankingManifest")
    source = ranking.get("source")
    if not isinstance(source, dict):
        raise ArtifactBindingError("ranking manifest source is invalid")
    declared_path_value = str(source.get("local_path") or "").strip()
    if not declared_path_value:
        raise ArtifactBindingError("ranking source.local_path is missing")
    declared_path = Path(declared_path_value).expanduser().resolve()
    supplied_path = Path(source_path).expanduser().resolve()
    if declared_path != supplied_path:
        raise ArtifactBindingError(
            "ranking source.local_path does not match the supplied source"
        )
    source_hash = file_sha256(str(declared_path))
    if ranking.get("sourceHash") != source_hash:
        raise ArtifactBindingError(
            "ranking manifest is not bound to the supplied source"
        )
    dataset = build_replay_capture_dataset(ranking)
    return ranking, dataset, declared_path


def _existing_rejection_receipt(path: Path, receipt: dict) -> dict | None:
    """Validate a prior receipt against a pure, expected receipt identity."""

    if not path.exists():
        return None
    operational_fields = {"datasetCreated", "rejectionCreated"}
    receipt_identity = {
        key: value for key, value in receipt.items() if key not in operational_fields
    }
    existing = read_json(str(path))
    if (
        set(existing) != set(receipt)
        or any(
            type(existing.get(field)) is not bool
            for field in operational_fields
        )
    ):
        raise ArtifactBindingError(
            f"immutable rejection receipt collision at {path}"
        )
    existing_identity = {
        key: value
        for key, value in existing.items()
        if key not in operational_fields
    }
    if existing_identity != receipt_identity:
        raise ArtifactBindingError(
            f"immutable rejection receipt collision at {path}"
        )
    return existing


def _write_idempotent_rejection_receipt(path: Path, receipt: dict) -> dict:
    """Keep a stable operator receipt across an identical archive retry."""

    existing = _existing_rejection_receipt(path, receipt)
    if existing is not None:
        return existing
    try:
        write_immutable_json(path, receipt)
    except ArtifactBindingError:
        existing = _existing_rejection_receipt(path, receipt)
        if existing is not None:
            return existing
        raise
    return receipt


_PREVIEW_RECEIPT_OPERATIONAL_FIELDS = {
    "datasetCreated",
    "rejectionCreated",
    "reviewMediaCreated",
}


def _existing_preview_rejection_receipt(
    path: Path,
    receipt: dict,
) -> dict | None:
    """Fail before archive mutation when a preview receipt path collides."""

    if not path.exists():
        return None
    identity = {
        key: value
        for key, value in receipt.items()
        if key not in _PREVIEW_RECEIPT_OPERATIONAL_FIELDS
    }
    existing = read_json(str(path))
    if (
        set(existing) != set(receipt)
        or any(
            type(existing.get(field)) is not bool
            for field in _PREVIEW_RECEIPT_OPERATIONAL_FIELDS
        )
    ):
        raise ArtifactBindingError(
            f"immutable preview rejection receipt collision at {path}"
        )
    existing_identity = {
        key: value
        for key, value in existing.items()
        if key not in _PREVIEW_RECEIPT_OPERATIONAL_FIELDS
    }
    if existing_identity != identity:
        raise ArtifactBindingError(
            f"immutable preview rejection receipt collision at {path}"
        )
    return existing


def _write_idempotent_preview_rejection_receipt(
    path: Path,
    receipt: dict,
) -> dict:
    existing = _existing_preview_rejection_receipt(path, receipt)
    if existing is not None:
        return existing
    try:
        write_immutable_json(path, receipt)
    except ArtifactBindingError:
        existing = _existing_preview_rejection_receipt(path, receipt)
        if existing is not None:
            return existing
        raise
    return receipt


def _expected_preview_rejection_receipt(
    dataset: dict,
    *,
    preview_path: Path,
    preview_duration_ms: int,
    preview_container: str,
    interval_start_ms: int,
    interval_end_ms: int,
    reviewer: str,
    decided_at: str,
    reason_codes: list[str],
    notes: str,
    preview_source_provenance_report: dict,
    evidence_root: Path,
) -> dict:
    """Build a pure receipt identity before any durable archive write."""

    media_hash = file_sha256(str(preview_path))
    media_byte_length = preview_path.stat().st_size
    rejection = build_replay_human_preview_rejection(
        dataset,
        interval_start_ms=interval_start_ms,
        interval_end_ms=interval_end_ms,
        review_media_hash=media_hash,
        review_media_byte_length=media_byte_length,
        review_media_duration_ms=preview_duration_ms,
        review_media_container=preview_container,
        reviewer=reviewer,
        decided_at=decided_at,
        reason_codes=reason_codes,
        preview_source_provenance_report=preview_source_provenance_report,
        notes=notes,
    )
    ranking_hash = dataset["rankingManifestHash"]
    archived_media = (
        evidence_root
        / "review-media"
        / f"{media_hash}.{preview_container}"
    )
    return {
        "schemaVersion": 1,
        "artifactType": HUMAN_PREVIEW_REJECTION_RECEIPT_TYPE,
        "datasetHash": dataset["contentHash"],
        "rejectionHash": rejection["contentHash"],
        "reviewMediaHash": media_hash,
        "previewSourceProvenanceHash": preview_source_provenance_report[
            "contentHash"
        ],
        "datasetPath": str(
            (evidence_root / "datasets" / f"{ranking_hash}.json").resolve()
        ),
        "rejectionPath": str(
            (
                evidence_root
                / "negative-preview-labels"
                / ranking_hash
                / f"{rejection['contentHash']}.json"
            ).resolve()
        ),
        "reviewMediaPath": str(archived_media.resolve()),
        "datasetCreated": False,
        "rejectionCreated": False,
        "reviewMediaCreated": False,
    }


def _expected_rejection_receipt(
    ranking: dict,
    candidate: dict,
    *,
    reviewer: str,
    decided_at: str,
    reason_codes: list[str],
    rejected_rank: int,
    notes: str,
    evidence_root: Path,
    speech_report: dict | None,
) -> dict:
    """Build the archive receipt identity without touching durable storage."""

    dataset = build_replay_capture_dataset(ranking)
    rejection = build_replay_human_rejection(
        dataset,
        candidate["candidate_hash"],
        reviewer=reviewer,
        decided_at=decided_at,
        reason_codes=reason_codes,
        rejected_rank=rejected_rank,
        notes=notes,
        speech_cleanliness_report=speech_report,
    )
    ranking_hash = dataset["rankingManifestHash"]
    return {
        "schemaVersion": 1,
        "artifactType": HUMAN_REJECTION_RECEIPT_TYPE,
        "datasetHash": dataset["contentHash"],
        "rejectionHash": rejection["contentHash"],
        "datasetPath": str(
            (evidence_root / "datasets" / f"{ranking_hash}.json").resolve()
        ),
        "rejectionPath": str(
            (
                evidence_root
                / "negative-labels"
                / ranking_hash
                / f"{rejection['contentHash']}.json"
            ).resolve()
        ),
        # These are operation results, not identity. Their boolean shape is
        # still validated on a pre-existing receipt.
        "datasetCreated": False,
        "rejectionCreated": False,
    }


def command_reject(args) -> dict:
    """Archive an explicit negative label without creating production authority."""

    evidence_root = Path(args.evidence_dir).expanduser().resolve()
    receipt_output = Path(args.output).expanduser().resolve()
    try:
        receipt_output.relative_to(evidence_root)
    except ValueError:
        pass
    else:
        raise ValueError(
            "--output must be outside the append-only Autoresearch evidence root"
        )
    ranking, candidate, _, speech_report = rejection_candidate_from_file(
        args.candidate_json,
        args.rank,
        args.source,
    )
    reason_codes = _rejection_reason_codes(args.reason_code)
    expected_receipt = _expected_rejection_receipt(
        ranking,
        candidate,
        reviewer=args.reviewer,
        decided_at=args.decided_at,
        reason_codes=reason_codes,
        rejected_rank=args.rank,
        notes=args.notes,
        evidence_root=evidence_root,
        speech_report=speech_report,
    )
    # A collision is rejected before the append-only archive can create a
    # dataset or negative label. An identical prior receipt is safe to retry.
    _existing_rejection_receipt(receipt_output, expected_receipt)
    receipt = archive_rejected_candidate(
        ranking,
        candidate["candidate_hash"],
        reviewer=args.reviewer,
        decided_at=args.decided_at,
        reason_codes=reason_codes,
        rejected_rank=args.rank,
        notes=args.notes,
        evidence_dir=evidence_root,
        speech_cleanliness_report=speech_report,
    )
    return _write_idempotent_rejection_receipt(receipt_output, receipt)


def command_reject_preview(args) -> dict:
    """Archive the exact source preview the operator rejected."""

    evidence_root = Path(args.evidence_dir).expanduser().resolve()
    receipt_output = Path(args.output).expanduser().resolve()
    try:
        receipt_output.relative_to(evidence_root)
    except ValueError:
        pass
    else:
        raise ValueError(
            "--output must be outside the append-only Autoresearch evidence root"
        )
    ranking, dataset, source_path = _preview_context_from_file(
        args.ranking,
        args.source,
    )
    preview_path = Path(args.preview).expanduser().resolve()
    preview_duration_ms, preview_container = _probe_review_media(
        str(preview_path)
    )
    interval_duration_ms = args.end_ms - args.start_ms
    if interval_duration_ms < 1:
        raise ArtifactBindingError(
            "preview source interval must have positive duration"
        )
    if (
        abs(preview_duration_ms - interval_duration_ms)
        > PREVIEW_DURATION_TOLERANCE_MS
    ):
        raise ArtifactBindingError(
            "review preview duration does not match the exact source interval"
        )
    reason_codes = _rejection_reason_codes(args.reason_code)
    preview_hash = file_sha256(str(preview_path))
    preview_source_provenance_report = analyze_preview_source_provenance(
        str(source_path),
        str(preview_path),
        str(dataset["sourceHash"]),
        preview_hash,
        args.start_ms,
        args.end_ms,
    )
    expected_receipt = _expected_preview_rejection_receipt(
        dataset,
        preview_path=preview_path,
        preview_duration_ms=preview_duration_ms,
        preview_container=preview_container,
        interval_start_ms=args.start_ms,
        interval_end_ms=args.end_ms,
        reviewer=args.reviewer,
        decided_at=args.decided_at,
        reason_codes=reason_codes,
        notes=args.notes,
        preview_source_provenance_report=preview_source_provenance_report,
        evidence_root=evidence_root,
    )
    # Validate an existing operator receipt before dataset/media writes. An
    # identical retry is safe and still lets the append-only archive verify its
    # own content-addressed objects.
    _existing_preview_rejection_receipt(receipt_output, expected_receipt)
    receipt = archive_rejected_preview(
        ranking,
        interval_start_ms=args.start_ms,
        interval_end_ms=args.end_ms,
        review_media_path=preview_path,
        review_media_duration_ms=preview_duration_ms,
        review_media_container=preview_container,
        reviewer=args.reviewer,
        decided_at=args.decided_at,
        reason_codes=reason_codes,
        preview_source_provenance_report=preview_source_provenance_report,
        evidence_dir=evidence_root,
        notes=args.notes,
    )
    return _write_idempotent_preview_rejection_receipt(
        receipt_output,
        receipt,
    )


def command_experiment(args) -> dict:
    decision = read_json(args.candidate_decision)
    candidate = decision["candidate"]
    duration = float(candidate["end_time"]) - float(candidate["start_time"])
    manifest = build_experiment_manifest(
        experiment_id=args.experiment_id,
        cohort_id=args.cohort,
        treatment_id=args.treatment,
        candidate_hash=decision["candidateHash"],
        hypothesis=args.hypothesis,
        primary_variable=args.primary_variable,
        pillar=args.pillar,
        duration_seconds=duration,
        declared_at=args.declared_at,
        decision_due_at=args.decision_due_at,
        speaker_id=args.speaker_id,
        source_popularity_bucket=args.source_popularity_bucket,
    )
    write_json(args.output, manifest)
    return manifest


def command_render(args) -> dict:
    telemetry = PerformanceTelemetry(
        metadata={"workflow": "render-approved", "requestedCount": 1}
    )
    try:
        with telemetry.stage("production.pipeline", requestedCount=1):
            result = render_approved_candidate(
                args.source,
                read_json(args.transcript),
                read_json(args.candidate_decision),
                read_json(args.experiment),
                args.output_dir,
                telemetry=telemetry,
            )
    except BaseException:
        finish_performance_report(telemetry)
        raise
    result["performance"] = finish_performance_report(telemetry)
    output = args.output or str(Path(args.output_dir) / "production-bundle.json")
    write_json(output, result)
    return {"bundlePath": str(Path(output).resolve()), **result}


def command_render_batch(args) -> dict:
    """Render multiple reviewed candidates in one bounded production batch."""
    decisions = [read_json(path) for path in args.candidate_decision]
    experiments = [read_json(path) for path in args.experiment]
    telemetry = PerformanceTelemetry(
        metadata={
            "workflow": "render-approved-batch",
            "requestedCount": len(decisions),
            "maxWorkers": args.max_workers,
        }
    )
    try:
        with telemetry.stage(
            "production.pipeline",
            requestedCount=len(decisions),
        ):
            result = render_approved_candidates(
                args.source,
                read_json(args.transcript),
                decisions,
                experiments,
                args.output_dir,
                max_workers=args.max_workers,
                telemetry=telemetry,
            )
    except BaseException:
        finish_performance_report(telemetry)
        raise
    result["performance"] = finish_performance_report(telemetry)
    for outcome in result["results"]:
        if outcome["status"] != "succeeded":
            continue
        bundle_path = Path(args.output_dir) / (
            f"production-bundle-{int(outcome['index']) + 1:02d}.json"
        )
        write_json(str(bundle_path), outcome["result"])
        outcome["bundlePath"] = str(bundle_path.resolve())

    output = args.output or str(Path(args.output_dir) / "production-batch.json")
    write_json(output, result)
    return {"batchPath": str(Path(output).resolve()), **result}


def command_originality(args) -> dict:
    decision = verify_seal(
        read_json(args.candidate_decision),
        "CandidateDecision",
    )
    if candidate_hash(decision["candidate"], decision["sourceHash"]) != decision["candidateHash"]:
        raise ArtifactBindingError("candidate decision hash is stale")
    recent = read_json(args.recent_publications).get("publications", [])
    report = evaluate_originality(
        decision["candidate"],
        decision["candidateHash"],
        decision["sourceHash"],
        recent,
        candidate_decision_hash=decision["contentHash"],
    )
    write_json(args.output, report)
    return report


def command_rights(args) -> dict:
    decision = read_json(args.candidate_decision)
    report = build_rights_manifest(
        decision["sourceHash"],
        status=args.status,
        owner=args.owner,
        evidence_reference=args.evidence_reference,
        allowed_platforms=args.platform,
        music_license_reference=args.music_license,
        font_license_references=args.font_license,
        attribution_text=args.attribution_text,
    )
    write_json(args.output, report)
    return report


def command_publish_plan(args) -> dict:
    bundle = read_json(args.production_bundle)
    metadata = read_json(args.metadata)
    manifest = build_publish_manifest(
        bundle["renderManifest"],
        bundle["creativeQaReport"],
        read_json(args.rights),
        bundle["experimentManifest"],
        bundle["candidateDecision"],
        metadata,
        originality_report=read_json(args.originality),
        audio_qa_report=bundle["audioQaReport"],
        privacy_status=args.privacy,
        related_video_id=args.related_video_id,
        related_video_waiver_reason=args.related_video_waiver,
    )
    write_json(args.output, manifest)
    return manifest


def command_publish(args) -> dict:
    from shorts_generator.youtube_uploader import (
        YouTubeMetadata,
        find_video_by_upload_marker,
        get_authenticated_service,
        upload_video,
        verify_authenticated_channel,
    )

    manifest = verify_seal(read_json(args.publish_manifest), "PublishManifest")
    render = verify_seal(read_json(args.render_manifest), "RenderManifest")
    if manifest.get("renderManifestHash") != render.get("contentHash"):
        raise ValueError("publish manifest references another render")
    if manifest.get("renderOutputHash") != render.get("outputHash"):
        raise ValueError("publish manifest output hash is stale")
    if file_sha256(render["outputPath"]) != render["outputHash"]:
        raise ValueError("render file changed after publish approval")
    if manifest.get("privacyStatus") == "public" and not args.confirm_public:
        raise ValueError("public release requires --confirm-public")
    idempotency_key = publish_idempotency_key(manifest, args.expected_channel_id)
    upload_marker = publish_upload_marker(idempotency_key)
    youtube = get_authenticated_service(args.client_secrets, args.token_file)
    channel = verify_authenticated_channel(
        youtube,
        expected_channel_id=args.expected_channel_id,
    )

    def upload(path, metadata, privacy, contains_synthetic_media):
        return upload_video(
            youtube,
            path,
            YouTubeMetadata(
                title=str(metadata["title"]),
                description=str(metadata["description"]),
                tags=tuple(metadata.get("tags") or ("shorts",)),
                category_id=str(metadata.get("categoryId") or "22"),
            ),
            privacy_status=privacy,
            contains_synthetic_media=contains_synthetic_media,
            upload_marker=upload_marker,
        )

    def reconcile(pending):
        return find_video_by_upload_marker(
            youtube,
            channel["id"],
            pending["uploadMarker"],
        )

    receipt = publish_reviewed_short(
        manifest,
        render,
        PublishReceiptStore(args.receipt_store),
        expected_channel_id=args.expected_channel_id,
        authenticated_channel=channel,
        upload=upload,
        public_release_approved=args.confirm_public,
        reconcile=reconcile,
        upload_marker=upload_marker,
    )
    return receipt


def command_release(args) -> dict:
    if not args.confirm_public:
        raise ValueError("public release requires --confirm-public")
    from shorts_generator.youtube_uploader import (
        get_authenticated_service,
        get_video_status,
        update_video_privacy,
        verify_authenticated_channel,
    )

    youtube = get_authenticated_service(args.client_secrets, args.token_file)
    channel = verify_authenticated_channel(
        youtube,
        expected_channel_id=args.expected_channel_id,
    )

    def inspect(video_id):
        return get_video_status(youtube, video_id)

    def update(video_id, privacy_status):
        return update_video_privacy(youtube, video_id, privacy_status)

    return release_uploaded_short(
        PublishReceiptStore(args.receipt_store),
        youtube_video_id=args.youtube_video_id,
        expected_channel_id=args.expected_channel_id,
        authenticated_channel=channel,
        update_privacy=update,
        inspect_video=inspect,
        public_release_approved=True,
    )


def command_snapshot(args) -> dict:
    metrics = read_json(args.metrics)
    experiment = read_json(args.experiment)
    snapshot = build_analytics_snapshot(
        video_id=args.video_id,
        published_at=args.published_at,
        observed_at=args.observed_at,
        metrics=metrics,
        source=args.source,
        experiment_id=experiment["experimentId"],
        cohort_id=experiment["cohortId"],
        treatment_id=experiment["treatmentId"],
        pillar=experiment["pillar"],
        duration_seconds=args.duration_seconds,
    )
    GrowthAnalyticsStore(args.store).upsert(snapshot)
    return snapshot


def command_evaluate(args) -> dict:
    report = evaluate_cohorts(
        GrowthAnalyticsStore(args.store).list(args.gate_hours),
        gate_hours=args.gate_hours,
        minimum_per_cohort=args.minimum_per_cohort,
    )
    write_json(args.output, report)
    return report


def command_import_csv(args) -> dict:
    value = {"schemaVersion": 1, "rows": import_studio_csv(args.csv)}
    if args.output:
        write_json(args.output, value)
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    bind_replay = sub.add_parser("bind-replay-transcript")
    bind_replay.add_argument("--ranking", required=True)
    bind_replay.add_argument("--source", required=True)
    bind_replay.add_argument("--transcript", required=True)
    bind_replay.add_argument(
        "--evidence-dir",
        default=LOCAL_AUTORESEARCH_EVIDENCE_DIR,
        help="Append-only evidence root, which may not contain this review artifact.",
    )
    bind_replay.add_argument("--output", required=True)
    bind_replay.set_defaults(handler=command_bind_replay_transcript)

    approve = sub.add_parser("approve-candidate")
    approve.add_argument("--candidate-json", required=True)
    approve.add_argument("--rank", type=int)
    approve.add_argument("--source", required=True)
    approve.add_argument("--reviewer", required=True)
    approve.add_argument("--decided-at", required=True)
    approve.add_argument("--notes", default="")
    approve.add_argument(
        "--evidence-dir",
        default=LOCAL_AUTORESEARCH_EVIDENCE_DIR,
        help=(
            "Durable append-only Autoresearch approval evidence root "
            "(separate from output and caches)."
        ),
    )
    approve.add_argument("--output", required=True)
    approve.set_defaults(handler=command_approve)

    reject = sub.add_parser("reject-candidate")
    reject.add_argument("--candidate-json", required=True)
    reject.add_argument("--rank", type=int, required=True)
    reject.add_argument("--source", required=True)
    reject.add_argument("--reviewer", required=True)
    reject.add_argument("--decided-at", required=True)
    reject.add_argument(
        "--reason-code",
        action="append",
        required=True,
        help=(
            "Canonical human rejection code. Repeat the flag or supply a "
            "comma-separated list."
        ),
    )
    reject.add_argument("--notes", default="")
    reject.add_argument(
        "--evidence-dir",
        default=LOCAL_AUTORESEARCH_EVIDENCE_DIR,
        help=(
            "Durable append-only Autoresearch rejection evidence root "
            "(separate from output and caches)."
        ),
    )
    reject.add_argument("--output", required=True)
    reject.set_defaults(handler=command_reject)

    reject_preview = sub.add_parser("reject-preview")
    reject_preview.add_argument("--ranking", required=True)
    reject_preview.add_argument("--source", required=True)
    reject_preview.add_argument("--preview", required=True)
    reject_preview.add_argument(
        "--start-ms",
        type=_nonnegative_milliseconds,
        required=True,
        help="Exact source interval start as a nonnegative integer millisecond.",
    )
    reject_preview.add_argument(
        "--end-ms",
        type=_nonnegative_milliseconds,
        required=True,
        help="Exact source interval end as a positive integer millisecond.",
    )
    reject_preview.add_argument("--reviewer", required=True)
    reject_preview.add_argument("--decided-at", required=True)
    reject_preview.add_argument(
        "--reason-code",
        action="append",
        required=True,
        help=(
            "Canonical human rejection code. Repeat the flag or supply a "
            "comma-separated list."
        ),
    )
    reject_preview.add_argument("--notes", default="")
    reject_preview.add_argument(
        "--evidence-dir",
        default=LOCAL_AUTORESEARCH_EVIDENCE_DIR,
        help=(
            "Durable append-only Autoresearch preview-rejection evidence "
            "root (separate from output and caches)."
        ),
    )
    reject_preview.add_argument("--output", required=True)
    reject_preview.set_defaults(handler=command_reject_preview)

    experiment = sub.add_parser("declare-experiment")
    experiment.add_argument("--candidate-decision", required=True)
    experiment.add_argument("--experiment-id", required=True)
    experiment.add_argument("--cohort", choices=("contradiction", "concrete_rule", "identity_stakes", "legacy_control"), required=True)
    experiment.add_argument("--treatment", required=True)
    experiment.add_argument("--hypothesis", required=True)
    experiment.add_argument("--primary-variable", default="hook_family")
    experiment.add_argument("--pillar", required=True)
    experiment.add_argument("--declared-at", required=True)
    experiment.add_argument("--decision-due-at", required=True)
    experiment.add_argument("--speaker-id")
    experiment.add_argument("--source-popularity-bucket")
    experiment.add_argument("--output", required=True)
    experiment.set_defaults(handler=command_experiment)

    render = sub.add_parser("render-approved")
    render.add_argument("--source", required=True)
    render.add_argument("--transcript", required=True)
    render.add_argument("--candidate-decision", required=True)
    render.add_argument("--experiment", required=True)
    render.add_argument("--output-dir", required=True)
    render.add_argument("--output")
    render.set_defaults(handler=command_render)

    render_batch = sub.add_parser("render-approved-batch")
    render_batch.add_argument("--source", required=True)
    render_batch.add_argument("--transcript", required=True)
    render_batch.add_argument(
        "--candidate-decision",
        action="append",
        required=True,
        help="Repeat once per approved Short, in desired output order.",
    )
    render_batch.add_argument(
        "--experiment",
        action="append",
        required=True,
        help="Repeat in the same order as --candidate-decision.",
    )
    render_batch.add_argument("--output-dir", required=True)
    render_batch.add_argument(
        "--max-workers",
        type=int,
        default=LOCAL_RENDER_WORKERS,
    )
    render_batch.add_argument("--output")
    render_batch.set_defaults(handler=command_render_batch)

    originality = sub.add_parser("originality")
    originality.add_argument("--candidate-decision", required=True)
    originality.add_argument("--recent-publications", required=True)
    originality.add_argument("--output", required=True)
    originality.set_defaults(handler=command_originality)

    rights = sub.add_parser("rights")
    rights.add_argument("--candidate-decision", required=True)
    rights.add_argument("--status", choices=("owned", "licensed", "permission_granted"), required=True)
    rights.add_argument("--owner", required=True)
    rights.add_argument("--evidence-reference", required=True)
    rights.add_argument("--platform", action="append", default=["youtube"])
    rights.add_argument("--music-license", required=True)
    rights.add_argument("--font-license", action="append", required=True)
    rights.add_argument("--attribution-text", required=True)
    rights.add_argument("--output", required=True)
    rights.set_defaults(handler=command_rights)

    plan = sub.add_parser("publish-plan")
    plan.add_argument("--production-bundle", required=True)
    plan.add_argument("--rights", required=True)
    plan.add_argument("--originality", required=True)
    plan.add_argument("--metadata", required=True)
    plan.add_argument("--privacy", choices=("private", "unlisted", "public"), default="private")
    plan.add_argument("--related-video-id")
    plan.add_argument("--related-video-waiver")
    plan.add_argument("--output", required=True)
    plan.set_defaults(handler=command_publish_plan)

    publish = sub.add_parser("publish")
    publish.add_argument("--publish-manifest", required=True)
    publish.add_argument("--render-manifest", required=True)
    publish.add_argument("--receipt-store", required=True)
    publish.add_argument("--expected-channel-id", required=True)
    publish.add_argument("--client-secrets")
    publish.add_argument("--token-file")
    publish.add_argument("--confirm-public", action="store_true")
    publish.set_defaults(handler=command_publish)

    release = sub.add_parser("release")
    release.add_argument("--youtube-video-id", required=True)
    release.add_argument("--receipt-store", required=True)
    release.add_argument("--expected-channel-id", required=True)
    release.add_argument("--client-secrets")
    release.add_argument("--token-file")
    release.add_argument("--confirm-public", action="store_true")
    release.set_defaults(handler=command_release)

    snapshot = sub.add_parser("snapshot")
    snapshot.add_argument("--video-id", required=True)
    snapshot.add_argument("--published-at", required=True)
    snapshot.add_argument("--observed-at", required=True)
    snapshot.add_argument("--metrics", required=True)
    snapshot.add_argument("--source", choices=("youtube_analytics_api", "studio_csv", "manual"), required=True)
    snapshot.add_argument("--experiment", required=True)
    snapshot.add_argument("--duration-seconds", type=float, required=True)
    snapshot.add_argument("--store", required=True)
    snapshot.set_defaults(handler=command_snapshot)

    evaluate = sub.add_parser("evaluate")
    evaluate.add_argument("--store", required=True)
    evaluate.add_argument("--gate-hours", type=int, choices=(24, 72, 168, 672), default=168)
    evaluate.add_argument("--minimum-per-cohort", type=int, default=3)
    evaluate.add_argument("--output", required=True)
    evaluate.set_defaults(handler=command_evaluate)

    csv_parser = sub.add_parser("import-studio-csv")
    csv_parser.add_argument("--csv", required=True)
    csv_parser.add_argument("--output")
    csv_parser.set_defaults(handler=command_import_csv)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = args.handler(args)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=2))
        return 1
    print(json.dumps({"ok": True, "result": result}, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
