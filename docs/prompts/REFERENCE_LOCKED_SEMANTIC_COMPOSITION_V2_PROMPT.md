# ShortsEngine implementation prompt — reference-locked semantic composition v2

## Objective

Replace the "choose one complete visual recipe" calibration boundary with an
experimental, feature-gated semantic composition path that keeps one directed
art style while producing story-specific animation structure.

The required distinction is:

- **Style is engine-owned and fixed.** Palette, typography, line treatment,
  density, safe regions, easing, transition quality, and caption separation
  must remain recognizably consistent.
- **Composition is story-owned semantically and engine-owned geometrically.**
  Different stories must use different grounded entities, relations, focal
  paths, state changes, and motion tracks. They must not be reskins of the same
  full-scene template.

This is a bounded quality proof, not a production rollout. Keep every new path
opt-in, non-publishable, and isolated from current default dispatch.

## Failure being corrected

`mechanism-explainer-v1` proved deterministic reuse by forcing GPS and an
odometer into the same counter panel. The generalized visual v1 work broadened
that approach to eight complete recipes, but a recipe still owns one fixed
layout, one fixed primitive tree, and essentially one motion sequence. It also
changes palette by composition family. That architecture can prove recipe
diversity but cannot prove unique visual storytelling.

Do not solve this by:

- adding more complete scene templates;
- randomly jittering coordinates;
- switching color palettes per story or recipe;
- allowing an LLM to emit SVG, HTML, CSS, JavaScript, paths, coordinates,
  frames, remote assets, or visible factual copy;
- hardcoding GPS, odometer, fixture IDs, narration strings, or frame numbers in
  renderer production modules;
- treating different text inside the same composition as a different
  animation.

## Target flow

```text
trusted narration + exact alignment + trusted semantic event graph
  -> engine-generated depiction candidates
  -> bounded CompositionProposal v2
  -> semantic trace and repetition preflight
  -> deterministic graph layout
  -> CompositionPlan v2 + target-specific motion tracks
  -> reference-locked HyperFrames composition renderer
  -> captions/audio compositor
  -> technical, semantic, repetition, and perceptual proof
  -> explicit human-review-pending result
```

The bounded proposal is the future LLM control surface. This slice may use
operator-authored proposals for the golden proof, but their schema and
validation must be identical to the eventual model output boundary.

## One locked ReferenceArtDirectionSpec

Create a versioned, hash-bound, server-owned art-direction spec. Every proof
story and every composition must use the same spec and style hash.

Required visual identity:

- canvas: 1080x1920 at 30 fps;
- background: near-black `#030303`;
- primary line/text: near-white `#f8fafc`;
- semantic accent: purple `#a78bfa`;
- exception/danger/signal accent: red `#ef4444`;
- secondary/support accent: blue `#60a5fa`;
- Outfit typography with fixed title, semantic-label, and caption roles;
- consistent line weights, rounded joins, corner radii, and easing curves;
- one visual ROI, one caption-safe lane, and no progress/story-thread bar;
- one dominant focus and bounded supporting context;
- no palette selection in the proposal and no palette branch by topology,
  recipe, or story.

Semantic color roles may change which of the fixed accents an entity uses, but
must not create a new style.

## CompositionProposal v2 — bounded model surface

Prefer reuse of the existing trusted semantic-event-graph contracts instead
of inventing a second factual entity graph. Bind every proposal to the exact
semantic graph, timing context, draft/source revision, candidate catalog, and
style spec.

For each scene, the proposal may select only bounded identifiers such as:

- narration beat or intent IDs;
- two to six trusted entity/depiction candidate IDs;
- one to six trusted proposition/relation IDs;
- one focus entity ID;
- one allowlisted topology intent;
- allowlisted semantic action/event candidate IDs;
- an explicit continuity policy and allowlisted transition intent.

Allowlisted topology intents are layout solvers, not finished animations:

- `single_focus`
- `actor_object`
- `directed_chain`
- `parallel_tracks`
- `comparison_pair`
- `radial_mechanism`
- `timeline`

The proposal must not contain visible text, colors, coordinates, dimensions,
anchors, transforms, geometry, paths, frame numbers, timing durations, assets,
URLs, markup, code, style tokens other than the required spec ID, or invented
entity/relation identifiers.

Reject accessors, proxies, custom prototypes, cycles, aliases, sparse arrays,
unknown properties, oversized inputs, executable strings, remote content, and
absolute paths before semantic validation.

## CompositionPlan v2 — engine-owned output

The compiler must resolve proposal selections against trusted semantic data and
produce a canonical, deeply frozen, hash-bound plan containing:

- grounded entity kinds, semantic roles, labels, claim/source references, and
  certainty;
- grounded directed relations and before/after states;
- exact scene and cue frames derived from alignment, never model-authored;
- deterministic layout bounds produced by topology and graph structure;
- persistent identity and cross-scene representation bindings;
- target-specific motion tracks;
- a settled comprehension hold after each key semantic action;
- semantic trace, graph fingerprint, motion fingerprint, quantized layout
  fingerprint, and style hash.

No visible factual copy may originate from free-form proposal text. Resolve it
from trusted StoryIR/semantic-event data or from explicitly marked
operator-authored calibration inputs.

## Low-level renderer vocabulary

Implement composable low-level depictions rather than full-scene functions.
The initial allowlist should cover the proof without story branches:

- human observer/scientist;
- generic device and receiver;
- satellite;
- vehicle;
- digit or number wheel;
- numeric token/counter value;
- calendar;
- clock/timeline marker;
- document/software patch;
- signal wave;
- generic bounded label.

