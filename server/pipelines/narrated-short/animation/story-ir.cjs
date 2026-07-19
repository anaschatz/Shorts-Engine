"use strict";

const { createHash } = require("node:crypto");

const { AppError } = require("../../../errors.cjs");
const { normalizeDraftBundle } = require("../contracts.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  buildSemanticVisualPlan,
  SCENE_ROLES,
} = require("./semantic-visual-planner.cjs");
const {
  normalizeAnimationTimingContext,
} = require("./timing-contract.cjs");

const STORY_IR_SCHEMA_VERSION = 1;
const STORY_IR_PROFILE_ID = "dark_curiosity_grounded_story_ir_v1";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z][a-z0-9_-]{2,119}$/;
const CLAIM_ID_PATTERN = /^claim_[A-Za-z0-9-]{2,72}$/;
const VERDICTS = Object.freeze(["verified", "qualified", "disputed"]);
const MAX_SEGMENTS_PER_BEAT = 4;
const MAX_SEGMENT_CHARACTERS = 120;
const MAX_SEGMENT_LINES = 6;
const MAX_SEGMENT_LINE_CHARACTERS = 30;
const NARRATIVE_SHAPE_BY_VOCABULARY = Object.freeze({
  radio_signal: "investigation_trail_v1",
  temporal_anomaly: "mechanism_reveal_v1",
  maritime_route: "object_journey_v1",
  general_mystery: "evidence_conflict_v1",
});

function fail(field, reason = "invalid") {
  throw new AppError(
    "ANIMATION_STORY_IR_INVALID",
    "The grounded story representation is invalid or is not bound to the approved narration.",
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
  for (const key of Object.keys(value)) if (!allowed.has(key)) {
    fail(`${field}.${key}`, "unsupported_field");
  }
  for (const key of required) if (!Object.hasOwn(value, key)) {
    fail(`${field}.${key}`, "field_required");
  }
}

function text(value, field, options = {}) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.length > (options.max || 320)
    || (options.pattern && !options.pattern.test(value))
  ) fail(field, "non_empty_safe_text_required");
  return value;
}

function nullableText(value, field, options = {}) {
  return value === null ? null : text(value, field, options);
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(field, "integer_out_of_range");
  }
  return value;
}

function stringList(value, field, options = {}) {
  if (
    !Array.isArray(value)
    || value.length < (options.minimum || 0)
    || value.length > (options.maximum || 24)
  ) fail(field, "array_size_invalid");
  const normalized = value.map((entry, index) => text(entry, `${field}[${index}]`, {
    max: options.max || 80,
    pattern: options.pattern,
  }));
  if (new Set(normalized).size !== normalized.length) fail(field, "duplicates_not_allowed");
  return normalized;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function contentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function normalizeBindings(input) {
  exactKeys(input, [
    "draftHash",
    "sourceStoryboardHash",
    "timingContextHash",
    "alignmentHash",
  ], "storyIR.bindings");
  const hash = (value, field) => text(value, field, { max: 64, pattern: HASH_PATTERN });
  return {
    draftHash: hash(input.draftHash, "storyIR.bindings.draftHash"),
    sourceStoryboardHash: hash(
      input.sourceStoryboardHash,
      "storyIR.bindings.sourceStoryboardHash",
    ),
    timingContextHash: hash(
      input.timingContextHash,
      "storyIR.bindings.timingContextHash",
    ),
    alignmentHash: hash(input.alignmentHash, "storyIR.bindings.alignmentHash"),
  };
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
    endWordIndex: integer(
      input.endWordIndex,
      `${field}.endWordIndex`,
      startWordIndex + 1,
      400,
    ),
    startFrame,
    endFrame: integer(input.endFrame, `${field}.endFrame`, startFrame + 1, 5400),
    text: text(input.text, `${field}.text`, { max: 400 }),
  };
}

