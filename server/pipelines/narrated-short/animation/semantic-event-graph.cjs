"use strict";

const { normalizeDraftBundle } = require("../contracts.cjs");
const { normalizeAnimationTimingContext } = require("./timing-contract.cjs");
const {
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
  failSemanticEventGraph,
  normalizeSemanticEventGraph,
} = require("./semantic-event-validator.cjs");

const SOURCE_FIELDS = Object.freeze({
  brief: new Set(["topic", "thesis"]),
  beat: new Set(["spokenText", "onScreenText"]),
  claim: new Set(["text"]),
  storyboard_scene: new Set(["template", "disclosure"]),
  storyboard_operation: new Set([
    "op",
    "text",
    "label",
    "date",
    "leftLabel",
    "rightLabel",
    "id",
    "fromId",
    "toId",
    "claimId",
    "sourceId",
    "leftValue",
    "rightValue",
    "scale",
    "layer",
    "mode",
  ]),
});

const CERTAINTY_RANK = Object.freeze({
  verified: 0,
  qualified: 1,
  disputed: 2,
});
const AUTHORING_ID_PATTERN = /^[a-z][a-z0-9_-]{2,79}$/;
const AUTHORING_CLAIM_ID_PATTERN = /^claim_[A-Za-z0-9-]{2,72}$/;
const AUTHORING_FIXTURE_PATTERN = /^eval\/narrated\/dark-curiosity\/fixtures\/[A-Za-z0-9_-]+\.json$/;

function fail(field, reason) {
  failSemanticEventGraph(field, reason);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function validateManifestShape(manifest) {
  if (!isPlainObject(manifest)) fail("manifest", "object_required");
  const required = ["narrativeShape", "entities", "propositions"];
  const allowed = new Set([...required, "storyFormat", "continuity", "epistemicConstraints"]);
  for (const key of Object.keys(manifest)) if (!allowed.has(key)) fail(`manifest.${key}`, "unsupported_field");
  for (const key of required) if (!Object.hasOwn(manifest, key)) fail(`manifest.${key}`, "field_required");
}

function exactAuthoringKeys(value, required, field, optional = []) {
  if (!isPlainObject(value)) fail(field, "object_required");
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field}.${key}`, "unsupported_field");
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${field}.${key}`, "field_required");
}

function authoringText(value, field, options = {}) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.length > (options.max || 240)
    || (options.pattern && !options.pattern.test(value))
  ) fail(field, "non_empty_safe_text_required");
  return value;
}

function authoringClaimIds(value, field, claimById) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    fail(field, "array_size_invalid");
  }
  const claimIds = value.map((claimId, index) => (
    authoringText(claimId, `${field}[${index}]`, {
      max: 80,
      pattern: AUTHORING_CLAIM_ID_PATTERN,
    })
  ));
  if (new Set(claimIds).size !== claimIds.length) fail(field, "duplicates_not_allowed");
  for (const claimId of claimIds) if (!claimById.has(claimId)) fail(field, "unknown_claim");
  return claimIds;
}

function authoringInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(field, "integer_out_of_range");
  }
  return value;
}

function exactSourceRef(sourceType, sourceId, operationIndex, field, source, startOffset, endOffset) {
  return {
    sourceType,
    sourceId,
    operationIndex,
    field,
    startOffset,
    endOffset,
    value: source.slice(startOffset, endOffset),
  };
}

