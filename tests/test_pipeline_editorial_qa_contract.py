import unittest

from shorts_generator.artifact_contracts import content_hash
from shorts_generator.pipeline import build_editorial_render_evidence


class PipelineEditorialQaContractTests(unittest.TestCase):
    def test_render_evidence_binds_versions_timeline_typography_and_cuts(self):
        evidence = build_editorial_render_evidence(
            {
                "format_profile": "bf_viral_micro_v1",
                "selection_profile": "motivational_tension_micro_v1",
                "render_profile": "bf_editorial_inset_v1",
                "layout_profile": "editorial_inset",
                "grade_profile": "high_contrast_grayscale_v1",
                "typography_profile": "kinetic_editorial_v1",
                "first_visible_text_seconds": 0.0,
                "semantic_end_seconds": 10.4,
                "max_hero_scale": 2.2,
                "source_cut_count": 1,
                "artificial_cut_count": 0,
                "brand_tail_profile": "bf_reference_tail_v2",
                "brand_tail_seconds": 1.25,
                "brand_tail_start_seconds": 11.45,
                "brand_tail_clearance_seconds": 1.05,
                "natural_tail_seconds": 0.75,
                "transition_tail_seconds": 0.3,
                "freeze_hold_seconds": 0.0,
                "source_content_end_time": 11.45,
                "next_spoken_word_start": 12.0,
                "next_speech_safety_seconds": 0.04,
                "acoustic_speech_end_time": 10.35,
                "transcript_next_spoken_word_start": 11.45,
                "acoustic_boundary_source": "candidate_verified_acoustic",
                "verified_acoustic_speech_end_time": 10.35,
                "verified_next_spoken_word_start": 12.0,
                "verified_next_speech_safety_seconds": 0.04,
                "verified_acoustic_boundary_evidence": "waveform review",
                "source_speech_leak_guard_passed": True,
                "effective_source_cut_limit": 2,
                "semantic_completion_source_cut_exception": False,
            }
        )

        self.assertEqual(evidence["cuts"]["artificialCutCount"], 0)
        self.assertEqual(evidence["brandTail"]["mark"], "BF.")
        self.assertEqual(
            evidence["brandTail"]["profile"],
            "bf_reference_tail_v2",
        )
        self.assertEqual(evidence["brandTail"]["freezeHoldSeconds"], 0.0)
        self.assertTrue(evidence["brandTail"]["sourceSpeechLeakGuardPassed"])
        self.assertEqual(
            evidence["brandTail"]["acousticBoundarySource"],
            "candidate_verified_acoustic",
        )
        self.assertEqual(
            evidence["brandTail"]["verifiedAcousticBoundaryEvidence"],
            "waveform review",
        )
        self.assertEqual(evidence["cuts"]["sourceCutLimit"], 2)
        self.assertEqual(evidence["timeline"]["firstVisibleTextSeconds"], 0.0)
        self.assertGreaterEqual(
            evidence["brandTail"]["startSeconds"],
            evidence["timeline"]["semanticEndSeconds"],
        )
        self.assertEqual(evidence["contentHash"], content_hash(evidence))

    def test_render_evidence_keeps_visual_cap_separate_from_next_speech(self):
        evidence = build_editorial_render_evidence(
            {
                "brand_tail_profile": "bf_smooth_tail_v4",
                "source_content_end_time": 1213.828,
                "next_spoken_word_start": 1213.98,
                "verified_visual_safe_end_time": 1213.828,
                "verified_visual_boundary_evidence": "scene-cut review",
                "visual_safe_end_guard_passed": True,
                "source_speech_leak_guard_passed": True,
            }
        )

        tail = evidence["brandTail"]
        self.assertAlmostEqual(tail["verifiedVisualSafeEndTime"], 1213.828)
        self.assertAlmostEqual(tail["nextSpokenWordStart"], 1213.98)
        self.assertEqual(
            tail["verifiedVisualBoundaryEvidence"],
            "scene-cut review",
        )
        self.assertTrue(tail["visualSafeEndGuardPassed"])
        self.assertEqual(evidence["contentHash"], content_hash(evidence))


if __name__ == "__main__":
    unittest.main()
