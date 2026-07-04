# Session Memory: Scorebug OCR ROI Debug Calibration

Date: 2026-07-04

## Decision

The live YouTube proof failure for long scorebug OCR should not report zero ROI attempts when chunks include sampled timestamps and candidate scorebug ROI ids. We added planned attempt diagnostics while keeping OCR evidence fail-closed.

## Implementation Notes

- Added per-chunk `plannedFrameCount`, `attemptedRoiCount`, and `attemptedObservationCount`.
- Aggregated chunk attempts into `scorebugDebug` when no readable ROI is selected.
- Preserved the distinction between actual `sampledFrameCount` and planned attempts.
- Updated live YouTube proof and smoke report sanitizers to expose the fields safely.
- Added tests for backend chunk summaries, public OCR normalization, and progress-only live proof reports.

## Safety

- No fake score changes are generated from attempted diagnostics.
- No MP4 is produced unless downstream valid-goal and video output gates pass.
- Reports remain bounded and avoid raw OCR text, stdout, stderr, paths, storage keys, cookies, tokens, and secrets.

## Validation

Focused validation passed:

```bash
node --test tests/scoreboard-ocr.test.cjs tests/render-job.test.cjs tests/youtube-runtime.test.mjs
```

Full validation still needs to run before commit and push.
