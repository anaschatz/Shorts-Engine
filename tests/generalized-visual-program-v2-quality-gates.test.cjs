"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const {
  visualProgramV2ContentHash,
} = require("../server/pipelines/narrated-short/animation/visual-program-v2-contract.cjs");
const {
  calibrationSemanticGraphContentHashV2,
  compileGeneralizedVisualProgramV2,
} = require("../server/pipelines/narrated-short/animation/visual-program-v2-compiler.cjs");
const {
  evaluateVisualProgramV2Repetition,
  evaluateVisualProgramV2SemanticTrace,
} = require("../server/pipelines/narrated-short/animation/visual-program-v2-quality-gates.cjs");

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rehash(program) {
  program.contentHash = visualProgramV2ContentHash(program);
  return program;
}

function compileOne(seed = "alpha", overrides = {}) {
  const draftHash = sha(`draft-${seed}`);
  const timingContext = normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: 30,
    durationFrames: 100,
    alignmentHash: sha(`alignment-${seed}`),
    draftHash,
    words: [
      { index: 0, text: "A", startFrame: 0, endFrame: 12 },
      { index: 1, text: "cause", startFrame: 14, endFrame: 30 },
      { index: 2, text: "appears", startFrame: 32, endFrame: 60 },
    ],
    beats: [{
      beatId: "beat_cause",
      wordStartIndex: 0,
      wordEndIndex: 3,
      startFrame: 0,
      endFrame: 60,
    }],
  });
  const subjectId = overrides.subjectId || "source_signal";
  const objectId = overrides.objectId || "output_state";
  const predicate = overrides.predicate || "causes_output";
  const certainty = overrides.certainty || "verified";
  const semanticEventGraph = {
    storyTitle: `CAUSE AND RESULT ${seed.toUpperCase()}`,
    draftHash,
    sourceStoryboardHash: sha(`storyboard-${seed}`),
    timingContextHash: timingContext.contentHash,
    entities: [
      {
        id: subjectId,
        kind: overrides.subjectKind || "causal_source",
        visualSubjectKind: overrides.subjectVisualKind || "signal",
        label: "source",
        persistent: overrides.persistent ?? true,
        claimIds: ["claim_cause"],
      },
      {
        id: objectId,
        kind: overrides.objectKind || "result_state",
        visualSubjectKind: overrides.objectVisualKind || "state",
        label: "result",
        persistent: false,
        claimIds: ["claim_cause"],
      },
    ],
    propositions: [{
      id: "prop_cause",
      beatId: "beat_cause",
      eventKind: overrides.eventKind || "causal_action",
      predicate,
      polarity: "affirmed",
      certainty,
      subject: { entityId: subjectId },
      object: { entityIds: [objectId] },
      visualAction: {
        operation: overrides.semanticOperation || "connect_cause",
        focusEntityIds: [objectId],
      },
      wordSpan: { startFrame: 0, endFrame: 60 },
    }],
  };
  const proposal = {
    schemaVersion: 2,
    profile: "generalized_visual_program_proposal_v2",
    bindings: {
      semanticEventGraphHash: calibrationSemanticGraphContentHashV2(semanticEventGraph),
      timingContextHash: timingContext.contentHash,
      draftHash,
      sourceRevisionHash: semanticEventGraph.sourceStoryboardHash,
    },
    styleSpecId: "educational_line_art_reference_v1",
    scenes: [{
      id: "scene_cause",
      entityIds: [subjectId, objectId],
      propositionIds: ["prop_cause"],
      layoutIntent: overrides.layoutIntent || "directed_flow",
      focusEntityId: objectId,
    }],
  };
  return compileGeneralizedVisualProgramV2({
    proposal,
    semanticEventGraph,
    timingContext,
    trustMode: "calibration_trusted",
  });
}

test("semantic trace passes a grounded non-text event and returns a deterministic frozen report", () => {
  const program = compileOne();
  const first = evaluateVisualProgramV2SemanticTrace(program);
  const second = evaluateVisualProgramV2SemanticTrace(program);
  assert.deepEqual(first, second);
  assert.equal(first.passed, true);
  assert.equal(first.summary.eventCount, 1);
  assert.deepEqual(first.scenes[0].events[0].relationIds, ["relation_0_00"]);
  assert.equal(first.scenes[0].events[0].causalRelations[0].presentation, "unqualified_solid");
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.scenes[0].events[0]), true);
});

test("semantic trace fails closed for text-only events and events without a relation or state change", () => {
  const textOnly = structuredClone(compileOne());
  textOnly.scenes[0].entities.forEach((entity) => {
    entity.kind = "text_label";
    entity.visualSubjectKind = "caption_text";
  });
  rehash(textOnly);
  const textReport = evaluateVisualProgramV2SemanticTrace(textOnly);
  assert.equal(textReport.passed, false);
  assert.ok(textReport.violations.some(({ code }) => code === "event_missing_non_text_entity"));

  const staticEvent = structuredClone(compileOne());
  staticEvent.scenes[0].relations = [];
  staticEvent.scenes[0].layout.edges = [];
  staticEvent.scenes[0].tracks = staticEvent.scenes[0].tracks
    .filter((track) => track.operation === "focus")
    .map((track, order) => ({ ...track, order }));
  rehash(staticEvent);
  const staticReport = evaluateVisualProgramV2SemanticTrace(staticEvent);
  assert.equal(staticReport.passed, false);
  assert.ok(staticReport.violations.some(({ code }) => code === "event_missing_relation_or_state_change"));
});