function normalizeSource(input, field) {
  exactKeys(input, [
    "sceneId",
    "template",
    "archetypeId",
    "entityKind",
    "operationKinds",
    "heading",
    "primaryLabel",
    "secondaryLabel",
    "onScreenText",
  ], field);
  return {
    sceneId: text(input.sceneId, `${field}.sceneId`, { max: 80, pattern: ID_PATTERN }),
    template: text(input.template, `${field}.template`, { max: 80, pattern: ID_PATTERN }),
    archetypeId: text(input.archetypeId, `${field}.archetypeId`, {
      max: 80,
      pattern: ID_PATTERN,
    }),
    entityKind: text(input.entityKind, `${field}.entityKind`, {
      max: 80,
      pattern: ID_PATTERN,
    }),
    operationKinds: stringList(input.operationKinds, `${field}.operationKinds`, {
      minimum: 1,
      maximum: 12,
      pattern: ID_PATTERN,
    }),
    heading: text(input.heading, `${field}.heading`, { max: 160 }),
    primaryLabel: text(input.primaryLabel, `${field}.primaryLabel`, { max: 160 }),
    secondaryLabel: nullableText(input.secondaryLabel, `${field}.secondaryLabel`, {
      max: 160,
    }),
    onScreenText: text(input.onScreenText, `${field}.onScreenText`, { max: 96 }),
  };
}

function normalizeBeat(input, index) {
  const field = `storyIR.beats[${index}]`;
  exactKeys(input, [
    "id",
    "beatId",
    "role",
    "claimIds",
    "certainty",
    "wordSpan",
    "segments",
    "source",
  ], field);
  const role = text(input.role, `${field}.role`, { max: 20, pattern: ID_PATTERN });
  if (role !== SCENE_ROLES[index]) fail(`${field}.role`, "role_order_invalid");
  const wordSpan = normalizeWordSpan(input.wordSpan, `${field}.wordSpan`);
  const segments = Array.isArray(input.segments)
    ? input.segments.map((segment, segmentIndex) => normalizeWordSpan(
      segment,
      `${field}.segments[${segmentIndex}]`,
    ))
    : fail(`${field}.segments`, "array_required");
  if (!segments.length || segments.length > MAX_SEGMENTS_PER_BEAT) {
    fail(`${field}.segments`, "array_size_invalid");
  }
  let expectedWordIndex = wordSpan.startWordIndex;
  let previousFrameEnd = wordSpan.startFrame;
  for (const [segmentIndex, segment] of segments.entries()) {
    if (
      segment.startWordIndex !== expectedWordIndex
      || segment.startFrame < previousFrameEnd
      || segment.text.length > MAX_SEGMENT_CHARACTERS
      || wrappedLineCount(segment.text.split(/\s+/)) > MAX_SEGMENT_LINES
      || segment.text.split(/\s+/).length
        !== segment.endWordIndex - segment.startWordIndex
    ) fail(`${field}.segments[${segmentIndex}]`, "segments_must_partition_beat");
    expectedWordIndex = segment.endWordIndex;
    previousFrameEnd = segment.endFrame;
  }
  if (
    segments[0].startFrame !== wordSpan.startFrame
    || expectedWordIndex !== wordSpan.endWordIndex
    || segments.at(-1).endFrame !== wordSpan.endFrame
    || segments.map((segment) => segment.text).join(" ") !== wordSpan.text
  ) fail(`${field}.segments`, "segments_must_partition_beat");
  return {
    id: text(input.id, `${field}.id`, { max: 120, pattern: ID_PATTERN }),
    beatId: text(input.beatId, `${field}.beatId`, { max: 80, pattern: ID_PATTERN }),
    role,
    claimIds: stringList(input.claimIds, `${field}.claimIds`, {
      minimum: 1,
      maximum: 4,
      pattern: CLAIM_ID_PATTERN,
    }),
    certainty: VERDICTS.includes(input.certainty)
      ? input.certainty
      : fail(`${field}.certainty`, "unsupported_value"),
    wordSpan,
    segments,
    source: normalizeSource(input.source, `${field}.source`),
  };
}

