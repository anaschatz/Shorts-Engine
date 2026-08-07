"use strict";

const { normalizeDraftBundle } = require("../contracts.cjs");
const {
  buildSemanticEventGraph,
  normalizeSemanticEventGraph,
  validateSemanticEventGraphAgainstDraft,
} = require("./semantic-event-graph.cjs");
const { normalizeAnimationTimingContext } = require("./timing-contract.cjs");

const ADAPTER_PROFILE = "semantic_event_graph_v3_to_visual_program_v2";
const ADAPTER_VERSION = "1.0.0";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function adaptSemanticEventGraphV3ToVisualProgramV2(input = {}) {
  const draft = normalizeDraftBundle(input.draft);
  const timingContext = normalizeAnimationTimingContext(input.timingContext);
  const sourceGraph = input.sourceGraph
    ? normalizeSemanticEventGraph(input.sourceGraph)
    : buildSemanticEventGraph({
      draft,
      timingContext,
      manifest: input.manifest,
    });

  validateSemanticEventGraphAgainstDraft(sourceGraph, { draft, timingContext });
  if (sourceGraph.draftHash !== draft.contentHash
    || sourceGraph.timingContextHash !== timingContext.contentHash) {
    throw new TypeError("SemanticEventGraph v3 bindings do not match the approved draft and timing context.");
  }

  const graph = {
    storyTitle: draft.script.title.toLocaleUpperCase("en-US"),
    draftHash: sourceGraph.draftHash,
    sourceStoryboardHash: sourceGraph.contentHash,
    timingContextHash: sourceGraph.timingContextHash,
    entities: sourceGraph.entities.map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      visualSubjectKind: entity.visualSubjectKind,
      label: entity.label,
      persistent: entity.persistent,
      claimIds: [...entity.claimIds],
    })),
    propositions: sourceGraph.propositions.map((proposition) => ({
      id: proposition.id,
      beatId: proposition.beatId,
      eventKind: proposition.object.entityIds.length
        ? proposition.eventKind
        : "state_transition",
      predicate: proposition.predicate,
      polarity: proposition.polarity,
      certainty: proposition.certainty,
      subject: { entityId: proposition.subject.entityId },
      object: { entityIds: [...proposition.object.entityIds] },
      visualAction: {
        operation: proposition.visualAction.operation,
        focusEntityIds: [...proposition.visualAction.focusEntityIds],
      },
      wordSpan: {
        startFrame: proposition.wordSpan.startFrame,
        endFrame: proposition.wordSpan.endFrame,
      },
    })),
  };

  return deepFreeze({
    graph,
    provenance: {
      profile: ADAPTER_PROFILE,
      version: ADAPTER_VERSION,
      sourceProfile: sourceGraph.profileId,
      sourceGraphHash: sourceGraph.contentHash,
      approvedDraftHash: draft.contentHash,
      timingContextHash: timingContext.contentHash,
      entityCount: graph.entities.length,
      propositionCount: graph.propositions.length,
      sourceGraphAuthoringMode: "checked_semantic_event_graph_v3",
      v2GraphHandAuthored: false,
    },
  });
}

module.exports = {
  ADAPTER_PROFILE,
  ADAPTER_VERSION,
  adaptSemanticEventGraphV3ToVisualProgramV2,
};
