import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from shorts_generator.brand_tail_experiment import (
    BRAND_TAIL_EXPERIMENT_ID,
    build_brand_tail_render_candidates,
    build_short_brand_tail_experiment_manifest,
    render_short_brand_tail_experiment,
    verify_decoded_frame_sequences,
    verify_only_brand_tail_axis,
)
from shorts_generator.hook_gate_v3 import (
    BF_FEED_STOP_POLICY_VERSION,
    HOOK_GATE_V3_VERSION,
    build_hook_gate_v3_report,
    evaluate_hook_gate_v3,
    evaluate_hook_gate_v3_cached,
)
from shorts_generator.highlights import align_motivational_boundaries
from shorts_generator.local.clipper import (
    _require_realesrgan_runtime,
    _resolve_bf_brand_tail_seconds,
)
from shorts_generator.motivational_closure import (
    SEMANTIC_CLOSURE_DECISION_VERSION,
    evaluate_motivational_closure_v1,
)
from shorts_generator.profiles import (
    BF_EDITORIAL_INSET_V2,
    BF_FEED_STOP_FORMAT_V1,
    BF_FEED_STOP_V1,
    BF_NATURAL_TAIL_V6,
    MOTIVATIONAL_PODCAST,
    SPEECH_CLEANLINESS_DECISION_VERSION,
    render_settings_for_content,
    resolve_profile_bundle,
    selection_settings,
)
from shorts_generator.ranker import rank_highlights, select_diverse_highlights


FIXTURE = (
    Path(__file__).parent
    / "fixtures"
    / "hook_gate_v3_regressions.json"
)
SHA_A = "a" * 64
SHA_B = "b" * 64


def timed_words(text, step=0.30, offset=0.0):
    return [
        {
            "start": round(offset + index * step, 3),
            "end": round(offset + (index + 1) * step, 3),
            "word": word,
        }
        for index, word in enumerate(text.split())
    ]


def candidate_for(text, *, duration=12.0, **overrides):
    words = timed_words(text)
    candidate = {
        "title": text,
        "topic": text,
        "start_time": 0.0,
        "end_time": duration,
        "render_start_time": 0.0,
        "speech_start_time": 0.0,
        "speech_end_time": duration,
        "opening_exact_quote": " ".join(text.split()[:10]),
        "hook_payoff_phrase": "",
        "has_complete_ending": True,
        "has_takeaway": True,
        "second_topic_begins_after_takeaway": False,
        "quotability_score": 90,
    }
    candidate.update(overrides)
    return candidate, words


def rankable_feed_stop_candidate():
    candidate, words = candidate_for(
        "If you're nervous, stop thinking about yourself."
    )
    evaluated = evaluate_hook_gate_v3(candidate, words)
    evaluated.update(
        {
            "selection_profile": BF_FEED_STOP_V1,
            "selection_policy_version": BF_FEED_STOP_V1,
            "has_hook": True,
            "has_development": True,
            "has_takeaway": True,
            "has_complete_ending": True,
            "hook_payoff_aligned": True,
            "takeaway_boundary_aligned": True,
            "semantic_continuation_required": False,
            "semantic_closure_status": "pass",
            "semantic_closure_eligible": True,
            "semantic_closure_decision_version": (
                SEMANTIC_CLOSURE_DECISION_VERSION
            ),
            "semantic_closure_deterministic_reasons": [],
            "semantic_tension_score": 90,
            "self_contained_micro_arc_score": 90,
            "context_dependence_score": 0,
            "generic_motivation_score": 0,
        }
    )
    return evaluated, transcript_for_words(words, duration=12.0)


