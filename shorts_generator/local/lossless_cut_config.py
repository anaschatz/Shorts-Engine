"""Pure environment parsing for the local lossless-cut cache."""

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Union


PathLike = Union[str, Path]

LOSSLESS_CUT_CACHE_ENV = "LOCAL_LOSSLESS_CUT_CACHE"
LOSSLESS_CUT_CACHE_DIR_ENV = "LOCAL_LOSSLESS_CUT_CACHE_DIR"
LOSSLESS_CUT_CACHE_MAX_GB_ENV = "LOCAL_LOSSLESS_CUT_CACHE_MAX_GB"

_ENABLED_VALUES = {"1", "true", "yes", "on"}
_MIN_CACHE_BYTES = 2 * 1024**3
_DEFAULT_MAX_GB = "20"


@dataclass(frozen=True)
class LosslessCutConfig:
    """Import-time values consumed through the existing clipper globals."""

    enabled: bool
    directory: Path
    max_bytes: int


def parse_lossless_cut_config(
    env: Mapping[str, str],
    local_cache_dir: PathLike,
) -> LosslessCutConfig:
    """Parse the existing three-variable contract without process I/O."""
    enabled = env.get(LOSSLESS_CUT_CACHE_ENV, "true").strip().lower() in (
        _ENABLED_VALUES
    )
    directory = Path(
        env.get(
            LOSSLESS_CUT_CACHE_DIR_ENV,
            str(Path(local_cache_dir) / "lossless-cuts-v1"),
        )
    ).expanduser()
    max_bytes = max(
        _MIN_CACHE_BYTES,
        int(
            float(env.get(LOSSLESS_CUT_CACHE_MAX_GB_ENV, _DEFAULT_MAX_GB))
            * 1024**3
        ),
    )
    return LosslessCutConfig(
        enabled=enabled,
        directory=directory,
        max_bytes=max_bytes,
    )
