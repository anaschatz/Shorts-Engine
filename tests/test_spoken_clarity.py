import copy
import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from shorts_generator.artifact_contracts import ArtifactBindingError, content_hash
from shorts_generator.local.spoken_clarity import (
    _decode_opening_mono_16k,
    analyze_motivational_spoken_clarity,
)
from shorts_generator.spoken_clarity import (
    ASR_TOKEN_MATCH_REVIEW_THRESHOLD,
    SPOKEN_CLARITY_DECISION_VERSION,
    SPOKEN_CLARITY_REPORT_TYPE,
    evaluate_spoken_clarity_evidence,
    verify_spoken_clarity_report,
)


SOURCE_HASH = "a" * 64
TRANSCRIPT_HASH = "b" * 64


def timed_words(text, start=10.0, step=0.2, segment_index=0):
    result = []
    cursor = start
    for token in text.split():
        result.append(
            {
                "text": token,
                "start": cursor,
                "end": cursor + step * 0.75,
                "segmentIndex": segment_index,
            }
        )
        cursor += step
    return result


def high_confidence_asr(words, start=10.0):
    return [
        {
            "text": word,
            "start": start + index * 0.2,
            "end": start + index * 0.2 + 0.15,
            "confidence": 0.95,
        }
        for index, word in enumerate(words)
    ]


