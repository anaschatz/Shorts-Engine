# Dark Curiosity local LLM scene planner

## Status

This is the first safe implementation slice for generating different animation
choreography per semantic sentence. It provides:

- a strict, hashed Animation Scene DSL v1;
- a deterministic planner that works without a GPU;
- a deterministic test-only mock;
- an opt-in, loopback-only OpenAI-compatible adapter for a local Ollama or
  llama.cpp server;
- validation and deterministic fallback for unavailable, timed-out, malformed
  or unsafe model output.

The local LLM is not called from the production animation compiler. The compiler
is intentionally synchronous and deterministic. A later artifact-binding slice
will run this planner upstream, persist the validated DSL with its bindings, and
then let the compiler consume only that canonical artifact.

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

## Current limitation and next slice

DSL v1 choreographs the existing three grounded modules; it does not yet create
new geometry. The next implementation step is an upstream Scene DSL artifact
service that:

1. plans every sentence before render enqueue;
2. persists canonical DSL artifacts and planner provenance;
3. binds their aggregate hash into the animation request;
4. makes the synchronous compiler revalidate and consume them;
5. adds renderer-owned motion windows for the allowlisted actions.

Only after that binding is complete should a bounded primitive factory be added
for genuinely new geometry.
