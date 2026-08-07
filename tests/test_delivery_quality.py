import copy
import math
import struct
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from shorts_generator.artifact_contracts import (
    ArtifactBindingError,
    content_hash,
    transcript_timing_hash,
)
from shorts_generator.delivery_quality import (
    DELIVERY_QUALITY_ACOUSTIC_PROVIDER,
    DELIVERY_QUALITY_ANALYZER_VERSION,
    DELIVERY_QUALITY_DECISION_VERSION,
    DELIVERY_QUALITY_REPORT_TYPE,
    DELIVERY_QUALITY_SAMPLE_RATE,
    evaluate_delivery_quality_evidence,
    verify_delivery_quality_report,
)
from shorts_generator.local.delivery_quality import (
    _decode_interval_mono_16k,
    _rms_dynamics,
    analyze_motivational_delivery_quality,
)
from shorts_generator.ranker import _delivery_quality_gate_reasons
from shorts_generator.spoken_clarity import evaluate_spoken_clarity_evidence


SOURCE_HASH = "c" * 64


def timed_words(text, start=10.0, step=0.35, word_seconds=0.22):
    output = []
    cursor = start
    for token in text.split():
        output.append(
            {
                "text": token,
                "start": cursor,
                "end": cursor + word_seconds,
                "segmentIndex": 0,
            }
        )
        cursor += step
    return output


def opening_asr(words, speech_start):
    opening_words = [
        word for word in words if float(word["start"]) < speech_start + 2.0
    ]
    return [
        {
            "text": word["text"],
            "start": speech_start + index * 0.18,
            "end": speech_start + index * 0.18 + 0.13,
            "confidence": 0.95,
        }
        for index, word in enumerate(opening_words)
        if speech_start + index * 0.18 + 0.13 <= speech_start + 2.0
    ]


