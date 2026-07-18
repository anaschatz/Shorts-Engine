"use strict";

const { createHash } = require("node:crypto");
const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  VISUAL_SUBJECT_KINDS,
  normalizeVisualCapabilityProposition,
} = require("./visual-capability-registry.cjs");

const SEMANTIC_EVENT_GRAPH_SCHEMA_VERSION = 3;
const SEMANTIC_EVENT_GRAPH_PROFILE_ID = "dark_curiosity_semantic_event_graph_v3";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z][a-z0-9_-]{2,79}$/;
const SEMANTIC_ATTRIBUTE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const CLAIM_ID_PATTERN = /^claim_[A-Za-z0-9-]{2,72}$/;
const BEAT_ID_PATTERN = /^beat_[A-Za-z0-9-]{2,72}$/;

const STORY_FORMATS = Object.freeze([
  "documented_mystery_v1",
  "deepest_iceberg_layer_v1",
  "speculative_what_if_v1",
]);

const NARRATIVE_SHAPES = Object.freeze([
  "mechanism_reveal_v1",
  "historical_reconstruction_v1",
  "investigation_trail_v1",
  "object_journey_v1",
  "evidence_conflict_v1",
  "constrained_what_if_v1",
]);

const ENTITY_KINDS = Object.freeze([
  "person",
  "group",
  "object",
  "place",
  "time",
  "event",
  "system",
  "device",
  "software",
  "document",
  "signal",
  "quantity",
  "environment",
  "concept",
  "unknown",
  "archival_record",
  "bit_field",
  "calendar_date",
  "calendar_year",
  "coastal_region",
  "crew_group",
  "device_group",
  "device_output",
  "finite_counter",
  "hypothesis",
  "ice_environment",
  "moving_ice_environment",
  "navigation_message_family",
  "navigation_signal",
  "observer_group",
  "receiver_group",
  "rejected_interpretation",
  "software_fix",
  "software_interpreter",
  "steamship",
  "temporal_progression",
  "unknown_outcome",
  "weather_event",
]);

const SEMANTIC_PREDICATES = Object.freeze([
  "appears",
  "disappears",
  "reappears",
  "moves",
  "drifts",
  "connects_to",
  "changes_to",
  "resets_to",
  "causes",
  "indicates",
  "compares_with",
  "precedes",
  "follows",
  "records",
  "measures",
  "limits",
  "supports",
  "contradicts",
  "remains_unknown",
  "is_not",
  "allows_only_a_limited_value_set",
  "assumed",
  "became_incorrect",
  "continued_into_following_years",
  "covers_duration",
  "documents_extraordinary_drift",
  "drifted_with",
  "event_occurred_in",
  "face_another_rollover_in_2038",
  "found_ship_absent_from_last_seen_ice",
  "give_week_counter_more_room",
  "had_an_ordinary_mechanism",
  "had_no_crew_aboard",
  "handled_repeated_value_ambiguity_badly",
  "handled_rollover_incorrectly_in_some_devices",
  "latest_record_dates_to_1969",
  "looked_haunted",
  "looked_out_after",
  "number_reset",
  "occurred_decades_after_ship_was_abandoned",
  "required_software_patches",
  "reset_or_move_backward",
  "reset_to_zero",
  "rolled_over",
  "rollover_occurred_on",
  "saw",
  "sometimes_boarded",
  "spotted_abandoned_ship_near",
  "stores_week_number_in_field",
  "was_a_supernatural_ghost_ship",
]);

const EVENT_KINDS = Object.freeze([
  "archival_evidence",
  "attributed_hypothesis",
  "bounded_interpretation",
  "capacity_comparison",
  "causal_action",
  "constraint",
  "coupled_motion",
  "entity_state",
  "epistemic_state",
  "event_context",
  "future_event",
  "measured_extent",
  "negated_state_transition",
  "observation_action",
  "observed_state_change",
  "rejected_interpretation",
  "remediation_requirement",
  "repeated_action",
  "repeated_observation",
  "rhetorical_appearance",
  "state_transition",
  "structural_relation",
  "temporal_relation",
  "time_context",
]);

