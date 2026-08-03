"use strict";

const { createHash } = require("node:crypto");
const { types: utilTypes } = require("node:util");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
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

const VISUAL_RECIPE_PLAN_SCHEMA_VERSION = 1;
const VISUAL_RECIPE_PLAN_PROFILE_ID = "generalized_visual_recipe_plan_v1";
const VISUAL_RECIPE_PLAN_PROFILE_VERSION = "1.0.0";
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{2,79}$/;
const SAFE_STRING_RE = /(?:https?:\/\/|data:|javascript:|<\/?(?:script|style|svg|html)\b|\b(?:function|eval|require|import)\s*\()/i;

function fail(field, reason = "invalid_value") {
  throw new AppError(
    "GENERALIZED_VISUAL_RECIPE_PLAN_INVALID",
    SAFE_MESSAGES.VALIDATION_ERROR || "The visual recipe plan did not pass validation.",
    400,
    { field, reason },
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function safeClone(input) {
  const seen = new WeakSet();
  function visit(value, field) {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (!value || value.length > 320 || /[\u0000-\u001f]/.test(value) || SAFE_STRING_RE.test(value)) {
        fail(field, "unsafe_string");
      }
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail(field, "non_finite_number");
      return value;
    }
    if (typeof value !== "object") fail(field, "data_only_required");
    if (utilTypes.isProxy(value)) fail(field, "proxy_not_allowed");
    if (seen.has(value)) fail(field, "cyclic_or_aliased_reference");
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    if ((Array.isArray(value) && prototype !== Array.prototype)
      || (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)) {
      fail(field, "plain_data_required");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === "symbol") fail(field, "symbol_key_not_allowed");
      if (Array.isArray(value) && key === "length") continue;
      if (descriptors[key].get || descriptors[key].set) fail(`${field}.${key}`, "accessor_not_allowed");
    }
    if (Array.isArray(value)) {
      if (value.length > 128) fail(field, "array_budget_exceeded");
      return Array.from({ length: value.length }, (_, index) => {
        if (!Object.hasOwn(value, index)) fail(`${field}[${index}]`, "sparse_array_not_allowed");
        return visit(descriptors[String(index)].value, `${field}[${index}]`);
      });
    }
    if (Object.keys(descriptors).length > 96) fail(field, "object_budget_exceeded");
    return Object.fromEntries(Object.keys(descriptors).map((key) => [
      key,
      visit(descriptors[key].value, `${field}.${key}`),
    ]));
  }
  return visit(input, "visualRecipePlan");
}

function exact(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field, "object_required");
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field}.${key}`, "unsupported_field");
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${field}.${key}`, "required_field");
}

function text(value, field, max = 160, pattern = null) {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/.test(value)
    || SAFE_STRING_RE.test(value) || (pattern && !pattern.test(value))) fail(field, "invalid_text");
  return value;
}

function integer(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(field, "integer_out_of_range");
  return value;
}

