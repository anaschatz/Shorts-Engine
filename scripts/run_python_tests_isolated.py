#!/usr/bin/env python3
"""Run every root Python test module in a fresh interpreter."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TESTS_DIR = ROOT / "tests"


def discover_modules(pattern: str) -> list[str]:
    modules = []
    for path in sorted(TESTS_DIR.glob(pattern)):
        if path.is_file():
            modules.append(".".join(path.relative_to(ROOT).with_suffix("").parts))
    return modules


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prove that Python test modules do not depend on import order."
    )
    parser.add_argument("--pattern", default="test_*.py")
    args = parser.parse_args()
    modules = discover_modules(args.pattern)
    if not modules:
        parser.error(f"no tests matched {args.pattern!r}")

    failures: list[tuple[str, int]] = []
    for module in modules:
        result = subprocess.run(
            [sys.executable, "-m", "unittest", "-q", module],
            cwd=ROOT,
            check=False,
        )
        if result.returncode:
            failures.append((module, result.returncode))

    print(
        f"isolated Python modules: {len(modules) - len(failures)}/"
        f"{len(modules)} passed"
    )
    if failures:
        for module, returncode in failures:
            print(f"FAILED {module} (exit {returncode})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
