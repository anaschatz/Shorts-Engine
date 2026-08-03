"use strict";

const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const {
  animationContentHash,
  validateAnimationIR,
} = require("./contract.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const { normalizeStoryIR } = require("./story-ir.cjs");
const {
  normalizeAnimationTimingContext,
  timingBindingFromContext,
} = require("./timing-contract.cjs");
const {
  VISUAL_PROGRAM_COMPILER_VERSION,
  VISUAL_RECIPE_REGISTRY_HASH,
  VISUAL_RECIPE_REGISTRY_VERSION,
  VISUAL_STYLE_TOKEN_ID,
  VISUAL_STYLE_TOKEN_VERSION,
  findVisualRecipe,
} = require("./visual-recipe-registry.cjs");
const {
  VISUAL_PROGRAM_PROFILE_ID,
  VISUAL_PROGRAM_PROFILE_VERSION,
  VISUAL_PROGRAM_SCHEMA_VERSION,
  deepFreezeVisualProgram,
  normalizeVisualProgramProposalV1,
  normalizeVisualProgramV1,
  visualProgramContentHash,
} = require("./visual-program-contract.cjs");
const {
  normalizeVisualRecipePlanV1,
} = require("./visual-recipe-plan-contract.cjs");
const {
  compileVisualRecipePlanV1,
} = require("./visual-recipe-plan-compiler.cjs");

const ADAPTER_PROFILE_ID = "generalized_visual_program_animation_adapter_v1";
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{2,79}$/;

function fail(field, reason = "invalid_value") {
  throw new AppError(
    "GENERALIZED_VISUAL_PROGRAM_INVALID",
    SAFE_MESSAGES.VALIDATION_ERROR || "The visual program did not pass validation.",
    400,
    { field, reason },
  );
}

function hash(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : stableStringify(value))
    .digest("hex");
}

function exactKeys(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field, "object_required");
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) fail(`${field}.${key}`, "unsupported_field");
  for (const key of allowed) if (!Object.hasOwn(value, key)) fail(`${field}.${key}`, "required_field");
}

function validateInputs(storyIR, timingContext, proposal) {
  if (
    storyIR.bindings.draftHash !== timingContext.draftHash
    || storyIR.bindings.timingContextHash !== timingContext.contentHash
    || storyIR.bindings.alignmentHash !== timingContext.alignmentHash
  ) fail("bindings", "story_timing_binding_mismatch");
  const expected = {
    storyIrHash: storyIR.contentHash,
    timingContextHash: timingContext.contentHash,
    draftHash: storyIR.bindings.draftHash,
    sourceRevisionHash: storyIR.bindings.sourceStoryboardHash,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (proposal.bindings[key] !== value) fail(`proposal.bindings.${key}`, "stale_binding");
  }

  const storyBeatIds = storyIR.beats.map((beat) => beat.beatId);
  const timingBeatIds = timingContext.beats.map((beat) => beat.beatId);
  if (stableStringify(storyBeatIds) !== stableStringify(timingBeatIds)) {
    fail("storyIR.beats", "story_timing_beat_mismatch");
  }
  const proposedBeatIds = proposal.scenes.flatMap((scene) => scene.narrationBeatIds);
  if (stableStringify(proposedBeatIds) !== stableStringify(storyBeatIds)) {
    fail("proposal.scenes", "beats_must_form_ordered_partition");
  }
}

function validateSceneProposal(scene, beats) {
  const primaryRecipe = findVisualRecipe(scene.primary.recipeId);
  if (!primaryRecipe) fail(`proposal.scenes.${scene.id}.primary.recipeId`, "unknown_recipe");
  if (!primaryRecipe.semanticFamilies.includes(scene.semanticFamily)) {
    fail(`proposal.scenes.${scene.id}.semanticFamily`, "recipe_family_mismatch");
  }
  if (!primaryRecipe.allowedPrimaryRoles.includes(scene.primary.role)) {
    fail(`proposal.scenes.${scene.id}.primary.role`, "recipe_role_mismatch");
  }
  if (!primaryRecipe.allowedActions.includes(scene.primary.action)) {
    fail(`proposal.scenes.${scene.id}.primary.action`, "recipe_action_mismatch");
  }
  if (!primaryRecipe.allowedTransitions.includes(scene.transitionId)) {
    fail(`proposal.scenes.${scene.id}.transitionId`, "recipe_transition_mismatch");
  }
  const trustedEntityRefs = new Set(beats.map((beat) => beat.source.sceneId));
  if (!trustedEntityRefs.has(scene.primary.entityRef)) {
    fail(`proposal.scenes.${scene.id}.primary.entityRef`, "untrusted_entity_reference");
  }

  if (scene.helper) {
    const helperRecipe = findVisualRecipe(scene.helper.recipeId);
    if (!helperRecipe) fail(`proposal.scenes.${scene.id}.helper.recipeId`, "unknown_recipe");
    if (!helperRecipe.allowedHelperRoles.includes(scene.helper.role)) {
      fail(`proposal.scenes.${scene.id}.helper.role`, "recipe_helper_role_mismatch");
    }
    const trustedClaimIds = new Set(beats.flatMap((beat) => beat.claimIds));
    for (const dataRef of scene.helper.dataRefs) {
      if (!trustedClaimIds.has(dataRef)) {
        fail(`proposal.scenes.${scene.id}.helper.dataRefs`, "untrusted_data_reference");
      }
    }
  }
  return primaryRecipe;
}

