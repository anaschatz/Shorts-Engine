"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const {
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  buildGeneralizedSemanticArtifacts,
} = require("../server/pipelines/narrated-short/animation/generalized-semantic-event-planner.cjs");
const {
  buildSemanticVisualSentencePlan,
} = require("../server/pipelines/narrated-short/animation/semantic-visual-sentence-planner.cjs");
const {
  createLocalLlmScenePlanner,
  normalizeLoopbackEndpoint,
  readBoundedResponseText,
} = require("../server/pipelines/narrated-short/animation/providers/local-llm-scene-planner.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");

const ROOT = resolve(__dirname, "..");

function timingFor(draft) {
  let frame = 0;
  let wordIndex = 0;
  const words = [];
  const beats = [];
  for (const beat of draft.script.beats) {
    const wordStartIndex = wordIndex;
    for (const wordText of beat.spokenText.split(/\s+/).filter(Boolean)) {
      words.push({
        index: wordIndex,
        text: wordText,
        startFrame: frame,
        endFrame: frame + 6,
      });
      wordIndex += 1;
      frame += 8;
    }
    beats.push({
      beatId: beat.id,
      wordStartIndex,
      wordEndIndex: wordIndex,
      startFrame: words[wordStartIndex].startFrame,
      endFrame: words[wordIndex - 1].endFrame,
    });
    frame += 16;
  }
  return normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: 30,
    durationFrames: frame + 30,
    alignmentHash: createHash("sha256")
      .update(`local-llm:${draft.contentHash}`)
      .digest("hex"),
    draftHash: draft.contentHash,
    words,
    beats,
  });
}

function fixture(id = "001_wow_signal_mystery") {
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "fixtures",
    `${id}.json`,
  ), "utf8")));
  const timingContext = timingFor(draft);
  const semantic = buildGeneralizedSemanticArtifacts({ draft, timingContext });
  const plan = buildSemanticVisualSentencePlan(semantic.semanticEventGraph);
  return {
    semanticEventGraph: semantic.semanticEventGraph,
    semanticVisualSentencePlan: plan,
    propositionId: plan.sentences[0].propositionId,
  };
}

function proposal() {
  return {
    schemaVersion: 1,
    actions: [
      {
        op: "highlight",
        target: "module_support_a",
        phase: "develop",
        preset: "pulse_once",
      },
      {
        op: "transform",
        target: "module_primary",
        phase: "resolve",
        preset: "semantic_transition",
      },
    ],
  };
}

function providerPayload(value = proposal()) {
  return {
    choices: [{
      message: {
        content: typeof value === "string" ? value : JSON.stringify(value),
      },
    }],
  };
}

function jsonResponse(value, options = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = Buffer.from(text, "utf8");
  const headers = new Map([
    ["content-type", options.contentType || "application/json; charset=utf-8"],
    ["content-length", String(
      options.contentLength ?? bytes.length,
    )],
  ]);
  let sent = false;
  return {
    status: options.status ?? 200,
    redirected: options.redirected ?? false,
    url: options.url || "",
    headers: {
      get(name) {
        return headers.get(String(name).toLowerCase()) ?? null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {
            options.onCancel?.();
          },
        };
      },
      async cancel() {
        options.onCancel?.();
      },
    },
  };
}

function liveEnv(overrides = {}) {
  return {
    SHORTSENGINE_LOCAL_LLM_SCENE_PLANNER_MODE: "openai_compatible",
    SHORTSENGINE_LOCAL_LLM_ENDPOINT:
      "http://127.0.0.1:11434/v1/chat/completions",
    SHORTSENGINE_LOCAL_LLM_MODEL: "scene-model",
    SHORTSENGINE_LOCAL_LLM_TIMEOUT_MS: "1000",
    SHORTSENGINE_LOCAL_LLM_RESPONSE_MAX_BYTES: "4096",
    ...overrides,
  };
}

