"use strict";

const { AppError } = require("../../../errors.cjs");
const { contentHash, normalizeDraftBundle } = require("../contracts.cjs");
const {
  ARCHETYPE_IDS,
  STORY_VOCABULARIES,
  classifyStoryVocabulary,
  inferEntityKind,
  inferStoryEntityKind,
  resolveSceneArchetype,
  sourceOperationIndexes,
} = require("./scene-archetype-registry.cjs");

const SEMANTIC_VISUAL_PLAN_SCHEMA_VERSION = 2;
const SEMANTIC_VISUAL_PROFILE_ID = "documented_mystery_semantic_v2";
const GENERIC_SEMANTIC_PROFILE_ID = SEMANTIC_VISUAL_PROFILE_ID;
const SCENE_ROLES = Object.freeze(["hook", "context", "evidence", "turn", "payoff"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,79}$/;
const LABEL_FIELDS = Object.freeze(["text", "label", "date", "leftLabel", "rightLabel"]);
const VOCABULARY_ENTITY_POLICY = Object.freeze({
  temporal_anomaly: Object.freeze({
    required: Object.freeze(["clock", "timeline"]),
    forbidden: Object.freeze(["telescope"]),
  }),
  maritime_route: Object.freeze({
    required: Object.freeze(["maritime_route"]),
    forbidden: Object.freeze(["telescope"]),
  }),
  radio_signal: Object.freeze({
    required: Object.freeze(["radio_signal", "telescope"]),
    forbidden: Object.freeze([]),
  }),
  general_mystery: Object.freeze({
    required: Object.freeze([]),
    forbidden: Object.freeze([]),
  }),
});

function fail(field, reason = "invalid") {
  throw new AppError(
    "ANIMATION_VISUAL_PLAN_INVALID",
    "The semantic visual plan is invalid or is not grounded in the approved storyboard.",
    409,
    { field, reason },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, field) {
  if (!isPlainObject(value)) fail(field, "object_required");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(field, "unsupported_or_missing_field");
  }
}

function nonEmptyString(value, field, options = {}) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) fail(field, "non_empty_string_required");
  if (value.length > (options.max || 240)) fail(field, "text_too_long");
  if (options.pattern && !options.pattern.test(value)) fail(field, "invalid_format");
  return value;
}

function nullableLabel(value, field) {
  if (value === null) return null;
  return nonEmptyString(value, field, { max: 160 });
}

function hash(value, field) {
  return nonEmptyString(value, field, { max: 64, pattern: HASH_PATTERN });
}

