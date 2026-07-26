import tempfile
import unittest
from unittest.mock import patch

from shorts_generator.artifact_contracts import candidate_hash
from shorts_generator.hook_gate import (
    HOOK_GATE_DECISION_VERSION,
    evaluate_hook_gate_v2,
)
from shorts_generator.highlights import (
    _discovery_cache_path,
    align_motivational_boundaries,
)
from shorts_generator.motivational_closure import (
    SEMANTIC_CLOSURE_DECISION_VERSION,
)
from shorts_generator.profiles import (
    MOTIVATIONAL_TENSION_MICRO_V1,
    MOTIVATIONAL_TENSION_MICRO_V2,
    SELECTION_PROFILES,
    selection_settings,
)
from shorts_generator.ranker import rank_highlights


def timed_words(spec):
    return [
        {"start": start, "end": end, "word": text}
        for start, end, text in spec
    ]


def passing_words(offset=0.0, signal_end=1.0, payoff_end=3.0):
    return timed_words(
        [
            (offset + 0.00, offset + 0.40, "Do"),
            (offset + 0.40, offset + signal_end, "less"),
            (offset + 1.00, offset + 1.35, "than"),
            (offset + 1.35, offset + 1.70, "you"),
            (offset + 1.70, offset + 2.10, "think"),
            (offset + 2.10, offset + 2.40, "you"),
            (offset + 2.40, offset + 2.70, "can"),
            (offset + 2.70, offset + payoff_end, "do."),
            (offset + 3.40, offset + 4.00, "Consistency"),
            (offset + 4.00, offset + 4.40, "builds"),
            (offset + 4.40, offset + 5.00, "endurance."),
        ]
    )


def passing_candidate(start=0.0, end=8.0, **overrides):
    value = {
        "title": "Less creates consistency",
        "start_time": start,
        "end_time": end,
        "speech_start_time": start,
        "speech_end_time": end,
        "opening_exact_quote": "Do less than you",
        "hook_signal_phrase": "Do less",
        "hook_payoff_phrase": "Do less than you think you can do",
        "hook_family": "contradiction",
        "new_viewer_understands_opening": True,
        "opens_with_context_connector": False,
        "contains_external_antecedent": False,
        "contains_host_setup": False,
        "first_second_value_score": 90,
        "specificity_score": 90,
        "relatability_score": 88,
        "stop_scroll_score": 92,
        "hook_gate_recommendation": "pass",
        "hook_gate_reasons": [
            "self_contained",
            "clear_contradiction",
            "immediate_payoff",
        ],
    }
    value.update(overrides)
    return value


