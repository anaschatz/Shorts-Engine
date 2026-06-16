# Authorized YouTube URL Ingest Foundation

## Purpose

ShortsEngine can validate a user-provided YouTube URL and explicit rights confirmation before a future downloader/ingest worker exists.

This milestone is intentionally validate-only:

- No server-side media download.
- No `yt-dlp`, `youtube-dl`, browser scraping, shell execution or network calls.
- No project/upload/export record is created from a YouTube URL.
- Generate/render/export stays disabled until a real MP4 artifact exists in artifact storage.

## Backend Contract

- `server/youtube-ingest.cjs` owns URL parsing and validation.
- `server/adapters/mock-youtube-ingest-adapter.cjs` is the default adapter and declares:
  - `mode: "mock"`
  - `enabled: false`
  - `networkCalls: false`
  - `downloaderConfigured: false`
  - `ingestAvailable: false`
- `POST /api/youtube/validate` accepts JSON `{ url, rightsConfirmed }`.
- Supported URL shapes:
  - `youtube.com/watch?v=<11-char-id>`
  - `youtube.com/shorts/<11-char-id>`
  - `youtu.be/<11-char-id>`
- Rejected URL shapes:
  - playlists
  - live streams
  - unsupported hosts
  - unsafe protocols
  - credentialed URLs
  - malformed or overlong URLs

## Health Contract

`GET /health` includes `youtubeIngest` readiness metadata only. It must not perform network calls and must not expose local paths, storage keys, credentials or provider raw errors.

## Frontend Contract

- Source selector has `Local upload` and `YouTube URL`.
- YouTube URL validation requires explicit source-specific rights confirmation.
- Valid YouTube sources show a safe validated preview.
- Generate/export/download remain disabled for YouTube mode until a real ingested MP4 artifact exists.
- Switching sources clears stale render state and avoids old downloads/previews leaking into the active mode.

## Next Milestone

Implement a legal/authorized downloader boundary with local staging, artifact creation, duration/size/container validation and provider-specific opt-in behavior.
