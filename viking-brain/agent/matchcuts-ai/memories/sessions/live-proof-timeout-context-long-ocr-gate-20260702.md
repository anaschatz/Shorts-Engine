# Session Memory: Live Proof Timeout Context + Long OCR Gate

## Date

2026-07-02

## Context

The latest live YouTube proof for a long source failed correctly at the top level, but the report was not useful enough: it used an external timeout race and lost server events, smoke/job lifecycle state, OCR chunk progress, and output gate context.

## Decisions

- Moved live proof timeout handling inside `runYouTubeLiveE2E`.
- Removed the CLI-level minimal timeout report path.
- Preserved `serverEvents` and safe active job context on timeout.
- Added top-level `currentJob`, `logsDownloaded: false`, and `artifactsDownloaded: false` to live proof reports.
- Enhanced smoke polling so a fetch failure after an active job snapshot keeps the last known OCR chunk/job context.

## Validation Added

- `youtube smoke polling failure preserves last active chunk context`
- `youtube live local e2e timeout preserves server progress context`

## Current Limitation

The live proof can still fail because the long-source OCR/render pipeline does not yet produce a passing 5/5 counted-goal MP4. That is acceptable only if the report now explains the exact phase, step, chunk progress, and missing output gate evidence without misleading success.
