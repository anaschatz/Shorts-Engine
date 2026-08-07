# ShortsEngine implementation prompt — live bounded local-LLM composition and third-story proof

## Objective

Extend the feature-gated Generalized Visual Program v2 proof so a real local
LLM chooses story-specific semantic composition while the engine continues to
own style, copy, geometry, timing, assets, rendering, and quality gates.

The mandatory unseen story is the checked-in Baychimo historical
reconstruction. Render it through exactly the same v2 compiler, locked art
direction, primitive registry, runtime, and compositor used by the GPS and
odometer proofs. Do not add a Baychimo renderer or a complete Baychimo scene
template.

This remains a standalone, non-publishable proof. Do not connect Visual Program
v2 to production preplan jobs, active project pointers, publish routes, or the
default animation dispatch in this slice.

## Truthful completion standard

A successful live proof requires all of the following:

- provider ID `local_openai_compatible`;
- model ID `qwen3:4b-instruct`;
- loopback OpenAI-compatible endpoint only;
- `fallbackUsed: false`;
- no mock or deterministic fallback counted as creative evidence;
- normalized model choice, prompt/profile/configuration hashes, attempt count,
  and bounded provenance persisted;
- no raw prompt, raw model response, narration, source URLs, local absolute
  paths, or provider internals in the public comparison report;
- output remains `publishable: false`, `humanReviewStatus: pending`, and
  `humanPerceptual: pending`.

If no live local model is available, implement and test the boundary but fail
the live render clearly. Never silently substitute a deterministic proposal and
claim an LLM result.

## Trusted third-story inputs

Use these exact local inputs:

- approved draft:
  `eval/narrated/dark-curiosity/fixtures/003_baychimo_icebound_drift.json`;
- verified exact-sequence word timing:
  `eval/narrated/dark-curiosity/semantic-events/timing/003_baychimo_icebound_drift.timing.json`;
- checked semantic-event manifest:
  `eval/narrated/dark-curiosity/semantic-events/003_baychimo_icebound_drift.json`;
- rights-confirmed local audio carrier:
  `manual-downloads/dark-curiosity-pilots-a940ca6/baychimo-icebound-drift-final.mp4`;
- source evidence report:
  `manual-downloads/dark-curiosity-pilots-a940ca6/baychimo-icebound-drift-report.json`;
- existing checked caption manifest, ASS, and VTT from the Baychimo human-quality
  batch.

The proof clock is 1068 frames at 30 fps with 89 ordered words. Validate the
fixture, timing, alignment, semantic graph, source report, source MP4, captions,
and every expected hash before rendering.

Describe this evidence accurately as verified exact-sequence ASR word timing,
hash-bound to the approved draft and audio. It is not a new phoneme-level
forced-alignment run.

Build the trusted SemanticEventGraph through the existing checked profile and
`buildSemanticEventGraph`; do not retype its 13 entities or 15 propositions as
a new story-specific v2 graph.

## Narrow model output

The model must return exactly one JSON object with this shape:

```json
{
  "schemaVersion": 1,
  "scenes": [
    {
      "rangeCandidateIndex": 12,
      "layoutIntent": "layered_stack"
    }
  ]
}
```

No other fields are allowed.

Before the provider call, the engine must derive a bounded catalogue of complete
story partitions. Each catalogue path is an ordered array of
`rangeCandidateIndex` values. A range candidate already binds a valid
proposition range, the derived participant set, and a grounded dominant focus.
The catalogue must be deterministic, contain no more than eight paths, and be
ranked toward three to seven coherent scenes without forcing a story template.

The provider-facing strict JSON Schema must use one `oneOf` branch per complete
catalogue path and exact `prefixItems` for every position. This constrains the
model to selecting one valid complete partition while leaving the layout intent
free within the allowlist. Do not use unsupported JSON Schema features in the
Ollama boundary; exact length is enforced by matching `minItems` and `maxItems`
and then revalidated by the server.

The server must validate and materialize:

- the selected candidate-index sequence is exactly one engine-derived complete
  catalogue path;
- an exact, ordered, contiguous partition from proposition index zero through
  the final proposition, with no overlap, gap, empty range, duplicate boundary,
  or out-of-range index;
- no more than four propositions per scene and no more than ten derived
  participants;
- only the six allowlisted v2 layout intents;
- the candidate's engine-selected focus is a scene participant, grounded by a
  selected proposition, and dominant across the range;
- the final materialized proposal passes the existing strict
  `normalizeVisualProgramProposalV2` contract.

The server derives all scene IDs, proposition IDs, entity IDs, bindings, style
ID, content hash, geometry, frame spans, tracks, labels, and visible copy.

## Prompt projection

The local model may receive only a bounded indexed semantic projection:

