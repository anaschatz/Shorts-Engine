"""Contract tests for the isolated HookGate V4 Autoresearch lane."""

from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from research.hook_v4_autoresearch import (
    EXPECTED_CONTRACT_HASH,
    HookV4AutoresearchError,
    assess_hook_v4_readiness,
    assess_observed_control,
    canonical_hash,
    classify_source_changes,
    compare_hook_v4_evaluations,
    evaluate_hook_v4_corpus,
    load_hook_v4_contract,
    seal,
    validate_hook_v4_corpus,
    verify_run_artifact,
    verify_seal,
    workspace_source_fingerprints,
)
from shorts_generator.artifact_contracts import (
    build_candidate_decision,
    candidate_hash,
    content_hash,
)
from shorts_generator.pipeline import build_ranking_manifest
from shorts_generator.profiles import BF_VIRAL_MICRO_V1, resolve_profile_bundle
from shorts_generator.replay_capture import (
    HUMAN_PREVIEW_REJECTION_ARTIFACT_TYPE,
    HUMAN_PREVIEW_REJECTION_LEGACY_VERSION,
    HUMAN_PREVIEW_REJECTION_SEMANTICS,
    build_replay_capture_dataset,
    build_replay_capture_label,
    build_replay_human_rejection,
)


ARGUMENT_TEXT = (
    "Don't attend every argument you're invited to. Just because somebody "
    "pushes their opinion onto you to talk about any controversial topic does "
    "not mean that it's an invitation for you to mandatorily give your opinion "
    "right back."
)
ARGUMENT_OPENING = "Don't attend every argument you're invited to."
ARGUMENT_PAYOFF = (
    "Just because somebody pushes their opinion onto you to talk about any "
    "controversial topic does not mean that it's an invitation for you to "
    "mandatorily give your opinion right back."
)
UNCLEAR_TEXT = (
    "You are not a target because this changes everything for them. "
    "That is why you should finally walk away from it while they keep doing it."
)
UNCLEAR_OPENING = "You are not a target because this changes everything for them."
UNCLEAR_PAYOFF = (
    "That is why you should finally walk away from it while they keep doing it."
)


def _timed_words(text: str, duration: float = 12.0) -> list[dict]:
    raw = text.split()
    step = duration / len(raw)
    return [
        {
            "start": round(index * step, 6),
            "end": round((index + 1) * step, 6),
            "word": word,
        }
        for index, word in enumerate(raw)
    ]


def _candidate_body(*, unclear: bool) -> tuple[dict, dict]:
    text = UNCLEAR_TEXT if unclear else ARGUMENT_TEXT
    opening = UNCLEAR_OPENING if unclear else ARGUMENT_OPENING
    payoff = UNCLEAR_PAYOFF if unclear else ARGUMENT_PAYOFF
    words = _timed_words(text)
    candidate = {
        "title": "Exact governed candidate",
        "start_time": 0.0,
        "end_time": 12.0,
        "render_start_time": 0.0,
        "speech_start_time": 0.0,
        "speech_end_time": 12.0,
        "candidate_text": text,
        "begins_on_complete_word_boundary": True,
        "new_viewer_understands_opening": not unclear,
        "has_complete_ending": True,
        "has_takeaway": True,
        "opening_unit_exact_quote": opening,
        "topic_comprehension_exact_quote": opening,
        "payoff_exact_quote": payoff,
        "opening_unit_type": "rule",
        "hook_mechanism": "concrete_rule",
        "hook_semantic_topic": "interpersonal boundaries",
        "opening_claim_summary": "Not every argument deserves a response.",
        "whole_point_summary": "Pressure does not create an obligation to reply.",
        "opening_sentence_clarity_score": 40 if unclear else 94,
        "topic_explicitness_score": 35 if unclear else 92,
        "standalone_comprehension_score": 40 if unclear else 95,
        "tension_or_relevance_score": 80 if unclear else 91,
        "opening_point_coherence_score": 45 if unclear else 94,
        "payoff_resolution_score": 45 if unclear else 93,
        "single_idea_focus_score": 90 if unclear else 96,
        "lexical_delivery_strength_score": 80 if unclear else 88,
        "hook_semantic_confidence_score": 90 if unclear else 93,
        "opening_unit_is_complete_claim": True,
        "requires_external_context": unclear,
        "unresolved_deictic_reference": unclear,
        "host_or_attribution_setup": False,
        "topic_intro_only": False,
        "payoff_changes_topic": False,
        "hook_semantic_reason_codes": (
            ["requires_prior_context", "unresolved_reference"]
            if unclear
            else [
                "clear_complete_claim",
                "topic_explicit_by_opening_end",
                "opening_and_payoff_coherent",
                "payoff_resolves_opening",
            ]
        ),
        "context_dependence_score": 80 if unclear else 0,
        "generic_motivation_score": 5,
        "content_profile": "motivational_podcast",
        "selection_profile": "motivational_tension_micro_v1",
        "render_profile": "bf_editorial_inset_v1",
        "format_profile": "bf_viral_micro_v1",
        "selection_rank": 1,
        "selected_for_render": True,
        "rejected": False,
        "rejection_reasons": [],
        "source_cut_count": 0,
    }
    transcript = {
        "duration": 12.5,
        "language": "en",
        "segments": [
            {
                "start": 0.0,
                "end": 12.0,
                "text": text,
                "words": words,
            }
        ],
    }
    return candidate, transcript


