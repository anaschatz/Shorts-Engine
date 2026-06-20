# Real Broadcast Scorebug Digit Calibration

## Decision

- Added `server/scorebug-calibration.cjs` as the safe scorebug calibration boundary for score parsing, OCR digit confusion normalization, transition decisions and diagnostics.
- Scoreboard OCR QA now records profile/layout diagnostics, final score candidates, transition decisions, calibration confidence, rejected reason codes and digit candidate counts.
- Scoreboard timeline evidence now preserves `transitionDecision` and `transitionReasonCodes` through OCR, reader, goal evidence and match truth layers.
- Local OCR supports bounded single-character digit reads for profile digit crops, but the live `gxiRyFZXJV8` proof still fails closed because the real broadcast digit crops are not reliably decoded.

## Safety

- OCR remains support-only evidence. A score change alone cannot confirm a counted goal without nearby football action/finish evidence.
- Impossible transitions, clocks, team labels, noisy extra groups and low-confidence readings fail closed.
- QA reports expose safe relative refs and reason codes only. They must not include absolute local paths, raw provider output, stderr/stdout, storage keys or secrets.
- Tests/eval/local demo continue to run without API keys or paid providers.

## Live Proof Result

- Live YouTube proof: `gxiRyFZXJV8`.
- Result: failed safe with `NO_VALID_GOALS_FOUND`.
- OCR QA: 37 score-only crops, 1 readable score-only crop, 0 stable score changes.
- Root cause observed from crop refs: the full broadcast crop shows the scorebug, but score-only/profile digit ROIs are not calibrated tightly enough for the real layout and often capture trophy/team noise or unreadable digits.

## Next Milestone

- Build a real crop-calibration loop from saved QA crop refs: tune home/away digit ROIs per broadcast layout, persist sanitized crop fixtures, and verify that stable score changes are extracted before using them for valid goal discovery.
