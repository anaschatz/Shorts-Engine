"use strict";

const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const { normalizeAnimationTimingContext } = require("./timing-contract.cjs");
const {
  VISUAL_PROGRAM_V2_LAYOUT_PROFILE_ID,
  VISUAL_PROGRAM_V2_LAYOUT_PROFILE_VERSION,
  VISUAL_PROGRAM_V2_PROFILE_ID,
  VISUAL_PROGRAM_V2_PROFILE_VERSION,
  VISUAL_PROGRAM_V2_SCHEMA_VERSION,
  VISUAL_PROGRAM_V2_STYLE_SPEC_ID,
  VISUAL_PROGRAM_V2_STYLE_SPEC_VERSION,
  normalizeVisualProgramProposalV2,
  normalizeVisualProgramV2,
  visualProgramV2ContentHash,
} = require("./visual-program-v2-contract.cjs");

const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{2,79}$/;
const CANVAS = Object.freeze({ width: 1080, height: 1920 });
const VISUAL_ROI = Object.freeze({ x: 72, y: 276, width: 936, height: 1068 });
const CAPTION_LANE = Object.freeze({ x: 0, y: 1416, width: 1080, height: 504 });
const TRACK_EASING = "ease_out_cubic";
const MINIMUM_HOLD_FRAMES = 8;
const NONPRODUCTION_DISCLOSURE = "operator_created_nonproduction";
const LOCAL_LLM_NONPRODUCTION_DISCLOSURE =
  "local_llm_generated_nonproduction";

function fail(field, reason = "invalid_value") {
  throw new AppError(
    "GENERALIZED_VISUAL_PROGRAM_V2_INVALID",
    SAFE_MESSAGES.VALIDATION_ERROR || "The visual program did not pass validation.",
    400,
    { field, reason },
  );
}

