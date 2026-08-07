"use strict";

const { createHash } = require("node:crypto");
const { types: utilTypes } = require("node:util");

const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const { normalizeAnimationTimingContext } = require("./timing-contract.cjs");
const {
  VISUAL_PROGRAM_V2_LAYOUT_INTENTS,
  VISUAL_PROGRAM_V2_STYLE_SPEC_ID,
  normalizeVisualProgramProposalV2,
} = require("./visual-program-v2-contract.cjs");
const {
  calibrationSemanticGraphContentHashV2,
} = require("./visual-program-v2-compiler.cjs");

const VISUAL_PROGRAM_V2_PLANNER_CHOICE_SCHEMA_VERSION = 1;
const VISUAL_PROGRAM_V2_PLANNER_CHOICE_PROFILE_ID =
  "generalized_visual_program_v2_composition_choice_v1";
const VISUAL_PROGRAM_V2_PROVIDER_SELECTION_SCHEMA_VERSION = 1;
const VISUAL_PROGRAM_V2_PROVIDER_SELECTION_PROFILE_ID =
  "generalized_visual_program_v2_provider_selection_v1";
const LOCAL_LLM_VISUAL_PROGRAM_V2_PROMPT_PROFILE_ID =
  "generalized_visual_program_v2_local_composer_prompt_v1";
const VISUAL_PROGRAM_V2_PLANNER_MAX_ATTEMPTS = 3;
const VISUAL_PROGRAM_V2_PLANNER_MAX_SCENES = 12;
const VISUAL_PROGRAM_V2_PLANNER_MAX_PARTICIPANTS = 10;
const VISUAL_PROGRAM_V2_PLANNER_MAX_PROPOSITIONS_PER_SCENE = 4;
const VISUAL_PROGRAM_V2_PLANNER_MAX_PROPOSITIONS =
  VISUAL_PROGRAM_V2_PLANNER_MAX_SCENES
  * VISUAL_PROGRAM_V2_PLANNER_MAX_PROPOSITIONS_PER_SCENE;
// Keep the grammar-bound catalog deliberately small. Each complete path is
// repeated in the strict JSON Schema, so a larger catalog can exceed the
// existing 32 KiB credential-free local-provider request budget.
const VISUAL_PROGRAM_V2_PLANNER_MAX_COMPLETE_PATHS = 8;
const COMPLETE_PATH_BEAM_WIDTH = VISUAL_PROGRAM_V2_PLANNER_MAX_COMPLETE_PATHS * 8;
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{2,79}$/;
const REJECTION_CODES = Object.freeze([
  "candidate_contract_invalid",
  "focus_not_grounded",
  "focus_not_dominant",
  "scene_density_exceeded",
  "participant_budget_exceeded",
  "partition_invalid",
  "candidate_compile_invalid",
  "semantic_trace_failed",
  "repetition_gate_failed",
]);
const REJECTION_GUIDANCE = Object.freeze({
  candidate_contract_invalid: "return_only_the_exact_required_json_fields",
  focus_not_grounded: "choose_each_focus_from_a_focusEntityIndexes_list_inside_its_scene_range",
  focus_not_dominant: "split_or_refocus_until_each_focus_participates_in_at_least_half_of_its_scene_propositions",
  scene_density_exceeded: "split_every_scene_range_to_at_most_4_propositions",
  participant_budget_exceeded: "split_ranges_until_each_scene_has_at_most_10_unique_participants",
  partition_invalid: "return_one_contiguous_ordered_partition_covering_every_proposition_exactly_once",
  candidate_compile_invalid: "use_only_the_supplied_indexes_and_allowed_layoutIntents",
  semantic_trace_failed: "split_or_refocus_so_each_scene_has_a_clear_grounded_non_text_semantic_action",
  repetition_gate_failed: "change_scene_boundaries_layoutIntents_or_focuses_without_changing_semantics",
});

function fail(field, reason = "invalid_value", status = 400) {
  throw new AppError(
    "GENERALIZED_VISUAL_PROGRAM_V2_PLANNER_INVALID",
    SAFE_MESSAGES.VALIDATION_ERROR || "The visual-program planner input is invalid.",
    status,
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

function safeDataClone(input, rootField) {
  const seen = new WeakSet();
  let visited = 0;
  function visit(value, field) {
    visited += 1;
    if (visited > 20_000) fail(rootField, "data_budget_exceeded");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
        fail(field, "unsafe_string");
      }
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail(field, "non_finite_number");
      return value;
    }
    if (!value || typeof value !== "object" || utilTypes.isProxy(value)) {
      fail(field, "plain_data_required");
    }
    if (seen.has(value)) fail(field, "cyclic_or_aliased_reference");
    seen.add(value);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if ((array && prototype !== Array.prototype)
      || (!array && prototype !== Object.prototype && prototype !== null)) {
      fail(field, "plain_data_required");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
      fail(field, "symbol_key_not_allowed");
    }
    if (array) {
      if (value.length > 256) fail(field, "array_budget_exceeded");
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.get || descriptor.set) {
          fail(`${field}[${index}]`, "plain_data_field_required");
        }
        output.push(visit(descriptor.value, `${field}[${index}]`));
      }
      return output;
    }
    const keys = Object.keys(descriptors);
    if (keys.length > 128) fail(field, "object_budget_exceeded");
    return Object.fromEntries(keys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set
        || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        fail(`${field}.${key}`, "plain_data_field_required");
      }
      return [key, visit(descriptor.value, `${field}.${key}`)];
    }));
  }
  return visit(input, rootField);
}

