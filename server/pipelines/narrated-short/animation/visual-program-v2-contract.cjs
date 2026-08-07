"use strict";

const { createHash } = require("node:crypto");
const { types: utilTypes } = require("node:util");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");

const VISUAL_PROGRAM_V2_SCHEMA_VERSION = 2;
const VISUAL_PROGRAM_V2_PROPOSAL_PROFILE_ID = "generalized_visual_program_proposal_v2";
const VISUAL_PROGRAM_V2_PROFILE_ID = "generalized_visual_program_v2";
const VISUAL_PROGRAM_V2_PROFILE_VERSION = "2.0.0";
const VISUAL_PROGRAM_V2_STYLE_SPEC_ID = "educational_line_art_reference_v1";
const VISUAL_PROGRAM_V2_STYLE_SPEC_VERSION = "1.0.0";
const VISUAL_PROGRAM_V2_LAYOUT_PROFILE_ID = "deterministic_semantic_graph_layout_v2";
const VISUAL_PROGRAM_V2_LAYOUT_PROFILE_VERSION = "2.0.0";
const VISUAL_PROGRAM_V2_LAYOUT_INTENTS = Object.freeze([
  "directed_flow",
  "cycle_orbit",
  "split_compare",
  "radial_focus",
  "timeline_track",
  "layered_stack",
]);
const VISUAL_PROGRAM_V2_TRACK_OPERATIONS = Object.freeze([
  "reveal",
  "draw",
  "focus",
  "state_change",
  "occlude_to_absent",
  "supersede_hypothesis",
  "co_move",
  "mark_last_known",
  "reject_hypothesis",
  "unresolved_boundary",
  "empty_occupancy",
  "propagate_carry",
]);
const VISUAL_PROGRAM_V2_TRUST_DISCLOSURES = Object.freeze([
  "operator_created_nonproduction",
  "local_llm_generated_nonproduction",
]);
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{2,79}$/;
const FORBIDDEN_PROPOSAL_KEYS = new Set([
  "anchor", "code", "css", "cx", "cy", "endframe", "frame", "height", "html",
  "javascript", "label", "markup", "path", "purpose", "script", "startframe", "style",
  "svg", "text", "transform", "triggerframe", "url", "viewbox", "width", "x", "y",
]);
const UNSAFE_STRING_RE = /(?:https?:\/\/|data:|javascript:|<\/?(?:script|style|svg|html)\b|\b(?:function|eval|require|import)\s*\()/i;

function fail(field, reason = "invalid_value") {
  throw new AppError(
    "GENERALIZED_VISUAL_PROGRAM_V2_INVALID",
    SAFE_MESSAGES.VALIDATION_ERROR || "The visual program did not pass validation.",
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

function safeClone(input, proposalSurface = false) {
  const seen = new WeakSet();
  function visit(value, field) {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (!value || value.length > 320 || /[\u0000-\u001f]/.test(value) || UNSAFE_STRING_RE.test(value)) {
        fail(field, "unsafe_string");
      }
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail(field, "non_finite_number");
      return value;
    }
    if (!value || typeof value !== "object") fail(field, "data_only_required");
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
      if (proposalSurface && FORBIDDEN_PROPOSAL_KEYS.has(key.toLowerCase())) {
        fail(`${field}.${key}`, "engine_owned_field");
      }
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
  return visit(input, proposalSurface ? "proposal" : "visualProgram");
}

function exact(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field, "object_required");
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field}.${key}`, "unsupported_field");
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${field}.${key}`, "required_field");
}

function text(value, field, maximum = 160, pattern = null) {
  if (typeof value !== "string" || !value || value.length > maximum
    || /[\u0000-\u001f]/.test(value) || UNSAFE_STRING_RE.test(value)
    || (pattern && !pattern.test(value))) fail(field, "invalid_text");
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(field, "integer_out_of_range");
  }
  return value;
}

function ids(value, field, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(field, "array_size_invalid");
  }
  const result = value.map((entry, index) => text(entry, `${field}[${index}]`, 80, ID_RE));
  if (new Set(result).size !== result.length) fail(field, "duplicate_values");
  return result;
}

function hash(value, field) {
  return text(value, field, 64, HASH_RE);
}

function boolean(value, field) {
  if (typeof value !== "boolean") fail(field, "boolean_required");
  return value;
}

