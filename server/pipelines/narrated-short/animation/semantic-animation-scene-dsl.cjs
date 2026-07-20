"use strict";

const { createHash } = require("node:crypto");

const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  normalizeSemanticPrimitiveParameters,
} = require("./semantic-primitive-parameters.cjs");
const {
  normalizeSemanticSceneComposition,
} = require("./semantic-scene-composition.cjs");

const SEMANTIC_ANIMATION_SCENE_DSL_SCHEMA_VERSION = 1;
const SEMANTIC_ANIMATION_SCENE_DSL_PROFILE_ID =
  "dark_curiosity_animation_scene_dsl_v1";
const SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION = 1;
const MAX_PROPOSED_ACTIONS = 4;
const MAX_FINAL_ACTIONS = 7;
const MAX_SCENE_COST = 12;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z][a-z0-9_-]{1,159}$/;
const PHASE_ORDER = Object.freeze({
  entry: 0,
  develop: 1,
  resolve: 2,
});
const OPERATION_ORDER = Object.freeze({
  create: 0,
  move: 1,
  transform: 2,
  highlight: 3,
  camera: 4,
});
const ACTION_COSTS = Object.freeze({
  create: 1,
  transform: 4,
  move: 3,
  highlight: 2,
  camera: 4,
});
const MODULE_TARGETS = Object.freeze([
  "module_primary",
  "module_support_a",
  "module_support_b",
]);
const MANDATORY_CREATE_ACTIONS = Object.freeze(MODULE_TARGETS.map((target) => (
  Object.freeze({
    op: "create",
    target,
    phase: "entry",
    preset: "reveal",
  })
)));
const MANDATORY_CREATE_COST = MANDATORY_CREATE_ACTIONS.reduce(
  (sum, action) => sum + ACTION_COSTS[action.op],
  0,
);
const ACTION_RULES = Object.freeze({
  create: Object.freeze({
    targets: MODULE_TARGETS,
    phases: Object.freeze(["entry"]),
    presets: Object.freeze(["reveal"]),
  }),
  transform: Object.freeze({
    targets: Object.freeze(["module_primary"]),
    phases: Object.freeze(["develop", "resolve"]),
    presets: Object.freeze(["semantic_transition"]),
  }),
  move: Object.freeze({
    targets: Object.freeze(["module_primary"]),
    phases: Object.freeze(["develop"]),
    presets: Object.freeze(["follow_grounded_route"]),
  }),
  highlight: Object.freeze({
    targets: MODULE_TARGETS,
    phases: Object.freeze(["develop", "resolve"]),
    presets: Object.freeze(["pulse_once"]),
  }),
  camera: Object.freeze({
    targets: Object.freeze(["scene"]),
    phases: Object.freeze(["develop", "resolve"]),
    presets: Object.freeze(["push_primary", "pull_overview"]),
  }),
});

function fail(field, reason = "invalid", code = "ANIMATION_SCENE_DSL_INVALID") {
  throw new AppError(
    code,
    code === "ANIMATION_SCENE_PROPOSAL_INVALID"
      ? "The animation scene proposal is invalid."
      : "The animation scene DSL is invalid or is not grounded in its semantic sentence.",
    409,
    { field, reason },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, field, optional = [], code) {
  if (!isPlainObject(value)) fail(field, "object_required", code);
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.some((key) => typeof key !== "string")) {
    fail(`${field}.*`, "unsupported_field", code);
  }
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) fail(`${field}.*`, "plain_data_field_required", code);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of actualKeys) {
    if (!allowed.has(key)) {
      fail(`${field}.*`, "unsupported_field", code);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(`${field}.${key}`, "field_required", code);
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
  ) fail(field, "bounded_safe_text_required", options.code);
  return value;
}

function hash(value, field) {
  return text(value, field, { maximum: 64, pattern: HASH_PATTERN });
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(field, "integer_out_of_range");
  }
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

function semanticPrimitiveParametersHash(value) {
  return canonicalHash(normalizeSemanticPrimitiveParameters(value));
}

function semanticSceneCompositionHash(value) {
  return canonicalHash(normalizeSemanticSceneComposition(value));
}

