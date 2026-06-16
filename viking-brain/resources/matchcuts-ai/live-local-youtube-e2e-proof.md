# Live Local YouTube E2E Proof

## Contract

The live local YouTube proof must remain manual and opt-in. Default local, CI and browser checks must not start downloader-backed ingest, download a YouTube URL, or require network access.

## Runner

`npm run youtube:e2e:local` runs `demo/run-youtube-live-e2e.mjs`.

Default behavior:

- returns `skipped`
- writes `demo/results/youtube-live-e2e-latest.json`
- does not start a server
- does not call downloader/network

Live behavior requires:

- `SHORTSENGINE_YOUTUBE_LIVE_E2E=1`
- `SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED=1`
- `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1`
- authorized URL through `SHORTSENGINE_YOUTUBE_LIVE_E2E_URL`
- allowlist through `SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS` or explicit `SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED=1`
- downloader, FFmpeg, FFprobe and storage readiness through `youtube:doctor`

## Flow

1. Validate flags and URL before server work.
2. Run `youtube:doctor`.
3. Start local server with YouTube ingest enabled.
4. Reuse `runYouTubeSmoke` against the local base URL.
5. Verify validate, ingest, project/upload creation, generate, completed job, export and MP4 download.
6. Persist only safe report metadata.

## Browser

Playwright live YouTube path is gated behind `SHORTSENGINE_YOUTUBE_LIVE_E2E_BROWSER=1`. It selects YouTube source, confirms rights, validates safe preview, ingests only when health readiness enables it, generates, waits for render completion and verifies download visibility.

## Safety

- No downloader commands in the live E2E wrapper.
- No raw canonical URLs, local paths, storage keys, stdout, stderr, cookies or tokens in reports.
- Server bind failures such as `EPERM` are reported as `YOUTUBE_LIVE_E2E_SERVER_BIND_FAILED`.
- The existing default smoke/eval/test/CI paths stay deterministic and no-network.
