#!/usr/bin/env python3
"""Baseline and one-hypothesis autoresearch experiment runner."""
import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from research.eval import evaluate


RESEARCH_DIR = ROOT / "research"
RUNS_DIR = RESEARCH_DIR / "runs"
BASELINE_PATH = RESEARCH_DIR / "baseline.json"
LATEST_PATH = RESEARCH_DIR / "latest.json"
RESULTS_PATH = RESEARCH_DIR / "results.tsv"
MIN_KEEP_DELTA = 0.25
RESULTS_HEADER = (
    "run_id\thypothesis\tchanged_files\tmodel\tprompt_hash\tquality_score\t"
    "components\tguardrails\tstatus\treason\treport\n"
)


def _run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _prompt_hash() -> str:
    digest = hashlib.sha256()
    for relative in (
        "shorts_generator/highlights.py",
        "shorts_generator/local/llm.py",
        "shorts_generator/ranker.py",
    ):
        digest.update((ROOT / relative).read_bytes())
    return digest.hexdigest()


def _changed_files() -> list[str]:
    result = subprocess.run(
        ["git", "status", "--short"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _run_tests() -> Dict:
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return {
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "output": (result.stdout + result.stderr)[-12000:],
    }


def _write_json(path: Path, payload: Dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _sanitize_tsv(value: object) -> str:
    return " ".join(str(value).replace("\t", " ").splitlines()).strip()


def _append_result(report: Dict) -> None:
    if not RESULTS_PATH.exists():
        RESULTS_PATH.write_text(RESULTS_HEADER, encoding="utf-8")
    row = [
        report["run_id"],
        report["hypothesis"],
        json.dumps(report["changed_files"], separators=(",", ":")),
        report["model"],
        report["prompt_hash"],
        report["evaluation"]["quality_score"],
        json.dumps(report["evaluation"]["components"], separators=(",", ":")),
        json.dumps(report["evaluation"]["guardrails"], separators=(",", ":")),
        report["status"],
        report["reason"],
        report["report_path"],
    ]
    with RESULTS_PATH.open("a", encoding="utf-8") as handle:
        handle.write("\t".join(_sanitize_tsv(value) for value in row) + "\n")


def _fingerprints_match(current: Dict, baseline: Dict) -> bool:
    return (
        current["fixture_fingerprint"] == baseline["evaluation"]["fixture_fingerprint"]
        and current["metric_definition_fingerprint"]
        == baseline["evaluation"]["metric_definition_fingerprint"]
    )


def _best_reference_report() -> Optional[Dict]:
    """Return the immutable baseline or the highest-scoring kept experiment."""
    reports = []
    if BASELINE_PATH.exists():
        reports.append(json.loads(BASELINE_PATH.read_text(encoding="utf-8")))
    if RUNS_DIR.exists():
        for path in RUNS_DIR.glob("*.json"):
            report = json.loads(path.read_text(encoding="utf-8"))
            if report.get("status") == "keep":
                reports.append(report)
    if not reports:
        return None
    return max(
        reports,
        key=lambda report: float(report.get("evaluation", {}).get("quality_score", 0.0)),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument("--hypothesis", default="")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--model", default="offline-cached")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--live-repeats", type=int, default=1)
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--refresh-live-cache", action="store_true")
    args = parser.parse_args()
    if not args.baseline and not args.hypothesis.strip():
        parser.error("--hypothesis is required for an experiment")
    if not 1 <= args.live_repeats <= 3:
        parser.error("--live-repeats must be between 1 and 3")
    if args.live and args.model == "offline-cached":
        parser.error("--live requires an explicitly pinned --model")

    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    run_id = _run_id()
    report_path = RUNS_DIR / f"{run_id}.json"
    tests = _run_tests()
    evaluation = evaluate()
    baseline = json.loads(BASELINE_PATH.read_text()) if BASELINE_PATH.exists() else None
    reference = baseline if args.baseline else _best_reference_report()
    status = "baseline" if args.baseline else "discard"
    reason = "baseline_created" if args.baseline else "quality_score_did_not_improve"
    delta = None
    live_reports = []

    if not tests["ok"]:
        status = "crash"
        reason = "unit_tests_failed"
    elif not evaluation["hard_guardrails_pass"]:
        status = "crash"
        reason = "hard_guardrail_failed"
    elif not args.baseline and reference is None:
        status = "crash"
        reason = "baseline_missing"
    elif not args.baseline and not _fingerprints_match(evaluation, reference):
        status = "crash"
        reason = "immutable_eval_fingerprint_changed"
    elif not args.baseline:
        delta = round(evaluation["quality_score"] - reference["evaluation"]["quality_score"], 4)
        if delta >= MIN_KEEP_DELTA:
            status = "keep"
            reason = "offline_quality_improved"

    if status == "keep" and args.live:
        # Keep deterministic/offline research runnable from the core
        # dependency set. Live evaluation owns the optional video/LLM stack.
        from research.live_eval import run_live_eval

        live_run_dir = RUNS_DIR / run_id
        try:
            for repeat in range(args.live_repeats):
                live_reports.append(
                    run_live_eval(
                        model=args.model,
                        seed=args.seed + repeat,
                        run_dir=live_run_dir,
                        render=args.render and repeat == 0,
                        refresh=args.refresh_live_cache,
                    )
                )
            if not all(item["accepted"] for item in live_reports):
                status = "discard"
                reason = "live_top1_not_human_accepted"
            elif any(item.get("render") and not item["render"]["decode_ok"] for item in live_reports):
                status = "crash"
                reason = "live_render_decode_failed"
            else:
                reason = "offline_and_live_quality_passed"
        except Exception as error:
            status = "crash"
            reason = f"live_model_unavailable_or_failed:{type(error).__name__}"
            live_reports.append({"error": str(error), "model": args.model})

    report = {
        "run_id": run_id,
        "hypothesis": args.hypothesis.strip() or "establish immutable baseline",
        "changed_files": _changed_files(),
        "model": args.model,
        "prompt_hash": _prompt_hash(),
        "status": status,
        "reason": reason,
        "quality_delta": delta,
        "reference_run_id": reference.get("run_id") if reference else None,
        "reference_quality_score": (
            reference.get("evaluation", {}).get("quality_score") if reference else None
        ),
        "evaluation": evaluation,
        "tests": tests,
        "live": live_reports,
        "report_path": str(report_path.relative_to(ROOT)),
    }
    _write_json(report_path, report)
    _write_json(LATEST_PATH, report)
    if args.baseline and status == "baseline":
        _write_json(BASELINE_PATH, report)
    _append_result(report)
    print(json.dumps({
        "run_id": run_id,
        "status": status,
        "reason": reason,
        "quality_score": evaluation["quality_score"],
        "quality_delta": delta,
        "report": report["report_path"],
    }, indent=2))
    return 0 if status in {"baseline", "keep", "discard"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
