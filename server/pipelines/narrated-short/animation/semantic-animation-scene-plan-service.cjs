"use strict";

const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const {
  buildDeterministicSemanticAnimationSceneDslPlan,
  buildSemanticAnimationSceneDslPlanFromScenes,
  validateSemanticAnimationSceneDslPlanAgainstContext,
} = require("./semantic-animation-scene-dsl-plan.cjs");
const {
  validateSemanticAnimationSceneDslAgainstContext,
} = require("./semantic-animation-scene-dsl.cjs");
const {
  normalizeSemanticEventGraph,
} = require("./semantic-event-validator.cjs");
const {
  validateSemanticVisualSentencePlanAgainstGraph,
} = require("./semantic-visual-sentence-planner.cjs");
const {
  createLocalLlmScenePlanner,
} = require("./providers/local-llm-scene-planner.cjs");

const DEFAULT_AGGREGATE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_AGGREGATE_TIMEOUT_MS = 10 * 60 * 1000;
const CIRCUIT_BREAKER_FAILURE_CODES = new Set([
  "ANIMATION_LOCAL_LLM_FETCH_FAILED",
  "ANIMATION_LOCAL_LLM_HTTP_FAILED",
  "ANIMATION_LOCAL_LLM_TIMEOUT",
  "ANIMATION_LOCAL_LLM_UNAVAILABLE",
]);
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function fail(field, reason = "invalid", status = 409) {
  throw new AppError(
    "ANIMATION_SCENE_DSL_PLAN_INVALID",
    "The animation scene DSL plan is invalid or is not grounded in its semantic sentence plan.",
    status,
    { field, reason },
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new AppError(
      "JOB_CANCELLED",
      SAFE_MESSAGES.JOB_CANCELLED,
      409,
    );
  }
}

function aggregateTimeoutMs(input, dependencies) {
  const value = dependencies.aggregateTimeoutMs
    ?? input.aggregateTimeoutMs
    ?? DEFAULT_AGGREGATE_TIMEOUT_MS;
  const timeoutMs = Number(value);
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAX_AGGREGATE_TIMEOUT_MS
  ) fail("aggregateTimeoutMs", "integer_out_of_range", 500);
  return timeoutMs;
}

function aggregateGuard(signal, timeoutMs) {
  const controller = new AbortController();
  let callerCancelled = false;
  let deadlineExpired = false;
  let rejectTerminal;
  const terminal = new Promise((_resolve, reject) => {
    rejectTerminal = reject;
  });
  // The guard can expire between scene calls. Keep its rejection observed even
  // when no planner promise is currently racing it.
  terminal.catch(() => {});
  const cancel = () => {
    if (callerCancelled || deadlineExpired) return;
    callerCancelled = true;
    rejectTerminal(new AppError(
      "JOB_CANCELLED",
      SAFE_MESSAGES.JOB_CANCELLED,
      409,
    ));
    controller.abort();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => {
    if (callerCancelled || deadlineExpired) return;
    deadlineExpired = true;
    rejectTerminal(new AppError(
      "ANIMATION_SCENE_PLANNER_AGGREGATE_TIMEOUT",
      "The animation scene planner exceeded its aggregate deadline.",
      504,
    ));
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    get callerCancelled() {
      return callerCancelled || signal?.aborted === true;
    },
    get deadlineExpired() {
      return deadlineExpired;
    },
    race(value) {
      return Promise.race([Promise.resolve(value), terminal]);
    },
    dispose() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      controller.abort();
    },
  };
}

function plannerMetadata(planner) {
  if (
    !planner
    || typeof planner !== "object"
    || typeof planner.id !== "string"
    || typeof planner.mode !== "string"
    || typeof planner.health !== "function"
    || typeof planner.planScene !== "function"
  ) fail("planner", "planner_contract_required", 500);
  const health = planner.health();
  if (
    !health
    || typeof health !== "object"
    || typeof health.promptProfileId !== "string"
    || health.mode !== planner.mode
  ) fail("planner.health", "planner_health_contract_required", 500);
  return {
    plannerId: planner.id,
    mode: planner.mode,
    promptProfileId: health.promptProfileId,
  };
}

function planningContext(input) {
  const graph = normalizeSemanticEventGraph(input.semanticEventGraph);
  const sentencePlan = validateSemanticVisualSentencePlanAgainstGraph(
    input.semanticVisualSentencePlan,
    graph,
  );
  if (
    graph.primitivePayloadProfileId === undefined
    || sentencePlan.sceneCompositionProfileId === undefined
    || sentencePlan.sentences.some((sentence) => (
      sentence.primitiveParameters === undefined
      || sentence.sceneComposition === undefined
    ))
  ) fail("semanticVisualSentencePlan", "composed_sentence_plan_required");
  return { graph, sentencePlan };
}

function copyFailure(failure) {
  if (failure === null) return null;
  if (!failure || typeof failure !== "object") return failure;
  return {
    code: failure.code,
    phase: failure.phase,
    retryable: failure.retryable,
  };
}

