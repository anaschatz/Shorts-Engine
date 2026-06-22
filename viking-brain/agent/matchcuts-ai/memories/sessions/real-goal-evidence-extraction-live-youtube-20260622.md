# Session Memory: Real Goal Evidence Extraction for Live YouTube

## Summary

Added fail-closed goal evidence diagnostics and candidate-cluster recovery plumbing for live YouTube valid-goals mode.

## Decisions

- Preserved visual support reason codes in goal evidence output instead of dropping them during validation.
- Added per-candidate `missingEvidence`, `recoveryEligibility`, and `rejectionReason`.
- Enabled candidate cluster recovery only for `youtube + valid_goals_only` render jobs.
- Added candidate-based visible goal recovery, while rejecting offside/no-goal, replay-only, celebration-only, and weak shot-only cases.
- Moved candidate diagnostics earlier in `valid_goal_selection_empty` logs so safe log redaction does not truncate them.

## Validation

- `npm run lint` passed.
- `npm run build` passed.
- `npm test` passed: 711/711.
- `npm run eval` passed with aggregate score 98.
- `npm run eval:reference` passed with aggregate score 98.
- `npm run demo:smoke` passed with 18 checks.
- `npm run ci:reports` passed.
- `npm run release:check` passed.

## Live Proof

The operator YouTube proof for the current test URL still failed closed with `NO_VALID_GOALS_FOUND`. The new report showed four non-recoverable goal evidence candidates. Each had `shot_sequence_support` but missed `goalmouth_or_finish_context`, `explicit_ball_in_net`, and `decision_or_reaction_confirmation`.

## Limitation

No generated MP4 was produced for the live YouTube proof in this pass. The next milestone should improve real visual/OCR evidence extraction for goalmouth, ball-in-net, and score/decision confirmation rather than loosening truth guards.
