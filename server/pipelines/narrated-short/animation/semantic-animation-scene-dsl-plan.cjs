"use strict";

const { createHash } = require("node:crypto");

const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  MAX_SCENE_COST,
  buildSemanticAnimationSceneDsl,
  normalizeSemanticAnimationSceneDsl,
  validateSemanticAnimationSceneDslAgainstContext,
} = require("./semantic-animation-scene-dsl.cjs");
const {
  SEMANTIC_ANIMATION_SCENE_PLANNER_PROMPT_PROFILE_ID,
  deterministicSemanticAnimationSceneProposalForContext,
} = require("./semantic-animation-scene-defaults.cjs");
const {
  normalizeSemanticEventGraph,
} = require("./semantic-event-validator.cjs");
const {
  validateSemanticVisualSentencePlanAgainstGraph,
} = require("./semantic-visual-sentence-planner.cjs");
const {
  SEMANTIC_SENTENCE_MAX_TOTAL_SENTENCES,
} = require("./semantic-render-profile.cjs");

const SEMANTIC_ANIMATION_SCENE_DSL_PLAN_SCHEMA_VERSION = 1;
const SEMANTIC_ANIMATION_SCENE_DSL_PLAN_PROFILE_ID =
  "dark_curiosity_animation_scene_dsl_plan_v1";
const DETERMINISTIC_SCENE_PLANNER_ID =
  "deterministic_semantic_scene_planner";
const DETERMINISTIC_SCENE_PLANNER_MODE = "deterministic";
const DETERMINISTIC_SCENE_PROVIDER_ID = "deterministic_scene_planner";
const DETERMINISTIC_SCENE_MODEL_ID = "deterministic-scene-planner-v1";
const MAX_SCENES = SEMANTIC_SENTENCE_MAX_TOTAL_SENTENCES;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z][a-z0-9_-]{1,159}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,159}$/;

function fail(field, reason = "invalid") {
  throw new AppError(
    "ANIMATION_SCENE_DSL_PLAN_INVALID",
    "The animation scene DSL plan is invalid or is not grounded in its semantic sentence plan.",
    409,
    { field, reason },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, field, optional = []) {
  if (!isPlainObject(value)) fail(field, "object_required");
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.some((key) => typeof key !== "string")) {
    fail(`${field}.*`, "unsupported_field");
  }
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) fail(`${field}.*`, "plain_data_field_required");
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of actualKeys) {
    if (!allowed.has(key)) fail(`${field}.*`, "unsupported_field");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(`${field}.${key}`, "field_required");
    }
  }
}

function text(value, field, options = {}) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > (options.maximum || 160)
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)
    || (options.pattern && !options.pattern.test(value))
  ) fail(field, "bounded_safe_text_required");
  return value;
}

function hash(value, field) {
  return text(value, field, { maximum: 64, pattern: HASH_PATTERN });
}

function identifier(value, field) {
  return text(value, field, { maximum: 160, pattern: ID_PATTERN });
}

function modelIdentifier(value, field) {
  return text(value, field, {
    maximum: 160,
    pattern: MODEL_ID_PATTERN,
  });
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(field, "integer_out_of_range");
  }
  return value;
}

