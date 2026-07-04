# Resumable Long YouTube Download + Proof Unblock

## Purpose

Long, rights-cleared YouTube proof runs must not fail with opaque downloader timeouts while bytes are still moving. The ingest boundary should distinguish an active long download from a stalled downloader, keep all work bounded, and never create proof MP4 output unless the staged source completes validation.

## Runtime Contract

- YouTube ingest remains disabled by default and requires explicit rights confirmation plus URL allowlist/manual gate.
- `SHORTSENGINE_YOUTUBE_DOWNLOAD_TIMEOUT_MS` is the preferred bounded downloader timeout alias; `SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS` remains backward compatible.
- `SHORTSENGINE_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_MS` is operator-only and maps into the spawned proof server as the real downloader timeout.
- Live proof total timeout is bounded separately from the downloader timeout.
- When live scoreboard OCR is enabled, the proof runner applies a bounded 300000ms smoke job timeout unless the operator explicitly sets `SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS`.
- The local downloader adapter uses safe arg arrays and includes `--continue`, while resumable partial state remains disabled by default.
- Failed downloads still clean managed staging partials and create no upload, project, job or export records.

## Safe Diagnostics

Downloader timeout reports should include:

- `timeoutClassification`
- `lastProgressAgeMs`
- `bytesStillMovingAtTimeout`
- `progressBytesObserved`
- `progressEventCount`
- `progressHeartbeatCount`
- `continueAttempted`
- `resumableStateEnabled`
- `resumeStateRetained`

`DOWNLOAD_TIMED_OUT_WITH_PROGRESS` means the timeout likely needs a bounded operator increase or source cache fallback. `DOWNLOAD_STALLED_NO_PROGRESS` means the downloader stopped producing staged bytes and should fail closed.

## Safety Rules

- Do not request or store cookies, browser sessions, PO tokens or raw downloader logs.
- Do not bypass DRM, private videos, age gates, paywalls, bot checks or platform restrictions.
- Do not treat partial `.mp4`, `.part`, `.tmp` or `.ytdl` files as valid sources.
- Do not show old/cached proof MP4 as a new success after ingest failure.
- Reports must avoid raw stdout/stderr, absolute local paths, storage keys, tokens and provider raw errors.

## Verification

Use focused tests for downloader timeout classification, no-progress stalls, live-proof timeout env mapping, public report propagation and environment contract validation before running full release checks.

## Latest Live Proof Result

The rights-confirmed long YouTube proof for `WuuGus5Obkg` no longer failed at the downloader/config boundary. It reached planning and failed closed with `NO_VALID_GOALS_FOUND`, `scoreChangeCount=0`, `countedGoalsIncluded=0`, and no MP4 output. The next product milestone should focus on valid-goal evidence discovery rather than downloader resumability.