class SpokenClarityDecisionTests(unittest.TestCase):
    def evaluate(self, **overrides):
        text = "Don't let criticism choose your life"
        values = {
            "source_hash": SOURCE_HASH,
            "transcript_timing_hash": TRANSCRIPT_HASH,
            "speech_start": 10.0,
            "speech_end": 14.0,
            "reference_words": timed_words(text),
            "point_exact_quote": "criticism choose your life",
            "opening_asr_words": high_confidence_asr(text.split()),
            "provider_identity": {"provider": "fixture-v1"},
        }
        values.update(overrides)
        return evaluate_spoken_clarity_evidence(**values)

    def test_clean_control_passes_and_is_sealed_to_exact_inputs(self):
        report = self.evaluate()

        self.assertEqual(report["artifactType"], SPOKEN_CLARITY_REPORT_TYPE)
        self.assertEqual(report["decisionVersion"], SPOKEN_CLARITY_DECISION_VERSION)
        self.assertEqual(report["status"], "pass")
        self.assertTrue(report["eligible"])
        self.assertEqual(report["deterministicReasons"], [])
        self.assertEqual(
            report["evidence"]["openingAsr"]["tokenMatchRatio"],
            1.0,
        )
        self.assertEqual(report["speechInterval"]["semantics"], "half-open")
        self.assertFalse(report["audioHandling"]["sourceAudioModified"])
        self.assertFalse(report["audioHandling"]["disfluenciesRemoved"])
        self.assertFalse(report["audioHandling"]["affectInferenceUsed"])
        self.assertIs(
            verify_spoken_clarity_report(
                report,
                source_hash=SOURCE_HASH,
                transcript_timing_hash=TRANSCRIPT_HASH,
                speech_interval=(10.0, 14.0),
                require_pass=True,
            ),
            report,
        )

    def test_exact_8g_shape_rejects_bare_auxiliary_and_unanchored_point(self):
        text = (
            "We don't have to feel that we're opening up a Pandora's Box. "
            "It's not okay to talk to anyone this way, so it's not okay to "
            "talk to me this way and I'm going to say that."
        )
        report = self.evaluate(
            speech_start=126.479,
            speech_end=148.96,
            reference_words=timed_words(text, start=126.479),
            point_exact_quote=(
                "It's not okay to talk to anyone this way, so it's not okay "
                "to talk to me this way and I'm going to say that."
            ),
            opening_asr_words=high_confidence_asr(
                text.split()[:8],
                start=126.479,
            ),
        )

        self.assertEqual(report["status"], "reject")
        self.assertFalse(report["evidence"]["hookSubjectOrClaim"]["present"])
        self.assertIn(
            "spoken_clarity_hook_subject_or_claim_missing",
            report["rejectionReasons"],
        )
        self.assertIn(
            "spoken_clarity_opening_point_anchor_missing",
            report["rejectionReasons"],
        )
        self.assertGreaterEqual(
            report["evidence"]["openingAsr"]["tokenMatchRatio"],
            ASR_TOKEN_MATCH_REVIEW_THRESHOLD,
        )
        self.assertNotIn(
            "spoken_clarity_opening_asr_token_mismatch",
            report["reviewReasons"],
        )

    def test_real_jhh_asr_mismatch_reviews_even_with_confident_words(self):
        text = (
            "Whenever there's a choice between resentment and guilt choose "
            "the guilt every time"
        )
        opening_reference = timed_words(
            "Whenever there's a choice between resentment",
            start=580.92,
            step=0.25,
            segment_index=0,
        )
        point_reference = timed_words(
            "and guilt choose the guilt every time",
            start=583.2,
            step=0.2,
            segment_index=1,
        )
        real_opening_asr = high_confidence_asr(
            "Whenever there's a choice within the museum".split(),
            start=580.92,
        )
        for word in real_opening_asr:
            word["confidence"] = 0.782935

        report = self.evaluate(
            speech_start=580.92,
            speech_end=585.0,
            reference_words=opening_reference + point_reference,
            point_exact_quote=text,
            opening_asr_words=real_opening_asr,
        )

        opening_asr = report["evidence"]["openingAsr"]
        self.assertEqual(report["status"], "review")
        self.assertFalse(report["eligible"])
        self.assertTrue(report["evidence"]["pointExactQuoteAligned"])
        self.assertAlmostEqual(opening_asr["meanWordConfidence"], 0.782935)
        self.assertEqual(opening_asr["referenceTokenCount"], 6)
        self.assertEqual(opening_asr["asrTokenCount"], 7)
        self.assertEqual(opening_asr["tokenEditDistance"], 3)
        self.assertEqual(opening_asr["tokenMatchRatio"], 0.571429)
        self.assertEqual(
            report["reviewReasons"],
            ["spoken_clarity_opening_asr_token_mismatch"],
        )

    def test_dont_is_not_signal_but_following_lexical_action_is(self):
        report = self.evaluate()

        signal = report["evidence"]["hookSubjectOrClaim"]
        self.assertEqual(signal["token"], "let")
        self.assertEqual(signal["family"], "actionable_claim")
        self.assertEqual(
            signal["pattern"],
            "topic_plus_predicate_or_contrast",
        )
        self.assertEqual(len(signal["parts"]), 2)

    def test_conservative_two_part_hook_controls_pass(self):
        controls = (
            (
                "Don't let criticism choose your life",
                "criticism choose your life",
                "topic_plus_predicate_or_contrast",
            ),
            (
                "Boundaries protect your peace",
                "Boundaries protect your peace",
                "topic_plus_predicate_or_contrast",
            ),
            (
                "Whenever there's a choice between resentment and guilt",
                "resentment and guilt",
                "two_tension_or_consequence_anchors",
            ),
        )
        for text, point, expected_pattern in controls:
            with self.subTest(text=text):
                report = self.evaluate(
                    reference_words=timed_words(text),
                    point_exact_quote=point,
                    opening_asr_words=high_confidence_asr(text.split()),
                )
                self.assertEqual(report["status"], "pass")
                claim = report["evidence"]["hookSubjectOrClaim"]
                self.assertTrue(claim["present"])
                self.assertEqual(claim["pattern"], expected_pattern)
                self.assertEqual(len(claim["parts"]), 2)
                self.assertNotEqual(
                    claim["parts"][0]["wordIndex"],
                    claim["parts"][1]["wordIndex"],
                )

    def test_generic_single_tokens_cannot_manufacture_hook_claim(self):
        adversarial = (
            "I was talking to people about things people know things",
            "Do things work",
            "People work",
            "Don't do things",
            "Guilt guilt",
        )
        for text in adversarial:
            with self.subTest(text=text):
                report = self.evaluate(
                    reference_words=timed_words(text),
                    point_exact_quote=text,
                    opening_asr_words=high_confidence_asr(text.split()),
                )
                self.assertEqual(report["status"], "reject")
                self.assertEqual(
                    report["evidence"]["hookSubjectOrClaim"],
                    {"present": False},
                )
                self.assertIn(
                    "spoken_clarity_hook_subject_or_claim_missing",
                    report["rejectionReasons"],
                )

    def test_exact_jhh_confidence_shape_is_review_and_ineligible(self):
        text = (
            "Whenever there's a choice between resentment and guilt, choose "
            "the guilt every time."
        )
        probabilities = [
            0.4185,
            0.7938,
            0.9395,
            0.9912,
            0.5393,
            0.5960,
            0.9391,
            0.8704,
        ]
        asr = high_confidence_asr(text.split()[:8], start=580.92)
        for word, probability in zip(asr, probabilities):
            word["confidence"] = probability
        report = self.evaluate(
            speech_start=580.92,
            speech_end=584.639,
            reference_words=timed_words(text, start=580.92),
            point_exact_quote=text,
            opening_asr_words=asr,
        )

        self.assertEqual(report["status"], "review")
        self.assertFalse(report["eligible"])
        self.assertAlmostEqual(
            report["evidence"]["openingAsr"]["meanWordConfidence"],
            0.760975,
        )
        self.assertEqual(
            report["evidence"]["openingAsr"]["lowConfidenceWordRatio"],
            0.375,
        )
        self.assertEqual(
            report["reviewReasons"],
            ["spoken_clarity_opening_asr_uncertain"],
        )

    def test_severely_unclear_opening_asr_rejects(self):
        asr = high_confidence_asr(["don't", "let", "criticism", "choose"])
        for word, probability in zip(asr, [0.4, 0.5, 0.6, 0.8]):
            word["confidence"] = probability
        report = self.evaluate(opening_asr_words=asr)

        self.assertEqual(report["status"], "reject")
        self.assertIn(
            "spoken_clarity_opening_asr_severely_unclear",
            report["rejectionReasons"],
        )

    def test_one_duplicate_is_review_and_two_are_reject(self):
        one = "Stop stop letting criticism choose your life"
        one_report = self.evaluate(
            reference_words=timed_words(one),
            point_exact_quote="criticism choose your life",
            opening_asr_words=high_confidence_asr(one.split()),
        )
        self.assertEqual(one_report["status"], "review")
        self.assertEqual(one_report["counts"]["adjacentDuplicates"], 1)

        two = "Stop stop letting criticism criticism choose your life"
        two_report = self.evaluate(
            reference_words=timed_words(two),
            point_exact_quote="criticism choose your life",
            opening_asr_words=high_confidence_asr(two.split()),
        )
        self.assertEqual(two_report["status"], "reject")
        self.assertEqual(two_report["counts"]["adjacentDuplicates"], 2)
        self.assertIn(
            "spoken_clarity_repeated_disfluencies",
            two_report["rejectionReasons"],
        )

    def test_repeated_two_to_four_gram_false_start_is_review(self):
        text = "So if I so if I let criticism choose my life"
        report = self.evaluate(
            reference_words=timed_words(text),
            point_exact_quote="criticism choose my life",
            opening_asr_words=high_confidence_asr(text.split()[:8]),
        )

        self.assertEqual(report["status"], "review")
        self.assertEqual(report["counts"]["repeatedPhraseRestarts"], 1)
        self.assertEqual(
            report["evidence"]["repeatedPhraseRestarts"][0]["phrase"],
            "so if i",
        )

    def test_searching_pause_is_review_but_sentence_boundary_is_not(self):
        text = "Stop letting criticism choose your life"
        words = timed_words(text)
        words[3]["start"] = 11.4
        words[3]["end"] = 11.55
        words[4]["start"] = 11.7
        words[4]["end"] = 11.85
        words[5]["start"] = 11.9
        words[5]["end"] = 12.05
        report = self.evaluate(
            reference_words=words,
            point_exact_quote="criticism choose your life",
            opening_asr_words=high_confidence_asr(text.split()),
        )
        self.assertEqual(report["status"], "review")
        self.assertEqual(report["counts"]["searchingInternalPauses"], 1)

        boundary_words = copy.deepcopy(words)
        boundary_words[2]["sentenceBoundaryAfter"] = True
        boundary = self.evaluate(
            reference_words=boundary_words,
            point_exact_quote="criticism choose your life",
            opening_asr_words=high_confidence_asr(text.split()),
        )
        self.assertEqual(boundary["status"], "pass")
        self.assertEqual(boundary["counts"]["searchingInternalPauses"], 0)

    def test_two_searching_pauses_reject(self):
        text = "Stop letting criticism choose your life protect your peace"
        words = timed_words(text)
        for index, start in ((3, 11.4), (4, 11.6), (5, 11.8), (6, 12.8), (7, 13.0), (8, 13.2)):
            words[index]["start"] = start
            words[index]["end"] = start + 0.15
        report = self.evaluate(
            reference_words=words,
            point_exact_quote="criticism choose your life protect your peace",
            opening_asr_words=high_confidence_asr(text.split()[:8]),
        )

        self.assertEqual(report["status"], "reject")
        self.assertEqual(report["counts"]["searchingInternalPauses"], 2)
        self.assertIn(
            "spoken_clarity_repeated_searching_pauses",
            report["rejectionReasons"],
        )

    def test_missing_provider_is_review_and_cannot_pass(self):
        report = self.evaluate(
            provider_status="clarity_transcriber_error",
            opening_asr_words=[],
        )

        self.assertEqual(report["status"], "review")
        self.assertFalse(report["eligible"])
        self.assertEqual(
            report["reviewReasons"],
            ["spoken_clarity_provider_not_ok"],
        )

    def test_tampering_and_stale_binding_are_rejected(self):
        report = self.evaluate()
        tampered = copy.deepcopy(report)
        tampered["evidence"]["openingPointAnchorTokens"] = []
        tampered["contentHash"] = content_hash(tampered)

        with self.assertRaisesRegex(ArtifactBindingError, "not canonical"):
            verify_spoken_clarity_report(tampered)
        with self.assertRaisesRegex(ArtifactBindingError, "interval is stale"):
            verify_spoken_clarity_report(report, speech_interval=(10.0, 14.1))


