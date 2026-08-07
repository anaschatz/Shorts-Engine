"""Offline, non-promoting calibration lane for DynamicMusic V1.

The lane evaluates deterministic envelope structure and exact render-evidence
bindings.  It deliberately does not decode media, call a model, infer viewer
retention, publish, or mutate the production profile.  Offline plan proxies
are safety/structure diagnostics only; a human A/B decision remains required.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import sys
import tempfile
from pathlib import Path
from typing import Dict, Iterable, Mapping, Optional, Sequence

# Support both ``python -m research.music_autoresearch_v1`` and direct script
# execution from any current working directory.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shorts_generator.artifact_contracts import content_hash, file_sha256
from shorts_generator.dynamic_music import (
    DYNAMIC_MUSIC_PLAN_VERSION,
    build_dynamic_music_plan,
    validate_dynamic_music_plan,
)


MUSIC_AUTORESEARCH_VERSION = "bf-music-autoresearch-v1.0.0"
MUSIC_PLAN_EVALUATION_VERSION = "bf-music-plan-evaluation-v1.0.0"
MUSIC_EXPERIMENT_VERSION = "bf-music-only-ab-v1.0.0"
MUSIC_REFERENCE_LABEL_VERSION = "bf-music-reference-label-v1.0.0"
MUSIC_OUTCOME_OBSERVATION_VERSION = "bf-music-outcome-observation-v1.0.0"
MUSIC_LIFECYCLE_VERSION = "bf-music-calibration-lifecycle-v1.0.0"
OBSERVED_CONTROL_BINDING_VERSION = "bf-observed-control-binding-v1.0.0"
EXPECTED_CONTRACT_CONTENT_HASH = (
    "1999076051f092a278bb19c22b6bd1caa4917e1b25a6a6c92a4033e2110c9b67"
)
DEFAULT_CONTRACT_PATH = Path(__file__).with_name(
    "music-autoresearch-v1-contract.json"
)
DEFAULT_CONTROL_PATH = Path(__file__).with_name("fixtures") / (
    "bf_music_observed_control_2026-08-07.json"
)

CALIBRATION_NOT_READY = "calibration_not_ready"
HUMAN_AB_REQUIRED = "human_ab_required"
CHANGED_AXES = ["musicTreatment"]
BLOCKED_EXIT_CODE = 2

ALLOWED_EVENT_ORDER = (
    "entry",
    "hook_hold",
    "semantic_build",
    "clarity_pocket",
    "stable_emphasis",
    "controlled_release",
    "natural_tail_hold",
    "restrained_bed",
)
EXACT_HOOK_SOURCES = frozenset({"opening_unit_exact_quote"})
EXACT_PAYOFF_SOURCES = frozenset(
    {
        "payoff_exact_quote",
        "strong_point_phrase",
        "hook_payoff_phrase",
        "final_takeaway_sentence",
    }
)
REAL_OUTCOME_SOURCES = frozenset(
    {"youtube_analytics_api", "studio_csv"}
)

# These constants are deliberately code-owned.  The JSON contract mirrors
# them, but changing a contract file alone cannot loosen the guardrails.
PLAN_GUARDRAIL_THRESHOLDS = {
    "maximumRampRatePerSecond": 1.25,
    "maximumSpeechMeanGain": 0.82,
    "maximumEntryGain": 0.55,
    "maximumTailGain": 0.75,
    "minimumDynamicRange": 0.24,
    "maximumDynamicRange": 0.58,
    "minimumBuildLift": 0.12,
    "minimumClarityPocketDepth": 0.18,
    "minimumPayoffEmphasisLift": 0.25,
    "minimumReleaseDepth": 0.15,
    "minimumContextBuildCoverage": 0.65,
}


def _seal(payload: Mapping[str, object]) -> Dict[str, object]:
    body = dict(payload)
    body.pop("contentHash", None)
    return {**body, "contentHash": content_hash(body)}


def _normalized_sha(value: object) -> str:
    return str(value or "").strip().lower().removeprefix("sha256:")


def _is_sha256(value: object) -> bool:
    normalized = _normalized_sha(value)
    return len(normalized) == 64 and all(
        character in "0123456789abcdef" for character in normalized
    )


def _verify_seal(
    artifact: Mapping[str, object],
    artifact_type: str,
) -> Dict[str, object]:
    if not isinstance(artifact, Mapping):
        raise ValueError(f"{artifact_type} must be an object")
    if artifact.get("artifactType") != artifact_type:
        raise ValueError(f"expected {artifact_type}")
    if not _is_sha256(artifact.get("contentHash")):
        raise ValueError(f"{artifact_type} contentHash is invalid")
    if _normalized_sha(artifact.get("contentHash")) != content_hash(
        dict(artifact)
    ):
        raise ValueError(f"{artifact_type} seal is invalid")
    return dict(artifact)


def load_music_autoresearch_contract(
    path: Path = DEFAULT_CONTRACT_PATH,
) -> Dict[str, object]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    contract = _verify_seal(value, "DynamicMusicAutoresearchContract")
    if contract.get("contractVersion") != MUSIC_AUTORESEARCH_VERSION:
        raise ValueError("unexpected music autoresearch contract version")
    if contract.get("contentHash") != EXPECTED_CONTRACT_CONTENT_HASH:
        raise ValueError("music autoresearch contract digest is not code-authorized")
    if contract.get("evaluationLane") != "dynamic_music_plan":
        raise ValueError("music autoresearch lane must be dynamic_music_plan")
    if contract.get("changedAxes") != CHANGED_AXES:
        raise ValueError("music autoresearch must change only musicTreatment")
    if contract.get("planVersion") != DYNAMIC_MUSIC_PLAN_VERSION:
        raise ValueError("music plan version is not bound to DynamicMusic V1")
    if contract.get("planGuardrails") != PLAN_GUARDRAIL_THRESHOLDS:
        raise ValueError("music plan guardrails do not match code-owned policy")
    if contract.get("autoPromotionAllowed") is not False:
        raise ValueError("music autoresearch can never auto-promote")
    if contract.get("liveOutcomeClaimsAllowedWithoutAnalytics") is not False:
        raise ValueError("music autoresearch cannot invent outcome labels")
    if int(contract.get("minimumSealedReferenceLabels") or 0) < 1:
        raise ValueError("music autoresearch requires sealed reference labels")
    outcome_policy = contract.get("realOutcomePolicy")
    if not isinstance(outcome_policy, Mapping):
        raise ValueError("real outcome policy is required")
    if set(outcome_policy.get("acceptedSources") or []) != set(
        REAL_OUTCOME_SOURCES
    ):
        raise ValueError("real outcome sources must match code-owned policy")
    return contract


def load_observed_music_control(
    path: Path = DEFAULT_CONTROL_PATH,
) -> Dict[str, object]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    control = _verify_seal(value, "ObservedMusicControl")
    if control.get("observedControlOnly") is not True:
        raise ValueError("control must be marked observedControlOnly")
    if control.get("performanceLabel") is not None:
        raise ValueError("observed control cannot contain a performance label")
    if control.get("musicTreatment") != "licensed_low_bed_v1":
        raise ValueError("unexpected observed control music treatment")
    for field in (
        "sourceHash",
        "transcriptTimingHash",
        "videoSha256",
        "candidateHash",
    ):
        if not _is_sha256(control.get(field)):
            raise ValueError(f"observed control {field} is invalid")
    for field in ("speechIntervalSeconds", "renderIntervalSeconds"):
        interval = control.get(field)
        if (
            not isinstance(interval, list)
            or len(interval) != 2
            or not all(isinstance(item, (int, float)) for item in interval)
            or float(interval[1]) <= float(interval[0])
        ):
            raise ValueError(f"observed control {field} is invalid")
    planning = control.get("planningInputs")
    if not isinstance(planning, Mapping):
        raise ValueError("observed control planningInputs are required")
    if not isinstance(planning.get("candidate"), Mapping):
        raise ValueError("observed control planning candidate is required")
    if not isinstance(planning.get("captionCues"), list):
        raise ValueError("observed control caption cues are required")
    if int(control.get("sourceByteLength") or 0) <= 0:
        raise ValueError("observed control sourceByteLength is required")
    support = control.get("supportingArtifacts")
    if not isinstance(support, Mapping) or set(support) != {
        "uploadReceipt",
        "targetedSelection",
        "gateDiagnostics",
        "tailPatch",
    }:
        raise ValueError("observed control supportingArtifacts are incomplete")
    return control


def _inventory(
    root: Path,
    specs: Iterable[Mapping[str, object]],
) -> list[Dict[str, object]]:
    results = []
    resolved_root = root.resolve()
    for spec in specs:
        relative = str(spec.get("path") or "").strip()
        expected_hash = _normalized_sha(spec.get("sha256"))
        expected_bytes = int(spec.get("byteLength") or 0)
        candidate = Path(relative)
        path = (resolved_root / candidate).resolve()
        bounded = (
            bool(relative)
            and not candidate.is_absolute()
            and path.is_relative_to(resolved_root)
        )
        exists = bounded and path.is_file()
        actual_bytes = path.stat().st_size if exists else None
        actual_hash = file_sha256(str(path)) if exists else None
        results.append(
            {
                "path": relative,
                "role": str(spec.get("role") or ""),
                "exists": exists,
                "pathBounded": bounded,
                "byteLength": actual_bytes,
                "byteLengthMatches": exists and actual_bytes == expected_bytes,
                "sha256Matches": exists and actual_hash == expected_hash,
                "ready": bool(
                    exists
                    and actual_bytes == expected_bytes
                    and actual_hash == expected_hash
                ),
            }
        )
    return results


def _bound_json(
    root: Path,
    spec: Mapping[str, object],
) -> Optional[Dict[str, object]]:
    inventory = _inventory(root, [spec])[0]
    if inventory["ready"] is not True:
        return None
    path = (Path(root).resolve() / str(spec["path"])).resolve()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def verify_observed_control_bindings(
    root: Path,
    control: Mapping[str, object],
) -> Dict[str, object]:
    """Cross-bind uploaded bytes, source bytes, transcript and intervals."""
    support = control.get("supportingArtifacts")
    if not isinstance(support, Mapping):
        support = {}
    required_names = (
        "uploadReceipt",
        "targetedSelection",
        "gateDiagnostics",
        "tailPatch",
    )
    support_inventory = {
        name: _inventory(root, [support.get(name) or {}])[0]
        for name in required_names
    }
    loaded = {
        name: _bound_json(root, support.get(name) or {})
        for name in required_names
    }
    gates = [
        _gate(
            f"CONTROL_{name.upper()}_FILE_HASH",
            support_inventory[name]["ready"] is True,
            {
                "exists": support_inventory[name]["exists"],
                "byteLengthMatches": support_inventory[name][
                    "byteLengthMatches"
                ],
                "sha256Matches": support_inventory[name]["sha256Matches"],
            },
            "declared exact bytes",
            "control_binding",
        )
        for name in required_names
    ]
    upload = loaded["uploadReceipt"] or {}
    upload_result = upload.get("result") if isinstance(upload.get("result"), Mapping) else {}
    remote = (
        upload_result.get("remote_status")
        if isinstance(upload_result.get("remote_status"), Mapping)
        else {}
    )
    gates.append(
        _gate(
            "CONTROL_UPLOAD_IDENTITY",
            _normalized_sha(upload.get("video_sha256"))
            == _normalized_sha(control.get("videoSha256"))
            and upload_result.get("video_id") == control.get("videoId")
            and remote.get("video_id") == control.get("videoId")
            and remote.get("privacy_status") == "public"
            and remote.get("published_at") == control.get("publishedAt"),
            {
                "videoId": upload_result.get("video_id"),
                "remoteVideoId": remote.get("video_id"),
                "videoSha256": upload.get("video_sha256"),
                "privacyStatus": remote.get("privacy_status"),
                "publishedAt": remote.get("published_at"),
            },
            "exact public upload receipt identity",
            "control_binding",
        )
    )
    targeted = loaded["targetedSelection"] or {}
    candidate = targeted.get("candidate") if isinstance(targeted.get("candidate"), Mapping) else {}
    speech_interval = list(control.get("speechIntervalSeconds") or [])
    gates.append(
        _gate(
            "CONTROL_SELECTION_IDENTITY",
            _normalized_sha(targeted.get("sourceHash"))
            == _normalized_sha(control.get("sourceHash"))
            and _normalized_sha(candidate.get("candidate_hash"))
            == _normalized_sha(control.get("candidateHash"))
            and len(speech_interval) == 2
            and abs(float(candidate.get("speech_start_time") or -1) - float(speech_interval[0]))
            <= 0.001
            and abs(float(candidate.get("speech_end_time") or -1) - float(speech_interval[1]))
            <= 0.001,
            {
                "sourceHash": targeted.get("sourceHash"),
                "candidateHash": candidate.get("candidate_hash"),
                "speechIntervalSeconds": [
                    candidate.get("speech_start_time"),
                    candidate.get("speech_end_time"),
                ],
            },
            "control source/candidate/speech identity",
            "control_binding",
        )
    )
    source_path_text = str(targeted.get("sourcePath") or "").strip()
    source_path = Path(source_path_text).expanduser() if source_path_text else None
    source_exists = bool(source_path and source_path.is_file())
    source_bytes = source_path.stat().st_size if source_exists and source_path else None
    source_hash = file_sha256(str(source_path)) if source_exists and source_path else None
    gates.append(
        _gate(
            "CONTROL_SOURCE_BYTES",
            source_exists
            and source_bytes == int(control.get("sourceByteLength") or 0)
            and source_hash == _normalized_sha(control.get("sourceHash")),
            {
                "exists": source_exists,
                "byteLength": source_bytes,
                "sha256": source_hash,
                "pathPersisted": False,
            },
            {
                "byteLength": control.get("sourceByteLength"),
                "sha256": control.get("sourceHash"),
            },
            "control_binding",
        )
    )
    diagnostics = loaded["gateDiagnostics"] or {}
    clarity = (
        diagnostics.get("spokenClarityReport")
        if isinstance(diagnostics.get("spokenClarityReport"), Mapping)
        else {}
    )
    clarity_seal_valid = (
        clarity.get("artifactType") == "SpokenClarityReport"
        and _is_sha256(clarity.get("contentHash"))
        and _normalized_sha(clarity.get("contentHash")) == content_hash(dict(clarity))
    )
    interval = clarity.get("speechInterval") if isinstance(clarity.get("speechInterval"), Mapping) else {}
    gates.append(
        _gate(
            "CONTROL_TRANSCRIPT_REPORT_BINDING",
            clarity_seal_valid
            and _normalized_sha(clarity.get("sourceHash"))
            == _normalized_sha(control.get("sourceHash"))
            and _normalized_sha(clarity.get("transcriptTimingHash"))
            == _normalized_sha(control.get("transcriptTimingHash"))
            and abs(float(interval.get("startSeconds") or -1) - float(speech_interval[0]))
            <= 0.001
            and abs(float(interval.get("endSeconds") or -1) - float(speech_interval[1]))
            <= 0.001,
            {
                "reportSealValid": clarity_seal_valid,
                "sourceHash": clarity.get("sourceHash"),
                "transcriptTimingHash": clarity.get("transcriptTimingHash"),
                "speechInterval": dict(interval),
            },
            "sealed transcript/source/interval binding",
            "control_binding",
        )
    )
    report_inputs = clarity.get("inputs") if isinstance(clarity.get("inputs"), Mapping) else {}
    reference_words = report_inputs.get("referenceWords") if isinstance(report_inputs.get("referenceWords"), list) else []
    planning = control.get("planningInputs") if isinstance(control.get("planningInputs"), Mapping) else {}
    caption_cues = planning.get("captionCues") if isinstance(planning.get("captionCues"), list) else []
    expected_words = [
        {
            "text": str(cue.get("text") or "").strip().casefold(),
            "start": round(float(speech_interval[0]) + float(cue.get("spoken_start") or 0.0), 3),
            "end": round(float(speech_interval[0]) + float(cue.get("spoken_end") or 0.0), 3),
        }
        for cue in caption_cues
    ] if len(speech_interval) == 2 else []
    actual_words = [
        {
            "text": str(word.get("text") or "").strip().casefold(),
            "start": round(float(word.get("startSeconds") or 0.0), 3),
            "end": round(float(word.get("endSeconds") or 0.0), 3),
        }
        for word in reference_words
        if isinstance(word, Mapping)
    ]
    gates.append(
        _gate(
            "CONTROL_PLANNING_TRANSCRIPT_WORDS",
            bool(expected_words) and actual_words == expected_words,
            {
                "actualWordCount": len(actual_words),
                "expectedWordCount": len(expected_words),
                "exactMatch": actual_words == expected_words,
            },
            "planning cues equal sealed report words and timings",
            "control_binding",
        )
    )
    tail = loaded["tailPatch"] or {}
    render_interval = list(control.get("renderIntervalSeconds") or [])
    gates.append(
        _gate(
            "CONTROL_TAIL_RENDER_BINDING",
            _normalized_sha(tail.get("outputSha256"))
            == _normalized_sha(control.get("videoSha256"))
            and list(tail.get("sourceIntervalSeconds") or []) == render_interval
            and abs(float(tail.get("speechEndSeconds") or -1) - float(speech_interval[1]))
            <= 0.001,
            {
                "outputSha256": tail.get("outputSha256"),
                "sourceIntervalSeconds": tail.get("sourceIntervalSeconds"),
                "speechEndSeconds": tail.get("speechEndSeconds"),
            },
            "final bytes, render interval and speech end match tail patch",
            "control_binding",
        )
    )
    payload = {
        "schemaVersion": 1,
        "artifactType": "ObservedMusicControlBinding",
        "bindingVersion": OBSERVED_CONTROL_BINDING_VERSION,
        "controlHash": control.get("contentHash"),
        "supportingArtifactInventory": support_inventory,
        "gates": gates,
        "bindingPass": all(gate["passed"] for gate in gates),
        "machineLocalSourcePathPersisted": False,
    }
    return _seal(payload)


def verify_reference_label_manifests(
    root: Path,
    contract: Mapping[str, object],
    reference_inventory: Sequence[Mapping[str, object]],
) -> Dict[str, object]:
    """Admit only sealed human labels bound to allowlisted media bytes."""
    media_specs = {
        str(spec.get("path") or ""): spec
        for spec in contract.get("styleReferenceMedia") or []
        if isinstance(spec, Mapping)
    }
    media_ready = {
        str(item.get("path") or ""): item.get("ready") is True
        for item in reference_inventory
    }
    reports = []
    admitted_reference_ids = set()
    for label_spec in contract.get("referenceLabelManifests") or []:
        inventory = _inventory(root, [label_spec])[0]
        label = _bound_json(root, label_spec) if inventory["ready"] else None
        reasons = []
        if label is None:
            reasons.append("label_file_unavailable_or_stale")
        else:
            try:
                verified = _verify_seal(label, "DynamicMusicReferenceLabel")
            except ValueError:
                verified = None
                reasons.append("label_seal_invalid")
            if verified is not None:
                if verified.get("labelVersion") != MUSIC_REFERENCE_LABEL_VERSION:
                    reasons.append("label_version_mismatch")
                media = verified.get("media") if isinstance(verified.get("media"), Mapping) else {}
                media_path = str(media.get("path") or "")
                expected_media = media_specs.get(media_path)
                if expected_media is None:
                    reasons.append("media_not_allowlisted")
                else:
                    if (
                        _normalized_sha(media.get("sha256"))
                        != _normalized_sha(expected_media.get("sha256"))
                        or int(media.get("byteLength") or 0)
                        != int(expected_media.get("byteLength") or 0)
                        or media_ready.get(media_path) is not True
                    ):
                        reasons.append("media_bytes_not_bound")
                judgment = verified.get("humanJudgment")
                required_judgments = {
                    "speechMaskingAcceptable",
                    "semanticBuildSupportsPoint",
                    "payoffEmphasisStable",
                    "releasePreservesNaturalTail",
                }
                if (
                    not isinstance(judgment, Mapping)
                    or set(judgment) != required_judgments
                    or not all(type(value) is bool for value in judgment.values())
                ):
                    reasons.append("human_judgment_schema_invalid")
                if not str(verified.get("labeledBy") or "").strip():
                    reasons.append("human_labeler_missing")
                if not str(verified.get("labeledAt") or "").strip():
                    reasons.append("human_label_time_missing")
                reference_id = str(verified.get("referenceId") or "").strip()
                if not reference_id:
                    reasons.append("reference_id_missing")
                elif reference_id in admitted_reference_ids:
                    reasons.append("duplicate_reference_id")
                if not reasons:
                    admitted_reference_ids.add(reference_id)
        reports.append(
            {
                "path": str(label_spec.get("path") or ""),
                "fileReady": inventory["ready"],
                "admitted": not reasons,
                "reasons": reasons,
            }
        )
    minimum = int(contract.get("minimumSealedReferenceLabels") or 0)
    payload = {
        "schemaVersion": 1,
        "artifactType": "DynamicMusicReferenceLabelReadiness",
        "labelVersion": MUSIC_REFERENCE_LABEL_VERSION,
        "declaredLabelCount": len(reports),
        "admittedLabelCount": len(admitted_reference_ids),
        "minimumRequired": minimum,
        "labelsReady": len(admitted_reference_ids) >= minimum,
        "labels": reports,
    }
    return _seal(payload)


def _gate(
    code: str,
    passed: bool,
    actual: object,
    expected: object,
    category: str,
) -> Dict[str, object]:
    return {
        "code": code,
        "category": category,
        "passed": bool(passed),
        "actual": actual,
        "expected": expected,
    }


def _event_integral(event: Mapping[str, object], limit: float) -> float:
    start = float(event["startSeconds"])
    end = min(float(event["endSeconds"]), limit)
    if end <= start:
        return 0.0
    event_end = float(event["endSeconds"])
    start_gain = float(event["startGain"])
    end_gain = float(event["endGain"])
    duration = event_end - start
    clipped = end - start
    clipped_end_gain = start_gain + (end_gain - start_gain) * (
        clipped / duration
    )
    return clipped * (start_gain + clipped_end_gain) / 2.0


def _phase_delta(
    events_by_type: Mapping[str, Mapping[str, object]],
    event_type: str,
    *,
    descending: bool = False,
) -> Optional[float]:
    event = events_by_type.get(event_type)
    if event is None:
        return None
    start = float(event["startGain"])
    end = float(event["endGain"])
    return round(start - end if descending else end - start, 6)


def _render_binding_gates(
    plan: Mapping[str, object],
    render_evidence: Optional[Mapping[str, object]],
    *,
    authorized_music_assets: Sequence[Mapping[str, object]] = (),
    asset_root: Optional[Path] = None,
) -> list[Dict[str, object]]:
    if render_evidence is None:
        return [
            _gate(
                "RENDER_EVIDENCE_PRESENT",
                False,
                None,
                "sealed RenderManifestEvidence for the treatment render",
                "binding",
            )
        ]
    evidence = dict(render_evidence)
    evidence_seal_valid = (
        evidence.get("artifactType") == "RenderManifestEvidence"
        and _is_sha256(evidence.get("contentHash"))
        and _normalized_sha(evidence.get("contentHash"))
        == content_hash(evidence)
    )
    music = evidence.get("music") if isinstance(evidence.get("music"), Mapping) else {}
    sealed_plan = (
        music.get("plan") if isinstance(music.get("plan"), Mapping) else {}
    )
    sealed_plan_body = dict(sealed_plan)
    sealed_plan_hash = _normalized_sha(sealed_plan_body.pop("contentHash", None))
    evaluated_plan_body = dict(plan)
    evaluated_plan_body.pop("contentHash", None)
    calculated_plan_hash = content_hash(evaluated_plan_body)
    asset = music.get("asset") if isinstance(music.get("asset"), Mapping) else {}
    asset_hash = _normalized_sha(asset.get("sha256"))
    asset_valid = (
        set(asset) == {"assetId", "sha256", "byteLength"}
        and _is_sha256(asset_hash)
        and asset.get("assetId") == f"sha256:{asset_hash}"
        and type(asset.get("byteLength")) is int
        and int(asset["byteLength"]) > 0
    )
    resolved_profile = str(music.get("resolvedProfile") or "").strip().lower()
    allowlist_matches = [
        spec
        for spec in authorized_music_assets
        if isinstance(spec, Mapping)
        and str(spec.get("role") or "")
        == f"licensed_music_{resolved_profile}"
        and _normalized_sha(spec.get("sha256")) == asset_hash
        and int(spec.get("byteLength") or 0)
        == int(asset.get("byteLength") or 0)
    ]
    allowlist_valid = len(allowlist_matches) == 1
    actual_asset_valid = False
    actual_asset_observation = {
        "allowlistMatchCount": len(allowlist_matches),
        "exists": False,
        "byteLengthMatches": False,
        "sha256Matches": False,
        "pathPersisted": False,
    }
    if allowlist_valid and asset_root is not None:
        inventory = _inventory(Path(asset_root), allowlist_matches)[0]
        actual_asset_valid = inventory["ready"] is True
        actual_asset_observation.update(
            {
                "exists": inventory["exists"],
                "byteLengthMatches": inventory["byteLengthMatches"],
                "sha256Matches": inventory["sha256Matches"],
            }
        )
    return [
        _gate(
            "RENDER_EVIDENCE_PRESENT",
            True,
            "RenderManifestEvidence",
            "RenderManifestEvidence",
            "binding",
        ),
        _gate(
            "RENDER_EVIDENCE_SEAL",
            evidence_seal_valid,
            evidence.get("contentHash"),
            "valid exact evidence seal",
            "binding",
        ),
        _gate(
            "V3_PROFILE_BINDING",
            evidence.get("formatProfile") == "bf_feed_stop_format_v3"
            and evidence.get("renderProfile") == "bf_editorial_inset_v3",
            {
                "formatProfile": evidence.get("formatProfile"),
                "renderProfile": evidence.get("renderProfile"),
            },
            {
                "formatProfile": "bf_feed_stop_format_v3",
                "renderProfile": "bf_editorial_inset_v3",
            },
            "binding",
        ),
        _gate(
            "MUSIC_MIX_APPLIED",
            music.get("dynamic") is True and music.get("applied") is True,
            {
                "dynamic": music.get("dynamic"),
                "applied": music.get("applied"),
            },
            {"dynamic": True, "applied": True},
            "binding",
        ),
        _gate(
            "MUSIC_PLAN_VERSION_BINDING",
            music.get("version") == DYNAMIC_MUSIC_PLAN_VERSION
            and music.get("mixProfile") == DYNAMIC_MUSIC_PLAN_VERSION
            and sealed_plan.get("planVersion") == DYNAMIC_MUSIC_PLAN_VERSION,
            {
                "version": music.get("version"),
                "mixProfile": music.get("mixProfile"),
                "planVersion": sealed_plan.get("planVersion"),
            },
            DYNAMIC_MUSIC_PLAN_VERSION,
            "binding",
        ),
        _gate(
            "MUSIC_PROFILE_BINDING",
            bool(resolved_profile)
            and music.get("profile") == resolved_profile
            and sealed_plan.get("musicProfile") == resolved_profile
            and plan.get("musicProfile") == resolved_profile,
            {
                "profile": music.get("profile"),
                "resolvedProfile": resolved_profile,
                "sealedPlanProfile": sealed_plan.get("musicProfile"),
                "evaluatedPlanProfile": plan.get("musicProfile"),
            },
            "one exact music profile across plan and renderer",
            "binding",
        ),
        _gate(
            "EXACT_PLAN_BINDING",
            sealed_plan_hash == calculated_plan_hash
            and _normalized_sha(music.get("planHash")) == calculated_plan_hash
            and sealed_plan_body == evaluated_plan_body,
            {
                "renderPlanHash": music.get("planHash"),
                "sealedPlanHash": sealed_plan_hash or None,
                "evaluatedPlanHash": calculated_plan_hash,
            },
            "all hashes and exact plan body match",
            "binding",
        ),
        _gate(
            "LICENSED_ASSET_BINDING",
            asset_valid,
            {
                "assetId": asset.get("assetId"),
                "byteLength": asset.get("byteLength"),
            },
            "non-empty sha256-bound licensed track",
            "binding",
        ),
        _gate(
            "LICENSED_ASSET_ALLOWLIST",
            allowlist_valid,
            {
                "profile": resolved_profile,
                "sha256": asset_hash or None,
                "byteLength": asset.get("byteLength"),
                "allowlistMatchCount": len(allowlist_matches),
            },
            "exactly one contract-authorized profile/hash/length tuple",
            "binding",
        ),
        _gate(
            "LICENSED_ASSET_ACTUAL_FILE_HASH",
            actual_asset_valid,
            actual_asset_observation,
            "actual allowlisted file bytes match receipt and contract",
            "binding",
        ),
    ]


def evaluate_dynamic_music_plan(
    plan: Mapping[str, object],
    *,
    render_evidence: Optional[Mapping[str, object]] = None,
    authorized_music_assets: Sequence[Mapping[str, object]] = (),
    asset_root: Optional[Path] = None,
) -> Dict[str, object]:
    """Evaluate safety/structure proxies without predicting viewer behavior."""
    plan_body = dict(plan)
    plan_body.pop("contentHash", None)
    validation_error = None
    try:
        validate_dynamic_music_plan(plan_body)
    except (TypeError, ValueError) as error:
        validation_error = f"{type(error).__name__}: {error}"

    events = plan_body.get("events") if isinstance(plan_body.get("events"), list) else []
    anchors = plan_body.get("anchors") if isinstance(plan_body.get("anchors"), Mapping) else {}
    constraints = (
        plan_body.get("constraints")
        if isinstance(plan_body.get("constraints"), Mapping)
        else {}
    )
    ordered_types = [str(event.get("type") or "") for event in events if isinstance(event, Mapping)]
    known_order = {
        name: index for index, name in enumerate(ALLOWED_EVENT_ORDER)
    }
    # restrained_bed is a complete fallback topology rather than a final phase.
    semantic_types = [name for name in ordered_types if name != "restrained_bed"]
    event_vocabulary_valid = all(name in known_order for name in ordered_types)
    event_order_valid = (
        ordered_types == ["restrained_bed"]
        or all(
            known_order[left] < known_order[right]
            for left, right in zip(semantic_types, semantic_types[1:])
        )
    )
    slopes = []
    gains = []
    for event in events:
        if not isinstance(event, Mapping):
            continue
        try:
            duration = float(event["endSeconds"]) - float(event["startSeconds"])
            start_gain = float(event["startGain"])
            end_gain = float(event["endGain"])
        except (KeyError, TypeError, ValueError):
            continue
        gains.extend((start_gain, end_gain))
        if duration > 0.0:
            slopes.append(abs(end_gain - start_gain) / duration)
    maximum_slope = max(slopes, default=math.inf)
    dynamic_range = max(gains) - min(gains) if gains else 0.0
    speech_end = float(anchors.get("speechEndSeconds") or 0.0)
    speech_integral = sum(
        _event_integral(event, speech_end)
        for event in events
        if isinstance(event, Mapping)
        and float(event.get("startSeconds") or 0.0) < speech_end
    )
    mean_speech_gain = speech_integral / speech_end if speech_end > 0 else math.inf
    events_by_type = {
        str(event.get("type")): event
        for event in events
        if isinstance(event, Mapping)
    }
    build_lift = _phase_delta(events_by_type, "semantic_build")
    pocket_depth = _phase_delta(
        events_by_type, "clarity_pocket", descending=True
    )
    emphasis_lift = _phase_delta(events_by_type, "stable_emphasis")
    release_depth = _phase_delta(
        events_by_type, "controlled_release", descending=True
    )
    hook_end = float(anchors.get("hookEndSeconds") or 0.0)
    build_event = events_by_type.get("semantic_build")
    pocket_event = events_by_type.get("clarity_pocket")
    context_build_coverage = None
    if build_event is not None and pocket_event is not None:
        context_span = float(pocket_event["startSeconds"]) - hook_end
        covered_span = float(build_event["endSeconds"]) - max(
            hook_end,
            float(build_event["startSeconds"]),
        )
        if context_span > 0.0:
            context_build_coverage = round(
                max(0.0, min(1.0, covered_span / context_span)),
                6,
            )
    threshold = PLAN_GUARDRAIL_THRESHOLDS
    safety_gates = [
        _gate(
            "PLAN_SCHEMA_VALID",
            validation_error is None,
            validation_error,
            "validate_dynamic_music_plan passes",
            "safety",
        ),
        _gate(
            "NON_GENERATIVE_CONSTRAINTS",
            constraints.get("speechDominant") is True
            and constraints.get("randomEffectsAllowed") is False
            and constraints.get("soundEffectsAllowed") is False
            and constraints.get("visualEventsAllowed") is False,
            dict(constraints),
            {
                "speechDominant": True,
                "randomEffectsAllowed": False,
                "soundEffectsAllowed": False,
                "visualEventsAllowed": False,
            },
            "safety",
        ),
        _gate(
            "EXACT_SEMANTIC_ANCHORS",
            anchors.get("hookSource") in EXACT_HOOK_SOURCES
            and anchors.get("payoffSource") in EXACT_PAYOFF_SOURCES
            and list(anchors.get("fallbackReasons") or []) == [],
            {
                "hookSource": anchors.get("hookSource"),
                "payoffSource": anchors.get("payoffSource"),
                "fallbackReasons": anchors.get("fallbackReasons"),
            },
            "exact aligned HookGate V4 opening and payoff; no fallback",
            "semantic_binding",
        ),
        _gate(
            "EVENT_VOCABULARY_AND_ORDER",
            event_vocabulary_valid and event_order_valid,
            ordered_types,
            "known one-way semantic phase order",
            "safety",
        ),
        _gate(
            "RAMP_RATE_LIMIT",
            maximum_slope <= threshold["maximumRampRatePerSecond"],
            round(maximum_slope, 6) if math.isfinite(maximum_slope) else None,
            threshold["maximumRampRatePerSecond"],
            "speech_protection",
        ),
        _gate(
            "SPEECH_MEAN_GAIN_LIMIT",
            mean_speech_gain <= threshold["maximumSpeechMeanGain"],
            round(mean_speech_gain, 6) if math.isfinite(mean_speech_gain) else None,
            threshold["maximumSpeechMeanGain"],
            "speech_protection",
        ),
        _gate(
            "ENTRY_RESTRAINT",
            bool(gains) and gains[0] <= threshold["maximumEntryGain"],
            round(gains[0], 6) if gains else None,
            threshold["maximumEntryGain"],
            "speech_protection",
        ),
        _gate(
            "TAIL_RESTRAINT",
            bool(gains) and gains[-1] <= threshold["maximumTailGain"],
            round(gains[-1], 6) if gains else None,
            threshold["maximumTailGain"],
            "speech_protection",
        ),
    ]
    design_gates = [
        _gate(
            "BOUNDED_DYNAMIC_RANGE",
            threshold["minimumDynamicRange"]
            <= dynamic_range
            <= threshold["maximumDynamicRange"],
            round(dynamic_range, 6),
            [
                threshold["minimumDynamicRange"],
                threshold["maximumDynamicRange"],
            ],
            "structure_proxy",
        ),
        _gate(
            "SEMANTIC_BUILD_LIFT",
            build_lift is not None
            and build_lift >= threshold["minimumBuildLift"],
            build_lift,
            threshold["minimumBuildLift"],
            "structure_proxy",
        ),
        _gate(
            "CLARITY_POCKET_DEPTH",
            pocket_depth is not None
            and pocket_depth >= threshold["minimumClarityPocketDepth"],
            pocket_depth,
            threshold["minimumClarityPocketDepth"],
            "structure_proxy",
        ),
        _gate(
            "PAYOFF_EMPHASIS_LIFT",
            emphasis_lift is not None
            and emphasis_lift >= threshold["minimumPayoffEmphasisLift"],
            emphasis_lift,
            threshold["minimumPayoffEmphasisLift"],
            "structure_proxy",
        ),
        _gate(
            "CONTROLLED_RELEASE_DEPTH",
            release_depth is not None
            and release_depth >= threshold["minimumReleaseDepth"],
            release_depth,
            threshold["minimumReleaseDepth"],
            "structure_proxy",
        ),
        _gate(
            "CONTEXT_BUILD_COVERAGE",
            context_build_coverage is not None
            and context_build_coverage
            >= threshold["minimumContextBuildCoverage"],
            context_build_coverage,
            threshold["minimumContextBuildCoverage"],
            "structure_proxy",
        ),
    ]
    binding_gates = _render_binding_gates(
        plan_body,
        render_evidence,
        authorized_music_assets=authorized_music_assets,
        asset_root=asset_root,
    )
    plan_guardrails_pass = all(
        gate["passed"] for gate in [*safety_gates, *design_gates]
    )
    render_binding_pass = all(gate["passed"] for gate in binding_gates)
    payload = {
        "schemaVersion": 1,
        "artifactType": "DynamicMusicPlanEvaluation",
        "evaluationVersion": MUSIC_PLAN_EVALUATION_VERSION,
        "planVersion": plan_body.get("planVersion"),
        "planHash": content_hash(plan_body),
        "offlineOnly": True,
        "proxyMetricsOnly": True,
        "retentionPrediction": None,
        "viewerOutcomeLabel": None,
        "autoPromotionAllowed": False,
        "metrics": {
            "maximumRampRatePerSecond": (
                round(maximum_slope, 6)
                if math.isfinite(maximum_slope)
                else None
            ),
            "speechWeightedMeanGain": (
                round(mean_speech_gain, 6)
                if math.isfinite(mean_speech_gain)
                else None
            ),
            "dynamicRange": round(dynamic_range, 6),
            "buildLift": build_lift,
            "clarityPocketDepth": pocket_depth,
            "payoffEmphasisLift": emphasis_lift,
            "releaseDepth": release_depth,
            "contextBuildCoverage": context_build_coverage,
        },
        "safetyGuardrails": safety_gates,
        "structureProxyGuardrails": design_gates,
        "renderBindingGuardrails": binding_gates,
        "planGuardrailsPass": plan_guardrails_pass,
        "renderBindingPass": render_binding_pass,
        "eligibleForHumanABPreview": (
            plan_guardrails_pass and render_binding_pass
        ),
        "decisionState": (
            HUMAN_AB_REQUIRED
            if plan_guardrails_pass and render_binding_pass
            else CALIBRATION_NOT_READY
        ),
    }
    return _seal(payload)


def _retime_context_build(
    plan: Mapping[str, object],
    *,
    hook_settle_seconds: float,
) -> Dict[str, object]:
    """Move only the hook-hold/build boundary; preserve all gains/anchors."""
    candidate = copy.deepcopy(dict(plan))
    candidate.pop("contentHash", None)
    events = candidate.get("events") or []
    hook_hold = next(
        (event for event in events if event.get("type") == "hook_hold"),
        None,
    )
    semantic_build = next(
        (event for event in events if event.get("type") == "semantic_build"),
        None,
    )
    if hook_hold is None or semantic_build is None:
        return candidate
    hook_end = float(candidate["anchors"]["hookEndSeconds"])
    minimum = float(candidate["constraints"]["minimumTransitionSeconds"])
    lower = float(hook_hold["startSeconds"]) + minimum
    upper = float(semantic_build["endSeconds"]) - minimum
    boundary = max(lower, min(upper, hook_end + hook_settle_seconds))
    boundary = round(boundary, 3)
    hook_hold["endSeconds"] = boundary
    semantic_build["startSeconds"] = boundary
    validate_dynamic_music_plan(candidate)
    return candidate


def search_dynamic_music_timing_variants(
    baseline_plan: Mapping[str, object],
    *,
    render_evidence: Optional[Mapping[str, object]] = None,
    authorized_music_assets: Sequence[Mapping[str, object]] = (),
    asset_root: Optional[Path] = None,
    hook_settle_candidates: Sequence[float] = (0.08, 0.20, 0.35, 0.50),
) -> Dict[str, object]:
    """Search one bounded timing parameter using structure proxies only.

    This does not declare a quality or retention winner.  It returns the safest
    deterministic candidate to render for human listening review.
    """
    variants = []
    seen_hashes = set()
    specifications = [("baseline", None)] + [
        (f"hook_plus_{value:.2f}s", float(value))
        for value in hook_settle_candidates
    ]
    for treatment_id, settle in specifications:
        plan = (
            copy.deepcopy(dict(baseline_plan))
            if settle is None
            else _retime_context_build(
                baseline_plan,
                hook_settle_seconds=settle,
            )
        )
        plan.pop("contentHash", None)
        plan_hash = content_hash(plan)
        if plan_hash in seen_hashes:
            continue
        seen_hashes.add(plan_hash)
        evaluation = evaluate_dynamic_music_plan(
            plan,
            render_evidence=(render_evidence if settle is not None else None),
            authorized_music_assets=authorized_music_assets,
            asset_root=asset_root,
        )
        variants.append(
            {
                "treatmentId": treatment_id,
                "parameters": {
                    "contextBuildStartPolicy": (
                        "production_baseline"
                        if settle is None
                        else "hook_end_plus_seconds"
                    ),
                    "hookSettleSeconds": settle,
                },
                "plan": plan,
                "planHash": plan_hash,
                "planEvaluation": evaluation,
            }
        )
    ranked = sorted(
        variants,
        key=lambda item: (
            item["planEvaluation"]["planGuardrailsPass"] is not True,
            -float(
                item["planEvaluation"]["metrics"].get(
                    "contextBuildCoverage"
                )
                or 0.0
            ),
            float(
                item["planEvaluation"]["metrics"].get(
                    "maximumRampRatePerSecond"
                )
                or math.inf
            ),
            item["treatmentId"],
        ),
    )
    selected = ranked[0] if ranked else None
    payload = {
        "schemaVersion": 1,
        "artifactType": "DynamicMusicOfflineSearch",
        "searchVersion": MUSIC_AUTORESEARCH_VERSION,
        "changedAxes": list(CHANGED_AXES),
        "searchedParameter": "contextBuildStartPolicy",
        "variantCount": len(variants),
        "variants": variants,
        "selectedOfflineProxyCandidate": selected,
        "selectionMeaning": (
            "plan-safe structure-proxy candidate for a human A/B render; "
            "not a viewer-outcome winner"
        ),
        "retentionPrediction": None,
        "winner": None,
        "humanDecisionRequired": True,
        "autoPromotionAllowed": False,
    }
    return _seal(payload)


def build_music_outcome_observation(
    analytics_snapshot: Mapping[str, object],
    experiment_recipe: Mapping[str, object],
    *,
    contract: Mapping[str, object],
    artifact_root: Path,
    source_hash: str,
    candidate_hash: str,
    render_evidence_path: Path,
    treatment_video_path: Path,
    upload_receipt_path: Path,
) -> Dict[str, object]:
    """Bind one real analytics snapshot to one canonical cohort assignment."""
    snapshot = dict(analytics_snapshot)
    if (
        snapshot.get("artifactType") != "AnalyticsSnapshot"
        or snapshot.get("contentHash") != content_hash(snapshot)
    ):
        raise ValueError("analytics snapshot seal is invalid")
    if experiment_recipe.get("artifactType") != "DynamicMusicExperimentRecipe":
        raise ValueError("music experiment recipe is required")
    if experiment_recipe.get("contentHash") != content_hash(dict(experiment_recipe)):
        raise ValueError("music experiment recipe seal is invalid")
    normalized_source = _normalized_sha(source_hash)
    normalized_candidate = _normalized_sha(candidate_hash)
    if not _is_sha256(normalized_source) or not _is_sha256(normalized_candidate):
        raise ValueError("source_hash and candidate_hash must be sha256")
    treatment_id = str(snapshot.get("treatmentId") or "").strip()
    resolved_root = Path(artifact_root).resolve()

    def artifact_spec(path: Path, role: str) -> Dict[str, object]:
        resolved = Path(path).expanduser().resolve()
        if not resolved.is_file() or not resolved.is_relative_to(resolved_root):
            raise ValueError(f"{role} must be an existing file inside artifact_root")
        return {
            "path": resolved.relative_to(resolved_root).as_posix(),
            "role": role,
            "sha256": file_sha256(str(resolved)),
            "byteLength": resolved.stat().st_size,
        }

    render_spec = artifact_spec(render_evidence_path, "treatment_render_evidence")
    video_spec = artifact_spec(treatment_video_path, "treatment_video")
    upload_spec = artifact_spec(upload_receipt_path, "treatment_upload_receipt")
    render_evidence = _bound_json(resolved_root, render_spec)
    upload_receipt = _bound_json(resolved_root, upload_spec)
    if render_evidence is None or upload_receipt is None:
        raise ValueError("treatment artifact JSON is invalid")
    music = (
        render_evidence.get("music")
        if isinstance(render_evidence.get("music"), Mapping)
        else {}
    )
    sealed_plan = music.get("plan") if isinstance(music.get("plan"), Mapping) else {}
    plan_body = dict(sealed_plan)
    plan_body.pop("contentHash", None)
    render_evaluation = evaluate_dynamic_music_plan(
        plan_body,
        render_evidence=render_evidence,
        authorized_music_assets=contract.get("licensedMusicAssets") or [],
        asset_root=resolved_root,
    )
    if render_evaluation["renderBindingPass"] is not True:
        raise ValueError("treatment render evidence is not fully bound")
    if render_evaluation["planHash"] != experiment_recipe.get("treatment", {}).get(
        "planHash"
    ):
        raise ValueError("treatment render plan does not match experiment recipe")
    upload_result = (
        upload_receipt.get("result")
        if isinstance(upload_receipt.get("result"), Mapping)
        else {}
    )
    remote = (
        upload_result.get("remote_status")
        if isinstance(upload_result.get("remote_status"), Mapping)
        else {}
    )
    if (
        _normalized_sha(upload_receipt.get("video_sha256"))
        != _normalized_sha(video_spec["sha256"])
        or upload_result.get("video_id") != snapshot.get("videoId")
        or remote.get("video_id") != snapshot.get("videoId")
        or remote.get("privacy_status") != "public"
    ):
        raise ValueError("upload receipt does not bind the public treatment video")
    asset = music.get("asset") if isinstance(music.get("asset"), Mapping) else {}
    manifest_identity = {
        "renderEvidenceHash": render_evidence.get("contentHash"),
        "renderEvidenceFileSha256": render_spec["sha256"],
        "formatProfile": render_evidence.get("formatProfile"),
        "renderProfile": render_evidence.get("renderProfile"),
        "planHash": render_evaluation["planHash"],
        "musicAssetSha256": asset.get("sha256"),
        "treatmentVideoSha256": video_spec["sha256"],
        "treatmentVideoByteLength": video_spec["byteLength"],
        "uploadReceiptFileSha256": upload_spec["sha256"],
        "videoId": snapshot.get("videoId"),
    }
    treatment_manifest_identity_hash = content_hash(manifest_identity)
    content_unit = {
        "sourceHash": normalized_source,
        "candidateHash": normalized_candidate,
    }
    content_unit_id = content_hash(content_unit)
    fixed_axes_hash = content_hash(experiment_recipe.get("fixedAxes") or {})
    assignment = {
        "experimentId": experiment_recipe.get("experimentId"),
        "treatmentId": treatment_id,
        "contentUnitId": content_unit_id,
        "fixedAxesHash": fixed_axes_hash,
        "changedAxes": list(CHANGED_AXES),
        "treatmentManifestIdentityHash": treatment_manifest_identity_hash,
    }
    payload = {
        "schemaVersion": 1,
        "artifactType": "DynamicMusicOutcomeObservation",
        "observationVersion": MUSIC_OUTCOME_OBSERVATION_VERSION,
        "experimentId": experiment_recipe.get("experimentId"),
        "experimentRecipeHash": experiment_recipe.get("contentHash"),
        "changedAxes": list(CHANGED_AXES),
        "fixedAxesHash": fixed_axes_hash,
        "treatmentId": treatment_id,
        "videoId": snapshot.get("videoId"),
        "sourceHash": normalized_source,
        "candidateHash": normalized_candidate,
        "contentUnitId": content_unit_id,
        "assignmentHash": content_hash(assignment),
        "treatmentManifestIdentity": manifest_identity,
        "treatmentManifestIdentityHash": treatment_manifest_identity_hash,
        "treatmentArtifacts": {
            "renderEvidence": render_spec,
            "video": video_spec,
            "uploadReceipt": upload_spec,
        },
        "analyticsSnapshotHash": snapshot.get("contentHash"),
        "analyticsSnapshot": snapshot,
    }
    return _seal(payload)


def assess_real_outcome_evidence(
    observations: Sequence[Mapping[str, object]],
    *,
    experiment_recipe: Mapping[str, object],
    contract: Mapping[str, object],
    artifact_root: Path,
    control_treatment_id: str,
    candidate_treatment_id: str,
    gate_hours: int = 168,
    minimum_per_treatment: int = 3,
) -> Dict[str, object]:
    """Check canonical equal-age cohorts, but never select a winner."""
    if (
        experiment_recipe.get("artifactType") != "DynamicMusicExperimentRecipe"
        or experiment_recipe.get("contentHash")
        != content_hash(dict(experiment_recipe))
    ):
        raise ValueError("sealed music experiment recipe is required")
    experiment_id = str(experiment_recipe.get("experimentId") or "")
    recipe_hash = str(experiment_recipe.get("contentHash") or "")
    fixed_axes_hash = content_hash(experiment_recipe.get("fixedAxes") or {})
    treatment_ids = {control_treatment_id, candidate_treatment_id}
    inspected = []
    for observation in observations:
        reasons = []
        observation = dict(observation)
        snapshot = (
            observation.get("analyticsSnapshot")
            if isinstance(observation.get("analyticsSnapshot"), Mapping)
            else {}
        )
        video_id = str(observation.get("videoId") or "").strip()
        treatment_id = str(observation.get("treatmentId") or "").strip()
        if observation.get("artifactType") != "DynamicMusicOutcomeObservation":
            reasons.append("outcome_observation_required")
        if observation.get("observationVersion") != MUSIC_OUTCOME_OBSERVATION_VERSION:
            reasons.append("observation_version_mismatch")
        if observation.get("contentHash") != content_hash(observation):
            reasons.append("invalid_observation_seal")
        if observation.get("experimentId") != experiment_id:
            reasons.append("experiment_mismatch")
        if observation.get("experimentRecipeHash") != recipe_hash:
            reasons.append("experiment_recipe_mismatch")
        if observation.get("changedAxes") != CHANGED_AXES:
            reasons.append("changed_axes_mismatch")
        if observation.get("fixedAxesHash") != fixed_axes_hash:
            reasons.append("fixed_axes_mismatch")
        if treatment_id not in treatment_ids:
            reasons.append("treatment_mismatch")
        if not _is_sha256(observation.get("sourceHash")) or not _is_sha256(
            observation.get("candidateHash")
        ):
            reasons.append("content_identity_invalid")
        expected_content_unit = content_hash(
            {
                "sourceHash": _normalized_sha(observation.get("sourceHash")),
                "candidateHash": _normalized_sha(
                    observation.get("candidateHash")
                ),
            }
        )
        if observation.get("contentUnitId") != expected_content_unit:
            reasons.append("content_unit_id_mismatch")
        artifacts = (
            observation.get("treatmentArtifacts")
            if isinstance(observation.get("treatmentArtifacts"), Mapping)
            else {}
        )
        artifact_specs_valid = set(artifacts) == {
            "renderEvidence",
            "video",
            "uploadReceipt",
        }
        render_evidence = None
        upload_receipt = None
        actual_manifest_identity = None
        if not artifact_specs_valid:
            reasons.append("treatment_artifact_set_incomplete")
        else:
            artifact_inventory = {
                name: _inventory(Path(artifact_root), [spec])[0]
                for name, spec in artifacts.items()
                if isinstance(spec, Mapping)
            }
            if len(artifact_inventory) != 3 or not all(
                item["ready"] is True for item in artifact_inventory.values()
            ):
                reasons.append("treatment_artifact_bytes_unavailable_or_stale")
            else:
                render_evidence = _bound_json(
                    Path(artifact_root), artifacts["renderEvidence"]
                )
                upload_receipt = _bound_json(
                    Path(artifact_root), artifacts["uploadReceipt"]
                )
                if render_evidence is None or upload_receipt is None:
                    reasons.append("treatment_artifact_json_invalid")
                else:
                    music = (
                        render_evidence.get("music")
                        if isinstance(render_evidence.get("music"), Mapping)
                        else {}
                    )
                    sealed_plan = (
                        music.get("plan")
                        if isinstance(music.get("plan"), Mapping)
                        else {}
                    )
                    plan_body = dict(sealed_plan)
                    plan_body.pop("contentHash", None)
                    render_evaluation = evaluate_dynamic_music_plan(
                        plan_body,
                        render_evidence=render_evidence,
                        authorized_music_assets=contract.get(
                            "licensedMusicAssets"
                        )
                        or [],
                        asset_root=Path(artifact_root),
                    )
                    if render_evaluation["renderBindingPass"] is not True:
                        reasons.append("treatment_render_binding_invalid")
                    if render_evaluation["planHash"] != experiment_recipe.get(
                        "treatment", {}
                    ).get("planHash"):
                        reasons.append("treatment_plan_recipe_mismatch")
                    video_spec = artifacts["video"]
                    upload_spec = artifacts["uploadReceipt"]
                    upload_result = (
                        upload_receipt.get("result")
                        if isinstance(upload_receipt.get("result"), Mapping)
                        else {}
                    )
                    remote = (
                        upload_result.get("remote_status")
                        if isinstance(upload_result.get("remote_status"), Mapping)
                        else {}
                    )
                    if (
                        _normalized_sha(upload_receipt.get("video_sha256"))
                        != _normalized_sha(video_spec.get("sha256"))
                        or upload_result.get("video_id") != video_id
                        or remote.get("video_id") != video_id
                        or remote.get("privacy_status") != "public"
                    ):
                        reasons.append("treatment_upload_video_binding_invalid")
                    asset = (
                        music.get("asset")
                        if isinstance(music.get("asset"), Mapping)
                        else {}
                    )
                    actual_manifest_identity = {
                        "renderEvidenceHash": render_evidence.get("contentHash"),
                        "renderEvidenceFileSha256": artifacts[
                            "renderEvidence"
                        ].get("sha256"),
                        "formatProfile": render_evidence.get("formatProfile"),
                        "renderProfile": render_evidence.get("renderProfile"),
                        "planHash": render_evaluation["planHash"],
                        "musicAssetSha256": asset.get("sha256"),
                        "treatmentVideoSha256": video_spec.get("sha256"),
                        "treatmentVideoByteLength": video_spec.get("byteLength"),
                        "uploadReceiptFileSha256": upload_spec.get("sha256"),
                        "videoId": video_id,
                    }
        declared_manifest_identity = observation.get("treatmentManifestIdentity")
        declared_manifest_hash = observation.get(
            "treatmentManifestIdentityHash"
        )
        if (
            actual_manifest_identity is None
            or not isinstance(declared_manifest_identity, Mapping)
            or dict(declared_manifest_identity) != actual_manifest_identity
            or declared_manifest_hash != content_hash(actual_manifest_identity)
        ):
            reasons.append("treatment_manifest_identity_mismatch")
        expected_assignment = content_hash(
            {
                "experimentId": experiment_id,
                "treatmentId": treatment_id,
                "contentUnitId": expected_content_unit,
                "fixedAxesHash": fixed_axes_hash,
                "changedAxes": list(CHANGED_AXES),
                "treatmentManifestIdentityHash": declared_manifest_hash,
            }
        )
        if observation.get("assignmentHash") != expected_assignment:
            reasons.append("assignment_hash_mismatch")
        if snapshot.get("artifactType") != "AnalyticsSnapshot":
            reasons.append("not_analytics_snapshot")
        if snapshot.get("contentHash") != content_hash(dict(snapshot)):
            reasons.append("invalid_snapshot_seal")
        if observation.get("analyticsSnapshotHash") != snapshot.get("contentHash"):
            reasons.append("snapshot_hash_mismatch")
        if snapshot.get("experimentId") != experiment_id:
            reasons.append("snapshot_experiment_mismatch")
        if snapshot.get("treatmentId") != treatment_id:
            reasons.append("snapshot_treatment_mismatch")
        if snapshot.get("cohortId") != treatment_id:
            reasons.append("snapshot_cohort_mismatch")
        if snapshot.get("videoId") != video_id:
            reasons.append("snapshot_video_mismatch")
        if snapshot.get("snapshotGateHours") != gate_hours:
            reasons.append("not_equal_age_gate")
        if snapshot.get("completeForPrimaryDecision") is not True:
            reasons.append("metrics_incomplete")
        if snapshot.get("source") not in REAL_OUTCOME_SOURCES:
            reasons.append("not_real_analytics_source")
        if not video_id:
            reasons.append("video_id_missing")
        inspected.append(
            {
                "videoId": video_id or None,
                "treatmentId": treatment_id or None,
                "contentUnitId": observation.get("contentUnitId"),
                "reasons": reasons,
            }
        )
    video_counts: Dict[str, int] = {}
    content_counts: Dict[str, int] = {}
    for item in inspected:
        if item["videoId"]:
            video_counts[item["videoId"]] = video_counts.get(item["videoId"], 0) + 1
        if item["contentUnitId"]:
            content_counts[item["contentUnitId"]] = content_counts.get(item["contentUnitId"], 0) + 1
    accepted: Dict[str, set[str]] = {name: set() for name in treatment_ids}
    rejected = []
    canonical_assignments = []
    for item in inspected:
        reasons = list(item["reasons"])
        if item["videoId"] and video_counts[item["videoId"]] > 1:
            reasons.append("duplicate_video_assignment")
        if item["contentUnitId"] and content_counts[item["contentUnitId"]] > 1:
            reasons.append("duplicate_content_unit_assignment")
        if reasons:
            rejected.append(
                {
                    "videoId": item["videoId"],
                    "reasons": sorted(set(reasons)),
                }
            )
        else:
            treatment_id = str(item["treatmentId"])
            accepted[treatment_id].add(str(item["videoId"]))
            canonical_assignments.append(
                {
                    "videoId": item["videoId"],
                    "treatmentId": treatment_id,
                    "contentUnitId": item["contentUnitId"],
                }
            )
    counts = {name: len(ids) for name, ids in sorted(accepted.items())}
    cohort_complete = all(
        count >= minimum_per_treatment for count in counts.values()
    )
    # Outcome rows and their treatment render/upload bytes are bound above.
    # What is intentionally *not* implemented yet is independent proof that
    # every control/treatment pair held all recipe fixed axes constant.  Keep
    # the outcome gate fail-closed until that verifier exists; accepting a
    # cohort on assignment metadata alone would turn a declared A/B contract
    # into evidence for itself.
    fixed_axis_render_proof_implemented = False
    global_blockers = []
    if not fixed_axis_render_proof_implemented:
        global_blockers.append("fixed_axis_render_proof_not_implemented")
    ready = cohort_complete and fixed_axis_render_proof_implemented
    payload = {
        "schemaVersion": 1,
        "artifactType": "DynamicMusicOutcomeReadiness",
        "experimentId": experiment_id,
        "experimentRecipeHash": recipe_hash,
        "fixedAxesHash": fixed_axes_hash,
        "changedAxes": list(CHANGED_AXES),
        "equalAgeGateHours": gate_hours,
        "minimumPerTreatment": minimum_per_treatment,
        "acceptedRealSnapshotCount": sum(counts.values()),
        "acceptedByTreatment": counts,
        "canonicalCohortHash": content_hash(
            sorted(
                canonical_assignments,
                key=lambda item: (str(item["treatmentId"]), str(item["videoId"])),
            )
        ),
        "rejectedSnapshots": rejected,
        "cohortCountThresholdMet": cohort_complete,
        "fixedAxisRenderProofImplemented": fixed_axis_render_proof_implemented,
        "fixedAxisRenderProofReady": False,
        "globalBlockers": global_blockers,
        "realOutcomeEvidenceReady": ready,
        "winner": None,
        "autoPromotionAllowed": False,
        "decisionState": HUMAN_AB_REQUIRED,
    }
    return _seal(payload)


def assess_music_data_readiness(
    root: Path,
    contract: Mapping[str, object],
    control: Mapping[str, object],
    *,
    experiment_recipe: Mapping[str, object],
    outcome_observations: Sequence[Mapping[str, object]] = (),
    render_binding_pass: bool = False,
) -> Dict[str, object]:
    root = Path(root).resolve()
    tracks = _inventory(root, contract.get("licensedMusicAssets") or [])
    references = _inventory(root, contract.get("styleReferenceMedia") or [])
    control_artifact = control.get("renderArtifact")
    control_spec = [control_artifact] if isinstance(control_artifact, Mapping) else []
    control_files = _inventory(root, control_spec)
    control_binding = verify_observed_control_bindings(root, control)
    reference_labels = verify_reference_label_manifests(
        root,
        contract,
        references,
    )
    outcome_policy = contract.get("realOutcomePolicy") or {}
    outcome = assess_real_outcome_evidence(
        outcome_observations,
        experiment_recipe=experiment_recipe,
        contract=contract,
        artifact_root=root,
        control_treatment_id=str(outcome_policy["controlTreatmentId"]),
        candidate_treatment_id=str(outcome_policy["candidateTreatmentId"]),
        gate_hours=int(outcome_policy["equalAgeGateHours"]),
        minimum_per_treatment=int(outcome_policy["minimumPerTreatment"]),
    )
    tracks_ready = bool(tracks) and all(item["ready"] for item in tracks)
    references_available = bool(references) and all(
        item["ready"] for item in references
    )
    control_ready = (
        bool(control_files)
        and all(item["ready"] for item in control_files)
        and control_binding["bindingPass"] is True
    )
    reference_label_count = int(reference_labels["admittedLabelCount"])
    calibration_ready = bool(
        tracks_ready
        and references_available
        and reference_labels["labelsReady"] is True
        and control_ready
        and render_binding_pass
        and outcome["realOutcomeEvidenceReady"]
    )
    blockers = []
    if not tracks_ready:
        blockers.append("licensed_music_assets_unavailable_or_stale")
    if not references_available:
        blockers.append("style_reference_media_unavailable_or_stale")
    if reference_labels["labelsReady"] is not True:
        blockers.append("sealed_reference_music_labels_missing")
    if not control_ready:
        blockers.append("observed_control_render_unavailable_or_stale")
    if not render_binding_pass:
        blockers.append("sealed_v3_treatment_render_evidence_missing")
    if not outcome["realOutcomeEvidenceReady"]:
        blockers.append("real_equal_age_outcome_metrics_insufficient")
    payload = {
        "schemaVersion": 1,
        "artifactType": "DynamicMusicAutoresearchReadiness",
        "contractVersion": contract.get("contractVersion"),
        "rootPathPersisted": False,
        "licensedMusicAssets": tracks,
        "styleReferenceMedia": references,
        "observedControlFiles": control_files,
        "observedControlBinding": control_binding,
        "licensedAssetsReady": tracks_ready,
        "referenceMediaAvailable": references_available,
        "sealedReferenceLabelCount": reference_label_count,
        "referenceLabelReadiness": reference_labels,
        "observedControlReady": control_ready,
        "observedControlPerformanceLabelAvailable": False,
        "v3TreatmentRenderBound": bool(render_binding_pass),
        "realOutcomeEvidence": outcome,
        "calibrationReady": calibration_ready,
        "blockers": blockers,
        "decisionState": (
            HUMAN_AB_REQUIRED if calibration_ready else CALIBRATION_NOT_READY
        ),
        "autoPromotionAllowed": False,
    }
    return _seal(payload)


def build_music_only_experiment_recipe(
    control: Mapping[str, object],
    plan_evaluation: Mapping[str, object],
) -> Dict[str, object]:
    control_identity = {
        "videoId": control.get("videoId"),
        "videoSha256": control.get("videoSha256"),
        "sourceHash": control.get("sourceHash"),
        "transcriptTimingHash": control.get("transcriptTimingHash"),
        "speechIntervalSeconds": control.get("speechIntervalSeconds"),
        "renderIntervalSeconds": control.get("renderIntervalSeconds"),
    }
    fixed = dict(control.get("fixedAxes") or {})
    render_bound = plan_evaluation.get("renderBindingPass") is True
    plan_safe = plan_evaluation.get("planGuardrailsPass") is True
    blockers = []
    if not plan_safe:
        blockers.append("treatment_plan_guardrails_failed")
    if not render_bound:
        blockers.append("sealed_v3_treatment_render_evidence_missing")
    blockers.extend(
        [
            "sealed_music_only_pair_equivalence_not_yet_proven",
            "human_listening_ab_not_yet_recorded",
            "real_equal_age_outcome_metrics_not_yet_available",
        ]
    )
    payload = {
        "schemaVersion": 1,
        "artifactType": "DynamicMusicExperimentRecipe",
        "experimentVersion": MUSIC_EXPERIMENT_VERSION,
        "experimentId": "bf-dynamic-music-v1-calibration",
        "changedAxes": list(CHANGED_AXES),
        "controlIdentity": {
            **control_identity,
            "contentHash": content_hash(control_identity),
        },
        "control": {
            "role": "observed_render_control_only",
            "musicTreatment": control.get("musicTreatment"),
            "performanceLabel": None,
            "retentionClaim": None,
        },
        "treatment": {
            "musicTreatment": DYNAMIC_MUSIC_PLAN_VERSION,
            "planHash": plan_evaluation.get("planHash"),
            "planGuardrailsPass": plan_safe,
            "renderBindingPass": render_bound,
        },
        "fixedAxes": fixed,
        "requiredPairProof": {
            "sameSourceHash": True,
            "sameTranscriptTimingHash": True,
            "sameSpeechAndRenderIntervals": True,
            "sameLayoutCaptionsGradeTailEnhancementAndSourceCuts": True,
            "sameLicensedMusicAssetSha256": True,
            "controlAndTreatmentRenderEvidenceRequired": True,
        },
        "humanListeningRubric": [
            "speech_is_never_masked",
            "music_supports_the_complete_hook_proposition",
            "clarity_pocket_makes_the_payoff_easier_to_follow",
            "payoff_emphasis_feels_stable_not_shaky_or_pumped",
            "release_preserves_the_speaker_breath_and_natural_tail",
        ],
        "futureLivePolicy": {
            "equalAgeGateHours": 168,
            "minimumPerTreatment": 3,
            "requiredSources": sorted(REAL_OUTCOME_SOURCES),
            "primaryMetrics": [
                "stayedToWatchPercent",
                "averagePercentageViewed",
            ],
            "speechSafetyMetrics": [
                "audioQaPass",
                "humanSpeechMaskingFailureCount",
            ],
            "winnerSelectionImplemented": False,
        },
        "blockers": blockers,
        "decisionState": (
            HUMAN_AB_REQUIRED
            if plan_safe and render_bound and len(blockers) == 0
            else CALIBRATION_NOT_READY
        ),
        "humanDecisionRequired": True,
        "autoPromotionAllowed": False,
    }
    return _seal(payload)


def build_music_calibration_lifecycle(
    *,
    deterministic: bool,
    plan_guardrails_pass: bool,
    readiness: Mapping[str, object],
) -> Dict[str, object]:
    """Expose the first unmet stage; never skip directly to promotion."""
    stages = [
        {
            "stage": "inventory_and_control_binding",
            "passed": readiness.get("licensedAssetsReady") is True
            and readiness.get("referenceMediaAvailable") is True
            and readiness.get("observedControlReady") is True,
        },
        {
            "stage": "offline_plan_search",
            "passed": deterministic and plan_guardrails_pass,
        },
        {
            "stage": "treatment_render_binding",
            "passed": readiness.get("v3TreatmentRenderBound") is True,
        },
        {
            "stage": "reference_label_calibration",
            "passed": (
                readiness.get("referenceLabelReadiness", {}).get("labelsReady")
                is True
            ),
        },
        # No artifact for this stage is accepted yet.  It intentionally blocks
        # live interpretation until an explicit pairwise human judgment schema
        # is implemented and reviewed.
        {"stage": "human_listening_ab", "passed": False},
        {
            "stage": "real_equal_age_outcomes",
            "passed": (
                readiness.get("realOutcomeEvidence", {}).get(
                    "realOutcomeEvidenceReady"
                )
                is True
            ),
        },
        {"stage": "human_promotion_decision", "passed": False},
    ]
    first_unmet = next(
        (item["stage"] for item in stages if item["passed"] is not True),
        "human_promotion_decision",
    )
    payload = {
        "schemaVersion": 1,
        "artifactType": "DynamicMusicCalibrationLifecycle",
        "lifecycleVersion": MUSIC_LIFECYCLE_VERSION,
        "stages": stages,
        "currentStage": first_unmet,
        "state": "blocked",
        "decisionState": (
            HUMAN_AB_REQUIRED
            if readiness.get("v3TreatmentRenderBound") is True
            else CALIBRATION_NOT_READY
        ),
        "humanDecisionRequired": True,
        "autoPromotionAllowed": False,
    }
    return _seal(payload)


def build_baseline_music_autoresearch_run(
    root: Path,
    contract: Mapping[str, object],
    control: Mapping[str, object],
    *,
    render_evidence: Optional[Mapping[str, object]] = None,
    outcome_observations: Sequence[Mapping[str, object]] = (),
) -> Dict[str, object]:
    planning = dict(control["planningInputs"])
    arguments = {
        "candidate": dict(planning["candidate"]),
        "caption_cues": list(planning["captionCues"]),
        "duration": float(planning["durationSeconds"]),
        "speech_end_seconds": float(planning["speechEndSeconds"]),
        "natural_tail_end_seconds": float(
            planning["naturalTailEndSeconds"]
        ),
    }
    first = build_dynamic_music_plan(**arguments)
    second = build_dynamic_music_plan(**arguments)
    deterministic = first == second
    baseline_evaluation = evaluate_dynamic_music_plan(
        first,
    )
    search = search_dynamic_music_timing_variants(
        first,
        render_evidence=render_evidence,
        authorized_music_assets=contract.get("licensedMusicAssets") or [],
        asset_root=Path(root),
    )
    selected = search.get("selectedOfflineProxyCandidate") or {}
    treatment_plan = selected.get("plan") or first
    evaluation = selected.get("planEvaluation") or baseline_evaluation
    recipe = build_music_only_experiment_recipe(control, evaluation)
    readiness = assess_music_data_readiness(
        root,
        contract,
        control,
        experiment_recipe=recipe,
        outcome_observations=outcome_observations,
        render_binding_pass=evaluation["renderBindingPass"] is True,
    )
    lifecycle = build_music_calibration_lifecycle(
        deterministic=deterministic,
        plan_guardrails_pass=evaluation["planGuardrailsPass"] is True,
        readiness=readiness,
    )
    code_bindings = {
        "contractHash": contract.get("contentHash"),
        "controlHash": control.get("contentHash"),
        "evaluatorCodeSha256": file_sha256(str(Path(__file__).resolve())),
        "dynamicMusicCodeSha256": file_sha256(
            str(ROOT / "shorts_generator" / "dynamic_music.py")
        ),
        "renderEvidenceHash": (
            render_evidence.get("contentHash")
            if isinstance(render_evidence, Mapping)
            else None
        ),
        "outcomeObservationSetHash": content_hash(
            sorted(
                str(item.get("contentHash") or "")
                for item in outcome_observations
            )
        ),
    }
    payload = {
        "schemaVersion": 1,
        "artifactType": "DynamicMusicAutoresearchRun",
        "runVersion": MUSIC_AUTORESEARCH_VERSION,
        "experimentId": contract.get("experimentId"),
        "offlineOnly": True,
        "networkCalls": 0,
        "llmCalls": 0,
        "downloads": 0,
        "renders": 0,
        "uploads": 0,
        "controlRole": "observed_render_control_only",
        "controlPerformanceLabel": None,
        "planDeterministic": deterministic,
        "baselinePlan": first,
        "baselinePlanEvaluation": baseline_evaluation,
        "offlineSearch": search,
        "proposedTreatmentPlan": treatment_plan,
        "proposedTreatmentPlanEvaluation": evaluation,
        "dataReadiness": readiness,
        "experimentRecipe": recipe,
        "lifecycle": lifecycle,
        "inputAndCodeBindings": code_bindings,
        "finalStatus": lifecycle["decisionState"],
        "autoPromotionAllowed": False,
    }
    return _seal(payload)


def _load_json(path: Path) -> Dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain one JSON object")
    return value


def _atomic_json(path: Path, payload: Mapping[str, object]) -> Path:
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.",
        suffix=".tmp",
        dir=str(target.parent),
    )
    descriptor_open = True
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor_open = False
            json.dump(
                payload,
                handle,
                indent=2,
                sort_keys=True,
                ensure_ascii=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, target)
    finally:
        if descriptor_open:
            os.close(descriptor)
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)
    return target


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the offline DynamicMusic autoresearch baseline"
    )
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT_PATH)
    parser.add_argument("--control", type=Path, default=DEFAULT_CONTROL_PATH)
    parser.add_argument("--render-evidence", type=Path)
    parser.add_argument(
        "--outcome-observation",
        "--analytics",
        dest="outcome_observations",
        action="append",
        type=Path,
        default=[],
        help=(
            "sealed DynamicMusicOutcomeObservation; raw analytics snapshots "
            "are rejected"
        ),
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--compact", action="store_true")
    args = parser.parse_args(argv)
    contract = load_music_autoresearch_contract(args.contract)
    control = load_observed_music_control(args.control)
    render_evidence = (
        _load_json(args.render_evidence) if args.render_evidence else None
    )
    observations = [_load_json(path) for path in args.outcome_observations]
    report = build_baseline_music_autoresearch_run(
        args.root,
        contract,
        control,
        render_evidence=render_evidence,
        outcome_observations=observations,
    )
    if args.output:
        _atomic_json(args.output, report)
    print(
        json.dumps(
            report,
            indent=None if args.compact else 2,
            sort_keys=True,
            ensure_ascii=True,
        )
    )
    return 0 if report["lifecycle"]["state"] != "blocked" else BLOCKED_EXIT_CODE


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "CALIBRATION_NOT_READY",
    "CHANGED_AXES",
    "DEFAULT_CONTRACT_PATH",
    "DEFAULT_CONTROL_PATH",
    "HUMAN_AB_REQUIRED",
    "MUSIC_AUTORESEARCH_VERSION",
    "MUSIC_EXPERIMENT_VERSION",
    "MUSIC_PLAN_EVALUATION_VERSION",
    "PLAN_GUARDRAIL_THRESHOLDS",
    "assess_music_data_readiness",
    "assess_real_outcome_evidence",
    "build_baseline_music_autoresearch_run",
    "build_music_only_experiment_recipe",
    "evaluate_dynamic_music_plan",
    "load_music_autoresearch_contract",
    "load_observed_music_control",
    "search_dynamic_music_timing_variants",
]
