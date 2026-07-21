# Dark Curiosity local LLM scene planner

## Status

The persisted production preplanning path for generating different animation
choreography per semantic sentence is implemented. It provides:

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
- a dedicated `plan_narrated_animation` job, exposed through
  `POST /api/narrated-projects/:projectId/animation-plan`;
- an immutable `animation_scene_dsl_plan` artifact whose exact draft,
  alignment, timing, semantic-plan and planner-configuration dependencies are
  checked before reuse;
- an active project pointer plus an exact artifact ID/hash handoff into render
  enqueue and the render worker;
- synchronous compiler and AnimationIR binding for generalized semantic-v3
  stories;
- a deterministic renderer-owned action schedule with distinct
  `entry`/`develop`/`resolve` frame windows and a settled readability hold;
- visible HyperFrames execution for every DSL v1 operation;
- real Chromium pixel proofs for action-plan divergence, random-access
  determinism, approved-route motion, action-signature coverage, settled holds
  and mobile legibility.

The local LLM is not called from the production animation compiler. The compiler
is intentionally synchronous and deterministic. A generalized semantic-v3
render must first complete preplanning, even in `disabled` mode; disabled mode
persists the deterministic fallback aggregate without making a network call.
Checked, unparameterized GPS and Baychimo profiles do not require or accept a
Scene DSL Plan and retain their existing byte-exact output.

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
 persisted animation_scene_dsl_plan artifact
                |
                v
 active project pointer (artifact ID + hash)
                |
                v
 render enqueue/worker reload + exact validation
                |
                v
 synchronous compiler revalidation + hash binding
                |
                v
 renderer-owned phase schedule + bounded frame state
                |
                v
     HyperFrames SVG action execution
                |
                v
 action signatures + phase/settled-hold browser QA
```

## Configuration

The safe default is `disabled`. It makes no network calls and returns the
deterministic fallback DSL.

```dotenv
SHORTSENGINE_LOCAL_LLM_SCENE_PLANNER_MODE=disabled
SHORTSENGINE_LOCAL_LLM_ENDPOINT=http://127.0.0.1:11434/v1/chat/completions
SHORTSENGINE_LOCAL_LLM_MODEL=local-scene-planner
SHORTSENGINE_LOCAL_LLM_TIMEOUT_MS=120000
SHORTSENGINE_LOCAL_LLM_AGGREGATE_TIMEOUT_MS=300000
SHORTSENGINE_LOCAL_LLM_RESPONSE_MAX_BYTES=65536
SHORTSENGINE_LOCAL_LLM_MAX_TOKENS=512
```

Supported modes:

| Mode | Network | Intended use |
| --- | --- | --- |
| `disabled` | none | persisted deterministic fallback; safe default |
| `mock` | none | deterministic provider-path tests only; rejected in production |
| `openai_compatible` | loopback HTTP only | local Ollama/llama.cpp inference with bounded fallback |

For generalized semantic-v3 stories, all three modes use the same persisted
preplan boundary. `disabled` does not bypass the job or inject an inline plan;
it makes the job produce the deterministic fallback artifact. `mock` is a test
mode and is rejected by the production API, preplan worker and render worker.
`openai_compatible` calls the configured loopback endpoint sequentially, one
scene at a time. Recoverable provider failures fall back deterministically.

`SHORTSENGINE_LOCAL_LLM_TIMEOUT_MS` bounds one provider request.
`SHORTSENGINE_LOCAL_LLM_AGGREGATE_TIMEOUT_MS` bounds the complete multi-scene
operation to `1000..600000` ms. When the aggregate deadline expires, the active
request is aborted and the current and remaining scenes are completed with the
deterministic fallback. Caller cancellation still fails the job rather than
being converted into fallback.

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
forbid the aggregate.

## Production preplan and artifact handoff

The production sequence is:

1. The narrated project must have an approved draft and an exact aligned
   narration for the active project revision.
2. `POST /api/narrated-projects/:projectId/animation-plan` creates the
   server-owned `plan_narrated_animation` operation. The request accepts only
   the supported animation profile; draft, alignment and planner identities are
   derived by the server.
3. The worker rebuilds the trusted timing context, semantic event graph and
   semantic visual sentence plan. It plans scenes sequentially, validates the
   complete aggregate, and performs a synchronous compiler check before
   persistence.
4. The worker writes one content-addressed `animation_scene_dsl_plan` artifact.
   Its dependency set must exactly match the approved draft hash, alignment
   hash, timing-context hash, semantic-event-graph hash, semantic-sentence-plan
   hash and current planner-configuration hash.
5. The project stores an active pointer containing the artifact ID/hash and the
   same source and planner bindings. The worker first rechecks the asynchronous
   planning inputs, captures an immutable full-project snapshot, and then uses
   project compare-and-swap to install the pointer. SQLite performs one
   conditional full-row `UPDATE`; local JSON persistence holds an exclusive
   per-project lock while it rereads, compares and atomically replaces the
   project envelope. A changed revision, narration, status or active plan makes
   the install fail stale instead of overwriting newer state.
6. Render enqueue recomputes the current planner configuration and resolves the
   active pointer. The render job payload carries only the trusted scene-plan
   artifact ID/hash, in addition to the existing animation bindings.
7. The render worker reloads and revalidates the pointer, artifact envelope,
   exact dependencies, body hash, semantic context and current planner
   configuration. The compiler then binds the aggregate hash into the
   production animation plan and AnimationIR. The render service also requires
   the plan object and artifact ID/hash as an all-or-none set.

A completed preplan can be reused only while all source and planner bindings
remain exact. Uploading or realigning narration, revising the story, or changing
the planner configuration invalidates the active binding and requires a new
preplan. No endpoint URL, model response, prompt, credential, API key or raw
provider error enters the render job payload or browser composition.

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

## Production browser QA

Generalized semantic-v3 composition emits a renderer-owned QA plan. The
production seek sequence retains a checkpoint for every unique selected action
signature, bounded entry/develop/resolve phase samples, and a settled-hold frame
for every scene that has a hold. Browser validation requires every expected
signature to be observed and requires settled-hold checkpoints to have no
active action. It also retains random-access repeat frames, mobile typography,
caption-safe-zone, clipping, route/path and primary-ROI checks.

The proof budget is bounded to 52 unique frames plus three deterministic repeat
captures, below the browser harness limit of 60. Production rendering fails
closed when mandatory action or hold proof cannot fit the budget or any browser
or motion gate fails.

## Remaining limitations

DSL v1 choreographs the existing three grounded modules. It still cannot create
new source-grounded geometry, new primitive types or model-authored renderer
code. A future bounded primitive factory is required for genuinely new visual
structures; it must preserve the same allowlist, source-binding and browser-QA
boundaries.

The active-plan install now uses a full-snapshot project compare-and-swap. A
failed install can leave a content-addressed scene-plan artifact for normal
orphan cleanup, but it cannot make that artifact active or renderable.

This CAS covers the project record only. The approval record and artifact write
are separate resources, so they are not one multi-record transaction. The
worker still rechecks approval before compiling, and render-time binding
validation remains mandatory. A future database-backed approval transaction is
required if approval mutation and active-plan installation must commit as one
unit.

Local JSON locking is intentionally fail-fast and does not make the local
adapter generally transactional or crash-durable. A process crash can leave a
`.lock` file. Live contention surfaces as retryable `PROJECT_STATE_LOCKED`;
stop all local workers before an operator removes an orphan lock. Use SQLite for
unattended or multi-process execution.