const POLARITIES = Object.freeze(["affirmed", "negated"]);
const EPISTEMIC_STATUSES = Object.freeze([
  "supported_fact",
  "qualified_analysis",
  "rhetorical_appearance",
  "historical_assumption",
  "unknown",
]);
const SEMANTIC_ATTRIBUTES = Object.freeze([
  "baychimoObservation",
  "baychimoVisibilityAtLastSeenIce",
  "bitWidth",
  "correctness",
  "crewAboard",
  "cyclePosition",
  "direction",
  "duration",
  "elapsedTime",
  "frequency",
  "knowledgeStatus",
  "motionCarrier",
  "precision",
  "relativeCapacity",
  "valueSpace",
  "year",
]);
const VISUAL_ACTIONS = Object.freeze([
  "add_repeated_sighting_markers",
  "advance_undated_later_years",
  "bound_documented_drift_evidence",
  "bound_week_value_space",
  "compare_legacy_and_newer_counter_capacity",
  "compare_receiver_interpretations",
  "contrast_counter_reset_with_continuing_time",
  "fade_beyond_last_documented_record",
  "fill_finite_counter_cycle",
  "mark_legacy_rollover_boundary",
  "mark_sinking_as_assumption",
  "move_ship_with_pack_ice",
  "occlude_then_clear_with_blizzard",
  "present_then_strip_haunted_appearance",
  "reject_supernatural_interpretation",
  "replace_assumption_with_documented_sighting",
  "reveal_counter_receiver_mechanism",
  "reveal_empty_crew_state",
  "reveal_empty_last_seen_position",
  "reveal_ten_bit_week_field",
  "roll_counter",
  "roll_counter_to_zero",
  "route_repeated_value_through_receiver",
  "set_date_context",
  "set_year_context",
  "show_boarding_action",
  "show_counter_reset",
  "show_incorrect_device_date",
  "show_patch_requirement",
  "span_abandonment_to_latest_record",
  "stamp_latest_archive_record",
]);

const CERTAINTIES = Object.freeze(["verified", "qualified", "disputed"]);
const SOURCE_REF_TYPES = Object.freeze([
  "brief",
  "beat",
  "claim",
  "storyboard_scene",
  "storyboard_operation",
]);