function stringList(value, field, options = {}) {
  if (!Array.isArray(value) || value.length < (options.minimum || 0)) fail(field, "non_empty_array_required");
  const output = value.map((item, index) => nonEmptyString(item, `${field}[${index}]`, {
    max: options.max || 80,
    pattern: options.pattern,
  }));
  if (new Set(output).size !== output.length) fail(field, "duplicates_not_allowed");
  if (options.sorted && output.some((item, index) => index > 0 && output[index - 1].localeCompare(item) > 0)) {
    fail(field, "stable_sort_required");
  }
  return output;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function labelCandidates(scene, indexes) {
  const values = [];
  for (const index of indexes) {
    const operation = scene.operations[index];
    for (const field of LABEL_FIELDS) {
      const candidate = operation[field];
      if (typeof candidate === "string" && candidate.trim() && !values.includes(candidate)) values.push(candidate);
    }
  }
  if (scene.disclosure && !values.includes(scene.disclosure)) values.push(scene.disclosure);
  return values;
}

function sourceLabels(scene, indexes) {
  const candidates = labelCandidates(scene, indexes);
  if (!candidates.length) fail(`storyboard.scenes.${scene.id}.operations`, "source_label_required");
  return {
    heading: candidates[0],
    primaryLabel: candidates[1] || candidates[0],
    secondaryLabel: candidates[2] || null,
  };
}

function sourceGeometry(scene, indexes) {
  const route = indexes
    .map((index) => scene.operations[index])
    .find((operation) => operation.op === "draw_route" && Array.isArray(operation.points));
  return route ? { points: route.points.map((point) => [...point]) } : {};
}

function beatBindings(draft) {
  const byId = new Map(draft.script.beats.map((beat) => [beat.id, beat]));
  const byRole = new Map(draft.script.beats.map((beat) => [beat.role, beat]));
  if (byRole.size !== SCENE_ROLES.length) fail("draft.script.beats", "exactly_five_roles_required");
  for (const role of SCENE_ROLES) {
    const beat = byRole.get(role);
    if (!beat) fail(`draft.script.beats.${role}`, "role_required");
    if (!Array.isArray(beat.claimIds) || beat.claimIds.length === 0) fail(`draft.script.beats.${role}.claimIds`, "claims_required");
  }
  return { byId, byRole };
}

function storyboardBindings(draft, beats) {
  const byBeatId = new Map();
  for (const scene of draft.storyboard.scenes) {
    if (scene.beatIds.length !== 1) fail(`draft.storyboard.scenes.${scene.id}.beatIds`, "single_beat_binding_required");
    const beatId = scene.beatIds[0];
    if (!beats.byId.has(beatId) || byBeatId.has(beatId)) {
      fail(`draft.storyboard.scenes.${scene.id}.beatIds`, "unique_known_beat_binding_required");
    }
    byBeatId.set(beatId, scene);
  }
  for (const role of SCENE_ROLES) {
    if (!byBeatId.has(beats.byRole.get(role).id)) fail(`draft.storyboard.scenes.${role}`, "source_scene_required");
  }
  return byBeatId;
}

function entityPolicy(storyVocabulary, scenes) {
  const policy = VOCABULARY_ENTITY_POLICY[storyVocabulary];
  const discovered = scenes.map((scene) => scene.entityKind);
  const requiredEntityKinds = [...new Set([...policy.required, ...discovered])].sort();
  const forbiddenEntityKinds = [...policy.forbidden].sort();
  if (requiredEntityKinds.some((kind) => forbiddenEntityKinds.includes(kind))) {
    fail("requiredEntityKinds", "required_entity_is_forbidden");
  }
  return { requiredEntityKinds, forbiddenEntityKinds };
}

function buildScene({ role, beat, sourceScene, storyVocabulary, storyEntityKind }) {
  const archetypeId = resolveSceneArchetype(sourceScene, storyVocabulary);
  if (!archetypeId || !ARCHETYPE_IDS.includes(archetypeId)) {
    fail(`draft.storyboard.scenes.${sourceScene.id}`, "archetype_not_resolved");
  }
  const operationIndexes = sourceOperationIndexes(sourceScene, archetypeId);
  if (!operationIndexes.length) fail(`draft.storyboard.scenes.${sourceScene.id}.operations`, "source_operation_required");
  const labels = sourceLabels(sourceScene, operationIndexes);
  const entityKind = inferEntityKind(sourceScene, archetypeId, storyVocabulary, storyEntityKind);
  if (!entityKind) fail(`draft.storyboard.scenes.${sourceScene.id}`, "entity_kind_not_resolved");
  return {
    id: `visual_${role}`,
    sourceSceneId: sourceScene.id,
    sourceTemplate: sourceScene.template,
    sourceOperationIndexes: operationIndexes,
    beatId: beat.id,
    role,
    claimIds: [...beat.claimIds],
    archetypeId,
    ...labels,
    entityKind,
    geometry: sourceGeometry(sourceScene, operationIndexes),
    disclosure: sourceScene.disclosure || null,
  };
}

function normalizeScene(input, index) {
  const field = `scenes[${index}]`;
  exactKeys(input, [
    "id",
    "sourceSceneId",
    "sourceTemplate",
    "sourceOperationIndexes",
    "beatId",
    "role",
    "claimIds",
    "archetypeId",
    "heading",
    "primaryLabel",
    "secondaryLabel",
    "entityKind",
    "geometry",
    "disclosure",
  ], field);
  const role = nonEmptyString(input.role, `${field}.role`, { max: 20 });
  if (role !== SCENE_ROLES[index]) fail(`${field}.role`, "role_order_invalid");
  if (input.id !== `visual_${role}`) fail(`${field}.id`, "scene_id_invalid");
  if (!ARCHETYPE_IDS.includes(input.archetypeId)) fail(`${field}.archetypeId`, "unsupported_archetype");
  if (!Array.isArray(input.sourceOperationIndexes) || input.sourceOperationIndexes.length === 0) {
    fail(`${field}.sourceOperationIndexes`, "source_operations_required");
  }
  const sourceOperationIndexes = input.sourceOperationIndexes.map((value, operationIndex) => {
    if (!Number.isInteger(value) || value < 0 || value > 39) fail(`${field}.sourceOperationIndexes[${operationIndex}]`, "operation_index_invalid");
    return value;
  });
  if (
    new Set(sourceOperationIndexes).size !== sourceOperationIndexes.length
    || sourceOperationIndexes.some((value, operationIndex) => operationIndex > 0 && value <= sourceOperationIndexes[operationIndex - 1])
  ) fail(`${field}.sourceOperationIndexes`, "operation_indexes_not_unique_and_sorted");

  exactKeys(input.geometry, Object.hasOwn(input.geometry, "points") ? ["points"] : [], `${field}.geometry`);
  const geometry = {};
  if (input.geometry.points !== undefined) {
    if (!Array.isArray(input.geometry.points) || input.geometry.points.length < 2 || input.geometry.points.length > 12) {
      fail(`${field}.geometry.points`, "route_points_invalid");
    }
    geometry.points = input.geometry.points.map((point, pointIndex) => {
      if (!Array.isArray(point) || point.length !== 2 || point.some((coordinate) => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)) {
        fail(`${field}.geometry.points[${pointIndex}]`, "point_invalid");
      }
      return [...point];
    });
  }

  return {
    id: input.id,
    sourceSceneId: nonEmptyString(input.sourceSceneId, `${field}.sourceSceneId`, { max: 80, pattern: ID_PATTERN }),
    sourceTemplate: nonEmptyString(input.sourceTemplate, `${field}.sourceTemplate`, { max: 80 }),
    sourceOperationIndexes,
    beatId: nonEmptyString(input.beatId, `${field}.beatId`, { max: 80, pattern: ID_PATTERN }),
    role,
    claimIds: stringList(input.claimIds, `${field}.claimIds`, { minimum: 1, pattern: ID_PATTERN }),
    archetypeId: input.archetypeId,
    heading: nonEmptyString(input.heading, `${field}.heading`, { max: 160 }),
    primaryLabel: nonEmptyString(input.primaryLabel, `${field}.primaryLabel`, { max: 160 }),
    secondaryLabel: nullableLabel(input.secondaryLabel, `${field}.secondaryLabel`),
    entityKind: nonEmptyString(input.entityKind, `${field}.entityKind`, { max: 80, pattern: ID_PATTERN }),
    geometry,
    disclosure: nullableLabel(input.disclosure, `${field}.disclosure`),
  };
}

function normalizeSemanticVisualPlan(input) {
  exactKeys(input, [
    "schemaVersion",
    "profileId",
    "sourceStoryboardHash",
    "draftHash",
    "timingContextHash",
    "storyVocabulary",
    "requiredEntityKinds",
    "forbiddenEntityKinds",
    "scenes",
  ], "visualPlan");
  if (input.schemaVersion !== SEMANTIC_VISUAL_PLAN_SCHEMA_VERSION) fail("schemaVersion", "unsupported_schema");
  if (input.profileId !== SEMANTIC_VISUAL_PROFILE_ID) fail("profileId", "unsupported_profile");
  if (!STORY_VOCABULARIES.includes(input.storyVocabulary)) fail("storyVocabulary", "unsupported_vocabulary");
  if (!Array.isArray(input.scenes) || input.scenes.length !== SCENE_ROLES.length) fail("scenes", "exactly_five_scenes_required");
  const normalized = {
    schemaVersion: SEMANTIC_VISUAL_PLAN_SCHEMA_VERSION,
    profileId: SEMANTIC_VISUAL_PROFILE_ID,
    sourceStoryboardHash: hash(input.sourceStoryboardHash, "sourceStoryboardHash"),
    draftHash: hash(input.draftHash, "draftHash"),
    timingContextHash: hash(input.timingContextHash, "timingContextHash"),
    storyVocabulary: input.storyVocabulary,
    requiredEntityKinds: stringList(input.requiredEntityKinds, "requiredEntityKinds", { sorted: true, pattern: ID_PATTERN }),
    forbiddenEntityKinds: stringList(input.forbiddenEntityKinds, "forbiddenEntityKinds", { sorted: true, pattern: ID_PATTERN }),
    scenes: input.scenes.map(normalizeScene),
  };
  if (normalized.requiredEntityKinds.some((kind) => normalized.forbiddenEntityKinds.includes(kind))) {
    fail("requiredEntityKinds", "required_entity_is_forbidden");
  }
  return deepFreeze(normalized);
}

function expectedPlan({ draft, timingContextHash }) {
  const beats = beatBindings(draft);
  const sources = storyboardBindings(draft, beats);
  const storyVocabulary = classifyStoryVocabulary(draft.storyboard);
  const storyEntityKind = inferStoryEntityKind(draft.storyboard, storyVocabulary);
  const scenes = SCENE_ROLES.map((role) => buildScene({
    role,
    beat: beats.byRole.get(role),
    sourceScene: sources.get(beats.byRole.get(role).id),
    storyVocabulary,
    storyEntityKind,
  }));
  const policy = entityPolicy(storyVocabulary, scenes);
  return {
    schemaVersion: SEMANTIC_VISUAL_PLAN_SCHEMA_VERSION,
    profileId: SEMANTIC_VISUAL_PROFILE_ID,
    sourceStoryboardHash: draft.storyboard.contentHash,
    draftHash: draft.contentHash,
    timingContextHash,
    storyVocabulary,
    ...policy,
    scenes,
  };
}

function buildSemanticVisualPlan(input = {}) {
  let draft;
  try {
    draft = normalizeDraftBundle(input.draft);
  } catch (error) {
    if (error?.code === "ANIMATION_VISUAL_PLAN_INVALID") throw error;
    fail("draft", "normalized_draft_required");
  }
  const timingContextHash = input.timingContext?.contentHash;
  hash(timingContextHash, "timingContext.contentHash");
  if (input.timingContext.draftHash && input.timingContext.draftHash !== draft.contentHash) {
    fail("timingContext.draftHash", "draft_binding_mismatch");
  }
  const plan = normalizeSemanticVisualPlan(expectedPlan({ draft, timingContextHash }));
  validateSemanticVisualPlanAgainstDraft(plan, { draft, timingContext: input.timingContext });
  return plan;
}

function validateSemanticVisualPlanAgainstDraft(input, context = {}, optionalTimingContext = null) {
  const plan = normalizeSemanticVisualPlan(input);
  let suppliedDraft = context?.draft;
  let timingContext = context?.timingContext;
  if (!suppliedDraft && context?.storyboard && context?.script) {
    suppliedDraft = context;
    timingContext = optionalTimingContext;
  }
  let draft;
  try {
    draft = normalizeDraftBundle(suppliedDraft);
  } catch (error) {
    if (error?.code === "ANIMATION_VISUAL_PLAN_INVALID") throw error;
    fail("draft", "normalized_draft_required");
  }
  const expectedTimingHash = timingContext?.contentHash || plan.timingContextHash;
  hash(expectedTimingHash, "timingContextHash");
  if (timingContext?.draftHash && timingContext.draftHash !== draft.contentHash) {
    fail("timingContext.draftHash", "draft_binding_mismatch");
  }
  const expected = normalizeSemanticVisualPlan(expectedPlan({ draft, timingContextHash: expectedTimingHash }));
  if (contentHash(plan) !== contentHash(expected)) fail("visualPlan", "source_binding_mismatch");
  return plan;
}

module.exports = {
  GENERIC_SEMANTIC_PROFILE_ID,
  SCENE_ROLES,
  SEMANTIC_VISUAL_PLAN_SCHEMA_VERSION,
  SEMANTIC_VISUAL_PROFILE_ID,
  STORY_VOCABULARIES,
  VOCABULARY_ENTITY_POLICY,
  buildSemanticVisualPlan,
  normalizeSemanticVisualPlan,
  validateSemanticVisualPlanAgainstDraft,
};
