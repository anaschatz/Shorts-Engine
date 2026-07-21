# Dark Curiosity generalized visual planner

## Purpose

The `semantic-v3` path can now compile an approved Dark Curiosity story without
requiring its exact draft and alignment hashes to exist in the checked-in
profile registry.

The generalized path now produces both a grounded visual-sentence sequence and
story-specific parameters for the renderer's procedural primitives. It does not
execute model-generated animation code.

## Pipeline

```text
approved DraftBundle + exact AnimationTimingContext
  -> grounded StoryIR
  -> VisualIntentGraph
  -> validated SemanticEventGraph
  -> SemanticVisualSentencePlan + grounded primitive parameters
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

### Grounded primitive parameters

Generalized graphs declare
`dark_curiosity_grounded_primitive_payload_v1` at graph level and require a
payload on every proposition. The payload preserves:

- a headline bound to the exact approved `beat.onScreenText`;
- sentence-specific detail bound to the exact current narration cue;
- quantities whose values and units retain exact source offsets;
- one explicit display quantity selected from the current cue, with
  exact transition targets such as `reset to zero` ranked first, followed by
  predicate-relevant measures or dates; incidental numbers on negation and
  uncertainty cues are omitted, and up to eight candidates remain available
  so a later grounded target cannot be truncated;
- optional normalized route points bound to the exact approved `draw_route`
  operation.

Validation deterministically rebuilds StoryIR, VisualIntentGraph, and the
expected generalized semantic manifest from the approved draft and timing. It
then compares the full generalized proposition tuple. Fresh hashes therefore
cannot rebind copy, quantities, state, polarity, or route geometry to another
beat or operation, and the parameterized profile cannot silently omit only
some payloads.

The sentence planner converts that payload into
`dark_curiosity_story_primitive_parameters_v1`. Each parameter block is bound
to the selected grammar and asset, contains a controlled semantic state token,
and uses a deterministic geometry seed. Arbitrary SVG paths, HTML, CSS,
executable content, remote URLs, colors, or unbounded coordinates are not
accepted.

When approved storyboard route points exist, the map primitive renders those
bounded layout points in their approved order as a waypoint-preserving
polyline. Otherwise it renders a seeded illustrative route and marks its
geometry provenance accordingly. Seeds are limited to non-semantic decoration
and bounded layout variation: grounded values select semantic marks such as a
ten-bit counter's ten ticks, while unknown values use neutral geometry.

The renderer and server share the same parameter normalizer. The renderer also
revalidates sentence plans whenever the graph declares grounded payloads or the
plan contains parameters. Fully stripping and rehashing a generalized
graph/plan is also rejected at the contract and renderer boundaries; the only
unparameterized exceptions are the exact checked graph and sentence-plan
hashes of the two fixed golden profiles. Grounded copy is XML-escaped,
quantities retain their value and unit, and bounded semantic excerpts
prioritize negation and preserve a multiword payoff phrase whenever it fits.
Cause/effect scenes render distinct calendar, counter, mapping-table, and
receiver motifs; an affirmative result uses a success path while only rejected
semantics use the error cross. Quantified cycles keep the exact grounded value
visible while the semantic state changes; cycles without a quantity switch to
a symbolic layout with no fake numeric value or numeric ticks. Vessel-absence
layouts distinguish a repeating loop from a bounded limit. Vessel-absence
scenes select ice and blizzard motifs independently and only when those words
occur in the grounded headline or cue, otherwise they use a neutral observation
field. Parameterized cause and chronology labels use deterministic balanced
wrapping and final width fitting, including single long words. The exact
current cue remains visible in the sentence caption while primitive labels stay
within their legibility budget.

### Constrained scene composition

Generalized sentences now declare the plan-level
`dark_curiosity_scene_composition_v2` profile and carry one deterministic
`sceneComposition` each. Every composition has exactly three bounded modules:

1. one primary module that renders the sentence's selected grammar and asset;
2. one contextual support module selected from grounded cue detail, display
   quantity, or an approved storyboard route;
3. one semantic-state support module.

The modules are connected by two fixed semantic links and placed in one of
three renderer-owned layouts: `header_strip`, `satellites_left`, or
`satellites_right`. Layout selection and its bounded variant seed are derived
from the graph hash, proposition, grounded primitive parameters, and recent
layout history. Recompiling identical approved inputs therefore produces the
same composition, while consecutive sentences avoid an immediate layout
repeat.

Composition v2 also requires one
`dark_curiosity_bounded_geometry_blueprint_v1`. The blueprint is a
server-owned visual derivative, not source geometry and not model output. It
contains only:

- the semantic recipe selected from the sentence grammar;
- exact graph, proposition, and primitive-parameter hash bindings;
- bounded topology controls such as node count, emphasis, orientation,
  density, and explicit provenance;
- a complexity cost and canonical content hash.

The deterministic geometry compiler turns that blueprint into
`dark_curiosity_bounded_geometry_program_v1`: a flat, deeply frozen graph of
allowlisted circle/square/diamond nodes and line/curve/dwell connections in
integer `normalized_1000` coordinates. Node, edge, and complexity budgets are
enforced before hashing. The compiler rejects accessors, sparse arrays,
symbols, duplicate illustrative points, non-finite or fractional coordinates,
negative zero,
self/dangling/duplicate edges, disconnected geometry, unknown roles or tones,
and fresh-hash context substitutions. It uses SHA-256 bytes and integer layout
rules only; there is no `Math.random`, wall clock, dynamic module loading, or
locale-dependent ordering.

Approved storyboard routes retain the exact approved waypoint order and are
marked `approved_storyboard_layout`. Repeated approved waypoints remain
distinct ordered nodes and compile to a bounded `dwell` ring instead of being
dropped or converted into an unvalidated zero-length line. A route whose
distinct inputs all collapse to one projected point is rejected. Every other
topology is explicitly marked `deterministic_illustrative`, so procedural
relationships cannot masquerade as factual map coordinates. The renderer
re-normalizes the blueprint, recompiles the program, and constructs fixed SVG
tags and classes itself. Neither artifact can carry raw SVG path data, HTML,
executable code, text, colors, CSS, styles, transforms, URLs, remote resources,
or new visible copy.

The bounded layer renders inside the existing primary module, after the legacy
grammar primitive. This preserves route, counter, vessel, and scene-action
runtime hooks while adding source-conditioned visual topology. Edges draw
through the existing deterministic path runtime; nodes reveal in canonical
order from semantic progress and settle without timers or incremental state.
The layer does not add a fourth composition module or a new Scene DSL target.

The generalized graph marker and sentence-plan composition-profile marker must
appear together. Every sentence in that profile must contain both primitive
parameters and a composition; fixed unparameterized plans must contain neither.
Validation deterministically rebuilds the expected composition for every
proposition and rejects partial profiles, reordered modules, unsupported
topologies, blueprint swaps, cross-sentence substitutions, or freshly rehashed
tampering. The existing Scene DSL composition hash automatically binds the
blueprint, so the model-facing proposal schema remains enum-only and unchanged.

Checked unparameterized profiles never enter the composition-v2 path and emit
no blueprint markup, CSS, runtime, or data attributes. Their pinned graph,
sentence-plan, AnimationIR, and HTML composition hashes remain byte-exact.

Internal graph/plan consistency is not treated as provenance. Parameterized
generalized IR requires trusted source validation: compilation and in-process
composition rebuild the graph against the approved draft and timing context,
then the controlled render worker receives the normalized approved draft and
timing context through a separate mode-`0600` staging file rather than the
mutable render-request payload. The provider passes the expected AnimationIR,
draft, and timing-context hashes out of band. The worker derives its staging
root from the request-file path inside a provider-created mode-`0700`, uniquely
named per-render directory. It accepts one exact argument grammar, requires
fixed input paths, bounds all input sizes, uses no-follow file handles, and
checks every expected hash before independently rebuilding and validating the
graph. Private IR, request, source-context, and composition files are removed
after use. Successful output verification also requires the exact in-memory
receipt issued by the same provider instance, so a fabricated or copied
manifest is not a trust credential. A standalone contract or renderer call
without the approved source context fails closed; a caller-supplied graph hash
is never a trust credential. Consequently, changing source text, substituting
another staged IR, or merely recomputing every public content hash is not
sufficient to render.

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
story-specific intent and grammar sequences, grounded visible labels and
quantities, approved route geometry variance, real end-to-end renderer
dispatch, leading silence, renderer line budgets, semantic negation and
movement, same-vocabulary semantic variation, registry preservation, renderer
contract parity, multiword quantity spans, cue-specific detail, semantic tick
counts, transition-target quantity ranking with distractors, qualitative cycle
fallbacks, grounded absence environments, long-token fitting, exact
nine-grammar coverage, asset-specific cause/effect motifs,
affirmed-versus-rejected result marks, XML escaping, whole-profile downgrade
rejection, provider-owned receipts, symlink isolation, worker source-context
tampering, and fresh-hash adversarial contract failures.

Run it with:

```sh
node --test tests/dark-curiosity-generalized-visual-intent-planner.test.cjs
```

## Current implementation boundary

Generalized shorts now render story-grounded labels, quantities, state values,
approved route layouts, deterministic geometry variants, and constrained
three-module scene compositions. This adds structural variation without
executing generated animation code or allowing arbitrary renderer geometry.

Registry-backed GPS and Baychimo profiles intentionally omit primitive
parameters, the composition-profile marker, and per-sentence compositions.
Their checked graph, sentence-plan, production-plan, AnimationIR, and rendered
composition hashes remain byte-exact.