function exact(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(field, "object_required");
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${field}.${key}`, "unsupported_field");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${field}.${key}`, "required_field");
  }
}

function text(value, field, maximum, pattern = null) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f]/.test(value)
    || (pattern && !pattern.test(value))) {
    fail(field, "bounded_text_required");
  }
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(field, "integer_out_of_range");
  }
  return value;
}

function hash(value, field) {
  return text(value, field, 64, HASH_RE);
}

function canonicalHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function unique(values) {
  return [...new Set(values)];
}

function buildValidSceneRanges(propositions, entityIndexById) {
  const ranges = [];
  for (let start = 0; start < propositions.length; start += 1) {
    const maximumEnd = Math.min(
      propositions.length,
      start + VISUAL_PROGRAM_V2_PLANNER_MAX_PROPOSITIONS_PER_SCENE,
    );
    for (let end = start + 1; end <= maximumEnd; end += 1) {
      const selected = propositions.slice(start, end);
      const participantIds = unique(selected.flatMap(
        (proposition) => proposition.participantIds,
      ));
      if (participantIds.length > VISUAL_PROGRAM_V2_PLANNER_MAX_PARTICIPANTS) {
        continue;
      }
      const allowedFocusEntityIndexes = unique(selected.flatMap(
        (proposition) => proposition.focusEntityIds,
      )).filter((entityId) => selected.filter(
        (proposition) => proposition.participantIds.includes(entityId),
      ).length * 2 >= selected.length).map(
        (entityId) => entityIndexById.get(entityId),
      ).sort((left, right) => left - right);
      if (!allowedFocusEntityIndexes.length) continue;
      ranges.push({
        startPropositionIndex: start,
        endPropositionIndexExclusive: end,
        allowedFocusEntityIndexes,
      });
    }
  }
  return ranges;
}

function buildSceneRangeCandidates(validSceneRanges) {
  return validSceneRanges.flatMap((range) => (
    range.allowedFocusEntityIndexes.map((focusEntityIndex) => ({
      startPropositionIndex: range.startPropositionIndex,
      endPropositionIndexExclusive: range.endPropositionIndexExclusive,
      focusEntityIndex,
    }))
  )).map((candidate, candidateIndex) => ({
    candidateIndex,
    ...candidate,
  }));
}

