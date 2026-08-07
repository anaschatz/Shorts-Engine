"""Governed offline Autoresearch lane for HookGate V4 policy changes.

This lane is deliberately separate from semantic-closure Autoresearch V2.  A
corpus item is admitted only after the production replay-capture verifiers
rebuild its exact dataset, ReplayTranscriptManifest, CandidateDecision or
human-rejection authority, transcript hashes and canonical candidate hash.
Observed/manual controls never become formal positives.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Dict, Mapping, Optional

from shorts_generator.artifact_contracts import (
    ArtifactBindingError,
    candidate_hash as authoritative_candidate_hash,
    canonical_json as authoritative_canonical_json,
    verify_replay_transcript_manifest,
)
from shorts_generator.hook_gate_v4 import evaluate_hook_gate_v4
from shorts_generator.replay_capture import (
    HUMAN_PREVIEW_REJECTION_ARTIFACT_TYPE,
    HUMAN_REJECTION_ARTIFACT_TYPE,
    LABEL_ARTIFACT_TYPE,
    verify_replay_capture_dataset,
    verify_replay_capture_label,
    verify_replay_human_preview_rejection,
    verify_replay_human_rejection,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONTRACT_PATH = Path(__file__).with_name(
    "hook-v4-autoresearch-contract.json"
)
HOOK_V4_AUTORESEARCH_VERSION = "bf-hook-v4-autoresearch-v1.1.0"
HOOK_V4_EVALUATION_VERSION = "bf-hook-v4-evaluation-v1.1.0"
HOOK_V4_CORPUS_TYPE = "BudgetFriendlyHookV4ReplayCorpus"
HOOK_V4_ITEM_TYPE = "BudgetFriendlyHookV4LabeledItem"

# Code-owned pin.  load_hook_v4_contract refuses a self-consistently resealed
# contract unless it matches this reviewed digest.
EXPECTED_CONTRACT_HASH = "36fdf8591981e3dc57dba20e670dfa2eca42aae1323d11cd15d82a3e0d529012"

_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_HOOK_REJECTION_CODES = frozenset(
    {
        "unclear_hook",
        "unclear_point",
        "requires_previous_context",
        "context_dependent_opening",
        "incomplete_hook",
        "generic_hook",
    }
)

# Protected evaluator-owned list. Coverage cannot be weakened by editing the
# gate under experiment.
HOOK_V4_CANONICAL_INPUT_FIELDS = (
    "opening_unit_exact_quote",
    "topic_comprehension_exact_quote",
    "payoff_exact_quote",
    "opening_unit_type",
    "hook_mechanism",
    "hook_semantic_topic",
    "opening_claim_summary",
    "whole_point_summary",
    "opening_sentence_clarity_score",
    "topic_explicitness_score",
    "standalone_comprehension_score",
    "tension_or_relevance_score",
    "opening_point_coherence_score",
    "payoff_resolution_score",
    "single_idea_focus_score",
    "lexical_delivery_strength_score",
    "hook_semantic_confidence_score",
    "opening_unit_is_complete_claim",
    "requires_external_context",
    "unresolved_deictic_reference",
    "host_or_attribution_setup",
    "topic_intro_only",
    "payoff_changes_topic",
    "hook_semantic_reason_codes",
)


class HookV4AutoresearchError(ValueError):
    """Stable fail-closed research-contract error."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _fail(code: str, message: str) -> None:
    raise HookV4AutoresearchError(code, message)


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        _fail("NON_CANONICAL_JSON", str(error))
    raise AssertionError("unreachable")


