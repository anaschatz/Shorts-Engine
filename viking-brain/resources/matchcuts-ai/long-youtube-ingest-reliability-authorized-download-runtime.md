# Long YouTube Ingest Reliability + Authorized Download Runtime

## Purpose

Live YouTube proof must not fail before render with an opaque `YOUTUBE_SMOKE_INGEST_TIMEOUT`. The ingest layer should make authorized public YouTube downloads bounded, observable and safe: metadata preflight first, explicit downloader attempt strategy, fallback attempt diagnostics, staging cleanup and no misleading MP4 proof when ingest fails.

## Runtime Contract

- YouTube ingest remains opt-in and rights-gated.
- Downloader work uses safe argument arrays, never shell strings.
- Smoke/live proof request timeout must cover the bounded downloader cycle:
  - `SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS * SHORTSENGINE_YOUTUBE_DOWNLOAD_ATTEMPTS + 30000`
  - minimum `120000`
  - maximum `900000`
- Ingest phases are observable:
  - `metadata_preflight`
  - `download_staging`
  - `download_validate_signature`
  - `ffprobe_validate`
  - `artifact_commit`
- Downloader failures include safe scalar diagnostics: attempts, configured attempts, timeout, selected/fallback format, fallback usage, metadata preflight status, cleanup status and next action.

## Safety Rules

- Do not request, store or print cookies, browser tokens, PO tokens or raw downloader output.
- Do not attempt to bypass DRM, private videos, paywalls, bot checks or platform restrictions.
- Partial `.mp4`, `.part`, `.tmp` and `.ytdl` files must be cleaned from managed staging paths.
- Failed ingest must create no upload, project, job or export records.
- Public API reports must avoid local paths, storage keys, stdout/stderr and raw provider/downloader errors.

## Validation Expectations

- Tests should cover retry/fallback behavior, partial cleanup, timeout diagnostics, no record creation on ingest failure, safe smoke reports and live output proof ingest diagnostics.
- Live proof may still fail because the remote platform blocks or stalls downloads, but it must fail with exact phase/step/substep and no generated MP4.
