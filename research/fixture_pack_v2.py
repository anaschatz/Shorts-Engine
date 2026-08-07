#!/usr/bin/env python3
"""Build an immutable, self-contained Budget Friendly replay corpus.

The packer reads existing local JSON evidence only. It never downloads media,
calls a model, renders, enhances, uploads, or infers negative human labels.
Explicit human rejections are verified and reported as read-only diagnostics;
they never become positives or make a dataset promotable.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Dict, Mapping, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from shorts_generator.growth_replay import load_replay_dataset
from shorts_generator.config import LOCAL_AUTORESEARCH_EVIDENCE_DIR
from shorts_generator.replay_capture import (
    HUMAN_LABEL_SEMANTICS,
    HUMAN_REJECTION_ARTIFACT_TYPE,
    LABEL_ARTIFACT_TYPE,
    verify_replay_capture_dataset,
    verify_replay_capture_label,
    verify_replay_human_rejection,
)

from research.autoresearch_v2 import (
    assess_replay_data_readiness,
    load_autoresearch_contract,
)


CORPUS_VERSION = "bf-replay-corpus-v2.0.0"
LABELS_VERSION = "bf-replay-labels-v2.0.0"
PACK_VERSION = "bf-replay-pack-v2.0.0"
LEGACY_LABEL_BINDING_MODE = "legacy_interval_v1"
EXACT_LABEL_BINDING_MODE = "candidate_hash_exact_v1"
CAPTURE_READINESS_ARTIFACT_TYPE = "BudgetFriendlyAutoresearchCaptureReadiness"

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

_CAPTURE_NONPORTABLE_FIELDS = frozenset(
    {
        "cache_path",
        "candidate_cache_path",
        "clip_url",
        "shot_index_cache_path",
        "transcript_cache_path",
        "youtube_upload",
    }
)
_WINDOWS_ABSOLUTE_PATH = re.compile(
    r"(?:^|[\s\"'=(])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])"
)
_POSIX_ABSOLUTE_PATH = re.compile(
    r"(?:^|[\s\"'=(])/(?!/)[^\s\"']+"
)


class CaptureActivationUnavailable(ValueError):
    def __init__(self, report: Mapping[str, object]):
        super().__init__("capture snapshot does not meet activation gates")
        self.report = dict(report)


def _canonical_hash(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
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


def _contains_absolute_path(value: str) -> bool:
    stripped = str(value or "").strip()
    if not stripped:
        return False
    if stripped.lower().startswith("file://") or Path(stripped).is_absolute():
        return True
    return bool(
        _WINDOWS_ABSOLUTE_PATH.search(stripped)
        or _POSIX_ABSOLUTE_PATH.search(stripped)
    )


def _portable_capture_value(value: object, *, context: str) -> object:
    """Fail closed on nested path fields or hidden absolute path values."""
    if isinstance(value, Mapping):
        portable = {}
        for key, item in value.items():
            normalized_key = str(key)
            if normalized_key in _CAPTURE_NONPORTABLE_FIELDS:
                raise ValueError(
                    "portable replay projection contains a nested local-path "
                    f"field at {context}.{normalized_key}"
                )
            portable[normalized_key] = _portable_capture_value(
                item,
                context=f"{context}.{normalized_key}",
            )
        return portable
    if isinstance(value, list):
        return [
            _portable_capture_value(item, context=f"{context}[{index}]")
            for index, item in enumerate(value)
        ]
    if isinstance(value, str) and _contains_absolute_path(value):
        # Never echo the rejected value: the diagnostic itself must not leak a
        # local username, cache root, or credential-bearing filesystem path.
        raise ValueError(f"portable replay projection contains an absolute path at {context}")
    return copy.deepcopy(value)


def _portable_capture_candidate(candidate: Mapping[str, object]) -> Dict[str, object]:
    """Drop only hash-volatile top-level paths; reject hidden nested paths."""
    portable = _portable_capture_value(
        {
            str(key): copy.deepcopy(value)
            for key, value in candidate.items()
            if str(key) not in _CAPTURE_NONPORTABLE_FIELDS
        },
        context="candidate",
    )
    if not isinstance(portable, dict):
        raise ValueError("portable capture candidate must be an object")
    return portable


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
            sealed_dataset = _seal(dataset_payload)
            sealed_labels = _seal(labels_payload)
            dataset_path = dataset_dir / f"{dataset_id}.json"
            label_path = label_dir / f"{dataset_id}.json"
            dataset_path.write_text(
                json.dumps(sealed_dataset, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            label_path.write_text(
                json.dumps(sealed_labels, indent=2, sort_keys=True) + "\n",
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
                    "append_unmatched_positives": True,
                    "label_binding_mode": LEGACY_LABEL_BINDING_MODE,
                    "candidate_artifact_hash": sealed_dataset["contentHash"],
                    "positive_artifact_hash": sealed_labels["contentHash"],
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
                    "datasetHash": sealed_dataset["contentHash"],
                }
            )
            label_datasets.append(
                {
                    "datasetId": dataset_id,
                    "approvedCount": len(labels),
                    "labelsHash": sealed_labels["contentHash"],
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
                "labelBindingMode": LEGACY_LABEL_BINDING_MODE,
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


def discover_capture_paths(capture_dir: Path) -> Tuple[list[Path], list[Path]]:
    """Discover promotable dataset/approval objects without trusting filenames."""
    dataset_paths, label_paths = _capture_paths(capture_dir)
    if not dataset_paths:
        raise ValueError("capture inbox has no dataset artifacts")
    return dataset_paths, label_paths


def discover_negative_capture_paths(capture_dir: Path) -> list[Path]:
    """Discover diagnostic-only explicit rejection objects."""
    return sorted((capture_dir / "negative-labels").glob("*/*.json"))


def _capture_paths(capture_dir: Path) -> Tuple[list[Path], list[Path]]:
    return (
        sorted((capture_dir / "datasets").glob("*.json")),
        sorted((capture_dir / "labels").glob("*/*.json")),
    )


def _read_artifacts(paths: Sequence[Path]) -> list[Dict]:
    artifacts = []
    for path in paths:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"invalid capture artifact: {path}") from error
        if not isinstance(value, dict):
            raise ValueError(f"capture artifact is not an object: {path}")
        artifacts.append(value)
    return artifacts


def ingest_capture_artifacts(
    *,
    dataset_artifacts: Sequence[Mapping[str, object]],
    label_artifacts: Sequence[Mapping[str, object]],
    negative_label_artifacts: Sequence[Mapping[str, object]] = (),
    diagnostics: Dict[str, object] | None = None,
) -> list[Dict]:
    """Validate exact hash joins and return positive-only replay inputs.

    Explicit rejection artifacts are verified against the same immutable
    dataset universe, then exposed only as aggregate diagnostics. They do not
    alter approval semantics or make an otherwise orphan dataset promotable.
    """
    datasets_by_hash: Dict[str, Dict] = {}
    datasets_by_ranking: Dict[str, Dict] = {}
    for raw in dataset_artifacts:
        dataset = verify_replay_capture_dataset(dict(raw))
        dataset_hash = str(dataset["contentHash"])
        ranking_hash = str(dataset["rankingManifestHash"])
        existing = datasets_by_ranking.get(ranking_hash)
        if existing is not None and existing["contentHash"] != dataset_hash:
            raise ValueError(
                "multiple capture datasets claim the same ranking manifest"
            )
        datasets_by_hash[dataset_hash] = dataset
        datasets_by_ranking[ranking_hash] = dataset
    if not datasets_by_hash:
        raise ValueError("capture ingestion requires at least one dataset")

    events_by_dataset: Dict[str, Dict[str, Dict]] = {
        dataset_hash: {} for dataset_hash in datasets_by_hash
    }
    for raw in label_artifacts:
        if raw.get("artifactType") != LABEL_ARTIFACT_TYPE:
            raise ValueError(f"expected {LABEL_ARTIFACT_TYPE}")
        dataset_hash = str(raw.get("datasetHash") or "")
        dataset = datasets_by_hash.get(dataset_hash)
        if dataset is None:
            raise ValueError("capture label references an unknown dataset")
        label = verify_replay_capture_label(dict(raw), dataset)
        events_by_dataset[dataset_hash][label["contentHash"]] = label

    rejection_events_by_dataset: Dict[str, Dict[str, Dict]] = {
        dataset_hash: {} for dataset_hash in datasets_by_hash
    }
    for raw in negative_label_artifacts:
        if raw.get("artifactType") != HUMAN_REJECTION_ARTIFACT_TYPE:
            raise ValueError(f"expected {HUMAN_REJECTION_ARTIFACT_TYPE}")
        dataset_hash = str(raw.get("datasetHash") or "")
        dataset = datasets_by_hash.get(dataset_hash)
        if dataset is None:
            raise ValueError("capture human rejection references an unknown dataset")
        rejection = verify_replay_human_rejection(dict(raw), dataset)
        rejection_events_by_dataset[dataset_hash][
            str(rejection["contentHash"])
        ] = rejection

    for dataset_hash in sorted(datasets_by_hash):
        approved_candidate_hashes = {
            str(event["candidateHash"])
            for event in events_by_dataset[dataset_hash].values()
        }
        rejected_candidate_hashes = {
            str(event["candidateHash"])
            for event in rejection_events_by_dataset[dataset_hash].values()
        }
        if approved_candidate_hashes & rejected_candidate_hashes:
            raise ValueError(
                "capture candidate has conflicting explicit human approval "
                "and rejection"
            )

    prepared = []
    orphan_dataset_ids = []
    seen_source_ids = set()
    seen_source_hashes = set()
    for dataset in sorted(
        datasets_by_hash.values(),
        key=lambda item: (str(item["sourceId"]), str(item["rankingManifestHash"])),
    ):
        dataset_hash = str(dataset["contentHash"])
        events = sorted(
            events_by_dataset[dataset_hash].values(),
            key=lambda item: (str(item["candidateHash"]), str(item["contentHash"])),
        )
        if not events:
            orphan_dataset_ids.append(str(dataset["datasetId"]))
            continue
        source_id = str(dataset["sourceId"])
        source_hash = str(dataset["sourceHash"])
        if source_id in seen_source_ids or source_hash in seen_source_hashes:
            raise ValueError(
                "capture snapshot requires exactly one ranking per source"
            )
        seen_source_ids.add(source_id)
        seen_source_hashes.add(source_hash)
        event_hashes_by_candidate: Dict[str, list[str]] = {}
        label_events_by_candidate: Dict[str, list[Dict]] = {}
        for event in events:
            event_candidate_hash = str(event["candidateHash"])
            event_hashes_by_candidate.setdefault(event_candidate_hash, []).append(
                str(event["contentHash"])
            )
            label_events_by_candidate.setdefault(event_candidate_hash, []).append(
                copy.deepcopy(event)
            )
        candidate_hashes = [
            str(candidate["candidate_hash"])
            for candidate in dataset["candidates"]
        ]
        approved_hashes = [
            value for value in candidate_hashes if value in event_hashes_by_candidate
        ]
        prepared.append(
            {
                "datasetId": str(dataset["datasetId"]),
                "sourceId": source_id,
                "sourceHash": source_hash,
                "rankingManifestHash": str(dataset["rankingManifestHash"]),
                "captureDatasetHash": dataset_hash,
                "candidates": copy.deepcopy(dataset["candidates"]),
                "transcript": copy.deepcopy(
                    dataset["replayTranscriptManifest"]["transcript"]
                ),
                "approvedCandidateHashes": approved_hashes,
                "labelEventHashesByCandidate": {
                    key: sorted(value)
                    for key, value in sorted(event_hashes_by_candidate.items())
                },
                "labelEventsByCandidate": {
                    key: sorted(
                        value,
                        key=lambda event: str(event["contentHash"]),
                    )
                    for key, value in sorted(label_events_by_candidate.items())
                },
                "engineSelectedCandidateHashes": list(
                    dataset["engineSelectedCandidateHashes"]
                ),
                "engineSelectionSemantics": dataset[
                    "engineSelectionSemantics"
                ],
                "replayTranscriptManifestHash": dataset[
                    "replayTranscriptManifestHash"
                ],
                "transcriptHash": dataset["transcriptHash"],
                "transcriptTimingHash": dataset["transcriptTimingHash"],
                "approvalEventCount": len(events),
            }
        )
    if diagnostics is not None:
        rejection_events = [
            event
            for events in rejection_events_by_dataset.values()
            for event in events.values()
        ]
        diagnostics.clear()
        diagnostics.update(
            {
                "capturedDatasetCount": len(datasets_by_hash),
                "promotableDatasetCount": len(prepared),
                "skippedOrphanDatasetCount": len(orphan_dataset_ids),
                "skippedOrphanDatasetIds": sorted(orphan_dataset_ids),
                "explicitHumanRejectionCount": len(rejection_events),
                "rejectedCandidateCount": len(
                    {
                        (str(event["datasetHash"]), str(event["candidateHash"]))
                        for event in rejection_events
                    }
                ),
            }
        )
    return prepared


def _capture_gate_policy(contract: Mapping[str, object]) -> Dict[str, object]:
    raw = contract.get("dataReadinessGates")
    if not isinstance(raw, Mapping):
        raise ValueError("capture readiness requires dataReadinessGates")
    policy: Dict[str, object] = {}
    for key in (
        "minimumSources",
        "minimumCandidates",
        "minimumHumanPositives",
    ):
        value = raw.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError(f"{key} must be an integer greater than zero")
        policy[key] = value
    coverage = raw.get("minimumPositiveLabelMatchCoverage")
    if (
        isinstance(coverage, bool)
        or not isinstance(coverage, (int, float))
        or not math.isfinite(float(coverage))
        or not 0.0 <= float(coverage) <= 1.0
    ):
        raise ValueError(
            "minimumPositiveLabelMatchCoverage must be finite and between 0 and 1"
        )
    policy["minimumPositiveLabelMatchCoverage"] = float(coverage)
    return policy


def build_capture_activation_readiness(
    *,
    prepared: Sequence[Mapping[str, object]],
    diagnostics: Mapping[str, object],
    contract: Mapping[str, object],
    integrity_error: str | None = None,
    dataset_artifact_count: int | None = None,
    label_artifact_count: int | None = None,
    negative_label_artifact_count: int | None = None,
) -> Dict[str, object]:
    """Measure exact approval evidence against the frozen activation gates."""
    policy = _capture_gate_policy(contract)
    source_count = len(prepared)
    candidate_count = 0
    human_positive_hashes = set()
    matched_positive_hashes = set()
    approval_event_count = 0
    seen_source_ids = set()
    seen_source_hashes = set()
    for item in prepared:
        source_id = str(item.get("sourceId") or "").strip()
        source_hash = str(item.get("sourceHash") or "").strip()
        if not source_id or not source_hash:
            raise ValueError("prepared capture source identity is incomplete")
        if source_id in seen_source_ids or source_hash in seen_source_hashes:
            raise ValueError("prepared capture sources must be unique")
        seen_source_ids.add(source_id)
        seen_source_hashes.add(source_hash)
        candidates = [
            candidate
            for candidate in item.get("candidates") or []
            if isinstance(candidate, Mapping)
        ]
        if len(candidates) != len(item.get("candidates") or []):
            raise ValueError("prepared capture candidates must be objects")
        candidate_hashes = {
            str(candidate.get("candidate_hash") or "").strip()
            for candidate in candidates
        }
        if "" in candidate_hashes or len(candidate_hashes) != len(candidates):
            raise ValueError("prepared capture candidate hashes must be unique")
        approved_hashes = {
            str(value or "").strip()
            for value in item.get("approvedCandidateHashes") or []
        }
        if "" in approved_hashes:
            raise ValueError("prepared capture approval hash is empty")
        unmatched = approved_hashes - candidate_hashes
        if unmatched:
            raise ValueError("prepared capture approval is not in candidate universe")
        if not approved_hashes:
            raise ValueError("prepared capture requires a human-positive candidate")
        duplicate_positives = human_positive_hashes & approved_hashes
        if duplicate_positives:
            raise ValueError("prepared capture reuses a human-positive candidate")
        human_positive_hashes.update(approved_hashes)
        matched_positive_hashes.update(approved_hashes & candidate_hashes)
        candidate_count += len(candidates)
        event_count = item.get("approvalEventCount")
        if (
            isinstance(event_count, bool)
            or not isinstance(event_count, int)
            or event_count < 0
        ):
            raise ValueError("prepared capture approvalEventCount is invalid")
        if event_count < len(approved_hashes):
            raise ValueError("prepared capture has fewer events than human positives")
        approval_event_count += event_count
    human_positive_count = len(human_positive_hashes)
    matched_positive_count = len(matched_positive_hashes)
    positive_match_coverage = (
        round(matched_positive_count / human_positive_count, 6)
        if human_positive_count
        else 0.0
    )
    captured_dataset_count = int(diagnostics.get("capturedDatasetCount") or 0)
    promotable_dataset_count = int(diagnostics.get("promotableDatasetCount") or 0)
    skipped_orphan_count = int(diagnostics.get("skippedOrphanDatasetCount") or 0)
    explicit_human_rejection_count = diagnostics.get(
        "explicitHumanRejectionCount",
        0,
    )
    rejected_candidate_count = diagnostics.get("rejectedCandidateCount", 0)
    for field, value in (
        ("explicitHumanRejectionCount", explicit_human_rejection_count),
        ("rejectedCandidateCount", rejected_candidate_count),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"capture diagnostics {field} is invalid")
    if rejected_candidate_count > explicit_human_rejection_count:
        raise ValueError(
            "capture diagnostics rejectedCandidateCount exceeds rejection events"
        )
    if promotable_dataset_count != source_count:
        raise ValueError("capture diagnostics promotable count is inconsistent")
    if captured_dataset_count != promotable_dataset_count + skipped_orphan_count:
        raise ValueError("capture diagnostics dataset counts are inconsistent")

    def gate(code: str, actual: int | float, expected: int | float) -> Dict[str, object]:
        deficit = max(0.0, float(expected) - float(actual))
        if isinstance(actual, int) and isinstance(expected, int):
            normalized_deficit: int | float = int(deficit)
        else:
            normalized_deficit = round(deficit, 6)
        return {
            "code": code,
            "actual": actual,
            "expected": expected,
            "deficit": normalized_deficit,
            "passed": actual >= expected,
        }

    gates = [
        gate("SOURCE_COVERAGE", source_count, int(policy["minimumSources"])),
        gate(
            "CANDIDATE_COVERAGE",
            candidate_count,
            int(policy["minimumCandidates"]),
        ),
        gate(
            "HUMAN_POSITIVE_COVERAGE",
            human_positive_count,
            int(policy["minimumHumanPositives"]),
        ),
        gate(
            "POSITIVE_LABEL_MATCH_COVERAGE",
            positive_match_coverage,
            float(policy["minimumPositiveLabelMatchCoverage"]),
        ),
    ]
    replayable = bool(prepared) and integrity_error is None
    activation_ready = replayable and all(item["passed"] for item in gates)
    payload = {
        "schemaVersion": 1,
        "artifactType": CAPTURE_READINESS_ARTIFACT_TYPE,
        "contractVersion": str(contract.get("contractVersion") or ""),
        "labelBindingMode": EXACT_LABEL_BINDING_MODE,
        "datasetArtifactCount": (
            int(dataset_artifact_count)
            if dataset_artifact_count is not None
            else int(diagnostics.get("capturedDatasetCount") or 0)
        ),
        "labelArtifactCount": (
            int(label_artifact_count)
            if label_artifact_count is not None
            else approval_event_count
        ),
        "negativeLabelArtifactCount": (
            int(negative_label_artifact_count)
            if negative_label_artifact_count is not None
            else explicit_human_rejection_count
        ),
        "sourceCount": source_count,
        "candidateCount": candidate_count,
        "humanPositiveCount": human_positive_count,
        "humanPositiveMatchedCount": matched_positive_count,
        "positiveLabelMatchCoverage": positive_match_coverage,
        "approvalEventCount": approval_event_count,
        "explicitHumanRejectionCount": explicit_human_rejection_count,
        "rejectedCandidateCount": rejected_candidate_count,
        "capturedDatasetCount": captured_dataset_count,
        "promotableDatasetCount": promotable_dataset_count,
        "skippedOrphanDatasetCount": skipped_orphan_count,
        "skippedOrphanDatasetIds": sorted(
            str(value) for value in diagnostics.get("skippedOrphanDatasetIds") or []
        ),
        "integrityError": integrity_error,
        "replayable": replayable,
        "activationReady": activation_ready,
        "dataReadinessGates": gates,
        "failedGateCodes": [
            str(item["code"]) for item in gates if item["passed"] is not True
        ],
    }
    return _seal(payload)


def assess_capture_data_readiness(
    capture_dir: Path,
    contract: Mapping[str, object],
) -> Dict[str, object]:
    """Inspect a mutable capture inbox without promoting or mutating it."""
    dataset_paths, label_paths = _capture_paths(capture_dir)
    negative_label_paths = discover_negative_capture_paths(capture_dir)
    diagnostics: Dict[str, object] = {
        "capturedDatasetCount": len(dataset_paths),
        "promotableDatasetCount": 0,
        "skippedOrphanDatasetCount": len(dataset_paths),
        "skippedOrphanDatasetIds": [],
        "explicitHumanRejectionCount": 0,
        "rejectedCandidateCount": 0,
    }
    prepared: list[Dict] = []
    integrity_error = None
    if not dataset_paths and label_paths:
        integrity_error = "capture inbox has label artifacts but no dataset artifacts"
    elif not dataset_paths and negative_label_paths:
        integrity_error = (
            "capture inbox has human rejection artifacts but no dataset artifacts"
        )
    elif dataset_paths:
        try:
            prepared = ingest_capture_artifacts(
                dataset_artifacts=_read_artifacts(dataset_paths),
                label_artifacts=_read_artifacts(label_paths),
                negative_label_artifacts=_read_artifacts(negative_label_paths),
                diagnostics=diagnostics,
            )
        except (OSError, TypeError, ValueError, KeyError) as error:
            message = str(error)
            for capture_root in {str(capture_dir), str(capture_dir.resolve())}:
                message = message.replace(capture_root, "<capture-dir>")
            integrity_error = f"{type(error).__name__}: {message}"
    return build_capture_activation_readiness(
        prepared=prepared,
        diagnostics=diagnostics,
        contract=contract,
        integrity_error=integrity_error,
        dataset_artifact_count=len(dataset_paths),
        label_artifact_count=len(label_paths),
        negative_label_artifact_count=len(negative_label_paths),
    )


def build_fixture_pack_from_captures(
    *,
    root: Path,
    dataset_paths: Sequence[Path],
    label_paths: Sequence[Path],
    negative_label_paths: Sequence[Path] = (),
    output_dir: Path,
    activation_contract: Mapping[str, object] | None = None,
) -> Dict[str, object]:
    """Promote an append-only approval inbox into one frozen replay pack."""
    ingestion_diagnostics: Dict[str, object] = {}
    prepared = ingest_capture_artifacts(
        dataset_artifacts=_read_artifacts(dataset_paths),
        label_artifacts=_read_artifacts(label_paths),
        negative_label_artifacts=_read_artifacts(negative_label_paths),
        diagnostics=ingestion_diagnostics,
    )
    if not prepared:
        raise ValueError("capture snapshot has no promotable labeled datasets")
    activation_readiness = None
    if activation_contract is not None:
        activation_readiness = build_capture_activation_readiness(
            prepared=prepared,
            diagnostics=ingestion_diagnostics,
            contract=activation_contract,
            dataset_artifact_count=len(dataset_paths),
            label_artifact_count=len(label_paths),
            negative_label_artifact_count=len(negative_label_paths),
        )
        if activation_readiness["activationReady"] is not True:
            raise CaptureActivationUnavailable(activation_readiness)
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
        for item in prepared:
            candidates = []
            candidates_by_hash = {}
            for raw_candidate in item["candidates"]:
                candidate = _portable_capture_candidate(raw_candidate)
                candidate_hash_value = str(candidate["candidate_hash"])
                candidates.append(candidate)
                candidates_by_hash[candidate_hash_value] = candidate
            transcript = _portable_capture_value(
                item["transcript"],
                context=f"dataset[{item['datasetId']}].transcript",
            )
            if not isinstance(transcript, dict):
                raise ValueError("portable capture transcript must be an object")
            positives = [
                copy.deepcopy(candidates_by_hash[candidate_hash_value])
                for candidate_hash_value in item["approvedCandidateHashes"]
            ]
            labels = []
            for candidate_hash_value in item["approvedCandidateHashes"]:
                event_hashes = item["labelEventHashesByCandidate"][
                    candidate_hash_value
                ]
                capture_labels = _portable_capture_value(
                    item["labelEventsByCandidate"][candidate_hash_value],
                    context=(
                        f"dataset[{item['datasetId']}].labels"
                        f"[{candidate_hash_value}].captureLabels"
                    ),
                )
                labels.append(
                    {
                        "labelId": _canonical_hash(
                            [item["datasetId"], candidate_hash_value, "approved"]
                        ),
                        "decision": "approved",
                        "candidateHash": candidate_hash_value,
                        "candidate": copy.deepcopy(
                            candidates_by_hash[candidate_hash_value]
                        ),
                        "matchScore": 1.0,
                        "matchStatus": "hash_bound",
                        "provenance": {
                            "captureDatasetHash": item["captureDatasetHash"],
                            "captureLabelHashes": event_hashes,
                            "captureLabels": capture_labels,
                        },
                    }
                )
            dataset_id = item["datasetId"]
            source_id = item["sourceId"]
            dataset_payload = {
                "schemaVersion": 1,
                "artifactType": "BudgetFriendlyReplayDatasetV2",
                "packVersion": PACK_VERSION,
                "datasetId": dataset_id,
                "sourceId": source_id,
                "candidates": candidates,
                "transcript": transcript,
                "captureProvenance": {
                    "sourceHash": item["sourceHash"],
                    "rankingManifestHash": item["rankingManifestHash"],
                    "captureDatasetHash": item["captureDatasetHash"],
                    "replayTranscriptManifestHash": item[
                        "replayTranscriptManifestHash"
                    ],
                    "transcriptHash": item["transcriptHash"],
                    "transcriptTimingHash": item["transcriptTimingHash"],
                    "engineSelectedCandidateHashes": item[
                        "engineSelectedCandidateHashes"
                    ],
                    "engineSelectionSemantics": item[
                        "engineSelectionSemantics"
                    ],
                },
            }
            labels_payload = {
                "schemaVersion": 1,
                "artifactType": "BudgetFriendlyReplayDatasetLabelsV2",
                "labelsVersion": LABELS_VERSION,
                "labelSemantics": HUMAN_LABEL_SEMANTICS,
                "datasetId": dataset_id,
                "sourceId": source_id,
                "positives": positives,
                "labels": labels,
            }
            sealed_dataset = _seal(dataset_payload)
            sealed_labels = _seal(labels_payload)
            dataset_path = dataset_dir / f"{dataset_id}.json"
            label_path = label_dir / f"{dataset_id}.json"
            dataset_path.write_text(
                json.dumps(
                    sealed_dataset,
                    indent=2,
                    sort_keys=True,
                    allow_nan=False,
                )
                + "\n",
                encoding="utf-8",
            )
            label_path.write_text(
                json.dumps(
                    sealed_labels,
                    indent=2,
                    sort_keys=True,
                    allow_nan=False,
                )
                + "\n",
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
                    "append_unmatched_positives": False,
                    "candidate_identity_key": "candidate_hash",
                    "label_binding_mode": EXACT_LABEL_BINDING_MODE,
                    "candidate_artifact_hash": sealed_dataset["contentHash"],
                    "positive_artifact_hash": sealed_labels["contentHash"],
                }
            )
            corpus_datasets.append(
                {
                    "datasetId": dataset_id,
                    "sourceId": source_id,
                    "candidateCount": len(candidates),
                    "transcriptWordCount": sum(
                        len(segment.get("words") or [])
                        for segment in item["transcript"]["segments"]
                    ),
                    "datasetHash": sealed_dataset["contentHash"],
                    "captureDatasetHash": item["captureDatasetHash"],
                }
            )
            label_datasets.append(
                {
                    "datasetId": dataset_id,
                    "approvedCount": len(positives),
                    "approvalEventCount": item["approvalEventCount"],
                    "labelsHash": sealed_labels["contentHash"],
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
                "labelBindingMode": EXACT_LABEL_BINDING_MODE,
                "corpusHash": corpus["contentHash"],
                "labelsHash": labels["contentHash"],
                "datasets": replay_specs,
            }
        )
        for name, artifact in (
            ("corpus.json", corpus),
            ("labels.json", labels),
            ("manifest.json", replay_manifest),
        ):
            (staging / name).write_text(
                json.dumps(
                    artifact,
                    indent=2,
                    sort_keys=True,
                    allow_nan=False,
                )
                + "\n",
                encoding="utf-8",
            )
        shutil.move(staging.as_posix(), output_dir.as_posix())
    report = {
        "outputDir": _relative(root, output_dir),
        "corpusHash": corpus["contentHash"],
        "labelsHash": labels["contentHash"],
        "manifestHash": replay_manifest["contentHash"],
        "datasetCount": len(corpus_datasets),
        "candidateCount": sum(item["candidateCount"] for item in corpus_datasets),
        "approvedLabelCount": sum(item["approvedCount"] for item in label_datasets),
        "approvalEventCount": sum(
            item["approvalEventCount"] for item in label_datasets
        ),
        "negativeLabelArtifactCount": len(negative_label_paths),
        "explicitHumanRejectionCount": ingestion_diagnostics[
            "explicitHumanRejectionCount"
        ],
        "rejectedCandidateCount": ingestion_diagnostics[
            "rejectedCandidateCount"
        ],
        "skippedOrphanDatasetCount": ingestion_diagnostics[
            "skippedOrphanDatasetCount"
        ],
        "skippedOrphanDatasetIds": ingestion_diagnostics[
            "skippedOrphanDatasetIds"
        ],
    }
    if activation_readiness is not None:
        report["captureReadinessHash"] = activation_readiness["contentHash"]
    return report


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
    parser.add_argument(
        "--capture-dir",
        nargs="?",
        const=Path(LOCAL_AUTORESEARCH_EVIDENCE_DIR),
        type=Path,
        help=(
            "Promote immutable datasets/labels from this approval evidence "
            "inbox instead of the legacy replay manifest. Omit the value to "
            "use LOCAL_AUTORESEARCH_EVIDENCE_DIR."
        ),
    )
    parser.add_argument("--preflight", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    root = Path(__file__).resolve().parents[1]
    contract = load_autoresearch_contract(args.contract)
    if args.capture_dir is not None:
        readiness = assess_capture_data_readiness(args.capture_dir, contract)
        if args.preflight or readiness["activationReady"] is not True:
            print(json.dumps(readiness, indent=2, sort_keys=True))
            return 0 if readiness["activationReady"] is True else 2
        dataset_paths, label_paths = discover_capture_paths(args.capture_dir)
        negative_label_paths = discover_negative_capture_paths(args.capture_dir)
        try:
            report = build_fixture_pack_from_captures(
                root=root,
                dataset_paths=dataset_paths,
                label_paths=label_paths,
                negative_label_paths=negative_label_paths,
                output_dir=args.output_dir,
                activation_contract=contract,
            )
        except CaptureActivationUnavailable as error:
            print(json.dumps(error.report, indent=2, sort_keys=True))
            return 2
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
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
