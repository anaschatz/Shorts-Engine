"use strict";

const { normalizeDraftBundle } = require("../contracts.cjs");
const {
  buildSemanticEventGraph,
} = require("./semantic-event-graph.cjs");
const {
  deepFreeze,
} = require("./semantic-event-validator.cjs");
const {
  buildGeneralizedSemanticEventManifest,
} = require("./generalized-semantic-event-manifest.cjs");
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
  const manifest = buildGeneralizedSemanticEventManifest(
    draft,
    timingContext,
    visualIntentGraph,
  );
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
