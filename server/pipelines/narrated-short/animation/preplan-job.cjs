"use strict";

const { AppError } = require("../../../errors.cjs");
const {
  contentHash,
  normalizeDraftBundle,
} = require("../contracts.cjs");
const { normalizeAlignment } = require("../narration/alignment.cjs");
const { buildProductionTimingContext } = require("./timing-context-builder.cjs");
const {
  compileProductionAnimation,
} = require("./production-plan-compiler.cjs");
const {
  SEMANTIC_SENTENCE_PROFILE_ID,
  SEMANTIC_SENTENCE_PROFILE_TOKEN,
} = require("./semantic-render-profile.cjs");
const {
  buildSemanticSentencePlanningContext,
} = require("./semantic-sentence-production-plan-compiler.cjs");
const {
  planSemanticAnimationScenes,
} = require("./semantic-animation-scene-plan-service.cjs");
const {
  createLocalLlmScenePlanner,
} = require("./providers/local-llm-scene-planner.cjs");
const {
  SCENE_PLAN_ARTIFACT_TYPE,
  readAnimationScenePlanArtifact,
} = require("./scene-plan-artifact.cjs");

function stale(field, reason = "binding_mismatch") {
  throw new AppError(
    "ANIMATION_PREPLAN_STALE",
    "The animation preplanning inputs are stale.",
    409,
    { field, reason },
  );
}

function unavailable() {
  throw new AppError(
    "PIPELINE_HANDLER_UNAVAILABLE",
    "Animation preplanning dependencies are unavailable.",
    503,
  );
}

function productionEnvironment(value) {
  return String(
    value || process.env.SHORTSENGINE_ENVIRONMENT || process.env.NODE_ENV || "development",
  ).trim().toLowerCase() === "production";
}

function exactActivePlan(active, expected) {
  return Boolean(
    active
    && active.status === "ready"
    && active.animationProfile === SEMANTIC_SENTENCE_PROFILE_TOKEN
    && active.projectRevision === expected.projectRevision
    && active.draftArtifactId === expected.draftArtifactId
    && active.draftHash === expected.draftHash
    && active.alignmentArtifactId === expected.alignmentArtifactId
    && active.alignmentHash === expected.alignmentHash
    && active.timingContextHash === expected.timingContextHash
    && active.semanticEventGraphHash === expected.semanticEventGraphHash
    && active.semanticVisualSentencePlanHash
      === expected.semanticVisualSentencePlanHash
    && active.plannerMode === expected.plannerMode
    && active.promptProfileId === expected.promptProfileId
    && active.plannerConfigurationHash
      === expected.plannerConfigurationHash
  );
}

function publicPlanSummary(active, options = {}) {
  return Object.freeze({
    required: true,
    artifactId: active.planArtifactId,
    contentHash: active.planHash,
    sceneCount: active.sceneCount,
    fallbackSceneCount: active.fallbackSceneCount,
    plannerMode: active.plannerMode,
    promptProfileId: active.promptProfileId,
    plannerConfigurationHash: active.plannerConfigurationHash,
    reused: options.reused === true,
  });
}

function preplanStateHash(project, approval) {
  return contentHash({
    projectId: project.id,
    projectRevision: project.input.revision,
    approval: approval
      ? {
        draftArtifactId: approval.draftArtifactId,
        draftHash: approval.draftHash,
        renderProfile: approval.renderProfile,
      }
      : null,
    activeNarration: project.input.activeNarration || null,
    activeAnimationScenePlan:
      project.input.activeAnimationScenePlan || null,
  });
}

