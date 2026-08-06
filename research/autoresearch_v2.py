"""Deterministic Budget Friendly Autoresearch V2 evaluation contracts.

This module is intentionally offline. It evaluates already-paid replay
artifacts and fingerprints experiment code; it never discovers clips, calls a
model, decodes video, renders, enhances, uploads, or mutates profiles.
"""
from __future__ import annotations

import hashlib
import builtins
import io
import json
import math
import os
import socket
import subprocess
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Iterable, Mapping, Optional, Sequence

from shorts_generator.growth_replay import build_growth_replay_report


AUTORESEARCH_V2_VERSION = "bf-autoresearch-v2.0.0"
AUTORESEARCH_EVALUATION_VERSION = "bf-selection-evaluation-v2.0.0"
DEFAULT_CONTRACT_PATH = Path(__file__).with_name("autoresearch-v2-contract.json")


class ReplayDataUnavailable(ValueError):
    """Raised when an immutable replay manifest references missing evidence."""

    def __init__(self, report: Mapping[str, object]):
        super().__init__("Budget Friendly replay evidence is unavailable")
        self.report = dict(report)


def _canonical_hash(value: object) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _seal(payload: Mapping[str, object]) -> Dict[str, object]:
    body = dict(payload)
    body.pop("contentHash", None)
    return {**body, "contentHash": _canonical_hash(body)}


def verify_local_seal(
    artifact: Mapping[str, object],
    artifact_type: str,
) -> Dict[str, object]:
    if not isinstance(artifact, Mapping) or artifact.get("artifactType") != artifact_type:
        raise ValueError(f"expected {artifact_type}")
    declared = str(artifact.get("contentHash") or "").strip().lower()
    if len(declared) != 64:
        raise ValueError(f"{artifact_type} contentHash is invalid")
    body = {key: value for key, value in artifact.items() if key != "contentHash"}
    if declared != _canonical_hash(body):
        raise ValueError(f"{artifact_type} seal is invalid")
    return dict(artifact)


def load_autoresearch_contract(
    path: Path = DEFAULT_CONTRACT_PATH,
) -> Dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("autoresearch contract must be an object")
    if value.get("artifactType") != "BudgetFriendlyAutoresearchContract":
        raise ValueError("unexpected autoresearch contract type")
    if value.get("contractVersion") != AUTORESEARCH_V2_VERSION:
        raise ValueError("unexpected autoresearch contract version")
    if value.get("evaluationLane") != "semantic_closure":
        raise ValueError("the first autoresearch V2 lane must be semantic_closure")
    for section in ("dataReadinessGates", "keepRules", "graduationRules"):
        if not isinstance(value.get(section), dict) or not value[section]:
            raise ValueError(f"autoresearch {section} is required")
    editable = [str(item) for item in value.get("editableScope") or []]
    protected = [str(item) for item in value.get("protectedScope") or []]
    if not editable or not protected:
        raise ValueError("autoresearch editable and protected scopes are required")
    if set(editable) & set(protected):
        raise ValueError("autoresearch editable/protected scopes overlap")
    return dict(value)


def contract_fingerprint(contract: Mapping[str, object]) -> str:
    return _canonical_hash(dict(contract))


def _replay_evidence_paths(
    root: Path,
    contract: Mapping[str, object],
) -> set[str]:
    manifest_value = str(contract.get("replayManifest") or "").strip()
    if not manifest_value:
        return set()
    manifest_path = Path(manifest_value)
    manifest_path = manifest_path if manifest_path.is_absolute() else root / manifest_path
    if not manifest_path.is_file():
        return {manifest_value}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {manifest_value}
    paths = {manifest_value}
    if isinstance(manifest, Mapping):
        for spec in manifest.get("datasets") or []:
            if not isinstance(spec, Mapping):
                continue
            for field in ("candidate_path", "transcript_path", "positive_path"):
                value = str(spec.get(field) or "").strip()
                if value:
                    paths.add(value)
    return paths