def _preview_rejection(
    dataset: dict,
    *,
    reasons: list[str],
    seed: str,
) -> dict:
    payload = {
        "schemaVersion": 1,
        "artifactType": HUMAN_PREVIEW_REJECTION_ARTIFACT_TYPE,
        "rejectionVersion": HUMAN_PREVIEW_REJECTION_LEGACY_VERSION,
        "decision": "rejected",
        "labelSemantics": HUMAN_PREVIEW_REJECTION_SEMANTICS,
        "productionEligible": False,
        "datasetId": dataset["datasetId"],
        "datasetHash": dataset["contentHash"],
        "rankingManifestHash": dataset["rankingManifestHash"],
        "rankingSchemaVersion": dataset["rankingSchemaVersion"],
        "sourceId": dataset["sourceId"],
        "sourceHash": dataset["sourceHash"],
        "replayTranscriptManifestHash": dataset["replayTranscriptManifestHash"],
        "transcriptHash": dataset["transcriptHash"],
        "transcriptTimingHash": dataset["transcriptTimingHash"],
        "sourceIntervalMs": {"startMs": 0, "endMs": 12000},
        "reviewMedia": {
            "sha256": hashlib.sha256(f"preview-{seed}".encode()).hexdigest(),
            "byteLength": 1000,
            "durationMs": 12000,
            "container": "mp4",
        },
        "reviewer": "fixture-owner",
        "decidedAt": "2026-08-07T12:00:00Z",
        "reasonCodes": sorted(reasons),
        "notes": "synthetic contract test only",
    }
    return {**payload, "contentHash": content_hash(payload)}


