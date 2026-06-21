# Real Scorebug ROI Calibration From Crop Fixtures

## Decision

- Calibrated the `broadcast-compact-score-only-v1` profile from saved OCR QA crop refs instead of guessing from downstream goal output.
- The broadcast profile now keeps explicit full scorebug, score-only, home digit, away digit, separator/trophy and team-label reject ROIs.
- Profile digit OCR now records safe home/away digit crop refs, OCR previews, status and reason codes in the OCR QA report and review HTML.
- The primary scorebug region continues scanning across all sampled frames after an earlier score read, so late score changes are no longer skipped.

## Safety

- OCR remains support evidence only. Score changes do not confirm a counted goal without nearby live action / finish evidence.
- Impossible jumps, clock-like groups, team labels, trophy/separator noise and unreadable digit crops fail closed.
- QA artifacts and reports expose relative refs and sanitized reason codes only. They must not include absolute paths, raw stdout/stderr, provider raw output, tokens, storage keys or secrets.
- Tests, eval and local demo still require no paid provider or API key.

## Current ROI Profile

- Full scorebug ROI: `{ "x": 0, "y": 0, "width": 1, "height": 1 }`
- Score-only ROI: `{ "x": 0.405, "y": 0.08, "width": 0.19, "height": 0.82 }`
- Home digit ROI: `{ "x": 0.415, "y": 0.18, "width": 0.075, "height": 0.62 }`
- Away digit ROI: `{ "x": 0.545, "y": 0.18, "width": 0.052, "height": 0.62 }`
- Separator/trophy ROI: `{ "x": 0.49, "y": 0.08, "width": 0.055, "height": 0.82 }`

## Live Proof Snapshot

- Source: `https://www.youtube.com/watch?v=gxiRyFZXJV8`
- Result: fail-closed `NO_VALID_GOALS_FOUND`.
- OCR improved from 0 stable score changes to 3 stable score changes: `0-0 -> 1-0 -> 2-0 -> 3-0`.
- Latest OCR QA: 34 score-only crops, 4 score-only readable crops, 10 profile-digit OCR readable rows, 31 profile digit crop rows.
- Downstream blocker: valid-goal discovery reports 24 OCR evidence rows but 0 `scoreboardConfirmedGoalCount`, so no MP4 is generated yet.

## Next Milestone

- Fuse the recovered score-change events with nearby live-action finish evidence so OCR-supported counted goals can be selected without allowing OCR-only false goal claims.
