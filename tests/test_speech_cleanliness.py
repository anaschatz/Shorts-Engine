import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shorts_generator.artifact_contracts import ArtifactBindingError, content_hash
from shorts_generator.local.speech_cleanliness import (
    analyze_motivational_speech_cleanliness,
)
from shorts_generator.speech_cleanliness import (
    SPEECH_CLEANLINESS_DECISION_VERSION,
    SPEECH_CLEANLINESS_REPORT_TYPE,
    evaluate_speech_cleanliness_evidence,
    verify_speech_cleanliness_report,
)


SOURCE_HASH = "a" * 64
TRANSCRIPT_HASH = "b" * 64


def event(start, end, text=None):
    value = {"start": start, "end": end}
    if text is not None:
        value["text"] = text
    return value


def transcript_for_words(words, duration=None):
    normalized = [dict(word) for word in words]
    end = max(float(word["end"]) for word in normalized)
    return {
        "duration": float(duration if duration is not None else end + 0.2),
        "segments": [
            {
                "start": min(float(word["start"]) for word in normalized),
                "end": end,
                "text": " ".join(str(word["word"]) for word in normalized),
                "words": normalized,
            }
        ],
    }


def candidate(start, end):
    return {
        "title": f"candidate-{start}-{end}",
        "start_time": start,
        "end_time": end,
        "speech_start_time": start,
        "speech_end_time": end,
    }


def silent_decoder(_path, start, end, *, sample_rate):
    return [0.0] * max(1, int((end - start) * sample_rate))


silent_decoder.provider_identity = "mock-silent-decoder-v1"


def no_speech_vad(_audio, *, sample_rate):
    return []


no_speech_vad.provider_identity = "mock-no-speech-vad-v1"


def no_fillers(_audio, *, sample_rate, language):
    return []


no_fillers.provider_identity = "mock-no-fillers-v1"


class SpeechCleanlinessDecisionTests(unittest.TestCase):
    def evaluate(self, **overrides):
        values = {
            "source_hash": SOURCE_HASH,
            "transcript_timing_hash": TRANSCRIPT_HASH,
            "speech_start": 10.0,
            "speech_end": 14.0,
            "lexical_fillers": [],
            "uncovered_vocalizations": [],
            "prompted_fillers": [],
            "provider_identity": {"provider": "fixture-v1"},
        }
        values.update(overrides)
        return evaluate_speech_cleanliness_evidence(**values)

    def test_clean_evidence_passes_and_is_sealed(self):
        report = self.evaluate()

        self.assertEqual(report["artifactType"], SPEECH_CLEANLINESS_REPORT_TYPE)
        self.assertEqual(
            report["decisionVersion"],
            SPEECH_CLEANLINESS_DECISION_VERSION,
        )
        self.assertEqual(report["status"], "pass")
        self.assertTrue(report["eligible"])
        self.assertEqual(report["deterministicReasons"], [])
        self.assertIs(
            verify_speech_cleanliness_report(
                report,
                source_hash=SOURCE_HASH,
                transcript_timing_hash=TRANSCRIPT_HASH,
                speech_interval=(10.0, 14.0),
                require_pass=True,
            ),
            report,
        )

    def test_single_filler_is_review_not_pass(self):
        report = self.evaluate(
            lexical_fillers=[event(10.2, 10.35, "Um")],
        )

        self.assertEqual(report["status"], "review")
        self.assertFalse(report["eligible"])
        self.assertEqual(report["reviewReasons"], ["single_audible_filler"])
        with self.assertRaisesRegex(ArtifactBindingError, "not eligible"):
            verify_speech_cleanliness_report(report, require_pass=True)

    def test_provider_error_is_always_review(self):
        report = self.evaluate(
            provider_status="filler_transcriber_error",
            lexical_fillers=[
                event(10.2, 10.3, "um"),
                event(10.5, 10.6, "uh"),
            ],
        )

        self.assertEqual(report["status"], "review")
        self.assertEqual(
            report["reviewReasons"],
            ["speech_cleanliness_provider_not_ok"],
        )
        self.assertEqual(report["rejectionReasons"], [])

    def test_five_uncovered_and_three_prompted_rejects(self):
        uncovered = [
            event(10.2 + index * 0.5, 10.3 + index * 0.5)
            for index in range(5)
        ]
        prompted = [
            event(10.2 + index * 0.5, 10.3 + index * 0.5, filler)
            for index, filler in enumerate(("um", "uh", "er"))
        ]
        report = self.evaluate(
            uncovered_vocalizations=uncovered,
            prompted_fillers=prompted,
        )

        self.assertEqual(report["status"], "reject")
        self.assertFalse(report["eligible"])
        self.assertEqual(report["uncoveredVocalizationCount"], 5)
        self.assertEqual(report["promptedFillerCount"], 3)
        self.assertEqual(
            report["rejectionReasons"],
            [
                "repeated_audible_fillers",
                "repeated_untranscribed_vocalizations",
            ],
        )

    def test_three_unresolved_vocalizations_are_review(self):
        report = self.evaluate(
            uncovered_vocalizations=[
                event(10.2, 10.3),
                event(10.7, 10.8),
                event(11.2, 11.3),
            ]
        )

        self.assertEqual(report["status"], "review")
        self.assertEqual(
            report["reviewReasons"],
            ["unresolved_internal_vocalizations"],
        )

    def test_verification_rejects_binding_mismatch_and_tamper(self):
        report = self.evaluate()
        with self.assertRaisesRegex(ArtifactBindingError, "another source"):
            verify_speech_cleanliness_report(report, source_hash="c" * 64)
        with self.assertRaisesRegex(ArtifactBindingError, "interval is stale"):
            verify_speech_cleanliness_report(
                report,
                speech_interval=(10.0, 13.9),
            )

        tampered = {**report, "eligible": False}
        with self.assertRaisesRegex(ArtifactBindingError, "contentHash"):
            verify_speech_cleanliness_report(tampered)

        resealed_but_inconsistent = {**report, "eligible": False}
        resealed_but_inconsistent["contentHash"] = content_hash(
            resealed_but_inconsistent
        )
        with self.assertRaisesRegex(ArtifactBindingError, "inconsistent"):
            verify_speech_cleanliness_report(resealed_but_inconsistent)

    def test_evidence_at_interval_end_is_half_open(self):
        with self.assertRaisesRegex(ArtifactBindingError, "outside"):
            self.evaluate(
                lexical_fillers=[event(14.0, 14.1, "um")],
            )
        report = self.evaluate(
            lexical_fillers=[event(13.9, 14.0, "um")],
        )
        self.assertEqual(report["lexicalFillerCount"], 1)


