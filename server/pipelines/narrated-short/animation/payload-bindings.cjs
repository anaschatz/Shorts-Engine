const { AppError } = require("../../../errors.cjs");
const { normalizeDraftBundle, contentHash } = require("../contracts.cjs");
const { normalizeAlignment } = require("../narration/alignment.cjs");
const { buildProductionTimingContext } = require("./timing-context-builder.cjs");
const { compileProductionAnimation, PRODUCTION_PROVIDER_ID, PRODUCTION_RUNTIME_VERSION } = require("./production-plan-compiler.cjs");
const { SEMANTIC_SENTENCE_PROFILE_TOKEN } = require("./semantic-render-profile.cjs");
const {
  resolveAnimationScenePlanBinding,
} = require("./scene-plan-artifact.cjs");

function explicitAnimationProfile(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value !== SEMANTIC_SENTENCE_PROFILE_TOKEN) {
    throw new AppError("ANIMATION_PROFILE_INVALID", "The requested production animation profile is unsupported.", 409, { field: "animationProfile" });
  }
  return SEMANTIC_SENTENCE_PROFILE_TOKEN;
}

function buildProductionAnimationPayloadBindings({ project, approval, renderProfile, animationProfile: requestedAnimationProfile, contentArtifacts }, dependencies = {}) {
  const animationProfile = explicitAnimationProfile(requestedAnimationProfile);
  const active = project && project.input && project.input.activeNarration;
  if (!active || !active.alignmentArtifactId || !contentArtifacts) return {};
  const draft = normalizeDraftBundle(contentArtifacts.readJson(approval.draftArtifactId).body);
  if (draft.verticalId !== "dark_curiosity") return {};
  const alignment = normalizeAlignment(contentArtifacts.readJson(active.alignmentArtifactId).body);
  const timingBuilder = dependencies.buildProductionTimingContext || buildProductionTimingContext;
  const compiler = dependencies.compileProductionAnimation || compileProductionAnimation;
  const timingContext = timingBuilder({ draft, alignment, projectId: project.id, projectRevision: project.input.revision, draftArtifactId: approval.draftArtifactId, draftHash: approval.draftHash, alignmentHash: active.alignmentHash });
  const activeScenePlan = animationProfile
    ? project.input.activeAnimationScenePlan
    : null;
  const scenePlanBinding = animationProfile
    ? resolveAnimationScenePlanBinding({
      project,
      projectRevision: project.input.revision,
      draft,
      timingContext,
      draftArtifactId: approval.draftArtifactId,
      draftHash: approval.draftHash,
      alignmentArtifactId: active.alignmentArtifactId,
      alignmentHash: active.alignmentHash,
      artifactId: activeScenePlan?.planArtifactId || null,
      artifactHash: activeScenePlan?.planHash || null,
      contentArtifactRepository: contentArtifacts,
      requirePersisted:
        dependencies.requirePersistedScenePlan === true,
      expectedPlanner: dependencies.expectedScenePlanner || null,
      buildSemanticSentencePlanningContext:
        dependencies.buildSemanticSentencePlanningContext,
    })
    : null;
  const animation = compiler({
    draft,
    timingContext,
    projectId: project.id,
    projectRevision: project.input.revision,
    renderProfile,
    ...(animationProfile ? { animationProfile } : {}),
    ...(scenePlanBinding?.scenePlan
      ? { semanticAnimationSceneDslPlan: scenePlanBinding.scenePlan }
      : {}),
  });
  const bindings = { timingContextHash: timingContext.contentHash, animationPlanHash: contentHash(animation.plan), animationIRHash: animation.animationIR.contentHash, animationProvider: PRODUCTION_PROVIDER_ID, animationRuntimeVersion: PRODUCTION_RUNTIME_VERSION, animationStyleVersion: animation.animationIR.renderer.styleVersion };
  if (animationProfile) bindings.animationProfile = animationProfile;
  if (scenePlanBinding?.scenePlan) {
    bindings.animationScenePlanArtifactId = activeScenePlan.planArtifactId;
    bindings.animationScenePlanHash = activeScenePlan.planHash;
  }
  return Object.freeze(bindings);
}

module.exports = { buildProductionAnimationPayloadBindings };
