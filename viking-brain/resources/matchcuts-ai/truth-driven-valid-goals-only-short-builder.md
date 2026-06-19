# Truth-Driven Valid Goals Only Short Builder

Date: 2026-06-19

## Purpose

ShortsEngine valid-goals-only generation must use Match Event Truth as the primary source of truth. The editor should compile only confirmed valid goals, keep them in match order, preserve enough action and decision context, and fail closed when the truth layer cannot confirm a goal.

## Runtime Contract

- `server/analysis.cjs` builds valid-goals-only moments from `matchEventTruth.selectedEvents` or raw `matchEventTruth.events`.
- Only `confirmed_goal` events with `confirmed_goal` outcome are eligible.
- Offside, disallowed, possible, replay, crowd reaction, chance and neutral events are excluded from valid-goals-only plans.
- Truth-selected source windows stay authoritative after story planning so late goals and decision windows are not trimmed away.
- Missing truth input returns no valid-goals-only candidate plans, allowing render orchestration to fail closed with `NO_VALID_GOALS_FOUND`.

## Timing Rules

- Named `VALID_GOAL_ONLY_TIMING` constants bound pre-context, post-context, decision context and max segment duration.
- Segments keep shot/payoff/decision coverage and are capped at about thirty seconds to avoid long celebration-only tails.
- Multi-goal compilations remain chronological and reject unsafe overlaps.

## Evaluation Metrics

- `validGoalsOnlyCoverage`
- `noGoalExclusionAccuracy`
- `fillerRate`
- `cutSmoothnessScore`
- Existing valid-goal recall, late-goal recall, false-goal rate and offside exclusion gates remain required.

## Safety Rules

- Do not infer valid goals from visual sequence, OCR, crowd noise, replay or celebration alone.
- Do not render offside/no-goal/uncertain moments in valid-goals-only mode.
- Keep reports safe: no raw OCR/provider output, paths, storage keys, tokens, stdout or stderr.
