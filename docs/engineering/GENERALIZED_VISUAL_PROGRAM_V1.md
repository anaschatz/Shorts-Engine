# Generalized VisualProgram v1

## Purpose

`VisualProgram v1` is the trust boundary between future semantic planning and the existing narrated-animation pipeline:

```text
trusted StoryIR + trusted timing context + untrusted bounded proposal
  -> strict proposal validation
  -> engine-owned recipe and timing compilation
  -> deeply frozen, hash-bound VisualProgram
  -> validated existing AnimationIR v1 adapter output
```

This step does not add a planner, renderer, primitive implementation, asset, media pipeline, or production route. The existing production compiler remains the default and does not import this boundary.

## Proposal versus compiled program

`VisualProgramProposalV1` is untrusted data. A future planner or LLM may choose only:

- an allowlisted style-token ID;
- three to six semantic scenes;
- the ordered narration beat IDs assigned to each scene;
- a trusted StoryIR scene reference for the dominant primary;
- one allowlisted semantic family, recipe, role, action, and transition;
- zero or one helper with claim references from the same assigned beats;
- bounded semantic state names and a short purpose.

The proposal cannot choose frames, coordinates, dimensions, geometry, paths, transforms, markup, code, assets, or runtime behavior.

`VisualProgramV1` is trusted compiler output. It adds:

- narration-derived scene boundaries;
- contiguous full-timeline coverage;
- one settled readability hold per scene;
- engine-owned entity IDs, templates, template versions, and complexity cost;
- recipe-registry, compiler, style, proposal, story, source, draft, and timing bindings;
- canonical content hashes and recursive immutability.

The public entry point is:

```js
compileGeneralizedVisualProgramV1({
  storyIR,
  timingContext,
  proposal,
  projectId,
  projectRevision,
});
```

It returns a deeply frozen adapter containing both `visualProgram` and a schema-valid existing `animationIR`.

## Proposal schema and invariants

The implemented proposal shape adapts the design to the repository's real StoryIR contract, where narration is partitioned into five `beatId` values:

```text
schemaVersion: 1
profile: generalized_visual_program_proposal_v1
bindings:
  storyIrHash
  timingContextHash
  draftHash
  sourceRevisionHash
styleTokenId
scenes[3..6]:
  id
  purpose
  semanticFamily
  narrationBeatIds[1..5]
  primary:
    entityRef
    role
    recipeId
    action
    fromState
    toState
  helper: null | {
    role
    recipeId
    dataRefs[1..4]
  }
  transitionId
```

All five StoryIR/timing beats must appear exactly once and in their trusted order. A primary `entityRef` must be the source scene of one of the assigned beats. Each helper `dataRef` must be a claim owned by those beats. This prevents a proposal from referring to invented or cross-story evidence.

The current three-scene minimum is also the smallest representation compatible with the existing AnimationIR v1 content contract. The six-scene maximum is deliberately below AnimationIR's broader limit and keeps proposal/action complexity bounded during this first contract slice.

## Security boundary

Validation examines property descriptors before reading values. It does not use property access that could invoke a getter. It rejects:

- functions, classes, symbols, `undefined`, `bigint`, accessors, and non-finite numbers;
- custom or polluted prototypes, cycles, aliases, and sparse arrays;
- unknown fields and oversized arrays, objects, identifiers, and text;
- coordinates, dimensions, transforms, anchors, raw geometry, and hardcoded frame fields;
- SVG, HTML, CSS, JavaScript, scripts, code, and markup;
- remote URLs, `data:`/`javascript:` schemes, and absolute local paths.

The proposal is normalized into fresh plain data before semantic validation. Failure is fail-closed with `GENERALIZED_VISUAL_PROGRAM_INVALID`; raw proposal content is not placed in the public error message.

## Recipe registry

The versioned, deeply frozen registry initially contains exactly these semantic families:

- `finite_cycle`
- `evidence_inspection`
- `bounded_uncertainty`
- `map_route`
- `negative_space_absence`
- `chronology`
- `comparison`
- `cause_effect`