function boolean(value, field) {
  if (typeof value !== "boolean") fail(field, "boolean_required");
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function canonicalHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function same(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function semanticAnimationSceneDslPlanContentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return canonicalHash(copy);
}

function normalizeBindings(input) {
  exactKeys(input, [
    "semanticEventGraphHash",
    "semanticVisualSentencePlanHash",
    "draftHash",
    "sourceStoryboardHash",
    "timingContextHash",
  ], "sceneDslPlan.bindings");
  return {
    semanticEventGraphHash: hash(
      input.semanticEventGraphHash,
      "sceneDslPlan.bindings.semanticEventGraphHash",
    ),
    semanticVisualSentencePlanHash: hash(
      input.semanticVisualSentencePlanHash,
      "sceneDslPlan.bindings.semanticVisualSentencePlanHash",
    ),
    draftHash: hash(
      input.draftHash,
      "sceneDslPlan.bindings.draftHash",
    ),
    sourceStoryboardHash: hash(
      input.sourceStoryboardHash,
      "sceneDslPlan.bindings.sourceStoryboardHash",
    ),
    timingContextHash: hash(
      input.timingContextHash,
      "sceneDslPlan.bindings.timingContextHash",
    ),
  };
}

function normalizePlanner(input) {
  exactKeys(input, [
    "plannerId",
    "mode",
    "promptProfileId",
  ], "sceneDslPlan.planner");
  return {
    plannerId: identifier(
      input.plannerId,
      "sceneDslPlan.planner.plannerId",
    ),
    mode: identifier(input.mode, "sceneDslPlan.planner.mode"),
    promptProfileId: identifier(
      input.promptProfileId,
      "sceneDslPlan.planner.promptProfileId",
    ),
  };
}

function normalizeFailure(input, field) {
  if (input === null) return null;
  exactKeys(input, ["code", "phase", "retryable"], field);
  return {
    code: text(input.code, `${field}.code`, {
      maximum: 160,
      pattern: FAILURE_CODE_PATTERN,
    }),
    phase: identifier(input.phase, `${field}.phase`),
    retryable: boolean(input.retryable, `${field}.retryable`),
  };
}

function normalizeProvenance(input, field, planner) {
  exactKeys(input, [
    "providerId",
    "modelId",
    "promptProfileId",
    "fallbackUsed",
    "failure",
  ], field);
  const promptProfileId = identifier(
    input.promptProfileId,
    `${field}.promptProfileId`,
  );
  if (promptProfileId !== planner.promptProfileId) {
    fail(`${field}.promptProfileId`, "planner_prompt_profile_mismatch");
  }
  const fallbackUsed = boolean(
    input.fallbackUsed,
    `${field}.fallbackUsed`,
  );
  const failure = normalizeFailure(input.failure, `${field}.failure`);
  if ((failure !== null) !== fallbackUsed) {
    fail(`${field}.failure`, "fallback_failure_pair_required");
  }
  return {
    providerId: identifier(input.providerId, `${field}.providerId`),
    modelId: modelIdentifier(input.modelId, `${field}.modelId`),
    promptProfileId,
    fallbackUsed,
    failure,
  };
}

function normalizeScene(input, index, bindings, planner) {
  const field = `sceneDslPlan.scenes[${index}]`;
  exactKeys(input, ["propositionId", "provenance", "sceneDsl"], field);
  const propositionId = identifier(
    input.propositionId,
    `${field}.propositionId`,
  );
  const sceneDsl = normalizeSemanticAnimationSceneDsl(input.sceneDsl, {
    // Structural normalization cannot infer trusted route geometry. The
    // contextual validator below proves route actions against the sentence.
    hasApprovedRoute: true,
  });
  if (
    sceneDsl.bindings.semanticEventGraphHash
      !== bindings.semanticEventGraphHash
    || sceneDsl.bindings.semanticVisualSentencePlanHash
      !== bindings.semanticVisualSentencePlanHash
  ) fail(`${field}.sceneDsl.bindings`, "aggregate_binding_mismatch");
  if (sceneDsl.bindings.propositionId !== propositionId) {
    fail(`${field}.sceneDsl.bindings.propositionId`, "proposition_binding_mismatch");
  }
  return {
    propositionId,
    provenance: normalizeProvenance(
      input.provenance,
      `${field}.provenance`,
      planner,
    ),
    sceneDsl,
  };
}

function expectedSummary(scenes) {
  const providerIds = [...new Set(
    scenes.map((scene) => scene.provenance.providerId),
  )].sort();
  return {
    sceneCount: scenes.length,
    fallbackSceneCount: scenes.filter(
      (scene) => scene.provenance.fallbackUsed,
    ).length,
    totalComputedCost: scenes.reduce(
      (sum, scene) => sum + scene.sceneDsl.computedCost,
      0,
    ),
    maximumSceneCost: Math.max(
      ...scenes.map((scene) => scene.sceneDsl.computedCost),
    ),
    providerIds,
  };
}

function normalizeSummary(input, scenes) {
  exactKeys(input, [
    "sceneCount",
    "fallbackSceneCount",
    "totalComputedCost",
    "maximumSceneCost",
    "providerIds",
  ], "sceneDslPlan.summary");
  if (
    !Array.isArray(input.providerIds)
    || input.providerIds.length < 1
    || input.providerIds.length > scenes.length
  ) fail("sceneDslPlan.summary.providerIds", "array_size_invalid");
  const providerIds = input.providerIds.map((providerId, index) => identifier(
    providerId,
    `sceneDslPlan.summary.providerIds[${index}]`,
  ));
  if (
    new Set(providerIds).size !== providerIds.length
    || !same(providerIds, [...providerIds].sort())
  ) fail("sceneDslPlan.summary.providerIds", "canonical_unique_array_required");
  const normalized = {
    sceneCount: integer(
      input.sceneCount,
      "sceneDslPlan.summary.sceneCount",
      1,
      MAX_SCENES,
    ),
    fallbackSceneCount: integer(
      input.fallbackSceneCount,
      "sceneDslPlan.summary.fallbackSceneCount",
      0,
      MAX_SCENES,
    ),
    totalComputedCost: integer(
      input.totalComputedCost,
      "sceneDslPlan.summary.totalComputedCost",
      1,
      MAX_SCENES * MAX_SCENE_COST,
    ),
    maximumSceneCost: integer(
      input.maximumSceneCost,
      "sceneDslPlan.summary.maximumSceneCost",
      1,
      MAX_SCENE_COST,
    ),
    providerIds,
  };
  if (!same(normalized, expectedSummary(scenes))) {
    fail("sceneDslPlan.summary", "derived_summary_mismatch");
  }
  return normalized;
}

function normalizeSemanticAnimationSceneDslPlan(input) {
  exactKeys(input, [
    "schemaVersion",
    "profileId",
    "bindings",
    "planner",
    "scenes",
    "summary",
  ], "sceneDslPlan", ["contentHash"]);
  if (input.schemaVersion !== SEMANTIC_ANIMATION_SCENE_DSL_PLAN_SCHEMA_VERSION) {
    fail("sceneDslPlan.schemaVersion", "unsupported_schema");
  }
  if (input.profileId !== SEMANTIC_ANIMATION_SCENE_DSL_PLAN_PROFILE_ID) {
    fail("sceneDslPlan.profileId", "unsupported_profile");
  }
  const bindings = normalizeBindings(input.bindings);
  const planner = normalizePlanner(input.planner);
  if (
    !Array.isArray(input.scenes)
    || input.scenes.length < 1
    || input.scenes.length > MAX_SCENES
  ) fail("sceneDslPlan.scenes", "array_size_invalid");
  const scenes = input.scenes.map(
    (scene, index) => normalizeScene(
      scene,
      index,
      bindings,
      planner,
    ),
  );
  if (
    new Set(scenes.map((scene) => scene.propositionId)).size
      !== scenes.length
  ) fail("sceneDslPlan.scenes", "duplicate_proposition_ids");
  const summary = normalizeSummary(input.summary, scenes);
  const normalized = {
    schemaVersion: SEMANTIC_ANIMATION_SCENE_DSL_PLAN_SCHEMA_VERSION,
    profileId: SEMANTIC_ANIMATION_SCENE_DSL_PLAN_PROFILE_ID,
    bindings,
    planner,
    scenes,
    summary,
  };
  const contentHash = semanticAnimationSceneDslPlanContentHash(normalized);
  if (input.contentHash !== undefined) {
    hash(input.contentHash, "sceneDslPlan.contentHash");
    if (input.contentHash !== contentHash) {
      fail("sceneDslPlan.contentHash", "content_hash_mismatch");
    }
  }
  return deepFreeze({ ...normalized, contentHash });
}

function normalizeContext(input) {
  if (!isPlainObject(input)) fail("context", "object_required");
  exactKeys(input, [
    "semanticEventGraph",
    "semanticVisualSentencePlan",
  ], "context");
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
  ) fail("context.semanticVisualSentencePlan", "composed_sentence_plan_required");
  return { graph, sentencePlan };
}

