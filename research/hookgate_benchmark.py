#!/usr/bin/env python3
"""Validate and compare HookGate V2/V3 on a governed real-project dataset."""

from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path
from typing import Any


MIN_PROJECTS = 30
CATEGORIES = {"football", "motivational", "narrated_animation"}
VARIANTS = ("v2", "v3")


class BenchmarkDatasetError(ValueError):
    """A stable, operator-readable benchmark dataset failure."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _fail(code: str, message: str) -> None:
    raise BenchmarkDatasetError(code, message)


def _number(value: Any, field: str, *, nullable: bool = False) -> float | None:
    if nullable and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("INVALID_METRIC", f"{field} must be numeric")
    value = float(value)
    if not math.isfinite(value) or value < 0:
        _fail("INVALID_METRIC", f"{field} must be finite and non-negative")
    return value


def validate_dataset(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        _fail("INVALID_DATASET", "root must be an object")
    if payload.get("artifactType") != "HookGateComparisonDataset":
        _fail("INVALID_ARTIFACT_TYPE", "artifactType must be HookGateComparisonDataset")
    if payload.get("schemaVersion") != 1:
        _fail("UNSUPPORTED_SCHEMA_VERSION", "only schemaVersion 1 is supported")

    collection = payload.get("collection")
    if not isinstance(collection, dict):
        _fail("INVALID_COLLECTION", "collection metadata is required")
    required_collection = {
        "consecutive": True,
        "selectedOnly": False,
        "anonymized": True,
        "sourceKind": "real_projects",
    }
    for key, expected in required_collection.items():
        if collection.get(key) != expected:
            _fail("UNSAFE_COLLECTION", f"collection.{key} must equal {expected!r}")

    projects = payload.get("projects")
    if not isinstance(projects, list) or len(projects) < MIN_PROJECTS:
        _fail("INSUFFICIENT_PROJECTS", f"at least {MIN_PROJECTS} projects are required")

    keys: set[str] = set()
    sequence: list[int] = []
    splits: dict[str, set[str]] = {"train": set(), "evaluation": set()}
    categories: set[str] = set()
    for index, project in enumerate(projects):
        prefix = f"projects[{index}]"
        if not isinstance(project, dict):
            _fail("INVALID_PROJECT", f"{prefix} must be an object")
        key = project.get("projectKey")
        if (
            not isinstance(key, str)
            or len(key) != 64
            or any(character not in "0123456789abcdef" for character in key)
        ):
            _fail("PROJECT_NOT_ANONYMIZED", f"{prefix}.projectKey must be a SHA-256 hex digest")
        if key in keys:
            _fail("DUPLICATE_PROJECT", f"{prefix}.projectKey is duplicated")
        keys.add(key)

        sequence_index = project.get("sequenceIndex")
        if isinstance(sequence_index, bool) or not isinstance(sequence_index, int):
            _fail("INVALID_SEQUENCE", f"{prefix}.sequenceIndex must be an integer")
        sequence.append(sequence_index)

        category = project.get("category")
        if category not in CATEGORIES:
            _fail("INVALID_CATEGORY", f"{prefix}.category is unsupported")
        categories.add(category)

        split = project.get("split")
        if split not in splits:
            _fail("INVALID_SPLIT", f"{prefix}.split must be train or evaluation")
        splits[split].add(key)

        human = project.get("humanRating")
        if not isinstance(human, dict):
            _fail("MISSING_HUMAN_RATING", f"{prefix}.humanRating is required")
        reviewer = human.get("reviewerKey")
        if (
            not isinstance(reviewer, str)
            or len(reviewer) != 64
            or any(character not in "0123456789abcdef" for character in reviewer)
        ):
            _fail("REVIEWER_NOT_ANONYMIZED", f"{prefix}.humanRating.reviewerKey must be hashed")
        accepted = human.get("acceptedCandidateIds")
        preferences = human.get("pairwisePreferences")
        if not isinstance(accepted, list) or not all(isinstance(item, str) for item in accepted):
            _fail("INVALID_HUMAN_RATING", f"{prefix} acceptedCandidateIds must be strings")
        if not isinstance(preferences, list) or not all(
            isinstance(pair, list)
            and len(pair) == 2
            and all(isinstance(item, str) for item in pair)
            for pair in preferences
        ):
            _fail("INVALID_HUMAN_RATING", f"{prefix} pairwisePreferences must be ID pairs")

        variants = project.get("variants")
        if not isinstance(variants, dict):
            _fail("MISSING_VARIANTS", f"{prefix}.variants is required")
        for variant in VARIANTS:
            result = variants.get(variant)
            if not isinstance(result, dict):
                _fail("MISSING_VARIANT", f"{prefix}.variants.{variant} is required")
            ranking = result.get("ranking")
            if not isinstance(ranking, list) or not ranking or not all(
                isinstance(item, str) for item in ranking
            ):
                _fail("INVALID_RANKING", f"{prefix}.variants.{variant}.ranking is invalid")
            for field in ("boundaryCompleteness", "captionReadability", "visualSubjectCoverage"):
                score = _number(result.get(field), f"{prefix}.variants.{variant}.{field}")
                if score is not None and score > 100:
                    _fail("INVALID_METRIC", f"{prefix}.variants.{variant}.{field} exceeds 100")
            failures = result.get("attributionFailures")
            if isinstance(failures, bool) or not isinstance(failures, int) or failures < 0:
                _fail("INVALID_METRIC", f"{prefix}.variants.{variant}.attributionFailures is invalid")
            _number(result.get("latencyMs"), f"{prefix}.variants.{variant}.latencyMs")
            _number(
                result.get("estimatedCostUsd"),
                f"{prefix}.variants.{variant}.estimatedCostUsd",
                nullable=True,
            )

    expected_sequence = list(range(min(sequence), min(sequence) + len(sequence)))
    if sorted(sequence) != expected_sequence:
        _fail("NON_CONSECUTIVE_PROJECTS", "sequenceIndex values must be contiguous")
    if not splits["train"] or not splits["evaluation"]:
        _fail("MISSING_TRAIN_EVAL_SPLIT", "both train and evaluation projects are required")
    if splits["train"] & splits["evaluation"]:
        _fail("TRAIN_EVAL_LEAKAGE", "a project cannot occur in both splits")
    if categories != CATEGORIES:
        missing = ", ".join(sorted(CATEGORIES - categories))
        _fail("MISSING_CATEGORY", f"dataset is missing: {missing}")
    return payload


def _percentile_95(values: list[float]) -> float:
    ordered = sorted(values)
    position = max(0, math.ceil(0.95 * len(ordered)) - 1)
    return ordered[position]


def evaluate_dataset(payload: Any) -> dict[str, Any]:
    dataset = validate_dataset(payload)
    projects = [item for item in dataset["projects"] if item["split"] == "evaluation"]
    report: dict[str, Any] = {
        "artifactType": "HookGateComparisonReport",
        "schemaVersion": 1,
        "datasetVersion": dataset.get("datasetVersion"),
        "projectCount": len(dataset["projects"]),
        "evaluationProjectCount": len(projects),
        "variants": {},
    }
    for variant in VARIANTS:
        top1_hits = 0
        recall_hits = 0
        pair_hits = 0
        pair_count = 0
        boundaries: list[float] = []
        captions: list[float] = []
        coverage: list[float] = []
        attribution_failures = 0
        latency: list[float] = []
        costs: list[float] = []
        for project in projects:
            human = project["humanRating"]
            result = project["variants"][variant]
            ranking = result["ranking"]
            accepted = set(human["acceptedCandidateIds"])
            top1_hits += int(ranking[0] in accepted)
            recall_hits += int(bool(set(ranking[:5]) & accepted))
            rank = {candidate_id: index for index, candidate_id in enumerate(ranking)}
            for winner, loser in human["pairwisePreferences"]:
                if winner in rank and loser in rank:
                    pair_count += 1
                    pair_hits += int(rank[winner] < rank[loser])
            boundaries.append(float(result["boundaryCompleteness"]))
            captions.append(float(result["captionReadability"]))
            coverage.append(float(result["visualSubjectCoverage"]))
            attribution_failures += result["attributionFailures"]
            latency.append(float(result["latencyMs"]))
            if result["estimatedCostUsd"] is not None:
                costs.append(float(result["estimatedCostUsd"]))
        count = len(projects)
        report["variants"][variant] = {
            "top1HumanAcceptance": round(top1_hits / count * 100, 4),
            "pairwiseRankingAccuracy": (
                round(pair_hits / pair_count * 100, 4) if pair_count else None
            ),
            "recallAt5": round(recall_hits / count * 100, 4),
            "boundaryCompleteness": round(statistics.fmean(boundaries), 4),
            "captionReadability": round(statistics.fmean(captions), 4),
            "visualSubjectCoverage": round(statistics.fmean(coverage), 4),
            "attributionFailures": attribution_failures,
            "meanLatencyMs": round(statistics.fmean(latency), 4),
            "p95LatencyMs": round(_percentile_95(latency), 4),
            "estimatedCostUsd": round(sum(costs), 6) if costs else None,
            "costCoverage": round(len(costs) / count * 100, 4),
        }
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    try:
        payload = json.loads(args.dataset.read_text(encoding="utf-8"))
        report = evaluate_dataset(payload)
    except (OSError, json.JSONDecodeError, BenchmarkDatasetError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 2
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=args.pretty))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