function hashValue(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function safeText(value, field, maximum = 160, pattern = null) {
  if (typeof value !== "string" || !value || value.length > maximum
    || /[\u0000-\u001f]/.test(value)
    || /(?:https?:\/\/|data:|javascript:|<\/?(?:script|style|svg|html)\b|\b(?:function|eval|require|import)\s*\()/i.test(value)
    || (pattern && !pattern.test(value))) fail(field, "invalid_text");
  return value;
}

function safeHash(value, field) {
  return safeText(value, field, 64, HASH_RE);
}

function safeIds(value, field, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(field, "array_size_invalid");
  const result = value.map((entry, index) => safeText(entry, `${field}[${index}]`, 80, ID_RE));
  if (new Set(result).size !== result.length) fail(field, "duplicate_values");
  return result;
}

function graphBase(rawGraph) {
  if (!rawGraph || typeof rawGraph !== "object" || Array.isArray(rawGraph)) fail("semanticEventGraph", "object_required");
  return {
    storyTitle: rawGraph.storyTitle,
    draftHash: rawGraph.draftHash,
    sourceStoryboardHash: rawGraph.sourceStoryboardHash,
    timingContextHash: rawGraph.timingContextHash,
    entities: rawGraph.entities,
    propositions: rawGraph.propositions,
  };
}

function calibrationSemanticGraphContentHashV2(rawGraph) {
  return hashValue(graphBase(rawGraph));
}

function normalizeCalibrationGraph(rawGraph, timingContext) {
  const base = graphBase(rawGraph);
  safeText(base.storyTitle, "semanticEventGraph.storyTitle", 96);
  safeHash(base.draftHash, "semanticEventGraph.draftHash");
  safeHash(base.sourceStoryboardHash, "semanticEventGraph.sourceStoryboardHash");
  safeHash(base.timingContextHash, "semanticEventGraph.timingContextHash");
  if (base.timingContextHash !== timingContext.contentHash) fail("semanticEventGraph.timingContextHash", "timing_binding_mismatch");
  if (!Array.isArray(base.entities) || !base.entities.length || base.entities.length > 64) fail("semanticEventGraph.entities", "array_size_invalid");
  const entities = base.entities.map((entity, index) => {
    const field = `semanticEventGraph.entities[${index}]`;
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) fail(field, "object_required");
    if (typeof entity.persistent !== "boolean") fail(`${field}.persistent`, "boolean_required");
    return {
      id: safeText(entity.id, `${field}.id`, 80, ID_RE),
      kind: safeText(entity.kind, `${field}.kind`, 80, ID_RE),
      visualSubjectKind: safeText(entity.visualSubjectKind, `${field}.visualSubjectKind`, 80, ID_RE),
      label: safeText(entity.label, `${field}.label`, 120),
      persistent: entity.persistent,
      claimIds: safeIds(entity.claimIds, `${field}.claimIds`, 1, 8),
    };
  });
  if (new Set(entities.map((entity) => entity.id)).size !== entities.length) fail("semanticEventGraph.entities", "duplicate_ids");
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const timingBeatById = new Map(timingContext.beats.map((beat) => [beat.beatId, beat]));
  if (!Array.isArray(base.propositions) || !base.propositions.length || base.propositions.length > 96) fail("semanticEventGraph.propositions", "array_size_invalid");
  let previousStart = -1;
  const propositions = base.propositions.map((proposition, index) => {
    const field = `semanticEventGraph.propositions[${index}]`;
    if (!proposition || typeof proposition !== "object" || Array.isArray(proposition)) fail(field, "object_required");
    const id = safeText(proposition.id, `${field}.id`, 80, ID_RE);
    const beatId = safeText(proposition.beatId, `${field}.beatId`, 80, ID_RE);
    const timingBeat = timingBeatById.get(beatId);
    if (!timingBeat) fail(`${field}.beatId`, "unknown_timing_beat");
    const startFrame = proposition.wordSpan?.startFrame;
    const endFrame = proposition.wordSpan?.endFrame;
    if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)
      || startFrame < timingBeat.startFrame || endFrame > timingBeat.endFrame || endFrame <= startFrame) {
      fail(`${field}.wordSpan`, "frame_span_outside_beat");
    }
    if (startFrame < previousStart) fail(`${field}.wordSpan.startFrame`, "propositions_not_ordered");
    previousStart = startFrame;
    const subjectEntityId = safeText(proposition.subject?.entityId, `${field}.subject.entityId`, 80, ID_RE);
    const objectEntityIds = safeIds(proposition.object?.entityIds || [], `${field}.object.entityIds`, 0, 8);
    const focusEntityIds = safeIds(proposition.visualAction?.focusEntityIds, `${field}.visualAction.focusEntityIds`, 1, 8);
    for (const entityId of [subjectEntityId, ...objectEntityIds, ...focusEntityIds]) {
      if (!entityById.has(entityId)) fail(field, "unknown_entity_reference");
    }
    return {
      id,
      beatId,
      eventKind: safeText(proposition.eventKind, `${field}.eventKind`, 80, ID_RE),
      predicate: safeText(proposition.predicate, `${field}.predicate`, 80, ID_RE),
      polarity: ["affirmed", "negated"].includes(proposition.polarity) ? proposition.polarity : fail(`${field}.polarity`, "unsupported_value"),
      certainty: ["verified", "qualified", "disputed"].includes(proposition.certainty) ? proposition.certainty : fail(`${field}.certainty`, "unsupported_value"),
      subjectEntityId,
      objectEntityIds,
      semanticOperation: safeText(proposition.visualAction.operation, `${field}.visualAction.operation`, 80, ID_RE),
      focusEntityIds,
      startFrame,
      endFrame,
    };
  });
  if (new Set(propositions.map((proposition) => proposition.id)).size !== propositions.length) fail("semanticEventGraph.propositions", "duplicate_ids");
  return Object.freeze({
    ...base,
    entities: Object.freeze(entities),
    propositions: Object.freeze(propositions),
    contentHash: calibrationSemanticGraphContentHashV2(base),
  });
}