class HookGateV3Tests(unittest.TestCase):
    def evaluate(self, text, **overrides):
        candidate, words = candidate_for(text, **overrides)
        return evaluate_hook_gate_v3(
            candidate,
            words,
            selection_settings(BF_FEED_STOP_V1),
        )

    def test_01_concrete_metaphor_passes(self):
        result = self.evaluate(
            "When you like a flower, you simply pluck it."
        )
        self.assertEqual(result["hookGateStatus"], "pass")
        self.assertEqual(result["hookFamily"], "visual_metaphor")
        self.assertGreaterEqual(result["hookGateScore"], 80)

    def test_02_direct_rule_passes(self):
        result = self.evaluate(
            "If you're nervous, stop thinking about yourself."
        )
        self.assertEqual(result["hookGateStatus"], "pass")
        self.assertEqual(result["hookFamily"], "concrete_rule")
        self.assertLessEqual(result["firstActionableRuleSeconds"], 2.0)

    def test_03_abstract_definition_gets_substantial_penalty(self):
        result = self.evaluate(
            "What makes us nervous is being self-conscious."
        )
        penalties = {
            item["reason"]: item["points"]
            for item in result["hookGatePenalties"]
        }
        self.assertEqual(result["hookGateStatus"], "reject")
        self.assertGreater(result["openingAbstractionScore"], 35)
        self.assertGreaterEqual(penalties["abstract_opening"], 15)

    def test_04_slow_contextual_introduction_is_rejected(self):
        result = self.evaluate(
            "The reason is that one of the things we notice later matters."
        )
        self.assertIn(
            "hook_v3_context_dependent_opening",
            result["hookGateRejectionReasons"],
        )

    def test_05_claim_after_three_seconds_rejects_or_reviews(self):
        result = self.evaluate(
            "There are many ideas people discuss every day before danger appears."
        )
        self.assertNotEqual(result["hookGateStatus"], "pass")

    def test_06_excellent_hook_with_incomplete_ending_is_rejected(self):
        result = self.evaluate(
            "If you're nervous, stop thinking about yourself.",
            has_complete_ending=False,
        )
        self.assertIn(
            "hook_v3_incomplete_ending",
            result["hookGateRejectionReasons"],
        )

    def test_touching_words_outside_half_open_speech_interval_are_excluded(self):
        candidate = {
            "title": "Boundaries are self-respect",
            "topic": "boundaries",
            "start_time": 10.0,
            "render_start_time": 10.0,
            "end_time": 12.0,
            "speech_start_time": 10.0,
            "speech_end_time": 12.0,
            "opening_exact_quote": "Stop accepting disrespect now.",
            "hook_payoff_phrase": "stop accepting disrespect",
            "has_complete_ending": True,
            "has_takeaway": True,
            "second_topic_begins_after_takeaway": False,
            "quotability_score": 90,
        }
        words = [
            {"start": 9.7, "end": 10.0, "word": "Earlier."},
            {"start": 10.0, "end": 10.3, "word": "Stop"},
            {"start": 10.3, "end": 10.7, "word": "accepting"},
            {"start": 10.7, "end": 11.3, "word": "disrespect"},
            {"start": 11.3, "end": 12.0, "word": "now."},
            {"start": 12.0, "end": 12.3, "word": "Next"},
        ]

        result = evaluate_hook_gate_v3(
            candidate,
            words,
            selection_settings(BF_FEED_STOP_V1),
        )

        self.assertEqual(result["firstWordLatencyMs"], 0.0)
        self.assertNotIn(
            "hook_v3_opening_not_on_word_boundary",
            result["hookGateRejectionReasons"],
        )
        self.assertNotIn(
            "hook_v3_render_starts_inside_first_word",
            result["hookGateRejectionReasons"],
        )
        self.assertEqual(result["openingWordCountAtTwoSeconds"], 4)

    def test_07_complete_point_with_045s_reaction_passes(self):
        transcript, candidate = natural_tail_fixture()
        result = evaluate_motivational_closure_v1(
            candidate,
            transcript,
            selection_settings(BF_FEED_STOP_V1),
        )
        self.assertTrue(result["semantic_closure_eligible"])
        self.assertEqual(result["planned_natural_tail_seconds"], 0.41)

    def test_08_next_sentence_never_enters_natural_tail(self):
        transcript, candidate = natural_tail_fixture()
        result = evaluate_motivational_closure_v1(
            candidate,
            transcript,
            selection_settings(BF_FEED_STOP_V1),
        )
        self.assertLess(
            result["natural_tail_end_time"],
            result["next_spoken_word_start"],
        )
        self.assertEqual(result["natural_tail_end_time"], 12.41)

    def test_09_captions_end_at_acoustic_speech_end(self):
        transcript, candidate = natural_tail_fixture()
        result = evaluate_motivational_closure_v1(
            candidate,
            transcript,
            selection_settings(BF_FEED_STOP_V1),
        )
        self.assertEqual(result["captions_source_end_time"], 12.0)

    def test_10_v3_format_freezes_render_axes(self):
        resolved = resolve_profile_bundle(format_profile=BF_FEED_STOP_FORMAT_V1)
        settings = render_settings_for_content(
            MOTIVATIONAL_PODCAST,
            render_profile=resolved["render_profile"],
            selection_profile=resolved["selection_profile"],
            format_profile=resolved["format_profile"],
        )
        self.assertEqual(resolved["selection_profile"], BF_FEED_STOP_V1)
        self.assertEqual(resolved["render_profile"], BF_EDITORIAL_INSET_V2)
        self.assertEqual(settings["layout_hint"], "editorial_inset")
        self.assertEqual(settings["caption_style"], BF_EDITORIAL_INSET_V2)
        self.assertEqual(settings["brand_tail_profile"], BF_NATURAL_TAIL_V6)

    def test_11_brand_tail_experiment_changes_one_axis(self):
        settings = render_settings_for_content(
            MOTIVATIONAL_PODCAST,
            render_profile=BF_EDITORIAL_INSET_V2,
            selection_profile=BF_FEED_STOP_V1,
        )
        manifest = build_short_brand_tail_experiment_manifest(
            candidate_hash=SHA_A,
            source_hash=SHA_B,
            source_interval=(10.0, 22.0),
            render_settings=settings,
        )
        control, variant = build_brand_tail_render_candidates(
            {"candidate_hash": SHA_A, "start_time": 10.0, "end_time": 22.0},
            manifest,
        )
        report = verify_only_brand_tail_axis(control, variant)
        self.assertEqual(manifest["experimentId"], BRAND_TAIL_EXPERIMENT_ID)
        self.assertEqual(manifest["changedAxes"], ["brandTailDuration"])
        self.assertEqual(report["changedAxes"], ["brandTailDuration"])
        self.assertEqual(
            _resolve_bf_brand_tail_seconds(
                BF_EDITORIAL_INSET_V2,
                BF_NATURAL_TAIL_V6,
                control["brand_tail_seconds"],
            ),
            0.85,
        )
        self.assertEqual(
            _resolve_bf_brand_tail_seconds(
                BF_EDITORIAL_INSET_V2,
                BF_NATURAL_TAIL_V6,
                variant["brand_tail_seconds"],
            ),
            0.40,
        )

    def test_12_realesrgan_cannot_silently_fallback(self):
        with self.assertRaisesRegex(RuntimeError, "runtime/models"):
            _require_realesrgan_runtime(True, None)
        self.assertTrue(
            _require_realesrgan_runtime(True, ("/bin/realesrgan", "/models"))
        )

    def test_13_regression_ranking(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        results = {}
        for case in fixture["cases"]:
            result = self.evaluate(case["text"])
            results[case["id"]] = result
            self.assertEqual(result["hookGateStatus"], case["expectedStatus"])
            self.assertEqual(result["hookFamily"], case["expectedFamily"])
        self.assertGreater(
            results["liking_vs_loving_winner"]["hookGateScore"],
            results["current_vinh_abstract"]["hookGateScore"],
        )
        self.assertGreater(
            results["vinh_direct_rule"]["hookGateScore"],
            results["current_vinh_abstract"]["hookGateScore"],
        )

    def test_14_render_settings_do_not_change_semantic_ranking(self):
        candidate, words = candidate_for(
            "The people gossiping about you are already behind you."
        )
        control = evaluate_hook_gate_v3(candidate, words)
        rendered = evaluate_hook_gate_v3(
            {
                **candidate,
                "render_profile": "some_other_profile",
                "layout_hint": "some_other_layout",
                "caption_style": "some_other_captions",
                "enhancement_scale": 99,
            },
            words,
        )
        self.assertEqual(control["hookGateScore"], rendered["hookGateScore"])

    def test_15_cache_is_keyed_and_reused_without_media_work(self):
        candidate, words = candidate_for(
            "If you're nervous, stop thinking about yourself."
        )
        with tempfile.TemporaryDirectory() as directory:
            first = evaluate_hook_gate_v3_cached(
                candidate,
                words,
                transcript_hash=SHA_A,
                cache_dir=directory,
            )
            second = evaluate_hook_gate_v3_cached(
                candidate,
                words,
                transcript_hash=SHA_A,
                cache_dir=directory,
            )
        self.assertFalse(first["hook_gate_v3_cache_hit"])
        self.assertTrue(second["hook_gate_v3_cache_hit"])
        self.assertEqual(first["hookGateScore"], second["hookGateScore"])

    def test_16_decoded_prefix_verification_fails_closed(self):
        matching = verify_decoded_frame_sequences(
            [b"frame-a", b"frame-b"],
            [b"frame-a", b"frame-b"],
        )
        self.assertTrue(matching["identical"])
        with self.assertRaisesRegex(ValueError, "decoded frames differ"):
            verify_decoded_frame_sequences(
                [b"frame-a"],
                [b"changed"],
            )

    def test_17_report_contains_versions_and_failure_reasons(self):
        result = self.evaluate(
            "What makes us nervous is being self-conscious."
        )
        report = build_hook_gate_v3_report(
            result,
            render_settings={
                "render_profile": BF_EDITORIAL_INSET_V2,
                "layout_hint": "editorial_inset",
                "caption_style": BF_EDITORIAL_INSET_V2,
            },
        )
        self.assertEqual(report["hookGateVersion"], HOOK_GATE_V3_VERSION)
        self.assertEqual(
            report["selectionPolicyVersion"],
            BF_FEED_STOP_POLICY_VERSION,
        )
        self.assertTrue(report["rejectionReasons"])
        self.assertEqual(report["renderProfile"], BF_EDITORIAL_INSET_V2)

    def test_18_diversity_prefers_distinct_hook_families(self):
        ranked = [
            diverse_candidate("one", "confidence", "concrete_rule", 95),
            diverse_candidate("two", "boundaries", "concrete_rule", 94),
            diverse_candidate(
                "three",
                "gossip",
                "interpersonal_conflict",
                90,
            ),
        ]
        selected = select_diverse_highlights(ranked, 2)
        self.assertEqual(
            [item["hookFamily"] for item in selected],
            ["concrete_rule", "interpersonal_conflict"],
        )

    def test_19_ranker_fails_closed_without_v3_decision(self):
        candidate, words = candidate_for(
            "If you're nervous, stop thinking about yourself."
        )
        transcript = transcript_for_words(words, duration=12.0)
        [ranked] = rank_highlights(
            [candidate],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=BF_FEED_STOP_V1,
        )
        self.assertTrue(ranked["rejected"])
        self.assertIn(
            "hook_gate_decision_missing",
            ranked["rejection_reasons"],
        )

    def test_20_v3_score_is_authoritative_in_ranker(self):
        candidate, words = candidate_for(
            "If you're nervous, stop thinking about yourself."
        )
        evaluated = evaluate_hook_gate_v3(candidate, words)
        evaluated.update(
            {
                "selection_profile": BF_FEED_STOP_V1,
                "selection_policy_version": BF_FEED_STOP_V1,
                "has_hook": True,
                "has_development": True,
                "has_takeaway": True,
                "has_complete_ending": True,
                "hook_payoff_aligned": True,
                "takeaway_boundary_aligned": True,
                "semantic_continuation_required": False,
                "semantic_closure_status": "pass",
                "semantic_closure_eligible": True,
                "semantic_closure_decision_version": (
                    SEMANTIC_CLOSURE_DECISION_VERSION
                ),
                "semantic_closure_deterministic_reasons": [],
                "semantic_tension_score": 90,
                "self_contained_micro_arc_score": 90,
                "context_dependence_score": 0,
                "generic_motivation_score": 0,
            }
        )
        transcript = transcript_for_words(words, duration=12.0)
        [ranked] = rank_highlights(
            [evaluated],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=BF_FEED_STOP_V1,
        )
        self.assertFalse(ranked["rejected"])
        self.assertEqual(ranked["final_score"], evaluated["hookGateScore"])

    def test_20a_feed_stop_ranker_requires_clean_source_audio_evidence(self):
        candidate, transcript = rankable_feed_stop_candidate()

        [ranked] = rank_highlights(
            [candidate],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=BF_FEED_STOP_V1,
            require_speech_cleanliness=True,
        )

        self.assertTrue(ranked["rejected"])
        self.assertIn(
            "speech_cleanliness_evidence_missing",
            ranked["rejection_reasons"],
        )

    def test_20b_feed_stop_ranker_propagates_audio_review_reason(self):
        candidate, transcript = rankable_feed_stop_candidate()
        candidate.update(
            {
                "speech_cleanliness_decision_version": (
                    SPEECH_CLEANLINESS_DECISION_VERSION
                ),
                "speech_cleanliness_status": "review",
                "speech_cleanliness_eligible": False,
                "speech_cleanliness_deterministic_reasons": [
                    "unresolved_internal_vocalizations"
                ],
            }
        )

        [ranked] = rank_highlights(
            [candidate],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=BF_FEED_STOP_V1,
            require_speech_cleanliness=True,
        )

        self.assertTrue(ranked["rejected"])
        self.assertIn(
            "unresolved_internal_vocalizations",
            ranked["rejection_reasons"],
        )

    def test_20c_feed_stop_ranker_accepts_exact_cleanliness_pass_only(self):
        candidate, transcript = rankable_feed_stop_candidate()
        candidate.update(
            {
                "speech_cleanliness_decision_version": (
                    SPEECH_CLEANLINESS_DECISION_VERSION
                ),
                "speech_cleanliness_status": "pass",
                "speech_cleanliness_eligible": True,
                "speech_cleanliness_deterministic_reasons": [],
            }
        )

        [ranked] = rank_highlights(
            [candidate],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=BF_FEED_STOP_V1,
            require_speech_cleanliness=True,
        )
        self.assertFalse(ranked["rejected"])

        candidate["speech_cleanliness_decision_version"] = "future-version"
        [stale] = rank_highlights(
            [candidate],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=BF_FEED_STOP_V1,
            require_speech_cleanliness=True,
        )
        self.assertTrue(stale["rejected"])
        self.assertIn(
            "speech_cleanliness_decision_version_mismatch",
            stale["rejection_reasons"],
        )

    def test_21_brand_tail_variant_reuses_encoded_control_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            control_path = Path(directory) / "control.mp4"
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=black:s=108x192:r=30:d=1.85",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    str(control_path),
                ],
                check=True,
            )
            manifest = build_short_brand_tail_experiment_manifest(
                candidate_hash=SHA_A,
                source_hash=SHA_B,
                source_interval=(10.0, 22.0),
            )

            def renderer(*args, **kwargs):
                return [
                    {
                        "clip_url": str(control_path),
                        "brand_tail_start_seconds": 1.0,
                        "brand_tail_seconds": 0.85,
                    }
                ]

            result = render_short_brand_tail_experiment(
                source_path="/unused/source.mp4",
                transcript={},
                sealed_candidate={
                    "candidate_hash": SHA_A,
                    "start_time": 10.0,
                    "end_time": 22.0,
                },
                manifest=manifest,
                output_dir=directory,
                renderer=renderer,
            )
        self.assertTrue(result["preTailFrameVerification"]["identical"])
        self.assertEqual(result["variant"]["brand_tail_seconds"], 0.40)

    def test_22_alignment_runs_v3_without_legacy_fallback(self):
        transcript, candidate = aligned_v3_fixture()
        [result] = align_motivational_boundaries([candidate], transcript)
        self.assertEqual(result["hookGateVersion"], HOOK_GATE_V3_VERSION)
        self.assertEqual(result["hookGateStatus"], "pass")
        self.assertEqual(result["firstWordLatencyMs"], 80.0)
        self.assertEqual(result["semantic_closure_status"], "pass")

    def test_alignment_trims_declared_second_topic_instead_of_extending_to_it(self):
        words = [
            {"start": 0.0, "end": 0.5, "word": "Everybody"},
            {"start": 0.5, "end": 1.0, "word": "gets"},
            {"start": 1.0, "end": 1.5, "word": "a"},
            {"start": 1.5, "end": 2.0, "word": "break."},
            {"start": 2.0, "end": 2.5, "word": "Most"},
            {"start": 2.5, "end": 3.0, "word": "people"},
            {"start": 3.0, "end": 3.5, "word": "blow"},
            {"start": 3.5, "end": 4.0, "word": "it."},
            {"start": 4.0, "end": 4.3, "word": "It's"},
            {"start": 4.3, "end": 4.6, "word": "an"},
            {"start": 4.6, "end": 5.0, "word": "awesome"},
            {"start": 5.0, "end": 5.5, "word": "documentary."},
        ]
        transcript = {
            "duration": 8.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 5.5,
                    "text": " ".join(word["word"] for word in words),
                    "words": words,
                }
            ],
        }
        candidate = {
            "start_time": 0.0,
            "end_time": 5.5,
            "speech_start_time": 0.0,
            "speech_end_time": 5.5,
            "hook_sentence": "Everybody gets a break.",
            "hook_payoff_phrase": "Most people blow it.",
            "earliest_complete_takeaway_sentence": "Most people blow it.",
            "final_takeaway_sentence": "Most people blow it.",
            "second_topic_begins_after_takeaway": True,
        }

        [result] = align_motivational_boundaries([candidate], transcript)

        self.assertEqual(result["speech_end_time"], 4.0)
        self.assertFalse(result["semantic_extension_applied"])
        self.assertFalse(result["second_topic_begins_after_takeaway"])
        self.assertTrue(result["second_topic_trimmed_after_takeaway"])
        self.assertEqual(
            result["semantic_closure_sentence"],
            "Most people blow it.",
        )