class HookGateV2DecisionTests(unittest.TestCase):
    def setUp(self):
        self.policy = selection_settings(MOTIVATIONAL_TENSION_MICRO_V2)

    def evaluate(self, candidate=None, words=None):
        return evaluate_hook_gate_v2(
            candidate or passing_candidate(),
            passing_words() if words is None else words,
            self.policy,
        )

    def test_exact_boundary_signal_1s_and_payoff_3s_pass(self):
        decision = self.evaluate()

        self.assertEqual(decision["hook_gate_status"], "pass")
        self.assertTrue(decision["hook_gate_eligible"])
        self.assertEqual(decision["hook_signal_latency_seconds"], 1.0)
        self.assertEqual(decision["hook_payoff_latency_seconds"], 3.0)
        self.assertEqual(
            decision["hook_gate_decision_version"],
            HOOK_GATE_DECISION_VERSION,
        )
        self.assertEqual(decision["hook_gate_deterministic_reasons"], [])

    def test_signal_timing_allows_50ms_caption_tolerance(self):
        decision = self.evaluate(words=passing_words(signal_end=1.05))

        self.assertEqual(decision["hook_gate_status"], "pass")
        self.assertEqual(
            decision["hook_gate_thresholds"][
                "signal_timing_tolerance_seconds"
            ],
            0.05,
        )

    def test_signal_after_50ms_caption_tolerance_is_rejected(self):
        decision = self.evaluate(words=passing_words(signal_end=1.051))

        self.assertEqual(decision["hook_gate_status"], "reject")
        self.assertIn(
            "hook_gate_signal_after_1s",
            decision["hook_gate_reject_reasons"],
        )

    def test_payoff_at_3_001_seconds_is_rejected(self):
        decision = self.evaluate(words=passing_words(payoff_end=3.001))

        self.assertEqual(decision["hook_gate_status"], "reject")
        self.assertIn(
            "hook_gate_payoff_after_3s",
            decision["hook_gate_reject_reasons"],
        )

    def test_hallucinated_phrase_is_rejected(self):
        decision = self.evaluate(
            candidate=passing_candidate(
                hook_signal_phrase="Words never spoken",
            )
        )

        self.assertFalse(decision["hook_signal_aligned"])
        self.assertIn(
            "hook_gate_signal_unaligned",
            decision["hook_gate_reject_reasons"],
        )

    def test_opening_quote_must_begin_at_speech_start(self):
        words = timed_words(
            [(0.0, 0.20, "Well")]
            + [
                (word["start"] + 0.20, word["end"] + 0.20, word["word"])
                for word in passing_words()
            ]
        )
        decision = self.evaluate(words=words)

        self.assertFalse(decision["hook_opening_aligned"])
        self.assertIn(
            "hook_gate_opening_unaligned",
            decision["hook_gate_reject_reasons"],
        )

    def test_phrase_outside_candidate_is_not_allowed_to_match(self):
        candidate = passing_candidate(
            start=4.0,
            end=12.0,
            hook_signal_phrase="Never quit",
        )
        words = timed_words(
            [
                (1.50, 1.90, "Never"),
                (1.90, 2.20, "quit."),
                *[
                    (word["start"], word["end"], word["word"])
                    for word in passing_words(offset=4.0)
                ],
            ]
        )
        decision = self.evaluate(candidate=candidate, words=words)

        self.assertFalse(decision["hook_signal_aligned"])
        self.assertIn(
            "hook_gate_signal_unaligned",
            decision["hook_gate_reject_reasons"],
        )

    def test_phrase_crossing_candidate_end_is_not_allowed_to_match(self):
        candidate = passing_candidate(
            end=2.99,
            speech_end_time=2.99,
        )
        decision = self.evaluate(candidate=candidate)

        self.assertFalse(decision["hook_payoff_aligned"])
        self.assertIn(
            "hook_gate_payoff_unaligned",
            decision["hook_gate_reject_reasons"],
        )

    def test_real_context_connector_pattern_is_rejected(self):
        candidate = passing_candidate(
            opening_exact_quote="That's when I knew",
            hook_signal_phrase="I knew",
            hook_payoff_phrase="I knew the truth",
            hook_family="outcome_first",
        )
        words = timed_words(
            [
                (0.0, 0.25, "That's"),
                (0.25, 0.50, "when"),
                (0.50, 0.70, "I"),
                (0.70, 1.00, "knew"),
                (1.00, 1.30, "the"),
                (1.30, 1.70, "truth."),
            ]
        )
        decision = self.evaluate(candidate=candidate, words=words)

        self.assertEqual(decision["hook_gate_status"], "reject")
        self.assertIn(
            "hook_gate_context_connector",
            decision["hook_gate_reject_reasons"],
        )

    def test_external_pronoun_opening_is_rejected(self):
        candidate = passing_candidate(
            opening_exact_quote="It changed everything for me",
            hook_signal_phrase="It changed everything",
            hook_payoff_phrase="It changed everything for me",
            hook_family="outcome_first",
        )
        words = timed_words(
            [
                (0.0, 0.20, "It"),
                (0.20, 0.50, "changed"),
                (0.50, 0.80, "everything"),
                (0.80, 1.00, "for"),
                (1.00, 1.20, "me."),
            ]
        )
        decision = self.evaluate(candidate=candidate, words=words)

        self.assertIn(
            "hook_gate_external_antecedent",
            decision["hook_gate_reject_reasons"],
        )

    def test_self_contained_high_stakes_question_can_pass(self):
        candidate = passing_candidate(
            opening_exact_quote="Are you okay with yourself",
            hook_signal_phrase="Are you okay with yourself",
            hook_payoff_phrase="Are you okay with yourself",
            hook_family="identity_stakes",
        )
        words = timed_words(
            [
                (0.0, 0.20, "Are"),
                (0.20, 0.35, "you"),
                (0.35, 0.55, "okay"),
                (0.55, 0.70, "with"),
                (0.70, 1.00, "yourself?"),
            ]
        )
        decision = self.evaluate(candidate=candidate, words=words)

        self.assertEqual(decision["hook_gate_status"], "pass")
        self.assertNotIn(
            "hook_gate_host_setup",
            decision["hook_gate_deterministic_reasons"],
        )

    def test_curly_apostrophe_and_hyphenated_word_align(self):
        candidate = passing_candidate(
            opening_exact_quote="Self-control isn't optional today",
            hook_signal_phrase="Self-control isn't optional",
            hook_payoff_phrase="Self-control isn't optional",
            hook_family="concrete_rule",
        )
        words = timed_words(
            [
                (0.0, 0.30, "Self-control"),
                (0.30, 0.60, "isn’t"),
                (0.60, 1.00, "optional"),
                (1.00, 1.20, "today."),
            ]
        )
        decision = self.evaluate(candidate=candidate, words=words)

        self.assertEqual(decision["hook_gate_status"], "pass")
        self.assertEqual(decision["hook_signal_latency_seconds"], 1.0)

        aligned = align_motivational_boundaries(
            [
                {
                    **candidate,
                    "selection_profile": MOTIVATIONAL_TENSION_MICRO_V2,
                    "selection_policy_version": (
                        MOTIVATIONAL_TENSION_MICRO_V2
                    ),
                }
            ],
            {
                "duration": 8.0,
                "segments": [
                    {
                        "start": 0.0,
                        "end": 1.2,
                        "text": "Self-control isn’t optional today.",
                        "words": words,
                    }
                ],
            },
        )[0]
        self.assertEqual(aligned["hook_gate_status"], "pass")

    def test_missing_word_timing_is_review_never_pass(self):
        decision = self.evaluate(words=[])

        self.assertEqual(decision["hook_gate_status"], "review")
        self.assertFalse(decision["hook_gate_eligible"])
        self.assertIn(
            "hook_gate_word_timing_missing",
            decision["hook_gate_review_reasons"],
        )

    def test_model_reject_remains_fail_closed(self):
        decision = self.evaluate(
            candidate=passing_candidate(
                hook_gate_recommendation="reject",
                hook_gate_reasons=["generic_motivation"],
            )
        )

        self.assertEqual(decision["hook_gate_status"], "reject")
        self.assertIn(
            "hook_gate_model_reject",
            decision["hook_gate_reject_reasons"],
        )

    def test_model_review_is_not_silently_promoted(self):
        decision = self.evaluate(
            candidate=passing_candidate(
                hook_gate_recommendation="review",
            )
        )

        self.assertEqual(decision["hook_gate_status"], "review")
        self.assertIn(
            "hook_gate_model_review",
            decision["hook_gate_review_reasons"],
        )

    def test_motivational_alignment_stage_runs_v2_gate(self):
        words = passing_words()
        transcript = {
            "duration": 8.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 5.0,
                    "text": (
                        "Do less than you think you can do. "
                        "Consistency builds endurance."
                    ),
                    "words": words,
                }
            ],
        }
        candidate = passing_candidate(
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V2,
            selection_policy_version=MOTIVATIONAL_TENSION_MICRO_V2,
        )

        aligned = align_motivational_boundaries(
            [candidate],
            transcript,
        )[0]

        self.assertEqual(aligned["hook_gate_status"], "pass")
        self.assertEqual(
            aligned["hook_gate_decision_version"],
            HOOK_GATE_DECISION_VERSION,
        )

    def test_v2_alignment_anchors_start_to_opening_evidence(self):
        words = timed_words(
            [(0.0, 0.20, "Well")]
            + [
                (word["start"] + 0.30, word["end"] + 0.30, word["word"])
                for word in passing_words()
            ]
        )
        transcript = {
            "duration": 9.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 5.3,
                    "text": (
                        "Well. Do less than you think you can do. "
                        "Consistency builds endurance."
                    ),
                    "words": words,
                }
            ],
        }
        candidate = passing_candidate(
            start=0.0,
            end=8.3,
            speech_start_time=0.0,
            speech_end_time=8.3,
            hook_sentence="Well Do less than you think you can do",
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V2,
            selection_policy_version=MOTIVATIONAL_TENSION_MICRO_V2,
        )

        aligned = align_motivational_boundaries(
            [candidate],
            transcript,
        )[0]

        self.assertEqual(aligned["speech_start_time"], 0.3)
        self.assertTrue(aligned["hook_opening_aligned"])
        self.assertEqual(aligned["hook_gate_status"], "pass")

    def test_deterministic_evidence_changes_candidate_hash(self):
        passed = self.evaluate()
        changed = dict(passed)
        changed["hook_signal_latency_seconds"] = 0.999

        self.assertNotEqual(
            candidate_hash(passed, "a" * 64),
            candidate_hash(changed, "a" * 64),
        )

    def test_v1_boundary_alignment_remains_unchanged(self):
        words = timed_words(
            [
                (0.0, 0.2, "So"),
                (0.3, 0.5, "do"),
                (0.5, 0.8, "less"),
                (0.8, 1.0, "than"),
                (1.0, 1.2, "you"),
                (1.2, 1.5, "think"),
                (1.5, 1.7, "you"),
                (1.7, 1.9, "can"),
                (1.9, 2.2, "do."),
                (2.6, 2.9, "That"),
                (2.9, 3.2, "builds"),
                (3.2, 3.7, "endurance."),
            ]
        )
        transcript = {
            "duration": 5.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 3.7,
                    "text": (
                        "So do less than you think you can do. "
                        "That builds endurance."
                    ),
                    "words": words,
                }
            ],
        }
        candidate = {
            "start_time": 0.0,
            "end_time": 3.7,
            "speech_start_time": 0.0,
            "speech_end_time": 3.7,
            "hook_sentence": "Do less than you think you can do.",
            "hook_payoff_phrase": "Do less than you think you can do.",
            "earliest_complete_takeaway_sentence": "That builds endurance.",
            "selection_profile": MOTIVATIONAL_TENSION_MICRO_V1,
        }

        aligned = align_motivational_boundaries(
            [candidate],
            transcript,
        )[0]

        self.assertEqual(aligned["speech_start_time"], 0.3)
        self.assertEqual(aligned["speech_end_time"], 3.7)
        self.assertEqual(aligned["hook_payoff_latency_seconds"], 1.9)
        self.assertNotIn("hook_gate_status", aligned)

    def test_decision_version_changes_only_v2_final_cache_lineage(self):
        transcript = {
            "duration": 8.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 5.0,
                    "text": "Do less than you think you can do.",
                    "words": passing_words(),
                }
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            v1_before, _ = _discovery_cache_path(
                directory,
                transcript,
                1,
                "motivational_podcast",
                MOTIVATIONAL_TENSION_MICRO_V1,
                "cache-test",
            )
            v2_before, _ = _discovery_cache_path(
                directory,
                transcript,
                1,
                "motivational_podcast",
                MOTIVATIONAL_TENSION_MICRO_V2,
                "cache-test",
            )
            with patch.dict(
                SELECTION_PROFILES[MOTIVATIONAL_TENSION_MICRO_V2],
                {"hook_gate_decision_version": "hook-gate-decision-test"},
            ):
                v1_after, _ = _discovery_cache_path(
                    directory,
                    transcript,
                    1,
                    "motivational_podcast",
                    MOTIVATIONAL_TENSION_MICRO_V1,
                    "cache-test",
                )
                v2_after, _ = _discovery_cache_path(
                    directory,
                    transcript,
                    1,
                    "motivational_podcast",
                    MOTIVATIONAL_TENSION_MICRO_V2,
                    "cache-test",
                )

        self.assertEqual(v1_before, v1_after)
        self.assertNotEqual(v2_before, v2_after)


