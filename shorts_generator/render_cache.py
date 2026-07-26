"""Exact-output cache for production renders.

The cache deliberately stores only rendered bytes and their integrity metadata.
Render manifests and QA reports remain downstream artifacts and must be rebuilt
and revalidated whenever a cached MP4 is materialized.

Entries use a small content-addressed object store:

* ``blobs/<sha-prefix>/<output-sha>.mp4`` contains immutable rendered bytes.
* ``entries/<key-prefix>/<render-key>.json`` atomically points at one blob.

Both files are committed with ``os.replace``.  Because metadata points to a
content-addressed blob, concurrent writers cannot leave a permanently mixed
media/metadata pair, even if two processes render different bytes for one key.
"""

from __future__ import annotations

import errno
import hashlib
import json
import math
import os
import shutil
import tempfile
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict


CACHE_SCHEMA_VERSION = 1
_HASH_CHUNK_SIZE = 1024 * 1024


class RenderCacheError(RuntimeError):
    """Raised when a render cannot safely be stored or materialized."""


@dataclass(frozen=True)
class RenderCacheEntry:
    """A validated cached render."""

    cache_key: str
    cached_path: Path
    output_sha256: str
    size_bytes: int
    metadata: Dict[str, Any]


def _sha256(value: str, field: str) -> str:
    normalized = str(value or "").strip().lower().removeprefix("sha256:")
    if len(normalized) != 64 or any(char not in "0123456789abcdef" for char in normalized):
        raise ValueError(f"{field} must be a SHA-256 hash")
    return normalized


def _canonical_value(value: Any, field: str) -> Any:
    """Return a JSON-safe value or reject ambiguous/non-deterministic input."""

    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{field} contains a non-finite float")
        return value
    if isinstance(value, Mapping):
        normalized = {}
        for key in sorted(value):
            if not isinstance(key, str):
                raise TypeError(f"{field} keys must be strings")
            normalized[key] = _canonical_value(value[key], f"{field}.{key}")
        return normalized
    if isinstance(value, (list, tuple)):
        return [
            _canonical_value(item, f"{field}[{index}]")
            for index, item in enumerate(value)
        ]
    raise TypeError(f"{field} contains unsupported value {type(value).__name__}")


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")


def build_render_cache_key(
    *,
    source_hash: str,
    edit_plan_hash: str,
    renderer_fingerprint: str,
    renderer_config: Mapping[str, Any],
    asset_hashes: Mapping[str, str],
) -> str:
    """Build the deterministic identity of an exact production render.

    ``renderer_fingerprint`` should change whenever renderer code or its runtime
    changes. ``renderer_config`` must contain every output-affecting option.
    ``asset_hashes`` binds fonts, music, logos, and other rendered assets by
    content rather than mutable path.
    """

    fingerprint = str(renderer_fingerprint or "").strip()
    if not fingerprint:
        raise ValueError("renderer_fingerprint is required")
    if not isinstance(renderer_config, Mapping):
        raise TypeError("renderer_config must be a mapping")
    if not isinstance(asset_hashes, Mapping):
        raise TypeError("asset_hashes must be a mapping")

    normalized_assets = {}
    for name in sorted(asset_hashes):
        if not isinstance(name, str) or not name.strip():
            raise ValueError("asset_hashes keys must be non-empty strings")
        normalized_assets[name] = _sha256(asset_hashes[name], f"asset_hashes.{name}")

    identity = {
        "schemaVersion": CACHE_SCHEMA_VERSION,
        "sourceHash": _sha256(source_hash, "source_hash"),
        "editPlanHash": _sha256(edit_plan_hash, "edit_plan_hash"),
        "rendererFingerprint": fingerprint,
        "rendererConfig": _canonical_value(renderer_config, "renderer_config"),
        "assetHashes": normalized_assets,
    }
    return hashlib.sha256(_canonical_json(identity)).hexdigest()