def natural_tail_fixture():
    spoken = [
        "If",
        "youre",
        "nervous",
        "stop",
        "thinking",
        "about",
        "yourself",
        "because",
        "attention",
        "changes",
        "the",
        "room.",
    ]
    words = [
        {"start": float(index), "end": float(index + 1), "word": word}
        for index, word in enumerate(spoken)
    ]
    words.append({"start": 12.45, "end": 12.80, "word": "Next"})
    transcript = {
        "duration": 20.0,
        "segments": [
            {"start": 0.0, "end": 20.0, "text": "", "words": words}
        ],
    }
    candidate = {
        "start_time": 0.0,
        "end_time": 12.0,
        "speech_start_time": 0.0,
        "speech_end_time": 12.0,
        "semantic_closure_sentence": "attention changes the room",
        "earliest_complete_takeaway_sentence": "attention changes the room",
        "takeaway_boundary_aligned": True,
        "semantic_continuation_required": False,
        "has_complete_ending": True,
        "has_takeaway": True,
        "stop_scroll_score": 90,
        "listener_payoff_score": 90,
        "self_contained_micro_arc_score": 90,
        "closure_score": 90,
    }
    return transcript, candidate


def transcript_for_words(words, duration):
    return {
        "duration": duration,
        "segments": [
            {
                "start": 0.0,
                "end": duration,
                "text": " ".join(word["word"] for word in words),
                "words": words,
            }
        ],
    }


