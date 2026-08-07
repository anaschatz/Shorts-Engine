import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

import main as cli
from shorts_generator.pipeline import _run_api, _run_local, generate_shorts
from shorts_generator.profiles import (
    SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY,
    resolve_profile_bundle,
)
from shorts_generator.spoken_clarity import SPOKEN_CLARITY_DECISION_VERSION


class SelectOnlyTests(unittest.TestCase):
    def test_feed_stop_v3_runs_delivery_between_clarity_and_cleanliness(self):
        class CleanlinessReached(RuntimeError):
            pass

        transcript = {
            "duration": 12.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 9.0,
                    "text": "A clear opening becomes one complete strong point",
                    "words": [
                        {
                            "start": index * 0.5,
                            "end": index * 0.5 + 0.3,
                            "word": word,
                        }
                        for index, word in enumerate(
                            "A clear opening becomes one complete strong point".split()
                        )
                    ],
                }
            ],
        }
        candidate = {
            "start_time": 0.0,
            "end_time": 9.0,
            "speech_start_time": 0.0,
            "speech_end_time": 9.0,
            "title": "One point",
            "rejected": False,
            "rejection_reasons": [],
        }
        gate_order = []

        def analyze_clarity(_source, items, *_args, **_kwargs):
            gate_order.append("spoken_clarity")
            return [
                {**item, "spokenClarityReport": {"testMarker": "clarity"}}
                for item in items
            ]

        def analyze_delivery(_source, items, *_args, **_kwargs):
            self.assertTrue(items)
            self.assertEqual(
                items[0]["spokenClarityReport"]["testMarker"],
                "clarity",
            )
            gate_order.append("delivery_quality")
            return [
                {**item, "deliveryQualityReport": {"testMarker": "delivery"}}
                for item in items
            ]

        def analyze_cleanliness(_source, items, *_args, **_kwargs):
            self.assertTrue(items)
            self.assertEqual(
                items[0]["deliveryQualityReport"]["testMarker"],
                "delivery",
            )
            gate_order.append("speech_cleanliness")
            raise CleanlinessReached

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"delivery-quality-pipeline-order")
            with patch(
                "shorts_generator.local.downloader.download_youtube_local",
                return_value=str(source),
            ), patch(
                "shorts_generator.pipeline.get_highlights",
                return_value={
                    "highlights": [candidate],
                    "content_info": {"content_type": "motivational_podcast"},
                },
            ), patch(
                "shorts_generator.pipeline.rank_highlights",
                side_effect=lambda items, *_args, **_kwargs: [
                    dict(item) for item in items
                ],
            ), patch(
                "shorts_generator.local.spoken_clarity."
                "analyze_motivational_spoken_clarity",
                side_effect=analyze_clarity,
            ) as clarity, patch(
                "shorts_generator.local.delivery_quality."
                "analyze_motivational_delivery_quality",
                side_effect=analyze_delivery,
            ) as delivery, patch(
                "shorts_generator.local.speech_cleanliness."
                "analyze_motivational_speech_cleanliness",
                side_effect=analyze_cleanliness,
            ) as cleanliness:
                with self.assertRaises(CleanlinessReached):
                    _run_local(
                        "https://example.test/source",
                        1,
                        "9:16",
                        "1080",
                        "en",
                        resolve_profile_bundle(
                            format_profile="bf_feed_stop_format_v3"
                        ),
                        approved_transcript=transcript,
                        select_only=False,
                    )

        self.assertEqual(
            gate_order,
            ["spoken_clarity", "delivery_quality", "speech_cleanliness"],
        )
        clarity.assert_called_once()
        delivery.assert_called_once()
        cleanliness.assert_called_once()

    def test_api_selection_skips_renderer_and_returns_selected_candidates(self):
        transcript = {
            "duration": 60.0,
            "segments": [{"start": 0.0, "end": 12.0, "text": "A complete thought."}],
        }
        candidate = {
            "start_time": 0.0,
            "end_time": 12.0,
            "title": "One decision",
            "rejected": False,
            "rejection_reasons": [],
        }
        selected = [{**candidate, "output_rank": 1, "selected_for_render": True}]
        with patch(
            "shorts_generator.pipeline.download_youtube",
            return_value="https://cdn.example/source.mp4",
        ), patch(
            "shorts_generator.pipeline.transcribe",
            return_value=transcript,
        ), patch(
            "shorts_generator.pipeline.get_highlights",
            return_value={
                "highlights": [candidate],
                "content_info": {"content_type": "other"},
            },
        ) as discover, patch(
            "shorts_generator.pipeline.rank_highlights",
            return_value=[candidate],
        ), patch(
            "shorts_generator.pipeline.select_diverse_highlights",
            return_value=selected,
        ), patch("shorts_generator.pipeline.crop_highlights") as crop:
            result = _run_api(
                "https://example.test/source",
                1,
                "9:16",
                "720",
                "en",
                resolve_profile_bundle(),
                select_only=True,
            )

        crop.assert_not_called()
        self.assertTrue(discover.call_args.kwargs["allow_incomplete_batch"])
        self.assertEqual(result["shorts"], [])
        self.assertEqual(result["selected_candidates"], selected)
        self.assertTrue(result["ranking"]["selection_only"])
        self.assertEqual(result["ranking"]["rendered_count"], 0)

    def test_local_selection_only_requests_incomplete_candidate_evidence(self):
        class DiscoveryReached(RuntimeError):
            pass

        transcript = {
            "duration": 60.0,
            "segments": [
                {"start": 0.0, "end": 12.0, "text": "A complete thought."}
            ],
        }
        with patch(
            "shorts_generator.local.downloader.download_youtube_local",
            return_value="/tmp/source.mp4",
        ), patch(
            "shorts_generator.pipeline.get_highlights",
            side_effect=DiscoveryReached,
        ) as discover:
            with self.assertRaises(DiscoveryReached):
                _run_local(
                    "/tmp/source.mp4",
                    3,
                    "9:16",
                    "1080",
                    "en",
                    resolve_profile_bundle(
                        format_profile="bf_feed_stop_format_v1"
                    ),
                    approved_transcript=transcript,
                    select_only=True,
                )

        self.assertTrue(discover.call_args.kwargs["allow_incomplete_batch"])

    def test_approved_render_cannot_be_selection_only(self):
        with self.assertRaisesRegex(ValueError, "cannot use select_only"):
            generate_shorts(
                "/tmp/source.mp4",
                num_clips=1,
                mode="local",
                format_profile="bf_viral_micro_v1",
                approved_candidate_hash="a" * 64,
                approved_transcript={"duration": 12.0, "segments": []},
                select_only=True,
            )

    def test_feed_stop_selection_rejects_unclean_audio_before_visual_analysis(self):
        transcript = {
            "duration": 20.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 12.0,
                    "text": "A complete point with clean reference words",
                    "words": [
                        {
                            "start": index * 0.4,
                            "end": index * 0.4 + 0.25,
                            "word": word,
                        }
                        for index, word in enumerate(
                            "A complete point with clean reference words".split()
                        )
                    ],
                }
            ],
        }
        candidate = {
            "start_time": 0.0,
            "end_time": 12.0,
            "speech_start_time": 0.0,
            "speech_end_time": 12.0,
            "title": "One decision",
            "rejected": False,
            "rejection_reasons": [],
        }
        dirty = {
            **candidate,
            "speech_cleanliness_status": "reject",
            "speech_cleanliness_eligible": False,
            "speech_cleanliness_deterministic_reasons": [
                "repeated_audible_fillers"
            ],
        }

        def rank(items, *_args, require_speech_cleanliness=False, **_kwargs):
            return [
                {
                    **item,
                    "rejected": bool(require_speech_cleanliness),
                    "rejection_reasons": (
                        ["repeated_audible_fillers"]
                        if require_speech_cleanliness
                        else []
                    ),
                }
                for item in items
            ]

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"source-audio-fixture")
            output = Path(directory) / "output"
            cache = Path(directory) / "cache"
            with patch(
                "shorts_generator.local.downloader.download_youtube_local",
                return_value=str(source),
            ), patch(
                "shorts_generator.pipeline.get_highlights",
                return_value={
                    "highlights": [candidate],
                    "content_info": {"content_type": "motivational_podcast"},
                },
            ), patch(
                "shorts_generator.pipeline.rank_highlights",
                side_effect=rank,
            ), patch(
                "shorts_generator.local.spoken_clarity."
                "analyze_motivational_spoken_clarity",
                side_effect=lambda _source, items, *_args, **_kwargs: list(items),
            ) as analyze_clarity, patch(
                "shorts_generator.local.speech_cleanliness."
                "analyze_motivational_speech_cleanliness",
                return_value=[dirty],
            ) as analyze_audio, patch(
                "shorts_generator.local.visual_features."
                "analyze_motivational_editability",
                side_effect=lambda _source, items, **_kwargs: list(items),
            ) as analyze_visual, patch(
                "shorts_generator.config.LOCAL_OUTPUT_DIR",
                str(output),
            ), patch(
                "shorts_generator.config.LOCAL_CANDIDATE_CACHE_DIR",
                str(cache),
            ), patch(
                "shorts_generator.config.LOCAL_SHOT_CACHE_DIR",
                str(cache / "shots"),
            ):
                result = _run_local(
                    "https://example.test/source",
                    1,
                    "9:16",
                    "1080",
                    "en",
                    resolve_profile_bundle(
                        format_profile="bf_feed_stop_format_v1"
                    ),
                    approved_transcript=transcript,
                    select_only=True,
                )

        analyze_clarity.assert_not_called()
        analyze_audio.assert_called_once()
        self.assertEqual(analyze_visual.call_args.args[1], [])
        self.assertEqual(result["selected_candidates"], [])
        self.assertEqual(result["ranking"]["selected_count"], 0)
        self.assertEqual(result["ranking"]["rejected_count"], 1)
        self.assertIn(
            "repeated_audible_fillers",
            result["highlights"][0]["rejection_reasons"],
        )

    def test_feed_stop_select_only_analyzes_rejected_near_misses_for_diagnostics(self):
        transcript = {
            "duration": 24.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 20.0,
                    "text": "One clear point followed by another candidate point",
                    "words": [
                        {
                            "start": index * 0.5,
                            "end": index * 0.5 + 0.3,
                            "word": word,
                        }
                        for index, word in enumerate(
                            "One clear point followed by another candidate point".split()
                        )
                    ],
                }
            ],
        }
        eligible = {
            "start_time": 0.0,
            "end_time": 9.0,
            "speech_start_time": 0.0,
            "speech_end_time": 9.0,
            "title": "Eligible",
            "point_exact_quote": "One clear point",
            "rejected": False,
            "rejection_reasons": [],
        }
        near_miss = {
            "start_time": 10.0,
            "end_time": 19.0,
            "speech_start_time": 10.0,
            "speech_end_time": 19.0,
            "title": "Near miss",
            "point_exact_quote": "another candidate point",
            "rejected": True,
            "rejection_reasons": ["hook_v3_score_below_80"],
        }

        def rank(
            items,
            *_args,
            require_speech_cleanliness=False,
            expected_spoken_clarity_version=None,
            expected_spoken_clarity_provider_identity=None,
            **_kwargs,
        ):
            if expected_spoken_clarity_version is not None:
                self.assertEqual(
                    expected_spoken_clarity_version,
                    SPOKEN_CLARITY_DECISION_VERSION,
                )
                self.assertEqual(
                    expected_spoken_clarity_provider_identity,
                    SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY,
                )
            ranked = []
            for raw in items:
                item = dict(raw)
                reasons = list(item.get("rejection_reasons") or [])
                if (
                    expected_spoken_clarity_version
                    and item.get("spoken_clarity_status") != "pass"
                ):
                    reasons.extend(
                        item.get("spoken_clarity_deterministic_reasons")
                        or ["spoken_clarity_evidence_missing"]
                    )
                if (
                    require_speech_cleanliness
                    and item.get("speech_cleanliness_status") != "pass"
                ):
                    reasons.extend(
                        item.get("speech_cleanliness_deterministic_reasons")
                        or ["speech_cleanliness_evidence_missing"]
                    )
                item["rejection_reasons"] = list(dict.fromkeys(reasons))
                item["rejected"] = bool(item["rejection_reasons"])
                ranked.append(item)
            return ranked

        def analyze_clarity(_source, items, *_args, **_kwargs):
            return [
                {
                    **item,
                    "spokenClarityReport": {
                        "artifactType": "SpokenClarityReport",
                        "diagnosticTitle": item["title"],
                    },
                    "spoken_clarity_status": "pass",
                    "spoken_clarity_eligible": True,
                    "spoken_clarity_deterministic_reasons": [],
                }
                for item in items
            ]

        def analyze_audio(_source, items, *_args, **_kwargs):
            return [
                {
                    **item,
                    "speech_cleanliness_status": "pass",
                    "speech_cleanliness_eligible": True,
                    "speech_cleanliness_deterministic_reasons": [],
                }
                for item in items
            ]

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"spoken-clarity-diagnostic-source")
            output = Path(directory) / "output"
            cache = Path(directory) / "cache"
            with patch(
                "shorts_generator.local.downloader.download_youtube_local",
                return_value=str(source),
            ), patch(
                "shorts_generator.pipeline.get_highlights",
                return_value={
                    "highlights": [eligible, near_miss],
                    "content_info": {"content_type": "motivational_podcast"},
                },
            ), patch(
                "shorts_generator.pipeline.rank_highlights",
                side_effect=rank,
            ), patch(
                "shorts_generator.local.spoken_clarity."
                "analyze_motivational_spoken_clarity",
                side_effect=analyze_clarity,
            ) as clarity, patch(
                "shorts_generator.local.speech_cleanliness."
                "analyze_motivational_speech_cleanliness",
                side_effect=analyze_audio,
            ) as audio, patch(
                "shorts_generator.local.visual_features."
                "analyze_motivational_editability",
                side_effect=lambda _source, items, **_kwargs: list(items),
            ), patch(
                "shorts_generator.pipeline.select_diverse_highlights",
                side_effect=lambda items, limit: [
                    dict(item) for item in items if not item.get("rejected")
                ][:limit],
            ), patch(
                "shorts_generator.pipeline._render_direct_local_batch_with_cache"
            ) as renderer, patch(
                "shorts_generator.config.LOCAL_OUTPUT_DIR",
                str(output),
            ), patch(
                "shorts_generator.config.LOCAL_CANDIDATE_CACHE_DIR",
                str(cache),
            ), patch(
                "shorts_generator.config.LOCAL_SHOT_CACHE_DIR",
                str(cache / "shots"),
            ):
                result = _run_local(
                    "https://example.test/source",
                    1,
                    "9:16",
                    "1080",
                    "en",
                    resolve_profile_bundle(
                        format_profile="bf_feed_stop_format_v2"
                    ),
                    approved_transcript=transcript,
                    select_only=True,
                )

            persisted = json.loads(
                Path(result["ranking"]["manifest_path"]).read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(
            [item["title"] for item in clarity.call_args.args[1]],
            ["Eligible", "Near miss"],
        )
        self.assertEqual(
            [item["title"] for item in audio.call_args.args[1]],
            ["Eligible"],
        )
        self.assertEqual(len(result["highlights"]), 2)
        self.assertEqual(len(persisted["candidates"]), 2)
        persisted_near_miss = next(
            item
            for item in persisted["candidates"]
            if item["title"] == "Near miss"
        )
        self.assertEqual(
            persisted_near_miss["spokenClarityReport"]["diagnosticTitle"],
            "Near miss",
        )
        self.assertEqual(
            persisted_near_miss["spoken_clarity_status"],
            "pass",
        )
        renderer.assert_not_called()

    def test_feed_stop_production_analyzes_only_semantic_eligible_candidates(self):
        class AudioAnalysisReached(RuntimeError):
            pass

        transcript = {
            "duration": 24.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 20.0,
                    "text": "One eligible point and one rejected point",
                }
            ],
        }
        highlights = [
            {
                "start_time": 0.0,
                "end_time": 9.0,
                "title": "Eligible",
                "rejected": False,
                "rejection_reasons": [],
            },
            {
                "start_time": 10.0,
                "end_time": 19.0,
                "title": "Rejected",
                "rejected": True,
                "rejection_reasons": ["hook_v3_score_below_80"],
            },
        ]

        def semantic_rank(items, *_args, **_kwargs):
            return [
                {
                    **item,
                    "rejected": index == 1,
                    "rejection_reasons": (
                        ["hook_v3_score_below_80"] if index == 1 else []
                    ),
                }
                for index, item in enumerate(items)
            ]

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"spoken-clarity-production-source")
            with patch(
                "shorts_generator.local.downloader.download_youtube_local",
                return_value=str(source),
            ), patch(
                "shorts_generator.pipeline.get_highlights",
                return_value={
                    "highlights": highlights,
                    "content_info": {"content_type": "motivational_podcast"},
                },
            ), patch(
                "shorts_generator.pipeline.rank_highlights",
                side_effect=semantic_rank,
            ), patch(
                "shorts_generator.local.spoken_clarity."
                "analyze_motivational_spoken_clarity",
                side_effect=lambda _source, items, *_args, **_kwargs: [
                    {
                        **item,
                        "spoken_clarity_status": "pass",
                        "spoken_clarity_eligible": True,
                    }
                    for item in items
                ],
            ) as clarity, patch(
                "shorts_generator.local.speech_cleanliness."
                "analyze_motivational_speech_cleanliness",
                side_effect=AudioAnalysisReached,
            ) as audio:
                with self.assertRaises(AudioAnalysisReached):
                    _run_local(
                        "https://example.test/source",
                        1,
                        "9:16",
                        "1080",
                        "en",
                        resolve_profile_bundle(
                            format_profile="bf_feed_stop_format_v2"
                        ),
                        approved_transcript=transcript,
                        select_only=False,
                    )

        self.assertEqual(
            [item["title"] for item in clarity.call_args.args[1]],
            ["Eligible"],
        )
        self.assertEqual(
            [item["title"] for item in audio.call_args.args[1]],
            ["Eligible"],
        )

    def test_feed_stop_spoken_clarity_provider_failure_selects_zero(self):
        transcript = {
            "duration": 16.0,
            "segments": [
                {
                    "start": 0.0,
                    "end": 12.0,
                    "text": "A complete point with enough reference words",
                    "words": [
                        {
                            "start": index * 0.5,
                            "end": index * 0.5 + 0.3,
                            "word": word,
                        }
                        for index, word in enumerate(
                            "A complete point with enough reference words".split()
                        )
                    ],
                }
            ],
        }
        candidate = {
            "start_time": 0.0,
            "end_time": 9.0,
            "speech_start_time": 0.0,
            "speech_end_time": 9.0,
            "title": "Provider failure",
            "rejected": False,
            "rejection_reasons": [],
        }

        def rank(
            items,
            *_args,
            require_speech_cleanliness=False,
            expected_spoken_clarity_version=None,
            expected_spoken_clarity_provider_identity=None,
            **_kwargs,
        ):
            if expected_spoken_clarity_version is not None:
                self.assertEqual(
                    expected_spoken_clarity_version,
                    SPOKEN_CLARITY_DECISION_VERSION,
                )
                self.assertEqual(
                    expected_spoken_clarity_provider_identity,
                    SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY,
                )
            output = []
            for raw in items:
                item = dict(raw)
                reasons = list(item.get("rejection_reasons") or [])
                if (
                    expected_spoken_clarity_version
                    and item.get("spoken_clarity_status") != "pass"
                ):
                    reasons.extend(
                        item.get("spoken_clarity_deterministic_reasons")
                        or ["spoken_clarity_evidence_missing"]
                    )
                if (
                    require_speech_cleanliness
                    and item.get("speech_cleanliness_status") != "pass"
                ):
                    reasons.extend(
                        item.get("speech_cleanliness_deterministic_reasons")
                        or ["speech_cleanliness_evidence_missing"]
                    )
                item["rejection_reasons"] = list(dict.fromkeys(reasons))
                item["rejected"] = bool(item["rejection_reasons"])
                output.append(item)
            return output

        failed_report = {
            "artifactType": "SpokenClarityReport",
            "providerStatus": "clarity_transcriber_error",
        }
        failed = {
            **candidate,
            "spokenClarityReport": failed_report,
            "spoken_clarity_status": "review",
            "spoken_clarity_eligible": False,
            "spoken_clarity_deterministic_reasons": [
                "spoken_clarity_provider_not_ok"
            ],
        }
        speech_pass = {
            **failed,
            "speech_cleanliness_status": "pass",
            "speech_cleanliness_eligible": True,
            "speech_cleanliness_deterministic_reasons": [],
        }

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"spoken-clarity-provider-failure")
            output = Path(directory) / "output"
            cache = Path(directory) / "cache"
            with patch(
                "shorts_generator.local.downloader.download_youtube_local",
                return_value=str(source),
            ), patch(
                "shorts_generator.pipeline.get_highlights",
                return_value={
                    "highlights": [candidate],
                    "content_info": {"content_type": "motivational_podcast"},
                },
            ), patch(
                "shorts_generator.pipeline.rank_highlights",
                side_effect=rank,
            ), patch(
                "shorts_generator.local.spoken_clarity."
                "analyze_motivational_spoken_clarity",
                return_value=[failed],
            ), patch(
                "shorts_generator.local.speech_cleanliness."
                "analyze_motivational_speech_cleanliness",
                return_value=[speech_pass],
            ), patch(
                "shorts_generator.local.visual_features."
                "analyze_motivational_editability",
                side_effect=lambda _source, items, **_kwargs: list(items),
            ) as visual, patch(
                "shorts_generator.pipeline.select_diverse_highlights",
                side_effect=lambda items, limit: [
                    dict(item) for item in items if not item.get("rejected")
                ][:limit],
            ), patch(
                "shorts_generator.pipeline._render_direct_local_batch_with_cache"
            ) as renderer, patch(
                "shorts_generator.config.LOCAL_OUTPUT_DIR",
                str(output),
            ), patch(
                "shorts_generator.config.LOCAL_CANDIDATE_CACHE_DIR",
                str(cache),
            ), patch(
                "shorts_generator.config.LOCAL_SHOT_CACHE_DIR",
                str(cache / "shots"),
            ):
                result = _run_local(
                    "https://example.test/source",
                    1,
                    "9:16",
                    "1080",
                    "en",
                    resolve_profile_bundle(
                        format_profile="bf_feed_stop_format_v2"
                    ),
                    approved_transcript=transcript,
                    select_only=True,
                )

        self.assertEqual(result["selected_candidates"], [])
        self.assertEqual(result["ranking"]["selected_count"], 0)
        self.assertEqual(result["ranking"]["rejected_count"], 1)
        self.assertEqual(
            result["highlights"][0]["spokenClarityReport"],
            failed_report,
        )
        self.assertIn(
            "spoken_clarity_provider_not_ok",
            result["highlights"][0]["rejection_reasons"],
        )
        self.assertEqual(visual.call_args.args[1], [])
        renderer.assert_not_called()

    def test_legacy_local_selection_does_not_invoke_spoken_clarity(self):
        transcript = {
            "duration": 16.0,
            "segments": [
                {"start": 0.0, "end": 10.0, "text": "A complete legacy point"}
            ],
        }
        candidate = {
            "start_time": 0.0,
            "end_time": 10.0,
            "title": "Legacy",
            "rejected": False,
            "rejection_reasons": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"legacy-selection-source")
            output = Path(directory) / "output"
            cache = Path(directory) / "cache"
            with patch(
                "shorts_generator.local.downloader.download_youtube_local",
                return_value=str(source),
            ), patch(
                "shorts_generator.pipeline.get_highlights",
                return_value={
                    "highlights": [candidate],
                    "content_info": {"content_type": "motivational_podcast"},
                },
            ), patch(
                "shorts_generator.pipeline.rank_highlights",
                side_effect=lambda items, *_args, **_kwargs: [
                    dict(item) for item in items
                ],
            ), patch(
                "shorts_generator.local.spoken_clarity."
                "analyze_motivational_spoken_clarity",
            ) as clarity, patch(
                "shorts_generator.local.speech_cleanliness."
                "analyze_motivational_speech_cleanliness",
            ) as audio, patch(
                "shorts_generator.local.visual_features."
                "analyze_motivational_editability",
                side_effect=lambda _source, items, **_kwargs: list(items),
            ), patch(
                "shorts_generator.pipeline.select_diverse_highlights",
                side_effect=lambda items, limit: [dict(item) for item in items][
                    :limit
                ],
            ), patch(
                "shorts_generator.config.LOCAL_OUTPUT_DIR",
                str(output),
            ), patch(
                "shorts_generator.config.LOCAL_CANDIDATE_CACHE_DIR",
                str(cache),
            ), patch(
                "shorts_generator.config.LOCAL_SHOT_CACHE_DIR",
                str(cache / "shots"),
            ):
                result = _run_local(
                    "https://example.test/source",
                    1,
                    "9:16",
                    "1080",
                    "en",
                    resolve_profile_bundle(
                        format_profile="bf_viral_micro_v1"
                    ),
                    approved_transcript=transcript,
                    select_only=True,
                )

        clarity.assert_not_called()
        audio.assert_not_called()
        self.assertEqual(result["ranking"]["selected_count"], 1)

    def test_selection_only_persists_an_empty_selection_instead_of_rendering(self):
        transcript = {
            "duration": 60.0,
            "segments": [{"start": 0.0, "end": 30.0, "text": "An incomplete thought."}],
        }
        rejected = {
            "start_time": 0.0,
            "end_time": 30.0,
            "rejected": True,
            "rejection_reasons": ["micro_duration_over_22s"],
        }
        with patch(
            "shorts_generator.pipeline.download_youtube",
            return_value="https://cdn.example/source.mp4",
        ), patch(
            "shorts_generator.pipeline.transcribe",
            return_value=transcript,
        ), patch(
            "shorts_generator.pipeline.get_highlights",
            return_value={
                "highlights": [rejected],
                "content_info": {"content_type": "other"},
            },
        ), patch(
            "shorts_generator.pipeline.rank_highlights",
            return_value=[rejected],
        ), patch(
            "shorts_generator.pipeline.select_diverse_highlights",
            return_value=[],
        ), patch("shorts_generator.pipeline.crop_highlights") as crop:
            result = _run_api(
                "https://example.test/source",
                1,
                "9:16",
                "720",
                "en",
                resolve_profile_bundle(),
                select_only=True,
            )

        crop.assert_not_called()
        self.assertEqual(result["selected_candidates"], [])
        self.assertEqual(result["shorts"], [])
        self.assertEqual(result["ranking"]["selected_count"], 0)
        self.assertEqual(result["ranking"]["rejected_count"], 1)

    def test_cli_blocks_selection_only_upload_before_running_pipeline(self):
        argv = [
            "main.py",
            "/tmp/source.mp4",
            "--select-only",
            "--upload-youtube",
        ]
        with patch.object(sys, "argv", argv), patch.object(
            cli,
            "generate_shorts",
        ) as generate, redirect_stderr(io.StringIO()) as errors:
            exit_code = cli.main()

        self.assertEqual(exit_code, 1)
        generate.assert_not_called()
        self.assertIn("cannot be combined", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