def _governed_item(
    *,
    seed: str,
    split: str,
    decision: str,
    reasons: list[str] | None = None,
    unclear: bool = False,
) -> dict:
    source_hash = hashlib.sha256(f"source-{seed}".encode()).hexdigest()
    body, transcript = _candidate_body(unclear=unclear)
    candidate = {**body, "candidate_hash": candidate_hash(body, source_hash)}
    ranking = build_ranking_manifest(
        f"https://example.test/{seed}",
        f"/not-authority/{seed}.mp4",
        "motivational_podcast",
        [candidate],
        [candidate],
        profiles=resolve_profile_bundle(format_profile=BF_VIRAL_MICRO_V1),
        source_hash=source_hash,
        transcript=transcript,
    )
    dataset = build_replay_capture_dataset(ranking)
    exact_candidate = dataset["candidates"][0]
    candidate_hash_value = exact_candidate["candidate_hash"]
    candidate_decision = None
    if decision == "approved":
        candidate_decision = build_candidate_decision(
            exact_candidate,
            source_hash,
            reviewer="fixture-owner",
            decided_at="2026-08-07T12:00:00Z",
            ranking_manifest_hash=ranking["contentHash"],
        )
        label = build_replay_capture_label(
            dataset,
            candidate_decision,
            approved_rank=1,
        )
        authority_hash = candidate_decision["contentHash"]
    elif decision == "candidate_rejected":
        label = build_replay_human_rejection(
            dataset,
            candidate_hash_value,
            reviewer="fixture-owner",
            decided_at="2026-08-07T12:00:00Z",
            reason_codes=reasons or ["audible_backchannels"],
            rejected_rank=1,
            notes="synthetic contract test only",
        )
        authority_hash = label["contentHash"]
    elif decision == "preview_rejected":
        label = _preview_rejection(
            dataset,
            reasons=reasons or ["unclear_hook"],
            seed=seed,
        )
        authority_hash = label["contentHash"]
    else:
        raise AssertionError("unsupported fixture decision")

    item_id = canonical_hash(
        {
            "captureDatasetHash": dataset["contentHash"],
            "replayTranscriptManifestHash": dataset["replayTranscriptManifest"][
                "contentHash"
            ],
            "labelArtifactHash": label["contentHash"],
            "authorityHash": authority_hash,
            "candidateHash": candidate_hash_value,
            "split": split,
        }
    )
    item = {
        "schemaVersion": 1,
        "artifactType": "BudgetFriendlyHookV4LabeledItem",
        "itemId": item_id,
        "split": split,
        "replayCaptureDataset": dataset,
        "replayTranscriptManifest": dataset["replayTranscriptManifest"],
        "candidateHash": candidate_hash_value,
        "candidate": exact_candidate,
        "humanLabelArtifact": label,
    }
    if candidate_decision is not None:
        item["candidateDecision"] = candidate_decision
    return seal(item)


def _fixture() -> tuple[dict, dict]:
    items = [
        _governed_item(seed="train-positive", split="train", decision="approved"),
        _governed_item(
            seed="train-hook-negative",
            split="train",
            decision="preview_rejected",
            reasons=["unclear_hook", "unclear_point"],
            unclear=True,
        ),
        _governed_item(seed="eval-positive", split="evaluation", decision="approved"),
        _governed_item(
            seed="eval-hook-negative",
            split="evaluation",
            decision="preview_rejected",
            reasons=["unclear_hook", "unintelligible_speech"],
            unclear=True,
        ),
        _governed_item(
            seed="pipeline-negative",
            split="train",
            decision="candidate_rejected",
            reasons=["audible_backchannels"],
        ),
    ]
    production = load_hook_v4_contract()
    contract_body = {
        key: copy.deepcopy(value)
        for key, value in production.items()
        if key != "contentHash"
    }
    contract_body["dataReadinessGates"].update(
        {
            "minimumDistinctSources": 5,
            "minimumFormalPositiveLabels": 2,
            "minimumFormalHookNegativeLabels": 2,
            "minimumEvaluationPositiveLabels": 1,
            "minimumEvaluationHookNegativeLabels": 1,
        }
    )
    negatives = [item for item in items if "rejection" in item["humanLabelArtifact"]["artifactType"].lower()]
    contract_body["strictNegativeControls"] = [
        {
            "evidenceHash": item["humanLabelArtifact"]["contentHash"],
            "artifactType": item["humanLabelArtifact"]["artifactType"],
            "reasonCodes": item["humanLabelArtifact"]["reasonCodes"],
            "axisOwner": (
                "speech_cleanliness"
                if item["humanLabelArtifact"]["reasonCodes"] == ["audible_backchannels"]
                else "hook_gate_v4"
            ),
            "expectedPipelineDisposition": "reject",
            "hookCalibrationEligible": "unclear_hook"
            in item["humanLabelArtifact"]["reasonCodes"],
        }
        for item in negatives
    ]
    contract = seal(contract_body)
    corpus = seal(
        {
            "schemaVersion": 1,
            "artifactType": "BudgetFriendlyHookV4ReplayCorpus",
            "contractVersion": contract["contractVersion"],
            "contractHash": contract["contentHash"],
            "corpusVersion": "synthetic-contract-test-only",
            "syntheticTestOnly": True,
            "items": items,
        }
    )
    return contract, corpus