function compareCandidateIndexArrays(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function sceneBandPenalty(sceneCount) {
  if (sceneCount < 3) return 3 - sceneCount;
  if (sceneCount > 7) return sceneCount - 7;
  return 0;
}

function compareCompletePaths(left, right) {
  return sceneBandPenalty(left.candidateIndexes.length)
    - sceneBandPenalty(right.candidateIndexes.length)
    || right.rangeLengthScore - left.rangeLengthScore
    || right.semanticCoherenceScore - left.semanticCoherenceScore
    || right.focusParticipationScore - left.focusParticipationScore
    || right.focusChangeCount - left.focusChangeCount
    || new Set(right.focusIndexes).size - new Set(left.focusIndexes).size
    || compareCandidateIndexArrays(left.candidateIndexes, right.candidateIndexes);
}

function comparePartialPaths(left, right) {
  return left.candidateIndexes.length - right.candidateIndexes.length
    || right.rangeLengthScore - left.rangeLengthScore
    || right.semanticCoherenceScore - left.semanticCoherenceScore
    || right.focusParticipationScore - left.focusParticipationScore
    || right.focusChangeCount - left.focusChangeCount
    || compareCandidateIndexArrays(left.candidateIndexes, right.candidateIndexes);
}

function extendCompletePath(path, candidate, propositions, entities) {
  const selected = propositions.slice(
    candidate.startPropositionIndex,
    candidate.endPropositionIndexExclusive,
  );
  const rangeLength = selected.length;
  const beatCoherent = selected.every(
    (proposition) => proposition.beatOrdinal === selected[0].beatOrdinal,
  );
  const participantConnected = selected.every((proposition, index) => index === 0
    || proposition.participantIds.some(
      (entityId) => selected[index - 1].participantIds.includes(entityId),
    ));
  const focusEntityId = entities[candidate.focusEntityIndex].id;
  const focusParticipation = selected.filter(
    (proposition) => proposition.participantIds.includes(focusEntityId),
  ).length;
  const previousFocus = path.focusIndexes.at(-1);
  return {
    candidateIndexes: [...path.candidateIndexes, candidate.candidateIndex],
    rangeLengthScore: path.rangeLengthScore + rangeLength * rangeLength,
    semanticCoherenceScore: path.semanticCoherenceScore
      + (beatCoherent ? 2 : 0)
      + (participantConnected ? 1 : 0),
    focusParticipationScore: path.focusParticipationScore + focusParticipation,
    focusChangeCount: path.focusChangeCount
      + (previousFocus !== undefined
        && previousFocus !== candidate.focusEntityIndex ? 1 : 0),
    focusIndexes: [...path.focusIndexes, candidate.focusEntityIndex],
  };
}

function buildCompletePartitionCatalog(
  sceneRangeCandidates,
  propositions,
  entities,
) {
  const candidatesByStart = Array.from(
    { length: propositions.length },
    () => [],
  );
  sceneRangeCandidates.forEach((candidate) => {
    candidatesByStart[candidate.startPropositionIndex].push(candidate);
  });
  const pathsByEnd = Array.from(
    { length: propositions.length + 1 },
    () => [],
  );
  pathsByEnd[0] = [{
    candidateIndexes: [],
    rangeLengthScore: 0,
    semanticCoherenceScore: 0,
    focusParticipationScore: 0,
    focusChangeCount: 0,
    focusIndexes: [],
  }];
  for (let start = 0; start < propositions.length; start += 1) {
    const sourcePaths = pathsByEnd[start].slice(0, COMPLETE_PATH_BEAM_WIDTH);
    for (const path of sourcePaths) {
      if (path.candidateIndexes.length >= VISUAL_PROGRAM_V2_PLANNER_MAX_SCENES) {
        continue;
      }
      for (const candidate of candidatesByStart[start]) {
        const extended = extendCompletePath(
          path,
          candidate,
          propositions,
          entities,
        );
        const destination = pathsByEnd[candidate.endPropositionIndexExclusive];
        destination.push(extended);
        if (destination.length > COMPLETE_PATH_BEAM_WIDTH * 2) {
          destination.sort(comparePartialPaths);
          destination.length = COMPLETE_PATH_BEAM_WIDTH;
        }
      }
    }
    for (let end = start + 1; end <= Math.min(
      propositions.length,
      start + VISUAL_PROGRAM_V2_PLANNER_MAX_PROPOSITIONS_PER_SCENE,
    ); end += 1) {
      if (pathsByEnd[end].length > COMPLETE_PATH_BEAM_WIDTH) {
        pathsByEnd[end].sort(comparePartialPaths);
        pathsByEnd[end].length = COMPLETE_PATH_BEAM_WIDTH;
      }
    }
  }
  const complete = pathsByEnd[propositions.length]
    .filter((path) => path.candidateIndexes.length >= 1
      && path.candidateIndexes.length <= VISUAL_PROGRAM_V2_PLANNER_MAX_SCENES)
    .sort(compareCompletePaths)
    .slice(0, VISUAL_PROGRAM_V2_PLANNER_MAX_COMPLETE_PATHS)
    .map((path) => path.candidateIndexes);
  if (!complete.length) {
    fail("semanticEventGraph.propositions", "complete_partition_catalog_unavailable", 409);
  }
  return complete;
}

function durationBucket(frameCount, fps) {
  const seconds = frameCount / fps;
  if (seconds < 0.8) return "brief";
  if (seconds < 1.6) return "short";
  if (seconds < 3) return "medium";
  return "long";
}

function buildVisualProgramV2PlannerContext(input = {}) {
  const timingContext = normalizeAnimationTimingContext(input.timingContext);
  const rawGraph = input.semanticEventGraph;
  if (!rawGraph || typeof rawGraph !== "object" || Array.isArray(rawGraph)
    || utilTypes.isProxy(rawGraph)) {
    fail("semanticEventGraph", "plain_object_required", 409);
  }
  const graph = safeDataClone({
    storyTitle: rawGraph.storyTitle,
    draftHash: rawGraph.draftHash,
    sourceStoryboardHash: rawGraph.sourceStoryboardHash,
    timingContextHash: rawGraph.timingContextHash,
    entities: rawGraph.entities,
    propositions: rawGraph.propositions,
  }, "semanticEventGraph");
  text(graph.storyTitle, "semanticEventGraph.storyTitle", 96);
  hash(graph.draftHash, "semanticEventGraph.draftHash");
  hash(graph.sourceStoryboardHash, "semanticEventGraph.sourceStoryboardHash");
  hash(graph.timingContextHash, "semanticEventGraph.timingContextHash");
  if (graph.timingContextHash !== timingContext.contentHash
    || graph.draftHash !== timingContext.draftHash) {
    fail("semanticEventGraph", "timing_binding_mismatch", 409);
  }
  if (!Array.isArray(graph.entities) || graph.entities.length < 1
    || graph.entities.length > 64) {
    fail("semanticEventGraph.entities", "array_size_invalid", 409);
  }
  const entityIds = new Set();
  const entities = graph.entities.map((entity, index) => {
    const field = `semanticEventGraph.entities[${index}]`;
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
      fail(field, "object_required", 409);
    }
    const id = text(entity.id, `${field}.id`, 80, ID_RE);
    if (entityIds.has(id)) fail(`${field}.id`, "duplicate_id", 409);
    entityIds.add(id);
    if (typeof entity.persistent !== "boolean") {
      fail(`${field}.persistent`, "boolean_required", 409);
    }
    return {
      index,
      id,
      kind: text(entity.kind, `${field}.kind`, 80, ID_RE),
      visualSubjectKind: text(
        entity.visualSubjectKind,
        `${field}.visualSubjectKind`,
        80,
        ID_RE,
      ),
      persistent: entity.persistent,
    };
  });
  const entityIndexById = new Map(entities.map((entity) => [entity.id, entity.index]));
  const beatOrdinalById = new Map(
    timingContext.beats.map((beat, index) => [beat.beatId, index]),
  );
  if (!Array.isArray(graph.propositions) || graph.propositions.length < 1
    || graph.propositions.length > VISUAL_PROGRAM_V2_PLANNER_MAX_PROPOSITIONS) {
    fail("semanticEventGraph.propositions", "array_size_invalid", 409);
  }
  const propositionIds = new Set();
  let previousStart = -1;
  const propositions = graph.propositions.map((proposition, index) => {
    const field = `semanticEventGraph.propositions[${index}]`;
    if (!proposition || typeof proposition !== "object" || Array.isArray(proposition)) {
      fail(field, "object_required", 409);
    }
    const id = text(proposition.id, `${field}.id`, 80, ID_RE);
    if (propositionIds.has(id)) fail(`${field}.id`, "duplicate_id", 409);
    propositionIds.add(id);
    const beatId = text(proposition.beatId, `${field}.beatId`, 80, ID_RE);
    const beatOrdinal = beatOrdinalById.get(beatId);
    if (!Number.isSafeInteger(beatOrdinal)) fail(`${field}.beatId`, "unknown_beat", 409);
    const timingBeat = timingContext.beats[beatOrdinal];
    const startFrame = integer(
      proposition.wordSpan?.startFrame,
      `${field}.wordSpan.startFrame`,
      timingBeat.startFrame,
      timingBeat.endFrame - 1,
    );
    const endFrame = integer(
      proposition.wordSpan?.endFrame,
      `${field}.wordSpan.endFrame`,
      startFrame + 1,
      timingBeat.endFrame,
    );
    if (startFrame < previousStart) fail(`${field}.wordSpan`, "not_ordered", 409);
    previousStart = startFrame;
    const subjectEntityId = text(
      proposition.subject?.entityId,
      `${field}.subject.entityId`,
      80,
      ID_RE,
    );
    const objectEntityIds = Array.isArray(proposition.object?.entityIds)
      ? proposition.object.entityIds.map((entry, objectIndex) => text(
        entry,
        `${field}.object.entityIds[${objectIndex}]`,
        80,
        ID_RE,
      ))
      : fail(`${field}.object.entityIds`, "array_required", 409);
    const focusEntityIds = Array.isArray(proposition.visualAction?.focusEntityIds)
      ? proposition.visualAction.focusEntityIds.map((entry, focusIndex) => text(
        entry,
        `${field}.visualAction.focusEntityIds[${focusIndex}]`,
        80,
        ID_RE,
      ))
      : fail(`${field}.visualAction.focusEntityIds`, "array_required", 409);
    if (!focusEntityIds.length || objectEntityIds.length > 8 || focusEntityIds.length > 8
      || new Set(objectEntityIds).size !== objectEntityIds.length
      || new Set(focusEntityIds).size !== focusEntityIds.length) {
      fail(field, "entity_reference_budget_invalid", 409);
    }
    const participantIds = unique([
      subjectEntityId,
      ...objectEntityIds,
      ...focusEntityIds,
    ]);
    if (participantIds.some((entityId) => !entityIndexById.has(entityId))) {
      fail(field, "unknown_entity_reference", 409);
    }
    const certainty = text(proposition.certainty, `${field}.certainty`, 32, ID_RE);
    if (!["verified", "qualified", "disputed"].includes(certainty)) {
      fail(`${field}.certainty`, "unsupported_value", 409);
    }
    const polarity = text(proposition.polarity, `${field}.polarity`, 32, ID_RE);
    if (!["affirmed", "negated"].includes(polarity)) {
      fail(`${field}.polarity`, "unsupported_value", 409);
    }
    return {
      index,
      id,
      beatId,
      beatOrdinal,
      eventKind: text(proposition.eventKind, `${field}.eventKind`, 80, ID_RE),
      predicate: text(proposition.predicate, `${field}.predicate`, 80, ID_RE),
      polarity,
      certainty,
      subjectEntityId,
      objectEntityIds,
      focusEntityIds,
      participantIds,
      startFrame,
      endFrame,
      durationBucket: durationBucket(endFrame - startFrame, timingContext.fps),
    };
  });
  const graphHash = calibrationSemanticGraphContentHashV2(graph);
  const validSceneRanges = buildValidSceneRanges(
    propositions,
    entityIndexById,
  );
  const sceneRangeCandidates = buildSceneRangeCandidates(validSceneRanges);
  const completePartitionCatalog = buildCompletePartitionCatalog(
    sceneRangeCandidates,
    propositions,
    entities,
  );
  const catalogCandidateIndexes = new Set(completePartitionCatalog.flat());
  const projectedSceneRangeCandidates = sceneRangeCandidates.filter(
    (candidate) => catalogCandidateIndexes.has(candidate.candidateIndex),
  );
  const projection = {
    schemaVersion: 1,
    entityCount: entities.length,
    propositionCount: propositions.length,
    entities: entities.map((entity) => ({
      index: entity.index,
      kind: entity.kind,
      visualSubjectKind: entity.visualSubjectKind,
      persistent: entity.persistent,
    })),
    propositions: propositions.map((proposition) => ({
      index: proposition.index,
      beatOrdinal: proposition.beatOrdinal,
      eventKind: proposition.eventKind,
      predicate: proposition.predicate,
      polarity: proposition.polarity,
      certainty: proposition.certainty,
      subjectEntityIndex: entityIndexById.get(proposition.subjectEntityId),
      objectEntityIndexes: proposition.objectEntityIds.map(
        (entityId) => entityIndexById.get(entityId),
      ),
      focusEntityIndexes: proposition.focusEntityIds.map(
        (entityId) => entityIndexById.get(entityId),
      ),
      participantEntityIndexes: proposition.participantIds.map(
        (entityId) => entityIndexById.get(entityId),
      ),
      durationBucket: proposition.durationBucket,
    })),
    sceneRangeCandidates: projectedSceneRangeCandidates,
    completePartitionCatalog,
  };
  const projectionHash = canonicalHash(projection);
  return deepFreeze({
    graph,
    graphHash,
    timingContext,
    entities,
    propositions,
    validSceneRanges,
    sceneRangeCandidates,
    completePartitionCatalog,
    projection,
    projectionHash,
  });
}