function orderedParticipants(propositions) {
  const output = [];
  const seen = new Set();
  for (const proposition of propositions) {
    for (const id of [proposition.subjectEntityId, ...proposition.objectEntityIds, ...proposition.focusEntityIds]) {
      if (!seen.has(id)) { seen.add(id); output.push(id); }
    }
  }
  return output;
}

function sameSet(left, right) {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function gridCenters(count, columns = Math.min(3, count), options = {}) {
  const rows = Math.ceil(count / columns);
  const left = VISUAL_ROI.x + 120;
  const right = VISUAL_ROI.x + VISUAL_ROI.width - 120;
  const top = VISUAL_ROI.y + 130;
  const bottom = VISUAL_ROI.y + VISUAL_ROI.height - 130;
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const rowCount = Math.min(columns, count - row * columns);
    const x = rowCount === 1 ? (left + right) / 2 : left + column * ((right - left) / (rowCount - 1));
    const y = rows === 1 ? (top + bottom) / 2 : top + row * ((bottom - top) / (rows - 1));
    return { x: options.reverse ? CANVAS.width - x : x, y };
  });
}

function layoutCenters(intent, entityIds, focusEntityId) {
  const count = entityIds.length;
  const center = { x: VISUAL_ROI.x + VISUAL_ROI.width / 2, y: VISUAL_ROI.y + VISUAL_ROI.height / 2 };
  if (intent === "timeline_track") {
    const left = VISUAL_ROI.x + 88;
    const right = VISUAL_ROI.x + VISUAL_ROI.width - 88;
    return entityIds.map((_, index) => ({
      x: count === 1 ? center.x : left + index * ((right - left) / (count - 1)),
      y: center.y,
    }));
  }
  if (intent === "layered_stack") {
    const focusIndex = entityIds.indexOf(focusEntityId);
    const supporting = entityIds.filter((id) => id !== focusEntityId);
    const output = Array(count);
    output[focusIndex] = { x: center.x, y: VISUAL_ROI.y + 230 };
    const left = VISUAL_ROI.x + 88;
    const right = VISUAL_ROI.x + VISUAL_ROI.width - 88;
    supporting.forEach((id, index) => {
      output[entityIds.indexOf(id)] = {
        x: supporting.length === 1 ? center.x : left + index * ((right - left) / (supporting.length - 1)),
        y: VISUAL_ROI.y + 690,
      };
    });
    return output;
  }
  if (intent === "cycle_orbit" || intent === "radial_focus") {
    const focusIndex = entityIds.indexOf(focusEntityId);
    const output = Array(count);
    const orbitIds = intent === "radial_focus" ? entityIds.filter((id) => id !== focusEntityId) : entityIds;
    if (intent === "radial_focus") output[focusIndex] = center;
    orbitIds.forEach((id, orbitIndex) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * orbitIndex) / orbitIds.length;
      output[entityIds.indexOf(id)] = { x: center.x + Math.cos(angle) * 315, y: center.y + Math.sin(angle) * 330 };
    });
    return output;
  }
  if (intent === "split_compare") {
    const leftCount = Math.ceil(count / 2);
    return entityIds.map((_, index) => {
      const leftSide = index < leftCount;
      const local = leftSide ? index : index - leftCount;
      const sideCount = leftSide ? leftCount : count - leftCount;
      return {
        x: leftSide ? VISUAL_ROI.x + 240 : VISUAL_ROI.x + VISUAL_ROI.width - 240,
        y: VISUAL_ROI.y + 150 + local * ((VISUAL_ROI.height - 300) / Math.max(1, sideCount - 1)),
      };
    });
  }
  return gridCenters(count, Math.min(4, count));
}