function compareActions(left, right) {
  return (
    PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase]
    || OPERATION_ORDER[left.op] - OPERATION_ORDER[right.op]
    || MODULE_TARGETS.indexOf(left.target) - MODULE_TARGETS.indexOf(right.target)
    || left.target.localeCompare(right.target)
    || left.preset.localeCompare(right.preset)
  );
}

function normalizeAction(input, field, options = {}) {
  exactKeys(
    input,
    ["op", "target", "phase", "preset"],
    field,
    [],
    options.code,
  );
  const op = text(input.op, `${field}.op`, {
    maximum: 32,
    pattern: ID_PATTERN,
    code: options.code,
  });
  const target = text(input.target, `${field}.target`, {
    maximum: 32,
    pattern: ID_PATTERN,
    code: options.code,
  });
  const phase = text(input.phase, `${field}.phase`, {
    maximum: 32,
    pattern: ID_PATTERN,
    code: options.code,
  });
  const preset = text(input.preset, `${field}.preset`, {
    maximum: 48,
    pattern: ID_PATTERN,
    code: options.code,
  });
  const rule = ACTION_RULES[op];
  if (!rule) fail(`${field}.op`, "unsupported_value", options.code);
  if (options.allowCreate !== true && op === "create") {
    fail(`${field}.op`, "server_owned_operation", options.code);
  }
  if (!rule.targets.includes(target)) {
    fail(`${field}.target`, "operation_target_mismatch", options.code);
  }
  if (!rule.phases.includes(phase)) {
    fail(`${field}.phase`, "operation_phase_mismatch", options.code);
  }
  if (!rule.presets.includes(preset)) {
    fail(`${field}.preset`, "operation_preset_mismatch", options.code);
  }
  return { op, target, phase, preset };
}

function validateActionTopology(actions, field, options = {}) {
  const signatures = actions.map((action) => `${action.op}:${action.target}`);
  if (new Set(signatures).size !== signatures.length) {
    fail(field, "duplicate_operation_target", options.code);
  }
  const phaseCounts = new Map();
  for (const action of actions) {
    phaseCounts.set(action.phase, (phaseCounts.get(action.phase) || 0) + 1);
  }
  if ([...phaseCounts.values()].some((count) => count > 3)) {
    fail(field, "phase_action_limit_exceeded", options.code);
  }
  if (actions.filter((action) => action.op === "camera").length > 1) {
    fail(field, "camera_action_limit_exceeded", options.code);
  }
}

function normalizeSemanticAnimationSceneProposal(input, options = {}) {
  const code = "ANIMATION_SCENE_PROPOSAL_INVALID";
  exactKeys(input, ["schemaVersion", "actions"], "proposal", [], code);
  if (input.schemaVersion !== SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION) {
    fail("proposal.schemaVersion", "unsupported_schema", code);
  }
  if (
    !Array.isArray(input.actions)
    || input.actions.length < 1
    || input.actions.length > MAX_PROPOSED_ACTIONS
  ) fail("proposal.actions", "array_size_invalid", code);
  const actions = input.actions.map((action, index) => normalizeAction(
    action,
    `proposal.actions[${index}]`,
    { allowCreate: false, code },
  ));
  validateActionTopology(actions, "proposal.actions", { code });
  if (!actions.some((action) => action.phase === "resolve")) {
    fail("proposal.actions", "resolve_action_required", code);
  }
  if (!actions.some((action) => (
    action.target === "module_primary" || action.target === "scene"
  ))) fail("proposal.actions", "primary_action_required", code);
  if (
    actions.some((action) => action.op === "move")
    && options.hasApprovedRoute !== true
  ) fail("proposal.actions", "approved_route_required", code);
  const totalCost = MANDATORY_CREATE_COST + actions.reduce(
    (sum, action) => sum + ACTION_COSTS[action.op],
    0,
  );
  if (totalCost > MAX_SCENE_COST) {
    fail("proposal.actions", "scene_cost_exceeded", code);
  }
  return deepFreeze({
    schemaVersion: SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION,
    actions: actions.sort(compareActions),
  });
}