function sourceCandidates(draft, claimIds = []) {
  const claims = new Set(claimIds);
  const candidates = [];
  const beatById = new Map(draft.script.beats.map((beat) => [beat.id, beat]));
  for (const claim of draft.claimLedger.claims) if (claims.has(claim.id)) {
    candidates.push({ sourceType: "claim", sourceId: claim.id, operationIndex: null, field: "text", source: claim.text });
  }
  for (const beat of draft.script.beats) if (beat.claimIds.some((claimId) => claims.has(claimId))) {
    candidates.push({ sourceType: "beat", sourceId: beat.id, operationIndex: null, field: "spokenText", source: beat.spokenText });
    candidates.push({ sourceType: "beat", sourceId: beat.id, operationIndex: null, field: "onScreenText", source: beat.onScreenText });
  }
  for (const scene of draft.storyboard.scenes) {
    const sceneSupportsClaim = scene.beatIds.some((beatId) => (
      beatById.get(beatId)?.claimIds.some((claimId) => claims.has(claimId))
    ));
    if (!sceneSupportsClaim) continue;
    if (scene.disclosure) {
      candidates.push({
        sourceType: "storyboard_scene",
        sourceId: scene.id,
        operationIndex: null,
        field: "disclosure",
        source: scene.disclosure,
      });
    }
    scene.operations.forEach((operation, operationIndex) => {
      for (const field of SOURCE_FIELDS.storyboard_operation) {
        if (typeof operation[field] === "string" || typeof operation[field] === "number") {
          candidates.push({
            sourceType: "storyboard_operation",
            sourceId: scene.id,
            operationIndex,
            field,
            source: String(operation[field]),
          });
        }
      }
    });
  }
  candidates.push({ sourceType: "brief", sourceId: "brief", operationIndex: null, field: "topic", source: draft.brief.topic });
  candidates.push({ sourceType: "brief", sourceId: "brief", operationIndex: null, field: "thesis", source: draft.brief.thesis });
  return candidates;
}

function groundedLabelRef(entity, draft, field) {
  const candidates = sourceCandidates(draft, entity.claimIds);
  for (const candidate of candidates) {
    const startOffset = candidate.source
      .toLocaleLowerCase("en-US")
      .indexOf(entity.label.toLocaleLowerCase("en-US"));
    if (startOffset >= 0) {
      return exactSourceRef(
        candidate.sourceType,
        candidate.sourceId,
        candidate.operationIndex,
        candidate.field,
        candidate.source,
        startOffset,
        startOffset + entity.label.length,
      );
    }
  }
  fail(`${field}.label`, "entity_label_has_no_exact_approved_source_value");
}

function cueSourceRef(beat, cue, timingBeat, field) {
  const localStartIndex = cue.wordStartIndex - timingBeat.wordStartIndex;
  const localEndIndex = cue.wordEndIndexExclusive - timingBeat.wordStartIndex;
  const beatWords = beat.spokenText.split(" ");
  if (
    localStartIndex < 0
    || localEndIndex > beatWords.length
    || localEndIndex <= localStartIndex
  ) fail(`${field}.cue`, "cue_word_span_outside_beat");
  const startOffset = localStartIndex === 0
    ? 0
    : beatWords.slice(0, localStartIndex).join(" ").length + 1;
  const endOffset = beatWords.slice(0, localEndIndex).join(" ").length;
  if (beat.spokenText.slice(startOffset, endOffset) !== cue.text) {
    fail(`${field}.cue.text`, "cue_not_found_verbatim_at_word_span");
  }
  return exactSourceRef(
    "beat",
    beat.id,
    null,
    "spokenText",
    beat.spokenText,
    startOffset,
    endOffset,
  );
}

function semanticFacts(value) {
  if (value === undefined) return [];
  if (!isPlainObject(value)) fail("manifest.state", "object_required");
  return Object.keys(value).sort().map((attribute) => ({ attribute, value: value[attribute] }));
}

function cueFragmentRef(surface, cue, cueRef, field) {
  const localOffset = cue.text
    .toLocaleLowerCase("en-US")
    .indexOf(surface.toLocaleLowerCase("en-US"));
  if (localOffset < 0) fail(field, "quantity_not_found_in_exact_cue");
  return {
    ...cueRef,
    startOffset: cueRef.startOffset + localOffset,
    endOffset: cueRef.startOffset + localOffset + surface.length,
    value: cue.text.slice(localOffset, localOffset + surface.length),
  };
}

function quantitiesFromAuthoring(input, cue, cueRef, field) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 8) fail(field, "array_size_invalid");
  return input.map((quantity, index) => {
    const quantityField = `${field}[${index}]`;
    exactAuthoringKeys(quantity, ["value", "unit"], quantityField);
    const value = authoringText(quantity.value, `${quantityField}.value`, { max: 80 });
    const unit = quantity.unit === null
      ? null
      : authoringText(quantity.unit, `${quantityField}.unit`, { max: 80 });
    const valueSourceRef = cueFragmentRef(value, cue, cueRef, `${quantityField}.value`);
    const unitSourceRef = unit === null
      ? null
      : cueFragmentRef(unit, cue, cueRef, `${quantityField}.unit`);
    return {
      value: valueSourceRef.value,
      unit: unitSourceRef?.value || null,
      valueSourceRef,
      unitSourceRef,
    };
  });
}

