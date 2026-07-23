import tempfile
import unittest
from unittest.mock import patch

from shorts_generator.highlights import (
    _discovery_cache_path,
    align_motivational_boundaries,
)
from shorts_generator.local.clipper import _bf_editorial_tail_plan
from shorts_generator.motivational_closure import (
    NATURAL_TAIL_POLICY_VERSION,
    SEMANTIC_CLOSURE_DECISION_VERSION,
    evaluate_motivational_closure_v1,
)
from shorts_generator.profiles import (
    BF_NATURAL_TAIL_V6,
    MOTIVATIONAL_TENSION_MICRO_V1,
    MOTIVATIONAL_TENSION_MICRO_V2,
    SELECTION_PROFILES,
    selection_settings,
)
from shorts_generator.ranker import rank_highlights


def word(start, end, text):
    return {"start": start, "end": end, "word": text}


def closure_words(
    *,
    speech_end=16.0,
    next_word_start=16.6,
    include_next=True,
):
    values = [
        word(0.0, 0.4, "Pressure"),
        word(0.4, 0.8, "creates"),
        word(0.8, 1.0, "bad"),
        word(1.0, 1.3, "decisions."),
        word(10.0, 12.0, "That"),
        word(12.0, 13.0, "is"),
        word(13.0, 14.0, "how"),
        word(14.0, 14.7, "consistency"),
        word(14.7, 15.3, "becomes"),
        word(15.3, speech_end, "sustainable."),
    ]
    if include_next:
        values.append(word(next_word_start, next_word_start + 0.4, "Next"))
    return values


def transcript_for(words, duration=30.0):
    return {
        "duration": duration,
        "segments": [
            {
                "start": 0.0,
                "end": duration,
                "text": " ".join(item["word"] for item in words),
                "words": words,
            }
        ],
    }


def closure_candidate(end=16.0, **overrides):
    value = {
        "title": "Consistency becomes sustainable",
        "start_time": 0.0,
        "end_time": end,
        "speech_start_time": 0.0,
        "speech_end_time": end,
        "semantic_closure_sentence": (
            "That is how consistency becomes sustainable"
        ),
        "earliest_complete_takeaway_sentence": (
            "That is how consistency becomes sustainable"
        ),
        "takeaway_boundary_aligned": True,
        "semantic_continuation_required": False,
        "has_complete_ending": True,
        "has_takeaway": True,
        "second_topic_begins_after_takeaway": False,
        "stop_scroll_score": 90,
        "listener_payoff_score": 90,
        "self_contained_micro_arc_score": 90,
        "closure_score": 90,
    }
    value.update(overrides)
    return value