function buildVisualProgram({ storyIR, timingContext, proposal }) {
  const storyBeatById = new Map(storyIR.beats.map((beat) => [beat.beatId, beat]));
  const timingBeatById = new Map(timingContext.beats.map((beat) => [beat.beatId, beat]));
  const scenes = proposal.scenes.map((scene, index) => {
    const beats = scene.narrationBeatIds.map((beatId) => storyBeatById.get(beatId));
    if (beats.some((beat) => !beat)) fail(`proposal.scenes[${index}].narrationBeatIds`, "unknown_beat");
    const recipe = validateSceneProposal(scene, beats);
    const firstTimingBeat = timingBeatById.get(scene.narrationBeatIds[0]);
    const lastTimingBeat = timingBeatById.get(scene.narrationBeatIds.at(-1));
    const nextScene = proposal.scenes[index + 1];
    const nextTimingBeat = nextScene
      ? timingBeatById.get(nextScene.narrationBeatIds[0])
      : null;
    const startFrame = index === 0 ? 0 : firstTimingBeat.startFrame;
    const endFrame = nextTimingBeat ? nextTimingBeat.startFrame : timingContext.durationFrames;
    const holdLength = Math.min(12, endFrame - startFrame - 1);
    const holdStart = Math.max(
      firstTimingBeat.startFrame,
      Math.min(lastTimingBeat.endFrame, endFrame - holdLength),
    );
    return {
      id: scene.id,
      purpose: scene.purpose,
      semanticFamily: scene.semanticFamily,
      narrationBeatIds: scene.narrationBeatIds,
      startFrame,
      endFrame,
      narrationStartFrame: firstTimingBeat.startFrame,
      narrationEndFrame: lastTimingBeat.endFrame,
      readabilityHold: { startFrame: holdStart, endFrame },
      primary: {
        ...scene.primary,
        entityId: `primary_${String(index).padStart(2, "0")}`,
        template: recipe.animationTemplate,
        templateVersion: "1.0.0",
        complexityCost: recipe.complexityCost,
      },
      helper: scene.helper
        ? {
          ...scene.helper,
          entityId: `helper_${String(index).padStart(2, "0")}`,
        }
        : null,
      transitionId: scene.transitionId,
    };
  });
  const base = {
    schemaVersion: VISUAL_PROGRAM_SCHEMA_VERSION,
    profile: VISUAL_PROGRAM_PROFILE_ID,
    profileVersion: VISUAL_PROGRAM_PROFILE_VERSION,
    bindings: {
      ...proposal.bindings,
      proposalHash: proposal.contentHash,
    },
    style: {
      tokenId: VISUAL_STYLE_TOKEN_ID,
      version: VISUAL_STYLE_TOKEN_VERSION,
    },
    registry: {
      version: VISUAL_RECIPE_REGISTRY_VERSION,
      contentHash: VISUAL_RECIPE_REGISTRY_HASH,
    },
    compiler: { version: VISUAL_PROGRAM_COMPILER_VERSION },
    duration: { fps: timingContext.fps, totalFrames: timingContext.durationFrames },
    scenes,
  };
  return normalizeVisualProgramV1({ ...base, contentHash: visualProgramContentHash(base) });
}

function absoluteAnchor(frame) {
  return { anchor: "absolute", frame, resolvedFrame: frame };
}

function operation({ op, targetId, startFrame, endFrame, params, claimId, purpose, carryPolicy }) {
  return {
    op,
    targetId,
    from: absoluteAnchor(startFrame),
    to: absoluteAnchor(endFrame),
    easing: "ease_out_cubic",
    params,
    ...(claimId ? { semanticClaimId: claimId } : {}),
    visualStatement: purpose,
    carryPolicy,
  };
}

