import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np

from shorts_generator.highlights import (
    align_motivational_boundaries,
    call_highlight_api,
    get_highlights,
)
from shorts_generator.local.clipper import (
    MOTIVATIONAL_CAPTION_VISUAL_LEAD_SECONDS,
    MOTIVATIONAL_CAPTION_BLOCK_GAP,
    MOTIVATIONAL_HANDOFF_GAP_SECONDS,
    MOTIVATIONAL_MAX_WORD_REVEAL_DELAY_SECONDS,
    MOTIVATIONAL_MAX_HANDOFF_OVERLAP_SECONDS,
    MOTIVATIONAL_MIN_WORD_REVEAL_DELAY_SECONDS,
    MOTIVATIONAL_MIN_VISIBLE_PHRASE_SECONDS,
    _CaptionRenderer,
    _apply_motivational_grade,
    _bf_editorial_typography_plan,
    _build_word_cues,
    _caption_anchor_font_style,
    _caption_sentence_layout,
    _caption_timing_metrics,
    _compose_editorial_frame,
    _compose_editorial_inset,
    _detect_clip_layout,
    _editorial_caption_lane,
    _editorial_composition_geometry,
    _editorial_crop_geometry,
    _editorial_inset_box,
    _expand_protected_face,
    _locked_speaker_bbox_at,
    _map_editorial_bbox,
    _map_bbox_to_crop,
    _map_bbox_to_render,
    _rect_intersection_area,
    _realesrgan_command,
    _select_locked_speaker_bbox,
    _update_stable_speaker_bbox,
)
from shorts_generator.local.visual_features import (
    _parse_scene_times,
    build_source_shot_index,
)
from shorts_generator.pipeline import build_ranking_manifest
from shorts_generator.profiles import (
    BUDGET_FRIENDLY_CAPTION_STYLE,
    MOTIVATIONAL_PODCAST,
    MOTIVATIONAL_TENSION_MICRO_V1,
    MOTIVATIONAL_MUSIC_DRIVING,
    MOTIVATIONAL_MUSIC_REFLECTIVE,
    MOTIVATIONAL_MUSIC_WARM,
    motivational_music_profile_for_candidate,
    render_settings_for_content,
)
from shorts_generator.ranker import (
    eligible_highlights,
    motivational_language_signals,
    rank_highlights,
    select_diverse_highlights,
)


def candidate(start=10.0, end=40.0, **overrides):
    item = {
        "title": "Discipline creates freedom",
        "topic": "discipline and freedom",
        "thesis": "Self-control creates practical freedom.",
        "start_time": start,
        "end_time": end,
        "speech_start_time": start,
        "speech_end_time": end,
        "score": 90,
        "hook_score": 94,
        "standalone_score": 95,
        "development_score": 91,
        "takeaway_score": 94,
        "emotional_conviction_score": 90,
        "quotability_score": 93,
        "closure_score": 96,
        "title_fit_score": 98,
        "boundary_quality_score": 100,
        "has_hook": True,
        "has_development": True,
        "has_takeaway": True,
        "has_complete_ending": True,
        "is_promotional": False,
        "is_outro": False,
        "requires_previous_context": False,
        "is_standalone_one_liner": False,
    }
    item.update(overrides)
    return item


def timed_sentence_transcript(sentences, duration=None):
    segments = []
    for start, end, text in sentences:
        tokens = text.split()
        step = (end - start) / max(1, len(tokens))
        words = [
            {
                "start": start + index * step,
                "end": end if index == len(tokens) - 1 else start + (index + 1) * step,
                "word": token,
            }
            for index, token in enumerate(tokens)
        ]
        segments.append({"start": start, "end": end, "text": text, "words": words})
    return {
        "duration": duration if duration is not None else sentences[-1][1],
        "segments": segments,
    }