class MotivationalClosureDecisionTests(unittest.TestCase):
    def setUp(self):
        self.policy = selection_settings(MOTIVATIONAL_TENSION_MICRO_V2)

    def evaluate(self, candidate=None, words=None, duration=30.0):
        measured_words = closure_words() if words is None else words
        return evaluate_motivational_closure_v1(
            candidate or closure_candidate(),
            transcript_for(measured_words, duration=duration),
            self.policy,
        )

    def test_exact_complete_endpoint_passes_and_plans_authentic_tail(self):
        decision = self.evaluate()

        self.assertEqual(decision["semantic_closure_status"], "pass")
        self.assertTrue(decision["semantic_closure_eligible"])
        self.assertEqual(
            decision["semantic_closure_decision_version"],
            SEMANTIC_CLOSURE_DECISION_VERSION,
        )
        self.assertEqual(
            decision["natural_tail_policy_version"],
            NATURAL_TAIL_POLICY_VERSION,
        )
        self.assertEqual(decision["natural_tail_start_time"], 16.0)
        self.assertEqual(decision["natural_tail_end_time"], 16.56)
        self.assertEqual(decision["planned_natural_tail_seconds"], 0.56)
        self.assertEqual(decision["post_source_fade_start_time"], 16.56)
        self.assertEqual(decision["freeze_hold_seconds"], 0.0)

    def test_unaligned_closing_quote_is_rejected(self):
        decision = self.evaluate(
            candidate=closure_candidate(
                semantic_closure_sentence="Words never spoken",
            )
        )

        self.assertEqual(decision["semantic_closure_status"], "reject")
        self.assertIn(
            "closure_exact_quote_unaligned",
            decision["semantic_closure_reject_reasons"],
        )

    def test_required_continuation_is_never_truncated_to_fit(self):
        decision = self.evaluate(
            candidate=closure_candidate(
                semantic_continuation_required=True,
                has_complete_ending=False,
            )
        )

        self.assertIn(
            "closure_required_continuation_missing",
            decision["semantic_closure_reject_reasons"],
        )
        self.assertIn(
            "closure_model_incomplete_ending",
            decision["semantic_closure_reject_reasons"],
        )

    def test_connector_ending_is_rejected(self):
        words = [
            *closure_words(include_next=False)[:-1],
            word(15.3, 15.6, "which"),
            word(15.6, 16.0, "means"),
            word(16.6, 17.0, "Next"),
        ]
        decision = self.evaluate(
            candidate=closure_candidate(
                semantic_closure_sentence="which means",
                earliest_complete_takeaway_sentence="which means",
            ),
            words=words,
        )

        self.assertIn(
            "closure_ends_with_connector",
            decision["semantic_closure_reject_reasons"],
        )

    def test_25_001_second_clip_requires_strong_evidence(self):
        words = closure_words(speech_end=25.001, next_word_start=25.7)
        weak = closure_candidate(
            end=25.001,
            stop_scroll_score=84,
        )
        decision = self.evaluate(candidate=weak, words=words, duration=40.0)

        self.assertEqual(decision["semantic_closure_status"], "review")
        self.assertIn(
            "closure_long_clip_requires_strong_evidence",
            decision["semantic_closure_review_reasons"],
        )

    def test_25_001_second_clip_can_pass_with_strong_evidence(self):
        words = closure_words(speech_end=25.001, next_word_start=25.7)
        decision = self.evaluate(
            candidate=closure_candidate(end=25.001),
            words=words,
            duration=40.0,
        )

        self.assertEqual(decision["semantic_closure_status"], "pass")
        self.assertEqual(
            decision["semantic_closure_duration_bucket"],
            "strong_evidence_only",
        )

    def test_30_001_second_clip_is_rejected_even_when_strong(self):
        words = closure_words(speech_end=30.001, next_word_start=30.7)
        decision = self.evaluate(
            candidate=closure_candidate(end=30.001),
            words=words,
            duration=40.0,
        )

        self.assertIn(
            "closure_duration_over_hard_max",
            decision["semantic_closure_reject_reasons"],
        )

    def test_missing_word_timings_returns_review(self):
        decision = evaluate_motivational_closure_v1(
            closure_candidate(),
            {"duration": 30.0, "segments": []},
            self.policy,
        )

        self.assertEqual(decision["semantic_closure_status"], "review")
        self.assertIn(
            "closure_word_timing_missing",
            decision["semantic_closure_review_reasons"],
        )

    def test_immediate_next_word_never_leaks_into_tail(self):
        words = closure_words(next_word_start=16.02)
        decision = self.evaluate(words=words)

        self.assertEqual(decision["natural_tail_end_time"], 16.0)
        self.assertEqual(decision["planned_natural_tail_seconds"], 0.0)
        self.assertLess(
            decision["natural_tail_end_time"],
            decision["next_spoken_word_start"],
        )

    def test_end_of_source_tail_is_bounded_to_750ms(self):
        words = closure_words(include_next=False)
        decision = self.evaluate(words=words, duration=30.0)

        self.assertEqual(decision["natural_tail_end_time"], 16.75)
        self.assertEqual(decision["planned_natural_tail_seconds"], 0.75)


