import json
import tempfile
import unittest
from pathlib import Path

from shorts_generator.artifact_contracts import (
    ArtifactBindingError,
    build_candidate_decision,
    build_edit_plan,
    build_publish_manifest,
    build_render_manifest,
    build_rights_manifest,
    build_replay_transcript_manifest,
    candidate_hash,
    content_hash,
    transcript_timing_hash,
    validate_timed_transcript,
    verify_seal,
    verify_replay_transcript_manifest,
)
from shorts_generator.experiment import build_experiment_manifest
from shorts_generator.delivery_quality import (
    DELIVERY_QUALITY_SAMPLE_RATE,
    evaluate_delivery_quality_evidence,
)
from shorts_generator.hook_gate_v4_report import build_hook_gate_v4_report
from shorts_generator.hook_gate_v4 import transcript_word_timing_hash
from shorts_generator.originality import evaluate_originality
from shorts_generator.speech_cleanliness import (
    evaluate_speech_cleanliness_evidence,
)
from shorts_generator.spoken_clarity import evaluate_spoken_clarity_evidence
from shorts_generator.profiles import (
    DELIVERY_QUALITY_TRUSTED_PROVIDER_IDENTITY,
    SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY,
)
from tests.test_hook_gate_v4 import ARGUMENT_OPENING, rankable_v4_candidate


SOURCE_HASH = "a" * 64
RANKING_HASH = "d" * 64


def candidate():
    value = {
        "start_time": 10.0,
        "end_time": 20.75,
        "title": "Discipline creates freedom",
        "hook_sentence": "Discipline is not a prison.",
        "final_takeaway_sentence": "It creates freedom.",
        "candidate_text": "Discipline removes daily negotiation and creates freedom.",
        "content_profile": "motivational_podcast",
        "selection_profile": "motivational_tension_micro_v1",
        "render_profile": "bf_editorial_inset_v1",
        "format_profile": "bf_viral_micro_v1",
        "rejected": False,
        "rejection_reasons": [],
        "source_cut_count": 0,
    }
    return {**value, "candidate_hash": candidate_hash(value, SOURCE_HASH)}


def feed_stop_candidate(
    *,
    format_profile="bf_feed_stop_format_v2",
    clarity_provider_identity=None,
):
    value = {
        key: item for key, item in candidate().items() if key != "candidate_hash"
    }
    value.update(
        {
            "end_time": 33.0,
            "speech_start_time": 10.0,
            "speech_end_time": 33.0,
            "selection_profile": "bf_feed_stop_v1",
            "render_profile": "bf_editorial_inset_v2",
            "format_profile": format_profile,
            "hook_sentence": "Boundaries protect your peace.",
            "final_takeaway_sentence": "Boundaries protect your peace.",
            "semantic_closure_exact_quote": "Boundaries protect your peace.",
        }
    )
    report = evaluate_speech_cleanliness_evidence(
        source_hash=SOURCE_HASH,
        transcript_timing_hash="b" * 64,
        speech_start=10.0,
        speech_end=33.0,
        lexical_fillers=[],
        uncovered_vocalizations=[],
        prompted_fillers=[],
        provider_identity={"provider": "test"},
    )
    value.update(
        {
            "speechCleanlinessReport": report,
            "speechCleanlinessStatus": report["status"],
            "speechCleanlinessEligible": report["eligible"],
            "speechCleanlinessRejectionReasons": report["rejectionReasons"],
            "speechCleanlinessReviewReasons": report["reviewReasons"],
            "speech_cleanliness_status": report["status"],
            "speech_cleanliness_eligible": report["eligible"],
            "speech_cleanliness_decision_version": report["decisionVersion"],
            "speech_cleanliness_reject_reasons": report["rejectionReasons"],
            "speech_cleanliness_review_reasons": report["reviewReasons"],
            "speech_cleanliness_deterministic_reasons": report[
                "deterministicReasons"
            ],
            "speech_cleanliness_provider_status": report["providerStatus"],
            "speech_cleanliness_lexical_filler_count": report[
                "lexicalFillerCount"
            ],
            "speech_cleanliness_uncovered_vocalization_count": report[
                "uncoveredVocalizationCount"
            ],
            "speech_cleanliness_prompted_filler_count": report[
                "promptedFillerCount"
            ],
        }
    )
    if format_profile == "bf_feed_stop_format_v1":
        return {**value, "candidate_hash": candidate_hash(value, SOURCE_HASH)}
    clarity_report = evaluate_spoken_clarity_evidence(
        source_hash=SOURCE_HASH,
        transcript_timing_hash="b" * 64,
        speech_start=10.0,
        speech_end=33.0,
        reference_words=[
            {"text": "Boundaries", "start": 10.0, "end": 10.4},
            {"text": "protect", "start": 10.5, "end": 10.9},
            {"text": "your", "start": 11.0, "end": 11.2},
            {
                "text": "peace.",
                "start": 11.3,
                "end": 11.8,
                "sentenceBoundaryAfter": True,
            },
        ],
        point_exact_quote="Boundaries protect your peace.",
        opening_asr_words=[
            {"text": "Boundaries", "confidence": 0.98},
            {"text": "protect", "confidence": 0.98},
            {"text": "your", "confidence": 0.98},
            {"text": "peace", "confidence": 0.98},
        ],
        provider_identity=(
            clarity_provider_identity
            if clarity_provider_identity is not None
            else SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY
        ),
    )
    clarity_counts = clarity_report["counts"]
    opening_asr = clarity_report["evidence"]["openingAsr"]
    value.update(
        {
            "spokenClarityReport": clarity_report,
            "spokenClarityStatus": clarity_report["status"],
            "spokenClarityEligible": clarity_report["eligible"],
            "spokenClarityRejectionReasons": clarity_report[
                "rejectionReasons"
            ],
            "spokenClarityReviewReasons": clarity_report["reviewReasons"],
            "spoken_clarity_decision_version": clarity_report[
                "decisionVersion"
            ],
            "spoken_clarity_status": clarity_report["status"],
            "spoken_clarity_eligible": clarity_report["eligible"],
            "spoken_clarity_reject_reasons": clarity_report[
                "rejectionReasons"
            ],
            "spoken_clarity_review_reasons": clarity_report["reviewReasons"],
            "spoken_clarity_deterministic_reasons": clarity_report[
                "deterministicReasons"
            ],
            "spoken_clarity_provider_status": clarity_report["providerStatus"],
            "spoken_clarity_adjacent_duplicate_count": clarity_counts[
                "adjacentDuplicates"
            ],
            "spoken_clarity_repeated_phrase_count": clarity_counts[
                "repeatedPhraseRestarts"
            ],
            "spoken_clarity_searching_pause_count": clarity_counts[
                "searchingInternalPauses"
            ],
            "spoken_clarity_opening_asr_mean_confidence": opening_asr[
                "meanWordConfidence"
            ],
            "spoken_clarity_opening_asr_low_ratio": opening_asr[
                "lowConfidenceWordRatio"
            ],
            "spoken_clarity_opening_asr_token_match_ratio": opening_asr[
                "tokenMatchRatio"
            ],
        }
    )
    return {**value, "candidate_hash": candidate_hash(value, SOURCE_HASH)}


