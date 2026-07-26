import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from shorts_generator.opencv_warmup import OpenCVImportWarmup


class OpenCVImportWarmupTests(unittest.TestCase):
    def test_concurrent_start_calls_create_exactly_one_worker(self):
        loader_entered = threading.Event()
        release_loader = threading.Event()
        state_lock = threading.Lock()
        loader_calls = 0
        sentinel = object()

        def fake_loader():
            nonlocal loader_calls
            with state_lock:
                loader_calls += 1
            loader_entered.set()
            self.assertTrue(release_loader.wait(timeout=2.0))
            return sentinel

        warmup = OpenCVImportWarmup(loader=fake_loader)
        with ThreadPoolExecutor(max_workers=8) as executor:
            starts = list(executor.map(lambda _index: warmup.start(), range(24)))

        self.assertTrue(loader_entered.wait(timeout=2.0))
        self.assertEqual(1, sum(starts))
        self.assertEqual(1, loader_calls)
        release_loader.set()
        self.assertIs(sentinel, warmup.wait(timeout=2.0))
        self.assertFalse(warmup.start())
        self.assertEqual(1, loader_calls)

    def test_wait_returns_loader_result_and_reports_elapsed_and_wait_time(self):
        loader_entered = threading.Event()
        wait_started = threading.Event()
        release_loader = threading.Event()
        sentinel = object()
        waiter_clock_calls = 0

        def fake_clock():
            nonlocal waiter_clock_calls
            name = threading.current_thread().name
            if name == "MainThread":
                return 10.0
            if name == "opencv-import-warmup":
                return 15.0
            waiter_clock_calls += 1
            if waiter_clock_calls == 1:
                wait_started.set()
                return 12.0
            return 16.0

        def fake_loader():
            loader_entered.set()
            self.assertTrue(release_loader.wait(timeout=2.0))
            return sentinel

        warmup = OpenCVImportWarmup(loader=fake_loader, clock=fake_clock)
        self.assertTrue(warmup.start())
        self.assertTrue(loader_entered.wait(timeout=2.0))

        with ThreadPoolExecutor(max_workers=1) as executor:
            waiter = executor.submit(warmup.wait, 2.0)
            self.assertTrue(wait_started.wait(timeout=2.0))
            release_loader.set()
            self.assertIs(sentinel, waiter.result(timeout=2.0))

        timing = warmup.timing()
        self.assertTrue(timing.started)
        self.assertTrue(timing.finished)
        self.assertEqual(5.0, timing.elapsed_seconds)
        self.assertEqual(4.0, timing.wait_seconds)
        self.assertEqual(1, timing.wait_count)

    def test_wait_propagates_the_loader_error(self):
        failure = ImportError("synthetic OpenCV import failure")

        def failing_loader():
            raise failure

        warmup = OpenCVImportWarmup(loader=failing_loader)
        warmup.start()

        with self.assertRaises(ImportError) as raised:
            warmup.wait(timeout=2.0)

        self.assertIs(failure, raised.exception)
        self.assertTrue(warmup.timing().finished)

    def test_wait_before_start_is_rejected(self):
        warmup = OpenCVImportWarmup(loader=lambda: object())

        with self.assertRaisesRegex(RuntimeError, "has not been started"):
            warmup.wait()

    def test_timeout_does_not_cancel_the_single_worker(self):
        loader_entered = threading.Event()
        release_loader = threading.Event()
        sentinel = object()

        def fake_loader():
            loader_entered.set()
            self.assertTrue(release_loader.wait(timeout=2.0))
            return sentinel

        warmup = OpenCVImportWarmup(loader=fake_loader)
        warmup.start()
        self.assertTrue(loader_entered.wait(timeout=2.0))

        with self.assertRaisesRegex(TimeoutError, "OpenCV import warmup"):
            warmup.wait(timeout=0.0)

        release_loader.set()
        self.assertIs(sentinel, warmup.wait(timeout=2.0))
        timing = warmup.timing()
        self.assertEqual(2, timing.wait_count)
        self.assertTrue(timing.finished)


if __name__ == "__main__":
    unittest.main()