function circuitFailure(result, plannerInfo) {
  const failure = result?.failure;
  if (
    result?.fallbackUsed !== true
    || result?.providerId !== "deterministic_fallback"
    || !MODEL_ID_PATTERN.test(result?.modelId || "")
    || result?.promptProfileId !== plannerInfo.promptProfileId
    || !failure
    || failure.phase !== "local_scene_planner"
    || failure.retryable !== true
    || !CIRCUIT_BREAKER_FAILURE_CODES.has(failure.code)
  ) return null;
  return Object.freeze({
    providerId: "deterministic_fallback",
    modelId: result.modelId,
    promptProfileId: plannerInfo.promptProfileId,
    fallbackUsed: true,
    failure: Object.freeze({
      code: failure.code,
      phase: "local_scene_planner",
      retryable: true,
    }),
  });
}

function aggregateDeadlineProvenance(plannerInfo) {
  return Object.freeze({
    providerId: "deterministic_fallback",
    modelId: "aggregate-deadline-fallback-v1",
    promptProfileId: plannerInfo.promptProfileId,
    fallbackUsed: true,
    failure: Object.freeze({
      code: "ANIMATION_SCENE_PLANNER_AGGREGATE_TIMEOUT",
      phase: "aggregate_scene_planner",
      retryable: true,
    }),
  });
}

function fallbackResult(sentence, deterministicScenes, provenance) {
  const deterministic = deterministicScenes.get(sentence.propositionId);
  if (!deterministic) {
    fail("deterministicFallback", "scene_coverage_mismatch", 500);
  }
  return {
    ...provenance,
    failure: copyFailure(provenance.failure),
    sceneDsl: deterministic.sceneDsl,
  };
}

async function planSemanticAnimationScenes(input = {}, dependencies = {}) {
  const signal = input.signal || dependencies.signal || null;
  throwIfAborted(signal);
  const context = planningContext(input);
  const planner = dependencies.planner
    || input.planner
    || createLocalLlmScenePlanner(
      dependencies.localLlmScenePlannerOptions || {},
    );
  const plannerInfo = plannerMetadata(planner);
  const deterministicPlan = buildDeterministicSemanticAnimationSceneDslPlan({
    semanticEventGraph: context.graph,
    semanticVisualSentencePlan: context.sentencePlan,
  });
  const deterministicScenes = new Map(deterministicPlan.scenes.map(
    (scene) => [scene.propositionId, scene],
  ));
  const guard = aggregateGuard(
    signal,
    aggregateTimeoutMs(input, dependencies),
  );
  const scenes = [];
  let openCircuit = null;

  try {
    for (const sentence of context.sentencePlan.sentences) {
      throwIfAborted(signal);
      let result;
      if (openCircuit) {
        result = fallbackResult(
          sentence,
          deterministicScenes,
          openCircuit,
        );
      } else if (guard.deadlineExpired) {
        openCircuit = aggregateDeadlineProvenance(plannerInfo);
        result = fallbackResult(
          sentence,
          deterministicScenes,
          openCircuit,
        );
      } else {
        try {
          result = await guard.race(planner.planScene({
            semanticEventGraph: context.graph,
            semanticVisualSentencePlan: context.sentencePlan,
            propositionId: sentence.propositionId,
            signal: guard.signal,
          }));
        } catch (cause) {
          if (guard.callerCancelled) {
            throw new AppError(
              "JOB_CANCELLED",
              SAFE_MESSAGES.JOB_CANCELLED,
              409,
            );
          }
          if (!guard.deadlineExpired) throw cause;
          openCircuit = aggregateDeadlineProvenance(plannerInfo);
          result = fallbackResult(
            sentence,
            deterministicScenes,
            openCircuit,
          );
        }
      }
      throwIfAborted(signal);
      if (!result || typeof result !== "object") {
        fail("planner.result", "planner_result_required", 502);
      }
      const sceneDsl = validateSemanticAnimationSceneDslAgainstContext(
        result.sceneDsl,
        {
          semanticEventGraphHash: context.graph.contentHash,
          semanticVisualSentencePlanHash:
            context.sentencePlan.contentHash,
          propositionId: sentence.propositionId,
          primitiveParameters: sentence.primitiveParameters,
          sceneComposition: sentence.sceneComposition,
        },
      );
      scenes.push({
        propositionId: sentence.propositionId,
        provenance: {
          providerId: result.providerId,
          modelId: result.modelId,
          promptProfileId: result.promptProfileId,
          fallbackUsed: result.fallbackUsed,
          failure: copyFailure(result.failure),
        },
        sceneDsl,
      });
      openCircuit ||= circuitFailure(result, plannerInfo);
    }
  } finally {
    guard.dispose();
  }

  throwIfAborted(signal);
  const sceneDslPlan = buildSemanticAnimationSceneDslPlanFromScenes({
    bindings: {
      semanticEventGraphHash: context.graph.contentHash,
      semanticVisualSentencePlanHash: context.sentencePlan.contentHash,
      draftHash: context.graph.draftHash,
      sourceStoryboardHash: context.graph.sourceStoryboardHash,
      timingContextHash: context.graph.timingContextHash,
    },
    planner: plannerInfo,
    scenes,
  });
  return validateSemanticAnimationSceneDslPlanAgainstContext(
    sceneDslPlan,
    {
      semanticEventGraph: context.graph,
      semanticVisualSentencePlan: context.sentencePlan,
    },
  );
}

const buildSemanticAnimationSceneDslPlan =
  planSemanticAnimationScenes;

module.exports = {
  DEFAULT_AGGREGATE_TIMEOUT_MS,
  MAX_AGGREGATE_TIMEOUT_MS,
  buildSemanticAnimationSceneDslPlan,
  planSemanticAnimationScenes,
};