function sourceText(ref, context, field) {
  const allowed = SOURCE_FIELDS[ref.sourceType];
  if (!allowed || !allowed.has(ref.field)) fail(`${field}.field`, "source_field_not_allowed");
  if (ref.sourceType === "brief") {
    if (ref.sourceId !== "brief" || ref.operationIndex !== null) fail(field, "brief_source_binding_invalid");
    return context.draft.brief[ref.field];
  }
  if (ref.sourceType === "beat") {
    if (ref.operationIndex !== null) fail(field, "beat_source_binding_invalid");
    const beat = context.beatById.get(ref.sourceId);
    if (!beat) fail(`${field}.sourceId`, "source_beat_not_found");
    return beat[ref.field];
  }
  if (ref.sourceType === "claim") {
    if (ref.operationIndex !== null) fail(field, "claim_source_binding_invalid");
    const claim = context.claimById.get(ref.sourceId);
    if (!claim) fail(`${field}.sourceId`, "source_claim_not_found");
    return claim[ref.field];
  }
  const scene = context.sceneById.get(ref.sourceId);
  if (!scene) fail(`${field}.sourceId`, "source_scene_not_found");
  if (ref.sourceType === "storyboard_scene") {
    if (ref.operationIndex !== null) fail(field, "scene_source_binding_invalid");
    return scene[ref.field];
  }
  const operation = scene.operations[ref.operationIndex];
  if (!operation) fail(`${field}.operationIndex`, "source_operation_not_found");
  return operation[ref.field];
}

function validateSourceRef(ref, context, field) {
  const raw = sourceText(ref, context, field);
  if ((typeof raw !== "string" && typeof raw !== "number") || raw === "") {
    fail(field, "source_value_unavailable");
  }
  const source = String(raw);
  if (ref.endOffset > source.length || source.slice(ref.startOffset, ref.endOffset) !== ref.value) {
    fail(field, "source_value_mismatch");
  }
  return ref;
}

function validateSourceRefs(refs, context, field) {
  refs.forEach((ref, index) => validateSourceRef(ref, context, `${field}[${index}]`));
}

function sourceRefsEqual(left, right) {
  return (
    left.sourceType === right.sourceType
    && left.sourceId === right.sourceId
    && left.operationIndex === right.operationIndex
    && left.field === right.field
    && left.startOffset === right.startOffset
    && left.endOffset === right.endOffset
    && left.value === right.value
  );
}

function expectedCertainty(claimIds, claimById, field = "claimIds") {
  const groundedClaimIds = authoringClaimIds(claimIds, field, claimById);
  return groundedClaimIds.reduce((current, claimId) => {
    const verdict = claimById.get(claimId).verdict;
    return CERTAINTY_RANK[verdict] > CERTAINTY_RANK[current] ? verdict : current;
  }, "verified");
}

