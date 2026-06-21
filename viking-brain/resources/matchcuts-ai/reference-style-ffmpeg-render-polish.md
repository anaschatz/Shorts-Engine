# Reference-Style FFmpeg Render Polish

ShortsEngine supports `reference_football_multi_goal_v1` for confirmed-goal multi-moment compilations.

Contract:

- Valid counted-goal compilations can route to `reference_football_multi_goal_v1`.
- FFmpeg multi-segment rendering keeps the existing safe segment cut and concat path, then records rendered transition metadata.
- ASS captions use bounded fade/scale motion and safe line wrapping.
- Confirmed-goal badges render as numbered overlays such as `GOAL 1 · CONFIRMED`, timed near the confirmation window instead of the start of the phase.
- Render reports expose `renderPolishQA` with transition, caption motion, overlay, style preset and warning fields.

Safety decisions:

- No goal badge appears without explicit confirmed-goal evidence.
- No aggressive crop is introduced; wide-safe framing remains the fallback for football action.
- Render polish metadata must not include absolute paths, storage keys, provider errors or secrets.
- Hard-cut fallback is allowed but must be counted in `hardCutFallbackCount` and reported as a warning.

Validation surface:

- Renderer tests cover ASS overlay timing, transition metadata and caption motion metadata.
- YouTube proof reports carry top-level render polish fields for live comparison.
- Frontend/backend validation accepts the new preset and still rejects unknown presets.
