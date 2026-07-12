#!/usr/bin/env python3
"""Resumable, channel-verified YouTube publisher for reviewed ShortsEngine exports."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "publishing" / "youtube-fifa20.json"
DEFAULT_CREDENTIALS = ROOT / "var" / "youtube-publisher" / "client-secret.json"
DEFAULT_TOKEN = ROOT / "var" / "youtube-publisher" / "oauth-token.json"
DEFAULT_STATE = ROOT / "var" / "youtube-publisher" / "upload-state.json"
SCOPES = (
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube.force-ssl",
)
PUBLISH_SCOPES = SCOPES[:2]
RETRIABLE_STATUS_CODES = {500, 502, 503, 504}


class PublishError(RuntimeError):
    pass


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise PublishError(f"Missing JSON file: {path}") from exc
    except json.JSONDecodeError as exc:
        raise PublishError(f"Invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise PublishError(f"Expected a JSON object in {path}")
    return value


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def resolve_managed_media(root: Path, relative_path: str) -> Path:
    candidate = (root / relative_path).resolve()
    media_root = (root / "manual-downloads").resolve()
    try:
        candidate.relative_to(media_root)
    except ValueError as exc:
        raise PublishError(f"Media must stay under manual-downloads: {relative_path}") from exc
    if candidate.suffix.lower() != ".mp4":
        raise PublishError(f"Only MP4 media is supported: {relative_path}")
    if not candidate.is_file():
        raise PublishError(f"Missing media file: {relative_path}")
    return candidate


def validate_manifest(manifest_path: Path, root: Path = ROOT) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = read_json(manifest_path)
    if manifest.get("schemaVersion") != 1:
        raise PublishError("Unsupported publishing manifest schemaVersion")
    items = manifest.get("items")
    if not isinstance(items, list) or not items:
        raise PublishError("Publishing manifest must contain a non-empty items array")

    seen_ids: set[str] = set()
    seen_files: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for position, raw in enumerate(items, start=1):
        if not isinstance(raw, dict):
            raise PublishError(f"Manifest item {position} must be an object")
        item_id = str(raw.get("id") or "").strip()
        title = str(raw.get("title") or "").strip()
        description = str(raw.get("description") or "").strip()
        relative_file = str(raw.get("file") or "").strip()
        tags = raw.get("tags")
        if not item_id or item_id in seen_ids:
            raise PublishError(f"Manifest item {position} has a missing or duplicate id")
        if not title or len(title) > 100:
            raise PublishError(f"Title for {item_id} must contain 1..100 characters")
        if not description or len(description) > 5000:
            raise PublishError(f"Description for {item_id} must contain 1..5000 characters")
        if "#Shorts" not in description or "#Football" not in description:
            raise PublishError(f"Description for {item_id} must include #Shorts and #Football")
        if not isinstance(tags, list) or not tags or any(not isinstance(tag, str) or not tag.strip() for tag in tags):
            raise PublishError(f"Tags for {item_id} must be a non-empty string array")
        if relative_file in seen_files:
            raise PublishError(f"Duplicate media file in manifest: {relative_file}")
        media_path = resolve_managed_media(root, relative_file)
        seen_ids.add(item_id)
        seen_files.add(relative_file)
        normalized.append({**raw, "id": item_id, "title": title, "description": description, "tags": tags, "mediaPath": media_path})
    return manifest, normalized


def probe_media(path: Path) -> dict[str, Any]:
    ffprobe = shutil.which(os.environ.get("FFPROBE_BIN", "ffprobe"))
    if not ffprobe:
        raise PublishError("ffprobe is required to validate Shorts media")
    result = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise PublishError(f"ffprobe could not validate {path.name}")
    payload = json.loads(result.stdout)
    streams = payload.get("streams") or []
    if not streams:
        raise PublishError(f"No video stream in {path.name}")
    width = int(streams[0].get("width") or 0)
    height = int(streams[0].get("height") or 0)
    duration = float((payload.get("format") or {}).get("duration") or 0)
    if width <= 0 or height <= 0 or width > height:
        raise PublishError(f"Expected square or vertical media for {path.name}, got {width}x{height}")
    if duration <= 0 or duration > 180:
        raise PublishError(f"Expected duration within 0..180 seconds for {path.name}, got {duration:.3f}")
    return {"width": width, "height": height, "durationSeconds": round(duration, 3), "bytes": path.stat().st_size}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_video_body(item: dict[str, Any], privacy: str) -> dict[str, Any]:
    return {
        "snippet": {
            "title": item["title"],
            "description": item["description"],
            "tags": item["tags"],
            "categoryId": str(item.get("categoryId") or "17"),
            "defaultLanguage": item.get("defaultLanguage") or "en",
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": bool(item.get("madeForKids", False)),
        },
    }


def load_google_dependencies() -> dict[str, Any]:
    try:
        import httplib2
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
        from googleapiclient.errors import HttpError
        from googleapiclient.http import MediaFileUpload, ResumableUploadError
    except ImportError as exc:
        raise PublishError("Missing Google API packages. Run: python3 -m pip install -r requirements-youtube.txt") from exc
    return {
        "httplib2": httplib2,
        "Request": Request,
        "Credentials": Credentials,
        "InstalledAppFlow": InstalledAppFlow,
        "build": build,
        "HttpError": HttpError,
        "MediaFileUpload": MediaFileUpload,
        "ResumableUploadError": ResumableUploadError,
    }


def authorize(
    credentials_path: Path,
    token_path: Path,
    dependencies: dict[str, Any],
    open_browser: bool = True,
    scopes: tuple[str, ...] = SCOPES,
) -> Any:
    if not credentials_path.is_file():
        raise PublishError(
            f"OAuth client file is missing: {credentials_path}. Create a Desktop OAuth client and place its JSON there."
        )
    credentials = None
    if token_path.is_file():
        credentials = dependencies["Credentials"].from_authorized_user_file(str(token_path), scopes)
        if hasattr(credentials, "has_scopes") and not credentials.has_scopes(scopes):
            credentials = None
    if credentials and credentials.expired and credentials.refresh_token:
        credentials.refresh(dependencies["Request"]())
    if not credentials or not credentials.valid:
        flow = dependencies["InstalledAppFlow"].from_client_secrets_file(str(credentials_path), scopes)
        credentials = flow.run_local_server(port=0, access_type="offline", prompt="consent", open_browser=open_browser)
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(credentials.to_json() + "\n", encoding="utf-8")
    os.chmod(token_path, 0o600)
    return credentials


def authenticated_channel(youtube: Any) -> dict[str, str]:
    response = youtube.channels().list(part="id,snippet", mine=True, maxResults=1).execute()
    items = response.get("items") or []
    if len(items) != 1:
        raise PublishError("OAuth account does not expose exactly one active YouTube channel")
    return {"id": items[0]["id"], "title": items[0].get("snippet", {}).get("title") or ""}


def google_error_reason(error: Any) -> str:
    content = getattr(error, "content", b"")
    if isinstance(content, bytes):
        content = content.decode("utf-8", errors="replace")
    try:
        payload = json.loads(content) if content else {}
    except json.JSONDecodeError:
        return "unknown"
    details = (payload.get("error") or {}).get("errors") or []
    if details and isinstance(details[0], dict):
        return str(details[0].get("reason") or "unknown")
    return "unknown"


def upload_video(youtube: Any, item: dict[str, Any], privacy: str, dependencies: dict[str, Any]) -> str:
    media = dependencies["MediaFileUpload"](
        str(item["mediaPath"]), mimetype="video/mp4", chunksize=8 * 1024 * 1024, resumable=True
    )
    request = youtube.videos().insert(part="snippet,status", body=build_video_body(item, privacy), media_body=media)
    response = None
    retry = 0
    while response is None:
        try:
            progress, response = request.next_chunk()
            retry = 0
            if progress:
                print(json.dumps({"event": "upload_progress", "id": item["id"], "progress": round(progress.progress(), 4)}), flush=True)
        except dependencies["ResumableUploadError"] as exc:
            reason = google_error_reason(exc)
            if reason == "uploadLimitExceeded":
                raise PublishError(
                    "YOUTUBE_UPLOAD_LIMIT_EXCEEDED: the channel reached its rolling 24-hour upload limit; rerun the same command after 24 hours"
                ) from exc
            raise PublishError(f"YouTube rejected upload for {item['id']} ({reason})") from exc
        except dependencies["HttpError"] as exc:
            if exc.resp.status not in RETRIABLE_STATUS_CODES:
                raise PublishError(f"YouTube API rejected upload for {item['id']} ({google_error_reason(exc)})") from exc
            retry += 1
            if retry > 8:
                raise PublishError(f"Upload retries exhausted for {item['id']}") from exc
            time.sleep(min(60, (2**retry) + random.random()))
        except (dependencies["httplib2"].HttpLib2Error, OSError) as exc:
            retry += 1
            if retry > 8:
                raise PublishError(f"Upload retries exhausted for {item['id']}") from exc
            time.sleep(min(60, (2**retry) + random.random()))
    video_id = response.get("id") if isinstance(response, dict) else None
    if not video_id:
        raise PublishError(f"YouTube returned no video id for {item['id']}")
    return str(video_id)


def choose_items(items: list[dict[str, Any]], only: str | None) -> list[dict[str, Any]]:
    if not only:
        return items
    wanted = {value.strip() for value in only.split(",") if value.strip()}
    selected = [item for item in items if item["id"] in wanted]
    missing = wanted - {item["id"] for item in selected}
    if missing:
        raise PublishError(f"Unknown manifest ids: {', '.join(sorted(missing))}")
    return selected


def validate_visibility(items: list[dict[str, Any]], privacy: str, allow_review_required: bool, confirm_public: bool) -> None:
    if privacy == "public" and not confirm_public:
        raise PublishError("Public upload requires --confirm-public")
    review_required = [item["id"] for item in items if not item.get("qaAcceptedWithoutEdit")]
    if privacy != "private" and review_required and not allow_review_required:
        raise PublishError(
            f"{len(review_required)} selected clips still require edits; use private visibility or explicitly pass --allow-review-required"
        )


def run_plan(manifest_path: Path, only: str | None) -> int:
    manifest, items = validate_manifest(manifest_path)
    items = choose_items(items, only)
    output = []
    for item in items:
        output.append(
            {
                "id": item["id"],
                "title": item["title"],
                "privacy": manifest.get("defaultPrivacy", "private"),
                "qaAcceptedWithoutEdit": bool(item.get("qaAcceptedWithoutEdit")),
                "media": probe_media(item["mediaPath"]),
            }
        )
    print(json.dumps({"ok": True, "manifestId": manifest.get("manifestId"), "count": len(output), "items": output}, indent=2))
    return 0


def create_youtube(
    credentials_path: Path,
    token_path: Path,
    open_browser: bool = True,
    scopes: tuple[str, ...] = SCOPES,
) -> tuple[Any, dict[str, Any]]:
    dependencies = load_google_dependencies()
    credentials = authorize(credentials_path, token_path, dependencies, open_browser=open_browser, scopes=scopes)
    youtube = dependencies["build"]("youtube", "v3", credentials=credentials, cache_discovery=False)
    return youtube, dependencies


def run_auth(credentials_path: Path, token_path: Path, open_browser: bool = True) -> int:
    youtube, _ = create_youtube(credentials_path, token_path, open_browser=open_browser)
    channel = authenticated_channel(youtube)
    print(json.dumps({"ok": True, "channel": channel, "tokenPath": str(token_path)}, indent=2))
    return 0


def run_import_client(credentials_path: Path) -> int:
    if sys.platform != "darwin" or not shutil.which("pbpaste"):
        raise PublishError("Clipboard import currently requires macOS pbpaste")
    result = subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=10, check=False)
    if result.returncode != 0 or not result.stdout.strip():
        raise PublishError("Clipboard does not contain an OAuth client JSON object")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise PublishError("Clipboard does not contain valid JSON") from exc
    installed = payload.get("installed") if isinstance(payload, dict) else None
    required = ("client_id", "client_secret", "auth_uri", "token_uri", "redirect_uris")
    if not isinstance(installed, dict) or any(not installed.get(key) for key in required):
        raise PublishError("Clipboard JSON is not a complete Desktop OAuth client configuration")
    atomic_write_json(credentials_path, payload)
    print(json.dumps({"ok": True, "credentialsPath": str(credentials_path), "projectId": installed.get("project_id")} , indent=2))
    return 0


def run_upload(args: argparse.Namespace) -> int:
    manifest, items = validate_manifest(args.manifest)
    items = choose_items(items, args.only)
    privacy = args.privacy or manifest.get("defaultPrivacy") or "private"
    validate_visibility(items, privacy, args.allow_review_required, args.confirm_public)
    for item in items:
        probe_media(item["mediaPath"])

    youtube, dependencies = create_youtube(args.credentials, args.token, scopes=PUBLISH_SCOPES)
    channel = authenticated_channel(youtube)
    expected_channel = args.expected_channel_id or os.environ.get("SHORTSENGINE_YOUTUBE_CHANNEL_ID")
    if not expected_channel:
        raise PublishError(
            f"Authenticated channel is {channel['title']} ({channel['id']}). Rerun with --expected-channel-id {channel['id']}"
        )
    if channel["id"] != expected_channel:
        raise PublishError(f"Authenticated channel {channel['id']} does not match expected channel {expected_channel}")

    state = read_json(args.state) if args.state.is_file() else {"schemaVersion": 1, "uploads": {}}
    uploads = state.setdefault("uploads", {})
    state["channel"] = channel
    state["manifestId"] = manifest.get("manifestId")
    completed = 0
    skipped = 0
    for item in items:
        digest = sha256_file(item["mediaPath"])
        previous = uploads.get(item["id"])
        if previous and previous.get("sha256") == digest and previous.get("youtubeVideoId") and not args.force:
            skipped += 1
            print(json.dumps({"event": "upload_skipped", "id": item["id"], "youtubeVideoId": previous["youtubeVideoId"]}), flush=True)
            continue
        if previous and previous.get("sha256") != digest and not args.force:
            raise PublishError(f"Media changed for already uploaded item {item['id']}; inspect it and use --force only intentionally")
        print(json.dumps({"event": "upload_started", "id": item["id"], "privacy": privacy}), flush=True)
        video_id = upload_video(youtube, item, privacy, dependencies)
        uploads[item["id"]] = {
            "youtubeVideoId": video_id,
            "sha256": digest,
            "privacyStatus": privacy,
            "uploadedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "title": item["title"],
        }
        atomic_write_json(args.state, state)
        completed += 1
        print(json.dumps({"event": "upload_completed", "id": item["id"], "youtubeVideoId": video_id}), flush=True)
    print(json.dumps({"ok": True, "channel": channel, "uploaded": completed, "skipped": skipped, "privacy": privacy}, indent=2))
    return 0


def run_verify(args: argparse.Namespace) -> int:
    _, manifest_items = validate_manifest(args.manifest)
    manifest_items = choose_items(manifest_items, args.only)
    state = read_json(args.state)
    uploads = state.get("uploads") or {}
    expected: dict[str, dict[str, Any]] = {}
    for item in manifest_items:
        upload = uploads.get(item["id"])
        if not upload or not upload.get("youtubeVideoId"):
            raise PublishError(f"No completed upload state for {item['id']}")
        expected[str(upload["youtubeVideoId"])] = {"item": item, "upload": upload}

    youtube, _ = create_youtube(args.credentials, args.token, scopes=PUBLISH_SCOPES)
    channel = authenticated_channel(youtube)
    expected_channel = args.expected_channel_id or os.environ.get("SHORTSENGINE_YOUTUBE_CHANNEL_ID")
    if expected_channel and channel["id"] != expected_channel:
        raise PublishError(f"Authenticated channel {channel['id']} does not match expected channel {expected_channel}")

    deadline = time.monotonic() + max(0, args.wait_seconds)
    while True:
        response = youtube.videos().list(
            part="snippet,status,processingDetails", id=",".join(expected), maxResults=len(expected)
        ).execute()
        remote = {str(video.get("id")): video for video in response.get("items") or []}
        report = []
        pending = False
        failures = []
        for video_id, details in expected.items():
            video = remote.get(video_id)
            if not video:
                failures.append(f"Missing remote video {video_id}")
                continue
            snippet = video.get("snippet") or {}
            status = video.get("status") or {}
            processing = video.get("processingDetails") or {}
            upload_status = str(status.get("uploadStatus") or "unknown")
            processing_status = str(processing.get("processingStatus") or "unknown")
            title_matches = snippet.get("title") == details["item"]["title"]
            privacy_matches = status.get("privacyStatus") == details["upload"].get("privacyStatus")
            if upload_status in {"failed", "rejected", "deleted"} or processing_status in {"failed", "terminated"}:
                failures.append(f"YouTube processing failed for {details['item']['id']}")
            if not title_matches or not privacy_matches:
                failures.append(f"YouTube metadata mismatch for {details['item']['id']}")
            if upload_status not in {"processed", "rejected", "failed", "deleted"} and processing_status not in {
                "succeeded",
                "failed",
                "terminated",
            }:
                pending = True
            report.append(
                {
                    "id": details["item"]["id"],
                    "youtubeVideoId": video_id,
                    "uploadStatus": upload_status,
                    "processingStatus": processing_status,
                    "privacyStatus": status.get("privacyStatus"),
                    "titleMatches": title_matches,
                }
            )
        if failures:
            raise PublishError("; ".join(failures))
        if not pending or time.monotonic() >= deadline:
            print(json.dumps({"ok": not pending, "channel": channel, "pending": pending, "items": report}, indent=2))
            return 0 if not pending else 2
        time.sleep(5)


def run_purge(args: argparse.Namespace) -> int:
    if args.confirm_delete != "DELETE_FIFA20_PRIVATE_BATCH":
        raise PublishError("Purge requires --confirm-delete DELETE_FIFA20_PRIVATE_BATCH")
    manifest, items = validate_manifest(args.manifest)
    state = read_json(args.state)
    uploads = state.get("uploads") or {}
    youtube, dependencies = create_youtube(args.credentials, args.token)
    channel = authenticated_channel(youtube)
    expected_channel = args.expected_channel_id or os.environ.get("SHORTSENGINE_YOUTUBE_CHANNEL_ID")
    if not expected_channel or channel["id"] != expected_channel:
        raise PublishError(f"Authenticated channel {channel['id']} does not match the required expected channel")

    remote_ids = [str(upload.get("youtubeVideoId")) for upload in uploads.values() if upload.get("youtubeVideoId")]
    remote_by_id: dict[str, dict[str, Any]] = {}
    if remote_ids:
        response = youtube.videos().list(part="snippet,status", id=",".join(remote_ids), maxResults=len(remote_ids)).execute()
        remote_by_id = {str(video.get("id")): video for video in response.get("items") or []}
        wrong_channel = [
            video_id
            for video_id, video in remote_by_id.items()
            if (video.get("snippet") or {}).get("channelId") != expected_channel
        ]
        if wrong_channel:
            raise PublishError("Purge refused because one or more videos do not belong to the expected channel")

    deleted_remote = []
    already_missing = []
    for item_id, upload in list(uploads.items()):
        video_id = str(upload.get("youtubeVideoId") or "")
        if not video_id:
            continue
        if video_id not in remote_by_id:
            already_missing.append(video_id)
        else:
            try:
                youtube.videos().delete(id=video_id).execute()
            except dependencies["HttpError"] as exc:
                if getattr(exc.resp, "status", None) != 404:
                    raise PublishError(f"YouTube refused deletion for {item_id} ({google_error_reason(exc)})") from exc
                already_missing.append(video_id)
            else:
                deleted_remote.append(video_id)
        del uploads[item_id]
        state["uploads"] = uploads
        atomic_write_json(args.state, state)
        print(json.dumps({"event": "remote_deleted", "id": item_id, "youtubeVideoId": video_id}), flush=True)

    deleted_local = []
    for item in items:
        candidates = [
            item["mediaPath"],
            item["mediaPath"].with_name(f"{item['mediaPath'].stem}-contact.jpg"),
        ]
        for candidate in candidates:
            if candidate.is_file():
                candidate.unlink()
                deleted_local.append(str(candidate.relative_to(ROOT)))

    report = {
        "schemaVersion": 1,
        "manifestId": manifest.get("manifestId"),
        "channel": channel,
        "deletedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "deletedRemoteVideoIds": deleted_remote,
        "alreadyMissingRemoteVideoIds": already_missing,
        "deletedLocalFiles": deleted_local,
    }
    report_path = args.state.with_name("purge-report.json")
    atomic_write_json(report_path, report)
    print(
        json.dumps(
            {
                "ok": True,
                "channel": channel,
                "deletedRemote": len(deleted_remote),
                "alreadyMissingRemote": len(already_missing),
                "deletedLocal": len(deleted_local),
                "reportPath": str(report_path),
            },
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan = subparsers.add_parser("plan", help="Validate all media and print the upload plan without network calls")
    plan.add_argument("--only", help="Comma-separated manifest ids")

    auth = subparsers.add_parser("auth", help="Authorize OAuth and print the selected YouTube channel")
    auth.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)
    auth.add_argument("--token", type=Path, default=DEFAULT_TOKEN)
    auth.add_argument("--no-browser", action="store_true", help="Print the OAuth URL instead of opening the default browser")

    import_client = subparsers.add_parser("import-client", help="Validate a Desktop OAuth client JSON from the macOS clipboard")
    import_client.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)

    upload = subparsers.add_parser("upload", help="Upload resumably and persist duplicate-safe state")
    upload.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)
    upload.add_argument("--token", type=Path, default=DEFAULT_TOKEN)
    upload.add_argument("--state", type=Path, default=DEFAULT_STATE)
    upload.add_argument("--expected-channel-id")
    upload.add_argument("--privacy", choices=("private", "unlisted", "public"))
    upload.add_argument("--only", help="Comma-separated manifest ids")
    upload.add_argument("--allow-review-required", action="store_true")
    upload.add_argument("--confirm-public", action="store_true")
    upload.add_argument("--force", action="store_true")

    verify = subparsers.add_parser("verify", help="Verify remote processing, metadata, and privacy for uploaded videos")
    verify.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)
    verify.add_argument("--token", type=Path, default=DEFAULT_TOKEN)
    verify.add_argument("--state", type=Path, default=DEFAULT_STATE)
    verify.add_argument("--expected-channel-id")
    verify.add_argument("--only", help="Comma-separated manifest ids")
    verify.add_argument("--wait-seconds", type=int, default=0)

    purge = subparsers.add_parser("purge", help="Delete only the managed FIFA20 YouTube batch and generated local outputs")
    purge.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)
    purge.add_argument("--token", type=Path, default=DEFAULT_TOKEN)
    purge.add_argument("--state", type=Path, default=DEFAULT_STATE)
    purge.add_argument("--expected-channel-id", required=True)
    purge.add_argument("--confirm-delete", required=True)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "plan":
            return run_plan(args.manifest, args.only)
        if args.command == "auth":
            return run_auth(args.credentials, args.token, open_browser=not args.no_browser)
        if args.command == "import-client":
            return run_import_client(args.credentials)
        if args.command == "upload":
            return run_upload(args)
        if args.command == "verify":
            return run_verify(args)
        if args.command == "purge":
            return run_purge(args)
        raise PublishError(f"Unsupported command: {args.command}")
    except PublishError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