function compileLayout(scene, relations) {
  const centers = layoutCenters(scene.layoutIntent, scene.entityIds, scene.focusEntityId);
  const semanticEntityById = new Map((scene.entities || []).map((entity) => [entity.id, entity]));
  const nodes = scene.entityIds.map((entityId, order) => {
    const focus = entityId === scene.focusEntityId;
    const semanticEntity = semanticEntityById.get(entityId);
    const wheelBank = /(?:wheel_bank|digit_bank)/.test(
      `${semanticEntity?.kind || ""} ${semanticEntity?.visualSubjectKind || ""}`,
    );
    const compactTrack = scene.layoutIntent === "timeline_track" && scene.entityIds.length >= 5;
    const compactLayer = scene.layoutIntent === "layered_stack" && scene.entityIds.length >= 5;
    const desiredWidth = wheelBank
      ? (focus ? 360 : 320)
      : compactLayer
      ? (focus ? 260 : 124)
      : (compactTrack ? 124 : (scene.entityIds.length > 6 ? 176 : 204));
    const horizontalCapacity = Math.floor(2 * Math.min(
      centers[order].x - VISUAL_ROI.x,
      VISUAL_ROI.x + VISUAL_ROI.width - centers[order].x,
    )) - 16;
    const minimumWidth = wheelBank ? 176 : 112;
    const width = Math.max(
      minimumWidth,
      Math.min(desiredWidth, horizontalCapacity),
    );
    const height = wheelBank
      ? 156
      : compactLayer
      ? (focus ? 160 : 104)
      : (compactTrack ? 112 : (scene.entityIds.length > 6 ? 112 : 132));
    return {
      entityId,
      order,
      role: focus ? "focus" : "participant",
      bounds: {
        x: Math.round(centers[order].x - width / 2),
        y: Math.round(centers[order].y - height / 2),
        width,
        height,
      },
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.entityId, node]));
  const pairKey = (relation) => `${relation.fromEntityId}\u0000${relation.toEntityId}`;
  const pairCounts = new Map();
  const pairSeen = new Map();
  for (const relation of relations) {
    const key = pairKey(relation);
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }
  const edges = relations.map((relation, index) => {
    const from = nodeById.get(relation.fromEntityId).bounds;
    const to = nodeById.get(relation.toEntityId).bounds;
    const a = { x: Math.round(from.x + from.width / 2), y: Math.round(from.y + from.height / 2) };
    const b = { x: Math.round(to.x + to.width / 2), y: Math.round(to.y + to.height / 2) };
    const key = pairKey(relation);
    const parallelIndex = pairSeen.get(key) || 0;
    pairSeen.set(key, parallelIndex + 1);
    const repeatedEndpoints = (pairCounts.get(key) || 0) > 1;
    const curved = (repeatedEndpoints && parallelIndex > 0)
      || (!repeatedEndpoints && index % 2 === 1 && relations.length > 2);
    const offsetDirection = parallelIndex % 2 ? 1 : -1;
    const offsetMagnitude = repeatedEndpoints
      ? 42 * Math.ceil(parallelIndex / 2)
      : 36;
    return {
      relationId: relation.id,
      fromEntityId: relation.fromEntityId,
      toEntityId: relation.toEntityId,
      kind: curved ? "curve" : "line",
      points: curved
        ? [a, {
          x: Math.round((a.x + b.x) / 2 + offsetDirection * offsetMagnitude),
          y: Math.round((a.y + b.y) / 2 - offsetDirection * offsetMagnitude),
        }, b]
        : [a, b],
    };
  });
  return {
    profileId: VISUAL_PROGRAM_V2_LAYOUT_PROFILE_ID,
    profileVersion: VISUAL_PROGRAM_V2_LAYOUT_PROFILE_VERSION,
    canvas: { ...CANVAS },
    regions: { visualRoi: { ...VISUAL_ROI }, captionLane: { ...CAPTION_LANE } },
    nodes,
    edges,
    constraints: { maximumSimultaneousMotion: 2, minimumSettledHoldFrames: MINIMUM_HOLD_FRAMES },
  };
}

