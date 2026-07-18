"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const {
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  buildSemanticEventGraph,
} = require("../server/pipelines/narrated-short/animation/semantic-event-graph.cjs");
const {
  normalizeSemanticEventGraph,
} = require("../server/pipelines/narrated-short/animation/semantic-event-validator.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const {
  buildSemanticVisualSentencePlan,
  normalizeSemanticVisualSentencePlan,
  semanticVisualSentencePlanContentHash,
  validateSemanticVisualSentencePlanAgainstGraph,
} = require("../server/pipelines/narrated-short/animation/semantic-visual-sentence-planner.cjs");

const ROOT = resolve(__dirname, "..");

function sourceRef(value, startOffset = 0) {
  return {
    sourceType: "claim",
    sourceId: "claim_counter",
    operationIndex: null,
    field: "text",
    startOffset,
    endOffset: startOffset + value.length,
    value,
  };
}

function proposition({
  id,
  startWordIndex,
  endWordIndex,
  startFrame,
  endFrame,
  cue,
}) {
  return {
    id,
    beatId: "beat_hook",
    claimIds: ["claim_counter"],
    wordSpan: {
      startWordIndex,
      endWordIndex,
      startFrame,
      endFrame,
      text: cue,
    },
    eventKind: "state_transition",
    predicate: "rolled_over",
    polarity: "affirmed",
    epistemicStatus: "supported_fact",
    subject: { entityId: "legacy_counter" },
    object: { entityIds: [], value: null, sourceRef: null },
    state: {
      before: [{ attribute: "cyclePosition", value: "maximum" }],
      after: [{ attribute: "cyclePosition", value: "origin" }],
    },
    attributes: [],
    quantities: [],
    certainty: "verified",
    visualIntent: {
      focusEntityId: "legacy_counter",
      predicate: "state_change",
      subjectKind: "finite_counter",
      stateTransition: "wrap_to_origin",
    },
    visualAction: {
      operation: "roll_counter_to_zero",
      focusEntityIds: ["legacy_counter"],
    },
    sourceRefs: [sourceRef(cue, startWordIndex * 10)],
  };
}

