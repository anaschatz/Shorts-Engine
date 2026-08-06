#!/usr/bin/env python3
"""Fail-closed, one-hypothesis runner for Budget Friendly Autoresearch V2."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Mapping, Optional, Sequence


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from research.autoresearch_v2 import (
    ReplayDataUnavailable,
    assess_replay_data_readiness,
    classify_source_changes,
    evaluate_budget_friendly_selection,
    git_workspace_state,
    load_autoresearch_contract,
    verify_local_seal,
    workspace_source_fingerprints,
)


RUN_VERSION = "bf-autoresearch-run-v2.0.0"
DEFAULT_OUTPUT_DIR = ROOT / "research" / "autoresearch-v2"


def _canonical_hash(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            default=str,
        ).encode("utf-8")
    ).hexdigest()


def _seal(payload: Mapping[str, object]) -> Dict[str, object]:
    body = dict(payload)
    body.pop("contentHash", None)
    return {**body, "contentHash": _canonical_hash(body)}


def _atomic_json(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        temporary = Path(handle.name)
        json.dump(payload, handle, indent=2, sort_keys=True, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def _experiment_id(
    hypothesis: str,
    source_fingerprints: Mapping[str, str],
    reference_hash: Optional[str],
) -> str:
    return "ar2-" + _canonical_hash(
        {
            "hypothesis": " ".join(hypothesis.split()),
            "sourceFingerprints": dict(source_fingerprints),
            "referenceHash": reference_hash,
        }
    )[:20]


def _reserve_run_path(
    runs_dir: Path,
    experiment_id: str,
) -> tuple[str, Path, Path]:
    runs_dir.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, 10000):
        run_id = f"{experiment_id}-a{attempt:03d}"
        path = runs_dir / f"{run_id}.json"
        pending = runs_dir / f"{run_id}.pending"
        if path.exists():
            continue
        try:
            descriptor = os.open(
                pending,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        except FileExistsError:
            continue
        os.close(descriptor)
        return run_id, path, pending
    raise RuntimeError("could not reserve a unique autoresearch attempt")


def _sanitize_output(value: str, root: Path) -> str:
    sanitized = str(value or "").replace(root.as_posix(), "<repo>")
    sanitized = re.sub(
        r"(?i)\b(api[_-]?key|authorization|client[_-]?secret|token)"
        r"(\s*[:=]\s*)\S+",
        r"\1\2<redacted>",
        sanitized,
    )
    sanitized = re.sub(
        r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
        "<redacted-email>",
        sanitized,
        flags=re.IGNORECASE,
    )
    return sanitized[-16000:]


def _test_lane(
    root: Path,
    *,
    lane: str,
    contract: Mapping[str, object],
    timeout_seconds: int = 600,
) -> Dict[str, object]:
    if lane == "fast":
        command = [
            sys.executable,
            "-m",
            "research.offline_test_runner",
            *[str(module) for module in contract["fastTestModules"]],
            "-q",
        ]
    elif lane == "full":
        unittest_arguments = [
            str(value) for value in contract["fullTestCommand"]
        ]
        if unittest_arguments[:2] == ["-m", "unittest"]:
            unittest_arguments = unittest_arguments[2:]
        command = [
            sys.executable,
            "-m",
            "research.offline_test_runner",
            *unittest_arguments,
        ]
        for module in contract.get("offlineExcludedTestModules") or []:
            command.extend(["--exclude-module", str(module)])
    else:
        raise ValueError(f"unknown test lane {lane}")
    environment = dict(os.environ)
    environment["AUTORESEARCH_OFFLINE"] = "1"
    for key in (
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "MUAPI_API_KEY",
        "OPENAI_API_KEY",
        "YOUTUBE_CLIENT_SECRET",
        "YOUTUBE_CLIENT_SECRETS_FILE",
        "YOUTUBE_TOKEN",
        "YOUTUBE_TOKEN_FILE",
    ):
        # Empty values prevent python-dotenv (override=False) from restoring
        # real credentials inside the offline child process.
        environment[key] = ""
    started = datetime.now(timezone.utc)
    with tempfile.TemporaryDirectory(prefix=f"bf-autoresearch-{lane}-") as sandbox:
        sandbox_root = Path(sandbox)
        activity_report = sandbox_root / "offline-activity.json"
        environment.update(
            {
                "HOME": str(sandbox_root),
                "TMPDIR": str(sandbox_root),
                "XDG_CACHE_HOME": str(sandbox_root / "xdg-cache"),
                "XDG_CONFIG_HOME": str(sandbox_root / "xdg-config"),
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONNOUSERSITE": "1",
                "AUTORESEARCH_ACTIVITY_REPORT": str(activity_report),
                "LOCAL_OUTPUT_DIR": str(sandbox_root / "output"),
                "LOCAL_PERFORMANCE_REPORT_DIR": str(sandbox_root / "performance"),
                "LOCAL_CACHE_DIR": str(sandbox_root / "cache"),
                "LOCAL_WORK_DIR": str(sandbox_root / "work"),
                "LOCAL_SOURCE_CACHE_DIR": str(sandbox_root / "sources"),
                "LOCAL_TRANSCRIPT_CACHE_DIR": str(sandbox_root / "transcripts"),
                "LOCAL_CANDIDATE_CACHE_DIR": str(sandbox_root / "candidates"),
                "LOCAL_RENDER_CACHE_DIR": str(sandbox_root / "renders"),
                "LOCAL_SHOT_CACHE_DIR": str(sandbox_root / "shots"),
                "LOCAL_VISUAL_ANALYSIS_CACHE_DIR": str(sandbox_root / "visual"),
                "LOCAL_CANDIDATE_VISUAL_CACHE_DIR": str(
                    sandbox_root / "candidate-visual"
                ),
                "LOCAL_YOUTUBE_CAPTIONS": "false",
            }
        )
        try:
            process = subprocess.Popen(
                command,
                cwd=root,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=environment,
                start_new_session=True,
            )
            stdout, stderr = process.communicate(timeout=timeout_seconds)
            output = _sanitize_output(stdout + stderr, root)
            try:
                activity = json.loads(activity_report.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError, TypeError):
                activity = {
                    "offlineNetworkBoundaryEnforced": False,
                    "networkAttempts": None,
                }
            boundary_passed = (
                activity.get("offlineNetworkBoundaryEnforced") is True
                and activity.get("networkAttempts") == 0
            )
            return {
                "lane": lane,
                "command": command[1:],
                "passed": process.returncode == 0 and boundary_passed,
                "returnCode": process.returncode,
                "elapsedSeconds": round(
                    (datetime.now(timezone.utc) - started).total_seconds(), 3
                ),
                "outputTail": output,
                "writePathsRedirected": True,
                "filesystemWriteBoundaryEnforced": False,
                **activity,
            }
        except subprocess.TimeoutExpired as error:
            if "process" in locals() and process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
            return {
                "lane": lane,
                "command": command[1:],
                "passed": False,
                "returnCode": None,
                "elapsedSeconds": round(
                    (datetime.now(timezone.utc) - started).total_seconds(), 3
                ),
                "outputTail": _sanitize_output(str(error), root),
                "timedOut": True,
                "writePathsRedirected": True,
                "filesystemWriteBoundaryEnforced": False,
                "offlineNetworkBoundaryEnforced": True,
            }


def _compatible_reports(
    output_dir: Path,
    contract_fingerprint: str,
) -> list[Dict[str, object]]:
    reports = []
    paths = [output_dir / "baseline.json", *(output_dir / "runs").glob("*.json")]
    seen = set()
    for path in paths:
        if path in seen or not path.is_file() or path.stat().st_size == 0:
            continue
        seen.add(path)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            verified = verify_local_seal(value, "BudgetFriendlyAutoresearchRunV2")
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            continue
        if (
            verified.get("contractFingerprint") == contract_fingerprint
            and verified.get("status") in {"baseline", "keep"}
        ):
            reports.append(verified)
    return reports


def _evidence_key(report: Mapping[str, object]) -> tuple[int, int, int, int]:
    evaluation = report.get("evaluation")
    counts = evaluation.get("counts") if isinstance(evaluation, Mapping) else {}
    return (
        int(counts.get("closurePositivePassCount") or 0),
        int(counts.get("topKKnownPositiveHitCount") or 0),
        int(counts.get("topKFilledSlotCount") or 0),
        int(counts.get("sourceSuccessAtKCount") or 0),
    )


def _best_reference(
    output_dir: Path,
    contract_fingerprint: str,
) -> Optional[Dict[str, object]]:
    reports = _compatible_reports(output_dir, contract_fingerprint)
    return max(reports, key=_evidence_key) if reports else None


def _candidate_regressions(
    reference: Mapping[str, object],
    current: Mapping[str, object],
) -> list[str]:
    old = {
        str(item.get("replayId")): item
        for item in reference.get("approvedCandidateOutcomes") or []
        if isinstance(item, Mapping)
    }
    new = {
        str(item.get("replayId")): item
        for item in current.get("approvedCandidateOutcomes") or []
        if isinstance(item, Mapping)
    }
    return sorted(
        replay_id
        for replay_id, previous in old.items()
        if previous.get("closurePassed") is True
        and new.get(replay_id, {}).get("closurePassed") is not True
    )


def _compare_evidence(
    reference: Mapping[str, object],
    current: Mapping[str, object],
    contract: Mapping[str, object],
) -> Dict[str, object]:
    old = dict(reference.get("counts") or {})
    new = dict(current.get("counts") or {})
    rules = dict(contract["keepRules"])
    delta = {
        key: int(new.get(key) or 0) - int(old.get(key) or 0)
        for key in (
            "closurePositivePassCount",
            "topKKnownPositiveHitCount",
            "topKFilledSlotCount",
            "sourceSuccessAtKCount",
        )
    }
    regressions = _candidate_regressions(reference, current)
    floor_checks = {
        "closurePositivePassCount": int(new.get("closurePositivePassCount") or 0)
        >= max(
            int(rules["minimumClosurePositivePassCount"]),
            int(old.get("closurePositivePassCount") or 0),
        ),
        "topKKnownPositiveHitCount": int(new.get("topKKnownPositiveHitCount") or 0)
        >= max(
            int(rules["minimumTopKKnownPositiveHitCount"]),
            int(old.get("topKKnownPositiveHitCount") or 0),
        ),
        "topKFilledSlotCount": int(new.get("topKFilledSlotCount") or 0)
        >= max(
            int(rules["minimumTopKFilledSlotCount"]),
            int(old.get("topKFilledSlotCount") or 0),
        ),
        "sourceSuccessAtKCount": int(new.get("sourceSuccessAtKCount") or 0)
        >= max(
            int(rules["minimumSourceSuccessAtKCount"]),
            int(old.get("sourceSuccessAtKCount") or 0),
        ),
        "knownPositiveHitRateAmongSelected": float(
            current.get("rawComponents", {}).get("knownPositiveHitRateAmongSelected") or 0.0
        )
        >= float(rules["minimumKnownPositiveHitRateAmongSelected"]),
        "approvedCandidateNonRegression": not regressions,
    }
    minimum_gain = int(rules["minimumAdditionalKnownPositiveCount"])
    improved = (
        delta["closurePositivePassCount"] >= minimum_gain
        or delta["topKKnownPositiveHitCount"] >= minimum_gain
    )
    return {
        "referenceCounts": old,
        "currentCounts": new,
        "delta": delta,
        "floorChecks": floor_checks,
        "regressedApprovedReplayIds": regressions,
        "improved": improved,
        "eligibleForFullTests": improved and all(floor_checks.values()),
    }


def _append_result(path: Path, report: Mapping[str, object]) -> None:
    header = "run_id\tstatus\treason\thypothesis\treference_run_id\treport\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(header)
        values = [
            report.get("runId"),
            report.get("status"),
            report.get("reason"),
            report.get("hypothesis"),
            report.get("referenceRunId"),
            report.get("reportPath"),
        ]
        handle.write(
            "\t".join(" ".join(str(value or "").replace("\t", " ").splitlines()) for value in values)
            + "\n"
        )
        handle.flush()
        os.fsync(handle.fileno())
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def execute(
    *,
    root: Path,
    contract_path: Path,
    output_dir: Path,
    baseline: bool,
    hypothesis: str,
) -> Dict[str, object]:
    contract = load_autoresearch_contract(contract_path)
    contract_fingerprint = _canonical_hash(contract)
    source_before = workspace_source_fingerprints(root, contract)
    reference = None if baseline else _best_reference(output_dir, contract_fingerprint)
    reference_hash = str(reference.get("contentHash")) if reference else None
    normalized_hypothesis = " ".join(
        (hypothesis or "establish immutable V2 baseline").split()
    )
    experiment_id = _experiment_id(
        normalized_hypothesis,
        source_before,
        reference_hash,
    )
    run_id, report_path, pending_path = _reserve_run_path(
        output_dir / "runs", experiment_id
    )
    status = "crash"
    reason = "uninitialized"
    source_changes = {
        "all": [],
        "editable": [],
        "protected": [],
        "support": [],
        "outOfScope": [],
    }
    test_lanes: Dict[str, object] = {"fast": None, "full": None}
    evaluation = None
    data_readiness = assess_replay_data_readiness(root, contract)
    evidence_comparison = None

    if data_readiness["replayable"] is not True:
        reason = "replay_artifacts_missing"
    elif not baseline and reference is None:
        reason = "compatible_v2_baseline_missing"
    else:
        if reference is not None:
            source_changes = classify_source_changes(
                reference.get("sourceFingerprints") or {},
                source_before,
                contract,
            )
        if source_changes["protected"]:
            reason = "protected_evaluation_source_changed"
        elif source_changes["outOfScope"]:
            reason = "out_of_scope_source_changed"
        elif not baseline and not source_changes["editable"]:
            status = "discard"
            reason = "no_editable_source_change"
        else:
            test_lanes["fast"] = _test_lane(root, lane="fast", contract=contract)
            if not test_lanes["fast"]["passed"]:
                reason = "fast_tests_failed"
            else:
                try:
                    first = evaluate_budget_friendly_selection(root, contract)
                    second = evaluate_budget_friendly_selection(root, contract)
                except ReplayDataUnavailable as error:
                    data_readiness = error.report
                    reason = "replay_artifacts_missing"
                else:
                    evaluation = first
                    if first != second:
                        reason = "nondeterministic_offline_evaluation"
                    elif first.get("hardGuardrailsPass") is not True:
                        reason = "offline_guardrail_failed"
                    elif baseline:
                        test_lanes["full"] = _test_lane(
                            root, lane="full", contract=contract
                        )
                        if test_lanes["full"]["passed"]:
                            status = "baseline"
                            reason = "baseline_created"
                        else:
                            reason = "full_tests_failed"
                    else:
                        evidence_comparison = _compare_evidence(
                            reference["evaluation"], first, contract
                        )
                        if not all(evidence_comparison["floorChecks"].values()):
                            status = "discard"
                            reason = "non_regression_floor_failed"
                        elif not evidence_comparison["improved"]:
                            status = "discard"
                            reason = "no_additional_known_positive"
                        else:
                            test_lanes["full"] = _test_lane(
                                root, lane="full", contract=contract
                            )
                            if test_lanes["full"]["passed"]:
                                status = "keep"
                                reason = "integer_evidence_improved"
                            else:
                                reason = "full_tests_failed"

    source_after = workspace_source_fingerprints(root, contract)
    if source_after != source_before:
        status = "crash"
        reason = "source_changed_during_run"
    created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    try:
        relative_report = report_path.relative_to(root).as_posix()
    except ValueError:
        relative_report = report_path.resolve().as_posix()
    payload = {
        "schemaVersion": 1,
        "artifactType": "BudgetFriendlyAutoresearchRunV2",
        "runVersion": RUN_VERSION,
        "contractVersion": contract["contractVersion"],
        "contractFingerprint": contract_fingerprint,
        "evaluationLane": contract["evaluationLane"],
        "experimentId": experiment_id,
        "runId": run_id,
        "createdAt": created_at,
        "hypothesis": normalized_hypothesis,
        "status": status,
        "reason": reason,
        "referenceRunId": reference.get("runId") if reference else None,
        "referenceHash": reference_hash,
        "workspace": git_workspace_state(root),
        "python": {
            "executable": sys.executable,
            "version": sys.version.split()[0],
        },
        "sourceFingerprints": source_before,
        "sourceChanges": source_changes,
        "dataReadiness": data_readiness,
        "evaluation": evaluation,
        "evidenceComparison": evidence_comparison,
        "testLanes": test_lanes,
        "networkCalls": 0,
        "llmCalls": 0,
        "downloads": 0,
        "renders": 0,
        "enhancements": 0,
        "uploads": 0,
        "productionPolicyMutations": 0,
        "reportPath": relative_report,
        "changed_files": source_changes["all"],
        "tests": test_lanes,
        "model": "offline-cached",
        "prompt_hash": _canonical_hash(
            {
                path: source_before.get(path)
                for path in contract.get("editableScope") or []
            }
        ),
    }
    report = _seal(payload)
    _atomic_json(report_path, report)
    pending_path.unlink(missing_ok=True)
    _atomic_json(output_dir / "latest.json", report)
    if status == "baseline":
        _atomic_json(output_dir / "baseline.json", report)
    _append_result(output_dir / "results.tsv", report)
    return report


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--baseline", action="store_true")
    group.add_argument("--hypothesis")
    parser.add_argument(
        "--contract",
        type=Path,
        default=ROOT / "research/autoresearch-v2-contract.json",
    )
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    report = execute(
        root=ROOT,
        contract_path=args.contract,
        output_dir=args.output_dir,
        baseline=bool(args.baseline),
        hypothesis=str(args.hypothesis or ""),
    )
    print(
        json.dumps(
            {
                "runId": report["runId"],
                "status": report["status"],
                "reason": report["reason"],
                "report": report["reportPath"],
                "missingArtifactCount": report["dataReadiness"].get(
                    "missingArtifactCount"
                ),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0 if report["status"] in {"baseline", "keep", "discard"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