function fail(field, reason = "invalid") {
  throw new AppError(
    "ANIMATION_SEMANTIC_EVENT_INVALID",
    "The semantic event graph is invalid or is not grounded in the approved draft.",
    409,
    { field, reason },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, field, optional = []) {
  if (!isPlainObject(value)) fail(field, "object_required");
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  for (const key of actual) if (!allowed.has(key)) fail(`${field}.${key}`, "unsupported_field");
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${field}.${key}`, "field_required");
}

function text(value, field, options = {}) {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(field, "non_empty_safe_text_required");
  }
  if (value.length > (options.max || 240)) fail(field, "text_too_long");
  if (options.pattern && !options.pattern.test(value)) fail(field, "invalid_format");
  return value;
}

function nullableText(value, field, options = {}) {
  return value === null ? null : text(value, field, options);
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(field, "integer_out_of_range");
  return value;
}

function token(value, field, allowed) {
  const normalized = text(value, field, { max: 80 });
  if (!allowed.includes(normalized)) fail(field, "unsupported_value");
  return normalized;
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function uniqueStrings(value, field, options = {}) {
  if (!Array.isArray(value) || value.length < (options.minimum || 0) || value.length > (options.maximum || 24)) {
    fail(field, "array_size_invalid");
  }
  const normalized = value.map((entry, index) => text(entry, `${field}[${index}]`, {
    max: options.max || 80,
    pattern: options.pattern,
  }));
  if (new Set(normalized).size !== normalized.length) fail(field, "duplicates_not_allowed");
  return options.preserveOrder
    ? normalized
    : normalized.sort(compareText);
}

function canonicalKey(value) {
  return stableStringify(value);
}

function uniqueObjects(value, field, normalize, options = {}) {
  if (!Array.isArray(value) || value.length < (options.minimum || 0) || value.length > (options.maximum || 24)) {
    fail(field, "array_size_invalid");
  }
  const normalized = value.map((entry, index) => normalize(entry, `${field}[${index}]`));
  const keys = normalized.map(canonicalKey);
  if (new Set(keys).size !== keys.length) fail(field, "duplicates_not_allowed");
  return normalized.sort((left, right) => compareText(canonicalKey(left), canonicalKey(right)));
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
  const sourceType = token(input.sourceType, `${field}.sourceType`, SOURCE_REF_TYPES);
  const operationIndex = input.operationIndex === null
    ? null
    : integer(input.operationIndex, `${field}.operationIndex`, 0, 39);
  if ((sourceType === "storyboard_operation") !== (operationIndex !== null)) {
    fail(`${field}.operationIndex`, "operation_index_binding_invalid");
  }
  const startOffset = integer(input.startOffset, `${field}.startOffset`, 0, 2000);
  const endOffset = integer(input.endOffset, `${field}.endOffset`, startOffset + 1, 2000);
  return {
    sourceType,
    sourceId: text(input.sourceId, `${field}.sourceId`, { max: 80, pattern: ID_PATTERN }),
    operationIndex,
    field: text(input.field, `${field}.field`, { max: 80, pattern: /^[A-Za-z][A-Za-z0-9]*$/ }),
    startOffset,
    endOffset,
    value: text(input.value, `${field}.value`, { max: 400 }),
  };
}

function normalizeEntity(input, index) {
  const field = `entities[${index}]`;
  exactKeys(input, [
    "id",
    "kind",
    "visualSubjectKind",
    "label",
    "persistent",
    "claimIds",
    "sourceRefs",
  ], field);
  if (typeof input.persistent !== "boolean") fail(`${field}.persistent`, "boolean_required");
  return {
    id: text(input.id, `${field}.id`, { max: 80, pattern: ID_PATTERN }),
    kind: text(input.kind, `${field}.kind`, { max: 80, pattern: ID_PATTERN }),
    visualSubjectKind: token(
      input.visualSubjectKind,
      `${field}.visualSubjectKind`,
      VISUAL_SUBJECT_KINDS,
    ),
    label: text(input.label, `${field}.label`, { max: 120 }),
    persistent: input.persistent,
    claimIds: uniqueStrings(input.claimIds, `${field}.claimIds`, {
      minimum: 1,
      maximum: 6,
      pattern: CLAIM_ID_PATTERN,
    }),
    sourceRefs: uniqueObjects(input.sourceRefs, `${field}.sourceRefs`, normalizeSourceRef, {
      minimum: 1,
      maximum: 16,
    }),
  };
}

function normalizeWordSpan(input, field) {
  exactKeys(input, ["startWordIndex", "endWordIndex", "startFrame", "endFrame", "text"], field);
  const startWordIndex = integer(input.startWordIndex, `${field}.startWordIndex`, 0, 399);
  const startFrame = integer(input.startFrame, `${field}.startFrame`, 0, 5399);
  return {
    startWordIndex,
    endWordIndex: integer(input.endWordIndex, `${field}.endWordIndex`, startWordIndex + 1, 400),
    startFrame,
    endFrame: integer(input.endFrame, `${field}.endFrame`, startFrame + 1, 5400),
    text: text(input.text, `${field}.text`, { max: 400 }),
  };
}

function normalizeObject(input, field) {
  exactKeys(input, ["entityIds", "value", "sourceRef"], field);
  const entityIds = uniqueStrings(input.entityIds, `${field}.entityIds`, {
    minimum: 0,
    maximum: 8,
    pattern: ID_PATTERN,
    preserveOrder: true,
  });
  const value = nullableText(input.value, `${field}.value`, { max: 240 });
  const sourceRef = input.sourceRef === null ? null : normalizeSourceRef(input.sourceRef, `${field}.sourceRef`);
  const entityMode = entityIds.length > 0 && value === null && sourceRef === null;
  const valueMode = entityIds.length === 0 && value !== null && sourceRef !== null;
  const emptyMode = entityIds.length === 0 && value === null && sourceRef === null;
  if (!entityMode && !valueMode && !emptyMode) fail(field, "object_binding_invalid");
  if (valueMode && sourceRef.value !== value) fail(`${field}.value`, "object_value_must_equal_source_value");
  return { entityIds, value, sourceRef };
}

function normalizeSubject(input, field) {
  exactKeys(input, ["entityId"], field);
  return {
    entityId: text(input.entityId, `${field}.entityId`, { max: 80, pattern: ID_PATTERN }),
  };
}

function normalizeSemanticScalar(value, field) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000) return value;
  return text(value, field, { max: 120 });
}

function normalizeSemanticFact(input, field) {
  exactKeys(input, ["attribute", "value"], field);
  return {
    attribute: text(input.attribute, `${field}.attribute`, {
      max: 80,
      pattern: SEMANTIC_ATTRIBUTE_PATTERN,
    }),
    value: normalizeSemanticScalar(input.value, `${field}.value`),
  };
}

function normalizeSemanticFacts(input, field, maximum) {
  const facts = uniqueObjects(input, field, normalizeSemanticFact, {
    minimum: 0,
    maximum,
  });
  if (new Set(facts.map((fact) => fact.attribute)).size !== facts.length) {
    fail(field, "duplicate_attribute");
  }
  return facts;
}

function normalizeState(input, field) {
  exactKeys(input, ["before", "after"], field);
  return {
    before: normalizeSemanticFacts(input.before, `${field}.before`, 8),
    after: normalizeSemanticFacts(input.after, `${field}.after`, 8),
  };
}

function normalizeAttributes(input, field) {
  return normalizeSemanticFacts(input, field, 12);
}

function normalizeVisualAction(input, field) {
  exactKeys(input, ["operation", "focusEntityIds"], field);
  return {
    operation: text(input.operation, `${field}.operation`, { max: 80, pattern: ID_PATTERN }),
    focusEntityIds: uniqueStrings(input.focusEntityIds, `${field}.focusEntityIds`, {
      minimum: 1,
      maximum: 8,
      pattern: ID_PATTERN,
      preserveOrder: true,
    }),
  };
}

function normalizeVisualIntent(input, field) {
  exactKeys(input, [
    "focusEntityId",
    "predicate",
    "subjectKind",
    "stateTransition",
  ], field);
  let capability;
  try {
    capability = normalizeVisualCapabilityProposition({
      predicate: input.predicate,
      subjectKind: input.subjectKind,
      stateTransition: input.stateTransition,
    });
  } catch (error) {
    fail(field, error?.details?.reason || "unsupported_visual_intent");
  }
  return {
    focusEntityId: text(input.focusEntityId, `${field}.focusEntityId`, {
      max: 80,
      pattern: ID_PATTERN,
    }),
    ...capability,
  };
}

function normalizeQuantity(input, field) {
  exactKeys(input, ["value", "unit", "valueSourceRef", "unitSourceRef"], field);
  const value = text(input.value, `${field}.value`, { max: 80 });
  const unit = nullableText(input.unit, `${field}.unit`, { max: 80 });
  const valueSourceRef = normalizeSourceRef(input.valueSourceRef, `${field}.valueSourceRef`);
  const unitSourceRef = input.unitSourceRef === null
    ? null
    : normalizeSourceRef(input.unitSourceRef, `${field}.unitSourceRef`);
  if (valueSourceRef.value !== value) fail(`${field}.value`, "quantity_value_must_equal_source_value");
  if ((unit === null) !== (unitSourceRef === null)) fail(`${field}.unitSourceRef`, "quantity_unit_binding_invalid");
  if (unitSourceRef && unitSourceRef.value !== unit) fail(`${field}.unit`, "quantity_unit_must_equal_source_value");
  return { value, unit, valueSourceRef, unitSourceRef };
}

function normalizeProposition(input, index) {
  const field = `propositions[${index}]`;
  exactKeys(input, [
    "id",
    "beatId",
    "claimIds",
    "wordSpan",
    "eventKind",
    "predicate",
    "polarity",
    "epistemicStatus",
    "subject",
    "object",
    "state",
    "attributes",
    "quantities",
    "certainty",
    "visualIntent",
    "visualAction",
    "sourceRefs",
  ], field);
  return {
    id: text(input.id, `${field}.id`, { max: 80, pattern: ID_PATTERN }),
    beatId: text(input.beatId, `${field}.beatId`, { max: 80, pattern: BEAT_ID_PATTERN }),
    claimIds: uniqueStrings(input.claimIds, `${field}.claimIds`, {
      minimum: 1,
      maximum: 6,
      pattern: CLAIM_ID_PATTERN,
    }),
    wordSpan: normalizeWordSpan(input.wordSpan, `${field}.wordSpan`),
    eventKind: token(input.eventKind, `${field}.eventKind`, EVENT_KINDS),
    predicate: text(input.predicate, `${field}.predicate`, { max: 80, pattern: ID_PATTERN }),
    polarity: token(input.polarity, `${field}.polarity`, POLARITIES),
    epistemicStatus: token(input.epistemicStatus, `${field}.epistemicStatus`, EPISTEMIC_STATUSES),
    subject: normalizeSubject(input.subject, `${field}.subject`),
    object: normalizeObject(input.object, `${field}.object`),
    state: normalizeState(input.state, `${field}.state`),
    attributes: normalizeAttributes(input.attributes, `${field}.attributes`),
    quantities: uniqueObjects(input.quantities, `${field}.quantities`, normalizeQuantity, {
      minimum: 0,
      maximum: 8,
    }),
    certainty: token(input.certainty, `${field}.certainty`, CERTAINTIES),
    visualIntent: normalizeVisualIntent(input.visualIntent, `${field}.visualIntent`),
    visualAction: normalizeVisualAction(input.visualAction, `${field}.visualAction`),
    sourceRefs: uniqueObjects(input.sourceRefs, `${field}.sourceRefs`, normalizeSourceRef, {
      minimum: 1,
      maximum: 20,
    }),
  };
}

function normalizeContinuity(input, index) {
  const field = `continuity[${index}]`;
  exactKeys(input, ["entityId", "beatIds", "rule"], field);
  return {
    entityId: text(input.entityId, `${field}.entityId`, { max: 80, pattern: ID_PATTERN }),
    beatIds: uniqueStrings(input.beatIds, `${field}.beatIds`, {
      minimum: 1,
      maximum: 8,
      pattern: BEAT_ID_PATTERN,
      preserveOrder: true,
    }),
    rule: text(input.rule, `${field}.rule`, { max: 320 }),
  };
}

function normalizeEpistemicConstraint(input, index) {
  const field = `epistemicConstraints[${index}]`;
  exactKeys(input, ["id", "rule", "claimIds"], field);
  return {
    id: text(input.id, `${field}.id`, { max: 80, pattern: ID_PATTERN }),
    rule: text(input.rule, `${field}.rule`, { max: 320 }),
    claimIds: uniqueStrings(input.claimIds, `${field}.claimIds`, {
      minimum: 1,
      maximum: 6,
      pattern: CLAIM_ID_PATTERN,
    }),
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function semanticEventGraphContentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function normalizeSemanticEventGraph(input) {
  exactKeys(input, [
    "schemaVersion",
    "profileId",
    "storyFormat",
    "narrativeShape",
    "draftHash",
    "sourceStoryboardHash",
    "timingContextHash",
    "entities",
    "propositions",
    "continuity",
    "epistemicConstraints",
  ], "semanticEventGraph", ["contentHash"]);
  if (input.schemaVersion !== SEMANTIC_EVENT_GRAPH_SCHEMA_VERSION) fail("schemaVersion", "unsupported_schema");
  if (input.profileId !== SEMANTIC_EVENT_GRAPH_PROFILE_ID) fail("profileId", "unsupported_profile");
  const entities = (Array.isArray(input.entities) ? input.entities : fail("entities", "array_required"))
    .map(normalizeEntity)
    .sort((left, right) => compareText(left.id, right.id));
  if (!entities.length || entities.length > 64) fail("entities", "array_size_invalid");
  if (new Set(entities.map((entity) => entity.id)).size !== entities.length) fail("entities", "duplicate_ids");

  const propositions = (Array.isArray(input.propositions) ? input.propositions : fail("propositions", "array_required"))
    .map(normalizeProposition)
    .sort((left, right) => (
      left.wordSpan.startWordIndex - right.wordSpan.startWordIndex
      || left.wordSpan.endWordIndex - right.wordSpan.endWordIndex
      || compareText(left.id, right.id)
    ));
  if (!propositions.length || propositions.length > 96) fail("propositions", "array_size_invalid");
  if (new Set(propositions.map((proposition) => proposition.id)).size !== propositions.length) {
    fail("propositions", "duplicate_ids");
  }
  const continuity = (Array.isArray(input.continuity) ? input.continuity : fail("continuity", "array_required"))
    .map(normalizeContinuity)
    .sort((left, right) => compareText(left.entityId, right.entityId));
  if (continuity.length > 24) fail("continuity", "array_size_invalid");
  const epistemicConstraints = (Array.isArray(input.epistemicConstraints)
    ? input.epistemicConstraints
    : fail("epistemicConstraints", "array_required"))
    .map(normalizeEpistemicConstraint)
    .sort((left, right) => compareText(left.id, right.id));
  if (epistemicConstraints.length > 24) fail("epistemicConstraints", "array_size_invalid");
  if (new Set(epistemicConstraints.map((constraint) => constraint.id)).size !== epistemicConstraints.length) {
    fail("epistemicConstraints", "duplicate_ids");
  }

  const normalized = {
    schemaVersion: SEMANTIC_EVENT_GRAPH_SCHEMA_VERSION,
    profileId: SEMANTIC_EVENT_GRAPH_PROFILE_ID,
    storyFormat: token(input.storyFormat, "storyFormat", STORY_FORMATS),
    narrativeShape: token(input.narrativeShape, "narrativeShape", NARRATIVE_SHAPES),
    draftHash: text(input.draftHash, "draftHash", { max: 64, pattern: HASH_PATTERN }),
    sourceStoryboardHash: text(input.sourceStoryboardHash, "sourceStoryboardHash", { max: 64, pattern: HASH_PATTERN }),
    timingContextHash: text(input.timingContextHash, "timingContextHash", { max: 64, pattern: HASH_PATTERN }),
    entities,
    propositions,
    continuity,
    epistemicConstraints,
  };
  const contentHash = semanticEventGraphContentHash(normalized);
  if (input.contentHash !== undefined) {
    text(input.contentHash, "contentHash", { max: 64, pattern: HASH_PATTERN });
    if (input.contentHash !== contentHash) fail("contentHash", "content_hash_mismatch");
  }
  return deepFreeze({ ...normalized, contentHash });
}

module.exports = {
  CERTAINTIES,
  ENTITY_KINDS,
  EPISTEMIC_STATUSES,
  EVENT_KINDS,
  NARRATIVE_SHAPES,
  POLARITIES,
  SEMANTIC_EVENT_GRAPH_PROFILE_ID,
  SEMANTIC_EVENT_GRAPH_SCHEMA_VERSION,
  SEMANTIC_PREDICATES,
  SEMANTIC_ATTRIBUTES,
  SOURCE_REF_TYPES,
  STORY_FORMATS,
  VISUAL_ACTIONS,
  deepFreeze,
  failSemanticEventGraph: fail,
  normalizeSemanticEventGraph,
  semanticEventGraphContentHash,
};
