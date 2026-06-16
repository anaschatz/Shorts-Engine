# Live YouTube E2E Environment Hardening

## Purpose

The local live YouTube E2E proof is operator-only. Its environment flags must be validated by the central release environment contract before any downloader, server bind, network call, browser work or smoke pipeline starts.

## Contract

`npm run env:check` validates:

- `SHORTSENGINE_YOUTUBE_LIVE_E2E`
- `SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED`
- `SHORTSENGINE_YOUTUBE_LIVE_E2E_URL`
- `SHORTSENGINE_YOUTUBE_LIVE_E2E_PORT`
- `SHORTSENGINE_YOUTUBE_LIVE_E2E_TIMEOUT_MS`
- `SHORTSENGINE_YOUTUBE_LIVE_E2E_BROWSER`

Live local proof or browser proof requires:

- YouTube ingest explicitly enabled.
- Rights explicitly confirmed.
- A supported YouTube watch, shorts or shortlink URL.
- Either an allowlisted video id or the explicit manual unlisted gate.

## Safety

Readiness output exposes only booleans and bounded numeric settings. It must not include raw YouTube URLs, local paths, storage keys, downloader output, cookies, tokens or provider errors.

## Tests

Regression coverage lives in `tests/environment.test.mjs` and `tests/static-lint.mjs`.