- entity index, kind, visual-subject kind, and persistence;
- proposition index, beat ordinal, event kind, predicate, polarity, certainty,
  subject entity index, object entity indexes, focus entity indexes,
  participant entity indexes, and a coarse duration bucket;
- only the range-candidate descriptors referenced by the bounded complete-path
  catalogue;
- the indexed complete-partition catalogue itself;
- allowlisted layout intents;
- scene/entity/motion budgets;
- bounded rejection reason codes on a retry.

Do not send labels, title, narration text, IDs, hashes, source references,
frames, assets, coordinates, paths, CSS, SVG, HTML, JavaScript, URLs, or color
tokens to the model. Do not accept any of those in its response.

Use prompt profile
`generalized_visual_program_v2_local_composer_prompt_v1`, configuration revision
`exact_top_level_schemaVersion_scenes_v8_ollama_projected_catalog_8`, temperature
zero, a bounded request and response size, and at most 1024 output tokens.

## Local provider boundary

Reuse the security behavior of the existing local scene planner:

- mode is `disabled`, `mock`, or `openai_compatible`;
- live endpoints must exactly match an HTTP IPv4 or IPv6 loopback
  `/v1/chat/completions` URL;
- credentials, query strings, fragments, redirects, remote hosts, and alternate
  paths are rejected;
- request body and response stream are byte-bounded;
- response content type must be JSON;
- timeout and external cancellation use `AbortController`;
- unsafe JSON, extra fields, accessors, proxies, sparse arrays, aliases,
  executable strings, and unsupported enum values fail closed;
- transport failures open the circuit for this proof and are not repeatedly
  hammered;
- structural or quality rejection may be retried, with at most three total
  attempts and reason-code-only feedback.

The provider adapter returns a frozen validated result containing only provider
ID, model ID, prompt profile ID, fallback flag, bounded failure metadata or
null, the normalized planner choice, and the normalized provider-selection
hash.

The planner service returns a separate deep-frozen accepted result containing:

- the normalized planner choice;
- the engine-materialized Visual Program v2 proposal;
- the compiled visual program;
- semantic and repetition gate reports;
- bounded provenance with planner ID, mode, provider ID, model ID, prompt
  profile ID, planner configuration hash, provider-selection hash, normalized
  choice hash, prompt-projection hash, attempt count, fallback flag, and bounded
  failure metadata or null.

The proof runner must persist the normalized choice as `planner-choice.json`.
Its engine-computed `contentHash` must equal the service provenance
`choiceHash` before the artifact is written.

Discard raw provider output after validation.

## Provenance and compiler trust

Add a server-owned compiler input `proposalSource: "operator" | "local_llm"`.
The model cannot set it.

- Existing operator proofs retain their current trust disclosure and hashes.
- A live model proposal compiles with
  `local_llm_generated_nonproduction` disclosure.
- Unknown or forged trust/disclosure combinations fail validation.

Both paths remain non-production and non-publishable.

## Generic primitive coverage

Before rendering Baychimo, add low-level engine-owned representations for:

- steamship/vessel;
- ice field or pack ice;
- blizzard/weather front;
- observer or crew group;
- hypothesis/assumption;
- archival record;
- unknown outcome/evidence boundary.

Also add one reusable compound `wheel_bank` representation and a bounded
`propagate_carry` state operation so the odometer mechanism is expressed as one
connected digit mechanism rather than six unrelated nodes.

These are reusable primitives selected from trusted entity kinds. They must not
contain Baychimo strings, story IDs, narration, source-specific coordinates, or
complete scene trees.

Do not map `vessel` to the car primitive. Unknown and hypothesis states must be
visually distinct from an ordinary generic box. Negated and qualified
relations must remain visually distinguishable.

Keep one dominant focus, resolve collisions, preserve the title and caption
lanes, and offset parallel edges so repeated endpoints do not draw directly on
top of one another.

## Engine-owned semantic-state motion

Do not reduce every grounded proposition to a generic arrow plus focus pulse.
Add a bounded engine-owned semantic-state vocabulary derived only from trusted
`semanticOperation`, predicate, polarity, certainty, and state-before/state-after
data. The LLM cannot author the vocabulary, motion parameters, geometry, or
timing.

The initial generic operations must cover:

- `occlude_to_absent`: preserve an empty/ghosted last-known position instead of
  simply deleting identity;
- `supersede_hypothesis`: dim and strike the earlier assumption while revealing
  the grounded observation;
- `co_move`: translate a carrier and carried entity together along an
  engine-owned short path;
- `mark_last_known`: stamp or bound the latest documented point on a timeline;
- `reject_hypothesis`: visibly negate a qualified/rejected interpretation;
- `unresolved_boundary`: settle on a dashed open boundary or question state.

Compile these operations into target-specific, frame-addressable tracks bound
to the exact proposition cue spans. Enforce the existing simultaneous-motion
budget and settled hold. Add runtime tests for random seek, final state,
crossfade interaction, and persistent-entity continuity.

