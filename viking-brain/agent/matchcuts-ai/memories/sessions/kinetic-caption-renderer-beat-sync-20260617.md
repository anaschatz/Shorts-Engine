# Session Memory: Kinetic Caption Renderer And Beat Sync

Date: 2026-06-17

Milestone:

- Built real kinetic caption rendering and bounded beat-synced sports animation cues for ShortsEngine.

Decisions:

- Keep creative preset (`hype`, `drama`, `tactical`, `fan`) separate from render style (`clean_sports`, `social_sports_v1`, `punchy_highlight`).
- Pass `stylePreset` through API validation, idempotency, job payload, orchestration and candidate edit plan generation.
- Use role-specific ASS styles instead of a single caption style.
- Use bounded FFmpeg overlays and background push, not object tracking or aggressive foreground crop.
- Parse pipe-separated football titles to prefer matchup segments such as `Αργεντινή - Αλγερία` over generic competition labels.
- Expand eval with caption role validity, render style preset validity and unsupported cue rate.

Safety:

- No false goal captions for no-goal clips.
- Unknown render styles fail closed.
- Unsupported animation cues are ignored with safe metadata.
- Public responses and reports must avoid secrets, raw paths, storage keys and provider errors.

Tests added or updated:

- Renderer ASS contract test.
- Football story planner caption role/title/cue tests.
- Analysis style preset propagation test.
- Client validation style preset test.
- Job persistence/orchestration render style tests.
- Eval metric shape tests.

Limitations:

- Cue timing remains heuristic and deterministic.
- Full beat grid/audio rhythm extraction and sports object tracking are future milestones.
