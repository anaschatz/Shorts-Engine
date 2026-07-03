# Session Memory: Reliable Authorized Source Acquisition Runtime

## Date

2026-07-04

## Context

The previous live YouTube proof moved past the smoke request timeout but failed at the real downloader runtime with `YOUTUBE_DOWNLOAD_TIMEOUT`.

## Changes

- Added a source acquisition service boundary around YouTube downloader acquisition.
- Added safe progress heartbeat and no-progress stall detection to the local downloader adapter.
- Added `YOUTUBE_NO_PROGRESS_TIMEOUT` as a distinct safe failure code.
- Extended smoke/live reports with source acquisition and progress diagnostics.
- Documented new runtime flags for heartbeat and no-progress timeout.

## Safety Notes

The milestone does not add cookies, tokens, private-video access, DRM bypasses, raw log exposure, or automatic auth. MP4 output is still produced only after source acquisition and validation succeed.

## Next Step

If live public YouTube acquisition still fails in this environment, build an operator-approved source cache or reviewed provider-neutral acquisition backend instead of adding scraping/auth bypass logic.
