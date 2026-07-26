#!/usr/bin/env python3
"""Immutable offline reference evaluator for highlight quality experiments."""
import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Dict, List

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from shorts_generator.ranker import eligible_highlights, promotional_language, rank_highlights


FIXTURES_DIR = ROOT / "research" / "fixtures"

QUALITY_WEIGHTS = {
    "top1_human_acceptance": 0.30,
    "pairwise_ranking_accuracy": 0.20,
    "recall_at_5": 0.15,
    "boundary_completeness": 0.15,
    "visual_subject_coverage": 0.10,
    "caption_readability": 0.10,
}

HARD_GUARDRAILS = (
    "promotional_top1_rate",
    "outro_top1_rate",
    "mid_sentence_cut_rate",
    "duration_violation_rate",
    "render_decode_failure_rate",
)


def _fixture_paths() -> List[Path]:
    return sorted(FIXTURES_DIR.glob("*.json"))


def fixture_fingerprint() -> str:
    digest = hashlib.sha256()
    for path in _fixture_paths():
        digest.update(path.name.encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def metric_definition_fingerprint() -> str:
    source = {
        "weights": QUALITY_WEIGHTS,
        "hard_guardrails": HARD_GUARDRAILS,
    }
    return hashlib.sha256(json.dumps(source, sort_keys=True).encode("utf-8")).hexdigest()


def load_fixtures() -> List[Dict]:
    fixtures = []
    for path in _fixture_paths():
        payload = json.loads(path.read_text(encoding="utf-8"))
        # The directory also contains versioned replay manifests used by the
        # growth-policy evaluator. They are artifacts, not ranker fixtures, and
        # must not be interpreted as a single fixture merely because they are
        # JSON files.
        if isinstance(payload, dict) and payload.get("artifactType"):
            continue
        entries = payload.get("fixtures") if isinstance(payload, dict) else None
        if isinstance(entries, list):
            fixtures.extend(entries)
        else:
            fixtures.append(payload)
    return fixtures


def _duration_violation(candidate: Dict) -> bool:
    duration = float(candidate["end_time"]) - float(candidate["start_time"])
    if duration > 90.0:
        return True
    return duration < 20.0 and not bool(candidate.get("is_standalone_one_liner"))


def evaluate_fixture(fixture: Dict) -> Dict:
    ranked = rank_highlights(
        fixture["candidates"],
        fixture["transcript"],
        content_type=fixture["category"],
    )
    eligible = eligible_highlights(ranked)
    top = eligible[0] if eligible else None
    accepted_ids = {item["id"] for item in fixture.get("accepted_intervals", [])}
    rejected_reasons = {
        item["id"]: item.get("reason", "rejected")
        for item in fixture.get("rejected_intervals", [])
    }
    rank_by_id = {item["id"]: index for index, item in enumerate(ranked)}

    preferences = fixture.get("pairwise_preferences", [])
    correct_pairs = sum(
        rank_by_id.get(winner, 10**6) < rank_by_id.get(loser, 10**6)
        for winner, loser in preferences
    )
    pairwise_accuracy = correct_pairs / len(preferences) if preferences else 1.0
    recall_at_5 = bool({item["id"] for item in eligible[:5]} & accepted_ids)

    selected_reason = rejected_reasons.get(top["id"]) if top else None
    selected_promotion = promotional_language(top.get("candidate_text", "")) if top else {}
    promotional_top1 = bool(
        top
        and (
            top.get("is_promotional")
            or selected_reason in {"promotional_outro", "promotional_intro", "sponsorship"}
            or selected_promotion.get("mostly_cta")
        )
    )
    outro_top1 = bool(
        top
        and (
            top.get("is_outro")
            or selected_reason == "promotional_outro"
            or selected_promotion.get("outro_hits")
        )
    )

    return {
        "id": fixture["id"],
        "category": fixture["category"],
        "preferred_top_candidate": fixture["preferred_top_candidate"],
        "selected_id": top.get("id") if top else None,
        "selected_interval": (
            [round(float(top["start_time"]), 3), round(float(top["end_time"]), 3)]
            if top
            else None
        ),
        "selected_score": float(top.get("final_score", 0.0)) if top else 0.0,
        "top1_accepted": bool(top and top["id"] in accepted_ids),
        "pairwise_accuracy": pairwise_accuracy,
        "recall_at_5": recall_at_5,
        "boundary_complete": bool(top and top.get("boundary_complete", False)),
        "visual_subject_coverage": float(
            top.get("visual_subject_coverage_score", top.get("measured_visual_action_score", 0.0))
        ) if top else 0.0,
        "caption_readability": float(top.get("caption_readability_score", 0.0)) if top else 0.0,
        "guardrails": {
            "promotional_top1": promotional_top1,
            "outro_top1": outro_top1,
            "mid_sentence_cut": bool(top and not top.get("boundary_complete", False)),
            "duration_violation": bool(top and _duration_violation(top)),
            "render_decode_failure": bool(top and not top.get("render_decode_ok", False)),
        },
        "ranking": [
            {
                "id": item["id"],
                "rank": index,
                "final_score": item["final_score"],
                "rejected": item["rejected"],
                "rejection_reasons": item["rejection_reasons"],
            }
            for index, item in enumerate(ranked, start=1)
        ],
    }


def evaluate() -> Dict:
    fixtures = load_fixtures()
    details = [evaluate_fixture(fixture) for fixture in fixtures]
    count = max(1, len(details))
    pair_count = sum(len(fixture.get("pairwise_preferences", [])) for fixture in fixtures)
    correct_pairs = sum(
        detail["pairwise_accuracy"] * len(fixture.get("pairwise_preferences", []))
        for detail, fixture in zip(details, fixtures)
    )
    components = {
        "top1_human_acceptance": sum(item["top1_accepted"] for item in details) / count * 100.0,
        "pairwise_ranking_accuracy": (correct_pairs / pair_count * 100.0) if pair_count else 100.0,
        "recall_at_5": sum(item["recall_at_5"] for item in details) / count * 100.0,
        "boundary_completeness": sum(item["boundary_complete"] for item in details) / count * 100.0,
        "visual_subject_coverage": sum(item["visual_subject_coverage"] for item in details) / count,
        "caption_readability": sum(item["caption_readability"] for item in details) / count,
    }
    components = {key: round(value, 4) for key, value in components.items()}
    quality_score = sum(QUALITY_WEIGHTS[key] * components[key] for key in QUALITY_WEIGHTS)
    guardrails = {
        "promotional_top1_rate": sum(item["guardrails"]["promotional_top1"] for item in details) / count * 100.0,
        "outro_top1_rate": sum(item["guardrails"]["outro_top1"] for item in details) / count * 100.0,
        "mid_sentence_cut_rate": sum(item["guardrails"]["mid_sentence_cut"] for item in details) / count * 100.0,
        "duration_violation_rate": sum(item["guardrails"]["duration_violation"] for item in details) / count * 100.0,
        "render_decode_failure_rate": sum(item["guardrails"]["render_decode_failure"] for item in details) / count * 100.0,
    }
    guardrails = {key: round(value, 4) for key, value in guardrails.items()}
    return {
        "quality_score": round(quality_score, 4),
        "components": components,
        "guardrails": guardrails,
        "hard_guardrails_pass": all(guardrails[key] == 0.0 for key in HARD_GUARDRAILS),
        "fixture_count": len(fixtures),
        "fixture_fingerprint": fixture_fingerprint(),
        "metric_definition_fingerprint": metric_definition_fingerprint(),
        "details": details,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    print(json.dumps(evaluate(), indent=2 if args.pretty else None, sort_keys=args.pretty))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
