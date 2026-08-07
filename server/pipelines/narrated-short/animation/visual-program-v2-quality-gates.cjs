"use strict";

const { createHash } = require("node:crypto");
const { types: utilTypes } = require("node:util");
const { stableStringify } = require("./canonical-json.cjs");
const { normalizeVisualProgramV2 } = require("./visual-program-v2-contract.cjs");

const SEMANTIC_TRACE_PROFILE = "visual_program_v2_semantic_trace_report_v1";
const REPETITION_PROFILE = "visual_program_v2_repetition_report_v1";
const OCCUPANCY_COLUMNS = 6;
const OCCUPANCY_ROWS = 8;
const MOTION_BUCKETS = 16;
const HASH_RE = /^[a-f0-9]{64}$/;
const TEXT_ONLY_TOKEN_RE = /(?:^|_)(?:caption|copy|glyph|label|paragraph|sentence|subtitle|text|title|typography|word|words)(?:_|$)/;
const CAUSAL_TOKEN_RE = /(?:caus|trigger|lead|result|produc|driv|because|therefore|maps?_to|transmit|send)/;
const SEMANTIC_STATE_OPERATIONS = new Set([
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

function hashValue(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function withReportHash(base) {
  return deepFreeze({ ...base, reportHash: hashValue(base) });
}

function violation(code, sceneId = null, eventId = null, targetId = null) {
  return { code, sceneId, eventId, targetId };
}

function contractFailure(error) {
  return {
    code: "plan_contract_invalid",
    sceneId: null,
    eventId: null,
    targetId: null,
    contractCode: error?.code === "GENERALIZED_VISUAL_PROGRAM_V2_INVALID"
      ? error.code
      : "unknown_contract_error",
    field: typeof error?.details?.field === "string" ? error.details.field.slice(0, 200) : null,
    reason: typeof error?.details?.reason === "string" ? error.details.reason.slice(0, 100) : null,
  };
}

function safeContentHash(rawValue) {
  try {
    if (!rawValue || typeof rawValue !== "object" || utilTypes.isProxy(rawValue)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(rawValue, "contentHash");
    return descriptor && !descriptor.get && !descriptor.set
      && typeof descriptor.value === "string" && HASH_RE.test(descriptor.value)
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function isTextOnlyEntity(entity) {
  return TEXT_ONLY_TOKEN_RE.test(`${entity.kind}_${entity.visualSubjectKind}`.toLowerCase());
}

function uniqueInOrder(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function eventEntityIds(event) {
  return uniqueInOrder([
    event.subjectEntityId,
    ...event.objectEntityIds,
    ...event.focusEntityIds,
  ]);
}

function relationPresentation(relation) {
  const predicate = relation.predicate.toLowerCase();
  if (relation.polarity === "negated" || relation.certainty === "disputed") return "qualified_dashed";
  if (/(?:transmit|send|signal|broadcast|receive|communicat|emit)/.test(predicate)) return "qualified_dashed";
  if (relation.certainty === "qualified") return "qualified_tone";
  return "unqualified_solid";
}

function isCausal(event, relation) {
  return CAUSAL_TOKEN_RE.test([
    event.eventKind,
    event.predicate,
    event.semanticOperation,
    relation.predicate,
  ].join("_").toLowerCase());
}

function trackBelongsToEvent(track, event, relationById) {
  if (track.targetKind === "relation") {
    return relationById.get(track.targetId)?.propositionId === event.propositionId;
  }
  return eventEntityIds(event).includes(track.targetId);
}

function trackInsideEvent(track, event) {
  return track.startFrame >= event.startFrame && track.endFrame <= event.endFrame;
}

function evaluateVisualProgramV2SemanticTrace(rawPlan) {
  let plan;
  try {
    plan = normalizeVisualProgramV2(rawPlan);
  } catch (error) {
    const violations = [contractFailure(error)];
    return withReportHash({
      schemaVersion: 1,
      profile: SEMANTIC_TRACE_PROFILE,
      planHash: safeContentHash(rawPlan),
      passed: false,
      scenes: [],
      violations,
      summary: { sceneCount: 0, eventCount: 0, checkedTrackCount: 0, violationCount: 1 },
    });
  }

  const violations = [];
  let eventCount = 0;
  let checkedTrackCount = 0;
  const sceneTraces = plan.scenes.map((scene) => {
    const sceneViolations = [];
    const add = (entry) => {
      sceneViolations.push(entry);
      violations.push(entry);
    };
    const entityById = new Map(scene.entities.map((entity) => [entity.id, entity]));
    const nodeById = new Map(scene.layout.nodes.map((node) => [node.entityId, node]));
    const relationById = new Map(scene.relations.map((relation) => [relation.id, relation]));
    const edgeByRelationId = new Map(scene.layout.edges.map((edge) => [edge.relationId, edge]));
    const eventByPropositionId = new Map(scene.events.map((event) => [event.propositionId, event]));

    for (const relation of scene.relations) {
      const edge = edgeByRelationId.get(relation.id);
      const grounded = entityById.has(relation.fromEntityId)
        && entityById.has(relation.toEntityId)
        && nodeById.has(relation.fromEntityId)
        && nodeById.has(relation.toEntityId)
        && edge?.fromEntityId === relation.fromEntityId
        && edge?.toEntityId === relation.toEntityId;
      if (!grounded) add(violation("relation_endpoint_ungrounded", scene.id, null, relation.id));
      const event = eventByPropositionId.get(relation.propositionId);
      if (event && isCausal(event, relation)) {
        const presentation = relationPresentation(relation);
        const qualificationLost = event.certainty !== relation.certainty
          || ((event.certainty === "qualified" || event.certainty === "disputed")
            && presentation === "unqualified_solid");
        if (qualificationLost) {
          add(violation("unqualified_causal_relation", scene.id, event.id, relation.id));
        }
      }
    }

    const eventTraces = scene.events.map((event) => {
      eventCount += 1;
      const selectedEntityIds = eventEntityIds(event);
      const nonTextEntityIds = selectedEntityIds.filter((id) => {
        const entity = entityById.get(id);
        return entity && !isTextOnlyEntity(entity);
      });
      if (!nonTextEntityIds.length) {
        add(violation("event_missing_non_text_entity", scene.id, event.id));
      }
      if (event.startFrame < scene.startFrame || event.endFrame > scene.endFrame) {
        add(violation("event_cue_outside_scene", scene.id, event.id));
      }

      const relationIds = scene.relations
        .filter((relation) => relation.propositionId === event.propositionId
          && entityById.has(relation.fromEntityId)
          && entityById.has(relation.toEntityId)
          && selectedEntityIds.includes(relation.fromEntityId)
          && selectedEntityIds.includes(relation.toEntityId))
        .map((relation) => relation.id);
      const eventTracks = scene.tracks.filter((track) => trackBelongsToEvent(track, event, relationById));
      const containedTracks = eventTracks.filter((track) => trackInsideEvent(track, event));
      const stateChangeTrackIds = containedTracks
        .filter((track) => track.targetKind === "entity"
          && SEMANTIC_STATE_OPERATIONS.has(track.operation)
          && selectedEntityIds.includes(track.targetId))
        .map((track) => track.id);
      if (!relationIds.length && !stateChangeTrackIds.length) {
        add(violation("event_missing_relation_or_state_change", scene.id, event.id));
      }

      const causalRelations = scene.relations
        .filter((relation) => relation.propositionId === event.propositionId && isCausal(event, relation))
        .map((relation) => ({
          relationId: relation.id,
          certainty: relation.certainty,
          presentation: relationPresentation(relation),
        }));
      return {
        eventId: event.id,
        propositionId: event.propositionId,
        selectedEntityIds,
        nonTextEntityIds,
        relationIds,
        stateChangeTrackIds,
        trackIds: containedTracks.map((track) => track.id),
        cue: { startFrame: event.startFrame, endFrame: event.endFrame },
        causalRelations,
      };
    });

    for (const track of scene.tracks) {
      checkedTrackCount += 1;
      const semanticEvents = scene.events.filter((event) => trackBelongsToEvent(track, event, relationById));
      if (!semanticEvents.some((event) => trackInsideEvent(track, event))) {
        add(violation("track_outside_event_cue", scene.id, null, track.id));
      }
      if (track.startFrame < scene.startFrame || track.endFrame > scene.endFrame) {
        add(violation("track_outside_scene", scene.id, null, track.id));
      }
      if (track.endFrame > scene.readabilityHold.startFrame) {
        add(violation("track_overlaps_settled_hold", scene.id, null, track.id));
      }
    }

    return {
      sceneId: scene.id,
      passed: sceneViolations.length === 0,
      settledHold: { ...scene.readabilityHold },
      events: eventTraces,
      violations: sceneViolations,
    };
  });

  return withReportHash({
    schemaVersion: 1,
    profile: SEMANTIC_TRACE_PROFILE,
    planHash: plan.contentHash,
    passed: violations.length === 0,
    scenes: sceneTraces,
    violations,
    summary: {
      sceneCount: plan.scenes.length,
      eventCount,
      checkedTrackCount,
      violationCount: violations.length,
    },
  });
}

function entityIndexMap(scene) {
  return new Map(scene.entityIds.map((id, index) => [id, index]));
}

function relationIndexMap(scene) {
  return new Map(scene.relations.map((relation, index) => [relation.id, index]));
}

function semanticDescriptor(scene) {
  const entityIndex = entityIndexMap(scene);
  return {
    entities: scene.entities.map((entity) => ({
      kind: entity.kind,
      visualSubjectKind: entity.visualSubjectKind,
    })),
    focusEntity: entityIndex.get(scene.focusEntityId),
    relations: scene.relations.map((relation) => ({
      from: entityIndex.get(relation.fromEntityId),
      to: entityIndex.get(relation.toEntityId),
      predicate: relation.predicate,
      polarity: relation.polarity,
      certainty: relation.certainty,
    })),
    events: scene.events.map((event) => ({
      eventKind: event.eventKind,
      predicate: event.predicate,
      semanticOperation: event.semanticOperation,
      subject: entityIndex.get(event.subjectEntityId),
      objects: event.objectEntityIds.map((id) => entityIndex.get(id)),
      focus: event.focusEntityIds.map((id) => entityIndex.get(id)),
      certainty: event.certainty,
    })),
  };
}

function quantizeUnit(value, buckets) {
  return Math.max(0, Math.min(buckets, Math.round(value * buckets)));
}

function motionDescriptor(scene) {
  const entityIndex = entityIndexMap(scene);
  const relationIndex = relationIndexMap(scene);
  const activeStart = scene.startFrame;
  const activeSpan = Math.max(1, scene.readabilityHold.startFrame - activeStart);
  return {
    buckets: MOTION_BUCKETS,
    tracks: scene.tracks.map((track) => ({
      targetKind: track.targetKind,
      target: track.targetKind === "entity"
        ? entityIndex.get(track.targetId)
        : relationIndex.get(track.targetId),
      operation: track.operation,
      start: quantizeUnit((track.startFrame - activeStart) / activeSpan, MOTION_BUCKETS),
      end: quantizeUnit((track.endFrame - activeStart) / activeSpan, MOTION_BUCKETS),
    })),
  };
}

function occupancyDescriptor(scene) {
  const region = scene.layout.regions.visualRoi;
  const cells = Array(OCCUPANCY_COLUMNS * OCCUPANCY_ROWS).fill(0);
  let focusCell = null;
  const nodes = scene.layout.nodes.map((node) => {
    const centerX = node.bounds.x + node.bounds.width / 2;
    const centerY = node.bounds.y + node.bounds.height / 2;
    const column = Math.max(0, Math.min(
      OCCUPANCY_COLUMNS - 1,
      Math.floor(((centerX - region.x) / region.width) * OCCUPANCY_COLUMNS),
    ));
    const row = Math.max(0, Math.min(
      OCCUPANCY_ROWS - 1,
      Math.floor(((centerY - region.y) / region.height) * OCCUPANCY_ROWS),
    ));
    const cell = row * OCCUPANCY_COLUMNS + column;
    cells[cell] += 1;
    if (node.entityId === scene.focusEntityId) focusCell = cell;
    return { order: node.order, role: node.role, cell };
  });
  return {
    columns: OCCUPANCY_COLUMNS,
    rows: OCCUPANCY_ROWS,
    cells,
    focusCell,
    nodes,
  };
}

function exactCompositionDescriptor(scene) {
  const entityIndex = entityIndexMap(scene);
  const relationIndex = relationIndexMap(scene);
  return {
    layoutIntent: scene.layoutIntent,
    semantic: semanticDescriptor(scene),
    motion: scene.tracks.map((track) => ({
      targetKind: track.targetKind,
      target: track.targetKind === "entity"
        ? entityIndex.get(track.targetId)
        : relationIndex.get(track.targetId),
      operation: track.operation,
      startFrame: track.startFrame - scene.startFrame,
      endFrame: track.endFrame - scene.startFrame,
    })),
    nodes: scene.layout.nodes.map((node) => ({
      order: node.order,
      role: node.role,
      bounds: { ...node.bounds },
    })),
    edges: scene.layout.edges.map((edge) => ({
      relation: relationIndex.get(edge.relationId),
      from: entityIndex.get(edge.fromEntityId),
      to: entityIndex.get(edge.toEntityId),
      kind: edge.kind,
      points: edge.points.map((point) => ({ ...point })),
    })),
  };
}

function sceneRepetitionDescriptor(storyId, programIndex, scene, sceneIndex, plan) {
  const semanticGraph = semanticDescriptor(scene);
  const motion = motionDescriptor(scene);
  const occupancy = occupancyDescriptor(scene);
  const semanticGraphHash = hashValue(semanticGraph);
  const motionHash = hashValue(motion);
  const occupancyHash = hashValue(occupancy);
  return {
    storyId,
    programIndex,
    sceneIndex,
    sceneId: scene.id,
    programHash: plan.contentHash,
    sourceSemanticEventGraphHash: plan.bindings.semanticEventGraphHash,
    descriptors: {
      semanticGraph: { ...semanticGraph, hash: semanticGraphHash },
      motion: { ...motion, hash: motionHash },
      occupancy: { ...occupancy, hash: occupancyHash },
    },
    hashes: {
      semanticGraph: semanticGraphHash,
      motion: motionHash,
      occupancy: occupancyHash,
      exact: hashValue(exactCompositionDescriptor(scene)),
      near: hashValue({ semanticGraphHash, motionHash, occupancyHash }),
    },
  };
}

function safeWrapper(rawEntry, index) {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry) || utilTypes.isProxy(rawEntry)) {
    return { storyId: `invalid_story_${index}`, program: rawEntry };
  }
  const prototype = Object.getPrototypeOf(rawEntry);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("program wrapper must be plain data");
  }
  const descriptors = Object.getOwnPropertyDescriptors(rawEntry);
  if (Object.hasOwn(descriptors, "program")) {
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !["program", "storyId"].includes(key))) {
      throw new TypeError("program wrapper has unsupported fields");
    }
    if (descriptors.program.get || descriptors.program.set) throw new TypeError("program accessor is not allowed");
    const storyDescriptor = descriptors.storyId;
    if (!storyDescriptor || storyDescriptor.get || storyDescriptor.set
      || typeof storyDescriptor.value !== "string" || !storyDescriptor.value
      || storyDescriptor.value.length > 120 || /[\u0000-\u001f]/.test(storyDescriptor.value)) {
      throw new TypeError("storyId is invalid");
    }
    return { storyId: storyDescriptor.value, program: descriptors.program.value };
  }
  return { storyId: null, program: rawEntry };
}

function safeProgramList(rawPrograms) {
  if (!Array.isArray(rawPrograms) || utilTypes.isProxy(rawPrograms)
    || Object.getPrototypeOf(rawPrograms) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(rawPrograms);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 64) return null;
  if (Reflect.ownKeys(descriptors).some((key) => {
    if (key === "length") return false;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) return true;
    const descriptor = descriptors[key];
    return descriptor.get || descriptor.set || Number(key) >= length;
  })) return null;
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.get || descriptor.set) return null;
    output.push(descriptor.value);
  }
  return output;
}

