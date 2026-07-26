"""End-to-end orchestrator.

Two modes:
  * mode="api"   (default) — MuAPI does download / transcribe / LLM / autocrop.
                              Fast, no local deps, pay-per-call.
  * mode="local"            — yt-dlp + faster-whisper + OpenAI or Gemini + ffmpeg/opencv.
                              Self-hosted, LLM_PROVIDER selects OpenAI or Gemini.
"""
import json
import math
import os
import tempfile
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .artifact_contracts import (
    VOLATILE_CANDIDATE_FIELDS,
    candidate_hash,
    content_hash,
    file_sha256,
)
from .clipper import crop_highlights
from .composite import plan_educational_composite
from .downloader import download_youtube
from .highlights import (
    IncompleteHighlightBatchError,
    call_muapi_llm,
    get_highlights,
)
from .performance import PerformanceTelemetry
from .editorial_qa import evaluate_editorial_render
from .gaming_context import enrich_gaming_context
from .ranker import eligible_highlights, rank_highlights, select_diverse_highlights
from .profiles import (
    BF_EDITORIAL_INSET_V1,
    BF_EDITORIAL_INSET_V2,
    BF_WINNER_LAYOUT_V1,
    BF_WINNER_PACKAGING_V1,
    motivational_music_profile_for_candidate,
    profile_manifest_metadata,
    render_settings_for_content,
    resolve_profile_bundle,
)
from .semantic_closure import resolve_semantic_endpoints
from .transcriber import transcribe


AUTO_CLIP_SECONDS = 360.0
AUTO_CLIP_MAX = 8


def _timed(telemetry: Optional[PerformanceTelemetry], name: str, **attributes):
    """Return a no-op context when telemetry is not supplied by the caller."""
    if telemetry is None:
        return nullcontext()
    return telemetry.stage(name, **attributes)


def _persist_performance_report(telemetry: PerformanceTelemetry) -> Optional[str]:
    """Persist telemetry without allowing diagnostics to change run semantics."""
    from .config import LOCAL_PERFORMANCE_REPORT_DIR

    path = os.path.join(
        LOCAL_PERFORMANCE_REPORT_DIR,
        f"{telemetry.run_id}.json",
    )
    try:
        return str(telemetry.write_report(path))
    except (OSError, TypeError, ValueError, RuntimeError) as error:
        print(
            f"[performance] could not write report: {error}",
            flush=True,
        )
        return None


def build_editorial_render_evidence(short: Dict) -> Dict:
    """Build the immutable renderer/QA subset available immediately after encode."""
    payload = {
        "schemaVersion": 1,
        "artifactType": "RenderManifestEvidence",
        "formatProfile": short.get("format_profile"),
        "selectionProfile": short.get("selection_profile"),
        "renderProfile": short.get("render_profile"),
        "layout": short.get("layout_profile"),
        "grade": short.get("grade_profile"),
        "captionStyle": short.get("typography_profile"),
        "timeline": {
            "firstVisibleTextSeconds": short.get("first_visible_text_seconds"),
            "semanticEndSeconds": short.get("semantic_end_seconds"),
            "events": short.get("render_timeline_events") or [],
        },
        "typography": {
            "maxHeroScale": short.get("max_hero_scale"),
            "typePlanSummary": short.get("type_plan_summary") or {},
        },
        "cuts": {
            "sourceCutCount": int(short.get("source_cut_count") or 0),
            "sourceCutLimit": int(short.get("effective_source_cut_limit") or 2),
            "semanticCompletionSourceCutException": bool(
                short.get("semantic_completion_source_cut_exception")
            ),
            "artificialCutCount": int(short.get("artificial_cut_count") or 0),
        },
        "brandTail": {
            "profile": short.get("brand_tail_profile"),
            "mark": "BF.",
            "platform": "youtube",
            "durationSeconds": short.get("brand_tail_seconds"),
            "startSeconds": short.get("brand_tail_start_seconds"),
            "clearanceSeconds": short.get("brand_tail_clearance_seconds"),
            "naturalReactionSeconds": short.get("natural_tail_seconds"),
            "crossfadeSeconds": short.get("transition_tail_seconds"),
            "visualCrossfadeSeconds": short.get("transition_tail_seconds"),
            "audioFadeSeconds": short.get("audio_transition_tail_seconds"),
            "speechAudioEndTime": short.get("speech_audio_end_time"),
            "semanticSourceMarginSeconds": short.get(
                "semantic_source_margin_seconds"
            ),
            "musicReleaseSeconds": short.get("music_release_tail_seconds"),
            "freezeHoldSeconds": short.get("freeze_hold_seconds"),
            "sourceContentEndTime": short.get("source_content_end_time"),
            "nextSpokenWordStart": short.get("next_spoken_word_start"),
            "nextSpeechSafetySeconds": short.get("next_speech_safety_seconds"),
            "acousticSpeechEndTime": short.get("acoustic_speech_end_time"),
            "transcriptNextSpokenWordStart": short.get(
                "transcript_next_spoken_word_start"
            ),
            "acousticBoundarySource": short.get("acoustic_boundary_source"),
            "verifiedAcousticSpeechEndTime": short.get(
                "verified_acoustic_speech_end_time"
            ),
            "verifiedNextSpokenWordStart": short.get(
                "verified_next_spoken_word_start"
            ),
            "verifiedNextSpeechSafetySeconds": short.get(
                "verified_next_speech_safety_seconds"
            ),
            "verifiedAcousticBoundaryEvidence": short.get(
                "verified_acoustic_boundary_evidence"
            ),
            "verifiedVisualSafeEndTime": short.get(
                "verified_visual_safe_end_time"
            ),
            "verifiedVisualBoundaryEvidence": short.get(
                "verified_visual_boundary_evidence"
            ),
            "visualSafeEndGuardPassed": (
                bool(short.get("visual_safe_end_guard_passed"))
                if short.get("verified_visual_safe_end_time") is not None
                else None
            ),
            "sourceSpeechLeakGuardPassed": bool(
                short.get("source_speech_leak_guard_passed")
            ),
            "semanticClosureDecisionVersion": short.get(
                "semantic_closure_decision_version"
            ),
            "semanticClosureStatus": short.get(
                "semantic_closure_status"
            ),
            "semanticClosureSpeechEndTime": short.get(
                "semantic_closure_speech_end_time"
            ),
            "captionsSourceEndTime": short.get(
                "captions_source_end_time"
            ),
            "plannedNaturalTailEndTime": short.get(
                "planned_natural_tail_end_time",
                short.get("natural_tail_end_time"),
            ),
        },
    }
    return {**payload, "contentHash": content_hash(payload)}