function normalizeBindings(input) {
  exactKeys(input, [
    "semanticEventGraphHash",
    "semanticVisualSentencePlanHash",
    "propositionId",
    "primitiveParametersHash",
    "sceneCompositionHash",
  ], "sceneDsl.bindings");
  return {
    semanticEventGraphHash: hash(
      input.semanticEventGraphHash,
      "sceneDsl.bindings.semanticEventGraphHash",
    ),
    semanticVisualSentencePlanHash: hash(
      input.semanticVisualSentencePlanHash,
      "sceneDsl.bindings.semanticVisualSentencePlanHash",
    ),
    propositionId: text(input.propositionId, "sceneDsl.bindings.propositionId", {
      pattern: ID_PATTERN,
    }),
    primitiveParametersHash: hash(
      input.primitiveParametersHash,
      "sceneDsl.bindings.primitiveParametersHash",
    ),
    sceneCompositionHash: hash(
      input.sceneCompositionHash,
      "sceneDsl.bindings.sceneCompositionHash",
    ),
  };
}

function semanticAnimationSceneDslContentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return canonicalHash(copy);
}

function normalizeSemanticAnimationSceneDsl(input, options = {}) {
  exactKeys(input, [
    "schemaVersion",
    "profileId",
    "id",
    "bindings",
    "actions",
    "computedCost",
  ], "sceneDsl", ["contentHash"]);
  if (input.schemaVersion !== SEMANTIC_ANIMATION_SCENE_DSL_SCHEMA_VERSION) {
    fail("sceneDsl.schemaVersion", "unsupported_schema");
  }
  if (input.profileId !== SEMANTIC_ANIMATION_SCENE_DSL_PROFILE_ID) {
    fail("sceneDsl.profileId", "unsupported_profile");
  }
  const bindings = normalizeBindings(input.bindings);
  const id = text(input.id, "sceneDsl.id", {
    maximum: 180,
    pattern: ID_PATTERN,
  });
  if (id !== `scene_dsl_${bindings.propositionId}`) {
    fail("sceneDsl.id", "proposition_binding_mismatch");
  }
  if (
    !Array.isArray(input.actions)
    || input.actions.length < MANDATORY_CREATE_ACTIONS.length + 1
    || input.actions.length > MAX_FINAL_ACTIONS
  ) fail("sceneDsl.actions", "array_size_invalid");
  const actions = input.actions.map((action, index) => normalizeAction(
    action,
    `sceneDsl.actions[${index}]`,
    { allowCreate: true },
  ));
  validateActionTopology(actions, "sceneDsl.actions");
  const createActions = actions.filter((action) => action.op === "create");
  if (
    stableStringify(createActions) !== stableStringify(MANDATORY_CREATE_ACTIONS)
  ) fail("sceneDsl.actions", "mandatory_create_topology_mismatch");
  const proposedActions = actions.filter((action) => action.op !== "create");
  try {
    normalizeSemanticAnimationSceneProposal({
      schemaVersion: SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION,
      actions: proposedActions,
    }, {
      hasApprovedRoute: options.hasApprovedRoute === true,
    });
  } catch (cause) {
    if (cause?.code !== "ANIMATION_SCENE_PROPOSAL_INVALID") throw cause;
    fail(
      "sceneDsl.actions",
      cause?.details?.reason || "proposal_invalid",
    );
  }
  const canonicalActions = [...actions].sort(compareActions);
  if (stableStringify(actions) !== stableStringify(canonicalActions)) {
    fail("sceneDsl.actions", "actions_not_canonical");
  }
  const computedCost = actions.reduce(
    (sum, action) => sum + ACTION_COSTS[action.op],
    0,
  );
  if (
    integer(input.computedCost, "sceneDsl.computedCost", 1, MAX_SCENE_COST)
    !== computedCost
  ) fail("sceneDsl.computedCost", "computed_cost_mismatch");
  const normalized = {
    schemaVersion: SEMANTIC_ANIMATION_SCENE_DSL_SCHEMA_VERSION,
    profileId: SEMANTIC_ANIMATION_SCENE_DSL_PROFILE_ID,
    id,
    bindings,
    actions,
    computedCost,
  };
  const contentHash = semanticAnimationSceneDslContentHash(normalized);
  if (input.contentHash !== undefined) {
    hash(input.contentHash, "sceneDsl.contentHash");
    if (input.contentHash !== contentHash) {
      fail("sceneDsl.contentHash", "content_hash_mismatch");
    }
  }
  return deepFreeze({ ...normalized, contentHash });
}