function participantsForRange(context, start, end) {
  return unique(context.propositions.slice(start, end).flatMap(
    (proposition) => proposition.participantIds,
  ));
}

function normalizeVisualProgramV2PlannerChoice(input, context, options = {}) {
  if (!context || typeof context !== "object" || !Object.isFrozen(context)) {
    fail("context", "normalized_context_required", 500);
  }
  const value = safeDataClone(input, "choice");
  if (Object.hasOwn(value, "contentHash") && options.allowContentHash !== true) {
    fail("choice.contentHash", "engine_owned_field");
  }
  exact(
    value,
    options.allowContentHash === true && Object.hasOwn(value, "contentHash")
      ? ["schemaVersion", "scenes", "contentHash"]
      : ["schemaVersion", "scenes"],
    "choice",
  );
  const normalizedInput = value;
  if (normalizedInput.schemaVersion !== VISUAL_PROGRAM_V2_PLANNER_CHOICE_SCHEMA_VERSION) {
    fail("choice.schemaVersion", "unsupported_schema");
  }
  if (!Array.isArray(normalizedInput.scenes) || normalizedInput.scenes.length < 1
    || normalizedInput.scenes.length > Math.min(
      VISUAL_PROGRAM_V2_PLANNER_MAX_SCENES,
      context.propositions.length,
    )) {
    fail("choice.scenes", "scene_budget_invalid");
  }
  let expectedStart = 0;
  const scenes = normalizedInput.scenes.map((scene, index) => {
    const field = `choice.scenes[${index}]`;
    exact(scene, [
      "startPropositionIndex",
      "endPropositionIndexExclusive",
      "layoutIntent",
      "focusEntityIndex",
    ], field);
    const startPropositionIndex = integer(
      scene.startPropositionIndex,
      `${field}.startPropositionIndex`,
      0,
      context.propositions.length - 1,
    );
    const endPropositionIndexExclusive = integer(
      scene.endPropositionIndexExclusive,
      `${field}.endPropositionIndexExclusive`,
      startPropositionIndex + 1,
      context.propositions.length,
    );
    if (startPropositionIndex !== expectedStart) {
      fail(`${field}.startPropositionIndex`, "contiguous_partition_required");
    }
    expectedStart = endPropositionIndexExclusive;
    const layoutIntent = text(scene.layoutIntent, `${field}.layoutIntent`, 80, ID_RE);
    if (!VISUAL_PROGRAM_V2_LAYOUT_INTENTS.includes(layoutIntent)) {
      fail(`${field}.layoutIntent`, "unsupported_layout_intent");
    }
    const focusEntityIndex = integer(
      scene.focusEntityIndex,
      `${field}.focusEntityIndex`,
      0,
      context.entities.length - 1,
    );
    const focusEntityId = context.entities[focusEntityIndex].id;
    const selected = context.propositions.slice(
      startPropositionIndex,
      endPropositionIndexExclusive,
    );
    if (selected.length > VISUAL_PROGRAM_V2_PLANNER_MAX_PROPOSITIONS_PER_SCENE) {
      fail(field, "scene_semantic_density_exceeded");
    }
    const participantIds = participantsForRange(
      context,
      startPropositionIndex,
      endPropositionIndexExclusive,
    );
    if (participantIds.length > VISUAL_PROGRAM_V2_PLANNER_MAX_PARTICIPANTS) {
      fail(field, "participant_budget_exceeded");
    }
    if (!participantIds.includes(focusEntityId)
      || !selected.some((proposition) => proposition.focusEntityIds.includes(focusEntityId))) {
      fail(`${field}.focusEntityIndex`, "focus_not_grounded");
    }
    const focusParticipationCount = selected.filter(
      (proposition) => proposition.participantIds.includes(focusEntityId),
    ).length;
    if (focusParticipationCount * 2 < selected.length) {
      fail(`${field}.focusEntityIndex`, "focus_not_dominant");
    }
    const candidateRange = context.validSceneRanges.find((candidate) => (
      candidate.startPropositionIndex === startPropositionIndex
      && candidate.endPropositionIndexExclusive === endPropositionIndexExclusive
    ));
    if (!candidateRange
      || !candidateRange.allowedFocusEntityIndexes.includes(focusEntityIndex)) {
      fail(field, "candidate_range_required");
    }
    return {
      startPropositionIndex,
      endPropositionIndexExclusive,
      layoutIntent,
      focusEntityIndex,
    };
  });
  if (expectedStart !== context.propositions.length) {
    fail("choice.scenes", "complete_partition_required");
  }
  const normalized = {
    schemaVersion: VISUAL_PROGRAM_V2_PLANNER_CHOICE_SCHEMA_VERSION,
    scenes,
  };
  const contentHash = canonicalHash(normalized);
  if (options.allowContentHash === true && Object.hasOwn(value, "contentHash")
    && value.contentHash !== contentHash) {
    fail("choice.contentHash", "content_hash_mismatch");
  }
  return deepFreeze({ ...normalized, contentHash });
}