def workspace_source_fingerprints(
    root: Path,
    contract: Mapping[str, object],
) -> Dict[str, str]:
    declared = {
        str(path)
        for field in ("editableScope", "protectedScope")
        for path in contract.get(field) or []
    }
    test_sources = {
        str(module).replace(".", "/") + ".py"
        for module in contract.get("fastTestModules") or []
    }
    # Keep the inventory bounded to source code (never recursively hash media,
    # outputs, caches, or arbitrary JSON), while still making an undeclared
    # engine edit observable and therefore classifiable as out-of-scope.
    source_universe = {
        path.relative_to(root).as_posix()
        for directory, pattern in (
            (root / "shorts_generator", "*.py"),
            (root / "research", "*.py"),
        )
        if directory.is_dir()
        for path in directory.rglob(pattern)
        if path.is_file()
    }
    evidence_paths = _replay_evidence_paths(root, contract)
    content_paths = declared | test_sources | evidence_paths
    paths = sorted(content_paths | source_universe)
    return {
        relative: _file_hash(root / relative)
        if (root / relative).is_file()
        else "missing"
        for relative in paths
    }


def classify_source_changes(
    reference: Mapping[str, str],
    current: Mapping[str, str],
    contract: Mapping[str, object],
) -> Dict[str, list[str]]:
    changed = sorted(
        path
        for path in set(reference) | set(current)
        if reference.get(path, "missing") != current.get(path, "missing")
    )
    editable = set(str(path) for path in contract.get("editableScope") or [])
    protected = set(str(path) for path in contract.get("protectedScope") or [])
    support = [path for path in changed if path.startswith("tests/")]
    return {
        "all": changed,
        "editable": [path for path in changed if path in editable],
        "protected": [path for path in changed if path in protected],
        "support": support,
        "outOfScope": [
            path
            for path in changed
            if path not in editable
            and path not in protected
            and not path.startswith("tests/")
        ],
    }


def git_workspace_state(root: Path) -> Dict[str, object]:
    def run(*arguments: str) -> Optional[subprocess.CompletedProcess[str]]:
        try:
            return subprocess.run(
                ["git", *arguments],
                cwd=root,
                capture_output=True,
                text=True,
                check=False,
                timeout=2,
            )
        except subprocess.TimeoutExpired:
            return None

    head = run("rev-parse", "HEAD")
    return {
        "head": head.stdout.strip() if head and head.returncode == 0 else None,
        "trackedDirty": None,
        "statusSkipped": True,
        "timedOut": head is None,
    }


def _ratio(numerator: int, denominator: int) -> Optional[float]:
    return round(float(numerator) / float(denominator), 6) if denominator > 0 else None


