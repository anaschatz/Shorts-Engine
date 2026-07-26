import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shorts_generator.config import _default_local_cache_dir
from shorts_generator.local.downloader import (
    _av1_fallback_format_for,
    _existing_download,
    _format_for,
    _materialize_cached_source,
    _preferred_source_height,
    download_youtube_local,
)
from shorts_generator.performance import PerformanceTelemetry


class ResolutionCacheTests(unittest.TestCase):
    def test_macos_default_cache_is_outside_the_desktop(self):
        with (
            patch("shorts_generator.config.sys.platform", "darwin"),
            patch(
                "shorts_generator.config.Path.home",
                return_value=Path("/Users/example"),
            ),
        ):
            cache_dir = _default_local_cache_dir()

        self.assertEqual(
            cache_dir,
            Path("/Users/example/Library/Caches/Shorts-Engine"),
        )

    def test_hd_vertical_output_prefers_1080p_source(self):
        self.assertEqual(_preferred_source_height("720"), 1080)
        self.assertEqual(_preferred_source_height("1080"), 1080)
        self.assertEqual(_preferred_source_height("360"), 360)
        self.assertEqual(_preferred_source_height("720", minimum_hd_height=720), 720)
        self.assertEqual(_preferred_source_height("1080", minimum_hd_height=720), 1080)
        self.assertIn("height<=1080", _format_for("720"))
        self.assertIn("height<=720", _format_for("720", minimum_hd_height=720))
        self.assertIn("vcodec^=av01", _av1_fallback_format_for("720"))

    def test_ignores_cached_source_below_required_height(self):
        with tempfile.TemporaryDirectory() as directory:
            low = Path(directory) / "source_video_360p.mp4"
            low.touch()
            with patch(
                "shorts_generator.local.downloader._probe_video_height",
                return_value=360,
            ):
                self.assertIsNone(_existing_download(directory, "video", min_height=1080))

    def test_reuses_smallest_cached_source_that_meets_requirement(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = {
                Path(directory) / "source_video_360p.mp4": 360,
                Path(directory) / "source_video_1080p.mp4": 1080,
                Path(directory) / "source_video_1440p.webm": 1440,
            }
            for path in paths:
                path.touch()
            with patch(
                "shorts_generator.local.downloader._probe_video_height",
                side_effect=lambda path: paths[Path(path)],
            ):
                selected = _existing_download(directory, "video", min_height=1080)
            self.assertEqual(selected, str(Path(directory) / "source_video_1080p.mp4"))

    def test_materializes_legacy_source_byte_for_byte_in_local_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / "desktop-output" / "source_video_1080p.mp4"
            local_cache = root / "local-cache"
            legacy.parent.mkdir()
            legacy.write_bytes(b"exact-video-bytes")

            migrated = Path(
                _materialize_cached_source(str(legacy), str(local_cache))
            )

            self.assertEqual(migrated, local_cache / legacy.name)
            self.assertEqual(migrated.read_bytes(), legacy.read_bytes())
            self.assertTrue(legacy.exists())

    def test_materialization_replaces_same_size_nonidentical_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / "desktop-output" / "source_video_1080p.mp4"
            local_cache = root / "local-cache"
            legacy.parent.mkdir()
            local_cache.mkdir()
            legacy.write_bytes(b"correct")
            target = local_cache / legacy.name
            target.write_bytes(b"corrupt")

            migrated = Path(
                _materialize_cached_source(str(legacy), str(local_cache))
            )

            self.assertEqual(migrated.read_bytes(), b"correct")

    def test_remote_download_uses_bounded_fragment_concurrency(self):
        class FakeYoutubeDL:
            options = []

            def __init__(self, options):
                self.options.append(options)

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extract_info(self, _url, download):
                self.assert_download = download
                return {"id": "video", "height": 1080, "ext": "mp4"}

            def prepare_filename(self, _info):
                return "/cache/source_video_1080p.mp4"

        fake_module = type(
            "FakeYtDlp",
            (),
            {
                "YoutubeDL": FakeYoutubeDL,
                "utils": type("Utils", (), {"DownloadError": RuntimeError}),
            },
        )
        with tempfile.TemporaryDirectory() as cache:
            expected = str(Path(cache) / "source_video_1080p.mp4")
            telemetry = PerformanceTelemetry(run_id="download-cache-test")
            warmup_calls = []
            video_info = []
            with (
                patch(
                    "shorts_generator.local.downloader._extract_youtube_video_id",
                    return_value=None,
                ),
                patch(
                    "shorts_generator.local.downloader._import_ytdlp",
                    return_value=fake_module,
                ),
                patch(
                    "shorts_generator.local.downloader._probe_video_height",
                    return_value=1080,
                ),
                patch(
                    "shorts_generator.local.downloader.os.path.exists",
                    return_value=True,
                ),
                patch(
                    "shorts_generator.local.downloader.LOCAL_DOWNLOAD_CONCURRENT_FRAGMENTS",
                    4,
                ),
                patch.object(FakeYoutubeDL, "prepare_filename", return_value=expected),
            ):
                path = download_youtube_local(
                    "https://www.youtube.com/watch?v=video",
                    out_dir=cache,
                    telemetry=telemetry,
                    on_remote_download_start=lambda: warmup_calls.append("start"),
                    on_video_info=video_info.append,
                )

            self.assertEqual(path, expected)
            counter = telemetry.finish()["cacheCounters"]["source"]
        self.assertEqual(
            FakeYoutubeDL.options[0]["concurrent_fragment_downloads"],
            4,
        )
        self.assertEqual(counter["misses"], 1)
        self.assertEqual(counter["hits"], 0)
        self.assertEqual(warmup_calls, ["start"])
        self.assertEqual(video_info, [{"id": "video", "height": 1080, "ext": "mp4"}])

    def test_cached_source_does_not_start_remote_warmup(self):
        with tempfile.TemporaryDirectory() as cache:
            cached = Path(cache) / "source_video_720p.mp4"
            cached.write_bytes(b"cached-source")
            warmup_calls = []
            video_info = []
            with patch(
                "shorts_generator.local.downloader._probe_video_height",
                return_value=720,
            ):
                path = download_youtube_local(
                    "https://www.youtube.com/watch?v=video",
                    fmt="720",
                    out_dir=cache,
                    minimum_hd_height=720,
                    on_remote_download_start=lambda: warmup_calls.append("start"),
                    on_video_info=video_info.append,
                )

        self.assertEqual(path, str(cached))
        self.assertEqual(warmup_calls, [])
        self.assertEqual(video_info, [])


if __name__ == "__main__":
    unittest.main()
