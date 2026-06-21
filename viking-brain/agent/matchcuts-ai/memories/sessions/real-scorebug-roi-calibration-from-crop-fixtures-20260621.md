# Real Scorebug ROI Calibration From Crop Fixtures - 2026-06-21

## What Changed

- Tightened the real broadcast scorebug ROIs for the `gxiRyFZXJV8`-style layout using saved OCR QA crop evidence.
- Added QA diagnostics for profile digit OCR: home/away digit crop refs, safe OCR text previews, status and reasons.
- Added a regression test that keeps scanning the primary scorebug region after a previous frame already produced a score.
- Updated the scorebug digit calibration eval fixture with ROI metadata and stable score-change expectations.

## Validation Snapshot

- `node --check server/scoreboard-ocr.cjs` passed.
- Focused OCR tests passed: `node --test tests/scoreboard-ocr.test.cjs tests/scorebug-calibration.test.cjs tests/scorebug-digit-reader.test.cjs`.
- Focused result: 35 passed, 0 failed.

## Live Proof Snapshot

- Source: `https://www.youtube.com/watch?v=gxiRyFZXJV8`
- Result: safe failure with `NO_VALID_GOALS_FOUND`.
- OCR result: 3 stable score changes recovered: `0-0 -> 1-0 -> 2-0 -> 3-0`.
- OCR QA metrics: 34 score-only crops, 4 readable score-only crops, 10 profile-digit readable rows, 31 profile digit crop rows.
- No MP4 was generated because valid-goal discovery still needs live-action finish evidence before accepting OCR-supported goals.

## Limitation

- This milestone closes the ROI/timeline blocker, not the full valid-goal fusion problem. The next pass should connect score-change timestamps to nearby live-action shot/finish windows while preserving the OCR-only no-goal guard.