function hash(value) {
  const copy = { ...value };
  delete copy.contentHash;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function same(left, right, field, reason) {
  if (stableStringify(left) !== stableStringify(right)) fail(field, reason);
}

function expectedGrounding(beats, recipeId) {
  const first = beats[0];
  const claimIds = [...new Set(beats.flatMap((beat) => beat.claimIds))].slice(0, 8);
  const verdictRank = { verified: 0, qualified: 1, disputed: 2 };
  const certainty = beats.reduce((worst, beat) => (
    verdictRank[beat.certainty] > verdictRank[worst] ? beat.certainty : worst
  ), "verified");
  return {
    heading: first.source.heading,
    primaryLabel: first.source.primaryLabel,
    secondaryLabel: first.source.secondaryLabel,
    onScreenText: first.source.onScreenText,
    claimIds,
    certainty,
    role: first.role,
    disclosure: recipeId === "map_route" ? "illustrative_approximate_route" : "grounded_story_labels_only",
  };
}

function expectedTransition(scene) {
  if (scene.transitionId === "none") return null;
  const startFrame = scene.startFrame;
  return {
    id: scene.transitionId,
    startFrame,
    endFrame: Math.min(scene.readabilityHold.startFrame, startFrame + 6),
  };
}

function normalizeVisualRecipePlanV1(input, trustedContext = {}) {
  if (!trustedContext.visualProgram || !trustedContext.storyIR || !trustedContext.timingContext) {
    fail("trustedContext", "trusted_context_required");
  }
  const value = safeClone(input);
  const visualProgram = normalizeVisualProgramV1(trustedContext.visualProgram);
  const storyIR = normalizeStoryIR(trustedContext.storyIR);
  const timingContext = normalizeAnimationTimingContext(trustedContext.timingContext);
  exact(value, ["schemaVersion", "profile", "profileVersion", "bindings", "layoutProfile", "duration", "scenes", "contentHash"], "visualRecipePlan");
  if (value.schemaVersion !== VISUAL_RECIPE_PLAN_SCHEMA_VERSION) fail("schemaVersion", "unsupported_schema");
  if (value.profile !== VISUAL_RECIPE_PLAN_PROFILE_ID || value.profileVersion !== VISUAL_RECIPE_PLAN_PROFILE_VERSION) {
    fail("profile", "unsupported_profile");
  }
  exact(value.bindings, ["visualProgramHash", "storyIrHash", "timingContextHash", "draftHash", "sourceRevisionHash", "recipeRegistryHash"], "bindings");
  const expectedBindings = {
    visualProgramHash: visualProgram.contentHash,
    storyIrHash: storyIR.contentHash,
    timingContextHash: timingContext.contentHash,
    draftHash: storyIR.bindings.draftHash,
    sourceRevisionHash: storyIR.bindings.sourceStoryboardHash,
    recipeRegistryHash: VISUAL_RECIPE_REGISTRY_HASH,
  };
  for (const [key, expected] of Object.entries(expectedBindings)) {
    text(value.bindings[key], `bindings.${key}`, 64, HASH_RE);
    if (value.bindings[key] !== expected) fail(`bindings.${key}`, "stale_binding");
  }
  exact(value.layoutProfile, ["id", "version"], "layoutProfile");
  if (value.layoutProfile.id !== VISUAL_LAYOUT_PROFILE_ID || value.layoutProfile.version !== VISUAL_LAYOUT_PROFILE_VERSION) {
    fail("layoutProfile", "layout_profile_mismatch");
  }
  exact(value.duration, ["fps", "totalFrames"], "duration");
  if (value.duration.fps !== timingContext.fps || value.duration.totalFrames !== timingContext.durationFrames) {
    fail("duration", "timing_mismatch");
  }
  if (!Array.isArray(value.scenes) || value.scenes.length !== visualProgram.scenes.length) fail("scenes", "scene_count_mismatch");
  const beatById = new Map(storyIR.beats.map((beat) => [beat.beatId, beat]));
  const scenes = value.scenes.map((scene, index) => {
    const field = `scenes[${index}]`;
    const source = visualProgram.scenes[index];
    exact(scene, ["id", "recipeId", "purpose", "narrationBeatIds", "grounded", "layout", "phases", "stateGraph", "transition", "motionBudget"], field);
    if (scene.id !== source.id || scene.recipeId !== source.primary.recipeId || scene.purpose !== source.purpose) fail(field, "visual_program_binding_mismatch");
    if (!findVisualRecipe(scene.recipeId)) fail(`${field}.recipeId`, "unsupported_recipe");
    same(scene.narrationBeatIds, source.narrationBeatIds, `${field}.narrationBeatIds`, "beat_binding_mismatch");
    const beats = source.narrationBeatIds.map((id) => beatById.get(id));
    if (beats.some((beat) => !beat)) fail(`${field}.narrationBeatIds`, "unknown_beat");
    exact(scene.grounded, ["heading", "primaryLabel", "secondaryLabel", "onScreenText", "claimIds", "certainty", "role", "disclosure"], `${field}.grounded`);
    same(scene.grounded, expectedGrounding(beats, scene.recipeId), `${field}.grounded`, "ungrounded_display_content");
    const expectedLayout = compileEngineOwnedLayout(scene.recipeId, { hasHelper: Boolean(source.helper) });
    same(scene.layout, expectedLayout, `${field}.layout`, "engine_layout_mismatch");
    same(scene.phases, deriveNarrationPhases(source), `${field}.phases`, "timing_phase_mismatch");
    exact(scene.stateGraph, ["identityId", "stateProfile", "fromState", "toState", "persistent"], `${field}.stateGraph`);
    const recipe = findVisualRecipe(scene.recipeId);
    const expectedState = {
      identityId: source.primary.entityId,
      stateProfile: `${scene.recipeId}_state_v1`,
      fromState: source.primary.fromState,
      toState: source.primary.toState,
      persistent: recipe.requiresPersistentIdentity,
    };
    same(scene.stateGraph, expectedState, `${field}.stateGraph`, "state_binding_mismatch");
    same(scene.transition, expectedTransition(source), `${field}.transition`, "transition_timing_mismatch");
    exact(scene.motionBudget, ["maximumSimultaneous", "actualMaximum", "movingOperationsEndFrame"], `${field}.motionBudget`);
    integer(scene.motionBudget.maximumSimultaneous, `${field}.motionBudget.maximumSimultaneous`, 1, 2);
    integer(scene.motionBudget.actualMaximum, `${field}.motionBudget.actualMaximum`, 1, scene.motionBudget.maximumSimultaneous);
    if (scene.motionBudget.movingOperationsEndFrame !== source.readabilityHold.startFrame) {
      fail(`${field}.motionBudget.movingOperationsEndFrame`, "motion_in_settled_hold");
    }
    return scene;
  });
  const normalized = {
    schemaVersion: VISUAL_RECIPE_PLAN_SCHEMA_VERSION,
    profile: VISUAL_RECIPE_PLAN_PROFILE_ID,
    profileVersion: VISUAL_RECIPE_PLAN_PROFILE_VERSION,
    bindings: expectedBindings,
    layoutProfile: { id: VISUAL_LAYOUT_PROFILE_ID, version: VISUAL_LAYOUT_PROFILE_VERSION },
    duration: { fps: timingContext.fps, totalFrames: timingContext.durationFrames },
    scenes,
  };
  const expectedHash = hash(normalized);
  if (value.contentHash !== expectedHash) fail("contentHash", "content_hash_mismatch");
  return deepFreeze({ ...normalized, contentHash: expectedHash });
}

module.exports = {
  VISUAL_RECIPE_PLAN_PROFILE_ID,
  VISUAL_RECIPE_PLAN_PROFILE_VERSION,
  VISUAL_RECIPE_PLAN_SCHEMA_VERSION,
  deepFreezeVisualRecipePlan: deepFreeze,
  normalizeVisualRecipePlanV1,
  visualRecipePlanContentHash: hash,
};
