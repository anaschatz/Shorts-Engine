"use strict";

const { createHash } = require("node:crypto");
const { types: utilTypes } = require("node:util");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  VISUAL_ACTIONS,
  VISUAL_PROGRAM_COMPILER_VERSION,
  VISUAL_RECIPE_REGISTRY_HASH,
  VISUAL_RECIPE_REGISTRY_VERSION,
  VISUAL_ROLES,
  VISUAL_STYLE_TOKEN_ID,
  VISUAL_STYLE_TOKEN_VERSION,
  VISUAL_TRANSITIONS,
  findVisualRecipe,
} = require("./visual-recipe-registry.cjs");

const VISUAL_PROGRAM_SCHEMA_VERSION = 1;
const VISUAL_PROGRAM_PROFILE_ID = "generalized_visual_program_v1";
const VISUAL_PROGRAM_PROFILE_VERSION = "1.0.0";
const VISUAL_PROGRAM_PROPOSAL_PROFILE_ID = "generalized_visual_program_proposal_v1";
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{2,79}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MAX_SCENES = 6;
const MIN_SCENES = 3;
const FORBIDDEN_PROPOSAL_KEYS = new Set([
  "__proto__",
  "anchor",
  "code",
  "constructor",
  "css",
  "cx",
  "cy",
  "endframe",
  "frame",
  "height",
  "html",
  "javascript",
  "markup",
  "path",
  "prototype",
  "script",
  "startframe",
  "style",
  "svg",
  "transform",
  "triggerframe",
  "url",
  "viewbox",
  "width",
  "x",
  "y",
]);
const REMOTE_OR_EXECUTABLE_RE = /(?:https?:\/\/|data:|javascript:|<\/?(?:script|style|svg|html)\b|\b(?:function|eval|require|import)\s*\()/i;
const ABSOLUTE_PATH_RE = /^(?:\/|~\/|[a-z]:[\\/]|\\\\)/i;

function fail(field, reason = "invalid_value") {
  throw new AppError(
    "GENERALIZED_VISUAL_PROGRAM_INVALID",
    SAFE_MESSAGES.VALIDATION_ERROR || "The visual program did not pass validation.",
    400,
    { field, reason },
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  Object.values(value).forEach(deepFreeze);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function safeDataClone(input, { proposalSurface = false } = {}) {
  const seen = new WeakSet();

  function visit(value, field) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      if (
        typeof value === "string"
        && (
          value.length > 240
          || /[\u0000-\u001f]/.test(value)
          || REMOTE_OR_EXECUTABLE_RE.test(value)
          || ABSOLUTE_PATH_RE.test(value)
        )
      ) fail(field, "unsafe_string");
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
    if (
      (Array.isArray(value) && prototype !== Array.prototype)
      || (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    ) fail(field, "plain_data_required");

    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === "symbol") fail(field, "symbol_key_not_allowed");
      if (key === "length" && Array.isArray(value)) continue;
      const descriptor = descriptors[key];
      if (descriptor.get || descriptor.set) fail(`${field}.${key}`, "accessor_not_allowed");
      if (proposalSurface && FORBIDDEN_PROPOSAL_KEYS.has(key.toLowerCase())) {
        fail(`${field}.${key}`, "engine_owned_field");
      }
    }

    if (Array.isArray(value)) {
      if (value.length > 64) fail(field, "array_budget_exceeded");
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail(`${field}[${index}]`, "sparse_array_not_allowed");
        output.push(visit(descriptors[String(index)].value, `${field}[${index}]`));
      }
      return output;
    }

    const keys = Object.keys(descriptors);
    if (keys.length > 64) fail(field, "object_budget_exceeded");
    const output = Object.create(null);
    for (const key of keys) {
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: visit(descriptors[key].value, `${field}.${key}`),
        writable: true,
      });
    }
    return output;
  }

  return visit(input, proposalSurface ? "proposal" : "visualProgram");
}

