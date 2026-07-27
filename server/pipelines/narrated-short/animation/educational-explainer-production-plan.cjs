"use strict";

const { contentHash } = require("../contracts.cjs");
const {
  SEMANTIC_SENTENCE_PROFILE_ID,
} = require("./semantic-render-profile.cjs");
const {
  buildSemanticSentenceProductionAnimationPlan,
} = require("./semantic-sentence-production-plan-compiler.cjs");
const {
  EDUCATIONAL_EXPLAINER_PROFILE_VERSION,
  EDUCATIONAL_EXPLAINER_RENDERER,
  EDUCATIONAL_EXPLAINER_SCHEMA_VERSION,
  EDUCATIONAL_EXPLAINER_TEMPLATE_ID,
  EDUCATIONAL_EXPLAINER_TEMPLATE_VERSION,
  buildEducationalExplainerArtifacts,
} = require("./educational-explainer-profile.cjs");

function buildEducationalExplainerProductionAnimationPlan(input = {}) {
  const base = buildSemanticSentenceProductionAnimationPlan({
    ...input,
    semanticProfileId: SEMANTIC_SENTENCE_PROFILE_ID,
  });
  const artifacts = buildEducationalExplainerArtifacts({
    draft: input.draft,
    timingContext: input.timingContext,
    sentencePlan: base.content.semanticVisualSentencePlan,
  });
  const persistentEntities = [
    {
      id: "promise_header",
      type: "promise_header",
      role: "narrative_promise",
      layer: 9,
      styleToken: "persistent_promise",
      text: artifacts.directorPlan.promise.title,
    },
    {
      id: "story_thread",
      type: "story_thread",
      role: "cross_scene_continuity",
      layer: 3,
      styleToken: "line_art_thread",
    },
  ];
  const scenes = base.scenes.map((scene) => ({
    ...scene,
    template: EDUCATIONAL_EXPLAINER_TEMPLATE_ID,
    templateVersion: EDUCATIONAL_EXPLAINER_TEMPLATE_VERSION,
    entityIds: [...scene.entityIds, "promise_header", "story_thread"],
  }));
  const transitions = scenes.slice(0, -1).map((scene, index) => ({
    fromSceneId: scene.id,
    toSceneId: scenes[index + 1].id,
    sharedEntityId: "story_thread",
    startFrame: Math.max(scene.startFrame, scene.endFrame - 8),
    endFrame: scene.endFrame,
  }));
  const educationalExplainer = {
    schemaVersion: 1,
    styleSpecId: artifacts.referenceStyleSpec.id,
    referenceStyleSpec: artifacts.referenceStyleSpec,
    narrativeBeatGraph: artifacts.narrativeBeatGraph,
    directorPlan: artifacts.directorPlan,
    audioIR: artifacts.audioIR,
    assetManifest: artifacts.assetManifest,
  };
  return {
    ...base,
    schemaVersion: EDUCATIONAL_EXPLAINER_SCHEMA_VERSION,
    profileVersion: EDUCATIONAL_EXPLAINER_PROFILE_VERSION,
    assetManifestHash: artifacts.assetManifest.contentHash,
    renderer: { ...EDUCATIONAL_EXPLAINER_RENDERER },
    seed: Number.parseInt(contentHash({
      directorPlanHash: artifacts.directorPlan.contentHash,
      projectId: input.projectId,
      projectRevision: input.projectRevision,
    }).slice(0, 8), 16) >>> 0,
    content: {
      ...base.content,
      compositionId: `edu_${artifacts.directorPlan.contentHash.slice(0, 24)}`,
      kicker: "VISUAL EXPLAINER",
      educationalExplainer,
    },
    sharedEntities: [...base.sharedEntities, ...persistentEntities],
    scenes,
    transitions,
    motionBudget: {
      profile: "calm_explainer",
      maxCost: Math.max(20, base.sharedEntities.length + transitions.length),
      maxConcurrentOperations: 2,
      maxCameraScale: 1.12,
      maxTravelPxPerFrame: 10,
      captionSafeZone: { topRatio: 0.76, bottomRatio: 1 },
    },
  };
}

module.exports = { buildEducationalExplainerProductionAnimationPlan };
