"use strict";

const { createHash } = require("node:crypto");

const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  SEMANTIC_SENTENCE_RENDERER_ASSET_IDS,
  SEMANTIC_SENTENCE_RENDERER_GRAMMAR_ASSET_BINDINGS,
  SEMANTIC_SENTENCE_RENDERER_GRAMMAR_IDS,
} = require("./semantic-render-profile.cjs");
const {
  UPCOMING_SEMANTIC_VISUAL_CONCEPT_IDS,
  semanticVisualConceptBindingMatches,
  semanticVisualConceptGroundingMatches,
} = require("./semantic-visual-concept-registry.cjs");

const SEMANTIC_PRIMITIVE_PARAMETER_SCHEMA_VERSION = 2;
const SEMANTIC_PRIMITIVE_PARAMETER_PROFILE_ID =
  "dark_curiosity_story_primitive_parameters_v2";
const ID_PATTERN = /^[a-z][a-z0-9_-]{1,79}$/;
const REMOTE_URL = /\bhttps?:\/\//i;
const SOURCE_REF_TYPES = Object.freeze([
  "brief",
  "beat",
  "claim",
  "storyboard_scene",
  "storyboard_operation",
]);
const SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR = Object.freeze({
  before_after: "grounded_calendar_v1",
  bounded_uncertainty: "grounded_uncertainty_v1",
  cause_effect_chain: "grounded_cause_effect_v1",
  chronology_accumulation: "grounded_chronology_v1",
  evidence_inspection: "grounded_evidence_v1",
  finite_cycle: "grounded_cycle_v1",
  map_motion: "grounded_route_v1",
  negative_space_absence: "grounded_absence_v1",
  side_by_side_comparison: "grounded_comparison_v1",
});
const SEMANTIC_PRIMITIVE_STATE_TOKENS = Object.freeze([
  "ABSENT",
  "CHANGED",
  "COMPARED",
  "IN MOTION",
  "LAST RECORD",
  "LIMIT",
  "OBSERVED",
  "UPCOMING",
  "RECORDED",
  "REJECTED",
  "REPEATS",
  "RESULT",
  "UNRESOLVED",
  "UPDATE REQUIRED",
  "WRONG",
]);

function fail(field, reason = "invalid") {
  throw new AppError(
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "Semantic primitive parameters are invalid or are not grounded in the semantic event graph.",
    409,
    { field, reason },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, field) {
  if (!isPlainObject(value)) fail(field, "object_required");
  const expected = [...required].sort();
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    fail(field, "unsupported_or_missing_field");
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) fail(`${field}.${key}`, "plain_data_field_required");
  }
  actual.sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) fail(field, "unsupported_or_missing_field");
}

function denseDataArray(value, field, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(field, "array_size_invalid");
  }
  const expected = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    fail(field, "dense_data_array_required");
  }
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) fail(`${field}[${index}]`, "dense_data_array_required");
    entries.push(descriptor.value);
  }
  return entries;
}

function text(value, field, options = {}) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > (options.max || 240)
    || /[\u0000-\u001f\u007f]/.test(value)
    || REMOTE_URL.test(value)
    || (options.pattern && !options.pattern.test(value))
  ) fail(field, "bounded_safe_text_required");
  return value;
}

function integer(value, field, minimum, maximum) {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < minimum
    || value > maximum
  ) {
    fail(field, "integer_out_of_range");
  }
  return value;
}

