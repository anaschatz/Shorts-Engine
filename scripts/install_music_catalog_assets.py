#!/usr/bin/env python3
"""Install the private runtime music assets described by the sealed catalog.

The catalog and this installer are safe to version.  The raw Pixabay files are
kept out of Git because their license permits use in rendered works, not
standalone redistribution.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import urllib.request
from pathlib import Path


def _canonical_hash(value: dict) -> str:
    body = dict(value)
    body.pop("contentHash", None)
    encoded = json.dumps(
        body,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _file_identity(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    length = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            length += len(chunk)
    return digest.hexdigest(), length


def _load_catalog(path: Path) -> dict:
    catalog = json.loads(path.read_text(encoding="utf-8"))
    if catalog.get("artifactType") != "ViralMusicCatalog":
        raise ValueError("music catalog has the wrong artifactType")
    expected = str(catalog.get("contentHash") or "").lower()
    actual = _canonical_hash(catalog)
    if expected != actual:
        raise ValueError(
            f"music catalog seal mismatch: expected={expected}, actual={actual}"
        )
    return catalog


def _install(track: dict, root: Path, *, check_only: bool) -> str:
    destination = (root / str(track["relativePath"])).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    expected_hash = str(track["sha256"]).lower()
    expected_length = int(track["byteLength"])
    if destination.is_file():
        actual_hash, actual_length = _file_identity(destination)
        if (actual_hash, actual_length) == (expected_hash, expected_length):
            return "verified"
        if check_only:
            raise ValueError(
                f"asset integrity mismatch for {track['trackId']}: {destination}"
            )
    elif check_only:
        raise FileNotFoundError(
            f"asset missing for {track['trackId']}: {destination}"
        )

    if check_only:
        raise AssertionError("unreachable")
    request = urllib.request.Request(
        str(track["contentUrl"]),
        headers={"User-Agent": "Shorts-Engine music asset installer/1.0"},
    )
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".download",
        dir=str(destination.parent),
    )
    os.close(file_descriptor)
    temporary = Path(temporary_name)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            with temporary.open("wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
        actual_hash, actual_length = _file_identity(temporary)
        if (actual_hash, actual_length) != (expected_hash, expected_length):
            raise ValueError(
                f"download integrity mismatch for {track['trackId']}"
            )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return "installed"


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Install or verify the sealed viral-music catalog assets"
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=repo_root / "assets" / "music" / "catalog.v1.json",
    )
    parser.add_argument("--root", type=Path, default=repo_root)
    parser.add_argument("--track-id", action="append", default=[])
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    catalog = _load_catalog(args.catalog.resolve())
    requested = set(args.track_id)
    tracks = [
        track
        for track in catalog.get("tracks", [])
        if not requested or track.get("trackId") in requested
    ]
    if requested - {str(track.get("trackId")) for track in tracks}:
        missing = sorted(requested - {str(track.get("trackId")) for track in tracks})
        raise ValueError(f"unknown track IDs: {', '.join(missing)}")
    if not tracks:
        raise ValueError("catalog contains no selected tracks")

    results = {
        str(track["trackId"]): _install(
            track,
            args.root.resolve(),
            check_only=args.check,
        )
        for track in tracks
    }
    print(
        json.dumps(
            {
                "catalogVersion": catalog["catalogVersion"],
                "catalogHash": catalog["contentHash"],
                "results": results,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
