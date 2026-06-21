# Kinetic Caption Renderer And Beat Sync

ShortsEngine now has a real renderer-facing caption contract and bounded sports animation cues.

Core changes:

- `server/edit-plan.cjs` validates caption roles: `opening_hook`, `context`, `action_callout`, `reaction`, `closing_punch`.
- Captions carry emphasis, layout, timing tokens and style tokens for ASS rendering.
- Supported render styles are `clean_sports`, `social_sports_v1`, `punchy_highlight` and `reference_football_multi_goal_v1`.
- Unknown render styles fail closed at the API/edit-plan boundary.
- Animation cues are bounded by type; unsupported cues are ignored with metadata instead of crashing render.
- `server/render.cjs` writes role-specific ASS styles and applies deterministic FFmpeg overlays for intro bars, beat cuts, punch borders, impact flashes and replay stutter marks.
- Wide-safe framing still preserves the full foreground frame; subtle push applies to the blurred background only.

Safety decisions:

- No ball/player tracking is claimed.
- No aggressive crop is introduced for punchy effects.
- No goal label or caption is emitted unless highlight type and reason evidence explicitly support a goal.
- Greek captions are preserved through ASS text output and safe line wrapping.
- Reports/tests must not leak absolute paths, storage keys, provider errors or secrets.

Validation surface:

- `tests/render.test.cjs` checks ASS role styles, kinetic tags, Greek text and no-goal safety.
- `tests/football-story-planner.test.cjs` checks matchup title parsing, caption roles and bounded cues.
- `tests/analysis.test.cjs` checks requested render style reaches candidate edit plans.
- `eval/scoring.cjs` now measures caption role validity, render style preset validity and unsupported cue rate.

Known limitation:

- Beat sync is deterministic and cue-based. It does not yet perform real beat grid extraction or track the ball/player location.
