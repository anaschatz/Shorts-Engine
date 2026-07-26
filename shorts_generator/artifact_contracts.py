"""Hash-linked artifacts for the Budget Friendly learning loop.

These helpers are intentionally storage-agnostic.  The Python media worker can
emit the artifacts and the Node control plane can persist/approve them without
trusting mutable filenames or candidate dictionaries.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Dict, Iterable, Optional

from .profiles import (
    BF_REFERENCE_TAIL_V2,
    BF_SMOOTH_TAIL_V3,
    BF_SMOOTH_TAIL_V4,
    BF_SMOOTH_TAIL_V5,
)


VOLATILE_CANDIDATE_FIELDS = frozenset(
    {
        "clip_url",
        "error",
        "render_error",
        "youtube_upload",
        "candidate_hash",
        "selected_for_render",
        "output_rank",
        "batch_exclusion_reason",
        "selection_rank",
        "shot_index_cache_path",
        "cache_path",
        "candidate_cache_path",
        "transcript_cache_path",
    }
)
ALLOWED_RIGHTS_STATUSES = frozenset({"owned", "licensed", "permission_granted"})
PRODUCTION_CONTENT_PROFILE = "motivational_podcast"
PRODUCTION_SELECTION_PROFILE = "motivational_tension_micro_v1"
PRODUCTION_RENDER_PROFILE = "bf_editorial_inset_v1"
PRODUCTION_FORMAT_PROFILE = "bf_viral_micro_v1"


class ArtifactBindingError(ValueError):
    """Raised when an artifact is missing evidence or references stale input."""


def canonical_json(value) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        default=str,
    )


def content_hash(value) -> str:
    if isinstance(value, dict):
        value = {key: item for key, item in value.items() if key != "contentHash"}
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _hash(value: str, field: str) -> str:
    normalized = str(value or "").strip().lower().removeprefix("sha256:")
    if len(normalized) != 64 or any(char not in "0123456789abcdef" for char in normalized):
        raise ArtifactBindingError(f"{field} must be a sha256 hash")
    return normalized


def _seal(payload: Dict) -> Dict:
    normalized = dict(payload)
    normalized.pop("contentHash", None)
    return {**normalized, "contentHash": content_hash(normalized)}


def verify_seal(artifact: Dict, artifact_type: Optional[str] = None) -> Dict:
    if not isinstance(artifact, dict):
        raise ArtifactBindingError("artifact must be an object")
    if artifact_type and artifact.get("artifactType") != artifact_type:
        raise ArtifactBindingError(f"expected {artifact_type}")
    declared = _hash(artifact.get("contentHash"), "contentHash")
    if declared != content_hash(artifact):
        raise ArtifactBindingError("artifact contentHash does not match its body")
    return artifact


def normalized_candidate(candidate: Dict) -> Dict:
    if not isinstance(candidate, dict):
        raise ArtifactBindingError("candidate must be an object")
    normalized = {
        key: value
        for key, value in candidate.items()
        if key not in VOLATILE_CANDIDATE_FIELDS and key != "contentHash"
    }
    for field in ("start_time", "end_time"):
        if field not in normalized:
            raise ArtifactBindingError(f"candidate.{field} is required")
    if float(normalized["end_time"]) <= float(normalized["start_time"]):
        raise ArtifactBindingError("candidate interval is invalid")
    return normalized


def candidate_hash(candidate: Dict, source_hash: str) -> str:
    return content_hash(
        {
            "sourceHash": _hash(source_hash, "sourceHash"),
            "candidate": normalized_candidate(candidate),
        }
    )


def _semantic_source_cut_limit(candidate: Dict, source_cuts: Iterable[float]) -> int:
    cuts = sorted(float(value) for value in source_cuts)
    if not candidate.get("semantic_completion_source_cut_exception"):
        return 2
    if (
        candidate.get("semantic_extension_applied") is not True
        or candidate.get("semantic_continuation_required") is True
        or int(candidate.get("semantic_completion_added_source_cuts") or 0) != 1
        or int(candidate.get("artificial_cut_count") or 0) > 0
        or int(candidate.get("composite_edit_count") or 0) > 0
    ):
        raise ArtifactBindingError("semantic source-cut exception evidence is invalid")
    try:
        extension_start = float(candidate["semantic_extension_start_time"])
        extension_end = float(candidate["semantic_extension_end_time"])
    except (KeyError, TypeError, ValueError):
        raise ArtifactBindingError("semantic source-cut exception lacks extension bounds")
    extension_cuts = [
        value for value in cuts if extension_start < value <= extension_end + 0.001
    ]
    pre_extension_cuts = [value for value in cuts if value <= extension_start + 0.001]
    if len(cuts) != 3 or len(extension_cuts) != 1 or len(pre_extension_cuts) > 2:
        raise ArtifactBindingError("semantic source-cut exception exceeds its one-cut allowance")
    return 3


def build_candidate_decision(
    candidate: Dict,
    source_hash: str,
    reviewer: str,
    decided_at: str,
    ranking_manifest_hash: str,
    notes: str = "",
) -> Dict:
    reviewer = str(reviewer or "").strip()
    decided_at = str(decided_at or "").strip()
    if not reviewer or not decided_at:
        raise ArtifactBindingError("reviewer and decided_at are required")
    source_hash = _hash(source_hash, "sourceHash")
    ranking_manifest_hash = _hash(ranking_manifest_hash, "rankingManifestHash")
    if ranking_manifest_hash == "0" * 64:
        raise ArtifactBindingError("placeholder ranking manifest hash is forbidden")
    normalized = normalized_candidate(candidate)
    if normalized.get("rejected") is not False or normalized.get("rejection_reasons"):
        raise ArtifactBindingError("only an eligible non-rejected candidate can be approved")
    expected_profiles = {
        "content_profile": PRODUCTION_CONTENT_PROFILE,
        "selection_profile": PRODUCTION_SELECTION_PROFILE,
        "render_profile": PRODUCTION_RENDER_PROFILE,
        "format_profile": PRODUCTION_FORMAT_PROFILE,
    }
    for field, expected in expected_profiles.items():
        if str(normalized.get(field) or "").strip().lower() != expected:
            raise ArtifactBindingError(f"candidate.{field} does not match the production profile")
    speech_start = normalized.get("speech_start_time")
    speech_end = normalized.get("speech_end_time")
    duration = (
        float(speech_end) - float(speech_start)
        if speech_start is not None and speech_end is not None
        else float(normalized["end_time"]) - float(normalized["start_time"])
    )
    if not 8.0 <= duration <= 22.0:
        raise ArtifactBindingError("candidate duration is outside the approved micro profile")
    source_cuts = normalized.get("source_scene_change_times") or []
    source_cut_limit = _semantic_source_cut_limit(normalized, source_cuts)
    if (
        int(normalized.get("source_cut_count") or len(source_cuts)) > source_cut_limit
        or len(source_cuts) > source_cut_limit
    ):
        raise ArtifactBindingError("candidate exceeds the production source-cut limit")
    actual_candidate_hash = candidate_hash(normalized, source_hash)
    if _hash(candidate.get("candidate_hash"), "candidate.candidate_hash") != actual_candidate_hash:
        raise ArtifactBindingError("candidate hash does not match the sealed ranking candidate")
    return _seal(
        {
            "schemaVersion": 1,
            "artifactType": "CandidateDecision",
            "decision": "approved",
            "rankingManifestHash": ranking_manifest_hash,
            "sourceHash": source_hash,
            "candidateHash": actual_candidate_hash,
            "contentProfile": PRODUCTION_CONTENT_PROFILE,
            "selectionProfile": PRODUCTION_SELECTION_PROFILE,
            "renderProfile": PRODUCTION_RENDER_PROFILE,
            "formatProfile": PRODUCTION_FORMAT_PROFILE,
            "candidate": normalized,
            "reviewer": reviewer,
            "decidedAt": decided_at,
            "notes": str(notes or "").strip(),
        }
    )


def build_source_asset_manifest(
    canonical_url: str,
    local_path: str,
    speaker: str,
    owner: str,
    rights_status: str,
    license_evidence: str,
    allowed_transformations: Iterable[str],
    allowed_platforms: Iterable[str],
    attribution_text: str,
    reviewed_at: str,
    expires_at: Optional[str] = None,
) -> Dict:
    path = Path(local_path)
    if not path.is_file():
        raise ArtifactBindingError("source asset does not exist")
    rights_status = str(rights_status or "").strip().lower()
    if rights_status not in ALLOWED_RIGHTS_STATUSES:
        raise ArtifactBindingError("source rights are not publishable")
    platforms = sorted({str(value).strip().lower() for value in allowed_platforms if str(value).strip()})
    transformations = sorted(
        {str(value).strip().lower() for value in allowed_transformations if str(value).strip()}
    )
    if "youtube" not in platforms or not transformations:
        raise ArtifactBindingError("source permissions are incomplete")
    required = (canonical_url, speaker, owner, license_evidence, attribution_text, reviewed_at)
    if any(not str(value or "").strip() for value in required):
        raise ArtifactBindingError("source provenance fields are required")
    payload = {
        "schemaVersion": 1,
        "artifactType": "SourceAssetManifest",
        "canonicalUrl": str(canonical_url).strip(),
        "localPath": str(path.resolve()),
        "sourceHash": file_sha256(str(path)),
        "speaker": str(speaker).strip(),
        "owner": str(owner).strip(),
        "rightsStatus": rights_status,
        "licenseEvidence": str(license_evidence).strip(),
        "allowedTransformations": transformations,
        "allowedPlatforms": platforms,
        "attributionText": str(attribution_text).strip(),
        "reviewedAt": str(reviewed_at).strip(),
        "expiresAt": str(expires_at).strip() if expires_at else None,
    }
    return _seal(payload)


def build_edit_plan(
    candidate_decision: Dict,
    candidate: Dict,
    caption_cues: Iterable[Dict],
    source_cuts: Iterable[float] = (),
    artificial_cuts: Iterable[float] = (),
    timeline_events: Iterable[Dict] = (),
) -> Dict:
    decision = verify_seal(candidate_decision, "CandidateDecision")
    ranking_manifest_hash = _hash(
        decision.get("rankingManifestHash"),
        "candidateDecision.rankingManifestHash",
    )
    actual_candidate_hash = candidate_hash(candidate, decision["sourceHash"])
    if decision.get("decision") != "approved" or decision["candidateHash"] != actual_candidate_hash:
        raise ArtifactBindingError("candidate was edited after approval")
    artificial = [float(value) for value in artificial_cuts]
    if artificial:
        raise ArtifactBindingError("bf_editorial_inset_v1 permits zero artificial cuts")
    source = sorted(float(value) for value in source_cuts)
    source_cut_limit = _semantic_source_cut_limit(candidate, source)
    if len(source) > source_cut_limit:
        raise ArtifactBindingError(
            "bf_editorial_inset_v1 exceeds its source-cut policy"
        )
    return _seal(
        {
            "schemaVersion": 1,
            "artifactType": "EditPlan",
            "rankingManifestHash": ranking_manifest_hash,
            "candidateDecisionHash": decision["contentHash"],
            "candidateHash": actual_candidate_hash,
            "sourceHash": decision["sourceHash"],
            "renderProfile": "bf_editorial_inset_v1",
            "formatProfile": "bf_viral_micro_v1",
            "captionCues": list(caption_cues),
            "sourceCutTimes": source,
            "sourceCutLimit": source_cut_limit,
            "semanticCompletionSourceCutException": bool(
                source_cut_limit == 3
            ),
            "artificialCutTimes": [],
            "timelineEvents": list(timeline_events),
        }
    )


def build_render_manifest(
    edit_plan: Dict,
    output_path: str,
    duration_seconds: float,
    fps: float,
    first_visible_text_seconds: float,
    max_hero_scale: float,
    brand_tail_seconds: float,
    renderer_version: str = "bf_editorial_renderer_v1",
    semantic_end_seconds: Optional[float] = None,
    brand_tail_start_seconds: Optional[float] = None,
    type_plan_summary: Optional[Dict] = None,
    timeline_events: Iterable[Dict] = (),
    brand_tail_profile: str = BF_REFERENCE_TAIL_V2,
    natural_tail_seconds: float = 0.0,
    transition_tail_seconds: float = 0.0,
    audio_transition_tail_seconds: float = 0.0,
    speech_audio_end_time: Optional[float] = None,
    semantic_source_margin_seconds: float = 0.0,
    music_release_tail_seconds: float = 0.0,
    freeze_hold_seconds: float = 0.0,
    source_content_end_time: Optional[float] = None,
    next_spoken_word_start: Optional[float] = None,
    next_speech_safety_seconds: float = 0.04,
    source_speech_leak_guard_passed: Optional[bool] = None,
    acoustic_speech_end_time: Optional[float] = None,
    transcript_next_spoken_word_start: Optional[float] = None,
    acoustic_boundary_source: str = "transcript",
    verified_acoustic_speech_end_time: Optional[float] = None,
    verified_next_spoken_word_start: Optional[float] = None,
    verified_next_speech_safety_seconds: Optional[float] = None,
    verified_acoustic_boundary_evidence: Optional[str] = None,
    verified_visual_safe_end_time: Optional[float] = None,
    verified_visual_boundary_evidence: Optional[str] = None,
    visual_safe_end_guard_passed: Optional[bool] = None,
) -> Dict:
    plan = verify_seal(edit_plan, "EditPlan")
    path = Path(output_path)
    if not path.is_file():
        raise ArtifactBindingError("render output does not exist")
    duration = float(duration_seconds)
    if not 8.0 <= duration <= 24.5:
        raise ArtifactBindingError("render duration is outside the micro profile")
    tail_profile = str(brand_tail_profile or "").strip().lower()
    boundary_source = str(acoustic_boundary_source or "transcript").strip().lower()
    if boundary_source not in {"transcript", "candidate_verified_acoustic"}:
        raise ArtifactBindingError("unknown acoustic tail boundary source")
    verified_boundary_values = (
        verified_acoustic_speech_end_time,
        verified_next_spoken_word_start,
        verified_next_speech_safety_seconds,
    )
    has_verified_boundary = any(
        value is not None for value in verified_boundary_values
    )
    if has_verified_boundary != (boundary_source == "candidate_verified_acoustic"):
        raise ArtifactBindingError(
            "verified acoustic timing must declare its candidate boundary source"
        )
    if has_verified_boundary:
        if not all(value is not None for value in verified_boundary_values):
            raise ArtifactBindingError(
                "verified acoustic timing requires speech end, next word, and safety"
            )
        verified_acoustic_end = float(verified_acoustic_speech_end_time)
        verified_next_word = float(verified_next_spoken_word_start)
        verified_safety = float(verified_next_speech_safety_seconds)
        if acoustic_speech_end_time is None or abs(
            float(acoustic_speech_end_time) - verified_acoustic_end
        ) > 0.001:
            raise ArtifactBindingError(
                "effective acoustic speech end does not match verified evidence"
            )
        if next_spoken_word_start is None or abs(
            float(next_spoken_word_start) - verified_next_word
        ) > 0.001:
            raise ArtifactBindingError(
                "effective next spoken word does not match verified evidence"
            )
        if abs(float(next_speech_safety_seconds) - verified_safety) > 0.001:
            raise ArtifactBindingError(
                "effective next-speech safety does not match verified evidence"
            )
        if (
            source_content_end_time is None
            or float(source_content_end_time)
            > verified_next_word - verified_safety + 0.001
        ):
            raise ArtifactBindingError(
                "verified source tail crosses its pre-speech safety boundary"
            )
    visual_boundary_evidence = (
        str(verified_visual_boundary_evidence or "").strip() or None
    )
    if visual_boundary_evidence is not None and verified_visual_safe_end_time is None:
        raise ArtifactBindingError(
            "verified visual boundary evidence requires a visual safe-end time"
        )
    verified_visual_end = None
    if verified_visual_safe_end_time is not None:
        if tail_profile not in {BF_SMOOTH_TAIL_V4, BF_SMOOTH_TAIL_V5}:
            raise ArtifactBindingError(
                "verified visual safe-end timing requires smooth-tail v4 or v5"
            )
        verified_visual_end = float(verified_visual_safe_end_time)
        if not math.isfinite(verified_visual_end):
            raise ArtifactBindingError(
                "verified visual safe-end timing must be finite"
            )
        if source_content_end_time is None or (
            float(source_content_end_time) > verified_visual_end + 0.001
        ):
            raise ArtifactBindingError(
                "source tail crosses its verified visual safe-end boundary"
            )
        if (
            acoustic_speech_end_time is not None
            and verified_visual_end
            < float(acoustic_speech_end_time) - 0.001
        ):
            raise ArtifactBindingError(
                "verified visual safe end cannot precede acoustic speech end"
            )
        if visual_safe_end_guard_passed is not True:
            raise ArtifactBindingError(
                "verified visual safe-end timing requires guard evidence"
            )
    elif visual_safe_end_guard_passed not in (None, False):
        raise ArtifactBindingError(
            "visual safe-end guard cannot be asserted without a verified boundary"
        )
    if tail_profile == BF_REFERENCE_TAIL_V2:
        if not 1.15 <= float(brand_tail_seconds) <= 1.35:
            raise ArtifactBindingError(
                "reference-matched brand hold must be 1.15..1.35 seconds"
            )
        if not 0.0 <= float(natural_tail_seconds) <= 0.75:
            raise ArtifactBindingError(
                "reference-matched natural reaction must be 0.0..0.75 seconds"
            )
        if not 0.0 <= float(transition_tail_seconds) <= 0.30:
            raise ArtifactBindingError(
                "reference-matched crossfade must be 0.0..0.30 seconds"
            )
        if abs(float(freeze_hold_seconds)) > 0.001:
            raise ArtifactBindingError("reference-matched tail forbids freeze holds")
        if source_speech_leak_guard_passed is not True:
            raise ArtifactBindingError(
                "reference-matched tail requires source-speech leak evidence"
            )
        if (
            next_spoken_word_start is not None
            and source_content_end_time is not None
            and float(source_content_end_time)
            > float(next_spoken_word_start) + 0.001
        ):
            raise ArtifactBindingError("tail source content reaches the next spoken word")
    elif tail_profile in {
        BF_SMOOTH_TAIL_V3,
        BF_SMOOTH_TAIL_V4,
        BF_SMOOTH_TAIL_V5,
    }:
        if not 0.80 <= float(brand_tail_seconds) <= 0.90:
            raise ArtifactBindingError(
                "smooth brand hold must be 0.80..0.90 seconds"
            )
        if not 0.0 <= float(natural_tail_seconds) <= 0.75:
            raise ArtifactBindingError(
                "smooth authentic source margin must be 0.0..0.75 seconds"
            )
        visual_crossfade_max = (
            0.13
            if tail_profile in {BF_SMOOTH_TAIL_V4, BF_SMOOTH_TAIL_V5}
            else 0.35
        )
        if not 0.0 <= float(transition_tail_seconds) <= visual_crossfade_max:
            raise ArtifactBindingError(
                "smooth visual crossfade must be 0.0.."
                f"{visual_crossfade_max:.2f} seconds"
            )
        if not 0.0 <= float(audio_transition_tail_seconds) <= 0.04:
            raise ArtifactBindingError(
                "smooth audio landing fade must be 0.0..0.04 seconds"
            )
        if not 0.0 <= float(music_release_tail_seconds) <= 0.30:
            raise ArtifactBindingError(
                "smooth music release must be 0.0..0.30 seconds"
            )
        if float(semantic_source_margin_seconds) < 0.0:
            raise ArtifactBindingError("semantic source margin cannot be negative")
        if tail_profile == BF_SMOOTH_TAIL_V5:
            if not 0.0 <= float(freeze_hold_seconds) <= 0.08:
                raise ArtifactBindingError(
                    "smooth-tail v5 permits at most an 80ms safe-frame settle"
                )
        elif abs(float(freeze_hold_seconds)) > 0.001:
            raise ArtifactBindingError("smooth tail forbids freeze holds")
        if source_speech_leak_guard_passed is not True:
            raise ArtifactBindingError(
                "smooth tail requires source-speech leak evidence"
            )
        if (
            speech_audio_end_time is not None
            and source_content_end_time is not None
            and abs(
                float(speech_audio_end_time) - float(source_content_end_time)
            ) > 0.001
        ):
            raise ArtifactBindingError(
                "smooth tail must preserve source audio to the safe source end"
            )
        if (
            next_spoken_word_start is not None
            and source_content_end_time is not None
            and float(source_content_end_time)
            > (
                float(next_spoken_word_start)
                - float(next_speech_safety_seconds)
                + 0.001
            )
        ):
            raise ArtifactBindingError(
                "smooth tail source content crosses the pre-speech guard"
            )
    elif not 0.2 <= float(brand_tail_seconds) <= 0.4:
        raise ArtifactBindingError("legacy YouTube brand tail must be 0.2..0.4 seconds")
    if float(first_visible_text_seconds) > 0.25:
        raise ArtifactBindingError("first visible text is later than 0.25 seconds")
    if float(max_hero_scale) < 1.8:
        raise ArtifactBindingError("hero scale must be at least 1.8x")
    source_cuts = list(plan.get("sourceCutTimes") or [])
    artificial_cuts = list(plan.get("artificialCutTimes") or [])
    tail_start = (
        float(brand_tail_start_seconds)
        if brand_tail_start_seconds is not None
        else duration - float(brand_tail_seconds)
    )
    semantic_end = (
        float(semantic_end_seconds)
        if semantic_end_seconds is not None
        else tail_start
    )
    if tail_start < semantic_end:
        raise ArtifactBindingError("brand tail overlaps the semantic ending")
    if tail_profile == BF_SMOOTH_TAIL_V5:
        if source_content_end_time is None:
            raise ArtifactBindingError(
                "smooth-tail v5 requires the guarded source end"
            )
        declared_transition_start = (
            tail_start - float(transition_tail_seconds)
        )
        expected_local_transition_start = (
            semantic_end
            + float(semantic_source_margin_seconds)
            + float(freeze_hold_seconds)
        )
        if abs(
            declared_transition_start - expected_local_transition_start
        ) > 0.002:
            raise ArtifactBindingError(
                "smooth-tail v5 must keep the source full-strength until its "
                "guarded end, then fade before the brand tail"
            )
        if (
            acoustic_speech_end_time is not None
            and float(source_content_end_time)
            < float(acoustic_speech_end_time) - 0.001
        ):
            raise ArtifactBindingError(
                "smooth-tail v5 picture fade cannot overlap speech"
            )
    if abs((tail_start + float(brand_tail_seconds)) - duration) > 0.08:
        raise ArtifactBindingError("brand tail does not end with the rendered output")
    return _seal(
        {
            "schemaVersion": 1,
            "artifactType": "RenderManifest",
            "rankingManifestHash": plan["rankingManifestHash"],
            "candidateDecisionHash": plan["candidateDecisionHash"],
            "candidateHash": plan["candidateHash"],
            "sourceHash": plan["sourceHash"],
            "editPlanHash": plan["contentHash"],
            "formatProfile": plan["formatProfile"],
            "selectionProfile": "motivational_tension_micro_v1",
            "renderProfile": plan["renderProfile"],
            "rendererVersion": str(renderer_version),
            "layout": "editorial_inset",
            "grade": "high_contrast_grayscale_v1",
            "captionStyle": "kinetic_editorial_v1",
            "outputPath": str(path.resolve()),
            "outputHash": file_sha256(str(path)),
            "durationSeconds": round(duration, 3),
            "fps": round(float(fps), 3),
            "timeline": {
                "firstVisibleTextSeconds": round(float(first_visible_text_seconds), 3),
                "semanticEndSeconds": round(semantic_end, 3),
                "events": list(timeline_events),
            },
            "typography": {
                "maxHeroScale": round(float(max_hero_scale), 3),
                "typePlanSummary": dict(type_plan_summary or {}),
            },
            "cuts": {
                "sourceCutCount": len(source_cuts),
                "sourceCutLimit": int(plan.get("sourceCutLimit") or 2),
                "semanticCompletionSourceCutException": bool(
                    plan.get("semanticCompletionSourceCutException")
                ),
                "artificialCutCount": len(artificial_cuts),
            },
            "brandTail": {
                "mark": "BF.",
                "platform": "youtube",
                "profile": tail_profile,
                "durationSeconds": round(float(brand_tail_seconds), 3),
                "startSeconds": round(tail_start, 3),
                "naturalReactionSeconds": round(float(natural_tail_seconds), 3),
                "crossfadeSeconds": round(float(transition_tail_seconds), 3),
                "visualCrossfadeSeconds": round(
                    float(transition_tail_seconds),
                    3,
                ),
                "audioFadeSeconds": round(
                    float(audio_transition_tail_seconds),
                    3,
                ),
                "speechAudioEndTime": (
                    round(float(speech_audio_end_time), 3)
                    if speech_audio_end_time is not None
                    else None
                ),
                "semanticSourceMarginSeconds": round(
                    float(semantic_source_margin_seconds),
                    3,
                ),
                "musicReleaseSeconds": round(
                    float(music_release_tail_seconds),
                    3,
                ),
                "freezeHoldSeconds": round(float(freeze_hold_seconds), 3),
                "sourceContentEndTime": (
                    round(float(source_content_end_time), 3)
                    if source_content_end_time is not None
                    else None
                ),
                "nextSpokenWordStart": (
                    round(float(next_spoken_word_start), 3)
                    if next_spoken_word_start is not None
                    else None
                ),
                "nextSpeechSafetySeconds": round(
                    float(next_speech_safety_seconds),
                    3,
                ),
                "acousticSpeechEndTime": (
                    round(float(acoustic_speech_end_time), 3)
                    if acoustic_speech_end_time is not None
                    else None
                ),
                "transcriptNextSpokenWordStart": (
                    round(float(transcript_next_spoken_word_start), 3)
                    if transcript_next_spoken_word_start is not None
                    else None
                ),
                "acousticBoundarySource": boundary_source,
                "verifiedAcousticSpeechEndTime": (
                    round(float(verified_acoustic_speech_end_time), 3)
                    if verified_acoustic_speech_end_time is not None
                    else None
                ),
                "verifiedNextSpokenWordStart": (
                    round(float(verified_next_spoken_word_start), 3)
                    if verified_next_spoken_word_start is not None
                    else None
                ),
                "verifiedNextSpeechSafetySeconds": (
                    round(float(verified_next_speech_safety_seconds), 3)
                    if verified_next_speech_safety_seconds is not None
                    else None
                ),
                "verifiedAcousticBoundaryEvidence": (
                    str(verified_acoustic_boundary_evidence or "").strip()
                    or None
                ),
                "verifiedVisualSafeEndTime": (
                    round(verified_visual_end, 3)
                    if verified_visual_end is not None
                    else None
                ),
                "verifiedVisualBoundaryEvidence": visual_boundary_evidence,
                "visualSafeEndGuardPassed": (
                    bool(visual_safe_end_guard_passed)
                    if verified_visual_end is not None
                    else None
                ),
                "sourceSpeechLeakGuardPassed": bool(
                    source_speech_leak_guard_passed
                ),
            },
        }
    )


def build_rights_manifest(
    source_hash: str,
    status: str,
    owner: str,
    evidence_reference: str,
    allowed_platforms: Iterable[str],
    music_license_reference: str,
    font_license_references: Iterable[str],
    attribution_text: str = "",
) -> Dict:
    status = str(status or "").strip().lower()
    if status not in ALLOWED_RIGHTS_STATUSES:
        raise ArtifactBindingError("source rights are not publishable")
    platforms = sorted({str(value).strip().lower() for value in allowed_platforms if str(value).strip()})
    if "youtube" not in platforms:
        raise ArtifactBindingError("rights do not permit YouTube")
    attribution = str(attribution_text or "").strip()
    if not all((owner, evidence_reference, music_license_reference, attribution)):
        raise ArtifactBindingError(
            "rights owner, evidence, music license and attribution text are required"
        )
    fonts = sorted({str(value).strip() for value in font_license_references if str(value).strip()})
    if not fonts:
        raise ArtifactBindingError("font license evidence is required")
    return _seal(
        {
            "schemaVersion": 1,
            "artifactType": "SourceRightsManifest",
            "sourceHash": _hash(source_hash, "sourceHash"),
            "rightsStatus": status,
            "owner": str(owner).strip(),
            "evidenceReference": str(evidence_reference).strip(),
            "allowedPlatforms": platforms,
            "musicLicenseReference": str(music_license_reference).strip(),
            "fontLicenseReferences": fonts,
            "attributionText": attribution,
        }
    )


def build_publish_manifest(
    render_manifest: Dict,
    qa_report: Dict,
    rights_manifest: Dict,
    experiment_manifest: Dict,
    candidate_decision: Dict,
    metadata: Dict,
    originality_report: Optional[Dict] = None,
    audio_qa_report: Optional[Dict] = None,
    privacy_status: str = "private",
    related_video_id: Optional[str] = None,
    related_video_waiver_reason: Optional[str] = None,
) -> Dict:
    render = verify_seal(render_manifest, "RenderManifest")
    rights = verify_seal(rights_manifest, "SourceRightsManifest")
    experiment = verify_seal(experiment_manifest, "ExperimentManifest")
    decision = verify_seal(candidate_decision, "CandidateDecision")
    recalculated_candidate_hash = candidate_hash(
        decision.get("candidate"),
        decision.get("sourceHash"),
    )
    if decision.get("decision") != "approved" or decision.get("candidateHash") != recalculated_candidate_hash:
        raise ArtifactBindingError("candidate decision is not an intact approval")
    if (
        render.get("candidateDecisionHash") != decision["contentHash"]
        or render.get("candidateHash") != decision["candidateHash"]
        or render.get("sourceHash") != decision["sourceHash"]
        or render.get("rankingManifestHash") != decision.get("rankingManifestHash")
    ):
        raise ArtifactBindingError("candidate decision is not bound to this render")
    if rights["sourceHash"] == "0" * 64:
        raise ArtifactBindingError("placeholder source rights are forbidden")
    if rights["sourceHash"] != render.get("sourceHash"):
        raise ArtifactBindingError("rights manifest is not bound to the rendered source")
    qa = verify_seal(qa_report, "CreativeQaReport")
    if qa.get("passed") is not True:
        raise ArtifactBindingError("creative QA must pass before publishing")
    qa_hash = qa["contentHash"]
    if qa.get("renderManifestHash") != render["contentHash"]:
        raise ArtifactBindingError("QA report is not bound to this render manifest")
    if render["outputHash"] != file_sha256(render["outputPath"]):
        raise ArtifactBindingError("render output changed after manifest creation")
    if render["candidateHash"] != experiment.get("candidateHash"):
        raise ArtifactBindingError("experiment is not bound to the approved candidate")
    if experiment.get("formatProfile") != render["formatProfile"]:
        raise ArtifactBindingError("experiment format profile does not match render")
    if not originality_report:
        raise ArtifactBindingError("originality report must pass before publishing")
    originality = verify_seal(originality_report, "OriginalityReport")
    if originality.get("passed") is not True:
        raise ArtifactBindingError("originality report must pass before publishing")
    originality_hash = originality["contentHash"]
    if originality.get("candidateHash") != render["candidateHash"]:
        raise ArtifactBindingError("originality report is not bound to the candidate")
    if originality.get("sourceHash") != render["sourceHash"]:
        raise ArtifactBindingError("originality report is not bound to the rendered source")
    if originality.get("candidateDecisionHash") != decision["contentHash"]:
        raise ArtifactBindingError("originality report is not bound to the candidate decision")
    if not audio_qa_report:
        raise ArtifactBindingError("audio QA must pass before publishing")
    audio_qa = verify_seal(audio_qa_report, "AudioQaReport")
    if audio_qa.get("passed") is not True:
        raise ArtifactBindingError("audio QA must pass before publishing")
    audio_qa_hash = audio_qa["contentHash"]
    if audio_qa.get("outputHash") != render["outputHash"]:
        raise ArtifactBindingError("audio QA is not bound to the rendered output")
    title = str(metadata.get("title") or "").strip()
    description = str(metadata.get("description") or "").strip()
    if not 1 <= len(title) <= 100 or not description:
        raise ArtifactBindingError("publish metadata is incomplete")
    attribution = str(rights.get("attributionText") or "").strip()
    if not attribution or attribution not in description:
        raise ArtifactBindingError(
            "publish description must contain rights attributionText exactly"
        )
    privacy = str(privacy_status or "").strip().lower()
    if privacy not in {"private", "unlisted", "public"}:
        raise ArtifactBindingError("invalid privacy status")
    related_video = str(related_video_id or "").strip() or None
    related_waiver = str(related_video_waiver_reason or "").strip() or None
    if not related_video and not related_waiver:
        raise ArtifactBindingError("related video or an explicit waiver is required")
    return _seal(
        {
            "schemaVersion": 1,
            "artifactType": "PublishManifest",
            "rankingManifestHash": decision["rankingManifestHash"],
            "candidateDecisionHash": decision["contentHash"],
            "candidateHash": render["candidateHash"],
            "renderManifestHash": render["contentHash"],
            "renderOutputHash": render["outputHash"],
            "qaReportHash": qa_hash,
            "originalityReportHash": originality_hash,
            "audioQaReportHash": audio_qa_hash,
            "rightsManifestHash": rights["contentHash"],
            "experimentManifestHash": experiment["contentHash"],
            "formatProfile": render["formatProfile"],
            "metadata": {**metadata, "title": title, "description": description},
            "privacyStatus": privacy,
            "relatedVideoId": related_video,
            "relatedVideoWaiverReason": related_waiver,
            "containsSyntheticMedia": bool(metadata.get("containsSyntheticMedia", False)),
        }
    )


__all__ = [
    "ALLOWED_RIGHTS_STATUSES",
    "ArtifactBindingError",
    "build_candidate_decision",
    "build_edit_plan",
    "build_publish_manifest",
    "build_render_manifest",
    "build_rights_manifest",
    "build_source_asset_manifest",
    "candidate_hash",
    "canonical_json",
    "content_hash",
    "file_sha256",
    "normalized_candidate",
    "verify_seal",
]