class MotivationalSelectionTests(unittest.TestCase):
    def test_hook_and_takeaway_words_trim_host_questions(self):
        tokens = [
            (0.0, 0.3, "Talk"), (0.3, 0.5, "about"), (0.5, 0.8, "that."),
            (1.2, 1.5, "People"), (1.5, 1.7, "feel"), (1.7, 2.1, "anxious."),
            (2.4, 2.7, "Caffeine"), (2.7, 2.9, "is"), (2.9, 3.1, "not"),
            (3.1, 3.3, "a"), (3.3, 3.6, "fuel."),
            (4.0, 4.2, "What"), (4.2, 4.5, "next?"),
        ]
        transcript = {
            "duration": 5.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 4.5,
                    "text": "Talk about that. People feel anxious. Caffeine is not a fuel. What next?",
                    "words": [
                        {"start": start, "end": end, "word": text}
                        for start, end, text in tokens
                    ],
                }
            ],
        }

        aligned = align_motivational_boundaries(
            [
                {
                    "start_time": 0.0,
                    "end_time": 4.5,
                    "speech_start_time": 0.0,
                    "speech_end_time": 4.5,
                    "hook_sentence": "People feel anxious.",
                    "final_takeaway_sentence": "Caffeine is not a fuel.",
                }
            ],
            transcript,
        )[0]

        self.assertEqual(aligned["speech_start_time"], 1.2)
        self.assertEqual(aligned["speech_end_time"], 3.6)
        self.assertLessEqual(aligned["end_time"], 4.0)

    def test_v2_alignment_uses_exact_payoff_and_earliest_complete_takeaway(self):
        transcript = {
            "duration": 8.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 7.5,
                    "text": (
                        "So do less than you think you can do. "
                        "That builds endurance. Then we can discuss intensity."
                    ),
                    "words": [
                        {"start": 0.0, "end": 0.2, "word": "So"},
                        {"start": 0.3, "end": 0.5, "word": "do"},
                        {"start": 0.5, "end": 0.8, "word": "less"},
                        {"start": 0.8, "end": 1.0, "word": "than"},
                        {"start": 1.0, "end": 1.2, "word": "you"},
                        {"start": 1.2, "end": 1.5, "word": "think"},
                        {"start": 1.5, "end": 1.7, "word": "you"},
                        {"start": 1.7, "end": 1.9, "word": "can"},
                        {"start": 1.9, "end": 2.2, "word": "do."},
                        {"start": 2.6, "end": 2.9, "word": "That"},
                        {"start": 2.9, "end": 3.2, "word": "builds"},
                        {"start": 3.2, "end": 3.7, "word": "endurance."},
                        {"start": 4.3, "end": 4.6, "word": "Then"},
                        {"start": 4.6, "end": 4.8, "word": "we"},
                        {"start": 4.8, "end": 5.0, "word": "can"},
                        {"start": 5.0, "end": 5.5, "word": "discuss"},
                        {"start": 5.5, "end": 6.2, "word": "intensity."},
                    ],
                }
            ],
        }

        aligned = align_motivational_boundaries(
            [
                {
                    "start_time": 0.0,
                    "end_time": 6.2,
                    "speech_start_time": 0.0,
                    "speech_end_time": 6.2,
                    "hook_sentence": "Do less than you think you can do.",
                    "hook_payoff_phrase": "do less than you think you can do",
                    "final_takeaway_sentence": "Then we can discuss intensity.",
                    "earliest_complete_takeaway_sentence": "That builds endurance.",
                    "contains_attribution_lead_in": True,
                    "second_topic_begins_after_takeaway": True,
                }
            ],
            transcript,
        )[0]

        self.assertEqual(aligned["speech_start_time"], 0.3)
        self.assertEqual(aligned["speech_end_time"], 3.7)
        self.assertEqual(aligned["hook_payoff_latency_seconds"], 1.9)
        self.assertTrue(aligned["hook_payoff_aligned"])
        self.assertTrue(aligned["takeaway_boundary_aligned"])
        self.assertFalse(aligned["contains_attribution_lead_in"])
        self.assertFalse(aligned["second_topic_begins_after_takeaway"])
        self.assertTrue(aligned["attribution_lead_in_trimmed"])
        self.assertTrue(aligned["second_topic_trimmed_after_takeaway"])

    def test_semantic_ending_extends_a_question_through_its_immediate_answer(self):
        transcript = timed_sentence_transcript(
            [
                (0.0, 4.98, "The biggest drug is not cocaine or heroin, it is fame."),
                (5.46, 14.62, "If you cannot handle fame, the consequences are severe."),
                (15.22, 18.06, "Do you know you and are you okay with you?"),
                (18.48, 20.74, "If you are not, it will break you."),
                (20.86, 22.14, "The best-selling author and host."),
            ],
            duration=22.14,
        )
        aligned = align_motivational_boundaries(
            [
                candidate(
                    0.0,
                    18.06,
                    speech_start_time=0.0,
                    speech_end_time=18.06,
                    hook_sentence="The biggest drug is not cocaine or heroin, it is fame.",
                    earliest_complete_takeaway_sentence=(
                        "Do you know you and are you okay with you?"
                    ),
                    final_takeaway_sentence="If you are not, it will break you.",
                    selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
                )
            ],
            transcript,
        )[0]

        self.assertEqual(aligned["speech_end_time"], 20.74)
        self.assertTrue(aligned["semantic_extension_applied"])
        self.assertFalse(aligned["semantic_continuation_required"])
        self.assertIn("question_answer", aligned["semantic_continuation_reasons"])
        self.assertEqual(
            aligned["semantic_closure_sentence"],
            "If you are not, it will break you.",
        )

    def test_semantic_ending_keeps_an_immediate_spoken_rephrase(self):
        transcript = timed_sentence_transcript(
            [
                (0.0, 5.0, "When you love a flower, you water it every day."),
                (5.2, 10.0, "The flower shows whether you are watering it or not."),
                (10.1, 10.6, "It is going to die."),
                (10.74, 13.9, "It is going to not bloom or whatever it may be."),
                (14.02, 17.0, "And I recommend this book to everyone."),
            ],
            duration=17.0,
        )
        aligned = align_motivational_boundaries(
            [
                candidate(
                    0.0,
                    10.6,
                    speech_start_time=0.0,
                    speech_end_time=10.6,
                    hook_sentence="When you love a flower, you water it every day.",
                    earliest_complete_takeaway_sentence="It is going to die.",
                    final_takeaway_sentence="It is going to die.",
                    selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
                )
            ],
            transcript,
        )[0]

        self.assertEqual(aligned["speech_end_time"], 13.9)
        self.assertIn("immediate_rephrase", aligned["semantic_continuation_reasons"])
        self.assertNotIn("And I recommend", aligned["semantic_closure_sentence"])

    def test_semantic_ending_does_not_extend_into_a_new_topic(self):
        transcript = timed_sentence_transcript(
            [
                (0.0, 5.0, "Do less than you think you can do."),
                (5.3, 8.0, "That builds endurance."),
                (8.3, 11.0, "Now let's discuss intensity."),
            ],
            duration=11.0,
        )
        aligned = align_motivational_boundaries(
            [
                candidate(
                    0.0,
                    8.0,
                    speech_start_time=0.0,
                    speech_end_time=8.0,
                    hook_sentence="Do less than you think you can do.",
                    earliest_complete_takeaway_sentence="That builds endurance.",
                    selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
                )
            ],
            transcript,
        )[0]

        self.assertEqual(aligned["speech_end_time"], 8.0)
        self.assertFalse(aligned["semantic_continuation_detected"])
        self.assertFalse(aligned["semantic_continuation_required"])

    def test_required_continuation_over_hard_max_rejects_instead_of_truncating(self):
        transcript = timed_sentence_transcript(
            [
                (0.0, 15.0, "Me first, everybody move, I will show you how to do it."),
                (15.2, 21.3, "Get out the way and let other people be great."),
                (21.5, 23.8, "They are only going to make this thing greater."),
            ],
            duration=23.8,
        )
        aligned = align_motivational_boundaries(
            [
                candidate(
                    0.0,
                    21.3,
                    speech_start_time=0.0,
                    speech_end_time=21.3,
                    hook_sentence="Me first, everybody move, I will show you how to do it.",
                    earliest_complete_takeaway_sentence=(
                        "Get out the way and let other people be great."
                    ),
                    selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
                )
            ],
            transcript,
        )[0]

        self.assertEqual(aligned["speech_end_time"], 21.3)
        self.assertTrue(aligned["semantic_continuation_required"])
        self.assertFalse(aligned["has_complete_ending"])
        ranked = rank_highlights(
            [aligned],
            transcript,
            content_type=MOTIVATIONAL_PODCAST,
            selection_profile=MOTIVATIONAL_TENSION_MICRO_V1,
        )[0]
        self.assertIn(
            "semantic_continuation_required",
            ranked["rejection_reasons"],
        )

    def test_alignment_clears_second_topic_only_when_words_are_outside_interval(self):
        transcript = {
            "duration": 6.0,
            "segments": [
                {
                    "start": 0.3,
                    "end": 3.7,
                    "text": "Do less than you think you can do. That builds endurance.",
                    "words": [
                        {"start": 0.3, "end": 0.5, "word": "Do"},
                        {"start": 0.5, "end": 0.8, "word": "less"},
                        {"start": 0.8, "end": 1.0, "word": "than"},
                        {"start": 1.0, "end": 1.2, "word": "you"},
                        {"start": 1.2, "end": 1.5, "word": "think"},
                        {"start": 1.5, "end": 1.7, "word": "you"},
                        {"start": 1.7, "end": 1.9, "word": "can"},
                        {"start": 1.9, "end": 2.2, "word": "do."},
                        {"start": 2.6, "end": 2.9, "word": "That"},
                        {"start": 2.9, "end": 3.2, "word": "builds"},
                        {"start": 3.2, "end": 3.7, "word": "endurance."},
                    ],
                },
                {
                    "start": 4.1,
                    "end": 5.4,
                    "text": "A separate topic begins.",
                    "words": [
                        {"start": 4.1, "end": 4.3, "word": "A"},
                        {"start": 4.3, "end": 4.7, "word": "separate"},
                        {"start": 4.7, "end": 5.0, "word": "topic"},
                        {"start": 5.0, "end": 5.4, "word": "begins."},
                    ],
                },
            ],
        }

        aligned = align_motivational_boundaries(
            [
                {
                    "start_time": 0.3,
                    "end_time": 3.7,
                    "speech_start_time": 0.3,
                    "speech_end_time": 3.7,
                    "hook_sentence": "Do less than you think you can do.",
                    "earliest_complete_takeaway_sentence": "That builds endurance.",
                    "contains_attribution_lead_in": True,
                    "second_topic_begins_after_takeaway": True,
                }
            ],
            transcript,
        )[0]

        self.assertTrue(aligned["contains_attribution_lead_in"])
        self.assertFalse(aligned["second_topic_begins_after_takeaway"])
        self.assertNotIn("attribution_lead_in_trimmed", aligned)
        self.assertNotIn("second_topic_trimmed_after_takeaway", aligned)
        self.assertTrue(aligned["second_topic_flag_cleared_outside_interval"])

    def test_alignment_keeps_second_topic_flag_without_exact_takeaway_evidence(self):
        transcript = {
            "duration": 5.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 4.0,
                    "text": "Pressure is real. A separate topic begins.",
                    "words": [
                        {"start": 0.0, "end": 0.5, "word": "Pressure"},
                        {"start": 0.5, "end": 0.8, "word": "is"},
                        {"start": 0.8, "end": 1.2, "word": "real."},
                        {"start": 2.0, "end": 2.2, "word": "A"},
                        {"start": 2.2, "end": 2.8, "word": "separate"},
                        {"start": 2.8, "end": 3.2, "word": "topic"},
                        {"start": 3.2, "end": 4.0, "word": "begins."},
                    ],
                }
            ],
        }

        aligned = align_motivational_boundaries(
            [
                {
                    "start_time": 0.0,
                    "end_time": 4.0,
                    "speech_start_time": 0.0,
                    "speech_end_time": 4.0,
                    "hook_sentence": "Pressure is real.",
                    "earliest_complete_takeaway_sentence": "Words not in source.",
                    "second_topic_begins_after_takeaway": True,
                }
            ],
            transcript,
        )[0]

        self.assertTrue(aligned["second_topic_begins_after_takeaway"])
        self.assertNotIn("second_topic_flag_cleared_outside_interval", aligned)

    def test_motivational_chunk_caps_candidates_and_reuses_disk_cache(self):
        prompts = []

        def fake_llm(prompt):
            prompts.append(prompt)
            return (
                '{"highlights":[{"title":"Freedom","start_time":0,"end_time":30,'
                '"speech_start_time":0,"speech_end_time":30,"score":90}]}'
            )

        with tempfile.TemporaryDirectory() as directory:
            for _ in range(2):
                call_highlight_api(
                    "[0.0s] Discipline creates freedom.",
                    {"content_type": "motivational_podcast", "density": "high"},
                    duration=1200.0,
                    num_clips=3,
                    is_chunk=True,
                    llm_fn=fake_llm,
                    cache_dir=directory,
                    cache_namespace="gemini:test",
                )

        self.assertEqual(len(prompts), 1)
        self.assertIn("Generate up to 4 distinct qualified highlights", prompts[0])

    def test_forced_profile_skips_generic_content_classification(self):
        prompts = []

        def fake_llm(prompt):
            prompts.append(prompt)
            return (
                '{"highlights":[{"title":"Freedom","start_time":0,"end_time":30,'
                '"speech_start_time":0,"speech_end_time":30,"score":90}]}'
            )

        result = get_highlights(
            {
                "duration": 30.0,
                "segments": [
                    {"start": 0.0, "end": 30.0, "text": "Discipline creates freedom."}
                ],
            },
            num_clips=1,
            llm_fn=fake_llm,
            profile_override="motivational_podcast",
        )

        self.assertEqual(len(prompts), 1)
        self.assertEqual(result["content_info"]["content_type"], "motivational_podcast")
        self.assertTrue(result["content_info"]["profile_forced"])

    def test_immutable_fixture_prefers_complete_arc_and_rejects_open_loop(self):
        payload = json.loads(
            (
                Path(__file__).parent
                / "fixtures"
                / "motivational_podcast_selection.json"
            ).read_text(encoding="utf-8")
        )
        fixture = payload["fixtures"][0]

        ranked = rank_highlights(
            fixture["candidates"],
            fixture["transcript"],
            content_type=fixture["category"],
        )

        self.assertEqual(
            eligible_highlights(ranked)[0]["id"],
            fixture["preferred_top_candidate"],
        )
        open_loop = next(item for item in ranked if item["id"] == "open_loop")
        self.assertIn("incomplete_ending", open_loop["rejection_reasons"])

    def test_prompt_requests_complete_motivational_arc(self):
        prompts = []

        def fake_llm(prompt):
            prompts.append(prompt)
            return (
                '{"highlights":[{"title":"Freedom","start_time":10,"end_time":40,'
                '"speech_start_time":10,"speech_end_time":40,"score":90}]}'
            )

        call_highlight_api(
            "[10.0s] Discipline creates freedom.",
            {"content_type": "motivational_podcast", "density": "high"},
            duration=60.0,
            num_clips=1,
            llm_fn=fake_llm,
        )

        self.assertIn("HOOK -> DEVELOPMENT -> TAKEAWAY", prompts[0])
        self.assertIn("Preferred duration is 22-35 seconds", prompts[0])
        self.assertIn("final_takeaway_sentence", prompts[0])
        self.assertIn("Never invent, paraphrase, or reorder", prompts[0])

    def test_incomplete_arc_loses_to_complete_takeaway(self):
        transcript = {
            "duration": 100.0,
            "segments": [
                {
                    "start": 10.0,
                    "end": 40.0,
                    "text": "Discipline creates freedom. Control gives you options.",
                },
                {
                    "start": 50.0,
                    "end": 80.0,
                    "text": "The biggest mistake is this. There are two reasons, and the first is",
                },
            ],
        }
        ranked = rank_highlights(
            [
                candidate(),
                candidate(
                    50.0,
                    80.0,
                    title="The biggest mistake",
                    score=99,
                    hook_score=99,
                    has_development=False,
                    has_takeaway=False,
                    has_complete_ending=False,
                    closure_score=5,
                ),
            ],
            transcript,
            content_type="motivational_podcast",
        )

        self.assertEqual(eligible_highlights(ranked)[0]["title"], "Discipline creates freedom")
        rejected = next(item for item in ranked if item["title"] == "The biggest mistake")
        self.assertIn("missing_takeaway", rejected["rejection_reasons"])
        self.assertIn("incomplete_ending", rejected["rejection_reasons"])

    def test_motivational_duration_policy_is_profile_specific(self):
        transcript = {"duration": 100.0, "segments": []}
        too_long = rank_highlights(
            [candidate(0.0, 56.0, max_duration_seconds=90.0)],
            transcript,
            content_type="motivational_podcast",
        )[0]
        short_aphorism = rank_highlights(
            [candidate(0.0, 16.0, is_standalone_one_liner=True)],
            transcript,
            content_type="motivational_podcast",
        )[0]

        self.assertIn("duration_over_limit", too_long["rejection_reasons"])
        self.assertFalse(short_aphorism["rejected"])

    def test_v2_rejects_late_hook_unaligned_takeaway_and_second_topic(self):
        transcript = {"duration": 100.0, "segments": []}
        ranked = rank_highlights(
            [
                candidate(
                    hook_payoff_latency_seconds=5.2,
                    hook_payoff_aligned=True,
                    takeaway_boundary_aligned=False,
                    second_topic_begins_after_takeaway=True,
                )
            ],
            transcript,
            content_type="motivational_podcast",
        )[0]

        self.assertIn("hook_payoff_too_late", ranked["rejection_reasons"])
        self.assertIn("unaligned_takeaway", ranked["rejection_reasons"])
        self.assertIn("second_topic_after_takeaway", ranked["rejection_reasons"])

    def test_v2_language_signals_reject_context_callbacks_and_filler(self):
        signals = motivational_language_signals(
            "So coming back to the discipline thing, yeah, right, you know, "
            "I mean, consistency matters."
        )

        self.assertTrue(signals["connector_or_attribution_opening"])
        self.assertTrue(signals["context_callback"])
        self.assertGreater(signals["filler_ratio"], 0.12)

    def test_source_cut_count_penalizes_otherwise_equal_candidate(self):
        transcript = {"duration": 100.0, "segments": []}
        stable = candidate(title="Stable", source_cut_count=1)
        busy = candidate(50.0, 80.0, title="Busy", source_cut_count=7)

        ranked = rank_highlights(
            [busy, stable],
            transcript,
            content_type="motivational_podcast",
        )

        self.assertEqual(eligible_highlights(ranked)[0]["title"], "Stable")
        busy_ranked = next(item for item in ranked if item["title"] == "Busy")
        self.assertGreater(busy_ranked["motivational_cut_penalty"], 15.0)

    def test_static_podcast_visuals_do_not_lower_semantic_ranking(self):
        transcript = {"duration": 100.0, "segments": []}
        ranked = rank_highlights(
            [
                candidate(title="Static strong", measured_visual_action_score=2),
                candidate(
                    50.0,
                    80.0,
                    title="Moving weak",
                    topic="generic effort",
                    measured_visual_action_score=98,
                    hook_score=70,
                    takeaway_score=65,
                ),
            ],
            transcript,
            content_type="motivational_podcast",
        )

        self.assertEqual(eligible_highlights(ranked)[0]["title"], "Static strong")

    def test_batch_deduplicates_equal_topic_labels(self):
        ranked = [
            {**candidate(), "final_score": 95, "rejected": False},
            {
                **candidate(60.0, 90.0, title="Same thesis, new wording"),
                "candidate_text": "Different words with little token overlap.",
                "final_score": 90,
                "rejected": False,
            },
        ]

        selected = select_diverse_highlights(ranked, limit=2)

        self.assertEqual(len(selected), 1)
        self.assertEqual(ranked[1]["batch_exclusion_reason"], "duplicates_higher_ranked_topic")


