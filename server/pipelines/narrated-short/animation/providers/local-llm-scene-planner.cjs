"use strict";

const { AppError, SAFE_MESSAGES } = require("../../../../errors.cjs");
const {
  normalizeSemanticEventGraph,
} = require("../semantic-event-validator.cjs");
const {
  validateSemanticVisualSentencePlanAgainstGraph,
} = require("../semantic-visual-sentence-planner.cjs");
const {
  ACTION_RULES,
  MAX_PROPOSED_ACTIONS,
  MAX_SCENE_COST,
  SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION,
  buildSemanticAnimationSceneDsl,
  normalizeSemanticAnimationSceneProposal,
} = require("../semantic-animation-scene-dsl.cjs");

const LOCAL_LLM_SCENE_PLANNER_PROMPT_PROFILE_ID =
  "dark_curiosity_local_scene_planner_prompt_v1";
const LOCAL_LLM_SCENE_PLANNER_MODES = Object.freeze([
  "disabled",
  "mock",
  "openai_compatible",
]);
const DEFAULT_LOCAL_LLM_ENDPOINT =
  "http://127.0.0.1:11434/v1/chat/completions";
const DEFAULT_LOCAL_LLM_MODEL = "local-scene-planner";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES_LIMIT = 256 * 1024;
const LOOPBACK_ENDPOINT_PATTERN =
  /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/v1\/chat\/completions$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const RECOVERABLE_PROVIDER_CODES = new Set([
  "ANIMATION_LOCAL_LLM_FETCH_FAILED",
  "ANIMATION_LOCAL_LLM_HTTP_FAILED",
  "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
  "ANIMATION_LOCAL_LLM_RESPONSE_TOO_LARGE",
  "ANIMATION_LOCAL_LLM_TIMEOUT",
  "ANIMATION_LOCAL_LLM_UNAVAILABLE",
  "ANIMATION_SCENE_DSL_INVALID",
  "ANIMATION_SCENE_PROPOSAL_INVALID",
]);
const SYSTEM_PROMPT = [
  "You are a bounded animation choreography selector.",
  "Return exactly one JSON object matching the supplied proposal schema.",
  "Use only an allowed action object copied from allowedActions.",
  "Never invent identifiers or enum values.",
  "Never return markdown, prose, labels, code, SVG, HTML, CSS, URLs,",
  "coordinates, colors, paths, timing values, story IDs, hashes, or extra fields.",
].join(" ");

function error(code, message, status = 409, details = null) {
  return new AppError(code, message, status, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeInteger(value, fallback, minimum, maximum, field) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw error(
      "ANIMATION_LOCAL_LLM_CONFIG_INVALID",
      "The local animation scene planner configuration is invalid.",
      500,
      { field },
    );
  }
  return number;
}

function safeIdentifier(value, field, fallback = "") {
  const normalized = String(value === undefined ? fallback : value).trim();
  if (!MODEL_ID_PATTERN.test(normalized)) {
    throw error(
      "ANIMATION_LOCAL_LLM_CONFIG_INVALID",
      "The local animation scene planner configuration is invalid.",
      500,
      { field },
    );
  }
  return normalized;
}

function normalizeLoopbackEndpoint(value) {
  const raw = String(value || "").trim();
  const match = LOOPBACK_ENDPOINT_PATTERN.exec(raw);
  if (!match) {
    throw error(
      "ANIMATION_LOCAL_LLM_ENDPOINT_UNSAFE",
      "The local animation scene planner endpoint must be an exact loopback URL.",
      500,
    );
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw error(
      "ANIMATION_LOCAL_LLM_ENDPOINT_UNSAFE",
      "The local animation scene planner endpoint must be an exact loopback URL.",
      500,
    );
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw error(
      "ANIMATION_LOCAL_LLM_ENDPOINT_UNSAFE",
      "The local animation scene planner endpoint must be an exact loopback URL.",
      500,
    );
  }
  if (
    parsed.protocol !== "http:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== "/v1/chat/completions"
  ) {
    throw error(
      "ANIMATION_LOCAL_LLM_ENDPOINT_UNSAFE",
      "The local animation scene planner endpoint must be an exact loopback URL.",
      500,
    );
  }
  return parsed.href;
}

