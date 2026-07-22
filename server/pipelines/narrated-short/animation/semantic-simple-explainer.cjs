"use strict";

const SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID =
  "dark_curiosity_simple_explainer_v1";

const SIMPLE_EXPLAINER_REVEAL_DURATION_SECONDS = 0.65;
const SIMPLE_EXPLAINER_SECONDARY_REVEAL_DURATION_SECONDS = 0.42;
const SIMPLE_EXPLAINER_MAX_GROUP_SPAN_FRAMES = 210;
const SIMPLE_EXPLAINER_MAX_SENTENCES_PER_GROUP = 2;
const SEMANTIC_SIMPLE_EXPLAINER_VISUAL_KINDS = Object.freeze([
  "absence",
  "bounded_structure",
  "cause_effect",
  "comparison",
  "cycle",
  "evidence",
  "rejection",
  "route",
  "state_change",
  "timeline",
  "uncertainty",
]);

const COMPATIBLE_CONCEPT_PAIRS = Object.freeze({
  "signal_frequency_band>duration_timeline": Object.freeze({
    visualKind: "state_change",
    driver: "first",
  }),
  "cue_evidence_network>hypothesis_rejection": Object.freeze({
    visualKind: "rejection",
    driver: "last",
  }),
  "signal_nonrecurrence>missing_confirmation": Object.freeze({
    visualKind: "uncertainty",
    driver: "last",
  }),
  "cue_evidence_focus>hypothesis_rejection": Object.freeze({
    visualKind: "rejection",
    driver: "last",
  }),
  "encoded_bit_register>bounded_value_range": Object.freeze({
    visualKind: "bounded_structure",
    driver: "first",
  }),
  "duration_timeline>counter_recurrence": Object.freeze({
    visualKind: "cycle",
    driver: "last",
  }),
  "cue_evidence_focus>cue_evidence_spotlight": Object.freeze({
    visualKind: "state_change",
    driver: "last",
  }),
  "finite_counter_wrap>hypothesis_rejection": Object.freeze({
    visualKind: "state_change",
    driver: "last",
  }),
  "reported_assumption>witness_sighting": Object.freeze({
    visualKind: "state_change",
    driver: "last",
  }),
  "semantic_vessel_movement>hypothesis_rejection": Object.freeze({
    visualKind: "rejection",
    driver: "last",
  }),
  "semantic_timeline_last_known_record>semantic_timeline_last_known_record": Object.freeze({
    visualKind: "timeline",
    driver: "last",
  }),
});

const SAFE_ID = /^[a-z][a-z0-9_-]{1,119}$/;

function invalid() {
  throw new TypeError("Semantic simple-explainer sentences are invalid.");
}

function semanticSimpleExplainerPresentationTiming(input) {
  if (
    !input
    || typeof input !== "object"
    || Array.isArray(input)
    || !Number.isInteger(input.fps)
    || input.fps < 1
    || input.fps > 120
    || !Number.isInteger(input.startFrame)
    || input.startFrame < 0
    || !Number.isInteger(input.semanticEndFrame)
    || input.semanticEndFrame <= input.startFrame
    || !Number.isInteger(input.endFrame)
    || input.endFrame < input.semanticEndFrame
    || !Array.isArray(input.stepStartFrames)
    || !input.stepStartFrames.length
    || input.stepStartFrames.length > SIMPLE_EXPLAINER_MAX_SENTENCES_PER_GROUP
    || input.stepStartFrames[0] !== input.startFrame
    || input.stepStartFrames.some((frame, index) => (
      !Number.isInteger(frame)
      || frame < input.startFrame
      || frame >= input.semanticEndFrame
      || (index > 0 && frame <= input.stepStartFrames[index - 1])
    ))
  ) invalid();
  const secondaryRevealStartFrame = input.stepStartFrames.length > 1
    ? input.stepStartFrames[1]
    : null;
  const primaryWindowEndFrame = secondaryRevealStartFrame
    ?? input.semanticEndFrame;
  const revealDurationFrames = Math.min(
    input.fps * SIMPLE_EXPLAINER_REVEAL_DURATION_SECONDS,
    Math.max(1, primaryWindowEndFrame - input.startFrame),
  );
  const secondaryRevealDurationFrames = secondaryRevealStartFrame === null
    ? Math.max(1, input.fps * SIMPLE_EXPLAINER_SECONDARY_REVEAL_DURATION_SECONDS)
    : Math.min(
      input.fps * SIMPLE_EXPLAINER_SECONDARY_REVEAL_DURATION_SECONDS,
      Math.max(1, input.semanticEndFrame - secondaryRevealStartFrame - 1),
    );
  const revealSettleFrame = input.startFrame + Math.ceil(revealDurationFrames);
  const secondaryRevealSettleFrame = secondaryRevealStartFrame === null
    ? null
    : secondaryRevealStartFrame
      + Math.ceil(secondaryRevealDurationFrames);
  if (
    revealSettleFrame > primaryWindowEndFrame
    || (
      secondaryRevealSettleFrame !== null
      && secondaryRevealSettleFrame >= input.semanticEndFrame
    )
  ) invalid();
  return Object.freeze({
    revealDurationFrames,
    revealSettleFrame,
    secondaryRevealDurationFrames,
    secondaryRevealStartFrame,
    secondaryRevealSettleFrame,
  });
}

