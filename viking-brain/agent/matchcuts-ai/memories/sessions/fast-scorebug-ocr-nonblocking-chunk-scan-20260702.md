# Session Memory: Fast Scorebug OCR Non-Blocking Chunk Scan

Created: 2026-07-02

## Summary

Implemented a bounded, non-blocking scorebug OCR chunk scan for long YouTube proof runs. Slow or timed-out chunks are now recorded with safe metadata and later chunks can still be scanned, allowing late score changes to be discovered without hanging the job.

## Decisions

- Treat chunk-level OCR timeout as recoverable while total OCR budget remains.
- Persist public `scoreboardOcr` summaries on failed jobs so proof reports can explain OCR blockers safely.
- Aggregate ROI calibration and scorebug debug summaries from successful chunk outputs only.
- Keep final video proof gated by actual counted-goal coverage and visible phase output, not JSON-only discovery.
- Keep live YouTube proof opt-in and rights-gated; downloader failures remain structured environment blockers.

## Validation

- Focused tests passed for render-job, YouTube runtime and scoreboard OCR coverage.
- Full local lint, build, test, eval, reference eval, YouTube doctor, OCR smoke/review, CI report and release checks passed before commit.
- Live YouTube operator proof reached the downloader boundary and failed safely before OCR with `YOUTUBE_DOWNLOAD_FAILED`; no misleading MP4 was created.

## Limitations

- The latest live proof blocker is downloader/runtime reliability for the provided YouTube source, not scorebug chunk orchestration.
- Real MP4 3/3 or 5/5 goal verification still requires a successful authorized source download plus final output gate pass.