function normalizeLocalLlmScenePlannerConfig(options = {}) {
  const env = options.env || process.env;
  const mode = String(
    options.mode
      ?? env.SHORTSENGINE_LOCAL_LLM_SCENE_PLANNER_MODE
      ?? "disabled",
  ).trim().toLowerCase();
  if (!LOCAL_LLM_SCENE_PLANNER_MODES.includes(mode)) {
    throw error(
      "ANIMATION_LOCAL_LLM_CONFIG_INVALID",
      "The local animation scene planner configuration is invalid.",
      500,
      { field: "mode" },
    );
  }
  const live = mode === "openai_compatible";
  return Object.freeze({
    mode,
    endpoint: live
      ? normalizeLoopbackEndpoint(
        options.endpoint
          ?? env.SHORTSENGINE_LOCAL_LLM_ENDPOINT
          ?? DEFAULT_LOCAL_LLM_ENDPOINT,
      )
      : null,
    modelId: live
      ? safeIdentifier(
        options.modelId
          ?? env.SHORTSENGINE_LOCAL_LLM_MODEL,
        "modelId",
        DEFAULT_LOCAL_LLM_MODEL,
      )
      : mode === "mock"
        ? "deterministic-mock-v1"
        : "deterministic-fallback-v1",
    timeoutMs: safeInteger(
      options.timeoutMs
        ?? env.SHORTSENGINE_LOCAL_LLM_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1000,
      300000,
      "timeoutMs",
    ),
    maxResponseBytes: safeInteger(
      options.maxResponseBytes
        ?? env.SHORTSENGINE_LOCAL_LLM_RESPONSE_MAX_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
      1024,
      MAX_RESPONSE_BYTES_LIMIT,
      "maxResponseBytes",
    ),
    maxTokens: safeInteger(
      options.maxTokens
        ?? env.SHORTSENGINE_LOCAL_LLM_MAX_TOKENS,
      512,
      64,
      1024,
      "maxTokens",
    ),
  });
}

function plannerContext(input = {}) {
  if (!isPlainObject(input)) {
    throw error(
      "ANIMATION_LOCAL_LLM_CONTEXT_INVALID",
      "The local animation scene planner context is invalid.",
      409,
    );
  }
  const graph = normalizeSemanticEventGraph(input.semanticEventGraph);
  const plan = validateSemanticVisualSentencePlanAgainstGraph(
    input.semanticVisualSentencePlan,
    graph,
  );
  const propositionId = String(input.propositionId || "").trim();
  const sentence = plan.sentences.find(
    (candidate) => candidate.propositionId === propositionId,
  );
  if (!sentence?.primitiveParameters || !sentence?.sceneComposition) {
    throw error(
      "ANIMATION_LOCAL_LLM_CONTEXT_INVALID",
      "The local animation scene planner context is invalid.",
      409,
      { field: "propositionId" },
    );
  }
  return Object.freeze({
    graphHash: graph.contentHash,
    planHash: plan.contentHash,
    propositionId,
    sentence,
    hasApprovedRoute:
      sentence.primitiveParameters.geometry.route !== null,
  });
}

function allowedActionsForContext(context) {
  const actions = [];
  for (const op of ["transform", "move", "highlight", "camera"]) {
    if (op === "move" && !context.hasApprovedRoute) continue;
    const rule = ACTION_RULES[op];
    for (const target of rule.targets) {
      for (const phase of rule.phases) {
        for (const preset of rule.presets) {
          actions.push({ op, target, phase, preset });
        }
      }
    }
  }
  return actions;
}

