import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import shorts_generator.config as config
import shorts_generator.local.clipper as local_clipper
import shorts_generator.local.downloader as local_downloader
import shorts_generator.local.transcriber as local_transcriber
import shorts_generator.local.visual_features as local_visual_features
from shorts_generator.artifact_contracts import candidate_hash, file_sha256
from shorts_generator.performance import PerformanceTelemetry
from shorts_generator.pipeline import (
    _direct_local_render_plan_hash,
    _render_direct_local_batch_with_cache,
    _run_local,
)
from shorts_generator.profiles import BF_EDITORIAL_INSET_V1, resolve_profile_bundle
from shorts_generator.render_cache import RenderCache


def _transcript(word="truth"):
    return {
        "duration": 20.0,
        "segments": [
            {
                "start": 1.0,
                "end": 11.4,
                "text": f"Good people tell the {word}.",
                "words": [
                    {"start": 1.0, "end": 1.3, "word": "Good"},
                    {"start": 1.3, "end": 1.7, "word": "people"},
                    {"start": 1.7, "end": 2.0, "word": "tell"},
                    {"start": 2.0, "end": 2.2, "word": "the"},
                    {"start": 2.2, "end": 2.7, "word": f"{word}."},
                ],
            }
        ],
    }


def _candidate(source_hash, ordinal=1, **changes):
    body = {
        "title": f"Candidate {ordinal}",
        "topic": "telling the truth",
        "hook_sentence": "Good people tell the truth.",
        "final_takeaway_sentence": "Tell the truth.",
        "start_time": float(ordinal),
        "end_time": float(ordinal) + 10.75,
        "speech_start_time": float(ordinal),
        "speech_end_time": float(ordinal) + 10.4,
        "source_cut_count": 0,
        "source_scene_change_times": [],
        "content_profile": "motivational_podcast",
        "selection_profile": "motivational_tension_micro_v1",
        "render_profile": BF_EDITORIAL_INSET_V1,
        "format_profile": "bf_viral_micro_v1",
        "background_music": False,
        "rejected": False,
        "rejection_reasons": [],
        "selected_for_render": True,
        "output_rank": ordinal,
    }
    body.update(changes)
    return {**body, "candidate_hash": candidate_hash(body, source_hash)}


def _render_metadata():
    return {
        "render_profile": BF_EDITORIAL_INSET_V1,
        "layout_profile": "editorial_inset",
        "grade_profile": "high_contrast_grayscale_v1",
        "typography_profile": "kinetic_editorial_v1",
        "brand_tail_profile": "bf_reference_tail_v2",
        "brand_tail_seconds": 1.25,
        "brand_tail_start_seconds": 10.7,
        "brand_tail_clearance_seconds": 0.3,
        "semantic_end_seconds": 10.4,
        "first_visible_text_seconds": 0.0,
        "max_hero_scale": 2.2,
        "render_timeline_events": [],
        "type_plan_summary": {},
    }


class DirectRenderPlanIdentityTests(unittest.TestCase):
    def test_plan_hash_binds_candidate_transcript_and_aspect_but_not_batch_rank(self):
        source_hash = "a" * 64
        profiles = resolve_profile_bundle(format_profile="bf_viral_micro_v1")
        candidate = _candidate(source_hash)
        first = _direct_local_render_plan_hash(
            candidate,
            _transcript(),
            source_hash,
            "9:16",
            profiles,
        )

        reranked = {**candidate, "output_rank": 7}
        self.assertEqual(
            first,
            _direct_local_render_plan_hash(
                reranked,
                _transcript(),
                source_hash,
                "9:16",
                profiles,
            ),
        )
        self.assertNotEqual(
            first,
            _direct_local_render_plan_hash(
                candidate,
                _transcript("facts"),
                source_hash,
                "9:16",
                profiles,
            ),
        )
        changed = _candidate(source_hash, title="A changed caption context")
        self.assertNotEqual(
            first,
            _direct_local_render_plan_hash(
                changed,
                _transcript(),
                source_hash,
                "9:16",
                profiles,
            ),
        )
        self.assertNotEqual(
            first,
            _direct_local_render_plan_hash(
                candidate,
                _transcript(),
                source_hash,
                "1:1",
                profiles,
            ),
        )