Each definition bounds primary/helper roles, actions, transitions, object counts, persistent-identity requirements, uncertainty support, and its existing AnimationIR template adapter. The registry contains no story name, fixture ID, asset, coordinate, or source path.

Changing registry content changes `VISUAL_RECIPE_REGISTRY_HASH`, which changes the compiled program and adapter bindings.

## Timing ownership

Only the engine resolves timing. Proposal scenes partition trusted narration beat IDs. The compiler derives:

- narration start/end from the first and last assigned timing beats;
- scene boundaries from the next assigned narration group, with first-frame and final-tail ownership;
- bounded transition windows around scene boundaries;
- a final settled hold of at most 12 frames per scene.

Scenes are contiguous, non-overlapping, and cover `0..durationFrames` exactly. The proposal cannot supply or override any frame number.

## Hash and provenance bindings

The canonical JSON hash format already used by the animation subsystem is reused. The chain binds:

```text
StoryIR content hash
timing-context content hash and alignment hash
draft hash
source storyboard revision hash
proposal content hash
registry version and content hash
compiler version
style-token ID and version
VisualProgram content hash
AnimationIR content hash
adapter binding and content hash
```

The compiler compares proposal bindings to trusted inputs before compilation. The adapter independently revalidates the compiled VisualProgram and AnimationIR and checks their cross-hashes. Recomputing one inner hash after tampering is insufficient because the outer bindings and AnimationIR adapter binding no longer agree.

## Existing AnimationIR integration

This step emits the existing `dark_curiosity_continuous` AnimationIR v1 contract. Recipe selection changes the existing allowlisted template and semantic entity plan. Engine-owned absolute anchors are generated only after trusted timing resolution. The result is passed through `validateAnimationIR` and recursively frozen.

This is intentionally an adapter boundary, not the Step 3 visual implementation. The generated operations are minimal existing-contract operations. Step 3 will implement the recipe-owned layout, focus, geometry, and action semantics behind this validated program without widening planner authority.

## Safe data-only proposal example

Hashes below are abbreviated for readability; real inputs require complete SHA-256 values.

```json
{
  "schemaVersion": 1,
  "profile": "generalized_visual_program_proposal_v1",
  "bindings": {
    "storyIrHash": "<trusted-story-ir-sha256>",
    "timingContextHash": "<trusted-timing-sha256>",
    "draftHash": "<trusted-draft-sha256>",
    "sourceRevisionHash": "<trusted-storyboard-sha256>"
  },
  "styleTokenId": "line_art_dark_v1",
  "scenes": [
    {
      "id": "visual_scene_1",
      "purpose": "Show the observed evidence before interpretation",
      "semanticFamily": "evidence_inspection",
      "narrationBeatIds": ["beat_hook", "beat_context"],
      "primary": {
        "entityRef": "scene_hook",
        "role": "document",
        "recipeId": "evidence_inspection",
        "action": "reveal",
        "fromState": "evidence_hidden",
        "toState": "evidence_visible"
      },
      "helper": null,
      "transitionId": "focus_lens"
    }
  ]
}
```

A complete valid proposal must contain three to six scenes and partition all trusted beat IDs.

## Rejected examples

Each fragment is rejected at any nesting depth:

```json
{ "primary": { "x": 0.5, "y": 0.2 } }
```

```json
{ "scene": { "startFrame": 120, "endFrame": 240 } }
```

```json
{ "helper": { "svg": "<svg>...</svg>" } }
```

```json
{ "asset": { "url": "remote-location" } }
```

Objects with getters, functions, custom prototypes, cycles, symbols, or sparse arrays are rejected before semantic compilation.

## Explicit non-goals of v1

- No LLM or AI planner.
- No new renderer or primitive implementation.
- No new visual style or asset vocabulary.
- No filesystem writes, Chromium, FFmpeg, MP4, or evidence generation.
- No change to semantic-v3, educational-explainer, or default production behavior.
- No claim that the minimal adapter output has production visual quality.
