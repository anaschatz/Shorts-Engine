"use strict";

const { createHash } = require("node:crypto");

const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  deepFreeze,
  normalizeSemanticEventGraph,
} = require("./semantic-event-validator.cjs");
const {
  VISUAL_SUBJECT_KINDS,
  assetSupportsProposition,
  grammarSupportsProposition,
  normalizeVisualCapabilityProposition,
  selectVisualCapability,
} = require("./visual-capability-registry.cjs");
const {
  SEMANTIC_SENTENCE_RENDERER_CAPABILITY_PAIRS,
} = require("./semantic-render-profile.cjs");
const {
  buildSemanticPrimitiveParameters,
  normalizeSemanticPrimitiveParameters,
} = require("./semantic-primitive-parameters.cjs");

const SEMANTIC_VISUAL_SENTENCE_PLAN_SCHEMA_VERSION = 1;
const SEMANTIC_VISUAL_SENTENCE_PLAN_PROFILE_ID =
  "dark_curiosity_semantic_visual_sentence_plan_v1";
const RECENT_VISUAL_HISTORY_LIMIT = 4;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z][a-z0-9_-]{2,119}$/;
const CLAIM_ID_PATTERN = /^claim_[A-Za-z0-9-]{2,72}$/;

function fail(field, reason = "invalid", code = "ANIMATION_SEMANTIC_VISUAL_SENTENCE_INVALID") {
  throw new AppError(
    code,
    "The semantic visual sentence plan is invalid or is not bound to its semantic event graph.",
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
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${field}.${key}`, "unsupported_field");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${field}.${key}`, "field_required");
  }
}

function text(value, field, options = {}) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) fail(field, "non_empty_safe_text_required");
  if (value.length > (options.maximum || 400)) fail(field, "text_too_long");
  if (options.pattern && !options.pattern.test(value)) fail(field, "invalid_format");
  return value;
}

function identifier(value, field) {
  return text(value, field, { maximum: 120, pattern: ID_PATTERN });
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

function boolean(value, field) {
  if (typeof value !== "boolean") fail(field, "boolean_required");
  return value;
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function uniqueStrings(value, field, options = {}) {
  if (
    !Array.isArray(value)
    || value.length < (options.minimum || 0)
    || value.length > (options.maximum || 96)
  ) fail(field, "array_size_invalid");
  const normalized = value.map((entry, index) => text(entry, `${field}[${index}]`, {
    maximum: options.textMaximum || 120,
    pattern: options.pattern,
  }));
  if (new Set(normalized).size !== normalized.length) fail(field, "duplicates_not_allowed");
  return normalized;
}

function canonicalHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function semanticVisualSentencePlanContentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return canonicalHash(copy);
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
  const startOffset = integer(input.startOffset, `${field}.startOffset`, 0, 2000);
  const operationIndex = input.operationIndex === null
    ? null
    : integer(input.operationIndex, `${field}.operationIndex`, 0, 39);
  return {
    sourceType: identifier(input.sourceType, `${field}.sourceType`),
    sourceId: identifier(input.sourceId, `${field}.sourceId`),
    operationIndex,
    field: text(input.field, `${field}.field`, {
      maximum: 80,
      pattern: /^[A-Za-z][A-Za-z0-9]*$/,
    }),
    startOffset,
    endOffset: integer(input.endOffset, `${field}.endOffset`, startOffset + 1, 2000),
    value: text(input.value, `${field}.value`, { maximum: 400 }),
  };
}

function normalizeSourceRefs(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    fail(field, "array_size_invalid");
  }
  const normalized = value.map((entry, index) => normalizeSourceRef(entry, `${field}[${index}]`));
  const signatures = normalized.map((entry) => stableStringify(entry));
  if (new Set(signatures).size !== signatures.length) fail(field, "duplicates_not_allowed");
  return normalized;
}

function normalizeWordSpan(input, field) {
  exactKeys(input, [
    "startWordIndex",
    "endWordIndex",
    "startFrame",
    "endFrame",
    "text",
  ], field);
  const startWordIndex = integer(input.startWordIndex, `${field}.startWordIndex`, 0, 399);
  const startFrame = integer(input.startFrame, `${field}.startFrame`, 0, 5399);
  return {
    startWordIndex,
    endWordIndex: integer(input.endWordIndex, `${field}.endWordIndex`, startWordIndex + 1, 400),
    startFrame,
    endFrame: integer(input.endFrame, `${field}.endFrame`, startFrame + 1, 5400),
    text: text(input.text, `${field}.text`, { maximum: 400 }),
  };
}