function normalizeVisualProgramV2ProviderSelection(input, context, options = {}) {
  if (!context || typeof context !== "object" || !Object.isFrozen(context)) {
    fail("context", "normalized_context_required", 500);
  }
  const value = safeDataClone(input, "providerSelection");
  if (Object.hasOwn(value, "contentHash") && options.allowContentHash !== true) {
    fail("providerSelection.contentHash", "engine_owned_field");
  }
  exact(
    value,
    options.allowContentHash === true && Object.hasOwn(value, "contentHash")
      ? ["schemaVersion", "scenes", "contentHash"]
      : ["schemaVersion", "scenes"],
    "providerSelection",
  );
  if (value.schemaVersion !== VISUAL_PROGRAM_V2_PROVIDER_SELECTION_SCHEMA_VERSION) {
    fail("providerSelection.schemaVersion", "unsupported_schema");
  }
  if (!Array.isArray(value.scenes) || value.scenes.length < 1
    || value.scenes.length > Math.min(
      VISUAL_PROGRAM_V2_PLANNER_MAX_SCENES,
      context.propositions.length,
    )) {
    fail("providerSelection.scenes", "scene_budget_invalid");
  }
  let expectedStart = 0;
  const scenes = value.scenes.map((scene, index) => {
    const field = `providerSelection.scenes[${index}]`;
    exact(scene, ["rangeCandidateIndex", "layoutIntent"], field);
    const rangeCandidateIndex = integer(
      scene.rangeCandidateIndex,
      `${field}.rangeCandidateIndex`,
      0,
      context.sceneRangeCandidates.length - 1,
    );
    const candidate = context.sceneRangeCandidates[rangeCandidateIndex];
    if (!candidate || candidate.startPropositionIndex !== expectedStart) {
      fail(`${field}.rangeCandidateIndex`, "provider_selection_partition_invalid");
    }
    expectedStart = candidate.endPropositionIndexExclusive;
    const layoutIntent = text(scene.layoutIntent, `${field}.layoutIntent`, 80, ID_RE);
    if (!VISUAL_PROGRAM_V2_LAYOUT_INTENTS.includes(layoutIntent)) {
      fail(`${field}.layoutIntent`, "unsupported_layout_intent");
    }
    return { rangeCandidateIndex, layoutIntent };
  });
  if (expectedStart !== context.propositions.length) {
    fail("providerSelection.scenes", "provider_selection_partition_invalid");
  }
  const selectedPath = scenes.map((scene) => scene.rangeCandidateIndex);
  if (!context.completePartitionCatalog.some((catalogPath) => (
    catalogPath.length === selectedPath.length
    && catalogPath.every((candidateIndex, index) => (
      candidateIndex === selectedPath[index]
    ))
  ))) {
    fail("providerSelection.scenes", "provider_selection_path_not_catalogued");
  }
  const normalized = {
    schemaVersion: VISUAL_PROGRAM_V2_PROVIDER_SELECTION_SCHEMA_VERSION,
    scenes,
  };
  const contentHash = canonicalHash(normalized);
  if (options.allowContentHash === true && Object.hasOwn(value, "contentHash")
    && value.contentHash !== contentHash) {
    fail("providerSelection.contentHash", "content_hash_mismatch");
  }
  return deepFreeze({ ...normalized, contentHash });
}