class HookGateV2RankerIntegrationTests(unittest.TestCase):
    @staticmethod
    def ranking_candidate(selection_profile, **overrides):
        value = {
            **passing_candidate(start=0.0, end=10.0),
            "selection_profile": selection_profile,
            "selection_policy_version": selection_profile,
            "score": 90,
            "hook_score": 90,
            "standalone_score": 90,
            "development_score": 90,
            "takeaway_score": 90,
            "emotional_conviction_score": 90,
            "quotability_score": 90,
            "closure_score": 90,
            "title_fit_score": 90,
            "has_hook": True,
            "has_development": True,
            "has_takeaway": True,
            "has_complete_ending": True,
            "is_promotional": False,
            "is_outro": False,
            "requires_previous_context": False,
            "is_standalone_one_liner": False,
            "semantic_tension_score": 90,
            "contrast_score": 90,
            "conflict_score": 90,
            "reversal_score": 80,
            "listener_payoff_score": 90,
            "self_contained_micro_arc_score": 90,
            "generic_motivation_score": 0,
            "context_dependence_score": 0,
            "reaction_tail_compatibility_score": 80,
            "hook_payoff_aligned": True,
            "takeaway_boundary_aligned": True,
            "source_cut_count": 0,
            "artificial_cut_count": 0,
        }
        value.update(overrides)
        return value

    def setUp(self):
        self.transcript = {
            "duration": 20.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 10.0,
                    "text": (
                        "Do less than you think you can do. "
                        "Consistency builds endurance."
                    ),
                }
            ],
        }

    def test_v2_ranker_fails_closed_without_deterministic_decision(self):
        ranked = rank_highlights(
            [self.ranking_candidate(MOTIVATIONAL_TENSION_MICRO_V2)],
            self.transcript,
            content_type="motivational_podcast",
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V2,
        )[0]

        self.assertTrue(ranked["rejected"])
        self.assertIn(
            "hook_gate_decision_missing",
            ranked["rejection_reasons"],
        )

    def test_v2_ranker_accepts_current_passing_decision_contract(self):
        evaluated = evaluate_hook_gate_v2(
            self.ranking_candidate(MOTIVATIONAL_TENSION_MICRO_V2),
            passing_words(),
            selection_settings(MOTIVATIONAL_TENSION_MICRO_V2),
        )
        evaluated.update(
            {
                "semantic_closure_status": "pass",
                "semantic_closure_eligible": True,
                "semantic_closure_decision_version": (
                    SEMANTIC_CLOSURE_DECISION_VERSION
                ),
                "semantic_closure_deterministic_reasons": [],
                "semantic_closure_duration_fit_score": 100.0,
            }
        )
        ranked = rank_highlights(
            [evaluated],
            self.transcript,
            content_type="motivational_podcast",
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V2,
        )[0]

        self.assertFalse(ranked["rejected"])
        self.assertNotIn(
            "hook_gate_decision_missing",
            ranked["rejection_reasons"],
        )
        self.assertNotIn(
            "hook_gate_decision_version_mismatch",
            ranked["rejection_reasons"],
        )

    def test_v1_ranker_does_not_require_hook_gate(self):
        ranked = rank_highlights(
            [self.ranking_candidate(MOTIVATIONAL_TENSION_MICRO_V1)],
            self.transcript,
            content_type="motivational_podcast",
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        )[0]

        self.assertNotIn(
            "hook_gate_decision_missing",
            ranked["rejection_reasons"],
        )


if __name__ == "__main__":
    unittest.main()