function compileGoldenSemanticEventManifest(input = {}) {
  let draft;
  let timingContext;
  try {
    draft = normalizeDraftBundle(input.draft);
    timingContext = normalizeAnimationTimingContext(input.timingContext);
  } catch (error) {
    if (error?.code === "ANIMATION_SEMANTIC_EVENT_INVALID") throw error;
    fail("context", "normalized_draft_and_timing_required");
  }
  const manifest = input.manifest;
  exactAuthoringKeys(manifest, [
    "schemaVersion",
    "artifactType",
    "id",
    "verticalId",
    "narrativeShape",
    "language",
    "sourceBindings",
    "entities",
    "beats",
    "continuity",
    "epistemicConstraints",
  ], "manifest");
  if (manifest.schemaVersion !== 3 || manifest.artifactType !== "semantic_event_graph") {
    fail("manifest.schemaVersion", "unsupported_authoring_schema");
  }
  authoringText(manifest.id, "manifest.id", { max: 80, pattern: AUTHORING_ID_PATTERN });
  if (manifest.verticalId !== "dark_curiosity" || manifest.language !== draft.brief.language) {
    fail("manifest.verticalId", "authoring_vertical_or_language_mismatch");
  }
  if (!NARRATIVE_SHAPES.includes(manifest.narrativeShape)) {
    fail("manifest.narrativeShape", "unsupported_narrative_shape");
  }
  exactAuthoringKeys(manifest.sourceBindings, [
    "fixturePath",
    "approvedDraftHash",
    "alignmentHash",
    "fps",
    "durationFrames",
    "wordCount",
  ], "manifest.sourceBindings");
  authoringText(manifest.sourceBindings.fixturePath, "manifest.sourceBindings.fixturePath", {
    max: 240,
    pattern: AUTHORING_FIXTURE_PATTERN,
  });
  if (
    manifest.sourceBindings.approvedDraftHash !== draft.contentHash
    || manifest.sourceBindings.alignmentHash !== timingContext.alignmentHash
    || manifest.sourceBindings.fps !== timingContext.fps
    || manifest.sourceBindings.durationFrames !== timingContext.durationFrames
    || manifest.sourceBindings.wordCount !== timingContext.words.length
  ) fail("manifest.sourceBindings", "authoring_source_binding_mismatch");

  const claimById = new Map(draft.claimLedger.claims.map((claim) => [claim.id, claim]));
  const beatById = new Map(draft.script.beats.map((beat) => [beat.id, beat]));
  const timingByBeatId = new Map(timingContext.beats.map((beat) => [beat.beatId, beat]));
  if (!Array.isArray(manifest.entities) || !manifest.entities.length || manifest.entities.length > 64) {
    fail("manifest.entities", "array_size_invalid");
  }
  const entities = manifest.entities.map((entity, index) => {
    const field = `manifest.entities[${index}]`;
    exactAuthoringKeys(entity, [
      "id",
      "kind",
      "visualSubjectKind",
      "label",
      "persistent",
      "claimIds",
    ], field);
    if (typeof entity.persistent !== "boolean") {
      fail(field, "unsupported_entity_definition");
    }
    const normalizedEntity = {
      ...entity,
      id: authoringText(entity.id, `${field}.id`, { max: 80, pattern: AUTHORING_ID_PATTERN }),
      kind: authoringText(entity.kind, `${field}.kind`, {
        max: 80,
        pattern: AUTHORING_ID_PATTERN,
      }),
      label: authoringText(entity.label, `${field}.label`, { max: 120 }),
      claimIds: authoringClaimIds(entity.claimIds, `${field}.claimIds`, claimById),
    };
    const labelRef = groundedLabelRef(normalizedEntity, draft, field);
    return {
      id: normalizedEntity.id,
      kind: normalizedEntity.kind,
      visualSubjectKind: normalizedEntity.visualSubjectKind,
      label: labelRef.value,
      persistent: normalizedEntity.persistent,
      claimIds: normalizedEntity.claimIds,
      sourceRefs: [labelRef],
    };
  });
  if (!Array.isArray(manifest.beats) || !manifest.beats.length || manifest.beats.length > 40) {
    fail("manifest.beats", "array_size_invalid");
  }
  const propositions = [];
  for (const [beatIndex, authorBeat] of manifest.beats.entries()) {
    const beatField = `manifest.beats[${beatIndex}]`;
    exactAuthoringKeys(authorBeat, ["beatId", "role", "wordSpan", "frameSpan", "propositions"], beatField);
    const beat = beatById.get(authorBeat.beatId);
    const timingBeat = timingByBeatId.get(authorBeat.beatId);
    if (!beat || !timingBeat || authorBeat.role !== beat.role) fail(`${beatField}.beatId`, "authoring_beat_mismatch");
    exactAuthoringKeys(authorBeat.wordSpan, ["startIndex", "endIndexExclusive"], `${beatField}.wordSpan`);
    exactAuthoringKeys(authorBeat.frameSpan, ["startFrame", "endFrame"], `${beatField}.frameSpan`);
    if (
      authorBeat.wordSpan.startIndex !== timingBeat.wordStartIndex
      || authorBeat.wordSpan.endIndexExclusive !== timingBeat.wordEndIndex
      || authorBeat.frameSpan.startFrame !== timingBeat.startFrame
      || authorBeat.frameSpan.endFrame !== timingBeat.endFrame
    ) fail(beatField, "authoring_beat_timing_mismatch");
    if (
      !Array.isArray(authorBeat.propositions)
      || !authorBeat.propositions.length
      || authorBeat.propositions.length > 24
    ) {
      fail(`${beatField}.propositions`, "array_size_invalid");
    }
    for (const [propositionIndex, author] of authorBeat.propositions.entries()) {
      const field = `${beatField}.propositions[${propositionIndex}]`;
      exactAuthoringKeys(author, [
        "id",
        "kind",
        "subjectEntityId",
        "predicate",
        "objectEntityIds",
        "polarity",
        "epistemicStatus",
        "claimIds",
        "cue",
        "visualIntent",
        "visualAction",
      ], field, ["stateBefore", "stateAfter", "attributes", "quantities"]);
      if (
        !EVENT_KINDS.includes(author.kind)
        || !POLARITIES.includes(author.polarity)
        || !EPISTEMIC_STATUSES.includes(author.epistemicStatus)
      ) fail(field, "unsupported_authoring_semantics");
      authoringText(author.id, `${field}.id`, { max: 80, pattern: AUTHORING_ID_PATTERN });
      authoringText(author.predicate, `${field}.predicate`, {
        max: 80,
        pattern: AUTHORING_ID_PATTERN,
      });
      authoringText(author.subjectEntityId, `${field}.subjectEntityId`, {
        max: 80,
        pattern: AUTHORING_ID_PATTERN,
      });
      const claimIds = authoringClaimIds(author.claimIds, `${field}.claimIds`, claimById);
      exactAuthoringKeys(author.cue, [
        "wordStartIndex",
        "wordEndIndexExclusive",
        "startFrame",
        "endFrame",
        "text",
      ], `${field}.cue`);
      authoringText(author.cue.text, `${field}.cue.text`, { max: 400 });
      authoringInteger(
        author.cue.wordStartIndex,
        `${field}.cue.wordStartIndex`,
        timingBeat.wordStartIndex,
        timingBeat.wordEndIndex - 1,
      );
      authoringInteger(
        author.cue.wordEndIndexExclusive,
        `${field}.cue.wordEndIndexExclusive`,
        author.cue.wordStartIndex + 1,
        timingBeat.wordEndIndex,
      );
      authoringInteger(
        author.cue.startFrame,
        `${field}.cue.startFrame`,
        timingBeat.startFrame,
        timingBeat.endFrame - 1,
      );
      authoringInteger(
        author.cue.endFrame,
        `${field}.cue.endFrame`,
        author.cue.startFrame + 1,
        timingBeat.endFrame,
      );
      exactAuthoringKeys(author.visualAction, ["operation", "focusEntityIds"], `${field}.visualAction`);
      authoringText(author.visualAction.operation, `${field}.visualAction.operation`, {
        max: 80,
        pattern: AUTHORING_ID_PATTERN,
      });
      const cueRef = cueSourceRef(beat, author.cue, timingBeat, field);
      propositions.push({
        id: author.id,
        beatId: beat.id,
        claimIds,
        wordSpan: {
          startWordIndex: author.cue.wordStartIndex,
          endWordIndex: author.cue.wordEndIndexExclusive,
          startFrame: author.cue.startFrame,
          endFrame: author.cue.endFrame,
          text: author.cue.text,
        },
        eventKind: author.kind,
        predicate: author.predicate,
        polarity: author.polarity,
        epistemicStatus: author.epistemicStatus,
        subject: { entityId: author.subjectEntityId },
        object: { entityIds: author.objectEntityIds, value: null, sourceRef: null },
        state: {
          before: semanticFacts(author.stateBefore),
          after: semanticFacts(author.stateAfter),
        },
        attributes: semanticFacts(author.attributes),
        quantities: quantitiesFromAuthoring(
          author.quantities,
          author.cue,
          cueRef,
          `${field}.quantities`,
        ),
        certainty: expectedCertainty(claimIds, claimById, `${field}.claimIds`),
        visualIntent: author.visualIntent,
        visualAction: {
          operation: author.visualAction.operation,
          focusEntityIds: author.visualAction.focusEntityIds,
        },
        sourceRefs: [cueRef],
      });
    }
  }

  return {
    storyFormat: draft.brief.formatId,
    narrativeShape: manifest.narrativeShape,
    entities,
    propositions,
    continuity: manifest.continuity,
    epistemicConstraints: manifest.epistemicConstraints,
  };
}

