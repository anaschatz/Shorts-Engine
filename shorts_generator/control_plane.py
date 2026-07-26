"""Fail-closed bindings for the Node motivational-source control plane."""
from __future__ import annotations

import os
import json
import hashlib
from pathlib import Path
from typing import Dict, Mapping, Optional

from .artifact_contracts import file_sha256
from .profiles import (
    BF_EDITORIAL_INSET_V1,
    BF_VIRAL_MICRO_V1,
    MOTIVATIONAL_PODCAST,
    MOTIVATIONAL_TENSION_MICRO_V1,
)


CONTROL_BINDING_ENV = {
    "source_hash": "SHORTSENGINE_CONTROL_SOURCE_SHA256",
    "rights_manifest_hash": "SHORTSENGINE_CONTROL_RIGHTS_MANIFEST_SHA256",
    "candidate_decision_hash": "SHORTSENGINE_CONTROL_CANDIDATE_DECISION_SHA256",
    "candidate_hash": "SHORTSENGINE_CONTROL_APPROVED_CANDIDATE_SHA256",
    "experiment_manifest_hash": "SHORTSENGINE_CONTROL_EXPERIMENT_MANIFEST_SHA256",
    "transcript_manifest_hash": "SHORTSENGINE_CONTROL_TRANSCRIPT_MANIFEST_SHA256",
}
CONTROL_INPUT_PATH_ENV = "SHORTSENGINE_CONTROL_INPUT_PATH"
CONTROL_INPUT_HASH_ENV = "SHORTSENGINE_CONTROL_INPUT_SHA256"
EXPECTED_PROFILES = {
    "content_profile": MOTIVATIONAL_PODCAST,
    "selection_profile": MOTIVATIONAL_TENSION_MICRO_V1,
    "render_profile": BF_EDITORIAL_INSET_V1,
    "format_profile": BF_VIRAL_MICRO_V1,
}


class ControlPlaneBindingError(ValueError):
    """Raised when a control-plane result cannot prove its immutable inputs."""