function buildLocalScenePlannerPrompt(context) {
  const sentence = context.sentence;
  const variationSeed =
    sentence.primitiveParameters.geometry.variantSeed;
  return Object.freeze({
    schemaVersion: 1,
    promptProfileId: LOCAL_LLM_SCENE_PLANNER_PROMPT_PROFILE_ID,
    task: "select_grounded_scene_choreography",
    context: {
      grammarId: sentence.primitiveParameters.grammarId,
      assetId: sentence.primitiveParameters.assetId,
      stateToken: sentence.primitiveParameters.stateToken,
      predicate: sentence.visualIntent.predicate,
      subjectKind: sentence.visualIntent.subjectKind,
      stateTransition: sentence.visualIntent.stateTransition,
      hasQuantity: sentence.primitiveParameters.quantity !== null,
      hasApprovedRoute: context.hasApprovedRoute,
      sceneLayoutId: sentence.sceneComposition.layoutId,
      variationSeed,
      moduleKinds: sentence.sceneComposition.modules.map(
        (module) => module.kind,
      ),
    },
    constraints: {
      minimumActions: 1,
      maximumActions: MAX_PROPOSED_ACTIONS,
      maximumFinalSceneCost: MAX_SCENE_COST,
      requireResolveAction: true,
      requirePrimaryOrSceneAction: true,
    },
    allowedActions: allowedActionsForContext(context),
    output: {
      schemaVersion: SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION,
      actions: "array_of_allowed_action_objects_only",
    },
  });
}

function deterministicProposalForContext(context) {
  const grammarId = context.sentence.primitiveParameters.grammarId;
  const variationBucket =
    context.sentence.primitiveParameters.geometry.variantSeed % 16;
  const alternatingSupport = variationBucket % 2 === 0
    ? "module_support_a"
    : "module_support_b";
  let actions;
  if (context.hasApprovedRoute) {
    actions = [
      {
        op: "move",
        target: "module_primary",
        phase: "develop",
        preset: "follow_grounded_route",
      },
      {
        op: "camera",
        target: "scene",
        phase: "develop",
        preset: variationBucket % 2 === 0
          ? "push_primary"
          : "pull_overview",
      },
      {
        op: "highlight",
        target: alternatingSupport,
        phase: "resolve",
        preset: "pulse_once",
      },
    ];
  } else if ([
    "evidence_inspection",
    "chronology_accumulation",
  ].includes(grammarId)) {
    actions = [
      {
        op: "camera",
        target: "scene",
        phase: "develop",
        preset: variationBucket % 2 === 0
          ? "push_primary"
          : "pull_overview",
      },
      {
        op: "highlight",
        target: variationBucket % 3 === 0
          ? "module_primary"
          : alternatingSupport,
        phase: "resolve",
        preset: "pulse_once",
      },
    ];
  } else if ([
    "bounded_uncertainty",
    "negative_space_absence",
  ].includes(grammarId)) {
    actions = [
      {
        op: "camera",
        target: "scene",
        phase: "develop",
        preset: variationBucket % 3 === 0
          ? "push_primary"
          : "pull_overview",
      },
      {
        op: "highlight",
        target: variationBucket % 2 === 0
          ? "module_primary"
          : alternatingSupport,
        phase: "resolve",
        preset: "pulse_once",
      },
    ];
  } else if (variationBucket % 3 === 2) {
    actions = [
      {
        op: "camera",
        target: "scene",
        phase: "develop",
        preset: "push_primary",
      },
      {
        op: "highlight",
        target: "module_primary",
        phase: "resolve",
        preset: "pulse_once",
      },
    ];
  } else {
    actions = [
      {
        op: "highlight",
        target: alternatingSupport,
        phase: "develop",
        preset: "pulse_once",
      },
      {
        op: "transform",
        target: "module_primary",
        phase: "resolve",
        preset: "semantic_transition",
      },
    ];
  }
  return normalizeSemanticAnimationSceneProposal({
    schemaVersion: SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION,
    actions,
  }, {
    hasApprovedRoute: context.hasApprovedRoute,
  });
}

function buildSceneDsl(context, proposal) {
  return buildSemanticAnimationSceneDsl({
    semanticEventGraphHash: context.graphHash,
    semanticVisualSentencePlanHash: context.planHash,
    propositionId: context.propositionId,
    primitiveParameters: context.sentence.primitiveParameters,
    sceneComposition: context.sentence.sceneComposition,
    proposal,
  });
}

function parseContentLength(response, maximum) {
  const raw = response.headers?.get?.("content-length");
  if (raw === null || raw === undefined || raw === "") return;
  if (!/^[0-9]+$/.test(raw)) {
    throw error(
      "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
      "The local animation scene planner returned an invalid response.",
      502,
    );
  }
  if (Number(raw) > maximum) {
    throw error(
      "ANIMATION_LOCAL_LLM_RESPONSE_TOO_LARGE",
      "The local animation scene planner response is too large.",
      502,
    );
  }
}