function normalizeSourceRef(input, field) {
  exactKeys(input, [
    "sourceType",
    "sourceId",
    "operationIndex",
    "field",
    "startOffset",
    "endOffset",
    "value",
  ], field);
  const sourceType = text(input.sourceType, `${field}.sourceType`, {
    max: 80,
    pattern: ID_PATTERN,
  });
  if (!SOURCE_REF_TYPES.includes(sourceType)) {
    fail(`${field}.sourceType`, "unsupported_value");
  }
  const operationIndex = input.operationIndex === null
    ? null
    : integer(input.operationIndex, `${field}.operationIndex`, 0, 39);
  if ((sourceType === "storyboard_operation") !== (operationIndex !== null)) {
    fail(`${field}.operationIndex`, "operation_index_binding_invalid");
  }
  const startOffset = integer(input.startOffset, `${field}.startOffset`, 0, 2000);
  const endOffset = integer(input.endOffset, `${field}.endOffset`, startOffset + 1, 2000);
  const value = text(input.value, `${field}.value`, { max: 400 });
  if (endOffset - startOffset !== value.length) {
    fail(`${field}.endOffset`, "source_range_length_mismatch");
  }
  return {
    sourceType,
    sourceId: text(input.sourceId, `${field}.sourceId`, {
      max: 80,
      pattern: ID_PATTERN,
    }),
    operationIndex,
    field: text(input.field, `${field}.field`, {
      max: 80,
      pattern: /^[A-Za-z][A-Za-z0-9]*$/,
    }),
    startOffset,
    endOffset,
    value,
  };
}

function normalizeGroundedText(input, field) {
  exactKeys(input, ["value", "sourceRef"], field);
  const value = text(input.value, `${field}.value`, { max: 160 });
  const sourceRef = normalizeSourceRef(input.sourceRef, `${field}.sourceRef`);
  if (sourceRef.value !== value) fail(`${field}.value`, "source_value_mismatch");
  return { value, sourceRef };
}

function normalizeQuantity(input, field) {
  if (input === null) return null;
  exactKeys(input, ["value", "unit", "valueSourceRef", "unitSourceRef"], field);
  const value = text(input.value, `${field}.value`, { max: 80 });
  const unit = input.unit === null
    ? null
    : text(input.unit, `${field}.unit`, { max: 80 });
  const valueSourceRef = normalizeSourceRef(
    input.valueSourceRef,
    `${field}.valueSourceRef`,
  );
  const unitSourceRef = input.unitSourceRef === null
    ? null
    : normalizeSourceRef(input.unitSourceRef, `${field}.unitSourceRef`);
  if (valueSourceRef.value !== value) fail(`${field}.value`, "source_value_mismatch");
  if ((unit === null) !== (unitSourceRef === null)) {
    fail(`${field}.unitSourceRef`, "unit_binding_invalid");
  }
  if (unitSourceRef && unitSourceRef.value !== unit) {
    fail(`${field}.unit`, "source_value_mismatch");
  }
  return { value, unit, valueSourceRef, unitSourceRef };
}

function normalizeRoute(input, field) {
  if (input === null) return null;
  exactKeys(input, [
    "provenance",
    "sourceSceneId",
    "operationIndex",
    "points",
  ], field);
  if (input.provenance !== "approved_storyboard_layout") {
    fail(`${field}.provenance`, "unsupported_value");
  }
  const pointInputs = denseDataArray(
    input.points,
    `${field}.points`,
    2,
    12,
  );
  const points = pointInputs.map((point, pointIndex) => {
    const coordinates = denseDataArray(
      point,
      `${field}.points[${pointIndex}]`,
      2,
      2,
    );
    if (coordinates.some((coordinate) => (
      !Number.isFinite(coordinate)
      || Object.is(coordinate, -0)
      || coordinate < 0
      || coordinate > 1
    ))) fail(`${field}.points[${pointIndex}]`, "point_out_of_range");
    return coordinates;
  });
  if (new Set(points.map((point) => stableStringify(point))).size < 2) {
    fail(`${field}.points`, "geometry_degenerate");
  }
  return {
    provenance: input.provenance,
    sourceSceneId: text(input.sourceSceneId, `${field}.sourceSceneId`, {
      max: 80,
      pattern: ID_PATTERN,
    }),
    operationIndex: integer(
      input.operationIndex,
      `${field}.operationIndex`,
      0,
      39,
    ),
    points,
  };
}

