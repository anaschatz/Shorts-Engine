# Provider-Backed Vision Labeling - 2026-06-17

## Decisions

- Added strict visual label validation for provider output.
- Added labels for `crowd_reaction` and `scoreboard_context`.
- Kept `goal`, `scored` and `goal_scored` disallowed as visual labels.
- Added `analyzeVision` as the provider-style entry point while keeping `analyzeFrames` compatible.
- Added deterministic `mock-vision-provider` for tests/eval.
- Added provider latency/failure metadata with public-safe summaries.
- External provider runtime failures/timeouts fall back safely; malformed semantic output still fails closed.
- Improved caption alignment so visual-only save/chance/foul/reaction moments can use type-specific fallback copy instead of generic transcript text.

## Eval

- Added fixtures for visual counter attack and visual crowd reaction without goal claims.
- Eval result during implementation: 16 fixtures, aggregate score 98, `visualLabelPrecision: 1`, `falseVisualGoalRate: 0`.

## Limitations

- This is still not ball/player tracking.
- Real provider integration remains opt-in and should be added behind the existing adapter contract with credentials, rate limits and provider-specific tests.