function validateBindings(graph, draft, timingContext) {
  if (draft.verticalId !== "dark_curiosity") fail("draft.verticalId", "dark_curiosity_required");
  if (graph.storyFormat !== draft.brief.formatId) fail("storyFormat", "draft_format_binding_mismatch");
  if (graph.draftHash !== draft.contentHash) fail("draftHash", "draft_binding_mismatch");
  if (graph.sourceStoryboardHash !== draft.storyboard.contentHash) {
    fail("sourceStoryboardHash", "storyboard_binding_mismatch");
  }
  if (timingContext.draftHash !== draft.contentHash) fail("timingContext.draftHash", "draft_binding_mismatch");
  if (graph.timingContextHash !== timingContext.contentHash) {
    fail("timingContextHash", "timing_binding_mismatch");
  }
}

function validateSemanticEventGraphAgainstDraft(input, context = {}) {
  let draft;
  let timingContext;
  try {
    draft = normalizeDraftBundle(context.draft);
    timingContext = normalizeAnimationTimingContext(context.timingContext);
  } catch (error) {
    if (error?.code === "ANIMATION_SEMANTIC_EVENT_INVALID") throw error;
    fail("context", "normalized_draft_and_timing_required");
  }
  const graph = normalizeSemanticEventGraph(input);
  validateBindings(graph, draft, timingContext);

  const beatById = new Map(draft.script.beats.map((beat) => [beat.id, beat]));
  const timingByBeatId = new Map(timingContext.beats.map((beat) => [beat.beatId, beat]));
  const claimById = new Map(draft.claimLedger.claims.map((claim) => [claim.id, claim]));
  const sceneById = new Map(draft.storyboard.scenes.map((scene) => [scene.id, scene]));
  if (beatById.size !== timingByBeatId.size) fail("timingContext.beats", "beat_count_mismatch");
  for (const beatId of beatById.keys()) if (!timingByBeatId.has(beatId)) {
    fail("timingContext.beats", "beat_binding_missing");
  }
  const sourceContext = { draft, beatById, claimById, sceneById };

  const entityById = new Map();
  for (const [index, entity] of graph.entities.entries()) {
    const field = `entities[${index}]`;
    for (const claimId of entity.claimIds) if (!claimById.has(claimId)) {
      fail(`${field}.claimIds`, "unknown_claim");
    }
    validateSourceRefs(entity.sourceRefs, sourceContext, `${field}.sourceRefs`);
    if (!entity.sourceRefs.some((ref) => ref.value === entity.label)) {
      fail(`${field}.label`, "entity_label_not_an_exact_source_value");
    }
    entityById.set(entity.id, entity);
  }

  const propositionIdsByBeat = new Map();
  const coveredClaimsByBeat = new Map();
  const wordSpansByBeat = new Map();
  const referencedEntitiesByBeat = new Map();
  const referencedEntityIds = new Set();
  for (const [index, proposition] of graph.propositions.entries()) {
    const field = `propositions[${index}]`;
    const beat = beatById.get(proposition.beatId);
    const timingBeat = timingByBeatId.get(proposition.beatId);
    if (!beat || !timingBeat) fail(`${field}.beatId`, "unknown_beat");
    const beatClaimIds = new Set(beat.claimIds);
    for (const claimId of proposition.claimIds) {
      if (!claimById.has(claimId) || !beatClaimIds.has(claimId)) {
        fail(`${field}.claimIds`, "claim_not_grounded_to_beat");
      }
    }
    if (
      proposition.wordSpan.startWordIndex < timingBeat.wordStartIndex
      || proposition.wordSpan.endWordIndex > timingBeat.wordEndIndex
    ) fail(`${field}.wordSpan`, "word_span_outside_beat");
    const exactWords = timingContext.words
      .slice(proposition.wordSpan.startWordIndex, proposition.wordSpan.endWordIndex)
      .map((word) => word.text)
      .join(" ");
    if (proposition.wordSpan.text !== exactWords) fail(`${field}.wordSpan.text`, "word_span_text_mismatch");
    const firstWord = timingContext.words[proposition.wordSpan.startWordIndex];
    const lastWord = timingContext.words[proposition.wordSpan.endWordIndex - 1];
    if (
      proposition.wordSpan.startFrame !== firstWord.startFrame
      || proposition.wordSpan.endFrame !== lastWord.endFrame
    ) fail(`${field}.wordSpan`, "word_span_frame_mismatch");

    const subject = entityById.get(proposition.subject.entityId);
    if (!subject) fail(`${field}.subject.entityId`, "subject_not_found");
    if (!proposition.claimIds.some((claimId) => subject.claimIds.includes(claimId))) {
      fail(`${field}.subject.entityId`, "subject_not_grounded_to_proposition_claim");
    }
    referencedEntityIds.add(subject.id);

    for (const objectEntityId of proposition.object.entityIds) {
      const objectEntity = entityById.get(objectEntityId);
      if (!objectEntity) fail(`${field}.object.entityId`, "object_not_found");
      referencedEntityIds.add(objectEntity.id);
    }
    for (const focusEntityId of proposition.visualAction.focusEntityIds) {
      if (!entityById.has(focusEntityId)) fail(`${field}.visualAction.focusEntityIds`, "focus_entity_not_found");
      referencedEntityIds.add(focusEntityId);
    }
    const intentEntity = entityById.get(proposition.visualIntent.focusEntityId);
    if (!intentEntity) fail(`${field}.visualIntent.focusEntityId`, "focus_entity_not_found");
    if (intentEntity.visualSubjectKind !== proposition.visualIntent.subjectKind) {
      fail(`${field}.visualIntent.subjectKind`, "focus_entity_subject_kind_mismatch");
    }
    if (
      intentEntity.id !== subject.id
      && !proposition.object.entityIds.includes(intentEntity.id)
    ) fail(`${field}.visualIntent.focusEntityId`, "focus_entity_not_a_semantic_participant");
    if (!proposition.visualAction.focusEntityIds.includes(intentEntity.id)) {
      fail(`${field}.visualIntent.focusEntityId`, "focus_entity_not_in_visual_action");
    }
    referencedEntityIds.add(intentEntity.id);
    if (proposition.object.sourceRef) {
      validateSourceRef(proposition.object.sourceRef, sourceContext, `${field}.object.sourceRef`);
    }
    proposition.quantities.forEach((quantity, quantityIndex) => {
      validateSourceRef(
        quantity.valueSourceRef,
        sourceContext,
        `${field}.quantities[${quantityIndex}].valueSourceRef`,
      );
      if (quantity.unitSourceRef) {
        validateSourceRef(
          quantity.unitSourceRef,
          sourceContext,
          `${field}.quantities[${quantityIndex}].unitSourceRef`,
        );
      }
    });
    validateSourceRefs(proposition.sourceRefs, sourceContext, `${field}.sourceRefs`);
    const expectedCueRef = cueSourceRef(beat, {
      wordStartIndex: proposition.wordSpan.startWordIndex,
      wordEndIndexExclusive: proposition.wordSpan.endWordIndex,
      text: proposition.wordSpan.text,
    }, timingBeat, field);
    if (!proposition.sourceRefs.some((ref) => sourceRefsEqual(ref, expectedCueRef))) {
      fail(`${field}.sourceRefs`, "exact_narration_cue_source_required");
    }
    const certainty = expectedCertainty(proposition.claimIds, claimById);
    if (proposition.certainty !== certainty) fail(`${field}.certainty`, "claim_verdict_mismatch");

    const wordSpans = wordSpansByBeat.get(proposition.beatId) || [];
    wordSpans.push({
      id: proposition.id,
      startWordIndex: proposition.wordSpan.startWordIndex,
      endWordIndex: proposition.wordSpan.endWordIndex,
    });
    wordSpansByBeat.set(proposition.beatId, wordSpans);
    const beatEntities = referencedEntitiesByBeat.get(proposition.beatId) || new Set();
    beatEntities.add(subject.id);
    proposition.object.entityIds.forEach((entityId) => beatEntities.add(entityId));
    proposition.visualAction.focusEntityIds.forEach((entityId) => beatEntities.add(entityId));
    beatEntities.add(intentEntity.id);
    referencedEntitiesByBeat.set(proposition.beatId, beatEntities);

    const beatPropositions = propositionIdsByBeat.get(proposition.beatId) || [];
    beatPropositions.push(proposition.id);
    propositionIdsByBeat.set(proposition.beatId, beatPropositions);
    const covered = coveredClaimsByBeat.get(proposition.beatId) || new Set();
    proposition.claimIds.forEach((claimId) => covered.add(claimId));
    coveredClaimsByBeat.set(proposition.beatId, covered);
  }

  for (const beat of draft.script.beats) {
    if (!propositionIdsByBeat.has(beat.id)) fail(`propositions.${beat.id}`, "beat_not_covered");
    const covered = coveredClaimsByBeat.get(beat.id);
    for (const claimId of beat.claimIds) if (!covered.has(claimId)) {
      fail(`propositions.${beat.id}.claimIds`, "beat_claim_not_covered");
    }
    const timingBeat = timingByBeatId.get(beat.id);
    const spans = [...(wordSpansByBeat.get(beat.id) || [])].sort((left, right) => (
      left.startWordIndex - right.startWordIndex
      || left.endWordIndex - right.endWordIndex
      || compareText(left.id, right.id)
    ));
    let nextWordIndex = timingBeat.wordStartIndex;
    for (const span of spans) {
      if (span.startWordIndex !== nextWordIndex) {
        fail(`propositions.${beat.id}.wordSpan`, "word_spans_must_partition_beat");
      }
      nextWordIndex = span.endWordIndex;
    }
    if (nextWordIndex !== timingBeat.wordEndIndex) {
      fail(`propositions.${beat.id}.wordSpan`, "word_spans_must_partition_beat");
    }
  }
  for (const entity of graph.entities) if (!referencedEntityIds.has(entity.id)) {
    fail(`entities.${entity.id}`, "unreferenced_entity");
  }
  const continuityEntityIds = new Set();
  for (const [index, continuity] of graph.continuity.entries()) {
    if (!entityById.has(continuity.entityId)) fail(`continuity[${index}].entityId`, "entity_not_found");
    if (continuityEntityIds.has(continuity.entityId)) {
      fail(`continuity[${index}].entityId`, "duplicate_continuity_entity");
    }
    continuityEntityIds.add(continuity.entityId);
    for (const beatId of continuity.beatIds) if (!beatById.has(beatId)) {
      fail(`continuity[${index}].beatIds`, "beat_not_found");
    } else if (!referencedEntitiesByBeat.get(beatId)?.has(continuity.entityId)) {
      fail(`continuity[${index}].beatIds`, "entity_not_referenced_in_beat");
    }
  }
  for (const [index, constraint] of graph.epistemicConstraints.entries()) {
    for (const claimId of constraint.claimIds) if (!claimById.has(claimId)) {
      fail(`epistemicConstraints[${index}].claimIds`, "unknown_claim");
    }
  }

  return graph;
}

