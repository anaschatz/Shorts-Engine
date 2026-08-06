#!/usr/bin/env python3
"""Build an immutable, self-contained Budget Friendly replay corpus.

The packer reads existing local JSON evidence only. It never downloads media,
calls a model, renders, enhances, uploads, or infers negative human labels.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Dict, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from shorts_generator.growth_replay import load_replay_dataset

from research.autoresearch_v2 import (
    assess_replay_data_readiness,
    load_autoresearch_contract,
)


CORPUS_VERSION = "bf-replay-corpus-v2.0.0"
LABELS_VERSION = "bf-replay-labels-v2.0.0"
PACK_VERSION = "bf-replay-pack-v2.0.0"

_RUNTIME_FIELDS = {
    "contentHash",
    "final_score",
    "output_rank",
    "rejected",
    "rejection_reasons",
    "selected_for_render",
    "selection_policy_version",
    "selection_profile",
}
_RUNTIME_PREFIXES = (
    "_replay_",
    "hook_gate_",
    "semantic_closure_",
    "semantic_focus_",
)


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


def _clean_candidate(candidate: Mapping[str, object], source_id: str) -> Dict[str, object]:
    cleaned = {
        key: copy.deepcopy(value)
        for key, value in candidate.items()
        if key not in _RUNTIME_FIELDS
        and not any(key.startswith(prefix) for prefix in _RUNTIME_PREFIXES)
    }
    start = float(cleaned.get("speech_start_time", cleaned.get("start_time", 0.0)) or 0.0)
    end = float(cleaned.get("speech_end_time", cleaned.get("end_time", start)) or start)
    title = str(cleaned.get("title") or "").strip()
    cleaned["corpus_candidate_id"] = _canonical_hash(
        {
            "sourceId": source_id,
            "speechStart": round(start, 6),
            "speechEnd": round(end, 6),
            "title": title,
        }
    )
    return cleaned


def _canonical_transcript(transcript: Mapping[str, object]) -> Dict[str, object]:
    segments = []
    for segment in transcript.get("segments") or []:
        if not isinstance(segment, Mapping):
            continue
        words = []
        for word in segment.get("words") or []:
            if not isinstance(word, Mapping):
                continue
            token = str(word.get("word") or word.get("text") or "").strip()
            if not token:
                continue
            words.append(
                {
                    "word": token,
                    "start": round(float(word.get("start") or 0.0), 6),
                    "end": round(float(word.get("end") or 0.0), 6),
                }
            )
        segments.append(
            {
                "start": round(float(segment.get("start") or 0.0), 6),
                "end": round(float(segment.get("end") or 0.0), 6),
                "text": str(segment.get("text") or "").strip(),
                "words": words,
            }
        )
    return {
        "duration": round(float(transcript.get("duration") or 0.0), 6),
        "segments": segments,
    }


def _relative(root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError as error:
        raise ValueError("fixture pack output must be inside the repository") from error


def build_fixture_pack(
    *,
    root: Path,
    source_manifest: Mapping[str, object],
    output_dir: Path,
) -> Dict[str, object]:
    specs = [spec for spec in source_manifest.get("datasets") or [] if isinstance(spec, Mapping)]
    if not specs:
        raise ValueError("source replay manifest has no datasets")
    if output_dir.exists():
        raise FileExistsError(f"fixture pack already exists: {output_dir}")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{output_dir.name}-",
        dir=output_dir.parent,
    ) as temporary:
        staging = Path(temporary) / output_dir.name
        dataset_dir = staging / "datasets"
        label_dir = staging / "labels"
        dataset_dir.mkdir(parents=True)
        label_dir.mkdir(parents=True)
        corpus_datasets = []
        label_datasets = []
        replay_specs = []
        for spec in specs:
            loaded = load_replay_dataset(dict(spec), root)
            dataset_id = str(loaded["id"])
            source_id = str(loaded["source_id"])
            candidates = []
            labels = []
            for candidate in loaded["candidates"]:
                cleaned = _clean_candidate(candidate, source_id)
                is_appended = candidate.get("_replay_positive_only") is True
                if not is_appended:
                    candidates.append(cleaned)
                if candidate.get("_replay_human_positive") is True:
                    labels.append(
                        {
                            "labelId": _canonical_hash(
                                [dataset_id, cleaned["corpus_candidate_id"], "approved"]
                            ),
                            "decision": "approved",
                            "candidate": cleaned,
                            "matchScore": float(
                                candidate.get("_replay_positive_match_score") or 0.0
                            ),
                            "matchStatus": "appended" if is_appended else "matched",
                            "provenance": {
                                "sourceManifestDatasetId": dataset_id,
                                "positivePath": str(spec.get("positive_path") or ""),
                                "positiveKey": str(spec.get("positive_key") or ""),
                            },
                        }
                    )
            transcript = _canonical_transcript(loaded["transcript"])
            dataset_payload = {
                "schemaVersion": 1,
                "artifactType": "BudgetFriendlyReplayDatasetV2",
                "packVersion": PACK_VERSION,
                "datasetId": dataset_id,
                "sourceId": source_id,
                "candidates": candidates,
                "transcript": transcript,
            }
            labels_payload = {
                "schemaVersion": 1,
                "artifactType": "BudgetFriendlyReplayDatasetLabelsV2",
                "labelsVersion": LABELS_VERSION,
                "datasetId": dataset_id,
                "sourceId": source_id,
                "positives": [item["candidate"] for item in labels],
                "labels": labels,
            }
            dataset_path = dataset_dir / f"{dataset_id}.json"
            label_path = label_dir / f"{dataset_id}.json"
            dataset_path.write_text(
                json.dumps(_seal(dataset_payload), indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            label_path.write_text(
                json.dumps(_seal(labels_payload), indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            final_dataset_path = output_dir / "datasets" / dataset_path.name
            final_label_path = output_dir / "labels" / label_path.name
            replay_specs.append(
                {
                    "id": dataset_id,
                    "source_id": source_id,
                    "candidate_path": _relative(root, final_dataset_path),
                    "candidate_key": "candidates",
                    "transcript_path": _relative(root, final_dataset_path),
                    "transcript_key": "transcript",
                    "positive_path": _relative(root, final_label_path),
                    "positive_key": "positives",
                    "positive_all": True,
                }
            )
            corpus_datasets.append(
                {
                    "datasetId": dataset_id,
                    "sourceId": source_id,
                    "candidateCount": len(candidates),
                    "transcriptWordCount": sum(
                        len(segment["words"]) for segment in transcript["segments"]
                    ),
                    "datasetHash": _seal(dataset_payload)["contentHash"],
                }
            )
            label_datasets.append(
                {
                    "datasetId": dataset_id,
                    "approvedCount": len(labels),
                    "labelsHash": _seal(labels_payload)["contentHash"],
                }
            )
        corpus = _seal(
            {
                "schemaVersion": 1,
                "artifactType": "BudgetFriendlyReplayCorpusV2",
                "corpusVersion": CORPUS_VERSION,
                "datasetCount": len(corpus_datasets),
                "datasets": corpus_datasets,
            }
        )
        labels = _seal(
            {
                "schemaVersion": 1,
                "artifactType": "BudgetFriendlyReplayLabelsV2",
                "labelsVersion": LABELS_VERSION,
                "labelSemantics": {
                    "approved": "explicit human-approved positive",
                    "unlisted": "unknown, never inferred rejected",
                },
                "datasets": label_datasets,
            }
        )
        replay_manifest = _seal(
            {
                "schemaVersion": 1,
                "artifactType": "BudgetFriendlyReplayManifestV2",
                "packVersion": PACK_VERSION,
                "corpusHash": corpus["contentHash"],
                "labelsHash": labels["contentHash"],
                "datasets": replay_specs,
            }
        )
        (staging / "corpus.json").write_text(
            json.dumps(corpus, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        (staging / "labels.json").write_text(
            json.dumps(labels, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        (staging / "manifest.json").write_text(
            json.dumps(replay_manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        shutil.move(staging.as_posix(), output_dir.as_posix())
    return {
        "outputDir": _relative(root, output_dir),
        "corpusHash": corpus["contentHash"],
        "labelsHash": labels["contentHash"],
        "manifestHash": replay_manifest["contentHash"],
        "datasetCount": len(corpus_datasets),
        "candidateCount": sum(item["candidateCount"] for item in corpus_datasets),
        "approvedLabelCount": sum(item["approvedCount"] for item in label_datasets),
    }


def _arguments() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--contract",
        type=Path,
        default=root / "research/autoresearch-v2-contract.json",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=root / "research/fixtures/bf-autoresearch-v2-pack",
    )
    parser.add_argument("--preflight", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    root = Path(__file__).resolve().parents[1]
    contract = load_autoresearch_contract(args.contract)
    readiness = assess_replay_data_readiness(root, contract)
    if readiness["replayable"] is not True:
        print(json.dumps(readiness, indent=2, sort_keys=True))
        return 2
    if args.preflight:
        print(json.dumps(readiness, indent=2, sort_keys=True))
        return 0
    source_manifest = json.loads(
        (root / str(contract["replayManifest"])).read_text(encoding="utf-8")
    )
    report = build_fixture_pack(
        root=root,
        source_manifest=source_manifest,
        output_dir=args.output_dir,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