function rect(value, field, outer = null) {
  exact(value, ["x", "y", "width", "height"], field);
  const normalized = {
    x: integer(value.x, `${field}.x`, 0, 2160),
    y: integer(value.y, `${field}.y`, 0, 3840),
    width: integer(value.width, `${field}.width`, 1, 2160),
    height: integer(value.height, `${field}.height`, 1, 3840),
  };
  if (outer && (normalized.x < outer.x || normalized.y < outer.y
    || normalized.x + normalized.width > outer.x + outer.width
    || normalized.y + normalized.height > outer.y + outer.height)) {
    fail(field, "outside_region");
  }
  return normalized;
}

function contentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function normalizeVisualProgramProposalV2(input) {
  const value = safeClone(input, true);
  exact(value, ["schemaVersion", "profile", "bindings", "styleSpecId", "scenes"], "proposal");
  if (value.schemaVersion !== VISUAL_PROGRAM_V2_SCHEMA_VERSION) fail("proposal.schemaVersion", "unsupported_schema");
  if (value.profile !== VISUAL_PROGRAM_V2_PROPOSAL_PROFILE_ID) fail("proposal.profile", "unsupported_profile");
  if (value.styleSpecId !== VISUAL_PROGRAM_V2_STYLE_SPEC_ID) fail("proposal.styleSpecId", "unsupported_style_spec");
  exact(value.bindings, ["semanticEventGraphHash", "timingContextHash", "draftHash", "sourceRevisionHash"], "proposal.bindings");
  const bindings = Object.fromEntries(Object.entries(value.bindings).map(([key, entry]) => [
    key, hash(entry, `proposal.bindings.${key}`),
  ]));
  if (!Array.isArray(value.scenes) || value.scenes.length < 1 || value.scenes.length > 12) {
    fail("proposal.scenes", "scene_budget_invalid");
  }
  const sceneIds = new Set();
  const usedPropositions = new Set();
  const scenes = value.scenes.map((scene, index) => {
    const field = `proposal.scenes[${index}]`;
    exact(scene, ["id", "entityIds", "propositionIds", "layoutIntent", "focusEntityId"], field);
    const id = text(scene.id, `${field}.id`, 80, ID_RE);
    if (sceneIds.has(id)) fail(`${field}.id`, "duplicate_scene_id");
    sceneIds.add(id);
    const entityIds = ids(scene.entityIds, `${field}.entityIds`, 1, 10);
    const propositionIds = ids(scene.propositionIds, `${field}.propositionIds`, 1, 16);
    for (const propositionId of propositionIds) {
      if (usedPropositions.has(propositionId)) fail(`${field}.propositionIds`, "duplicate_program_proposition");
      usedPropositions.add(propositionId);
    }
    const layoutIntent = text(scene.layoutIntent, `${field}.layoutIntent`, 80, ID_RE);
    if (!VISUAL_PROGRAM_V2_LAYOUT_INTENTS.includes(layoutIntent)) fail(`${field}.layoutIntent`, "unsupported_layout_intent");
    const focusEntityId = text(scene.focusEntityId, `${field}.focusEntityId`, 80, ID_RE);
    if (!entityIds.includes(focusEntityId)) fail(`${field}.focusEntityId`, "focus_entity_not_selected");
    return { id, entityIds, propositionIds, layoutIntent, focusEntityId };
  });
  const normalized = {
    schemaVersion: VISUAL_PROGRAM_V2_SCHEMA_VERSION,
    profile: VISUAL_PROGRAM_V2_PROPOSAL_PROFILE_ID,
    bindings,
    styleSpecId: VISUAL_PROGRAM_V2_STYLE_SPEC_ID,
    scenes,
  };
  return deepFreeze({ ...normalized, contentHash: contentHash(normalized) });
}

