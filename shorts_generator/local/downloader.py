"""Local YouTube download via yt-dlp.

Returns a local mp4 path so the rest of the local pipeline can read it
directly off disk.
"""
import filecmp
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from typing import Any, Callable, Dict, Optional

from ..config import (
    LOCAL_DOWNLOAD_CONCURRENT_FRAGMENTS,
    LOCAL_OUTPUT_DIR,
    LOCAL_SOURCE_CACHE_DIR,
)


def _import_ytdlp():
    try:
        import yt_dlp  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "yt-dlp is required for --mode local. Install it with:\n"
            "    pip install -r requirements-local.txt"
        ) from e
    return yt_dlp


def _requested_height(fmt: str) -> int:
    try:
        return max(144, int(fmt))
    except ValueError:
        return 720


def _preferred_source_height(fmt: str, minimum_hd_height: int = 1080) -> int:
    """Use enough source detail for the active render profile.

    Legacy/full-frame vertical crops retain the 1080p floor. Callers rendering
    the 1014x570 BF inset may safely request a 720p floor because that source is
    still downscaled, never enlarged, in the final composition.
    """
    requested = _requested_height(fmt)
    floor = max(720, int(minimum_hd_height))
    return max(floor, requested) if requested >= 720 else requested


def _format_for(fmt: str, minimum_hd_height: int = 1080) -> str:
    """Map our '720' / '1080' shorthand to a yt-dlp format selector."""
    height = _preferred_source_height(fmt, minimum_hd_height)
    return (
        f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/"
        f"best[height<={height}][ext=mp4]/best"
    )


def _av1_fallback_format_for(fmt: str, minimum_hd_height: int = 1080) -> str:
    """Prefer the smaller MP4/AV1 rendition when YouTube rejects AVC URLs."""
    height = _preferred_source_height(fmt, minimum_hd_height)
    return (
        f"bestvideo[height<={height}][ext=mp4][vcodec^=av01]+bestaudio[ext=m4a]/"
        f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/"
        f"best[height<={height}][ext=mp4]/best"
    )


def _extract_youtube_video_id(source: str) -> Optional[str]:
    """Best-effort extraction of a YouTube video id from a URL."""
    parsed = urlparse(source)
    host = (parsed.netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]

    if host in ("youtu.be", "www.youtu.be"):
        video_id = parsed.path.lstrip("/").split("/", 1)[0]
        return video_id or None

    if "youtube.com" in host:
        if parsed.path.startswith("/watch"):
            qs = parse_qs(parsed.query)
            video_id = qs.get("v", [""])[0]
            return video_id or None
        match = re.search(r"/(?:shorts|embed|live)/([^/?#&]+)", parsed.path)
        if match:
            return match.group(1)

    return None


def _resolve_local_path(source: str) -> Optional[str]:
    """Return a local filesystem path if the input already points at one."""
    parsed = urlparse(source)
    if parsed.scheme == "file":
        raw_path = unquote(parsed.path)
        if parsed.netloc and parsed.netloc not in ("", "localhost"):
            raw_path = f"//{parsed.netloc}{raw_path}"
        candidate = Path(raw_path).expanduser()
        if candidate.exists() and candidate.is_file():
            return str(candidate.resolve())
        raise RuntimeError(f"Local file URL does not exist: {source}")

    if parsed.scheme in ("http", "https"):
        return None

    candidate = Path(source).expanduser()
    if candidate.exists() and candidate.is_file():
        return str(candidate.resolve())

    if any(sep in source for sep in (os.sep, "/")) or source.startswith("~") or source.startswith("."):
        raise RuntimeError(f"Local file path does not exist: {source}")

    return None


def _probe_video_height(path: str) -> Optional[int]:
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=height", "-of", "default=nw=1:nk=1", path,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return int(result.stdout.strip())
    except (FileNotFoundError, subprocess.CalledProcessError, ValueError):
        return None


def _existing_download(out_dir: str, video_id: str, min_height: int) -> Optional[str]:
    """Return the smallest cached source that satisfies the requested quality."""
    directory = Path(out_dir)
    candidates = []
    for ext in ("mp4", "mkv", "webm"):
        candidates.extend(directory.glob(f"source_{video_id}.{ext}"))
        candidates.extend(directory.glob(f"source_{video_id}_*p.{ext}"))

    adequate = []
    for candidate in sorted(set(candidates)):
        height = _probe_video_height(str(candidate))
        if height is not None and height >= min_height:
            adequate.append((height, str(candidate)))
    return min(adequate, default=(0, None), key=lambda item: item[0])[1]