def aligned_v3_fixture():
    text = [
        "Earlier.",
        "If",
        "you're",
        "nervous",
        "stop",
        "thinking",
        "about",
        "yourself",
        "because",
        "attention",
        "changes",
        "the",
        "whole",
        "room.",
        "Next",
    ]
    times = [
        (9.0, 9.5),
        (10.0, 10.7),
        (10.7, 11.3),
        (11.3, 12.0),
        (12.0, 13.0),
        (13.0, 14.0),
        (14.0, 15.0),
        (15.0, 16.0),
        (16.0, 17.0),
        (17.0, 18.0),
        (18.0, 19.0),
        (19.0, 20.0),
        (20.0, 21.0),
        (21.0, 22.0),
        (22.45, 23.0),
    ]
    words = [
        {"start": start, "end": end, "word": word}
        for word, (start, end) in zip(text, times)
    ]
    transcript = {
        "duration": 30.0,
        "segments": [
            {
                "start": 9.0,
                "end": 23.0,
                "text": (
                    "Earlier. If you're nervous stop thinking about yourself "
                    "because attention changes the whole room. Next"
                ),
                "words": words,
            }
        ],
    }
    candidate = {
        "title": "Stop thinking about yourself",
        "topic": "confidence",
        "start_time": 10.0,
        "end_time": 22.0,
        "speech_start_time": 10.0,
        "speech_end_time": 22.0,
        "opening_exact_quote": (
            "If you're nervous stop thinking about yourself"
        ),
        "hook_sentence": "If you're nervous stop thinking about yourself",
        "hook_payoff_phrase": "stop thinking about yourself",
        "earliest_complete_takeaway_sentence": (
            "attention changes the whole room"
        ),
        "final_takeaway_sentence": "attention changes the whole room",
        "has_complete_ending": True,
        "has_takeaway": True,
        "has_hook": True,
        "has_development": True,
        "semantic_continuation_required": False,
        "second_topic_begins_after_takeaway": False,
        "selection_profile": BF_FEED_STOP_V1,
        "selection_policy_version": BF_FEED_STOP_V1,
        "quotability_score": 90,
        "stop_scroll_score": 90,
        "listener_payoff_score": 90,
        "self_contained_micro_arc_score": 90,
        "closure_score": 90,
    }
    return transcript, candidate


def diverse_candidate(title, topic, family, score):
    start = {"one": 0.0, "two": 20.0, "three": 40.0}.get(title, 60.0)
    return {
        "title": title,
        "topic": topic,
        "candidate_text": f"{topic} unique lesson words for this clip",
        "start_time": start,
        "end_time": start + 12.0,
        "final_score": score,
        "rejected": False,
        "hookFamily": family,
        "selection_policy_version": BF_FEED_STOP_V1,
    }


if __name__ == "__main__":
    unittest.main()