function normalizeStoryIR(input) {
  exactKeys(input, [
    "schemaVersion",
    "profileId",
    "storyFormat",
    "storyVocabulary",
    "narrativeShape",
    "bindings",
    "beats",
  ], "storyIR", ["contentHash"]);
  if (input.schemaVersion !== STORY_IR_SCHEMA_VERSION) fail("storyIR.schemaVersion", "unsupported_schema");
  if (input.profileId !== STORY_IR_PROFILE_ID) fail("storyIR.profileId", "unsupported_profile");
  const storyVocabulary = text(input.storyVocabulary, "storyIR.storyVocabulary", {
    max: 80,
    pattern: ID_PATTERN,
  });
  if (!Object.hasOwn(NARRATIVE_SHAPE_BY_VOCABULARY, storyVocabulary)) {
    fail("storyIR.storyVocabulary", "unsupported_value");
  }
  const beats = Array.isArray(input.beats)
    ? input.beats.map(normalizeBeat)
    : fail("storyIR.beats", "array_required");
  if (beats.length !== SCENE_ROLES.length) fail("storyIR.beats", "exactly_five_beats_required");
  if (new Set(beats.map((beat) => beat.id)).size !== beats.length) {
    fail("storyIR.beats", "duplicate_ids");
  }
  if (new Set(beats.map((beat) => beat.beatId)).size !== beats.length) {
    fail("storyIR.beats", "duplicate_beat_ids");
  }
  let expectedWordIndex = 0;
  let previousFrameEnd = 0;
  for (const [index, beat] of beats.entries()) {
    if (beat.id !== `story_${beat.beatId}`) {
      fail(`storyIR.beats[${index}].id`, "beat_id_binding_mismatch");
    }
    if (beat.wordSpan.startWordIndex !== expectedWordIndex) {
      fail(`storyIR.beats[${index}].wordSpan`, "word_spans_must_partition_story");
    }
    if (beat.wordSpan.startFrame < previousFrameEnd) {
      fail(`storyIR.beats[${index}].wordSpan`, "frame_spans_must_be_ordered");
    }
    expectedWordIndex = beat.wordSpan.endWordIndex;
    previousFrameEnd = beat.wordSpan.endFrame;
  }
  const normalized = {
    schemaVersion: STORY_IR_SCHEMA_VERSION,
    profileId: STORY_IR_PROFILE_ID,
    storyFormat: input.storyFormat === "documented_mystery_v1"
      ? input.storyFormat
      : fail("storyIR.storyFormat", "unsupported_story_format"),
    storyVocabulary,
    narrativeShape: input.narrativeShape === NARRATIVE_SHAPE_BY_VOCABULARY[storyVocabulary]
      ? input.narrativeShape
      : fail("storyIR.narrativeShape", "vocabulary_shape_mismatch"),
    bindings: normalizeBindings(input.bindings),
    beats,
  };
  const hash = contentHash(normalized);
  if (input.contentHash !== undefined && input.contentHash !== hash) {
    fail("storyIR.contentHash", "content_hash_mismatch");
  }
  return deepFreeze({ ...normalized, contentHash: hash });
}

function worstVerdict(claimIds, claimById, field) {
  const rank = new Map(VERDICTS.map((value, index) => [value, index]));
  return claimIds.reduce((current, claimId) => {
    const claim = claimById.get(claimId);
    if (!claim) fail(field, "unknown_claim");
    if (!rank.has(claim.verdict)) fail(field, "unsupported_claim_verdict");
    return rank.get(claim.verdict) > rank.get(current) ? claim.verdict : current;
  }, "verified");
}

function wrappedLineCount(words) {
  const lines = [];
  for (const word of words) {
    const value = typeof word === "string" ? word : word.text;
    const previous = lines.at(-1);
    if (
      !previous
      || previous.length + value.length + 1 > MAX_SEGMENT_LINE_CHARACTERS
    ) {
      lines.push(value);
    } else {
      lines[lines.length - 1] = `${previous} ${value}`;
    }
  }
  return lines.length;
}

