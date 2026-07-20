"use strict";

const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const {
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
  const scenes = [];

  for (const sentence of context.sentencePlan.sentences) {
    throwIfAborted(signal);
    const result = await planner.planScene({
      semanticEventGraph: context.graph,
      semanticVisualSentencePlan: context.sentencePlan,
      propositionId: sentence.propositionId,
      signal,
    });
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
  buildSemanticAnimationSceneDslPlan,
  planSemanticAnimationScenes,
};
