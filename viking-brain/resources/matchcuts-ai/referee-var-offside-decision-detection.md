# Referee/VAR/Offside Visual Decision Detection

## Purpose

ShortsEngine should resolve ball-in-net outcomes using post-goal decision context, not celebration or crowd noise alone. The system now recognizes explicit visual decision cues such as assistant flags, referee no-goal/goal signals, VAR graphics, offside replay lines, scoreboard goal removal/confirmation and replay angles.

## Contracts

- Decision visual labels are schema-validated in `server/vision.cjs`; unknown labels fail closed.
- Goal outcome resolution lives in `server/goal-outcome.cjs`.
- `goalOutcome` may include `decisionWindow`, `safeCaptionBadge` and a bounded `explanation` in addition to the previous outcome fields.
- `confirmed_goal` requires explicit confirmation evidence such as goal-confirmed commentary, referee goal signal or scoreboard confirmation.
- `disallowed_offside` requires stronger no-goal/offside evidence such as flag, no-goal commentary, offside line, referee no-goal signal or scoreboard goal removal.
- Weak VAR/offside review evidence becomes `possible_offside`, not confirmed/disallowed.

## Safety Rules

- Never infer confirmed goal from ball-in-net, goal mouth, crowd roar, celebration or tracking evidence alone.
- Keep disallowed goals in the short, but label them with `OFFSIDE - NO GOAL`.
- Use `VAR CHECK` for unresolved VAR/offside review context.
- Story planning must keep source windows long enough to include the decision window.
- Reports expose only safe codes, badges and bounded timestamps; no raw logs, provider output, local paths or storage keys.

## Evaluation Notes

`npm run eval` tracks:

- `offsideOutcomeAccuracy`
- `disallowedGoalIncluded`
- `decisionContextCoverage`
- `captionOutcomeAlignment`
- `postGoalWindowCoverage`

The synthetic fixture `goal_disallowed_offside_decision` covers ball-in-net plus VAR/offside/no-goal visual decision context.
