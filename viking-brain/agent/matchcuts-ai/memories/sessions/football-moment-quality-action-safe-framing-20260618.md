# Session Memory: Football Moment Quality + Action-Safe Render Framing

## Decisions

- Added action-sequence metadata to analysis evidence and candidate edit plans so
  debugging can distinguish action-led moments from reaction-only context.
- Scene-change and replay context must not be counted as build-up action by
  itself.
- Trend edit cues are now evidence-aligned: reaction-only moments do not get
  punch zoom, impact flash or freeze-frame effects.
- Evaluation summaries now surface action-window and animation-relevance metrics.

## Safety

- No brittle ball tracking was introduced.
- Goal claims remain gated by explicit goal evidence.
- Wide-safe framing stays the default fallback.
- Reports expose only safe booleans, bounded counts and known metric names.

## Tests

- Added focused coverage for goal shot-to-payoff action sequence metadata.
- Added regression coverage for reaction-only cue suppression and contact/action
  cue enablement.
- Eval tests assert the new action-sequence and animation-relevance metrics.