const RECIPE_OPERATIONS = Object.freeze({
  finite_cycle: Object.freeze([
    ["pulse", { scale: 1.08, opacity: 1 }],
    ["morph_path", { toShape: "node" }],
  ]),
  cause_effect: Object.freeze([
    ["draw_path", { direction: "left_to_right" }],
    ["move", { x: 24, y: 0 }],
  ]),
  comparison: Object.freeze([
    ["scale", { from: 0.82, to: 1 }],
    ["highlight", { strength: 1 }],
  ]),
  evidence_inspection: Object.freeze([
    ["scale", { from: 0.9, to: 1 }],
    ["highlight", { strength: 1 }],
  ]),
  bounded_uncertainty: Object.freeze([
    ["fade", { from: 0.35, to: 1 }],
    ["highlight", { strength: 0.8 }],
  ]),
  map_route: Object.freeze([
    ["draw_path", { direction: "left_to_right" }],
    ["move", { x: 28, y: -12 }],
  ]),
  negative_space_absence: Object.freeze([
    ["fade", { from: 1, to: 0.45 }],
    ["highlight", { strength: 0.75 }],
  ]),
  chronology: Object.freeze([
    ["draw_path", { direction: "left_to_right" }],
    ["pulse", { scale: 1.06, opacity: 1 }],
  ]),
});

function recipeOperations(recipeScene, visualScene, claimId) {
  const [enter, develop, reveal, resolve] = recipeScene.phases;
  const profile = RECIPE_OPERATIONS[recipeScene.recipeId];
  const operations = [operation({
    op: "create",
    targetId: visualScene.primary.entityId,
    startFrame: enter.startFrame,
    endFrame: enter.endFrame,
    params: { opacity: 1 },
    claimId,
    purpose: visualScene.purpose,
    carryPolicy: visualScene.primary.recipeId === "finite_cycle" ? "carry_to_next" : "clear_at_scene_end",
  })];
  if (visualScene.helper) {
    operations.push(operation({
      op: "fade",
      targetId: visualScene.helper.entityId,
      startFrame: enter.startFrame,
      endFrame: enter.endFrame,
      params: { from: 0, to: 1 },
      claimId: visualScene.helper.dataRefs[0],
      purpose: visualScene.purpose,
      carryPolicy: "clear_at_scene_end",
    }));
  }
  operations.push(operation({
    op: profile[0][0],
    targetId: visualScene.primary.entityId,
    startFrame: develop.startFrame,
    endFrame: develop.endFrame,
    params: profile[0][1],
    claimId,
    purpose: visualScene.purpose,
    carryPolicy: "clear_at_scene_end",
  }));
  operations.push(operation({
    op: profile[1][0],
    targetId: visualScene.primary.entityId,
    startFrame: reveal.startFrame,
    endFrame: reveal.endFrame,
    params: profile[1][1],
    claimId,
    purpose: visualScene.purpose,
    carryPolicy: "clear_at_scene_end",
  }));
  if (recipeScene.transition) {
    operations.push(operation({
      op: "transition_match",
      targetId: "story_thread",
      startFrame: resolve.startFrame,
      endFrame: resolve.endFrame,
      params: { toEntityId: visualScene.primary.entityId },
      claimId,
      purpose: visualScene.purpose,
      carryPolicy: "persistent",
    }));
  }
  return operations;
}