def file_sha256(path: str | os.PathLike[str]) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(_HASH_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_directory(directory: Path) -> None:
    """Best-effort durability for the rename that just happened."""

    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _write_json_atomic(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(_canonical_json(payload))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _copy_render_to_temporary(source: Path, destination: Path) -> tuple[str, int]:
    before = source.stat()
    digest = hashlib.sha256()
    size_bytes = 0
    with source.open("rb") as reader, destination.open("xb") as writer:
        for chunk in iter(lambda: reader.read(_HASH_CHUNK_SIZE), b""):
            writer.write(chunk)
            digest.update(chunk)
            size_bytes += len(chunk)
        writer.flush()
        os.fsync(writer.fileno())
    after = source.stat()
    identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if identity_before != identity_after or size_bytes != before.st_size:
        raise RenderCacheError("rendered MP4 changed while it was being cached")
    if size_bytes <= 0:
        raise RenderCacheError("rendered MP4 is empty")
    return digest.hexdigest(), size_bytes


class RenderCache:
    """Disk-backed exact-output render cache."""

    def __init__(self, root: str | os.PathLike[str]):
        self.root = Path(root)
        self._blobs = self.root / "blobs"
        self._entries = self.root / "entries"

    def _metadata_path(self, cache_key: str) -> Path:
        cache_key = _sha256(cache_key, "cache_key")
        return self._entries / cache_key[:2] / f"{cache_key}.json"

    def _blob_path(self, output_sha256: str) -> Path:
        output_sha256 = _sha256(output_sha256, "output_sha256")
        return self._blobs / output_sha256[:2] / f"{output_sha256}.mp4"

    def lookup(self, cache_key: str) -> RenderCacheEntry | None:
        """Return a cache entry only after key, size, and SHA-256 validation."""

        normalized_key = _sha256(cache_key, "cache_key")
        metadata_path = self._metadata_path(normalized_key)
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if not isinstance(metadata, dict):
                return None
            if metadata.get("schemaVersion") != CACHE_SCHEMA_VERSION:
                return None
            if _sha256(metadata.get("cacheKey"), "metadata.cacheKey") != normalized_key:
                return None
            output_sha256 = _sha256(
                metadata.get("outputSha256"),
                "metadata.outputSha256",
            )
            size_bytes = metadata.get("sizeBytes")
            if isinstance(size_bytes, bool) or not isinstance(size_bytes, int) or size_bytes <= 0:
                return None
            cached_metadata = _canonical_value(
                metadata.get("metadata", {}),
                "metadata.metadata",
            )
            if not isinstance(cached_metadata, dict):
                return None
            declared_metadata_hash = _sha256(
                metadata.get("metadataSha256"),
                "metadata.metadataSha256",
            )
            if hashlib.sha256(_canonical_json(cached_metadata)).hexdigest() != declared_metadata_hash:
                return None
            cached_path = self._blob_path(output_sha256)
            if not cached_path.is_file() or cached_path.stat().st_size != size_bytes:
                return None
            if file_sha256(cached_path) != output_sha256:
                return None
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return None
        return RenderCacheEntry(
            cache_key=normalized_key,
            cached_path=cached_path,
            output_sha256=output_sha256,
            size_bytes=size_bytes,
            metadata=cached_metadata,
        )

    def store(
        self,
        cache_key: str,
        rendered_mp4: str | os.PathLike[str],
        *,
        metadata: Mapping[str, Any] | None = None,
    ) -> RenderCacheEntry:
        """Atomically store rendered bytes and publish their cache metadata."""

        normalized_key = _sha256(cache_key, "cache_key")
        source = Path(rendered_mp4)
        if not source.is_file():
            raise RenderCacheError(f"rendered MP4 does not exist: {source}")
        if source.suffix.lower() != ".mp4":
            raise RenderCacheError("rendered output must have an .mp4 extension")
        cached_metadata = _canonical_value(
            dict(metadata or {}),
            "metadata",
        )

        self._blobs.mkdir(parents=True, exist_ok=True)
        temporary = self._blobs / f".render-{uuid.uuid4().hex}.tmp"
        try:
            output_sha256, size_bytes = _copy_render_to_temporary(source, temporary)
            blob_path = self._blob_path(output_sha256)
            blob_path.parent.mkdir(parents=True, exist_ok=True)

            existing_is_valid = (
                blob_path.is_file()
                and blob_path.stat().st_size == size_bytes
                and file_sha256(blob_path) == output_sha256
            )
            if existing_is_valid:
                temporary.unlink()
            else:
                os.replace(temporary, blob_path)
                _fsync_directory(blob_path.parent)

            metadata = {
                "schemaVersion": CACHE_SCHEMA_VERSION,
                "cacheKey": normalized_key,
                "outputSha256": output_sha256,
                "sizeBytes": size_bytes,
                "metadata": cached_metadata,
                "metadataSha256": hashlib.sha256(
                    _canonical_json(cached_metadata)
                ).hexdigest(),
            }
            _write_json_atomic(self._metadata_path(normalized_key), metadata)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise

        return RenderCacheEntry(
            cache_key=normalized_key,
            cached_path=blob_path,
            output_sha256=output_sha256,
            size_bytes=size_bytes,
            metadata=cached_metadata,
        )

    def materialize(
        self,
        cache_key: str,
        output_path: str | os.PathLike[str],
    ) -> Path | None:
        """Atomically materialize a validated hit via hardlink or exact copy.

        The destination's parent directory is created when necessary.  A
        pre-existing destination is left untouched if validation or copying
        fails.  Returning ``None`` means the entry was absent or corrupt.
        """

        entry = self.lookup(cache_key)
        if entry is None:
            return None

        return self.materialize_entry(entry, output_path)

    def materialize_entry(
        self,
        entry: RenderCacheEntry,
        output_path: str | os.PathLike[str],
    ) -> Path:
        """Materialize an entry already validated by :meth:`lookup`.

        This avoids hashing the same immutable blob twice when the caller also
        needs the entry metadata.  The copy fallback still verifies the bytes
        it transfers, and the content-addressed blob path is checked against
        the supplied digest before publication.
        """
        if not isinstance(entry, RenderCacheEntry):
            raise TypeError("entry must be a RenderCacheEntry")
        expected_path = self._blob_path(entry.output_sha256)
        if entry.cached_path != expected_path:
            raise RenderCacheError("cache entry blob path does not match its digest")

        destination = Path(output_path)
        if destination.exists() and destination.is_dir():
            raise RenderCacheError(f"output path is a directory: {destination}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.parent / f".{destination.name}.{uuid.uuid4().hex}.tmp"
        fallback_errors = {
            errno.EXDEV,
            errno.EPERM,
            errno.EACCES,
            errno.EMLINK,
            getattr(errno, "ENOTSUP", -1),
            getattr(errno, "EOPNOTSUPP", -1),
            getattr(errno, "ENOSYS", -1),
        }
        try:
            try:
                os.link(entry.cached_path, temporary)
            except OSError as error:
                if error.errno not in fallback_errors:
                    raise
                copied_hash, copied_size = _copy_render_to_temporary(
                    entry.cached_path,
                    temporary,
                )
                if copied_hash != entry.output_sha256 or copied_size != entry.size_bytes:
                    raise RenderCacheError("cached MP4 changed while being materialized")
            os.replace(temporary, destination)
            _fsync_directory(destination.parent)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        return destination
