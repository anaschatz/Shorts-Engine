# Full-Source Valid Goal Discovery + Late Goal Coverage

Date: 2026-06-18

## Decision

ShortsEngine valid-goals-only mode must search the full source timeline before creating edit plans. Long-source football analysis should use bounded time buckets, preserve late critical visual windows, and select only confirmed onside goals for valid-goals-only output.

## Safety Contract

- Do not infer a valid goal from crowd noise, celebrations, shot-like motion, goal-area visibility or scoreboard context alone.
- Confirmed valid goals require a goal evidence chain: shot/contact or ball trajectory, payoff/ball-in-net or goal-mouth result, and explicit confirmation such as scoreboard/referee signal or safe goal language.
- Offside/no-goal/VAR reversal evidence must exclude a candidate from valid-goals-only output.
- If no confirmed valid goals are found, return no candidate plan so the render job can fail closed with `NO_VALID_GOALS_FOUND`.
- Reports expose bucket counts, selected valid goals and excluded candidates only as safe reason-code summaries.

## Implementation Notes

- `server/vision.cjs` keeps bounded bucket coverage so early visual windows cannot crowd out late goal evidence.
- `server/analysis.cjs` discovers goal anchors across early/middle/late buckets, keeps late decision context, and trims stale opening/reaction context from football sequences.
- `server/goal-outcome.cjs` allows validated decision reason codes to support outcome resolution without accepting raw provider claims.
- `server/render-job.cjs` logs safe valid-goal selection counts when valid-goals-only planning fails closed.
- `eval/scoring.cjs` now reports `validGoalRecall`, `lateGoalRecall`, `falseGoalRate`, `offsideExclusionAccuracy`, `validGoalOnlyFillerRate`, `captionGoalClaimAccuracy` and `segmentTimingCoverage`.

## Regression Fixtures

- `tests/analysis.test.cjs` covers three late confirmed goals after high-score early filler.
- `tests/vision.test.cjs` covers late critical visual windows after many early filler windows.
- `tests/render-job.test.cjs` covers late candidate-window preservation before frame extraction.
- `eval/fixtures/022_late_valid_goals_only.json` covers valid-goals-only recall for three late confirmed goals.
