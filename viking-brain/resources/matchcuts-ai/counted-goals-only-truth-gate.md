# Counted Goals Only Truth Gate

Date: 2026-06-20

## Purpose

ShortsEngine valid-goals-only output must contain only goals that counted officially. Offside goals, disallowed goals, VAR/no-goal candidates, chances, reactions, hymns and generic highlights are not eligible filler.

## Runtime Contract

- Every public match truth event exposes a safe contract: `eventType`, `truthStatus`, `sourceStart`, `sourceEnd`, optional decision window, team/score metadata, evidence, disqualifiers and confidence.
- `valid_goals_only` scoring uses the final confirmed-goal compilation plan, not the raw top high-energy moment.
- If the truth layer cannot prove a counted goal, the pipeline must fail closed with `NO_VALID_GOALS_FOUND` instead of falling back to balanced highlights.
- Goal sequence order is preserved so late counted goals remain eligible.

## Evidence Rules

- Counted-goal proof requires strong evidence such as scoreboard score change, restart/center-circle confirmation, scorer/score graphics, OCR/manual truth annotation or a complete goal sequence with confirmation.
- Crowd noise, commentator hype, celebrations and visual shot motion are support signals only.
- Disqualifiers include offside, no-goal decisions, unchanged scoreboard, VAR/no-goal context or replay/check-angle context without counted confirmation.

## Evaluation Rules

- `validGoalRecall`, `lateGoalRecall`, `offsideExclusionAccuracy`, `noGoalExclusionAccuracy`, `validGoalsOnlyCoverage`, `validGoalOrdering` and exact segment count must pass.
- Filler segment rate and false goal rate must remain zero for counted-goals-only fixtures.
- Reports must stay safe: no paths, secrets, storage keys, provider raw errors, logs or artifacts.
