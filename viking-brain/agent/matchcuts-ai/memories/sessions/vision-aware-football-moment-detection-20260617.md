# Vision-Aware Football Moment Detection - 2026-06-17

## Decisions

- Added `server/vision.cjs` as the visual analysis boundary.
- Visual signals are validated and normalized before highlight detection.
- Visual reason codes can support `big_chance`, `save`, `foul`, `counter_attack`, `replay_or_reaction` and `unknown_action`.
- Visual evidence never creates `highlightType: "goal"` without explicit `goal` reason evidence.
- Landscape football rendering remains `wide_safe_vertical` by default to keep the ball/action visible in the full source frame.
- Edit plans now expose `visualEvidenceSummary`, `actionFocusConfidence` and `framingReason`.

## Evaluation

- Added fixtures `011` through `014` for visual shot, save, foul/contact and goal-area-only no-goal cases.
- `npm run eval` result during implementation: aggregate score `98`, fixture count `14`, `visualReasonPrecision: 1`, `falseVisualGoalRate: 0`.

## Tests

Focused tests covered:

- visual signal validation
- visual reason mapping
- no false goal from visual signals
- render orchestration `analyze_visuals` step
- invalid visual output fail-closed behavior
- eval report visual metrics

## Limitations

- The default analyzer is still a safe heuristic fallback, not real object tracking.
- A later milestone should add sampled-frame extraction and real provider/local CV inference behind `analyzeFrames`.