class HookV4AutoresearchTests(unittest.TestCase):
    def test_production_contract_is_sealed_and_code_pinned(self):
        contract = load_hook_v4_contract()
        self.assertEqual(contract["contentHash"], EXPECTED_CONTRACT_HASH)
        self.assertEqual(contract["evaluationLane"], "hook_gate_v4")
        self.assertEqual(contract["editableScope"], ["shorts_generator/hook_gate_v4.py"])
        self.assertNotIn("shorts_generator/semantic_closure.py", contract["editableScope"])

    def test_missing_corpus_fails_closed_as_calibration_not_ready(self):
        contract = load_hook_v4_contract()
        with tempfile.TemporaryDirectory() as directory:
            readiness = assess_hook_v4_readiness(Path(directory), contract)
        self.assertEqual(readiness["status"], "calibration_not_ready")
        self.assertFalse(readiness["baselineAllowed"])
        self.assertEqual(readiness["contractHash"], EXPECTED_CONTRACT_HASH)
        self.assertEqual(readiness["corpusError"], "dedicated_hook_v4_corpus_missing")

    def test_synthetic_fixture_is_never_product_evidence(self):
        contract, corpus = _fixture()
        production = load_hook_v4_contract()
        body = {key: value for key, value in corpus.items() if key != "contentHash"}
        body["contractHash"] = production["contentHash"]
        with self.assertRaisesRegex(
            HookV4AutoresearchError, "SYNTHETIC_EVIDENCE_FORBIDDEN"
        ):
            validate_hook_v4_corpus(seal(body), production)

    def test_authoritative_fixture_computes_locked_metrics(self):
        contract, corpus = _fixture()
        report = evaluate_hook_v4_corpus(
            corpus,
            contract,
            allow_synthetic=True,
        )
        self.assertTrue(report["calibrationReady"])
        self.assertEqual(report["metrics"]["formalPositiveRecall"], 1.0)
        self.assertEqual(report["metrics"]["formalHookNegativeSpecificity"], 1.0)
        self.assertEqual(report["metrics"]["balancedAccuracy"], 1.0)
        self.assertEqual(report["counts"]["declaredItemCount"], 5)
        self.assertEqual(report["counts"]["verifiedItemCount"], 5)
        self.assertTrue(report["strictHookControlBehavior"]["passed"])
        presence = report["strictPipelineControlEvidencePresence"]
        self.assertTrue(presence["allPresent"])
        self.assertFalse(presence["downstreamBehaviorEvaluated"])

    def test_tampered_replay_transcript_is_rejected_by_authoritative_verifier(self):
        contract, corpus = _fixture()
        body = {key: copy.deepcopy(value) for key, value in corpus.items() if key != "contentHash"}
        item = body["items"][0]
        item_body = {key: copy.deepcopy(value) for key, value in item.items() if key != "contentHash"}
        item_body["replayTranscriptManifest"]["transcript"]["segments"][0]["words"][0]["end"] += 0.1
        item_body["replayTranscriptManifest"]["contentHash"] = content_hash(
            item_body["replayTranscriptManifest"]
        )
        body["items"][0] = seal(item_body)
        with self.assertRaisesRegex(
            HookV4AutoresearchError, "AUTHORITATIVE_BINDING_INVALID"
        ):
            validate_hook_v4_corpus(seal(body), contract, allow_synthetic=True)

    def test_stale_canonical_candidate_hash_is_rejected(self):
        contract, corpus = _fixture()
        body = {key: copy.deepcopy(value) for key, value in corpus.items() if key != "contentHash"}
        item = body["items"][0]
        item_body = {key: copy.deepcopy(value) for key, value in item.items() if key != "contentHash"}
        item_body["candidate"]["opening_claim_summary"] = "tampered claim"
        body["items"][0] = seal(item_body)
        with self.assertRaisesRegex(HookV4AutoresearchError, "canonical candidate hash"):
            validate_hook_v4_corpus(seal(body), contract, allow_synthetic=True)

    def test_candidate_decision_must_match_capture_label_exactly(self):
        contract, corpus = _fixture()
        body = {key: copy.deepcopy(value) for key, value in corpus.items() if key != "contentHash"}
        item = body["items"][0]
        item_body = {key: copy.deepcopy(value) for key, value in item.items() if key != "contentHash"}
        decision_body = {
            key: value
            for key, value in item_body["candidateDecision"].items()
            if key != "contentHash"
        }
        decision_body["reviewer"] = "another-reviewer"
        item_body["candidateDecision"] = {
            **decision_body,
            "contentHash": content_hash(decision_body),
        }
        body["items"][0] = seal(item_body)
        with self.assertRaisesRegex(HookV4AutoresearchError, "exact CandidateDecision"):
            validate_hook_v4_corpus(seal(body), contract, allow_synthetic=True)

    def test_observed_manual_control_cannot_enter_formal_corpus(self):
        contract, corpus = _fixture()
        body = {key: copy.deepcopy(value) for key, value in corpus.items() if key != "contentHash"}
        item = body["items"][0]
        item_body = {key: copy.deepcopy(value) for key, value in item.items() if key != "contentHash"}
        label_body = {
            key: value
            for key, value in item_body["humanLabelArtifact"].items()
            if key != "contentHash"
        }
        label_body["labelSemantics"] = "observed_manual_approval_non_scoring"
        item_body["humanLabelArtifact"] = {
            **label_body,
            "contentHash": content_hash(label_body),
        }
        body["items"][0] = seal(item_body)
        with self.assertRaisesRegex(HookV4AutoresearchError, "AUTHORITATIVE_LABEL_INVALID"):
            validate_hook_v4_corpus(seal(body), contract, allow_synthetic=True)

    def test_comparison_rejects_every_previously_correct_eval_regression(self):
        contract, corpus = _fixture()
        # Comparison itself only accepts the production code-pinned contract.
        # Rebind the otherwise synthetic evaluation to the production contract
        # solely to exercise the locked comparison shape.
        baseline = evaluate_hook_v4_corpus(corpus, contract, allow_synthetic=True)
        production = load_hook_v4_contract()
        baseline_body = {
            key: copy.deepcopy(value)
            for key, value in baseline.items()
            if key != "contentHash"
        }
        baseline_body["contractHash"] = production["contentHash"]
        baseline_body["contractVersion"] = production["contractVersion"]
        baseline_body["evaluationLock"]["contractHash"] = production["contentHash"]
        baseline_body["evaluationLockHash"] = canonical_hash(
            baseline_body["evaluationLock"]
        )
        baseline = seal(baseline_body)
        trial_body = {
            key: copy.deepcopy(value)
            for key, value in baseline.items()
            if key != "contentHash"
        }
        correct = next(
            item for item in trial_body["evaluationOutcomes"] if item["correct"] is True
        )
        correct["actualHookDisposition"] = (
            "reject" if correct["expectedHookDisposition"] == "pass" else "pass"
        )
        correct["correct"] = False
        trial = seal(trial_body)
        comparison = compare_hook_v4_evaluations(baseline, trial, production)
        self.assertEqual(comparison["decision"], "discard")
        self.assertEqual(len(comparison["evaluationRegressionItemIds"]), 1)

    def test_comparison_rejects_changed_locked_label_even_when_resealed(self):
        contract, corpus = _fixture()
        evaluation = evaluate_hook_v4_corpus(corpus, contract, allow_synthetic=True)
        production = load_hook_v4_contract()
        body = {key: copy.deepcopy(value) for key, value in evaluation.items() if key != "contentHash"}
        body["contractHash"] = production["contentHash"]
        body["contractVersion"] = production["contractVersion"]
        body["evaluationLock"]["contractHash"] = production["contentHash"]
        body["evaluationLockHash"] = canonical_hash(body["evaluationLock"])
        baseline = seal(body)
        trial_body = {key: copy.deepcopy(value) for key, value in baseline.items() if key != "contentHash"}
        trial_body["evaluationOutcomes"][0]["evidenceHash"] = "0" * 64
        trial = seal(trial_body)
        with self.assertRaisesRegex(HookV4AutoresearchError, "locked label changed"):
            compare_hook_v4_evaluations(baseline, trial, production)

    def test_fingerprint_classifier_separates_all_three_scopes(self):
        contract = load_hook_v4_contract()
        baseline = workspace_source_fingerprints(Path(__file__).resolve().parents[1], contract)
        current = dict(baseline)
        current["shorts_generator/hook_gate_v4.py"] = "1" * 64
        current["research/hook_v4_autoresearch.py"] = "2" * 64
        current["research/new_unscoped_experiment.py"] = "3" * 64
        changes = classify_source_changes(baseline, current, contract)
        self.assertEqual(changes["editable"], ["shorts_generator/hook_gate_v4.py"])
        self.assertEqual(changes["protected"], ["research/hook_v4_autoresearch.py"])
        self.assertEqual(changes["outOfScope"], ["research/new_unscoped_experiment.py"])

    def test_observed_control_verification_remains_non_scoring(self):
        contract = load_hook_v4_contract()
        expected = contract["observedPositiveControls"][0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate_path = root / "candidate.json"
            receipt_path = root / "receipt.json"
            candidate_path.write_text(
                json.dumps(
                    {
                        "sourceHash": expected["sourceHash"],
                        "candidate": {
                            "candidate_hash": expected["candidateHash"],
                            "speech_start_time": 252.58,
                            "speech_end_time": 269.388,
                        },
                    }
                ),
                encoding="utf-8",
            )
            receipt_path.write_text(
                json.dumps(
                    {
                        "video_sha256": expected["uploadSha256"],
                        "result": {
                            "video_id": expected["uploadVideoId"],
                            "privacy_status": "public",
                        },
                    }
                ),
                encoding="utf-8",
            )
            report = assess_observed_control(
                contract,
                candidate_path=candidate_path,
                receipt_path=receipt_path,
            )
        self.assertTrue(report["metadataVerified"])
        self.assertFalse(report["formalLabel"])
        self.assertFalse(report["activationEligible"])
        self.assertFalse(report["v4Evaluable"])

    def test_recorded_runs_are_sealed_contract_bound_refusals(self):
        contract = load_hook_v4_contract()
        root = Path(__file__).resolve().parents[1]
        for filename, mode in (
            ("preflight.json", "preflight"),
            ("baseline-attempt.json", "baseline"),
        ):
            artifact = verify_run_artifact(
                json.loads(
                    (root / "research" / "hook-v4-autoresearch" / filename).read_text(
                        encoding="utf-8"
                    )
                ),
                contract,
            )
            self.assertEqual(artifact["mode"], mode)
            self.assertEqual(artifact["status"], "calibration_not_ready")
            self.assertFalse(artifact["baselineCreated"])
            self.assertEqual(artifact["contractHash"], EXPECTED_CONTRACT_HASH)
            self.assertEqual(
                artifact["readiness"]["captureEvidence"]["strictNegativeControlCount"],
                3,
            )
            self.assertEqual(
                artifact["readiness"]["captureEvidence"]["formalPositiveCount"],
                0,
            )


if __name__ == "__main__":
    unittest.main()
