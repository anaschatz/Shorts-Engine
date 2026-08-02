# Generalized Visual Engine — Step 4 report — 2026-08-02

## Outcome

Step 4 adds the first reusable renderer behind the experimental generalized visual adapter. The renderer consumes the Step 3 `VisualRecipePlanV1`, produces eight materially different SVG recipe trees, evaluates arbitrary frames deterministically, and supplies a bounded real-browser proof runner.

The default production renderer path was not replaced. Activation is explicit through `compileGeneralizedVisualProgramAdapterToHtml`; no existing `AnimationIR` tuple silently enters this renderer.

## Implemented architecture

- `generalized-visual-style-v1.mjs`: eight allowlisted composition-family palettes with dark editorial hierarchy.
- `generalized-visual-primitives-v1.mjs`: 16 engine-owned, bounded SVG primitives and all eight recipe composition trees.
- `generalized-visual-runtime-v1.mjs`: immutable operation windows and history-free random frame evaluation.
- `generalized-visual-recipes-v1.mjs`: strict tuple validation, embedded pinned font, CSP, markup assembly, and QA metadata.
- `animation-ir-adapter.mjs`: one isolated generalized-adapter export; existing default dispatch logic remains intact.
- `generalized-visual-browser-proof.mjs`: Chromium rendering, screenshot hashing, DOM layout audit, network isolation, and strict report normalization.
- `render-generalized-visual-proof.mjs`: dry-run/write confirmation boundary and temporary-artifact lifecycle.

No untracked story-specific renderer, story-owned SVG asset, generated media, cache, or evidence directory is a dependency of this implementation.

## Security and determinism

The proposal/AI boundary still cannot provide geometry, markup, CSS, SVG paths, URLs, or code. Geometry and state come from the canonical Step 3 plan. The adapter, plan, and AnimationIR are revalidated against trusted StoryIR/timing context before rendering.

Grounded story labels are escaped. Recipe SVG is engine-authored. The CSP denies external resources. The runtime has no `Date.now`, `Math.random`, timer, or playback-history dependency. Unsupported tuples, recipes, operations, and hash/binding mutations fail closed.

## Browser proof result

A real headless Chromium run rendered:

- three compiled story cases;
- nine scenes and all eight recipes;
- five phase samples per scene, for 45 screenshot hashes;
- 1080x1920 output;
- explicit `N -> M -> N` seeks.

The bounded proof passed its layout fidelity, primary/helper collision, typography, marker bounds, caption safety, visible visual ROI, motion budget, settled hold, random-seek determinism, and network-isolation gates. Generated PNG/report artifacts remained temporary and were deleted; no golden media is committed.

The final exact-commit proof must be rerun after the feature commit exists. A report tied to an earlier commit, even if the working tree contained the implementation, is not release evidence.

## What this step proves

- The same production module set renders all three fixtures.
- All eight recipes have non-empty, distinct composition structures.
- Rendered bounds correspond to the trusted plan, with one dominant primary and at most one helper.
- Recipe markers, labels, and primitives remain bounded away from the caption lane in the tested scenes.
- Frame seeking is deterministic and holds have no active motion.
- The sanitized proof contract detects summary, shape, and content-hash tampering.
- The existing renderer dispatch remains available and unchanged in behavior.

## What this step does not prove

- Human viewers understand every visual without narration.
- The compositions meet a final aesthetic bar or outperform existing shorts.
- Every possible grounded-text combination remains equally legible.
- Screenshot hashes match across different Chrome, OS, GPU, or font-rendering versions.
- Audio/caption synchronization, complete MP4 encoding, upload, or distribution works.
- This experimental path is production-ready or enabled by default.

## Honest next boundary

Step 5 should be perceptual and human-quality validation, not another schema expansion. It should render bounded review material for varied stories, score visual-narration comprehension, hierarchy, pacing, and text legibility, then feed only generalizable fixes back into the recipe/style system. Human approval and real output review remain mandatory before any production-path activation.