class GrowthV2ClosureIntegrationTests(unittest.TestCase):
    def test_v6_renderer_uses_live_source_then_fades_with_zero_freeze(self):
        plan = _bf_editorial_tail_plan(
            transcript_for(closure_words(), duration=30.0),
            speech_end_time=16.0,
            brand_tail_seconds=0.85,
            tail_profile=BF_NATURAL_TAIL_V6,
            semantic_closure_decision_version=(
                SEMANTIC_CLOSURE_DECISION_VERSION
            ),
            planned_natural_tail_end_time=16.56,
        )

        self.assertEqual(plan["source_content_end_time"], 16.56)
        self.assertEqual(plan["visual_transition_start_time"], 16.56)
        self.assertEqual(plan["transition_tail_seconds"], 0.13)
        self.assertEqual(plan["freeze_hold_seconds"], 0.0)
        self.assertAlmostEqual(plan["natural_tail_seconds"], 0.56)
        self.assertTrue(plan["source_speech_leak_guard_passed"])

    def test_v6_renderer_fails_closed_without_closure_seal(self):
        with self.assertRaisesRegex(ValueError, "sealed semantic-closure"):
            _bf_editorial_tail_plan(
                transcript_for(closure_words(), duration=30.0),
                speech_end_time=16.0,
                brand_tail_seconds=0.85,
                tail_profile=BF_NATURAL_TAIL_V6,
            )

    def test_v6_never_audio_fades_the_final_word_when_no_tail_exists(self):
        plan = _bf_editorial_tail_plan(
            transcript_for(
                closure_words(next_word_start=16.02),
                duration=30.0,
            ),
            speech_end_time=16.0,
            brand_tail_seconds=0.85,
            tail_profile=BF_NATURAL_TAIL_V6,
            semantic_closure_decision_version=(
                SEMANTIC_CLOSURE_DECISION_VERSION
            ),
            planned_natural_tail_end_time=16.0,
        )

        self.assertEqual(plan["natural_tail_seconds"], 0.0)
        self.assertEqual(plan["audio_transition_tail_seconds"], 0.0)
        self.assertEqual(plan["speech_audio_end_time"], 16.0)
        self.assertEqual(plan["freeze_hold_seconds"], 0.0)

    def test_alignment_runs_hook_and_closure_decisions_for_v2(self):
        words = [
            word(0.0, 0.4, "Do"),
            word(0.4, 0.8, "less"),
            word(0.8, 1.2, "than"),
            word(1.2, 1.6, "you"),
            word(1.6, 2.0, "think"),
            word(2.0, 2.4, "you"),
            word(2.4, 2.7, "can"),
            word(2.7, 3.0, "do."),
            word(5.0, 6.0, "Consistency"),
            word(6.0, 7.0, "becomes"),
            word(7.0, 8.0, "sustainable."),
            word(8.5, 8.9, "Next"),
        ]
        transcript = transcript_for(words, duration=12.0)
        candidate = {
            "title": "Do less",
            "start_time": 0.0,
            "end_time": 8.0,
            "speech_start_time": 0.0,
            "speech_end_time": 8.0,
            "hook_sentence": "Do less than you think you can do",
            "hook_payoff_phrase": "Do less than you think you can do",
            "opening_exact_quote": "Do less than you",
            "hook_signal_phrase": "Do less",
            "hook_family": "contradiction",
            "new_viewer_understands_opening": True,
            "opens_with_context_connector": False,
            "contains_external_antecedent": False,
            "contains_host_setup": False,
            "first_second_value_score": 90,
            "specificity_score": 90,
            "relatability_score": 90,
            "stop_scroll_score": 90,
            "hook_gate_recommendation": "pass",
            "hook_gate_reasons": [
                "self_contained",
                "clear_contradiction",
                "immediate_payoff",
            ],
            "earliest_complete_takeaway_sentence": (
                "Consistency becomes sustainable"
            ),
            "final_takeaway_sentence": "Consistency becomes sustainable",
            "has_takeaway": True,
            "has_complete_ending": True,
            "second_topic_begins_after_takeaway": False,
            "listener_payoff_score": 90,
            "self_contained_micro_arc_score": 90,
            "closure_score": 90,
            "selection_profile": MOTIVATIONAL_TENSION_MICRO_V2,
            "selection_policy_version": MOTIVATIONAL_TENSION_MICRO_V2,
        }

        aligned = align_motivational_boundaries([candidate], transcript)[0]

        self.assertEqual(aligned["hook_gate_status"], "pass")
        self.assertEqual(aligned["semantic_closure_status"], "pass")
        self.assertEqual(aligned["natural_tail_end_time"], 8.46)
        self.assertEqual(aligned["freeze_hold_seconds"], 0.0)

    def test_v2_ranker_fails_closed_without_closure_decision(self):
        candidate = closure_candidate(
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V2,
            hook_gate_status="pass",
            hook_gate_eligible=True,
            hook_gate_decision_version="hook-gate-decision-v1.0.0",
            hook_gate_deterministic_reasons=[],
            has_hook=True,
            has_development=True,
            score=90,
            hook_score=90,
            standalone_score=90,
            development_score=90,
            takeaway_score=90,
            emotional_conviction_score=90,
            quotability_score=90,
            semantic_tension_score=90,
            contrast_score=90,
            conflict_score=90,
            reversal_score=90,
            generic_motivation_score=0,
            context_dependence_score=0,
            hook_payoff_aligned=True,
            source_cut_count=0,
            artificial_cut_count=0,
        )

        ranked = rank_highlights(
            [candidate],
            transcript_for(closure_words(), duration=30.0),
            content_type="motivational_podcast",
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V2,
        )[0]

        self.assertTrue(ranked["rejected"])
        self.assertIn(
            "semantic_closure_decision_missing",
            ranked["rejection_reasons"],
        )

    def test_v1_alignment_does_not_emit_v2_closure_fields(self):
        candidate = closure_candidate(
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
            hook_sentence="Pressure creates bad decisions",
            hook_payoff_phrase="Pressure creates bad decisions",
        )
        aligned = align_motivational_boundaries(
            [candidate],
            transcript_for(closure_words(), duration=30.0),
        )[0]

        self.assertNotIn("semantic_closure_status", aligned)
        self.assertNotIn("natural_tail_policy_version", aligned)

    def test_closure_version_change_invalidates_only_v2_cache_lineage(self):
        transcript = transcript_for(closure_words(), duration=30.0)
        with tempfile.TemporaryDirectory() as directory:
            v1_before, _ = _discovery_cache_path(
                directory,
                transcript,
                1,
                "motivational_podcast",
                MOTIVATIONAL_TENSION_MICRO_V1,
                "closure-cache-test",
            )
            v2_before, _ = _discovery_cache_path(
                directory,
                transcript,
                1,
                "motivational_podcast",
                MOTIVATIONAL_TENSION_MICRO_V2,
                "closure-cache-test",
            )
            with patch.dict(
                SELECTION_PROFILES[MOTIVATIONAL_TENSION_MICRO_V2],
                {
                    "semantic_closure_decision_version": (
                        "semantic-closure-decision-test"
                    )
                },
            ):
                v1_after, _ = _discovery_cache_path(
                    directory,
                    transcript,
                    1,
                    "motivational_podcast",
                    MOTIVATIONAL_TENSION_MICRO_V1,
                    "closure-cache-test",
                )
                v2_after, _ = _discovery_cache_path(
                    directory,
                    transcript,
                    1,
                    "motivational_podcast",
                    MOTIVATIONAL_TENSION_MICRO_V2,
                    "closure-cache-test",
                )

        self.assertEqual(v1_before, v1_after)
        self.assertNotEqual(v2_before, v2_after)


if __name__ == "__main__":
    unittest.main()
