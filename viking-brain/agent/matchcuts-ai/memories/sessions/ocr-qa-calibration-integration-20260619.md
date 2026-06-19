# OCR QA Calibration Integration - 2026-06-19

## What Changed

- Added `server/ocr-qa-calibration.cjs` as the safe normalization/loading boundary for `demo/results/ocr-qa-review-latest.json`.
- Wired OCR QA calibration into `server/render-job.cjs` before goal evidence analysis.
- Updated `server/goal-evidence-provider.cjs` so scoreboard OCR decision reason codes are used only when calibration is usable.
- Extended eval fixtures/scoring with explicit `ocrQaCalibration` and `ocrQaCalibrationSupport`.
- Removed old untracked duplicate OpenViking reference files from the worktree.

## Safety Decisions

- OCR QA is support-only and never grants `goalDecisionAllowed`.
- Missing/skipped/stale/invalid/leaking reports fail closed to ignored OCR support.
- Strong OCR QA can support action-backed valid goals/offside decisions, but cannot create OCR-only goals.
- Logs and public job/eval output expose only bounded calibration summaries.

## Tests Added Or Updated

- `tests/ocr-qa-calibration.test.cjs`
- `tests/render-job.test.cjs`
- `tests/eval.test.cjs`

## Limitation

Manual OCR QA validates crop quality/readability, not the truth of a goal. It should remain a support signal until a stronger match-event truth layer exists.
