# Dark Curiosity local LLM scene planner

## Status

The first three safe implementation slices for generating different animation
choreography per semantic sentence are complete. They provide:

- a strict, hashed Animation Scene DSL v1;
- a deterministic planner that works without a GPU;
- a deterministic test-only mock;
- an opt-in, loopback-only OpenAI-compatible adapter for a local Ollama or
  llama.cpp server;
- validation and deterministic fallback for unavailable, timed-out, malformed
  or unsafe model output;
- one immutable aggregate Scene DSL Plan covering every parameterized narration
  sentence in exact order;
- per-scene provider/fallback provenance and aggregate cost accounting;
- synchronous compiler and AnimationIR binding for generalized semantic-v3
  stories;
- a deterministic renderer-owned action schedule with distinct
  `entry`/`develop`/`resolve` frame windows and a settled readability hold;
- visible HyperFrames execution for every DSL v1 operation;
- real Chromium pixel proofs for action-plan divergence, random-access
  determinism, approved-route motion and mobile legibility.

The local LLM is not called from the production animation compiler. The compiler
is intentionally synchronous and deterministic. When no preplanned aggregate is
supplied, it builds the same deterministic fallback plan at every hash boundary.
Checked, unparameterized GPS and Baychimo profiles omit the aggregate and retain
their existing byte-exact output.

## Trust boundary

The model does not author renderer code or visible content. It receives no raw
narration, claims, subject text or detail text. It can select at most four
allowlisted actions over these server-owned targets:

- `module_primary`
- `module_support_a`
- `module_support_b`
- `scene`

The bounded prompt contains only validated semantic enums, module kinds, layout
intent and a server-derived 32-bit variation seed. The seed makes unrelated
sentences produce distinct prompts without exposing narration or source IDs.

The output cannot contain text, SVG, HTML, CSS, JavaScript, paths, coordinates,
colors, URLs, asset references, timing values, invented identifiers, story or
entity IDs, or hashes. It may only copy the fixed enum values and module targets
from the supplied action allowlist. The server adds the three mandatory reveal
actions and computes:

- semantic event graph binding;
- semantic visual sentence plan binding;
- proposition binding;
- primitive-parameter hash;
- scene-composition hash;
- bounded scene cost;
- canonical content hash.

The resulting DSL is immutable and must revalidate against the trusted semantic
sentence. Recomputing a content hash is not enough to move a DSL to another
story or proposition.

## Data flow

```text
trusted semantic graph + sentence plan
                |
                v
     enum-only bounded prompt
                |
       +--------+---------+
       |                  |
 disabled/mock       local loopback LLM
       |                  |
       +--------+---------+
                |
       strict JSON proposal
                |
                v
     proposal validator + budget
                |
                v
 server-owned bindings/actions/hash
                |
                v
   immutable Animation Scene DSL v1
                |
                v
 full-coverage Scene DSL Plan + provenance
                |
                v
 synchronous compiler revalidation + hash binding
                |
                v
 renderer-owned phase schedule + bounded frame state
                |
                v
     HyperFrames SVG action execution
```

## Configuration

The safe default is `disabled`. It makes no network calls and returns the
deterministic fallback DSL.

```dotenv
SHORTSENGINE_LOCAL_LLM_SCENE_PLANNER_MODE=disabled
SHORTSENGINE_LOCAL_LLM_ENDPOINT=http://127.0.0.1:11434/v1/chat/completions
SHORTSENGINE_LOCAL_LLM_MODEL=local-scene-planner
SHORTSENGINE_LOCAL_LLM_TIMEOUT_MS=120000
SHORTSENGINE_LOCAL_LLM_RESPONSE_MAX_BYTES=65536
SHORTSENGINE_LOCAL_LLM_MAX_TOKENS=512
```

Supported modes:

| Mode | Network | Intended use |
| --- | --- | --- |
| `disabled` | none | default deterministic fallback |
| `mock` | none | deterministic provider-path tests |
| `openai_compatible` | loopback HTTP only | local Ollama/llama.cpp inference |

No API key is read or sent. Even if `OPENAI_API_KEY` exists in the process
environment, this adapter ignores it and never adds authorization, cookie or
credential headers.

The endpoint parser accepts only these literal forms:

```text
http://127.0.0.1:<port>/v1/chat/completions
http://[::1]:<port>/v1/chat/completions
```

It rejects `localhost`, DNS names, private/LAN hosts, metadata addresses,
credentials, query strings, fragments, alternate paths, redirects and
numeric/hex/octal loopback aliases.

## Provider API

