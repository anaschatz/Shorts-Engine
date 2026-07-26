import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from shorts_generator.local import clipper


class ClipBatchConcurrencyTests(unittest.TestCase):
    def _highlight(self, index: int) -> dict:
        return {
            "title": f"clip-{index}",
            "start_time": float(index),
            "end_time": float(index) + 1.0,
        }

    def test_batch_renders_concurrently_and_preserves_output_order(self):
        barrier = threading.Barrier(2, timeout=2.0)

        def fake_crop(*args, **kwargs):
            del kwargs
            output_path = Path(args[4])
            barrier.wait()
            output_path.write_bytes(f"render-{args[1]}".encode("utf-8"))
            return str(output_path)

        with TemporaryDirectory() as output_dir, mock.patch.object(
            clipper,
            "LOCAL_RENDER_WORKERS",
            2,
        ), mock.patch.object(
            clipper,
            "LOCAL_REAL_ESRGAN",
            False,
        ), mock.patch.object(
            clipper,
            "LOCAL_WORK_DIR",
            output_dir,
        ), mock.patch.object(
            clipper,
            "crop_clip_local",
            side_effect=fake_crop,
        ), mock.patch.object(
            clipper,
            "_prewarm_bf_editorial_realesrgan_cache",
            return_value={},
        ):
            results = clipper.crop_highlights_local(
                "source.mp4",
                [self._highlight(1), self._highlight(2)],
                out_dir=output_dir,
            )
            expected_urls = [
                str(Path(output_dir) / "short_01.mp4"),
                str(Path(output_dir) / "short_02.mp4"),
            ]
            rendered_bytes = [
                (Path(output_dir) / "short_01.mp4").read_bytes(),
                (Path(output_dir) / "short_02.mp4").read_bytes(),
            ]

        self.assertEqual(["clip-1", "clip-2"], [item["title"] for item in results])
        self.assertEqual(
            expected_urls,
            [item["clip_url"] for item in results],
        )
        self.assertEqual([b"render-1.0", b"render-2.0"], rendered_bytes)

    def test_failed_render_does_not_block_other_batch_outputs(self):
        def fake_crop(*args, **kwargs):
            del kwargs
            if float(args[1]) == 2.0:
                raise RuntimeError("synthetic render failure")
            output_path = Path(args[4])
            output_path.write_bytes(f"render-{args[1]}".encode("utf-8"))
            return str(output_path)

        with TemporaryDirectory() as output_dir, mock.patch.object(
            clipper,
            "LOCAL_RENDER_WORKERS",
            2,
        ), mock.patch.object(
            clipper,
            "LOCAL_REAL_ESRGAN",
            False,
        ), mock.patch.object(
            clipper,
            "LOCAL_WORK_DIR",
            output_dir,
        ), mock.patch.object(
            clipper,
            "crop_clip_local",
            side_effect=fake_crop,
        ), mock.patch.object(
            clipper,
            "_prewarm_bf_editorial_realesrgan_cache",
            return_value={},
        ):
            results = clipper.crop_highlights_local(
                "source.mp4",
                [
                    self._highlight(1),
                    self._highlight(2),
                    self._highlight(3),
                ],
                out_dir=output_dir,
            )

            self.assertTrue((Path(output_dir) / "short_01.mp4").is_file())
            self.assertFalse((Path(output_dir) / "short_02.mp4").exists())
            self.assertTrue((Path(output_dir) / "short_03.mp4").is_file())

        self.assertEqual(["clip-1", "clip-2", "clip-3"], [item["title"] for item in results])
        self.assertIsNone(results[1]["clip_url"])
        self.assertIn("synthetic render failure", results[1]["error"])

    def test_render_batch_never_exceeds_two_workers(self):
        state_lock = threading.Lock()
        active = 0
        max_active = 0

        def fake_crop(*args, **kwargs):
            nonlocal active, max_active
            del kwargs
            output_path = Path(args[4])
            with state_lock:
                active += 1
                max_active = max(max_active, active)
            try:
                time.sleep(0.03)
                output_path.write_bytes(b"render")
            finally:
                with state_lock:
                    active -= 1
            return str(output_path)

        with TemporaryDirectory() as output_dir, mock.patch.object(
            clipper,
            "LOCAL_RENDER_WORKERS",
            99,
        ), mock.patch.object(
            clipper,
            "LOCAL_REAL_ESRGAN",
            False,
        ), mock.patch.object(
            clipper,
            "LOCAL_WORK_DIR",
            output_dir,
        ), mock.patch.object(
            clipper,
            "crop_clip_local",
            side_effect=fake_crop,
        ), mock.patch.object(
            clipper,
            "_prewarm_bf_editorial_realesrgan_cache",
            return_value={},
        ):
            results = clipper.crop_highlights_local(
                "source.mp4",
                [self._highlight(1), self._highlight(2), self._highlight(3)],
                out_dir=output_dir,
            )

        self.assertEqual(2, max_active)
        self.assertTrue(all(item["clip_url"] for item in results))

    def test_realesrgan_processes_are_serialized_across_workers(self):
        state_lock = threading.Lock()
        active = 0
        max_active = 0

        def fake_run(*_args, **_kwargs):
            nonlocal active, max_active
            with state_lock:
                active += 1
                max_active = max(max_active, active)
            try:
                time.sleep(0.03)
                return mock.Mock(returncode=0, stdout="", stderr="")
            finally:
                with state_lock:
                    active -= 1

        with mock.patch.object(
            clipper.subprocess,
            "run",
            side_effect=fake_run,
        ), ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(
                    clipper._run_realesrgan_process,
                    ["realesrgan", str(index)],
                )
                for index in range(2)
            ]
            for future in futures:
                self.assertEqual(0, future.result().returncode)

        self.assertEqual(1, max_active)


if __name__ == "__main__":
    unittest.main()
