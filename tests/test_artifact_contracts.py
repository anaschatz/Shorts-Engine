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
from shorts_generator.originality import evaluate_originality


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
                            "word": "One exact thought.",
                            "start": 0.000000123,
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