async function cancelResponseBody(response) {
  try {
    if (typeof response?.body?.cancel === "function") {
      await response.body.cancel();
      return;
    }
    if (typeof response?.body?.getReader === "function") {
      await response.body.getReader().cancel();
    }
  } catch {
    // Best-effort release of an untrusted local response stream.
  }
}

async function readBoundedResponseText(response, maximum) {
  try {
    parseContentLength(response, maximum);
    const contentType = String(
      response.headers?.get?.("content-type") || "",
    ).toLowerCase();
    if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
      throw error(
        "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
        "The local animation scene planner returned an invalid response.",
        502,
      );
    }
  } catch (cause) {
    await cancelResponseBody(response);
    throw cause;
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    await cancelResponseBody(response);
    throw error(
      "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
      "The local animation scene planner response is not safely readable.",
      502,
    );
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw error(
          "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
          "The local animation scene planner returned an invalid response.",
          502,
        );
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximum) {
        throw error(
          "ANIMATION_LOCAL_LLM_RESPONSE_TOO_LARGE",
          "The local animation scene planner response is too large.",
          502,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Best-effort release after a bounded read failure.
      }
    }
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function parseProviderProposal(payloadText, context) {
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw error(
      "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
      "The local animation scene planner returned invalid JSON.",
      502,
    );
  }
  if (
    !isPlainObject(payload)
    || !Array.isArray(payload.choices)
    || payload.choices.length !== 1
    || !isPlainObject(payload.choices[0])
    || !isPlainObject(payload.choices[0].message)
    || typeof payload.choices[0].message.content !== "string"
    || !payload.choices[0].message.content.trim()
  ) {
    throw error(
      "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
      "The local animation scene planner returned an invalid response.",
      502,
    );
  }
  let proposal;
  try {
    proposal = JSON.parse(payload.choices[0].message.content);
  } catch {
    throw error(
      "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
      "The local animation scene planner returned invalid JSON.",
      502,
    );
  }
  return normalizeSemanticAnimationSceneProposal(proposal, {
    hasApprovedRoute: context.hasApprovedRoute,
  });
}

function isAbortError(value) {
  return value?.name === "AbortError" || value?.code === "ABORT_ERR";
}

async function requestLocalProposal(config, context, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw error(
      "ANIMATION_LOCAL_LLM_UNAVAILABLE",
      "The local animation scene planner is unavailable.",
      503,
    );
  }
  const externalSignal = dependencies.signal || null;
  if (externalSignal?.aborted) {
    throw error("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
  }
  const prompt = buildLocalScenePlannerPrompt(context);
  const body = JSON.stringify({
    model: config.modelId,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(prompt) },
    ],
    temperature: 0,
    max_tokens: config.maxTokens,
    stream: false,
  });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw error(
      "ANIMATION_LOCAL_LLM_REQUEST_TOO_LARGE",
      "The local animation scene planner request is too large.",
      500,
    );
  }
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  try {
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body,
      redirect: "error",
      signal: controller.signal,
    });
    if (
      response?.redirected === true
      || (
        typeof response?.url === "string"
        && response.url
        && response.url !== config.endpoint
      )
    ) {
      await cancelResponseBody(response);
      throw error(
        "ANIMATION_LOCAL_LLM_RESPONSE_INVALID",
        "The local animation scene planner returned an invalid response.",
        502,
      );
    }
    if (
      !response
      || typeof response.status !== "number"
      || response.status < 200
      || response.status >= 300
    ) {
      await cancelResponseBody(response);
      throw error(
        "ANIMATION_LOCAL_LLM_HTTP_FAILED",
        "The local animation scene planner rejected the request.",
        502,
        {
          status: Number.isInteger(response?.status)
            ? response.status
            : 0,
        },
      );
    }
    const responseText = await readBoundedResponseText(
      response,
      config.maxResponseBytes,
    );
    return parseProviderProposal(responseText, context);
  } catch (cause) {
    if (externallyAborted || externalSignal?.aborted) {
      throw error("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
    }
    if (timedOut) {
      throw error(
        "ANIMATION_LOCAL_LLM_TIMEOUT",
        "The local animation scene planner timed out.",
        504,
      );
    }
    if (cause instanceof AppError) throw cause;
    if (controller.signal.aborted && isAbortError(cause)) {
      throw error(
        "ANIMATION_LOCAL_LLM_TIMEOUT",
        "The local animation scene planner timed out.",
        504,
      );
    }
    throw error(
      "ANIMATION_LOCAL_LLM_FETCH_FAILED",
      "The local animation scene planner request failed.",
      502,
    );
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    controller.abort();
  }
}