function buildAnimationIR({ visualProgram, visualRecipePlan, storyIR, timingContext, projectId, projectRevision }) {
  if (typeof projectId !== "string" || !ID_RE.test(projectId)) fail("projectId", "invalid_project_id");
  if (!Number.isInteger(projectRevision) || projectRevision < 1 || projectRevision > 1_000_000) {
    fail("projectRevision", "invalid_project_revision");
  }
  const storyBeatById = new Map(storyIR.beats.map((beat) => [beat.beatId, beat]));
  const adapterBindingHash = hash(`${VISUAL_RECIPE_REGISTRY_HASH}:${visualProgram.contentHash}:${visualRecipePlan.contentHash}`);
  const sharedEntities = [
    { id: "background", type: "background", role: "background_field", layer: 0, styleToken: VISUAL_STYLE_TOKEN_ID },
    { id: "story_thread", type: "story_thread", role: "narrative_continuity", layer: 1, styleToken: VISUAL_STYLE_TOKEN_ID },
    ...visualProgram.scenes.flatMap((scene) => [
      {
        id: scene.primary.entityId,
        type: "semantic_visual",
        role: scene.primary.role,
        layer: 4,
        styleToken: VISUAL_STYLE_TOKEN_ID,
      },
      ...(scene.helper ? [{
        id: scene.helper.entityId,
        type: "semantic_label",
        role: scene.helper.role,
        layer: 5,
        styleToken: VISUAL_STYLE_TOKEN_ID,
      }] : []),
    ]),
  ];
  const scenes = visualProgram.scenes.map((scene, sceneIndex) => {
    const beats = scene.narrationBeatIds.map((beatId) => storyBeatById.get(beatId));
    const claimIds = [...new Set(beats.flatMap((beat) => beat.claimIds))].slice(0, 8);
    const entityIds = ["background", "story_thread", scene.primary.entityId];
    if (scene.helper) entityIds.push(scene.helper.entityId);
    const firstClaim = claimIds[0];
    return {
      id: scene.id,
      startFrame: scene.startFrame,
      endFrame: scene.endFrame,
      template: scene.primary.template,
      templateVersion: scene.primary.templateVersion,
      entityIds,
      operations: recipeOperations(visualRecipePlan.scenes[sceneIndex], scene, firstClaim),
      readabilityHolds: [scene.readabilityHold],
      complexityCost: scene.primary.complexityCost,
      semantic: {
        beatId: beats[0].beatId,
        role: beats[0].role,
        claimIds,
        visualStatement: scene.purpose,
      },
    };
  });
  const transitions = visualProgram.scenes.slice(0, -1).map((scene, index) => {
    const next = visualProgram.scenes[index + 1];
    const boundary = next.startFrame;
    return {
      fromSceneId: scene.id,
      toSceneId: next.id,
      sharedEntityId: "story_thread",
      startFrame: boundary,
      endFrame: Math.min(next.readabilityHold.startFrame, boundary + 6),
    };
  });
  const labels = visualProgram.scenes.map((scene) => scene.primary.recipeId).slice(0, 6);
  while (labels.length < 3) labels.push("resolve");
  const ir = {
    schemaVersion: 1,
    profile: "dark_curiosity_continuous",
    profileVersion: "1.0.0",
    projectId,
    projectRevision,
    verticalId: "dark_curiosity",
    width: 1080,
    height: 1920,
    fps: timingContext.fps,
    durationFrames: timingContext.durationFrames,
    draftHash: storyIR.bindings.draftHash,
    alignmentHash: timingContext.alignmentHash,
    assetManifestHash: adapterBindingHash,
    renderer: {
      provider: "hyperframes_local",
      runtimeVersion: "0.7.55",
      styleVersion: VISUAL_STYLE_TOKEN_VERSION,
    },
    seed: Number.parseInt(visualProgram.contentHash.slice(0, 8), 16),
    content: {
      compositionId: "generalized_visual_program",
      kicker: "Visual explanation",
      titleLines: ["Evidence in motion"],
      metricValue: String(visualProgram.scenes.length),
      metricLabel: "bounded visual scenes",
      evidenceCode: "VPROGRAM",
      evidenceLabel: "Narration-bound evidence",
      reasoningLeft: "Observed",
      reasoningRight: "Unresolved",
      payoffLines: ["The evidence sets the boundary"],
      timelineLabels: labels,
    },
    timingBinding: timingBindingFromContext(timingContext),
    sharedEntities,
    scenes,
    transitions,
    motionBudget: {
      profile: "calm_explainer",
      maxCost: 180,
      maxConcurrentOperations: 2,
      maxCameraScale: 1.12,
      maxTravelPxPerFrame: 8,
      captionSafeZone: { topRatio: 0.68, bottomRatio: 0.9 },
    },
  };
  return deepFreezeVisualProgram(validateAnimationIR(ir));
}

function adapterContentHash(value) {
  const copy = { ...value };
  delete copy.contentHash;
  return hash(copy);
}

