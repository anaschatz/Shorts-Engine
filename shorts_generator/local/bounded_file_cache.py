"""Shared filesystem budget policy for local render caches."""

from pathlib import Path
from typing import Tuple


def prune_bounded_cache(
    cache_dir: Path,
    pattern: str,
    max_bytes: int,
) -> Tuple[int, int]:
    """Evict oldest matching files to 90% after a cache exceeds its budget."""
    if not cache_dir.is_dir():
        return 0, 0

    entries = []
    total_bytes = 0
    for path in cache_dir.glob(pattern):
        try:
            stat = path.stat()
        except OSError:
            continue
        total_bytes += stat.st_size
        entries.append((stat.st_mtime_ns, stat.st_size, path))
    if total_bytes <= max_bytes:
        return 0, total_bytes

    target_bytes = int(max_bytes * 0.90)
    removed = 0
    for _, size, path in sorted(entries):
        try:
            path.unlink()
        except OSError:
            continue
        total_bytes -= size
        removed += 1
        if total_bytes <= target_bytes:
            break
    return removed, total_bytes