@contextmanager
def _offline_evaluation_boundary():
    """Deny accidental network or media subprocess work during replay."""
    original_socket = socket.socket
    original_create_connection = socket.create_connection
    original_getaddrinfo = socket.getaddrinfo
    original_gethostbyname = socket.gethostbyname
    original_gethostbyname_ex = socket.gethostbyname_ex
    original_run = subprocess.run
    original_popen = subprocess.Popen
    original_builtin_open = builtins.open
    original_io_open = io.open
    original_os_open = os.open
    original_mkdir = os.mkdir
    original_makedirs = os.makedirs
    original_rename = os.rename
    original_replace = os.replace
    original_remove = os.remove
    original_unlink = os.unlink
    activity = {
        "networkAttempts": 0,
        "subprocessAttempts": 0,
        "writeAttempts": 0,
    }

    def denied_network(*_args, **_kwargs):
        activity["networkAttempts"] += 1
        raise RuntimeError("offline autoresearch forbids network and subprocess calls")

    def denied_subprocess(*_args, **_kwargs):
        activity["subprocessAttempts"] += 1
        raise RuntimeError("offline autoresearch forbids network and subprocess calls")

    def denied_write(*_args, **_kwargs):
        activity["writeAttempts"] += 1
        raise RuntimeError("offline autoresearch evaluation is read-only")

    def guarded_open(original, file, mode="r", *args, **kwargs):
        normalized_mode = str(mode or "r")
        if any(flag in normalized_mode for flag in ("w", "a", "x", "+")):
            return denied_write()
        return original(file, mode, *args, **kwargs)

    def guarded_os_open(path, flags, mode=0o777, *, dir_fd=None):
        write_flags = (
            os.O_WRONLY
            | os.O_RDWR
            | os.O_APPEND
            | os.O_CREAT
            | os.O_TRUNC
            | os.O_EXCL
        )
        if int(flags) & write_flags:
            return denied_write()
        if dir_fd is None:
            return original_os_open(path, flags, mode)
        return original_os_open(path, flags, mode, dir_fd=dir_fd)

    socket.socket = denied_network
    socket.create_connection = denied_network
    socket.getaddrinfo = denied_network
    socket.gethostbyname = denied_network
    socket.gethostbyname_ex = denied_network
    subprocess.run = denied_subprocess
    subprocess.Popen = denied_subprocess
    builtins.open = lambda file, mode="r", *args, **kwargs: guarded_open(
        original_builtin_open, file, mode, *args, **kwargs
    )
    io.open = lambda file, mode="r", *args, **kwargs: guarded_open(
        original_io_open, file, mode, *args, **kwargs
    )
    os.open = guarded_os_open
    os.mkdir = denied_write
    os.makedirs = denied_write
    os.rename = denied_write
    os.replace = denied_write
    os.remove = denied_write
    os.unlink = denied_write
    try:
        yield activity
    finally:
        socket.socket = original_socket
        socket.create_connection = original_create_connection
        socket.getaddrinfo = original_getaddrinfo
        socket.gethostbyname = original_gethostbyname
        socket.gethostbyname_ex = original_gethostbyname_ex
        subprocess.run = original_run
        subprocess.Popen = original_popen
        builtins.open = original_builtin_open
        io.open = original_io_open
        os.open = original_os_open
        os.mkdir = original_mkdir
        os.makedirs = original_makedirs
        os.rename = original_rename
        os.replace = original_replace
        os.remove = original_remove
        os.unlink = original_unlink


def assess_replay_data_readiness(
    root: Path,
    contract: Mapping[str, object],
) -> Dict[str, object]:
    manifest_relative = str(contract["replayManifest"])
    manifest_path = root / manifest_relative
    missing = []
    datasets = []
    if not manifest_path.is_file():
        missing.append(manifest_relative)
        manifest = None
    else:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if isinstance(manifest, Mapping):
        for index, spec in enumerate(manifest.get("datasets") or []):
            if not isinstance(spec, Mapping):
                continue
            dataset_id = str(spec.get("id") or f"dataset-{index}")
            declared_paths = []
            for field in ("candidate_path", "transcript_path", "positive_path"):
                value = str(spec.get(field) or "").strip()
                if not value:
                    continue
                candidate_path = Path(value)
                resolved = candidate_path if candidate_path.is_absolute() else root / candidate_path
                declared_paths.append(
                    {
                        "field": field,
                        "path": value,
                        "exists": resolved.is_file(),
                    }
                )
                if not resolved.is_file():
                    missing.append(value)
            datasets.append(
                {
                    "datasetId": dataset_id,
                    "artifacts": declared_paths,
                    "ready": all(item["exists"] for item in declared_paths),
                }
            )
    payload = {
        "schemaVersion": 1,
        "artifactType": "BudgetFriendlyAutoresearchDataReadiness",
        "contractVersion": contract["contractVersion"],
        "replayManifest": manifest_relative,
        "manifestFingerprint": (
            _file_hash(manifest_path) if manifest_path.is_file() else None
        ),
        "datasetCount": len(datasets),
        "readyDatasetCount": sum(item["ready"] for item in datasets),
        "missingArtifactCount": len(set(missing)),
        "missingArtifacts": sorted(set(missing)),
        "replayable": bool(datasets) and not missing,
        "datasets": datasets,
    }
    return _seal(payload)


def _reason_contains(reasons: Iterable[object], fragments: Sequence[str]) -> bool:
    normalized = " ".join(str(reason).strip().casefold() for reason in reasons)
    return any(fragment in normalized for fragment in fragments)