async function runNarratedAnimationPreplanJob(context = {}) {
  const { jobs, job, project, payload = {}, dependencies = {} } = context;
  const contentArtifacts = dependencies.contentArtifactRepository;
  const approvals = dependencies.contentApprovalRepository;
  const projects = dependencies.projectRepository;
  if (!jobs || !job || !project || !contentArtifacts || !approvals || !projects) {
    unavailable();
  }
  if (
    payload.animationProfile !== SEMANTIC_SENTENCE_PROFILE_TOKEN
    || project.projectType !== "narrated_short"
    || project.input.revision !== payload.projectRevision
  ) stale("projectRevision");

  const approval = approvals.findApproved(project.id, project.input.revision);
  if (
    !approval
    || approval.draftArtifactId !== payload.approvedDraftArtifactId
    || approval.draftHash !== payload.approvedDraftHash
    || approval.renderProfile !== payload.renderProfile
  ) stale("approval");
  const activeNarration = project.input.activeNarration;
  if (
    !activeNarration
    || activeNarration.status !== "aligned"
    || activeNarration.aligned !== true
    || activeNarration.timingReady !== true
    || activeNarration.projectRevision !== payload.projectRevision
    || activeNarration.draftArtifactId !== payload.approvedDraftArtifactId
    || activeNarration.draftHash !== payload.approvedDraftHash
    || activeNarration.alignmentArtifactId !== payload.alignmentArtifactId
    || activeNarration.alignmentHash !== payload.alignmentHash
  ) stale("activeNarration");

  const draftEnvelope = contentArtifacts.readJson(
    payload.approvedDraftArtifactId,
  );
  const alignmentEnvelope = contentArtifacts.readJson(
    payload.alignmentArtifactId,
  );
  if (
    draftEnvelope.artifactType !== "approval_bundle"
    || alignmentEnvelope.artifactType !== "narration_alignment"
    || draftEnvelope.projectId !== project.id
    || alignmentEnvelope.projectId !== project.id
    || draftEnvelope.revision !== payload.projectRevision
    || alignmentEnvelope.revision !== payload.projectRevision
    || draftEnvelope.contentHash !== payload.approvedDraftHash
    || alignmentEnvelope.contentHash !== payload.alignmentHash
  ) stale("artifact");

  const draft = normalizeDraftBundle(draftEnvelope.body);
  const alignment = normalizeAlignment(alignmentEnvelope.body);
  const timingContext = (dependencies.buildProductionTimingContext
    || buildProductionTimingContext)({
    draft,
    alignment,
    projectId: project.id,
    projectRevision: project.input.revision,
    draftArtifactId: payload.approvedDraftArtifactId,
    draftHash: payload.approvedDraftHash,
    alignmentHash: payload.alignmentHash,
  });
  const source = (dependencies.buildSemanticSentencePlanningContext
    || buildSemanticSentencePlanningContext)({
    draft,
    timingContext,
    semanticProfileId: SEMANTIC_SENTENCE_PROFILE_ID,
  });

  if (source.semanticEventGraph.primitivePayloadProfileId === undefined) {
    jobs.complete(job, {
      step: "animation_preplan_not_required",
      animationScenePlan: Object.freeze({
        required: false,
        reason: "checked_profile",
      }),
    });
    return Object.freeze({
      required: false,
      timingContext,
      source,
      project,
    });
  }

  const planner = dependencies.scenePlanner || createLocalLlmScenePlanner({
    ...(dependencies.localLlmScenePlannerOptions || {}),
    env: dependencies.scenePlannerEnv || process.env,
  });
  const plannerHealth = planner.health();
  if (
    !plannerHealth
    || planner.mode !== plannerHealth.mode
    || typeof plannerHealth.configurationHash !== "string"
    || !/^[a-f0-9]{64}$/.test(plannerHealth.configurationHash)
    || !Number.isInteger(plannerHealth.aggregateTimeoutMs)
    || plannerHealth.aggregateTimeoutMs < 1000
    || plannerHealth.aggregateTimeoutMs > 10 * 60 * 1000
  ) {
    throw new AppError(
      "ANIMATION_LOCAL_LLM_CONFIG_INVALID",
      "The local animation scene planner configuration is invalid.",
      500,
      { field: "health" },
    );
  }
  if (
    productionEnvironment(dependencies.environment)
    && plannerHealth.mode === "mock"
  ) {
    throw new AppError(
      "ANIMATION_LOCAL_LLM_CONFIG_INVALID",
      "The local animation scene planner configuration is invalid.",
      500,
      { field: "mode" },
    );
  }
  if (
    payload.plannerMode !== plannerHealth.mode
    || payload.promptProfileId !== plannerHealth.promptProfileId
    || payload.plannerConfigurationHash !== plannerHealth.configurationHash
  ) stale("planner", "planner_configuration_changed");

  const expected = {
    projectRevision: project.input.revision,
    draftArtifactId: payload.approvedDraftArtifactId,
    draftHash: payload.approvedDraftHash,
    alignmentArtifactId: payload.alignmentArtifactId,
    alignmentHash: payload.alignmentHash,
    timingContextHash: timingContext.contentHash,
    semanticEventGraphHash: source.semanticEventGraph.contentHash,
    semanticVisualSentencePlanHash:
      source.semanticVisualSentencePlan.contentHash,
    plannerMode: plannerHealth.mode,
    promptProfileId: plannerHealth.promptProfileId,
    plannerConfigurationHash: plannerHealth.configurationHash,
  };
  const existing = project.input.activeAnimationScenePlan;
  if (exactActivePlan(existing, expected)) {
    const reused = readAnimationScenePlanArtifact({
      contentArtifactRepository: contentArtifacts,
      artifactId: existing.planArtifactId,
      artifactHash: existing.planHash,
      projectId: project.id,
      projectRevision: project.input.revision,
      draftHash: payload.approvedDraftHash,
      alignmentHash: payload.alignmentHash,
      timingContext,
      semanticEventGraph: source.semanticEventGraph,
      semanticVisualSentencePlan: source.semanticVisualSentencePlan,
      plannerMode: existing.plannerMode,
      promptProfileId: existing.promptProfileId,
      plannerConfigurationHash: existing.plannerConfigurationHash,
      sceneCount: existing.sceneCount,
      fallbackSceneCount: existing.fallbackSceneCount,
    });
    const summary = publicPlanSummary(existing, { reused: true });
    jobs.complete(job, {
      step: "animation_preplan_reused",
      animationScenePlan: summary,
    });
    return Object.freeze({
      required: true,
      artifact: Object.freeze({
        artifact: Object.freeze({ id: existing.planArtifactId }),
        envelope: reused.envelope,
      }),
      scenePlan: reused.scenePlan,
      timingContext,
      source,
      project,
      reused: true,
    });
  }

  const planningStateHash = preplanStateHash(project, approval);
  const projectId = project.id;
  const projectRevision = project.input.revision;

  jobs.update(job, { progress: 15, step: "plan_animation_scenes" });
  const scenePlan = await (dependencies.planSemanticAnimationScenes
    || planSemanticAnimationScenes)({
    semanticEventGraph: source.semanticEventGraph,
    semanticVisualSentencePlan: source.semanticVisualSentencePlan,
    planner,
    signal: job._controller?.signal,
  }, {
    ...(dependencies.scenePlanServiceOptions || {}),
    planner,
    signal: job._controller?.signal,
    aggregateTimeoutMs: plannerHealth.aggregateTimeoutMs,
  });
  if (
    scenePlan.planner?.plannerId !== planner.id
    || scenePlan.planner?.mode !== plannerHealth.mode
    || scenePlan.planner?.promptProfileId !== plannerHealth.promptProfileId
  ) stale("scenePlan.planner", "planner_identity_mismatch");

  const currentProject = projects.get(projectId);
  const currentApproval = approvals.findApproved(projectId, projectRevision);
  if (
    !currentProject
    || preplanStateHash(currentProject, currentApproval) !== planningStateHash
  ) stale("project", "project_changed_during_planning");

  jobs.update(job, { progress: 75, step: "validate_animation_preplan" });
  const compiled = (dependencies.compileProductionAnimation
    || compileProductionAnimation)({
    draft,
    timingContext,
    projectId,
    projectRevision,
    renderProfile: payload.renderProfile,
    animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
    semanticAnimationSceneDslPlan: scenePlan,
  });
  if (
    compiled.animationIR.content.semanticAnimationSceneDslPlan.contentHash
      !== scenePlan.contentHash
  ) stale("scenePlan", "compiler_binding_mismatch");

  jobs.update(job, { progress: 90, step: "persist_animation_preplan" });
  const artifact = contentArtifacts.createJson({
    type: SCENE_PLAN_ARTIFACT_TYPE,
    projectId,
    jobId: job.id,
    revision: projectRevision,
    dependencyHashes: [
      payload.approvedDraftHash,
      payload.alignmentHash,
      timingContext.contentHash,
      source.semanticEventGraph.contentHash,
      source.semanticVisualSentencePlan.contentHash,
      plannerHealth.configurationHash,
    ],
    body: scenePlan,
  });
  if (artifact.envelope.contentHash !== scenePlan.contentHash) {
    stale("scenePlan", "artifact_hash_mismatch");
  }
  const active = {
    status: "ready",
    animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
    projectRevision,
    planArtifactId: artifact.artifact.id,
    planHash: artifact.envelope.contentHash,
    draftArtifactId: payload.approvedDraftArtifactId,
    draftHash: payload.approvedDraftHash,
    alignmentArtifactId: payload.alignmentArtifactId,
    alignmentHash: payload.alignmentHash,
    timingContextHash: timingContext.contentHash,
    semanticEventGraphHash: source.semanticEventGraph.contentHash,
    semanticVisualSentencePlanHash:
      source.semanticVisualSentencePlan.contentHash,
    plannerMode: plannerHealth.mode,
    promptProfileId: plannerHealth.promptProfileId,
    plannerConfigurationHash: plannerHealth.configurationHash,
    sceneCount: scenePlan.summary.sceneCount,
    fallbackSceneCount: scenePlan.summary.fallbackSceneCount,
  };
  const updatedProject = projects.update(projectId, {
    input: {
      ...currentProject.input,
      activeAnimationScenePlan: active,
    },
  });
  if (
    dependencies.persistenceAdapter
    && typeof dependencies.persistenceAdapter.persistProject === "function"
  ) dependencies.persistenceAdapter.persistProject({ project: updatedProject });

  const summary = publicPlanSummary(
    updatedProject.input.activeAnimationScenePlan,
  );
  jobs.complete(job, {
    step: "animation_preplan_ready",
    animationScenePlan: summary,
  });
  return Object.freeze({
    required: true,
    artifact,
    scenePlan,
    timingContext,
    source,
    compiled: Object.freeze({
      animationPlanHash: contentHash(compiled.plan),
      animationIRHash: compiled.animationIR.contentHash,
    }),
    project: updatedProject,
    reused: false,
  });
}

module.exports = {
  runNarratedAnimationPreplanJob,
};
