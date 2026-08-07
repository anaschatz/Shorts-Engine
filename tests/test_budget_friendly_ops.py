import argparse
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import budget_friendly_ops as ops
from shorts_generator import youtube_uploader as youtube_uploader_module
from shorts_generator.artifact_contracts import (
    ArtifactBindingError,
    build_replay_transcript_manifest,
    candidate_hash,
    content_hash,
    file_sha256,
)
from shorts_generator.speech_cleanliness import (
    evaluate_speech_cleanliness_evidence,
)
from shorts_generator.spoken_clarity import evaluate_spoken_clarity_evidence
from shorts_generator.pipeline import build_ranking_manifest
from shorts_generator.profiles import (
    BF_FEED_STOP_FORMAT_V1,
    BF_FEED_STOP_FORMAT_V2,
    BF_FEED_STOP_FORMAT_V3,
    BF_GROWTH_V2,
    BF_VIRAL_MICRO_V1,
    SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY,
    resolve_profile_bundle,
)
from shorts_generator.publisher import PublishReceiptStore
from shorts_generator.replay_capture import (
    verify_replay_capture_dataset,
    verify_replay_capture_label,
    verify_replay_human_preview_rejection,
    verify_replay_human_rejection,
)
from tests.test_replay_capture import passing_preview_provenance_report
from tests.test_artifact_contracts import feed_stop_v3_candidate


def replay_backfill_transcript(
    text,
    source_hash,
    *,
    multiword_token=False,
    include_provenance=True,
):
    tokens = [text] if multiword_token else text.split()
    step = 11.75 / len(tokens)
    transcript = {
        "duration": 12.0,
        "segments": [
            {
                "start": 0.0,
                "end": 11.75,
                "text": text,
                "words": [
                    {
                        "word": token,
                        "start": round(index * step, 6),
                        "end": round((index + 1) * step, 6),
                    }
                    for index, token in enumerate(tokens)
                ],
            }
        ],
    }
    if include_provenance:
        transcript["_cache"] = {
            "schema_version": 3,
            "source_sha256": source_hash,
            "model": "fixture",
            "language": "en",
        }
    return transcript


