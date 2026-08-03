"""Authenticated, resumable uploads through the official YouTube Data API."""
import json
import os
import random
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Iterable, Optional

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    def load_dotenv(*_args, **_kwargs):
        return False

load_dotenv()

YOUTUBE_SCOPES = (
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
)
VALID_PRIVACY_STATUSES = ("private", "unlisted", "public")
RETRIABLE_STATUS_CODES = {500, 502, 503, 504}
DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024


def normalize_publish_at(value: str) -> str:
    """Normalize an explicit timezone-aware schedule to YouTube's UTC format."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("publish_at must be a valid ISO-8601 datetime") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("publish_at must include an explicit timezone offset")
    return (
        parsed.astimezone(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


@dataclass(frozen=True)
class YouTubeMetadata:
    title: str
    description: str
    tags: tuple[str, ...] = ()
    category_id: str = "22"


def load_metadata_file(path: str) -> YouTubeMetadata:
    """Read the simple TITLE/DESCRIPTION format emitted beside rendered Shorts."""
    text = Path(path).read_text(encoding="utf-8")
    match = re.match(
        r"\s*TITLE\s*\n(?P<title>[^\n]+)\s*\n+DESCRIPTION\s*\n(?P<description>[\s\S]+?)\s*$",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        raise ValueError("metadata file must contain TITLE and DESCRIPTION sections")
    title = match.group("title").strip()
    description = match.group("description").strip()
    if not title or len(title) > 100:
        raise ValueError("YouTube title must contain 1-100 characters")
    if len(description) > 5000:
        raise ValueError("YouTube description must not exceed 5000 characters")
    tags = tuple(
        token[1:]
        for token in re.findall(r"(?<!\w)#[A-Za-z0-9_]+", description)
    )
    return YouTubeMetadata(title=title, description=description, tags=tags)


def build_short_metadata(short: Dict, source_url: str = "") -> YouTubeMetadata:
    """Create conservative metadata when no curated metadata file is supplied."""
    title = str(short.get("youtube_title") or short.get("title") or "Short").strip()
    title = title[:100].rstrip()
    description = str(
        short.get("youtube_description")
        or short.get("thesis")
        or short.get("context_summary")
        or ""
    ).strip()
    if source_url:
        description = f"{description}\n\nSource: {source_url}".strip()
    description = f"{description}\n\n#shorts".strip()
    return YouTubeMetadata(title=title, description=description, tags=("shorts",))


def _normalized_handle(value: str) -> str:
    return str(value or "").strip().lower().lstrip("@")


def verify_authenticated_channel(
    youtube,
    expected_handle: str = "",
    expected_channel_id: str = "",
) -> Dict:
    """Fail closed when OAuth points at a different YouTube channel."""
    response = youtube.channels().list(part="id,snippet", mine=True).execute()
    items = response.get("items") or []
    if len(items) != 1:
        raise RuntimeError(f"Expected one authenticated YouTube channel, found {len(items)}")
    channel = items[0]
    channel_id = str(channel.get("id") or "")
    snippet = channel.get("snippet") or {}
    custom_url = str(snippet.get("customUrl") or "")
    if expected_channel_id and channel_id != expected_channel_id:
        raise RuntimeError(
            f"Authenticated channel ID {channel_id!r} does not match "
            f"expected {expected_channel_id!r}"
        )
    if expected_handle and _normalized_handle(custom_url) != _normalized_handle(expected_handle):
        raise RuntimeError(
            f"Authenticated channel {custom_url or channel_id!r} does not match "
            f"expected {expected_handle!r}"
        )
    return {
        "id": channel_id,
        "title": str(snippet.get("title") or ""),
        "handle": custom_url,
    }


def get_authenticated_service(
    client_secrets_file: Optional[str] = None,
    token_file: Optional[str] = None,
    open_browser: bool = True,
):
    """Return an authorized YouTube v3 client and persist a refresh token locally."""
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError as error:
        raise RuntimeError(
            "YouTube upload dependencies are missing. Install requirements-local.txt."
        ) from error

    secrets_path = Path(
        client_secrets_file
        or os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "client_secret.json")
    ).expanduser()
    token_path = Path(
        token_file
        or os.getenv("YOUTUBE_TOKEN_FILE", ".youtube-oauth-token.json")
    ).expanduser()
    if not secrets_path.is_file():
        raise RuntimeError(
            f"YouTube OAuth client file not found: {secrets_path}. "
            "Create a Desktop OAuth client with YouTube Data API v3 enabled."
        )

    credentials = None
    if token_path.is_file():
        credentials = Credentials.from_authorized_user_file(
            str(token_path),
            scopes=YOUTUBE_SCOPES,
        )
    if credentials and credentials.expired and credentials.refresh_token:
        credentials.refresh(Request())
    if not credentials or not credentials.valid:
        flow = InstalledAppFlow.from_client_secrets_file(
            str(secrets_path),
            scopes=YOUTUBE_SCOPES,
        )
        credentials = flow.run_local_server(
            host="127.0.0.1",
            port=0,
            open_browser=open_browser,
            authorization_prompt_message="Open this URL to authorize YouTube uploads:\n{url}",
            success_message="YouTube authorization completed. You can close this tab.",
        )
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(credentials.to_json(), encoding="utf-8")
    try:
        token_path.chmod(0o600)
    except OSError:
        pass
    return build("youtube", "v3", credentials=credentials, cache_discovery=False)


def resumable_upload(
    request,
    max_retries: int = 8,
    sleep: Callable[[float], None] = time.sleep,
    random_value: Callable[[], float] = random.random,
) -> Dict:
    """Upload all chunks, retrying only transport failures and documented 5xx codes."""
    retry = 0
    while True:
        try:
            status, response = request.next_chunk()
            if status is not None:
                progress = int(float(status.progress()) * 100)
                print(f"[youtube] upload progress: {progress}%", flush=True)
            if response is None:
                continue
            if not response.get("id"):
                raise RuntimeError(f"YouTube returned an unexpected response: {response}")
            return response
        except Exception as error:
            status_code = getattr(getattr(error, "resp", None), "status", None)
            retriable = status_code in RETRIABLE_STATUS_CODES or isinstance(
                error,
                (OSError, TimeoutError, ConnectionError),
            )
            if not retriable:
                raise
            retry += 1
            if retry > max_retries:
                raise RuntimeError("YouTube upload exceeded retry limit") from error
            delay = random_value() * min(64.0, float(2**retry))
            print(
                f"[youtube] temporary upload error; retry {retry}/{max_retries} "
                f"in {delay:.1f}s",
                flush=True,
            )
            sleep(delay)


def upload_video(
    youtube,
    video_path: str,
    metadata: YouTubeMetadata,
    privacy_status: str = "private",
    notify_subscribers: bool = False,
    made_for_kids: bool = False,
    contains_synthetic_media: bool = False,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    media_factory=None,
    upload_marker: str = "",
    publish_at: str = "",
) -> Dict:
    """Create a YouTube video resource and upload a local MP4 resumably."""
    if privacy_status not in VALID_PRIVACY_STATUSES:
        raise ValueError(f"privacy_status must be one of {VALID_PRIVACY_STATUSES}")
    normalized_publish_at = normalize_publish_at(publish_at)
    if normalized_publish_at and privacy_status != "private":
        raise ValueError("scheduled YouTube uploads must use private privacy status")
    path = Path(video_path)
    if not path.is_file():
        raise FileNotFoundError(video_path)
    if media_factory is None:
        try:
            from googleapiclient.http import MediaFileUpload
        except ImportError as error:
            raise RuntimeError(
                "YouTube upload dependencies are missing. Install requirements-local.txt."
            ) from error
        media_factory = MediaFileUpload

    tags = list(metadata.tags)
    marker = str(upload_marker or "").strip()
    if marker and marker not in tags:
        tags.append(marker)
    body = {
        "snippet": {
            "title": metadata.title,
            "description": metadata.description,
            "tags": tags,
            "categoryId": metadata.category_id,
        },
        "status": {
            "privacyStatus": privacy_status,
            "selfDeclaredMadeForKids": made_for_kids,
            "containsSyntheticMedia": contains_synthetic_media,
        },
    }
    if normalized_publish_at:
        body["status"]["publishAt"] = normalized_publish_at
    request = youtube.videos().insert(
        part="snippet,status",
        body=body,
        media_body=media_factory(
            str(path),
            chunksize=chunk_size,
            resumable=True,
            mimetype="video/mp4",
        ),
        notifySubscribers=notify_subscribers,
    )
    response = resumable_upload(request)
    return {
        "video_id": response["id"],
        "url": f"https://www.youtube.com/watch?v={response['id']}",
        "privacy_status": privacy_status,
        "publish_at": normalized_publish_at or None,
        "title": metadata.title,
    }


def _video_summary(resource: Dict, upload_marker: str = "") -> Dict:
    video_id = str(resource.get("id") or "").strip()
    snippet = resource.get("snippet") or {}
    status = resource.get("status") or {}
    return {
        "video_id": video_id,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "channel_id": str(snippet.get("channelId") or ""),
        "title": str(snippet.get("title") or ""),
        "published_at": str(snippet.get("publishedAt") or ""),
        "privacy_status": str(status.get("privacyStatus") or ""),
        "publish_at": str(status.get("publishAt") or ""),
        "upload_status": str(status.get("uploadStatus") or ""),
        "upload_marker": str(upload_marker or ""),
    }


def get_video_status(youtube, video_id: str) -> Dict:
    """Return the exact remote status for one video or fail closed."""
    normalized = str(video_id or "").strip()
    response = youtube.videos().list(
        part="id,snippet,status",
        id=normalized,
        maxResults=1,
    ).execute()
    items = response.get("items") or []
    if len(items) != 1 or str(items[0].get("id") or "") != normalized:
        raise RuntimeError(f"YouTube video {normalized!r} was not found")
    return _video_summary(items[0])


def find_video_by_upload_marker(
    youtube,
    channel_id: str,
    upload_marker: str,
) -> Optional[Dict]:
    """Reconcile a crashed upload by an exact private tag in the uploads playlist."""
    normalized_channel = str(channel_id or "").strip()
    marker = str(upload_marker or "").strip()
    if not normalized_channel or not marker:
        raise ValueError("channel_id and upload_marker are required for reconciliation")
    channel_response = youtube.channels().list(
        part="contentDetails",
        id=normalized_channel,
        maxResults=1,
    ).execute()
    channels = channel_response.get("items") or []
    if len(channels) != 1 or str(channels[0].get("id") or "") != normalized_channel:
        raise RuntimeError("authenticated channel uploads playlist was not found")
    uploads_playlist = str(
        ((channels[0].get("contentDetails") or {}).get("relatedPlaylists") or {}).get(
            "uploads"
        )
        or ""
    )
    if not uploads_playlist:
        raise RuntimeError("authenticated channel has no uploads playlist")

    matches = []
    page_token = None
    while True:
        request = {
            "part": "contentDetails",
            "playlistId": uploads_playlist,
            "maxResults": 50,
        }
        if page_token:
            request["pageToken"] = page_token
        page = youtube.playlistItems().list(**request).execute()
        video_ids = [
            str((item.get("contentDetails") or {}).get("videoId") or "").strip()
            for item in page.get("items") or []
        ]
        video_ids = [value for value in video_ids if value]
        if video_ids:
            videos = youtube.videos().list(
                part="id,snippet,status",
                id=",".join(video_ids),
                maxResults=len(video_ids),
            ).execute()
            for video in videos.get("items") or []:
                snippet = video.get("snippet") or {}
                if (
                    str(snippet.get("channelId") or "") == normalized_channel
                    and marker in (snippet.get("tags") or [])
                ):
                    matches.append(_video_summary(video, upload_marker=marker))
        page_token = str(page.get("nextPageToken") or "").strip() or None
        if not page_token:
            break
    if len(matches) > 1:
        raise RuntimeError("upload marker is bound to multiple YouTube videos")
    return matches[0] if matches else None


def update_video_privacy(
    youtube,
    video_id: str,
    privacy_status: str,
) -> Dict:
    """Update an existing video resource; this function never inserts a video."""
    normalized = str(video_id or "").strip()
    privacy = str(privacy_status or "").strip().lower()
    if not normalized:
        raise ValueError("video_id is required")
    if privacy not in VALID_PRIVACY_STATUSES:
        raise ValueError(f"privacy_status must be one of {VALID_PRIVACY_STATUSES}")
    current_response = youtube.videos().list(
        part="status",
        id=normalized,
        maxResults=1,
    ).execute()
    current_items = current_response.get("items") or []
    if len(current_items) != 1 or str(current_items[0].get("id") or "") != normalized:
        raise RuntimeError(f"YouTube video {normalized!r} was not found")
    current_status = current_items[0].get("status") or {}
    mutable_status_fields = (
        "containsSyntheticMedia",
        "embeddable",
        "license",
        "publicStatsViewable",
        "selfDeclaredMadeForKids",
    )
    merged_status = {
        field: current_status[field]
        for field in mutable_status_fields
        if field in current_status
    }
    merged_status["privacyStatus"] = privacy
    response = youtube.videos().update(
        part="status",
        body={"id": normalized, "status": merged_status},
    ).execute()
    returned_id = str(response.get("id") or "").strip()
    returned_privacy = str((response.get("status") or {}).get("privacyStatus") or "")
    if returned_id != normalized or returned_privacy != privacy:
        raise RuntimeError("YouTube did not confirm the requested privacy update")
    return {
        "video_id": returned_id,
        "url": f"https://www.youtube.com/watch?v={returned_id}",
        "privacy_status": returned_privacy,
    }


def upload_rendered_shorts(
    shorts: Iterable[Dict],
    source_url: str,
    metadata_file: Optional[str] = None,
    privacy_status: str = "private",
    expected_handle: str = "",
    expected_channel_id: str = "",
    client_secrets_file: Optional[str] = None,
    token_file: Optional[str] = None,
    notify_subscribers: bool = False,
) -> Dict:
    """Authorize once, verify the target channel, and upload successful renders in order."""
    rendered = [item for item in shorts if item.get("clip_url") and not item.get("error")]
    if not rendered:
        raise RuntimeError("No successfully rendered Shorts are available for upload")
    if metadata_file and len(rendered) != 1:
        raise ValueError("--youtube-metadata-file requires exactly one rendered Short")

    youtube = get_authenticated_service(client_secrets_file, token_file)
    channel = verify_authenticated_channel(
        youtube,
        expected_handle=expected_handle,
        expected_channel_id=expected_channel_id,
    )
    curated = load_metadata_file(metadata_file) if metadata_file else None
    uploads = []
    for short in rendered:
        metadata = curated or build_short_metadata(short, source_url=source_url)
        result = upload_video(
            youtube,
            str(short["clip_url"]),
            metadata,
            privacy_status=privacy_status,
            notify_subscribers=notify_subscribers,
        )
        short["youtube_upload"] = result
        uploads.append(result)
    return {"channel": channel, "uploads": uploads}
