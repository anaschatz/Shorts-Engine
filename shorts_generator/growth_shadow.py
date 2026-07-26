"""Fresh HookGateV2 discovery in an isolated, non-production shadow run."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence

from .growth_replay import (
    build_growth_replay_report,
    render_growth_replay_markdown,
)
from .highlights import get_highlights
from .hook_gate import (
    HOOK_GATE_DECISION_VERSION,
    HOOK_GATE_PROMPT_VERSION,
)
from .motivational_closure import SEMANTIC_CLOSURE_DECISION_VERSION
from .profiles import (
    MOTIVATIONAL_PODCAST,
    MOTIVATIONAL_TENSION_MICRO_V2,
)


GROWTH_SHADOW_SCHEMA_VERSION = 1
GROWTH_SHADOW_POLICY_VERSION = "bf-growth-shadow-v1.0.0"
DiscoveryFn = Callable[..., Dict]
LLMFn = Callable[[str], str]


def _load_json(path: Path) -> object:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _nested(document: object, key: Optional[str]) -> object:
    value = document
    if not key:
        return value
    for part in str(key).split("."):
        if not isinstance(value, dict) or part not in value:
            raise KeyError(f"artifact has no key path {key!r}")
        value = value[part]
    return value


def _resolve(root: Path, value: object) -> Path:
    path = Path(str(value))
    return path if path.is_absolute() else root / path


def _portable_path(root: Path, path: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve()))
    except ValueError:
        return str(path.resolve())


def _atomic_write_json(path: Path, payload: Dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(
            payload,
            indent=2,
            sort_keys=True,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _content_hash(payload: Dict) -> str:
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _successful_response_cache_entries(cache_dir: Path) -> int:
    return sum(
        path.is_file() and "discovery-v6" not in path.parts
        for path in cache_dir.rglob("*.json")
    )


def _build_human_review_queue(
    replay_report: Dict,
    source_results: Sequence[Dict],
    root: Path,
) -> Dict:
    artifacts = {
        result["sourceId"]: _load_json(
            _resolve(root, result["candidateArtifact"])
        )
        for result in source_results
    }
    items = []
    for dataset in replay_report["datasets"]:
        source_id = dataset["source_id"]
        artifact = artifacts.get(source_id)
        raw_candidates = (
            _nested(artifact, "result.highlights")
            if isinstance(artifact, dict)
            else []
        )
        if not isinstance(raw_candidates, list):
            raw_candidates = []
        shadow_top_ids = set(
            dataset["top_k"]["closure_shadow_ids"]
        )
        for index, record in enumerate(dataset["candidates"]):
            full_eligible = record["full_v2"]["eligible"]
            shadow_top = record["replay_id"] in shadow_top_ids
            if not full_eligible and not shadow_top:
                continue
            raw = (
                raw_candidates[index]
                if index < len(raw_candidates)
                and isinstance(raw_candidates[index], dict)
                else {}
            )
            items.append(
                {
                    "reviewId": record["replay_id"],
                    "sourceId": source_id,
                    "priority": (
                        "full_v2_eligible"
                        if full_eligible
                        else "closure_shadow_near_miss"
                    ),
                    "title": record["title"],
                    "speechStartTime": record["speech_start_time"],
                    "speechEndTime": record["speech_end_time"],
                    "speechDurationSeconds": record[
                        "speech_duration_seconds"
                    ],
                    "openingExactQuote": str(
                        raw.get("opening_exact_quote") or ""
                    ),
                    "hookSignalPhrase": str(
                        raw.get("hook_signal_phrase") or ""
                    ),
                    "hookPayoffPhrase": str(
                        raw.get("hook_payoff_phrase") or ""
                    ),
                    "closingExactQuote": str(
                        raw.get("semantic_closure_sentence")
                        or raw.get(
                            "earliest_complete_takeaway_sentence"
                        )
                        or ""
                    ),
                    "hookStatus": record["hook_gate"]["status"],
                    "hookReasons": record["hook_gate"]["reasons"],
                    "closureStatus": record[
                        "semantic_closure"
                    ]["status"],
                    "closureReasons": record[
                        "semantic_closure"
                    ]["reasons"],
                    "fullV2Eligible": full_eligible,
                    "humanDecision": None,
                    "humanReasons": [],
                }
            )
    items.sort(
        key=lambda item: (
            item["priority"] != "full_v2_eligible",
            item["sourceId"],
            item["speechStartTime"],
        )
    )
    return {
        "schemaVersion": 1,
        "artifactType": "BudgetFriendlyGrowthShadowHumanReviewQueue",
        "policyVersion": GROWTH_SHADOW_POLICY_VERSION,
        "instructions": (
            "Set humanDecision to approve or reject and add concise "
            "humanReasons. Full-V2 items estimate precision; closure-shadow "
            "near misses help detect an over-strict hook gate."
        ),
        "reviewedCount": 0,
        "items": items,
    }


def _render_human_review_markdown(queue: Dict) -> str:
    lines = [
        "# HookGateV2 Shadow Human Review",
        "",
        "Mark exactly one decision for each item:",
        "",
        "- `[ ] approve`",
        "- `[ ] reject`",
        "",
    ]
    for index, item in enumerate(queue["items"], start=1):
        lines.extend(
            [
                f"## {index}. {item['title']}",
                "",
                f"- Review id: `{item['reviewId']}`",
                f"- Source: `{item['sourceId']}`",
                f"- Priority: `{item['priority']}`",
                (
                    f"- Interval: {item['speechStartTime']:.3f}s–"
                    f"{item['speechEndTime']:.3f}s "
                    f"({item['speechDurationSeconds']:.3f}s)"
                ),
                f"- Opening: “{item['openingExactQuote']}”",
                f"- Signal: “{item['hookSignalPhrase']}”",
                f"- Payoff: “{item['hookPayoffPhrase']}”",
                f"- Closing: “{item['closingExactQuote']}”",
                (
                    f"- Hook: `{item['hookStatus']}`"
                    + (
                        " — " + ", ".join(item["hookReasons"])
                        if item["hookReasons"]
                        else ""
                    )
                ),
                (
                    f"- Closure: `{item['closureStatus']}`"
                    + (
                        " — " + ", ".join(item["closureReasons"])
                        if item["closureReasons"]
                        else ""
                    )
                ),
                "",
                "- [ ] approve",
                "- [ ] reject",
                "- Reasons:",
                "",
            ]
        )
    if not queue["items"]:
        lines.extend(
            [
                "No full-V2 candidates or closure-shadow near misses were "
                "available.",
                "",
            ]
        )
    return "\n".join(lines)


def validate_shadow_manifest(
    manifest: Dict,
    root: Path,
    source_ids: Optional[Sequence[str]] = None,
) -> List[Dict]:
    specs = manifest.get("datasets")
    if not isinstance(specs, list) or not specs:
        raise ValueError("shadow manifest requires at least one dataset")
    requested = {
        str(value).strip()
        for value in (source_ids or [])
        if str(value).strip()
    }
    selected = []
    for raw_spec in specs:
        if not isinstance(raw_spec, dict):
            continue
        spec = dict(raw_spec)
        source_id = str(
            spec.get("source_id") or spec.get("id") or ""
        ).strip()
        if requested and source_id not in requested:
            continue
        if not source_id:
            raise ValueError("every shadow dataset requires source_id or id")
        for key in ("candidate_path", "transcript_path", "positive_path"):
            if key not in spec:
                raise ValueError(f"{source_id}: missing {key}")
            path = _resolve(root, spec[key])
            if not path.is_file():
                raise FileNotFoundError(f"{source_id}: missing {path}")
        selected.append(spec)
    missing = requested - {
        str(spec.get("source_id") or spec.get("id"))
        for spec in selected
    }
    if missing:
        raise ValueError(
            "requested sources are absent from manifest: "
            + ", ".join(sorted(missing))
        )
    if not selected:
        raise ValueError("shadow source filter selected no datasets")
    return selected


def _load_transcript(spec: Dict, root: Path) -> Dict:
    transcript_path = _resolve(
        root,
        spec.get("transcript_path") or spec["candidate_path"],
    )
    document = _load_json(transcript_path)
    transcript = _nested(document, str(spec.get("transcript_key") or ""))
    if not isinstance(transcript, dict) or not isinstance(
        transcript.get("segments"),
        list,
    ):
        raise TypeError(
            f"{transcript_path}: transcript must contain segments"
        )
    return transcript


def run_growth_v2_shadow(
    manifest: Dict,
    *,
    root: Path,
    output_dir: Path,
    llm_fn: LLMFn,
    top_k: int = 3,
    source_ids: Optional[Sequence[str]] = None,
    cache_namespace: str = GROWTH_SHADOW_POLICY_VERSION,
    discovery_fn: DiscoveryFn = get_highlights,
) -> Dict:
    """Run fresh V2 discovery without rendering, publishing, or policy mutation."""
    root = root.resolve()
    output_dir = output_dir.resolve()
    specs = validate_shadow_manifest(manifest, root, source_ids)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = output_dir / "cache"
    candidate_dir = output_dir / "candidates"

    replay_specs: List[Dict] = []
    source_results: List[Dict] = []
    total_llm_calls = 0
    run_started = time.monotonic()

    for spec in specs:
        dataset_id = str(spec.get("id") or spec.get("source_id"))
        source_id = str(spec.get("source_id") or dataset_id)
        transcript = _load_transcript(spec, root)
        source_call_count = 0
        source_cache_dir = cache_dir / dataset_id
        cached_responses_before = _successful_response_cache_entries(
            source_cache_dir
        )

        def counted_llm(prompt: str) -> str:
            nonlocal source_call_count, total_llm_calls
            source_call_count += 1
            total_llm_calls += 1
            return llm_fn(prompt)

        source_started = time.monotonic()
        error_payload = None
        try:
            result = discovery_fn(
                transcript,
                num_clips=max(1, int(top_k)),
                llm_fn=counted_llm,
                profile_override=MOTIVATIONAL_PODCAST,
                cache_dir=str(source_cache_dir),
                cache_namespace=(
                    f"{cache_namespace}:{dataset_id}:"
                    f"{HOOK_GATE_PROMPT_VERSION}"
                ),
                selection_profile=MOTIVATIONAL_TENSION_MICRO_V2,
                allow_incomplete_batch=True,
            )
            if not isinstance(result, dict) or not isinstance(
                result.get("highlights"),
                list,
            ):
                raise TypeError(
                    "shadow discovery must return a highlights list"
                )
        except Exception as error:
            error_payload = {
                "type": type(error).__name__,
                "message": str(error),
            }
            result = {
                "content_info": {
                    "content_type": MOTIVATIONAL_PODCAST,
                    "selection_profile": MOTIVATIONAL_TENSION_MICRO_V2,
                },
                "highlights": [],
                "batch_decision": {
                    "target_count": max(1, int(top_k)),
                    "eligible_count": 0,
                    "selected_count": 0,
                    "complete": False,
                },
            }

        highlights = [
            dict(value)
            for value in result.get("highlights", [])
            if isinstance(value, dict)
        ]
        evidence_complete_count = sum(
            value.get("hook_gate_response_complete") is True
            for value in highlights
        )
        cached_responses_after = _successful_response_cache_entries(
            source_cache_dir
        )
        artifact = {
            "schemaVersion": GROWTH_SHADOW_SCHEMA_VERSION,
            "artifactType": "BudgetFriendlyGrowthShadowCandidates",
            "policyVersion": GROWTH_SHADOW_POLICY_VERSION,
            "datasetId": dataset_id,
            "sourceId": source_id,
            "selectionProfile": MOTIVATIONAL_TENSION_MICRO_V2,
            "hookPromptVersion": HOOK_GATE_PROMPT_VERSION,
            "hookDecisionVersion": HOOK_GATE_DECISION_VERSION,
            "semanticClosureDecisionVersion": (
                SEMANTIC_CLOSURE_DECISION_VERSION
            ),
            "execution": {
                "llmCalls": source_call_count,
                "newSuccessfulResponseCacheEntries": max(
                    0,
                    cached_responses_after - cached_responses_before,
                ),
                "successfulResponseCacheEntries": cached_responses_after,
                "elapsedSeconds": round(
                    time.monotonic() - source_started,
                    3,
                ),
                "renders": 0,
                "uploads": 0,
                "productionPolicyMutations": 0,
            },
            "hookEvidence": {
                "candidateCount": len(highlights),
                "responseCompleteCount": evidence_complete_count,
                "coverage": (
                    round(evidence_complete_count / len(highlights), 4)
                    if highlights
                    else None
                ),
            },
            "error": error_payload,
            "result": {
                **result,
                "highlights": highlights,
            },
        }
        artifact["contentHash"] = _content_hash(artifact)
        candidate_path = candidate_dir / f"{dataset_id}.json"
        _atomic_write_json(candidate_path, artifact)

        replay_spec = {
            **spec,
            "candidate_path": _portable_path(root, candidate_path),
            "candidate_key": "result.highlights",
            "append_unmatched_positives": False,
        }
        replay_specs.append(replay_spec)
        source_results.append(
            {
                "datasetId": dataset_id,
                "sourceId": source_id,
                "candidateArtifact": _portable_path(
                    root,
                    candidate_path,
                ),
                "candidateCount": len(highlights),
                "hookEvidenceCompleteCount": evidence_complete_count,
                "llmCalls": source_call_count,
                "newSuccessfulResponseCacheEntries": artifact["execution"][
                    "newSuccessfulResponseCacheEntries"
                ],
                "successfulResponseCacheEntries": cached_responses_after,
                "elapsedSeconds": artifact["execution"][
                    "elapsedSeconds"
                ],
                "batchDecision": result.get("batch_decision"),
                "error": error_payload,
            }
        )

    replay_manifest = {
        "schemaVersion": 1,
        "artifactType": "BudgetFriendlyGrowthShadowReplayManifest",
        "shadowPolicyVersion": GROWTH_SHADOW_POLICY_VERSION,
        "datasets": replay_specs,
    }
    manifest_path = output_dir / "replay-manifest.json"
    _atomic_write_json(manifest_path, replay_manifest)

    replay_report = build_growth_replay_report(
        replay_manifest,
        root=root,
        top_k=max(1, int(top_k)),
    )
    replay_json_path = output_dir / "growth-v2-shadow-replay.json"
    replay_markdown_path = output_dir / "growth-v2-shadow-replay.md"
    _atomic_write_json(replay_json_path, replay_report)
    replay_markdown_path.write_text(
        render_growth_replay_markdown(replay_report),
        encoding="utf-8",
    )
    review_queue = _build_human_review_queue(
        replay_report,
        source_results,
        root,
    )
    review_json_path = output_dir / "human-review-queue.json"
    review_markdown_path = output_dir / "human-review-queue.md"
    _atomic_write_json(review_json_path, review_queue)
    review_markdown_path.write_text(
        _render_human_review_markdown(review_queue),
        encoding="utf-8",
    )

    payload = {
        "schemaVersion": GROWTH_SHADOW_SCHEMA_VERSION,
        "artifactType": "BudgetFriendlyGrowthShadowRun",
        "policyVersion": GROWTH_SHADOW_POLICY_VERSION,
        "cacheNamespace": cache_namespace,
        "selectionProfile": MOTIVATIONAL_TENSION_MICRO_V2,
        "execution": {
            "sourceCount": len(specs),
            "llmCalls": total_llm_calls,
            "successfulResponseCacheEntries": sum(
                result["successfulResponseCacheEntries"]
                for result in source_results
            ),
            "elapsedSeconds": round(time.monotonic() - run_started, 3),
            "renders": 0,
            "uploads": 0,
            "productionPolicyMutations": 0,
        },
        "sources": source_results,
        "replayManifest": _portable_path(root, manifest_path),
        "replayReport": _portable_path(root, replay_json_path),
        "replayMarkdown": _portable_path(root, replay_markdown_path),
        "humanReviewQueue": _portable_path(root, review_json_path),
        "humanReviewMarkdown": _portable_path(
            root,
            review_markdown_path,
        ),
        "humanReviewItemCount": len(review_queue["items"]),
        "humanReviewedCount": review_queue["reviewedCount"],
        "acceptanceGates": replay_report["acceptanceGates"],
        "aggregate": replay_report["aggregate"],
        "productionApprovalRecommended": replay_report[
            "productionApprovalRecommended"
        ],
        "sourceErrorCount": sum(
            result["error"] is not None
            for result in source_results
        ),
    }
    payload["contentHash"] = _content_hash(payload)
    _atomic_write_json(output_dir / "shadow-run.json", payload)
    return payload


__all__ = [
    "GROWTH_SHADOW_POLICY_VERSION",
    "GROWTH_SHADOW_SCHEMA_VERSION",
    "run_growth_v2_shadow",
    "validate_shadow_manifest",
]