function normalizeVisualIntent(input, field) {
  exactKeys(input, [
    "focusEntityId",
    "predicate",
    "subjectKind",
    "stateTransition",
  ], field);
  const capability = normalizeVisualCapabilityProposition({
    predicate: input.predicate,
    subjectKind: input.subjectKind,
    stateTransition: input.stateTransition,
  });
  return {
    focusEntityId: identifier(input.focusEntityId, `${field}.focusEntityId`),
    ...capability,
  };
}

function normalizeFocusEntity(input, field) {
  exactKeys(input, ["id", "visualSubjectKind", "persistent"], field);
  const visualSubjectKind = text(input.visualSubjectKind, `${field}.visualSubjectKind`, {
    maximum: 80,
  });
  if (!VISUAL_SUBJECT_KINDS.includes(visualSubjectKind)) {
    fail(`${field}.visualSubjectKind`, "unsupported_value");
  }
  return {
    id: identifier(input.id, `${field}.id`),
    visualSubjectKind,
    persistent: boolean(input.persistent, `${field}.persistent`),
  };
}

function normalizeCapability(input, field, visualIntent) {
  exactKeys(input, [
    "assetId",
    "grammarId",
    "score",
    "semanticScore",
    "continuityScore",
    "noveltyScore",
  ], field);
  const assetId = identifier(input.assetId, `${field}.assetId`);
  const grammarId = identifier(input.grammarId, `${field}.grammarId`);
  const proposition = {
    predicate: visualIntent.predicate,
    subjectKind: visualIntent.subjectKind,
    stateTransition: visualIntent.stateTransition,
  };
  if (!assetSupportsProposition(assetId, proposition)) {
    fail(`${field}.assetId`, "asset_semantically_incompatible");
  }
  if (!grammarSupportsProposition(grammarId, proposition)) {
    fail(`${field}.grammarId`, "grammar_semantically_incompatible");
  }
  return {
    assetId,
    grammarId,
    score: integer(input.score, `${field}.score`, 0, 1_000_000),
    semanticScore: integer(input.semanticScore, `${field}.semanticScore`, 0, 1000),
    continuityScore: integer(input.continuityScore, `${field}.continuityScore`, 0, 1000),
    noveltyScore: integer(input.noveltyScore, `${field}.noveltyScore`, 0, 1000),
  };
}

function normalizeContinuity(input, field) {
  exactKeys(input, ["carriedEntityIds", "carriedAssetIds"], field);
  return {
    carriedEntityIds: uniqueStrings(input.carriedEntityIds, `${field}.carriedEntityIds`, {
      maximum: 24,
      pattern: ID_PATTERN,
    }),
    carriedAssetIds: uniqueStrings(input.carriedAssetIds, `${field}.carriedAssetIds`, {
      maximum: 24,
      pattern: ID_PATTERN,
    }),
  };
}

