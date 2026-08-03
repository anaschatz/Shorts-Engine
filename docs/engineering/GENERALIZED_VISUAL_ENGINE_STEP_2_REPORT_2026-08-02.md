# Generalized Visual Engine — Step 2 report — 2026-08-02

## Result

Step 2 adds a strict, deterministic, data-only `VisualProgram v1` boundary and a validated adapter to the existing AnimationIR v1 contract. It does not add or alter a renderer, media pipeline, planner, UI, assets, or default production behavior.

The implementation is isolated in new files. The pre-existing dirty tracked files and untracked experimental/media/cache artifacts were not edited, deleted, or staged by this work.

## Files created

- `server/pipelines/narrated-short/animation/visual-program-contract.cjs`
- `server/pipelines/narrated-short/animation/visual-recipe-registry.cjs`
- `server/pipelines/narrated-short/animation/visual-program-compiler.cjs`
- `tests/generalized-visual-program-v1.test.cjs`
- `docs/engineering/GENERALIZED_VISUAL_PROGRAM_V1.md`
- `docs/engineering/GENERALIZED_VISUAL_ENGINE_STEP_2_REPORT_2026-08-02.md`

No existing tracked source, test, package, or renderer file was modified.

## Common three-story compilation proof

The focused test constructs trusted StoryIR and timing context from these tracked fixtures:

- `001_wow_signal_mystery.json`
- `002_gps_week_rollover.json`
- `003_baychimo_icebound_drift.json`

All three call only `compileGeneralizedVisualProgramV1`. There is no story ID/name branch in the compiler or registry.

The exact recipe sequences proven by the test are:

| Story | Recipe sequence |
| --- | --- |
| Wow Signal | `evidence_inspection` → `bounded_uncertainty` → `comparison` |
| GPS rollover | `finite_cycle` → `cause_effect` → `comparison` |
| Baychimo | `map_route` → `negative_space_absence` → `chronology` |

The three outputs have distinct VisualProgram hashes. Each output is deterministic, recursively frozen, narration/source-bound, covers the full timeline without gaps or overlaps, and passes the existing `validateAnimationIR` contract.

## Security and generalization proof

The tests fail closed on:

- coordinates, transforms, paths, hardcoded frames, remote strings, code-like content, and unknown fields;
- accessors without executing their getter, cycles, sparse arrays, symbol keys, and polluted prototypes;
- stale story bindings, foreign claim references, untrusted entities, unknown recipes/actions/transitions/style tokens, excessive text/helpers/scenes;
- tampered adapter content even when the inner VisualProgram hash is freshly recomputed.

A canonical-order test reverses proposal object keys recursively and proves byte-identical compiled output and hashes. A source guard proves that the compiler contains none of the three fixture IDs/story names, imports no experimental renderer, and is not imported by the existing production compiler.

## Validation results

Final local results:

| Gate | Result |
| --- | --- |
| `node --test tests/generalized-visual-program-v1.test.cjs` | 8 pass, 0 fail, 0 skip |
| `npm run lint` | pass |
| `npm run build` | pass |
| Focused StoryIR/timing/AnimationIR/semantic-v3/educational suite | 78 pass, 0 fail, 0 skip |
| `npm test` | 1,740 total; 1,731 pass; 0 fail; 9 environment-gated skips |

The focused suite includes existing byte-exact semantic-v3 and educational-explainer compatibility assertions. No MP4, contact sheet, or evidence directory is created by the new tests or implementation.

## Known limitations

- The registry describes the first eight semantic recipe capabilities, but Step 2 intentionally does not implement new recipe visuals.
- The AnimationIR adapter uses existing templates and minimal existing operations. Passing the contract is not a claim of viewer comprehension or production visual quality.
- Scene proposal count is bounded to three through six for this initial slice.
- Persistent identity is bound to a trusted StoryIR entity reference and stable compiled entity within its scene; cross-scene visual identity and morph geometry belong to Step 3.
- There is one allowlisted style token. Palette/layout variation is not implemented here.
- Test proposals are hand-authored data. There is no AI/LLM planner.
- There is no new production route or feature flag; consumers must call the new compiler explicitly.

## Deliberately not implemented

- Recipe geometry, layout, focal anchors, scale rules, or safe-zone solver.
- Renderer dispatch or HyperFrames changes.
- AI proposal generation.
- New SVG primitives, assets, styles, animations, videos, benchmark renders, or UI.
- Production rollout, publishing, or changes to existing video appearance.

## Exact Step 3 boundary

Step 3 should implement the first engine-owned recipe/layout/focus system *behind* `VisualProgramV1`:

1. Consume only a validated compiled VisualProgram, never an untrusted proposal.
2. Implement engine-owned layout slots, focal anchors, safe zones, scale limits, one-primary/one-helper composition, and persistent identity.
3. Implement a bounded first recipe subset with visible action semantics, settled holds, and allowlisted transitions.
4. Produce existing schema-valid AnimationIR/renderer input without accepting planner-owned geometry, frames, markup, code, or assets.
5. Add renderer-level deterministic tests and bounded visual evidence for multiple unrelated stories without adding story-specific branches.

Step 3 must not widen the proposal schema merely to make rendering easier. Geometry, motion parameters, layout, and timing remain engine-owned.
