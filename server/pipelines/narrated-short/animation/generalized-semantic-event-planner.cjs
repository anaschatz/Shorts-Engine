"use strict";

const { normalizeDraftBundle } = require("../contracts.cjs");
const {
  buildSemanticEventGraph,
} = require("./semantic-event-graph.cjs");
const {
  deepFreeze,
} = require("./semantic-event-validator.cjs");
const {
  buildStoryIR,
  validateStoryIRAgainstDraft,
} = require("./story-ir.cjs");
const {
  buildVisualIntentGraph,
  validateVisualIntentGraphAgainstStoryIR,
} = require("./generalized-visual-intent-planner.cjs");
const {
  normalizeAnimationTimingContext,
} = require("./timing-contract.cjs");

function sourceRef(sourceType, sourceId, field, value) {
  return {
    sourceType,
    sourceId,
    operationIndex: null,
    field,
    startOffset: 0,
    endOffset: value.length,
    value,
  };
}

function narrationCueSourceRef(beat, timingBeat, wordSpan) {
  const words = beat.spokenText.split(/\s+/).filter(Boolean);
  const localStart = wordSpan.startWordIndex - timingBeat.wordStartIndex;
  const localEnd = wordSpan.endWordIndex - timingBeat.wordStartIndex;
  const startOffset = localStart === 0
    ? 0
    : words.slice(0, localStart).join(" ").length + 1;
  const endOffset = words.slice(0, localEnd).join(" ").length;
  const value = beat.spokenText.slice(startOffset, endOffset);
  return {
    sourceType: "beat",
    sourceId: beat.id,
    operationIndex: null,
    field: "spokenText",
    startOffset,
    endOffset,
    value,
  };
}

function semanticEventManifest(draft, timingContext, visualIntentGraph) {
  const beatById = new Map(draft.script.beats.map((beat) => [beat.id, beat]));
  const timingByBeatId = new Map(timingContext.beats.map((beat) => [beat.beatId, beat]));
  const entities = visualIntentGraph.entities.map((entity) => {
    const labelBeat = beatById.get(entity.labelBeatId);
    return {
      id: entity.id,
      kind: entity.subjectKind,
      visualSubjectKind: entity.subjectKind,
      label: entity.label,
      persistent: entity.persistent,
      claimIds: structuredClone(entity.claimIds),
      sourceRefs: [sourceRef(
        "beat",
        labelBeat.id,
        "onScreenText",
        labelBeat.onScreenText,
      )],
    };
  });
  const propositions = visualIntentGraph.intents.map((intent) => {
    const beat = beatById.get(intent.beatId);
    const timingBeat = timingByBeatId.get(intent.beatId);
    return {
      id: `proposition_${intent.role}_${intent.segmentIndex}`,
      beatId: intent.beatId,
      claimIds: structuredClone(intent.claimIds),
      wordSpan: structuredClone(intent.wordSpan),
      eventKind: intent.eventKind,
      predicate: intent.semanticPredicate,
      polarity: intent.polarity,
      epistemicStatus: intent.epistemicStatus,
      subject: { entityId: intent.entityId },
      object: { entityIds: [], value: null, sourceRef: null },
      state: { before: [], after: [] },
      attributes: [],
      quantities: [],
      certainty: intent.certainty,
      visualIntent: {
        focusEntityId: intent.entityId,
        ...structuredClone(intent.visualIntent),
      },
      visualAction: {
        operation: intent.visualAction,
        focusEntityIds: [intent.entityId],
      },
      sourceRefs: [narrationCueSourceRef(beat, timingBeat, intent.wordSpan)],
    };
  });
  const epistemicConstraints = visualIntentGraph.intents
    .filter((intent) => intent.certainty !== "verified")
    .map((intent) => ({
      id: `constraint_${intent.role}_${intent.segmentIndex}`,
      rule: "Preserve the approved uncertainty and do not convert interpretation into fact.",
      claimIds: structuredClone(intent.claimIds),
    }));
  return {
    storyFormat: visualIntentGraph.storyFormat,
    narrativeShape: visualIntentGraph.narrativeShape,
    entities,
    propositions,
    continuity: structuredClone(visualIntentGraph.continuity),
    epistemicConstraints,
  };
}

function buildGeneralizedSemanticArtifacts(input = {}) {
  const draft = normalizeDraftBundle(input.draft);
  const timingContext = normalizeAnimationTimingContext(input.timingContext);
  const storyIR = validateStoryIRAgainstDraft(
    buildStoryIR({ draft, timingContext }),
    { draft, timingContext },
  );
  const visualIntentGraph = validateVisualIntentGraphAgainstStoryIR(
    buildVisualIntentGraph(storyIR, { draft, timingContext }),
    storyIR,
    { draft, timingContext },
  );
  const manifest = semanticEventManifest(draft, timingContext, visualIntentGraph);
  const semanticEventGraph = buildSemanticEventGraph({
    draft,
    timingContext,
    manifest,
  });
  return deepFreeze({
    draft,
    timingContext,
    storyIR,
    visualIntentGraph,
    semanticEventGraph,
  });
}

module.exports = {
  buildGeneralizedSemanticArtifacts,
};