```js
const {
  createLocalLlmScenePlanner,
} = require(
  "./server/pipelines/narrated-short/animation/providers/local-llm-scene-planner.cjs"
);

const planner = createLocalLlmScenePlanner({ env: process.env });
const result = await planner.planScene({
  semanticEventGraph,
  semanticVisualSentencePlan,
  propositionId,
  signal,
});
```

`result.sceneDsl` is always a validated deterministic artifact. For live
provider failures, `fallbackUsed` is true and `failure` contains only an
allowlisted code, phase and retryability flag. Raw prompts, model output,
response bodies, endpoint URLs and provider errors are not returned.

Trusted graph/plan errors and caller cancellation do not fall back. They fail
closed.

## Aggregate planning API

```js
const {
  buildSemanticAnimationSceneDslPlan,
} = require(
  "./server/pipelines/narrated-short/animation/semantic-animation-scene-plan-service.cjs"
);

const sceneDslPlan = await buildSemanticAnimationSceneDslPlan({
  semanticEventGraph,
  semanticVisualSentencePlan,
  planner,
  signal,
});
```

The service validates the complete graph and sentence plan before the first
provider call, plans sentences sequentially for safe local-GPU usage, and
returns nothing partial after cancellation or failure. The aggregate stores no
prompt, raw response, narration text, endpoint, credential, latency or
timestamp.

Generalized semantic-v3 compilation requires exactly one context-valid Scene DSL
for every parameterized sentence. Checked unparameterized semantic profiles
forbid the aggregate. The aggregate hash is nested in the production animation
plan and AnimationIR, so the existing persisted `animation_plan` and
`animation_ir` artifacts bind the complete plan and its provenance without
adding an unreferenced standalone artifact.

## Renderer execution

The renderer validates the embedded aggregate again before reading any action.
It serializes only the allowlisted action schedule and its hashes into the
composition; planner IDs, model IDs, prompts, fallback diagnostics and provider
output never enter browser runtime data.

Each sentence receives three contiguous, non-overlapping phase windows.
Renderer-owned timing reserves at least 12% of one second per phase when the
sentence duration permits, uses fixed 3:4:3 entry/develop/resolve weighting,
borrows at most 350 ms of an available narration gap, and preserves at least
200 ms of settled hold when that gap exists. The schedule is derived from
validated narration timing and is not model-authored. A one- or two-frame cue
uses an explicit deterministic overlap schedule instead of failing; a short
`pulse_once` still reaches one visible peak and settles on the next frame.

The fixed action mappings are:

- `create/reveal`: staggered opacity, vertical settle and scale-in for the
  primary and two support modules;
- `move/follow_grounded_route`: deterministic piecewise traversal of approved
  normalized route points, projected into a bounded primary-module displacement
  when the scene has no route marker;
- `transform/semantic_transition`: bounded primary scale, lift and emphasis,
  with the same action progress driving the actual counter/vessel state swap;
- `highlight/pulse_once`: one smooth scale/glow envelope that returns to
  identity;
- `camera/push_primary|pull_overview`: bounded zoom on the geometry-only camera
  channel, never on narration copy or captions.

Map primitives without a DSL `move` retain their grammar-owned base traversal,
but now measure progress on the actual rendered SVG route instead of a
synthetic diagonal. Approved `move` actions use the validated route schedule.
Every frame state is recomputed from the requested frame. There is no wall
clock, incremental transform accumulation, random number or CSS animation.
Seeking N, then M, then N therefore reproduces the same pixels.

Support values are wrapped or excerpted without `spacingAndGlyphs`
compression. Their 26/28 px source sizes and 24 px effective floor are checked
after camera and module transforms in the real-browser mobile audit.

Checked unparameterized profiles do not emit the schedule, action CSS, runtime
or trace attributes. Their pinned HTML composition hashes remain byte-exact.

## Current limitation and next slice

DSL v1 now visibly choreographs the existing three grounded modules, but it
still does not create new geometry. The asynchronous live planner is also not
yet a render-enqueue job; production compilation currently uses the
network-free deterministic aggregate. The next implementation slice should:

1. add a dedicated preplanning job that persists a live local-LLM aggregate
   before render enqueue and passes only its trusted artifact reference/hash;
2. extend production browser QA sampling from sentence midpoints to explicit
   action-phase checkpoints and require coverage of every selected action
   signature;
3. keep deterministic fallback as the no-GPU and provider-failure path;
4. add a bounded primitive factory for genuinely new, source-grounded geometry.

The local browser proof already compares actual pixel hashes for two valid
plans over the same story, rejects any visible marker more than 0.75 px from
its actual SVG path, verifies approved Baychimo route traversal, and checks
that non-map grounded routes move the primary module. Production action-phase
coverage is the remaining gate before the live preplanning job becomes the
default upstream path.