def _sha256(value: object, field: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized.startswith("sha256:"):
        normalized = normalized[7:]
    if len(normalized) != 64 or any(char not in "0123456789abcdef" for char in normalized):
        raise ControlPlaneBindingError(f"{field} must be a sha256 hash")
    return normalized


def _exact_keys(value: object, fields: set[str], label: str) -> Dict:
    if not isinstance(value, dict) or set(value) != fields:
        raise ControlPlaneBindingError(f"{label} has an invalid shape")
    return value


def load_control_plane_request(
    env: Optional[Mapping[str, str]] = None,
) -> Optional[Dict]:
    """Load the Node-sealed approved-render request before expensive work."""
    source_env = os.environ if env is None else env
    required_env = [*CONTROL_BINDING_ENV.values(), CONTROL_INPUT_PATH_ENV, CONTROL_INPUT_HASH_ENV]
    configured = [name in source_env for name in required_env]
    if not any(configured):
        return None
    if not all(configured):
        raise ControlPlaneBindingError("control-plane approved-render request is incomplete")
    bindings = {
        field: _sha256(source_env.get(env_name), env_name)
        for field, env_name in CONTROL_BINDING_ENV.items()
    }
    input_hash = _sha256(source_env.get(CONTROL_INPUT_HASH_ENV), CONTROL_INPUT_HASH_ENV)
    input_path = Path(str(source_env.get(CONTROL_INPUT_PATH_ENV) or "").strip())
    if (
        not input_path.is_absolute()
        or input_path.is_symlink()
        or not input_path.is_file()
        or input_path.stat().st_size <= 0
        or input_path.stat().st_size > 64 * 1024 * 1024
    ):
        raise ControlPlaneBindingError("control-plane input path is not a safe local file")
    input_bytes = input_path.read_bytes()
    if hashlib.sha256(input_bytes).hexdigest() != input_hash:
        raise ControlPlaneBindingError("control-plane input file hash does not match")
    try:
        request = json.loads(input_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ControlPlaneBindingError("control-plane input is not valid JSON") from error
    request = _exact_keys(
        request,
        {"schemaVersion", "candidateDecision", "experimentManifest", "transcriptManifest"},
        "control-plane input",
    )
    if request.get("schemaVersion") != 1:
        raise ControlPlaneBindingError("control-plane input schema is unsupported")
    decision = request.get("candidateDecision")
    experiment = request.get("experimentManifest")
    transcript = request.get("transcriptManifest")
    if not all(isinstance(value, dict) for value in (decision, experiment, transcript)):
        raise ControlPlaneBindingError("control-plane artifacts are missing")
    if (
        decision.get("artifactType") != "CandidateDecision"
        or decision.get("contentHash") != bindings["candidate_decision_hash"]
        or decision.get("candidateHash") != bindings["candidate_hash"]
        or decision.get("sourceHash") != bindings["source_hash"]
        or decision.get("selectionProfile") != EXPECTED_PROFILES["selection_profile"]
        or decision.get("decision") != "approved"
    ):
        raise ControlPlaneBindingError("candidate decision is stale or not approved")
    if (
        experiment.get("artifactType") != "ExperimentManifest"
        or experiment.get("contentHash") != bindings["experiment_manifest_hash"]
        or experiment.get("candidateDecisionHash") != bindings["candidate_decision_hash"]
        or experiment.get("candidateHash") != bindings["candidate_hash"]
        or experiment.get("formatProfile") != EXPECTED_PROFILES["format_profile"]
        or experiment.get("selectionProfile") != EXPECTED_PROFILES["selection_profile"]
        or experiment.get("renderProfile") != EXPECTED_PROFILES["render_profile"]
    ):
        raise ControlPlaneBindingError("experiment manifest is stale or incompatible")
    if (
        transcript.get("artifactType") != "TranscriptManifest"
        or transcript.get("contentHash") != bindings["transcript_manifest_hash"]
        or transcript.get("sourceHash") != bindings["source_hash"]
        or not isinstance(transcript.get("transcript"), dict)
    ):
        raise ControlPlaneBindingError("transcript manifest is stale or incompatible")
    return {
        "bindings": bindings,
        "candidateDecision": decision,
        "experimentManifest": experiment,
        "transcriptManifest": transcript,
        "inputPath": str(input_path.resolve()),
        "inputHash": input_hash,
    }


def bind_control_plane_result(
    result: Dict,
    env: Optional[Mapping[str, str]] = None,
    request: Optional[Dict] = None,
) -> Dict:
    """Attach verified Node bindings when the control-plane env contract is active.

    Normal standalone CLI runs do not set these variables and remain unchanged.
    Presence of any variable activates the contract; all three hashes, the exact
    local production profile, and the unchanged source file then become mandatory.
    """
    if not isinstance(result, dict):
        raise ControlPlaneBindingError("worker result must be an object")
    if "control_plane_bindings" in result or "controlPlaneBindings" in result:
        raise ControlPlaneBindingError("worker result already contains control-plane bindings")

    approved_request = request if request is not None else load_control_plane_request(env)
    if approved_request is None:
        return dict(result)
    bindings = approved_request["bindings"]
    if result.get("mode") != "local":
        raise ControlPlaneBindingError("control-plane rendering requires local mode")
    profiles = result.get("profiles")
    if not isinstance(profiles, dict):
        raise ControlPlaneBindingError("control-plane result is missing profiles")
    for field, expected in EXPECTED_PROFILES.items():
        if str(profiles.get(field) or "").strip().lower() != expected:
            raise ControlPlaneBindingError(
                f"control-plane rendering requires {field}={expected}"
            )

    raw_source_path = str(result.get("source_video_url") or "").strip()
    source_path = Path(raw_source_path)
    if not raw_source_path or not source_path.is_absolute() or not source_path.is_file():
        raise ControlPlaneBindingError("control-plane source path is not a local file")
    resolved_source = source_path.resolve()
    actual_source_hash = file_sha256(str(resolved_source))
    if actual_source_hash != bindings["source_hash"]:
        raise ControlPlaneBindingError("control-plane source hash does not match the source file")
    shorts = result.get("shorts")
    if (
        not isinstance(shorts, list)
        or len(shorts) != 1
        or not isinstance(shorts[0], dict)
        or shorts[0].get("error")
        or str(shorts[0].get("candidate_hash") or "").strip().lower()
        != bindings["candidate_hash"]
    ):
        raise ControlPlaneBindingError("rendered short is not the approved candidate")

    return {
        **result,
        "source_video_url": str(resolved_source),
        "control_plane_bindings": bindings,
    }


__all__ = [
    "CONTROL_BINDING_ENV",
    "CONTROL_INPUT_HASH_ENV",
    "CONTROL_INPUT_PATH_ENV",
    "EXPECTED_PROFILES",
    "ControlPlaneBindingError",
    "bind_control_plane_result",
    "load_control_plane_request",
]