function materializeVisualProgramV2PlannerChoiceFromProviderSelection(
  context,
  rawSelection,
) {
  const selection = normalizeVisualProgramV2ProviderSelection(
    rawSelection,
    context,
    { allowContentHash: true },
  );
  return normalizeVisualProgramV2PlannerChoice({
    schemaVersion: VISUAL_PROGRAM_V2_PLANNER_CHOICE_SCHEMA_VERSION,
    scenes: selection.scenes.map((scene) => {
      const candidate = context.sceneRangeCandidates[scene.rangeCandidateIndex];
      return {
        startPropositionIndex: candidate.startPropositionIndex,
        endPropositionIndexExclusive: candidate.endPropositionIndexExclusive,
        layoutIntent: scene.layoutIntent,
        focusEntityIndex: candidate.focusEntityIndex,
      };
    }),
  }, context);
}

function materializeVisualProgramV2ProviderSelectionFromPlannerChoice(
  context,
  rawChoice,
) {
  const choice = normalizeVisualProgramV2PlannerChoice(rawChoice, context, {
    allowContentHash: true,
  });
  return normalizeVisualProgramV2ProviderSelection({
    schemaVersion: VISUAL_PROGRAM_V2_PROVIDER_SELECTION_SCHEMA_VERSION,
    scenes: choice.scenes.map((scene, index) => {
      const rangeCandidateIndex = context.sceneRangeCandidates.findIndex(
        (candidate) => (
          candidate.startPropositionIndex === scene.startPropositionIndex
          && candidate.endPropositionIndexExclusive
            === scene.endPropositionIndexExclusive
          && candidate.focusEntityIndex === scene.focusEntityIndex
        ),
      );
      if (rangeCandidateIndex < 0) {
        fail(`choice.scenes[${index}]`, "candidate_range_required", 500);
      }
      return { rangeCandidateIndex, layoutIntent: scene.layoutIntent };
    }),
  }, context);
}

