"""Deterministic near-duplicate checks for candidate hooks and source intervals."""
from __future__ import annotations

import re
from typing import Dict, Iterable, List, Set, Tuple

from .artifact_contracts import ArtifactBindingError, content_hash


def _tokens(value: str) -> List[str]:
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", str(value or "").lower())


def _shingles(value: str, size: int = 3) -> Set[Tuple[str, ...]]:
    tokens = _tokens(value)
    if not tokens:
        return set()
    if len(tokens) < size:
        return {tuple(tokens)}
    return {tuple(tokens[index:index + size]) for index in range(len(tokens) - size + 1)}


def text_similarity(left: str, right: str, shingle_size: int = 3) -> float:
    left_set = _shingles(left, shingle_size)
    right_set = _shingles(right, shingle_size)
    if not left_set or not right_set:
        return 0.0
    return len(left_set & right_set) / len(left_set | right_set)


def interval_iou(left: Tuple[float, float], right: Tuple[float, float]) -> float:
    overlap = max(0.0, min(left[1], right[1]) - max(left[0], right[0]))
    union = max(left[1], right[1]) - min(left[0], right[0])
    return overlap / union if union > 0 else 0.0


def evaluate_originality(
    candidate: Dict,
    candidate_hash: str,
    source_hash: str,
    recent_publications: Iterable[Dict],
    candidate_decision_hash: str,
    script_threshold: float = 0.72,
    hook_threshold: float = 0.82,
    interval_threshold: float = 0.50,
) -> Dict:
    """Fail candidates that repeat recent wording or the same source moment."""
    hashes = {
        "candidateHash": str(candidate_hash or "").strip().lower(),
        "sourceHash": str(source_hash or "").strip().lower(),
        "candidateDecisionHash": str(candidate_decision_hash or "").strip().lower(),
    }
    for field, value in hashes.items():
        if (
            len(value) != 64
            or any(char not in "0123456789abcdef" for char in value)
            or value == "0" * 64
        ):
            raise ArtifactBindingError(f"{field} must be a non-placeholder sha256 hash")
    candidate_hash = hashes["candidateHash"]
    source_hash = hashes["sourceHash"]
    candidate_decision_hash = hashes["candidateDecisionHash"]
    candidate_text = " ".join(
        str(candidate.get(key) or "")
        for key in ("candidate_text", "thesis", "final_takeaway_sentence")
    ).strip()
    hook = str(candidate.get("hook_sentence") or candidate.get("title") or "").strip()
    if not candidate_text or not hook:
        raise ArtifactBindingError("candidate text and hook are required for originality QA")
    start = float(candidate["start_time"])
    end = float(candidate["end_time"])
    if end <= start:
        raise ArtifactBindingError("candidate interval is invalid")

    comparisons = []
    for recent in recent_publications:
        script_similarity = text_similarity(
            candidate_text,
            str(recent.get("candidateText") or recent.get("candidate_text") or ""),
        )
        hook_similarity = text_similarity(
            hook,
            str(recent.get("hook") or recent.get("hook_sentence") or recent.get("title") or ""),
            shingle_size=2,
        )
        same_source = str(recent.get("sourceHash") or "") == source_hash
        overlap = 0.0
        if same_source and recent.get("startTime") is not None and recent.get("endTime") is not None:
            overlap = interval_iou(
                (start, end),
                (float(recent["startTime"]), float(recent["endTime"])),
            )
        comparisons.append(
            {
                "publicationId": str(recent.get("videoId") or recent.get("publicationId") or "unknown"),
                "scriptSimilarity": round(script_similarity, 6),
                "hookSimilarity": round(hook_similarity, 6),
                "sameSourceIntervalIou": round(overlap, 6),
            }
        )
    maximums = {
        "scriptSimilarity": max((item["scriptSimilarity"] for item in comparisons), default=0.0),
        "hookSimilarity": max((item["hookSimilarity"] for item in comparisons), default=0.0),
        "sameSourceIntervalIou": max((item["sameSourceIntervalIou"] for item in comparisons), default=0.0),
    }
    gates = [
        {
            "code": "SCRIPT_SIMILARITY",
            "passed": maximums["scriptSimilarity"] < script_threshold,
            "actual": maximums["scriptSimilarity"],
            "threshold": script_threshold,
        },
        {
            "code": "HOOK_SIMILARITY",
            "passed": maximums["hookSimilarity"] < hook_threshold,
            "actual": maximums["hookSimilarity"],
            "threshold": hook_threshold,
        },
        {
            "code": "SOURCE_INTERVAL_OVERLAP",
            "passed": maximums["sameSourceIntervalIou"] < interval_threshold,
            "actual": maximums["sameSourceIntervalIou"],
            "threshold": interval_threshold,
        },
    ]
    payload = {
        "schemaVersion": 1,
        "artifactType": "OriginalityReport",
        "candidateDecisionHash": candidate_decision_hash,
        "candidateHash": candidate_hash,
        "sourceHash": source_hash,
        "thresholds": {
            "scriptSimilarity": script_threshold,
            "hookSimilarity": hook_threshold,
            "sameSourceIntervalIou": interval_threshold,
        },
        "maximums": maximums,
        "comparisons": sorted(comparisons, key=lambda item: item["publicationId"]),
        "gates": gates,
        "passed": all(gate["passed"] for gate in gates),
    }
    return {**payload, "contentHash": content_hash(payload)}


__all__ = ["evaluate_originality", "interval_iou", "text_similarity"]