function fitsSegmentBudget(words) {
  return words.map((word) => word.text).join(" ").length
      <= MAX_SEGMENT_CHARACTERS
    && wrappedLineCount(words) <= MAX_SEGMENT_LINES;
}

function semanticBoundaryScore(words, index) {
  const previous = String(words[index - 1]?.text || "");
  const next = String(words[index]?.text || "").toLocaleLowerCase("en-US");
  if (/[.!?;:]$/.test(previous)) return 3;
  if (["but", "while", "without", "because", "although", "yet", "not"].includes(next)) {
    return 3;
  }
  if (/,$/.test(previous)) return 2;
  return 0;
}

function semanticBoundary(words, cursor, maximumEnd, options = {}) {
  const minimumWords = 3;
  const minimumRemainder = options.minimumRemainder || 1;
  const candidates = [];
  for (
    let index = cursor + minimumWords;
    index <= maximumEnd && words.length - index >= minimumRemainder;
    index += 1
  ) {
    const score = semanticBoundaryScore(words, index);
    if (score) candidates.push({ index, score });
  }
  candidates.sort((left, right) => (
    right.score - left.score
    || (options.preferLast
      ? right.index - left.index
      : left.index - right.index)
  ));
  return candidates[0]?.index || null;
}

function segmentWords(words) {
  const segments = [];
  let cursor = 0;
  while (cursor < words.length) {
    if (segments.length >= MAX_SEGMENTS_PER_BEAT) {
      fail("beats.segments", "cue_partition_exceeds_limit");
    }
    let end = cursor;
    while (end < words.length) {
      if (!fitsSegmentBudget(words.slice(cursor, end + 1))) break;
      end += 1;
    }
    if (end === cursor) fail("beats.segments", "single_word_exceeds_readability_limit");
    if (end < words.length) {
      if (words.length - end < 2 && end - cursor > 2) {
        end = words.length - 2;
      }
      end = semanticBoundary(words, cursor, end, {
        preferLast: true,
        minimumRemainder: 2,
      }) || end;
    } else if (segments.length + 1 < MAX_SEGMENTS_PER_BEAT) {
      end = semanticBoundary(words, cursor, end - 1, {
        preferLast: false,
        minimumRemainder: 3,
      }) || end;
    }
    const slice = words.slice(cursor, end);
    segments.push({
      startWordIndex: slice[0].index,
      endWordIndex: slice.at(-1).index + 1,
      startFrame: slice[0].startFrame,
      endFrame: slice.at(-1).endFrame,
      text: slice.map((word) => word.text).join(" "),
    });
    cursor = end;
  }
  return segments;
}

