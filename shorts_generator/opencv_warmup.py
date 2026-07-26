"""Start the optional OpenCV import early without blocking the caller.

Importing OpenCV can be a noticeable part of a cold local run.  This helper
allows that import to overlap independent work (for example, a download) while
keeping the eventual import failure visible to the code that needs OpenCV.

The module deliberately does not import :mod:`cv2` at module load time.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional


def _load_opencv() -> Any:
    """Import OpenCV only inside the background worker."""
    import cv2  # type: ignore

    return cv2


@dataclass(frozen=True)
class OpenCVWarmupTiming:
    """A thread-safe timing snapshot for one warmup helper."""

    started: bool
    finished: bool
    elapsed_seconds: Optional[float]
    wait_seconds: float
    wait_count: int


class OpenCVImportWarmup:
    """Run one OpenCV loader in a daemon thread and publish its result.

    ``start`` is idempotent and thread-safe: exactly one caller starts the
    worker and receives ``True``.  Later calls receive ``False``.  ``wait``
    returns the loaded module-like object or re-raises the loader's exception.

    A loader can be injected for tests.  Production callers normally use the
    default, which imports ``cv2`` inside the worker rather than on the calling
    thread.
    """

    def __init__(
        self,
        loader: Callable[[], Any] = _load_opencv,
        *,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        if not callable(loader):
            raise TypeError("loader must be callable")
        if not callable(clock):
            raise TypeError("clock must be callable")
        self._loader = loader
        self._clock = clock
        self._lock = threading.Lock()
        self._done = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._result: Any = None
        self._error: Optional[BaseException] = None
        self._started_at: Optional[float] = None
        self._finished_at: Optional[float] = None
        self._wait_seconds = 0.0
        self._wait_count = 0

    def start(self) -> bool:
        """Start the background loader once; return whether this call started it."""
        with self._lock:
            if self._thread is not None:
                return False
            started_at = float(self._clock())
            thread = threading.Thread(
                target=self._run,
                name="opencv-import-warmup",
                daemon=True,
            )
            self._started_at = started_at
            self._thread = thread
            try:
                thread.start()
            except BaseException:
                # No worker was started, so leave the helper reusable.
                self._thread = None
                self._started_at = None
                raise
            return True

    def _run(self) -> None:
        try:
            result = self._loader()
        except BaseException as error:
            with self._lock:
                self._error = error
                self._finished_at = float(self._clock())
        else:
            with self._lock:
                self._result = result
                self._finished_at = float(self._clock())
        finally:
            self._done.set()

    def wait(self, timeout: Optional[float] = None) -> Any:
        """Wait for the import, returning its result or propagating its failure.

        ``TimeoutError`` is raised if *timeout* elapses.  A timed-out wait does
        not cancel the import and a later call can wait for the same worker.
        """
        with self._lock:
            if self._thread is None:
                raise RuntimeError("OpenCV import warmup has not been started")

        wait_started = float(self._clock())
        finished = self._done.wait(timeout)
        wait_finished = float(self._clock())
        with self._lock:
            self._wait_seconds += max(0.0, wait_finished - wait_started)
            self._wait_count += 1
            error = self._error
            result = self._result

        if not finished:
            raise TimeoutError("timed out waiting for OpenCV import warmup")
        if error is not None:
            raise error
        return result

    def timing(self) -> OpenCVWarmupTiming:
        """Return a consistent snapshot of worker elapsed and caller wait time."""
        with self._lock:
            elapsed = None
            if self._started_at is not None:
                end = self._finished_at
                if end is None:
                    end = float(self._clock())
                elapsed = max(0.0, end - self._started_at)
            return OpenCVWarmupTiming(
                started=self._thread is not None,
                finished=self._done.is_set(),
                elapsed_seconds=elapsed,
                wait_seconds=self._wait_seconds,
                wait_count=self._wait_count,
            )


__all__ = ["OpenCVImportWarmup", "OpenCVWarmupTiming"]