function semanticTrackOperation(event) {
  const semantic = `${event.semanticOperation} ${event.predicate}`.toLowerCase();
  if (/(?:empty_crew|no_crew)/.test(semantic)) return "empty_occupancy";
  if (/(?:propagate_carry|carries_to_next|carries_through)/.test(semantic)) return "propagate_carry";
  if (/(?:empty_last_seen|ship_absent|absent_from)/.test(semantic)) return "occlude_to_absent";
  if (/(?:replace_assumption|supersed)/.test(semantic)) return "supersede_hypothesis";
  if (/(?:move_.*_with|co_move|drifted_with)/.test(semantic)) return "co_move";
  if (/(?:unknown|unresolved|fade_beyond)/.test(semantic)) return "unresolved_boundary";
  if (/(?:latest_record|last_documented|stamp_latest|span_abandonment)/.test(semantic)) return "mark_last_known";
  if (/(?:reject|not_supernatural|supernatural_ghost)/.test(semantic)) return "reject_hypothesis";
  return null;
}

function semanticEntityTarget(event, operation, entities) {
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const selected = [...event.focusEntityIds, ...event.objectEntityIds, event.subjectEntityId]
    .filter((id, index, values) => values.indexOf(id) === index)
    .map((id) => entityById.get(id))
    .filter(Boolean);
  if (["supersede_hypothesis", "reject_hypothesis"].includes(operation)) {
    return selected.find((entity) => /(?:hypothesis|rejected)/.test(`${entity.kind} ${entity.visualSubjectKind}`))?.id
      || selected.at(-1)?.id;
  }
  if (operation === "unresolved_boundary") {
    return selected.find((entity) => /(?:unknown|outcome)/.test(`${entity.kind} ${entity.visualSubjectKind}`))?.id
      || selected.at(-1)?.id;
  }
  if (operation === "propagate_carry") {
    return selected.find((entity) => /(?:wheel_bank|digit_bank|odometer)/.test(`${entity.kind} ${entity.visualSubjectKind}`))?.id
      || selected[0]?.id;
  }
  return selected[0]?.id;
}

function appendTrack(tracks, sceneIndex, target, startFrame, endFrame) {
  if (endFrame <= startFrame) return;
  tracks.push({
    id: `track_${sceneIndex}_${String(tracks.length).padStart(2, "0")}`,
    ...target,
    startFrame,
    endFrame,
    easing: TRACK_EASING,
    order: tracks.length,
  });
}

function compileTracks(sceneIndex, events, relations, entities, holdStart) {
  const relationsByProposition = new Map();
  for (const relation of relations) {
    const entries = relationsByProposition.get(relation.propositionId) || [];
    entries.push(relation);
    relationsByProposition.set(relation.propositionId, entries);
  }
  const tracks = [];
  for (const event of events) {
    const windowStart = Math.min(Math.max(event.startFrame, 0), holdStart - 2);
    const windowEnd = Math.max(windowStart + 2, Math.min(event.endFrame, holdStart));
    const semanticOperation = semanticTrackOperation(event);
    if (semanticOperation === "co_move") {
      const targetIds = [event.subjectEntityId, event.objectEntityIds[0]]
        .filter((id, index, values) => id && values.indexOf(id) === index)
        .slice(0, 2);
      targetIds.forEach((targetId) => appendTrack(tracks, sceneIndex, {
        targetKind: "entity",
        targetId,
        operation: semanticOperation,
      }, windowStart, windowEnd));
      continue;
    }
    if (semanticOperation) {
      const targetId = semanticEntityTarget(event, semanticOperation, entities);
      if (!targetId) fail(`scenes[${sceneIndex}].events.${event.id}`, "semantic_target_missing");
      const relation = (relationsByProposition.get(event.propositionId) || [])[0];
      if (relation) {
        appendTrack(tracks, sceneIndex, {
          targetKind: "relation",
          targetId: relation.id,
          operation: "draw",
        }, windowStart, windowEnd);
      }
      appendTrack(tracks, sceneIndex, {
        targetKind: "entity",
        targetId,
        operation: semanticOperation,
      }, windowStart, windowEnd);
      continue;
    }
    const targets = relationsByProposition.get(event.propositionId) || [];
    const planned = targets.length
      ? targets.map((relation) => ({ targetKind: "relation", targetId: relation.id, operation: "draw" }))
      : [{ targetKind: "entity", targetId: event.subjectEntityId, operation: event.eventKind.includes("state") ? "state_change" : "reveal" }];
    planned.push({ targetKind: "entity", targetId: event.focusEntityIds[0], operation: "focus" });
    let cursor = windowStart;
    planned.forEach((target, index) => {
      const remaining = planned.length - index;
      const length = Math.max(1, Math.floor((windowEnd - cursor) / remaining));
      const endFrame = index === planned.length - 1 ? windowEnd : Math.min(windowEnd, cursor + length);
      appendTrack(tracks, sceneIndex, target, cursor, endFrame);
      cursor = endFrame;
    });
  }
  if (!tracks.length) fail(`scenes[${sceneIndex}].tracks`, "no_tracks_compiled");
  return tracks;
}