def _selected_failure_counts(replay: Mapping[str, object]) -> Dict[str, int]:
    incomplete = 0
    context = 0
    promotional = 0
    for dataset in replay.get("datasets") or []:
        if not isinstance(dataset, Mapping):
            continue
        for candidate in dataset.get("candidates") or []:
            if not isinstance(candidate, Mapping):
                continue
            closure_shadow = candidate.get("closure_shadow")
            if not isinstance(closure_shadow, Mapping) or closure_shadow.get("top_k") is not True:
                continue
            closure = candidate.get("semantic_closure")
            hook = candidate.get("hook_gate")
            closure_reasons = (
                list(closure.get("reasons") or []) if isinstance(closure, Mapping) else []
            )
            hook_reasons = list(hook.get("reasons") or []) if isinstance(hook, Mapping) else []
            selected_reasons = list(closure_shadow.get("reasons") or [])
            if (
                not isinstance(closure, Mapping)
                or closure.get("status") != "pass"
                or _reason_contains(
                    [*closure_reasons, *selected_reasons],
                    ("incomplete", "continuation", "mid_sentence", "unaligned"),
                )
            ):
                incomplete += 1
            if _reason_contains(
                [*hook_reasons, *selected_reasons],
                ("external_antecedent", "context_dependent", "context-dependent"),
            ):
                context += 1
            if _reason_contains(
                [*hook_reasons, *selected_reasons],
                ("promotional", "sponsor", "outro", "cta"),
            ):
                promotional += 1
    return {
        "selectedIncompleteEndingCount": incomplete,
        "selectedContextDependentCount": context,
        "selectedPromotionalCount": promotional,
    }


def _known_positive_outcomes(
    replay: Mapping[str, object],
) -> tuple[list[Dict[str, object]], Dict[str, int]]:
    outcomes = []
    closure_pass_count = 0
    top_k_hit_count = 0
    filled_slot_count = 0
    source_success_count = 0
    full_batch_count = 0
    top_k = int(replay.get("topK") or 3)
    for dataset in replay.get("datasets") or []:
        if not isinstance(dataset, Mapping):
            continue
        dataset_id = str(dataset.get("dataset_id") or dataset.get("id") or "")
        source_hits = 0
        source_filled = 0
        for candidate in dataset.get("candidates") or []:
            if not isinstance(candidate, Mapping):
                continue
            closure_shadow = candidate.get("closure_shadow")
            closure = candidate.get("semantic_closure")
            selected = bool(
                isinstance(closure_shadow, Mapping)
                and closure_shadow.get("top_k") is True
            )
            if selected:
                filled_slot_count += 1
                source_filled += 1
            if candidate.get("human_positive") is not True:
                continue
            closure_passed = bool(
                isinstance(closure, Mapping) and closure.get("status") == "pass"
            )
            closure_pass_count += int(closure_passed)
            top_k_hit_count += int(selected)
            source_hits += int(selected)
            outcomes.append(
                {
                    "replayId": str(candidate.get("replay_id") or ""),
                    "datasetId": dataset_id,
                    "title": str(candidate.get("title") or ""),
                    "closurePassed": closure_passed,
                    "selectedTopK": selected,
                    "positiveLabelAppended": bool(
                        candidate.get("human_positive_appended")
                    ),
                }
            )
        source_success_count += int(source_hits > 0)
        full_batch_count += int(source_filled >= top_k)
    return sorted(outcomes, key=lambda item: str(item["replayId"])), {
        "closurePositivePassCount": closure_pass_count,
        "topKKnownPositiveHitCount": top_k_hit_count,
        "topKFilledSlotCount": filled_slot_count,
        "sourceSuccessAtKCount": source_success_count,
        "fullBatchSourceCount": full_batch_count,
    }


