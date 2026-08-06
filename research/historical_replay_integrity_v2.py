#!/usr/bin/env python3
"""Validate the surviving historical replay without claiming it is rerunnable."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Dict, Mapping


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from research.autoresearch_v2 import verify_local_seal


INTEGRITY_VERSION = "bf-historical-replay-integrity-v2.0.0"
EXPECTED_BASELINE_COUNTS = {
    "sourceCount": 6,
    "candidateCount": 95,
    "humanPositiveCount": 18,
    "matchedPositiveCount": 17,
    "appendedPositiveCount": 1,
    "closurePositivePassCount": 11,
    "topKFilledSlotCount": 9,
    "topKKnownPositiveHitCount": 7,
    "sourceSuccessAtKCount": 4,
    "fullBatchSourceCount": 2,
    "hookEvidenceCount": 0,
}


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


def _macro_ndcg(report: Mapping[str, object]) -> float:
    values = []
    top_k = int(report.get("topK") or 3)
    for dataset in report.get("datasets") or []:
        candidates = [
            candidate
            for candidate in dataset.get("candidates") or []
            if isinstance(candidate, Mapping)
        ]
        selected = sorted(
            (
                candidate
                for candidate in candidates
                if candidate.get("closure_shadow", {}).get("top_k") is True
            ),
            key=lambda candidate: float(
                candidate.get("closure_shadow", {}).get("score") or 0.0
            ),
            reverse=True,
        )[:top_k]
        positive_count = sum(
            candidate.get("human_positive") is True for candidate in candidates
        )
        ideal_width = min(top_k, positive_count)
        if ideal_width <= 0:
            continue
        actual = sum(
            (1.0 if candidate.get("human_positive") is True else 0.0)
            / math.log2(index + 2.0)
            for index, candidate in enumerate(selected)
        )
        ideal = sum(1.0 / math.log2(index + 2.0) for index in range(ideal_width))
        values.append(actual / ideal)
    return round(sum(values) / len(values), 6) if values else 0.0


def inspect_historical_replay(report: Mapping[str, object]) -> Dict[str, object]:
    replay = verify_local_seal(report, "BudgetFriendlyGrowthReplayReport")
    counts = {
        "sourceCount": len(replay.get("datasets") or []),
        "candidateCount": 0,
        "humanPositiveCount": 0,
        "matchedPositiveCount": 0,
        "appendedPositiveCount": 0,
        "closurePositivePassCount": 0,
        "topKFilledSlotCount": 0,
        "topKKnownPositiveHitCount": 0,
        "sourceSuccessAtKCount": 0,
        "fullBatchSourceCount": 0,
        "hookEvidenceCount": 0,
    }
    top_k = int(replay.get("topK") or 3)
    for dataset in replay.get("datasets") or []:
        source_hits = 0
        source_filled = 0
        for candidate in dataset.get("candidates") or []:
            counts["candidateCount"] += 1
            human_positive = candidate.get("human_positive") is True
            appended = candidate.get("human_positive_appended") is True
            counts["humanPositiveCount"] += int(human_positive)
            counts["appendedPositiveCount"] += int(human_positive and appended)
            counts["matchedPositiveCount"] += int(human_positive and not appended)
            closure_pass = candidate.get("semantic_closure", {}).get("status") == "pass"
            counts["closurePositivePassCount"] += int(
                human_positive and closure_pass
            )
            selected = candidate.get("closure_shadow", {}).get("top_k") is True
            counts["topKFilledSlotCount"] += int(selected)
            counts["topKKnownPositiveHitCount"] += int(selected and human_positive)
            source_hits += int(selected and human_positive)
            source_filled += int(selected)
            counts["hookEvidenceCount"] += int(
                candidate.get("hook_gate", {}).get("evidence_complete") is True
            )
        counts["sourceSuccessAtKCount"] += int(source_hits > 0)
        counts["fullBatchSourceCount"] += int(source_filled >= top_k)
    parity = {
        key: {
            "actual": counts[key],
            "expected": expected,
            "passed": counts[key] == expected,
        }
        for key, expected in EXPECTED_BASELINE_COUNTS.items()
    }
    payload = {
        "schemaVersion": 1,
        "artifactType": "BudgetFriendlyHistoricalReplayIntegrityV2",
        "integrityVersion": INTEGRITY_VERSION,
        "historicalReplayHash": replay["contentHash"],
        "historicalEvidenceValid": all(item["passed"] for item in parity.values()),
        "rerunnable": False,
        "engineChangeEvaluationAllowed": False,
        "reason": "raw_candidate_and_timed_transcript_artifacts_are_missing",
        "counts": counts,
        "rates": {
            "closurePositiveRecall": round(
                counts["closurePositivePassCount"] / counts["humanPositiveCount"],
                6,
            ),
            "topKKnownPositiveRecall": round(
                counts["topKKnownPositiveHitCount"] / counts["humanPositiveCount"],
                6,
            ),
            "knownPositiveHitRateAmongSelected": round(
                counts["topKKnownPositiveHitCount"]
                / counts["topKFilledSlotCount"],
                6,
            ),
            "topKFillRate": round(
                counts["topKFilledSlotCount"]
                / (counts["sourceCount"] * top_k),
                6,
            ),
            "sourceSuccessAtKRate": round(
                counts["sourceSuccessAtKCount"] / counts["sourceCount"],
                6,
            ),
            "macroNdcgAtK": _macro_ndcg(replay),
        },
        "hookGate": {
            "status": "not_evaluable",
            "evidenceCount": counts["hookEvidenceCount"],
            "candidateCount": counts["candidateCount"],
        },
        "parityChecks": parity,
    }
    return _seal(payload)


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--report",
        type=Path,
        default=ROOT / "research/replay/budget-friendly-growth-v2-replay.json",
    )
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    integrity = inspect_historical_replay(report)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(integrity, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(integrity, indent=2, sort_keys=True))
    return 0 if integrity["historicalEvidenceValid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