function normalizeVisualProgramV2(input) {
  const value = safeClone(input);
  exact(value, ["schemaVersion", "profile", "profileVersion", "bindings", "presentation", "style", "trust", "duration", "scenes", "contentHash"], "visualProgram");
  if (value.schemaVersion !== 2 || value.profile !== VISUAL_PROGRAM_V2_PROFILE_ID
    || value.profileVersion !== VISUAL_PROGRAM_V2_PROFILE_VERSION) fail("visualProgram.profile", "unsupported_profile");
  exact(value.bindings, ["proposalHash", "semanticEventGraphHash", "timingContextHash", "draftHash", "sourceRevisionHash"], "visualProgram.bindings");
  Object.entries(value.bindings).forEach(([key, entry]) => hash(entry, `visualProgram.bindings.${key}`));
  exact(value.presentation, ["title"], "visualProgram.presentation");
  text(value.presentation.title, "visualProgram.presentation.title", 96);
  exact(value.style, ["specId", "specVersion"], "visualProgram.style");
  if (value.style.specId !== VISUAL_PROGRAM_V2_STYLE_SPEC_ID || value.style.specVersion !== VISUAL_PROGRAM_V2_STYLE_SPEC_VERSION) fail("visualProgram.style", "style_binding_mismatch");
  exact(value.trust, ["mode", "disclosure"], "visualProgram.trust");
  if (value.trust.mode !== "calibration_trusted"
    || !VISUAL_PROGRAM_V2_TRUST_DISCLOSURES.includes(value.trust.disclosure)) {
    fail("visualProgram.trust", "unsupported_trust_mode");
  }
  exact(value.duration, ["fps", "totalFrames"], "visualProgram.duration");
  integer(value.duration.fps, "visualProgram.duration.fps", 24, 60);
  integer(value.duration.totalFrames, "visualProgram.duration.totalFrames", 2, 10800);
  if (!Array.isArray(value.scenes) || !value.scenes.length || value.scenes.length > 12) fail("visualProgram.scenes", "scene_budget_invalid");
  let expectedStart = 0;
  for (const [index, scene] of value.scenes.entries()) {
    const field = `visualProgram.scenes[${index}]`;
    exact(scene, ["id", "entityIds", "propositionIds", "layoutIntent", "focusEntityId", "startFrame", "endFrame", "readabilityHold", "entities", "relations", "events", "layout", "tracks", "compositionFingerprint"], field);
    text(scene.id, `${field}.id`, 80, ID_RE);
    ids(scene.entityIds, `${field}.entityIds`, 1, 10);
    ids(scene.propositionIds, `${field}.propositionIds`, 1, 16);
    if (!VISUAL_PROGRAM_V2_LAYOUT_INTENTS.includes(scene.layoutIntent)) fail(`${field}.layoutIntent`, "unsupported_layout_intent");
    if (!scene.entityIds.includes(scene.focusEntityId)) fail(`${field}.focusEntityId`, "focus_entity_not_selected");
    integer(scene.startFrame, `${field}.startFrame`, 0, value.duration.totalFrames - 1);
    integer(scene.endFrame, `${field}.endFrame`, scene.startFrame + 1, value.duration.totalFrames);
    if (scene.startFrame !== expectedStart) fail(`${field}.startFrame`, "scenes_not_contiguous");
    expectedStart = scene.endFrame;
    exact(scene.readabilityHold, ["startFrame", "endFrame"], `${field}.readabilityHold`);
    integer(scene.readabilityHold.startFrame, `${field}.readabilityHold.startFrame`, scene.startFrame, scene.endFrame - 1);
    integer(scene.readabilityHold.endFrame, `${field}.readabilityHold.endFrame`, scene.readabilityHold.startFrame + 1, scene.endFrame);
    if (scene.readabilityHold.endFrame - scene.readabilityHold.startFrame < 8) fail(`${field}.readabilityHold`, "hold_too_short");
    if (!Array.isArray(scene.entities) || scene.entities.length !== scene.entityIds.length) fail(`${field}.entities`, "entity_count_mismatch");
    const compiledEntityIds = new Set();
    scene.entities.forEach((entity, entityIndex) => {
      const entityField = `${field}.entities[${entityIndex}]`;
      exact(entity, ["id", "kind", "visualSubjectKind", "label", "persistent", "claimIds"], entityField);
      const entityId = text(entity.id, `${entityField}.id`, 80, ID_RE);
      if (!scene.entityIds.includes(entityId) || compiledEntityIds.has(entityId)) fail(`${entityField}.id`, "entity_binding_invalid");
      compiledEntityIds.add(entityId);
      text(entity.kind, `${entityField}.kind`, 80, ID_RE);
      text(entity.visualSubjectKind, `${entityField}.visualSubjectKind`, 80, ID_RE);
      text(entity.label, `${entityField}.label`, 120);
      boolean(entity.persistent, `${entityField}.persistent`);
      ids(entity.claimIds, `${entityField}.claimIds`, 1, 8);
    });
    if (compiledEntityIds.size !== scene.entityIds.length) fail(`${field}.entities`, "entity_coverage_mismatch");
    if (!Array.isArray(scene.relations) || scene.relations.length > 32) fail(`${field}.relations`, "relation_budget_invalid");
    const relationIds = new Set();
    scene.relations.forEach((relation, relationIndex) => {
      const relationField = `${field}.relations[${relationIndex}]`;
      exact(relation, ["id", "propositionId", "fromEntityId", "toEntityId", "predicate", "polarity", "certainty", "order"], relationField);
      const relationId = text(relation.id, `${relationField}.id`, 80, ID_RE);
      if (relationIds.has(relationId) || relation.order !== relationIndex) fail(relationField, "relation_order_invalid");
      relationIds.add(relationId);
      if (!scene.propositionIds.includes(relation.propositionId)) fail(`${relationField}.propositionId`, "unknown_proposition");
      if (!scene.entityIds.includes(relation.fromEntityId) || !scene.entityIds.includes(relation.toEntityId)
        || relation.fromEntityId === relation.toEntityId) fail(relationField, "relation_endpoint_invalid");
      text(relation.predicate, `${relationField}.predicate`, 80, ID_RE);
      if (!["affirmed", "negated"].includes(relation.polarity)) fail(`${relationField}.polarity`, "unsupported_value");
      if (!["verified", "qualified", "disputed"].includes(relation.certainty)) fail(`${relationField}.certainty`, "unsupported_value");
    });
    if (!Array.isArray(scene.events) || !scene.events.length || scene.events.length > 24) fail(`${field}.events`, "event_budget_invalid");
    scene.events.forEach((event, eventIndex) => {
      const eventField = `${field}.events[${eventIndex}]`;
      exact(event, ["id", "propositionId", "beatId", "eventKind", "predicate", "semanticOperation", "subjectEntityId", "objectEntityIds", "focusEntityIds", "certainty", "startFrame", "endFrame", "order"], eventField);
      text(event.id, `${eventField}.id`, 80, ID_RE);
      if (event.order !== eventIndex || event.propositionId !== scene.propositionIds[eventIndex]) fail(eventField, "event_order_invalid");
      text(event.beatId, `${eventField}.beatId`, 80, ID_RE);
      text(event.eventKind, `${eventField}.eventKind`, 80, ID_RE);
      text(event.predicate, `${eventField}.predicate`, 80, ID_RE);
      text(event.semanticOperation, `${eventField}.semanticOperation`, 80, ID_RE);
      if (!scene.entityIds.includes(event.subjectEntityId)) fail(`${eventField}.subjectEntityId`, "unknown_entity");
      const objectEntityIds = ids(event.objectEntityIds, `${eventField}.objectEntityIds`, 0, 8);
      const focusEntityIds = ids(event.focusEntityIds, `${eventField}.focusEntityIds`, 1, 8);
      if ([...objectEntityIds, ...focusEntityIds].some((id) => !scene.entityIds.includes(id))) fail(eventField, "unknown_entity");
      if (!["verified", "qualified", "disputed"].includes(event.certainty)) fail(`${eventField}.certainty`, "unsupported_value");
      integer(event.startFrame, `${eventField}.startFrame`, scene.startFrame, scene.endFrame - 1);
      integer(event.endFrame, `${eventField}.endFrame`, event.startFrame + 1, scene.endFrame);
    });
    if (!Array.isArray(scene.tracks) || !scene.tracks.length || scene.tracks.length > 64) fail(`${field}.tracks`, "track_budget_invalid");
    exact(scene.layout, ["profileId", "profileVersion", "canvas", "regions", "nodes", "edges", "constraints"], `${field}.layout`);
    if (scene.layout.profileId !== VISUAL_PROGRAM_V2_LAYOUT_PROFILE_ID || scene.layout.profileVersion !== VISUAL_PROGRAM_V2_LAYOUT_PROFILE_VERSION) fail(`${field}.layout`, "layout_profile_mismatch");
    exact(scene.layout.canvas, ["width", "height"], `${field}.layout.canvas`);
    if (scene.layout.canvas.width !== 1080 || scene.layout.canvas.height !== 1920) fail(`${field}.layout.canvas`, "canvas_mismatch");
    exact(scene.layout.regions, ["visualRoi", "captionLane"], `${field}.layout.regions`);
    const visualRoi = rect(scene.layout.regions.visualRoi, `${field}.layout.regions.visualRoi`);
    const captionLane = rect(scene.layout.regions.captionLane, `${field}.layout.regions.captionLane`);
    if (JSON.stringify(visualRoi) !== JSON.stringify({ x: 72, y: 276, width: 936, height: 1068 })
      || JSON.stringify(captionLane) !== JSON.stringify({ x: 0, y: 1416, width: 1080, height: 504 })) fail(`${field}.layout.regions`, "region_mismatch");
    if (!Array.isArray(scene.layout.nodes) || scene.layout.nodes.length !== scene.entityIds.length) fail(`${field}.layout.nodes`, "node_count_mismatch");
    scene.layout.nodes.forEach((node, nodeIndex) => {
      const nodeField = `${field}.layout.nodes[${nodeIndex}]`;
      exact(node, ["entityId", "order", "role", "bounds"], nodeField);
      if (node.entityId !== scene.entityIds[nodeIndex] || node.order !== nodeIndex) fail(nodeField, "node_order_invalid");
      if (!["focus", "participant"].includes(node.role)) fail(`${nodeField}.role`, "unsupported_value");
      rect(node.bounds, `${nodeField}.bounds`, visualRoi);
    });
    if (!Array.isArray(scene.layout.edges) || scene.layout.edges.length !== scene.relations.length) fail(`${field}.layout.edges`, "edge_count_mismatch");
    scene.layout.edges.forEach((edge, edgeIndex) => {
      const edgeField = `${field}.layout.edges[${edgeIndex}]`;
      exact(edge, ["relationId", "fromEntityId", "toEntityId", "kind", "points"], edgeField);
      if (edge.relationId !== scene.relations[edgeIndex].id || !["line", "curve"].includes(edge.kind)) fail(edgeField, "edge_binding_invalid");
      if (!Array.isArray(edge.points) || edge.points.length !== (edge.kind === "curve" ? 3 : 2)) fail(`${edgeField}.points`, "point_count_invalid");
      edge.points.forEach((point, pointIndex) => {
        exact(point, ["x", "y"], `${edgeField}.points[${pointIndex}]`);
        integer(point.x, `${edgeField}.points[${pointIndex}].x`, 0, 1080);
        integer(point.y, `${edgeField}.points[${pointIndex}].y`, 0, 1920);
      });
    });
    exact(scene.layout.constraints, ["maximumSimultaneousMotion", "minimumSettledHoldFrames"], `${field}.layout.constraints`);
    if (scene.layout.constraints.maximumSimultaneousMotion !== 2 || scene.layout.constraints.minimumSettledHoldFrames !== 8) fail(`${field}.layout.constraints`, "constraint_mismatch");
    scene.tracks.forEach((track, trackIndex) => {
      const trackField = `${field}.tracks[${trackIndex}]`;
      exact(track, ["id", "targetKind", "targetId", "operation", "startFrame", "endFrame", "easing", "order"], trackField);
      text(track.id, `${trackField}.id`, 80, ID_RE);
      if (track.order !== trackIndex || !["entity", "relation"].includes(track.targetKind)
        || !VISUAL_PROGRAM_V2_TRACK_OPERATIONS.includes(track.operation)
        || track.easing !== "ease_out_cubic") fail(trackField, "track_binding_invalid");
      if ((track.targetKind === "entity" && !scene.entityIds.includes(track.targetId))
        || (track.targetKind === "relation" && !relationIds.has(track.targetId))) fail(`${trackField}.targetId`, "unknown_target");
      integer(track.startFrame, `${trackField}.startFrame`, scene.startFrame, scene.readabilityHold.startFrame - 1);
      integer(track.endFrame, `${trackField}.endFrame`, track.startFrame + 1, scene.readabilityHold.startFrame);
    });
    hash(scene.compositionFingerprint, `${field}.compositionFingerprint`);
  }
  if (expectedStart !== value.duration.totalFrames) fail("visualProgram.scenes", "timeline_not_covered");
  const expectedHash = contentHash(value);
  if (value.contentHash !== expectedHash) fail("visualProgram.contentHash", "content_hash_mismatch");
  return deepFreeze(value);
}

module.exports = {
  VISUAL_PROGRAM_V2_LAYOUT_INTENTS,
  VISUAL_PROGRAM_V2_LAYOUT_PROFILE_ID,
  VISUAL_PROGRAM_V2_LAYOUT_PROFILE_VERSION,
  VISUAL_PROGRAM_V2_PROFILE_ID,
  VISUAL_PROGRAM_V2_PROFILE_VERSION,
  VISUAL_PROGRAM_V2_PROPOSAL_PROFILE_ID,
  VISUAL_PROGRAM_V2_SCHEMA_VERSION,
  VISUAL_PROGRAM_V2_STYLE_SPEC_ID,
  VISUAL_PROGRAM_V2_STYLE_SPEC_VERSION,
  VISUAL_PROGRAM_V2_TRACK_OPERATIONS,
  VISUAL_PROGRAM_V2_TRUST_DISCLOSURES,
  deepFreezeVisualProgramV2: deepFreeze,
  normalizeVisualProgramProposalV2,
  normalizeVisualProgramV2,
  visualProgramV2ContentHash: contentHash,
};
