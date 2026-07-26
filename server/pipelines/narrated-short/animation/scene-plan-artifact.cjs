"use strict";

const { AppError } = require("../../../errors.cjs");
const {
  validateSemanticAnimationSceneDslPlanAgainstContext,
} = require("./semantic-animation-scene-dsl-plan.cjs");
const {
  SEMANTIC_SENTENCE_PROFILE_ID,
  SEMANTIC_SENTENCE_PROFILE_TOKEN,
} = require("./semantic-render-profile.cjs");
const {
  buildSemanticSentencePlanningContext,
} = require("./semantic-sentence-production-plan-compiler.cjs");

const SCENE_PLAN_ARTIFACT_TYPE = "animation_scene_dsl_plan";

function invalid(field, reason = "invalid") {
  throw new AppError(
    "ANIMATION_SCENE_PLAN_ARTIFACT_INVALID",
    "The persisted animation scene plan is invalid or stale.",
    409,
    { field, reason },
  );
}

function preplanRequired(reason = "missing") {
  throw new AppError(
    "ANIMATION_PREPLAN_REQUIRED",
    "Animation preplanning must complete before this render can be queued.",
    409,
    { reason },
  );
}

function requireHash(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    invalid(field, "hash_required");
  }
  return value;
}

function readAnimationScenePlanArtifact(input = {}) {
  const contentArtifacts = input.contentArtifactRepository;
  if (!contentArtifacts || typeof contentArtifacts.readJson !== "function") {
    invalid("contentArtifactRepository", "repository_required");
  }
  if (typeof input.artifactId !== "string" || !input.artifactId) {
    invalid("artifactId", "artifact_id_required");
  }
  const artifactHash = requireHash(input.artifactHash, "artifactHash");
  const envelope = contentArtifacts.readJson(input.artifactId);
  if (
    envelope.artifactType !== SCENE_PLAN_ARTIFACT_TYPE
    || envelope.projectId !== input.projectId
    || envelope.revision !== input.projectRevision
    || envelope.contentHash !== artifactHash
    || envelope.body?.contentHash !== artifactHash
  ) invalid("artifact", "envelope_binding_mismatch");

  const requiredDependencies = [
    requireHash(input.draftHash, "draftHash"),
    requireHash(input.alignmentHash, "alignmentHash"),
    requireHash(input.timingContext.contentHash, "timingContext.contentHash"),
    requireHash(
      input.semanticEventGraph.contentHash,
      "semanticEventGraph.contentHash",
    ),
    requireHash(
      input.semanticVisualSentencePlan.contentHash,
      "semanticVisualSentencePlan.contentHash",
    ),
    requireHash(
      input.plannerConfigurationHash,
      "plannerConfigurationHash",
    ),
  ];
  const expectedDependencies = [...new Set(requiredDependencies)].sort();
  const dependencies = [...new Set(envelope.dependencyHashes || [])].sort();
  if (
    dependencies.length !== expectedDependencies.length
    || dependencies.some((hash, index) => hash !== expectedDependencies[index])
  ) {
    invalid("artifact.dependencyHashes", "context_dependency_missing");
  }

  const scenePlan = validateSemanticAnimationSceneDslPlanAgainstContext(
    envelope.body,
    {
      semanticEventGraph: input.semanticEventGraph,
      semanticVisualSentencePlan: input.semanticVisualSentencePlan,
    },
  );
  if (
    scenePlan.bindings.draftHash !== input.draftHash
    || scenePlan.bindings.timingContextHash !== input.timingContext.contentHash
    || scenePlan.planner.mode !== input.plannerMode
    || scenePlan.planner.promptProfileId !== input.promptProfileId
    || scenePlan.summary.sceneCount !== input.sceneCount
    || scenePlan.summary.fallbackSceneCount !== input.fallbackSceneCount
  ) invalid("artifact.body.bindings", "source_binding_mismatch");

  return Object.freeze({ envelope, scenePlan });
}

function resolveAnimationScenePlanBinding(input = {}) {
  const source = (input.buildSemanticSentencePlanningContext
    || buildSemanticSentencePlanningContext)({
    draft: input.draft,
    timingContext: input.timingContext,
    semanticProfileId: SEMANTIC_SENTENCE_PROFILE_ID,
  });
  const generalized =
    source.semanticEventGraph.primitivePayloadProfileId !== undefined;
  const artifactId = input.artifactId || null;
  const artifactHash = input.artifactHash || null;
  if (!generalized) {
    if (artifactId !== null || artifactHash !== null) {
      invalid("artifact", "checked_profile_forbids_scene_plan");
    }
    return Object.freeze({ source, scenePlan: null, generalized: false });
  }
  if ((artifactId === null) !== (artifactHash === null)) {
    invalid("artifact", "artifact_pair_required");
  }
  if (artifactId === null) {
    if (input.requirePersisted === true) {
      preplanRequired();
    }
    return Object.freeze({ source, scenePlan: null, generalized: true });
  }

  const active = input.project?.input?.activeAnimationScenePlan;
  if (
    !active
    || active.status !== "ready"
    || active.animationProfile !== SEMANTIC_SENTENCE_PROFILE_TOKEN
    || active.projectRevision !== input.projectRevision
    || active.planArtifactId !== artifactId
    || active.planHash !== artifactHash
    || active.draftArtifactId !== input.draftArtifactId
    || active.draftHash !== input.draftHash
    || active.alignmentArtifactId !== input.alignmentArtifactId
    || active.alignmentHash !== input.alignmentHash
    || active.timingContextHash !== input.timingContext.contentHash
    || active.semanticEventGraphHash
      !== source.semanticEventGraph.contentHash
    || active.semanticVisualSentencePlanHash
      !== source.semanticVisualSentencePlan.contentHash
  ) invalid("project.input.activeAnimationScenePlan", "active_binding_mismatch");
  const expectedPlanner = input.expectedPlanner || null;
  if (
    expectedPlanner
    && (
      active.plannerMode !== expectedPlanner.mode
      || active.promptProfileId !== expectedPlanner.promptProfileId
      || active.plannerConfigurationHash
        !== expectedPlanner.configurationHash
    )
  ) preplanRequired("planner_configuration_changed");

  const resolved = readAnimationScenePlanArtifact({
    contentArtifactRepository: input.contentArtifactRepository,
    artifactId,
    artifactHash,
    projectId: input.project.id,
    projectRevision: input.projectRevision,
    draftHash: input.draftHash,
    alignmentHash: input.alignmentHash,
    timingContext: input.timingContext,
    semanticEventGraph: source.semanticEventGraph,
    semanticVisualSentencePlan: source.semanticVisualSentencePlan,
    plannerMode: active.plannerMode,
    promptProfileId: active.promptProfileId,
    plannerConfigurationHash: active.plannerConfigurationHash,
    sceneCount: active.sceneCount,
    fallbackSceneCount: active.fallbackSceneCount,
  });
  return Object.freeze({
    source,
    scenePlan: resolved.scenePlan,
    envelope: resolved.envelope,
    generalized: true,
  });
}

module.exports = {
  SCENE_PLAN_ARTIFACT_TYPE,
  readAnimationScenePlanArtifact,
  resolveAnimationScenePlanBinding,
};
