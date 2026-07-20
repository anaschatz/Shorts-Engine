# Dark Curiosity local LLM scene planner

## Status

The first two safe implementation slices for generating different animation
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
  stories.

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

## Current limitation and next slice

DSL v1 choreographs the existing three grounded modules; it does not yet create
new geometry. The asynchronous live planner is also not yet a render-enqueue
job; production compilation currently uses the network-free deterministic
aggregate. The next implementation slice should:

1. make HyperFrames execute the allowlisted entry/develop/resolve presets using
   renderer-owned timing windows and coordinates;
2. add a dedicated preplanning job that persists a live local-LLM aggregate
   before render enqueue and passes only its trusted artifact reference/hash;
3. keep deterministic fallback as the no-GPU and provider-failure path;
4. add visual QA assertions proving that each selected action visibly occurs
   inside its narration sentence.

Only after renderer action execution and preplanning artifact binding are
complete should a bounded primitive factory be added for genuinely new
geometry.
