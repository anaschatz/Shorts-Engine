# Real Broadcast Scorebug Digit Calibration - 2026-06-21

## What Changed

- Added a dedicated scorebug calibration module with score normalization, transition decisions and safe QA diagnostics.
- Extended scoreboard OCR, local OCR adapter, scoreboard reader, goal evidence and match truth layers to carry `transitionDecision` / `transitionReasonCodes`.
- Added focused tests for scorebug parsing, impossible transition rejection, safe diagnostics and profile digit OCR crop recovery.
- Enhanced fixture `034_scorebug_digit_counted_goal_calibration.json` with transition-decision expectations.

## Validation Snapshot

- Focused syntax checks passed for the changed scorebug/OCR modules.
- Focused tests passed: `node --test tests/scorebug-calibration.test.cjs tests/scorebug-digit-reader.test.cjs tests/scoreboard-ocr.test.cjs`.
- Full validation still needs to be rerun after the final profile digit OCR changes before commit/push.

## Live Proof Snapshot

- Test source: `https://www.youtube.com/watch?v=gxiRyFZXJV8`.
- Result: fail-closed `NO_VALID_GOALS_FOUND`.
- Metrics: 37 score-only crops, 1 readable score-only crop, 0 stable score-change events, 0 counted goals selected, no MP4 output.
- The observed crop-level blocker is ROI calibration: full scorebug crops contain the visible score, but extracted score-only/profile digit crops are polluted by trophy/team labels or produce unreadable home/away digits.

## Limitation

- This pass improved diagnostics and safety, but it did not yet recover the 3 counted goals from the real broadcast scorebug. The next milestone should focus on real crop fixtures and calibrated digit ROIs, not downstream goal guessing.
