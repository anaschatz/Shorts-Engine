# YouTube Ingest Failure UX + Authorized Import Foundation - 2026-06-17

## Decisions

- Added a downloader failure classifier so local YouTube ingest maps real yt-dlp failures to safe, user-actionable codes instead of generic `YOUTUBE_DOWNLOAD_FAILED`.
- Kept authorized import as a foundation only with `SHORTSENGINE_YOUTUBE_AUTHORIZED_IMPORT_ENABLED=0` and `/health` capability `authorizedImportAvailable: false`.
- Allowed validation to pass for safe URLs while carrying metadata warnings when probes detect auth, bot-check, cookie, private/unavailable, geo, age-gated or rate-limit risks.
- Added UI warning and recovery controls: retry ingest, use another link and upload MP4 fallback.
- Kept Generate/Download disabled until a successful ingest creates upload/project state and render completes.

## Verification

- `node --test tests/youtube-ingest.test.cjs tests/validation.test.js`
- `node --test tests/backend.test.cjs`
- `node tests/static-lint.mjs`

## Limitations

- Authorized import does not yet implement cookies, OAuth, browser session import or private video handling.
- Some public YouTube videos can still be blocked by YouTube anti-bot checks; the supported fallback is another public video or manual MP4 upload.
