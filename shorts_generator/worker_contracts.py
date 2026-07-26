"""Versioned, path-free contracts shared with the Node control plane."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Callable


SCHEMA_VERSION = 1
CONTENT_TYPES = {"football", "motivational", "narrated_animation"}
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
HASH_PATTERN = re.compile(r"^[a-f0-9]{64}$")


class WorkerContractError(ValueError):
    def __init__(self, code: str, field: str):
        super().__init__(f"{code}: invalid {field}")
        self.code = code
        self.field = field


def _object(
    value: Any,
    required: set[str],
    optional: set[str],
    field: str,
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - required - optional:
        raise WorkerContractError("CONTRACT_SHAPE_INVALID", field)
    if required - set(value):
        raise WorkerContractError("CONTRACT_FIELD_REQUIRED", field)
    return value


def _version(value: Any, field: str = "schemaVersion") -> int:
    if value != SCHEMA_VERSION:
        raise WorkerContractError("CONTRACT_VERSION_UNSUPPORTED", field)
    return SCHEMA_VERSION


def _identifier(value: Any, field: str) -> str:
    normalized = str(value or "")
    if not ID_PATTERN.fullmatch(normalized):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", field)
    return normalized


def _hash(value: Any, field: str) -> str:
    normalized = str(value or "").lower().removeprefix("sha256:")
    if not HASH_PATTERN.fullmatch(normalized):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", field)
    return normalized


def _number(
    value: Any,
    field: str,
    *,
    minimum: float = 0,
    maximum: float | None = None,
    integer: bool = False,
) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", field)
    if integer and not isinstance(value, int):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", field)
    if value < minimum or (maximum is not None and value > maximum):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", field)
    return value


def validate_artifact_manifest(value: Any) -> dict[str, Any]:
    item = _object(
        value,
        {"schemaVersion", "artifactId", "kind", "sha256", "sizeBytes"},
        {"media", "extensions"},
        "artifactManifest",
    )
    _version(item["schemaVersion"])
    _identifier(item["artifactId"], "artifactId")
    if item["kind"] not in {"source", "transcript", "analysis", "preview", "render", "qa"}:
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "kind")
    _hash(item["sha256"], "sha256")
    _number(item["sizeBytes"], "sizeBytes", minimum=1, integer=True)
    if "media" in item:
        media = _object(
            item["media"],
            {"mimeType"},
            {"durationMs", "width", "height"},
            "media",
        )
        if not re.fullmatch(r"(?:video|audio|application)/[a-z0-9.+-]{1,64}", str(media["mimeType"])):
            raise WorkerContractError("CONTRACT_VALUE_INVALID", "media.mimeType")
        for field in ("durationMs", "width", "height"):
            if field in media:
                _number(media[field], f"media.{field}", minimum=1, integer=True)
    return dict(item)


def validate_candidate(value: Any) -> dict[str, Any]:
    item = _object(
        value,
        {
            "schemaVersion",
            "candidateId",
            "sourceArtifactId",
            "startMs",
            "endMs",
            "contentType",
            "rankingScore",
            "evidence",
        },
        {"extensions"},
        "candidate",
    )
    _version(item["schemaVersion"])
    _identifier(item["candidateId"], "candidateId")
    _identifier(item["sourceArtifactId"], "sourceArtifactId")
    start = _number(item["startMs"], "startMs", integer=True)
    end = _number(item["endMs"], "endMs", minimum=1, integer=True)
    if end <= start:
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "endMs")
    if item["contentType"] not in CONTENT_TYPES:
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "contentType")
    _number(item["rankingScore"], "rankingScore", maximum=100)
    evidence = item["evidence"]
    if (
        not isinstance(evidence, list)
        or not 1 <= len(evidence) <= 32
        or any(not isinstance(code, str) or not CODE_PATTERN.fullmatch(code) for code in evidence)
    ):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "evidence")
    return dict(item)


def validate_hook_gate_decision(value: Any) -> dict[str, Any]:
    item = _object(
        value,
        {
            "schemaVersion",
            "candidateId",
            "gateVersion",
            "decision",
            "reasonCodes",
            "metrics",
        },
        {"extensions"},
        "hookGateDecision",
    )
    _version(item["schemaVersion"])
    _identifier(item["candidateId"], "candidateId")
    if item["gateVersion"] not in {"hook-gate-v2", "hook-gate-v3"}:
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "gateVersion")
    if item["decision"] not in {"pass", "reject", "human_review"}:
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "decision")
    reasons = item["reasonCodes"]
    if not isinstance(reasons, list) or len(reasons) > 32 or any(
        not isinstance(code, str) or not CODE_PATTERN.fullmatch(code) for code in reasons
    ):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "reasonCodes")
    metrics = _object(
        item["metrics"],
        {"boundaryCompleteness", "captionReadability", "visualSubjectCoverage"},
        {"latencyMs", "estimatedCostUsd"},
        "metrics",
    )
    for field in ("boundaryCompleteness", "captionReadability", "visualSubjectCoverage"):
        _number(metrics[field], f"metrics.{field}", maximum=100)
    if "latencyMs" in metrics:
        _number(metrics["latencyMs"], "metrics.latencyMs", integer=True)
    if "estimatedCostUsd" in metrics:
        _number(metrics["estimatedCostUsd"], "metrics.estimatedCostUsd")
    return dict(item)


def _source_reference(value: Any) -> dict[str, Any]:
    source = _object(value, {"artifactId", "sha256"}, set(), "source")
    _identifier(source["artifactId"], "source.artifactId")
    _hash(source["sha256"], "source.sha256")
    return source


def validate_analysis_request(value: Any) -> dict[str, Any]:
    item = _object(
        value,
        {"schemaVersion", "requestId", "operation", "source", "options"},
        {"extensions"},
        "analysisRequest",
    )
    _version(item["schemaVersion"])
    _identifier(item["requestId"], "requestId")
    if item["operation"] != "analysis":
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "operation")
    _source_reference(item["source"])
    options = _object(
        item["options"],
        {"contentType", "language", "maxCandidates"},
        set(),
        "options",
    )
    if options["contentType"] not in CONTENT_TYPES:
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "options.contentType")
    if not re.fullmatch(r"(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)", str(options["language"])):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "options.language")
    _number(options["maxCandidates"], "options.maxCandidates", minimum=1, maximum=100, integer=True)
    return dict(item)


def validate_analysis_result(value: Any) -> dict[str, Any]:
    item = _object(
        value,
        {"schemaVersion", "requestId", "operation", "status", "candidates", "hookGate"},
        {"artifact", "extensions"},
        "analysisResult",
    )
    _version(item["schemaVersion"])
    _identifier(item["requestId"], "requestId")
    if item["operation"] != "analysis" or item["status"] != "succeeded":
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "status")
    if not isinstance(item["candidates"], list) or not 1 <= len(item["candidates"]) <= 100:
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "candidates")
    candidates = [validate_candidate(candidate) for candidate in item["candidates"]]
    if not isinstance(item["hookGate"], list) or len(item["hookGate"]) != len(candidates):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "hookGate")
    decisions = [validate_hook_gate_decision(decision) for decision in item["hookGate"]]
    if {item["candidateId"] for item in candidates} != {
        item["candidateId"] for item in decisions
    }:
        raise WorkerContractError("CONTRACT_LINK_INVALID", "hookGate")
    if "artifact" in item:
        validate_artifact_manifest(item["artifact"])
    return dict(item)


def validate_render_request(value: Any) -> dict[str, Any]:
    item = _object(
        value,
        {"schemaVersion", "requestId", "operation", "source", "candidate", "hookGate", "profile"},
        {"extensions"},
        "renderRequest",
    )
    _version(item["schemaVersion"])
    _identifier(item["requestId"], "requestId")
    if item["operation"] != "render":
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "operation")
    source = _source_reference(item["source"])
    candidate = validate_candidate(item["candidate"])
    decision = validate_hook_gate_decision(item["hookGate"])
    if (
        candidate["sourceArtifactId"] != source["artifactId"]
        or decision["candidateId"] != candidate["candidateId"]
        or decision["decision"] != "pass"
    ):
        raise WorkerContractError("CONTRACT_LINK_INVALID", "candidate")
    profile = _object(
        item["profile"],
        {"formatProfile", "selectionProfile", "renderProfile"},
        set(),
        "profile",
    )
    for field, identifier in profile.items():
        _identifier(identifier, f"profile.{field}")
    return dict(item)


def validate_render_result(value: Any) -> dict[str, Any]:
    item = _object(
        value,
        {"schemaVersion", "requestId", "operation", "status", "artifact", "qa"},
        {"extensions"},
        "renderResult",
    )
    _version(item["schemaVersion"])
    _identifier(item["requestId"], "requestId")
    if item["operation"] != "render" or item["status"] != "succeeded":
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "status")
    artifact = validate_artifact_manifest(item["artifact"])
    if artifact["kind"] != "render":
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "artifact.kind")
    qa = _object(item["qa"], {"passed", "codes"}, set(), "qa")
    if not isinstance(qa["passed"], bool) or not isinstance(qa["codes"], list):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "qa")
    if any(not isinstance(code, str) or not CODE_PATTERN.fullmatch(code) for code in qa["codes"]):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "qa.codes")
    if not qa["passed"]:
        raise WorkerContractError("CONTRACT_LINK_INVALID", "qa.passed")
    return dict(item)


def validate_error_response(value: Any) -> dict[str, Any]:
    item = _object(
        value,
        {"schemaVersion", "requestId", "status", "error"},
        {"extensions"},
        "errorResponse",
    )
    _version(item["schemaVersion"])
    _identifier(item["requestId"], "requestId")
    if item["status"] != "error":
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "status")
    error = _object(item["error"], {"code", "message", "retryable"}, {"field"}, "error")
    if not isinstance(error["code"], str) or not CODE_PATTERN.fullmatch(error["code"]):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "error.code")
    if not isinstance(error["message"], str) or not 1 <= len(error["message"]) <= 240:
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "error.message")
    if not isinstance(error["retryable"], bool):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "error.retryable")
    if "field" in error and not ID_PATTERN.fullmatch(str(error["field"])):
        raise WorkerContractError("CONTRACT_VALUE_INVALID", "error.field")
    return dict(item)


VALIDATORS: dict[str, Callable[[Any], dict[str, Any]]] = {
    "analysisRequest": validate_analysis_request,
    "analysisResult": validate_analysis_result,
    "renderRequest": validate_render_request,
    "renderResult": validate_render_result,
    "candidate": validate_candidate,
    "hookGateDecision": validate_hook_gate_decision,
    "artifactManifest": validate_artifact_manifest,
    "errorResponse": validate_error_response,
}


def validate_fixture(path: str | Path) -> None:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    fixture = _object(payload, set(VALIDATORS), set(), "fixture")
    for name, validator in VALIDATORS.items():
        validator(fixture[name])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validate-fixture", required=True)
    args = parser.parse_args()
    try:
        validate_fixture(args.validate_fixture)
    except (OSError, json.JSONDecodeError, WorkerContractError) as error:
        print(str(error))
        return 1
    print("worker contract fixture valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
