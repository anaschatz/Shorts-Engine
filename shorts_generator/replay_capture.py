"""Immutable explicit-human review evidence for offline Autoresearch replay.

Positive capture is attached to the reviewed approval boundary; explicit
rejections live in a separate non-production lane. Engine selection is
retained as provenance only and never becomes a human label.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from pathlib import Path
from typing import Dict, Iterable, Mapping, Sequence
from urllib.parse import parse_qs, urlparse

from .artifact_contracts import (
    ArtifactBindingError,
    FEED_STOP_V3_REPLAY_PROFILE_TUPLE,
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
HUMAN_REJECTION_VERSION = "bf-replay-human-rejection-v1.0.0"
HUMAN_REJECTION_ARTIFACT_TYPE = "BudgetFriendlyReplayHumanRejectionV1"
HUMAN_REJECTION_RECEIPT_TYPE = "BudgetFriendlyReplayHumanRejectionReceiptV1"
HUMAN_REJECTION_SEMANTICS = "explicit_human_rejection"
HUMAN_PREVIEW_REJECTION_LEGACY_VERSION = (
    "bf-replay-human-preview-rejection-v1.0.0"
)
HUMAN_PREVIEW_REJECTION_VERSION = "bf-replay-human-preview-rejection-v1.1.0"
HUMAN_PREVIEW_REJECTION_ARTIFACT_TYPE = (
    "BudgetFriendlyReplayHumanPreviewRejectionV1"
)
HUMAN_PREVIEW_REJECTION_RECEIPT_TYPE = (
    "BudgetFriendlyReplayHumanPreviewRejectionReceiptV1"
)
HUMAN_PREVIEW_REJECTION_SEMANTICS = "explicit_human_preview_rejection"
HUMAN_PREVIEW_DURATION_TOLERANCE_MS = 100
HUMAN_REJECTION_REASON_CODES = frozenset(
    {
        "abrupt_ending",
        "audible_backchannels",
        "audible_fillers",
        "captions_obscure_face",
        "distracting_editing",
        "hesitant_or_stuttered_delivery",
        "incomplete_point",
        "main_speech_obscured",
        "other_editorial",
        "poor_caption_timing",
        "poor_visual_quality",
        "repeated_topic",
        "unclear_hook",
        "unclear_point",
        "unclear_context",
        "unintelligible_speech",
        "unsuitable_speaker",
        "weak_hook",
    }
)


def _normalized_reason_codes(reason_codes: object) -> list[str]:
    if (
        not isinstance(reason_codes, Sequence)
        or isinstance(reason_codes, (str, bytes))
    ):
        raise ArtifactBindingError("reasonCodes must be a nonempty list")
    normalized = []
    for raw in reason_codes:
        code = "_".join(
            str(raw or "").strip().lower().replace("-", " ").split()
        )
        if code not in HUMAN_REJECTION_REASON_CODES:
            raise ArtifactBindingError(f"unknown human rejection reason code: {code}")
        normalized.append(code)
    normalized = sorted(set(normalized))
    if not normalized:
        raise ArtifactBindingError("reasonCodes must be a nonempty list")
    return normalized


def _normalized_evidence_refs(evidence_refs: object) -> Dict[str, str]:
    if evidence_refs is None:
        return {}
    if not isinstance(evidence_refs, Mapping):
        raise ArtifactBindingError("evidenceRefs must be an object")
    normalized: Dict[str, str] = {}
    for raw_key, raw_value in evidence_refs.items():
        key = str(raw_key or "").strip()
        if (
            not key
            or not key[0].isalpha()
            or not key.endswith("Hash")
            or not all(char.isalnum() for char in key[:-4])
        ):
            raise ArtifactBindingError("evidenceRefs keys must be named hashes")
        normalized[key] = _sha256(raw_value, f"evidenceRefs.{key}")
    return dict(sorted(normalized.items()))


def _strict_integer(value: object, field: str, *, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        qualifier = "nonnegative" if minimum == 0 else "positive"
        raise ArtifactBindingError(f"{field} must be a {qualifier} integer")
    return value


def _normalized_review_media(
    *,
    media_hash: object,
    byte_length: object,
    duration_ms: object,
    container: object,
) -> Dict:
    normalized_container = str(container or "").strip().lower().lstrip(".")
    if (
        not normalized_container
        or len(normalized_container) > 16
        or not normalized_container[0].isalnum()
        or not all(char.isalnum() for char in normalized_container)
    ):
        raise ArtifactBindingError(
            "reviewMedia.container must be a canonical container name"
        )
    return {
        "sha256": _sha256(media_hash, "reviewMedia.sha256"),
        "byteLength": _strict_integer(
            byte_length,
            "reviewMedia.byteLength",
            minimum=1,
        ),
        "durationMs": _strict_integer(
            duration_ms,
            "reviewMedia.durationMs",
            minimum=1,
        ),
        "container": normalized_container,
    }


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


def _rejection_candidate(
    dataset: Mapping[str, object],
    candidate_hash_value: object,
) -> tuple[Dict, int]:
    normalized_hash = _sha256(candidate_hash_value, "candidateHash")
    matches = [
        (index, candidate)
        for index, candidate in enumerate(dataset.get("candidates") or [])
        if isinstance(candidate, dict)
        and candidate.get("candidate_hash") == normalized_hash
    ]
    if len(matches) != 1:
        raise ArtifactBindingError(
            "human rejection candidate must exist exactly once in the capture dataset"
        )
    index, candidate = matches[0]
    return candidate, index


def _candidate_rank(candidate: Mapping[str, object]) -> int:
    declared = candidate.get("selection_rank", candidate.get("output_rank"))
    if isinstance(declared, bool):
        raise ArtifactBindingError("rejected candidate rank is invalid")
    try:
        rank = int(declared)
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError("rejected candidate rank is missing") from error
    if rank < 1:
        raise ArtifactBindingError("rejected candidate rank is invalid")
    return rank


def _normalized_optional_rank(
    rejected_rank: object,
    candidate: Mapping[str, object],
) -> int | None:
    if rejected_rank is None:
        return None
    if isinstance(rejected_rank, bool):
        raise ArtifactBindingError("rejectedRank must be a positive integer")
    try:
        normalized = int(rejected_rank)
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError(
            "rejectedRank must be a positive integer"
        ) from error
    if normalized < 1 or normalized != _candidate_rank(candidate):
        raise ArtifactBindingError(
            "rejectedRank is not bound to the rejected candidate"
        )
    return normalized


def _candidate_speech_interval(candidate: Mapping[str, object]) -> tuple[float, float]:
    start = _finite(
        candidate.get("speech_start_time", candidate.get("start_time")),
        "candidate speech start",
    )
    end = _finite(
        candidate.get("speech_end_time", candidate.get("end_time")),
        "candidate speech end",
    )
    if start < 0.0 or end <= start:
        raise ArtifactBindingError("candidate speech interval is invalid")
    return start, end


def _verify_rejection_speech_cleanliness_evidence(
    *,
    dataset: Mapping[str, object],
    candidate: Mapping[str, object],
    evidence_refs: Mapping[str, str],
    speech_cleanliness_report: object = None,
) -> None:
    """Bind an optional cleanliness report without making it an approval gate."""

    candidate_report = candidate.get("speechCleanlinessReport")
    supplied_report = speech_cleanliness_report
    report_hash = evidence_refs.get("speechCleanlinessReportHash")
    reports = []
    if candidate_report is not None:
        if not isinstance(candidate_report, dict):
            raise ArtifactBindingError(
                "candidate speech-cleanliness report is invalid"
            )
        reports.append(candidate_report)
    if supplied_report is not None:
        if not isinstance(supplied_report, dict):
            raise ArtifactBindingError("speech-cleanliness report is invalid")
        if candidate_report is None:
            raise ArtifactBindingError(
                "external-only speech-cleanliness evidence is not self-contained"
            )
        reports.append(supplied_report)

    if reports and report_hash is None:
        raise ArtifactBindingError(
            "speech-cleanliness report requires an exact evidence reference"
        )
    if report_hash is not None and not reports:
        raise ArtifactBindingError(
            "speechCleanlinessReportHash has no bound report"
        )
    if not reports:
        return

    from .speech_cleanliness import verify_speech_cleanliness_report

    interval = _candidate_speech_interval(candidate)
    for report in reports:
        verified = verify_speech_cleanliness_report(
            report,
            source_hash=str(dataset.get("sourceHash") or ""),
            transcript_timing_hash=str(
                dataset.get("transcriptTimingHash") or ""
            ),
            speech_interval=interval,
            require_pass=False,
        )
        if verified.get("contentHash") != report_hash:
            raise ArtifactBindingError(
                "speech-cleanliness report hash binding is stale"
            )


def build_replay_human_rejection(
    dataset_artifact: Dict,
    candidate_hash_value: str,
    *,
    reviewer: str,
    decided_at: str,
    reason_codes: Sequence[str],
    rejected_rank: int | None = None,
    notes: str = "",
    evidence_refs: Mapping[str, object] | None = None,
    speech_cleanliness_report: Dict | None = None,
) -> Dict:
    """Build a sealed negative event from an explicit human rejection.

    This is intentionally not a ``CandidateDecision`` and is never accepted by
    the positive-label ingestion path.
    """

    dataset = verify_replay_capture_dataset(dataset_artifact)
    candidate, candidate_index = _rejection_candidate(
        dataset,
        candidate_hash_value,
    )
    normalized_reviewer = str(reviewer or "").strip()
    normalized_decided_at = str(decided_at or "").strip()
    if not normalized_reviewer or not normalized_decided_at:
        raise ArtifactBindingError("reviewer and decided_at are required")
    normalized_reasons = _normalized_reason_codes(reason_codes)
    normalized_refs = _normalized_evidence_refs(evidence_refs)

    candidate_report = candidate.get("speechCleanlinessReport")
    if speech_cleanliness_report is not None and candidate_report is None:
        raise ArtifactBindingError(
            "external-only speech-cleanliness evidence is not self-contained"
        )
    reports = [
        report
        for report in (candidate_report, speech_cleanliness_report)
        if report is not None
    ]
    if reports:
        report_hashes = {
            _sha256(
                report.get("contentHash") if isinstance(report, Mapping) else None,
                "speechCleanlinessReport.contentHash",
            )
            for report in reports
        }
        if len(report_hashes) != 1:
            raise ArtifactBindingError(
                "supplied speech-cleanliness report differs from candidate evidence"
            )
        exact_report_hash = next(iter(report_hashes))
        declared_report_hash = normalized_refs.get(
            "speechCleanlinessReportHash"
        )
        if declared_report_hash not in (None, exact_report_hash):
            raise ArtifactBindingError(
                "speech-cleanliness evidence reference is stale"
            )
        normalized_refs["speechCleanlinessReportHash"] = exact_report_hash
        normalized_refs = dict(sorted(normalized_refs.items()))

    _verify_rejection_speech_cleanliness_evidence(
        dataset=dataset,
        candidate=candidate,
        evidence_refs=normalized_refs,
        speech_cleanliness_report=speech_cleanliness_report,
    )
    normalized_rank = _normalized_optional_rank(rejected_rank, candidate)
    payload = {
        "schemaVersion": 1,
        "artifactType": HUMAN_REJECTION_ARTIFACT_TYPE,
        "rejectionVersion": HUMAN_REJECTION_VERSION,
        "decision": "rejected",
        "labelSemantics": HUMAN_REJECTION_SEMANTICS,
        "datasetId": dataset["datasetId"],
        "datasetHash": dataset["contentHash"],
        "rankingManifestHash": dataset["rankingManifestHash"],
        "rankingSchemaVersion": dataset["rankingSchemaVersion"],
        "sourceId": dataset["sourceId"],
        "sourceHash": dataset["sourceHash"],
        "replayTranscriptManifestHash": dataset[
            "replayTranscriptManifestHash"
        ],
        "transcriptHash": dataset["transcriptHash"],
        "transcriptTimingHash": dataset["transcriptTimingHash"],
        "candidateHash": str(candidate["candidate_hash"]),
        "candidateRecordHash": content_hash(candidate),
        "candidateIndex": candidate_index,
        "reviewer": normalized_reviewer,
        "decidedAt": normalized_decided_at,
        "reasonCodes": normalized_reasons,
        "notes": str(notes or "").strip(),
    }
    if normalized_rank is not None:
        payload["rejectedRank"] = normalized_rank
    if normalized_refs:
        payload["evidenceRefs"] = normalized_refs
    return _seal(payload)


def verify_replay_human_rejection(
    artifact: Dict,
    dataset_artifact: Dict,
    *,
    speech_cleanliness_report: Dict | None = None,
) -> Dict:
    """Verify a human rejection and all of its replay provenance bindings."""

    rejection = verify_seal(artifact, HUMAN_REJECTION_ARTIFACT_TYPE)
    rejection = _strict_snapshot(rejection, "human rejection")
    if not isinstance(rejection, dict):
        raise ArtifactBindingError("human rejection must be an object")
    verify_seal(rejection, HUMAN_REJECTION_ARTIFACT_TYPE)
    dataset = verify_replay_capture_dataset(dataset_artifact)
    if (
        rejection.get("schemaVersion") != 1
        or rejection.get("rejectionVersion") != HUMAN_REJECTION_VERSION
    ):
        raise ArtifactBindingError("unsupported human rejection schema")
    if (
        rejection.get("decision") != "rejected"
        or rejection.get("labelSemantics") != HUMAN_REJECTION_SEMANTICS
    ):
        raise ArtifactBindingError("artifact is not an explicit human rejection")

    expected_dataset_bindings = {
        "datasetId": dataset["datasetId"],
        "datasetHash": dataset["contentHash"],
        "rankingManifestHash": dataset["rankingManifestHash"],
        "rankingSchemaVersion": dataset["rankingSchemaVersion"],
        "sourceId": dataset["sourceId"],
        "sourceHash": dataset["sourceHash"],
        "replayTranscriptManifestHash": dataset[
            "replayTranscriptManifestHash"
        ],
        "transcriptHash": dataset["transcriptHash"],
        "transcriptTimingHash": dataset["transcriptTimingHash"],
    }
    for field, expected in expected_dataset_bindings.items():
        if rejection.get(field) != expected:
            raise ArtifactBindingError(
                f"human rejection {field} binding is stale"
            )

    candidate, candidate_index = _rejection_candidate(
        dataset,
        rejection.get("candidateHash"),
    )
    expected_candidate_bindings = {
        "candidateHash": candidate["candidate_hash"],
        "candidateRecordHash": content_hash(candidate),
        "candidateIndex": candidate_index,
    }
    for field, expected in expected_candidate_bindings.items():
        if rejection.get(field) != expected:
            raise ArtifactBindingError(
                f"human rejection {field} binding is stale"
            )

    normalized_rank = _normalized_optional_rank(
        rejection.get("rejectedRank")
        if "rejectedRank" in rejection
        else None,
        candidate,
    )
    normalized_reasons = _normalized_reason_codes(rejection.get("reasonCodes"))
    if rejection.get("reasonCodes") != normalized_reasons:
        raise ArtifactBindingError("human rejection reasonCodes are not canonical")
    normalized_refs = _normalized_evidence_refs(
        rejection.get("evidenceRefs")
        if "evidenceRefs" in rejection
        else None
    )
    if (
        "evidenceRefs" in rejection
        and rejection.get("evidenceRefs") != normalized_refs
    ):
        raise ArtifactBindingError("human rejection evidenceRefs are not canonical")
    reviewer = str(rejection.get("reviewer") or "").strip()
    decided_at = str(rejection.get("decidedAt") or "").strip()
    notes = str(rejection.get("notes") or "").strip()
    if (
        not reviewer
        or not decided_at
        or rejection.get("reviewer") != reviewer
        or rejection.get("decidedAt") != decided_at
        or rejection.get("notes") != notes
    ):
        raise ArtifactBindingError("human rejection review fields are not canonical")

    _verify_rejection_speech_cleanliness_evidence(
        dataset=dataset,
        candidate=candidate,
        evidence_refs=normalized_refs,
        speech_cleanliness_report=speech_cleanliness_report,
    )

    required_fields = {
        "schemaVersion",
        "artifactType",
        "rejectionVersion",
        "decision",
        "labelSemantics",
        *expected_dataset_bindings.keys(),
        *expected_candidate_bindings.keys(),
        "reviewer",
        "decidedAt",
        "reasonCodes",
        "notes",
        "contentHash",
    }
    if normalized_rank is not None:
        required_fields.add("rejectedRank")
    if normalized_refs:
        required_fields.add("evidenceRefs")
    if set(rejection) != required_fields:
        raise ArtifactBindingError("human rejection body is not canonical")
    return rejection


def _preview_dataset_bindings(dataset: Mapping[str, object]) -> Dict:
    return {
        "datasetId": dataset["datasetId"],
        "datasetHash": dataset["contentHash"],
        "rankingManifestHash": dataset["rankingManifestHash"],
        "rankingSchemaVersion": dataset["rankingSchemaVersion"],
        "sourceId": dataset["sourceId"],
        "sourceHash": dataset["sourceHash"],
        "replayTranscriptManifestHash": dataset[
            "replayTranscriptManifestHash"
        ],
        "transcriptHash": dataset["transcriptHash"],
        "transcriptTimingHash": dataset["transcriptTimingHash"],
    }


def _normalized_preview_interval(
    dataset: Mapping[str, object],
    *,
    start_ms: object,
    end_ms: object,
) -> Dict[str, int]:
    normalized_start = _strict_integer(
        start_ms,
        "sourceIntervalMs.startMs",
        minimum=0,
    )
    normalized_end = _strict_integer(
        end_ms,
        "sourceIntervalMs.endMs",
        minimum=1,
    )
    if normalized_end <= normalized_start:
        raise ArtifactBindingError(
            "sourceIntervalMs must have positive duration"
        )
    transcript_manifest = dataset.get("replayTranscriptManifest")
    transcript = (
        transcript_manifest.get("transcript")
        if isinstance(transcript_manifest, Mapping)
        else None
    )
    if not isinstance(transcript, Mapping):
        raise ArtifactBindingError("capture transcript is invalid")
    duration_seconds = _finite(
        transcript.get("duration"),
        "capture transcript duration",
    )
    # Millisecond intervals are permitted to end at the first integer
    # millisecond which wholly contains the exact transcript duration.
    maximum_end_ms = int(math.ceil(duration_seconds * 1000.0 - 1e-9))
    if normalized_end > maximum_end_ms:
        raise ArtifactBindingError(
            "sourceIntervalMs exceeds the bound transcript duration"
        )
    return {
        "startMs": normalized_start,
        "endMs": normalized_end,
    }


def _verify_preview_media_duration(
    interval: Mapping[str, int],
    review_media: Mapping[str, object],
) -> None:
    interval_duration_ms = interval["endMs"] - interval["startMs"]
    media_duration_ms = review_media["durationMs"]
    if (
        not isinstance(media_duration_ms, int)
        or isinstance(media_duration_ms, bool)
        or abs(media_duration_ms - interval_duration_ms)
        > HUMAN_PREVIEW_DURATION_TOLERANCE_MS
    ):
        raise ArtifactBindingError(
            "reviewMedia.durationMs does not match sourceIntervalMs "
            f"within {HUMAN_PREVIEW_DURATION_TOLERANCE_MS}ms"
        )


def _review_media_identity(path: str | Path) -> tuple[Path, str, int]:
    media_path = Path(path).expanduser()
    try:
        before = media_path.stat()
    except OSError as error:
        raise ArtifactBindingError(
            f"review media is unavailable: {media_path}"
        ) from error
    if not media_path.is_file() or before.st_size < 1:
        raise ArtifactBindingError("review media must be a nonempty file")
    digest = hashlib.sha256()
    byte_length = 0
    try:
        with media_path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                byte_length += len(chunk)
        after = media_path.stat()
    except OSError as error:
        raise ArtifactBindingError(
            f"review media could not be read: {media_path}"
        ) from error
    if (
        byte_length != before.st_size
        or byte_length != after.st_size
        or before.st_mtime_ns != after.st_mtime_ns
    ):
        raise ArtifactBindingError("review media changed while it was hashed")
    return media_path, digest.hexdigest(), byte_length


def build_replay_human_preview_rejection(
    dataset_artifact: Dict,
    *,
    interval_start_ms: int,
    interval_end_ms: int,
    review_media_hash: str,
    review_media_byte_length: int,
    review_media_duration_ms: int,
    review_media_container: str,
    reviewer: str,
    decided_at: str,
    reason_codes: Sequence[str],
    preview_source_provenance_report: Dict,
    notes: str = "",
) -> Dict:
    """Build a sealed rejection of exact reviewed preview media.

    A preview rejection deliberately carries no candidate identity: it records
    what the operator actually watched without pretending the reviewed source
    interval was one of the ranking manifest's candidate records.
    """

    dataset = verify_replay_capture_dataset(dataset_artifact)
    normalized_reviewer = str(reviewer or "").strip()
    normalized_decided_at = str(decided_at or "").strip()
    if not normalized_reviewer or not normalized_decided_at:
        raise ArtifactBindingError("reviewer and decided_at are required")
    interval = _normalized_preview_interval(
        dataset,
        start_ms=interval_start_ms,
        end_ms=interval_end_ms,
    )
    review_media = _normalized_review_media(
        media_hash=review_media_hash,
        byte_length=review_media_byte_length,
        duration_ms=review_media_duration_ms,
        container=review_media_container,
    )
    _verify_preview_media_duration(interval, review_media)
    if not isinstance(preview_source_provenance_report, dict):
        raise ArtifactBindingError(
            "previewSourceProvenanceReport is required for new rejections"
        )
    from .preview_provenance import verify_preview_source_provenance

    verified_provenance = verify_preview_source_provenance(
        preview_source_provenance_report,
        source_hash=str(dataset["sourceHash"]),
        preview_hash=str(review_media["sha256"]),
        start_ms=int(interval["startMs"]),
        end_ms=int(interval["endMs"]),
        require_pass=True,
    )
    payload = {
        "schemaVersion": 1,
        "artifactType": HUMAN_PREVIEW_REJECTION_ARTIFACT_TYPE,
        "rejectionVersion": HUMAN_PREVIEW_REJECTION_VERSION,
        "decision": "rejected",
        "labelSemantics": HUMAN_PREVIEW_REJECTION_SEMANTICS,
        "productionEligible": False,
        **_preview_dataset_bindings(dataset),
        "sourceIntervalMs": interval,
        "reviewMedia": review_media,
        "previewSourceProvenanceReportHash": verified_provenance[
            "contentHash"
        ],
        "previewSourceProvenanceReport": verified_provenance,
        "reviewer": normalized_reviewer,
        "decidedAt": normalized_decided_at,
        "reasonCodes": _normalized_reason_codes(reason_codes),
        "notes": str(notes or "").strip(),
    }
    return _seal(payload)


def verify_replay_human_preview_rejection(
    artifact: Dict,
    dataset_artifact: Dict,
    *,
    review_media_path: str | Path | None = None,
) -> Dict:
    """Verify an exact non-production preview rejection and its media bytes."""

    rejection = verify_seal(
        artifact,
        HUMAN_PREVIEW_REJECTION_ARTIFACT_TYPE,
    )
    rejection = _strict_snapshot(rejection, "human preview rejection")
    if not isinstance(rejection, dict):
        raise ArtifactBindingError("human preview rejection must be an object")
    verify_seal(rejection, HUMAN_PREVIEW_REJECTION_ARTIFACT_TYPE)
    dataset = verify_replay_capture_dataset(dataset_artifact)
    rejection_version = rejection.get("rejectionVersion")
    if rejection.get("schemaVersion") != 1 or rejection_version not in {
        HUMAN_PREVIEW_REJECTION_LEGACY_VERSION,
        HUMAN_PREVIEW_REJECTION_VERSION,
    }:
        raise ArtifactBindingError("unsupported human preview rejection schema")
    if (
        rejection.get("decision") != "rejected"
        or rejection.get("labelSemantics")
        != HUMAN_PREVIEW_REJECTION_SEMANTICS
        or rejection.get("productionEligible") is not False
    ):
        raise ArtifactBindingError(
            "artifact is not a non-production human preview rejection"
        )
    candidate_identity_fields = {
        "candidateHash",
        "candidateRecordHash",
        "candidateIndex",
        "rejectedRank",
    }
    if candidate_identity_fields.intersection(rejection):
        raise ArtifactBindingError(
            "human preview rejection must not contain candidate identity"
        )

    expected_dataset_bindings = _preview_dataset_bindings(dataset)
    for field, expected in expected_dataset_bindings.items():
        if rejection.get(field) != expected:
            raise ArtifactBindingError(
                f"human preview rejection {field} binding is stale"
            )

    interval = rejection.get("sourceIntervalMs")
    if not isinstance(interval, Mapping):
        raise ArtifactBindingError("sourceIntervalMs must be an object")
    normalized_interval = _normalized_preview_interval(
        dataset,
        start_ms=interval.get("startMs"),
        end_ms=interval.get("endMs"),
    )
    if dict(interval) != normalized_interval:
        raise ArtifactBindingError("sourceIntervalMs is not canonical")

    review_media = rejection.get("reviewMedia")
    if not isinstance(review_media, Mapping):
        raise ArtifactBindingError("reviewMedia must be an object")
    normalized_media = _normalized_review_media(
        media_hash=review_media.get("sha256"),
        byte_length=review_media.get("byteLength"),
        duration_ms=review_media.get("durationMs"),
        container=review_media.get("container"),
    )
    if dict(review_media) != normalized_media:
        raise ArtifactBindingError("reviewMedia is not canonical")
    _verify_preview_media_duration(normalized_interval, normalized_media)
    if review_media_path is not None:
        _, media_hash, byte_length = _review_media_identity(review_media_path)
        if (
            media_hash != normalized_media["sha256"]
            or byte_length != normalized_media["byteLength"]
        ):
            raise ArtifactBindingError(
                "review media bytes do not match the sealed rejection"
            )

    provenance_fields = set()
    if rejection_version == HUMAN_PREVIEW_REJECTION_VERSION:
        report = rejection.get("previewSourceProvenanceReport")
        if not isinstance(report, dict):
            raise ArtifactBindingError(
                "V1.1 preview rejection lacks preview source provenance"
            )
        from .preview_provenance import verify_preview_source_provenance

        verified_provenance = verify_preview_source_provenance(
            report,
            source_hash=str(dataset["sourceHash"]),
            preview_hash=str(normalized_media["sha256"]),
            start_ms=int(normalized_interval["startMs"]),
            end_ms=int(normalized_interval["endMs"]),
            require_pass=True,
        )
        if (
            rejection.get("previewSourceProvenanceReportHash")
            != verified_provenance.get("contentHash")
        ):
            raise ArtifactBindingError(
                "preview source provenance report hash binding is stale"
            )
        provenance_fields = {
            "previewSourceProvenanceReportHash",
            "previewSourceProvenanceReport",
        }

    normalized_reasons = _normalized_reason_codes(rejection.get("reasonCodes"))
    if rejection.get("reasonCodes") != normalized_reasons:
        raise ArtifactBindingError(
            "human preview rejection reasonCodes are not canonical"
        )
    reviewer = str(rejection.get("reviewer") or "").strip()
    decided_at = str(rejection.get("decidedAt") or "").strip()
    notes = str(rejection.get("notes") or "").strip()
    if (
        not reviewer
        or not decided_at
        or rejection.get("reviewer") != reviewer
        or rejection.get("decidedAt") != decided_at
        or rejection.get("notes") != notes
    ):
        raise ArtifactBindingError(
            "human preview rejection review fields are not canonical"
        )

    required_fields = {
        "schemaVersion",
        "artifactType",
        "rejectionVersion",
        "decision",
        "labelSemantics",
        "productionEligible",
        *expected_dataset_bindings.keys(),
        "sourceIntervalMs",
        "reviewMedia",
        "reviewer",
        "decidedAt",
        "reasonCodes",
        "notes",
        *provenance_fields,
        "contentHash",
    }
    if set(rejection) != required_fields:
        raise ArtifactBindingError(
            "human preview rejection body is not canonical"
        )
    return rejection


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


def _verify_candidate_decision(
    artifact: Dict,
    *,
    replay_transcript: Dict | None = None,
    transcript_timing_hash: str | None = None,
) -> Dict:
    decision = verify_seal(artifact, "CandidateDecision")
    if decision.get("schemaVersion") != 1 or decision.get("decision") != "approved":
        raise ArtifactBindingError("capture requires an approved CandidateDecision")
    candidate_hash_value = _decision_candidate_hash(decision)
    candidate = decision.get("candidate")
    candidate_input = {
        **candidate,
        "candidate_hash": candidate_hash_value,
    }
    if decision.get("hookGateReport") is not None:
        candidate_input["hookGateReport"] = decision.get("hookGateReport")
    rebuilt = build_candidate_decision(
        candidate_input,
        str(decision.get("sourceHash") or ""),
        reviewer=str(decision.get("reviewer") or ""),
        decided_at=str(decision.get("decidedAt") or ""),
        ranking_manifest_hash=str(decision.get("rankingManifestHash") or ""),
        notes=str(decision.get("notes") or ""),
        replay_transcript=replay_transcript,
        transcript_timing_hash=transcript_timing_hash,
    )
    if rebuilt != decision:
        raise ArtifactBindingError("candidate decision body is not canonical")
    return decision


def _verify_v3_hook_report_matches_dataset_candidate(
    decision: Mapping[str, object],
    candidate: Mapping[str, object],
) -> None:
    decision_profile = (
        str(decision.get("contentProfile") or "").strip().lower(),
        str(decision.get("selectionProfile") or "").strip().lower(),
        str(decision.get("renderProfile") or "").strip().lower(),
        str(decision.get("formatProfile") or "").strip().lower(),
    )
    if (
        decision_profile == FEED_STOP_V3_REPLAY_PROFILE_TUPLE
        and decision.get("hookGateReport") != candidate.get("hookGateReport")
    ):
        raise ArtifactBindingError(
            "V3 CandidateDecision HookGate report differs from the ranking candidate"
        )


def build_replay_capture_label(
    dataset_artifact: Dict,
    candidate_decision: Dict,
    *,
    approved_rank: int,
) -> Dict:
    """Build one positive label exclusively from an explicit approved decision."""
    dataset = verify_replay_capture_dataset(dataset_artifact)
    transcript_manifest = dataset["replayTranscriptManifest"]
    decision = _verify_candidate_decision(
        candidate_decision,
        replay_transcript=transcript_manifest["transcript"],
        transcript_timing_hash=dataset["transcriptTimingHash"],
    )
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
    _verify_v3_hook_report_matches_dataset_candidate(decision, candidate)
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
    transcript_manifest = dataset["replayTranscriptManifest"]
    decision = _verify_candidate_decision(
        label.get("candidateDecision"),
        replay_transcript=transcript_manifest["transcript"],
        transcript_timing_hash=dataset["transcriptTimingHash"],
    )
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
    _verify_v3_hook_report_matches_dataset_candidate(decision, matching[0])
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


def write_immutable_json(path: Path, artifact: Dict) -> bool:
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


def _write_immutable_review_media(
    source_path: Path,
    destination_path: Path,
    *,
    expected_hash: str,
    expected_byte_length: int,
) -> bool:
    """Copy exact review bytes once; identical content-addressed retries pass."""

    destination_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination_path.name}.",
        suffix=".tmp",
        dir=destination_path.parent,
    )
    temporary = Path(temporary_name)
    digest = hashlib.sha256()
    byte_length = 0
    try:
        try:
            with source_path.open("rb") as source, os.fdopen(
                descriptor,
                "wb",
            ) as destination:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    destination.write(chunk)
                    digest.update(chunk)
                    byte_length += len(chunk)
                destination.flush()
                os.fsync(destination.fileno())
        except OSError as error:
            raise ArtifactBindingError("review media copy failed") from error
        if (
            digest.hexdigest() != expected_hash
            or byte_length != expected_byte_length
        ):
            raise ArtifactBindingError("review media changed during archival")
        try:
            os.link(temporary, destination_path)
        except FileExistsError:
            _, existing_hash, existing_length = _review_media_identity(
                destination_path
            )
            if (
                existing_hash != expected_hash
                or existing_length != expected_byte_length
            ):
                raise ArtifactBindingError(
                    f"immutable review media collision at {destination_path}"
                )
            return False
        _fsync_directory(destination_path.parent)
        return True
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass
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
    dataset_created = write_immutable_json(dataset_path, dataset)
    label_created = write_immutable_json(label_path, label)
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


def archive_rejected_candidate(
    ranking_manifest: Dict,
    candidate_hash_value: str,
    *,
    reviewer: str,
    decided_at: str,
    reason_codes: Sequence[str],
    evidence_dir: str | Path,
    rejected_rank: int | None = None,
    notes: str = "",
    evidence_refs: Mapping[str, object] | None = None,
    speech_cleanliness_report: Dict | None = None,
) -> Dict:
    """Persist a dataset and one append-only explicit human rejection."""

    dataset = build_replay_capture_dataset(ranking_manifest)
    rejection = build_replay_human_rejection(
        dataset,
        candidate_hash_value,
        reviewer=reviewer,
        decided_at=decided_at,
        reason_codes=reason_codes,
        rejected_rank=rejected_rank,
        notes=notes,
        evidence_refs=evidence_refs,
        speech_cleanliness_report=speech_cleanliness_report,
    )
    verify_replay_human_rejection(
        rejection,
        dataset,
        speech_cleanliness_report=speech_cleanliness_report,
    )
    root = Path(evidence_dir).expanduser()
    dataset_path = root / "datasets" / f"{dataset['rankingManifestHash']}.json"
    rejection_path = (
        root
        / "negative-labels"
        / dataset["rankingManifestHash"]
        / f"{rejection['contentHash']}.json"
    )
    dataset_created = write_immutable_json(dataset_path, dataset)
    rejection_created = write_immutable_json(rejection_path, rejection)
    return {
        "schemaVersion": 1,
        "artifactType": HUMAN_REJECTION_RECEIPT_TYPE,
        "datasetHash": dataset["contentHash"],
        "rejectionHash": rejection["contentHash"],
        "datasetPath": str(dataset_path.resolve()),
        "rejectionPath": str(rejection_path.resolve()),
        "datasetCreated": dataset_created,
        "rejectionCreated": rejection_created,
    }


def archive_rejected_preview(
    ranking_manifest: Dict,
    *,
    interval_start_ms: int,
    interval_end_ms: int,
    review_media_path: str | Path,
    review_media_duration_ms: int,
    review_media_container: str,
    reviewer: str,
    decided_at: str,
    reason_codes: Sequence[str],
    preview_source_provenance_report: Dict,
    evidence_dir: str | Path,
    notes: str = "",
) -> Dict:
    """Persist exact preview bytes and one append-only preview rejection."""

    dataset = build_replay_capture_dataset(ranking_manifest)
    source_media_path, media_hash, media_byte_length = _review_media_identity(
        review_media_path
    )
    normalized_media = _normalized_review_media(
        media_hash=media_hash,
        byte_length=media_byte_length,
        duration_ms=review_media_duration_ms,
        container=review_media_container,
    )
    rejection = build_replay_human_preview_rejection(
        dataset,
        interval_start_ms=interval_start_ms,
        interval_end_ms=interval_end_ms,
        review_media_hash=normalized_media["sha256"],
        review_media_byte_length=normalized_media["byteLength"],
        review_media_duration_ms=normalized_media["durationMs"],
        review_media_container=normalized_media["container"],
        reviewer=reviewer,
        decided_at=decided_at,
        reason_codes=reason_codes,
        preview_source_provenance_report=preview_source_provenance_report,
        notes=notes,
    )
    verify_replay_human_preview_rejection(rejection, dataset)

    root = Path(evidence_dir).expanduser()
    dataset_path = root / "datasets" / f"{dataset['rankingManifestHash']}.json"
    archived_media_path = (
        root
        / "review-media"
        / f"{normalized_media['sha256']}.{normalized_media['container']}"
    )
    rejection_path = (
        root
        / "negative-preview-labels"
        / dataset["rankingManifestHash"]
        / f"{rejection['contentHash']}.json"
    )
    dataset_created = write_immutable_json(dataset_path, dataset)
    review_media_created = _write_immutable_review_media(
        source_media_path,
        archived_media_path,
        expected_hash=normalized_media["sha256"],
        expected_byte_length=normalized_media["byteLength"],
    )
    verify_replay_human_preview_rejection(
        rejection,
        dataset,
        review_media_path=archived_media_path,
    )
    rejection_created = write_immutable_json(rejection_path, rejection)
    return {
        "schemaVersion": 1,
        "artifactType": HUMAN_PREVIEW_REJECTION_RECEIPT_TYPE,
        "datasetHash": dataset["contentHash"],
        "rejectionHash": rejection["contentHash"],
        "reviewMediaHash": normalized_media["sha256"],
        "previewSourceProvenanceHash": preview_source_provenance_report[
            "contentHash"
        ],
        "datasetPath": str(dataset_path.resolve()),
        "rejectionPath": str(rejection_path.resolve()),
        "reviewMediaPath": str(archived_media_path.resolve()),
        "datasetCreated": dataset_created,
        "rejectionCreated": rejection_created,
        "reviewMediaCreated": review_media_created,
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