function normalizeSentence(input, index) {
  const field = `sentences[${index}]`;
  exactKeys(input, [
    "id",
    "propositionId",
    "beatId",
    "claimIds",
    "wordSpan",
    "sourceRefs",
    "visualIntent",
    "participantEntityIds",
    "focusEntity",
    "persistentEntityIds",
    "capability",
    "continuity",
  ], field, ["primitiveParameters"]);
  const propositionId = identifier(input.propositionId, `${field}.propositionId`);
  const visualIntent = normalizeVisualIntent(input.visualIntent, `${field}.visualIntent`);
  const focusEntity = normalizeFocusEntity(input.focusEntity, `${field}.focusEntity`);
  if (focusEntity.id !== visualIntent.focusEntityId) {
    fail(`${field}.focusEntity.id`, "visual_intent_focus_mismatch");
  }
  if (focusEntity.visualSubjectKind !== visualIntent.subjectKind) {
    fail(`${field}.focusEntity.visualSubjectKind`, "visual_intent_subject_kind_mismatch");
  }
  const participantEntityIds = uniqueStrings(
    input.participantEntityIds,
    `${field}.participantEntityIds`,
    { minimum: 1, maximum: 8, pattern: ID_PATTERN },
  );
  if (!participantEntityIds.includes(focusEntity.id)) {
    fail(`${field}.participantEntityIds`, "visual_intent_focus_not_a_participant");
  }
  const persistentEntityIds = uniqueStrings(
    input.persistentEntityIds,
    `${field}.persistentEntityIds`,
    { maximum: 8, pattern: ID_PATTERN },
  ).sort(compareText);
  if (focusEntity.persistent !== persistentEntityIds.includes(focusEntity.id)) {
    fail(`${field}.persistentEntityIds`, "focus_persistence_mismatch");
  }
  const capability = normalizeCapability(
    input.capability,
    `${field}.capability`,
    visualIntent,
  );
  const normalized = {
    id: identifier(input.id, `${field}.id`),
    propositionId,
    beatId: identifier(input.beatId, `${field}.beatId`),
    claimIds: uniqueStrings(input.claimIds, `${field}.claimIds`, {
      minimum: 1,
      maximum: 6,
      pattern: CLAIM_ID_PATTERN,
    }),
    wordSpan: normalizeWordSpan(input.wordSpan, `${field}.wordSpan`),
    sourceRefs: normalizeSourceRefs(input.sourceRefs, `${field}.sourceRefs`),
    visualIntent,
    participantEntityIds,
    focusEntity,
    persistentEntityIds,
    capability,
    continuity: normalizeContinuity(input.continuity, `${field}.continuity`),
  };
  if (input.primitiveParameters !== undefined) {
    const primitiveParameters = normalizeSemanticPrimitiveParameters(
      input.primitiveParameters,
    );
    if (
      primitiveParameters.grammarId !== capability.grammarId
      || primitiveParameters.assetId !== capability.assetId
    ) fail(`${field}.primitiveParameters`, "capability_binding_mismatch");
    normalized.primitiveParameters = primitiveParameters;
  }
  return normalized;
}

function normalizeBindings(input) {
  exactKeys(input, [
    "semanticEventGraphHash",
    "draftHash",
    "sourceStoryboardHash",
    "timingContextHash",
  ], "bindings");
  return {
    semanticEventGraphHash: hash(input.semanticEventGraphHash, "bindings.semanticEventGraphHash"),
    draftHash: hash(input.draftHash, "bindings.draftHash"),
    sourceStoryboardHash: hash(input.sourceStoryboardHash, "bindings.sourceStoryboardHash"),
    timingContextHash: hash(input.timingContextHash, "bindings.timingContextHash"),
  };
}

function normalizePersistentEntityBinding(input, index) {
  const field = `persistentEntityBindings[${index}]`;
  exactKeys(input, [
    "entityId",
    "visualSubjectKind",
    "assetId",
    "sentenceIds",
  ], field);
  const visualSubjectKind = text(input.visualSubjectKind, `${field}.visualSubjectKind`, {
    maximum: 80,
  });
  if (!VISUAL_SUBJECT_KINDS.includes(visualSubjectKind)) {
    fail(`${field}.visualSubjectKind`, "unsupported_value");
  }
  return {
    entityId: identifier(input.entityId, `${field}.entityId`),
    visualSubjectKind,
    assetId: identifier(input.assetId, `${field}.assetId`),
    sentenceIds: uniqueStrings(input.sentenceIds, `${field}.sentenceIds`, {
      minimum: 1,
      maximum: 96,
      pattern: ID_PATTERN,
    }),
  };
}

