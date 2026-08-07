"""Offline V1-versus-V2 replay and acceptance evaluation.

The replay consumes already-paid candidate and transcript artifacts.  It never
calls an LLM, downloads media, analyzes frames, renders video, or mutates the
production policy.  Legacy candidates that predate HookGateV2 are evaluated
honestly: semantic closure can be replayed from exact timed words, while
missing Prompt-1 evidence remains ``review`` rather than being synthesized.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from copy import deepcopy
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .artifact_contracts import (
    FEED_STOP_V3_REPLAY_PROFILE_TUPLE,
    build_candidate_decision,
    build_replay_transcript_manifest,
    candidate_hash,
    normalized_candidate,
    validate_timed_transcript,
)
from .highlights import align_motivational_boundaries
from .hook_gate import HOOK_GATE_DECISION_VERSION
from .profiles import (
    MOTIVATIONAL_PODCAST,
    MOTIVATIONAL_TENSION_MICRO_V1,
    MOTIVATIONAL_TENSION_MICRO_V2,
)
from .ranker import rank_highlights, select_diverse_highlights


GROWTH_REPLAY_SCHEMA_VERSION = 1
GROWTH_REPLAY_POLICY_VERSION = "bf-growth-replay-v1.0.0"
DEFAULT_TOP_K = 3
REPLAY_PACK_MANIFEST_TYPE = "BudgetFriendlyReplayManifestV2"
REPLAY_PACK_DATASET_TYPE = "BudgetFriendlyReplayDatasetV2"
REPLAY_PACK_LABELS_TYPE = "BudgetFriendlyReplayDatasetLabelsV2"
REPLAY_PACK_CORPUS_TYPE = "BudgetFriendlyReplayCorpusV2"
REPLAY_PACK_LABEL_INDEX_TYPE = "BudgetFriendlyReplayLabelsV2"
REPLAY_PACK_VERSION = "bf-replay-pack-v2.0.0"
REPLAY_CORPUS_VERSION = "bf-replay-corpus-v2.0.0"
REPLAY_LABELS_VERSION = "bf-replay-labels-v2.0.0"
LEGACY_LABEL_BINDING_MODE = "legacy_interval_v1"
EXACT_LABEL_BINDING_MODE = "candidate_hash_exact_v1"
EXPLICIT_HUMAN_LABEL_SEMANTICS = "explicit_human_approval"
CAPTURE_LABEL_ARTIFACT_TYPE = "BudgetFriendlyReplayCaptureLabelV2"
CAPTURE_LABEL_VERSION = "bf-replay-capture-label-v2.0.0"
LABEL_BINDING_MODES = frozenset(
    {LEGACY_LABEL_BINDING_MODE, EXACT_LABEL_BINDING_MODE}
)


def _artifact_hash(value: object) -> str:
    if isinstance(value, dict):
        value = {key: item for key, item in value.items() if key != "contentHash"}
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValueError("replay artifact must be strict JSON") from error
    return hashlib.sha256(encoded).hexdigest()


def _sha256(value: object, field: str) -> str:
    normalized = str(value or "").strip().lower()
    if (
        len(normalized) != 64
        or any(character not in "0123456789abcdef" for character in normalized)
        or normalized == "0" * 64
    ):
        raise ValueError(f"{field} must be a sha256 hash")
    return normalized


def _verify_artifact(
    document: object,
    artifact_type: str,
    *,
    expected_hash: Optional[str] = None,
) -> Dict:
    if not isinstance(document, dict) or document.get("artifactType") != artifact_type:
        raise ValueError(f"expected {artifact_type}")
    declared = _sha256(document.get("contentHash"), f"{artifact_type}.contentHash")
    if declared != _artifact_hash(document):
        raise ValueError(f"{artifact_type} seal is invalid")
    if expected_hash is not None and declared != _sha256(
        expected_hash,
        f"expected {artifact_type} hash",
    ):
        raise ValueError(f"{artifact_type} hash does not match replay manifest")
    return document


def _resolve_pack_path(root: Path, value: object, field: str) -> Path:
    path = Path(str(value or ""))
    if not str(value or "").strip() or path.is_absolute():
        raise ValueError(f"{field} must be a repository-relative path")
    resolved_root = root.resolve()
    resolved = (resolved_root / path).resolve()
    try:
        resolved.relative_to(resolved_root)
    except ValueError as error:
        raise ValueError(f"{field} escapes the replay root") from error
    return resolved


def _looks_like_v2_spec(spec: object) -> bool:
    return isinstance(spec, dict) and any(
        field in spec
        for field in (
            "candidate_artifact_hash",
            "positive_artifact_hash",
            "candidate_identity_key",
            "label_binding_mode",
        )
    )


def _looks_like_v2_pack(manifest: Dict) -> bool:
    artifact_type = str(manifest.get("artifactType") or "")
    if artifact_type.startswith("BudgetFriendlyReplayManifest"):
        return True
    if any(
        field in manifest
        for field in (
            "contentHash",
            "packVersion",
            "corpusHash",
            "labelsHash",
            "labelBindingMode",
        )
    ):
        return True
    return any(_looks_like_v2_spec(spec) for spec in (manifest.get("datasets") or []))


def _validate_v2_spec_contract(
    spec: Dict,
    *,
    expected_binding_mode: Optional[str] = None,
    context: str,
) -> str:
    binding_mode = str(spec.get("label_binding_mode") or "").strip()
    if binding_mode not in LABEL_BINDING_MODES:
        raise ValueError(f"{context}: V2 label_binding_mode is invalid")
    if expected_binding_mode is not None and binding_mode != expected_binding_mode:
        raise ValueError(f"{context}: label binding mode differs from manifest")
    _sha256(spec.get("candidate_artifact_hash"), f"{context}.candidate_artifact_hash")
    _sha256(spec.get("positive_artifact_hash"), f"{context}.positive_artifact_hash")
    required_shape = {
        "candidate_key": "candidates",
        "transcript_key": "transcript",
        "positive_key": "positives",
    }
    for field, expected in required_shape.items():
        if spec.get(field) != expected:
            raise ValueError(f"{context}: V2 {field} must be {expected!r}")
    for field in ("candidate_path", "transcript_path", "positive_path"):
        if not str(spec.get(field) or "").strip():
            raise ValueError(f"{context}: V2 {field} is required")
    if spec.get("positive_all") is not True:
        raise ValueError(f"{context}: V2 positives must all be explicit labels")
    if binding_mode == EXACT_LABEL_BINDING_MODE:
        if spec.get("candidate_identity_key") != "candidate_hash":
            raise ValueError(f"{context}: exact labels require candidate_hash identity")
        if spec.get("append_unmatched_positives") is not False:
            raise ValueError(f"{context}: exact labels forbid appended positives")
    else:
        if str(spec.get("candidate_identity_key") or "").strip():
            raise ValueError(f"{context}: legacy interval labels forbid exact identity")
        if spec.get("append_unmatched_positives") is not True:
            raise ValueError(f"{context}: legacy interval labels must append unmatched positives")
    return binding_mode


def verify_replay_pack(
    manifest: Dict,
    root: Path,
    *,
    manifest_path: Optional[Path] = None,
) -> Dict:
    """Verify every V2 pack seal and cross-hash before replay or baseline."""
    if manifest.get("artifactType") != REPLAY_PACK_MANIFEST_TYPE:
        if _looks_like_v2_pack(manifest):
            raise ValueError("invalid or downgraded V2 replay pack manifest")
        return {"verified": False, "legacy": True}
    if manifest_path is None:
        raise ValueError("V2 replay pack verification requires manifest_path")
    _verify_artifact(manifest, REPLAY_PACK_MANIFEST_TYPE)
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("packVersion") != REPLAY_PACK_VERSION
    ):
        raise ValueError("unsupported V2 replay pack schema")
    binding_mode = str(manifest.get("labelBindingMode") or "").strip()
    if binding_mode not in LABEL_BINDING_MODES:
        raise ValueError("V2 replay pack labelBindingMode is invalid")
    corpus_hash = _sha256(manifest.get("corpusHash"), "replay manifest corpusHash")
    labels_hash = _sha256(manifest.get("labelsHash"), "replay manifest labelsHash")
    specs = manifest.get("datasets")
    if not isinstance(specs, list) or not specs:
        raise ValueError("sealed replay pack has no datasets")
    dataset_records = []
    seen_dataset_ids = set()
    seen_source_ids = set()
    seen_source_hashes = set()
    seen_capture_label_hashes = set()
    for index, spec in enumerate(specs):
        if not isinstance(spec, dict):
            raise ValueError("sealed replay pack dataset spec is invalid")
        _validate_v2_spec_contract(
            spec,
            expected_binding_mode=binding_mode,
            context=f"datasets[{index}]",
        )
        dataset_id = str(spec.get("id") or "").strip()
        source_id = str(spec.get("source_id") or "").strip()
        if not dataset_id or dataset_id in seen_dataset_ids:
            raise ValueError("sealed replay pack dataset ids are invalid")
        if not source_id or source_id in seen_source_ids:
            raise ValueError("sealed replay pack must contain unique sources")
        seen_dataset_ids.add(dataset_id)
        seen_source_ids.add(source_id)
        candidate_path = _resolve_pack_path(
            root,
            spec.get("candidate_path"),
            f"datasets[{index}].candidate_path",
        )
        transcript_path = _resolve_pack_path(
            root,
            spec.get("transcript_path"),
            f"datasets[{index}].transcript_path",
        )
        positive_path = _resolve_pack_path(
            root,
            spec.get("positive_path"),
            f"datasets[{index}].positive_path",
        )
        if transcript_path != candidate_path:
            raise ValueError("V2 replay transcript must be sealed with its dataset")
        dataset = _verify_artifact(
            _load_json(candidate_path),
            REPLAY_PACK_DATASET_TYPE,
            expected_hash=str(spec["candidate_artifact_hash"]),
        )
        labels = _verify_artifact(
            _load_json(positive_path),
            REPLAY_PACK_LABELS_TYPE,
            expected_hash=str(spec["positive_artifact_hash"]),
        )
        if (
            dataset.get("schemaVersion") != 1
            or dataset.get("packVersion") != REPLAY_PACK_VERSION
            or labels.get("schemaVersion") != 1
            or labels.get("labelsVersion") != REPLAY_LABELS_VERSION
        ):
            raise ValueError("unsupported sealed replay dataset schema")
        if (
            dataset.get("datasetId") != dataset_id
            or labels.get("datasetId") != dataset_id
            or dataset.get("sourceId") != source_id
            or labels.get("sourceId") != source_id
        ):
            raise ValueError("sealed replay dataset identity is stale")
        candidates = _nested(dataset, str(spec.get("candidate_key") or "candidates"))
        transcript = _nested(dataset, str(spec.get("transcript_key") or "transcript"))
        positives = _nested(labels, str(spec.get("positive_key") or "positives"))
        if not isinstance(candidates, list) or not isinstance(positives, list):
            raise ValueError("sealed replay candidate/positive payload is invalid")
        if not isinstance(transcript, dict) or not isinstance(
            transcript.get("segments"),
            list,
        ):
            raise ValueError("sealed replay transcript payload is invalid")
        if binding_mode == EXACT_LABEL_BINDING_MODE:
            exact_source_hash = _validate_exact_capture_provenance(
                dataset,
                candidates,
                transcript,
                context=f"datasets[{index}]",
            )
            if exact_source_hash in seen_source_hashes:
                raise ValueError(
                    "sealed exact replay pack must contain unique source hashes"
                )
            seen_source_hashes.add(exact_source_hash)
            _validate_exact_positive_bodies(
                candidates,
                positives,
                context=f"datasets[{index}]",
            )
            exact_label_hashes = _validate_exact_human_label_evidence(
                dataset,
                labels,
                candidates,
                positives,
                transcript=transcript,
                context=f"datasets[{index}]",
            )
            if seen_capture_label_hashes.intersection(exact_label_hashes):
                raise ValueError(
                    "one capture approval event cannot be reused across replay datasets"
                )
            seen_capture_label_hashes.update(exact_label_hashes)
        dataset_records.append(
            {
                "datasetId": dataset_id,
                "sourceId": source_id,
                "candidateCount": len(candidates),
                "approvedCount": len(positives),
                "datasetHash": dataset["contentHash"],
                "labelsHash": labels["contentHash"],
            }
        )

    resolved_manifest = manifest_path.resolve()
    try:
        resolved_manifest.relative_to(root.resolve())
    except ValueError as error:
        raise ValueError("replay manifest escapes the replay root") from error
    on_disk_manifest = _verify_artifact(
        _load_json(resolved_manifest),
        REPLAY_PACK_MANIFEST_TYPE,
    )
    if on_disk_manifest != manifest:
        raise ValueError("replay manifest path does not match supplied manifest")
    corpus = _verify_artifact(
        _load_json(resolved_manifest.parent / "corpus.json"),
        REPLAY_PACK_CORPUS_TYPE,
        expected_hash=corpus_hash,
    )
    label_index = _verify_artifact(
        _load_json(resolved_manifest.parent / "labels.json"),
        REPLAY_PACK_LABEL_INDEX_TYPE,
        expected_hash=labels_hash,
    )
    if (
        corpus.get("schemaVersion") != 1
        or corpus.get("corpusVersion") != REPLAY_CORPUS_VERSION
        or label_index.get("schemaVersion") != 1
        or label_index.get("labelsVersion") != REPLAY_LABELS_VERSION
    ):
        raise ValueError("unsupported replay pack index schema")
    corpus_summaries = {
        str(item.get("datasetId")): item
        for item in (corpus.get("datasets") or [])
        if isinstance(item, dict)
    }
    label_summaries = {
        str(item.get("datasetId")): item
        for item in (label_index.get("datasets") or [])
        if isinstance(item, dict)
    }
    if (
        corpus.get("datasetCount") != len(dataset_records)
        or len(corpus_summaries) != len(dataset_records)
        or len(label_summaries) != len(dataset_records)
    ):
        raise ValueError("replay pack index counts are stale")
    for record in dataset_records:
        corpus_summary = corpus_summaries.get(record["datasetId"], {})
        label_summary = label_summaries.get(record["datasetId"], {})
        if (
            corpus_summary.get("sourceId") != record["sourceId"]
            or corpus_summary.get("candidateCount") != record["candidateCount"]
            or corpus_summary.get("datasetHash") != record["datasetHash"]
            or label_summary.get("approvedCount") != record["approvedCount"]
            or label_summary.get("labelsHash") != record["labelsHash"]
        ):
            raise ValueError("replay pack indexes do not match sealed datasets")
    return {
        "verified": True,
        "legacy": False,
        "datasetCount": len(dataset_records),
        "sourceCount": len(seen_source_ids),
        "candidateCount": sum(item["candidateCount"] for item in dataset_records),
        "approvedCount": sum(item["approvedCount"] for item in dataset_records),
    }


def _number(value: object, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _ratio(numerator: int, denominator: int) -> Optional[float]:
    if denominator <= 0:
        return None
    return round(float(numerator) / float(denominator), 4)


def _nested(document: object, key: Optional[str]) -> object:
    value = document
    if not key:
        return value
    for part in str(key).split("."):
        if not isinstance(value, dict) or part not in value:
            raise KeyError(f"artifact has no key path {key!r}")
        value = value[part]
    return value


def _load_json(path: Path) -> object:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _resolve_path(root: Path, value: str) -> Path:
    path = Path(str(value))
    return path if path.is_absolute() else root / path


def _candidate_interval(candidate: Dict) -> Tuple[float, float]:
    start = _number(
        candidate.get("speech_start_time", candidate.get("start_time")),
        -1.0,
    )
    end = _number(
        candidate.get("speech_end_time", candidate.get("end_time")),
        -1.0,
    )
    return start, end


def _interval_match_score(left: Dict, right: Dict) -> float:
    left_start, left_end = _candidate_interval(left)
    right_start, right_end = _candidate_interval(right)
    if min(left_start, right_start) < 0.0:
        return 0.0
    overlap = max(0.0, min(left_end, right_end) - max(left_start, right_start))
    shorter = min(
        max(0.001, left_end - left_start),
        max(0.001, right_end - right_start),
    )
    overlap_ratio = overlap / shorter
    left_title = str(left.get("title") or "").strip().casefold()
    right_title = str(right.get("title") or "").strip().casefold()
    title_bonus = 0.10 if left_title and left_title == right_title else 0.0
    return min(1.0, overlap_ratio + title_bonus)


def _dedupe_candidates(candidates: Iterable[Dict]) -> List[Dict]:
    kept: List[Dict] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        item = deepcopy(candidate)
        if any(_interval_match_score(item, existing) >= 0.97 for existing in kept):
            continue
        kept.append(item)
    return kept


def _mark_human_positives(
    candidates: List[Dict],
    positives: Sequence[Dict],
    append_unmatched: bool = True,
) -> Tuple[List[Dict], List[Dict]]:
    result = [dict(candidate) for candidate in candidates]
    unmatched: List[Dict] = []
    for item in result:
        item["_replay_human_positive"] = False
        item["_replay_positive_match_score"] = 0.0
    for positive in positives:
        if not isinstance(positive, dict):
            continue
        scored = [
            (_interval_match_score(candidate, positive), index)
            for index, candidate in enumerate(result)
        ]
        score, index = max(scored, default=(0.0, -1))
        if index >= 0 and score >= 0.60:
            result[index]["_replay_human_positive"] = True
            result[index]["_replay_positive_match_score"] = round(score, 4)
            continue
        if not append_unmatched:
            unmatched.append(deepcopy(positive))
            continue
        appended = deepcopy(positive)
        appended["_replay_human_positive"] = True
        appended["_replay_positive_match_score"] = 1.0
        appended["_replay_positive_only"] = True
        result.append(appended)
    return result, unmatched


def _identity_value(candidate: Dict, key: str, context: str) -> str:
    value = str(candidate.get(key) or "").strip().lower()
    if not value:
        raise ValueError(f"{context}: candidate identity {key!r} is missing")
    if key == "candidate_hash" and (
        len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"{context}: candidate_hash is invalid")
    return value


def _validate_exact_positive_bodies(
    candidates: Sequence[Dict],
    positives: Sequence[Dict],
    *,
    context: str,
) -> None:
    """Require each hash-bound positive to be the exact captured candidate."""
    candidate_by_identity: Dict[str, Dict] = {}
    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise ValueError(f"{context}: candidate record must be an object")
        identity = _identity_value(candidate, "candidate_hash", context)
        if identity in candidate_by_identity:
            raise ValueError(f"{context}: duplicate candidate identity {identity}")
        candidate_by_identity[identity] = candidate
    positive_identities = set()
    for positive in positives:
        if not isinstance(positive, dict):
            raise ValueError(f"{context}: positive record must be an object")
        identity = _identity_value(positive, "candidate_hash", context)
        if identity in positive_identities:
            raise ValueError(f"{context}: duplicate positive identity {identity}")
        positive_identities.add(identity)
        candidate = candidate_by_identity.get(identity)
        if candidate is None:
            raise ValueError(
                f"{context}: explicit positive identity is absent from candidate universe"
            )
        if positive != candidate:
            raise ValueError(
                f"{context}: positive candidate body differs from candidate universe"
            )


def _validate_exact_human_label_evidence(
    dataset: Dict,
    labels_document: Dict,
    candidates: Sequence[Dict],
    positives: Sequence[Dict],
    *,
    transcript: Dict,
    context: str,
) -> set[str]:
    """Prove every exact positive has one explicit, hash-bound approval record."""
    if not positives:
        raise ValueError(
            f"{context}: exact replay datasets require a human-approved positive"
        )
    if labels_document.get("labelSemantics") != EXPLICIT_HUMAN_LABEL_SEMANTICS:
        raise ValueError(
            f"{context}: exact labels require explicit human-approval semantics"
        )
    detailed_labels = labels_document.get("labels")
    if not isinstance(detailed_labels, list) or len(detailed_labels) != len(positives):
        raise ValueError(
            f"{context}: exact positives require one detailed approval label each"
        )

    capture_provenance = dataset.get("captureProvenance")
    if not isinstance(capture_provenance, dict):
        raise ValueError(f"{context}: exact replay dataset lacks capture provenance")
    capture_dataset_hash = _sha256(
        capture_provenance.get("captureDatasetHash"),
        f"{context}.captureDatasetHash",
    )
    source_hash = _sha256(
        capture_provenance.get("sourceHash"),
        f"{context}.sourceHash",
    )
    ranking_hash = _sha256(
        capture_provenance.get("rankingManifestHash"),
        f"{context}.rankingManifestHash",
    )
    replay_transcript_timing_hash = _sha256(
        capture_provenance.get("transcriptTimingHash"),
        f"{context}.transcriptTimingHash",
    )
    observed_capture_label_hashes: set[str] = set()

    for index, (positive, label) in enumerate(zip(positives, detailed_labels)):
        label_context = f"{context}.labels[{index}]"
        if not isinstance(label, dict):
            raise ValueError(f"{label_context}: approval label must be an object")
        identity = _identity_value(positive, "candidate_hash", context)
        if (
            label.get("decision") != "approved"
            or label.get("matchStatus") != "hash_bound"
            or label.get("candidateHash") != identity
            or label.get("candidate") != positive
        ):
            raise ValueError(
                f"{label_context}: approval label is not bound to its exact positive"
            )
        match_score = label.get("matchScore")
        if (
            isinstance(match_score, bool)
            or not isinstance(match_score, (int, float))
            or float(match_score) != 1.0
        ):
            raise ValueError(f"{label_context}: exact approval matchScore must be 1.0")
        expected_label_id = _artifact_hash(
            [dataset.get("datasetId"), identity, "approved"]
        )
        if label.get("labelId") != expected_label_id:
            raise ValueError(f"{label_context}: approval labelId is stale")
        provenance = label.get("provenance")
        if not isinstance(provenance, dict):
            raise ValueError(f"{label_context}: approval provenance is missing")
        if _sha256(
            provenance.get("captureDatasetHash"),
            f"{label_context}.captureDatasetHash",
        ) != capture_dataset_hash:
            raise ValueError(
                f"{label_context}: approval references another capture dataset"
            )
        event_hashes = provenance.get("captureLabelHashes")
        if not isinstance(event_hashes, list) or not event_hashes:
            raise ValueError(
                f"{label_context}: approval requires a capture label event"
            )
        normalized_event_hashes = [
            _sha256(value, f"{label_context}.captureLabelHashes")
            for value in event_hashes
        ]
        if (
            len(normalized_event_hashes) != len(set(normalized_event_hashes))
            or normalized_event_hashes != sorted(normalized_event_hashes)
        ):
            raise ValueError(
                f"{label_context}: capture label event hashes must be unique and sorted"
            )
        capture_labels = provenance.get("captureLabels")
        if not isinstance(capture_labels, list) or len(capture_labels) != len(
            normalized_event_hashes
        ):
            raise ValueError(
                f"{label_context}: capture label event bodies are incomplete"
            )
        verified_event_hashes = []
        for event_index, (event, expected_event_hash) in enumerate(
            zip(capture_labels, normalized_event_hashes)
        ):
            event_context = f"{label_context}.captureLabels[{event_index}]"
            capture_label = _verify_artifact(
                event,
                CAPTURE_LABEL_ARTIFACT_TYPE,
                expected_hash=expected_event_hash,
            )
            if (
                capture_label.get("schemaVersion") != 1
                or capture_label.get("labelVersion") != CAPTURE_LABEL_VERSION
                or capture_label.get("decision") != "approved"
                or capture_label.get("labelSemantics")
                != EXPLICIT_HUMAN_LABEL_SEMANTICS
                or capture_label.get("datasetId") != ranking_hash
                or capture_label.get("datasetHash") != capture_dataset_hash
                or capture_label.get("rankingManifestHash") != ranking_hash
                or capture_label.get("sourceHash") != source_hash
                or capture_label.get("candidateHash") != identity
            ):
                raise ValueError(
                    f"{event_context}: capture approval binding is invalid"
                )
            decision_hash = _sha256(
                capture_label.get("candidateDecisionHash"),
                f"{event_context}.candidateDecisionHash",
            )
            decision = _verify_artifact(
                capture_label.get("candidateDecision"),
                "CandidateDecision",
                expected_hash=decision_hash,
            )
            try:
                candidate_input = {
                    **decision.get("candidate"),
                    "candidate_hash": identity,
                }
                if decision.get("hookGateReport") is not None:
                    candidate_input["hookGateReport"] = decision.get(
                        "hookGateReport"
                    )
                rebuilt_decision = build_candidate_decision(
                    candidate_input,
                    source_hash,
                    reviewer=str(decision.get("reviewer") or ""),
                    decided_at=str(decision.get("decidedAt") or ""),
                    ranking_manifest_hash=ranking_hash,
                    notes=str(decision.get("notes") or ""),
                    replay_transcript=transcript,
                    transcript_timing_hash=replay_transcript_timing_hash,
                )
            except (TypeError, ValueError) as error:
                raise ValueError(
                    f"{event_context}: CandidateDecision is not canonical"
                ) from error
            decision_profile = (
                str(decision.get("contentProfile") or "").strip().lower(),
                str(decision.get("selectionProfile") or "").strip().lower(),
                str(decision.get("renderProfile") or "").strip().lower(),
                str(decision.get("formatProfile") or "").strip().lower(),
            )
            if (
                rebuilt_decision != decision
                or decision.get("schemaVersion") != 1
                or decision.get("decision") != "approved"
                or decision.get("rankingManifestHash") != ranking_hash
                or decision.get("sourceHash") != source_hash
                or decision.get("candidateHash") != identity
                or decision.get("candidate") != normalized_candidate(positive)
                or candidate_hash(decision.get("candidate"), source_hash) != identity
                or (
                    decision_profile == FEED_STOP_V3_REPLAY_PROFILE_TUPLE
                    and decision.get("hookGateReport")
                    != positive.get("hookGateReport")
                )
                or capture_label.get("reviewer") != decision.get("reviewer")
                or capture_label.get("decidedAt") != decision.get("decidedAt")
                or capture_label.get("notes") != decision.get("notes", "")
            ):
                raise ValueError(
                    f"{event_context}: CandidateDecision binding is invalid"
                )
            approved_rank = capture_label.get("approvedRank")
            candidate_rank = positive.get(
                "selection_rank",
                positive.get("output_rank"),
            )
            if (
                isinstance(approved_rank, bool)
                or not isinstance(approved_rank, int)
                or approved_rank < 1
                or isinstance(candidate_rank, bool)
                or not isinstance(candidate_rank, int)
                or approved_rank != candidate_rank
            ):
                raise ValueError(
                    f"{event_context}: approved rank is not exactly candidate-bound"
                )
            verified_event_hashes.append(str(capture_label["contentHash"]))
        if verified_event_hashes != normalized_event_hashes:
            raise ValueError(f"{label_context}: capture label hashes are stale")
        reused = observed_capture_label_hashes.intersection(verified_event_hashes)
        if reused:
            raise ValueError(
                f"{label_context}: one approval event cannot label multiple positives"
            )
        observed_capture_label_hashes.update(verified_event_hashes)
    return observed_capture_label_hashes


def _validate_exact_capture_provenance(
    dataset: Dict,
    candidates: Sequence[Dict],
    transcript: Dict,
    *,
    context: str,
) -> str:
    """Recompute the exact identities used by source-coverage and label metrics."""
    provenance = dataset.get("captureProvenance")
    if not isinstance(provenance, dict):
        raise ValueError(f"{context}: exact replay dataset lacks capture provenance")
    source_hash = _sha256(
        provenance.get("sourceHash"),
        f"{context}.sourceHash",
    )
    ranking_hash = _sha256(
        provenance.get("rankingManifestHash"),
        f"{context}.rankingManifestHash",
    )
    _sha256(
        provenance.get("captureDatasetHash"),
        f"{context}.captureDatasetHash",
    )
    if dataset.get("datasetId") != ranking_hash:
        raise ValueError(f"{context}: datasetId is not ranking-manifest bound")

    exact_transcript = validate_timed_transcript(
        transcript,
        require_timed_words=True,
    )
    transcript_manifest = build_replay_transcript_manifest(
        exact_transcript,
        source_hash,
    )
    expected_transcript_hashes = {
        "replayTranscriptManifestHash": transcript_manifest["contentHash"],
        "transcriptHash": transcript_manifest["transcriptHash"],
        "transcriptTimingHash": transcript_manifest["transcriptTimingHash"],
    }
    for field, expected in expected_transcript_hashes.items():
        if _sha256(provenance.get(field), f"{context}.{field}") != expected:
            raise ValueError(f"{context}: {field} is not bound to the transcript")

    candidate_hashes = []
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            raise ValueError(f"{context}: candidate record must be an object")
        declared = _identity_value(candidate, "candidate_hash", context)
        try:
            actual = candidate_hash(candidate, source_hash)
        except (TypeError, ValueError) as error:
            raise ValueError(
                f"{context}: candidate[{index}] identity cannot be recomputed"
            ) from error
        if declared != actual:
            raise ValueError(f"{context}: candidate[{index}] hash is stale")
        candidate_hashes.append(declared)

    selected = provenance.get("engineSelectedCandidateHashes")
    if (
        not isinstance(selected, list)
        or len(selected) != len(set(selected))
        or any(value not in candidate_hashes for value in selected)
        or selected != [value for value in candidate_hashes if value in selected]
    ):
        raise ValueError(f"{context}: engine-selected candidate provenance is invalid")
    if provenance.get("engineSelectionSemantics") != "unknown_not_human_label":
        raise ValueError(f"{context}: engine selections cannot be human labels")
    return source_hash


def _mark_human_positives_by_identity(
    candidates: Sequence[Dict],
    positives: Sequence[Dict],
    *,
    identity_key: str,
    context: str,
) -> Tuple[List[Dict], List[Dict]]:
    """Bind positives exactly; never dedupe or fall back to interval overlap."""
    _validate_exact_positive_bodies(candidates, positives, context=context)
    result = []
    indexes: Dict[str, int] = {}
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        item = deepcopy(candidate)
        identity = _identity_value(item, identity_key, context)
        if identity in indexes:
            raise ValueError(f"{context}: duplicate candidate identity {identity}")
        indexes[identity] = len(result)
        item["_replay_human_positive"] = False
        item["_replay_positive_match_score"] = 0.0
        result.append(item)

    positive_identities = set()
    unmatched = []
    for positive in positives:
        if not isinstance(positive, dict):
            continue
        identity = _identity_value(positive, identity_key, context)
        if identity in positive_identities:
            raise ValueError(f"{context}: duplicate positive identity {identity}")
        positive_identities.add(identity)
        index = indexes.get(identity)
        if index is None:
            unmatched.append(deepcopy(positive))
            continue
        result[index]["_replay_human_positive"] = True
        result[index]["_replay_positive_match_score"] = 1.0
        result[index]["_replay_positive_match_kind"] = "exact_identity"
    if unmatched:
        raise ValueError(
            f"{context}: explicit positive identity is absent from candidate universe"
        )
    return result, []


def load_replay_dataset(spec: Dict, root: Path) -> Dict:
    """Load one manifest entry without invoking external services."""
    binding_mode: Optional[str] = None
    if _looks_like_v2_spec(spec):
        binding_mode = _validate_v2_spec_contract(
            spec,
            context=str(spec.get("id") or "replay dataset"),
        )
    candidate_path = (
        _resolve_pack_path(root, spec.get("candidate_path"), "candidate_path")
        if binding_mode is not None
        else _resolve_path(root, str(spec["candidate_path"]))
    )
    candidate_document = _load_json(candidate_path)
    if binding_mode is not None:
        candidate_document = _verify_artifact(
            candidate_document,
            REPLAY_PACK_DATASET_TYPE,
            expected_hash=str(spec["candidate_artifact_hash"]),
        )
    candidate_value = _nested(
        candidate_document,
        str(spec.get("candidate_key") or "candidates"),
    )
    if not isinstance(candidate_value, list):
        raise TypeError(f"{candidate_path}: candidate payload must be a list")

    transcript_value = spec.get("transcript_path") or spec["candidate_path"]
    transcript_path = (
        _resolve_pack_path(root, transcript_value, "transcript_path")
        if binding_mode is not None
        else _resolve_path(root, str(transcript_value))
    )
    transcript_document = (
        candidate_document
        if transcript_path == candidate_path
        else _load_json(transcript_path)
    )
    transcript = _nested(
        transcript_document,
        str(spec.get("transcript_key") or ""),
    )
    if not isinstance(transcript, dict) or not isinstance(
        transcript.get("segments"),
        list,
    ):
        raise TypeError(f"{transcript_path}: transcript must contain segments")

    positives: List[Dict] = []
    positive_document: object = None
    positive_path_value = spec.get("positive_path")
    if positive_path_value:
        positive_path = (
            _resolve_pack_path(root, positive_path_value, "positive_path")
            if binding_mode is not None
            else _resolve_path(root, str(positive_path_value))
        )
        positive_document = (
            candidate_document
            if positive_path == candidate_path
            else _load_json(positive_path)
        )
        if binding_mode is not None:
            positive_document = _verify_artifact(
                positive_document,
                REPLAY_PACK_LABELS_TYPE,
                expected_hash=str(spec["positive_artifact_hash"]),
            )
        positive_value = _nested(
            positive_document,
            str(spec.get("positive_key") or "candidates"),
        )
        if not isinstance(positive_value, list):
            raise TypeError(f"{positive_path}: positive payload must be a list")
        positive_candidates = [
            dict(value)
            for value in positive_value
            if isinstance(value, dict)
        ]
        if spec.get("positive_all") is True:
            positives = positive_candidates
        else:
            selected_positives = [
                value
                for value in positive_candidates
                if value.get("selected_for_render") is True
                or value.get("output_rank") is not None
            ]
            if positive_candidates and not selected_positives:
                raise ValueError(
                    f"{positive_path}: no explicit selected positives; "
                    "set positive_all=true only when every item is a label"
                )
            positives = selected_positives
    else:
        positives = [
            dict(value)
            for value in candidate_value
            if isinstance(value, dict)
            and (
                value.get("selected_for_render") is True
                or value.get("output_rank") is not None
            )
        ]

    dataset_id = str(spec.get("id") or candidate_path.stem)
    if binding_mode == EXACT_LABEL_BINDING_MODE:
        if not isinstance(candidate_document, dict) or not isinstance(
            positive_document,
            dict,
        ):
            raise ValueError(f"{dataset_id}: exact replay artifacts are invalid")
        _validate_exact_capture_provenance(
            candidate_document,
            candidate_value,
            transcript,
            context=dataset_id,
        )
        _validate_exact_human_label_evidence(
            candidate_document,
            positive_document,
            candidate_value,
            positives,
            transcript=transcript,
            context=dataset_id,
        )
        candidates, unmatched_positives = _mark_human_positives_by_identity(
            candidate_value,
            positives,
            identity_key="candidate_hash",
            context=dataset_id,
        )
    else:
        candidates, unmatched_positives = _mark_human_positives(
            _dedupe_candidates(candidate_value),
            positives,
            append_unmatched=bool(
                spec.get("append_unmatched_positives", True)
            ),
        )
    for index, candidate in enumerate(candidates):
        candidate["_replay_id"] = f"{dataset_id}:{index:03d}"
        candidate["_replay_dataset_id"] = dataset_id
        candidate["_replay_original_selected"] = bool(
            candidate.get("selected_for_render") is True
            or candidate.get("output_rank") is not None
            or candidate.get("_replay_human_positive")
        )
        candidate["_replay_original_eligible"] = not bool(
            candidate.get("rejected")
        )
        candidate["_replay_original_rejection_reasons"] = list(
            candidate.get("rejection_reasons") or []
        )
        candidate["_replay_original_score"] = _number(
            candidate.get("final_score", candidate.get("score")),
            0.0,
        )
    return {
        "id": dataset_id,
        "source_id": str(spec.get("source_id") or dataset_id),
        "candidate_path": str(candidate_path),
        "transcript_path": str(transcript_path),
        "transcript": transcript,
        "candidates": candidates,
        "positive_label_count": len(positives),
        "unmatched_positive_labels": unmatched_positives,
    }


def _prepare_profile_candidates(
    candidates: Sequence[Dict],
    transcript: Dict,
    selection_profile: str,
) -> List[Dict]:
    prepared = []
    for candidate in candidates:
        item = deepcopy(candidate)
        item["selection_profile"] = selection_profile
        item["selection_policy_version"] = selection_profile
        prepared.append(item)
    return align_motivational_boundaries(prepared, transcript)


def _rank_by_id(
    candidates: Sequence[Dict],
    transcript: Dict,
    selection_profile: str,
) -> Tuple[List[Dict], Dict[str, Dict]]:
    ranked = rank_highlights(
        list(candidates),
        transcript,
        content_type=MOTIVATIONAL_PODCAST,
        selection_profile=selection_profile,
    )
    return ranked, {
        str(item.get("_replay_id")): item
        for item in ranked
        if item.get("_replay_id")
    }


def _closure_shadow_candidates(candidates: Sequence[Dict]) -> List[Dict]:
    """Hold HookGate constant to isolate Stage-2 closure/duration behavior."""
    shadow = []
    for candidate in candidates:
        item = deepcopy(candidate)
        item.update(
            {
                "hook_gate_status": "pass",
                "hook_gate_eligible": True,
                "hook_gate_decision_version": HOOK_GATE_DECISION_VERSION,
                "hook_gate_reject_reasons": [],
                "hook_gate_review_reasons": [],
                "hook_gate_deterministic_reasons": [],
            }
        )
        shadow.append(item)
    return shadow


def _top_ids(ranked: Sequence[Dict], limit: int) -> List[str]:
    selected = select_diverse_highlights(
        [dict(item) for item in ranked],
        limit=max(1, int(limit)),
    )
    return [
        str(item["_replay_id"])
        for item in selected
        if item.get("_replay_id")
    ]


def _status_counts(candidates: Sequence[Dict], field: str) -> Dict[str, int]:
    counter = Counter(
        str(candidate.get(field) or "missing").strip().lower()
        for candidate in candidates
    )
    return dict(sorted(counter.items()))


def _reason_counts(
    candidates: Sequence[Dict],
    fields: Sequence[str],
) -> Dict[str, int]:
    counter: Counter = Counter()
    for candidate in candidates:
        for field in fields:
            values = candidate.get(field)
            if not isinstance(values, list):
                continue
            counter.update(
                str(value).strip()
                for value in values
                if str(value).strip()
            )
    return dict(sorted(counter.items(), key=lambda pair: (-pair[1], pair[0])))


def _nested_reason_counts(
    records: Sequence[Dict],
    section: str,
) -> Dict[str, int]:
    counter: Counter = Counter()
    for record in records:
        value = record.get(section)
        if not isinstance(value, dict):
            continue
        reasons = value.get("reasons")
        if not isinstance(reasons, list):
            continue
        counter.update(
            str(reason).strip()
            for reason in reasons
            if str(reason).strip()
        )
    return dict(sorted(counter.items(), key=lambda pair: (-pair[1], pair[0])))


def evaluate_replay_dataset(dataset: Dict, top_k: int = DEFAULT_TOP_K) -> Dict:
    transcript = dataset["transcript"]
    original = list(dataset["candidates"])
    v1_candidates = _prepare_profile_candidates(
        original,
        transcript,
        MOTIVATIONAL_TENSION_MICRO_V1,
    )
    v2_candidates = _prepare_profile_candidates(
        original,
        transcript,
        MOTIVATIONAL_TENSION_MICRO_V2,
    )

    v1_ranked, v1_by_id = _rank_by_id(
        v1_candidates,
        transcript,
        MOTIVATIONAL_TENSION_MICRO_V1,
    )
    full_v2_ranked, full_v2_by_id = _rank_by_id(
        v2_candidates,
        transcript,
        MOTIVATIONAL_TENSION_MICRO_V2,
    )
    closure_shadow_ranked, closure_shadow_by_id = _rank_by_id(
        _closure_shadow_candidates(v2_candidates),
        transcript,
        MOTIVATIONAL_TENSION_MICRO_V2,
    )

    v1_top = _top_ids(v1_ranked, top_k)
    full_v2_top = _top_ids(full_v2_ranked, top_k)
    closure_shadow_top = _top_ids(closure_shadow_ranked, top_k)
    human_positive_ids = {
        str(candidate["_replay_id"])
        for candidate in original
        if candidate.get("_replay_human_positive")
    }

    evaluated_records = []
    for source in original:
        replay_id = str(source["_replay_id"])
        v1 = v1_by_id.get(replay_id, {})
        full_v2 = full_v2_by_id.get(replay_id, {})
        closure_shadow = closure_shadow_by_id.get(replay_id, {})
        aligned_v2 = next(
            (
                item
                for item in v2_candidates
                if str(item.get("_replay_id")) == replay_id
            ),
            {},
        )
        start, end = _candidate_interval(aligned_v2 or source)
        hook_evidence_complete = bool(
            source.get("hook_gate_response_complete")
        )
        hook_status = (
            str(aligned_v2.get("hook_gate_status") or "missing")
            if hook_evidence_complete
            else "not_evaluable"
        )
        hook_reasons = (
            list(
                aligned_v2.get("hook_gate_deterministic_reasons")
                or []
            )
            if hook_evidence_complete
            else ["legacy_hook_prompt_evidence_missing"]
        )
        full_v2_reasons = list(
            full_v2.get("rejection_reasons") or []
        )
        if not hook_evidence_complete:
            full_v2_reasons = [
                reason
                for reason in full_v2_reasons
                if not str(reason).startswith("hook_gate_")
            ]
            full_v2_reasons.append("legacy_hook_prompt_evidence_missing")
        evaluated_records.append(
            {
                "replay_id": replay_id,
                "title": str(source.get("title") or ""),
                "speech_start_time": round(start, 3),
                "speech_end_time": round(end, 3),
                "speech_duration_seconds": round(max(0.0, end - start), 3),
                "human_positive": bool(source.get("_replay_human_positive")),
                "human_positive_appended": bool(
                    source.get("_replay_positive_only")
                ),
                "human_positive_match_score": round(
                    _number(source.get("_replay_positive_match_score")),
                    4,
                ),
                "original_selected": bool(
                    source.get("_replay_original_selected")
                ),
                "original_eligible": bool(
                    source.get("_replay_original_eligible")
                ),
                "original_score": round(
                    _number(source.get("_replay_original_score")),
                    3,
                ),
                "v1_replay": {
                    "eligible": not bool(v1.get("rejected", True)),
                    "score": round(_number(v1.get("final_score")), 3),
                    "reasons": list(v1.get("rejection_reasons") or []),
                    "top_k": replay_id in v1_top,
                },
                "hook_gate": {
                    "evidence_complete": hook_evidence_complete,
                    "status": hook_status,
                    "reasons": hook_reasons,
                },
                "semantic_closure": {
                    "status": str(
                        aligned_v2.get("semantic_closure_status") or "missing"
                    ),
                    "eligible": bool(
                        aligned_v2.get("semantic_closure_eligible")
                    ),
                    "reasons": list(
                        aligned_v2.get(
                            "semantic_closure_deterministic_reasons"
                        )
                        or []
                    ),
                    "duration_bucket": aligned_v2.get(
                        "semantic_closure_duration_bucket"
                    ),
                    "duration_fit_score": aligned_v2.get(
                        "semantic_closure_duration_fit_score"
                    ),
                    "planned_natural_tail_seconds": aligned_v2.get(
                        "planned_natural_tail_seconds"
                    ),
                },
                "full_v2": {
                    "eligible": not bool(full_v2.get("rejected", True)),
                    "score": round(_number(full_v2.get("final_score")), 3),
                    "reasons": full_v2_reasons,
                    "top_k": replay_id in full_v2_top,
                },
                "closure_shadow": {
                    "eligible": not bool(
                        closure_shadow.get("rejected", True)
                    ),
                    "score": round(
                        _number(closure_shadow.get("final_score")),
                        3,
                    ),
                    "reasons": list(
                        closure_shadow.get("rejection_reasons") or []
                    ),
                    "top_k": replay_id in closure_shadow_top,
                },
            }
        )

    candidate_count = len(evaluated_records)
    positive_count = int(
        dataset.get("positive_label_count", len(human_positive_ids))
    )
    appended_positive_count = sum(
        record["human_positive"] and record["human_positive_appended"]
        for record in evaluated_records
    )
    unmatched_positive_labels = list(
        dataset.get("unmatched_positive_labels") or []
    )
    unmatched_positive_count = len(unmatched_positive_labels)
    matched_positive_count = max(
        0,
        positive_count
        - appended_positive_count
        - unmatched_positive_count,
    )
    hook_evaluable_count = sum(
        record["hook_gate"]["evidence_complete"]
        for record in evaluated_records
    )
    closure_pass_count = sum(
        record["semantic_closure"]["status"] == "pass"
        for record in evaluated_records
    )
    closure_positive_pass_count = sum(
        record["human_positive"]
        and record["semantic_closure"]["status"] == "pass"
        for record in evaluated_records
    )
    full_v2_positive_pass_count = sum(
        record["human_positive"] and record["full_v2"]["eligible"]
        for record in evaluated_records
    )
    v1_positive_pass_count = sum(
        record["human_positive"] and record["v1_replay"]["eligible"]
        for record in evaluated_records
    )
    closure_shadow_top_positive_count = len(
        set(closure_shadow_top) & human_positive_ids
    )
    planned_top_k_slots = max(1, int(top_k))
    potential_false_negatives = [
        {
            "replay_id": record["replay_id"],
            "title": record["title"],
            "status": record["semantic_closure"]["status"],
            "reasons": record["semantic_closure"]["reasons"],
        }
        for record in evaluated_records
        if record["human_positive"]
        and record["semantic_closure"]["status"] != "pass"
    ]
    potential_false_negatives.extend(
        {
            "replay_id": None,
            "title": str(label.get("title") or ""),
            "status": "not_discovered",
            "reasons": ["human_positive_interval_not_discovered"],
            "speech_start_time": _candidate_interval(label)[0],
            "speech_end_time": _candidate_interval(label)[1],
        }
        for label in unmatched_positive_labels
        if isinstance(label, dict)
    )
    return {
        "dataset_id": dataset["id"],
        "source_id": dataset["source_id"],
        "candidate_path": dataset["candidate_path"],
        "transcript_path": dataset["transcript_path"],
        "metrics": {
            "candidate_count": candidate_count,
            "human_positive_count": positive_count,
            "human_positive_matched_count": matched_positive_count,
            "human_positive_appended_count": appended_positive_count,
            "human_positive_unmatched_count": unmatched_positive_count,
            "human_positive_match_coverage": _ratio(
                matched_positive_count,
                positive_count,
            ),
            "v1_replay_eligible_count": sum(
                record["v1_replay"]["eligible"]
                for record in evaluated_records
            ),
            "v1_human_positive_pass_count": v1_positive_pass_count,
            "v1_human_positive_recall": _ratio(
                v1_positive_pass_count,
                positive_count,
            ),
            "hook_prompt_evaluable_count": hook_evaluable_count,
            "hook_prompt_evidence_coverage": _ratio(
                hook_evaluable_count,
                candidate_count,
            ),
            "hook_status_counts": dict(
                sorted(
                    Counter(
                        record["hook_gate"]["status"]
                        for record in evaluated_records
                    ).items()
                )
            ),
            "semantic_closure_status_counts": _status_counts(
                v2_candidates,
                "semantic_closure_status",
            ),
            "semantic_closure_acceptance_rate": _ratio(
                closure_pass_count,
                candidate_count,
            ),
            "semantic_closure_human_positive_pass_count": (
                closure_positive_pass_count
            ),
            "semantic_closure_human_positive_recall": _ratio(
                closure_positive_pass_count,
                positive_count,
            ),
            "full_v2_eligible_count": sum(
                record["full_v2"]["eligible"]
                for record in evaluated_records
            ),
            "full_v2_human_positive_pass_count": (
                full_v2_positive_pass_count
            ),
            "full_v2_human_positive_recall": _ratio(
                full_v2_positive_pass_count,
                positive_count,
            ),
            "closure_shadow_eligible_count": sum(
                record["closure_shadow"]["eligible"]
                for record in evaluated_records
            ),
            "closure_shadow_top_k_human_positive_count": (
                closure_shadow_top_positive_count
            ),
            "closure_shadow_top_k_selected_count": len(
                closure_shadow_top
            ),
            "closure_shadow_top_k_planned_slots": planned_top_k_slots,
            "closure_shadow_top_k_fill_rate": _ratio(
                len(closure_shadow_top),
                planned_top_k_slots,
            ),
            "closure_shadow_top_k_human_positive_rate": _ratio(
                closure_shadow_top_positive_count,
                len(closure_shadow_top),
            ),
            "closure_shadow_top_k_slot_hit_rate": _ratio(
                closure_shadow_top_positive_count,
                planned_top_k_slots,
            ),
            "closure_shadow_human_positive_top_k_recall": _ratio(
                closure_shadow_top_positive_count,
                positive_count,
            ),
            "v1_vs_closure_shadow_top_k_overlap": _ratio(
                len(set(v1_top) & set(closure_shadow_top)),
                max(1, min(len(v1_top), len(closure_shadow_top))),
            ),
        },
        "top_k": {
            "k": top_k,
            "v1_replay_ids": v1_top,
            "full_v2_ids": full_v2_top,
            "closure_shadow_ids": closure_shadow_top,
        },
        "reason_counts": {
            "hook_gate": _nested_reason_counts(
                evaluated_records,
                "hook_gate",
            ),
            "semantic_closure": _reason_counts(
                v2_candidates,
                (
                    "semantic_closure_reject_reasons",
                    "semantic_closure_review_reasons",
                ),
            ),
            "full_v2": _nested_reason_counts(
                evaluated_records,
                "full_v2",
            ),
            "closure_shadow": _reason_counts(
                closure_shadow_ranked,
                ("rejection_reasons",),
            ),
        },
        "potential_false_negatives": potential_false_negatives,
        "candidates": evaluated_records,
    }


def _sum_metric(datasets: Sequence[Dict], key: str) -> int:
    return sum(int(dataset["metrics"].get(key) or 0) for dataset in datasets)


def build_growth_replay_report(
    manifest: Dict,
    root: Path,
    top_k: int = DEFAULT_TOP_K,
    manifest_path: Optional[Path] = None,
) -> Dict:
    verify_replay_pack(
        manifest,
        root,
        manifest_path=manifest_path,
    )
    specs = manifest.get("datasets")
    if not isinstance(specs, list) or not specs:
        raise ValueError("replay manifest requires at least one dataset")
    datasets = [
        evaluate_replay_dataset(load_replay_dataset(spec, root), top_k=top_k)
        for spec in specs
        if isinstance(spec, dict)
    ]
    candidate_count = _sum_metric(datasets, "candidate_count")
    positive_count = _sum_metric(datasets, "human_positive_count")
    matched_positive_count = _sum_metric(
        datasets,
        "human_positive_matched_count",
    )
    hook_evaluable = _sum_metric(datasets, "hook_prompt_evaluable_count")
    closure_pass = sum(
        dataset["metrics"]["semantic_closure_status_counts"].get("pass", 0)
        for dataset in datasets
    )
    closure_positive_pass = _sum_metric(
        datasets,
        "semantic_closure_human_positive_pass_count",
    )
    full_v2_eligible = _sum_metric(datasets, "full_v2_eligible_count")
    full_v2_positive_pass = _sum_metric(
        datasets,
        "full_v2_human_positive_pass_count",
    )
    v1_positive_pass = _sum_metric(
        datasets,
        "v1_human_positive_pass_count",
    )
    closure_shadow_top_positive = _sum_metric(
        datasets,
        "closure_shadow_top_k_human_positive_count",
    )
    closure_shadow_top_selected = _sum_metric(
        datasets,
        "closure_shadow_top_k_selected_count",
    )
    closure_shadow_top_planned_slots = _sum_metric(
        datasets,
        "closure_shadow_top_k_planned_slots",
    )
    closure_shadow_full_batch_count = sum(
        dataset["metrics"]["closure_shadow_top_k_selected_count"]
        >= dataset["metrics"]["closure_shadow_top_k_planned_slots"]
        for dataset in datasets
    )
    source_count = len(
        {
            str(dataset.get("source_id") or dataset.get("dataset_id") or "")
            for dataset in datasets
        }
    )
    aggregate = {
        "source_count": source_count,
        "candidate_count": candidate_count,
        "human_positive_count": positive_count,
        "human_positive_matched_count": matched_positive_count,
        "human_positive_match_coverage": _ratio(
            matched_positive_count,
            positive_count,
        ),
        "v1_human_positive_recall": _ratio(
            v1_positive_pass,
            positive_count,
        ),
        "hook_prompt_evaluable_count": hook_evaluable,
        "hook_prompt_evidence_coverage": _ratio(
            hook_evaluable,
            candidate_count,
        ),
        "semantic_closure_pass_count": closure_pass,
        "semantic_closure_acceptance_rate": _ratio(
            closure_pass,
            candidate_count,
        ),
        "semantic_closure_human_positive_recall": _ratio(
            closure_positive_pass,
            positive_count,
        ),
        "full_v2_eligible_count": full_v2_eligible,
        "full_v2_acceptance_rate": _ratio(
            full_v2_eligible,
            candidate_count,
        ),
        "full_v2_human_positive_recall": _ratio(
            full_v2_positive_pass,
            positive_count,
        ),
        "closure_shadow_top_k_human_positive_rate": _ratio(
            closure_shadow_top_positive,
            closure_shadow_top_selected,
        ),
        "closure_shadow_top_k_fill_rate": _ratio(
            closure_shadow_top_selected,
            closure_shadow_top_planned_slots,
        ),
        "closure_shadow_top_k_slot_hit_rate": _ratio(
            closure_shadow_top_positive,
            closure_shadow_top_planned_slots,
        ),
        "closure_shadow_full_batch_source_rate": _ratio(
            closure_shadow_full_batch_count,
            source_count,
        ),
        "potential_false_negative_count": sum(
            len(dataset["potential_false_negatives"])
            for dataset in datasets
        ),
    }
    gates = [
        {
            "code": "SOURCE_COVERAGE",
            "passed": source_count >= 5,
            "actual": source_count,
            "expected": ">=5 sources",
        },
        {
            "code": "CANDIDATE_COVERAGE",
            "passed": candidate_count >= 30,
            "actual": candidate_count,
            "expected": ">=30 candidates",
        },
        {
            "code": "HUMAN_POSITIVE_COVERAGE",
            "passed": positive_count >= 12,
            "actual": positive_count,
            "expected": ">=12 human-approved positives",
        },
        {
            "code": "POSITIVE_LABEL_MATCH_COVERAGE",
            "passed": (
                aggregate["human_positive_match_coverage"] or 0.0
            )
            >= 0.90,
            "actual": aggregate["human_positive_match_coverage"],
            "expected": ">=0.90",
        },
        {
            "code": "HOOK_PROMPT_EVIDENCE_COVERAGE",
            "passed": (aggregate["hook_prompt_evidence_coverage"] or 0.0) >= 0.80,
            "actual": aggregate["hook_prompt_evidence_coverage"],
            "expected": ">=0.80",
        },
        {
            "code": "CLOSURE_HUMAN_POSITIVE_RECALL",
            "passed": (
                aggregate["semantic_closure_human_positive_recall"] or 0.0
            )
            >= 0.80,
            "actual": aggregate[
                "semantic_closure_human_positive_recall"
            ],
            "expected": ">=0.80",
        },
        {
            "code": "CLOSURE_SHADOW_TOP_K_PRECISION",
            "passed": (
                aggregate["closure_shadow_top_k_human_positive_rate"] or 0.0
            )
            >= 0.60,
            "actual": aggregate[
                "closure_shadow_top_k_human_positive_rate"
            ],
            "expected": ">=0.60",
        },
        {
            "code": "CLOSURE_SHADOW_TOP_K_FILL_RATE",
            "passed": (
                aggregate["closure_shadow_top_k_fill_rate"] or 0.0
            )
            >= 0.80,
            "actual": aggregate["closure_shadow_top_k_fill_rate"],
            "expected": ">=0.80",
        },
    ]
    limitations = []
    if (aggregate["hook_prompt_evidence_coverage"] or 0.0) < 0.80:
        limitations.append(
            "Legacy candidates predate HookGateV2 prompt evidence. Full V2 "
            "acceptance is therefore a coverage result, not a hook-quality "
            "estimate; no evidence was synthesized."
        )
    if any(
        dataset["metrics"]["human_positive_count"] == 0
        for dataset in datasets
    ):
        limitations.append(
            "At least one source has no matched human-positive label."
        )
    payload = {
        "schemaVersion": GROWTH_REPLAY_SCHEMA_VERSION,
        "artifactType": "BudgetFriendlyGrowthReplayReport",
        "policyVersion": GROWTH_REPLAY_POLICY_VERSION,
        "topK": int(top_k),
        "offlineOnly": True,
        "llmCalls": 0,
        "renders": 0,
        "aggregate": aggregate,
        "acceptanceGates": gates,
        "productionApprovalRecommended": all(
            gate["passed"] for gate in gates
        ),
        "limitations": limitations,
        "datasets": datasets,
    }
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return {
        **payload,
        "contentHash": hashlib.sha256(encoded).hexdigest(),
    }


def render_growth_replay_markdown(report: Dict) -> str:
    aggregate = report["aggregate"]
    lines = [
        "# Budget Friendly Growth V2 Replay",
        "",
        f"- Policy: `{report['policyVersion']}`",
        f"- Sources: {aggregate['source_count']}",
        f"- Candidates: {aggregate['candidate_count']}",
        f"- Human-approved positives: {aggregate['human_positive_count']}",
        f"- LLM calls: {report['llmCalls']}",
        f"- Renders: {report['renders']}",
        "",
        "## Aggregate",
        "",
        "| Metric | Value |",
        "| --- | ---: |",
        f"| V1 human-positive recall | {aggregate['v1_human_positive_recall']} |",
        f"| Positive-label interval match coverage | {aggregate['human_positive_match_coverage']} |",
        f"| Hook prompt evidence coverage | {aggregate['hook_prompt_evidence_coverage']} |",
        f"| Semantic-closure acceptance rate | {aggregate['semantic_closure_acceptance_rate']} |",
        f"| Semantic-closure human-positive recall | {aggregate['semantic_closure_human_positive_recall']} |",
        f"| Full V2 acceptance rate | {aggregate['full_v2_acceptance_rate']} |",
        f"| Full V2 human-positive recall | {aggregate['full_v2_human_positive_recall']} |",
        f"| Closure-shadow top-{report['topK']} precision (selected slots) | {aggregate['closure_shadow_top_k_human_positive_rate']} |",
        f"| Closure-shadow top-{report['topK']} fill rate | {aggregate['closure_shadow_top_k_fill_rate']} |",
        f"| Closure-shadow top-{report['topK']} slot hit rate | {aggregate['closure_shadow_top_k_slot_hit_rate']} |",
        f"| Closure-shadow full-batch source rate | {aggregate['closure_shadow_full_batch_source_rate']} |",
        f"| Potential closure false negatives | {aggregate['potential_false_negative_count']} |",
        "",
        "## Acceptance gates",
        "",
        "| Gate | Passed | Actual | Expected |",
        "| --- | --- | ---: | --- |",
    ]
    for gate in report["acceptanceGates"]:
        lines.append(
            f"| `{gate['code']}` | {'yes' if gate['passed'] else 'no'} | "
            f"{gate['actual']} | {gate['expected']} |"
        )
    lines.extend(
        [
            "",
            "## Source results",
            "",
            "| Source | Candidates | Positives | Hook coverage | Closure acceptance | Closure positive recall | Shadow precision | Shadow fill |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for dataset in report["datasets"]:
        metrics = dataset["metrics"]
        lines.append(
            f"| `{dataset['source_id']}` | {metrics['candidate_count']} | "
            f"{metrics['human_positive_count']} | "
            f"{metrics['hook_prompt_evidence_coverage']} | "
            f"{metrics['semantic_closure_acceptance_rate']} | "
            f"{metrics['semantic_closure_human_positive_recall']} | "
            f"{metrics['closure_shadow_top_k_human_positive_rate']} | "
            f"{metrics['closure_shadow_top_k_fill_rate']} |"
        )
    false_negatives = [
        (dataset["source_id"], item)
        for dataset in report["datasets"]
        for item in dataset["potential_false_negatives"]
    ]
    lines.extend(["", "## Potential closure false negatives", ""])
    if false_negatives:
        for source_id, item in false_negatives:
            reasons = ", ".join(item["reasons"]) or item["status"]
            lines.append(
                f"- `{source_id}` — **{item['title']}**: {reasons}"
            )
    else:
        lines.append("- None in the labeled replay set.")
    if report.get("limitations"):
        lines.extend(["", "## Limitations", ""])
        lines.extend(f"- {value}" for value in report["limitations"])
    lines.extend(
        [
            "",
            "## Recommendation",
            "",
            (
                "Production approval is recommended."
                if report["productionApprovalRecommended"]
                else "Keep `bf_growth_v2` in shadow/opt-in mode until every "
                "acceptance gate passes."
            ),
            "",
        ]
    )
    return "\n".join(lines)


__all__ = [
    "DEFAULT_TOP_K",
    "GROWTH_REPLAY_POLICY_VERSION",
    "GROWTH_REPLAY_SCHEMA_VERSION",
    "build_growth_replay_report",
    "evaluate_replay_dataset",
    "load_replay_dataset",
    "render_growth_replay_markdown",
    "verify_replay_pack",
]