function expectedBindingsForContext(context) {
  return {
    semanticEventGraphHash: context.graph.contentHash,
    semanticVisualSentencePlanHash: context.sentencePlan.contentHash,
    draftHash: context.graph.draftHash,
    sourceStoryboardHash: context.graph.sourceStoryboardHash,
    timingContextHash: context.graph.timingContextHash,
  };
}

function validateSemanticAnimationSceneDslPlanAgainstContext(
  input,
  contextInput,
) {
  const context = normalizeContext(contextInput);
  const plan = normalizeSemanticAnimationSceneDslPlan(input);
  if (!same(plan.bindings, expectedBindingsForContext(context))) {
    fail("sceneDslPlan.bindings", "semantic_context_binding_mismatch");
  }
  const propositionIds = context.sentencePlan.sentences.map(
    (sentence) => sentence.propositionId,
  );
  if (
    !same(
      plan.scenes.map((scene) => scene.propositionId),
      propositionIds,
    )
  ) fail("sceneDslPlan.scenes", "narration_order_coverage_mismatch");
  plan.scenes.forEach((scene, index) => {
    const sentence = context.sentencePlan.sentences[index];
    validateSemanticAnimationSceneDslAgainstContext(scene.sceneDsl, {
      semanticEventGraphHash: context.graph.contentHash,
      semanticVisualSentencePlanHash: context.sentencePlan.contentHash,
      propositionId: sentence.propositionId,
      primitiveParameters: sentence.primitiveParameters,
      sceneComposition: sentence.sceneComposition,
    });
  });
  return plan;
}

