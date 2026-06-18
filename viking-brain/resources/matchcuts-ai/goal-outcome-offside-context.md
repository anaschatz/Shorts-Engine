# Goal Outcome + Offside Decision Context

## Purpose

ShortsEngine should treat ball-in-net moments as outcome-aware events, not automatically as confirmed goals. Offside goals remain important highlights, but captions and overlays must say whether the finish counted, was ruled out, is under possible offside review, or has an unclear decision.

## Contracts

- Goal moments may include `goalOutcome` with `eventType`, `outcome`, `offsideStatus`, `decisionEvidence`, `decisionTimestamp`, `confidence`, `requiresPostContext` and `postContextSeconds`.
- Valid outcomes are `confirmed_goal`, `disallowed_offside`, `possible_offside` and `unknown_decision`.
- Ball-in-net windows keep bounded post-context so transcript or visual evidence can catch flag/offside/VAR/no-goal decisions.
- Multi-moment segments carry their own `goalOutcome`; the compilation plan may remain `generic_highlight`.
- Rendered subtitles include safe outcome badges: `CONFIRMED`, `OFFSIDE - NO GOAL`, `POSSIBLE OFFSIDE`, or `DECISION UNCLEAR`.

## Safety Rules

- Do not claim confirmed goal from crowd noise, celebration, shot motion, goal area visibility or ball-in-net visual evidence alone.
- Explicit offside/disallowed evidence overrides celebration evidence.
- If evidence conflicts or is missing, use `possible_offside` or `unknown_decision`.
- Decision-safe goal language such as `OFFSIDE - NO GOAL` is allowed; standalone confirmed-goal copy is not allowed unless the outcome is `confirmed_goal`.
- Reports may expose safe outcome codes and timestamps, but never raw provider output, local paths or secrets.

## Evaluation Notes

Track no-false-confirmed-goal behavior, offside-goal inclusion, post-goal decision context coverage and caption/outcome alignment in future fixtures.