function materializeVisualProgramProposalV2(context, rawChoice) {
  const choice = normalizeVisualProgramV2PlannerChoice(rawChoice, context, {
    allowContentHash: true,
  });
  return normalizeVisualProgramProposalV2({
    schemaVersion: 2,
    profile: "generalized_visual_program_proposal_v2",
    bindings: {
      semanticEventGraphHash: context.graphHash,
      timingContextHash: context.timingContext.contentHash,
      draftHash: context.graph.draftHash,
      sourceRevisionHash: context.graph.sourceStoryboardHash,
    },
    styleSpecId: VISUAL_PROGRAM_V2_STYLE_SPEC_ID,
    scenes: choice.scenes.map((scene, index) => {
      const selected = context.propositions.slice(
        scene.startPropositionIndex,
        scene.endPropositionIndexExclusive,
      );
      return {
        id: `visual_scene_${String(index).padStart(2, "0")}`,
        entityIds: participantsForRange(
          context,
          scene.startPropositionIndex,
          scene.endPropositionIndexExclusive,
        ),
        propositionIds: selected.map((proposition) => proposition.id),
        layoutIntent: scene.layoutIntent,
        focusEntityId: context.entities[scene.focusEntityIndex].id,
      };
    }),
  });
}

function inferredLayout(context, start, end) {
  const propositions = context.propositions.slice(start, end);
  const participantCount = participantsForRange(context, start, end).length;
  const qualified = propositions.some((entry) => (
    entry.polarity === "negated"
    || entry.certainty !== "verified"
    || /(?:contrast|different|unknown|not_|reject|versus)/.test(entry.predicate)
  ));
  if (qualified) return "split_compare";
  if (participantCount >= 6) return "layered_stack";
  const relationCount = propositions.reduce(
    (count, proposition) => count + proposition.objectEntityIds.length,
    0,
  );
  const sequential = propositions.length > 2 && propositions.every(
    (proposition, index) => index === 0
      || propositions[index - 1].objectEntityIds.includes(proposition.subjectEntityId),
  );
  if (sequential) return "timeline_track";
  if (relationCount > 1 || participantCount > 2) return "directed_flow";
  if (relationCount === 1) return "directed_flow";
  return "radial_focus";
}

function buildDeterministicVisualProgramV2PlannerChoice(context) {
  const ranges = [];
  let start = 0;
  while (start < context.propositions.length) {
    const beatOrdinal = context.propositions[start].beatOrdinal;
    let end = start + 1;
    while (end < context.propositions.length
      && context.propositions[end].beatOrdinal === beatOrdinal
      && end - start < VISUAL_PROGRAM_V2_PLANNER_MAX_PROPOSITIONS_PER_SCENE
      && participantsForRange(context, start, end + 1).length
        <= VISUAL_PROGRAM_V2_PLANNER_MAX_PARTICIPANTS) {
      end += 1;
    }
    ranges.push([start, end]);
    start = end;
  }
  if (ranges.length > VISUAL_PROGRAM_V2_PLANNER_MAX_SCENES) {
    fail("context.propositions", "deterministic_scene_budget_exceeded", 409);
  }
  return normalizeVisualProgramV2PlannerChoice({
    schemaVersion: VISUAL_PROGRAM_V2_PLANNER_CHOICE_SCHEMA_VERSION,
    scenes: ranges.map(([rangeStart, rangeEnd]) => {
      const selected = context.propositions.slice(rangeStart, rangeEnd);
      const focusCandidates = unique(selected.flatMap(
        (proposition) => proposition.focusEntityIds,
      ));
      const preferredFocus = focusCandidates
        .map((entityId, candidateIndex) => ({
          entityId,
          candidateIndex,
          participation: selected.filter(
            (proposition) => proposition.participantIds.includes(entityId),
          ).length,
        }))
        .sort((left, right) => right.participation - left.participation
          || right.candidateIndex - left.candidateIndex)[0]?.entityId;
      return {
        startPropositionIndex: rangeStart,
        endPropositionIndexExclusive: rangeEnd,
        layoutIntent: inferredLayout(context, rangeStart, rangeEnd),
        focusEntityIndex: context.entities.find(
          (entity) => entity.id === preferredFocus,
        ).index,
      };
    }),
  }, context);
}