function normalizeBuildContext(input, options = {}) {
  if (!isPlainObject(input)) fail("context", "object_required");
  exactKeys(input, [
    "semanticEventGraphHash",
    "semanticVisualSentencePlanHash",
    "propositionId",
    "primitiveParameters",
    "sceneComposition",
  ], "context", options.allowProposal === true ? ["proposal"] : []);
  const semanticEventGraphHash = hash(
    input.semanticEventGraphHash,
    "context.semanticEventGraphHash",
  );
  const semanticVisualSentencePlanHash = hash(
    input.semanticVisualSentencePlanHash,
    "context.semanticVisualSentencePlanHash",
  );
  const propositionId = text(input.propositionId, "context.propositionId", {
    pattern: ID_PATTERN,
  });
  const primitiveParameters = normalizeSemanticPrimitiveParameters(
    input.primitiveParameters,
  );
  const sceneComposition = normalizeSemanticSceneComposition(
    input.sceneComposition,
  );
  if (sceneComposition.id !== `composition_${propositionId}`) {
    fail("context.sceneComposition.id", "proposition_binding_mismatch");
  }
  return {
    semanticEventGraphHash,
    semanticVisualSentencePlanHash,
    propositionId,
    primitiveParameters,
    sceneComposition,
  };
}

function buildSemanticAnimationSceneDsl(input = {}) {
  const context = normalizeBuildContext(input, { allowProposal: true });
  const proposal = normalizeSemanticAnimationSceneProposal(input.proposal, {
    hasApprovedRoute: context.primitiveParameters.geometry.route !== null,
  });
  const actions = [
    ...MANDATORY_CREATE_ACTIONS.map((action) => ({ ...action })),
    ...proposal.actions.map((action) => ({ ...action })),
  ].sort(compareActions);
  const computedCost = actions.reduce(
    (sum, action) => sum + ACTION_COSTS[action.op],
    0,
  );
  return normalizeSemanticAnimationSceneDsl({
    schemaVersion: SEMANTIC_ANIMATION_SCENE_DSL_SCHEMA_VERSION,
    profileId: SEMANTIC_ANIMATION_SCENE_DSL_PROFILE_ID,
    id: `scene_dsl_${context.propositionId}`,
    bindings: {
      semanticEventGraphHash: context.semanticEventGraphHash,
      semanticVisualSentencePlanHash:
        context.semanticVisualSentencePlanHash,
      propositionId: context.propositionId,
      primitiveParametersHash: semanticPrimitiveParametersHash(
        context.primitiveParameters,
      ),
      sceneCompositionHash: semanticSceneCompositionHash(
        context.sceneComposition,
      ),
    },
    actions,
    computedCost,
  }, {
    hasApprovedRoute: context.primitiveParameters.geometry.route !== null,
  });
}

function validateSemanticAnimationSceneDslAgainstContext(input, contextInput) {
  const context = normalizeBuildContext(contextInput);
  const sceneDsl = normalizeSemanticAnimationSceneDsl(input, {
    hasApprovedRoute: context.primitiveParameters.geometry.route !== null,
  });
  const proposal = {
    schemaVersion: SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION,
    actions: sceneDsl.actions
      .filter((action) => action.op !== "create")
      .map((action) => ({ ...action })),
  };
  const expected = buildSemanticAnimationSceneDsl({
    ...context,
    proposal,
  });
  if (stableStringify(sceneDsl) !== stableStringify(expected)) {
    fail("sceneDsl.bindings", "semantic_sentence_binding_mismatch");
  }
  return sceneDsl;
}

module.exports = {
  ACTION_COSTS,
  ACTION_RULES,
  MANDATORY_CREATE_ACTIONS,
  MAX_FINAL_ACTIONS,
  MAX_PROPOSED_ACTIONS,
  MAX_SCENE_COST,
  SEMANTIC_ANIMATION_SCENE_DSL_PROFILE_ID,
  SEMANTIC_ANIMATION_SCENE_DSL_SCHEMA_VERSION,
  SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION,
  buildSemanticAnimationSceneDsl,
  normalizeSemanticAnimationSceneDsl,
  normalizeSemanticAnimationSceneProposal,
  semanticAnimationSceneDslContentHash,
  semanticPrimitiveParametersHash,
  semanticSceneCompositionHash,
  validateSemanticAnimationSceneDslAgainstContext,
};
