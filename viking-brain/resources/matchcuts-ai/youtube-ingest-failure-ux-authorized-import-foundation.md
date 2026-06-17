# YouTube Ingest Failure UX + Authorized Import Foundation

ShortsEngine validates safe YouTube URLs separately from downloader-backed ingest. A URL can pass validation while the downloader later fails because YouTube requires sign-in, anti-bot confirmation, cookies, age-gated access, a public source, or a retry window.

## Contract

- Keep `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=0` by default.
- Keep `SHORTSENGINE_YOUTUBE_AUTHORIZED_IMPORT_ENABLED=0` by default.
- Do not accept, store, log or report cookies, browser sessions, tokens or raw downloader output.
- Classify downloader failures at the adapter boundary with safe codes:
  - `YOUTUBE_AUTH_REQUIRED`
  - `YOUTUBE_BOT_CHECK_REQUIRED`
  - `YOUTUBE_COOKIES_REQUIRED`
  - `YOUTUBE_VIDEO_PRIVATE`
  - `YOUTUBE_VIDEO_UNAVAILABLE`
  - `YOUTUBE_GEO_RESTRICTED`
  - `YOUTUBE_AGE_RESTRICTED`
  - `YOUTUBE_RATE_LIMITED`
  - `YOUTUBE_DOWNLOAD_TIMEOUT`
  - `YOUTUBE_DOWNLOAD_FAILED`
- Public error details are allowlisted to `nextAction`, `retryable`, `authorizedImportRequired`, `ingestRisk` and `metadataStatus`.
- Metadata probe failures may return validation warnings such as `metadataStatus: "bot-check-required"` and `ingestRisk: "authorized-import-required"` while still allowing the user to choose another link or MP4 fallback.

## UI

- Validation warning: tell the user the URL is valid but ingest may require authorized import.
- Ingest failure: keep Generate/Download disabled and show retry, another-link and MP4 fallback controls.
- Never show raw `stderr`, `stdout`, local paths, cookies or storage keys.

## Tests

- Unit tests cover downloader classification, metadata warnings, service failure no-record behavior and safe recovery copy.
- Static checks cover selectors, docs, env defaults and classifier contracts.
