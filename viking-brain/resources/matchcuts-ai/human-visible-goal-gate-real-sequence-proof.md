# Human-Visible Goal Gate + Real Sequence Proof

## Decision

Counted-goal truth is not enough for release proof. A counted goal must also pass a human-visible sequence gate before live proof can claim that the generated video shows the goal.

## Contract

- A visible goal sequence needs buildup, shot, goalmouth/payoff, and confirmation after the finish.
- Scoreboard-only, celebration-only, replay-only, and shot-like windows without visible payoff fail closed.
- The gate reports safe failure codes such as `SCOREBOARD_ONLY`, `CELEBRATION_ONLY`, `REPLAY_ONLY`, `NO_SHOT_VISIBLE`, and `NO_FINISH_VISIBLE`.
- Live YouTube proof must fail with `YOUTUBE_LIVE_E2E_HUMAN_VISIBLE_GOAL_INCOMPLETE` when expected counted goals are not all human-visible.
- Eval fixtures can opt into `humanVisibleGoalGateRequired` to make this a deterministic regression gate.

## Safety Notes

- The gate does not infer goals from scorebug, crowd noise, replay, or celebration alone.
- Reports include sampled timestamp refs only, not raw frames, logs, local paths, storage keys, or provider output.
- Cut smoothness and human-visible goal proof are separate metrics so one failure does not hide the other.