def feed_stop_v3_candidate(
    *,
    source_hash=SOURCE_HASH,
    point_exact_quote=ARGUMENT_OPENING,
    opening_asr_confidence=0.98,
    delivery_provider_identity=None,
    hook_source_hash=None,
    hook_transcript_timing_hash=None,
    evidence_transcript_timing_hash=None,
):
    """Build one exact V3 research-approval fixture and its transcript."""

    hook_candidate, transcript = rankable_v4_candidate()
    hook_candidate.pop("hookGateReport", None)
    transcript_hash = (
        evidence_transcript_timing_hash
        or transcript_timing_hash(transcript)
    )
    value = {
        **hook_candidate,
        "candidate_text": transcript["segments"][0]["text"],
        "content_profile": "motivational_podcast",
        "selection_profile": "bf_feed_stop_v2",
        "render_profile": "bf_editorial_inset_v3",
        "format_profile": "bf_feed_stop_format_v3",
        "selection_rank": 1,
        "rejected": False,
        "rejection_reasons": [],
        "source_cut_count": 0,
    }
    speech_start = float(value["speech_start_time"])
    speech_end = float(value["speech_end_time"])
    words = [
        {
            "text": word["word"],
            "start": word["start"],
            "end": word["end"],
        }
        for word in transcript["segments"][0]["words"]
    ]
    opening_asr = [
        {
            "text": word["text"],
            "confidence": opening_asr_confidence,
        }
        for word in words
        if float(word["start"]) < speech_start + 2.0
    ]
    clarity = evaluate_spoken_clarity_evidence(
        source_hash=source_hash,
        transcript_timing_hash=transcript_hash,
        speech_start=speech_start,
        speech_end=speech_end,
        reference_words=words,
        point_exact_quote=point_exact_quote,
        opening_asr_words=opening_asr,
        provider_identity=SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY,
    )
    clarity_counts = clarity["counts"]
    opening_asr_evidence = clarity["evidence"]["openingAsr"]
    value.update(
        {
            "spokenClarityReport": clarity,
            "spokenClarityStatus": clarity["status"],
            "spokenClarityEligible": clarity["eligible"],
            "spokenClarityRejectionReasons": clarity["rejectionReasons"],
            "spokenClarityReviewReasons": clarity["reviewReasons"],
            "spoken_clarity_decision_version": clarity["decisionVersion"],
            "spoken_clarity_status": clarity["status"],
            "spoken_clarity_eligible": clarity["eligible"],
            "spoken_clarity_reject_reasons": clarity["rejectionReasons"],
            "spoken_clarity_review_reasons": clarity["reviewReasons"],
            "spoken_clarity_deterministic_reasons": clarity[
                "deterministicReasons"
            ],
            "spoken_clarity_provider_status": clarity["providerStatus"],
            "spoken_clarity_adjacent_duplicate_count": clarity_counts[
                "adjacentDuplicates"
            ],
            "spoken_clarity_repeated_phrase_count": clarity_counts[
                "repeatedPhraseRestarts"
            ],
            "spoken_clarity_searching_pause_count": clarity_counts[
                "searchingInternalPauses"
            ],
            "spoken_clarity_opening_asr_mean_confidence": (
                opening_asr_evidence["meanWordConfidence"]
            ),
            "spoken_clarity_opening_asr_low_ratio": opening_asr_evidence[
                "lowConfidenceWordRatio"
            ],
            "spoken_clarity_opening_asr_token_match_ratio": (
                opening_asr_evidence["tokenMatchRatio"]
            ),
        }
    )
    duration = speech_end - speech_start
    acoustic = {
        "available": True,
        "sampleRate": DELIVERY_QUALITY_SAMPLE_RATE,
        "sampleCount": round(duration * DELIVERY_QUALITY_SAMPLE_RATE),
        "frameCount": max(1, round(duration / 0.05)),
        "frameWindowMilliseconds": 50.0,
        "overallRmsDbfs": -22.0,
        "peakDbfs": -5.0,
        "activeFrameRatio": 0.92,
        "activeFrameThresholdDbfs": -40.0,
        "rmsDynamicRangeDb": 6.5,
        "crestFactorDb": 17.0,
    }
    delivery = evaluate_delivery_quality_evidence(
        source_hash=source_hash,
        transcript_timing_hash=transcript_hash,
        speech_start=speech_start,
        speech_end=speech_end,
        timed_words=words,
        spoken_clarity_report=clarity,
        acoustic_measurements=acoustic,
        provider_identity=(
            delivery_provider_identity
            if delivery_provider_identity is not None
            else DELIVERY_QUALITY_TRUSTED_PROVIDER_IDENTITY
        ),
    )
    value.update(
        {
            "deliveryQualityReport": delivery,
            "deliveryQualityStatus": delivery["status"],
            "deliveryQualityEligible": delivery["eligible"],
            "deliveryQualityStrength": delivery["deliveryStrength"],
            "deliveryQualityRejectionReasons": delivery[
                "rejectionReasons"
            ],
            "deliveryQualityReviewReasons": delivery["reviewReasons"],
            "delivery_quality_decision_version": delivery["decisionVersion"],
            "delivery_quality_status": delivery["status"],
            "delivery_quality_eligible": delivery["eligible"],
            "delivery_quality_strength": delivery["deliveryStrength"],
            "delivery_quality_reject_reasons": delivery["rejectionReasons"],
            "delivery_quality_review_reasons": delivery["reviewReasons"],
            "delivery_quality_provider_status": delivery["providerStatus"],
        }
    )
    cleanliness = evaluate_speech_cleanliness_evidence(
        source_hash=source_hash,
        transcript_timing_hash=transcript_hash,
        speech_start=speech_start,
        speech_end=speech_end,
        lexical_fillers=[],
        uncovered_vocalizations=[],
        prompted_fillers=[],
        provider_identity={"provider": "test"},
    )
    value.update(
        {
            "speechCleanlinessReport": cleanliness,
            "speechCleanlinessStatus": cleanliness["status"],
            "speechCleanlinessEligible": cleanliness["eligible"],
            "speechCleanlinessRejectionReasons": cleanliness[
                "rejectionReasons"
            ],
            "speechCleanlinessReviewReasons": cleanliness["reviewReasons"],
            "speech_cleanliness_status": cleanliness["status"],
            "speech_cleanliness_eligible": cleanliness["eligible"],
            "speech_cleanliness_decision_version": cleanliness[
                "decisionVersion"
            ],
            "speech_cleanliness_reject_reasons": cleanliness[
                "rejectionReasons"
            ],
            "speech_cleanliness_review_reasons": cleanliness["reviewReasons"],
            "speech_cleanliness_deterministic_reasons": cleanliness[
                "deterministicReasons"
            ],
            "speech_cleanliness_provider_status": cleanliness[
                "providerStatus"
            ],
            "speech_cleanliness_lexical_filler_count": cleanliness[
                "lexicalFillerCount"
            ],
            "speech_cleanliness_uncovered_vocalization_count": cleanliness[
                "uncoveredVocalizationCount"
            ],
            "speech_cleanliness_prompted_filler_count": cleanliness[
                "promptedFillerCount"
            ],
        }
    )
    value["hookGateReport"] = build_hook_gate_v4_report(
        value,
        source_hash=hook_source_hash or source_hash,
        transcript_timing_hash=(
            hook_transcript_timing_hash
            or transcript_word_timing_hash(
                [
                    word
                    for segment in transcript["segments"]
                    for word in segment["words"]
                ]
            )
        ),
        render_settings=value,
        experiment={
            "experimentId": value.get("experiment_id"),
            "cohortId": value.get("experiment_cohort"),
            "changedAxes": value.get("changedAxes") or [],
        },
    )
    return (
        {**value, "candidate_hash": candidate_hash(value, source_hash)},
        transcript,
    )