function buildVisualProgramV2PlannerPrompt(context, options = {}) {
  const attemptIndex = integer(
    options.attemptIndex ?? 1,
    "prompt.attemptIndex",
    1,
    VISUAL_PROGRAM_V2_PLANNER_MAX_ATTEMPTS,
  );
  const rejectionCodes = options.rejectionCodes || [];
  if (!Array.isArray(rejectionCodes) || rejectionCodes.length > REJECTION_CODES.length
    || new Set(rejectionCodes).size !== rejectionCodes.length
    || rejectionCodes.some((code) => !REJECTION_CODES.includes(code))) {
    fail("prompt.rejectionCodes", "unsupported_rejection_codes", 500);
  }
  return deepFreeze({
    schemaVersion: 1,
    promptProfileId: LOCAL_LLM_VISUAL_PROGRAM_V2_PROMPT_PROFILE_ID,
    task: "select_indexed_scene_range_candidates_and_layouts",
    attemptIndex,
    rejectionCodes: [...rejectionCodes],
    rejectionGuidance: rejectionCodes.map((code) => ({
      code,
      action: REJECTION_GUIDANCE[code],
    })),
    retryInstruction: rejectionCodes.length
      ? "correct_every_listed_rejection_code_without_relaxing_any_constraint"
      : "none",
    context: context.projection,
    constraints: {
      exactOrderedPartitionRequired: true,
      minimumScenes: Math.ceil(
        context.propositions.length
          / VISUAL_PROGRAM_V2_PLANNER_MAX_PROPOSITIONS_PER_SCENE,
      ),
      maximumScenes: Math.min(
        VISUAL_PROGRAM_V2_PLANNER_MAX_SCENES,
        context.propositions.length,
      ),
      maximumParticipantsPerScene: VISUAL_PROGRAM_V2_PLANNER_MAX_PARTICIPANTS,
      maximumPropositionsPerScene: VISUAL_PROGRAM_V2_PLANNER_MAX_PROPOSITIONS_PER_SCENE,
      sceneRangeLengthFormula:
        "endPropositionIndexExclusive_minus_startPropositionIndex",
      firstSceneStartPropositionIndex: 0,
      finalSceneEndPropositionIndexExclusive: context.propositions.length,
      focusMustBeSelectedAndGrounded: true,
      focusGroundingRule:
        "focusEntityIndex_must_appear_in_focusEntityIndexes_for_a_proposition_inside_the_scene_range",
      oneDominantFocusPerScene: true,
      focusDominanceRule:
        "focusEntityIndex_must_be_a_participant_in_at_least_half_of_the_scene_propositions",
      everySceneMustSelectOneContextSceneRangeCandidate: true,
      candidateIndexSequenceMustMatchOneCompletePartitionCatalogPath: true,
    },
    allowedLayoutIntents: [...VISUAL_PROGRAM_V2_LAYOUT_INTENTS],
    responseContract: {
      exactTopLevelFields: ["schemaVersion", "scenes"],
      schemaVersionValue: VISUAL_PROGRAM_V2_PLANNER_CHOICE_SCHEMA_VERSION,
      exactSceneFields: [
        "rangeCandidateIndex",
        "layoutIntent",
      ],
      forbiddenWrapperFields: ["output", "result", "answer", "data", "response"],
    },
  });
}

module.exports = {
  LOCAL_LLM_VISUAL_PROGRAM_V2_PROMPT_PROFILE_ID,
  VISUAL_PROGRAM_V2_PLANNER_CHOICE_PROFILE_ID,
  VISUAL_PROGRAM_V2_PLANNER_CHOICE_SCHEMA_VERSION,
  VISUAL_PROGRAM_V2_PROVIDER_SELECTION_PROFILE_ID,
  VISUAL_PROGRAM_V2_PROVIDER_SELECTION_SCHEMA_VERSION,
  VISUAL_PROGRAM_V2_PLANNER_MAX_ATTEMPTS,
  VISUAL_PROGRAM_V2_PLANNER_MAX_COMPLETE_PATHS,
  VISUAL_PROGRAM_V2_PLANNER_MAX_PARTICIPANTS,
  VISUAL_PROGRAM_V2_PLANNER_MAX_PROPOSITIONS,
  VISUAL_PROGRAM_V2_PLANNER_MAX_PROPOSITIONS_PER_SCENE,
  VISUAL_PROGRAM_V2_PLANNER_MAX_SCENES,
  VISUAL_PROGRAM_V2_PLANNER_REJECTION_CODES: REJECTION_CODES,
  buildDeterministicVisualProgramV2PlannerChoice,
  buildVisualProgramV2PlannerContext,
  buildVisualProgramV2PlannerPrompt,
  materializeVisualProgramV2PlannerChoiceFromProviderSelection,
  materializeVisualProgramV2ProviderSelectionFromPlannerChoice,
  materializeVisualProgramProposalV2,
  normalizeVisualProgramV2ProviderSelection,
  normalizeVisualProgramV2PlannerChoice,
};
