"""Public package API.

Keep the heavyweight pipeline import lazy.  Utility commands and tests often
need only artifact/cache helpers; importing requests, video tooling and every
pipeline dependency at package-import time adds avoidable startup latency.
"""

from typing import Any


def generate_shorts(*args: Any, **kwargs: Any):
    from .pipeline import generate_shorts as _generate_shorts

    return _generate_shorts(*args, **kwargs)


__all__ = ["generate_shorts"]
