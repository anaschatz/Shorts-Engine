#!/usr/bin/env python3
"""Fail-closed preflight/baseline/one-hypothesis HookGate V4 runner."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from research.hook_v4_autoresearch import (
    DEFAULT_CONTRACT_PATH,
    HOOK_V4_AUTORESEARCH_VERSION,
    HookV4AutoresearchError,
    assess_hook_v4_readiness,
    classify_source_changes,
    compare_hook_v4_evaluations,
    evaluate_hook_v4_corpus,
    load_hook_v4_contract,
    seal,
    verify_run_artifact,
    workspace_source_fingerprints,
)
from shorts_generator.config import LOCAL_AUTORESEARCH_EVIDENCE_DIR


RUN_VERSION = "bf-hook-v4-autoresearch-run-v1.1.0"
DEFAULT_BASELINE = ROOT / "research" / "hook-v4-autoresearch" / "baseline.json"


def _atomic_json(path: Path, payload: dict) -> None:
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


def _offline_environment() -> dict[str, str]:
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
        environment[key] = ""
    return environment


def _test_lane(contract: dict, lane: str) -> dict:
    if lane == "fast":
        command = [
            sys.executable,
            "-m",
            "research.offline_test_runner",
            *[str(module) for module in contract["fastTestModules"]],
            "-q",
        ]
    elif lane == "full":
        arguments = [str(value) for value in contract["fullTestCommand"]]
        if arguments[:2] == ["-m", "unittest"]:
            arguments = arguments[2:]
        command = [sys.executable, "-m", "research.offline_test_runner", *arguments]
        for module in contract.get("offlineExcludedTestModules") or []:
            command.extend(["--exclude-module", str(module)])
    else:
        raise ValueError(f"unknown test lane: {lane}")
    with tempfile.TemporaryDirectory(prefix=f"bf-hook-v4-{lane}-") as directory:
        environment = _offline_environment()
        environment.update(
            {
                "HOME": directory,
                "TMPDIR": directory,
                "XDG_CACHE_HOME": str(Path(directory) / "cache"),
                "XDG_CONFIG_HOME": str(Path(directory) / "config"),
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONNOUSERSITE": "1",
                "LOCAL_OUTPUT_DIR": str(Path(directory) / "output"),
                "LOCAL_AUTORESEARCH_EVIDENCE_DIR": str(Path(directory) / "evidence"),
            }
        )
        process = subprocess.run(
            command,
            cwd=ROOT,
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=900,
            check=False,
        )
    return {
        "lane": lane,
        "passed": process.returncode == 0,
        "returnCode": process.returncode,
        "outputTail": process.stdout[-12000:],
    }


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--preflight", action="store_true")
    action.add_argument("--baseline", action="store_true")
    action.add_argument("--hypothesis")
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT_PATH)
    parser.add_argument("--baseline-report", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument(
        "--evidence-dir",
        type=Path,
        default=Path(LOCAL_AUTORESEARCH_EVIDENCE_DIR),
    )
    parser.add_argument("--observed-candidate", type=Path)
    parser.add_argument("--observed-receipt", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--pretty", action="store_true")
    return parser.parse_args()


def _run_payload(contract: dict, mode: str, status: str, **values: object) -> dict:
    return seal(
        {
            "schemaVersion": 1,
            "artifactType": "BudgetFriendlyHookV4AutoresearchRun",
            "runVersion": RUN_VERSION,
            "contractVersion": contract["contractVersion"],
            "contractHash": contract["contentHash"],
            "mode": mode,
            "status": status,
            **values,
        }
    )


def main() -> int:
    args = _arguments()
    mode = "hypothesis" if args.hypothesis is not None else (
        "baseline" if args.baseline else "preflight"
    )
    try:
        contract = load_hook_v4_contract(args.contract)
        readiness = assess_hook_v4_readiness(
            ROOT,
            contract,
            evidence_dir=args.evidence_dir,
            observed_candidate_path=args.observed_candidate,
            observed_receipt_path=args.observed_receipt,
        )
        if readiness.get("calibrationReady") is not True:
            artifact = _run_payload(
                contract,
                mode,
                "calibration_not_ready",
                readiness=readiness,
                baselineCreated=False,
            )
            exit_code = 2
        elif args.preflight:
            artifact = _run_payload(
                contract,
                mode,
                "ready",
                readiness=readiness,
                baselineCreated=False,
            )
            exit_code = 0
        else:
            manifest_path = ROOT / str(contract["corpusManifest"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if args.baseline:
                fast = _test_lane(contract, "fast")
                full = _test_lane(contract, "full") if fast["passed"] else None
                first = evaluate_hook_v4_corpus(manifest, contract)
                second = evaluate_hook_v4_corpus(manifest, contract)
                if first != second:
                    raise HookV4AutoresearchError(
                        "NON_DETERMINISTIC_BASELINE",
                        "two locked evaluations differ",
                    )
                if not fast["passed"] or not full or not full["passed"]:
                    raise HookV4AutoresearchError(
                        "BASELINE_TEST_FAILURE",
                        "baseline test lanes did not pass",
                    )
                artifact = _run_payload(
                    contract,
                    mode,
                    "baseline",
                    readiness=readiness,
                    evaluation=first,
                    sourceFingerprints=workspace_source_fingerprints(ROOT, contract),
                    tests={"fast": fast, "full": full},
                    baselineCreated=True,
                )
                exit_code = 0
            else:
                hypothesis = " ".join(str(args.hypothesis or "").split())
                if not hypothesis:
                    raise HookV4AutoresearchError(
                        "HYPOTHESIS_REQUIRED", "hypothesis must not be empty"
                    )
                baseline_raw = json.loads(
                    args.baseline_report.read_text(encoding="utf-8")
                )
                baseline = verify_run_artifact(baseline_raw, contract)
                if baseline.get("status") != "baseline" or baseline.get("baselineCreated") is not True:
                    raise HookV4AutoresearchError(
                        "BASELINE_REQUIRED", "reference is not a completed baseline"
                    )
                baseline_fingerprints = baseline.get("sourceFingerprints")
                if not isinstance(baseline_fingerprints, dict):
                    raise HookV4AutoresearchError(
                        "BASELINE_INVALID", "baseline lacks source fingerprints"
                    )
                current_fingerprints = workspace_source_fingerprints(ROOT, contract)
                changes = classify_source_changes(
                    baseline_fingerprints,
                    current_fingerprints,
                    contract,
                )
                if changes["protected"]:
                    raise HookV4AutoresearchError(
                        "PROTECTED_SCOPE_CHANGED",
                        ", ".join(changes["protected"]),
                    )
                if changes["outOfScope"]:
                    raise HookV4AutoresearchError(
                        "OUT_OF_SCOPE_CHANGED",
                        ", ".join(changes["outOfScope"]),
                    )
                if not changes["editable"]:
                    raise HookV4AutoresearchError(
                        "NO_EDITABLE_CHANGE",
                        "one HookGate V4 policy change is required",
                    )
                fast = _test_lane(contract, "fast")
                if not fast["passed"]:
                    raise HookV4AutoresearchError(
                        "FAST_TEST_FAILURE", "fast test lane did not pass"
                    )
                first = evaluate_hook_v4_corpus(manifest, contract)
                second = evaluate_hook_v4_corpus(manifest, contract)
                if first != second:
                    raise HookV4AutoresearchError(
                        "NON_DETERMINISTIC_TRIAL", "two locked evaluations differ"
                    )
                comparison = compare_hook_v4_evaluations(
                    baseline["evaluation"], first, contract
                )
                full = None
                status = comparison["decision"]
                if status == "keep":
                    full = _test_lane(contract, "full")
                    if not full["passed"]:
                        status = "crash"
                artifact = _run_payload(
                    contract,
                    mode,
                    status,
                    hypothesis=hypothesis,
                    readiness=readiness,
                    baselineHash=baseline["contentHash"],
                    evaluation=first,
                    comparison=comparison,
                    sourceChanges=changes,
                    sourceFingerprints=current_fingerprints,
                    tests={"fast": fast, "full": full},
                    baselineCreated=False,
                )
                exit_code = 0 if status == "keep" else 1
    except (
        OSError,
        json.JSONDecodeError,
        subprocess.SubprocessError,
        HookV4AutoresearchError,
    ) as error:
        try:
            contract
        except UnboundLocalError:
            contract = {
                "contractVersion": HOOK_V4_AUTORESEARCH_VERSION,
                "contentHash": "unavailable",
            }
        artifact = _run_payload(
            contract,
            mode,
            "crash",
            error=str(error),
            baselineCreated=False,
        )
        exit_code = 2
    if args.output is not None:
        _atomic_json(args.output, artifact)
    print(
        json.dumps(
            artifact,
            indent=2 if args.pretty else None,
            sort_keys=args.pretty,
            ensure_ascii=False,
        )
    )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