def canonical_hash(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def seal(payload: Mapping[str, object]) -> Dict[str, object]:
    body = dict(payload)
    body.pop("contentHash", None)
    return {**body, "contentHash": canonical_hash(body)}


def verify_seal(payload: Mapping[str, object], *, field: str) -> Dict:
    if not isinstance(payload, Mapping):
        _fail("INVALID_SEALED_ARTIFACT", f"{field} must be an object")
    value = dict(payload)
    declared = str(value.get("contentHash") or "").strip().lower()
    body = {key: item for key, item in value.items() if key != "contentHash"}
    if not _SHA256_RE.fullmatch(declared) or declared != canonical_hash(body):
        _fail("INVALID_SEAL", f"{field}.contentHash does not match its body")
    return value


def _positive_integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        _fail("INVALID_CONTRACT", f"{field} must be an integer >= 1")
    return value


def _unit_interval(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("INVALID_CONTRACT", f"{field} must be numeric")
    number = float(value)
    if not math.isfinite(number) or not 0.0 <= number <= 1.0:
        _fail("INVALID_CONTRACT", f"{field} must be between 0 and 1")
    return number


def _validate_contract(payload: object, *, allow_test_override: bool = False) -> Dict:
    if not isinstance(payload, Mapping):
        _fail("INVALID_CONTRACT", "root must be an object")
    contract = verify_seal(payload, field="contract")
    if contract.get("artifactType") != "BudgetFriendlyHookV4AutoresearchContract":
        _fail("INVALID_CONTRACT", "unexpected artifactType")
    if contract.get("schemaVersion") != 1:
        _fail("INVALID_CONTRACT", "only schemaVersion 1 is supported")
    if contract.get("contractVersion") != HOOK_V4_AUTORESEARCH_VERSION:
        _fail("INVALID_CONTRACT", "unsupported contractVersion")
    if contract.get("evaluatorVersion") != HOOK_V4_EVALUATION_VERSION:
        _fail("INVALID_CONTRACT", "unsupported evaluatorVersion")
    if contract.get("evaluationLane") != "hook_gate_v4":
        _fail("INVALID_CONTRACT", "evaluationLane must be hook_gate_v4")
    if not allow_test_override and contract["contentHash"] != EXPECTED_CONTRACT_HASH:
        _fail("CONTRACT_DIGEST_MISMATCH", "contract differs from code-owned digest")

    gates = contract.get("dataReadinessGates")
    if not isinstance(gates, dict):
        _fail("INVALID_CONTRACT", "dataReadinessGates is required")
    for key in (
        "minimumDistinctSources",
        "minimumFormalPositiveLabels",
        "minimumFormalHookNegativeLabels",
        "minimumEvaluationPositiveLabels",
        "minimumEvaluationHookNegativeLabels",
    ):
        _positive_integer(gates.get(key), f"dataReadinessGates.{key}")
    for key in (
        "minimumExactLabelBindingCoverage",
        "minimumHookV4SemanticEvidenceCoverage",
    ):
        _unit_interval(gates.get(key), f"dataReadinessGates.{key}")
    if gates.get("requireSourceDisjointSplits") is not True:
        _fail("INVALID_CONTRACT", "source-disjoint splits must be required")

    editable = contract.get("editableScope")
    protected = contract.get("protectedScope")
    if editable != ["shorts_generator/hook_gate_v4.py"]:
        _fail("INVALID_CONTRACT", "Hook policy is the only editable file")
    if not isinstance(protected, list) or not protected:
        _fail("INVALID_CONTRACT", "protectedScope is required")
    if set(editable) & set(protected):
        _fail("INVALID_CONTRACT", "editable and protected scopes overlap")

    controls = contract.get("strictNegativeControls")
    if not isinstance(controls, list) or len(controls) != 3:
        _fail("INVALID_CONTRACT", "exactly three sealed negative controls are required")
    seen = set()
    for control in controls:
        if not isinstance(control, dict):
            _fail("INVALID_CONTRACT", "negative control must be an object")
        digest = _sha256(control.get("evidenceHash"), "negative control evidenceHash")
        if digest in seen:
            _fail("INVALID_CONTRACT", "negative control hashes must be unique")
        seen.add(digest)
        if not isinstance(control.get("reasonCodes"), list) or not control["reasonCodes"]:
            _fail("INVALID_CONTRACT", "negative controls require reasonCodes")
        if control.get("expectedPipelineDisposition") != "reject":
            _fail("INVALID_CONTRACT", "negative controls must remain pipeline rejects")

    observed = contract.get("observedPositiveControls")
    if not isinstance(observed, list) or len(observed) != 1:
        _fail("INVALID_CONTRACT", "one observed control is required")
    if (
        observed[0].get("formalLabel") is not False
        or observed[0].get("activationEligible") is not False
        or observed[0].get("labelSemantics")
        != "observed_manual_approval_non_scoring"
    ):
        _fail("INVALID_CONTRACT", "observed control must remain non-scoring")
    return contract


def load_hook_v4_contract(path: Path = DEFAULT_CONTRACT_PATH) -> Dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        _fail("CONTRACT_UNAVAILABLE", str(error))
    return _validate_contract(payload)


def _sha256(value: object, field: str) -> str:
    normalized = str(value or "").strip().lower().removeprefix("sha256:")
    if not _SHA256_RE.fullmatch(normalized):
        _fail("INVALID_CORPUS", f"{field} must be a SHA-256 digest")
    return normalized


def _finite(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail("INVALID_CORPUS", f"{field} must be numeric")
    number = float(value)
    if not math.isfinite(number):
        _fail("INVALID_CORPUS", f"{field} must be finite")
    return number


def _candidate_interval_ms(candidate: Mapping[str, object]) -> Dict[str, int]:
    start = _finite(
        candidate.get("speech_start_time", candidate.get("start_time")),
        "candidate speech start",
    )
    end = _finite(
        candidate.get("speech_end_time", candidate.get("end_time")),
        "candidate speech end",
    )
    if start < 0.0 or end <= start:
        _fail("INVALID_CORPUS", "candidate speech interval is invalid")
    return {"startMs": round(start * 1000.0), "endMs": round(end * 1000.0)}


def _has_v4_semantic_inputs(candidate: Mapping[str, object]) -> bool:
    for field in HOOK_V4_CANONICAL_INPUT_FIELDS:
        if field not in candidate or candidate.get(field) is None:
            return False
        if isinstance(candidate.get(field), str) and not str(candidate[field]).strip():
            return False
    return True


def _timed_words(transcript_manifest: Mapping[str, object]) -> list[Dict]:
    words = []
    for segment in transcript_manifest["transcript"]["segments"]:
        for word in segment.get("words") or []:
            words.append(
                {
                    "start": word["start"],
                    "end": word["end"],
                    "word": word.get("word", word.get("text")),
                }
            )
    if not words:
        _fail("INVALID_CORPUS", "verified transcript contains no timed words")
    return words


def _strict_equal(left: object, right: object) -> bool:
    return _canonical_json(left) == _canonical_json(right)


def _matching_dataset_candidate(
    dataset: Mapping[str, object],
    candidate_hash_value: str,
) -> Dict:
    matches = [
        candidate
        for candidate in dataset.get("candidates") or []
        if isinstance(candidate, dict)
        and str(candidate.get("candidate_hash") or "") == candidate_hash_value
    ]
    if len(matches) != 1:
        _fail("LABEL_BINDING_MISMATCH", "candidate is not unique in verified dataset")
    return dict(matches[0])


def _verify_item(raw: object, index: int) -> Dict:
    item = verify_seal(raw, field=f"items[{index}]")
    if item.get("artifactType") != HOOK_V4_ITEM_TYPE or item.get("schemaVersion") != 1:
        _fail("INVALID_CORPUS", f"items[{index}] has an unsupported contract")
    if item.get("split") not in {"train", "evaluation"}:
        _fail("INVALID_CORPUS", f"items[{index}].split is invalid")
    try:
        dataset = verify_replay_capture_dataset(item.get("replayCaptureDataset"))
        transcript_manifest = verify_replay_transcript_manifest(
            item.get("replayTranscriptManifest"),
            source_hash=dataset["sourceHash"],
            require_timed_words=True,
        )
    except (ArtifactBindingError, TypeError, KeyError) as error:
        _fail("AUTHORITATIVE_BINDING_INVALID", str(error))
    if not _strict_equal(transcript_manifest, dataset.get("replayTranscriptManifest")):
        _fail("LABEL_BINDING_MISMATCH", "item transcript differs from capture dataset")

    source_hash = _sha256(dataset.get("sourceHash"), "dataset.sourceHash")
    transcript_hash = _sha256(
        transcript_manifest.get("transcriptTimingHash"),
        "transcriptTimingHash",
    )
    candidate = item.get("candidate")
    if not isinstance(candidate, dict):
        _fail("INVALID_CORPUS", "item candidate is required")
    try:
        computed_candidate_hash = authoritative_candidate_hash(candidate, source_hash)
    except (ArtifactBindingError, TypeError, ValueError) as error:
        _fail("AUTHORITATIVE_BINDING_INVALID", str(error))
    declared_candidate_hash = _sha256(
        item.get("candidateHash"), "item.candidateHash"
    )
    if (
        computed_candidate_hash != declared_candidate_hash
        or str(candidate.get("candidate_hash") or "") != declared_candidate_hash
    ):
        _fail("LABEL_BINDING_MISMATCH", "canonical candidate hash is stale")

    label = item.get("humanLabelArtifact")
    if not isinstance(label, dict):
        _fail("INVALID_CORPUS", "humanLabelArtifact is required")
    artifact_type = str(label.get("artifactType") or "")
    candidate_decision = None
    reason_codes: list[str] = []
    if artifact_type == LABEL_ARTIFACT_TYPE:
        try:
            verified_label = verify_replay_capture_label(label, dataset)
        except (ArtifactBindingError, TypeError, KeyError) as error:
            _fail("AUTHORITATIVE_LABEL_INVALID", str(error))
        candidate_decision = item.get("candidateDecision")
        if not isinstance(candidate_decision, dict) or not _strict_equal(
            candidate_decision,
            verified_label.get("candidateDecision"),
        ):
            _fail("LABEL_BINDING_MISMATCH", "exact CandidateDecision is missing")
        authority_hash = _sha256(
            candidate_decision.get("contentHash"), "CandidateDecision.contentHash"
        )
        label_candidate_hash = _sha256(
            verified_label.get("candidateHash"), "label.candidateHash"
        )
        if label_candidate_hash != declared_candidate_hash:
            _fail("LABEL_BINDING_MISMATCH", "approval references another candidate")
        expected_candidate = _matching_dataset_candidate(dataset, label_candidate_hash)
        decision = "approved"
        semantics = "explicit_human_approval"
        binding_type = "candidate_hash_exact"
    elif artifact_type == HUMAN_REJECTION_ARTIFACT_TYPE:
        if "candidateDecision" in item:
            _fail("INVALID_CORPUS", "rejection cannot carry CandidateDecision")
        try:
            verified_label = verify_replay_human_rejection(label, dataset)
        except (ArtifactBindingError, TypeError, KeyError) as error:
            _fail("AUTHORITATIVE_LABEL_INVALID", str(error))
        authority_hash = _sha256(
            verified_label.get("contentHash"), "rejection.contentHash"
        )
        label_candidate_hash = _sha256(
            verified_label.get("candidateHash"), "rejection.candidateHash"
        )
        if label_candidate_hash != declared_candidate_hash:
            _fail("LABEL_BINDING_MISMATCH", "rejection references another candidate")
        expected_candidate = _matching_dataset_candidate(dataset, label_candidate_hash)
        reason_codes = list(verified_label.get("reasonCodes") or [])
        decision = "rejected"
        semantics = "explicit_human_rejection"
        binding_type = "candidate_hash_exact"
    elif artifact_type == HUMAN_PREVIEW_REJECTION_ARTIFACT_TYPE:
        if "candidateDecision" in item:
            _fail("INVALID_CORPUS", "preview rejection cannot carry CandidateDecision")
        try:
            verified_label = verify_replay_human_preview_rejection(label, dataset)
        except (ArtifactBindingError, TypeError, KeyError) as error:
            _fail("AUTHORITATIVE_LABEL_INVALID", str(error))
        authority_hash = _sha256(
            verified_label.get("contentHash"), "preview rejection.contentHash"
        )
        if verified_label.get("sourceIntervalMs") != _candidate_interval_ms(candidate):
            _fail("LABEL_BINDING_MISMATCH", "preview interval differs from candidate")
        expected_candidate = candidate
        reason_codes = list(verified_label.get("reasonCodes") or [])
        decision = "rejected"
        semantics = "explicit_human_preview_rejection"
        binding_type = "source_interval_exact"
    else:
        _fail("NON_FORMAL_LABEL", "label artifact is not authoritative")

    if not _strict_equal(candidate, expected_candidate):
        _fail("LABEL_BINDING_MISMATCH", "candidate differs from authoritative record")
    if decision == "rejected" and not reason_codes:
        _fail("INVALID_CORPUS", "human rejection requires reasonCodes")

    label_hash = _sha256(verified_label.get("contentHash"), "label.contentHash")
    expected_item_id = canonical_hash(
        {
            "captureDatasetHash": dataset["contentHash"],
            "replayTranscriptManifestHash": transcript_manifest["contentHash"],
            "labelArtifactHash": label_hash,
            "authorityHash": authority_hash,
            "candidateHash": declared_candidate_hash,
            "split": item["split"],
        }
    )
    if _sha256(item.get("itemId"), "item.itemId") != expected_item_id:
        _fail("LABEL_BINDING_MISMATCH", "itemId does not bind authoritative evidence")

    expected_fields = {
        "schemaVersion",
        "artifactType",
        "itemId",
        "split",
        "replayCaptureDataset",
        "replayTranscriptManifest",
        "candidateHash",
        "candidate",
        "humanLabelArtifact",
        "contentHash",
    }
    if candidate_decision is not None:
        expected_fields.add("candidateDecision")
    if set(item) != expected_fields:
        _fail("INVALID_CORPUS", "labeled item body is not canonical")

    return {
        "item": item,
        "itemId": expected_item_id,
        "split": item["split"],
        "sourceHash": source_hash,
        "transcriptTimingHash": transcript_hash,
        "candidateHash": declared_candidate_hash,
        "candidate": dict(candidate),
        "timedWords": _timed_words(transcript_manifest),
        "humanLabel": {
            "decision": decision,
            "labelSemantics": semantics,
            "evidenceHash": authority_hash,
            "bindingArtifactHash": label_hash,
            "evidenceArtifactType": (
                "CandidateDecision" if candidate_decision is not None else artifact_type
            ),
            "reasonCodes": reason_codes,
            "bindingType": binding_type,
        },
    }


def validate_hook_v4_corpus(
    payload: object,
    contract: Mapping[str, object],
    *,
    allow_synthetic: bool = False,
) -> Dict:
    verified_contract = _validate_contract(
        contract,
        allow_test_override=allow_synthetic,
    )
    if not isinstance(payload, Mapping):
        _fail("INVALID_CORPUS", "root must be an object")
    corpus = verify_seal(payload, field="corpus")
    if corpus.get("artifactType") != HOOK_V4_CORPUS_TYPE:
        _fail("INVALID_CORPUS", f"artifactType must be {HOOK_V4_CORPUS_TYPE}")
    if corpus.get("schemaVersion") != 1:
        _fail("INVALID_CORPUS", "only schemaVersion 1 is supported")
    if corpus.get("contractHash") != verified_contract["contentHash"]:
        _fail("INVALID_CORPUS", "corpus references another contract hash")
    if corpus.get("contractVersion") != verified_contract["contractVersion"]:
        _fail("INVALID_CORPUS", "corpus references another contract version")
    if corpus.get("syntheticTestOnly") is True and not allow_synthetic:
        _fail("SYNTHETIC_EVIDENCE_FORBIDDEN", "test fixtures cannot be product evidence")
    items = corpus.get("items")
    if not isinstance(items, list) or not items:
        _fail("INVALID_CORPUS", "items must be a non-empty list")

    verified_items = [_verify_item(item, index) for index, item in enumerate(items)]
    item_ids = [item["itemId"] for item in verified_items]
    candidate_hashes = [item["candidateHash"] for item in verified_items]
    evidence_hashes = [item["humanLabel"]["evidenceHash"] for item in verified_items]
    if len(item_ids) != len(set(item_ids)):
        _fail("DUPLICATE_EVIDENCE", "itemId must be unique")
    if len(candidate_hashes) != len(set(candidate_hashes)):
        _fail("DUPLICATE_EVIDENCE", "candidateHash must be unique")
    if len(evidence_hashes) != len(set(evidence_hashes)):
        _fail("DUPLICATE_EVIDENCE", "human authority must be unique")
    return {
        "artifact": corpus,
        "contract": verified_contract,
        "items": verified_items,
        "declaredItemCount": len(items),
        "verifiedItemCount": len(verified_items),
    }


def _ratio(numerator: int, denominator: int) -> Optional[float]:
    return round(numerator / denominator, 6) if denominator else None


def _readiness_gates(validated: Mapping[str, object]) -> list[Dict]:
    items = list(validated["items"])
    contract = validated["contract"]
    positives = [item for item in items if item["humanLabel"]["decision"] == "approved"]
    hook_negatives = [
        item
        for item in items
        if item["humanLabel"]["decision"] == "rejected"
        and bool(set(item["humanLabel"]["reasonCodes"]) & _HOOK_REJECTION_CODES)
    ]
    evaluation_positives = [item for item in positives if item["split"] == "evaluation"]
    evaluation_negatives = [item for item in hook_negatives if item["split"] == "evaluation"]
    sources = {item["sourceHash"] for item in items}
    train_sources = {item["sourceHash"] for item in items if item["split"] == "train"}
    evaluation_sources = {
        item["sourceHash"] for item in items if item["split"] == "evaluation"
    }
    semantic_count = sum(_has_v4_semantic_inputs(item["candidate"]) for item in items)
    binding_coverage = _ratio(validated["verifiedItemCount"], validated["declaredItemCount"]) or 0.0
    semantic_coverage = _ratio(semantic_count, validated["verifiedItemCount"]) or 0.0

    controls_by_hash = {
        str(control["evidenceHash"]): control
        for control in contract["strictNegativeControls"]
    }
    exact_controls = set()
    for item in items:
        label = item["humanLabel"]
        control = controls_by_hash.get(label["evidenceHash"])
        if control and (
            label["evidenceArtifactType"] == control["artifactType"]
            and set(label["reasonCodes"]) == set(control["reasonCodes"])
            and label["decision"] == "rejected"
        ):
            exact_controls.add(label["evidenceHash"])

    policy = contract["dataReadinessGates"]

    def gate(code: str, actual: object, expected: object, passed: bool) -> Dict:
        return {"code": code, "actual": actual, "expected": expected, "passed": passed}

    return [
        gate("DISTINCT_SOURCE_COVERAGE", len(sources), policy["minimumDistinctSources"], len(sources) >= policy["minimumDistinctSources"]),
        gate("FORMAL_POSITIVE_COVERAGE", len(positives), policy["minimumFormalPositiveLabels"], len(positives) >= policy["minimumFormalPositiveLabels"]),
        gate("FORMAL_HOOK_NEGATIVE_COVERAGE", len(hook_negatives), policy["minimumFormalHookNegativeLabels"], len(hook_negatives) >= policy["minimumFormalHookNegativeLabels"]),
        gate("EVALUATION_POSITIVE_COVERAGE", len(evaluation_positives), policy["minimumEvaluationPositiveLabels"], len(evaluation_positives) >= policy["minimumEvaluationPositiveLabels"]),
        gate("EVALUATION_HOOK_NEGATIVE_COVERAGE", len(evaluation_negatives), policy["minimumEvaluationHookNegativeLabels"], len(evaluation_negatives) >= policy["minimumEvaluationHookNegativeLabels"]),
        gate("EXACT_AUTHORITATIVE_BINDING_COVERAGE", binding_coverage, policy["minimumExactLabelBindingCoverage"], binding_coverage >= policy["minimumExactLabelBindingCoverage"]),
        gate("HOOK_V4_SEMANTIC_EVIDENCE_COVERAGE", semantic_coverage, policy["minimumHookV4SemanticEvidenceCoverage"], semantic_coverage >= policy["minimumHookV4SemanticEvidenceCoverage"]),
        gate("STRICT_NEGATIVE_CONTROL_EVIDENCE_PRESENCE", sorted(exact_controls), sorted(controls_by_hash), exact_controls == set(controls_by_hash)),
        gate("SOURCE_DISJOINT_SPLITS", sorted(train_sources & evaluation_sources), [], not bool(train_sources & evaluation_sources)),
    ]


def _evaluation_lock_payload(validated: Mapping[str, object]) -> Dict:
    evaluation_items = [
        item for item in validated["items"] if item["split"] == "evaluation"
    ]
    return {
        "contractHash": validated["contract"]["contentHash"],
        "corpusHash": validated["artifact"]["contentHash"],
        "evaluationItems": [
            {
                "itemId": item["itemId"],
                "candidateHash": item["candidateHash"],
                "evidenceHash": item["humanLabel"]["evidenceHash"],
                "decision": item["humanLabel"]["decision"],
                "reasonCodes": item["humanLabel"]["reasonCodes"],
            }
            for item in sorted(evaluation_items, key=lambda value: value["itemId"])
        ],
    }


def evaluate_hook_v4_corpus(
    payload: object,
    contract: Mapping[str, object],
    *,
    allow_synthetic: bool = False,
) -> Dict:
    validated = validate_hook_v4_corpus(
        payload,
        contract,
        allow_synthetic=allow_synthetic,
    )
    gates = _readiness_gates(validated)
    if not all(gate["passed"] for gate in gates):
        _fail("CALIBRATION_NOT_READY", "formal label readiness floors are not met")

    outcomes = []
    for item in validated["items"]:
        result = evaluate_hook_gate_v4(item["candidate"], item["timedWords"])
        status = str(result.get("hookGateStatus") or "")
        label = item["humanLabel"]
        hook_negative = bool(set(label["reasonCodes"]) & _HOOK_REJECTION_CODES)
        scoring = label["decision"] == "approved" or hook_negative
        expected = (
            "pass" if label["decision"] == "approved" else "reject"
        ) if scoring else None
        exact_spans = all(
            result.get(field) is True
            for field in (
                "openingUnitExactAligned",
                "topicComprehensionExactAligned",
                "payoffExactAligned",
            )
        )
        outcomes.append(
            {
                "itemId": item["itemId"],
                "split": item["split"],
                "candidateHash": item["candidateHash"],
                "evidenceHash": label["evidenceHash"],
                "humanDecision": label["decision"],
                "reasonCodes": list(label["reasonCodes"]),
                "hookCalibrationEligible": scoring,
                "expectedHookDisposition": expected,
                "actualHookDisposition": status,
                "correct": status == expected if scoring else None,
                "exactSpansAligned": exact_spans,
                "rejectionReasons": list(result.get("hookGateRejectionReasons") or []),
                "reviewReasons": list(result.get("hookGateReviewReasons") or []),
            }
        )

    evaluation = [item for item in outcomes if item["split"] == "evaluation"]
    positives = [item for item in evaluation if item["humanDecision"] == "approved"]
    negatives = [
        item
        for item in evaluation
        if item["humanDecision"] == "rejected" and item["hookCalibrationEligible"]
    ]
    positive_passes = sum(item["actualHookDisposition"] == "pass" for item in positives)
    negative_rejects = sum(item["actualHookDisposition"] == "reject" for item in negatives)
    positive_recall = _ratio(positive_passes, len(positives))
    negative_specificity = _ratio(negative_rejects, len(negatives))
    balanced = (
        round((float(positive_recall) + float(negative_specificity)) / 2.0, 6)
        if positive_recall is not None and negative_specificity is not None
        else None
    )

    controls = {
        control["evidenceHash"]: control
        for control in validated["contract"]["strictNegativeControls"]
    }
    control_outcomes = [item for item in outcomes if item["evidenceHash"] in controls]
    hook_control_outcomes = [
        item
        for item in control_outcomes
        if controls[item["evidenceHash"]]["hookCalibrationEligible"] is True
    ]
    missing_control_evidence = sorted(
        set(controls) - {item["evidenceHash"] for item in control_outcomes}
    )
    hook_control_regressions = sorted(
        item["evidenceHash"]
        for item in hook_control_outcomes
        if item["actualHookDisposition"] != "reject"
    )
    boundary_failures = sum(not item["exactSpansAligned"] for item in outcomes)
    artifact = validated["artifact"]
    verified_contract = validated["contract"]
    evaluation_lock = _evaluation_lock_payload(validated)
    report = {
        "schemaVersion": 1,
        "artifactType": "BudgetFriendlyHookV4AutoresearchEvaluation",
        "evaluationVersion": HOOK_V4_EVALUATION_VERSION,
        "contractVersion": verified_contract["contractVersion"],
        "contractHash": verified_contract["contentHash"],
        "corpusHash": artifact["contentHash"],
        "evaluationLock": evaluation_lock,
        "evaluationLockHash": canonical_hash(evaluation_lock),
        "offlineOnly": True,
        "networkCalls": 0,
        "llmCalls": 0,
        "downloads": 0,
        "renders": 0,
        "uploads": 0,
        "dataReadinessGates": gates,
        "calibrationReady": True,
        "counts": {
            "declaredItemCount": validated["declaredItemCount"],
            "verifiedItemCount": validated["verifiedItemCount"],
            "evaluationPositiveCount": len(positives),
            "evaluationHookNegativeCount": len(negatives),
            "positivePassCount": positive_passes,
            "hookNegativeRejectCount": negative_rejects,
            "falseNegativeCount": len(positives) - positive_passes,
            "falsePositiveCount": len(negatives) - negative_rejects,
            "reviewDispositionCount": sum(item["actualHookDisposition"] == "review" for item in evaluation),
            "boundaryEvidenceFailureCount": boundary_failures,
            "strictHookControlRegressionCount": len(hook_control_regressions),
            "missingStrictControlEvidenceCount": len(missing_control_evidence),
        },
        "metrics": {
            "formalPositiveRecall": positive_recall,
            "formalHookNegativeSpecificity": negative_specificity,
            "balancedAccuracy": balanced,
        },
        "strictHookControlBehavior": {
            "requiredEvidenceHashes": sorted(
                digest
                for digest, control in controls.items()
                if control["hookCalibrationEligible"] is True
            ),
            "regressedEvidenceHashes": hook_control_regressions,
            "passed": not hook_control_regressions,
        },
        # Presence is not a downstream behavioral result.  The name and fields
        # intentionally avoid claiming that the pipeline itself was executed.
        "strictPipelineControlEvidencePresence": {
            "requiredEvidenceHashes": sorted(controls),
            "missingEvidenceHashes": missing_control_evidence,
            "allPresent": not missing_control_evidence,
            "downstreamBehaviorEvaluated": False,
        },
        "evaluationOutcomes": sorted(evaluation, key=lambda item: item["itemId"]),
        "strictControlOutcomes": sorted(
            control_outcomes, key=lambda item: item["itemId"]
        ),
    }
    return seal(report)


def _verify_evaluation(
    report: Mapping[str, object],
    contract: Mapping[str, object],
) -> Dict:
    verified_contract = _validate_contract(contract)
    value = verify_seal(report, field="evaluation")
    if value.get("artifactType") != "BudgetFriendlyHookV4AutoresearchEvaluation":
        _fail("INCOMPATIBLE_EVALUATION", "unexpected evaluation artifact")
    if value.get("evaluationVersion") != HOOK_V4_EVALUATION_VERSION:
        _fail("INCOMPATIBLE_EVALUATION", "evaluation version differs")
    if value.get("contractHash") != verified_contract["contentHash"]:
        _fail("INCOMPATIBLE_EVALUATION", "contract hash differs")
    if value.get("calibrationReady") is not True:
        _fail("INCOMPATIBLE_EVALUATION", "evaluation was not calibration-ready")
    lock = value.get("evaluationLock")
    if not isinstance(lock, dict):
        _fail("EVALUATION_LOCK_MISMATCH", "evaluation lock body is missing")
    if canonical_hash(lock) != value.get("evaluationLockHash"):
        _fail("EVALUATION_LOCK_MISMATCH", "evaluation lock hash is stale")
    if (
        lock.get("contractHash") != value.get("contractHash")
        or lock.get("corpusHash") != value.get("corpusHash")
    ):
        _fail("EVALUATION_LOCK_MISMATCH", "evaluation lock provenance differs")
    locked_items = lock.get("evaluationItems")
    outcomes = value.get("evaluationOutcomes")
    if not isinstance(locked_items, list) or not isinstance(outcomes, list):
        _fail("EVALUATION_LOCK_MISMATCH", "locked evaluation items are missing")
    locked_by_id = {
        str(item.get("itemId") or ""): item
        for item in locked_items
        if isinstance(item, dict)
    }
    outcome_by_id = {
        str(item.get("itemId") or ""): item
        for item in outcomes
        if isinstance(item, dict)
    }
    if (
        len(locked_by_id) != len(locked_items)
        or len(outcome_by_id) != len(outcomes)
        or locked_by_id.keys() != outcome_by_id.keys()
    ):
        _fail("EVALUATION_LOCK_MISMATCH", "evaluation outcome universe differs")
    for item_id, locked in locked_by_id.items():
        outcome = outcome_by_id[item_id]
        expected = {
            "itemId": outcome.get("itemId"),
            "candidateHash": outcome.get("candidateHash"),
            "evidenceHash": outcome.get("evidenceHash"),
            "decision": outcome.get("humanDecision"),
            "reasonCodes": outcome.get("reasonCodes"),
        }
        if not _strict_equal(locked, expected):
            _fail("EVALUATION_LOCK_MISMATCH", f"locked label changed: {item_id}")
    return value


def compare_hook_v4_evaluations(
    baseline: Mapping[str, object],
    trial: Mapping[str, object],
    contract: Mapping[str, object],
) -> Dict:
    before = _verify_evaluation(baseline, contract)
    after = _verify_evaluation(trial, contract)
    if before.get("corpusHash") != after.get("corpusHash"):
        _fail("INCOMPATIBLE_EVALUATION", "corpus changed")
    if before.get("evaluationLockHash") != after.get("evaluationLockHash"):
        _fail("EVALUATION_LOCK_MISMATCH", "evaluation label lock changed")
    baseline_outcomes = {
        item["itemId"]: item for item in before.get("evaluationOutcomes") or []
    }
    trial_outcomes = {
        item["itemId"]: item for item in after.get("evaluationOutcomes") or []
    }
    if baseline_outcomes.keys() != trial_outcomes.keys():
        _fail("EVALUATION_LOCK_MISMATCH", "evaluation universe changed")
    regressions = []
    additional_correct = []
    for item_id, baseline_item in baseline_outcomes.items():
        trial_item = trial_outcomes[item_id]
        immutable_fields = (
            "candidateHash",
            "evidenceHash",
            "humanDecision",
            "reasonCodes",
            "hookCalibrationEligible",
            "expectedHookDisposition",
        )
        if any(
            not _strict_equal(baseline_item.get(field), trial_item.get(field))
            for field in immutable_fields
        ):
            _fail("EVALUATION_LOCK_MISMATCH", f"locked label changed: {item_id}")
        if baseline_item.get("correct") is True and trial_item.get("correct") is not True:
            regressions.append(item_id)
        if baseline_item.get("correct") is False and trial_item.get("correct") is True:
            additional_correct.append(item_id)

    before_controls = {
        item["evidenceHash"]: item for item in before.get("strictControlOutcomes") or []
    }
    after_controls = {
        item["evidenceHash"]: item for item in after.get("strictControlOutcomes") or []
    }
    if before_controls.keys() != after_controls.keys():
        _fail("EVALUATION_LOCK_MISMATCH", "strict control evidence changed")
    hook_control_regressions = [
        digest
        for digest, baseline_item in before_controls.items()
        if baseline_item.get("hookCalibrationEligible") is True
        and baseline_item.get("correct") is True
        and after_controls[digest].get("correct") is not True
    ]
    before_counts = before["counts"]
    after_counts = after["counts"]
    review_increase = int(after_counts["reviewDispositionCount"]) - int(
        before_counts["reviewDispositionCount"]
    )
    rules = _validate_contract(contract)["keepRules"]
    gates = [
        {
            "code": "NO_PREVIOUSLY_CORRECT_EVALUATION_LABEL_REGRESSION",
            "actual": len(regressions),
            "expected": rules["maximumEvaluationLabelRegressions"],
            "passed": len(regressions) <= rules["maximumEvaluationLabelRegressions"],
        },
        {
            "code": "NO_STRICT_HOOK_CONTROL_REGRESSION",
            "actual": len(hook_control_regressions),
            "expected": rules["maximumStrictHookControlRegressions"],
            "passed": len(hook_control_regressions)
            <= rules["maximumStrictHookControlRegressions"],
        },
        {
            "code": "STRICT_CONTROL_EVIDENCE_PRESENT",
            "actual": after_counts["missingStrictControlEvidenceCount"],
            "expected": 0,
            "passed": after_counts["missingStrictControlEvidenceCount"] == 0,
        },
        {
            "code": "BOUNDARY_EVIDENCE",
            "actual": after_counts["boundaryEvidenceFailureCount"],
            "expected": rules["maximumBoundaryEvidenceFailures"],
            "passed": after_counts["boundaryEvidenceFailureCount"]
            <= rules["maximumBoundaryEvidenceFailures"],
        },
        {
            "code": "NO_REVIEW_DISPOSITION_INCREASE",
            "actual": review_increase,
            "expected": rules["maximumReviewDispositionIncrease"],
            "passed": review_increase <= rules["maximumReviewDispositionIncrease"],
        },
        {
            "code": "ADDITIONAL_CORRECT_EVALUATION_LABEL",
            "actual": len(additional_correct),
            "expected": rules["minimumAdditionalCorrectEvaluationLabels"],
            "passed": len(additional_correct)
            >= rules["minimumAdditionalCorrectEvaluationLabels"],
        },
    ]
    return seal(
        {
            "schemaVersion": 1,
            "artifactType": "BudgetFriendlyHookV4AutoresearchComparison",
            "contractVersion": before["contractVersion"],
            "contractHash": before["contractHash"],
            "corpusHash": before["corpusHash"],
            "evaluationLockHash": before["evaluationLockHash"],
            "baselineHash": before["contentHash"],
            "trialHash": after["contentHash"],
            "evaluationRegressionItemIds": sorted(regressions),
            "strictHookControlRegressionEvidenceHashes": sorted(hook_control_regressions),
            "additionalCorrectItemIds": sorted(additional_correct),
            "keepGates": gates,
            "decision": "keep" if all(gate["passed"] for gate in gates) else "discard",
        }
    )


def _read_json(path: Path) -> Dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        _fail("INVALID_EVIDENCE", f"{path.name} must contain an object")
    return value


def assess_capture_controls(
    evidence_dir: Path,
    contract: Mapping[str, object],
) -> Dict:
    verified_contract = _validate_contract(contract)
    try:
        from research.autoresearch_v2 import load_autoresearch_contract
        from research.fixture_pack_v2 import assess_capture_data_readiness

        capture = assess_capture_data_readiness(
            evidence_dir,
            load_autoresearch_contract(),
        )
    except Exception as error:
        return seal(
            {
                "schemaVersion": 1,
                "artifactType": "BudgetFriendlyHookV4CaptureControlReadiness",
                "contractHash": verified_contract["contentHash"],
                "integrityError": f"{type(error).__name__}: {error}",
                "formalPositiveCount": 0,
                "strictNegativeControlCount": 0,
                "strictNegativeControlsPresentAndExact": False,
                "v4EvaluableNegativeControlCount": 0,
            }
        )
    events = []
    for directory in ("negative-labels", "negative-preview-labels"):
        for path in sorted((evidence_dir / directory).glob("*/*.json")):
            try:
                events.append(_read_json(path))
            except (OSError, json.JSONDecodeError, HookV4AutoresearchError):
                continue
    by_hash = {str(event.get("contentHash") or ""): event for event in events}
    statuses = []
    for control in verified_contract["strictNegativeControls"]:
        event = by_hash.get(control["evidenceHash"])
        exact = bool(
            event
            and event.get("artifactType") == control["artifactType"]
            and event.get("decision") == "rejected"
            and set(event.get("reasonCodes") or []) == set(control["reasonCodes"])
        )
        statuses.append(
            {
                "evidenceHash": control["evidenceHash"],
                "axisOwner": control["axisOwner"],
                "hookCalibrationEligible": control["hookCalibrationEligible"],
                "presentAndExact": exact,
                "v4Evaluable": False,
            }
        )
    exact = capture.get("integrityError") is None and all(
        status["presentAndExact"] for status in statuses
    )
    return seal(
        {
            "schemaVersion": 1,
            "artifactType": "BudgetFriendlyHookV4CaptureControlReadiness",
            "contractHash": verified_contract["contentHash"],
            "integrityError": capture.get("integrityError"),
            "formalPositiveCount": int(capture.get("humanPositiveCount") or 0),
            "candidateRejectionCount": int(capture.get("rejectedCandidateCount") or 0),
            "previewRejectionCount": int(capture.get("rejectedSourceIntervalCount") or 0),
            "strictNegativeControlCount": sum(status["presentAndExact"] for status in statuses),
            "strictNegativeControlsPresentAndExact": exact,
            "v4EvaluableNegativeControlCount": 0,
            "controls": statuses,
            "promotedToCorpus": False,
        }
    )


def assess_observed_control(
    contract: Mapping[str, object],
    *,
    candidate_path: Optional[Path] = None,
    receipt_path: Optional[Path] = None,
) -> Dict:
    verified_contract = _validate_contract(contract)
    expected = dict(verified_contract["observedPositiveControls"][0])
    matched = False
    reason = "observed_control_artifacts_not_supplied"
    if candidate_path is not None and receipt_path is not None:
        try:
            candidate_artifact = _read_json(candidate_path)
            receipt = _read_json(receipt_path)
            candidate = dict(candidate_artifact.get("candidate") or {})
            result = dict(receipt.get("result") or {})
            matched = bool(
                candidate_artifact.get("sourceHash") == expected["sourceHash"]
                and candidate.get("candidate_hash") == expected["candidateHash"]
                and _candidate_interval_ms(candidate) == expected["sourceIntervalMs"]
                and receipt.get("video_sha256") == expected["uploadSha256"]
                and result.get("video_id") == expected["uploadVideoId"]
                and result.get("privacy_status") == "public"
            )
            reason = "observed_control_metadata_verified" if matched else "observed_control_mismatch"
        except (OSError, json.JSONDecodeError, HookV4AutoresearchError) as error:
            reason = f"observed_control_invalid:{type(error).__name__}"
    return seal(
        {
            "schemaVersion": 1,
            "artifactType": "BudgetFriendlyHookV4ObservedControlReadiness",
            "contractHash": verified_contract["contentHash"],
            "controlId": expected["controlId"],
            "labelSemantics": expected["labelSemantics"],
            "formalLabel": False,
            "activationEligible": False,
            "metadataVerified": matched,
            "v4Evaluable": False,
            "reason": reason,
        }
    )


def assess_hook_v4_readiness(
    root: Path,
    contract: Mapping[str, object],
    *,
    evidence_dir: Optional[Path] = None,
    observed_candidate_path: Optional[Path] = None,
    observed_receipt_path: Optional[Path] = None,
) -> Dict:
    verified_contract = _validate_contract(contract)
    manifest_relative = str(verified_contract["corpusManifest"])
    manifest_path = root / manifest_relative
    corpus_error = None
    gates = []
    corpus_hash = None
    if not manifest_path.is_file():
        corpus_error = "dedicated_hook_v4_corpus_missing"
    else:
        try:
            validated = validate_hook_v4_corpus(
                _read_json(manifest_path),
                verified_contract,
            )
            corpus_hash = validated["artifact"]["contentHash"]
            gates = _readiness_gates(validated)
        except (OSError, json.JSONDecodeError, HookV4AutoresearchError) as error:
            corpus_error = str(error)
    capture = (
        assess_capture_controls(evidence_dir, verified_contract)
        if evidence_dir is not None
        else seal(
            {
                "schemaVersion": 1,
                "artifactType": "BudgetFriendlyHookV4CaptureControlReadiness",
                "contractHash": verified_contract["contentHash"],
                "integrityError": None,
                "formalPositiveCount": 0,
                "strictNegativeControlCount": 0,
                "strictNegativeControlsPresentAndExact": False,
                "v4EvaluableNegativeControlCount": 0,
                "reason": "capture_inbox_not_supplied",
            }
        )
    )
    observed = assess_observed_control(
        verified_contract,
        candidate_path=observed_candidate_path,
        receipt_path=observed_receipt_path,
    )
    calibration_ready = bool(
        corpus_error is None and gates and all(gate["passed"] for gate in gates)
    )
    return seal(
        {
            "schemaVersion": 1,
            "artifactType": "BudgetFriendlyHookV4AutoresearchReadiness",
            "contractVersion": verified_contract["contractVersion"],
            "contractHash": verified_contract["contentHash"],
            "evaluationLane": "hook_gate_v4",
            "corpusManifest": manifest_relative,
            "corpusHash": corpus_hash,
            "corpusError": corpus_error,
            "dataReadinessGates": gates,
            "captureEvidence": capture,
            "observedPositiveControl": observed,
            "calibrationReady": calibration_ready,
            "status": "ready" if calibration_ready else "calibration_not_ready",
            "baselineAllowed": calibration_ready,
            "limitations": [
                "Observed/manual approval is non-scoring until a formal CandidateDecision exists.",
                "V3 and preview-only records need sealed V4 semantic evidence before replay.",
                "The semantic_closure V2 corpus is not HookGate V4 calibration evidence.",
            ],
        }
    )


def workspace_source_fingerprints(
    root: Path,
    contract: Mapping[str, object],
) -> Dict[str, str]:
    verified_contract = _validate_contract(contract)
    paths = set()
    for directory in (root / "shorts_generator", root / "research"):
        if directory.is_dir():
            for path in directory.rglob("*.py"):
                if "__pycache__" not in path.parts:
                    paths.add(path.relative_to(root).as_posix())
    for module in verified_contract.get("fastTestModules") or []:
        paths.add(str(module).replace(".", "/") + ".py")
    paths.update(str(path) for path in verified_contract["editableScope"])
    paths.update(str(path) for path in verified_contract["protectedScope"])
    fingerprints = {}
    for relative in sorted(paths):
        path = root / relative
        fingerprints[relative] = (
            hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "missing"
        )
    return fingerprints


def source_fingerprints(root: Path, contract: Mapping[str, object]) -> Dict[str, str]:
    """Compatibility alias for the bounded workspace inventory."""

    return workspace_source_fingerprints(root, contract)


def classify_source_changes(
    baseline: Mapping[str, str],
    current: Mapping[str, str],
    contract: Mapping[str, object],
) -> Dict[str, list[str]]:
    verified_contract = _validate_contract(contract)
    changed = sorted(
        path
        for path in set(baseline) | set(current)
        if baseline.get(path) != current.get(path)
    )
    editable = set(verified_contract["editableScope"])
    protected = set(verified_contract["protectedScope"])
    return {
        "changed": changed,
        "editable": [path for path in changed if path in editable],
        "protected": [path for path in changed if path in protected],
        "outOfScope": [
            path for path in changed if path not in editable and path not in protected
        ],
    }


def verify_run_artifact(
    artifact: Mapping[str, object],
    contract: Mapping[str, object],
) -> Dict:
    verified_contract = _validate_contract(contract)
    run = verify_seal(artifact, field="run")
    if run.get("artifactType") != "BudgetFriendlyHookV4AutoresearchRun":
        _fail("INVALID_RUN", "unexpected run artifact")
    if run.get("contractHash") != verified_contract["contentHash"]:
        _fail("INVALID_RUN", "run references another contract hash")
    return run


__all__ = [
    "DEFAULT_CONTRACT_PATH",
    "EXPECTED_CONTRACT_HASH",
    "HOOK_V4_AUTORESEARCH_VERSION",
    "HOOK_V4_CANONICAL_INPUT_FIELDS",
    "HookV4AutoresearchError",
    "assess_capture_controls",
    "assess_hook_v4_readiness",
    "assess_observed_control",
    "canonical_hash",
    "classify_source_changes",
    "compare_hook_v4_evaluations",
    "evaluate_hook_v4_corpus",
    "load_hook_v4_contract",
    "seal",
    "source_fingerprints",
    "validate_hook_v4_corpus",
    "verify_run_artifact",
    "verify_seal",
    "workspace_source_fingerprints",
]