class ArtifactContractsTests(unittest.TestCase):
    def decision(self):
        return build_candidate_decision(
            candidate(),
            SOURCE_HASH,
            reviewer="operator_1",
            decided_at="2026-07-16T12:00:00Z",
            ranking_manifest_hash=RANKING_HASH,
        )

    def test_candidate_decision_is_deterministic_and_sealed(self):
        first = self.decision()
        second = self.decision()
        self.assertEqual(first["contentHash"], second["contentHash"])
        self.assertEqual(first["candidateHash"], candidate_hash(candidate(), SOURCE_HASH))
        self.assertIs(verify_seal(first, "CandidateDecision"), first)

    def test_feed_stop_candidate_decision_preserves_exact_review_profile(self):
        feed_stop = feed_stop_candidate()

        decision = build_candidate_decision(
            feed_stop,
            SOURCE_HASH,
            reviewer="operator_1",
            decided_at="2026-08-07T12:00:00Z",
            ranking_manifest_hash=RANKING_HASH,
        )

        self.assertEqual(decision["contentProfile"], "motivational_podcast")
        self.assertEqual(decision["selectionProfile"], "bf_feed_stop_v1")
        self.assertEqual(decision["renderProfile"], "bf_editorial_inset_v2")
        self.assertEqual(decision["formatProfile"], "bf_feed_stop_format_v2")
        self.assertIs(verify_seal(decision, "CandidateDecision"), decision)

    def test_feed_stop_v1_decision_remains_compatible_without_clarity(self):
        feed_stop = feed_stop_candidate(
            format_profile="bf_feed_stop_format_v1"
        )

        decision = build_candidate_decision(
            feed_stop,
            SOURCE_HASH,
            reviewer="operator_1",
            decided_at="2026-08-07T12:00:00Z",
            ranking_manifest_hash=RANKING_HASH,
        )

        self.assertEqual(decision["formatProfile"], "bf_feed_stop_format_v1")
        self.assertNotIn("spokenClarityReport", decision["candidate"])
        self.assertIs(verify_seal(decision, "CandidateDecision"), decision)

    def test_legacy_feed_stop_decision_hashes_remain_byte_compatible(self):
        expected = {
            "bf_feed_stop_format_v1": (
                "37b4d012760c385f368228ac4bf68be22"
                "a437454b77847463ddcf663a5bac552"
            ),
            "bf_feed_stop_format_v2": (
                "ff525dd5644abe0e803443345a6d4bfcb"
                "215e290402b5d0312c58cd9ed3a7c39"
            ),
        }
        for format_profile, expected_hash in expected.items():
            with self.subTest(format_profile=format_profile):
                decision = build_candidate_decision(
                    feed_stop_candidate(format_profile=format_profile),
                    SOURCE_HASH,
                    reviewer="operator_1",
                    decided_at="2026-08-07T12:00:00Z",
                    ranking_manifest_hash=RANKING_HASH,
                )

                self.assertEqual(decision["contentHash"], expected_hash)
                self.assertNotIn("hookGateReport", decision)

    def test_feed_stop_v3_decision_binds_volatile_hook_report_at_top_level(self):
        v3, replay_transcript = feed_stop_v3_candidate()
        original_candidate_hash = v3["candidate_hash"]

        decision = build_candidate_decision(
            v3,
            SOURCE_HASH,
            reviewer="operator_1",
            decided_at="2026-08-07T12:00:00Z",
            ranking_manifest_hash=RANKING_HASH,
            replay_transcript=replay_transcript,
            transcript_timing_hash=transcript_timing_hash(replay_transcript),
        )

        self.assertEqual(
            (
                decision["contentProfile"],
                decision["selectionProfile"],
                decision["renderProfile"],
                decision["formatProfile"],
            ),
            (
                "motivational_podcast",
                "bf_feed_stop_v2",
                "bf_editorial_inset_v3",
                "bf_feed_stop_format_v3",
            ),
        )
        self.assertEqual(decision["candidateHash"], original_candidate_hash)
        self.assertEqual(decision["hookGateReport"], v3["hookGateReport"])
        self.assertEqual(
            decision["transcriptTimingHash"],
            transcript_timing_hash(replay_transcript),
        )
        self.assertNotIn("hookGateReport", decision["candidate"])
        self.assertEqual(
            v3["spokenClarityReport"]["rejectionReasons"],
            ["spoken_clarity_hook_subject_or_claim_missing"],
        )
        self.assertEqual(v3["deliveryQualityStatus"], "pass")
        self.assertIs(verify_seal(decision, "CandidateDecision"), decision)

    def test_feed_stop_v3_spoken_clarity_ignores_only_semantic_reasons(self):
        semantic_only, replay_transcript = feed_stop_v3_candidate(
            point_exact_quote="This phrase is not present anywhere"
        )
        self.assertIn(
            "spoken_clarity_point_quote_unaligned",
            semantic_only["spokenClarityReport"]["rejectionReasons"],
        )
        self.assertEqual(semantic_only["deliveryQualityStatus"], "pass")

        decision = build_candidate_decision(
            semantic_only,
            SOURCE_HASH,
            reviewer="operator_1",
            decided_at="2026-08-07T12:00:00Z",
            ranking_manifest_hash=RANKING_HASH,
            replay_transcript=replay_transcript,
            transcript_timing_hash=transcript_timing_hash(replay_transcript),
        )
        self.assertEqual(decision["formatProfile"], "bf_feed_stop_format_v3")

        acoustically_unclear, replay_transcript = feed_stop_v3_candidate(
            opening_asr_confidence=0.10
        )
        self.assertIn(
            "spoken_clarity_opening_asr_severely_unclear",
            acoustically_unclear["spokenClarityReport"]["rejectionReasons"],
        )
        with self.assertRaisesRegex(
            ArtifactBindingError,
            "acoustic/fluency evidence is not eligible",
        ):
            build_candidate_decision(
                acoustically_unclear,
                SOURCE_HASH,
                reviewer="operator_1",
                decided_at="2026-08-07T12:00:00Z",
                ranking_manifest_hash=RANKING_HASH,
                replay_transcript=replay_transcript,
                transcript_timing_hash=transcript_timing_hash(
                    replay_transcript
                ),
            )

    def test_feed_stop_v3_evidence_fails_closed_on_adversarial_drift(self):
        valid, replay_transcript = feed_stop_v3_candidate()

        missing_hook = json.loads(json.dumps(valid))
        missing_hook.pop("hookGateReport")

        tampered_hook = json.loads(json.dumps(valid))
        tampered_hook["hookGateReport"]["hookGateScore"] = 1.0

        wrong_hook_source, _ = feed_stop_v3_candidate(
            hook_source_hash="e" * 64
        )
        wrong_hook_transcript, _ = feed_stop_v3_candidate(
            hook_transcript_timing_hash="f" * 64
        )
        untrusted_delivery, _ = feed_stop_v3_candidate(
            delivery_provider_identity={"provider": "arbitrary"}
        )

        delivery_alias = json.loads(json.dumps(valid))
        delivery_alias["delivery_quality_status"] = "review"

        missing_delivery = json.loads(json.dumps(valid))
        missing_delivery.pop("deliveryQualityReport")

        missing_cleanliness = json.loads(json.dumps(valid))
        missing_cleanliness.pop("speechCleanlinessReport")

        alternate_clarity, _ = feed_stop_v3_candidate(
            point_exact_quote="This phrase is not present anywhere"
        )
        mismatched_embedded_clarity = json.loads(json.dumps(valid))
        for field in (
            "deliveryQualityReport",
            "deliveryQualityStatus",
            "deliveryQualityEligible",
            "deliveryQualityStrength",
            "deliveryQualityRejectionReasons",
            "deliveryQualityReviewReasons",
            "delivery_quality_decision_version",
            "delivery_quality_status",
            "delivery_quality_eligible",
            "delivery_quality_strength",
            "delivery_quality_reject_reasons",
            "delivery_quality_review_reasons",
            "delivery_quality_provider_status",
        ):
            mismatched_embedded_clarity[field] = alternate_clarity[field]

        cases = (
            ("missing-hook", missing_hook, "lacks a HookGate V4 report"),
            ("tampered-hook", tampered_hook, "HookGate V4 report is invalid"),
            ("wrong-hook-source", wrong_hook_source, "another source"),
            (
                "wrong-hook-transcript",
                wrong_hook_transcript,
                "another transcript",
            ),
            (
                "untrusted-delivery",
                untrusted_delivery,
                "trusted local provider identity",
            ),
            (
                "delivery-alias",
                delivery_alias,
                "delivery-quality candidate aliases do not match",
            ),
            (
                "missing-delivery",
                missing_delivery,
                "lacks a delivery-quality report",
            ),
            (
                "missing-cleanliness",
                missing_cleanliness,
                "lacks a speech-cleanliness report",
            ),
            (
                "mismatched-embedded-clarity",
                mismatched_embedded_clarity,
                "not bound to the candidate SpokenClarity report",
            ),
        )
        for name, raw, message in cases:
            with self.subTest(name=name):
                body = {
                    key: value
                    for key, value in raw.items()
                    if key != "candidate_hash"
                }
                candidate_value = {
                    **body,
                    "candidate_hash": candidate_hash(body, SOURCE_HASH),
                }
                with self.assertRaisesRegex(ArtifactBindingError, message):
                    build_candidate_decision(
                        candidate_value,
                        SOURCE_HASH,
                        reviewer="operator_1",
                        decided_at="2026-08-07T12:00:00Z",
                        ranking_manifest_hash=RANKING_HASH,
                        replay_transcript=replay_transcript,
                        transcript_timing_hash=transcript_timing_hash(
                            replay_transcript
                        ),
                    )

    def test_feed_stop_candidate_decision_requires_cleanliness_report(self):
        feed_stop = feed_stop_candidate()
        body = {
            key: value
            for key, value in feed_stop.items()
            if key != "candidate_hash"
            and not key.startswith("speechCleanliness")
            and not key.startswith("speech_cleanliness_")
        }
        missing = {**body, "candidate_hash": candidate_hash(body, SOURCE_HASH)}

        with self.assertRaisesRegex(
            ArtifactBindingError,
            "lacks a speech-cleanliness report",
        ):
            build_candidate_decision(
                missing,
                SOURCE_HASH,
                reviewer="operator_1",
                decided_at="2026-08-07T12:00:00Z",
                ranking_manifest_hash=RANKING_HASH,
            )

    def test_feed_stop_candidate_decision_requires_passing_spoken_clarity(self):
        feed_stop = feed_stop_candidate()
        body = {
            key: value
            for key, value in feed_stop.items()
            if key != "candidate_hash"
            and not key.startswith("spokenClarity")
            and not key.startswith("spoken_clarity_")
        }
        missing = {**body, "candidate_hash": candidate_hash(body, SOURCE_HASH)}
        with self.assertRaisesRegex(
            ArtifactBindingError,
            "lacks a spoken-clarity report",
        ):
            build_candidate_decision(
                missing,
                SOURCE_HASH,
                reviewer="operator_1",
                decided_at="2026-08-07T12:00:00Z",
                ranking_manifest_hash=RANKING_HASH,
            )

        untrusted = feed_stop_candidate(
            clarity_provider_identity={"provider": "arbitrary-test"}
        )
        with self.assertRaisesRegex(
            ArtifactBindingError,
            "trusted local provider identity",
        ):
            build_candidate_decision(
                untrusted,
                SOURCE_HASH,
                reviewer="operator_1",
                decided_at="2026-08-07T12:00:00Z",
                ranking_manifest_hash=RANKING_HASH,
            )

        alias_body = {
            **{
                key: value
                for key, value in feed_stop.items()
                if key != "candidate_hash"
            },
            "spoken_clarity_status": "review",
        }
        alias_mismatch = {
            **alias_body,
            "candidate_hash": candidate_hash(alias_body, SOURCE_HASH),
        }
        with self.assertRaisesRegex(
            ArtifactBindingError,
            "spoken-clarity candidate aliases do not match",
        ):
            build_candidate_decision(
                alias_mismatch,
                SOURCE_HASH,
                reviewer="operator_1",
                decided_at="2026-08-07T12:00:00Z",
                ranking_manifest_hash=RANKING_HASH,
            )

    def test_feed_stop_candidate_decision_rejects_stale_interval_and_aliases(self):
        feed_stop = feed_stop_candidate()
        stale_report = evaluate_speech_cleanliness_evidence(
            source_hash=SOURCE_HASH,
            transcript_timing_hash="b" * 64,
            speech_start=10.0,
            speech_end=32.0,
            lexical_fillers=[],
            uncovered_vocalizations=[],
            prompted_fillers=[],
        )
        stale_body = {
            **{key: value for key, value in feed_stop.items() if key != "candidate_hash"},
            "speechCleanlinessReport": stale_report,
        }
        stale = {
            **stale_body,
            "candidate_hash": candidate_hash(stale_body, SOURCE_HASH),
        }
        with self.assertRaisesRegex(ArtifactBindingError, "interval is stale"):
            build_candidate_decision(
                stale,
                SOURCE_HASH,
                reviewer="operator_1",
                decided_at="2026-08-07T12:00:00Z",
                ranking_manifest_hash=RANKING_HASH,
            )

        alias_body = {
            **{key: value for key, value in feed_stop.items() if key != "candidate_hash"},
            "speech_cleanliness_status": "review",
        }
        alias_mismatch = {
            **alias_body,
            "candidate_hash": candidate_hash(alias_body, SOURCE_HASH),
        }
        with self.assertRaisesRegex(ArtifactBindingError, "aliases do not match"):
            build_candidate_decision(
                alias_mismatch,
                SOURCE_HASH,
                reviewer="operator_1",
                decided_at="2026-08-07T12:00:00Z",
                ranking_manifest_hash=RANKING_HASH,
            )

    def test_transcript_manifest_preserves_exact_json_and_binds_source(self):
        transcript = {
            "duration": 12.123456789,
            "language": "en",
            "segments": [
                {
                    "start": 0.000000123,
                    "end": 12.000000321,
                    "text": "One exact thought.",
                    "speaker": "speaker-a",
                    "words": [
                        {
                            "word": "One",
                            "start": 0.000000123,
                            "end": 3.000000123,
                            "confidence": 0.987654321,
                        },
                        {
                            "word": "exact",
                            "start": 3.100000123,
                            "end": 7.000000123,
                            "confidence": 0.987654321,
                        },
                        {
                            "word": "thought.",
                            "start": 7.100000123,
                            "end": 12.000000321,
                            "confidence": 0.987654321,
                        }
                    ],
                }
            ],
        }
        manifest = build_replay_transcript_manifest(transcript, SOURCE_HASH)
        transcript["segments"][0]["words"][0]["start"] = 9.0

        self.assertEqual(
            manifest["transcript"]["segments"][0]["words"][0]["start"],
            0.000000123,
        )
        self.assertEqual(
            manifest["transcriptTimingHash"],
            transcript_timing_hash(manifest["transcript"]),
        )
        self.assertIs(
            verify_replay_transcript_manifest(
                manifest,
                source_hash=SOURCE_HASH,
                require_timed_words=True,
            ),
            manifest,
        )
        with self.assertRaisesRegex(ArtifactBindingError, "another source"):
            verify_replay_transcript_manifest(manifest, source_hash="b" * 64)

    def test_timed_transcript_accepts_case_and_punctuation_variants_without_mutation(self):
        transcript = {
            "duration": 3.0,
            "segments": [
                {
                    "start": 0.1,
                    "end": 2.8,
                    "text": "Don’t STOP—now!",
                    "words": [
                        {"word": "don't", "start": 0.1, "end": 0.8},
                        {"word": "stop", "start": 0.9, "end": 1.6},
                        {"word": "NOW", "start": 1.7, "end": 2.8},
                    ],
                }
            ],
        }

        snapshot = validate_timed_transcript(
            transcript,
            require_timed_words=True,
        )

        self.assertEqual(snapshot, transcript)
        self.assertEqual(snapshot["segments"][0]["text"], "Don’t STOP—now!")

    def test_timed_transcript_requires_string_segment_text_and_word_tokens(self):
        base = {
            "duration": 2.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 1.5,
                    "text": "One thought.",
                    "words": [
                        {"word": "One", "start": 0.0, "end": 0.5},
                        {"word": "thought.", "start": 0.6, "end": 1.5},
                    ],
                }
            ],
        }
        non_string_text = {
            **base,
            "segments": [{**base["segments"][0], "text": 123}],
        }
        non_string_token = {
            **base,
            "segments": [
                {
                    **base["segments"][0],
                    "words": [
                        {"word": 1, "start": 0.0, "end": 0.5},
                        base["segments"][0]["words"][1],
                    ],
                }
            ],
        }

        with self.assertRaisesRegex(ArtifactBindingError, "text must be a string"):
            validate_timed_transcript(non_string_text, require_timed_words=True)
        with self.assertRaisesRegex(ArtifactBindingError, "tokens must be strings"):
            validate_timed_transcript(non_string_token, require_timed_words=True)

    def test_timed_transcript_requires_positive_speech_duration_and_segment_containment(self):
        zero_duration = {
            "duration": 2.0,
            "segments": [
                {
                    "start": 1.0,
                    "end": 1.0,
                    "text": "One",
                    "words": [{"word": "One", "start": 1.0, "end": 1.1}],
                }
            ],
        }
        word_outside_segment = {
            "duration": 2.0,
            "segments": [
                {
                    "start": 0.5,
                    "end": 1.5,
                    "text": "One thought.",
                    "words": [
                        {"word": "One", "start": 0.4, "end": 0.8},
                        {"word": "thought.", "start": 0.9, "end": 1.5},
                    ],
                }
            ],
        }
        word_ending_after_segment = {
            "duration": 2.0,
            "segments": [
                {
                    "start": 0.5,
                    "end": 1.5,
                    "text": "One thought.",
                    "words": [
                        {"word": "One", "start": 0.5, "end": 0.8},
                        {"word": "thought.", "start": 0.9, "end": 1.6},
                    ],
                }
            ],
        }

        with self.assertRaisesRegex(ArtifactBindingError, "positive duration"):
            validate_timed_transcript(zero_duration, require_timed_words=True)
        with self.assertRaisesRegex(ArtifactBindingError, "outside its segment"):
            validate_timed_transcript(
                word_outside_segment,
                require_timed_words=True,
            )
        with self.assertRaisesRegex(ArtifactBindingError, "outside its segment"):
            validate_timed_transcript(
                word_ending_after_segment,
                require_timed_words=True,
            )

    def test_timed_transcript_rejects_partial_or_wrong_word_lists(self):
        transcript = {
            "duration": 3.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 2.5,
                    "text": "The complete point.",
                    "words": [
                        {"word": "The", "start": 0.0, "end": 0.5},
                        {"word": "wrong", "start": 0.6, "end": 1.2},
                    ],
                }
            ],
        }

        with self.assertRaisesRegex(ArtifactBindingError, "do not match"):
            validate_timed_transcript(transcript, require_timed_words=True)

    def test_verified_visual_boundary_changes_candidate_and_cache_identity(self):
        body = {
            key: value
            for key, value in candidate().items()
            if key != "candidate_hash"
        }
        visual = {
            **body,
            "verified_visual_safe_end_time": 20.62,
            "verified_visual_boundary_evidence": "scene-cut review",
        }
        changed_evidence = {
            **visual,
            "verified_visual_boundary_evidence": "frame-by-frame scene-cut review",
        }

        self.assertNotEqual(
            candidate_hash(body, SOURCE_HASH),
            candidate_hash(visual, SOURCE_HASH),
        )
        self.assertNotEqual(
            candidate_hash(visual, SOURCE_HASH),
            candidate_hash(changed_evidence, SOURCE_HASH),
        )

    def test_rejected_ranking_candidate_cannot_be_approved(self):
        rejected = {
            **candidate(),
            "rejected": True,
            "rejection_reasons": ["missing_semantic_tension"],
        }
        rejected["candidate_hash"] = candidate_hash(rejected, SOURCE_HASH)
        with self.assertRaisesRegex(ArtifactBindingError, "eligible non-rejected"):
            build_candidate_decision(
                rejected,
                SOURCE_HASH,
                reviewer="operator_1",
                decided_at="2026-07-16T12:00:00Z",
                ranking_manifest_hash=RANKING_HASH,
            )

    def test_edited_candidate_cannot_build_an_edit_plan(self):
        edited = candidate()
        edited["end_time"] = 21.0
        with self.assertRaisesRegex(ArtifactBindingError, "edited after approval"):
            build_edit_plan(self.decision(), edited, caption_cues=[])

    def test_artificial_cut_fails_closed(self):
        with self.assertRaisesRegex(ArtifactBindingError, "zero artificial cuts"):
            build_edit_plan(
                self.decision(),
                candidate(),
                caption_cues=[],
                artificial_cuts=[4.0],
            )

    def test_semantic_completion_can_seal_exactly_one_extra_natural_source_cut(self):
        body = {key: value for key, value in candidate().items() if key != "candidate_hash"}
        body.update(
            {
                "source_cut_count": 3,
                "source_scene_change_times": [12.0, 15.0, 20.2],
                "semantic_extension_applied": True,
                "semantic_continuation_required": False,
                "semantic_extension_start_time": 20.0,
                "semantic_extension_end_time": 20.7,
                "semantic_completion_source_cut_exception": True,
                "semantic_completion_added_source_cuts": 1,
                "artificial_cut_count": 0,
            }
        )
        extended = {**body, "candidate_hash": candidate_hash(body, SOURCE_HASH)}
        decision = build_candidate_decision(
            extended,
            SOURCE_HASH,
            reviewer="operator_1",
            decided_at="2026-07-16T12:00:00Z",
            ranking_manifest_hash=RANKING_HASH,
        )
        plan = build_edit_plan(
            decision,
            extended,
            caption_cues=[],
            source_cuts=body["source_scene_change_times"],
        )

        self.assertEqual(plan["sourceCutLimit"], 3)
        self.assertTrue(plan["semanticCompletionSourceCutException"])
        self.assertEqual(plan["artificialCutTimes"], [])

    def test_render_manifest_binds_exact_output_and_versions(self):
        plan = build_edit_plan(
            self.decision(),
            candidate(),
            caption_cues=[{"start": 0.0, "end": 0.8, "text": "DISCIPLINE"}],
            source_cuts=[7.0],
        )
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "short.mp4"
            output.write_bytes(b"fixture-render")
            manifest = build_render_manifest(
                plan,
                str(output),
                duration_seconds=10.75,
                fps=30,
                first_visible_text_seconds=0.0,
                max_hero_scale=2.2,
                brand_tail_seconds=1.25,
                source_speech_leak_guard_passed=True,
            )
        self.assertEqual(manifest["candidateHash"], self.decision()["candidateHash"])
        self.assertEqual(manifest["cuts"]["artificialCutCount"], 0)
        self.assertEqual(manifest["renderProfile"], "bf_editorial_inset_v1")
        verify_seal(manifest, "RenderManifest")

    def test_render_manifest_binds_candidate_verified_acoustic_tail_evidence(self):
        plan = build_edit_plan(
            self.decision(),
            candidate(),
            caption_cues=[{"start": 0.0, "end": 20.8, "text": "COMPLETE"}],
        )
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "short.mp4"
            output.write_bytes(b"fixture-render")
            manifest = build_render_manifest(
                plan,
                str(output),
                duration_seconds=22.1,
                fps=30,
                first_visible_text_seconds=0.0,
                max_hero_scale=2.2,
                brand_tail_seconds=1.25,
                semantic_end_seconds=20.8,
                brand_tail_start_seconds=20.85,
                transition_tail_seconds=0.11,
                source_content_end_time=20.85,
                next_spoken_word_start=20.86,
                next_speech_safety_seconds=0.01,
                source_speech_leak_guard_passed=True,
                acoustic_speech_end_time=20.74,
                transcript_next_spoken_word_start=20.8,
                acoustic_boundary_source="candidate_verified_acoustic",
                verified_acoustic_speech_end_time=20.74,
                verified_next_spoken_word_start=20.86,
                verified_next_speech_safety_seconds=0.01,
                verified_acoustic_boundary_evidence="waveform review",
            )

        tail = manifest["brandTail"]
        self.assertEqual(tail["acousticBoundarySource"], "candidate_verified_acoustic")
        self.assertAlmostEqual(tail["acousticSpeechEndTime"], 20.74)
        self.assertAlmostEqual(tail["transcriptNextSpokenWordStart"], 20.8)
        self.assertAlmostEqual(tail["verifiedNextSpokenWordStart"], 20.86)
        self.assertAlmostEqual(tail["verifiedNextSpeechSafetySeconds"], 0.01)
        self.assertEqual(tail["verifiedAcousticBoundaryEvidence"], "waveform review")
        self.assertAlmostEqual(tail["sourceContentEndTime"], 20.85)
        self.assertGreaterEqual(
            tail["startSeconds"],
            manifest["timeline"]["semanticEndSeconds"],
        )
        verify_seal(manifest, "RenderManifest")

    def test_v4_render_manifest_binds_verified_visual_safe_end(self):
        plan = build_edit_plan(
            self.decision(),
            candidate(),
            caption_cues=[{"start": 0.0, "end": 20.5, "text": "COMPLETE"}],
        )
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "short.mp4"
            output.write_bytes(b"fixture-render")
            manifest = build_render_manifest(
                plan,
                str(output),
                duration_seconds=21.678,
                fps=30,
                first_visible_text_seconds=0.0,
                max_hero_scale=2.2,
                brand_tail_seconds=0.85,
                semantic_end_seconds=20.5,
                brand_tail_start_seconds=20.828,
                brand_tail_profile="bf_smooth_tail_v4",
                natural_tail_seconds=0.327625,
                transition_tail_seconds=0.13,
                audio_transition_tail_seconds=0.04,
                speech_audio_end_time=20.827625,
                semantic_source_margin_seconds=0.327625,
                music_release_tail_seconds=0.18,
                source_content_end_time=20.827625,
                next_spoken_word_start=20.98,
                next_speech_safety_seconds=0.01,
                source_speech_leak_guard_passed=True,
                acoustic_speech_end_time=20.5,
                acoustic_boundary_source="candidate_verified_acoustic",
                verified_acoustic_speech_end_time=20.5,
                verified_next_spoken_word_start=20.98,
                verified_next_speech_safety_seconds=0.01,
                verified_acoustic_boundary_evidence="waveform review",
                verified_visual_safe_end_time=20.827625,
                verified_visual_boundary_evidence="scene-cut review",
                visual_safe_end_guard_passed=True,
            )

        tail = manifest["brandTail"]
        self.assertAlmostEqual(tail["sourceContentEndTime"], 20.828)
        self.assertAlmostEqual(tail["verifiedVisualSafeEndTime"], 20.828)
        self.assertEqual(
            tail["verifiedVisualBoundaryEvidence"],
            "scene-cut review",
        )
        self.assertTrue(tail["visualSafeEndGuardPassed"])
        self.assertAlmostEqual(tail["nextSpokenWordStart"], 20.98)
        verify_seal(manifest, "RenderManifest")

    def test_render_manifest_rejects_source_past_verified_visual_safe_end(self):
        plan = build_edit_plan(self.decision(), candidate(), caption_cues=[])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "short.mp4"
            output.write_bytes(b"fixture-render")
            with self.assertRaisesRegex(
                ArtifactBindingError,
                "crosses its verified visual safe-end boundary",
            ):
                build_render_manifest(
                    plan,
                    str(output),
                    duration_seconds=21.7,
                    fps=30,
                    first_visible_text_seconds=0.0,
                    max_hero_scale=2.2,
                    brand_tail_seconds=0.85,
                    brand_tail_profile="bf_smooth_tail_v4",
                    source_content_end_time=20.85,
                    verified_visual_safe_end_time=20.8,
                    visual_safe_end_guard_passed=True,
                    source_speech_leak_guard_passed=True,
                )

    def test_publish_manifest_requires_matching_rights_qa_experiment_and_originality(self):
        decision = self.decision()
        plan = build_edit_plan(decision, candidate(), caption_cues=[])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "short.mp4"
            output.write_bytes(b"fixture-render")
            render = build_render_manifest(
                plan,
                str(output),
                duration_seconds=10.75,
                fps=30,
                first_visible_text_seconds=0.0,
                max_hero_scale=2.2,
                brand_tail_seconds=1.25,
                source_speech_leak_guard_passed=True,
            )
            qa_payload = {
                "schemaVersion": 1,
                "artifactType": "CreativeQaReport",
                "renderManifestHash": render["contentHash"],
                "passed": True,
            }
            qa = {**qa_payload, "contentHash": content_hash(qa_payload)}
            attribution = "Source: Source owner podcast."
            with self.assertRaisesRegex(ArtifactBindingError, "attribution text"):
                build_rights_manifest(
                    SOURCE_HASH,
                    status="licensed",
                    owner="Source owner",
                    evidence_reference="license-001",
                    allowed_platforms=["youtube"],
                    music_license_reference="music-license-001",
                    font_license_references=["font-license-001"],
                )
            rights = build_rights_manifest(
                SOURCE_HASH,
                status="licensed",
                owner="Source owner",
                evidence_reference="license-001",
                allowed_platforms=["youtube"],
                music_license_reference="music-license-001",
                font_license_references=["font-license-001"],
                attribution_text=attribution,
            )
            experiment = build_experiment_manifest(
                experiment_id="bf_content_001",
                cohort_id="contradiction",
                treatment_id="contradiction_01",
                candidate_hash=decision["candidateHash"],
                hypothesis="Contradiction hooks improve stop rate.",
                primary_variable="hook_family",
                pillar="discipline_work",
                duration_seconds=10.75,
                declared_at="2026-07-16T12:00:00Z",
                decision_due_at="2026-08-13T12:00:00Z",
            )
            originality = evaluate_originality(
                candidate(),
                candidate_hash=decision["candidateHash"],
                source_hash=SOURCE_HASH,
                recent_publications=[],
                candidate_decision_hash=decision["contentHash"],
            )
            audio_payload = {
                "schemaVersion": 1,
                "artifactType": "AudioQaReport",
                "videoPath": str(output.resolve()),
                "outputHash": render["outputHash"],
                "brandTailSeconds": 0.3,
                "measurements": {
                    "integratedLufs": -15.5,
                    "truePeakDbfs": -1.8,
                    "brandTailRmsDbfs": -240.0,
                },
                "gates": [],
                "passed": True,
            }
            audio = {**audio_payload, "contentHash": content_hash(audio_payload)}
            publish_inputs = {
                "render_manifest": render,
                "qa_report": qa,
                "rights_manifest": rights,
                "experiment_manifest": experiment,
                "candidate_decision": decision,
                "metadata": {
                    "title": "Discipline creates freedom",
                    "description": f"A practical rule.\n\n{attribution}",
                },
                "originality_report": originality,
                "audio_qa_report": audio,
                "related_video_waiver_reason": "First episode in the new series",
            }

            missing_audio = dict(publish_inputs)
            missing_audio.pop("audio_qa_report")
            with self.assertRaisesRegex(ArtifactBindingError, "audio QA must pass"):
                build_publish_manifest(**missing_audio)

            missing_attribution = {
                **publish_inputs,
                "metadata": {
                    "title": "Discipline creates freedom",
                    "description": "A practical rule without source attribution.",
                },
            }
            with self.assertRaisesRegex(ArtifactBindingError, "attributionText exactly"):
                build_publish_manifest(**missing_attribution)

            for field, artifact in (
                ("qa_report", qa),
                ("experiment_manifest", experiment),
                ("originality_report", originality),
                ("audio_qa_report", audio),
            ):
                with self.subTest(tampered_artifact=field):
                    tampered_inputs = dict(publish_inputs)
                    tampered_inputs[field] = {**artifact, "auditNote": "tampered"}
                    with self.assertRaisesRegex(
                        ArtifactBindingError,
                        "contentHash does not match",
                    ):
                        build_publish_manifest(**tampered_inputs)

            wrong_audio_payload = {**audio_payload, "outputHash": "b" * 64}
            wrong_audio = {
                **wrong_audio_payload,
                "contentHash": content_hash(wrong_audio_payload),
            }
            wrong_audio_inputs = {**publish_inputs, "audio_qa_report": wrong_audio}
            with self.assertRaisesRegex(ArtifactBindingError, "audio QA is not bound"):
                build_publish_manifest(**wrong_audio_inputs)

            wrong_source_payload = {
                **{key: value for key, value in originality.items() if key != "contentHash"},
                "sourceHash": "b" * 64,
            }
            wrong_source = {
                **wrong_source_payload,
                "contentHash": content_hash(wrong_source_payload),
            }
            with self.assertRaisesRegex(ArtifactBindingError, "rendered source"):
                build_publish_manifest(
                    **{**publish_inputs, "originality_report": wrong_source}
                )

            wrong_decision_payload = {
                **{key: value for key, value in originality.items() if key != "contentHash"},
                "candidateDecisionHash": "c" * 64,
            }
            wrong_decision = {
                **wrong_decision_payload,
                "contentHash": content_hash(wrong_decision_payload),
            }
            with self.assertRaisesRegex(ArtifactBindingError, "candidate decision"):
                build_publish_manifest(
                    **{**publish_inputs, "originality_report": wrong_decision}
                )

            publish = build_publish_manifest(**publish_inputs)

        self.assertEqual(publish["renderOutputHash"], render["outputHash"])
        self.assertEqual(publish["originalityReportHash"], originality["contentHash"])
        self.assertEqual(publish["audioQaReportHash"], audio["contentHash"])
        self.assertEqual(publish["experimentManifestHash"], experiment["contentHash"])
        self.assertEqual(publish["candidateDecisionHash"], decision["contentHash"])
        verify_seal(publish, "PublishManifest")


if __name__ == "__main__":
    unittest.main()