test("disabled and mock modes never touch the network", async () => {
  let fetchCalls = 0;
  const fetch = async () => {
    fetchCalls += 1;
    throw new Error("network must not be used");
  };
  const input = fixture();
  const disabled = createLocalLlmScenePlanner({ env: {}, fetch });
  const first = await disabled.planScene(input);
  const second = await disabled.planScene(structuredClone(input));

  assert.equal(fetchCalls, 0);
  assert.equal(first.fallbackUsed, true);
  assert.equal(first.failure.code, "ANIMATION_LOCAL_LLM_DISABLED");
  assert.deepEqual(first.sceneDsl, second.sceneDsl);
  assert.equal(first.sceneDsl.bindings.semanticEventGraphHash, input.semanticEventGraph.contentHash);
  assert.equal(disabled.health().apiKeyRequired, false);
  assert.equal(disabled.health().loopbackOnly, true);

  const mock = createLocalLlmScenePlanner({
    env: { SHORTSENGINE_LOCAL_LLM_SCENE_PLANNER_MODE: "mock" },
    fetch,
  });
  const mocked = await mock.planScene(input);
  assert.equal(fetchCalls, 0);
  assert.equal(mocked.fallbackUsed, false);
  assert.equal(mocked.providerId, "deterministic_mock");
});

test("loopback endpoint parser rejects DNS, private, remote and obfuscated hosts", () => {
  assert.equal(
    normalizeLoopbackEndpoint(
      "http://127.0.0.1:11434/v1/chat/completions",
    ),
    "http://127.0.0.1:11434/v1/chat/completions",
  );
  assert.equal(
    normalizeLoopbackEndpoint(
      "http://[::1]:8080/v1/chat/completions",
    ),
    "http://[::1]:8080/v1/chat/completions",
  );
  assert.equal(
    normalizeLoopbackEndpoint(
      "http://127.0.0.1:80/v1/chat/completions",
    ),
    "http://127.0.0.1/v1/chat/completions",
  );

  for (const unsafe of [
    "http://localhost:11434/v1/chat/completions",
    "http://127.0.0.1.evil.test:11434/v1/chat/completions",
    "http://127.0.0.1@evil.test:11434/v1/chat/completions",
    "http://10.0.0.2:11434/v1/chat/completions",
    "http://169.254.169.254:80/v1/chat/completions",
    "http://2130706433:11434/v1/chat/completions",
    "http://0x7f000001:11434/v1/chat/completions",
    "http://0177.0.0.1:11434/v1/chat/completions",
    "http://127.1:11434/v1/chat/completions",
    "https://127.0.0.1:11434/v1/chat/completions",
    "http://127.0.0.1:11434/api/chat",
    "http://127.0.0.1:11434/v1/chat/completions?key=value",
    "http://127.0.0.1:11434/v1/chat/completions#fragment",
  ]) {
    assert.throws(
      () => normalizeLoopbackEndpoint(unsafe),
      { code: "ANIMATION_LOCAL_LLM_ENDPOINT_UNSAFE" },
      unsafe,
    );
  }
});

test("live mode sends one credential-free bounded loopback request", async () => {
  const requests = [];
  const secret = "credential-must-not-appear";
  const planner = createLocalLlmScenePlanner({
    env: liveEnv({ OPENAI_API_KEY: secret }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(providerPayload());
    },
  });
  const input = fixture();
  const result = await planner.planScene(input);

  assert.equal(result.fallbackUsed, false);
  assert.equal(result.providerId, "local_openai_compatible");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "http://127.0.0.1:11434/v1/chat/completions",
  );
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.redirect, "error");
  assert.deepEqual(requests[0].options.headers, {
    accept: "application/json",
    "content-type": "application/json",
  });
  assert.doesNotMatch(requests[0].options.body, /authorization|api[_-]?key|cookie/i);
  assert.doesNotMatch(requests[0].options.body, new RegExp(secret));
  assert.equal(
    requests[0].options.body.includes(
      input.semanticVisualSentencePlan.sentences[0].wordSpan.text,
    ),
    false,
  );
  assert.equal(result.sceneDsl.computedCost, 9);
});

test("safe semantic variation makes every numbered-fixture prompt distinct", async () => {
  const prompts = [];
  const planner = createLocalLlmScenePlanner({
    env: liveEnv(),
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body);
      prompts.push(request.messages[1].content);
      return jsonResponse(providerPayload());
    },
  });
  for (const id of [
    "001_wow_signal_mystery",
    "002_gps_week_rollover",
    "003_baychimo_icebound_drift",
  ]) {
    const input = fixture(id);
    for (const sentence of input.semanticVisualSentencePlan.sentences) {
      await planner.planScene({
        ...input,
        propositionId: sentence.propositionId,
      });
    }
  }

  assert.ok(prompts.length >= 20);
  assert.equal(new Set(prompts).size, prompts.length);
  assert.doesNotMatch(prompts.join(""), /spokenText|wordSpan|sourceRefs/);
});