function buildSemanticEventGraph(input = {}) {
  let draft;
  let timingContext;
  try {
    draft = normalizeDraftBundle(input.draft);
    timingContext = normalizeAnimationTimingContext(input.timingContext);
  } catch (error) {
    if (error?.code === "ANIMATION_SEMANTIC_EVENT_INVALID") throw error;
    fail("context", "normalized_draft_and_timing_required");
  }
  const manifest = input.manifest?.artifactType === "semantic_event_graph"
    ? compileGoldenSemanticEventManifest({ draft, timingContext, manifest: input.manifest })
    : input.manifest;
  validateManifestShape(manifest);
  const graph = normalizeSemanticEventGraph({
    schemaVersion: SEMANTIC_EVENT_GRAPH_SCHEMA_VERSION,
    profileId: SEMANTIC_EVENT_GRAPH_PROFILE_ID,
    storyFormat: manifest.storyFormat || draft.brief.formatId,
    narrativeShape: manifest.narrativeShape,
    draftHash: draft.contentHash,
    sourceStoryboardHash: draft.storyboard.contentHash,
    timingContextHash: timingContext.contentHash,
    entities: manifest.entities,
    propositions: manifest.propositions,
    continuity: manifest.continuity || [],
    epistemicConstraints: manifest.epistemicConstraints || [],
  });
  return validateSemanticEventGraphAgainstDraft(graph, { draft, timingContext });
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
  buildSemanticEventGraph,
  compileGoldenSemanticEventManifest,
  normalizeSemanticEventGraph,
  validateSemanticEventGraphAgainstDraft,
};
