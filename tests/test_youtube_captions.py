import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from shorts_generator.local.youtube_captions import (
    _caption_quality,
    _fetch_caption_json3,
    _select_caption_track,
    parse_json3_transcript,
    transcribe_youtube_captions,
)
from shorts_generator.performance import PerformanceTelemetry


def json3_payload(word_count=24):
    segments = []
    offset = 0
    for index in range(word_count):
        segments.append(
            {
                "utf8": ("word" if index == 0 else f" word{index}"),
                "tOffsetMs": offset,
            }
        )
        offset += 180
    return {
        "events": [
            {"tStartMs": 0, "dDurationMs": 9000, "segs": segments},
            {"tStartMs": 4500, "dDurationMs": 1000, "aAppend": 1, "segs": [{"utf8": "\n"}]},
        ]
    }


class YoutubeCaptionTranscriptTests(unittest.TestCase):
    def test_fetch_reuses_successful_download_info_without_extracting_again(self):
        payload = json.dumps(json3_payload()).encode("utf-8")

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return payload

        class FakeYoutubeDL:
            extract_calls = 0

            def __init__(self, _options):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extract_info(self, *_args, **_kwargs):
                type(self).extract_calls += 1
                raise AssertionError("the successful download info should be reused")

            def urlopen(self, url):
                self.assertEqual(url, "caption-json3")
                return Response()

            def assertEqual(self, left, right):
                if left != right:
                    raise AssertionError(f"{left!r} != {right!r}")

        fake_module = type("FakeYtDlp", (), {"YoutubeDL": FakeYoutubeDL})
        video_info = {
            "language": "en",
            "automatic_captions": {
                "en-orig": [{"ext": "json3", "url": "caption-json3"}],
            },
        }

        with mock.patch(
            "shorts_generator.local.youtube_captions._import_ytdlp",
            return_value=fake_module,
        ):
            fetched = _fetch_caption_json3(
                "https://www.youtube.com/watch?v=abcdefghijk",
                None,
                video_info=video_info,
            )

        self.assertEqual(fetched, (payload, "en-orig", "automatic_captions"))
        self.assertEqual(FakeYoutubeDL.extract_calls, 0)

    def test_json3_parser_produces_positive_word_timings_and_ignores_newlines(self):
        transcript = parse_json3_transcript(json3_payload(), media_duration=12.0)

        self.assertEqual(transcript["duration"], 12.0)
        self.assertEqual(len(transcript["segments"]), 1)
        words = transcript["segments"][0]["words"]
        self.assertEqual(len(words), 24)
        self.assertEqual(words[0]["word"], "word")
        self.assertTrue(all(word["end"] > word["start"] for word in words))
        self.assertLessEqual(words[-1]["end"], 9.0)
        self.assertEqual(_caption_quality(transcript), (True, "ok"))

    def test_json3_parser_drops_caption_cues_not_spoken_words(self):
        payload = json3_payload()
        payload["events"].append(
            {
                "tStartMs": 6000,
                "dDurationMs": 1000,
                "segs": [
                    {"utf8": ">>"},
                    {"utf8": " [Music]", "tOffsetMs": 100},
                    {"utf8": " Actual", "tOffsetMs": 200},
                    {"utf8": " speech", "tOffsetMs": 400},
                ],
            }
        )

        transcript = parse_json3_transcript(payload, media_duration=12.0)
        tokens = [word["word"] for segment in transcript["segments"] for word in segment["words"]]

        self.assertNotIn(">>", tokens)
        self.assertNotIn("[Music]", tokens)
        self.assertIn("Actual", tokens)
        self.assertIn("speech", tokens)

    def test_track_selection_prefers_word_timed_original_auto_then_manual(self):
        info = {
            "language": "en",
            "subtitles": {
                "en": [{"ext": "json3", "url": "manual"}],
            },
            "automatic_captions": {
                "en-orig": [{"ext": "json3", "url": "auto-original"}],
                "el": [{"ext": "json3", "url": "translated"}],
            },
        }
        source, language, selected = _select_caption_track(info, "en")
        self.assertEqual(
            (source, language, selected["url"]),
            ("automatic_captions", "en-orig", "auto-original"),
        )

        info["automatic_captions"] = {"el": info["automatic_captions"]["el"]}
        source, language, selected = _select_caption_track(info, "en")
        self.assertEqual(
            (source, language, selected["url"]),
            ("subtitles", "en", "manual"),
        )

    def test_fetch_is_cached_and_second_run_avoids_network(self):
        telemetry = PerformanceTelemetry(run_id="youtube-caption-cache")
        fetched = (json.dumps(json3_payload()).encode("utf-8"), "en-orig", "automatic_captions")
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch(
                "shorts_generator.local.youtube_captions._fetch_caption_json3",
                return_value=fetched,
            ) as fetch:
                first = transcribe_youtube_captions(
                    "https://www.youtube.com/watch?v=abcdefghijk",
                    None,
                    telemetry=telemetry,
                    cache_dir=directory,
                )
                second = transcribe_youtube_captions(
                    "https://www.youtube.com/watch?v=abcdefghijk",
                    None,
                    telemetry=telemetry,
                    cache_dir=directory,
                )

        self.assertEqual(first, second)
        self.assertEqual(fetch.call_count, 1)
        counters = telemetry.finish()["cacheCounters"]["youtube_captions"]
        self.assertEqual(counters["misses"], 1)
        self.assertEqual(counters["hits"], 1)

    def test_stale_download_caption_url_retries_live_metadata_before_whisper(self):
        fetched = (
            json.dumps(json3_payload()).encode("utf-8"),
            "en-orig",
            "automatic_captions",
        )
        with tempfile.TemporaryDirectory() as directory, mock.patch(
            "shorts_generator.local.youtube_captions._fetch_caption_json3",
            side_effect=(RuntimeError("expired signed URL"), fetched),
        ) as fetch:
            transcript = transcribe_youtube_captions(
                "https://www.youtube.com/watch?v=abcdefghijk",
                None,
                cache_dir=directory,
                video_info={"automatic_captions": {}},
            )

        self.assertIsNotNone(transcript)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(fetch.call_args_list[0].kwargs["video_info"], {
            "automatic_captions": {},
        })
        self.assertEqual(fetch.call_args_list[1].args, (
            "https://www.youtube.com/watch?v=abcdefghijk",
            None,
        ))

    def test_sparse_caption_track_returns_none_for_whisper_fallback(self):
        sparse = json3_payload(word_count=2)
        with tempfile.TemporaryDirectory() as directory, mock.patch(
            "shorts_generator.local.youtube_captions._fetch_caption_json3",
            return_value=(json.dumps(sparse).encode("utf-8"), "en", "subtitles"),
        ):
            result = transcribe_youtube_captions(
                "https://youtu.be/abcdefghijk",
                None,
                cache_dir=directory,
            )
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