function compareDescriptors(first, second, scope) {
  const matchingDescriptorHashes = ["semanticGraph", "motion", "occupancy"]
    .filter((name) => first.hashes[name] === second.hashes[name]);
  const classification = first.hashes.exact === second.hashes.exact
    ? "exact"
    : first.hashes.near === second.hashes.near
      ? "near"
      : "distinct";
  return {
    scope,
    classification,
    similarity: matchingDescriptorHashes.length / 3,
    matchingDescriptorHashes,
    first: {
      storyId: first.storyId,
      programIndex: first.programIndex,
      sceneIndex: first.sceneIndex,
      sceneId: first.sceneId,
    },
    second: {
      storyId: second.storyId,
      programIndex: second.programIndex,
      sceneIndex: second.sceneIndex,
      sceneId: second.sceneId,
    },
  };
}

function repetitionViolation(comparison) {
  const prefix = comparison.scope === "within_story_adjacent" ? "adjacent_scene" : "cross_story_scene";
  return {
    code: `${prefix}_${comparison.classification}_repetition`,
    first: { ...comparison.first },
    second: { ...comparison.second },
  };
}

function evaluateVisualProgramV2Repetition(rawPrograms, rawOptions = {}) {
  const optionDescriptors = rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)
    && !utilTypes.isProxy(rawOptions)
    && [Object.prototype, null].includes(Object.getPrototypeOf(rawOptions))
    ? Object.getOwnPropertyDescriptors(rawOptions)
    : null;
  const optionsValid = optionDescriptors
    && Reflect.ownKeys(optionDescriptors).every((key) => key === "failClosed")
    && (!optionDescriptors.failClosed
      || (!optionDescriptors.failClosed.get && !optionDescriptors.failClosed.set
        && typeof optionDescriptors.failClosed.value === "boolean"));
  const failClosed = optionsValid && optionDescriptors.failClosed
    ? optionDescriptors.failClosed.value
    : true;
  const violations = [];
  const warnings = [];
  if (!optionsValid) {
    violations.push({ code: "repetition_options_invalid", programIndex: null, storyId: null });
  }
  const list = safeProgramList(rawPrograms);
  if (!list) {
    violations.push({ code: "program_list_invalid", programIndex: null, storyId: null });
  }

  const programs = [];
  (list || []).forEach((rawEntry, programIndex) => {
    let wrapper;
    let plan;
    try {
      wrapper = safeWrapper(rawEntry, programIndex);
      plan = normalizeVisualProgramV2(wrapper.program);
      if (!wrapper.storyId) wrapper.storyId = plan.bindings.draftHash;
    } catch (error) {
      const entry = {
        code: "program_contract_invalid",
        programIndex,
        storyId: wrapper?.storyId || `invalid_story_${programIndex}`,
      };
      (failClosed ? violations : warnings).push(entry);
      return;
    }
    programs.push({
      storyId: wrapper.storyId,
      programIndex,
      programHash: plan.contentHash,
      sourceSemanticEventGraphHash: plan.bindings.semanticEventGraphHash,
      scenes: plan.scenes.map((scene, sceneIndex) => (
        sceneRepetitionDescriptor(wrapper.storyId, programIndex, scene, sceneIndex, plan)
      )),
    });
  });

  const byStory = new Map();
  for (const program of programs) {
    const scenes = byStory.get(program.storyId) || [];
    scenes.push(...program.scenes);
    byStory.set(program.storyId, scenes);
  }
  const withinMatches = [];
  let withinComparisonCount = 0;
  for (const scenes of byStory.values()) {
    for (let index = 1; index < scenes.length; index += 1) {
      withinComparisonCount += 1;
      const comparison = compareDescriptors(scenes[index - 1], scenes[index], "within_story_adjacent");
      if (comparison.classification !== "distinct") {
        withinMatches.push(comparison);
        violations.push(repetitionViolation(comparison));
      }
    }
  }

  const storyEntries = [...byStory.entries()];
  const crossMatches = [];
  let crossComparisonCount = 0;
  for (let leftIndex = 0; leftIndex < storyEntries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < storyEntries.length; rightIndex += 1) {
      for (const first of storyEntries[leftIndex][1]) {
        for (const second of storyEntries[rightIndex][1]) {
          crossComparisonCount += 1;
          const comparison = compareDescriptors(first, second, "cross_story");
          if (comparison.classification !== "distinct") {
            crossMatches.push(comparison);
            violations.push(repetitionViolation(comparison));
          }
        }
      }
    }
  }

  return withReportHash({
    schemaVersion: 1,
    profile: REPETITION_PROFILE,
    passed: violations.length === 0,
    failClosed,
    policy: {
      adjacency: "exact_or_three_descriptor_near_match_rejected",
      crossStory: "all_scene_pairs_exact_or_three_descriptor_near_match_rejected",
      persistentEntityIsNovelty: false,
      occupancyGrid: { columns: OCCUPANCY_COLUMNS, rows: OCCUPANCY_ROWS },
      motionBuckets: MOTION_BUCKETS,
    },
    programs,
    withinStory: { comparisonCount: withinComparisonCount, matches: withinMatches },
    crossStory: { comparisonCount: crossComparisonCount, matches: crossMatches },
    violations,
    warnings,
    summary: {
      acceptedProgramCount: programs.length,
      sceneCount: programs.reduce((total, program) => total + program.scenes.length, 0),
      violationCount: violations.length,
      warningCount: warnings.length,
      repetitionCount: withinMatches.length + crossMatches.length,
    },
  });
}

module.exports = {
  evaluateVisualProgramV2Repetition,
  evaluateVisualProgramV2SemanticTrace,
};