def acoustic(duration, **overrides):
    values = {
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
    values.update(overrides)
    return values


class DeliveryQualityDecisionTests(unittest.TestCase):
    def fixture(
        self,
        *,
        text="Don't let criticism choose your life because boundaries protect your peace today",
        speech_start=10.0,
        speech_end=15.0,
        step=0.35,
        point="criticism choose your life",
        provider_status="ok",
        acoustic_overrides=None,
    ):
        words = timed_words(text, start=speech_start, step=step)
        transcript = {
            "duration": speech_end + 1.0,
            "segments": [
                {
                    "start": speech_start,
                    "end": words[-1]["end"],
                    "text": text,
                    "words": [
                        {"word": item["text"], "start": item["start"], "end": item["end"]}
                        for item in words
                    ],
                }
            ],
        }
        transcript_hash = transcript_timing_hash(transcript)
        clarity = evaluate_spoken_clarity_evidence(
            source_hash=SOURCE_HASH,
            transcript_timing_hash=transcript_hash,
            speech_start=speech_start,
            speech_end=speech_end,
            reference_words=words,
            point_exact_quote=point,
            opening_asr_words=opening_asr(words, speech_start),
            provider_status="ok",
            provider_identity={"provider": "clarity-fixture-v1"},
        )
        measurements = acoustic(
            speech_end - speech_start,
            **(acoustic_overrides or {}),
        )
        report = evaluate_delivery_quality_evidence(
            source_hash=SOURCE_HASH,
            transcript_timing_hash=transcript_hash,
            speech_start=speech_start,
            speech_end=speech_end,
            timed_words=words,
            spoken_clarity_report=clarity,
            acoustic_measurements=measurements,
            provider_status=provider_status,
            provider_identity={
                "analyzerVersion": DELIVERY_QUALITY_ANALYZER_VERSION,
                "acousticProvider": DELIVERY_QUALITY_ACOUSTIC_PROVIDER,
            },
        )
        return report, clarity, words, transcript

    def test_clean_delivery_passes_and_is_exactly_bound(self):
        report, _clarity, _words, transcript = self.fixture()

        self.assertEqual(report["artifactType"], DELIVERY_QUALITY_REPORT_TYPE)
        self.assertEqual(report["decisionVersion"], DELIVERY_QUALITY_DECISION_VERSION)
        self.assertEqual(report["analyzerVersion"], DELIVERY_QUALITY_ANALYZER_VERSION)
        self.assertEqual(report["status"], "pass")
        self.assertTrue(report["eligible"])
        self.assertGreater(report["deliveryStrength"], 80.0)
        self.assertFalse(report["audioHandling"]["sourceAudioModified"])
        self.assertFalse(report["audioHandling"]["affectInferenceUsed"])
        self.assertFalse(report["audioHandling"]["confidenceOrEmotionInferred"])
        self.assertIs(
            verify_delivery_quality_report(
                report,
                source_hash=SOURCE_HASH,
                transcript_timing_hash=transcript_timing_hash(transcript),
                speech_interval=(10.0, 15.0),
                require_pass=True,
            ),
            report,
        )

    def test_calm_even_delivery_is_not_rejected_by_dynamics_alone(self):
        report, _clarity, _words, _transcript = self.fixture(
            acoustic_overrides={"rmsDynamicRangeDb": 0.5}
        )

        self.assertEqual(report["status"], "pass")
        self.assertIn(
            "dynamics:very_low_rms_variation",
            report["deliveryStrengthSignals"]["severe"],
        )
        self.assertEqual(
            report["deliveryStrengthSignals"]["corroboratingCategories"],
            ["dynamics"],
        )

    def test_very_low_strength_reject_requires_corroboration(self):
        text = "Don't let criticism choose your life because boundaries protect your peace"
        report, _clarity, _words, _transcript = self.fixture(
            text=text,
            speech_end=12.0,
            step=0.17,
            acoustic_overrides={
                "overallRmsDbfs": -60.0,
                "peakDbfs": -40.0,
                "activeFrameRatio": 0.05,
                "activeFrameThresholdDbfs": -55.0,
                "rmsDynamicRangeDb": 0.5,
                "crestFactorDb": 20.0,
            },
        )

        self.assertLess(report["deliveryStrength"], 50.0)
        self.assertGreaterEqual(
            len(report["deliveryStrengthSignals"]["corroboratingCategories"]),
            2,
        )
        self.assertEqual(report["status"], "reject")
        self.assertIn(
            "delivery_quality_very_low_strength_corroborated",
            report["rejectionReasons"],
        )

    def test_borderline_multiple_signals_review(self):
        report, _clarity, _words, _transcript = self.fixture(
            speech_end=12.2,
            step=0.18,
            acoustic_overrides={"rmsDynamicRangeDb": 1.5},
        )

        self.assertLess(report["deliveryStrength"], 65.0)
        self.assertEqual(report["status"], "review")
        self.assertIn(
            "delivery_quality_borderline_strength", report["reviewReasons"]
        )

    def test_spoken_clarity_asr_failure_is_preserved(self):
        report, clarity, words, transcript = self.fixture()
        bad_asr = copy.deepcopy(clarity["inputs"]["openingAsrWords"])
        for item in bad_asr:
            item["confidence"] = 0.30
        rejected_clarity = evaluate_spoken_clarity_evidence(
            source_hash=SOURCE_HASH,
            transcript_timing_hash=transcript_timing_hash(transcript),
            speech_start=10.0,
            speech_end=15.0,
            reference_words=words,
            point_exact_quote="criticism choose your life",
            opening_asr_words=bad_asr,
            provider_identity={"provider": "clarity-fixture-v1"},
        )

        rejected = evaluate_delivery_quality_evidence(
            source_hash=SOURCE_HASH,
            transcript_timing_hash=transcript_timing_hash(transcript),
            speech_start=10.0,
            speech_end=15.0,
            timed_words=words,
            spoken_clarity_report=rejected_clarity,
            acoustic_measurements=report["inputs"]["acousticMeasurements"],
            provider_identity={"provider": "delivery-fixture-v1"},
        )
        self.assertEqual(rejected["status"], "reject")
        self.assertIn(
            "spoken_clarity_opening_asr_severely_unclear",
            rejected["rejectionReasons"],
        )

    def test_semantic_clarity_reason_is_not_mislabeled_as_delivery(self):
        report, clarity, words, transcript = self.fixture()
        semantic_only = evaluate_spoken_clarity_evidence(
            source_hash=SOURCE_HASH,
            transcript_timing_hash=transcript_timing_hash(transcript),
            speech_start=10.0,
            speech_end=15.0,
            reference_words=words,
            point_exact_quote="missing invented quote",
            opening_asr_words=clarity["inputs"]["openingAsrWords"],
            provider_identity={"provider": "clarity-fixture-v1"},
        )
        delivery = evaluate_delivery_quality_evidence(
            source_hash=SOURCE_HASH,
            transcript_timing_hash=transcript_timing_hash(transcript),
            speech_start=10.0,
            speech_end=15.0,
            timed_words=words,
            spoken_clarity_report=semantic_only,
            acoustic_measurements=report["inputs"]["acousticMeasurements"],
            provider_identity={"provider": "delivery-fixture-v1"},
        )

        self.assertEqual(delivery["status"], "pass")
        self.assertIn(
            "spoken_clarity_point_quote_unaligned",
            delivery["evidence"]["spokenClarity"]["nonDeliveryReasons"],
        )

    def test_missing_provider_or_decode_is_review_not_reject(self):
        report, clarity, words, transcript = self.fixture()
        missing = {
            "available": False,
            "sampleRate": DELIVERY_QUALITY_SAMPLE_RATE,
            "sampleCount": 0,
            "frameCount": 0,
            "frameWindowMilliseconds": None,
            "overallRmsDbfs": None,
            "peakDbfs": None,
            "activeFrameRatio": None,
            "activeFrameThresholdDbfs": None,
            "rmsDynamicRangeDb": None,
            "crestFactorDb": None,
        }
        reviewed = evaluate_delivery_quality_evidence(
            source_hash=SOURCE_HASH,
            transcript_timing_hash=transcript_timing_hash(transcript),
            speech_start=10.0,
            speech_end=15.0,
            timed_words=words,
            spoken_clarity_report=clarity,
            acoustic_measurements=missing,
            provider_status="audio_decode_error",
            provider_identity={"provider": "delivery-fixture-v1"},
        )

        self.assertEqual(reviewed["status"], "review")
        self.assertEqual(reviewed["rejectionReasons"], [])
        self.assertIn("delivery_quality_provider_not_ok", reviewed["reviewReasons"])
        self.assertIn(
            "delivery_quality_acoustic_evidence_missing", reviewed["reviewReasons"]
        )

    def test_timed_words_must_match_verified_spoken_clarity(self):
        report, clarity, words, transcript = self.fixture()
        changed = copy.deepcopy(words)
        changed[0]["text"] = "Changed"
        with self.assertRaisesRegex(ArtifactBindingError, "disagree"):
            evaluate_delivery_quality_evidence(
                source_hash=SOURCE_HASH,
                transcript_timing_hash=transcript_timing_hash(transcript),
                speech_start=10.0,
                speech_end=15.0,
                timed_words=changed,
                spoken_clarity_report=clarity,
                acoustic_measurements=report["inputs"]["acousticMeasurements"],
                provider_identity={"provider": "delivery-fixture-v1"},
            )

    def test_acoustic_sample_count_must_cover_exact_interval(self):
        report, clarity, words, transcript = self.fixture()
        bad = copy.deepcopy(report["inputs"]["acousticMeasurements"])
        bad["sampleCount"] -= DELIVERY_QUALITY_SAMPLE_RATE
        with self.assertRaisesRegex(ArtifactBindingError, "exact speech interval"):
            evaluate_delivery_quality_evidence(
                source_hash=SOURCE_HASH,
                transcript_timing_hash=transcript_timing_hash(transcript),
                speech_start=10.0,
                speech_end=15.0,
                timed_words=words,
                spoken_clarity_report=clarity,
                acoustic_measurements=bad,
                provider_identity={"provider": "delivery-fixture-v1"},
            )

    def test_tampering_and_stale_bindings_fail(self):
        report, _clarity, _words, transcript = self.fixture()
        tampered = copy.deepcopy(report)
        tampered["deliveryStrength"] = 0.0
        tampered["contentHash"] = content_hash(tampered)
        with self.assertRaisesRegex(ArtifactBindingError, "not canonical"):
            verify_delivery_quality_report(tampered)
        with self.assertRaisesRegex(ArtifactBindingError, "interval is stale"):
            verify_delivery_quality_report(
                report,
                transcript_timing_hash=transcript_timing_hash(transcript),
                speech_interval=(10.0, 15.1),
            )

    def test_rank_boundary_requires_report_and_exact_aliases(self):
        report, _clarity, _words, transcript = self.fixture()
        candidate = {
            "start_time": 10.0,
            "end_time": 15.0,
            "speech_start_time": 10.0,
            "speech_end_time": 15.0,
            "deliveryQualityReport": report,
            "deliveryQualityStatus": report["status"],
            "deliveryQualityEligible": report["eligible"],
            "deliveryQualityStrength": report["deliveryStrength"],
            "deliveryQualityRejectionReasons": report["rejectionReasons"],
            "deliveryQualityReviewReasons": report["reviewReasons"],
            "delivery_quality_decision_version": report["decisionVersion"],
            "delivery_quality_status": report["status"],
            "delivery_quality_eligible": report["eligible"],
            "delivery_quality_strength": report["deliveryStrength"],
            "delivery_quality_reject_reasons": report["rejectionReasons"],
            "delivery_quality_review_reasons": report["reviewReasons"],
            "delivery_quality_provider_status": report["providerStatus"],
        }
        provider = report["providerIdentity"]

        self.assertEqual(
            _delivery_quality_gate_reasons(
                candidate,
                transcript,
                expected_version=DELIVERY_QUALITY_DECISION_VERSION,
                expected_provider_identity=provider,
                expected_source_hash=SOURCE_HASH,
            ),
            [],
        )
        missing = dict(candidate)
        missing.pop("deliveryQualityReport")
        self.assertEqual(
            _delivery_quality_gate_reasons(
                missing,
                transcript,
                expected_version=DELIVERY_QUALITY_DECISION_VERSION,
                expected_provider_identity=provider,
                expected_source_hash=SOURCE_HASH,
            ),
            ["delivery_quality_evidence_missing"],
        )
        aliased = dict(candidate)
        aliased["delivery_quality_strength"] = -1.0
        self.assertIn(
            "delivery_quality_report_alias_mismatch",
            _delivery_quality_gate_reasons(
                aliased,
                transcript,
                expected_version=DELIVERY_QUALITY_DECISION_VERSION,
                expected_provider_identity=provider,
                expected_source_hash=SOURCE_HASH,
            ),
        )

        self.assertEqual(
            _delivery_quality_gate_reasons(
                candidate,
                transcript,
                expected_version=DELIVERY_QUALITY_DECISION_VERSION,
                expected_provider_identity=provider,
                expected_source_hash="d" * 64,
            ),
            ["delivery_quality_report_invalid"],
        )

    def test_rank_boundary_rejects_tampered_or_untrusted_delivery_report(self):
        report, _clarity, _words, transcript = self.fixture()
        candidate = {
            "start_time": 10.0,
            "end_time": 15.0,
            "speech_start_time": 10.0,
            "speech_end_time": 15.0,
            "deliveryQualityReport": {**report, "deliveryStrength": 1.0},
        }
        self.assertEqual(
            _delivery_quality_gate_reasons(
                candidate,
                transcript,
                expected_version=DELIVERY_QUALITY_DECISION_VERSION,
                expected_provider_identity=report["providerIdentity"],
                expected_source_hash=SOURCE_HASH,
            ),
            ["delivery_quality_report_invalid"],
        )


class DeliveryQualityLocalTests(unittest.TestCase):
    def test_ffmpeg_decode_is_read_only_mono_16k_exact_interval(self):
        completed = SimpleNamespace(stdout=struct.pack("<4f", 0.1, -0.2, 0.3, -0.4))
        with patch(
            "shorts_generator.local.delivery_quality.subprocess.run",
            return_value=completed,
        ) as run:
            samples = _decode_interval_mono_16k(
                "source with spaces.mp4", 12.3456789012, 14.8456789012
            )

        command = run.call_args.args[0]
        self.assertLess(command.index("-ss"), command.index("-i"))
        self.assertEqual(command[command.index("-ss") + 1], "12.345678901")
        self.assertEqual(command[command.index("-t") + 1], "2.500000000")
        self.assertEqual(command[command.index("-ac") + 1], "1")
        self.assertEqual(command[command.index("-ar") + 1], "16000")
        self.assertNotIn("-y", command)
        run.assert_called_once_with(command, check=True, capture_output=True)
        self.assertEqual(len(samples), 4)

    def test_rms_metrics_are_bounded_and_deterministic(self):
        samples = []
        for index in range(DELIVERY_QUALITY_SAMPLE_RATE):
            amplitude = 0.04 if index < DELIVERY_QUALITY_SAMPLE_RATE // 2 else 0.20
            samples.append(amplitude * math.sin(2.0 * math.pi * 220.0 * index / 16000.0))
        first = _rms_dynamics(samples)
        second = _rms_dynamics(list(samples))

        self.assertEqual(first, second)
        self.assertTrue(first["available"])
        self.assertEqual(first["sampleRate"], 16000)
        self.assertGreater(first["rmsDynamicRangeDb"], 5.0)
        self.assertLessEqual(first["activeFrameRatio"], 1.0)

    def test_local_analyzer_attaches_sealed_report(self):
        text = "Don't let criticism choose your life because boundaries protect your peace today"
        words = timed_words(text, start=0.0)
        transcript = {
            "duration": 5.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": words[-1]["end"],
                    "text": text,
                    "words": [
                        {"word": word["text"], "start": word["start"], "end": word["end"]}
                        for word in words
                    ],
                }
            ],
        }
        transcript_hash = transcript_timing_hash(transcript)
        clarity = evaluate_spoken_clarity_evidence(
            source_hash=SOURCE_HASH,
            transcript_timing_hash=transcript_hash,
            speech_start=0.0,
            speech_end=5.0,
            reference_words=words,
            point_exact_quote="criticism choose your life",
            opening_asr_words=opening_asr(words, 0.0),
            provider_identity={"provider": "clarity-fixture-v1"},
        )
        candidate = {
            "speech_start_time": 0.0,
            "speech_end_time": 5.0,
            "spokenClarityReport": clarity,
        }

        def decoder(_path, start, end, *, sample_rate):
            self.assertEqual((start, end, sample_rate), (0.0, 5.0, 16000))
            return [
                0.08 * math.sin(2.0 * math.pi * 220.0 * index / sample_rate)
                for index in range(round((end - start) * sample_rate))
            ]

        decoder.provider_identity = "delivery-fixture-decoder-v1"
        [analyzed] = analyze_motivational_delivery_quality(
            "unused.mp4",
            [candidate],
            transcript,
            SOURCE_HASH,
            audio_decoder=decoder,
        )

        self.assertEqual(analyzed["deliveryQualityStatus"], "pass")
        self.assertTrue(analyzed["deliveryQualityEligible"])
        self.assertEqual(
            analyzed["deliveryQualityReport"]["providerIdentity"]["audioDecoder"],
            "delivery-fixture-decoder-v1",
        )
        verify_delivery_quality_report(
            analyzed["deliveryQualityReport"],
            source_hash=SOURCE_HASH,
            transcript_timing_hash=transcript_hash,
            speech_interval=(0.0, 5.0),
            require_pass=True,
        )

    def test_local_decode_failure_returns_review(self):
        text = "Don't let criticism choose your life because boundaries protect your peace today"
        words = timed_words(text, start=0.0)
        transcript = {
            "duration": 5.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": words[-1]["end"],
                    "text": text,
                    "words": [
                        {"word": word["text"], "start": word["start"], "end": word["end"]}
                        for word in words
                    ],
                }
            ],
        }
        clarity = evaluate_spoken_clarity_evidence(
            source_hash=SOURCE_HASH,
            transcript_timing_hash=transcript_timing_hash(transcript),
            speech_start=0.0,
            speech_end=5.0,
            reference_words=words,
            point_exact_quote="criticism choose your life",
            opening_asr_words=opening_asr(words, 0.0),
            provider_identity={"provider": "clarity-fixture-v1"},
        )

        def failing_decoder(*_args, **_kwargs):
            raise RuntimeError("decode failed")

        [analyzed] = analyze_motivational_delivery_quality(
            "unused.mp4",
            [{"speech_start_time": 0.0, "speech_end_time": 5.0, "spokenClarityReport": clarity}],
            transcript,
            SOURCE_HASH,
            audio_decoder=failing_decoder,
        )
        self.assertEqual(analyzed["deliveryQualityStatus"], "review")
        self.assertEqual(analyzed["deliveryQualityRejectionReasons"], [])
        self.assertIn(
            "delivery_quality_provider_not_ok",
            analyzed["deliveryQualityReviewReasons"],
        )


if __name__ == "__main__":
    unittest.main()
