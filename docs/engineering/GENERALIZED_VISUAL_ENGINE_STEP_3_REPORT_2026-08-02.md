# Generalized Visual Engine — Step 3 report — 2026-08-02

## Result

Step 3 implements engine-owned vertical layouts and eight real visual recipe plans on top of the Step 2 VisualProgram boundary. The implementation remains isolated from the default production path.

New production modules:

- `visual-layout-engine.cjs`
- `visual-recipe-plan-contract.cjs`
- `visual-recipe-plan-compiler.cjs`

The Step 2 adapter was minimally extended to bind the new recipe plan and emit recipe-specific operations through the existing AnimationIR contract.

## Demonstrated generalization

One compiler handles the three tracked benchmark sequences:

- Evidence inspection → bounded uncertainty → comparison.
- Finite cycle → cause/effect → comparison.
- Approximate map route → negative-space absence → chronology.

Together these exercise every registered recipe. They produce distinct composition families, geometry kinds, hashes, and recipe state profiles without story-ID branches in production modules.

## Security and trust boundary

- Proposal geometry, frames, markup, code, assets, URLs, and dimensions remain rejected by the Step 2 boundary.
- Recipe-plan geometry is reproduced by trusted engine code during validation, so a caller cannot alter a coordinate and regain validity by recalculating only the content hash.
- Grounded display fields are reproduced from trusted StoryIR during validation.
- Public recipe-plan validation requires the trusted VisualProgram, StoryIR, and timing context.
- The plan is data-only, canonical, hash-bound, and deeply frozen.
- No filesystem, network, media, browser, subprocess, or untracked renderer dependency was introduced.

## Timing and visual hierarchy

- All scene motion is narration-derived.
- Every scene ends with a motion-free settled hold.
- Adapter concurrency is reduced from four to two operations.
- A dominant centered primary is mandatory.
- A helper is optional, smaller, and non-overlapping.
- All visual elements remain outside the caption lane.
- Route geometry is illustrative, approximate, and generated without StoryIR coordinates.

## Validation evidence

The focused Step 3 suite covers all eight recipes, three distinct story compositions, grounded labels, certainty preservation, safe zones, collision checks, random-seek determinism, timing-driven hash changes, hostile object graphs, fresh-hash tampering, production isolation, and existing VisualProgram compatibility.

Final command results and commit/CI evidence are recorded in the task handoff after all repository gates finish.

## Honest remaining boundary

This is not yet a production renderer and no claim of visual polish is made. The current renderer does not consume the new numerical layout plan. Step 4 should add production-quality reusable primitives and a bounded renderer adapter, then generate browser-rendered proof for human review. No default-path switch should happen before that evidence exists.