def _macro_ndcg_at_k(replay: Mapping[str, object]) -> Optional[float]:
    values = []
    top_k = int(replay.get("topK") or 3)
    for dataset in replay.get("datasets") or []:
        if not isinstance(dataset, Mapping):
            continue
        candidates = [
            candidate
            for candidate in dataset.get("candidates") or []
            if isinstance(candidate, Mapping)
        ]
        selected = sorted(
            (
                candidate
                for candidate in candidates
                if isinstance(candidate.get("closure_shadow"), Mapping)
                and candidate["closure_shadow"].get("top_k") is True
            ),
            key=lambda candidate: float(candidate["closure_shadow"].get("score") or 0.0),
            reverse=True,
        )[:top_k]
        positive_count = sum(candidate.get("human_positive") is True for candidate in candidates)
        ideal_width = min(top_k, positive_count)
        if ideal_width <= 0:
            continue
        dcg = sum(
            (1.0 if candidate.get("human_positive") is True else 0.0)
            / math.log2(index + 2.0)
            for index, candidate in enumerate(selected)
        )
        ideal = sum(1.0 / math.log2(index + 2.0) for index in range(ideal_width))
        values.append(dcg / ideal)
    return round(sum(values) / len(values), 6) if values else None


def evaluate_budget_friendly_selection(
    root: Path,
    contract: Mapping[str, object],
) -> Dict[str, object]:
    readiness = assess_replay_data_readiness(root, contract)
    if readiness["replayable"] is not True:
        raise ReplayDataUnavailable(readiness)
    manifest_path = root / str(contract["replayManifest"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    with _offline_evaluation_boundary() as offline_activity:
        replay = build_growth_replay_report(
            manifest,
            root=root,
            top_k=max(1, int(contract["topK"])),
        )
    aggregate = replay["aggregate"]
    approved_outcomes, counts = _known_positive_outcomes(replay)
    top_hits = counts["topKKnownPositiveHitCount"]
    human_positives = int(aggregate["human_positive_count"])
    components = {
        "semanticClosureHumanPositiveRecall": aggregate[
            "semantic_closure_human_positive_recall"
        ],
        "knownPositiveHitRateAmongSelected": aggregate[
            "closure_shadow_top_k_human_positive_rate"
        ],
        "topKKnownPositiveRecall": _ratio(top_hits, human_positives),
        "topKFillRate": aggregate["closure_shadow_top_k_fill_rate"],
        "sourceSuccessAtKRate": _ratio(
            counts["sourceSuccessAtKCount"], int(aggregate["source_count"])
        ),
        "fullBatchSourceRate": _ratio(
            counts["fullBatchSourceCount"], int(aggregate["source_count"])
        ),
        "macroNdcgAtK": _macro_ndcg_at_k(replay),
    }
    normalized_components = {
        name: round(100.0 * float(value or 0.0), 4)
        for name, value in components.items()
    }
    data_policy = dict(contract["dataReadinessGates"])
    data_gates = [
        {
            "code": "SOURCE_COVERAGE",
            "actual": int(aggregate["source_count"]),
            "expected": int(data_policy["minimumSources"]),
            "passed": int(aggregate["source_count"]) >= int(data_policy["minimumSources"]),
        },
        {
            "code": "CANDIDATE_COVERAGE",
            "actual": int(aggregate["candidate_count"]),
            "expected": int(data_policy["minimumCandidates"]),
            "passed": int(aggregate["candidate_count"]) >= int(data_policy["minimumCandidates"]),
        },
        {
            "code": "HUMAN_POSITIVE_COVERAGE",
            "actual": human_positives,
            "expected": int(data_policy["minimumHumanPositives"]),
            "passed": human_positives >= int(data_policy["minimumHumanPositives"]),
        },
        {
            "code": "POSITIVE_LABEL_MATCH_COVERAGE",
            "actual": aggregate["human_positive_match_coverage"],
            "expected": float(data_policy["minimumPositiveLabelMatchCoverage"]),
            "passed": float(aggregate["human_positive_match_coverage"] or 0.0)
            >= float(data_policy["minimumPositiveLabelMatchCoverage"]),
        },
    ]
    failures = _selected_failure_counts(replay)
    quality_policy = dict(contract["keepRules"])
    quality_gates = [
        {
            "code": "KNOWN_POSITIVE_HIT_RATE_FLOOR",
            "actual": components["knownPositiveHitRateAmongSelected"],
            "expected": float(quality_policy["minimumKnownPositiveHitRateAmongSelected"]),
            "passed": float(components["knownPositiveHitRateAmongSelected"] or 0.0)
            >= float(quality_policy["minimumKnownPositiveHitRateAmongSelected"]),
        },
        {
            "code": "SELECTED_INCOMPLETE_ENDINGS",
            "actual": failures["selectedIncompleteEndingCount"],
            "expected": int(quality_policy["maximumSelectedIncompleteEndingCount"]),
            "passed": failures["selectedIncompleteEndingCount"]
            <= int(quality_policy["maximumSelectedIncompleteEndingCount"]),
        },
        {
            "code": "SELECTED_CONTEXT_DEPENDENCE",
            "actual": failures["selectedContextDependentCount"],
            "expected": int(quality_policy["maximumSelectedContextDependentCount"]),
            "passed": failures["selectedContextDependentCount"]
            <= int(quality_policy["maximumSelectedContextDependentCount"]),
        },
        {
            "code": "SELECTED_PROMOTIONAL",
            "actual": failures["selectedPromotionalCount"],
            "expected": int(quality_policy["maximumSelectedPromotionalCount"]),
            "passed": failures["selectedPromotionalCount"]
            <= int(quality_policy["maximumSelectedPromotionalCount"]),
        },
        {
            "code": "OFFLINE_EXECUTION",
            "actual": {
                "networkCalls": offline_activity["networkAttempts"],
                "subprocessCalls": offline_activity["subprocessAttempts"],
                "writeAttempts": offline_activity["writeAttempts"],
                "llmCalls": replay.get("llmCalls"),
                "downloads": 0,
                "renders": replay.get("renders"),
                "enhancements": 0,
                "uploads": 0,
            },
            "expected": "all zero",
            "passed": (
                not any(offline_activity.values())
                and replay.get("llmCalls") == 0
                and replay.get("renders") == 0
            ),
        },
    ]
    limitations = list(replay.get("limitations") or [])
    if float(aggregate.get("hook_prompt_evidence_coverage") or 0.0) < 0.80:
        limitations.append(
            "Hook quality is not scored for legacy records without sealed prompt evidence."
        )
    payload = {
        "schemaVersion": 1,
        "artifactType": "BudgetFriendlyAutoresearchEvaluation",
        "evaluationVersion": AUTORESEARCH_EVALUATION_VERSION,
        "contractVersion": contract["contractVersion"],
        "experimentId": contract["experimentId"],
        "contractFingerprint": contract_fingerprint(contract),
        "replayReportHash": replay["contentHash"],
        "offlineOnly": True,
        "offlineBoundaryEnforced": True,
        "networkCalls": offline_activity["networkAttempts"],
        "subprocessCalls": offline_activity["subprocessAttempts"],
        "writeAttempts": offline_activity["writeAttempts"],
        "llmCalls": 0,
        "downloads": 0,
        "renders": 0,
        "enhancements": 0,
        "uploads": 0,
        "components": normalized_components,
        "rawComponents": components,
        "counts": {
            **counts,
            "humanPositiveCount": human_positives,
        },
        "dataReadinessGates": data_gates,
        "qualityGuardrails": quality_gates,
        "hardGuardrailsPass": all(
            gate["passed"] for gate in [*data_gates, *quality_gates]
        ),
        "coverage": {
            "sourceCount": aggregate["source_count"],
            "candidateCount": aggregate["candidate_count"],
            "humanPositiveCount": human_positives,
            "topKHumanPositiveCount": top_hits,
            "hookPromptEvidenceCoverage": aggregate[
                "hook_prompt_evidence_coverage"
            ],
        },
        "selectedFailureCounts": failures,
        "approvedCandidateOutcomes": approved_outcomes,
        "potentialFalseNegativeCount": aggregate[
            "potential_false_negative_count"
        ],
        "limitations": list(dict.fromkeys(limitations)),
    }
    return _seal(payload)


__all__ = [
    "AUTORESEARCH_EVALUATION_VERSION",
    "AUTORESEARCH_V2_VERSION",
    "DEFAULT_CONTRACT_PATH",
    "ReplayDataUnavailable",
    "assess_replay_data_readiness",
    "classify_source_changes",
    "contract_fingerprint",
    "evaluate_budget_friendly_selection",
    "git_workspace_state",
    "load_autoresearch_contract",
    "verify_local_seal",
    "workspace_source_fingerprints",
]