function buildSemanticAnimationSceneDslPlanFromScenes(input = {}) {
  const scenes = Array.isArray(input.scenes) ? input.scenes : [];
  return normalizeSemanticAnimationSceneDslPlan({
    schemaVersion: SEMANTIC_ANIMATION_SCENE_DSL_PLAN_SCHEMA_VERSION,
    profileId: SEMANTIC_ANIMATION_SCENE_DSL_PLAN_PROFILE_ID,
    bindings: input.bindings,
    planner: input.planner,
    scenes,
    summary: expectedSummary(scenes),
  });
}

function buildDeterministicSemanticAnimationSceneDslPlan(input = {}) {
  const context = normalizeContext(input);
  const bindings = expectedBindingsForContext(context);
  const planner = {
    plannerId: DETERMINISTIC_SCENE_PLANNER_ID,
    mode: DETERMINISTIC_SCENE_PLANNER_MODE,
    promptProfileId:
      SEMANTIC_ANIMATION_SCENE_PLANNER_PROMPT_PROFILE_ID,
  };
  const scenes = context.sentencePlan.sentences.map((sentence) => {
    const proposal =
      deterministicSemanticAnimationSceneProposalForContext({
        sentence,
        hasApprovedRoute:
          sentence.primitiveParameters.geometry.route !== null,
      });
    return {
      propositionId: sentence.propositionId,
      provenance: {
        providerId: DETERMINISTIC_SCENE_PROVIDER_ID,
        modelId: DETERMINISTIC_SCENE_MODEL_ID,
        promptProfileId: planner.promptProfileId,
        fallbackUsed: false,
        failure: null,
      },
      sceneDsl: buildSemanticAnimationSceneDsl({
        semanticEventGraphHash: context.graph.contentHash,
        semanticVisualSentencePlanHash:
          context.sentencePlan.contentHash,
        propositionId: sentence.propositionId,
        primitiveParameters: sentence.primitiveParameters,
        sceneComposition: sentence.sceneComposition,
        proposal,
      }),
    };
  });
  return validateSemanticAnimationSceneDslPlanAgainstContext(
    buildSemanticAnimationSceneDslPlanFromScenes({
      bindings,
      planner,
      scenes,
    }),
    {
      semanticEventGraph: context.graph,
      semanticVisualSentencePlan: context.sentencePlan,
    },
  );
}

module.exports = {
  DETERMINISTIC_SCENE_MODEL_ID,
  DETERMINISTIC_SCENE_PLANNER_ID,
  DETERMINISTIC_SCENE_PLANNER_MODE,
  DETERMINISTIC_SCENE_PROVIDER_ID,
  MAX_SCENES,
  SEMANTIC_ANIMATION_SCENE_DSL_PLAN_PROFILE_ID,
  SEMANTIC_ANIMATION_SCENE_DSL_PLAN_SCHEMA_VERSION,
  buildDeterministicSemanticAnimationSceneDslPlan,
  buildSemanticAnimationSceneDslPlanFromScenes,
  normalizeSemanticAnimationSceneDslPlan,
  semanticAnimationSceneDslPlanContentHash,
  validateSemanticAnimationSceneDslPlanAgainstContext,
};
