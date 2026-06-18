# Session Memory: Referee/VAR/Offside Visual Decision Detection

Date: 2026-06-18

## Decisions

- Added `server/goal-outcome.cjs` as the dedicated resolver for ball-in-net outcome decisions.
- Expanded visual decision labels for referee, VAR, offside-line replay and scoreboard decision signals.
- Kept deterministic fallback as default; no paid/provider API is required for local tests, eval or demo.
- Changed story planning so decision-aware goal windows can exceed the old 22s goal cap when needed to include post-goal decision context.
- Added eval metrics for offside outcome accuracy, disallowed-goal inclusion, decision context coverage, caption/outcome alignment and post-goal window coverage.

## Safety

- Confirmed goals require explicit confirmation evidence.
- Weak VAR/offside review cues remain `possible_offside`.
- Ball-in-net without a final decision remains `unknown_decision`.
- Disallowed/offside goals are included, but must use no-goal/offside captions and badges.

## Validation Notes

- Focused tests covered resolver, visual decision labels, analysis and render badges.
- `npm run eval` passed with 21 fixtures and all new decision metrics at `1`.