class MotivationalRenderingTests(unittest.TestCase):
    def test_source_shot_index_is_cached_by_source_and_detector_settings(self):
        calls = []

        def fake_runner(command, **kwargs):
            calls.append(command)
            return SimpleNamespace(
                returncode=0,
                stderr="pts_time:0.10 pts_time:2.00 pts_time:2.20 pts_time:5.00",
                stdout="",
            )

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"immutable source fixture")
            first = build_source_shot_index(
                str(source),
                [(10.0, 18.0)],
                str(Path(directory) / "cache"),
                runner=fake_runner,
            )
            second = build_source_shot_index(
                str(source),
                [(10.0, 18.0)],
                str(Path(directory) / "cache"),
                runner=fake_runner,
            )

        self.assertEqual(len(calls), 1)
        self.assertEqual(
            first["intervals"]["10.000:18.000"]["scene_change_times"],
            [12.0, 15.0],
        )
        self.assertEqual(first["source_hash"], second["source_hash"])

    def test_scene_parser_deduplicates_flash_frames(self):
        parsed = _parse_scene_times(
            "pts_time:1.0 pts_time:1.2 pts_time:1.7 pts_time:4.9",
            20.0,
            25.0,
        )

        self.assertEqual(parsed, [21.0, 21.7])

    def test_locked_speaker_prefers_previous_subject_on_tied_persistence(self):
        left = (160, 120, 220, 220)
        right = (1420, 125, 220, 220)
        candidates = [
            (0, left), (0, right),
            (1, left), (1, right),
            (2, left), (2, right),
        ]

        selected = _select_locked_speaker_bbox(
            candidates,
            (1920, 1080),
            previous=(1400, 110, 230, 230),
        )

        self.assertEqual(selected, right)

    def test_locked_speaker_rejects_small_false_face_near_previous_position(self):
        actual = (610, 125, 360, 360)
        false_face = (1450, 130, 90, 90)
        candidates = [
            (0, actual), (1, actual),
            (0, false_face), (1, false_face), (2, false_face),
        ]

        selected = _select_locked_speaker_bbox(
            candidates,
            (1920, 1080),
            previous=(1420, 110, 110, 110),
        )

        self.assertEqual(selected, actual)

    def test_locked_speaker_changes_only_at_source_shot_boundary(self):
        left = (160, 120, 220, 220)
        right = (1420, 125, 220, 220)
        plan = [
            {"start": 0.0, "end": 4.0, "bbox": left},
            {"start": 4.0, "end": 8.0, "bbox": right},
        ]

        self.assertEqual(_locked_speaker_bbox_at(plan, 0.2), left)
        self.assertEqual(_locked_speaker_bbox_at(plan, 3.99), left)
        self.assertEqual(_locked_speaker_bbox_at(plan, 4.0), right)

    def test_stable_speaker_snaps_across_editorial_camera_cut(self):
        close_up = (410, 160, 300, 330)
        reaction_shot = (1310, 180, 210, 240)

        updated = _update_stable_speaker_bbox(
            close_up,
            reaction_shot,
            (1920, 1080),
        )

        self.assertEqual(updated, reaction_shot)

    def test_stable_speaker_smooths_small_detection_jitter(self):
        previous = (410, 160, 300, 330)
        jittered = (420, 164, 296, 328)

        updated = _update_stable_speaker_bbox(previous, jittered, (1920, 1080))

        self.assertNotEqual(updated, jittered)
        self.assertGreater(updated[0], previous[0])

    def test_profile_routes_human_rendering_without_touching_defaults(self):
        settings = render_settings_for_content("motivational_podcast")

        self.assertEqual(settings["layout_hint"], "motivational_editorial")
        self.assertEqual(settings["caption_style"], BUDGET_FRIENDLY_CAPTION_STYLE)
        self.assertEqual(settings["enhancement_model"], "realesrgan-x4plus")
        self.assertEqual(settings["enhancement_scale"], 4)
        self.assertEqual(settings["enhancement_reference_blend"], 0.10)
        self.assertTrue(settings["background_music"])
        self.assertEqual(render_settings_for_content("gaming"), {})

    def test_music_profile_is_deterministic_from_candidate_semantics(self):
        self.assertEqual(
            motivational_music_profile_for_candidate(
                candidate(
                    title="Discipline wins",
                    topic="confidence through work and sacrifice",
                )
            ),
            MOTIVATIONAL_MUSIC_DRIVING,
        )
        self.assertEqual(
            motivational_music_profile_for_candidate(
                candidate(
                    title="Your younger self",
                    topic="what your future life will mean",
                )
            ),
            MOTIVATIONAL_MUSIC_REFLECTIVE,
        )
        self.assertEqual(
            motivational_music_profile_for_candidate(
                candidate(
                    title="Choose love",
                    topic="hope and gratitude for your family",
                )
            ),
            MOTIVATIONAL_MUSIC_WARM,
        )

    def test_motivational_captions_progressively_reveal_a_stable_phrase(self):
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 11.5,
                    "text": "Discipline creates real freedom.",
                    "words": [
                        {"word": "Discipline", "start": 10.0, "end": 10.3},
                        {"word": "creates", "start": 10.35, "end": 10.6},
                        {"word": "real", "start": 10.65, "end": 10.9},
                        {"word": "freedom.", "start": 10.95, "end": 11.3},
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            10.0,
            11.5,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )

        self.assertEqual(len(cues), 4)
        self.assertEqual([cue["visible_word_count"] for cue in cues], [1, 2, 3, 4])
        self.assertEqual([cue["active_index"] for cue in cues], [0, 1, 2, 3])
        self.assertEqual({cue["phrase_id"] for cue in cues}, {0})
        self.assertEqual({cue["sentence_id"] for cue in cues}, {0})
        self.assertTrue(all(cue["sentence_phrase_index"] == 0 for cue in cues))
        self.assertTrue(all(cue["sentence_phrase_count"] == 1 for cue in cues))
        self.assertEqual(MOTIVATIONAL_CAPTION_VISUAL_LEAD_SECONDS, 0.0)
        second_word_delay = cues[1]["start"] - 0.35
        self.assertGreaterEqual(
            second_word_delay,
            MOTIVATIONAL_MIN_WORD_REVEAL_DELAY_SECONDS - 1e-6,
        )
        self.assertLessEqual(
            second_word_delay,
            MOTIVATIONAL_MAX_WORD_REVEAL_DELAY_SECONDS + 1e-6,
        )
        self.assertGreater(cues[0]["start"], 0.0)
        self.assertAlmostEqual(cues[0]["end"], cues[1]["start"])
        final_phrase = cues[-1]
        self.assertEqual(final_phrase["emphasis_index"], 3)
        self.assertEqual(
            final_phrase["words"][final_phrase["emphasis_index"]],
            "freedom.",
        )

    def test_editorial_timing_uses_post_speech_padding_for_final_hold(self):
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 10.8,
                    "text": "Choose freedom.",
                    "words": [
                        {"word": "Choose", "start": 10.0, "end": 10.3},
                        {"word": "freedom.", "start": 10.35, "end": 10.8},
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            10.0,
            10.8,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
            render_profile="bf_editorial_inset_v1",
            display_end=11.8,
        )
        final_cue = max(
            cues,
            key=lambda cue: int(cue["visible_word_count"]),
        )
        metrics = _caption_timing_metrics(cues)

        self.assertEqual(final_cue["timing_hold_reason"], "sentence_closure")
        self.assertGreaterEqual(final_cue["post_speech_hold_seconds"], 0.649)
        self.assertEqual(metrics["early_reveal_count"], 0)
        self.assertEqual(metrics["median_sentence_tail_hold_ms"], 650)
        self.assertGreaterEqual(metrics["minimum_complete_phrase_ms"], 650)

    def test_editorial_timing_does_not_leave_contraction_as_orphan(self):
        words = "It's a very potent stimulus and very potent stimuli.".split()
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 12.2,
                    "words": [
                        {
                            "word": word,
                            "start": 10.0 + index * 0.22,
                            "end": 10.18 + index * 0.22,
                        }
                        for index, word in enumerate(words)
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            10.0,
            12.2,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
            render_profile="bf_editorial_inset_v1",
        )
        phrases = {
            int(cue["phrase_id"]): cue["words"]
            for cue in cues
        }

        self.assertNotIn(["It's"], phrases.values())
        self.assertTrue(
            all(
                float(event["reveal_start"]) >= float(event["spoken_start"])
                for cue in cues
                for event in cue.get("reveal_events") or []
            )
        )

    def test_editorial_caption_groups_are_short_and_have_one_anchor(self):
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 13.2,
                    "text": "Choose the right direction before you optimize how fast you move.",
                    "words": [
                        {"word": word, "start": 10.0 + index * 0.25, "end": 10.2 + index * 0.25}
                        for index, word in enumerate(
                            "Choose the right direction before you optimize how fast you move.".split()
                        )
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            10.0,
            13.2,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )

        self.assertGreater(len(cues), 1)
        self.assertTrue(all(1 <= len(cue["words"]) <= 6 for cue in cues))
        self.assertTrue(
            all(0 <= cue["emphasis_index"] < len(cue["words"]) for cue in cues)
        )
        self.assertTrue(
            all(
                cue["typography_variant"]
                in {"headline", "statement", "support", "contrast"}
                for cue in cues
            )
        )
        self.assertGreater(
            len({cue["typography_base_scale"] for cue in cues}),
            1,
        )

    def test_editorial_phrases_handoff_without_accumulating(self):
        words = "Discipline creates freedom when choices follow clear principles. Start again now.".split()
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 13.5,
                    "words": [
                        {
                            "word": word,
                            "start": 10.0 + index * 0.28,
                            "end": 10.22 + index * 0.28,
                        }
                        for index, word in enumerate(words)
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            10.0,
            13.5,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        first_sentence = [cue for cue in cues if cue["sentence_id"] == 0]
        first_phrase = [cue for cue in first_sentence if cue["phrase_id"] == 0]
        second_phrase = [cue for cue in first_sentence if cue["phrase_id"] == 1]
        next_sentence_start = min(
            cue["start"] for cue in cues if cue["sentence_id"] == 1
        )

        self.assertLessEqual(
            max(cue["end"] for cue in first_phrase)
            - min(cue["start"] for cue in second_phrase),
            MOTIVATIONAL_MAX_HANDOFF_OVERLAP_SECONDS + 1e-6,
        )
        self.assertGreaterEqual(
            min(cue["start"] for cue in second_phrase)
            - max(cue["end"] for cue in first_phrase),
            MOTIVATIONAL_HANDOFF_GAP_SECONDS - 1e-6,
        )
        self.assertGreaterEqual(
            max(cue["end"] for cue in first_phrase)
            - min(cue["start"] for cue in first_phrase),
            MOTIVATIONAL_MIN_VISIBLE_PHRASE_SECONDS - 1e-6,
        )
        self.assertLessEqual(
            max(cue["end"] for cue in first_sentence),
            next_sentence_start + 1e-6,
        )
        for sample_time in sorted({cue["start"] for cue in first_sentence}):
            active_phrases = {
                cue["phrase_id"]
                for cue in first_sentence
                if cue["start"] <= sample_time < cue["end"]
            }
            self.assertLessEqual(len(active_phrases), 2)

    def test_editorial_emphasis_is_semantic_and_budgeted(self):
        words = (
            "Pressure is a privilege. Feeling pressure on a daily basis in the "
            "capacity that we feel is a privilege. I thrive under pressure."
        ).split()
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 16.0,
                    "text": " ".join(words),
                    "words": [
                        {
                            "word": word,
                            "start": 10.0 + index * 0.28,
                            "end": 10.22 + index * 0.28,
                        }
                        for index, word in enumerate(words)
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            10.0,
            16.0,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
            caption_context={
                "title": "Pressure Is a Privilege",
                "thesis": "Embracing pressure as a privilege helps you thrive.",
            },
        )

        phrases = {cue["phrase_id"]: cue for cue in cues}.values()
        headlines = [
            cue for cue in phrases if cue["typography_variant"] == "headline"
        ]
        mixed = [
            cue for cue in phrases if cue["typography_secondary_index"] >= 0
        ]
        capacity_cue = next(cue for cue in cues if "capacity" in cue["text"])

        self.assertLessEqual(len(headlines), 4)
        self.assertGreaterEqual(len(headlines), 1)
        self.assertEqual(len(mixed), 0)
        self.assertTrue(
            all(
                {"pressure", "privilege"}
                & {word.lower().strip(".,") for word in cue["words"]}
                for cue in headlines
            )
        )
        self.assertIn(
            capacity_cue["typography_variant"],
            {"support", "statement"},
        )
        self.assertEqual(capacity_cue["typography_secondary_index"], -1)
        self.assertTrue(
            all(cue["typography_accent_style"] == "base" for cue in headlines)
        )
        self.assertTrue(
            all(cue["typography_anchor_scale"] >= 1.5 for cue in headlines)
        )
        self.assertTrue(
            all(cue["typography_body_style"] == "support" for cue in phrases)
        )
        self.assertTrue(
            all(
                cue["typography_anchor_scale"] == 1.0
                for cue in phrases
                if cue["typography_variant"] != "headline"
            )
        )

    def test_editorial_script_font_requires_an_intensifier_before_the_anchor(self):
        words = "It is so hard.".split()
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 11.6,
                    "text": " ".join(words),
                    "words": [
                        {
                            "word": word,
                            "start": 10.0 + index * 0.3,
                            "end": 10.24 + index * 0.3,
                        }
                        for index, word in enumerate(words)
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            10.0,
            11.6,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        cue = cues[-1]

        self.assertEqual(cue["typography_variant"], "headline")
        self.assertEqual(cue["words"][cue["emphasis_index"]], "hard.")
        self.assertEqual(cue["words"][cue["typography_secondary_index"]], "so")
        self.assertEqual(cue["typography_secondary_style"], "script")
        self.assertEqual(cue["typography_accent_style"], "base")

    def test_editorial_anchor_font_swap_follows_semantic_class(self):
        self.assertEqual(_caption_anchor_font_style("believe"), "serif")
        self.assertEqual(_caption_anchor_font_style("purpose"), "serif")
        self.assertEqual(_caption_anchor_font_style("harder"), "base")
        self.assertEqual(_caption_anchor_font_style("consequences"), "base")

    def test_bf_editorial_profile_uses_semantic_anchor_font(self):
        plan = _bf_editorial_typography_plan(
            [
                [{"text": "I"}, {"text": "believe"}],
                [{"text": "face"}, {"text": "consequences"}],
            ],
            caption_context={"title": "Believe and face consequences"},
        )

        self.assertEqual(plan[0]["typography_accent_style"], "serif")
        self.assertEqual(plan[1]["typography_accent_style"], "base")
        self.assertIn("believe:serif", plan[0]["typography_reason"])
        self.assertIn("consequences:base", plan[1]["typography_reason"])

    def test_editorial_has_at_most_one_display_anchor_per_sentence(self):
        words = "Good choices create a good life because good habits create freedom.".split()
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 14.0,
                    "text": " ".join(words),
                    "words": [
                        {
                            "word": word,
                            "start": 10.0 + index * 0.3,
                            "end": 10.24 + index * 0.3,
                        }
                        for index, word in enumerate(words)
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            10.0,
            14.0,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
            caption_context={"title": "A Good Life"},
        )
        phrases = {cue["phrase_id"]: cue for cue in cues}.values()
        headlines = [
            cue for cue in phrases if cue["typography_variant"] == "headline"
        ]

        self.assertEqual(
            len({cue["sentence_id"] for cue in headlines}),
            len(headlines),
        )
        self.assertTrue(all(not cue["typography_motif"] for cue in phrases))

    def test_editorial_groups_do_not_end_on_dangling_pronouns(self):
        words = (
            "Feeling pressure on a daily basis in the capacity that we feel is "
            "such a privilege. If you feel bad and you wake up and ask for help."
        ).split()
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 18.0,
                    "text": " ".join(words),
                    "words": [
                        {
                            "word": word,
                            "start": 10.0 + index * 0.3,
                            "end": 10.24 + index * 0.3,
                        }
                        for index, word in enumerate(words)
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            10.0,
            18.0,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )

        dangling = {"i", "he", "she", "it", "we", "they", "you"}
        self.assertTrue(all(len(cue["words"]) <= 6 for cue in cues))
        self.assertTrue(
            all(
                cue["words"][-1].lower().strip(".,?!") not in dangling
                for cue in cues[:-1]
            )
        )

    def test_editorial_caption_never_overlaps_protected_face(self):
        frame = np.full((1280, 720, 3), 32, dtype=np.uint8)
        face = (282, 530, 96, 96)
        protected = _expand_protected_face(face, (720, 1280))
        renderer = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )

        rendered = renderer.draw(
            frame,
            {
                "words": ["THE", "PRESENT."],
                "active_index": -1,
                "emphasis_index": 1,
                "typography_variant": "headline",
                "typography_base_scale": 1.24,
                "typography_anchor_scale": 1.0,
                "typography_accent_style": "base",
            },
            protected_boxes=[protected],
            safe_box=(22, 450, 676, 380),
        )

        self.assertIsNotNone(renderer.last_drawn_box)
        self.assertEqual(
            _rect_intersection_area(renderer.last_drawn_box, protected),
            0,
        )
        x, y, width, height = face
        self.assertTrue(
            np.array_equal(
                rendered[y:y + height, x:x + width],
                frame[y:y + height, x:x + width],
            )
        )

    def test_sampled_speaker_box_seeds_the_opposite_caption_lane(self):
        safe_box = _editorial_inset_box((1920, 1080), (720, 1280))
        mapped = _map_editorial_bbox(
            (200, 200, 300, 300),
            (1920, 1080),
            (720, 1280),
        )
        protected = _expand_protected_face(mapped, (720, 1280))
        lane = _editorial_caption_lane(safe_box, [protected])

        self.assertEqual(lane[4], "side")
        self.assertGreaterEqual(lane[0], protected[0] + protected[2])

    def test_editorial_font_size_scales_with_output_resolution(self):
        renderer_720p = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        renderer_1080p = _CaptionRenderer(
            frame_width=1080,
            frame_height=1920,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )

        self.assertEqual(renderer_720p.base_font_size, 48)
        self.assertEqual(renderer_1080p.base_font_size, 72)
        self.assertAlmostEqual(
            renderer_720p.base_font_size / 1280,
            renderer_1080p.base_font_size / 1920,
            places=3,
        )

    def test_editorial_side_caption_tracks_the_speaker_head_height(self):
        frame = np.zeros((1280, 720, 3), dtype=np.uint8)
        renderer = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        protected = (470, 260, 220, 500)

        renderer.draw(
            frame,
            {
                "words": ["BUILD", "MEANING"],
                "active_index": 1,
                "visible_word_count": 2,
                "emphasis_index": 1,
                "phrase_id": 41,
                "sentence_id": 4,
                "sentence_phrase_index": 0,
                "sentence_phrase_count": 1,
                "caption_track_progress": 0.50,
                "typography_variant": "statement",
                "typography_base_scale": 0.86,
                "typography_anchor_scale": 1.0,
                "typography_accent_style": "support",
            },
            safe_box=(18, 76, 684, 1126),
            protected_boxes=[protected],
        )

        caption = renderer.last_drawn_box
        caption_center_y = caption[1] + caption[3] / 2
        expected_center_y = protected[1] + protected[3] * 0.46
        self.assertLessEqual(abs(caption_center_y - expected_center_y), 2)
        self.assertLessEqual(caption[0] + caption[2], protected[0])

    def test_editorial_sentence_lane_switches_only_when_new_face_obstructs_it(self):
        frame = np.zeros((1280, 720, 3), dtype=np.uint8)
        renderer = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        safe_box = (18, 76, 684, 1126)
        right_face = (470, 260, 220, 500)
        left_face = (30, 260, 220, 500)
        base = {
            "active_index": 1,
            "visible_word_count": 2,
            "emphasis_index": 1,
            "sentence_id": 4,
            "sentence_phrase_count": 2,
            "caption_track_progress": 0.50,
            "typography_variant": "statement",
            "typography_base_scale": 0.86,
            "typography_anchor_scale": 1.0,
            "typography_accent_style": "support",
        }

        renderer.draw(
            frame,
            {
                **base,
                "words": ["FIRST", "SHOT"],
                "phrase_id": 50,
                "sentence_phrase_index": 0,
            },
            safe_box=safe_box,
            protected_boxes=[right_face],
        )
        first_box = renderer.last_drawn_box
        renderer.draw(
            frame,
            {
                **base,
                "words": ["SECOND", "SHOT"],
                "phrase_id": 51,
                "sentence_phrase_index": 1,
            },
            safe_box=safe_box,
            protected_boxes=[left_face],
        )
        second_box = renderer.last_drawn_box

        self.assertLessEqual(first_box[0] + first_box[2], right_face[0])
        self.assertGreaterEqual(second_box[0], left_face[0] + left_face[2])
        self.assertEqual(_rect_intersection_area(second_box, left_face), 0)

    def test_editorial_headline_is_larger_than_support_phrase(self):
        frame = np.zeros((1280, 720, 3), dtype=np.uint8)
        renderer = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        base_cue = {
            "words": ["CHOOSE", "FREEDOM"],
            "active_index": -1,
            "emphasis_index": 1,
            "typography_anchor_scale": 1.0,
            "typography_accent_style": "base",
        }

        renderer.draw(
            frame,
            {
                **base_cue,
                "typography_variant": "support",
                "typography_base_scale": 0.82,
            },
            safe_box=(22, 450, 676, 380),
        )
        support_height = renderer.last_drawn_box[3]
        renderer.draw(
            frame,
            {
                **base_cue,
                "typography_variant": "headline",
                "typography_base_scale": 1.24,
            },
            safe_box=(22, 450, 676, 380),
        )
        headline_height = renderer.last_drawn_box[3]

        self.assertGreater(headline_height, support_height)

    def test_editorial_caption_uses_a_stable_bottom_anchor(self):
        frame = np.zeros((1280, 720, 3), dtype=np.uint8)
        renderer = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        safe_box = (22, 450, 676, 380)
        base = {
            "active_index": -1,
            "emphasis_index": 1,
            "typography_anchor_scale": 1.0,
            "typography_accent_style": "base",
            "typography_secondary_index": -1,
        }

        renderer.draw(
            frame,
            {
                **base,
                "words": ["QUIET", "SUPPORT"],
                "typography_variant": "support",
                "typography_base_scale": 0.86,
            },
            safe_box=safe_box,
        )
        support_bottom = renderer.last_drawn_box[1] + renderer.last_drawn_box[3]
        renderer.draw(
            frame,
            {
                **base,
                "words": ["CORE", "MESSAGE"],
                "typography_variant": "headline",
                "typography_base_scale": 1.06,
            },
            safe_box=safe_box,
        )
        headline_bottom = renderer.last_drawn_box[1] + renderer.last_drawn_box[3]

        self.assertLessEqual(abs(headline_bottom - support_bottom), 2)

    def test_editorial_progressive_reveal_keeps_the_phrase_box_locked(self):
        frame = np.zeros((1280, 720, 3), dtype=np.uint8)
        renderer = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        cue = {
            "words": ["PEOPLE", "WERE", "WATCHING"],
            "active_index": 0,
            "emphasis_index": 2,
            "phrase_id": 7,
            "typography_variant": "headline",
            "typography_base_scale": 1.06,
            "typography_anchor_scale": 1.22,
            "typography_accent_style": "base",
            "typography_secondary_index": -1,
        }
        safe_box = (22, 450, 676, 380)

        renderer.draw(
            frame,
            {**cue, "visible_word_count": 1},
            safe_box=safe_box,
            protected_boxes=[(250, 520, 120, 150)],
        )
        first_box = renderer.last_drawn_box
        renderer.draw(
            frame,
            {**cue, "active_index": 2, "visible_word_count": 3},
            safe_box=safe_box,
            protected_boxes=[(270, 500, 120, 150)],
        )

        self.assertEqual(renderer.last_drawn_box, first_box)
        self.assertEqual(renderer.last_visible_word_count, 3)

    def test_editorial_sentence_moves_only_downward_then_resets(self):
        frame = np.zeros((1280, 720, 3), dtype=np.uint8)
        renderer = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        safe_box = (18, 76, 684, 1126)
        protected = [(470, 260, 220, 500)]
        base = {
            "active_index": 1,
            "visible_word_count": 2,
            "emphasis_index": 1,
            "typography_variant": "support",
            "typography_base_scale": 0.90,
            "typography_anchor_scale": 1.10,
            "typography_accent_style": "base",
            "sentence_id": 4,
            "sentence_phrase_count": 3,
        }

        tops = []
        for phrase_index, words in enumerate(
            (["START", "HERE"], ["BUILD", "MEANING"], ["LAND", "HERE"])
        ):
            renderer.draw(
                frame,
                {
                    **base,
                    "words": words,
                    "phrase_id": 20 + phrase_index,
                    "sentence_phrase_index": phrase_index,
                },
                safe_box=safe_box,
                protected_boxes=protected,
            )
            tops.append(renderer.last_drawn_box[1])
            self.assertEqual(
                _rect_intersection_area(renderer.last_drawn_box, protected[0]),
                0,
            )

        self.assertEqual(tops, sorted(tops))
        self.assertEqual(len(set(tops)), 3)
        self.assertGreater(tops[0], safe_box[1] + safe_box[3] * 0.18)

        renderer.draw(
            frame,
            {
                **base,
                "words": ["NEW", "SENTENCE"],
                "phrase_id": 30,
                "sentence_id": 5,
                "sentence_phrase_index": 0,
            },
            safe_box=safe_box,
            protected_boxes=protected,
        )
        self.assertLess(renderer.last_drawn_box[1], tops[-1])

    def test_editorial_sentence_uses_only_three_ordered_track_stops(self):
        groups = [
            [
                {
                    "text": f"word{index}{'.' if index == 7 else ','}",
                    "start": float(index),
                    "end": float(index) + 0.4,
                }
            ]
            for index in range(8)
        ]

        layout = _caption_sentence_layout(groups)
        slots = [item["caption_track_slot"] for item in layout]
        positions = [item["caption_track_progress"] for item in layout]

        self.assertEqual(slots, sorted(slots))
        self.assertEqual(set(slots), {0, 1, 2})
        self.assertEqual(positions[0], 0.40)
        self.assertEqual(positions[-1], 0.60)
        self.assertLessEqual(len(set(positions)), 3)

    def test_editorial_side_track_keeps_one_text_edge_locked(self):
        frame = np.zeros((1280, 720, 3), dtype=np.uint8)
        renderer = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        safe_box = (18, 76, 684, 1126)
        protected = [(470, 180, 220, 840)]
        base = {
            "active_index": 0,
            "visible_word_count": 4,
            "emphasis_index": 0,
            "typography_variant": "statement",
            "typography_base_scale": 0.86,
            "typography_anchor_scale": 1.0,
            "typography_accent_style": "support",
            "typography_body_style": "support",
            "sentence_id": 4,
            "sentence_phrase_count": 2,
            "caption_track_progress": 0.50,
        }

        left_edges = []
        for phrase_id, words in enumerate(
            (["ONE", "IDEA"], ["A", "LONGER", "CLEAR", "STATEMENT"]),
            start=40,
        ):
            renderer.draw(
                frame,
                {
                    **base,
                    "words": words,
                    "phrase_id": phrase_id,
                    "sentence_phrase_index": phrase_id - 40,
                },
                safe_box=safe_box,
                protected_boxes=protected,
            )
            left_edges.append(renderer.last_drawn_box[0])

        self.assertEqual(left_edges[0], left_edges[1])
        self.assertEqual(
            _rect_intersection_area(renderer.last_drawn_box, protected[0]),
            0,
        )

    def test_editorial_handoff_packs_caption_boxes_without_overlap(self):
        frame = np.zeros((1280, 720, 3), dtype=np.uint8)
        renderer = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        occupied = []
        safe_box = (22, 450, 676, 380)
        protected = [(490, 470, 180, 290)]
        base = {
            "active_index": 0,
            "visible_word_count": 4,
            "emphasis_index": 0,
            "typography_body_style": "support",
            "sentence_id": 2,
            "sentence_phrase_count": 3,
        }

        renderer.draw(
            frame,
            {
                **base,
                "words": ["MAN", "IS", "A", "LOT"],
                "phrase_id": 10,
                "sentence_phrase_index": 1,
                "caption_track_progress": 0.50,
                "typography_variant": "statement",
                "typography_base_scale": 0.86,
                "typography_anchor_scale": 1.0,
                "typography_accent_style": "support",
            },
            safe_box=safe_box,
            protected_boxes=protected,
            occupied_caption_boxes=occupied,
        )
        first_box = renderer.last_drawn_box
        renderer.draw(
            frame,
            {
                **base,
                "words": ["HARDER"],
                "visible_word_count": 1,
                "phrase_id": 11,
                "sentence_phrase_index": 2,
                "caption_track_progress": 0.60,
                "typography_variant": "headline",
                "typography_base_scale": 0.82,
                "typography_anchor_scale": 1.58,
                "typography_accent_style": "base",
            },
            safe_box=safe_box,
            protected_boxes=protected,
            occupied_caption_boxes=occupied,
        )
        second_box = renderer.last_drawn_box

        self.assertEqual(_rect_intersection_area(first_box, second_box), 0)
        self.assertGreaterEqual(
            second_box[1] - (first_box[1] + first_box[3]),
            MOTIVATIONAL_CAPTION_BLOCK_GAP,
        )

    def test_editorial_payoff_below_face_uses_full_width(self):
        frame = np.zeros((1280, 720, 3), dtype=np.uint8)
        renderer = _CaptionRenderer(
            frame_width=720,
            frame_height=1280,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )
        protected = (300, 260, 360, 430)

        renderer.draw(
            frame,
            {
                "words": ["CONSEQUENCES."],
                "active_index": 0,
                "visible_word_count": 1,
                "emphasis_index": 0,
                "phrase_id": 77,
                "sentence_id": 8,
                "sentence_phrase_index": 7,
                "sentence_phrase_count": 8,
                "typography_variant": "support",
                "typography_base_scale": 1.0,
                "typography_anchor_scale": 1.08,
                "typography_accent_style": "base",
            },
            safe_box=(18, 76, 684, 1126),
            protected_boxes=[protected],
        )

        self.assertGreater(renderer.last_drawn_box[2], 250)
        self.assertEqual(
            _rect_intersection_area(renderer.last_drawn_box, protected),
            0,
        )

    def test_motivational_captions_drop_standalone_filler_cue(self):
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 12.0,
                    "text": "Yeah. Discipline creates freedom.",
                    "words": [
                        {"word": "Yeah.", "start": 10.0, "end": 10.35},
                        {"word": "Discipline", "start": 10.8, "end": 11.1},
                        {"word": "creates", "start": 11.15, "end": 11.4},
                        {"word": "freedom.", "start": 11.45, "end": 11.8},
                    ],
                }
            ]
        }

        cues = _build_word_cues(
            transcript,
            10.0,
            12.0,
            caption_style=BUDGET_FRIENDLY_CAPTION_STYLE,
        )

        self.assertEqual(len(cues), 3)
        self.assertEqual(
            [cue["text"] for cue in cues],
            [
                "Discipline creates freedom.",
                "Discipline creates freedom.",
                "Discipline creates freedom.",
            ],
        )
        self.assertEqual([cue["visible_word_count"] for cue in cues], [1, 2, 3])
        self.assertEqual({cue["sentence_id"] for cue in cues}, {0})

    def test_motivational_layout_bypasses_corner_facecam_split(self):
        class FakeCap:
            def __init__(self):
                self.frames = [np.zeros((180, 320, 3), dtype=np.uint8) for _ in range(12)]
                self.position = 0

            def get(self, prop):
                return len(self.frames) if prop == cv2.CAP_PROP_FRAME_COUNT else 0

            def set(self, prop, value):
                if prop == cv2.CAP_PROP_POS_FRAMES:
                    self.position = int(value)

            def read(self):
                frame = self.frames[min(self.position, len(self.frames) - 1)]
                self.position += 1
                return True, frame.copy()

        class SpeakerCascade:
            def detectMultiScale(self, *args, **kwargs):
                return np.array([[120, 35, 70, 70]], dtype=np.int32)

        layout, box = _detect_clip_layout(
            cv2,
            FakeCap(),
            SpeakerCascade(),
            (320, 180),
            layout_hint="motivational_speaker",
        )

        self.assertEqual(layout, "stable_speaker")
        self.assertIsNotNone(box)

    def test_editorial_layout_prefers_persistent_profile_speaker(self):
        class FakeCap:
            def __init__(self):
                self.frames = [
                    np.zeros((180, 320, 3), dtype=np.uint8)
                    for _ in range(12)
                ]
                self.position = 0

            def get(self, prop):
                return (
                    len(self.frames)
                    if prop == cv2.CAP_PROP_FRAME_COUNT
                    else 0
                )

            def set(self, prop, value):
                if prop == cv2.CAP_PROP_POS_FRAMES:
                    self.position = int(value)

            def read(self):
                frame = self.frames[min(self.position, len(self.frames) - 1)]
                self.position += 1
                return True, frame.copy()

        class FrontalFalsePositive:
            def detectMultiScale(self, *args, **kwargs):
                return np.array([[40, 40, 80, 80]], dtype=np.int32)

        class ProfileSpeaker:
            def detectMultiScale(self, *args, **kwargs):
                return np.array([[180, 20, 100, 100]], dtype=np.int32)

        layout, box = _detect_clip_layout(
            cv2,
            FakeCap(),
            FrontalFalsePositive(),
            (320, 180),
            layout_hint="motivational_editorial",
            profile_face_cascade=ProfileSpeaker(),
        )

        self.assertEqual(layout, "editorial_speaker")
        self.assertIsNotNone(box)
        self.assertGreater(box[0], 150)

    def test_editorial_layout_preserves_source_composition(self):
        source = np.full((180, 320, 3), 220, dtype=np.uint8)

        composed = _compose_editorial_inset(cv2, source, (180, 320))

        self.assertEqual(composed.shape, (320, 180, 3))
        self.assertEqual(int(composed[8, 90].max()), 0)
        self.assertGreater(int(composed[160, 90].mean()), 180)
        self.assertEqual(int(composed[108, 7].max()), 0)

    def test_reference_editorial_grade_is_monochrome_and_preserves_black_canvas(self):
        frame = np.zeros((24, 32, 3), dtype=np.uint8)
        frame[6:18, 8:24] = (40, 120, 220)

        graded = _apply_motivational_grade(cv2, frame)

        self.assertTrue(np.array_equal(graded[:, :, 0], graded[:, :, 1]))
        self.assertTrue(np.array_equal(graded[:, :, 1], graded[:, :, 2]))
        self.assertEqual(int(graded[0, 0].max()), 0)
        self.assertGreater(int(graded[12, 16].mean()), 0)

    def test_editorial_full_frame_crop_keeps_speaker_right_of_center(self):
        face = (1150, 250, 200, 220)

        _, crop_box = _editorial_crop_geometry((1920, 960), face, 9 / 16)
        mapped = _map_bbox_to_crop(face, crop_box, (720, 1280))

        self.assertEqual(crop_box[2:], (540, 960))
        mapped_center_x = mapped[0] + mapped[2] / 2
        self.assertAlmostEqual(mapped_center_x / 720, 0.68, delta=0.03)
        self.assertGreaterEqual(mapped[0], 0)
        self.assertLessEqual(mapped[0] + mapped[2], 720)

    def test_editorial_closeup_zooms_out_without_black_bars(self):
        frame = np.full((960, 1920, 3), 170, dtype=np.uint8)
        frame[:, :960] = (80, 120, 180)
        close_face = (1191, 148, 509, 509)

        crop_box, render_box, uses_canvas = _editorial_composition_geometry(
            (1920, 960),
            close_face,
            9 / 16,
            (720, 1280),
        )
        mapped_face = _map_bbox_to_render(close_face, crop_box, render_box)
        composed = _compose_editorial_frame(
            cv2,
            frame,
            (720, 1280),
            close_face,
            9 / 16,
        )

        self.assertTrue(uses_canvas)
        self.assertEqual(crop_box[2:], (960, 960))
        self.assertEqual(render_box, (0, 280, 720, 720))
        self.assertGreaterEqual(mapped_face[0], 0)
        self.assertLessEqual(mapped_face[0] + mapped_face[2], 720)
        self.assertEqual(composed.shape, (1280, 720, 3))
        self.assertGreater(int(composed[:200].mean()), 0)
        self.assertGreater(int(composed[-200:].mean()), 0)

    def test_editorial_normal_shot_remains_full_height(self):
        _, render_box, uses_canvas = _editorial_composition_geometry(
            (1920, 960),
            (1200, 260, 180, 180),
            9 / 16,
            (720, 1280),
        )

        self.assertFalse(uses_canvas)
        self.assertEqual(render_box, (0, 0, 720, 1280))

    def test_editorial_hint_never_routes_to_facecam_split(self):
        class FakeCap:
            def __init__(self):
                self.frames = [np.zeros((180, 320, 3), dtype=np.uint8) for _ in range(12)]
                self.position = 0

            def get(self, prop):
                return len(self.frames) if prop == cv2.CAP_PROP_FRAME_COUNT else 0

            def set(self, prop, value):
                if prop == cv2.CAP_PROP_POS_FRAMES:
                    self.position = int(value)

            def read(self):
                frame = self.frames[min(self.position, len(self.frames) - 1)]
                self.position += 1
                return True, frame.copy()

        class SpeakerCascade:
            def detectMultiScale(self, *args, **kwargs):
                return np.array([[120, 35, 70, 70]], dtype=np.int32)

        layout, box = _detect_clip_layout(
            cv2,
            FakeCap(),
            SpeakerCascade(),
            (320, 180),
            layout_hint="motivational_editorial",
        )

        self.assertEqual(layout, "editorial_speaker")
        self.assertIsNotNone(box)

    def test_general_realesrgan_model_is_selectable_for_human_footage(self):
        command = _realesrgan_command(
            ("/runtime/realesrgan-ncnn-vulkan", "/runtime/models"),
            "/input",
            "/output",
            4,
            model_name="realesrgan-x4plus",
        )

        self.assertIn("realesrgan-x4plus", command)
        self.assertIn("4", command)

    def test_manifest_records_rank_metrics_and_output_path(self):
        ranked = [
            {
                **candidate(),
                "final_score": 94.5,
                "output_rank": 1,
                "rejected": False,
                "rejection_reasons": [],
            }
        ]
        shorts = [{**ranked[0], "clip_url": "output/short_01.mp4"}]

        manifest = build_ranking_manifest(
            "https://example.test/watch?v=source",
            "/cache/source.mp4",
            "motivational_podcast",
            ranked,
            shorts,
            source_hash="a" * 64,
        )

        self.assertEqual(manifest["candidates"][0]["final_score"], 94.5)
        self.assertEqual(manifest["candidates"][0]["clip_url"], "output/short_01.mp4")


if __name__ == "__main__":
    unittest.main()