def attach_clean_speech_report(
    candidate_body,
    source_hash,
    transcript,
    *,
    transcript_timing_hash=None,
    lexical_fillers=None,
    uncovered_vocalizations=None,
    prompted_fillers=None,
):
    report = evaluate_speech_cleanliness_evidence(
        source_hash=source_hash,
        transcript_timing_hash=(
            transcript_timing_hash
            or build_replay_transcript_manifest(
                transcript,
                source_hash,
            )["transcriptTimingHash"]
        ),
        speech_start=candidate_body.get(
            "speech_start_time",
            candidate_body["start_time"],
        ),
        speech_end=candidate_body.get(
            "speech_end_time",
            candidate_body["end_time"],
        ),
        lexical_fillers=lexical_fillers or [],
        uncovered_vocalizations=uncovered_vocalizations or [],
        prompted_fillers=prompted_fillers or [],
        provider_identity={"provider": "test"},
    )
    return {
        **candidate_body,
        "speechCleanlinessReport": report,
        "speechCleanlinessStatus": report["status"],
        "speechCleanlinessEligible": report["eligible"],
        "speechCleanlinessRejectionReasons": report["rejectionReasons"],
        "speechCleanlinessReviewReasons": report["reviewReasons"],
        "speech_cleanliness_decision_version": report["decisionVersion"],
        "speech_cleanliness_status": report["status"],
        "speech_cleanliness_eligible": report["eligible"],
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


def attach_clear_spoken_report(
    candidate_body,
    source_hash,
    transcript,
    *,
    transcript_timing_hash=None,
    provider_identity=None,
):
    transcript_manifest = build_replay_transcript_manifest(transcript, source_hash)
    speech_start = candidate_body.get(
        "speech_start_time",
        candidate_body["start_time"],
    )
    speech_end = candidate_body.get(
        "speech_end_time",
        candidate_body["end_time"],
    )
    reference_words = [
        word
        for segment in transcript["segments"]
        for word in segment["words"]
        if speech_start <= float(word["start"]) < speech_end
        and float(word["end"]) <= speech_end
    ]
    opening_words = [
        {
            "text": word["word"],
            "confidence": 0.98,
        }
        for word in reference_words
        if float(word["start"]) < speech_start + 2.0
    ]
    report = evaluate_spoken_clarity_evidence(
        source_hash=source_hash,
        transcript_timing_hash=(
            transcript_timing_hash
            or transcript_manifest["transcriptTimingHash"]
        ),
        speech_start=speech_start,
        speech_end=speech_end,
        reference_words=reference_words,
        point_exact_quote=candidate_body["final_takeaway_sentence"],
        opening_asr_words=opening_words,
        provider_identity=(
            provider_identity
            if provider_identity is not None
            else SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY
        ),
    )
    counts = report["counts"]
    opening_asr = report["evidence"]["openingAsr"]
    return {
        **candidate_body,
        "spokenClarityReport": report,
        "spokenClarityStatus": report["status"],
        "spokenClarityEligible": report["eligible"],
        "spokenClarityRejectionReasons": report["rejectionReasons"],
        "spokenClarityReviewReasons": report["reviewReasons"],
        "spoken_clarity_decision_version": report["decisionVersion"],
        "spoken_clarity_status": report["status"],
        "spoken_clarity_eligible": report["eligible"],
        "spoken_clarity_reject_reasons": report["rejectionReasons"],
        "spoken_clarity_review_reasons": report["reviewReasons"],
        "spoken_clarity_deterministic_reasons": report[
            "deterministicReasons"
        ],
        "spoken_clarity_provider_status": report["providerStatus"],
        "spoken_clarity_adjacent_duplicate_count": counts[
            "adjacentDuplicates"
        ],
        "spoken_clarity_repeated_phrase_count": counts[
            "repeatedPhraseRestarts"
        ],
        "spoken_clarity_searching_pause_count": counts[
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


def jhh_preview_fixture(root):
    """A preview whose reviewed interval extends beyond ranking candidate 2."""

    source = root / "source.mp4"
    source.write_bytes(b"jhh-source-bytes")
    preview = root / "02-guilt-vs-resentment-source-preview.mp4"
    preview.write_bytes(b"exact-reviewed-jhh-preview")
    source_hash = file_sha256(str(source))
    transcript = {
        "duration": 767.652,
        "segments": [
            {
                "start": 580.92,
                "end": 603.5,
                "text": (
                    "whenever choice resentment guilt choose guilt every time "
                    "because resentment poison"
                ),
                "words": [
                    {"word": "whenever", "start": 580.92, "end": 581.519},
                    {"word": "choice", "start": 581.88, "end": 582.12},
                    {"word": "resentment", "start": 582.54, "end": 583.08},
                    {"word": "guilt", "start": 583.26, "end": 583.62},
                    {"word": "choose", "start": 583.62, "end": 583.92},
                    {"word": "guilt", "start": 584.04, "end": 584.34},
                    {"word": "every", "start": 584.399, "end": 584.519},
                    {"word": "time", "start": 584.519, "end": 584.639},
                    {"word": "because", "start": 601.019, "end": 601.38},
                    {"word": "resentment", "start": 601.62, "end": 602.1},
                    {"word": "poison", "start": 602.82, "end": 603.181},
                ],
            }
        ],
        "_cache": {
            "schema_version": 3,
            "source_sha256": source_hash,
            "model": "fixture",
            "language": "en",
        },
    }
    candidate_body = {
        "start_time": 579.17,
        "end_time": 586.04,
        "speech_start_time": 580.92,
        "speech_end_time": 584.639,
        "candidate_text": (
            "whenever choice resentment guilt choose guilt every time"
        ),
        "content_profile": "motivational_podcast",
        "selection_profile": "bf_feed_stop_v1",
        "render_profile": "bf_editorial_inset_v2",
        "format_profile": "bf_feed_stop_format_v1",
        "selection_rank": 2,
        "rejected": True,
        "rejection_reasons": ["weak_hook"],
        "source_cut_count": 0,
    }
    candidate_value = {
        **candidate_body,
        "candidate_hash": candidate_hash(candidate_body, source_hash),
    }
    ranking = build_ranking_manifest(
        "https://www.youtube.com/watch?v=JHh731RsnI4",
        str(source),
        "motivational_podcast",
        [candidate_value],
        [],
        profiles=resolve_profile_bundle(format_profile=BF_FEED_STOP_FORMAT_V1),
        source_hash=source_hash,
        transcript=transcript,
    )
    ranking_path = root / "ranking.json"
    ops.write_json(str(ranking_path), ranking)
    return source, preview, ranking_path, candidate_value


def eight_g_preview_fixture(root):
    """A reviewed preview ending 40 ms before rank 1's outer interval."""

    source = root / "source.mp4"
    source.write_bytes(b"8g-source-bytes")
    preview = root / "01-boundaries-source-preview.mp4"
    preview.write_bytes(b"exact-reviewed-8g-preview")
    source_hash = file_sha256(str(source))
    transcript = {
        "duration": 381.528,
        "segments": [
            {
                "start": 126.479,
                "end": 149.52,
                "text": "we open boundaries and make the point clearly",
                "words": [
                    {"word": "we", "start": 126.479, "end": 126.6},
                    {"word": "open", "start": 128.8, "end": 129.32},
                    {"word": "boundaries", "start": 130.0, "end": 131.0},
                    {"word": "and", "start": 137.0, "end": 137.2},
                    {"word": "make", "start": 138.0, "end": 138.4},
                    {"word": "the", "start": 140.0, "end": 140.2},
                    {"word": "point", "start": 144.0, "end": 144.4},
                    {"word": "clearly", "start": 148.4, "end": 148.96},
                ],
            }
        ],
        "_cache": {
            "schema_version": 3,
            "source_sha256": source_hash,
            "model": "fixture",
            "language": "en",
        },
    }
    candidate_body = {
        "start_time": 126.479,
        "end_time": 149.52,
        "speech_start_time": 126.479,
        "speech_end_time": 148.96,
        "candidate_text": "we open boundaries and make the point clearly",
        "content_profile": "motivational_podcast",
        "selection_profile": "bf_feed_stop_v1",
        "render_profile": "bf_editorial_inset_v2",
        "format_profile": "bf_feed_stop_format_v1",
        "selection_rank": 1,
        "rejected": True,
        "rejection_reasons": ["weak_hook"],
        "source_cut_count": 0,
    }
    candidate_value = {
        **candidate_body,
        "candidate_hash": candidate_hash(candidate_body, source_hash),
    }
    ranking = build_ranking_manifest(
        "https://www.youtube.com/watch?v=8G2d8oERs-I",
        str(source),
        "motivational_podcast",
        [candidate_value],
        [],
        profiles=resolve_profile_bundle(format_profile=BF_FEED_STOP_FORMAT_V1),
        source_hash=source_hash,
        transcript=transcript,
    )
    ranking_path = root / "ranking.json"
    ops.write_json(str(ranking_path), ranking)
    return source, preview, ranking_path, candidate_value


class BudgetFriendlyOpsTests(unittest.TestCase):
    def test_approve_candidate_cli_accepts_v3_only_with_exact_bound_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"feed-stop-v3-source")
            source_hash = file_sha256(str(source))
            candidate, transcript = feed_stop_v3_candidate(
                source_hash=source_hash
            )
            ranking = build_ranking_manifest(
                "https://example.test/feed-stop-v3-source",
                str(source),
                "motivational_podcast",
                [candidate],
                [candidate],
                profiles=resolve_profile_bundle(
                    format_profile=BF_FEED_STOP_FORMAT_V3
                ),
                source_hash=source_hash,
                transcript=transcript,
            )
            ranking_path = root / "ranking.json"
            decision_path = root / "decision.json"
            evidence = root / "evidence"
            ops.write_json(str(ranking_path), ranking)
            args = ops.build_parser().parse_args(
                [
                    "approve-candidate",
                    "--candidate-json",
                    str(ranking_path),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-07T12:00:00Z",
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(decision_path),
                ]
            )

            decision = args.handler(args)

            self.assertEqual(
                decision["formatProfile"],
                BF_FEED_STOP_FORMAT_V3,
            )
            self.assertEqual(
                decision["hookGateReport"],
                ranking["candidates"][0]["hookGateReport"],
            )
            self.assertTrue(decision_path.is_file())
            self.assertEqual(
                len(list((evidence / "labels").glob("*/*.json"))),
                1,
            )

            mismatched_transcript = json.loads(json.dumps(transcript))
            mismatched_transcript["segments"][0]["words"][0]["start"] = 0.001
            invalid_ranking = build_ranking_manifest(
                "https://example.test/feed-stop-v3-source",
                str(source),
                "motivational_podcast",
                [candidate],
                [candidate],
                profiles=resolve_profile_bundle(
                    format_profile=BF_FEED_STOP_FORMAT_V3
                ),
                source_hash=source_hash,
                transcript=mismatched_transcript,
            )
            invalid_path = root / "wrong-transcript.json"
            ops.write_json(str(invalid_path), invalid_ranking)
            with self.assertRaisesRegex(
                ArtifactBindingError,
                "HookGate V4|another transcript",
            ):
                ops.candidate_from_file(
                    str(invalid_path),
                    1,
                    str(source),
                )

    def test_bind_replay_transcript_accepts_only_canonical_youtube_cache_metadata(self):
        transcript = replay_backfill_transcript(
            " ".join(f"word{index}" for index in range(24)),
            "unused",
        )
        transcript["_cache"] = {
            "schema_version": 1,
            "parser_version": "json3-words-v1",
            "provider": "automatic_captions",
            "video_id": "legacy123",
            "requested_language": "en",
            "track_language": "en-orig",
        }

        ops._verify_backfill_transcript_provenance(
            transcript,
            source_input="https://www.youtube.com/watch?v=legacy123",
            source_hash="a" * 64,
        )
        transcript["_cache"]["parser_version"] = "stale-parser"
        with self.assertRaisesRegex(ValueError, "cache provenance is incompatible"):
            ops._verify_backfill_transcript_provenance(
                transcript,
                source_input="https://www.youtube.com/watch?v=legacy123",
                source_hash="a" * 64,
            )

    def test_bind_replay_transcript_reseals_legacy_ranking_without_a_label(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            source_hash = file_sha256(str(source))
            candidate_body = {
                "start_time": 0.0,
                "end_time": 11.75,
                "speech_start_time": 0.0,
                "speech_end_time": 11.75,
                "title": "Review this exact candidate",
                "candidate_text": "Pressure creates choices and boundaries protect peace.",
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
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            legacy = build_ranking_manifest(
                "https://www.youtube.com/watch?v=legacy123",
                str(source),
                "motivational_podcast",
                [candidate],
                [candidate],
                profiles=resolve_profile_bundle(format_profile=BF_VIRAL_MICRO_V1),
                source_hash=source_hash,
            )
            transcript = replay_backfill_transcript(
                "Pressure creates choices and boundaries protect peace.",
                source_hash,
            )
            ranking_path = root / "legacy-ranking.json"
            transcript_path = root / "transcript.json"
            output = root / "review-ranking.json"
            evidence = root / "evidence"
            ops.write_json(str(ranking_path), legacy)
            ops.write_json(str(transcript_path), transcript)
            args = ops.build_parser().parse_args(
                [
                    "bind-replay-transcript",
                    "--ranking",
                    str(ranking_path),
                    "--source",
                    str(source),
                    "--transcript",
                    str(transcript_path),
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(output),
                ]
            )

            result = args.handler(args)
            replay_ranking = ops.read_json(str(output))
            retry = args.handler(args)
            collision_output = root / "owned-by-user.json"
            collision_output.write_text('{"owner":"user"}\n', encoding="utf-8")
            collision_args = ops.build_parser().parse_args(
                [
                    "bind-replay-transcript",
                    "--ranking",
                    str(ranking_path),
                    "--source",
                    str(source),
                    "--transcript",
                    str(transcript_path),
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(collision_output),
                ]
            )
            with self.assertRaisesRegex(
                ValueError,
                "immutable capture collision",
            ):
                collision_args.handler(collision_args)
            collision_body = collision_output.read_text(encoding="utf-8")

        self.assertEqual(result["legacyRankingManifestHash"], legacy["contentHash"])
        self.assertTrue(result["created"])
        self.assertFalse(retry["created"])
        self.assertEqual(collision_body, '{"owner":"user"}\n')
        self.assertEqual(result["rankingManifestHash"], replay_ranking["contentHash"])
        self.assertEqual(result["candidateCount"], 1)
        self.assertEqual(result["engineSelectedCandidateCount"], 1)
        self.assertEqual(result["engineSelectionSemantics"], "unknown_not_human_label")
        self.assertEqual(result["humanPositiveCount"], 0)
        self.assertTrue(result["approvalRequired"])
        self.assertEqual(
            replay_ranking["replayBackfillProvenance"]["legacyRankingManifestHash"],
            legacy["contentHash"],
        )
        self.assertEqual(
            replay_ranking["replayTranscriptManifest"]["sourceHash"],
            source_hash,
        )
        ops.verify_seal(replay_ranking, "RankingManifest")
        self.assertFalse(evidence.exists())

    def test_bind_replay_transcript_rejects_unprovenanced_unrelated_and_multiword_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            source_hash = file_sha256(str(source))
            candidate_text = "Pressure creates choices and boundaries protect peace."
            candidate_body = {
                "start_time": 0.0,
                "end_time": 11.75,
                "speech_start_time": 0.0,
                "speech_end_time": 11.75,
                "candidate_text": candidate_text,
            }
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            legacy = build_ranking_manifest(
                "https://www.youtube.com/watch?v=legacy123",
                str(source),
                "motivational_podcast",
                [candidate],
                [],
                source_hash=source_hash,
            )
            ranking_path = root / "legacy-ranking.json"
            ops.write_json(str(ranking_path), legacy)
            cases = [
                (
                    "unprovenanced",
                    replay_backfill_transcript(
                        candidate_text,
                        source_hash,
                        include_provenance=False,
                    ),
                    "lacks verifiable cache provenance",
                ),
                (
                    "unrelated",
                    replay_backfill_transcript(
                        "Completely unrelated words occupy this exact interval.",
                        source_hash,
                    ),
                    "text is not supported by its timed interval",
                ),
                (
                    "multiword",
                    replay_backfill_transcript(
                        candidate_text,
                        source_hash,
                        multiword_token=True,
                    ),
                    "word timing tokens must not contain whitespace",
                ),
            ]
            for name, transcript, error_pattern in cases:
                transcript_path = root / f"{name}.json"
                output = root / f"{name}-ranking.json"
                ops.write_json(str(transcript_path), transcript)
                args = ops.build_parser().parse_args(
                    [
                        "bind-replay-transcript",
                        "--ranking",
                        str(ranking_path),
                        "--source",
                        str(source),
                        "--transcript",
                        str(transcript_path),
                        "--output",
                        str(output),
                    ]
                )

                with self.subTest(name=name), self.assertRaisesRegex(
                    ValueError,
                    error_pattern,
                ):
                    args.handler(args)
                self.assertFalse(output.exists())

    def test_bind_replay_transcript_rejects_wrong_source_and_preserves_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            other_source = root / "other.mp4"
            source.write_bytes(b"source")
            other_source.write_bytes(b"other")
            legacy = build_ranking_manifest(
                "https://www.youtube.com/watch?v=legacy123",
                str(source),
                "motivational_podcast",
                [],
                [],
                profiles=resolve_profile_bundle(format_profile=BF_VIRAL_MICRO_V1),
                source_hash=file_sha256(str(source)),
            )
            ranking_path = root / "legacy-ranking.json"
            transcript_path = root / "transcript.json"
            output = root / "review-ranking.json"
            ops.write_json(str(ranking_path), legacy)
            ops.write_json(str(transcript_path), {"duration": 1.0, "segments": []})
            args = ops.build_parser().parse_args(
                [
                    "bind-replay-transcript",
                    "--ranking",
                    str(ranking_path),
                    "--source",
                    str(other_source),
                    "--transcript",
                    str(transcript_path),
                    "--output",
                    str(output),
                ]
            )

            with self.assertRaisesRegex(
                ValueError,
                "not bound to the supplied source",
            ):
                args.handler(args)

            self.assertFalse(output.exists())

    def test_render_approved_batch_cli_preserves_order_and_writes_bundles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "transcript.json"
            decisions = [root / "decision-1.json", root / "decision-2.json"]
            experiments = [root / "experiment-1.json", root / "experiment-2.json"]
            ops.write_json(str(transcript), {"segments": []})
            for index, path in enumerate(decisions, start=1):
                ops.write_json(str(path), {"candidateHash": str(index) * 64})
            for index, path in enumerate(experiments, start=1):
                ops.write_json(str(path), {"experimentId": f"experiment-{index}"})

            fake_result = {
                "schemaVersion": 1,
                "sourceHash": "a" * 64,
                "requestedCount": 2,
                "succeededCount": 2,
                "failedCount": 0,
                "maxWorkers": 2,
                "gpuRendersSerialized": False,
                "results": [
                    {
                        "index": 0,
                        "candidateHash": "1" * 64,
                        "status": "succeeded",
                        "result": {"short": {"clip_url": "short_01.mp4"}},
                    },
                    {
                        "index": 1,
                        "candidateHash": "2" * 64,
                        "status": "succeeded",
                        "result": {"short": {"clip_url": "short_02.mp4"}},
                    },
                ],
            }
            args = ops.build_parser().parse_args(
                [
                    "render-approved-batch",
                    "--source",
                    str(root / "source.mp4"),
                    "--transcript",
                    str(transcript),
                    "--candidate-decision",
                    str(decisions[0]),
                    "--candidate-decision",
                    str(decisions[1]),
                    "--experiment",
                    str(experiments[0]),
                    "--experiment",
                    str(experiments[1]),
                    "--output-dir",
                    directory,
                    "--max-workers",
                    "2",
                ]
            )

            with patch.object(
                ops,
                "render_approved_candidates",
                return_value=fake_result,
            ) as renderer, patch.object(
                ops,
                "LOCAL_PERFORMANCE_REPORT_DIR",
                directory,
            ):
                result = args.handler(args)

            batch_path = Path(result["batchPath"])
            bundle_paths = [
                Path(item["bundlePath"])
                for item in result["results"]
            ]

        self.assertEqual(
            renderer.call_args.args[2],
            [{"candidateHash": "1" * 64}, {"candidateHash": "2" * 64}],
        )
        self.assertEqual(renderer.call_args.kwargs["max_workers"], 2)
        self.assertEqual(batch_path.name, "production-batch.json")
        self.assertEqual(
            [path.name for path in bundle_paths],
            ["production-bundle-01.json", "production-bundle-02.json"],
        )

    def test_approve_candidate_cli_writes_a_sealed_decision(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"source")
            source_hash = file_sha256(str(source))
            candidate_body = {
                "start_time": 1.0,
                "end_time": 11.75,
                "title": "Test",
                "hook_sentence": "A tested tension hook.",
                "final_takeaway_sentence": "A complete takeaway.",
                "candidate_text": "A tested tension hook with a complete takeaway.",
                "content_profile": "motivational_podcast",
                "selection_profile": "motivational_tension_micro_v1",
                "render_profile": "bf_editorial_inset_v1",
                "format_profile": "bf_viral_micro_v1",
                "selection_rank": 1,
                "rejected": False,
                "rejection_reasons": [],
                "source_cut_count": 0,
            }
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            ranking = build_ranking_manifest(
                "https://example.test/source",
                str(source),
                "motivational_podcast",
                [candidate],
                [],
                profiles=resolve_profile_bundle(format_profile=BF_VIRAL_MICRO_V1),
                source_hash=source_hash,
                transcript=replay_backfill_transcript(
                    "A tested tension hook with a complete takeaway.",
                    source_hash,
                ),
            )
            ranking_path = Path(directory) / "ranking.json"
            ops.write_json(
                str(ranking_path),
                ranking,
            )
            output = Path(directory) / "decision.json"
            args = ops.build_parser().parse_args(
                [
                    "approve-candidate",
                    "--candidate-json",
                    str(ranking_path),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-07-16T12:00:00Z",
                    "--evidence-dir",
                    str(Path(directory) / "evidence"),
                    "--output",
                    str(output),
                ]
            )
            decision = args.handler(args)
            output_exists = output.is_file()
            dataset_count = len(
                list((output.parent / "evidence/datasets").glob("*.json"))
            )
            label_count = len(
                list((output.parent / "evidence/labels").glob("*/*.json"))
            )

        self.assertEqual(decision["artifactType"], "CandidateDecision")
        self.assertEqual(len(decision["candidateHash"]), 64)
        self.assertEqual(decision["rankingManifestHash"], ranking["contentHash"])
        self.assertTrue(output_exists)
        self.assertEqual(dataset_count, 1)
        self.assertEqual(label_count, 1)

    def test_approve_candidate_cli_rejects_legacy_feed_stop_v1_before_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"feed-stop-source")
            source_hash = file_sha256(str(source))
            candidate_body = {
                "start_time": 0.0,
                "end_time": 11.75,
                "speech_start_time": 0.0,
                "speech_end_time": 11.5,
                "title": "Protect your peace",
                "hook_sentence": "Boundaries protect your peace.",
                "final_takeaway_sentence": "Boundaries protect your peace.",
                "candidate_text": "Boundaries protect your peace every single day",
                "content_profile": "motivational_podcast",
                "selection_profile": "bf_feed_stop_v1",
                "render_profile": "bf_editorial_inset_v2",
                "format_profile": "bf_feed_stop_format_v1",
                "selection_rank": 1,
                "rejected": False,
                "rejection_reasons": [],
                "source_cut_count": 0,
            }
            transcript = replay_backfill_transcript(
                "Boundaries protect your peace every single day",
                source_hash,
            )
            candidate_body = attach_clean_speech_report(
                candidate_body,
                source_hash,
                transcript,
            )
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            ranking = build_ranking_manifest(
                "https://example.test/feed-stop-source",
                str(source),
                "motivational_podcast",
                [candidate],
                [candidate],
                profiles=resolve_profile_bundle(
                    format_profile=BF_FEED_STOP_FORMAT_V1
                ),
                source_hash=source_hash,
                transcript=transcript,
            )
            ranking_path = root / "ranking.json"
            decision_path = root / "decision.json"
            evidence = root / "evidence"
            ops.write_json(str(ranking_path), ranking)
            args = ops.build_parser().parse_args(
                [
                    "approve-candidate",
                    "--candidate-json",
                    str(ranking_path),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-07T12:00:00Z",
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(decision_path),
                ]
            )

            with self.assertRaisesRegex(
                ArtifactBindingError,
                "legacy replay-only",
            ):
                args.handler(args)
            self.assertFalse(decision_path.exists())
            self.assertFalse(evidence.exists())

    def test_approve_candidate_cli_accepts_v2_only_with_bound_clarity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"feed-stop-v2-source")
            source_hash = file_sha256(str(source))
            transcript = replay_backfill_transcript(
                "Boundaries protect your peace every single day",
                source_hash,
            )
            candidate_body = {
                "start_time": 0.0,
                "end_time": 11.75,
                "speech_start_time": 0.0,
                "speech_end_time": 11.5,
                "title": "Protect your peace",
                "hook_sentence": "Boundaries protect your peace.",
                "final_takeaway_sentence": "Boundaries protect your peace.",
                "candidate_text": (
                    "Boundaries protect your peace every single day"
                ),
                "content_profile": "motivational_podcast",
                "selection_profile": "bf_feed_stop_v1",
                "render_profile": "bf_editorial_inset_v2",
                "format_profile": "bf_feed_stop_format_v2",
                "selection_rank": 1,
                "rejected": False,
                "rejection_reasons": [],
                "source_cut_count": 0,
            }
            candidate_body = attach_clean_speech_report(
                candidate_body,
                source_hash,
                transcript,
            )
            candidate_body = attach_clear_spoken_report(
                candidate_body,
                source_hash,
                transcript,
            )
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            ranking = build_ranking_manifest(
                "https://example.test/feed-stop-v2-source",
                str(source),
                "motivational_podcast",
                [candidate],
                [candidate],
                profiles=resolve_profile_bundle(
                    format_profile=BF_FEED_STOP_FORMAT_V2
                ),
                source_hash=source_hash,
                transcript=transcript,
            )
            ranking_path = root / "ranking.json"
            decision_path = root / "decision.json"
            evidence = root / "evidence"
            ops.write_json(str(ranking_path), ranking)
            args = ops.build_parser().parse_args(
                [
                    "approve-candidate",
                    "--candidate-json",
                    str(ranking_path),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-07T12:00:00Z",
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(decision_path),
                ]
            )

            decision = args.handler(args)
            speech_only_body = {
                key: value
                for key, value in candidate_body.items()
                if not key.startswith("spokenClarity")
                and not key.startswith("spoken_clarity_")
            }
            invalid_cases = (
                (
                    "wrong-transcript",
                    attach_clear_spoken_report(
                        speech_only_body,
                        source_hash,
                        transcript,
                        transcript_timing_hash="f" * 64,
                    ),
                    "another transcript",
                ),
                (
                    "untrusted-provider",
                    attach_clear_spoken_report(
                        speech_only_body,
                        source_hash,
                        transcript,
                        provider_identity={"provider": "arbitrary-test"},
                    ),
                    "trusted local provider identity",
                ),
            )
            for name, invalid_body, message in invalid_cases:
                invalid_candidate = {
                    **invalid_body,
                    "candidate_hash": candidate_hash(
                        invalid_body,
                        source_hash,
                    ),
                }
                invalid_ranking = build_ranking_manifest(
                    "https://example.test/feed-stop-v2-source",
                    str(source),
                    "motivational_podcast",
                    [invalid_candidate],
                    [invalid_candidate],
                    profiles=resolve_profile_bundle(
                        format_profile=BF_FEED_STOP_FORMAT_V2
                    ),
                    source_hash=source_hash,
                    transcript=transcript,
                )
                invalid_path = root / f"{name}.json"
                ops.write_json(str(invalid_path), invalid_ranking)
                with self.subTest(name=name), self.assertRaisesRegex(
                    ArtifactBindingError,
                    message,
                ):
                    ops.candidate_from_file(
                        str(invalid_path),
                        1,
                        str(source),
                    )

        self.assertEqual(decision["formatProfile"], BF_FEED_STOP_FORMAT_V2)
        self.assertEqual(
            decision["candidate"]["spokenClarityReport"][
                "transcriptTimingHash"
            ],
            ranking["replayTranscriptManifest"]["transcriptTimingHash"],
        )

    def test_reject_candidate_cli_archives_engine_rejected_candidate_idempotently(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"rejected-source")
            source_hash = file_sha256(str(source))
            transcript = replay_backfill_transcript(
                "A weak hook with a complete but uninteresting thought",
                source_hash,
            )
            candidate_body = {
                "start_time": 0.0,
                "end_time": 11.75,
                "candidate_text": (
                    "A weak hook with a complete but uninteresting thought"
                ),
                "content_profile": "motivational_podcast",
                "selection_profile": "motivational_tension_micro_v1",
                "render_profile": "bf_editorial_inset_v1",
                "format_profile": "bf_viral_micro_v1",
                "selection_rank": 1,
                "rejected": True,
                "rejection_reasons": ["weak_hook"],
                "source_cut_count": 0,
            }
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            ranking = build_ranking_manifest(
                "https://example.test/rejected-source",
                str(source),
                "motivational_podcast",
                [candidate],
                [],
                profiles=resolve_profile_bundle(
                    format_profile=BF_VIRAL_MICRO_V1
                ),
                source_hash=source_hash,
                transcript=transcript,
            )
            ranking_path = root / "ranking.json"
            evidence = root / "evidence"
            receipt_path = root / "rejection-receipt.json"
            ops.write_json(str(ranking_path), ranking)
            args = ops.build_parser().parse_args(
                [
                    "reject-candidate",
                    "--candidate-json",
                    str(ranking_path),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-07T12:00:00Z",
                    "--reason-code",
                    "weak_hook, weak_hook",
                    "--notes",
                    "The opening does not stop the feed.",
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(receipt_path),
                ]
            )

            first_receipt = args.handler(args)
            second_receipt = args.handler(args)
            dataset = verify_replay_capture_dataset(
                ops.read_json(first_receipt["datasetPath"])
            )
            rejection = verify_replay_human_rejection(
                ops.read_json(first_receipt["rejectionPath"]),
                dataset,
            )
            positive_label_dir_exists = (evidence / "labels").exists()

        self.assertEqual(first_receipt, second_receipt)
        self.assertEqual(
            first_receipt["artifactType"],
            "BudgetFriendlyReplayHumanRejectionReceiptV1",
        )
        self.assertEqual(rejection["decision"], "rejected")
        self.assertEqual(
            rejection["labelSemantics"],
            "explicit_human_rejection",
        )
        self.assertEqual(rejection["candidateHash"], candidate["candidate_hash"])
        self.assertEqual(rejection["reasonCodes"], ["weak_hook"])
        self.assertEqual(rejection["rejectedRank"], 1)
        self.assertFalse(positive_label_dir_exists)

    def test_reject_candidate_output_collision_precedes_archive_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"collision-source")
            source_hash = file_sha256(str(source))
            text = "A complete candidate that the reviewer rejected"
            transcript = replay_backfill_transcript(text, source_hash)
            candidate_body = {
                "start_time": 0.0,
                "end_time": 11.75,
                "candidate_text": text,
                "content_profile": "motivational_podcast",
                "selection_profile": "motivational_tension_micro_v1",
                "render_profile": "bf_editorial_inset_v1",
                "format_profile": "bf_viral_micro_v1",
                "selection_rank": 1,
                "rejected": True,
                "rejection_reasons": ["weak_hook"],
                "source_cut_count": 0,
            }
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            ranking = build_ranking_manifest(
                "https://example.test/collision-source",
                str(source),
                "motivational_podcast",
                [candidate],
                [],
                profiles=resolve_profile_bundle(
                    format_profile=BF_VIRAL_MICRO_V1
                ),
                source_hash=source_hash,
                transcript=transcript,
            )
            ranking_path = root / "ranking.json"
            evidence = root / "evidence"
            receipt_path = root / "rejection-receipt.json"
            ops.write_json(str(ranking_path), ranking)
            collision = {
                "schemaVersion": 1,
                "artifactType": (
                    "BudgetFriendlyReplayHumanRejectionReceiptV1"
                ),
                "datasetHash": "a" * 64,
                "rejectionHash": "b" * 64,
                "datasetPath": "/collision/dataset.json",
                "rejectionPath": "/collision/rejection.json",
                "datasetCreated": False,
                "rejectionCreated": False,
            }
            ops.write_json(str(receipt_path), collision)
            args = ops.build_parser().parse_args(
                [
                    "reject-candidate",
                    "--candidate-json",
                    str(ranking_path),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-07T12:00:00Z",
                    "--reason-code",
                    "weak_hook",
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(receipt_path),
                ]
            )

            with patch.object(
                ops,
                "archive_rejected_candidate",
            ) as archive, self.assertRaisesRegex(
                ArtifactBindingError,
                "immutable rejection receipt collision",
            ):
                args.handler(args)

            archive.assert_not_called()
            self.assertFalse(evidence.exists())
            self.assertEqual(ops.read_json(str(receipt_path)), collision)

    def test_reject_candidate_cli_accepts_feed_stop_audio_rejection_without_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"feed-stop-rejection")
            source_hash = file_sha256(str(source))
            text = "Everybody gets a break most people waste the opportunity"
            transcript = replay_backfill_transcript(text, source_hash)
            candidate_body = {
                "start_time": 0.0,
                "end_time": 11.75,
                "speech_start_time": 0.0,
                "speech_end_time": 11.5,
                "candidate_text": text,
                "content_profile": "motivational_podcast",
                "selection_profile": "bf_feed_stop_v1",
                "render_profile": "bf_editorial_inset_v2",
                "format_profile": "bf_feed_stop_format_v1",
                "selection_rank": 1,
                "rejected": True,
                "rejection_reasons": ["repeated_audible_fillers"],
                "source_cut_count": 0,
            }
            candidate_body = attach_clean_speech_report(
                candidate_body,
                source_hash,
                transcript,
                prompted_fillers=[
                    {"start": 2.0, "end": 2.15, "text": "uh-huh"},
                    {"start": 5.0, "end": 5.15, "text": "ah"},
                ],
            )
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            ranking = build_ranking_manifest(
                "https://example.test/feed-stop-rejection",
                str(source),
                "motivational_podcast",
                [candidate],
                [],
                profiles=resolve_profile_bundle(
                    format_profile=BF_FEED_STOP_FORMAT_V1
                ),
                source_hash=source_hash,
                transcript=transcript,
            )
            ranking_path = root / "ranking.json"
            evidence = root / "evidence"
            receipt_path = root / "rejection-receipt.json"
            ops.write_json(str(ranking_path), ranking)
            args = ops.build_parser().parse_args(
                [
                    "reject-candidate",
                    "--candidate-json",
                    str(ranking_path),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-07T12:00:00Z",
                    "--reason-code",
                    "audible_backchannels",
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(receipt_path),
                ]
            )

            with patch.object(ops, "build_candidate_decision") as authority:
                receipt = args.handler(args)
            authority.assert_not_called()
            dataset = verify_replay_capture_dataset(
                ops.read_json(receipt["datasetPath"])
            )
            rejection = verify_replay_human_rejection(
                ops.read_json(receipt["rejectionPath"]),
                dataset,
                speech_cleanliness_report=candidate[
                    "speechCleanlinessReport"
                ],
            )

        self.assertEqual(rejection["candidateHash"], candidate["candidate_hash"])
        self.assertEqual(rejection["reasonCodes"], ["audible_backchannels"])
        self.assertEqual(
            rejection["evidenceRefs"]["speechCleanlinessReportHash"],
            candidate["speechCleanlinessReport"]["contentHash"],
        )
        self.assertEqual(rejection["artifactType"], "BudgetFriendlyReplayHumanRejectionV1")

    def test_reject_candidate_cli_accepts_historical_feed_stop_without_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"feed-stop-missing-audio-evidence")
            source_hash = file_sha256(str(source))
            text = "Approval is a trap choose your own standard instead"
            transcript = replay_backfill_transcript(text, source_hash)
            candidate_body = {
                "start_time": 0.0,
                "end_time": 11.75,
                "speech_start_time": 0.0,
                "speech_end_time": 11.5,
                "candidate_text": text,
                "content_profile": "motivational_podcast",
                "selection_profile": "bf_feed_stop_v1",
                "render_profile": "bf_editorial_inset_v2",
                "format_profile": "bf_feed_stop_format_v1",
                "selection_rank": 1,
                "rejected": True,
                "rejection_reasons": ["speech_cleanliness_evidence_missing"],
                "source_cut_count": 0,
            }
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            ranking = build_ranking_manifest(
                "https://example.test/feed-stop-missing-evidence",
                str(source),
                "motivational_podcast",
                [candidate],
                [],
                profiles=resolve_profile_bundle(
                    format_profile=BF_FEED_STOP_FORMAT_V1
                ),
                source_hash=source_hash,
                transcript=transcript,
            )
            ranking_path = root / "ranking.json"
            evidence = root / "evidence"
            receipt_path = root / "receipt.json"
            ops.write_json(str(ranking_path), ranking)
            args = ops.build_parser().parse_args(
                [
                    "reject-candidate",
                    "--candidate-json",
                    str(ranking_path),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-07T12:00:00Z",
                    "--reason-code",
                    "audible_backchannels",
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(receipt_path),
                ]
            )

            receipt = args.handler(args)
            dataset = verify_replay_capture_dataset(
                ops.read_json(receipt["datasetPath"])
            )
            rejection = verify_replay_human_rejection(
                ops.read_json(receipt["rejectionPath"]),
                dataset,
            )

            self.assertTrue(evidence.exists())
            self.assertTrue(receipt_path.exists())
            self.assertEqual(rejection["candidateHash"], candidate["candidate_hash"])
            self.assertNotIn("evidenceRefs", rejection)

    def test_reject_candidate_cli_fails_closed_for_present_invalid_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"feed-stop-invalid-audio-evidence")
            source_hash = file_sha256(str(source))
            text = "Approval is a trap choose your own standard instead"
            transcript = replay_backfill_transcript(text, source_hash)
            candidate_body = attach_clean_speech_report(
                {
                    "start_time": 0.0,
                    "end_time": 11.75,
                    "speech_start_time": 0.0,
                    "speech_end_time": 11.5,
                    "candidate_text": text,
                    "content_profile": "motivational_podcast",
                    "selection_profile": "bf_feed_stop_v1",
                    "render_profile": "bf_editorial_inset_v2",
                    "format_profile": "bf_feed_stop_format_v1",
                    "selection_rank": 1,
                    "rejected": True,
                    "rejection_reasons": ["weak_hook"],
                    "source_cut_count": 0,
                },
                source_hash,
                transcript,
            )
            candidate_body["speechCleanlinessReport"] = {
                **candidate_body["speechCleanlinessReport"],
                "providerStatus": "tampered",
            }
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            ranking = build_ranking_manifest(
                "https://example.test/feed-stop-invalid-evidence",
                str(source),
                "motivational_podcast",
                [candidate],
                [],
                profiles=resolve_profile_bundle(
                    format_profile=BF_FEED_STOP_FORMAT_V1
                ),
                source_hash=source_hash,
                transcript=transcript,
            )
            ranking_path = root / "ranking.json"
            evidence = root / "evidence"
            receipt_path = root / "receipt.json"
            ops.write_json(str(ranking_path), ranking)
            args = ops.build_parser().parse_args(
                [
                    "reject-candidate",
                    "--candidate-json",
                    str(ranking_path),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-07T12:00:00Z",
                    "--reason-code",
                    "weak_hook",
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(receipt_path),
                ]
            )

            with self.assertRaisesRegex(
                ArtifactBindingError,
                "contentHash does not match",
            ):
                args.handler(args)

            self.assertFalse(evidence.exists())
            self.assertFalse(receipt_path.exists())

    def test_reject_preview_archives_exact_jhh_interval_without_forging_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, preview, ranking_path, candidate_value = jhh_preview_fixture(root)
            evidence = root / "evidence"
            receipt_path = root / "preview-rejection-receipt.json"
            args = ops.build_parser().parse_args(
                [
                    "reject-preview",
                    "--ranking",
                    str(ranking_path),
                    "--source",
                    str(source),
                    "--preview",
                    str(preview),
                    "--start-ms",
                    "580920",
                    "--end-ms",
                    "603500",
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-07T12:30:00Z",
                    "--reason-code",
                    "unclear_hook,unintelligible_speech",
                    "--notes",
                    "The exact preview has an unintelligible opening.",
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(receipt_path),
                ]
            )
            provenance = passing_preview_provenance_report(
                file_sha256(str(source)),
                file_sha256(str(preview)),
                580920,
                603500,
            )

            with patch.object(
                ops,
                "_probe_review_media",
                return_value=(22589, "mp4"),
            ), patch.object(
                ops,
                "analyze_preview_source_provenance",
                return_value=provenance,
            ) as analyzer:
                first = args.handler(args)
                second = args.handler(args)

            dataset = verify_replay_capture_dataset(
                ops.read_json(first["datasetPath"])
            )
            rejection = verify_replay_human_preview_rejection(
                ops.read_json(first["rejectionPath"]),
                dataset,
                review_media_path=first["reviewMediaPath"],
            )

            self.assertEqual(first, second)
            self.assertEqual(analyzer.call_count, 2)
            self.assertEqual(
                analyzer.call_args_list[0].args,
                (
                    str(source.resolve()),
                    str(preview.resolve()),
                    file_sha256(str(source)),
                    file_sha256(str(preview)),
                    580920,
                    603500,
                ),
            )
            self.assertEqual(
                first["previewSourceProvenanceHash"],
                provenance["contentHash"],
            )
            self.assertEqual(
                first["artifactType"],
                "BudgetFriendlyReplayHumanPreviewRejectionReceiptV1",
            )
            self.assertEqual(
                rejection["sourceIntervalMs"],
                {"startMs": 580920, "endMs": 603500},
            )
            self.assertEqual(
                rejection["reviewMedia"]["sha256"],
                file_sha256(str(preview)),
            )
            self.assertEqual(
                rejection["reasonCodes"],
                ["unclear_hook", "unintelligible_speech"],
            )
            self.assertNotIn("candidateHash", rejection)
            self.assertNotEqual(
                rejection["sourceIntervalMs"]["endMs"],
                round(candidate_value["speech_end_time"] * 1000),
            )
            self.assertFalse((evidence / "labels").exists())
            self.assertTrue(Path(first["reviewMediaPath"]).is_file())

    def test_reject_preview_preserves_8g_file_boundary_not_candidate_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, preview, ranking_path, candidate_value = eight_g_preview_fixture(
                root
            )
            evidence = root / "evidence"
            receipt_path = root / "preview-rejection-receipt.json"
            args = ops.build_parser().parse_args(
                [
                    "reject-preview",
                    "--ranking",
                    str(ranking_path),
                    "--source",
                    str(source),
                    "--preview",
                    str(preview),
                    "--start-ms",
                    "126479",
                    "--end-ms",
                    "149480",
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-07T12:31:00Z",
                    "--reason-code",
                    "unclear_hook,unclear_point",
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(receipt_path),
                ]
            )
            provenance = passing_preview_provenance_report(
                file_sha256(str(source)),
                file_sha256(str(preview)),
                126479,
                149480,
            )

            with patch.object(
                ops,
                "_probe_review_media",
                return_value=(23023, "mp4"),
            ), patch.object(
                ops,
                "analyze_preview_source_provenance",
                return_value=provenance,
            ):
                receipt = args.handler(args)
            dataset = verify_replay_capture_dataset(
                ops.read_json(receipt["datasetPath"])
            )
            rejection = verify_replay_human_preview_rejection(
                ops.read_json(receipt["rejectionPath"]),
                dataset,
                review_media_path=receipt["reviewMediaPath"],
            )

        self.assertEqual(
            rejection["sourceIntervalMs"],
            {"startMs": 126479, "endMs": 149480},
        )
        self.assertNotEqual(
            rejection["sourceIntervalMs"]["endMs"],
            round(candidate_value["end_time"] * 1000),
        )
        self.assertNotIn("candidateHash", rejection)

    def test_reject_preview_collision_and_bad_duration_precede_archive_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, preview, ranking_path, _ = jhh_preview_fixture(root)
            evidence = root / "evidence"
            receipt_path = root / "preview-rejection-receipt.json"
            args = ops.build_parser().parse_args(
                [
                    "reject-preview",
                    "--ranking",
                    str(ranking_path),
                    "--source",
                    str(source),
                    "--preview",
                    str(preview),
                    "--start-ms",
                    "580920",
                    "--end-ms",
                    "603500",
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-07T12:30:00Z",
                    "--reason-code",
                    "unclear_hook",
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(receipt_path),
                ]
            )
            collision = {
                "schemaVersion": 1,
                "artifactType": (
                    "BudgetFriendlyReplayHumanPreviewRejectionReceiptV1"
                ),
                "datasetHash": "a" * 64,
                "rejectionHash": "b" * 64,
                "reviewMediaHash": "c" * 64,
                "datasetPath": "/collision/dataset.json",
                "rejectionPath": "/collision/rejection.json",
                "reviewMediaPath": "/collision/review.mp4",
                "datasetCreated": False,
                "rejectionCreated": False,
                "reviewMediaCreated": False,
            }
            ops.write_json(str(receipt_path), collision)
            provenance = passing_preview_provenance_report(
                file_sha256(str(source)),
                file_sha256(str(preview)),
                580920,
                603500,
            )

            with patch.object(
                ops,
                "_probe_review_media",
                return_value=(22589, "mp4"),
            ), patch.object(
                ops,
                "analyze_preview_source_provenance",
                return_value=provenance,
            ), patch.object(ops, "archive_rejected_preview") as archive, self.assertRaisesRegex(
                ArtifactBindingError,
                "immutable preview rejection receipt collision",
            ):
                args.handler(args)
            archive.assert_not_called()
            self.assertFalse(evidence.exists())

            receipt_path.unlink()
            with patch.object(
                ops,
                "_probe_review_media",
                return_value=(21000, "mp4"),
            ), patch.object(ops, "archive_rejected_preview") as archive, self.assertRaisesRegex(
                ArtifactBindingError,
                "does not match the exact source interval",
            ):
                args.handler(args)
            archive.assert_not_called()
            self.assertFalse(evidence.exists())

    def test_reject_preview_uses_integer_millisecond_contract(self):
        self.assertEqual(ops._nonnegative_milliseconds("580920"), 580920)
        for value in ("580.920", "-1", "1e3", ""):
            with self.subTest(value=value), self.assertRaises(
                argparse.ArgumentTypeError
            ):
                ops._nonnegative_milliseconds(value)

    def test_rejection_candidate_resolution_rejects_stale_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"bound-source")
            other_source = root / "other.mp4"
            other_source.write_bytes(b"other-source")
            source_hash = file_sha256(str(source))
            text = "One exact candidate with a complete thought"
            transcript = replay_backfill_transcript(text, source_hash)
            candidate_body = {
                "start_time": 0.0,
                "end_time": 11.75,
                "candidate_text": text,
                "content_profile": "motivational_podcast",
                "selection_profile": "motivational_tension_micro_v1",
                "render_profile": "bf_editorial_inset_v1",
                "format_profile": "bf_viral_micro_v1",
                "selection_rank": 1,
                "rejected": True,
                "rejection_reasons": ["weak_hook"],
                "source_cut_count": 0,
            }
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            valid_ranking = build_ranking_manifest(
                "https://example.test/bound-source",
                str(source),
                "motivational_podcast",
                [candidate],
                [],
                profiles=resolve_profile_bundle(
                    format_profile=BF_VIRAL_MICRO_V1
                ),
                source_hash=source_hash,
                transcript=transcript,
            )
            stale_candidate = {
                **candidate,
                "candidate_hash": "f" * 64,
            }
            stale_hash_ranking = build_ranking_manifest(
                "https://example.test/bound-source",
                str(source),
                "motivational_podcast",
                [stale_candidate],
                [],
                profiles=resolve_profile_bundle(
                    format_profile=BF_VIRAL_MICRO_V1
                ),
                source_hash=source_hash,
                transcript=transcript,
            )
            missing_transcript_ranking = build_ranking_manifest(
                "https://example.test/bound-source",
                str(source),
                "motivational_podcast",
                [candidate],
                [],
                profiles=resolve_profile_bundle(
                    format_profile=BF_VIRAL_MICRO_V1
                ),
                source_hash=source_hash,
            )
            unapproved_profile_ranking = build_ranking_manifest(
                "https://example.test/bound-source",
                str(source),
                "motivational_podcast",
                [candidate],
                [],
                profiles=resolve_profile_bundle(format_profile=BF_GROWTH_V2),
                source_hash=source_hash,
                transcript=transcript,
            )
            cases = (
                (
                    "wrong-source",
                    valid_ranking,
                    other_source,
                    "not bound to the supplied source",
                ),
                (
                    "stale-candidate",
                    stale_hash_ranking,
                    source,
                    "candidate hash is stale",
                ),
                (
                    "missing-transcript",
                    missing_transcript_ranking,
                    source,
                    "lacks a replay transcript manifest",
                ),
                (
                    "unapproved-profile",
                    unapproved_profile_ranking,
                    source,
                    "does not freeze an approved review profile",
                ),
            )
            for name, ranking, supplied_source, message in cases:
                with self.subTest(name=name):
                    ranking_path = root / f"{name}.json"
                    ops.write_json(str(ranking_path), ranking)
                    with self.assertRaisesRegex(ArtifactBindingError, message):
                        ops.rejection_candidate_from_file(
                            str(ranking_path),
                            1,
                            str(supplied_source),
                        )

    def test_feed_stop_candidate_from_file_binds_cleanliness_to_replay_transcript(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"feed-stop-binding")
            source_hash = file_sha256(str(source))
            text = "Approval is a trap choose your standard instead"
            transcript = replay_backfill_transcript(text, source_hash)
            base = {
                "start_time": 0.0,
                "end_time": 11.75,
                "speech_start_time": 0.0,
                "speech_end_time": 11.5,
                "title": "Stop seeking approval",
                "candidate_text": text,
                "content_profile": "motivational_podcast",
                "selection_profile": "bf_feed_stop_v1",
                "render_profile": "bf_editorial_inset_v2",
                "format_profile": "bf_feed_stop_format_v1",
                "selection_rank": 1,
                "rejected": False,
                "rejection_reasons": [],
                "source_cut_count": 0,
            }
            mismatched = attach_clean_speech_report(
                base,
                source_hash,
                transcript,
                transcript_timing_hash="f" * 64,
            )
            tampered = attach_clean_speech_report(
                base,
                source_hash,
                transcript,
            )
            tampered["speechCleanlinessReport"] = {
                **tampered["speechCleanlinessReport"],
                "providerStatus": "tampered",
            }
            cases = (
                (
                    "missing",
                    base,
                    "lacks a speech-cleanliness report",
                ),
                (
                    "transcript-mismatch",
                    mismatched,
                    "another transcript",
                ),
                (
                    "tampered-report",
                    tampered,
                    "contentHash does not match",
                ),
            )
            for name, candidate_body, message in cases:
                with self.subTest(name=name):
                    candidate = {
                        **candidate_body,
                        "candidate_hash": candidate_hash(
                            candidate_body,
                            source_hash,
                        ),
                    }
                    ranking = build_ranking_manifest(
                        "https://example.test/feed-stop-binding",
                        str(source),
                        "motivational_podcast",
                        [candidate],
                        [candidate],
                        profiles=resolve_profile_bundle(
                            format_profile=BF_FEED_STOP_FORMAT_V1
                        ),
                        source_hash=source_hash,
                        transcript=transcript,
                    )
                    ranking_path = root / f"{name}.json"
                    ops.write_json(str(ranking_path), ranking)
                    with self.assertRaisesRegex(ArtifactBindingError, message):
                        ops.candidate_from_file(
                            str(ranking_path),
                            1,
                            str(source),
                        )

    def test_approve_rejects_unallowlisted_and_mixed_profile_contracts(self):
        cases = (
            (BF_GROWTH_V2, BF_GROWTH_V2),
            (BF_FEED_STOP_FORMAT_V1, BF_VIRAL_MICRO_V1),
        )
        for ranking_format, candidate_format in cases:
            with self.subTest(
                ranking_format=ranking_format,
                candidate_format=candidate_format,
            ), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "source.mp4"
                source.write_bytes(b"profile-source")
                source_hash = file_sha256(str(source))
                candidate_bundle = resolve_profile_bundle(
                    format_profile=candidate_format
                )
                candidate_body = {
                    "start_time": 0.0,
                    "end_time": 11.75,
                    "candidate_text": "One complete review candidate",
                    "content_profile": candidate_bundle["content_profile"],
                    "selection_profile": candidate_bundle["selection_profile"],
                    "render_profile": candidate_bundle["render_profile"],
                    "format_profile": candidate_bundle["format_profile"],
                    "selection_rank": 1,
                    "rejected": False,
                    "rejection_reasons": [],
                    "source_cut_count": 0,
                }
                candidate = {
                    **candidate_body,
                    "candidate_hash": candidate_hash(
                        candidate_body,
                        source_hash,
                    ),
                }
                ranking = build_ranking_manifest(
                    "https://example.test/profile-source",
                    str(source),
                    "motivational_podcast",
                    [candidate],
                    [],
                    profiles=resolve_profile_bundle(
                        format_profile=ranking_format
                    ),
                    source_hash=source_hash,
                    transcript=replay_backfill_transcript(
                        "One complete review candidate",
                        source_hash,
                    ),
                )
                ranking_path = root / "ranking.json"
                output = root / "decision.json"
                evidence = root / "evidence"
                ops.write_json(str(ranking_path), ranking)
                args = ops.build_parser().parse_args(
                    [
                        "approve-candidate",
                        "--candidate-json",
                        str(ranking_path),
                        "--rank",
                        "1",
                        "--source",
                        str(source),
                        "--reviewer",
                        "operator_1",
                        "--decided-at",
                        "2026-08-07T12:00:00Z",
                        "--evidence-dir",
                        str(evidence),
                        "--output",
                        str(output),
                    ]
                )

                with self.assertRaises(ArtifactBindingError):
                    args.handler(args)
                self.assertFalse(output.exists())
                self.assertFalse(evidence.exists())

    def test_approve_rejects_legacy_unsealed_candidate_json(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"source")
            legacy = Path(directory) / "candidate.json"
            ops.write_json(
                str(legacy),
                {"start_time": 1.0, "end_time": 11.75, "title": "Legacy"},
            )
            args = ops.build_parser().parse_args(
                [
                    "approve-candidate",
                    "--candidate-json",
                    str(legacy),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-07-16T12:00:00Z",
                    "--output",
                    str(Path(directory) / "decision.json"),
                ]
            )
            with self.assertRaisesRegex(ValueError, "expected RankingManifest"):
                args.handler(args)

    def test_approve_output_cannot_overwrite_append_only_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / "evidence"
            immutable = evidence / "datasets" / "immutable.json"
            immutable.parent.mkdir(parents=True)
            immutable.write_text('{"sealed":true}\n', encoding="utf-8")
            args = ops.build_parser().parse_args(
                [
                    "approve-candidate",
                    "--candidate-json",
                    str(root / "ranking.json"),
                    "--rank",
                    "1",
                    "--source",
                    str(root / "source.mp4"),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-06T12:00:00Z",
                    "--evidence-dir",
                    str(evidence),
                    "--output",
                    str(immutable),
                ]
            )

            with self.assertRaisesRegex(ValueError, "outside the append-only"):
                args.handler(args)

            self.assertEqual(
                immutable.read_text(encoding="utf-8"),
                '{"sealed":true}\n',
            )

    def test_approve_rejects_ranking_without_bound_transcript_before_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            source_hash = file_sha256(str(source))
            candidate_body = {
                "start_time": 1.0,
                "end_time": 11.75,
                "candidate_text": "A complete approved thought.",
                "content_profile": "motivational_podcast",
                "selection_profile": "motivational_tension_micro_v1",
                "render_profile": "bf_editorial_inset_v1",
                "format_profile": "bf_viral_micro_v1",
                "selection_rank": 1,
                "rejected": False,
                "rejection_reasons": [],
                "source_cut_count": 0,
            }
            candidate = {
                **candidate_body,
                "candidate_hash": candidate_hash(candidate_body, source_hash),
            }
            ranking = build_ranking_manifest(
                "https://example.test/source",
                str(source),
                "motivational_podcast",
                [candidate],
                [],
                profiles=resolve_profile_bundle(format_profile=BF_VIRAL_MICRO_V1),
                source_hash=source_hash,
            )
            ranking_path = root / "ranking.json"
            output = root / "decision.json"
            ops.write_json(str(ranking_path), ranking)
            args = ops.build_parser().parse_args(
                [
                    "approve-candidate",
                    "--candidate-json",
                    str(ranking_path),
                    "--rank",
                    "1",
                    "--source",
                    str(source),
                    "--reviewer",
                    "operator_1",
                    "--decided-at",
                    "2026-08-06T12:00:00Z",
                    "--evidence-dir",
                    str(root / "evidence"),
                    "--output",
                    str(output),
                ]
            )

            with self.assertRaisesRegex(ValueError, "artifact must be an object"):
                args.handler(args)
            self.assertFalse(output.exists())
            self.assertFalse((root / "evidence").exists())

    def test_originality_rejects_tampered_candidate_decision(self):
        source_hash = "a" * 64
        candidate_body = {
            "start_time": 1.0,
            "end_time": 11.75,
            "hook_sentence": "A tested tension hook.",
            "candidate_text": "A tested tension hook with a complete takeaway.",
            "content_profile": "motivational_podcast",
            "selection_profile": "motivational_tension_micro_v1",
            "render_profile": "bf_editorial_inset_v1",
            "format_profile": "bf_viral_micro_v1",
            "rejected": False,
            "rejection_reasons": [],
        }
        candidate = {
            **candidate_body,
            "candidate_hash": candidate_hash(candidate_body, source_hash),
        }
        decision = ops.build_candidate_decision(
            candidate,
            source_hash,
            reviewer="operator_1",
            decided_at="2026-07-16T12:00:00Z",
            ranking_manifest_hash="d" * 64,
        )
        documents = {
            "decision.json": {**decision, "sourceHash": "b" * 64},
            "recent.json": {"publications": []},
        }
        args = SimpleNamespace(
            candidate_decision="decision.json",
            recent_publications="recent.json",
            output="originality.json",
        )
        with patch.object(
            ops,
            "read_json",
            side_effect=lambda path: documents[path],
        ):
            with self.assertRaisesRegex(ValueError, "contentHash does not match"):
                ops.command_originality(args)

    def test_rights_cli_persists_required_attribution_text(self):
        attribution = "Source: Example Podcast, used with permission."
        args = ops.build_parser().parse_args(
            [
                "rights",
                "--candidate-decision",
                "decision.json",
                "--status",
                "licensed",
                "--owner",
                "Example Podcast",
                "--evidence-reference",
                "license-001",
                "--music-license",
                "music-license-001",
                "--font-license",
                "font-license-001",
                "--attribution-text",
                attribution,
                "--output",
                "rights.json",
            ]
        )
        with patch.object(
            ops,
            "read_json",
            return_value={"sourceHash": "a" * 64},
        ), patch.object(ops, "write_json") as write_json:
            rights = args.handler(args)

        self.assertEqual(rights["attributionText"], attribution)
        write_json.assert_called_once_with("rights.json", rights)

    def test_publish_plan_passes_audio_qa_report_from_production_bundle(self):
        render = {"artifactType": "RenderManifest"}
        creative_qa = {"artifactType": "CreativeQaReport"}
        experiment = {"artifactType": "ExperimentManifest"}
        audio_qa = {"artifactType": "AudioQaReport"}
        bundle = {
            "candidateDecision": {"artifactType": "CandidateDecision"},
            "renderManifest": render,
            "creativeQaReport": creative_qa,
            "experimentManifest": experiment,
            "audioQaReport": audio_qa,
        }
        rights = {"artifactType": "SourceRightsManifest"}
        originality = {"artifactType": "OriginalityReport"}
        metadata = {"title": "Title", "description": "Description"}
        manifest = {"artifactType": "PublishManifest"}
        documents = {
            "bundle.json": bundle,
            "metadata.json": metadata,
            "rights.json": rights,
            "originality.json": originality,
        }
        args = SimpleNamespace(
            production_bundle="bundle.json",
            metadata="metadata.json",
            rights="rights.json",
            originality="originality.json",
            privacy="private",
            related_video_id=None,
            related_video_waiver="first episode",
            output="publish.json",
        )

        with patch.object(
            ops,
            "read_json",
            side_effect=lambda path: documents[path],
        ), patch.object(
            ops,
            "build_publish_manifest",
            return_value=manifest,
        ) as build_publish, patch.object(ops, "write_json") as write_json:
            result = ops.command_publish_plan(args)

        self.assertIs(result, manifest)
        self.assertIs(build_publish.call_args.kwargs["audio_qa_report"], audio_qa)
        write_json.assert_called_once_with("publish.json", manifest)

    def test_publish_rejects_stale_render_before_youtube_authentication(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "short.mp4"
            output.write_bytes(b"render")
            render_payload = {
                "schemaVersion": 1,
                "artifactType": "RenderManifest",
                "outputPath": str(output),
                "outputHash": file_sha256(str(output)),
            }
            render = {**render_payload, "contentHash": content_hash(render_payload)}
            publish_payload = {
                "schemaVersion": 1,
                "artifactType": "PublishManifest",
                "renderManifestHash": "f" * 64,
                "renderOutputHash": render["outputHash"],
                "privacyStatus": "private",
            }
            publish = {
                **publish_payload,
                "contentHash": content_hash(publish_payload),
            }
            args = SimpleNamespace(
                publish_manifest="publish.json",
                render_manifest="render.json",
                client_secrets=None,
                token_file=None,
                expected_channel_id="channel",
                receipt_store="receipts.json",
                confirm_public=False,
            )
            documents = {"publish.json": publish, "render.json": render}
            with patch.object(
                ops,
                "read_json",
                side_effect=lambda path: documents[path],
            ), patch.object(
                youtube_uploader_module,
                "get_authenticated_service",
            ) as authenticate:
                with self.assertRaisesRegex(ValueError, "another render"):
                    ops.command_publish(args)
                authenticate.assert_not_called()

    def test_release_requires_explicit_confirmation_before_authentication(self):
        args = ops.build_parser().parse_args(
            [
                "release",
                "--youtube-video-id",
                "video-123",
                "--receipt-store",
                "receipts.json",
                "--expected-channel-id",
                "channel-123",
            ]
        )
        with patch.object(
            youtube_uploader_module,
            "get_authenticated_service",
        ) as authenticate:
            with self.assertRaisesRegex(ValueError, "requires --confirm-public"):
                args.handler(args)
            authenticate.assert_not_called()

    def test_release_cli_updates_bound_video_without_uploading_again(self):
        with tempfile.TemporaryDirectory() as directory:
            store_path = str(Path(directory) / "receipts.json")
            receipt_payload = {
                "schemaVersion": 1,
                "artifactType": "PublishReceipt",
                "idempotencyKey": "a" * 64,
                "renderOutputHash": "b" * 64,
                "channelId": "channel-123",
                "youtubeVideoId": "video-123",
                "privacyStatus": "private",
                "responseState": "uploaded",
            }
            receipt = {
                **receipt_payload,
                "contentHash": content_hash(receipt_payload),
            }
            PublishReceiptStore(store_path).save(receipt)
            args = ops.build_parser().parse_args(
                [
                    "release",
                    "--youtube-video-id",
                    "video-123",
                    "--receipt-store",
                    store_path,
                    "--expected-channel-id",
                    "channel-123",
                    "--confirm-public",
                ]
            )
            youtube = object()
            with patch.object(
                youtube_uploader_module,
                "get_authenticated_service",
                return_value=youtube,
            ), patch.object(
                youtube_uploader_module,
                "verify_authenticated_channel",
                return_value={"id": "channel-123"},
            ) as verify_channel, patch.object(
                youtube_uploader_module,
                "update_video_privacy",
                return_value={
                    "video_id": "video-123",
                    "privacy_status": "public",
                },
            ) as update_privacy, patch.object(
                youtube_uploader_module,
                "upload_video",
            ) as upload_video:
                release = args.handler(args)

        self.assertEqual(release["responseState"], "released")
        verify_channel.assert_called_once_with(
            youtube,
            expected_channel_id="channel-123",
        )
        update_privacy.assert_called_once_with(youtube, "video-123", "public")
        upload_video.assert_not_called()


if __name__ == "__main__":
    unittest.main()