def _materialize_cached_source(source_path: str, out_dir: str) -> str:
    """Copy a legacy cloud-backed source into the OS-local source cache once."""
    source = Path(source_path)
    target_dir = Path(out_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / source.name
    if source.resolve() == target.resolve():
        return str(source)
    if (
        target.is_file()
        and target.stat().st_size == source.stat().st_size
        and filecmp.cmp(source, target, shallow=False)
    ):
        return str(target)

    temporary = target.with_name(f".{target.name}.{os.getpid()}.part")
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()
    return str(target)


def download_youtube_local(
    video_url: str,
    fmt: str = "720",
    out_dir: Optional[str] = None,
    telemetry: Optional[Any] = None,
    minimum_hd_height: int = 1080,
    on_remote_download_start: Optional[Callable[[], Any]] = None,
    on_video_info: Optional[Callable[[Dict], Any]] = None,
) -> str:
    """Download a remote URL or return a local file path unchanged."""
    local_path = _resolve_local_path(video_url)
    if local_path:
        if telemetry is not None:
            telemetry.cache_hit("source")
        print(f"[download/local] using local file: {local_path}", flush=True)
        return local_path

    using_default_cache = out_dir is None
    out_dir = out_dir or LOCAL_SOURCE_CACHE_DIR
    os.makedirs(out_dir, exist_ok=True)
    min_height = _preferred_source_height(fmt, minimum_hd_height)

    video_id = _extract_youtube_video_id(video_url)
    if video_id:
        cached = _existing_download(out_dir, video_id, min_height=min_height)
        if cached:
            if telemetry is not None:
                telemetry.cache_hit("source")
            print(
                f"[download/local] reusing validated { _probe_video_height(cached) }p cache: "
                f"{cached}",
                flush=True,
            )
            return cached
        if using_default_cache and Path(LOCAL_OUTPUT_DIR) != Path(out_dir):
            legacy_cached = _existing_download(
                LOCAL_OUTPUT_DIR,
                video_id,
                min_height=min_height,
            )
            if legacy_cached:
                print(
                    f"[download/local] migrating source cache outside cloud sync: "
                    f"{legacy_cached}",
                    flush=True,
                )
                try:
                    migrated = _materialize_cached_source(legacy_cached, out_dir)
                except OSError as error:
                    print(
                        f"[download/local] source migration skipped ({error}); "
                        "using legacy cache for this run",
                        flush=True,
                    )
                    if telemetry is not None:
                        telemetry.cache_hit("source")
                    return legacy_cached
                if telemetry is not None:
                    telemetry.cache_hit("source")
                print(f"[download/local] local source cache: {migrated}", flush=True)
                return migrated

    if telemetry is not None:
        telemetry.cache_miss("source")
    if on_remote_download_start is not None:
        try:
            on_remote_download_start()
        except Exception as error:
            # Native warm-up is an optimization, never a prerequisite for
            # downloading the source.  The renderer can still import its
            # dependency synchronously later in the run.
            print(
                f"[download/local] background warm-up skipped: {error}",
                flush=True,
            )
    yt_dlp = _import_ytdlp()
    print(f"[download/local] {video_url} @ up to {min_height}p → {out_dir}/", flush=True)
    ydl_opts = {
        "outtmpl": os.path.join(out_dir, "source_%(id)s_%(height)sp.%(ext)s"),
        "merge_output_format": "mp4",
        # DASH/HLS fragments are independent. Bounded concurrency shortens the
        # network-bound stage without changing the selected streams or bytes.
        "concurrent_fragment_downloads": LOCAL_DOWNLOAD_CONCURRENT_FRAGMENTS,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }

    path = ""
    formats = (
        _format_for(fmt, minimum_hd_height),
        _av1_fallback_format_for(fmt, minimum_hd_height),
    )
    for attempt, format_selector in enumerate(formats, start=1):
        attempt_opts = {**ydl_opts, "format": format_selector}
        try:
            with yt_dlp.YoutubeDL(attempt_opts) as ydl:
                info = ydl.extract_info(video_url, download=True)
                if on_video_info is not None:
                    try:
                        on_video_info(info)
                    except Exception as error:
                        # Passing the already-resolved subtitle catalog to the
                        # caption stage is only an optimization.  Never turn a
                        # successful source download into a failed run because
                        # an optional metadata consumer rejected the hint.
                        print(
                            f"[download/local] video metadata handoff skipped: {error}",
                            flush=True,
                        )
                path = ydl.prepare_filename(info)
                # merge_output_format may rename the extension after merge
                if not os.path.exists(path):
                    stem, _ = os.path.splitext(path)
                    for ext in (".mp4", ".mkv", ".webm"):
                        if os.path.exists(stem + ext):
                            path = stem + ext
                            break
            break
        except yt_dlp.utils.DownloadError as error:
            if attempt == 1 and "403" in str(error):
                print(
                    "[download/local] AVC URL rejected with HTTP 403; retrying MP4/AV1",
                    flush=True,
                )
                continue
            raise

    actual_height = _probe_video_height(path)
    if actual_height is None:
        raise RuntimeError(f"Could not validate downloaded video resolution: {path}")
    if actual_height < min_height:
        raise RuntimeError(
            f"Downloaded source is only {actual_height}p; {min_height}p is required "
            f"for the requested polished output."
        )
    print(f"[download/local] ready: {path} ({actual_height}p)", flush=True)
    return path