Relationship/effect primitives should include:

- directed arrow;
- dashed signal transfer;
- carry connection;
- mapping/interpretation connection;
- parallel time tracks;
- focus ring;
- draw-on/reveal mask;
- state replacement/morph;
- persistent-object movement.

The renderer must iterate over compiled entities, relations, and tracks. Do not
implement `if story === gps`, `switch recipeId` full-scene trees, or any
equivalent hidden story template.

## Deterministic layout and motion

- Layout is derived from topology, graph degree/order, focus, semantic role,
  continuity, and safe regions.
- Variation is semantic and deterministic; random coordinate jitter does not
  count as diversity.
- Enforce containment, collision separation, mobile legibility, caption-lane
  exclusion, one dominant focus, and a bounded visible-object budget.
- Evaluate every target track directly from the requested frame. No wall
  clock, CSS autoplay, incremental state, `Math.random`, or history-dependent
  transforms.
- Bind motion cues to exact aligned semantic words/intents where available.
- Permit at most two simultaneous meaningful actions and end each scene with a
  motion-free hold.
- Cuts must use bounded crossfade, match, focus, or continuity transitions;
  no hard full-frame replacement unless semantically required.

## Semantic trace gate

Fail the proof when any important narrated mechanism is communicated only by
text. Require:

- every bound beat/intent to map to at least one non-text entity plus a
  relation or visible state-changing action;
- every relation endpoint to resolve to selected grounded entities;
- causality arrows only for evidence whose certainty permits causality;
- qualified/disputed/unknown material to remain visually qualified;
- key actions to start inside their aligned narration cue and settle after it;
- continuity/match transitions to reuse a real grounded identity or compatible
  representation.

## Repetition gate

Compute and store three independent descriptors for every scene:

1. semantic graph: topology, entity-role multiset, relation predicates,
   degree/focus path, and state delta;
2. motion: target role, operation, direction, phase, and relative cue order;
3. visual structure: quantized ROI occupancy/silhouette at the settled frame.

Reject exact and near-duplicate consecutive scenes. Also scan non-adjacent
scenes and both proof stories. Persistent identity permits reuse only when a
material state, relationship, or focal change occurs. Reusing the same object
without a substantive semantic change must fail.

If a future LLM proposal fails, bounded replanning may occur at most twice.
Any deterministic fallback that repeats a template must remain visibly marked
as fallback and fail the creative quality gate rather than silently passing.

## Mandatory proof stories

Render two complete non-publishable calibration videos through the exact same
compiler, style spec, primitive registry, layout solver, runtime, and media
pipeline:

### GPS rollover

The animation must visibly explain, without relying only on labels:

- satellite/signal sends a finite week value;
- the value reaches a receiver;
- rollover changes the transmitted number from the last value to zero;
- old interpretation maps that repeated value to the wrong calendar cycle;
- displayed date moves backward while real time continues forward;
- a software correction changes the mapping to the correct cycle;
- final state makes clear that the number repeated but time did not.

### Odometer rollover

The animation must visibly explain:

- a vehicle contains a six-wheel counter;
- a carry propagates from one wheel to the next;
- the maximum value rolls through all wheels to zero;
- the vehicle continues moving while the counter remains at zero;
- final state makes clear that the finite display reset, not the vehicle.

The GPS and odometer may share low-level primitives such as digits, arrows, and
labels. They must not share a complete scene tree, graph fingerprint, motion
fingerprint, or settled-frame structure.

Use existing local calibration narration/caption assets where possible. Do not
claim commercial-use approval. Preserve full subtitles in the existing purple
profile and a VTT sidecar, while keeping semantic typography separate from the
caption lane.

## Evidence and acceptance criteria

- Both outputs are 1080x1920, 30 fps, H.264/AAC with exact duration/frame
  agreement and no clipping.
- Same art-direction spec ID and hash for every scene in both stories.
- Different semantic graph, motion, layout, composition, and sampled-pixel
  hashes for GPS and odometer.
- No story IDs, story narration, hardcoded story frames, or story-specific SVG
  assets in renderer/compiler production modules.
- Proposal contains no text/geometry/frames/code/assets/URLs.
- Every important narrated relation has a non-text semantic trace.
- No adjacent near-duplicate scene fingerprints.
- GPS includes an explicit wrong-date versus real-time split and corrected
  mapping.
- Odometer includes visibly sequential wheel carry and persistent vehicle
  motion after rollover.
- Meaningful motion cues begin within two frames of their resolved aligned cue
  when exact cue alignment exists.
- Scene replacements are smooth and every resolved idea receives a readable
  hold.
- Full captions remain visible and outside the visual ROI.
- Same input, versions, and seed reproduce plan hashes and sampled frame
  hashes.
- Browser/runtime QA, renderer tests, contract/security tests, and media probes
  pass.
- Contact sheets and a sanitized comparison report are generated.
- Result remains feature-gated, non-publishable, and
  `humanReviewStatus: pending`.

Inspect the two videos and contact sheets after rendering. Do not report
success from tests alone. If the visual result still reads as the same template
with different labels, stop and report failure rather than weakening the
acceptance criteria.

## Compatibility

- Keep generalized visual v1 and all current production profiles byte- and
  behavior-compatible.
- Add an explicit v2 compiler/renderer entry point; do not silently route
  default AnimationIR into it.
- Do not change publishing approval, evidence, rights, or upload guards.
- Do not overwrite unrelated working-tree changes or commit generated caches.
