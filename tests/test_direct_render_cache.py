import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import shorts_generator.config as config
import shorts_generator.local.clipper as local_clipper
import shorts_generator.local.downloader as local_downloader
import shorts_generator.local.transcriber as local_transcriber
import shorts_generator.local.visual_features as local_visual_features
from shorts_generator.artifact_contracts import (
    candidate_hash,
    content_hash,
    file_sha256,
)
from shorts_generator.performance import PerformanceTelemetry
from shorts_generator.music_router import route_music_for_candidate
from shorts_generator.pipeline import (
    _direct_local_render_cache_identity,
    _direct_local_render_plan_hash,
    _render_direct_local_batch_with_cache,
    _run_local,
)
from shorts_generator.production_workflow import (
    V4_MUSIC_CATALOG_CONTENT_HASH,
    _dynamic_music_treatment_version,
    _render_cache_identity,
    _renderer_fingerprint,
    _resolve_v4_music_cache_binding,
)
from shorts_generator.profiles import (
    BF_EDITORIAL_INSET_V1,
    BF_EDITORIAL_INSET_V3,
    BF_EDITORIAL_INSET_V4,
    MUSIC_ROTATION_VERSION,
    SEMANTIC_MUSIC_ROUTER_VERSION,
    VIRAL_MUSIC_CATALOG_VERSION,
    resolve_profile_bundle,
)
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


def _sealed(body):
    return {**body, "contentHash": content_hash(body)}


def _synthetic_v4_music_contract(root: Path):
    music_bytes = b"licensed-v4-music-fixture"
    relative_path = "assets/music/test-v4-track.mp3"
    music_path = root / relative_path
    music_path.parent.mkdir(parents=True, exist_ok=True)
    music_path.write_bytes(music_bytes)
    track = {
        "trackId": "pixabay:test-v4",
        "relativePath": relative_path,
        "title": "Synthetic V4 track",
        "creator": "Test fixture",
        "sourcePageUrl": "https://example.test/music",
        "contentUrl": "https://example.test/music.mp3",
        "licenseUrl": "https://example.test/license",
        "sha256": file_sha256(music_path),
        "byteLength": len(music_bytes),
        "durationSeconds": 90.0,
        "codec": "mp3",
        "sampleRate": 48000,
        "channels": 2,
        "aiGenerated": False,
        "contentIdRegistered": "unknown",
        "semanticFamilies": ["hard_truth"],
        "treatmentProfile": "reflective",
        "recommendedOffsetSeconds": 24.0,
        "catalogOrder": 1,
    }
    catalog = _sealed(
        {
            "schemaVersion": 1,
            "artifactType": "ViralMusicCatalog",
            "catalogVersion": VIRAL_MUSIC_CATALOG_VERSION,
            "licenseUrl": "https://example.test/license",
            "retrievedAt": "2026-08-08T00:00:00Z",
            "sourceReplacement": {
                "explicit": True,
                "requestedTrack": {
                    "title": "Unavailable fixture track",
                    "sourcePageUrl": "https://example.test/unavailable",
                    "pixabayContentId": 999999,
                },
                "replacementTrackId": track["trackId"],
                "note": "Synthetic replacement evidence for cache tests.",
            },
            "tracks": [track],
        }
    )
    catalog_path = root / "assets" / "music" / "catalog.v1.json"
    catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
    candidate = {
        "render_profile": BF_EDITORIAL_INSET_V4,
        "background_music": True,
        "music_profile": "reflective",
        "topic": "an uncomfortable hard truth",
        "whole_point_summary": "You cannot avoid a hard truth forever.",
        "final_takeaway_sentence": "Accept the truth.",
    }
    decision = route_music_for_candidate(
        candidate,
        catalog_path=catalog_path,
        repository_root=root,
        verify_assets=True,
    )
    candidate.update(
        {
            "musicRoutingDecision": decision,
            "musicCatalogTrack": track,
        }
    )
    return candidate, catalog, track, music_path


