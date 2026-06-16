# ShortsEngine YouTube Ingest Manual Smoke

This guide is for an explicit, operator-run proof that ShortsEngine can ingest an authorized YouTube URL, convert it into a local MP4 artifact, render a short, and download the resulting MP4. It is not part of default CI and it must not run without an explicit manual flag.

## Safety And Rights

- Use only videos you own, have licensed, or are otherwise authorized to process.
- Respect YouTube terms, copyright, privacy, platform rules, and local law.
- Do not use private videos, credentialed URLs, playlists, live streams, channel pages, search pages, or embeds.
- Keep YouTube ingest disabled in default local, CI, and staging environments until a human operator enables it intentionally.
- Do not commit `.env` files, cookies, downloader output, downloaded videos, generated reports, uploads, renders, storage keys, or secrets.

## What This Smoke Proves

The smoke runner checks:

- `/health` is ready and includes safe `youtubeIngest` readiness.
- `/api/youtube/validate` accepts only a safe YouTube URL with rights confirmation.
- `/api/youtube/ingest` creates a project/upload only after downloader, FFprobe, upload validation, and artifact commit succeed.
- render generation completes and creates an export.
- the export download returns a bounded MP4 with a valid `ftyp` signature.
- `demo/results/youtube-smoke-latest.json` contains only safe summaries and request-id presence, not raw URLs, local paths, storage keys, stdout, stderr, cookies, tokens, or provider errors.

## Install And Verify Downloader

ShortsEngine never installs a downloader automatically. Install and patch it outside the app, then point ShortsEngine at the managed binary if needed.

Examples:

```bash
yt-dlp --version
ffmpeg -version
ffprobe -version
```

If the downloader is not on `PATH`, configure:

```bash
export SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN="/path/to/managed/yt-dlp"
```

Do not use shell aliases, command strings with spaces, cookies, or downloader configs that require private credentials.

## Enable Manual Ingest

In one terminal, start the app with explicit ingest enabled:

```bash
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 npm run dev
```

Use the port printed by the server, usually `http://127.0.0.1:4175`.

## Run Doctor

Run a no-download readiness check:

```bash
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_DOCTOR_URL="http://127.0.0.1:4175" \
npm run youtube:doctor
```

The doctor checks the explicit flag, FFmpeg, FFprobe, staging storage, downloader readiness, and optional live `/health` shape. It reports safe `nextAction` strings for operator recovery.

Default disabled mode is expected to skip safely:

```bash
npm run youtube:doctor
```

## Run Manual Smoke

Prefer an allowlist for the exact video id:

```bash
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_SMOKE=1 \
SHORTSENGINE_YOUTUBE_SMOKE_URL="https://www.youtube.com/watch?v=<authorized-video-id>" \
SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS="<authorized-video-id>" \
SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL="http://127.0.0.1:4175" \
npm run youtube:smoke
```

For a one-off manual proof, use the unlisted gate only when the URL was reviewed:

```bash
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_SMOKE=1 \
SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED=1 \
SHORTSENGINE_YOUTUBE_SMOKE_URL="https://www.youtube.com/watch?v=<authorized-video-id>" \
SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL="http://127.0.0.1:4175" \
npm run youtube:smoke
```

Useful bounded settings:

```bash
SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS=120000
SHORTSENGINE_YOUTUBE_SMOKE_TIMEOUT_MS=120000
SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS=90000
SHORTSENGINE_YOUTUBE_SMOKE_DOWNLOAD_MAX_BYTES=83886080
```

Raise timeouts only for an intentional manual proof with a known short source.

## Read The Report

Open:

```bash
demo/results/youtube-smoke-latest.json
```

Expected passing report:

- `status: "passed"`
- safe `source` with `sourceType`, `kind`, and `videoId`
- safe `target` with protocol, host type, and mount only
- project/upload/job/export ids
- `health.requestIdPresent` and per-step `requestIdPresent`
- export `contentType`, `sizeBytes`, and `sha256Prefix`

Failure reports should include only safe codes and `nextAction`. They must not contain raw URLs, local absolute paths, storage keys, stdout, stderr, cookies, tokens, secrets, or raw provider/downloader errors.

## Safe Cleanup

Do not manually delete uploads, renders, exports, database files, or object-storage records unless a dedicated lifecycle policy says so.

Allowed cleanup after a failed manual run:

- remove temporary staging files created by the current run only after the process has exited.
- keep `demo/results/youtube-smoke-latest.json` long enough to debug safe failure codes.

If cleanup requires deleting committed artifacts or exports, stop and add a dedicated cleanup milestone first.

## Troubleshooting Codes

| Code | Meaning | Next action |
| --- | --- | --- |
| `YOUTUBE_INGEST_DISABLED` | Real ingest is intentionally off. | Set `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1` only for manual proof. |
| `YOUTUBE_DOWNLOADER_MISSING` | The configured downloader is unavailable. | Install/configure downloader or set `SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN`. |
| `FFMPEG_MISSING` | FFmpeg is unavailable. | Install FFmpeg or set `FFMPEG_BIN`. |
| `FFPROBE_MISSING` | FFprobe is unavailable. | Install FFprobe or set `FFPROBE_BIN`. |
| `YOUTUBE_STAGING_STORAGE_UNAVAILABLE` | Local staging storage is not ready. | Check data directory permissions and staging storage. |
| `YOUTUBE_DOCTOR_HEALTH_URL_NOT_CONFIGURED` | Doctor did not check live health. | Set `SHORTSENGINE_YOUTUBE_DOCTOR_URL` when a server is running. |
| `YOUTUBE_DOCTOR_HEALTH_YOUTUBE_INVALID` | Live health has the wrong `youtubeIngest` shape. | Fix health response shape before relying on live proof. |
| `YOUTUBE_SMOKE_URL_NOT_ALLOWED` | URL is not allowlisted. | Set `SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS` or the explicit unlisted gate. |
| `YOUTUBE_PLAYLIST_UNSUPPORTED` | Playlist URLs are rejected before network. | Use one authorized watch or shorts URL. |
| `YOUTUBE_LIVE_UNSUPPORTED` | Live streams are rejected before network. | Use a completed authorized video. |
| `YOUTUBE_SMOKE_HEALTH_NOT_READY` | `/health` is not ready for ingest. | Start a ready server with ingest and downloader configured. |
| `YOUTUBE_SMOKE_FETCH_FAILED` | Smoke could not reach the configured base URL. | Start the server or fix `SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL`. |
| `YOUTUBE_SMOKE_JOB_TIMEOUT` | Render job did not finish in time. | Inspect safe job progress and raise timeout only if expected. |
| `YOUTUBE_SMOKE_DOWNLOAD_NOT_MP4` | Export download did not return MP4. | Check render/export download contract. |
| `YOUTUBE_SMOKE_MP4_SIGNATURE_INVALID` | Downloaded file did not have an MP4 signature. | Check render output and download contract. |
| `YOUTUBE_SMOKE_RESPONSE_LEAK` | Public API response included unsafe fields. | Remove internal fields from public response. |
| `YOUTUBE_SMOKE_REPORT_LEAK` | Smoke report leak guard failed closed. | Remove sensitive output before storing reports. |

## Default CI Contract

Default CI and local checks must remain no-network and no-downloader:

- `npm run youtube:doctor` is safe with defaults and should skip real ingest.
- `npm run youtube:smoke` is skipped unless `SHORTSENGINE_YOUTUBE_SMOKE=1`.
- Real cloud integration, downloader installation, and authorized YouTube smoke remain manual operator actions.