def build_ranking_manifest(
    source_input: str,
    source_path: str,
    content_type: str,
    ranked: List[Dict],
    shorts: List[Dict],
    profiles: Optional[Dict] = None,
    source_hash: Optional[str] = None,
) -> Dict:
    """Build a provenance-safe record of every ranking and render outcome."""
    normalized_source_hash = str(source_hash or "").strip().lower().removeprefix("sha256:")
    if (
        len(normalized_source_hash) != 64
        or any(char not in "0123456789abcdef" for char in normalized_source_hash)
        or normalized_source_hash == "0" * 64
    ):
        raise ValueError("source_hash must be a non-placeholder sha256 hash")
    outputs_by_rank = {
        int(item.get("output_rank", index)): {
            "clip_url": item.get("clip_url"),
            "render_error": item.get("error"),
        }
        for index, item in enumerate(shorts, start=1)
    }
    candidates = []
    for item in ranked:
        record = dict(item)
        output_rank = record.get("output_rank")
        if output_rank is not None:
            record.update(outputs_by_rank.get(int(output_rank), {}))
        if (
            str(
                record.get("hookGateVersion")
                or record.get("hook_gate_version")
                or ""
            ).strip()
            == "hook-gate-v3.0.0"
        ):
            from .hook_gate_v3 import build_hook_gate_v3_report

            record["hookGateReport"] = build_hook_gate_v3_report(
                record,
                render_settings=record,
                experiment={
                    "experimentId": record.get("experiment_id"),
                    "cohortId": record.get("experiment_cohort"),
                    "changedAxes": record.get("changedAxes") or [],
                },
            )
        candidates.append(record)
    payload = {
        "schemaVersion": 1,
        "artifactType": "RankingManifest",
        "sourceHash": normalized_source_hash,
        "source": {
            "input": source_input,
            "local_path": source_path,
        },
        "content_type": content_type,
        "candidates": candidates,
        "selected_outputs": shorts,
    }
    if profiles is not None:
        payload["profiles"] = profile_manifest_metadata(profiles)
    return {**payload, "contentHash": content_hash(payload)}


