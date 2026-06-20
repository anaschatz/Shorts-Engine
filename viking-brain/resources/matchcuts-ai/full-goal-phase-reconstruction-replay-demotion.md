# Full Goal Phase Reconstruction + Replay Demotion

Date: 2026-06-20

## Purpose

ShortsEngine valid-goals-only output must show the full live action sequence for each counted goal, not replay-only or celebration-only clips. Replays are useful evidence, but they are secondary to the live buildup, shot, finish and confirmation.

## Runtime Contract

- Match Event Truth reconstructs each confirmed goal phase from support evidence such as scoreboard changes, ball-in-net/payoff evidence, commentator/crowd spikes and replay confirmation.
- A renderable goal phase must include live action before the payoff, shot evidence, finish evidence and confirmation evidence.
- Replay-only and celebration-only goal candidates are demoted and excluded from valid-goals-only compilation.
- Valid-goals-only moments carry phase metadata: `shotStart`, `finishTime`, `confirmationTime`, `replayUsed`, `replayOnly` and `phaseCoverage`.
- Edit plans reject confirmed-goal segments when `replayOnly` is true or when the segment lacks shot/finish coverage.
- Valid-goals-only timing uses action-first windows of about 18-28 seconds per goal, ordered chronologically.

## Evaluation Contract

- Fixtures can require `goalPhaseCoverageRequired`.
- Eval reports include `goalPhaseCoverageScore` and `replayOnlyGoalRate`.
- Valid-goals-only fixtures pass only when every counted goal segment has full phase coverage and no replay-only primary segment.

## Safety Rules

- Do not infer a counted goal from replay, crowd reaction, celebration, score area context or visual motion alone.
- Offside/no-goal candidates remain excluded even if they have stronger hype signals than valid goals.
- Keep reports safe: no raw provider output, storage keys, tokens, logs, absolute local paths or downloader stderr/stdout.

## Current Limitation

Live YouTube proof can still be blocked by local server readiness before ingest/render. When that happens, write a safe proof report and do not claim a generated MP4 exists.