function safeFailure(code) {
  return Object.freeze({
    code,
    phase: "local_scene_planner",
    retryable: [
      "ANIMATION_LOCAL_LLM_FETCH_FAILED",
      "ANIMATION_LOCAL_LLM_HTTP_FAILED",
      "ANIMATION_LOCAL_LLM_TIMEOUT",
      "ANIMATION_LOCAL_LLM_UNAVAILABLE",
    ].includes(code),
  });
}

function freezeResult(value) {
  Object.freeze(value.sceneDsl);
  if (value.failure) Object.freeze(value.failure);
  return Object.freeze(value);
}

function createLocalLlmScenePlanner(options = {}) {
  const config = normalizeLocalLlmScenePlannerConfig(options);
  const fetchImpl = options.fetch;
  return Object.freeze({
    id: "local_llm_scene_planner",
    mode: config.mode,
    health() {
      return Object.freeze({
        status: config.mode === "disabled" ? "disabled" : "configured",
        ready: true,
        mode: config.mode,
        networkRequired: config.mode === "openai_compatible",
        loopbackOnly: true,
        apiKeyRequired: false,
        promptProfileId: LOCAL_LLM_SCENE_PLANNER_PROMPT_PROFILE_ID,
      });
    },
    async planScene(input = {}) {
      const signal = input.signal || options.signal;
      if (signal?.aborted) {
        throw error("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
      }
      const context = plannerContext(input);
      const fallbackProposal = deterministicProposalForContext(context);
      if (config.mode === "disabled") {
        return freezeResult({
          providerId: "deterministic_fallback",
          modelId: config.modelId,
          promptProfileId: LOCAL_LLM_SCENE_PLANNER_PROMPT_PROFILE_ID,
          fallbackUsed: true,
          failure: safeFailure("ANIMATION_LOCAL_LLM_DISABLED"),
          sceneDsl: buildSceneDsl(context, fallbackProposal),
        });
      }
      if (config.mode === "mock") {
        return freezeResult({
          providerId: "deterministic_mock",
          modelId: config.modelId,
          promptProfileId: LOCAL_LLM_SCENE_PLANNER_PROMPT_PROFILE_ID,
          fallbackUsed: false,
          failure: null,
          sceneDsl: buildSceneDsl(context, fallbackProposal),
        });
      }
      try {
        const proposal = await requestLocalProposal(config, context, {
          fetch: fetchImpl,
          signal,
        });
        return freezeResult({
          providerId: "local_openai_compatible",
          modelId: config.modelId,
          promptProfileId: LOCAL_LLM_SCENE_PLANNER_PROMPT_PROFILE_ID,
          fallbackUsed: false,
          failure: null,
          sceneDsl: buildSceneDsl(context, proposal),
        });
      } catch (cause) {
        if (cause?.code === "JOB_CANCELLED") throw cause;
        if (!RECOVERABLE_PROVIDER_CODES.has(cause?.code)) throw cause;
        return freezeResult({
          providerId: "deterministic_fallback",
          modelId: config.modelId,
          promptProfileId: LOCAL_LLM_SCENE_PLANNER_PROMPT_PROFILE_ID,
          fallbackUsed: true,
          failure: safeFailure(cause.code),
          sceneDsl: buildSceneDsl(context, fallbackProposal),
        });
      }
    },
  });
}

module.exports = {
  DEFAULT_LOCAL_LLM_ENDPOINT,
  LOCAL_LLM_SCENE_PLANNER_MODES,
  LOCAL_LLM_SCENE_PLANNER_PROMPT_PROFILE_ID,
  MAX_REQUEST_BYTES,
  buildLocalScenePlannerPrompt,
  createLocalLlmScenePlanner,
  deterministicProposalForContext,
  normalizeLocalLlmScenePlannerConfig,
  normalizeLoopbackEndpoint,
  readBoundedResponseText,
};