function normalizeGeometry(input, field, grammarId) {
  exactKeys(input, [
    "presetId",
    "variantSeed",
    "direction",
    "route",
  ], field);
  const presetId = text(input.presetId, `${field}.presetId`, {
    max: 80,
    pattern: ID_PATTERN,
  });
  if (presetId !== SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR[grammarId]) {
    fail(`${field}.presetId`, "grammar_preset_mismatch");
  }
  if (!["forward", "reverse"].includes(input.direction)) {
    fail(`${field}.direction`, "unsupported_value");
  }
  const route = normalizeRoute(input.route, `${field}.route`);
  if (route && input.direction !== "forward") {
    fail(`${field}.direction`, "approved_route_order_must_be_preserved");
  }
  return {
    presetId,
    variantSeed: integer(
      input.variantSeed,
      `${field}.variantSeed`,
      0,
      0xffffffff,
    ),
    direction: input.direction,
    route,
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function normalizeSemanticPrimitiveParameters(input) {
  exactKeys(input, [
    "schemaVersion",
    "profileId",
    "grammarId",
    "assetId",
    "visualConceptId",
    "subject",
    "detail",
    "quantity",
    "stateToken",
    "geometry",
  ], "primitiveParameters");
  if (input.schemaVersion !== SEMANTIC_PRIMITIVE_PARAMETER_SCHEMA_VERSION) {
    fail("primitiveParameters.schemaVersion", "unsupported_schema");
  }
  if (input.profileId !== SEMANTIC_PRIMITIVE_PARAMETER_PROFILE_ID) {
    fail("primitiveParameters.profileId", "unsupported_profile");
  }
  const grammarId = text(input.grammarId, "primitiveParameters.grammarId", {
    max: 80,
    pattern: ID_PATTERN,
  });
  const assetId = text(input.assetId, "primitiveParameters.assetId", {
    max: 80,
    pattern: ID_PATTERN,
  });
  if (
    !SEMANTIC_SENTENCE_RENDERER_GRAMMAR_IDS.includes(grammarId)
    || !SEMANTIC_SENTENCE_RENDERER_ASSET_IDS.includes(assetId)
    || !SEMANTIC_SENTENCE_RENDERER_GRAMMAR_ASSET_BINDINGS[grammarId]
      ?.includes(assetId)
  ) fail("primitiveParameters.capability", "renderer_pair_unsupported");
  const visualConceptId = text(
    input.visualConceptId,
    "primitiveParameters.visualConceptId",
    { max: 80, pattern: ID_PATTERN },
  );
  const stateToken = text(input.stateToken, "primitiveParameters.stateToken", {
    max: 24,
  });
  if (!SEMANTIC_PRIMITIVE_STATE_TOKENS.includes(stateToken)) {
    fail("primitiveParameters.stateToken", "unsupported_value");
  }
  if (!semanticVisualConceptBindingMatches({
    visualConceptId,
    grammarId,
    assetId,
    stateToken,
  })) {
    fail("primitiveParameters.visualConceptId", "concept_binding_mismatch");
  }
  const subject = normalizeGroundedText(
    input.subject,
    "primitiveParameters.subject",
  );
  const detail = normalizeGroundedText(
    input.detail,
    "primitiveParameters.detail",
  );
  const quantity = normalizeQuantity(
    input.quantity,
    "primitiveParameters.quantity",
  );
  if (!semanticVisualConceptGroundingMatches({
    visualConceptId,
    subjectValue: subject.value,
    detailValue: detail.value,
    detailSourceRef: detail.sourceRef,
    quantity,
  })) {
    fail("primitiveParameters.visualConceptId", "concept_grounding_mismatch");
  }
  return deepFreeze({
    schemaVersion: SEMANTIC_PRIMITIVE_PARAMETER_SCHEMA_VERSION,
    profileId: SEMANTIC_PRIMITIVE_PARAMETER_PROFILE_ID,
    grammarId,
    assetId,
    visualConceptId,
    subject,
    detail,
    quantity,
    stateToken,
    geometry: normalizeGeometry(
      input.geometry,
      "primitiveParameters.geometry",
      grammarId,
    ),
  });
}

function semanticStateToken(proposition) {
  const transition = proposition.visualIntent.stateTransition;
  if (proposition.polarity === "negated" || transition === "reject_hypothesis") {
    return "REJECTED";
  }
  if (transition === "become_absent") return "ABSENT";
  if (transition === "remain_unresolved") return "UNRESOLVED";
  if (transition === "repeat_cycle") return "REPEATS";
  if (transition === "move_along_path") return "IN MOTION";
  if (transition === "reach_capacity") return "LIMIT";
  if (transition === "change_value") return "CHANGED";
  if (
    transition === "mark_last_known"
    && UPCOMING_SEMANTIC_VISUAL_CONCEPT_IDS.includes(
      proposition.primitivePayload?.visualConceptId,
    )
  ) return "UPCOMING";
  if (transition === "mark_last_known") return "LAST RECORD";
  if (transition === "map_input_to_output") return "RESULT";
  if (transition === "map_to_incorrect_output") return "WRONG";
  if (transition === "require_update") return "UPDATE REQUIRED";
  if (transition === "compare_states") return "COMPARED";
  if (transition === "become_visible") return "RECORDED";
  return "OBSERVED";
}

function buildSemanticPrimitiveParameters(input = {}) {
  const {
    graphHash,
    proposition,
    capability,
  } = input;
  if (!proposition?.primitivePayload) {
    fail("proposition.primitivePayload", "grounded_payload_required");
  }
  const seed = createHash("sha256")
    .update(stableStringify({
      graphHash,
      propositionId: proposition.id,
      payload: proposition.primitivePayload,
      grammarId: capability.grammarId,
      assetId: capability.assetId,
    }))
    .digest()
    .readUInt32BE(0);
  const route = proposition.primitivePayload.geometry
    ? {
      provenance: "approved_storyboard_layout",
      sourceSceneId: proposition.primitivePayload.geometry.sourceSceneId,
      operationIndex: proposition.primitivePayload.geometry.operationIndex,
      points: structuredClone(proposition.primitivePayload.geometry.points),
    }
    : null;
  return normalizeSemanticPrimitiveParameters({
    schemaVersion: SEMANTIC_PRIMITIVE_PARAMETER_SCHEMA_VERSION,
    profileId: SEMANTIC_PRIMITIVE_PARAMETER_PROFILE_ID,
    grammarId: capability.grammarId,
    assetId: capability.assetId,
    visualConceptId: proposition.primitivePayload.visualConceptId,
    subject: structuredClone(proposition.primitivePayload.headline),
    detail: structuredClone(proposition.primitivePayload.detail),
    quantity: proposition.primitivePayload.displayQuantity
      ? structuredClone(proposition.primitivePayload.displayQuantity)
      : null,
    stateToken: semanticStateToken(proposition),
    geometry: {
      presetId: SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR[capability.grammarId],
      variantSeed: seed,
      direction: route ? "forward" : (
        proposition.polarity === "negated"
        || ["become_absent", "reject_hypothesis"].includes(
          proposition.visualIntent.stateTransition,
        )
      ) ? "reverse" : "forward",
      route,
    },
  });
}

module.exports = {
  SEMANTIC_PRIMITIVE_PARAMETER_PROFILE_ID,
  SEMANTIC_PRIMITIVE_PARAMETER_SCHEMA_VERSION,
  SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR,
  SEMANTIC_PRIMITIVE_STATE_TOKENS,
  buildSemanticPrimitiveParameters,
  normalizeSemanticPrimitiveParameters,
};
