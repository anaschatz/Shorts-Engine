#!/usr/bin/env python3
"""Run unittest with outbound network access denied.

Autoresearch validation may use local tools such as FFmpeg, but it must never
download media, call an LLM, or reach an upload API.  The parent runner also
clears credentials and redirects known output/cache paths into a temporary
directory; this child boundary makes the network restriction executable.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Iterator, Sequence


class ExcludingTestLoader(unittest.TestLoader):
    """Exclude only contract-declared external/manual integration modules."""

    def __init__(self, excluded_modules: Sequence[str] = ()):
        super().__init__()
        self.excluded_modules = {
            str(module).strip() for module in excluded_modules if str(module).strip()
        }

    def loadTestsFromModule(self, module, *args, **kwargs):
        module_name = str(getattr(module, "__name__", ""))
        normalized = module_name.removeprefix("tests.")
        if (
            module_name in self.excluded_modules
            or normalized in self.excluded_modules
            or f"tests.{normalized}" in self.excluded_modules
        ):
            return self.suiteClass()
        return super().loadTestsFromModule(module, *args, **kwargs)


def _extract_exclusions(arguments: Sequence[str]) -> tuple[list[str], list[str]]:
    remaining = []
    excluded = []
    index = 0
    values = list(arguments)
    while index < len(values):
        if values[index] == "--exclude-module":
            if index + 1 >= len(values):
                raise ValueError("--exclude-module requires a module name")
            excluded.append(values[index + 1])
            index += 2
            continue
        remaining.append(values[index])
        index += 1
    return remaining, excluded


@contextmanager
def offline_network_boundary() -> Iterator[Dict[str, int]]:
    original_socket = socket.socket
    original_create_connection = socket.create_connection
    original_getaddrinfo = socket.getaddrinfo
    original_gethostbyname = socket.gethostbyname
    original_gethostbyname_ex = socket.gethostbyname_ex
    counters = {"networkAttempts": 0}

    def denied(*_args, **_kwargs):
        counters["networkAttempts"] += 1
        raise RuntimeError("autoresearch test lanes forbid outbound network access")

    class GuardedSocket(original_socket):
        def connect(self, *_args, **_kwargs):
            return denied()

        def connect_ex(self, *_args, **_kwargs):
            return denied()

        def sendto(self, *_args, **_kwargs):
            return denied()

        def sendmsg(self, *_args, **_kwargs):
            return denied()

    socket.socket = GuardedSocket
    socket.create_connection = denied
    socket.getaddrinfo = denied
    socket.gethostbyname = denied
    socket.gethostbyname_ex = denied
    try:
        yield counters
    finally:
        socket.socket = original_socket
        socket.create_connection = original_create_connection
        socket.getaddrinfo = original_getaddrinfo
        socket.gethostbyname = original_gethostbyname
        socket.gethostbyname_ex = original_gethostbyname_ex


def main(argv: list[str] | None = None) -> int:
    arguments, excluded_modules = _extract_exclusions(
        list(sys.argv[1:] if argv is None else argv)
    )
    with offline_network_boundary() as activity:
        program = unittest.main(
            module=None,
            argv=["offline_test_runner", *arguments],
            exit=False,
            testLoader=ExcludingTestLoader(excluded_modules),
        )
    report_path = os.getenv("AUTORESEARCH_ACTIVITY_REPORT", "").strip()
    if report_path:
        Path(report_path).write_text(
            json.dumps(
                {
                    "offlineNetworkBoundaryEnforced": True,
                    "excludedModules": sorted(excluded_modules),
                    **activity,
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
    return 0 if program.result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