function expectedStoryIR(draft, timingContext) {
  if (
    draft.verticalId !== "dark_curiosity"
    || draft.brief.formatId !== "documented_mystery_v1"
  ) fail("draft.brief.formatId", "documented_mystery_required");
  if (draft.contentHash !== timingContext.draftHash) {
    fail("timingContext.draftHash", "draft_binding_mismatch");
  }
  if (
    draft.script.beats.length !== SCENE_ROLES.length
    || timingContext.beats.length !== SCENE_ROLES.length
  ) fail("timingContext.beats", "exactly_five_beats_required");

  const visualPlan = buildSemanticVisualPlan({ draft, timingContext });
  const visualByBeatId = new Map(visualPlan.scenes.map((scene) => [scene.beatId, scene]));
  const sourceSceneById = new Map(draft.storyboard.scenes.map((scene) => [scene.id, scene]));
  const claimById = new Map(draft.claimLedger.claims.map((claim) => [claim.id, claim]));
  const beats = draft.script.beats.map((beat, index) => {
    const timingBeat = timingContext.beats[index];
    const visual = visualByBeatId.get(beat.id);
    const sourceScene = visual && sourceSceneById.get(visual.sourceSceneId);
    if (
      timingBeat?.beatId !== beat.id
      || beat.role !== SCENE_ROLES[index]
      || !visual
      || !sourceScene
    ) fail(`beats[${index}]`, "draft_timing_visual_binding_mismatch");
    const words = timingContext.words.slice(
      timingBeat.wordStartIndex,
      timingBeat.wordEndIndex,
    );
    const narrationText = words.map((word) => word.text).join(" ");
    if (narrationText !== beat.spokenText) {
      fail(`beats[${index}].wordSpan.text`, "exact_script_words_required");
    }
    const operationKinds = [...new Set(visual.sourceOperationIndexes.map((operationIndex) => {
      const operation = sourceScene.operations[operationIndex];
      if (!operation) fail(`beats[${index}].source.operationKinds`, "operation_not_found");
      return operation.op;
    }))];
    return {
      id: `story_${beat.id}`,
      beatId: beat.id,
      role: beat.role,
      claimIds: [...beat.claimIds],
      certainty: worstVerdict(beat.claimIds, claimById, `beats[${index}].claimIds`),
      wordSpan: {
        startWordIndex: timingBeat.wordStartIndex,
        endWordIndex: timingBeat.wordEndIndex,
        startFrame: words[0].startFrame,
        endFrame: words.at(-1).endFrame,
        text: narrationText,
      },
      segments: segmentWords(words),
      source: {
        sceneId: sourceScene.id,
        template: sourceScene.template,
        archetypeId: visual.archetypeId,
        entityKind: visual.entityKind,
        operationKinds,
        heading: visual.heading,
        primaryLabel: visual.primaryLabel,
        secondaryLabel: visual.secondaryLabel,
        onScreenText: beat.onScreenText,
      },
    };
  });
  return {
    schemaVersion: STORY_IR_SCHEMA_VERSION,
    profileId: STORY_IR_PROFILE_ID,
    storyFormat: draft.brief.formatId,
    storyVocabulary: visualPlan.storyVocabulary,
    narrativeShape: NARRATIVE_SHAPE_BY_VOCABULARY[visualPlan.storyVocabulary],
    bindings: {
      draftHash: draft.contentHash,
      sourceStoryboardHash: draft.storyboard.contentHash,
      timingContextHash: timingContext.contentHash,
      alignmentHash: timingContext.alignmentHash,
    },
    beats,
  };
}

function buildStoryIR(input = {}) {
  let draft;
  let timingContext;
  try {
    draft = normalizeDraftBundle(input.draft);
    timingContext = normalizeAnimationTimingContext(input.timingContext);
  } catch (error) {
    if (error?.code === "ANIMATION_STORY_IR_INVALID") throw error;
    fail("context", "normalized_draft_and_timing_required");
  }
  return normalizeStoryIR(expectedStoryIR(draft, timingContext));
}

function validateStoryIRAgainstDraft(input, context = {}) {
  const storyIR = normalizeStoryIR(input);
  let expected;
  try {
    expected = buildStoryIR(context);
  } catch (error) {
    if (error?.code === "ANIMATION_STORY_IR_INVALID") throw error;
    fail("context", "normalized_draft_and_timing_required");
  }
  if (storyIR.contentHash !== expected.contentHash) {
    fail("storyIR", "source_binding_mismatch");
  }
  return storyIR;
}

module.exports = {
  MAX_SEGMENTS_PER_BEAT,
  MAX_SEGMENT_CHARACTERS,
  MAX_SEGMENT_LINES,
  MAX_SEGMENT_LINE_CHARACTERS,
  NARRATIVE_SHAPE_BY_VOCABULARY,
  STORY_IR_PROFILE_ID,
  STORY_IR_SCHEMA_VERSION,
  buildStoryIR,
  normalizeStoryIR,
  storyIRContentHash: contentHash,
  validateStoryIRAgainstDraft,
};