def transcript_for_two_candidates():
    first_text = "Don't let criticism choose your life."
    second_text = "Choose guilt because resentment is poison."
    first = timed_words(first_text, start=0.0, segment_index=0)
    second = timed_words(second_text, start=5.0, segment_index=1)
    for words in (first, second):
        for word in words:
            word["word"] = word.pop("text")
            word.pop("segmentIndex")
    return {
        "duration": 9.0,
        "language": "en",
        "segments": [
            {
                "start": 0.0,
                "end": first[-1]["end"],
                "text": first_text,
                "words": first,
            },
            {
                "start": 5.0,
                "end": second[-1]["end"],
                "text": second_text,
                "words": second,
            },
        ],
    }


class _FakeBatchRunner:
    provider_identity = "fake-opening-runner-v1"

    def __init__(self):
        self.calls = 0

    def __call__(self, _audio, *, sample_rate, language):
        self.calls += 1
        words = (
            ["don't", "let", "criticism", "choose", "your", "life"]
            if self.calls == 1
            else ["choose", "guilt", "because", "resentment", "is", "poison"]
        )
        return high_confidence_asr(words, start=0.0)


def _silent_decoder(_path, start, end, *, sample_rate):
    return [0.0] * max(1, int((end - start) * sample_rate))


_silent_decoder.provider_identity = "fake-opening-decoder-v1"