function same(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function recent(values) {
  return values.slice(-RECENT_VISUAL_HISTORY_LIMIT);
}

function expectedContinuity(sentence, persistentAssetByEntity) {
  const carriedEntityIds = sentence.persistentEntityIds
    .filter((entityId) => persistentAssetByEntity.has(entityId))
    .sort(compareText);
  const carriedAssetIds = [...new Set(
    carriedEntityIds.map((entityId) => persistentAssetByEntity.get(entityId)),
  )].sort(compareText);
  return { carriedEntityIds, carriedAssetIds };
}

function normalizeSemanticVisualSentencePlan(input) {
  exactKeys(input, [
    "schemaVersion",
    "profileId",
    "storyFormat",
    "narrativeShape",
    "bindings",
    "sentences",
    "persistentEntityBindings",
  ], "semanticVisualSentencePlan", ["contentHash"]);
  if (input.schemaVersion !== SEMANTIC_VISUAL_SENTENCE_PLAN_SCHEMA_VERSION) {
    fail("schemaVersion", "unsupported_schema");
  }
  if (input.profileId !== SEMANTIC_VISUAL_SENTENCE_PLAN_PROFILE_ID) {
    fail("profileId", "unsupported_profile");
  }
  const sentences = (Array.isArray(input.sentences)
    ? input.sentences
    : fail("sentences", "array_required"))
    .map(normalizeSentence)
    .sort((left, right) => (
      left.wordSpan.startWordIndex - right.wordSpan.startWordIndex
      || left.wordSpan.endWordIndex - right.wordSpan.endWordIndex
      || compareText(left.id, right.id)
    ));
  if (!sentences.length || sentences.length > 96) fail("sentences", "array_size_invalid");
  if (new Set(sentences.map((sentence) => sentence.id)).size !== sentences.length) {
    fail("sentences", "duplicate_ids");
  }
  if (new Set(sentences.map((sentence) => sentence.propositionId)).size !== sentences.length) {
    fail("sentences", "duplicate_proposition_ids");
  }

  const recentGrammarIds = [];
  const recentAssetIds = [];
  const persistentAssetByEntity = new Map();
  const persistentBindingByEntity = new Map();
  let nextWordIndex = sentences[0].wordSpan.startWordIndex;
  let previousEndFrame = sentences[0].wordSpan.startFrame;

  sentences.forEach((sentence, index) => {
    const field = `sentences[${index}]`;
    if (sentence.id !== `vs_${sentence.propositionId}`) {
      fail(`${field}.id`, "sentence_id_mismatch");
    }
    if (sentence.wordSpan.startWordIndex !== nextWordIndex) {
      fail(`${field}.wordSpan.startWordIndex`, "sentence_word_spans_not_contiguous");
    }
    if (sentence.wordSpan.startFrame < previousEndFrame) {
      fail(`${field}.wordSpan.startFrame`, "sentence_frames_overlap");
    }

    const continuity = expectedContinuity(sentence, persistentAssetByEntity);
    if (!same(sentence.continuity, continuity)) {
      fail(`${field}.continuity`, "continuity_history_mismatch");
    }
    const selected = selectVisualCapability({
      proposition: {
        predicate: sentence.visualIntent.predicate,
        subjectKind: sentence.visualIntent.subjectKind,
        stateTransition: sentence.visualIntent.stateTransition,
      },
      recentGrammarIds: recent(recentGrammarIds),
      recentAssetIds: recent(recentAssetIds),
      carriedAssetIds: continuity.carriedAssetIds,
      allowedPairs: SEMANTIC_SENTENCE_RENDERER_CAPABILITY_PAIRS,
    });
    const expectedCapability = {
      assetId: selected.assetId,
      grammarId: selected.grammarId,
      score: selected.score,
      semanticScore: selected.semanticScore,
      continuityScore: selected.continuityScore,
      noveltyScore: selected.noveltyScore,
    };
    if (!same(sentence.capability, expectedCapability)) {
      fail(`${field}.capability`, "deterministic_selection_mismatch");
    }

    if (sentence.focusEntity.persistent) {
      const priorAssetId = persistentAssetByEntity.get(sentence.focusEntity.id);
      if (priorAssetId && priorAssetId !== selected.assetId) {
        fail(
          `${field}.capability.assetId`,
          "persistent_entity_asset_conflict",
          "ANIMATION_SEMANTIC_VISUAL_SENTENCE_UNSUPPORTED",
        );
      }
      persistentAssetByEntity.set(sentence.focusEntity.id, selected.assetId);
      const binding = persistentBindingByEntity.get(sentence.focusEntity.id) || {
        entityId: sentence.focusEntity.id,
        visualSubjectKind: sentence.focusEntity.visualSubjectKind,
        assetId: selected.assetId,
        sentenceIds: [],
      };
      if (
        binding.visualSubjectKind !== sentence.focusEntity.visualSubjectKind
        || binding.assetId !== selected.assetId
      ) {
        fail(
          `${field}.focusEntity`,
          "persistent_entity_binding_conflict",
          "ANIMATION_SEMANTIC_VISUAL_SENTENCE_UNSUPPORTED",
        );
      }
      binding.sentenceIds.push(sentence.id);
      persistentBindingByEntity.set(sentence.focusEntity.id, binding);
    }

    recentGrammarIds.push(selected.grammarId);
    recentAssetIds.push(selected.assetId);
    nextWordIndex = sentence.wordSpan.endWordIndex;
    previousEndFrame = sentence.wordSpan.endFrame;
  });

  const persistentEntityBindings = (Array.isArray(input.persistentEntityBindings)
    ? input.persistentEntityBindings
    : fail("persistentEntityBindings", "array_required"))
    .map(normalizePersistentEntityBinding)
    .sort((left, right) => compareText(left.entityId, right.entityId));
  if (new Set(persistentEntityBindings.map((binding) => binding.entityId)).size
    !== persistentEntityBindings.length) {
    fail("persistentEntityBindings", "duplicate_entity_ids");
  }
  const expectedBindings = [...persistentBindingByEntity.values()]
    .sort((left, right) => compareText(left.entityId, right.entityId));
  if (!same(persistentEntityBindings, expectedBindings)) {
    fail("persistentEntityBindings", "persistent_bindings_mismatch");
  }

  const normalized = {
    schemaVersion: SEMANTIC_VISUAL_SENTENCE_PLAN_SCHEMA_VERSION,
    profileId: SEMANTIC_VISUAL_SENTENCE_PLAN_PROFILE_ID,
    storyFormat: identifier(input.storyFormat, "storyFormat"),
    narrativeShape: identifier(input.narrativeShape, "narrativeShape"),
    bindings: normalizeBindings(input.bindings),
    sentences,
    persistentEntityBindings,
  };
  const contentHash = semanticVisualSentencePlanContentHash(normalized);
  if (input.contentHash !== undefined) {
    hash(input.contentHash, "contentHash");
    if (input.contentHash !== contentHash) fail("contentHash", "content_hash_mismatch");
  }
  return deepFreeze({ ...normalized, contentHash });
}

function validateSemanticVisualSentencePlanAgainstGraph(input, semanticEventGraph) {
  const graph = normalizeSemanticEventGraph(semanticEventGraph);
  const plan = normalizeSemanticVisualSentencePlan(input);
  const graphDeclaresPrimitivePayloads =
    graph.primitivePayloadProfileId !== undefined;
  const payloadCount = graph.propositions.filter(
    (proposition) => proposition.primitivePayload !== undefined,
  ).length;
  if (
    (graphDeclaresPrimitivePayloads && payloadCount !== graph.propositions.length)
    || (!graphDeclaresPrimitivePayloads && payloadCount !== 0)
  ) {
    fail(
      "semanticEventGraph.primitivePayloadProfileId",
      "semantic_event_graph_binding_mismatch",
    );
  }
  const expectedBindings = {
    semanticEventGraphHash: graph.contentHash,
    draftHash: graph.draftHash,
    sourceStoryboardHash: graph.sourceStoryboardHash,
    timingContextHash: graph.timingContextHash,
  };
  if (!same(plan.bindings, expectedBindings)) fail("bindings", "semantic_event_graph_binding_mismatch");
  if (plan.storyFormat !== graph.storyFormat) fail("storyFormat", "semantic_event_graph_binding_mismatch");
  if (plan.narrativeShape !== graph.narrativeShape) {
    fail("narrativeShape", "semantic_event_graph_binding_mismatch");
  }
  if (plan.sentences.length !== graph.propositions.length) {
    fail("sentences", "semantic_event_graph_sentence_count_mismatch");
  }

  const entityById = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const continuityEntityIdsByBeat = new Map();
  for (const binding of graph.continuity) {
    for (const beatId of binding.beatIds) {
      const entityIds = continuityEntityIdsByBeat.get(beatId) || new Set();
      entityIds.add(binding.entityId);
      continuityEntityIdsByBeat.set(beatId, entityIds);
    }
  }

  plan.sentences.forEach((sentence, index) => {
    const field = `sentences[${index}]`;
    const proposition = graph.propositions[index];
    const focusEntity = entityById.get(proposition.visualIntent.focusEntityId);
    if (!focusEntity) fail(`${field}.visualIntent.focusEntityId`, "focus_entity_not_found");
    const expectedFocusEntity = {
      id: focusEntity.id,
      visualSubjectKind: focusEntity.visualSubjectKind,
      persistent: focusEntity.persistent,
    };
    const expectedPersistentEntityIds = [...new Set([
      ...proposition.visualAction.focusEntityIds.filter(
        (entityId) => entityById.get(entityId)?.persistent,
      ),
      ...(continuityEntityIdsByBeat.get(proposition.beatId) || []),
    ])].sort(compareText);
    const exactBindings = [
      ["id", `vs_${proposition.id}`],
      ["propositionId", proposition.id],
      ["beatId", proposition.beatId],
      ["claimIds", proposition.claimIds],
      ["wordSpan", proposition.wordSpan],
      ["sourceRefs", proposition.sourceRefs],
      ["visualIntent", proposition.visualIntent],
      ["participantEntityIds", proposition.visualAction.focusEntityIds],
      ["focusEntity", expectedFocusEntity],
      ["persistentEntityIds", expectedPersistentEntityIds],
    ];
    for (const [key, expected] of exactBindings) {
      if (!same(sentence[key], expected)) fail(`${field}.${key}`, "semantic_event_graph_binding_mismatch");
    }
    if (proposition.primitivePayload) {
      const expectedPrimitiveParameters = buildSemanticPrimitiveParameters({
        graphHash: graph.contentHash,
        proposition,
        capability: sentence.capability,
      });
      if (!same(sentence.primitiveParameters, expectedPrimitiveParameters)) {
        fail(
          `${field}.primitiveParameters`,
          "semantic_event_graph_binding_mismatch",
        );
      }
    } else if (sentence.primitiveParameters !== undefined) {
      fail(
        `${field}.primitiveParameters`,
        "semantic_event_graph_binding_mismatch",
      );
    }
    for (const entityId of sentence.participantEntityIds) {
      if (!entityById.has(entityId)) fail(`${field}.participantEntityIds`, "entity_not_found");
    }
  });

  for (const [index, binding] of plan.persistentEntityBindings.entries()) {
    const entity = entityById.get(binding.entityId);
    if (!entity || !entity.persistent) {
      fail(`persistentEntityBindings[${index}].entityId`, "persistent_entity_not_found");
    }
    if (binding.visualSubjectKind !== entity.visualSubjectKind) {
      fail(`persistentEntityBindings[${index}].visualSubjectKind`, "entity_subject_kind_mismatch");
    }
  }
  return plan;
}

function buildSemanticVisualSentencePlan(semanticEventGraph) {
  const graph = normalizeSemanticEventGraph(semanticEventGraph);
  const entityById = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const continuityEntityIdsByBeat = new Map();
  for (const [index, binding] of graph.continuity.entries()) {
    const entity = entityById.get(binding.entityId);
    if (!entity) fail(`semanticEventGraph.continuity[${index}].entityId`, "entity_not_found");
    if (!entity.persistent) {
      fail(`semanticEventGraph.continuity[${index}].entityId`, "continuity_entity_not_persistent");
    }
    for (const beatId of binding.beatIds) {
      const ids = continuityEntityIdsByBeat.get(beatId) || new Set();
      ids.add(entity.id);
      continuityEntityIdsByBeat.set(beatId, ids);
    }
  }
  const recentGrammarIds = [];
  const recentAssetIds = [];
  const persistentAssetByEntity = new Map();
  const persistentSentenceIdsByEntity = new Map();
  const sentences = graph.propositions.map((proposition, index) => {
    const field = `semanticEventGraph.propositions[${index}]`;
    const focusEntity = entityById.get(proposition.visualIntent.focusEntityId);
    if (!focusEntity) fail(`${field}.visualIntent.focusEntityId`, "focus_entity_not_found");
    if (focusEntity.visualSubjectKind !== proposition.visualIntent.subjectKind) {
      fail(`${field}.visualIntent.subjectKind`, "focus_entity_subject_kind_mismatch");
    }
    if (!proposition.visualAction.focusEntityIds.includes(focusEntity.id)) {
      fail(`${field}.visualIntent.focusEntityId`, "focus_entity_not_in_visual_action");
    }
    const persistentEntityIds = [...new Set([
      ...proposition.visualAction.focusEntityIds
        .filter((entityId) => {
          const entity = entityById.get(entityId);
          if (!entity) fail(`${field}.visualAction.focusEntityIds`, "focus_entity_not_found");
          return entity.persistent;
        }),
      ...(continuityEntityIdsByBeat.get(proposition.beatId) || []),
    ])].sort(compareText);
    const continuity = expectedContinuity(
      { persistentEntityIds },
      persistentAssetByEntity,
    );
    const visualCapabilityProposition = {
      predicate: proposition.visualIntent.predicate,
      subjectKind: proposition.visualIntent.subjectKind,
      stateTransition: proposition.visualIntent.stateTransition,
    };
    const selected = selectVisualCapability({
      proposition: visualCapabilityProposition,
      recentGrammarIds: recent(recentGrammarIds),
      recentAssetIds: recent(recentAssetIds),
      carriedAssetIds: continuity.carriedAssetIds,
      allowedPairs: SEMANTIC_SENTENCE_RENDERER_CAPABILITY_PAIRS,
    });
    if (focusEntity.persistent) {
      const priorAssetId = persistentAssetByEntity.get(focusEntity.id);
      if (priorAssetId && priorAssetId !== selected.assetId) {
        fail(
          `${field}.visualIntent`,
          "persistent_entity_asset_conflict",
          "ANIMATION_SEMANTIC_VISUAL_SENTENCE_UNSUPPORTED",
        );
      }
      persistentAssetByEntity.set(focusEntity.id, selected.assetId);
      const sentenceIds = persistentSentenceIdsByEntity.get(focusEntity.id) || [];
      sentenceIds.push(`vs_${proposition.id}`);
      persistentSentenceIdsByEntity.set(focusEntity.id, sentenceIds);
    }
    recentGrammarIds.push(selected.grammarId);
    recentAssetIds.push(selected.assetId);
    const capability = {
      assetId: selected.assetId,
      grammarId: selected.grammarId,
      score: selected.score,
      semanticScore: selected.semanticScore,
      continuityScore: selected.continuityScore,
      noveltyScore: selected.noveltyScore,
    };
    const sentence = {
      id: `vs_${proposition.id}`,
      propositionId: proposition.id,
      beatId: proposition.beatId,
      claimIds: structuredClone(proposition.claimIds),
      wordSpan: structuredClone(proposition.wordSpan),
      sourceRefs: structuredClone(proposition.sourceRefs),
      visualIntent: structuredClone(proposition.visualIntent),
      participantEntityIds: structuredClone(proposition.visualAction.focusEntityIds),
      focusEntity: {
        id: focusEntity.id,
        visualSubjectKind: focusEntity.visualSubjectKind,
        persistent: focusEntity.persistent,
      },
      persistentEntityIds,
      capability,
      continuity,
    };
    if (proposition.primitivePayload) {
      sentence.primitiveParameters = buildSemanticPrimitiveParameters({
        graphHash: graph.contentHash,
        proposition,
        capability,
      });
    }
    return sentence;
  });
  const persistentEntityBindings = [...persistentSentenceIdsByEntity.entries()]
    .map(([entityId, sentenceIds]) => ({
      entityId,
      visualSubjectKind: entityById.get(entityId).visualSubjectKind,
      assetId: persistentAssetByEntity.get(entityId),
      sentenceIds,
    }))
    .sort((left, right) => compareText(left.entityId, right.entityId));
  const plan = normalizeSemanticVisualSentencePlan({
    schemaVersion: SEMANTIC_VISUAL_SENTENCE_PLAN_SCHEMA_VERSION,
    profileId: SEMANTIC_VISUAL_SENTENCE_PLAN_PROFILE_ID,
    storyFormat: graph.storyFormat,
    narrativeShape: graph.narrativeShape,
    bindings: {
      semanticEventGraphHash: graph.contentHash,
      draftHash: graph.draftHash,
      sourceStoryboardHash: graph.sourceStoryboardHash,
      timingContextHash: graph.timingContextHash,
    },
    sentences,
    persistentEntityBindings,
  });
  return validateSemanticVisualSentencePlanAgainstGraph(plan, graph);
}

module.exports = {
  RECENT_VISUAL_HISTORY_LIMIT,
  SEMANTIC_VISUAL_SENTENCE_PLAN_PROFILE_ID,
  SEMANTIC_VISUAL_SENTENCE_PLAN_SCHEMA_VERSION,
  buildSemanticVisualSentencePlan,
  normalizeSemanticVisualSentencePlan,
  semanticVisualSentencePlanContentHash,
  validateSemanticVisualSentencePlanAgainstGraph,
};