function normalizeSentence(sentence, index) {
  if (
    !sentence
    || typeof sentence !== "object"
    || Array.isArray(sentence)
    || typeof sentence.id !== "string"
    || !SAFE_ID.test(sentence.id)
    || typeof sentence.beatId !== "string"
    || !SAFE_ID.test(sentence.beatId)
    || typeof sentence.capability?.grammarId !== "string"
    || !SAFE_ID.test(sentence.capability.grammarId)
    || !Number.isInteger(sentence.wordSpan?.startFrame)
    || !Number.isInteger(sentence.wordSpan?.endFrame)
    || sentence.wordSpan.startFrame < 0
    || sentence.wordSpan.endFrame <= sentence.wordSpan.startFrame
  ) invalid();
  return Object.freeze({ sentence, index });
}

function isGrammaticalContinuation(previous, next) {
  const previousText = String(previous.wordSpan?.text || "").trim();
  const nextText = String(next.wordSpan?.text || "").trim();
  return !/[.!?][\"')\]]?$/.test(previousText)
    || /^(?:and|but|while|yet|making|leaving|without|not|decades|when)\b/i
      .test(nextText);
}

function singletonVisualKind(sentence) {
  const transition = sentence.visualIntent?.stateTransition;
  const concept = sentence.primitiveParameters?.visualConceptId;
  if (transition === "become_visible" && concept === "witness_sighting") {
    return "evidence";
  }
  if (transition === "reject_hypothesis") return "rejection";
  if (transition === "remain_unresolved") return "uncertainty";
  if (transition === "move_along_path") return "route";
  if (transition === "become_absent") return "absence";
  if (transition === "compare_states") return "comparison";
  if (transition === "reveal_structure") return "bounded_structure";
  if (
    transition === "map_to_incorrect_output"
    || transition === "require_update"
  ) return "cause_effect";
  switch (sentence.capability?.grammarId) {
    case "chronology_accumulation": return "timeline";
    case "side_by_side_comparison": return "comparison";
    case "cause_effect_chain": return "cause_effect";
    case "finite_cycle": return "cycle";
    case "before_after": return "state_change";
    case "evidence_inspection": return "evidence";
    case "negative_space_absence": return "absence";
    case "map_motion": return "route";
    case "bounded_uncertainty": return "uncertainty";
    default: return "evidence";
  }
}

function semanticPairCompatibility(previous, next, fps) {
  if (!isGrammaticalContinuation(previous, next)) return null;
  if (
    next.wordSpan.startFrame - previous.wordSpan.startFrame
      < Math.ceil(fps * SIMPLE_EXPLAINER_REVEAL_DURATION_SECONDS)
    || next.wordSpan.endFrame - next.wordSpan.startFrame
      < Math.ceil(fps * SIMPLE_EXPLAINER_SECONDARY_REVEAL_DURATION_SECONDS)
  ) return null;
  const previousConcept = previous.primitiveParameters?.visualConceptId || "";
  const nextConcept = next.primitiveParameters?.visualConceptId || "";

  const explicit = COMPATIBLE_CONCEPT_PAIRS[
    `${previousConcept}>${nextConcept}`
  ];
  if (
    explicit
    && previousConcept === "semantic_timeline_last_known_record"
    && !/\bdecades?\b[\s\S]*\babandon(?:ed|ment)?\b/i.test(
      `${previous.wordSpan.text} ${next.wordSpan.text}`,
    )
  ) return null;
  if (explicit) return explicit;
  return null;
}

function partitionBeatEntries(entries, fps) {
  const semanticPhases = [];
  for (const entry of entries) {
    const active = semanticPhases.at(-1);
    const compatibility = active?.entries.length
      < SIMPLE_EXPLAINER_MAX_SENTENCES_PER_GROUP
      ? semanticPairCompatibility(
        active.entries.at(-1).sentence,
        entry.sentence,
        fps,
      )
      : null;
    const span = active
      ? entry.sentence.wordSpan.endFrame
        - active.entries[0].sentence.wordSpan.startFrame
      : 0;
    if (
      !active
      || !compatibility
      || span > SIMPLE_EXPLAINER_MAX_GROUP_SPAN_FRAMES
    ) {
      semanticPhases.push({
        entries: [entry],
        visualKind: singletonVisualKind(entry.sentence),
        driver: "first",
      });
    } else {
      active.entries.push(entry);
      active.visualKind = compatibility.visualKind;
      active.driver = compatibility.driver;
    }
  }
  return semanticPhases;
}

function buildSemanticSimpleExplainerGroups(sentences, options = {}) {
  if (!Array.isArray(sentences) || !sentences.length || sentences.length > 96) {
    invalid();
  }
  if (
    !options
    || typeof options !== "object"
    || Array.isArray(options)
    || Object.keys(options).some((key) => key !== "fps")
  ) invalid();
  const fps = options.fps === undefined ? 30 : options.fps;
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) invalid();
  const normalized = sentences.map(normalizeSentence);
  if (new Set(normalized.map(({ sentence }) => sentence.id)).size !== sentences.length) {
    invalid();
  }
  if (normalized.some((entry, index) => (
    index > 0
    && entry.sentence.wordSpan.startFrame
      < normalized[index - 1].sentence.wordSpan.endFrame
  ))) invalid();
  const beatRuns = [];
  const closedBeatIds = new Set();
  for (const entry of normalized) {
    const prior = beatRuns.at(-1);
    if (prior?.beatId === entry.sentence.beatId) {
      prior.entries.push(entry);
      continue;
    }
    if (closedBeatIds.has(entry.sentence.beatId)) invalid();
    if (prior) closedBeatIds.add(prior.beatId);
    beatRuns.push({ beatId: entry.sentence.beatId, entries: [entry] });
  }
  const groups = beatRuns.flatMap((beatRun) => {
    const partitions = partitionBeatEntries(beatRun.entries, fps);
    return partitions.map((partition, phaseIndex) => ({
      beatId: beatRun.beatId,
      entries: partition.entries,
      visualKind: partition.visualKind,
      driver: partition.driver,
      phaseIndex,
      phaseCount: partitions.length,
    }));
  });
  return Object.freeze(groups.map((group, groupIndex) => {
    const anchor = group.driver === "last"
      ? group.entries.at(-1)
      : group.entries[0];
    const sentenceIndices = group.entries.map(({ index }) => index);
    return Object.freeze({
      id: group.phaseCount === 1
        ? `simple_scene_${group.beatId}`
        : `simple_scene_${group.beatId}_part_${group.phaseIndex + 1}`,
      profileId: SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
      beatId: group.beatId,
      groupIndex,
      phaseIndex: group.phaseIndex,
      phaseCount: group.phaseCount,
      visualKind: group.visualKind,
      sentenceIndices: Object.freeze(sentenceIndices),
      sentenceIds: Object.freeze(group.entries.map(({ sentence }) => sentence.id)),
      firstSentenceIndex: sentenceIndices[0],
      lastSentenceIndex: sentenceIndices.at(-1),
      anchorSentenceIndex: anchor.index,
      anchorSentenceId: anchor.sentence.id,
    });
  }));
}

module.exports = {
  SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
  SEMANTIC_SIMPLE_EXPLAINER_VISUAL_KINDS,
  SIMPLE_EXPLAINER_MAX_GROUP_SPAN_FRAMES,
  SIMPLE_EXPLAINER_MAX_SENTENCES_PER_GROUP,
  SIMPLE_EXPLAINER_REVEAL_DURATION_SECONDS,
  SIMPLE_EXPLAINER_SECONDARY_REVEAL_DURATION_SECONDS,
  buildSemanticSimpleExplainerGroups,
  semanticSimpleExplainerPresentationTiming,
};
