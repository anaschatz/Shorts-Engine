# Scoreboard-Backed Late Valid Goal Recovery

Date: 2026-06-20

## Purpose

Long YouTube matches can miss late valid goals when the sampled visual evidence sees the shot and goal mouth but not a clean ball-in-net frame. ShortsEngine may recover those goals only when strong scoreboard/OCR QA confirms a score change near the shot sequence.

## Runtime Contract

- `server/goal-evidence-provider.cjs` can emit `scoreboard_backed_goal_sequence` for a missed ball-in-net goal.
- Recovery requires nearby shot/action evidence plus usable strong OCR QA with a temporal score change.
- OCR-only score changes remain non-goal evidence and must fail closed.
- Offside/no-goal visual decision evidence blocks scoreboard-backed recovery.
- `server/match-event-truth.cjs` can classify a scoreboard-backed sequence as `confirmed_goal` only when score confirmation and action evidence agree.
- `server/analysis.cjs` accepts scoreboard-backed confirmed goals in valid-goals-only planning without injecting fake ball-in-net evidence.

## Sequencing Contract

- Valid-goals-only compilations keep confirmed goals in source order.
- Offside, no-goal, intro, anthem, filler chances and reaction-only segments stay excluded.
- Confirmed goal handles are shorter because truth windows already include build-up, payoff and decision context.
- Multi-goal compilations include `transitionPlan` metadata for smooth short fades between goals.

## Safety Rules

- Do not infer a goal from scoreboard OCR alone.
- Do not infer a goal from crowd noise, celebration, shot motion or goal-area context alone.
- Require strong OCR QA before scoreboard-backed goal recovery.
- Preserve no-false-goal guards for ambiguous OCR, OCR-only score changes and score-unchanged disallowed goals.
- Keep public reports free of raw provider output, local paths, storage keys, tokens, stdout and stderr.

## Evaluation Coverage

- `eval/fixtures/028_scoreboard_backed_late_valid_goal.json` covers one normal confirmed goal and one late recovered goal without a clean ball-in-net label.
- Focused tests cover provider recovery, OCR-only fail-closed behavior, truth classification, valid-goals-only sequencing and eval reporting.
