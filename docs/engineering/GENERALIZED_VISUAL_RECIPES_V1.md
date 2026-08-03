# Generalized visual recipes v1

## Scope

This step adds a deterministic, engine-owned layout and recipe layer between the trusted `VisualProgram` and the existing `AnimationIR`. It does not add an AI planner, a browser renderer, generated assets, or a production-path switch.

```text
StoryIR + timing + data-only proposal
  -> VisualProgram v1
  -> VisualRecipePlan v1
  -> existing validated AnimationIR
  -> future bounded recipe renderer (Step 4)
```

The proposal remains a semantic control surface. It cannot supply coordinates, dimensions, paths, markup, assets, motion curves, frame numbers, remote content, or executable code. Numerical geometry exists only in the trusted recipe plan produced by `visual-layout-engine.cjs`.

## Contract and bindings

`VisualRecipePlanV1` is canonical, hash-bound, deeply frozen, and requires trusted `VisualProgram`, `StoryIR`, and timing context for public validation. Its bindings cover:

- VisualProgram hash.
- StoryIR hash.
- Timing-context hash.
- Draft and source-storyboard revisions.
- Recipe-registry hash.
- Layout profile and version.

Validation rejects stale bindings, unknown fields, non-finite numbers, sparse arrays, aliases/cycles, accessors, proxies, symbols, custom prototypes, executable/remote strings, content-hash mismatches, and freshly rehashed changes to engine geometry or grounded display copy.

## Engine-owned vertical layout

The v1 layout profile uses a 1080×1920 canvas with separate header, visual ROI, and caption-safe lane. Every recipe has exactly one dominant primary region and no more than one smaller helper region. The engine enforces:

- Primary centering within 54 pixels of the canvas center.
- Primary and helper containment in the visual ROI.
- No primary/helper overlap.
- No caption-lane collision.
- Bounded scale and typography values.
- At most two simultaneous operations.
- A motion-free settled hold of at least eight frames.
- No transition overlap with the preceding settled hold.

The eight recipes deliberately use different composition families rather than a shared blue-card template.

| Recipe | Composition | Required visual semantics |
| --- | --- | --- |
| `finite_cycle` | Mechanism focus | Persistent counter/receiver; before → rollover → resolved |
| `cause_effect` | Directional causal flow | Two grounded states and a qualified directional connection |
| `comparison` | Common-baseline comparison | Two states/values on one bounded baseline |
| `evidence_inspection` | Evidence desk | Evidence document, inspection lens, settled readable detail |
| `bounded_uncertainty` | Uncertainty band | Observed, inferred, and unknown remain distinct; unresolved stays open |
| `map_route` | Route field | Engine-generated ordered geometry with an approximate-route disclosure |
| `negative_space_absence` | Expected-presence field | Expected outline and searched context make absence visible |
| `chronology` | Chronology track | Ordered events, active point, and bounded markers |

Route coordinates from StoryIR are intentionally ignored. The layout engine generates a stable illustrative route from semantic order only.

## Grounding policy

Display labels are copied only from trusted StoryIR fields: heading, primary/secondary labels, on-screen text, claim IDs, certainty, and narrative role. Proposal `purpose`, action, and state values control behavior but are not treated as factual display copy.

The worst certainty across a scene's bound beats is preserved. The engine never promotes `qualified` or `disputed` material to `verified`. Approximate map geometry carries an explicit disclosure.

## Timing policy

Each scene derives five contiguous phases from narration-bound scene timing:

```text
enter -> develop -> reveal -> resolve -> hold
```

The first four phases fit before the VisualProgram readability hold. All AnimationIR operations end at or before that boundary. Short scenes with fewer than eight pre-hold frames are rejected deterministically rather than silently compressed into unreadable motion. The pure scene-state resolver makes `N → M → N` random seeks deterministic.

Timing changes alter the recipe-plan and adapter hashes while leaving engine-owned geometry unchanged.

## AnimationIR adapter

The former placeholder-only scene operations are replaced with allowlisted recipe operations using the existing schema:

- `create`
- `fade`
- `move`
- `scale`
- `draw_path`
- `morph_path`
- `highlight`
- `pulse`

No AnimationIR schema expansion was needed. `VisualRecipePlanV1` is included beside the VisualProgram and AnimationIR in the experimental adapter and participates in its binding hash. The default production compiler and renderer dispatch remain unchanged.

## Explicit limitations

This step proves deterministic recipe planning, layout safety, grounded labels, narration-derived phases, recipe-specific AnimationIR operations, and three-story generalization. It does not prove browser-rendered pixel quality or viewer comprehension. Step 4 must implement reusable renderer primitives and produce the first bounded browser-rendered proof before any production-path proposal.