class DirectRenderBatchCacheTests(unittest.TestCase):
    def test_full_hit_does_not_wait_for_speculative_opencv_warmup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            source_hash = file_sha256(str(source))
            profiles = resolve_profile_bundle(format_profile="bf_viral_micro_v1")
            candidate = _candidate(source_hash)
            cache = RenderCache(root / "cache")
            cached_mp4 = root / "cached.mp4"
            cached_mp4.write_bytes(b"cached-render")
            cache.store(
                candidate["candidate_hash"],
                cached_mp4,
                metadata={"short": {**candidate, **_render_metadata()}},
            )
            warmup = Mock()

            with (
                patch(
                    "shorts_generator.pipeline._direct_local_render_cache_identity",
                    return_value=(cache, candidate["candidate_hash"]),
                ),
                patch.object(local_clipper, "crop_highlights_local") as renderer,
            ):
                [short], writes = _render_direct_local_batch_with_cache(
                    str(source),
                    [candidate],
                    "9:16",
                    _transcript(),
                    profiles,
                    source_hash,
                    str(root / "staging"),
                    None,
                    opencv_warmup=warmup,
                )

            self.assertTrue(short["render_cache_hit"])
            self.assertEqual(writes, [])
            warmup.wait.assert_not_called()
            renderer.assert_not_called()

    def test_failed_warmup_is_advisory_until_real_renderer_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            source_hash = file_sha256(str(source))
            profiles = resolve_profile_bundle(format_profile="bf_viral_micro_v1")
            candidate = _candidate(source_hash)
            warmup = Mock()
            warmup.wait.side_effect = RuntimeError("synthetic warm-up failure")

            def render(_source, highlights, *, out_dir, **_kwargs):
                output = Path(out_dir) / "short_01.mp4"
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(b"rendered-after-warmup-failure")
                return [
                    {
                        **highlights[0],
                        **_render_metadata(),
                        "clip_url": str(output),
                    }
                ]

            with (
                patch(
                    "shorts_generator.pipeline._direct_local_render_cache_identity",
                    return_value=(None, None),
                ),
                patch.object(
                    local_clipper,
                    "crop_highlights_local",
                    side_effect=render,
                ) as renderer,
            ):
                [short], writes = _render_direct_local_batch_with_cache(
                    str(source),
                    [candidate],
                    "9:16",
                    _transcript(),
                    profiles,
                    source_hash,
                    str(root / "staging"),
                    None,
                    opencv_warmup=warmup,
                )

            renderer.assert_called_once()
            warmup.wait.assert_called_once()
            self.assertEqual(writes, [])
            self.assertTrue(Path(short["clip_url"]).is_file())

    def test_partial_hit_renders_only_miss_and_preserves_output_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            source_hash = file_sha256(str(source))
            profiles = resolve_profile_bundle(format_profile="bf_viral_micro_v1")
            candidates = [_candidate(source_hash, 1), _candidate(source_hash, 2)]
            cache = RenderCache(root / "cache")
            cached_mp4 = root / "cached.mp4"
            cached_mp4.write_bytes(b"cached-first")
            cache.store(
                candidates[0]["candidate_hash"],
                cached_mp4,
                metadata={
                    "short": {
                        **candidates[0],
                        **_render_metadata(),
                        "output_rank": 99,
                    }
                },
            )

            rendered_candidates = []

            def render(_source, highlights, *, out_dir, **_kwargs):
                rendered_candidates.extend(highlights)
                output = Path(out_dir) / "short_01.mp4"
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(b"rendered-second")
                return [{**highlights[0], **_render_metadata(), "clip_url": str(output)}]

            telemetry = PerformanceTelemetry()
            with (
                patch(
                    "shorts_generator.pipeline._direct_local_render_cache_identity",
                    side_effect=lambda candidate, *_args: (
                        cache,
                        candidate["candidate_hash"],
                    ),
                ),
                patch.object(local_clipper, "crop_highlights_local", side_effect=render),
            ):
                shorts, writes = _render_direct_local_batch_with_cache(
                    str(source),
                    candidates,
                    "9:16",
                    _transcript(),
                    profiles,
                    source_hash,
                    str(root / "staging"),
                    telemetry,
                )

            self.assertEqual([item["title"] for item in shorts], ["Candidate 1", "Candidate 2"])
            self.assertEqual([item["output_rank"] for item in shorts], [1, 2])
            self.assertTrue(shorts[0]["render_cache_hit"])
            self.assertFalse(shorts[1]["render_cache_hit"])
            self.assertEqual(
                [item["candidate_hash"] for item in rendered_candidates],
                [candidates[1]["candidate_hash"]],
            )
            self.assertEqual([job["index"] for job in writes], [1])
            counters = telemetry.snapshot()["cacheCounters"]["local_render"]
            self.assertEqual((counters["hits"], counters["misses"]), (1, 1))

    def test_corrupt_hit_falls_back_to_renderer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"source")
            source_hash = file_sha256(str(source))
            profiles = resolve_profile_bundle(format_profile="bf_viral_micro_v1")
            candidate = _candidate(source_hash)
            cache = RenderCache(root / "cache")
            cached_mp4 = root / "cached.mp4"
            cached_mp4.write_bytes(b"cached")
            entry = cache.store(
                candidate["candidate_hash"],
                cached_mp4,
                metadata={"short": {**candidate, **_render_metadata()}},
            )
            entry.cached_path.write_bytes(b"corrupt")

            def render(_source, highlights, *, out_dir, **_kwargs):
                output = Path(out_dir) / "short_01.mp4"
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(b"rerendered")
                return [{**highlights[0], **_render_metadata(), "clip_url": str(output)}]

            with (
                patch(
                    "shorts_generator.pipeline._direct_local_render_cache_identity",
                    return_value=(cache, candidate["candidate_hash"]),
                ),
                patch.object(
                    local_clipper,
                    "crop_highlights_local",
                    side_effect=render,
                ) as renderer,
            ):
                [short], writes = _render_direct_local_batch_with_cache(
                    str(source),
                    [candidate],
                    "9:16",
                    _transcript(),
                    profiles,
                    source_hash,
                    str(root / "staging"),
                    None,
                )

            renderer.assert_called_once()
            self.assertFalse(short["render_cache_hit"])
            self.assertEqual(len(writes), 1)