class DirectRenderPlanIdentityTests(unittest.TestCase):
    def test_v3_cache_identity_has_nonempty_music_treatment_before_render_metadata(self):
        self.assertEqual(
            _dynamic_music_treatment_version(
                {"render_profile": BF_EDITORIAL_INSET_V3}
            ),
            "bf_dynamic_music_v1.0.0",
        )
        self.assertEqual(
            _dynamic_music_treatment_version(
                {
                    "render_profile": BF_EDITORIAL_INSET_V3,
                    "music_version": "custom-dynamic-music-v2",
                }
            ),
            "custom-dynamic-music-v2",
        )
        self.assertIsNone(
            _dynamic_music_treatment_version(
                {"render_profile": BF_EDITORIAL_INSET_V1}
            )
        )
        self.assertEqual(
            _dynamic_music_treatment_version(
                {"render_profile": BF_EDITORIAL_INSET_V4}
            ),
            "bf_dynamic_music_v1.0.0",
        )

    def test_v3_renderer_config_binds_nonempty_music_treatment(self):
        prepared = {
            "renderCandidate": {
                "render_profile": BF_EDITORIAL_INSET_V3,
                "music_profile": "reflective",
                "background_music": False,
            },
            "editPlan": {
                "sourceHash": "a" * 64,
                "contentHash": "b" * 64,
            },
        }
        with tempfile.TemporaryDirectory() as directory, (
            patch.object(config, "LOCAL_RENDER_CACHE", True)
        ), patch.object(
            config, "LOCAL_RENDER_CACHE_DIR", directory
        ), patch.object(
            config, "LOCAL_REAL_ESRGAN", False
        ), patch.object(
            local_clipper, "_resolve_caption_font", return_value=None
        ), patch.object(
            local_clipper, "_resolve_motivational_support_font", return_value=None
        ), patch.object(
            local_clipper, "_resolve_motivational_accent_font", return_value=None
        ), patch.object(
            local_clipper, "_resolve_motivational_script_font", return_value=None
        ), patch.object(
            local_clipper, "_resolve_motivational_music_track", return_value=None
        ), patch(
            "shorts_generator.production_workflow._renderer_fingerprint",
            return_value="renderer-fingerprint",
        ), patch(
            "shorts_generator.production_workflow.build_render_cache_key",
            return_value="cache-key",
        ) as build_key:
            _, cache_key = _render_cache_identity(prepared)

        self.assertEqual(cache_key, "cache-key")
        music_identity = build_key.call_args.kwargs["renderer_config"]["music"]
        self.assertEqual(
            music_identity["treatmentVersion"],
            "bf_dynamic_music_v1.0.0",
        )
        self.assertTrue(music_identity["treatmentVersion"].strip())

    def test_v4_resolver_binds_sealed_decision_catalog_entry_and_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate, catalog, track, music_path = _synthetic_v4_music_contract(
                root
            )
            with patch(
                "shorts_generator.production_workflow."
                "V4_MUSIC_CATALOG_CONTENT_HASH",
                catalog["contentHash"],
            ):
                binding = _resolve_v4_music_cache_binding(
                    candidate,
                    repository_root=root,
                )

        self.assertEqual(binding["trackId"], track["trackId"])
        self.assertEqual(binding["startSeconds"], 24.0)
        self.assertEqual(binding["catalogContentHash"], catalog["contentHash"])
        self.assertEqual(binding["assetSha256"], track["sha256"])
        self.assertEqual(binding["assetByteLength"], track["byteLength"])
        self.assertEqual(binding["musicPath"], str(music_path.resolve()))

    def test_v4_resolver_fails_closed_on_missing_stale_or_mismatched_routing(self):
        with self.assertRaisesRegex(ValueError, "musicRoutingDecision"):
            _resolve_v4_music_cache_binding(
                {
                    "render_profile": BF_EDITORIAL_INSET_V4,
                    "musicCatalogTrack": {},
                }
            )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate, catalog, _, _ = _synthetic_v4_music_contract(root)
            stale = copy.deepcopy(candidate)
            stale["musicRoutingDecision"]["startSeconds"] = 29.0
            with patch(
                "shorts_generator.production_workflow."
                "V4_MUSIC_CATALOG_CONTENT_HASH",
                catalog["contentHash"],
            ), self.assertRaisesRegex(Exception, "seal|contentHash"):
                _resolve_v4_music_cache_binding(
                    stale,
                    repository_root=root,
                )

            mismatch = copy.deepcopy(candidate)
            mismatch["musicCatalogTrack"] = {
                **mismatch["musicCatalogTrack"],
                "trackId": "pixabay:other",
            }
            with patch(
                "shorts_generator.production_workflow."
                "V4_MUSIC_CATALOG_CONTENT_HASH",
                catalog["contentHash"],
            ), self.assertRaisesRegex(ValueError, "musicCatalogTrack"):
                _resolve_v4_music_cache_binding(
                    mismatch,
                    repository_root=root,
                )

            transplanted = copy.deepcopy(candidate)
            transplanted["whole_point_summary"] = (
                "A completely different relationship point."
            )
            with patch(
                "shorts_generator.production_workflow."
                "V4_MUSIC_CATALOG_CONTENT_HASH",
                catalog["contentHash"],
            ), self.assertRaisesRegex(Exception, "other semantics"):
                _resolve_v4_music_cache_binding(
                    transplanted,
                    repository_root=root,
                )

    def test_v4_cache_identity_uses_only_sealed_route_and_exact_catalog_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            music_path = root / "routed.mp3"
            music_path.write_bytes(b"routed-v4-music")
            decision = {
                "contentHash": "d" * 64,
                "semanticInputHash": "e" * 64,
                "routerVersion": SEMANTIC_MUSIC_ROUTER_VERSION,
                "catalogVersion": VIRAL_MUSIC_CATALOG_VERSION,
                "rotationVersion": MUSIC_ROTATION_VERSION,
            }
            track = {
                "relativePath": "assets/music/routed.mp3",
            }
            binding = {
                "decision": decision,
                "catalogTrack": track,
                "catalogContentHash": V4_MUSIC_CATALOG_CONTENT_HASH,
                "musicPath": str(music_path),
                "assetSha256": file_sha256(music_path),
                "assetByteLength": music_path.stat().st_size,
                "startSeconds": 29.0,
                "trackId": "pixabay:112823",
                "treatmentProfile": "reflective",
            }
            prepared = {
                "renderCandidate": {
                    "render_profile": BF_EDITORIAL_INSET_V4,
                    "music_profile": "reflective",
                    "background_music": True,
                    # Deliberately conflicting legacy-looking fields. The V4
                    # cache contract must consume only the sealed binding.
                    "music_version": "bf_dynamic_music_v1.0.0",
                },
                "editPlan": {
                    "sourceHash": "a" * 64,
                    "contentHash": "b" * 64,
                },
            }
            with (
                patch.object(config, "LOCAL_RENDER_CACHE", True),
                patch.object(config, "LOCAL_RENDER_CACHE_DIR", directory),
                patch.object(config, "LOCAL_REAL_ESRGAN", False),
                patch.object(config, "LOCAL_MOTIVATIONAL_MUSIC", True),
                patch.object(
                    config, "LOCAL_MOTIVATIONAL_MUSIC_PROFILE", "driving"
                ),
                patch.object(
                    config, "LOCAL_MOTIVATIONAL_MUSIC_START_SECONDS", 777.0
                ),
                patch.object(
                    local_clipper, "_resolve_caption_font", return_value=None
                ),
                patch.object(
                    local_clipper,
                    "_resolve_motivational_support_font",
                    return_value=None,
                ),
                patch.object(
                    local_clipper,
                    "_resolve_motivational_accent_font",
                    return_value=None,
                ),
                patch.object(
                    local_clipper,
                    "_resolve_motivational_script_font",
                    return_value=None,
                ),
                patch.object(
                    local_clipper, "_resolve_motivational_music_track"
                ) as legacy_resolver,
                patch(
                    "shorts_generator.production_workflow."
                    "_resolve_v4_music_cache_binding",
                    return_value=binding,
                ),
                patch(
                    "shorts_generator.production_workflow._renderer_fingerprint",
                    return_value="v4-renderer-fingerprint",
                ) as renderer_fingerprint,
                patch(
                    "shorts_generator.production_workflow.build_render_cache_key",
                    return_value="v4-cache-key",
                ) as build_key,
            ):
                _, cache_key = _render_cache_identity(prepared)

        self.assertEqual(cache_key, "v4-cache-key")
        legacy_resolver.assert_not_called()
        renderer_fingerprint.assert_called_once_with(
            True,
            True,
            V4_MUSIC_CATALOG_CONTENT_HASH,
        )
        call = build_key.call_args.kwargs
        self.assertEqual(call["asset_hashes"]["music"], binding["assetSha256"])
        music = call["renderer_config"]["music"]
        self.assertNotIn("profile", music)
        self.assertEqual(music["routingDecisionHash"], "d" * 64)
        self.assertEqual(music["semanticInputHash"], "e" * 64)
        self.assertEqual(music["trackId"], "pixabay:112823")
        self.assertEqual(music["startSeconds"], 29.0)
        self.assertEqual(
            music["catalogContentHash"], V4_MUSIC_CATALOG_CONTENT_HASH
        )
        self.assertEqual(
            music["catalogTrack"],
            {
                "relativePath": "assets/music/routed.mp3",
                "sha256": binding["assetSha256"],
                "byteLength": binding["assetByteLength"],
            },
        )

    def test_v4_cache_fails_before_resolution_when_music_layer_is_disabled(self):
        prepared = {
            "renderCandidate": {
                "render_profile": BF_EDITORIAL_INSET_V4,
                "background_music": True,
            },
            "editPlan": {
                "sourceHash": "a" * 64,
                "contentHash": "b" * 64,
            },
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(
            config, "LOCAL_RENDER_CACHE", True
        ), patch.object(
            config, "LOCAL_RENDER_CACHE_DIR", directory
        ), patch.object(
            config, "LOCAL_MOTIVATIONAL_MUSIC", False
        ), patch(
            "shorts_generator.production_workflow._resolve_v4_music_cache_binding"
        ) as resolver:
            with self.assertRaisesRegex(ValueError, "routed music layer"):
                _render_cache_identity(prepared)
        resolver.assert_not_called()

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

    def test_v3_cache_identity_binds_dynamic_music_inputs_and_is_enabled(self):
        source_hash = "a" * 64
        profiles = resolve_profile_bundle(format_profile="bf_feed_stop_format_v3")
        candidate = _candidate(
            source_hash,
            selection_profile="bf_feed_stop_v2",
            render_profile=BF_EDITORIAL_INSET_V3,
            format_profile="bf_feed_stop_format_v3",
            music_profile="reflective",
            music_mix_profile="bf_dynamic_music_v1.0.0",
            opening_unit_exact_quote="Good people tell the truth.",
            payoff_exact_quote="Good people tell the truth.",
        )

        base_plan_hash = _direct_local_render_plan_hash(
            candidate,
            _transcript(),
            source_hash,
            "9:16",
            profiles,
        )
        changed = _candidate(
            source_hash,
            selection_profile="bf_feed_stop_v2",
            render_profile=BF_EDITORIAL_INSET_V3,
            format_profile="bf_feed_stop_format_v3",
            music_profile="driving",
            music_mix_profile="bf_dynamic_music_v1.0.0",
            opening_unit_exact_quote="Good people tell the truth.",
            payoff_exact_quote="Good people tell the truth.",
        )
        self.assertNotEqual(
            base_plan_hash,
            _direct_local_render_plan_hash(
                changed,
                _transcript(),
                source_hash,
                "9:16",
                profiles,
            ),
        )

        with patch(
            "shorts_generator.production_workflow._render_cache_identity",
            return_value=("cache", "v3-cache-key"),
        ) as identity:
            self.assertEqual(
                _direct_local_render_cache_identity(
                    candidate,
                    _transcript(),
                    source_hash,
                    "9:16",
                    profiles,
                ),
                ("cache", "v3-cache-key"),
            )
        identity.assert_called_once()

    def test_renderer_fingerprint_changes_when_dynamic_music_code_changes(self):
        real_path_open = Path.open

        def mutated_open(path, *args, **kwargs):
            if Path(path).name == "dynamic_music.py":
                return io.BytesIO(b"synthetic dynamic-music implementation v2")
            return real_path_open(path, *args, **kwargs)

        with patch(
            "shorts_generator.production_workflow.importlib.metadata.version",
            return_value="test-runtime",
        ), patch(
            "shorts_generator.production_workflow.subprocess.run",
            return_value=SimpleNamespace(stdout="ffmpeg version test\n"),
        ):
            _renderer_fingerprint.cache_clear()
            legacy_baseline = _renderer_fingerprint(False)
            baseline = _renderer_fingerprint(True)
            with patch.object(Path, "open", new=mutated_open):
                _renderer_fingerprint.cache_clear()
                legacy_mutated = _renderer_fingerprint(False)
                mutated = _renderer_fingerprint(True)
        _renderer_fingerprint.cache_clear()

        self.assertEqual(legacy_baseline, legacy_mutated)
        self.assertNotEqual(baseline, mutated)

    def test_v4_fingerprint_binds_router_source_and_canonical_catalog_hash(self):
        real_path_open = Path.open
        router_bytes = b"semantic music router v1"

        def router_open(path, *args, **kwargs):
            if Path(path).name == "music_router.py":
                return io.BytesIO(router_bytes)
            return real_path_open(path, *args, **kwargs)

        with patch(
            "shorts_generator.production_workflow.importlib.metadata.version",
            return_value="test-runtime",
        ), patch(
            "shorts_generator.production_workflow.subprocess.run",
            return_value=SimpleNamespace(stdout="ffmpeg version test\n"),
        ), patch.object(Path, "open", new=router_open):
            _renderer_fingerprint.cache_clear()
            first = _renderer_fingerprint(
                True,
                True,
                V4_MUSIC_CATALOG_CONTENT_HASH,
            )
            changed_catalog = _renderer_fingerprint(True, True, "f" * 64)
            v3 = _renderer_fingerprint(True)

            router_bytes = b"semantic music router v2"
            _renderer_fingerprint.cache_clear()
            changed_router = _renderer_fingerprint(
                True,
                True,
                V4_MUSIC_CATALOG_CONTENT_HASH,
            )
            unchanged_v3 = _renderer_fingerprint(True)
        _renderer_fingerprint.cache_clear()

        self.assertNotEqual(first, changed_catalog)
        self.assertNotEqual(first, changed_router)
        self.assertEqual(v3, unchanged_v3)

    def test_v4_fingerprint_rejects_missing_catalog_hash(self):
        _renderer_fingerprint.cache_clear()
        with self.assertRaisesRegex(ValueError, "catalog hash"):
            _renderer_fingerprint(True, True, "")
        _renderer_fingerprint.cache_clear()


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
