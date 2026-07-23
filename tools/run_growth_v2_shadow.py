#!/usr/bin/env python3
"""Run fresh HookGateV2 discovery without rendering or publishing."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from shorts_generator.growth_shadow import (
    GROWTH_SHADOW_POLICY_VERSION,
    run_growth_v2_shadow,
    validate_shadow_manifest,
)


def _arguments() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description=(
            "Run fresh HookGateV2 candidate discovery in isolated shadow "
            "mode. This command never renders, uploads, or mutates the "
            "production profile."
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
        default=root / "research/shadow-runs/hook-gate-v2",
    )
    parser.add_argument(
        "--provider",
        choices=("gemini", "openai", "muapi", "cache-only"),
        default="gemini",
    )
    parser.add_argument(
        "--source",
        action="append",
        default=[],
        help="Source id to run; repeat to select multiple sources.",
    )
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument(
        "--cache-namespace",
        default=GROWTH_SHADOW_POLICY_VERSION,
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and print the execution contract only.",
    )
    return parser.parse_args()


def _llm_for_provider(provider: str):
    if provider == "cache-only":
        def cache_only(_prompt: str) -> str:
            raise RuntimeError(
                "cache-only shadow run encountered an uncached LLM request"
            )

        return cache_only
    if provider == "muapi":
        from shorts_generator.highlights import call_muapi_llm

        return call_muapi_llm
    from shorts_generator.local.llm import (
        call_gemini_llm,
        call_openai_llm,
    )

    return (
        call_gemini_llm
        if provider == "gemini"
        else call_openai_llm
    )


def main() -> int:
    args = _arguments()
    root = Path(__file__).resolve().parents[1]
    with args.manifest.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    specs = validate_shadow_manifest(
        manifest,
        root,
        source_ids=args.source,
    )
    print(
        "Shadow contract: "
        f"{len(specs)} sources, provider={args.provider}, "
        f"target={max(1, args.top_k)}, renders=0, uploads=0, "
        "production mutations=0."
    )
    if args.dry_run:
        for spec in specs:
            print(spec.get("source_id") or spec.get("id"))
        return 0

    result = run_growth_v2_shadow(
        manifest,
        root=root,
        output_dir=args.output_dir,
        llm_fn=_llm_for_provider(args.provider),
        top_k=max(1, args.top_k),
        source_ids=args.source,
        cache_namespace=args.cache_namespace,
    )
    aggregate = result["aggregate"]
    print(
        "Shadow complete: "
        f"{result['execution']['sourceCount']} sources, "
        f"{aggregate['candidate_count']} candidates, "
        f"{result['execution']['llmCalls']} LLM calls, "
        f"{result['execution']['elapsedSeconds']}s."
    )
    print(
        "Production approval recommended: "
        f"{result['productionApprovalRecommended']}"
    )
    print(args.output_dir / "shadow-run.json")
    return 2 if result["sourceErrorCount"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
