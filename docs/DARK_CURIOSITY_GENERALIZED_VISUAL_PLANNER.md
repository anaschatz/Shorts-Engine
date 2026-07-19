# Dark Curiosity generalized visual planner

## Purpose

The `semantic-v3` path can now compile an approved Dark Curiosity story without
requiring its exact draft and alignment hashes to exist in the checked-in
profile registry.

This slice generalizes semantic planning, not unrestricted animation code
generation. It produces a new grounded sequence of existing, renderer-supported
visual sentences for each short.

## Pipeline

```text
approved DraftBundle + exact AnimationTimingContext
  -> grounded StoryIR
  -> VisualIntentGraph
  -> validated SemanticEventGraph
  -> SemanticVisualSentencePlan
  -> production plan
  -> AnimationIR v3
  -> semantic sentence renderer
```

### Grounded StoryIR

`story-ir.cjs` binds every representation to:

- the approved draft hash;
- the approved storyboard hash;
- the exact timing-context and alignment hashes;
- all five ordered narration roles;
- every aligned word and frame span;
- the claim ledger and source storyboard operations.

Narration is deterministically divided at punctuation and semantic clause
boundaries into at most four readable segments per beat. Segments must partition
the aligned words exactly, preserve frame order, contain at most 120 characters,
fit the renderer's six-line copy budget, and produce at most 20 sentences for
the full short.

### VisualIntentGraph

`generalized-visual-intent-planner.cjs` maps each grounded segment to a visual
intent, entity, event, epistemic status, and source scene. Planning uses both the
story vocabulary and local narration semantics such as recurrence, negation,
uncertainty, disappearance, chronology, quantities, causality, and movement.

The graph validates:

- the StoryIR again against the supplied approved draft and exact timing context;
- exact intent order and segment identity;
- exact word-span continuity;
- entity, claim, source, and beat bindings;
- cross-beat continuity for persistent entities;
- renderer-supported asset–grammar pairs, not only separate allowlists;
- deterministic canonical hashes and immutable artifacts.

### Semantic adapter

`generalized-semantic-event-planner.cjs` adapts the StoryIR and
VisualIntentGraph to the existing SemanticEventGraph contract. Cue source
references point to exact character offsets inside approved narration text.
Qualified and disputed claims retain explicit uncertainty constraints.

No external model or API is called during compilation. The result is
deterministic for the same approved draft and alignment and can be safely
recompiled by queued jobs.

## Compatibility

The profile registry remains a two-entry exact golden allowlist. Compilation is
registry-first:

1. GPS and Baychimo exact tuples use their original checked-in manifests.
2. Other valid `dark_curiosity` / `documented_mystery_v1` inputs use the
   generalized planner.
3. The default non-`semantic-v3` path remains unchanged.

The renderer capability lists are mirrored server-side and tested against the
actual renderer exports so the planner fails closed instead of selecting an
asset or grammar that cannot render.

Leading silence in a valid alignment is preserved. The first visual sentence is
available from frame zero at zero progress and begins its semantic motion at the
exact first-word frame.

## Verification

The focused suite covers three unrelated checked fixtures and one derived
general-mystery case:

- WOW signal (`radio_signal`);
- GPS week rollover (`temporal_anomaly`);
- Baychimo (`maritime_route`).
- archive relationship (`general_mystery`).

It verifies determinism, deep immutability, exact word partitioning, distinct
story-specific intent and grammar sequences, real end-to-end renderer dispatch,
leading silence, renderer line budgets, semantic negation and movement,
same-vocabulary semantic variation, registry preservation, renderer capability
parity, and adversarial contract failures.

Run it with:

```sh
node --test tests/dark-curiosity-generalized-visual-intent-planner.test.cjs
```

## Current boundary and next slice

The planner now creates a new semantic animation sequence per short, but the
renderer primitives still contain several fixed labels, values, and geometry.
For example, some counters, mappings, dates, and cause/effect labels are
template constants.

The next slice should add a strictly validated primitive-parameter contract to
the VisualIntentGraph and AnimationIR, then render story-grounded labels,
numbers, paths, state values, and geometry. That is the step that turns
story-specific sequencing into genuinely story-specific procedural animation
while retaining deterministic rendering and the existing safety gates.