class DirectLocalPipelineCacheIntegrationTests(unittest.TestCase):
    def test_failed_qa_is_not_cached_and_cache_hit_still_reruns_qa(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output_dir = root / "output"
            cache = RenderCache(root / "render-cache")
            source = root / "source.mp4"
            source.write_bytes(b"source-video")
            transcript = _transcript()
            profiles = resolve_profile_bundle(format_profile="bf_viral_micro_v1")
            generated_candidate = {
                key: value
                for key, value in _candidate(file_sha256(str(source))).items()
                if key
                not in {
                    "candidate_hash",
                    "content_profile",
                    "selection_profile",
                    "render_profile",
                    "format_profile",
                    "background_music",
                    "selected_for_render",
                    "output_rank",
                }
            }

            def get_highlights_result(*_args, **_kwargs):
                return {
                    "highlights": [copy.deepcopy(generated_candidate)],
                    "content_info": {"content_type": "motivational_podcast"},
                }

            def rank(items, *_args, **_kwargs):
                return [
                    {**item, "rejected": False, "rejection_reasons": []}
                    for item in items
                ]

            def select(items, limit):
                return [
                    {
                        **item,
                        "selected_for_render": True,
                        "output_rank": index,
                    }
                    for index, item in enumerate(items[:limit], start=1)
                ]

            def render(_source, highlights, *, out_dir, **_kwargs):
                output = Path(out_dir) / "short_01.mp4"
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(b"exact-render")
                return [{**highlights[0], **_render_metadata(), "clip_url": str(output)}]

            def cut_metrics(shorts):
                return [
                    {
                        **short,
                        "artificial_cut_count": 0,
                        "artificial_cut_guardrail_pass": True,
                    }
                    for short in shorts
                ]

            failed_qa = {
                "passed": False,
                "gates": [{"code": "synthetic", "passed": False}],
            }
            passed_qa = {"passed": True, "gates": []}

            with (
                patch.object(config, "LOCAL_YOUTUBE_CAPTIONS", False),
                patch.object(config, "LOCAL_OUTPUT_DIR", str(output_dir)),
                patch.object(local_downloader, "download_youtube_local", return_value=str(source)),
                patch.object(local_transcriber, "transcribe_local", side_effect=lambda *_a, **_k: copy.deepcopy(transcript)),
                patch(
                    "shorts_generator.pipeline.get_highlights",
                    side_effect=get_highlights_result,
                ),
                patch("shorts_generator.pipeline.rank_highlights", side_effect=rank),
                patch("shorts_generator.pipeline.select_diverse_highlights", side_effect=select),
                patch.object(
                    local_visual_features,
                    "analyze_motivational_editability",
                    side_effect=lambda _source, items, **_kwargs: items,
                ),
                patch.object(
                    local_visual_features,
                    "analyze_rendered_cut_metrics",
                    side_effect=cut_metrics,
                ) as analyze_cuts,
                patch.object(local_clipper, "crop_highlights_local", side_effect=render) as renderer,
                patch(
                    "shorts_generator.pipeline._direct_local_render_cache_identity",
                    side_effect=lambda candidate, *_args: (
                        cache,
                        candidate["candidate_hash"],
                    ),
                ),
                patch(
                    "shorts_generator.pipeline.evaluate_editorial_render",
                    side_effect=[failed_qa, passed_qa, passed_qa],
                ) as qa,
            ):
                with self.assertRaisesRegex(RuntimeError, "Editorial render QA failed"):
                    _run_local(
                        "file://source.mp4",
                        1,
                        "9:16",
                        "720",
                        None,
                        profiles,
                    )
                first_success = _run_local(
                    "file://source.mp4",
                    1,
                    "9:16",
                    "720",
                    None,
                    profiles,
                )
                cached_success = _run_local(
                    "file://source.mp4",
                    1,
                    "9:16",
                    "720",
                    None,
                    profiles,
                )

            self.assertFalse(first_success["shorts"][0]["render_cache_hit"])
            self.assertTrue(cached_success["shorts"][0]["render_cache_hit"])
            self.assertEqual(renderer.call_count, 2)
            self.assertEqual(analyze_cuts.call_count, 3)
            self.assertEqual(qa.call_count, 3)
            self.assertEqual(
                Path(cached_success["shorts"][0]["clip_url"]).read_bytes(),
                b"exact-render",
            )
            ranking = json.loads(
                (output_dir / "ranking.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                ranking["replayTranscriptManifest"]["transcript"],
                transcript,
            )


if __name__ == "__main__":
    unittest.main()
