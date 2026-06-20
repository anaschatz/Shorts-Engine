# Scorebug Evidence to Counted Goal Truth Integration - 2026-06-20

## Decisions

- Added score timeline and score change contracts inside the match-event truth layer.
- Stable score increases now produce counted-goal truth events only when live action exists.
- Reverted score changes produce disallowed/no-goal truth events.
- High-confidence OCR without strong QA or decoder-backed digit evidence stays fail-closed.
- Decoder and image segmentation statuses are propagated as safe report metadata.

## Tests

- Added focused match-event truth tests for counted goals, reverted goals, noisy OCR, late 3-goal coverage, and replay-only rejection.
- Added eval fixture `035_scorebug_truth_integration_live_blocker.json`.
- `npm run eval` passed with aggregate score 99 and `matchEventTruthFalseGoalRate = 0`.

## Limitation

- Live YouTube proof still needs to be rerun after full validation to confirm whether the real source now produces counted goal events instead of `NO_VALID_GOALS_FOUND`.
