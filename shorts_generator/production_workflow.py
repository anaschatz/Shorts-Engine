"""Production-only render path for an explicitly approved micro candidate."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from functools import lru_cache
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .artifact_contracts import (
    ArtifactBindingError,
    build_edit_plan,
    build_render_manifest,
    file_sha256,
    verify_seal,
)
from .audio_qa import evaluate_audio_delivery
from .editorial_qa import evaluate_editorial_render
from .profiles import (
    BF_EDITORIAL_INSET_V1,
    BF_SMOOTH_TAIL_V5,
    BF_VIRAL_MICRO_V1,
    MOTIVATIONAL_PODCAST,
    MOTIVATIONAL_TENSION_MICRO_V1,
    render_settings_for_content,
)
from .render_cache import RenderCache, RenderCacheError, build_render_cache_key


def _timed(telemetry: Optional[Any], name: str, **attributes):
    if telemetry is None:
        return nullcontext()
    return telemetry.stage(name, **attributes)


def _verify_production_job(
    candidate_decision: Dict,
    experiment_manifest: Dict,
) -> Tuple[Dict, Dict]:
    """Verify the immutable artifacts for one production job."""
    decision = verify_seal(candidate_decision, "CandidateDecision")
    experiment = verify_seal(experiment_manifest, "ExperimentManifest")
    if experiment["candidateHash"] != decision["candidateHash"]:
        raise ArtifactBindingError("experiment references another candidate")
    if (
        experiment.get("formatProfile") != BF_VIRAL_MICRO_V1
        or experiment.get("selectionProfile") != MOTIVATIONAL_TENSION_MICRO_V1
        or experiment.get("renderProfile") != BF_EDITORIAL_INSET_V1
    ):
        raise ArtifactBindingError("experiment does not freeze the production profile")
    return decision, experiment


def _resolve_shared_transcript(transcript: Dict, source_hash: str) -> Dict:
    """Resolve a raw transcript or one sealed TranscriptManifest exactly once."""
    if not isinstance(transcript, dict):
        raise ArtifactBindingError("transcript must be an object")
    if transcript.get("artifactType") == "TranscriptManifest":
        manifest = verify_seal(transcript, "TranscriptManifest")
        if manifest.get("sourceHash") != source_hash:
            raise ArtifactBindingError("transcript manifest references another source")
        resolved = manifest.get("transcript")
    else:
        resolved = transcript
    if not isinstance(resolved, dict) or not isinstance(resolved.get("segments"), list):
        raise ArtifactBindingError("transcript must contain a segments list")
    return resolved


def _candidate_hash_hint(candidate_decision: Any) -> Optional[str]:
    if not isinstance(candidate_decision, dict):
        return None
    value = candidate_decision.get("candidateHash")
    if value is None and isinstance(candidate_decision.get("candidate"), dict):
        value = candidate_decision["candidate"].get("candidate_hash")
    normalized = str(value or "").strip().lower().removeprefix("sha256:")
    return normalized or None


def _real_esrgan_enabled() -> bool:
    """Read the configured enhancer state without resolving/starting its runtime."""
    from .config import LOCAL_REAL_ESRGAN

    return bool(LOCAL_REAL_ESRGAN)


def _probe_video_frame_size_ffprobe(
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


def _real_esrgan_required_for_source(source_path: str) -> bool:
    """Return whether this source needs GPU enhancement for the BF inset."""
    if not _real_esrgan_enabled():
        return False
    from .local.clipper import (
        _output_dimensions,
        _should_bypass_editorial_realesrgan,
    )

    source_size = _probe_video_frame_size_ffprobe(source_path)
    if source_size is None:
        try:
            import cv2  # type: ignore
            from .local.clipper import _probe_video_frame_size
        except ImportError:
            return True
        source_size = _probe_video_frame_size(cv2, source_path)
    if source_size is None:
        return True
    output_size = _output_dimensions("9:16", BF_EDITORIAL_INSET_V1)
    return not _should_bypass_editorial_realesrgan(source_size, output_size)


@lru_cache(maxsize=1)
def _renderer_fingerprint() -> str:
    """Bind exact-output cache entries to renderer code and runtime versions."""
    digest = hashlib.sha256()
    package_root = Path(__file__).resolve().parent
    for path in (
        package_root / "local" / "clipper.py",
        package_root / "profiles.py",
    ):
        digest.update(path.name.encode("utf-8"))
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    for distribution in ("numpy", "opencv-python", "Pillow"):
        try:
            version = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            version = "missing"
        digest.update(f"{distribution}={version}\n".encode("utf-8"))
    try:
        ffmpeg_version = subprocess.run(
            ["ffmpeg", "-version"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()[0]
    except (FileNotFoundError, subprocess.CalledProcessError, IndexError):
        ffmpeg_version = "ffmpeg=unavailable"
    digest.update(ffmpeg_version.encode("utf-8"))
    return digest.hexdigest()


@lru_cache(maxsize=64)
def _asset_sha256(path_text: str, size: int, mtime_ns: int) -> str:
    """Hash one resolved renderer asset once per process/stat identity."""
    del size, mtime_ns
    return file_sha256(path_text)


def _render_cache_identity(
    prepared: Dict,
) -> Tuple[Optional[RenderCache], Optional[str]]:
    """Return the exact render cache and key for one prepared candidate."""
    from .config import (
        LOCAL_AUDIO_BITRATE,
        LOCAL_AUDIO_LOUDNESS,
        LOCAL_AUDIO_TRUE_PEAK,
        LOCAL_CAPTION_LEAD_MS,
        LOCAL_MOTIVATIONAL_MUSIC,
        LOCAL_MOTIVATIONAL_MUSIC_LOUDNESS,
        LOCAL_MOTIVATIONAL_MUSIC_PROFILE,
        LOCAL_MOTIVATIONAL_MUSIC_START_SECONDS,
        LOCAL_OUTPUT_FPS,
        LOCAL_REAL_ESRGAN,
        LOCAL_REAL_ESRGAN_BYPASS_HIGH_RES,
        LOCAL_REAL_ESRGAN_MIN_PANEL_COVERAGE,
        LOCAL_REAL_ESRGAN_MODEL,
        LOCAL_REAL_ESRGAN_REFERENCE_BLEND,
        LOCAL_RENDER_CACHE,
        LOCAL_RENDER_CACHE_DIR,
        LOCAL_VIDEO_CRF,
        LOCAL_VIDEO_PRESET,
        LOCAL_VIDEO_PROFILE,
    )

    if not LOCAL_RENDER_CACHE:
        return None, None

    from .local import clipper

    render_candidate = prepared["renderCandidate"]
    asset_paths = {
        "font.base": clipper._resolve_caption_font(BF_EDITORIAL_INSET_V1),
        "font.support": clipper._resolve_motivational_support_font(),
        "font.accent": clipper._resolve_motivational_accent_font(),
        "font.script": clipper._resolve_motivational_script_font(),
        "music": clipper._resolve_motivational_music_track(
            bool(render_candidate.get("background_music", False)),
            str(render_candidate.get("music_profile") or ""),
        ),
    }
    asset_hashes = {}
    for name, path_text in asset_paths.items():
        if not path_text:
            continue
        path = Path(path_text)
        stat = path.stat()
        asset_hashes[name] = _asset_sha256(
            str(path.resolve()),
            stat.st_size,
            stat.st_mtime_ns,
        )

    enhancement_model = (
        LOCAL_REAL_ESRGAN_MODEL
        or str(render_candidate.get("enhancement_model") or "")
    )
    enhancement_runtime_fingerprint = None
    if LOCAL_REAL_ESRGAN:
        runtime = clipper._resolve_realesrgan_runtime()
        if runtime is not None:
            enhancement_runtime_fingerprint = clipper._realesrgan_runtime_fingerprint(
                runtime,
                enhancement_model or "realesrgan-x4plus",
            )
    renderer_config = {
        "canvas": {"width": 1080, "height": 1920, "fps": LOCAL_OUTPUT_FPS},
        "video": {
            "crf": LOCAL_VIDEO_CRF,
            "preset": LOCAL_VIDEO_PRESET,
            "profile": LOCAL_VIDEO_PROFILE,
        },
        "audio": {
            "bitrate": LOCAL_AUDIO_BITRATE,
            "loudness": LOCAL_AUDIO_LOUDNESS,
            "truePeak": LOCAL_AUDIO_TRUE_PEAK,
        },
        "captions": {
            "style": BF_EDITORIAL_INSET_V1,
            "leadMs": LOCAL_CAPTION_LEAD_MS,
        },
        # Bind the semantic tail policy explicitly as well as through the
        # renderer source fingerprint.  This prevents a long-lived worker (or
        # a restored cache directory) from serving v3's earlier 200ms fade for
        # an otherwise identical v4 request.
        "tail": {
            "profile": str(render_candidate.get("brand_tail_profile") or ""),
            "brandSeconds": float(
                render_candidate.get("brand_tail_seconds") or 0.0
            ),
        },
        "music": {
            "enabled": LOCAL_MOTIVATIONAL_MUSIC,
            "profile": LOCAL_MOTIVATIONAL_MUSIC_PROFILE,
            "loudness": LOCAL_MOTIVATIONAL_MUSIC_LOUDNESS,
            "startSeconds": LOCAL_MOTIVATIONAL_MUSIC_START_SECONDS,
        },
        "enhancement": {
            "enabled": LOCAL_REAL_ESRGAN,
            "bypassHighResolution": LOCAL_REAL_ESRGAN_BYPASS_HIGH_RES,
            "minimumPanelCoverage": LOCAL_REAL_ESRGAN_MIN_PANEL_COVERAGE,
            "model": enhancement_model,
            "referenceBlend": LOCAL_REAL_ESRGAN_REFERENCE_BLEND,
            "runtimeFingerprint": enhancement_runtime_fingerprint,
        },
    }
    key = build_render_cache_key(
        source_hash=prepared["editPlan"]["sourceHash"],
        edit_plan_hash=prepared["editPlan"]["contentHash"],
        renderer_fingerprint=_renderer_fingerprint(),
        renderer_config=renderer_config,
        asset_hashes=asset_hashes,
    )
    return RenderCache(LOCAL_RENDER_CACHE_DIR), key


def _cached_short_for_job(
    prepared: Dict,
    output_root: Path,
    output_index: int,
    telemetry: Optional[Any] = None,
) -> Tuple[Optional[Dict], Optional[RenderCache], Optional[str]]:
    """Materialize an exact cached MP4 and restore its renderer metadata."""
    try:
        cache, cache_key = _render_cache_identity(prepared)
    except (OSError, TypeError, ValueError, RuntimeError) as error:
        print(f"[production] render cache lookup skipped: {error}", flush=True)
        return None, None, None
    if cache is None or cache_key is None:
        return None, cache, cache_key
    entry = cache.lookup(cache_key)
    cached_short = entry.metadata.get("short") if entry is not None else None
    if not isinstance(cached_short, dict):
        if telemetry is not None:
            telemetry.cache_miss("production_render")
        return None, cache, cache_key
    output_path = output_root / f"short_{output_index:02d}.mp4"
    try:
        materialized = cache.materialize(cache_key, output_path)
    except (OSError, RenderCacheError) as error:
        print(f"[production] render cache materialization skipped: {error}", flush=True)
        return None, cache, cache_key
    if materialized is None:
        if telemetry is not None:
            telemetry.cache_miss("production_render")
        return None, cache, cache_key
    if telemetry is not None:
        telemetry.cache_hit("production_render")
    print(
        f"[production] exact render cache hit: {cache_key[:12]} "
        f"→ {materialized.name}",
        flush=True,
    )
    return (
        {
            **json.loads(json.dumps(cached_short)),
            "clip_url": str(materialized),
            "render_cache_hit": True,
            "render_cache_key": cache_key,
        },
        cache,
        cache_key,
    )


def _store_render_cache(
    cache: Optional[RenderCache],
    cache_key: Optional[str],
    result: Dict,
) -> None:
    """Store only a QA-passed output; cache failures never fail production."""
    if cache is None or cache_key is None:
        return
    short = result["short"]
    metadata = {
        key: value
        for key, value in short.items()
        if key not in {"clip_url", "render_cache_hit", "render_cache_key"}
    }
    try:
        cache.store(
            cache_key,
            str(short["clip_url"]),
            metadata={"short": metadata},
        )
    except (OSError, TypeError, ValueError, RenderCacheError) as error:
        print(f"[production] render cache store skipped: {error}", flush=True)


def _probe_video(path: str) -> Dict:
    try:
        import cv2  # type: ignore
    except ImportError as error:  # pragma: no cover
        raise RuntimeError("opencv-python is required for production render probing") from error
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


def _prepare_verified_candidate(
    transcript: Dict,
    decision: Dict,
    experiment: Dict,
) -> Dict:
    """Build the immutable edit plan and renderer input for a verified job."""
    from .local.clipper import (
        _build_word_cues,
        _resolve_bf_brand_tail_seconds,
        _trim_opening_dead_air,
    )

    candidate = dict(decision["candidate"])
    start = float(candidate.get("render_start_time", candidate["start_time"]))
    end = float(candidate.get("render_end_time", candidate["end_time"]))
    actual_start = _trim_opening_dead_air(
        transcript,
        start,
        end,
        max_dead_air_seconds=0.25,
        speech_lead_seconds=0.08,
    )
    caption_end = min(
        end,
        float(candidate["speech_end_time"])
        if candidate.get("speech_end_time") is not None
        else end,
    )
    brand_tail_seconds = _resolve_bf_brand_tail_seconds(
        BF_EDITORIAL_INSET_V1,
        brand_tail_profile=BF_SMOOTH_TAIL_V5,
        requested_seconds=candidate.get("brand_tail_seconds"),
    )
    # The tail is appended after the source speech boundary by the renderer;
    # it must never consume or truncate the approved spoken interval.
    caption_display_end = caption_end
    caption_context = {
        key: candidate.get(key)
        for key in (
            "title",
            "topic",
            "hook_sentence",
            "final_takeaway_sentence",
            "thesis",
            "context_summary",
        )
    }
    cues = _build_word_cues(
        transcript,
        actual_start,
        caption_end,
        speech_start=(
            float(candidate["speech_start_time"])
            if candidate.get("speech_start_time") is not None
            else None
        ),
        caption_style=BF_EDITORIAL_INSET_V1,
        caption_context=caption_context,
        render_profile=BF_EDITORIAL_INSET_V1,
        display_end=caption_display_end,
    )
    edit_plan = build_edit_plan(
        decision,
        candidate,
        caption_cues=cues,
        source_cuts=candidate.get("source_scene_change_times") or [],
        artificial_cuts=(),
        timeline_events=[
            {
                "type": "caption_word",
                "timeSeconds": round(float(cue["start"]), 3),
                "text": str(cue.get("text") or ""),
            }
            for cue in cues
        ],
    )

    settings = render_settings_for_content(
        MOTIVATIONAL_PODCAST,
        render_profile=BF_EDITORIAL_INSET_V1,
        selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        format_profile=BF_VIRAL_MICRO_V1,
    )
    render_candidate = {
        **candidate,
        **settings,
        "brand_tail_profile": BF_SMOOTH_TAIL_V5,
        "brand_tail_seconds": brand_tail_seconds,
    }
    return {
        "decision": decision,
        "experiment": experiment,
        "editPlan": edit_plan,
        "renderCandidate": render_candidate,
    }


def _promote_rendered_short(
    short: Dict,
    output_root: Path,
    output_index: int,
) -> Dict:
    """Move one isolated renderer output into its deterministic batch slot."""
    if short.get("error") or not short.get("clip_url"):
        return short
    rendered_path = Path(str(short["clip_url"]))
    final_path = output_root / f"short_{output_index:02d}.mp4"
    rendered_path.replace(final_path)
    return {**short, "clip_url": str(final_path)}


def _finalize_rendered_candidate(prepared: Dict, short: Dict) -> Dict:
    """Run the unchanged manifest and QA chain for one rendered candidate."""
    from .local.visual_features import analyze_rendered_cut_metrics

    decision = prepared["decision"]
    experiment = prepared["experiment"]
    edit_plan = prepared["editPlan"]
    if short.get("error") or not short.get("clip_url"):
        raise ArtifactBindingError(
            f"approved candidate render failed: {short.get('error') or 'missing output'}"
        )
    [short] = analyze_rendered_cut_metrics([short])
    if not short.get("artificial_cut_guardrail_pass"):
        raise ArtifactBindingError("approved render contains an undeclared artificial cut")
    media = _probe_video(str(short["clip_url"]))
    if (media["width"], media["height"]) != (1080, 1920):
        raise ArtifactBindingError("approved render does not match 1080x1920")
    render_manifest = build_render_manifest(
        edit_plan,
        str(short["clip_url"]),
        duration_seconds=media["durationSeconds"],
        fps=media["fps"],
        first_visible_text_seconds=float(short.get("first_visible_text_seconds") or 0.0),
        max_hero_scale=float(short.get("max_hero_scale") or 0.0),
        brand_tail_seconds=float(short.get("brand_tail_seconds") or 0.0),
        semantic_end_seconds=float(short.get("semantic_end_seconds") or 0.0),
        brand_tail_start_seconds=float(short.get("brand_tail_start_seconds") or 0.0),
        type_plan_summary=short.get("type_plan_summary") or {},
        timeline_events=short.get("render_timeline_events") or [],
        brand_tail_profile=str(short.get("brand_tail_profile") or BF_SMOOTH_TAIL_V5),
        natural_tail_seconds=float(short.get("natural_tail_seconds") or 0.0),
        transition_tail_seconds=float(short.get("transition_tail_seconds") or 0.0),
        audio_transition_tail_seconds=float(
            short.get("audio_transition_tail_seconds") or 0.0
        ),
        speech_audio_end_time=(
            float(short["speech_audio_end_time"])
            if short.get("speech_audio_end_time") is not None
            else None
        ),
        semantic_source_margin_seconds=float(
            short.get("semantic_source_margin_seconds") or 0.0
        ),
        music_release_tail_seconds=float(
            short.get("music_release_tail_seconds") or 0.0
        ),
        freeze_hold_seconds=float(short.get("freeze_hold_seconds") or 0.0),
        source_content_end_time=(
            float(short["source_content_end_time"])
            if short.get("source_content_end_time") is not None
            else None
        ),
        next_spoken_word_start=(
            float(short["next_spoken_word_start"])
            if short.get("next_spoken_word_start") is not None
            else None
        ),
        next_speech_safety_seconds=float(
            short.get("next_speech_safety_seconds") or 0.04
        ),
        acoustic_speech_end_time=(
            float(short["acoustic_speech_end_time"])
            if short.get("acoustic_speech_end_time") is not None
            else None
        ),
        transcript_next_spoken_word_start=(
            float(short["transcript_next_spoken_word_start"])
            if short.get("transcript_next_spoken_word_start") is not None
            else None
        ),
        acoustic_boundary_source=str(
            short.get("acoustic_boundary_source") or "transcript"
        ),
        verified_acoustic_speech_end_time=(
            float(short["verified_acoustic_speech_end_time"])
            if short.get("verified_acoustic_speech_end_time") is not None
            else None
        ),
        verified_next_spoken_word_start=(
            float(short["verified_next_spoken_word_start"])
            if short.get("verified_next_spoken_word_start") is not None
            else None
        ),
        verified_next_speech_safety_seconds=(
            float(short["verified_next_speech_safety_seconds"])
            if short.get("verified_next_speech_safety_seconds") is not None
            else None
        ),
        verified_acoustic_boundary_evidence=short.get(
            "verified_acoustic_boundary_evidence"
        ),
        verified_visual_safe_end_time=(
            float(short["verified_visual_safe_end_time"])
            if short.get("verified_visual_safe_end_time") is not None
            else None
        ),
        verified_visual_boundary_evidence=short.get(
            "verified_visual_boundary_evidence"
        ),
        visual_safe_end_guard_passed=(
            bool(short.get("visual_safe_end_guard_passed"))
            if short.get("verified_visual_safe_end_time") is not None
            else None
        ),
        source_speech_leak_guard_passed=bool(
            short.get("source_speech_leak_guard_passed")
        ),
    )
    qa_report = evaluate_editorial_render(
        str(short["clip_url"]),
        render_manifest=render_manifest,
    )
    qa_report = verify_seal(qa_report, "CreativeQaReport")
    if qa_report.get("renderManifestHash") != render_manifest["contentHash"]:
        raise ArtifactBindingError(
            "approved render creative QA is not bound to the render manifest"
        )
    if not qa_report["passed"]:
        failed = ",".join(
            gate["code"] for gate in qa_report["gates"] if not gate["passed"]
        )
        raise ArtifactBindingError(f"approved render QA failed: {failed}")
    audio_qa_report = evaluate_audio_delivery(
        str(short["clip_url"]),
        float(short["brand_tail_seconds"]),
        brand_tail_profile=str(
            short.get("brand_tail_profile") or BF_SMOOTH_TAIL_V5
        ),
    )
    audio_qa_report = verify_seal(audio_qa_report, "AudioQaReport")
    if audio_qa_report.get("outputHash") != render_manifest["outputHash"]:
        raise ArtifactBindingError(
            "approved render audio QA is not bound to the rendered output"
        )
    if not audio_qa_report["passed"]:
        failed = ",".join(
            gate["code"] for gate in audio_qa_report["gates"] if not gate["passed"]
        )
        raise ArtifactBindingError(f"approved render audio QA failed: {failed}")
    return {
        "schemaVersion": 1,
        "candidateDecision": decision,
        "experimentManifest": experiment,
        "editPlan": edit_plan,
        "renderManifest": render_manifest,
        "creativeQaReport": qa_report,
        "audioQaReport": audio_qa_report,
        "short": short,
    }


def _render_prepared_candidate(
    source_path: str,
    transcript: Dict,
    prepared: Dict,
    output_dir: str,
    *,
    output_index: int = 1,
    isolate_output: bool = False,
    telemetry: Optional[Any] = None,
) -> Dict:
    """Render and finalize one prepared candidate."""
    from .local.clipper import crop_highlights_local

    output_root = Path(output_dir)
    output_root.mkdir(parents=True, exist_ok=True)
    with _timed(telemetry, "production.render_cache_lookup", index=output_index):
        cached_short, render_cache, render_cache_key = _cached_short_for_job(
            prepared,
            output_root,
            output_index,
            telemetry=telemetry,
        )
    if cached_short is not None:
        with _timed(
            telemetry,
            "production.qa",
            index=output_index,
            cacheHit=True,
        ):
            return _finalize_rendered_candidate(prepared, cached_short)

    def render_once(render_dir: str) -> Dict:
        [rendered] = crop_highlights_local(
            source_path,
            [prepared["renderCandidate"]],
            aspect_ratio="9:16",
            out_dir=render_dir,
            transcript=transcript,
            render_profile=BF_EDITORIAL_INSET_V1,
            brand_tail_profile=BF_SMOOTH_TAIL_V5,
        )
        return rendered

    with _timed(telemetry, "production.render", index=output_index):
        if isolate_output:
            with TemporaryDirectory(
                prefix=f".short-{output_index:02d}-",
                dir=str(output_root),
            ) as temporary_dir:
                short = render_once(temporary_dir)
                short = _promote_rendered_short(short, output_root, output_index)
        else:
            short = render_once(str(output_root))
    with _timed(
        telemetry,
        "production.qa",
        index=output_index,
        cacheHit=False,
    ):
        result = _finalize_rendered_candidate(prepared, short)
    _store_render_cache(render_cache, render_cache_key, result)
    return result


def _render_verified_candidate(
    source_path: str,
    transcript: Dict,
    decision: Dict,
    experiment: Dict,
    output_dir: str,
    *,
    output_index: int = 1,
    isolate_output: bool = False,
    telemetry: Optional[Any] = None,
) -> Dict:
    """Prepare, render, and finalize one verified production job."""
    with _timed(telemetry, "production.prepare", index=output_index):
        prepared = _prepare_verified_candidate(transcript, decision, experiment)
    return _render_prepared_candidate(
        source_path,
        transcript,
        prepared,
        output_dir,
        output_index=output_index,
        isolate_output=isolate_output,
        telemetry=telemetry,
    )


def render_approved_candidate(
    source_path: str,
    transcript: Dict,
    candidate_decision: Dict,
    experiment_manifest: Dict,
    output_dir: str,
    *,
    telemetry: Optional[Any] = None,
) -> Dict:
    """Render only the exact approved candidate and return its sealed artifacts."""
    decision, experiment = _verify_production_job(
        candidate_decision,
        experiment_manifest,
    )
    with _timed(telemetry, "production.source_verification"):
        source_hash = file_sha256(source_path)
    if source_hash != decision["sourceHash"]:
        raise ArtifactBindingError("source file does not match the approved candidate")
    resolved_transcript = _resolve_shared_transcript(transcript, source_hash)
    return _render_verified_candidate(
        source_path,
        resolved_transcript,
        decision,
        experiment,
        output_dir,
        telemetry=telemetry,
    )


def _failed_batch_result(
    index: int,
    candidate_hash: Optional[str],
    error: Exception,
) -> Dict:
    return {
        "index": index,
        "candidateHash": candidate_hash,
        "status": "failed",
        "error": {
            "type": type(error).__name__,
            "message": str(error),
        },
    }


def _render_shared_enhancer_batch(
    source_path: str,
    transcript: Dict,
    prepared_jobs: List[Dict],
    output_dir: str,
) -> Dict[int, object]:
    """Invoke the renderer once so its shared Real-ESRGAN prewarm is reachable."""
    from .local.clipper import crop_highlights_local

    output_root = Path(output_dir)
    output_root.mkdir(parents=True, exist_ok=True)
    try:
        with TemporaryDirectory(
            prefix=".approved-enhancer-batch-",
            dir=str(output_root),
        ) as temporary_dir:
            rendered = crop_highlights_local(
                source_path,
                [job["prepared"]["renderCandidate"] for job in prepared_jobs],
                aspect_ratio="9:16",
                out_dir=temporary_dir,
                transcript=transcript,
                render_profile=BF_EDITORIAL_INSET_V1,
                brand_tail_profile=BF_SMOOTH_TAIL_V5,
                _allow_parallel=False,
            )
            if len(rendered) != len(prepared_jobs):
                raise ArtifactBindingError(
                    "approved batch renderer returned an unexpected result count"
                )
            outcomes: Dict[int, object] = {}
            for job, short in zip(prepared_jobs, rendered):
                try:
                    outcomes[job["index"]] = _promote_rendered_short(
                        short,
                        output_root,
                        job["index"] + 1,
                    )
                except Exception as error:
                    outcomes[job["index"]] = error
            return outcomes
    except Exception as error:
        return {job["index"]: error for job in prepared_jobs}


def render_approved_candidates(
    source_path: str,
    transcript: Dict,
    candidate_decisions: Iterable[Dict],
    experiment_manifests: Iterable[Dict],
    output_dir: str,
    *,
    max_workers: int = 2,
    serialize_gpu_renders: Optional[bool] = None,
    telemetry: Optional[Any] = None,
) -> Dict:
    """Render an approved batch with shared verification and isolated outcomes.

    Results always retain input order. Artifact or render failures affect only
    their own result entry. Sources that genuinely need Real-ESRGAN share one
    renderer invocation so GPU jobs cannot overlap. Sufficient-resolution
    editorial panels use the bounded CPU render path instead.
    """
    decisions: List[Dict] = list(candidate_decisions)
    experiments: List[Dict] = list(experiment_manifests)
    if not decisions:
        raise ValueError("candidate_decisions must contain at least one artifact")
    if len(decisions) != len(experiments):
        raise ValueError(
            "candidate_decisions and experiment_manifests must have equal length"
        )
    try:
        requested_workers = int(max_workers)
    except (TypeError, ValueError) as error:
        raise ValueError("max_workers must be a positive integer") from error
    if requested_workers < 1:
        raise ValueError("max_workers must be a positive integer")

    with _timed(telemetry, "production.source_verification"):
        source_hash = file_sha256(source_path)
        resolved_transcript = _resolve_shared_transcript(transcript, source_hash)
    worker_count = min(requested_workers, len(decisions))
    gpu_serialized = (
        _real_esrgan_required_for_source(source_path)
        if serialize_gpu_renders is None
        else bool(serialize_gpu_renders)
    )
    ordered_results: List[Optional[Dict]] = [None] * len(decisions)
    prepared_jobs: List[Dict] = []
    for index, candidate_decision in enumerate(decisions):
        candidate_hash = _candidate_hash_hint(candidate_decision)
        try:
            decision, experiment = _verify_production_job(
                candidate_decision,
                experiments[index],
            )
            candidate_hash = decision["candidateHash"]
            if decision["sourceHash"] != source_hash:
                raise ArtifactBindingError(
                    "source file does not match the approved candidate"
                )
            with _timed(telemetry, "production.prepare", index=index + 1):
                prepared_jobs.append(
                    {
                        "index": index,
                        "candidateHash": candidate_hash,
                        "prepared": _prepare_verified_candidate(
                            resolved_transcript,
                            decision,
                            experiment,
                        ),
                    }
                )
        except Exception as error:
            ordered_results[index] = _failed_batch_result(
                index,
                candidate_hash,
                error,
            )

    shared_render_outcomes: Dict[int, object] = {}
    if gpu_serialized and prepared_jobs:
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)
        render_misses = []
        for job in prepared_jobs:
            with _timed(
                telemetry,
                "production.render_cache_lookup",
                index=job["index"] + 1,
            ):
                cached_short, render_cache, render_cache_key = _cached_short_for_job(
                    job["prepared"],
                    output_root,
                    job["index"] + 1,
                    telemetry=telemetry,
                )
            job["renderCache"] = render_cache
            job["renderCacheKey"] = render_cache_key
            if cached_short is not None:
                shared_render_outcomes[job["index"]] = cached_short
            else:
                render_misses.append(job)
        if render_misses:
            with _timed(
                telemetry,
                "production.render_batch",
                clipCount=len(render_misses),
                sharedEnhancer=True,
            ):
                shared_render_outcomes.update(
                    _render_shared_enhancer_batch(
                        source_path,
                        resolved_transcript,
                        render_misses,
                        output_dir,
                    )
                )

    def complete_job(job: Dict) -> Dict:
        index = job["index"]
        candidate_hash = job["candidateHash"]
        try:
            if gpu_serialized:
                rendered = shared_render_outcomes[index]
                if isinstance(rendered, Exception):
                    raise rendered
                with _timed(
                    telemetry,
                    "production.qa",
                    index=index + 1,
                    cacheHit=bool(rendered.get("render_cache_hit")),
                ):
                    result = _finalize_rendered_candidate(
                        job["prepared"],
                        rendered,
                    )
                if not rendered.get("render_cache_hit"):
                    _store_render_cache(
                        job.get("renderCache"),
                        job.get("renderCacheKey"),
                        result,
                    )
            else:
                result = _render_prepared_candidate(
                    source_path,
                    resolved_transcript,
                    job["prepared"],
                    output_dir,
                    output_index=index + 1,
                    isolate_output=True,
                    telemetry=telemetry,
                )
            return {
                "index": index,
                "candidateHash": candidate_hash,
                "status": "succeeded",
                "cacheHit": bool(result.get("short", {}).get("render_cache_hit")),
                "result": result,
            }
        except Exception as error:
            return _failed_batch_result(index, candidate_hash, error)

    if prepared_jobs:
        completion_workers = min(worker_count, len(prepared_jobs))
        with ThreadPoolExecutor(
            max_workers=completion_workers,
            thread_name_prefix="approved-short",
        ) as executor:
            futures = [
                executor.submit(complete_job, job)
                for job in prepared_jobs
            ]
            for job, future in zip(prepared_jobs, futures):
                ordered_results[job["index"]] = future.result()

    finalized_results = [
        result
        for result in ordered_results
        if result is not None
    ]
    if len(finalized_results) != len(decisions):  # pragma: no cover
        raise RuntimeError("approved batch lost a result")

    succeeded = sum(
        result["status"] == "succeeded"
        for result in finalized_results
    )
    return {
        "schemaVersion": 1,
        "sourceHash": source_hash,
        "requestedCount": len(decisions),
        "succeededCount": succeeded,
        "failedCount": len(decisions) - succeeded,
        "maxWorkers": worker_count,
        "gpuRendersSerialized": gpu_serialized,
        "results": finalized_results,
    }


render_approved_batch = render_approved_candidates


__all__ = [
    "render_approved_batch",
    "render_approved_candidate",
    "render_approved_candidates",
]