function validateGeneralizedVisualProgramAnimationAdapterV1(input, trustedContext = {}) {
  exactKeys(input, ["schemaVersion", "profile", "bindings", "visualProgram", "visualRecipePlan", "animationIR", "contentHash"], "adapter");
  if (input.schemaVersion !== 1 || input.profile !== ADAPTER_PROFILE_ID) fail("adapter.profile", "unsupported_adapter");
  exactKeys(input.bindings, ["visualProgramHash", "visualRecipePlanHash", "animationIRHash", "recipeRegistryHash", "adapterBindingHash"], "adapter.bindings");
  for (const [key, value] of Object.entries(input.bindings)) {
    if (typeof value !== "string" || !HASH_RE.test(value)) fail(`adapter.bindings.${key}`, "invalid_hash");
  }
  const visualProgram = normalizeVisualProgramV1(input.visualProgram);
  if (!trustedContext.storyIR || !trustedContext.timingContext) {
    fail("adapter.trustedContext", "trusted_context_required");
  }
  const storyIR = normalizeStoryIR(trustedContext.storyIR);
  const timingContext = normalizeAnimationTimingContext(trustedContext.timingContext);
  let visualRecipePlan;
  try {
    visualRecipePlan = normalizeVisualRecipePlanV1(input.visualRecipePlan, {
      visualProgram,
      storyIR,
      timingContext,
    });
  } catch (error) {
    if (error?.code === "GENERALIZED_VISUAL_RECIPE_PLAN_INVALID") {
      fail("adapter.visualRecipePlan", "recipe_plan_binding_mismatch");
    }
    throw error;
  }
  const animationIR = validateAnimationIR(input.animationIR);
  if (
    visualProgram.bindings.storyIrHash !== storyIR.contentHash
    || visualProgram.bindings.timingContextHash !== timingContext.contentHash
    || visualProgram.bindings.draftHash !== storyIR.bindings.draftHash
    || visualProgram.bindings.sourceRevisionHash !== storyIR.bindings.sourceStoryboardHash
    || animationIR.draftHash !== storyIR.bindings.draftHash
    || animationIR.alignmentHash !== timingContext.alignmentHash
    || animationIR.timingBinding?.timingContextHash !== timingContext.contentHash
    || animationIR.durationFrames !== timingContext.durationFrames
    || animationIR.fps !== timingContext.fps
  ) fail("adapter.trustedContext", "trusted_context_binding_mismatch");
  const adapterBindingHash = hash(`${VISUAL_RECIPE_REGISTRY_HASH}:${visualProgram.contentHash}:${visualRecipePlan.contentHash}`);
  if (
    input.bindings.visualProgramHash !== visualProgram.contentHash
    || input.bindings.visualRecipePlanHash !== visualRecipePlan.contentHash
    || input.bindings.animationIRHash !== animationIR.contentHash
    || input.bindings.recipeRegistryHash !== VISUAL_RECIPE_REGISTRY_HASH
    || input.bindings.adapterBindingHash !== adapterBindingHash
    || animationIR.assetManifestHash !== adapterBindingHash
  ) fail("adapter.bindings", "adapter_binding_mismatch");
  const normalized = {
    schemaVersion: 1,
    profile: ADAPTER_PROFILE_ID,
    bindings: { ...input.bindings },
    visualProgram,
    visualRecipePlan,
    animationIR,
  };
  const expectedHash = adapterContentHash(normalized);
  if (input.contentHash !== expectedHash) fail("adapter.contentHash", "content_hash_mismatch");
  return deepFreezeVisualProgram({ ...normalized, contentHash: expectedHash });
}

function compileGeneralizedVisualProgramV1({
  storyIR: rawStoryIR,
  timingContext: rawTimingContext,
  proposal: rawProposal,
  projectId = "project_visual_program",
  projectRevision = 1,
} = {}) {
  const storyIR = normalizeStoryIR(rawStoryIR);
  const timingContext = normalizeAnimationTimingContext(rawTimingContext);
  const proposal = normalizeVisualProgramProposalV1(rawProposal);
  validateInputs(storyIR, timingContext, proposal);
  const visualProgram = buildVisualProgram({ storyIR, timingContext, proposal });
  const visualRecipePlan = compileVisualRecipePlanV1({ visualProgram, storyIR, timingContext });
  const animationIR = buildAnimationIR({
    visualProgram,
    visualRecipePlan,
    storyIR,
    timingContext,
    projectId,
    projectRevision,
  });
  const adapterBindingHash = hash(`${VISUAL_RECIPE_REGISTRY_HASH}:${visualProgram.contentHash}:${visualRecipePlan.contentHash}`);
  const adapter = {
    schemaVersion: 1,
    profile: ADAPTER_PROFILE_ID,
    bindings: {
      visualProgramHash: visualProgram.contentHash,
      visualRecipePlanHash: visualRecipePlan.contentHash,
      animationIRHash: animationContentHash(animationIR),
      recipeRegistryHash: VISUAL_RECIPE_REGISTRY_HASH,
      adapterBindingHash,
    },
    visualProgram,
    visualRecipePlan,
    animationIR,
  };
  return validateGeneralizedVisualProgramAnimationAdapterV1(
    { ...adapter, contentHash: adapterContentHash(adapter) },
    { storyIR, timingContext },
  );
}

module.exports = {
  GENERALIZED_VISUAL_PROGRAM_ADAPTER_PROFILE_ID: ADAPTER_PROFILE_ID,
  compileGeneralizedVisualProgramV1,
  validateGeneralizedVisualProgramAnimationAdapterV1,
};
