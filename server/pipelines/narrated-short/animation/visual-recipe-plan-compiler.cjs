"use strict";

const { normalizeStoryIR } = require("./story-ir.cjs");
const { normalizeAnimationTimingContext } = require("./timing-contract.cjs");
const { normalizeVisualProgramV1 } = require("./visual-program-contract.cjs");
const { VISUAL_RECIPE_REGISTRY_HASH, findVisualRecipe } = require("./visual-recipe-registry.cjs");
const {
  VISUAL_LAYOUT_PROFILE_ID,
  VISUAL_LAYOUT_PROFILE_VERSION,
  compileEngineOwnedLayout,
  deriveNarrationPhases,
} = require("./visual-layout-engine.cjs");
const {
  VISUAL_RECIPE_PLAN_PROFILE_ID,
  VISUAL_RECIPE_PLAN_PROFILE_VERSION,
  VISUAL_RECIPE_PLAN_SCHEMA_VERSION,
  normalizeVisualRecipePlanV1,
  visualRecipePlanContentHash,
} = require("./visual-recipe-plan-contract.cjs");

function groundingFor(beats, recipeId) {
  const first = beats[0];
  const rank = { verified: 0, qualified: 1, disputed: 2 };
  return {
    heading: first.source.heading,
    primaryLabel: first.source.primaryLabel,
    secondaryLabel: first.source.secondaryLabel,
    onScreenText: first.source.onScreenText,
    claimIds: [...new Set(beats.flatMap((beat) => beat.claimIds))].slice(0, 8),
    certainty: beats.reduce((worst, beat) => (
      rank[beat.certainty] > rank[worst] ? beat.certainty : worst
    ), "verified"),
    role: first.role,
    disclosure: recipeId === "map_route" ? "illustrative_approximate_route" : "grounded_story_labels_only",
  };
}

function transitionFor(scene) {
  if (scene.transitionId === "none") return null;
  return {
    id: scene.transitionId,
    startFrame: scene.startFrame,
    endFrame: Math.min(scene.readabilityHold.startFrame, scene.startFrame + 6),
  };
}

function compileVisualRecipePlanV1(input = {}) {
  const visualProgram = normalizeVisualProgramV1(input.visualProgram);
  const storyIR = normalizeStoryIR(input.storyIR);
  const timingContext = normalizeAnimationTimingContext(input.timingContext);
  const beatById = new Map(storyIR.beats.map((beat) => [beat.beatId, beat]));
  const scenes = visualProgram.scenes.map((scene) => {
    const recipe = findVisualRecipe(scene.primary.recipeId);
    const beats = scene.narrationBeatIds.map((id) => beatById.get(id));
    const phases = deriveNarrationPhases(scene);
    return {
      id: scene.id,
      recipeId: scene.primary.recipeId,
      purpose: scene.purpose,
      narrationBeatIds: [...scene.narrationBeatIds],
      grounded: groundingFor(beats, scene.primary.recipeId),
      layout: compileEngineOwnedLayout(scene.primary.recipeId, { hasHelper: Boolean(scene.helper) }),
      phases,
      stateGraph: {
        identityId: scene.primary.entityId,
        stateProfile: `${scene.primary.recipeId}_state_v1`,
        fromState: scene.primary.fromState,
        toState: scene.primary.toState,
        persistent: recipe.requiresPersistentIdentity,
      },
      transition: transitionFor(scene),
      motionBudget: {
        maximumSimultaneous: 2,
        actualMaximum: scene.helper ? 2 : 1,
        movingOperationsEndFrame: scene.readabilityHold.startFrame,
      },
    };
  });
  const base = {
    schemaVersion: VISUAL_RECIPE_PLAN_SCHEMA_VERSION,
    profile: VISUAL_RECIPE_PLAN_PROFILE_ID,
    profileVersion: VISUAL_RECIPE_PLAN_PROFILE_VERSION,
    bindings: {
      visualProgramHash: visualProgram.contentHash,
      storyIrHash: storyIR.contentHash,
      timingContextHash: timingContext.contentHash,
      draftHash: storyIR.bindings.draftHash,
      sourceRevisionHash: storyIR.bindings.sourceStoryboardHash,
      recipeRegistryHash: VISUAL_RECIPE_REGISTRY_HASH,
    },
    layoutProfile: { id: VISUAL_LAYOUT_PROFILE_ID, version: VISUAL_LAYOUT_PROFILE_VERSION },
    duration: { fps: timingContext.fps, totalFrames: timingContext.durationFrames },
    scenes,
  };
  return normalizeVisualRecipePlanV1(
    { ...base, contentHash: visualRecipePlanContentHash(base) },
    { visualProgram, storyIR, timingContext },
  );
}

function resolveVisualRecipeSceneState(plan, sceneId, frame) {
  const scene = plan.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene || !Number.isInteger(frame)) return null;
  const phase = scene.phases.find((candidate) => frame >= candidate.startFrame && frame < candidate.endFrame);
  if (!phase) return null;
  const duration = phase.endFrame - phase.startFrame;
  return Object.freeze({
    sceneId,
    recipeId: scene.recipeId,
    phaseId: phase.id,
    moving: phase.moving,
    progress: Math.round(((frame - phase.startFrame) / duration) * 10000) / 10000,
    state: phase.id === "hold" ? scene.stateGraph.toState : scene.stateGraph.fromState,
  });
}

module.exports = {
  compileVisualRecipePlanV1,
  resolveVisualRecipeSceneState,
};
