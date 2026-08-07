import json
import tempfile
import unittest

import shorts_generator.hook_gate_v4 as hook_gate_v4_module
from shorts_generator.artifact_contracts import transcript_timing_hash
from shorts_generator.hook_gate_v3 import HOOK_GATE_V3_VERSION
from shorts_generator.hook_gate_v4 import (
    BF_FEED_STOP_V2_POLICY_VERSION,
    HOOK_GATE_V4_DECISION_VERSION,
    HOOK_GATE_V4_PROMPT_VERSION,
    HOOK_GATE_V4_VERSION,
    build_hook_gate_v4_report,
    evaluate_hook_gate_v4,
    evaluate_hook_gate_v4_cached,
    hook_gate_v4_cache_key,
    transcript_word_timing_hash,
    verify_hook_gate_v4_report,
)
from shorts_generator.hook_gate_v4_report import HookGateV4ReportError
from shorts_generator.motivational_closure import (
    SEMANTIC_CLOSURE_DECISION_VERSION,
)
from shorts_generator.profiles import (
    BF_FEED_STOP_V2,
    MOTIVATIONAL_PODCAST,
    selection_settings,
)
from shorts_generator.ranker import rank_highlights


SOURCE_HASH = "a" * 64
TRANSCRIPT_HASH = "b" * 64


def timed_words(text, duration=16.0, offset=0.0):
    raw = text.split()
    step = duration / len(raw)
    return [
        {
            "start": round(offset + index * step, 6),
            "end": round(offset + (index + 1) * step, 6),
            "word": word,
        }
        for index, word in enumerate(raw)
    ]


def strong_candidate(text, opening, payoff, duration=16.0, **overrides):
    candidate = {
        "title": "Strong complete point",
        "start_time": 0.0,
        "end_time": duration,
        "render_start_time": 0.0,
        "speech_start_time": 0.0,
        "speech_end_time": duration,
        "begins_on_complete_word_boundary": True,
        "opening_unit_exact_quote": opening,
        "topic_comprehension_exact_quote": opening,
        "payoff_exact_quote": payoff,
        "opening_unit_type": "rule",
        "hook_mechanism": "concrete_rule",
        "hook_semantic_topic": "interpersonal boundaries",
        "opening_claim_summary": "Not every invitation to argue deserves a response.",
        "whole_point_summary": "Other people's opinions do not create an obligation to reply.",
        "opening_sentence_clarity_score": 94,
        "topic_explicitness_score": 92,
        "standalone_comprehension_score": 95,
        "tension_or_relevance_score": 91,
        "opening_point_coherence_score": 94,
        "payoff_resolution_score": 93,
        "single_idea_focus_score": 96,
        "lexical_delivery_strength_score": 88,
        "hook_semantic_confidence_score": 93,
        "opening_unit_is_complete_claim": True,
        "requires_external_context": False,
        "unresolved_deictic_reference": False,
        "host_or_attribution_setup": False,
        "topic_intro_only": False,
        "payoff_changes_topic": False,
        "hook_semantic_reason_codes": [
            "clear_complete_claim",
            "topic_explicit_by_opening_end",
            "opening_and_payoff_coherent",
            "payoff_resolves_opening",
        ],
        "has_hook": True,
        "has_takeaway": True,
        "has_complete_ending": True,
        "second_topic_begins_after_takeaway": False,
        "requires_previous_context": False,
        "contains_context_callback": False,
        "contains_host_setup": False,
        "contains_attribution_lead_in": False,
        "new_viewer_understands_opening": True,
        "context_dependence_score": 0,
        "generic_motivation_score": 5,
    }
    candidate.update(overrides)
    return candidate, timed_words(text, duration)


def rankable_v4_candidate():
    candidate, words = strong_candidate(
        ARGUMENT_TEXT,
        ARGUMENT_OPENING,
        ARGUMENT_PAYOFF,
    )
    candidate.update(
        {
            "selection_profile": BF_FEED_STOP_V2,
            "selection_policy_version": BF_FEED_STOP_V2,
            "has_development": True,
            "hook_payoff_aligned": True,
            "takeaway_boundary_aligned": True,
            "semantic_continuation_required": False,
            "semantic_closure_status": "pass",
            "semantic_closure_eligible": True,
            "semantic_closure_decision_version": (
                SEMANTIC_CLOSURE_DECISION_VERSION
            ),
            "semantic_closure_deterministic_reasons": [],
        }
    )
    transcript = {
        "duration": 16.0,
        "segments": [
            {
                "start": 0.0,
                "end": 16.0,
                "text": ARGUMENT_TEXT,
                "words": words,
            }
        ],
    }
    candidate = evaluate_hook_gate_v4_cached(
        candidate,
        words,
        policy=selection_settings(BF_FEED_STOP_V2),
        transcript_hash=transcript_word_timing_hash(words),
    )
    return candidate, transcript


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