function exactKeys(value, allowed, required, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field, "object_required");
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${field}.${key}`, "unsupported_field");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${field}.${key}`, "required_field");
  }
}

function text(value, field, { max = 160, pattern = null } = {}) {
  if (
    typeof value !== "string"
    || !value
    || value.length > max
    || /[\u0000-\u001f]/.test(value)
    || (pattern && !pattern.test(value))
  ) fail(field, "invalid_text");
  return value;
}

function integer(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(field, "integer_out_of_range");
  return value;
}

function oneOf(value, field, values) {
  const normalized = text(value, field, { max: 80, pattern: ID_RE });
  if (!values.includes(normalized)) fail(field, "unsupported_value");
  return normalized;
}

function strings(value, field, { min = 1, max = 8, pattern = ID_RE } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(field, "array_size_invalid");
  const result = value.map((entry, index) => text(entry, `${field}[${index}]`, { max: 80, pattern }));
  if (new Set(result).size !== result.length) fail(field, "duplicate_values");
  return result;
}

function contentHash(value) {
  const copy = { ...value };
  delete copy.contentHash;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function normalizeBindings(value, field, { proposal = false } = {}) {
  const keys = ["storyIrHash", "timingContextHash", "draftHash", "sourceRevisionHash"];
  if (!proposal) keys.push("proposalHash");
  exactKeys(value, keys, keys, field);
  return Object.fromEntries(keys.map((key) => [
    key,
    text(value[key], `${field}.${key}`, { max: 64, pattern: HASH_RE }),
  ]));
}

function normalizeProposalPrimary(value, field) {
  const keys = ["entityRef", "role", "recipeId", "action", "fromState", "toState"];
  exactKeys(value, keys, keys, field);
  return {
    entityRef: text(value.entityRef, `${field}.entityRef`, { max: 80, pattern: ID_RE }),
    role: oneOf(value.role, `${field}.role`, VISUAL_ROLES),
    recipeId: text(value.recipeId, `${field}.recipeId`, { max: 80, pattern: ID_RE }),
    action: oneOf(value.action, `${field}.action`, VISUAL_ACTIONS),
    fromState: text(value.fromState, `${field}.fromState`, { max: 80, pattern: ID_RE }),
    toState: text(value.toState, `${field}.toState`, { max: 80, pattern: ID_RE }),
  };
}

function normalizeProposalHelper(value, field) {
  if (value === null) return null;
  const keys = ["role", "recipeId", "dataRefs"];
  exactKeys(value, keys, keys, field);
  return {
    role: oneOf(value.role, `${field}.role`, VISUAL_ROLES),
    recipeId: text(value.recipeId, `${field}.recipeId`, { max: 80, pattern: ID_RE }),
    dataRefs: strings(value.dataRefs, `${field}.dataRefs`, { max: 4 }),
  };
}

function normalizeVisualProgramProposalV1(input) {
  const value = safeDataClone(input, { proposalSurface: true });
  const keys = ["schemaVersion", "profile", "bindings", "styleTokenId", "scenes"];
  exactKeys(value, keys, keys, "proposal");
  if (value.schemaVersion !== VISUAL_PROGRAM_SCHEMA_VERSION) fail("proposal.schemaVersion", "unsupported_schema");
  if (value.profile !== VISUAL_PROGRAM_PROPOSAL_PROFILE_ID) fail("proposal.profile", "unsupported_profile");
  if (value.styleTokenId !== VISUAL_STYLE_TOKEN_ID) fail("proposal.styleTokenId", "unsupported_style_token");
  if (!Array.isArray(value.scenes) || value.scenes.length < MIN_SCENES || value.scenes.length > MAX_SCENES) {
    fail("proposal.scenes", "scene_budget_invalid");
  }
  const sceneIds = new Set();
  const scenes = value.scenes.map((scene, index) => {
    const field = `proposal.scenes[${index}]`;
    const sceneKeys = ["id", "purpose", "semanticFamily", "narrationBeatIds", "primary", "helper", "transitionId"];
    exactKeys(scene, sceneKeys, sceneKeys, field);
    const id = text(scene.id, `${field}.id`, { max: 80, pattern: ID_RE });
    if (sceneIds.has(id)) fail(`${field}.id`, "duplicate_scene_id");
    sceneIds.add(id);
    return {
      id,
      purpose: text(scene.purpose, `${field}.purpose`, { max: 160 }),
      semanticFamily: text(scene.semanticFamily, `${field}.semanticFamily`, { max: 80, pattern: ID_RE }),
      narrationBeatIds: strings(scene.narrationBeatIds, `${field}.narrationBeatIds`, { max: 5 }),
      primary: normalizeProposalPrimary(scene.primary, `${field}.primary`),
      helper: normalizeProposalHelper(scene.helper, `${field}.helper`),
      transitionId: oneOf(scene.transitionId, `${field}.transitionId`, VISUAL_TRANSITIONS),
    };
  });
  const normalized = {
    schemaVersion: VISUAL_PROGRAM_SCHEMA_VERSION,
    profile: VISUAL_PROGRAM_PROPOSAL_PROFILE_ID,
    bindings: normalizeBindings(value.bindings, "proposal.bindings", { proposal: true }),
    styleTokenId: VISUAL_STYLE_TOKEN_ID,
    scenes,
  };
  return deepFreeze({ ...normalized, contentHash: contentHash(normalized) });
}

function normalizeCompiledPrimary(value, field) {
  const keys = [
    "entityRef", "entityId", "role", "recipeId", "action", "fromState", "toState",
    "template", "templateVersion", "complexityCost",
  ];
  exactKeys(value, keys, keys, field);
  return {
    entityRef: text(value.entityRef, `${field}.entityRef`, { max: 80, pattern: ID_RE }),
    entityId: text(value.entityId, `${field}.entityId`, { max: 80, pattern: ID_RE }),
    role: oneOf(value.role, `${field}.role`, VISUAL_ROLES),
    recipeId: text(value.recipeId, `${field}.recipeId`, { max: 80, pattern: ID_RE }),
    action: oneOf(value.action, `${field}.action`, VISUAL_ACTIONS),
    fromState: text(value.fromState, `${field}.fromState`, { max: 80, pattern: ID_RE }),
    toState: text(value.toState, `${field}.toState`, { max: 80, pattern: ID_RE }),
    template: text(value.template, `${field}.template`, { max: 80, pattern: ID_RE }),
    templateVersion: text(value.templateVersion, `${field}.templateVersion`, { max: 20, pattern: VERSION_RE }),
    complexityCost: integer(value.complexityCost, `${field}.complexityCost`, 1, 200),
  };
}

function normalizeCompiledHelper(value, field) {
  if (value === null) return null;
  const keys = ["entityId", "role", "recipeId", "dataRefs"];
  exactKeys(value, keys, keys, field);
  return {
    entityId: text(value.entityId, `${field}.entityId`, { max: 80, pattern: ID_RE }),
    role: oneOf(value.role, `${field}.role`, VISUAL_ROLES),
    recipeId: text(value.recipeId, `${field}.recipeId`, { max: 80, pattern: ID_RE }),
    dataRefs: strings(value.dataRefs, `${field}.dataRefs`, { max: 4 }),
  };
}

function normalizeVisualProgramV1(input) {
  const value = safeDataClone(input);
  const keys = ["schemaVersion", "profile", "profileVersion", "bindings", "style", "registry", "compiler", "duration", "scenes", "contentHash"];
  exactKeys(value, keys, keys, "visualProgram");
  if (value.schemaVersion !== VISUAL_PROGRAM_SCHEMA_VERSION) fail("visualProgram.schemaVersion", "unsupported_schema");
  if (value.profile !== VISUAL_PROGRAM_PROFILE_ID) fail("visualProgram.profile", "unsupported_profile");
  if (value.profileVersion !== VISUAL_PROGRAM_PROFILE_VERSION) fail("visualProgram.profileVersion", "unsupported_profile_version");
  exactKeys(value.style, ["tokenId", "version"], ["tokenId", "version"], "visualProgram.style");
  if (value.style.tokenId !== VISUAL_STYLE_TOKEN_ID || value.style.version !== VISUAL_STYLE_TOKEN_VERSION) fail("visualProgram.style", "style_binding_mismatch");
  exactKeys(value.registry, ["version", "contentHash"], ["version", "contentHash"], "visualProgram.registry");
  if (value.registry.version !== VISUAL_RECIPE_REGISTRY_VERSION || value.registry.contentHash !== VISUAL_RECIPE_REGISTRY_HASH) fail("visualProgram.registry", "registry_binding_mismatch");
  exactKeys(value.compiler, ["version"], ["version"], "visualProgram.compiler");
  text(value.compiler.version, "visualProgram.compiler.version", { max: 20, pattern: VERSION_RE });
  if (value.compiler.version !== VISUAL_PROGRAM_COMPILER_VERSION) fail("visualProgram.compiler.version", "compiler_binding_mismatch");
  exactKeys(value.duration, ["fps", "totalFrames"], ["fps", "totalFrames"], "visualProgram.duration");
  const duration = {
    fps: integer(value.duration.fps, "visualProgram.duration.fps", 30, 30),
    totalFrames: integer(value.duration.totalFrames, "visualProgram.duration.totalFrames", 30, 3600),
  };
  if (!Array.isArray(value.scenes) || value.scenes.length < MIN_SCENES || value.scenes.length > MAX_SCENES) fail("visualProgram.scenes", "scene_budget_invalid");
  let expectedStart = 0;
  const sceneIds = new Set();
  const narrationBeatIds = new Set();
  const compiledEntityIds = new Set();
  const scenes = value.scenes.map((scene, index) => {
    const field = `visualProgram.scenes[${index}]`;
    const sceneKeys = [
      "id", "purpose", "semanticFamily", "narrationBeatIds", "startFrame", "endFrame",
      "narrationStartFrame", "narrationEndFrame", "readabilityHold", "primary", "helper", "transitionId",
    ];
    exactKeys(scene, sceneKeys, sceneKeys, field);
    const startFrame = integer(scene.startFrame, `${field}.startFrame`, 0, duration.totalFrames - 1);
    const endFrame = integer(scene.endFrame, `${field}.endFrame`, startFrame + 1, duration.totalFrames);
    if (startFrame !== expectedStart) fail(`${field}.startFrame`, "scenes_not_contiguous");
    expectedStart = endFrame;
    const narrationStartFrame = integer(scene.narrationStartFrame, `${field}.narrationStartFrame`, startFrame, endFrame - 1);
    const narrationEndFrame = integer(scene.narrationEndFrame, `${field}.narrationEndFrame`, narrationStartFrame + 1, endFrame);
    exactKeys(scene.readabilityHold, ["startFrame", "endFrame"], ["startFrame", "endFrame"], `${field}.readabilityHold`);
    const readabilityHold = {
      startFrame: integer(scene.readabilityHold.startFrame, `${field}.readabilityHold.startFrame`, narrationStartFrame, endFrame - 1),
      endFrame: integer(scene.readabilityHold.endFrame, `${field}.readabilityHold.endFrame`, scene.readabilityHold.startFrame + 1, endFrame),
    };
    const id = text(scene.id, `${field}.id`, { max: 80, pattern: ID_RE });
    if (sceneIds.has(id)) fail(`${field}.id`, "duplicate_scene_id");
    sceneIds.add(id);
    const sceneBeatIds = strings(scene.narrationBeatIds, `${field}.narrationBeatIds`, { max: 5 });
    for (const beatId of sceneBeatIds) {
      if (narrationBeatIds.has(beatId)) fail(`${field}.narrationBeatIds`, "duplicate_narration_beat");
      narrationBeatIds.add(beatId);
    }
    const primary = normalizeCompiledPrimary(scene.primary, `${field}.primary`);
    const recipe = findVisualRecipe(primary.recipeId);
    if (
      !recipe
      || !recipe.semanticFamilies.includes(scene.semanticFamily)
      || !recipe.allowedPrimaryRoles.includes(primary.role)
      || !recipe.allowedActions.includes(primary.action)
      || !recipe.allowedTransitions.includes(scene.transitionId)
      || recipe.animationTemplate !== primary.template
      || recipe.complexityCost !== primary.complexityCost
    ) fail(`${field}.primary`, "compiled_recipe_binding_mismatch");
    if (compiledEntityIds.has(primary.entityId)) fail(`${field}.primary.entityId`, "duplicate_entity_id");
    compiledEntityIds.add(primary.entityId);
    const helper = normalizeCompiledHelper(scene.helper, `${field}.helper`);
    if (helper) {
      const helperRecipe = findVisualRecipe(helper.recipeId);
      if (!helperRecipe || !helperRecipe.allowedHelperRoles.includes(helper.role)) {
        fail(`${field}.helper`, "compiled_helper_recipe_binding_mismatch");
      }
      if (compiledEntityIds.has(helper.entityId)) fail(`${field}.helper.entityId`, "duplicate_entity_id");
      compiledEntityIds.add(helper.entityId);
    }
    return {
      id,
      purpose: text(scene.purpose, `${field}.purpose`, { max: 160 }),
      semanticFamily: text(scene.semanticFamily, `${field}.semanticFamily`, { max: 80, pattern: ID_RE }),
      narrationBeatIds: sceneBeatIds,
      startFrame,
      endFrame,
      narrationStartFrame,
      narrationEndFrame,
      readabilityHold,
      primary,
      helper,
      transitionId: oneOf(scene.transitionId, `${field}.transitionId`, VISUAL_TRANSITIONS),
    };
  });
  if (expectedStart !== duration.totalFrames) fail("visualProgram.scenes", "timeline_not_covered");
  const normalized = {
    schemaVersion: VISUAL_PROGRAM_SCHEMA_VERSION,
    profile: VISUAL_PROGRAM_PROFILE_ID,
    profileVersion: VISUAL_PROGRAM_PROFILE_VERSION,
    bindings: normalizeBindings(value.bindings, "visualProgram.bindings"),
    style: { tokenId: VISUAL_STYLE_TOKEN_ID, version: VISUAL_STYLE_TOKEN_VERSION },
    registry: { version: VISUAL_RECIPE_REGISTRY_VERSION, contentHash: VISUAL_RECIPE_REGISTRY_HASH },
    compiler: { version: value.compiler.version },
    duration,
    scenes,
  };
  const expectedHash = contentHash(normalized);
  if (value.contentHash !== expectedHash) fail("visualProgram.contentHash", "content_hash_mismatch");
  return deepFreeze({ ...normalized, contentHash: expectedHash });
}

module.exports = {
  MAX_VISUAL_PROGRAM_SCENES: MAX_SCENES,
  MIN_VISUAL_PROGRAM_SCENES: MIN_SCENES,
  VISUAL_PROGRAM_PROFILE_ID,
  VISUAL_PROGRAM_PROFILE_VERSION,
  VISUAL_PROGRAM_PROPOSAL_PROFILE_ID,
  VISUAL_PROGRAM_SCHEMA_VERSION,
  deepFreezeVisualProgram: deepFreeze,
  normalizeVisualProgramProposalV1,
  normalizeVisualProgramV1,
  visualProgramContentHash: contentHash,
};
