# Generalized Visual Renderer v1

## Scope

The generalized visual renderer is an experimental, deterministic browser renderer for the validated Step 3 adapter. It turns engine-owned `VisualRecipePlanV1` geometry and `AnimationIR` timing into self-contained HTML/SVG/CSS. It does not accept an AI-authored DOM, SVG path, stylesheet, URL, file path, or executable payload.

```text
trusted StoryIR + timing
  -> VisualProgramV1
  -> VisualRecipePlanV1
  -> AnimationIR
  -> strict generalized adapter validation
  -> recipe + primitive renderer
  -> random-access frame runtime
  -> HTML/SVG composition
```

The entrypoint is `compileGeneralizedVisualProgramAdapterToHtml(adapter, trustedContext)`. This export is separate from `compileAnimationIRToHtml`; the existing production dispatch remains unchanged.

## Bound tuple and fail-closed behavior

Rendering requires the exact v1 tuple:

- generalized adapter schema/profile v1;
- recipe-plan profile `generalized_visual_recipe_plan_v1@1.0.0`;
- layout profile `engine_owned_vertical_layout_v1@1.0.0`;
- local Hyperframes provider/runtime `0.7.55`;
- valid StoryIR, draft, timing, VisualProgram, plan, and AnimationIR bindings.

The canonical compiler validator revalidates hashes and trusted bindings before any markup is emitted. Missing plans, version mismatches, unknown recipes, unsupported operations, and tampering fail closed. There is no generic-card fallback.

## Primitive registry

The renderer owns a fixed registry of 16 primitives: panel frame, document, inspection lens, counter cells, directional connector, comparison baseline, bounded marker, uncertainty region, route path, route marker, expected-object outline, chronology axis, chronology event marker, grounded label, certainty badge, and focus ring.

Primitive functions receive only validated plan fields. Coordinates are finite and bounded by the engine-owned layout. Paths are constructed from validated engine points. Text is XML-escaped and deterministically fitted to bounded lines; overlong final lines use a bounded SVG `textLength`. Caller-provided markup, CSS, paths, assets, and URLs have no API surface.

Each primitive has stable `data-primitive`, semantic-role, bounds, and caption-avoidance metadata. The DOM contains one dominant primary and at most one helper. The caption lane remains a separate, opaque safe zone.

## Recipes and visual hierarchy

All eight recipes have different composition trees, not icon swaps:

- `finite_cycle`: persistent counter cells and rollover path;
- `cause_effect`: two states and a certainty-qualified connector;
- `comparison`: bounded markers on a shared baseline;
- `evidence_inspection`: evidence document and inspection lens;
- `bounded_uncertainty`: observed, inferred, and unknown regions;
- `map_route`: engine-generated route points plus an explicit illustrative/approximate disclosure;
- `negative_space_absence`: expected outline, searched field, and absence focus;
- `chronology`: ordered markers on an engine-owned axis.

The style layer selects from eight allowlisted dark-editorial palettes by composition family. It does not branch on a story ID. Every scene has one high-contrast focal object, lower-contrast helpers, clean line art, and a maximum of two simultaneous operations.

## Frame evaluation

`createGeneralizedVisualRuntimeData` compiles validated operations into immutable frame windows. Both the Node resolver and browser runtime derive state from the requested frame alone:

- frame and scene are clamped to the trusted duration;
- the active `enter`, `develop`, `reveal`, `resolve`, or `hold` phase is selected directly;
- draw, reveal, resolve, opacity, and active-operation values are recomputed;
- holds force zero active motion;
- more than two active operations throws;
- `N -> M -> N` does not depend on playback history.

The runtime uses no clock, random generator, timer, or remote request. The same adapter, viewport, and frame therefore produce the same state and screenshot hash on the same pinned browser/font runtime.

## Asset and network boundary

The only font is the tracked dependency `@fontsource/outfit`; its WOFF2 bytes are embedded by the renderer and SHA-256 bound in composition metadata. The document CSP denies network, media, objects, frames, forms, and caller assets. Browser proof additionally aborts and counts any non-`about:blank`/non-data request.

## Bounded browser proof

Dry-run validation is non-writing:

```bash
node tools/render-generalized-visual-proof.mjs --dry-run
```

Real proof requires both write flags:

```bash
node tools/render-generalized-visual-proof.mjs --write --confirm-bounded-proof
```

The tool compiles the three tracked test fixtures through the same Step 3 compiler and v1 renderer. It renders one frame from each of five phases for every scene at 1080x1920, checks DOM layout and safe zones, takes deterministic PNG hashes, and performs an `N -> M -> N` screenshot comparison. Temporary PNG and report files are deleted before exit.

The returned report is strict, canonical, hash-bound, deeply frozen, and sanitized. It contains versions, exact commit SHA, bounded hashes/frame numbers, recipe IDs, dimensions, and Boolean gates only. It contains no raw narration, HTML, path, filename, user identifier, URL, token, or storage key.

This proof demonstrates deterministic mechanical rendering and bounded layout for the selected fixtures. It is not human aesthetic approval, cross-platform pixel equivalence, a full video/audio render, staging proof, or production release proof.