test("invalid provider output falls back without exposing raw output", async () => {
  const raw =
    "```json\n{\"javascript\":\"sensitive-provider-output\"}\n```";
  const planner = createLocalLlmScenePlanner({
    env: liveEnv(),
    fetch: async () => jsonResponse(providerPayload(raw)),
  });
  const result = await planner.planScene(fixture());

  assert.equal(result.fallbackUsed, true);
  assert.equal(result.failure.code, "ANIMATION_LOCAL_LLM_RESPONSE_INVALID");
  assert.doesNotMatch(
    JSON.stringify(result),
    /javascript|sensitive-provider-output/,
  );
});

test("declared and streamed response limits fail safely and cancel the reader", async () => {
  let declaredCancelled = false;
  const declared = createLocalLlmScenePlanner({
    env: liveEnv(),
    fetch: async () => jsonResponse(providerPayload(), {
      contentLength: 5000,
      onCancel() {
        declaredCancelled = true;
      },
    }),
  });
  const declaredResult = await declared.planScene(fixture());
  assert.equal(declaredResult.fallbackUsed, true);
  assert.equal(
    declaredResult.failure.code,
    "ANIMATION_LOCAL_LLM_RESPONSE_TOO_LARGE",
  );
  assert.equal(declaredCancelled, true);

  let cancelled = false;
  let readCount = 0;
  const response = {
    headers: {
      get(name) {
        return name === "content-type" ? "application/json" : null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            readCount += 1;
            return readCount === 1
              ? { done: false, value: new Uint8Array(700) }
              : { done: false, value: new Uint8Array(700) };
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    },
  };
  await assert.rejects(
    () => readBoundedResponseText(response, 1024),
    { code: "ANIMATION_LOCAL_LLM_RESPONSE_TOO_LARGE" },
  );
  assert.equal(cancelled, true);
});

test("rejected status and content type cancel response bodies", async () => {
  for (const responseOptions of [
    { status: 503 },
    { contentType: "text/plain" },
    {
      redirected: true,
      url: "http://127.0.0.1:11434/v1/chat/completions",
    },
  ]) {
    let cancelled = false;
    const planner = createLocalLlmScenePlanner({
      env: liveEnv(),
      fetch: async () => jsonResponse(providerPayload(), {
        ...responseOptions,
        onCancel() {
          cancelled = true;
        },
      }),
    });
    const result = await planner.planScene(fixture());
    assert.equal(result.fallbackUsed, true);
    assert.equal(cancelled, true);
  }
});

test("timeout falls back, while caller cancellation remains cancellation", async () => {
  const neverCompletesUntilAbort = (_url, options) => new Promise(
    (_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const cause = new Error("aborted provider detail");
        cause.name = "AbortError";
        reject(cause);
      }, { once: true });
    },
  );
  const timed = createLocalLlmScenePlanner({
    env: liveEnv(),
    fetch: neverCompletesUntilAbort,
  });
  const timedResult = await timed.planScene(fixture());
  assert.equal(timedResult.fallbackUsed, true);
  assert.equal(timedResult.failure.code, "ANIMATION_LOCAL_LLM_TIMEOUT");

  const controller = new AbortController();
  const cancelled = createLocalLlmScenePlanner({
    env: liveEnv(),
    fetch: neverCompletesUntilAbort,
  }).planScene({
    ...fixture(),
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(cancelled, { code: "JOB_CANCELLED" });
});

test("all modes honor an already-cancelled caller before planning", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  for (const mode of ["disabled", "mock", "openai_compatible"]) {
    const planner = createLocalLlmScenePlanner({
      env: mode === "openai_compatible"
        ? liveEnv()
        : { SHORTSENGINE_LOCAL_LLM_SCENE_PLANNER_MODE: mode },
      fetch: async () => {
        fetchCalls += 1;
        return jsonResponse(providerPayload());
      },
      signal: controller.signal,
    });
    await assert.rejects(
      () => planner.planScene(fixture()),
      { code: "JOB_CANCELLED" },
    );
  }
  assert.equal(fetchCalls, 0);
});

test("invalid trusted context fails closed before any fallback or fetch", async () => {
  let fetchCalls = 0;
  const planner = createLocalLlmScenePlanner({
    env: liveEnv(),
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse(providerPayload());
    },
  });
  const input = fixture();
  input.propositionId = "missing_proposition";

  await assert.rejects(
    () => planner.planScene(input),
    { code: "ANIMATION_LOCAL_LLM_CONTEXT_INVALID" },
  );
  assert.equal(fetchCalls, 0);
});