function compileGeneralizedVisualProgramV2(input = {}) {
  if (input.trustMode !== "calibration_trusted") fail("trustMode", "calibration_trusted_required");
  const proposalSource = input.proposalSource ?? "operator";
  if (!["operator", "local_llm"].includes(proposalSource)) {
    fail("proposalSource", "unsupported_proposal_source");
  }
  const timingContext = normalizeAnimationTimingContext(input.timingContext);
  const proposal = normalizeVisualProgramProposalV2(input.proposal);
  const graph = normalizeCalibrationGraph(input.semanticEventGraph, timingContext);
  if (proposal.bindings.semanticEventGraphHash !== graph.contentHash
    || proposal.bindings.timingContextHash !== timingContext.contentHash
    || proposal.bindings.draftHash !== graph.draftHash
    || proposal.bindings.sourceRevisionHash !== graph.sourceStoryboardHash) fail("proposal.bindings", "trusted_binding_mismatch");
  const entityById = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const propositionById = new Map(graph.propositions.map((proposition) => [proposition.id, proposition]));
  const proposedOrder = proposal.scenes.flatMap((scene) => scene.propositionIds);
  const graphOrder = graph.propositions.map((proposition) => proposition.id);
  if (stableStringify(proposedOrder) !== stableStringify(graphOrder)) fail("proposal.scenes.propositionIds", "ordered_partition_required");
  const scenes = proposal.scenes.map((scene, sceneIndex) => {
    const propositions = scene.propositionIds.map((id) => propositionById.get(id));
    if (propositions.some((entry) => !entry)) fail(`proposal.scenes[${sceneIndex}].propositionIds`, "unknown_proposition");
    const participants = orderedParticipants(propositions);
    if (!sameSet(scene.entityIds, participants)) fail(`proposal.scenes[${sceneIndex}].entityIds`, "participant_set_mismatch");
    if (!propositions.some((proposition) => proposition.focusEntityIds.includes(scene.focusEntityId))) fail(`proposal.scenes[${sceneIndex}].focusEntityId`, "focus_not_grounded_in_selected_propositions");
    const nextFirstId = proposal.scenes[sceneIndex + 1]?.propositionIds[0];
    const startFrame = sceneIndex === 0 ? 0 : propositions[0].startFrame;
    const endFrame = nextFirstId ? propositionById.get(nextFirstId).startFrame : timingContext.durationFrames;
    if (endFrame - startFrame <= MINIMUM_HOLD_FRAMES + 1) fail(`proposal.scenes[${sceneIndex}]`, "scene_too_short");
    const readabilityHold = { startFrame: endFrame - MINIMUM_HOLD_FRAMES, endFrame };
    const relations = [];
    propositions.forEach((proposition) => proposition.objectEntityIds.forEach((toEntityId) => {
      relations.push({
        id: `relation_${sceneIndex}_${String(relations.length).padStart(2, "0")}`,
        propositionId: proposition.id,
        fromEntityId: proposition.subjectEntityId,
        toEntityId,
        predicate: proposition.predicate,
        polarity: proposition.polarity,
        certainty: proposition.certainty,
        order: relations.length,
      });
    }));
    const events = propositions.map((proposition, order) => ({
      id: `event_${sceneIndex}_${String(order).padStart(2, "0")}`,
      propositionId: proposition.id,
      beatId: proposition.beatId,
      eventKind: proposition.eventKind,
      predicate: proposition.predicate,
      semanticOperation: proposition.semanticOperation,
      subjectEntityId: proposition.subjectEntityId,
      objectEntityIds: [...proposition.objectEntityIds],
      focusEntityIds: [...proposition.focusEntityIds],
      certainty: proposition.certainty,
      startFrame: proposition.startFrame,
      endFrame: proposition.endFrame,
      order,
    }));
    const compiledScene = {
      id: scene.id,
      entityIds: [...scene.entityIds],
      propositionIds: [...scene.propositionIds],
      layoutIntent: scene.layoutIntent,
      focusEntityId: scene.focusEntityId,
      startFrame,
      endFrame,
      readabilityHold,
      entities: scene.entityIds.map((id) => ({ ...entityById.get(id), claimIds: [...entityById.get(id).claimIds] })),
      relations,
      events,
      layout: null,
      tracks: null,
      compositionFingerprint: "",
    };
    compiledScene.layout = compileLayout(compiledScene, relations);
    compiledScene.tracks = compileTracks(
      sceneIndex,
      events,
      relations,
      compiledScene.entities,
      readabilityHold.startFrame,
    );
    compiledScene.compositionFingerprint = hashValue({
      layoutIntent: scene.layoutIntent,
      entityKinds: compiledScene.entities.map((entity) => entity.kind),
      relations: relations.map((relation) => [relation.predicate, relation.fromEntityId, relation.toEntityId]),
      tracks: compiledScene.tracks.map((track) => [track.targetKind, track.operation]),
    });
    return compiledScene;
  });
  const base = {
    schemaVersion: VISUAL_PROGRAM_V2_SCHEMA_VERSION,
    profile: VISUAL_PROGRAM_V2_PROFILE_ID,
    profileVersion: VISUAL_PROGRAM_V2_PROFILE_VERSION,
    bindings: {
      proposalHash: proposal.contentHash,
      semanticEventGraphHash: graph.contentHash,
      timingContextHash: timingContext.contentHash,
      draftHash: graph.draftHash,
      sourceRevisionHash: graph.sourceStoryboardHash,
    },
    presentation: { title: graph.storyTitle },
    style: { specId: VISUAL_PROGRAM_V2_STYLE_SPEC_ID, specVersion: VISUAL_PROGRAM_V2_STYLE_SPEC_VERSION },
    trust: {
      mode: "calibration_trusted",
      disclosure: proposalSource === "local_llm"
        ? LOCAL_LLM_NONPRODUCTION_DISCLOSURE
        : NONPRODUCTION_DISCLOSURE,
    },
    duration: { fps: timingContext.fps, totalFrames: timingContext.durationFrames },
    scenes,
  };
  return normalizeVisualProgramV2({ ...base, contentHash: visualProgramV2ContentHash(base) });
}

module.exports = {
  LOCAL_LLM_NONPRODUCTION_DISCLOSURE,
  NONPRODUCTION_DISCLOSURE,
  calibrationSemanticGraphContentHashV2,
  compileGeneralizedVisualProgramV2,
};