test("semantic trace catches endpoint, certainty, cue, and settled-hold failures", () => {
  const endpoint = structuredClone(compileOne());
  const edge = endpoint.scenes[0].layout.edges[0];
  [edge.fromEntityId, edge.toEntityId] = [edge.toEntityId, edge.fromEntityId];
  rehash(endpoint);
  assert.ok(evaluateVisualProgramV2SemanticTrace(endpoint).violations
    .some(({ code }) => code === "relation_endpoint_ungrounded"));

  const certainty = structuredClone(compileOne());
  certainty.scenes[0].events[0].certainty = "qualified";
  rehash(certainty);
  assert.ok(evaluateVisualProgramV2SemanticTrace(certainty).violations
    .some(({ code }) => code === "unqualified_causal_relation"));

  const outsideCue = structuredClone(compileOne());
  outsideCue.scenes[0].tracks[1].endFrame = 70;
  rehash(outsideCue);
  assert.ok(evaluateVisualProgramV2SemanticTrace(outsideCue).violations
    .some(({ code }) => code === "track_outside_event_cue"));

  const overlapsHold = structuredClone(compileOne());
  overlapsHold.scenes[0].tracks[1].endFrame = 93;
  rehash(overlapsHold);
  const holdReport = evaluateVisualProgramV2SemanticTrace(overlapsHold);
  assert.equal(holdReport.passed, false);
  assert.equal(holdReport.violations[0].code, "plan_contract_invalid");
  assert.equal(holdReport.violations[0].field, "visualProgram.scenes[0].tracks[1].endFrame");
});

test("repetition gate rejects exact and 6x8-quantized near adjacent compositions", () => {
  const first = compileOne("same-a");
  const persistentOnly = structuredClone(compileOne("same-b"));
  persistentOnly.scenes[0].entities[0].persistent = false;
  rehash(persistentOnly);
  const exact = evaluateVisualProgramV2Repetition([
    { storyId: "one_story", program: first },
    { storyId: "one_story", program: persistentOnly },
  ]);
  assert.equal(exact.passed, false);
  assert.equal(exact.withinStory.matches[0].classification, "exact");
  assert.equal(exact.policy.persistentEntityIsNovelty, false);

  const near = structuredClone(compileOne("same-c"));
  near.scenes[0].layout.nodes[0].bounds.x += 2;
  near.scenes[0].layout.edges[0].points[0].x += 2;
  rehash(near);
  const nearReport = evaluateVisualProgramV2Repetition([
    { storyId: "one_story", program: first },
    { storyId: "one_story", program: near },
  ]);
  assert.equal(nearReport.passed, false);
  assert.equal(nearReport.withinStory.matches[0].classification, "near");
  assert.equal(nearReport.withinStory.matches[0].similarity, 1);
  assert.equal(nearReport.programs[0].scenes[0].descriptors.occupancy.cells.length, 48);
});

test("repetition gate scans cross-story reuse but accepts a material predicate/state delta", () => {
  const first = compileOne("cross-a");
  const repeated = compileOne("cross-b");
  const cross = evaluateVisualProgramV2Repetition([
    { storyId: "story_alpha", program: first },
    { storyId: "story_beta", program: repeated },
  ]);
  assert.equal(cross.passed, false);
  assert.equal(cross.crossStory.comparisonCount, 1);
  assert.equal(cross.crossStory.matches[0].classification, "exact");

  const materiallyDifferent = compileOne("cross-c", {
    predicate: "reverses_state",
    eventKind: "state_transition",
    semanticOperation: "reverse_state",
  });
  const distinct = evaluateVisualProgramV2Repetition([
    { storyId: "story_alpha", program: first },
    { storyId: "story_gamma", program: materiallyDifferent },
  ]);
  assert.equal(distinct.passed, true);
  assert.equal(distinct.crossStory.matches.length, 0);
  assert.equal(distinct.programs[0].scenes[0].hashes.motion, distinct.programs[1].scenes[0].hashes.motion);
  assert.equal(distinct.programs[0].scenes[0].hashes.occupancy, distinct.programs[1].scenes[0].hashes.occupancy);
  assert.notEqual(distinct.programs[0].scenes[0].hashes.semanticGraph, distinct.programs[1].scenes[0].hashes.semanticGraph);
  assert.equal(Object.isFrozen(distinct.programs[0].scenes[0].descriptors.occupancy.cells), true);
});

test("repetition input is fail-closed by default with an explicit calibration escape hatch", () => {
  const closed = evaluateVisualProgramV2Repetition([{ storyId: "bad_story", program: {} }]);
  assert.equal(closed.passed, false);
  assert.equal(closed.violations[0].code, "program_contract_invalid");

  const calibrationOnly = evaluateVisualProgramV2Repetition(
    [{ storyId: "bad_story", program: {} }],
    { failClosed: false },
  );
  assert.equal(calibrationOnly.passed, true);
  assert.equal(calibrationOnly.warnings[0].code, "program_contract_invalid");
});
