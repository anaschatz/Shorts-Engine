"""Immutable explicit-human approval evidence for offline Autoresearch replay.

Capture is deliberately attached to the reviewed approval boundary. Engine
selection is retained as provenance only; it never becomes a human label.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
from pathlib import Path
from typing import Dict, Iterable, Mapping, Sequence
from urllib.parse import parse_qs, urlparse

from .artifact_contracts import (
    ArtifactBindingError,
    build_candidate_decision,
    candidate_hash,
    content_hash,
    verify_seal,
    verify_replay_transcript_manifest,
)


CAPTURE_VERSION = "bf-replay-capture-v2.0.0"
CAPTURE_LABEL_VERSION = "bf-replay-capture-label-v2.0.0"
DATASET_ARTIFACT_TYPE = "BudgetFriendlyReplayCaptureDatasetV2"
LABEL_ARTIFACT_TYPE = "BudgetFriendlyReplayCaptureLabelV2"
ENGINE_SELECTION_SEMANTICS = "unknown_not_human_label"
HUMAN_LABEL_SEMANTICS = "explicit_human_approval"


def _strict_snapshot(value: object, field: str) -> object:
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError(f"{field} must be strict JSON") from error
    return json.loads(encoded)


def _sha256(value: object, field: str) -> str:
    normalized = str(value or "").strip().lower().removeprefix("sha256:")
    if (
        len(normalized) != 64
        or any(char not in "0123456789abcdef" for char in normalized)
        or normalized == "0" * 64
    ):
        raise ArtifactBindingError(f"{field} must be a non-placeholder sha256 hash")
    return normalized


def _seal(payload: Mapping[str, object]) -> Dict:
    snapshot = _strict_snapshot(dict(payload), "capture artifact")
    if not isinstance(snapshot, dict):
        raise ArtifactBindingError("capture artifact must be an object")
    snapshot.pop("contentHash", None)
    return {**snapshot, "contentHash": content_hash(snapshot)}


def _strict_canonical_json(value: object, field: str) -> str:
    """Canonical strict JSON used for type-sensitive equality checks."""
    snapshot = _strict_snapshot(value, field)
    return json.dumps(
        snapshot,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )


def _finite(value: object, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError(f"{field} must be finite") from error
    if not math.isfinite(number):
        raise ArtifactBindingError(f"{field} must be finite")
    return number


def _source_id(source_input: str, source_hash: str) -> str:
    parsed = urlparse(source_input)
    hostname = str(parsed.hostname or "").lower()
    video_id = ""
    if hostname in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
        if parsed.path == "/watch":
            video_id = str(parse_qs(parsed.query).get("v", [""])[0]).strip()
        else:
            parts = [part for part in parsed.path.split("/") if part]
            if len(parts) >= 2 and parts[0] in {"shorts", "embed"}:
                video_id = parts[1]
    elif hostname in {"youtu.be", "www.youtu.be"}:
        video_id = parsed.path.strip("/").split("/", 1)[0]
    return f"youtube:{video_id}" if video_id else f"sha256:{source_hash}"


def _source_reference(source_input: str) -> Dict:
    parsed = urlparse(source_input)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return {
            "kind": "url",
            "url": source_input,
            "inputHash": content_hash({"sourceInput": source_input}),
        }
    return {
        "kind": "non_url",
        "inputHash": content_hash({"sourceInput": source_input}),
    }


def _candidate_records(
    candidates: object,
    source_hash: str,
    transcript_duration: float,
) -> tuple[list[Dict], list[Dict]]:
    if not isinstance(candidates, list) or not candidates:
        raise ArtifactBindingError("ranking manifest candidates are invalid")
    records: list[Dict] = []
    bindings: list[Dict] = []
    seen = set()
    for index, raw in enumerate(candidates):
        if not isinstance(raw, dict):
            raise ArtifactBindingError("ranking manifest candidate is invalid")
        candidate = _strict_snapshot(raw, f"candidate[{index}]")
        if not isinstance(candidate, dict):
            raise ArtifactBindingError("ranking manifest candidate is invalid")
        declared_hash = _sha256(
            candidate.get("candidate_hash"),
            f"candidate[{index}].candidate_hash",
        )
        actual_hash = candidate_hash(candidate, source_hash)
        if declared_hash != actual_hash:
            raise ArtifactBindingError(
                f"candidate[{index}] hash is stale"
            )
        if declared_hash in seen:
            raise ArtifactBindingError("ranking manifest has duplicate candidate hashes")
        seen.add(declared_hash)
        start = _finite(
            candidate.get("speech_start_time", candidate.get("start_time")),
            f"candidate[{index}].start",
        )
        end = _finite(
            candidate.get("speech_end_time", candidate.get("end_time")),
            f"candidate[{index}].end",
        )
        if start < 0.0 or end <= start or end > transcript_duration + 0.001:
            raise ArtifactBindingError(
                f"candidate[{index}] is outside the transcript interval"
            )
        records.append(candidate)
        bindings.append(
            {
                "candidateHash": declared_hash,
                "candidateRecordHash": content_hash(candidate),
                "index": index,
            }
        )
    return records, bindings


def _engine_selected_hashes(
    candidates: Sequence[Mapping[str, object]],
    selected_outputs: object,
) -> list[str]:
    output_hashes = {
        str(item.get("candidate_hash") or "").strip().lower()
        for item in (selected_outputs if isinstance(selected_outputs, list) else [])
        if isinstance(item, Mapping)
    }
    selected = []
    for candidate in candidates:
        candidate_hash_value = str(candidate.get("candidate_hash") or "").strip().lower()
        if (
            candidate.get("selected_for_render") is True
            or candidate.get("output_rank") is not None
            or candidate_hash_value in output_hashes
        ):
            selected.append(candidate_hash_value)
    return list(dict.fromkeys(selected))


def _ranking_capture_projection(ranking_manifest: Dict) -> Dict:
    """Verify a ranking and derive every replay-capture field from its body."""
    ranking = verify_seal(ranking_manifest, "RankingManifest")
    ranking = _strict_snapshot(ranking, "ranking manifest")
    if not isinstance(ranking, dict):
        raise ArtifactBindingError("ranking manifest must be an object")
    # Verify again after strict JSON normalization so unsupported Python values
    # cannot acquire a different portable representation at the capture edge.
    verify_seal(ranking, "RankingManifest")
    if ranking.get("schemaVersion") != 1:
        raise ArtifactBindingError("unsupported RankingManifest schema")

    ranking_hash = _sha256(ranking.get("contentHash"), "rankingManifestHash")
    source_hash = _sha256(ranking.get("sourceHash"), "sourceHash")
    transcript_manifest = verify_replay_transcript_manifest(
        ranking.get("replayTranscriptManifest"),
        source_hash=source_hash,
        require_timed_words=True,
    )
    transcript = transcript_manifest["transcript"]
    candidates, candidate_bindings = _candidate_records(
        ranking.get("candidates"),
        source_hash,
        float(transcript["duration"]),
    )
    source = ranking.get("source")
    if not isinstance(source, dict):
        raise ArtifactBindingError("ranking manifest source is invalid")
    source_input = str(source.get("input") or "").strip()
    if not source_input:
        raise ArtifactBindingError("ranking manifest source input is missing")
    engine_selected = _engine_selected_hashes(
        candidates,
        ranking.get("selected_outputs"),
    )
    return {
        "rankingManifest": ranking,
        "datasetId": ranking_hash,
        "sourceId": _source_id(source_input, source_hash),
        "sourceHash": source_hash,
        "source": _source_reference(source_input),
        "rankingManifestHash": ranking_hash,
        "rankingSchemaVersion": ranking.get("schemaVersion"),
        "contentType": ranking.get("content_type"),
        "profiles": ranking.get("profiles"),
        "replayTranscriptManifestHash": transcript_manifest["contentHash"],
        "transcriptHash": transcript_manifest["transcriptHash"],
        "transcriptTimingHash": transcript_manifest["transcriptTimingHash"],
        "replayTranscriptManifest": transcript_manifest,
        "candidates": candidates,
        "candidateBindings": candidate_bindings,
        "engineSelectedCandidateHashes": engine_selected,
        "engineSelectionSemantics": ENGINE_SELECTION_SEMANTICS,
    }


def build_replay_capture_dataset(ranking_manifest: Dict) -> Dict:
    """Build one exact candidate/transcript dataset from a sealed ranking."""
    projection = _ranking_capture_projection(ranking_manifest)
    payload = {
        "schemaVersion": 1,
        "artifactType": DATASET_ARTIFACT_TYPE,
        "captureVersion": CAPTURE_VERSION,
        **projection,
    }
    return _seal(payload)


def verify_replay_capture_dataset(artifact: Dict) -> Dict:
    dataset = verify_seal(artifact, DATASET_ARTIFACT_TYPE)
    dataset = _strict_snapshot(dataset, "replay capture dataset")
    if not isinstance(dataset, dict):
        raise ArtifactBindingError("replay capture dataset must be an object")
    verify_seal(dataset, DATASET_ARTIFACT_TYPE)
    if dataset.get("schemaVersion") != 1 or dataset.get("captureVersion") != CAPTURE_VERSION:
        raise ArtifactBindingError("unsupported replay capture dataset schema")
    projection = _ranking_capture_projection(dataset.get("rankingManifest"))
    for field, expected in projection.items():
        if _strict_canonical_json(
            dataset.get(field),
            f"capture.{field}",
        ) != _strict_canonical_json(expected, f"ranking projection.{field}"):
            raise ArtifactBindingError(
                f"capture {field} is not exactly derived from RankingManifest"
            )
    return dataset


def _decision_candidate_hash(decision: Mapping[str, object]) -> str:
    source_hash = _sha256(decision.get("sourceHash"), "sourceHash")
    candidate = decision.get("candidate")
    if not isinstance(candidate, dict):
        raise ArtifactBindingError("candidate decision candidate is invalid")
    actual_hash = candidate_hash(candidate, source_hash)
    declared_hash = _sha256(decision.get("candidateHash"), "candidateHash")
    if actual_hash != declared_hash:
        raise ArtifactBindingError("candidate decision candidate hash is stale")
    return declared_hash


def _verify_candidate_decision(artifact: Dict) -> Dict:
    decision = verify_seal(artifact, "CandidateDecision")
    if decision.get("schemaVersion") != 1 or decision.get("decision") != "approved":
        raise ArtifactBindingError("capture requires an approved CandidateDecision")
    candidate_hash_value = _decision_candidate_hash(decision)
    candidate = decision.get("candidate")
    rebuilt = build_candidate_decision(
        {
            **candidate,
            "candidate_hash": candidate_hash_value,
        },
        str(decision.get("sourceHash") or ""),
        reviewer=str(decision.get("reviewer") or ""),
        decided_at=str(decision.get("decidedAt") or ""),
        ranking_manifest_hash=str(decision.get("rankingManifestHash") or ""),
        notes=str(decision.get("notes") or ""),
    )
    if rebuilt != decision:
        raise ArtifactBindingError("candidate decision body is not canonical")
    return decision


def build_replay_capture_label(
    dataset_artifact: Dict,
    candidate_decision: Dict,
    *,
    approved_rank: int,
) -> Dict:
    """Build one positive label exclusively from an explicit approved decision."""
    dataset = verify_replay_capture_dataset(dataset_artifact)
    decision = _verify_candidate_decision(candidate_decision)
    candidate_hash_value = _decision_candidate_hash(decision)
    if decision.get("sourceHash") != dataset.get("sourceHash"):
        raise ArtifactBindingError("candidate decision references another source")
    if decision.get("rankingManifestHash") != dataset.get("rankingManifestHash"):
        raise ArtifactBindingError("candidate decision references another ranking")
    candidate_by_hash = {
        item["candidate_hash"]: item
        for item in dataset["candidates"]
    }
    candidate = candidate_by_hash.get(candidate_hash_value)
    if candidate is None:
        raise ArtifactBindingError("approved candidate is absent from capture dataset")
    try:
        normalized_rank = int(approved_rank)
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError("approvedRank must be a positive integer") from error
    declared_rank = candidate.get("selection_rank", candidate.get("output_rank"))
    try:
        candidate_rank = int(declared_rank)
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError("approved candidate rank is missing") from error
    if normalized_rank < 1 or normalized_rank != candidate_rank:
        raise ArtifactBindingError("approvedRank is not bound to the approved candidate")
    payload = {
        "schemaVersion": 1,
        "artifactType": LABEL_ARTIFACT_TYPE,
        "labelVersion": CAPTURE_LABEL_VERSION,
        "decision": "approved",
        "labelSemantics": HUMAN_LABEL_SEMANTICS,
        "datasetId": dataset["datasetId"],
        "datasetHash": dataset["contentHash"],
        "rankingManifestHash": dataset["rankingManifestHash"],
        "sourceHash": dataset["sourceHash"],
        "candidateHash": candidate_hash_value,
        "candidateDecisionHash": decision["contentHash"],
        "candidateDecision": decision,
        "approvedRank": normalized_rank,
        "reviewer": decision["reviewer"],
        "decidedAt": decision["decidedAt"],
        "notes": decision.get("notes", ""),
    }
    return _seal(payload)


def verify_replay_capture_label(
    artifact: Dict,
    dataset_artifact: Dict,
) -> Dict:
    label = verify_seal(artifact, LABEL_ARTIFACT_TYPE)
    dataset = verify_replay_capture_dataset(dataset_artifact)
    if label.get("schemaVersion") != 1 or label.get("labelVersion") != CAPTURE_LABEL_VERSION:
        raise ArtifactBindingError("unsupported replay capture label schema")
    if label.get("decision") != "approved" or label.get("labelSemantics") != HUMAN_LABEL_SEMANTICS:
        raise ArtifactBindingError("capture label is not an explicit approval")
    decision = _verify_candidate_decision(label.get("candidateDecision"))
    candidate_hash_value = _decision_candidate_hash(decision)
    expected = {
        "datasetId": dataset["datasetId"],
        "datasetHash": dataset["contentHash"],
        "rankingManifestHash": dataset["rankingManifestHash"],
        "sourceHash": dataset["sourceHash"],
        "candidateHash": candidate_hash_value,
        "candidateDecisionHash": decision["contentHash"],
        "reviewer": decision["reviewer"],
        "decidedAt": decision["decidedAt"],
        "notes": decision.get("notes", ""),
    }
    for field, value in expected.items():
        if label.get(field) != value:
            raise ArtifactBindingError(f"capture label {field} binding is stale")
    if decision.get("rankingManifestHash") != dataset.get("rankingManifestHash"):
        raise ArtifactBindingError("capture label decision references another ranking")
    if decision.get("sourceHash") != dataset.get("sourceHash"):
        raise ArtifactBindingError("capture label decision references another source")
    matching = [
        item
        for item in dataset["candidates"]
        if item.get("candidate_hash") == candidate_hash_value
    ]
    if len(matching) != 1:
        raise ArtifactBindingError("capture label candidate binding is invalid")
    declared_rank = matching[0].get(
        "selection_rank",
        matching[0].get("output_rank"),
    )
    try:
        rank_matches = int(label.get("approvedRank")) == int(declared_rank)
    except (TypeError, ValueError):
        rank_matches = False
    if not rank_matches or int(label["approvedRank"]) < 1:
        raise ArtifactBindingError("capture label approvedRank is stale")
    return label


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_immutable_json(path: Path, artifact: Dict) -> bool:
    """Create one complete content-addressed file; identical retries are safe."""
    snapshot = _strict_snapshot(artifact, "capture artifact")
    encoded = (
        json.dumps(
            snapshot,
            indent=2,
            sort_keys=True,
            ensure_ascii=True,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
                existing_canonical = _strict_canonical_json(
                    existing,
                    "existing capture artifact",
                )
            except (OSError, json.JSONDecodeError, ArtifactBindingError) as error:
                raise ArtifactBindingError(
                    f"immutable capture collision at {path}"
                ) from error
            if existing_canonical != _strict_canonical_json(
                snapshot,
                "capture artifact",
            ):
                raise ArtifactBindingError(
                    f"immutable capture collision at {path}"
                )
            return False
        _fsync_directory(path.parent)
        return True
    finally:
        temporary.unlink(missing_ok=True)


def archive_approved_candidate(
    ranking_manifest: Dict,
    candidate_decision: Dict,
    *,
    approved_rank: int,
    evidence_dir: str | Path,
) -> Dict:
    """Persist a reusable dataset and one append-only explicit approval label."""
    dataset = build_replay_capture_dataset(ranking_manifest)
    label = build_replay_capture_label(
        dataset,
        candidate_decision,
        approved_rank=approved_rank,
    )
    root = Path(evidence_dir).expanduser()
    dataset_path = root / "datasets" / f"{dataset['rankingManifestHash']}.json"
    label_path = (
        root
        / "labels"
        / dataset["rankingManifestHash"]
        / f"{label['candidateDecisionHash']}.json"
    )
    dataset_created = _write_immutable_json(dataset_path, dataset)
    label_created = _write_immutable_json(label_path, label)
    return {
        "schemaVersion": 1,
        "artifactType": "BudgetFriendlyReplayCaptureReceiptV2",
        "datasetHash": dataset["contentHash"],
        "labelHash": label["contentHash"],
        "datasetPath": str(dataset_path.resolve()),
        "labelPath": str(label_path.resolve()),
        "datasetCreated": dataset_created,
        "labelCreated": label_created,
    }


def load_capture_artifacts(paths: Iterable[Path]) -> list[Dict]:
    """Strict JSON loader shared by the offline fixture-promotion step."""
    artifacts = []
    for path in paths:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ArtifactBindingError(f"invalid capture artifact: {path}") from error
        if not isinstance(value, dict):
            raise ArtifactBindingError(f"capture artifact is not an object: {path}")
        artifacts.append(value)
    return artifacts