## Baychimo semantic expectations

The model is free to choose valid scene boundaries and topologies; do not force
the following as a hidden template. The compiled result must nevertheless make
these grounded meanings visible:

1. 1931, crew and blizzard context, followed by the empty last-seen ice
   position;
2. the sinking assumption replaced by a documented hunter sighting near the
   coast;
3. later sightings and boarding of the same persistent vessel;
4. the vessel without a crew moving with pack ice;
5. the archive span to the 1969 record;
6. documented drift, rejection of the supernatural interpretation, and a
   bounded unknown final fate.

Do not show disappearance by contradictorily drawing the ship as present in an
"empty position" state. Use an engine-owned absence/occlusion treatment while
preserving semantic identity for later scenes.

## Three-story comparison

Fix the current two-story-only comparison logic. For any N >= 2 stories:

- compare every pair of stories;
- enumerate exact and near fingerprint overlap per pair;
- require one shared style hash;
- require distinct program and composition hashes;
- run the existing semantic, motion, and 6x8 occupancy repetition descriptors
  across the entire corpus;
- fail closed if any pair overlaps or any program fails its gates.

Run GPS, odometer, and Baychimo through this comparison. GPS and odometer may
retain their checked semantic/audio inputs, but all three final proof programs
must come from successful live local-LLM choices with no fallback. This proves
that the same planner boundary, compiler, style, primitive registry, runtime,
and compositor can produce materially different compositions.

## Blinded review pack

Create a separate story-level v2 review pack for the three full MP4s. Reuse the
security patterns of the Step 6 human-calibration system, but do not force full
videos into the old recipe-scene contract.

Requirements:

- randomized anonymous item IDs and order;
- same-origin hashed MP4 copies only;
- loopback-only server and strict CSP with `media-src 'self'`;
- no internal story ID, graph, proposal, planner, provider, source filename,
  program/composition/style/report hash, or expected answer in the public
  assignment; the story subject itself may remain visible in burned-in titles
  and comprehension questions;
- one normal-speed playback before answers become available;
- bounded multiple-choice comprehension and uncertainty questions;
- bounded 1–5 scores for narration correspondence, focal clarity, pacing,
  visual variety, helpfulness, and polish;
- bounded issue codes including abrupt cuts, motion/narration mismatch, and
  unclear ending;
- create-only responses and explicit finalization;
- at least five distinct, complete, confirmed reviewer sessions, operationally
  performed by independent people, before any human gate can pass;
- mock responses never count as human evidence.

The automated run may create and browser-verify the pack. It must not fabricate
review responses, finalize a passing human result, or claim that comprehension,
pacing, polish, or originality passed.

## Required tests

Add focused tests for:

- exact indexed-choice schema and data-only boundary;
- deterministic complete-partition catalogue generation, eight-path bound,
  provider projection pruning, and non-catalogue rejection;
- strict per-path JSON Schema generation with exact candidate indexes and
  scene count;
- hostile inputs, aliases, sparse arrays, accessors, extra fields, code, URLs,
  coordinates, text, hashes, IDs, and frames;
- exact proposition partition, participant derivation, and grounded focus;
- loopback endpoint enforcement, redirect rejection, response byte limits,
  timeout, cancellation, bad JSON, wrong content type, and fallback marking;
- live provenance disclosure versus operator disclosure;
- at-most-three attempts and reason-code-only retry feedback;
- generic Baychimo primitive selection with no story switch;
- verified Baychimo draft/timing/semantic/audio/caption bindings;
- arbitrary-N pairwise comparison and regression for the previous N=3 bug;
- review-pack blinding, create-only behavior, CSP, video MIME, normal-speed
  completion gate, mock exclusion, and pending human status;
- deterministic replay from a persisted normalized model choice.

Keep all existing v1 and v2 compatibility tests passing.

## Mandatory run and evidence

Run a real installed local model through Ollama using the exact loopback
endpoint. Render Baychimo at 1080x1920, 30 fps, with frame-exact audio,
captions, persistent title, contact sheet, semantic trace, planner provenance,
sampled-frame hashes, technical QA, and no-remote-request evidence.

Then run the three-story corpus comparison and generate/browser-check the
blinded review pack.

The final report must state:

- whether the live model was actually used;
- model/provider/prompt profile/configuration hash and attempt count;
- normalized choice and proposal hashes, without raw prompt/response;
- exact alignment and source-rights status;
- style/program/composition/fingerprint comparison results;
- all automated test and render gates;
- agent visual observations separately from human evidence;
- `humanReviewStatus: pending`, `humanApproved: false`,
  `productionReady: false`, and `publishable: false`.

Do not claim reference-level creative quality or production readiness from
automated evidence alone.