function graphFixture() {
  return normalizeSemanticEventGraph({
    schemaVersion: 3,
    profileId: "dark_curiosity_semantic_event_graph_v3",
    storyFormat: "documented_mystery_v1",
    narrativeShape: "mechanism_reveal_v1",
    draftHash: "a".repeat(64),
    sourceStoryboardHash: "b".repeat(64),
    timingContextHash: "c".repeat(64),
    entities: [{
      id: "legacy_counter",
      kind: "finite_counter",
      visualSubjectKind: "finite_counter",
      label: "legacy counter",
      persistent: true,
      claimIds: ["claim_counter"],
      sourceRefs: [sourceRef("legacy counter")],
    }],
    propositions: [
      proposition({
        id: "counter_first_wrap",
        startWordIndex: 0,
        endWordIndex: 2,
        startFrame: 0,
        endFrame: 24,
        cue: "counter wraps",
      }),
      proposition({
        id: "counter_second_wrap",
        startWordIndex: 2,
        endWordIndex: 4,
        startFrame: 26,
        endFrame: 50,
        cue: "counter repeats",
      }),
    ],
    continuity: [{
      entityId: "legacy_counter",
      beatIds: ["beat_hook"],
      rule: "Keep one counter identity across both state transitions.",
    }],
    epistemicConstraints: [],
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function goldenGraph(fileName) {
  const manifest = readJson(resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "semantic-events",
    fileName,
  ));
  const draft = normalizeDraftBundle(readJson(resolve(ROOT, manifest.sourceBindings.fixturePath)));
  const timingContext = normalizeAnimationTimingContext(readJson(resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "semantic-events",
    "timing",
    fileName.replace(/\.json$/, ".timing.json"),
  )));
  return buildSemanticEventGraph({ draft, timingContext, manifest });
}

function assertDeepFrozen(value, field = "plan", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, `${field} must be frozen`);
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${field}.${key}`, seen);
  }
}

function assertPlannerInvalid(action, reason) {
  assert.throws(action, (error) => {
    assert.equal(error?.code, "ANIMATION_SEMANTIC_VISUAL_SENTENCE_INVALID");
    assert.equal(error?.details?.reason, reason);
    return true;
  });
}

test("planner emits a deterministic, deeply frozen, graph-bound sentence plan", () => {
  const graph = graphFixture();
  const first = buildSemanticVisualSentencePlan(graph);
  const second = buildSemanticVisualSentencePlan(structuredClone(graph));

  assert.deepEqual(second, first);
  assert.equal(first.bindings.semanticEventGraphHash, graph.contentHash);
  assert.equal(first.bindings.draftHash, graph.draftHash);
  assert.equal(first.bindings.sourceStoryboardHash, graph.sourceStoryboardHash);
  assert.equal(first.bindings.timingContextHash, graph.timingContextHash);
  assert.equal(first.contentHash, semanticVisualSentencePlanContentHash(first));
  assert.deepEqual(normalizeSemanticVisualSentencePlan(structuredClone(first)), first);
  assert.deepEqual(validateSemanticVisualSentencePlanAgainstGraph(first, graph), first);
  assertDeepFrozen(first);
  assert.equal(Object.hasOwn(first.sentences[0], "visualAction"), false);
  assert.deepEqual(first.sentences[0].participantEntityIds, ["legacy_counter"]);

  assert.deepEqual(
    first.sentences.map((sentence) => ({
      propositionId: sentence.propositionId,
      claimIds: sentence.claimIds,
      wordSpan: sentence.wordSpan,
      sourceRefs: sentence.sourceRefs,
    })),
    graph.propositions.map((propositionValue) => ({
      propositionId: propositionValue.id,
      claimIds: propositionValue.claimIds,
      wordSpan: propositionValue.wordSpan,
      sourceRefs: propositionValue.sourceRefs,
    })),
  );
});

test("planner carries persistent identity and feeds both continuity and recent history to selection", () => {
  const plan = buildSemanticVisualSentencePlan(graphFixture());
  const [first, second] = plan.sentences;

  assert.equal(first.capability.assetId, "finite_counter");
  assert.equal(first.capability.grammarId, "finite_cycle");
  assert.deepEqual(first.continuity, {
    carriedEntityIds: [],
    carriedAssetIds: [],
  });
  assert.deepEqual(second.continuity, {
    carriedEntityIds: ["legacy_counter"],
    carriedAssetIds: ["finite_counter"],
  });
  assert.equal(first.capability.continuityScore, 0);
  assert.ok(second.capability.continuityScore > first.capability.continuityScore);
  assert.ok(second.capability.noveltyScore < first.capability.noveltyScore);
  assert.deepEqual(plan.persistentEntityBindings, [{
    entityId: "legacy_counter",
    visualSubjectKind: "finite_counter",
    assetId: "finite_counter",
    sentenceIds: ["vs_counter_first_wrap", "vs_counter_second_wrap"],
  }]);
});

test("planner fails closed on graph focus mismatches and plan tampering", () => {
  const graph = graphFixture();
  const mismatchedGraph = structuredClone(graph);
  delete mismatchedGraph.contentHash;
  mismatchedGraph.entities[0].visualSubjectKind = "device";
  assertPlannerInvalid(
    () => buildSemanticVisualSentencePlan(mismatchedGraph),
    "focus_entity_subject_kind_mismatch",
  );

  const nonPersistentContinuity = structuredClone(graph);
  delete nonPersistentContinuity.contentHash;
  nonPersistentContinuity.entities[0].persistent = false;
  assertPlannerInvalid(
    () => buildSemanticVisualSentencePlan(nonPersistentContinuity),
    "continuity_entity_not_persistent",
  );

  const plan = buildSemanticVisualSentencePlan(graph);
  const tamperedBinding = structuredClone(plan);
  tamperedBinding.bindings.semanticEventGraphHash = "d".repeat(64);
  assertPlannerInvalid(
    () => normalizeSemanticVisualSentencePlan(tamperedBinding),
    "content_hash_mismatch",
  );

  const nonDeterministicSelection = structuredClone(plan);
  delete nonDeterministicSelection.contentHash;
  nonDeterministicSelection.sentences[0].capability.grammarId = "before_after";
  assertPlannerInvalid(
    () => normalizeSemanticVisualSentencePlan(nonDeterministicSelection),
    "deterministic_selection_mismatch",
  );

  const unsupportedField = structuredClone(plan);
  delete unsupportedField.contentHash;
  unsupportedField.sentences[0].template = "generic_chart";
  assertPlannerInvalid(
    () => normalizeSemanticVisualSentencePlan(unsupportedField),
    "unsupported_field",
  );

  const graphBindingTamper = structuredClone(plan);
  delete graphBindingTamper.contentHash;
  graphBindingTamper.sentences[0].sourceRefs[0].value = "different source";
  assertPlannerInvalid(
    () => validateSemanticVisualSentencePlanAgainstGraph(graphBindingTamper, graph),
    "semantic_event_graph_binding_mismatch",
  );

  const participantTamper = structuredClone(plan);
  delete participantTamper.contentHash;
  participantTamper.sentences[0].participantEntityIds = ["legacy_counter", "invented_entity"];
  assertPlannerInvalid(
    () => validateSemanticVisualSentencePlanAgainstGraph(participantTamper, graph),
    "semantic_event_graph_binding_mismatch",
  );
});

test("GPS and Baychimo goldens compile into story-specific visual sentences", () => {
  const gpsGraph = goldenGraph("002_gps_week_rollover.json");
  const baychimoGraph = goldenGraph("003_baychimo_icebound_drift.json");
  const gps = buildSemanticVisualSentencePlan(gpsGraph);
  const baychimo = buildSemanticVisualSentencePlan(baychimoGraph);

  assert.equal(gps.sentences.length, gpsGraph.propositions.length);
  assert.equal(baychimo.sentences.length, baychimoGraph.propositions.length);
  assert.notEqual(gps.narrativeShape, baychimo.narrativeShape);
  assert.equal(
    gps.sentences.find((sentence) => sentence.propositionId === "gps_hook_counter_reset")
      .capability.grammarId,
    "finite_cycle",
  );
  assert.equal(
    baychimo.sentences.find(
      (sentence) => sentence.propositionId === "baychimo_hook_observed_absence",
    ).capability.grammarId,
    "negative_space_absence",
  );
  assert.ok(gps.sentences.find(
    (sentence) => sentence.propositionId === "gps_context_ten_bit_storage",
  ).continuity.carriedEntityIds.includes("legacy_gps_week_counter"));
  assert.ok(baychimo.sentences.find(
    (sentence) => sentence.propositionId === "baychimo_context_sinking_assumption",
  ).continuity.carriedEntityIds.includes("baychimo"));
  assert.ok(gps.persistentEntityBindings.some(
    (binding) => binding.entityId === "legacy_gps_week_counter",
  ));
  assert.ok(baychimo.persistentEntityBindings.some(
    (binding) => binding.entityId === "baychimo",
  ));
  assert.notDeepEqual(
    gps.sentences.map((sentence) => sentence.capability.grammarId),
    baychimo.sentences.map((sentence) => sentence.capability.grammarId),
  );
});