def write_local_ranking_manifest(payload: Dict, output_dir: str) -> str:
    os.makedirs(output_dir, exist_ok=True)
    path = os.path.join(output_dir, "ranking.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=True, default=str)
    return path


def _planned_local_batch_outputs(shorts: List[Dict], output_dir: str) -> List[Dict]:
    """Return result records bound to their final paths before publication.

    Rendering and QA operate on files in a private staging directory.  The
    final paths must nevertheless be present in ``ranking.json``, so build a
    publication view without moving anything yet.  Creative QA reports contain
    the inspected path as metadata; re-seal that report after rebinding it to
    the final artifact path.
    """
    planned = []
    for index, short in enumerate(shorts, start=1):
        final_path = Path(output_dir) / f"short_{index:02d}.mp4"
        item = {**short, "clip_url": str(final_path)}
        qa_report = item.get("editorial_qa_report")
        if isinstance(qa_report, dict):
            rebound_report = dict(qa_report)
            rebound_report["videoPath"] = str(final_path.resolve())
            rebound_report["contentHash"] = content_hash(rebound_report)
            item["editorial_qa_report"] = rebound_report
        planned.append(item)
    return planned


def _promote_staged_local_batch(
    staged_shorts: List[Dict],
    final_shorts: List[Dict],
    staged_manifest_path: str,
    output_dir: str,
) -> str:
    """Publish one verified local batch with rollback on promotion failure.

    All sources live below a temporary directory inside ``output_dir``.  That
    keeps every ``os.replace`` on one filesystem.  Existing public artifacts
    are first moved into the same staging directory and restored if any later
    replacement fails, preventing a failed batch from leaving mixed old/new
    outputs behind.
    """
    if len(staged_shorts) != len(final_shorts):
        raise RuntimeError("staged and final render batches have different sizes")

    output_root = Path(output_dir)
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_source = Path(staged_manifest_path)
    staging_root = manifest_source.parent.resolve()
    manifest_destination = output_root / "ranking.json"
    publications = []
    for staged, final in zip(staged_shorts, final_shorts):
        staged_path = Path(str(staged.get("clip_url") or ""))
        final_path = Path(str(final.get("clip_url") or ""))
        try:
            staged_path.resolve().relative_to(staging_root)
        except (OSError, ValueError) as error:
            raise RuntimeError(
                f"render artifact escaped batch staging directory: {staged_path}"
            ) from error
        if not staged_path.is_file() or staged_path.stat().st_size <= 0:
            raise RuntimeError(f"staged render is missing or empty: {staged_path}")
        publications.append((staged_path, final_path))

    try:
        manifest_source.resolve().relative_to(staging_root)
    except (OSError, ValueError) as error:
        raise RuntimeError(
            f"ranking manifest escaped batch staging directory: {manifest_source}"
        ) from error
    if not manifest_source.is_file() or manifest_source.stat().st_size <= 0:
        raise RuntimeError("staged ranking manifest is missing or empty")
    publications.append((manifest_source, manifest_destination))

    destinations = [destination for _, destination in publications]
    if len({str(path.resolve()) for path in destinations}) != len(destinations):
        raise RuntimeError("batch publication contains duplicate output paths")
    for destination in destinations:
        try:
            destination.resolve().relative_to(output_root.resolve())
        except (OSError, ValueError) as error:
            raise RuntimeError(
                f"batch publication escaped output directory: {destination}"
            ) from error

    backup_root = staging_root / ".previous-publication"
    backup_root.mkdir(parents=True, exist_ok=True)
    backups = []
    promoted = []
    try:
        for position, destination in enumerate(destinations, start=1):
            if not destination.exists():
                continue
            backup_path = backup_root / f"{position:02d}-{destination.name}"
            os.replace(destination, backup_path)
            backups.append((backup_path, destination))
        for source, destination in publications:
            os.replace(source, destination)
            promoted.append(destination)
    except Exception as error:
        rollback_errors = []
        for destination in reversed(promoted):
            try:
                destination.unlink(missing_ok=True)
            except OSError as rollback_error:
                rollback_errors.append(str(rollback_error))
        for backup_path, destination in reversed(backups):
            try:
                os.replace(backup_path, destination)
            except OSError as rollback_error:
                rollback_errors.append(str(rollback_error))
        detail = (
            f"; rollback errors: {'; '.join(rollback_errors)}"
            if rollback_errors
            else ""
        )
        raise RuntimeError(f"atomic batch publication failed: {error}{detail}") from error

    return str(manifest_destination)


_DIRECT_RENDER_CACHE_OMIT_FIELDS = (
    VOLATILE_CANDIDATE_FIELDS
    - {"candidate_hash"}
) | {
    "clip_url",
    "render_cache_hit",
    "render_cache_key",
    "render_cache_output_sha256",
}


def _direct_local_render_plan_hash(
    candidate: Dict,
    transcript: Dict,
    source_hash: str,
    aspect_ratio: str,
    resolved_profiles: Dict,
) -> str:
    """Bind a direct BF render to every semantic input consumed by clipper.

    Candidate hashes deliberately omit batch rank and output paths, so one exact
    render remains reusable when its position in a later batch changes.  The
    full timed transcript is conservative but safe: captions, opening trim, and
    the post-speech tail all inspect word timings beyond the candidate body.
    """

    declared_candidate_hash = str(candidate.get("candidate_hash") or "").strip().lower()
    actual_candidate_hash = candidate_hash(candidate, source_hash)
    if declared_candidate_hash != actual_candidate_hash:
        raise ValueError("candidate_hash changed before direct render cache lookup")
    if not isinstance(transcript, dict) or not isinstance(transcript.get("segments"), list):
        raise TypeError("transcript must contain a segments list")
    profile_metadata = profile_manifest_metadata(resolved_profiles)
    payload = {
        "schemaVersion": 1,
        "artifactType": "DirectLocalRenderPlanIdentity",
        "candidateHash": actual_candidate_hash,
        "transcript": {
            "duration": transcript.get("duration"),
            "segments": transcript["segments"],
        },
        "aspectRatio": str(aspect_ratio),
        "profileContractSha256": profile_metadata["contract_sha256"],
    }
    return content_hash(payload)


def _direct_local_render_cache_identity(
    candidate: Dict,
    transcript: Dict,
    source_hash: str,
    aspect_ratio: str,
    resolved_profiles: Dict,
) -> Tuple[Optional[Any], Optional[str]]:
    """Reuse the production renderer identity for direct BF local renders."""

    if resolved_profiles.get("render_profile") not in {
        BF_EDITORIAL_INSET_V1,
        BF_EDITORIAL_INSET_V2,
        BF_WINNER_LAYOUT_V1,
        BF_WINNER_PACKAGING_V1,
    }:
        return None, None
    from .production_workflow import _render_cache_identity

    edit_plan_hash = _direct_local_render_plan_hash(
        candidate,
        transcript,
        source_hash,
        aspect_ratio,
        resolved_profiles,
    )
    return _render_cache_identity(
        {
            "editPlan": {
                "sourceHash": source_hash,
                "contentHash": edit_plan_hash,
            },
            "renderCandidate": candidate,
        }
    )


def _restore_direct_cached_short(
    candidate: Dict,
    cached_short: Dict,
    clip_url: str,
    cache_key: str,
    output_sha256: str,
) -> Dict:
    """Restore renderer metadata while keeping this run's volatile ranking data."""

    restored = json.loads(json.dumps(cached_short))
    for field in VOLATILE_CANDIDATE_FIELDS:
        restored.pop(field, None)
        if field in candidate:
            restored[field] = candidate[field]
    restored["candidate_hash"] = candidate["candidate_hash"]
    restored["clip_url"] = clip_url
    restored["render_cache_hit"] = True
    restored["render_cache_key"] = cache_key
    restored["render_cache_output_sha256"] = output_sha256
    return restored


def _materialize_direct_cached_short(
    candidate: Dict,
    transcript: Dict,
    source_hash: str,
    aspect_ratio: str,
    resolved_profiles: Dict,
    output_path: Path,
    telemetry: Optional[PerformanceTelemetry],
) -> Tuple[Optional[Dict], Optional[Any], Optional[str]]:
    """Return one validated cached render, or fail open to a normal render."""

    try:
        cache, cache_key = _direct_local_render_cache_identity(
            candidate,
            transcript,
            source_hash,
            aspect_ratio,
            resolved_profiles,
        )
    except (OSError, TypeError, ValueError, RuntimeError) as error:
        print(f"[pipeline/local] render cache lookup skipped: {error}", flush=True)
        return None, None, None
    if cache is None or cache_key is None:
        return None, cache, cache_key

    entry = cache.lookup(cache_key)
    cached_short = entry.metadata.get("short") if entry is not None else None
    if (
        entry is None
        or not isinstance(cached_short, dict)
        or cached_short.get("candidate_hash") != candidate.get("candidate_hash")
        or cached_short.get("render_profile")
        != resolved_profiles.get("render_profile")
    ):
        if telemetry is not None:
            telemetry.cache_miss("local_render")
        return None, cache, cache_key
    try:
        materialized = cache.materialize_entry(entry, output_path)
    except (OSError, TypeError, ValueError, RuntimeError) as error:
        print(
            f"[pipeline/local] render cache materialization skipped: {error}",
            flush=True,
        )
        if telemetry is not None:
            telemetry.cache_miss("local_render")
        return None, cache, cache_key
    if materialized is None:
        if telemetry is not None:
            telemetry.cache_miss("local_render")
        return None, cache, cache_key
    if telemetry is not None:
        telemetry.cache_hit("local_render")
    print(
        f"[pipeline/local] exact render cache hit: {cache_key[:12]} "
        f"→ {materialized.name}",
        flush=True,
    )
    return (
        _restore_direct_cached_short(
            candidate,
            cached_short,
            str(materialized),
            cache_key,
            entry.output_sha256,
        ),
        cache,
        cache_key,
    )


def _render_direct_local_batch_with_cache(
    source_path: str,
    highlights: List[Dict],
    aspect_ratio: str,
    transcript: Dict,
    resolved_profiles: Dict,
    source_hash: str,
    staging_dir: str,
    telemetry: Optional[PerformanceTelemetry],
    opencv_warmup: Optional[Any] = None,
) -> Tuple[List[Dict], List[Dict]]:
    """Materialize hits, render only misses, and retain original batch order."""

    from .local.clipper import crop_highlights_local

    staging_root = Path(staging_dir)
    resolved: List[Optional[Dict]] = [None] * len(highlights)
    misses = []
    with _timed(
        telemetry,
        "render_cache_lookup",
        clipCount=len(highlights),
        renderProfile=resolved_profiles.get("render_profile") or "legacy",
    ):
        for index, candidate in enumerate(highlights):
            hit_path = staging_root / "cache-hits" / f"short_{index + 1:02d}.mp4"
            cached, cache, cache_key = _materialize_direct_cached_short(
                candidate,
                transcript,
                source_hash,
                aspect_ratio,
                resolved_profiles,
                hit_path,
                telemetry,
            )
            if cached is not None:
                resolved[index] = cached
            else:
                misses.append(
                    {
                        "index": index,
                        "candidate": candidate,
                        "cache": cache,
                        "cache_key": cache_key,
                    }
                )

    with _timed(
        telemetry,
        "render_batch",
        clipCount=len(misses),
        cacheHitCount=len(highlights) - len(misses),
        renderProfile=resolved_profiles.get("render_profile") or "legacy",
    ):
        if misses and opencv_warmup is not None:
            try:
                with _timed(
                    telemetry,
                    "native_runtime_wait",
                    runtime="opencv",
                ):
                    opencv_warmup.wait()
            except Exception as error:
                # Warm-up is speculative.  A real render miss remains the
                # authority and will surface its normal dependency error.
                print(
                    f"[pipeline/local] OpenCV warm-up failed open: {error}",
                    flush=True,
                )
            else:
                warmup_timing = opencv_warmup.timing()
                print(
                    "[pipeline/local] OpenCV warm-up ready "
                    f"(elapsed={warmup_timing.elapsed_seconds:.2f}s, "
                    f"render wait={warmup_timing.wait_seconds:.2f}s)",
                    flush=True,
                )
        rendered_misses = (
            crop_highlights_local(
                source_path,
                [job["candidate"] for job in misses],
                aspect_ratio=aspect_ratio,
                out_dir=str(staging_root / "cache-misses"),
                transcript=transcript,
                render_profile=resolved_profiles.get("render_profile"),
            )
            if misses
            else []
        )
    if len(rendered_misses) != len(misses):
        raise RuntimeError(
            "render cache miss batch returned an invalid result count: "
            f"received={len(rendered_misses)}, expected={len(misses)}"
        )

    cache_writes = []
    for job, rendered in zip(misses, rendered_misses):
        item = dict(rendered)
        if job["cache"] is not None and job["cache_key"] is not None:
            item["render_cache_hit"] = False
            item["render_cache_key"] = job["cache_key"]
            cache_writes.append(job)
        resolved[job["index"]] = item
    if any(item is None for item in resolved):
        raise RuntimeError("render cache batch did not resolve every output slot")
    return [dict(item) for item in resolved if item is not None], cache_writes


def _store_direct_local_render_cache(
    cache_writes: List[Dict],
    raw_shorts: List[Dict],
) -> None:
    """Store only raw renderer metadata after all applicable QA has passed."""

    for job in cache_writes:
        short = raw_shorts[job["index"]]
        metadata = {
            key: value
            for key, value in short.items()
            if key not in _DIRECT_RENDER_CACHE_OMIT_FIELDS
        }
        try:
            job["cache"].store(
                job["cache_key"],
                str(short["clip_url"]),
                metadata={"short": metadata},
            )
        except (OSError, TypeError, ValueError, RuntimeError) as error:
            print(f"[pipeline/local] render cache store skipped: {error}", flush=True)


def resolve_clip_count(requested: Optional[int], duration: float) -> int:
    """Resolve automatic batch size at roughly one short per six source minutes."""
    if requested is not None:
        if requested < 1:
            raise ValueError("num_clips must be at least 1 or None for auto")
        return requested
    return max(1, min(AUTO_CLIP_MAX, int(math.ceil(max(1.0, duration) / AUTO_CLIP_SECONDS))))


def _run_local(
    youtube_url: str,
    num_clips: Optional[int],
    aspect_ratio: str,
    download_format: str,
    language: Optional[str],
    resolved_profiles: Dict,
    approved_candidate_hash: Optional[str] = None,
    approved_transcript: Optional[Dict] = None,
    select_only: bool = False,
    telemetry: Optional[PerformanceTelemetry] = None,
) -> Dict:
    from .local.downloader import download_youtube_local
    from .local.llm import LLM_RESPONSE_SCHEMA_VERSION, call_local_llm
    from .local.transcriber import transcribe_local
    from .local.visual_features import (
        analyze_candidate_visuals,
        analyze_motivational_editability,
        analyze_rendered_cut_metrics,
    )

    opencv_warmup = None
    downloaded_video_info = None

    def capture_downloaded_video_info(info: Dict) -> None:
        """Retain yt-dlp's successful response for caption-track discovery."""
        nonlocal downloaded_video_info
        downloaded_video_info = {
            key: info.get(key)
            for key in (
                "original_language",
                "language",
                "subtitles",
                "automatic_captions",
            )
            if info.get(key) is not None
        }

    def start_remote_render_warmup() -> None:
        """Hide the cold OpenCV import behind a real network download."""
        nonlocal opencv_warmup
        motivational_selection_only = (
            select_only
            and resolved_profiles.get("selection_profile")
            in {
                "motivational_tension_micro_v1",
                "motivational_tension_micro_v2",
            }
        )
        if motivational_selection_only or opencv_warmup is not None:
            return
        from .opencv_warmup import OpenCVImportWarmup

        opencv_warmup = OpenCVImportWarmup()
        opencv_warmup.start()
        print(
            "[pipeline/local] warming OpenCV during source download",
            flush=True,
        )

    with _timed(telemetry, "download", format=download_format):
        source_path = download_youtube_local(
            youtube_url,
            fmt=download_format,
            telemetry=telemetry,
            minimum_hd_height=(
                720
                if resolved_profiles.get("render_profile")
                in {BF_EDITORIAL_INSET_V1, BF_EDITORIAL_INSET_V2}
                else 1080
            ),
            on_remote_download_start=start_remote_render_warmup,
            on_video_info=capture_downloaded_video_info,
        )

    with _timed(
        telemetry,
        "transcription",
        approvedTranscript=approved_transcript is not None,
        language=language or "auto",
    ):
        if approved_transcript is not None:
            transcript = json.loads(json.dumps(approved_transcript))
            if telemetry is not None:
                telemetry.cache_hit("transcript")
        else:
            from .config import LOCAL_YOUTUBE_CAPTIONS

            transcript = None
            if LOCAL_YOUTUBE_CAPTIONS:
                from .local.youtube_captions import transcribe_youtube_captions

                with _timed(
                    telemetry,
                    "transcription.youtube_captions",
                    language=language or "auto",
                ):
                    transcript = transcribe_youtube_captions(
                        youtube_url,
                        source_path,
                        language=language,
                        telemetry=telemetry,
                        video_info=downloaded_video_info,
                    )
            if transcript is None:
                with _timed(
                    telemetry,
                    "transcription.whisper",
                    language=language or "auto",
                ):
                    transcript = transcribe_local(
                        source_path,
                        language=language,
                        telemetry=telemetry,
                    )
    if not transcript["segments"]:
        raise RuntimeError(
            "Whisper produced no segments. The video may have no detectable speech."
        )

    resolved_num_clips = resolve_clip_count(num_clips, float(transcript.get("duration", 0.0)))
    print(
        f"[pipeline/local] short batch target={resolved_num_clips} "
        f"({'auto' if num_clips is None else 'explicit'})",
        flush=True,
    )
    from .config import (
        GEMINI_MODEL,
        LLM_PROVIDER,
        LOCAL_CANDIDATE_CACHE_DIR,
        LOCAL_OUTPUT_DIR,
        LOCAL_SHOT_CACHE_DIR,
        OPENAI_MODEL,
    )

    model_name = GEMINI_MODEL if LLM_PROVIDER == "gemini" else OPENAI_MODEL
    with _timed(
        telemetry,
        "candidate_generation",
        provider=LLM_PROVIDER,
        model=model_name,
    ):
        highlights_result = get_highlights(
            transcript,
            num_clips=resolved_num_clips,
            llm_fn=call_local_llm,
            profile_override=resolved_profiles.get("content_profile"),
            selection_profile=resolved_profiles.get("selection_profile"),
            cache_dir=LOCAL_CANDIDATE_CACHE_DIR,
            cache_namespace=f"{LLM_PROVIDER}:{model_name}:{LLM_RESPONSE_SCHEMA_VERSION}",
            telemetry=telemetry,
        )
    candidates: List[Dict] = highlights_result.get("highlights", [])
    if not candidates:
        raise RuntimeError("Highlight generator returned zero clips.")

    content_type = highlights_result.get("content_info", {}).get("content_type", "other")
    if content_type == "gaming":
        candidates = [{**candidate, "layout_hint": "gameplay"} for candidate in candidates]
        candidates = enrich_gaming_context(candidates, transcript)
    if content_type in {"tutorial", "lecture"}:
        candidates = resolve_semantic_endpoints(candidates, transcript)
        candidates = [
            plan_educational_composite(candidate, transcript)
            if candidate.get("composite_required")
            else candidate
            for candidate in candidates
        ]
    render_settings = render_settings_for_content(
        content_type,
        render_profile=resolved_profiles.get("render_profile"),
        selection_profile=resolved_profiles.get("selection_profile"),
        format_profile=resolved_profiles.get("format_profile"),
    )
    if render_settings:
        candidates = [{**candidate, **render_settings} for candidate in candidates]
    if content_type == "motivational_podcast":
        candidates = [
            {
                **candidate,
                "music_profile": motivational_music_profile_for_candidate(candidate),
            }
            for candidate in candidates
        ]

    # Motivational selection is semantic plus native source-cut stability.
    # OpenCV candidate-frame metrics are rank-neutral for this profile, so
    # reject semantic failures before media analysis and never decode them.
    deferred_candidates: List[Dict] = []
    if content_type == "motivational_podcast":
        semantic_ranked = rank_highlights(
            candidates,
            transcript,
            content_type=content_type,
            selection_profile=resolved_profiles.get("selection_profile"),
        )
        candidates = [
            dict(item) for item in eligible_highlights(semantic_ranked)
        ]
        deferred_candidates = [
            dict(item) for item in semantic_ranked if item.get("rejected")
        ]
        semantic_selected = select_diverse_highlights(
            [dict(item) for item in candidates],
            limit=resolved_num_clips,
        )
        if (
            not select_only
            and not approved_candidate_hash
            and len(semantic_selected) < resolved_num_clips
        ):
            raise IncompleteHighlightBatchError(
                "semantic candidate preflight exhausted before visual analysis: "
                f"selected={len(semantic_selected)}, target={resolved_num_clips}"
            )

    with _timed(
        telemetry,
        "candidate_visual_analysis",
        candidateCount=len(candidates),
        deferredCandidateCount=len(deferred_candidates),
    ):
        if content_type == "motivational_podcast":
            candidates = analyze_motivational_editability(
                source_path,
                candidates,
                cache_dir=LOCAL_SHOT_CACHE_DIR,
                telemetry=telemetry,
            )
        else:
            candidates = analyze_candidate_visuals(
                source_path,
                candidates,
                telemetry=telemetry,
            )
    with _timed(
        telemetry,
        "candidate_ranking",
        candidateCount=len(candidates),
        contentType=content_type,
    ):
        all_highlights = rank_highlights(
            candidates + deferred_candidates,
            transcript,
            content_type=content_type,
            selection_profile=resolved_profiles.get("selection_profile"),
        )
    with _timed(telemetry, "source_hash"):
        source_hash = file_sha256(source_path)
    all_highlights = [
        {
            **{key: value for key, value in item.items() if key != "candidate_hash"},
            "candidate_hash": candidate_hash(
                {key: value for key, value in item.items() if key != "candidate_hash"},
                source_hash,
            ),
        }
        for item in all_highlights
    ]
    if approved_candidate_hash:
        approved_matches = [
            item
            for item in all_highlights
            if not item.get("rejected") and item.get("candidate_hash") == approved_candidate_hash
        ]
        if len(approved_matches) != 1:
            raise RuntimeError(
                "Approved candidate hash did not resolve to exactly one eligible candidate; "
                "render blocked before crop."
            )
        for item in all_highlights:
            item["selected_for_render"] = item is approved_matches[0]
            item.pop("output_rank", None)
            item.pop("batch_exclusion_reason", None)
            if item is approved_matches[0]:
                item["output_rank"] = 1
            elif not item.get("rejected"):
                item["batch_exclusion_reason"] = "not_approved_candidate"
        top = approved_matches
    else:
        top = select_diverse_highlights(all_highlights, limit=resolved_num_clips)
    expected_batch_size = 1 if approved_candidate_hash else resolved_num_clips
    if not select_only and len(top) != expected_batch_size:
        reasons = sorted(
            {
                reason
                for item in all_highlights
                for reason in item.get("rejection_reasons", [])
            }
        )
        raise IncompleteHighlightBatchError(
            "render blocked for incomplete candidate batch: "
            f"selected={len(top)}, target={expected_batch_size}, "
            f"reasons={','.join(reasons) or 'insufficient_diversity'}"
        )
    if select_only:
        print(
            f"[pipeline/local] selected {len(top)} of {len(all_highlights)} candidates; "
            "render skipped (--select-only)",
            flush=True,
        )
        shorts = []
        with _timed(telemetry, "ranking_manifest"):
            manifest = build_ranking_manifest(
                youtube_url,
                source_path,
                content_type,
                all_highlights,
                top,
                profiles=resolved_profiles,
                source_hash=source_hash,
            )
            manifest_path = write_local_ranking_manifest(manifest, LOCAL_OUTPUT_DIR)
    else:
        print(
            f"[pipeline/local] cropping {len(top)} of {len(all_highlights)} candidates "
            f"({sum(bool(item.get('rejected')) for item in all_highlights)} rejected)",
            flush=True,
        )
        os.makedirs(LOCAL_OUTPUT_DIR, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix=".shorts-render-batch-",
            dir=LOCAL_OUTPUT_DIR,
        ) as staging_dir:
            shorts, render_cache_writes = _render_direct_local_batch_with_cache(
                source_path,
                top,
                aspect_ratio,
                transcript,
                resolved_profiles,
                source_hash,
                staging_dir,
                telemetry,
                opencv_warmup=opencv_warmup,
            )
            failed_renders = [
                item
                for item in shorts
                if item.get("error")
                or not item.get("clip_url")
                or not os.path.isfile(str(item.get("clip_url") or ""))
                or os.path.getsize(str(item.get("clip_url") or "")) <= 0
            ]
            if len(shorts) != expected_batch_size or failed_renders:
                details = "; ".join(
                    str(item.get("error") or "missing output")
                    for item in failed_renders
                )
                raise RuntimeError(
                    "render batch incomplete; no batch may be reported as complete: "
                    f"successful={len(shorts) - len(failed_renders)}, "
                    f"target={expected_batch_size}"
                    + (f" ({details})" if details else "")
                )
            raw_render_shorts = [dict(item) for item in shorts]

            if content_type == "motivational_podcast":
                with _timed(
                    telemetry,
                    "rendered_cut_analysis",
                    clipCount=len(shorts),
                ):
                    shorts = analyze_rendered_cut_metrics(shorts)
                if resolved_profiles.get("render_profile") in {
                    BF_EDITORIAL_INSET_V1,
                    BF_EDITORIAL_INSET_V2,
                }:
                    editorial_qa_failures = []
                    measured_shorts = []
                    with _timed(
                        telemetry,
                        "editorial_qa",
                        clipCount=len(shorts),
                    ):
                        for item in shorts:
                            measured = dict(item)
                            if not measured.get("error") and measured.get("clip_url"):
                                render_evidence = build_editorial_render_evidence(measured)
                                qa_report = evaluate_editorial_render(
                                    str(measured["clip_url"]),
                                    render_manifest=render_evidence,
                                )
                                measured["render_manifest_evidence"] = render_evidence
                                measured["editorial_qa_report"] = qa_report
                                if not qa_report["passed"]:
                                    editorial_qa_failures.append(measured)
                            measured_shorts.append(measured)
                    shorts = measured_shorts
                    if editorial_qa_failures:
                        summaries = []
                        for item in editorial_qa_failures:
                            failed_codes = [
                                gate["code"]
                                for gate in item["editorial_qa_report"]["gates"]
                                if not gate["passed"]
                            ]
                            summaries.append(
                                f"#{item.get('output_rank', '?')}={','.join(failed_codes)}"
                            )
                        raise RuntimeError(
                            "Editorial render QA failed: " + "; ".join(summaries)
                        )
                    failed_cut_qa = [
                        item
                        for item in shorts
                        if not item.get("error")
                        and int(item.get("artificial_cut_count") or 0) > 0
                    ]
                else:
                    failed_cut_qa = [
                        item
                        for item in shorts
                        if not item.get("error")
                        and not item.get("artificial_cut_guardrail_pass", False)
                    ]
                if failed_cut_qa:
                    counts = ", ".join(
                        f"#{item.get('output_rank', '?')}={item.get('artificial_cut_count')}"
                        for item in failed_cut_qa
                    )
                    raise RuntimeError(
                        f"Motivational render added artificial cuts: {counts}"
                    )

            _store_direct_local_render_cache(
                render_cache_writes,
                raw_render_shorts,
            )

            final_shorts = _planned_local_batch_outputs(shorts, LOCAL_OUTPUT_DIR)
            with _timed(telemetry, "ranking_manifest"):
                manifest = build_ranking_manifest(
                    youtube_url,
                    source_path,
                    content_type,
                    all_highlights,
                    final_shorts,
                    profiles=resolved_profiles,
                    source_hash=source_hash,
                )
                staged_manifest_path = write_local_ranking_manifest(
                    manifest,
                    staging_dir,
                )
            with _timed(
                telemetry,
                "batch_publication",
                clipCount=len(final_shorts),
            ):
                manifest_path = _promote_staged_local_batch(
                    shorts,
                    final_shorts,
                    staged_manifest_path,
                    LOCAL_OUTPUT_DIR,
                )
            shorts = final_shorts

    return {
        "mode": "local",
        "profiles": profile_manifest_metadata(resolved_profiles),
        "source_video_url": source_path,
        "transcript": transcript,
        "highlights": all_highlights,
        "selected_candidates": top,
        "shorts": shorts,
        "ranking": {
            "content_type": highlights_result.get("content_info", {}).get("content_type", "other"),
            "requested_clips": "auto" if num_clips is None else num_clips,
            "target_clips": resolved_num_clips,
            "selected_count": len(top),
            "rendered_count": len(shorts),
            "selection_only": bool(select_only),
            "eligible_count": len(eligible_highlights(all_highlights)),
            "rejected_count": sum(bool(item.get("rejected")) for item in all_highlights),
            "manifest_path": manifest_path,
        },
    }


def _run_api(
    youtube_url: str,
    num_clips: Optional[int],
    aspect_ratio: str,
    download_format: str,
    language: Optional[str],
    resolved_profiles: Dict,
    select_only: bool = False,
    telemetry: Optional[PerformanceTelemetry] = None,
) -> Dict:
    with _timed(telemetry, "download", format=download_format):
        source_url = download_youtube(youtube_url, fmt=download_format)

    with _timed(telemetry, "transcription", language=language or "auto"):
        transcript = transcribe(source_url, language=language)
    if not transcript["segments"]:
        raise RuntimeError(
            "Whisper produced no segments. The video may have no detectable speech."
        )

    resolved_num_clips = resolve_clip_count(num_clips, float(transcript.get("duration", 0.0)))
    with _timed(telemetry, "candidate_generation", provider="muapi"):
        highlights_result = get_highlights(
            transcript,
            num_clips=resolved_num_clips,
            llm_fn=call_muapi_llm,
            profile_override=resolved_profiles.get("content_profile"),
            selection_profile=resolved_profiles.get("selection_profile"),
            telemetry=telemetry,
        )
    candidates: List[Dict] = highlights_result.get("highlights", [])
    if not candidates:
        raise RuntimeError("Highlight generator returned zero clips.")

    with _timed(
        telemetry,
        "candidate_ranking",
        candidateCount=len(candidates),
    ):
        all_highlights = rank_highlights(
            candidates,
            transcript,
            content_type=highlights_result.get("content_info", {}).get("content_type", "other"),
            selection_profile=resolved_profiles.get("selection_profile"),
        )
    top = select_diverse_highlights(all_highlights, limit=resolved_num_clips)
    if not select_only and len(top) != resolved_num_clips:
        raise IncompleteHighlightBatchError(
            "API render blocked for incomplete candidate batch: "
            f"selected={len(top)}, target={resolved_num_clips}"
        )
    if select_only:
        print(
            f"[pipeline] selected {len(top)} of {len(all_highlights)} candidates; "
            "render skipped (--select-only)",
            flush=True,
        )
        shorts = []
    else:
        print(f"[pipeline] cropping {len(top)} of {len(all_highlights)} candidates", flush=True)
        with _timed(telemetry, "render_batch", clipCount=len(top)):
            shorts = crop_highlights(source_url, top, aspect_ratio=aspect_ratio)

    return {
        "mode": "api",
        "profiles": profile_manifest_metadata(resolved_profiles),
        "source_video_url": source_url,
        "transcript": transcript,
        "highlights": all_highlights,
        "selected_candidates": top,
        "shorts": shorts,
        "ranking": {
            "content_type": highlights_result.get("content_info", {}).get("content_type", "other"),
            "requested_clips": "auto" if num_clips is None else num_clips,
            "target_clips": resolved_num_clips,
            "selected_count": len(top),
            "rendered_count": len(shorts),
            "selection_only": bool(select_only),
            "eligible_count": len(eligible_highlights(all_highlights)),
            "rejected_count": sum(bool(item.get("rejected")) for item in all_highlights),
        },
    }


def generate_shorts(
    youtube_url: str,
    num_clips: Optional[int] = 3,
    aspect_ratio: str = "9:16",
    download_format: str = "720",
    language: Optional[str] = None,
    mode: str = "api",
    content_profile: Optional[str] = None,
    selection_profile: Optional[str] = None,
    render_profile: Optional[str] = None,
    format_profile: Optional[str] = None,
    approved_candidate_hash: Optional[str] = None,
    approved_transcript: Optional[Dict] = None,
    select_only: bool = False,
) -> Dict:
    """Run the full pipeline and return a structured result.

    Args:
        youtube_url: source URL.
        num_clips: how many shorts to render, or None to derive a bounded batch
            size from source duration.
        aspect_ratio: e.g. "9:16", "1:1".
        download_format: source resolution ("360" / "480" / "720" / "1080").
        language: ISO-639-1 to force Whisper language detection.
        mode: "api" (default, MuAPI) or "local" (yt-dlp + faster-whisper +
            OpenAI or Gemini + ffmpeg).
        content_profile: optional forced profile such as "motivational_podcast".
        selection_profile: optional versioned candidate policy.
        render_profile: optional versioned local renderer contract.
        format_profile: optional combined content/selection/render preset.
        approved_candidate_hash: exact CandidateDecision candidate hash supplied
            by the Node control plane; local production profile only.
        approved_transcript: hash-verified TranscriptManifest body supplied by
            the Node control plane together with approved_candidate_hash.
        select_only: rank and persist candidates without invoking a renderer.

    Returns:
        {
          "mode": "api" | "local",
          "source_video_url": str,   # hosted URL (api) or local path (local)
          "transcript": {...},
          "highlights": [...],       # all candidates ranked
          "shorts": [...],           # top `num_clips` with clip_url / local path
        }
    """
    mode = (mode or "api").lower()
    resolved_profiles = resolve_profile_bundle(
        content_profile=content_profile,
        selection_profile=selection_profile,
        render_profile=render_profile,
        format_profile=format_profile,
    )
    approved_hash = str(approved_candidate_hash or "").strip().lower().removeprefix("sha256:")
    has_approved_transcript = approved_transcript is not None
    if bool(approved_hash) != has_approved_transcript:
        raise ValueError(
            "approved_candidate_hash and approved_transcript must be provided together"
        )
    if approved_hash:
        if len(approved_hash) != 64 or any(char not in "0123456789abcdef" for char in approved_hash):
            raise ValueError("approved_candidate_hash must be a sha256 hash")
        if mode != "local" or resolved_profiles.get("format_profile") != "bf_viral_micro_v1":
            raise ValueError(
                "approved candidate rendering requires local bf_viral_micro_v1"
            )
        if num_clips != 1:
            raise ValueError("approved candidate rendering requires num_clips=1")
        if select_only:
            raise ValueError("approved candidate rendering cannot use select_only")
    if (
        resolved_profiles.get("render_profile")
        in {
            BF_EDITORIAL_INSET_V1,
            BF_EDITORIAL_INSET_V2,
            BF_WINNER_LAYOUT_V1,
            BF_WINNER_PACKAGING_V1,
        }
        and str(aspect_ratio or "").strip() != "9:16"
    ):
        raise ValueError(
            f"Profile {resolved_profiles.get('render_profile')!r} requires "
            "aspect_ratio='9:16' "
            "for its immutable 1080x1920 canvas contract."
        )
    if mode == "api" and resolved_profiles["local_only"]:
        selected = resolved_profiles.get("format_profile") or resolved_profiles.get(
            "render_profile"
        )
        raise ValueError(
            f"Profile {selected!r} is local-only: API autocrop cannot reproduce "
            "the versioned editorial inset render contract. Use mode='local'."
        )
    if mode not in {"api", "local"}:
        raise ValueError(f"Unknown mode: {mode!r}. Use 'api' or 'local'.")

    telemetry = PerformanceTelemetry(
        metadata={
            "mode": mode,
            "sourceInput": youtube_url,
            "requestedClips": "auto" if num_clips is None else num_clips,
            "selectOnly": bool(select_only),
            "formatProfile": resolved_profiles.get("format_profile"),
            "selectionProfile": resolved_profiles.get("selection_profile"),
            "renderProfile": resolved_profiles.get("render_profile"),
        }
    )
    try:
        with telemetry.stage("pipeline", mode=mode):
            if mode == "local":
                result = _run_local(
                    youtube_url,
                    num_clips,
                    aspect_ratio,
                    download_format,
                    language,
                    resolved_profiles,
                    approved_candidate_hash=approved_hash or None,
                    approved_transcript=approved_transcript,
                    select_only=select_only,
                    telemetry=telemetry,
                )
            else:
                result = _run_api(
                    youtube_url,
                    num_clips,
                    aspect_ratio,
                    download_format,
                    language,
                    resolved_profiles,
                    select_only=select_only,
                    telemetry=telemetry,
                )
    except BaseException:
        report_path = _persist_performance_report(telemetry)
        if report_path:
            print(f"[performance] failed-run report: {report_path}", flush=True)
        raise

    report_path = _persist_performance_report(telemetry)
    report = telemetry.snapshot()
    result["performance"] = {
        "run_id": telemetry.run_id,
        "report_path": report_path,
        "duration_seconds": report["durationSeconds"],
        "stage_totals": report["stageTotals"],
        "cache_counters": report["cacheCounters"],
    }
    if report_path:
        print(f"[performance] report: {report_path}", flush=True)
    return result