class LocalSpeechCleanlinessTests(unittest.TestCase):
    def test_actual_five_uncovered_three_prompted_pattern_rejects(self):
        words = [
            {"word": word, "start": index * 0.8, "end": index * 0.8 + 0.2}
            for index, word in enumerate(
                ("Choose", "the", "truth", "that", "protects", "you")
            )
        ]
        transcript = transcript_for_words(words, duration=5.0)
        vad_calls = []
        transcriber_calls = []

        def gap_vad(_audio, *, sample_rate):
            vad_calls.append(sample_rate)
            return [{"start": 0.01, "end": 0.11, "confidence": 0.95}]

        gap_vad.provider_identity = "mock-five-gap-vad-v1"

        def fillers(_audio, *, sample_rate, language):
            transcriber_calls.append((sample_rate, language))
            return [
                event(0.25, 0.35, "um"),
                event(1.05, 1.15, "uh"),
                event(1.85, 1.95, "er"),
            ]

        fillers.provider_identity = "mock-three-fillers-v1"
        with tempfile.TemporaryDirectory() as directory:
            [result] = analyze_motivational_speech_cleanliness(
                "/unused/source.mp4",
                [candidate(0.0, 5.0)],
                transcript,
                SOURCE_HASH,
                directory,
                audio_decoder=silent_decoder,
                gap_vad=gap_vad,
                filler_transcriber=fillers,
            )

        self.assertEqual(len(vad_calls), 5)
        self.assertEqual(len(transcriber_calls), 1)
        self.assertEqual(result["speech_cleanliness_status"], "reject")
        self.assertFalse(result["speech_cleanliness_eligible"])
        self.assertEqual(
            result["speech_cleanliness_uncovered_vocalization_count"],
            5,
        )
        self.assertEqual(result["speech_cleanliness_prompted_filler_count"], 3)
        self.assertIn(
            "repeated_untranscribed_vocalizations",
            result["speech_cleanliness_deterministic_reasons"],
        )
        verify_speech_cleanliness_report(result["speechCleanlinessReport"])

    def test_clean_candidate_passes_without_filler_transcription(self):
        transcript = transcript_for_words(
            [
                {"word": "Choose", "start": 0.0, "end": 0.2},
                {"word": "truth", "start": 0.25, "end": 0.45},
                {"word": "now", "start": 0.5, "end": 0.7},
            ],
            duration=1.0,
        )
        filler_calls = []

        def should_not_run(*_args, **_kwargs):
            filler_calls.append(True)
            return []

        should_not_run.provider_identity = "unexpected-filler-v1"
        with tempfile.TemporaryDirectory() as directory:
            [result] = analyze_motivational_speech_cleanliness(
                "/unused/source.mp4",
                [candidate(0.0, 1.0)],
                transcript,
                SOURCE_HASH,
                directory,
                audio_decoder=silent_decoder,
                gap_vad=no_speech_vad,
                filler_transcriber=should_not_run,
            )

        self.assertEqual(filler_calls, [])
        self.assertEqual(result["speech_cleanliness_status"], "pass")
        self.assertTrue(result["speech_cleanliness_eligible"])

    def test_one_lexical_filler_is_review(self):
        transcript = transcript_for_words(
            [
                {"word": "Um", "start": 0.0, "end": 0.15},
                {"word": "choose", "start": 0.2, "end": 0.45},
                {"word": "now", "start": 0.5, "end": 0.7},
            ],
            duration=1.0,
        )
        with tempfile.TemporaryDirectory() as directory:
            [result] = analyze_motivational_speech_cleanliness(
                "/unused/source.mp4",
                [candidate(0.0, 1.0)],
                transcript,
                SOURCE_HASH,
                directory,
                audio_decoder=silent_decoder,
                gap_vad=no_speech_vad,
                filler_transcriber=no_fillers,
            )

        self.assertEqual(result["speech_cleanliness_status"], "review")
        self.assertEqual(result["speech_cleanliness_lexical_filler_count"], 1)
        self.assertEqual(
            result["speech_cleanliness_review_reasons"],
            ["single_audible_filler"],
        )

    def test_semantic_use_of_right_is_not_misclassified_as_a_filler(self):
        transcript = transcript_for_words(
            [
                {"word": "You", "start": 0.0, "end": 0.15},
                {"word": "have", "start": 0.2, "end": 0.35},
                {"word": "the", "start": 0.4, "end": 0.5},
                {"word": "right", "start": 0.55, "end": 0.75},
                {"word": "to", "start": 0.8, "end": 0.9},
                {"word": "leave", "start": 0.95, "end": 1.2},
            ],
            duration=1.4,
        )
        with tempfile.TemporaryDirectory() as directory:
            [result] = analyze_motivational_speech_cleanliness(
                "/unused/source.mp4",
                [candidate(0.0, 1.4)],
                transcript,
                SOURCE_HASH,
                directory,
                audio_decoder=silent_decoder,
                gap_vad=no_speech_vad,
                filler_transcriber=no_fillers,
            )

        self.assertEqual(result["speech_cleanliness_status"], "pass")
        self.assertEqual(result["speech_cleanliness_lexical_filler_count"], 0)

    def test_audio_and_model_errors_review_never_pass(self):
        clean_transcript = transcript_for_words(
            [
                {"word": "Choose", "start": 0.0, "end": 0.2},
                {"word": "now", "start": 0.3, "end": 0.5},
            ],
            duration=1.0,
        )

        def broken_decoder(*_args, **_kwargs):
            raise RuntimeError("decode failed")

        broken_decoder.provider_identity = "broken-decoder-v1"
        filler_transcript = transcript_for_words(
            [
                {"word": "Um", "start": 0.0, "end": 0.15},
                {"word": "choose", "start": 0.2, "end": 0.45},
            ],
            duration=1.0,
        )

        def broken_model(*_args, **_kwargs):
            raise RuntimeError("model failed")

        broken_model.provider_identity = "broken-filler-model-v1"
        with tempfile.TemporaryDirectory() as directory:
            [decode_result] = analyze_motivational_speech_cleanliness(
                "/unused/source.mp4",
                [candidate(0.0, 1.0)],
                clean_transcript,
                SOURCE_HASH,
                directory,
                audio_decoder=broken_decoder,
                gap_vad=no_speech_vad,
                filler_transcriber=no_fillers,
            )
            [model_result] = analyze_motivational_speech_cleanliness(
                "/unused/source.mp4",
                [candidate(0.0, 1.0)],
                filler_transcript,
                SOURCE_HASH,
                directory,
                audio_decoder=silent_decoder,
                gap_vad=no_speech_vad,
                filler_transcriber=broken_model,
            )

        self.assertEqual(decode_result["speech_cleanliness_status"], "review")
        self.assertEqual(
            decode_result["speech_cleanliness_provider_status"],
            "audio_decode_error",
        )
        self.assertEqual(model_result["speech_cleanliness_status"], "review")
        self.assertEqual(
            model_result["speech_cleanliness_provider_status"],
            "filler_transcriber_error",
        )

    def test_cache_is_bound_to_provider_identity_and_rejects_tamper(self):
        transcript = transcript_for_words(
            [
                {"word": "Choose", "start": 0.0, "end": 0.2},
                {"word": "now", "start": 0.25, "end": 0.5},
            ],
            duration=1.0,
        )
        calls = {"a": 0, "b": 0}

        def decoder_a(_path, start, end, *, sample_rate):
            calls["a"] += 1
            return [0.0] * int((end - start) * sample_rate)

        decoder_a.provider_identity = "decoder-a-v1"

        def decoder_b(_path, start, end, *, sample_rate):
            calls["b"] += 1
            return [0.0] * int((end - start) * sample_rate)

        decoder_b.provider_identity = "decoder-b-v1"

        with tempfile.TemporaryDirectory() as directory:
            first = analyze_motivational_speech_cleanliness(
                "/unused/source.mp4",
                [candidate(0.0, 1.0)],
                transcript,
                SOURCE_HASH,
                directory,
                audio_decoder=decoder_a,
                gap_vad=no_speech_vad,
                filler_transcriber=no_fillers,
            )
            second = analyze_motivational_speech_cleanliness(
                "/unused/source.mp4",
                [candidate(0.0, 1.0)],
                transcript,
                SOURCE_HASH,
                directory,
                audio_decoder=decoder_a,
                gap_vad=no_speech_vad,
                filler_transcriber=no_fillers,
            )
            self.assertEqual(calls["a"], 1)
            self.assertEqual(
                first[0]["speechCleanlinessReport"]["contentHash"],
                second[0]["speechCleanlinessReport"]["contentHash"],
            )

            analyze_motivational_speech_cleanliness(
                "/unused/source.mp4",
                [candidate(0.0, 1.0)],
                transcript,
                SOURCE_HASH,
                directory,
                audio_decoder=decoder_b,
                gap_vad=no_speech_vad,
                filler_transcriber=no_fillers,
            )
            self.assertEqual(calls["b"], 1)
            cache_files = sorted(Path(directory).rglob("*.json"))
            self.assertEqual(len(cache_files), 2)

            decoder_a_cache = next(
                path
                for path in cache_files
                if json.loads(path.read_text(encoding="utf-8"))[
                    "providerIdentity"
                ]["audioDecoder"]
                == "decoder-a-v1"
            )
            cached = json.loads(decoder_a_cache.read_text(encoding="utf-8"))
            cached["eligible"] = False
            decoder_a_cache.write_text(json.dumps(cached), encoding="utf-8")
            analyze_motivational_speech_cleanliness(
                "/unused/source.mp4",
                [candidate(0.0, 1.0)],
                transcript,
                SOURCE_HASH,
                directory,
                audio_decoder=decoder_a,
                gap_vad=no_speech_vad,
                filler_transcriber=no_fillers,
            )
            self.assertEqual(calls["a"], 2)

            repaired = json.loads(decoder_a_cache.read_text(encoding="utf-8"))
            verify_speech_cleanliness_report(repaired, require_pass=True)
            self.assertNotIn("audio", repaired)

    def test_reference_words_use_half_open_candidate_interval(self):
        transcript = transcript_for_words(
            [
                {"word": "uh", "start": 0.8, "end": 1.0},
                {"word": "Choose", "start": 1.0, "end": 1.4},
                {"word": "now", "start": 1.45, "end": 2.0},
                {"word": "um", "start": 2.0, "end": 2.2},
            ],
            duration=2.5,
        )
        with tempfile.TemporaryDirectory() as directory:
            [result] = analyze_motivational_speech_cleanliness(
                "/unused/source.mp4",
                [candidate(1.0, 2.0)],
                transcript,
                SOURCE_HASH,
                directory,
                audio_decoder=silent_decoder,
                gap_vad=no_speech_vad,
                filler_transcriber=no_fillers,
            )

        self.assertEqual(result["speech_cleanliness_status"], "pass")
        self.assertEqual(result["speech_cleanliness_lexical_filler_count"], 0)

    def test_default_filler_model_is_constructed_once_per_batch(self):
        transcript = transcript_for_words(
            [
                {"word": "Um", "start": 0.0, "end": 0.15},
                {"word": "choose", "start": 0.2, "end": 0.45},
                {"word": "Uh", "start": 2.0, "end": 2.15},
                {"word": "act", "start": 2.2, "end": 2.45},
            ],
            duration=3.0,
        )
        constructions = []
        calls = []

        class FakeRunner:
            def __init__(self):
                constructions.append(True)

            def __call__(self, _audio, *, sample_rate, language):
                calls.append((sample_rate, language))
                return []

        with tempfile.TemporaryDirectory() as directory, patch(
            "shorts_generator.local.speech_cleanliness."
            "_FasterWhisperFillerTranscriber",
            FakeRunner,
        ):
            results = analyze_motivational_speech_cleanliness(
                "/unused/source.mp4",
                [candidate(0.0, 1.0), candidate(2.0, 3.0)],
                transcript,
                SOURCE_HASH,
                directory,
                audio_decoder=silent_decoder,
                gap_vad=no_speech_vad,
                filler_transcriber=None,
            )

        self.assertEqual(len(constructions), 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(
            [result["speech_cleanliness_status"] for result in results],
            ["review", "review"],
        )


if __name__ == "__main__":
    unittest.main()