class HookGateV4Tests(unittest.TestCase):
    def test_real_false_negative_passes_without_keyword_expansion(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertEqual(result["hookGateStatus"], "pass")
        self.assertTrue(result["hookGateEligible"])
        self.assertEqual(result["openingUnitStartTokenIndex"], 0)
        self.assertLess(result["openingUnitDurationSeconds"], 3.5)
        self.assertNotIn(
            "hook_v4_opening_sentence_unclear",
            result["hookGateRejectionReasons"],
        )

    def test_complete_opening_unit_can_extend_beyond_first_eight_words(self):
        text = (
            "You do not owe every angry person an immediate answer today. "
            "Their pressure does not make your response mandatory at all, and "
            "you can take time to decide whether this conversation deserves "
            "your attention before you give any answer back."
        )
        opening = "You do not owe every angry person an immediate answer today."
        payoff = (
            "Their pressure does not make your response mandatory at all, and "
            "you can take time to decide whether this conversation deserves "
            "your attention before you give any answer back."
        )
        candidate, words = strong_candidate(text, opening, payoff, duration=12.0)

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertGreater(result["openingUnitEndTokenIndex"], 7)
        self.assertEqual(result["hookGateStatus"], "pass")

    def test_unclear_context_callback_is_rejected_even_with_strong_words(self):
        text = (
            "You are not a target because this changes everything for them. "
            "That is why you should finally walk away from it."
        )
        opening = "You are not a target because this changes everything for them."
        payoff = "That is why you should finally walk away from it."
        candidate, words = strong_candidate(
            text,
            opening,
            payoff,
            duration=12.0,
            requires_external_context=True,
            unresolved_deictic_reference=True,
            topic_explicitness_score=35,
            standalone_comprehension_score=30,
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertEqual(result["hookGateStatus"], "reject")
        self.assertIn(
            "hook_v4_requires_external_context",
            result["hookGateRejectionReasons"],
        )
        self.assertIn(
            "hook_v4_unresolved_reference",
            result["hookGateRejectionReasons"],
        )

    def test_abstract_teaser_is_rejected_as_topic_intro(self):
        text = (
            "There is a silent killer hiding in modern life today. "
            "Busy schedules eventually damage connection between people."
        )
        opening = "There is a silent killer hiding in modern life today."
        payoff = "Busy schedules eventually damage connection between people."
        candidate, words = strong_candidate(
            text,
            opening,
            payoff,
            duration=12.0,
            opening_unit_type="topic_intro",
            topic_intro_only=True,
            topic_explicitness_score=45,
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertIn(
            "hook_v4_topic_intro_or_fragment",
            result["hookGateRejectionReasons"],
        )
        self.assertIn("hook_v4_topic_unclear", result["hookGateRejectionReasons"])

    def test_strong_opening_with_unrelated_payoff_is_rejected(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
            opening_point_coherence_score=40,
            payoff_changes_topic=True,
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertIn(
            "hook_v4_opening_point_incoherent",
            result["hookGateRejectionReasons"],
        )
        self.assertIn(
            "hook_v4_payoff_topic_shift",
            result["hookGateRejectionReasons"],
        )

    def test_opening_and_topic_quotes_must_be_exact_prefixes(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            "attend every argument",
            ARGUMENT_PAYOFF,
            topic_comprehension_exact_quote="every argument you're invited to",
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertIn(
            "hook_v4_opening_unit_not_prefix",
            result["hookGateRejectionReasons"],
        )
        self.assertIn(
            "hook_v4_topic_comprehension_not_prefix",
            result["hookGateRejectionReasons"],
        )

    def test_topic_comprehension_prefix_cannot_end_before_opening_unit(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
            topic_comprehension_exact_quote="Don't attend every argument",
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertLess(
            result["topicComprehensionEndTokenIndex"],
            result["openingUnitEndTokenIndex"],
        )
        self.assertIn(
            "hook_v4_topic_comprehension_before_opening_unit_end",
            result["hookGateRejectionReasons"],
        )

    def test_payoff_must_end_on_last_spoken_token(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            "give your opinion",
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertIn(
            "hook_v4_payoff_not_at_speech_end",
            result["hookGateRejectionReasons"],
        )

    def test_mid_phoneme_opening_is_rejected_even_when_declared_complete(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
            speech_start_time=0.05,
            start_time=0.05,
            render_start_time=0.05,
            begins_on_complete_word_boundary=True,
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertFalse(result["startsOnCompleteWordBoundary"])
        self.assertIn(
            "hook_v4_opening_not_on_word_boundary",
            result["hookGateRejectionReasons"],
        )
        self.assertIn(
            "hook_v4_opening_cuts_word",
            result["hookGateRejectionReasons"],
        )

    def test_mid_phoneme_ending_is_rejected_instead_of_hiding_last_word(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
            speech_end_time=15.95,
            end_time=15.95,
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertFalse(result["endsOnCompleteWordBoundary"])
        self.assertIn(
            "hook_v4_ending_not_on_word_boundary",
            result["hookGateRejectionReasons"],
        )
        self.assertIn(
            "hook_v4_ending_cuts_word",
            result["hookGateRejectionReasons"],
        )

    def test_empty_structured_opening_type_cannot_use_legacy_default(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
            opening_unit_type="",
            hook_type="rule",
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertFalse(result["hookSemanticCanonicalComplete"])
        self.assertIn(
            "hook_v4_semantic_evidence_incomplete",
            result["hookGateRejectionReasons"],
        )
        self.assertIn(
            "hook_v4_opening_unit_type_invalid",
            result["hookGateRejectionReasons"],
        )

    def test_empty_unstructured_hook_mechanism_cannot_use_alias(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
            hook_mechanism="",
            hook_family="concrete_rule",
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertFalse(result["hookSemanticCanonicalComplete"])
        self.assertIn(
            "hook_v4_semantic_evidence_incomplete",
            result["hookGateRejectionReasons"],
        )
        self.assertIn(
            "hook_v4_hook_mechanism_invalid",
            result["hookGateRejectionReasons"],
        )

    def test_missing_whole_point_score_fails_closed(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
        )
        candidate.pop("opening_point_coherence_score")
        candidate.pop("whole_point_summary")

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertIn(
            "hook_v4_openingPointCoherence_evidence_missing",
            result["hookGateRejectionReasons"],
        )

    def test_legacy_scores_cannot_silently_replace_missing_v4_contract(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
        )
        for field in (
            "opening_sentence_clarity_score",
            "topic_explicitness_score",
            "standalone_comprehension_score",
            "tension_or_relevance_score",
            "opening_point_coherence_score",
            "payoff_resolution_score",
            "single_idea_focus_score",
            "lexical_delivery_strength_score",
            "hook_semantic_confidence_score",
        ):
            candidate.pop(field)
        candidate.update(
            {
                "hook_score": 99,
                "standalone_score": 99,
                "semantic_tension_score": 99,
                "self_contained_micro_arc_score": 99,
                "listener_payoff_score": 99,
                "takeaway_score": 99,
                "closure_score": 99,
                "emotional_conviction_score": 99,
            }
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertIn(
            "hook_v4_semantic_evidence_incomplete",
            result["hookGateRejectionReasons"],
        )

    def test_low_delivery_strength_is_not_hidden_by_semantics(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
            lexical_delivery_strength_score=40,
        )

        result = evaluate_hook_gate_v4(candidate, words)

        self.assertIn(
            "hook_v4_lexical_delivery_too_weak",
            result["hookGateRejectionReasons"],
        )

    def test_report_is_sealed_and_bound_to_source_transcript_and_interval(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
        )
        evaluated = evaluate_hook_gate_v4(candidate, words)
        report = build_hook_gate_v4_report(
            evaluated,
            source_hash=SOURCE_HASH,
            transcript_timing_hash=TRANSCRIPT_HASH,
        )

        verified = verify_hook_gate_v4_report(
            report,
            source_hash=SOURCE_HASH,
            transcript_timing_hash=TRANSCRIPT_HASH,
            speech_interval=(0.0, 16.0),
            require_pass=True,
        )
        self.assertEqual(verified["hookGateVersion"], HOOK_GATE_V4_VERSION)
        self.assertEqual(verified["promptVersion"], HOOK_GATE_V4_PROMPT_VERSION)
        self.assertEqual(verified["decisionVersion"], HOOK_GATE_V4_DECISION_VERSION)
        self.assertEqual(
            verified["selectionPolicyVersion"],
            BF_FEED_STOP_V2_POLICY_VERSION,
        )

        tampered = json.loads(json.dumps(report))
        tampered["semanticScores"]["openingSentenceClarity"] = 1
        with self.assertRaisesRegex(HookGateV4ReportError, "contentHash"):
            verify_hook_gate_v4_report(tampered)
        with self.assertRaisesRegex(HookGateV4ReportError, "another source"):
            verify_hook_gate_v4_report(report, source_hash="c" * 64)

    def test_cache_key_includes_semantic_evidence_and_policy(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
        )
        base = hook_gate_v4_cache_key(candidate, words)
        changed_candidate = hook_gate_v4_cache_key(
            {**candidate, "opening_point_coherence_score": 73},
            words,
        )
        changed_policy = hook_gate_v4_cache_key(
            candidate,
            words,
            policy={"minimum_score": 82.0},
        )
        self.assertNotEqual(base, changed_candidate)
        self.assertNotEqual(base, changed_policy)
        for field in hook_gate_v4_module._HOOK_GATE_V4_EVALUATION_INPUT_KEYS:
            mutated = dict(candidate)
            mutated[field] = {"mutation": field}
            self.assertNotEqual(
                base,
                hook_gate_v4_cache_key(mutated, words),
                msg=f"cache identity omitted evaluator input {field}",
            )

        with tempfile.TemporaryDirectory() as directory:
            hook_gate_v4_module._MEMORY_CACHE.pop(base, None)
            first = evaluate_hook_gate_v4_cached(
                candidate,
                words,
                cache_dir=directory,
            )
            second = evaluate_hook_gate_v4_cached(
                candidate,
                words,
                cache_dir=directory,
            )
        self.assertFalse(first["hook_gate_v4_cache_hit"])
        self.assertTrue(second["hook_gate_v4_cache_hit"])
        self.assertIsNone(first["hookGateReport"]["sourceHash"])
        self.assertEqual(
            first["hookGateReport"]["transcriptTimingHash"],
            transcript_word_timing_hash(words),
        )
        verify_hook_gate_v4_report(
            second["hookGateReport"],
            transcript_timing_hash=transcript_word_timing_hash(words),
            speech_interval=(0.0, 16.0),
            require_pass=True,
        )

    def test_cache_misses_when_fail_closed_boolean_inputs_change(self):
        for field, reason in (
            (
                "new_viewer_understands_opening",
                "hook_v4_new_viewer_cannot_understand_opening",
            ),
            (
                "begins_on_complete_word_boundary",
                "hook_v4_opening_cuts_word",
            ),
        ):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                candidate, words = strong_candidate(
                    ARGUMENT_TEXT,
                    ARGUMENT_OPENING,
                    ARGUMENT_PAYOFF,
                )
                mutated = {**candidate, field: False}
                base_key = hook_gate_v4_cache_key(candidate, words)
                mutated_key = hook_gate_v4_cache_key(mutated, words)
                hook_gate_v4_module._MEMORY_CACHE.pop(base_key, None)
                hook_gate_v4_module._MEMORY_CACHE.pop(mutated_key, None)

                first = evaluate_hook_gate_v4_cached(
                    candidate,
                    words,
                    cache_dir=directory,
                )
                second = evaluate_hook_gate_v4_cached(
                    mutated,
                    words,
                    cache_dir=directory,
                )

                self.assertFalse(first["hook_gate_v4_cache_hit"])
                self.assertFalse(second["hook_gate_v4_cache_hit"])
                self.assertNotEqual(base_key, mutated_key)
                self.assertIn(reason, second["hookGateRejectionReasons"])

    def test_cache_hit_preserves_fresh_non_evaluator_candidate_fields(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
        )
        candidate["title"] = "Cached title"
        key = hook_gate_v4_cache_key(candidate, words)
        hook_gate_v4_module._MEMORY_CACHE.pop(key, None)

        first = evaluate_hook_gate_v4_cached(candidate, words)
        fresh_candidate = {
            **candidate,
            "title": "Fresh authoritative title",
            "request_trace_id": "fresh-request",
        }
        second = evaluate_hook_gate_v4_cached(fresh_candidate, words)

        self.assertFalse(first["hook_gate_v4_cache_hit"])
        self.assertTrue(second["hook_gate_v4_cache_hit"])
        self.assertEqual(second["title"], "Fresh authoritative title")
        self.assertEqual(second["request_trace_id"], "fresh-request")

    def test_cached_evaluator_recomputes_tampered_memory_report(self):
        candidate, words = strong_candidate(
            ARGUMENT_TEXT,
            ARGUMENT_OPENING,
            ARGUMENT_PAYOFF,
            opening_sentence_clarity_score=93,
        )
        key = hook_gate_v4_cache_key(candidate, words)
        hook_gate_v4_module._MEMORY_CACHE.pop(key, None)
        first = evaluate_hook_gate_v4_cached(candidate, words)
        hook_gate_v4_module._MEMORY_CACHE[key]["hookGateReport"][
            "semanticScores"
        ]["openingSentenceClarity"] = 1

        second = evaluate_hook_gate_v4_cached(candidate, words)

        self.assertFalse(first["hook_gate_v4_cache_hit"])
        self.assertFalse(second["hook_gate_v4_cache_hit"])
        self.assertEqual(
            second["hookGateReport"]["semanticScores"][
                "openingSentenceClarity"
            ],
            93.0,
        )
        verify_hook_gate_v4_report(
            second["hookGateReport"],
            transcript_timing_hash=transcript_word_timing_hash(words),
            require_pass=True,
        )

    def test_rank_boundary_accepts_exact_recomputation_and_sealed_report(self):
        candidate, transcript = rankable_v4_candidate()

        [ranked] = rank_highlights(
            [candidate],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=BF_FEED_STOP_V2,
        )

        self.assertFalse(ranked["rejected"])
        self.assertNotIn(
            "hook_gate_v4_alias_mismatch",
            ranked["rejection_reasons"],
        )

    def test_rank_boundary_rejects_missing_v4_report(self):
        candidate, transcript = rankable_v4_candidate()
        candidate.pop("hookGateReport")

        [ranked] = rank_highlights(
            [candidate],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=BF_FEED_STOP_V2,
        )

        self.assertTrue(ranked["rejected"])
        self.assertIn(
            "hook_gate_v4_report_missing",
            ranked["rejection_reasons"],
        )

    def test_rank_boundary_rejects_tampered_v4_report(self):
        candidate, transcript = rankable_v4_candidate()
        candidate["hookGateReport"] = json.loads(
            json.dumps(candidate["hookGateReport"])
        )
        candidate["hookGateReport"]["semanticScores"][
            "openingSentenceClarity"
        ] = 1

        [ranked] = rank_highlights(
            [candidate],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=BF_FEED_STOP_V2,
        )

        self.assertTrue(ranked["rejected"])
        self.assertIn(
            "hook_gate_v4_report_invalid",
            ranked["rejection_reasons"],
        )

    def test_rank_boundary_rejects_aliases_only_v4_candidate(self):
        candidate, transcript = rankable_v4_candidate()
        aliases_only = {
            key: value
            for key, value in candidate.items()
            if not (
                key == "hookGateReport"
                or key.startswith("openingUnit")
                or key.startswith("topicComprehension")
                or key.startswith("payoff")
                or key.startswith("hookSemantic")
            )
        }

        [ranked] = rank_highlights(
            [aliases_only],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=BF_FEED_STOP_V2,
        )

        self.assertTrue(ranked["rejected"])
        self.assertIn(
            "hook_gate_v4_report_missing",
            ranked["rejection_reasons"],
        )
        self.assertIn(
            "hook_gate_v4_alias_mismatch",
            ranked["rejection_reasons"],
        )

    def test_rank_boundary_rejects_alias_drift_from_valid_report(self):
        candidate, transcript = rankable_v4_candidate()
        candidate["hookGateScore"] = 100.0
        candidate["hook_gate_score"] = 100.0

        [ranked] = rank_highlights(
            [candidate],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=BF_FEED_STOP_V2,
        )

        self.assertTrue(ranked["rejected"])
        self.assertIn(
            "hook_gate_v4_alias_mismatch",
            ranked["rejection_reasons"],
        )

    def test_v3_version_remains_unchanged(self):
        self.assertEqual(HOOK_GATE_V3_VERSION, "hook-gate-v3.0.0")


if __name__ == "__main__":
    unittest.main()
