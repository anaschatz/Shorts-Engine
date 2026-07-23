#!/usr/bin/env python3
"""Replay Budget Friendly growth V1/V2 policies on cached local artifacts."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from shorts_generator.growth_replay import (
    build_growth_replay_report,
    render_growth_replay_markdown,
)


def _arguments() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description=(
            "Compare V1, full V2, and closure-only V2 without LLM calls, "
            "downloads, or rendering."
        )
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=root / "research/fixtures/bf_growth_replay_2026.json",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=root / "research/replay",
    )
    parser.add_argument("--top-k", type=int, default=3)
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    repo_root = Path(__file__).resolve().parents[1]
    with args.manifest.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    report = build_growth_replay_report(
        manifest,
        root=repo_root,
        top_k=max(1, args.top_k),
    )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.output_dir / "budget-friendly-growth-v2-replay.json"
    markdown_path = args.output_dir / "budget-friendly-growth-v2-replay.md"
    json_path.write_text(
        json.dumps(
            report,
            indent=2,
            sort_keys=True,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    markdown_path.write_text(
        render_growth_replay_markdown(report),
        encoding="utf-8",
    )

    aggregate = report["aggregate"]
    print(
        "Replay complete: "
        f"{aggregate['source_count']} sources, "
        f"{aggregate['candidate_count']} candidates, "
        f"{aggregate['human_positive_count']} positives."
    )
    print(
        "Production approval recommended: "
        f"{report['productionApprovalRecommended']}"
    )
    print(json_path)
    print(markdown_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
