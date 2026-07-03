# YouTube Downloader Runtime Reliability

## Purpose

Live YouTube proof is only meaningful if the source video is fetched into controlled staging and validated before OCR, analysis or rendering. Downloader failures must be observable and safe, not opaque `download failed` events.

## Runtime Contract

- YouTube ingest remains disabled by default and requires explicit operator flags plus rights confirmation.
- The local downloader adapter uses `execFile` with explicit argument arrays only.
- Download output is restricted to the managed YouTube staging `source.mp4` path.
- Format selection is bounded by:
  - `SHORTSENGINE_YOUTUBE_FORMAT_SELECTOR`
  - `SHORTSENGINE_YOUTUBE_FALLBACK_FORMAT_SELECTOR`
  - `SHORTSENGINE_YOUTUBE_DOWNLOAD_ATTEMPTS`
  - `SHORTSENGINE_YOUTUBE_RETRY_BACKOFF_MS`
- Retry/fallback is bounded and clears partial output before each attempt and after failed attempts.
- Cookies, browser sessions, tokens and raw extractor args are not accepted by default.

## Safe Failure Reporting

Downloader failures should include safe public metadata:

- `attempts`
- `attemptsConfigured`
- `timeoutMs`
- `formatSelector`
- `fallbackFormatSelector`
- `fallbackUsed`
- `playerClient`
- `retryable`
- `authorizedImportRequired`
- `nextAction`

Reports and API responses must never include raw stdout, stderr, local paths, cookies, tokens, provider raw errors or full command strings.

## Validation

- Tests cover fallback retry success, retry exhaustion, partial output cleanup, safe format strategy summaries, doctor runtime metadata and smoke report propagation.
- `youtube:doctor` exposes downloader readiness, version and safe format strategy when ingest is enabled.

## Limitation

This milestone improves downloader reliability and observability, but public YouTube download success still depends on the operator environment, network conditions and YouTube access policy. Bot/auth/cookie-gated videos must fail closed without secret import.