class SpokenClarityLocalProviderTests(unittest.TestCase):
    def test_ffmpeg_uses_input_side_seek_and_exact_opening_duration(self):
        completed = SimpleNamespace(stdout=struct.pack("<f", 0.25))
        with patch(
            "shorts_generator.local.spoken_clarity.subprocess.run",
            return_value=completed,
        ) as run:
            audio = _decode_opening_mono_16k(
                "source with spaces.mp4",
                12.3456789012,
                14.8456789012,
            )

        command = run.call_args.args[0]
        self.assertLess(command.index("-ss"), command.index("-i"))
        self.assertEqual(
            command[command.index("-ss") + 1],
            "12.345678901",
        )
        self.assertEqual(command[command.index("-i") + 1], "source with spaces.mp4")
        self.assertEqual(command[command.index("-t") + 1], "2.500000000")
        self.assertEqual(command[command.index("-ar") + 1], "16000")
        run.assert_called_once_with(command, check=True, capture_output=True)
        self.assertEqual(audio.tolist(), [0.25])

    def test_cache_identity_changes_with_language(self):
        transcript = transcript_for_two_candidates()
        transcript["segments"] = transcript["segments"][:1]
        transcript["duration"] = 2.0
        candidate = {
            "speech_start_time": 0.0,
            "speech_end_time": 1.15,
            "semantic_closure_exact_quote": "criticism choose your life.",
        }

        class LanguageRunner:
            provider_identity = "language-aware-runner-v1"

            def __init__(self):
                self.languages = []

            def __call__(self, _audio, *, sample_rate, language):
                self.languages.append(language)
                return high_confidence_asr(
                    ["don't", "let", "criticism", "choose", "your", "life"],
                    start=0.0,
                )

        runner = LanguageRunner()
        with tempfile.TemporaryDirectory() as cache_dir:
            english = copy.deepcopy(transcript)
            english["language"] = "en"
            french = copy.deepcopy(transcript)
            french["language"] = "fr"

            english_result = analyze_motivational_spoken_clarity(
                "unused.mp4",
                [candidate],
                english,
                SOURCE_HASH,
                cache_dir,
                audio_decoder=_silent_decoder,
                clarity_transcriber=runner,
            )
            french_result = analyze_motivational_spoken_clarity(
                "unused.mp4",
                [candidate],
                french,
                SOURCE_HASH,
                cache_dir,
                audio_decoder=_silent_decoder,
                clarity_transcriber=runner,
            )
            warm_english = analyze_motivational_spoken_clarity(
                "unused.mp4",
                [candidate],
                english,
                SOURCE_HASH,
                cache_dir,
                audio_decoder=_silent_decoder,
                clarity_transcriber=runner,
            )

            cache_files = list(
                (Path(cache_dir) / "spoken-clarity-v1").rglob("*.json")
            )

        self.assertEqual(runner.languages, ["en", "fr"])
        self.assertEqual(len(cache_files), 2)
        self.assertEqual(
            english_result[0]["spokenClarityReport"]["providerIdentity"]["language"],
            "en",
        )
        self.assertEqual(
            french_result[0]["spokenClarityReport"]["providerIdentity"]["language"],
            "fr",
        )
        self.assertEqual(
            warm_english[0]["spokenClarityReport"],
            english_result[0]["spokenClarityReport"],
        )

    def test_transient_decode_review_is_not_cached_and_next_run_retries(self):
        transcript = transcript_for_two_candidates()
        transcript["segments"] = transcript["segments"][:1]
        transcript["duration"] = 2.0
        candidate = {
            "speech_start_time": 0.0,
            "speech_end_time": 1.15,
            "semantic_closure_exact_quote": "criticism choose your life.",
        }

        class FlakyDecoder:
            provider_identity = "flaky-decoder-v1"

            def __init__(self):
                self.calls = 0

            def __call__(self, _path, start, end, *, sample_rate):
                self.calls += 1
                if self.calls == 1:
                    raise RuntimeError("temporary decode failure")
                return [0.0] * max(1, int((end - start) * sample_rate))

        class CleanRunner:
            provider_identity = "clean-runner-v1"

            def __init__(self):
                self.calls = 0

            def __call__(self, _audio, *, sample_rate, language):
                self.calls += 1
                return high_confidence_asr(
                    ["don't", "let", "criticism", "choose", "your", "life"],
                    start=0.0,
                )

        decoder = FlakyDecoder()
        runner = CleanRunner()
        with tempfile.TemporaryDirectory() as cache_dir:
            first = analyze_motivational_spoken_clarity(
                "unused.mp4",
                [candidate],
                transcript,
                SOURCE_HASH,
                cache_dir,
                audio_decoder=decoder,
                clarity_transcriber=runner,
            )
            self.assertEqual(
                first[0]["spokenClarityReport"]["providerStatus"],
                "audio_decode_error",
            )
            self.assertEqual(list(Path(cache_dir).rglob("*.json")), [])

            second = analyze_motivational_spoken_clarity(
                "unused.mp4",
                [candidate],
                transcript,
                SOURCE_HASH,
                cache_dir,
                audio_decoder=decoder,
                clarity_transcriber=runner,
            )
            third = analyze_motivational_spoken_clarity(
                "unused.mp4",
                [candidate],
                transcript,
                SOURCE_HASH,
                cache_dir,
                audio_decoder=decoder,
                clarity_transcriber=runner,
            )

        self.assertEqual(second[0]["spokenClarityStatus"], "pass")
        self.assertEqual(
            third[0]["spokenClarityReport"],
            second[0]["spokenClarityReport"],
        )
        self.assertEqual(decoder.calls, 2)
        self.assertEqual(runner.calls, 1)

    def test_transient_transcriber_review_is_not_cached_and_next_run_retries(self):
        transcript = transcript_for_two_candidates()
        transcript["segments"] = transcript["segments"][:1]
        transcript["duration"] = 2.0
        candidate = {
            "speech_start_time": 0.0,
            "speech_end_time": 1.15,
            "semantic_closure_exact_quote": "criticism choose your life.",
        }

        class FlakyRunner:
            provider_identity = "flaky-runner-v1"

            def __init__(self):
                self.calls = 0

            def __call__(self, _audio, *, sample_rate, language):
                self.calls += 1
                if self.calls == 1:
                    raise RuntimeError("temporary provider failure")
                return high_confidence_asr(
                    ["don't", "let", "criticism", "choose", "your", "life"],
                    start=0.0,
                )

        runner = FlakyRunner()
        with tempfile.TemporaryDirectory() as cache_dir:
            first = analyze_motivational_spoken_clarity(
                "unused.mp4",
                [candidate],
                transcript,
                SOURCE_HASH,
                cache_dir,
                audio_decoder=_silent_decoder,
                clarity_transcriber=runner,
            )
            self.assertEqual(
                first[0]["spokenClarityReport"]["providerStatus"],
                "clarity_transcriber_error",
            )
            self.assertEqual(list(Path(cache_dir).rglob("*.json")), [])

            second = analyze_motivational_spoken_clarity(
                "unused.mp4",
                [candidate],
                transcript,
                SOURCE_HASH,
                cache_dir,
                audio_decoder=_silent_decoder,
                clarity_transcriber=runner,
            )
            third = analyze_motivational_spoken_clarity(
                "unused.mp4",
                [candidate],
                transcript,
                SOURCE_HASH,
                cache_dir,
                audio_decoder=_silent_decoder,
                clarity_transcriber=runner,
            )

        self.assertEqual(second[0]["spokenClarityStatus"], "pass")
        self.assertEqual(
            third[0]["spokenClarityReport"],
            second[0]["spokenClarityReport"],
        )
        self.assertEqual(runner.calls, 2)

    def test_transient_default_provider_init_review_retries_on_next_run(self):
        transcript = transcript_for_two_candidates()
        transcript["segments"] = transcript["segments"][:1]
        transcript["duration"] = 2.0
        candidate = {
            "speech_start_time": 0.0,
            "speech_end_time": 1.15,
            "semantic_closure_exact_quote": "criticism choose your life.",
        }
        runner = _FakeBatchRunner()

        with tempfile.TemporaryDirectory() as cache_dir:
            with patch(
                "shorts_generator.local.spoken_clarity."
                "_FasterWhisperOpeningClarityTranscriber",
                side_effect=[RuntimeError("provider unavailable"), runner],
            ) as factory:
                first = analyze_motivational_spoken_clarity(
                    "unused.mp4",
                    [candidate],
                    transcript,
                    SOURCE_HASH,
                    cache_dir,
                    audio_decoder=_silent_decoder,
                )
                self.assertEqual(
                    first[0]["spokenClarityReport"]["providerStatus"],
                    "clarity_transcriber_error",
                )
                self.assertEqual(list(Path(cache_dir).rglob("*.json")), [])

                second = analyze_motivational_spoken_clarity(
                    "unused.mp4",
                    [candidate],
                    transcript,
                    SOURCE_HASH,
                    cache_dir,
                    audio_decoder=_silent_decoder,
                )
                third = analyze_motivational_spoken_clarity(
                    "unused.mp4",
                    [candidate],
                    transcript,
                    SOURCE_HASH,
                    cache_dir,
                    audio_decoder=_silent_decoder,
                )

        self.assertEqual(factory.call_count, 2)
        self.assertEqual(second[0]["spokenClarityStatus"], "pass")
        self.assertEqual(
            third[0]["spokenClarityReport"],
            second[0]["spokenClarityReport"],
        )

    def test_default_model_is_constructed_once_per_batch_and_cache_is_warm(self):
        transcript = transcript_for_two_candidates()
        candidates = [
            {
                "speech_start_time": 0.0,
                "speech_end_time": 1.15,
                "semantic_closure_exact_quote": "criticism choose your life.",
            },
            {
                "speech_start_time": 5.0,
                "speech_end_time": 6.15,
                "semantic_closure_exact_quote": "resentment is poison.",
            },
        ]
        runner = _FakeBatchRunner()
        with tempfile.TemporaryDirectory() as cache_dir:
            with patch(
                "shorts_generator.local.spoken_clarity."
                "_FasterWhisperOpeningClarityTranscriber",
                return_value=runner,
            ) as factory:
                first = analyze_motivational_spoken_clarity(
                    "unused.mp4",
                    candidates,
                    transcript,
                    SOURCE_HASH,
                    cache_dir,
                    audio_decoder=_silent_decoder,
                )
                self.assertEqual(factory.call_count, 1)
                self.assertEqual(runner.calls, 2)

            for item, interval in zip(first, ((0.0, 1.15), (5.0, 6.15))):
                self.assertIn("spokenClarityReport", item)
                self.assertEqual(
                    item["spoken_clarity_opening_asr_token_match_ratio"],
                    1.0,
                )
                verify_spoken_clarity_report(
                    item["spokenClarityReport"],
                    source_hash=SOURCE_HASH,
                    speech_interval=interval,
                )

            with patch(
                "shorts_generator.local.spoken_clarity."
                "_FasterWhisperOpeningClarityTranscriber"
            ) as warm_factory:
                second = analyze_motivational_spoken_clarity(
                    "unused.mp4",
                    candidates,
                    transcript,
                    SOURCE_HASH,
                    cache_dir,
                    audio_decoder=_silent_decoder,
                )
                warm_factory.assert_not_called()
            self.assertEqual(
                [item["spokenClarityReport"] for item in second],
                [item["spokenClarityReport"] for item in first],
            )


if __name__ == "__main__":
    unittest.main()
