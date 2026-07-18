"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  buildSemanticEventGraph,
  normalizeSemanticEventGraph,
  validateSemanticEventGraphAgainstDraft,
} = require("../server/pipelines/narrated-short/animation/semantic-event-graph.cjs");
const {
  semanticEventGraphContentHash,
} = require("../server/pipelines/narrated-short/animation/semantic-event-validator.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");

const ROOT = resolve(__dirname, "..");
const GOLDENS = Object.freeze([
  Object.freeze({
    id: "gps",
    fileName: "002_gps_week_rollover.json",
    timingFileName: "002_gps_week_rollover.timing.json",
    timingHash: "d69c135d8f350a09151e584665cf8986f44abacd3b2ea98108494265bc30586b",
    graphHash: "e2405560134386bb7d70745a1c89ef059ebaec15495b96d4129eee56d3c7be08",
  }),
  Object.freeze({
    id: "baychimo",
    fileName: "003_baychimo_icebound_drift.json",
    timingFileName: "003_baychimo_icebound_drift.timing.json",
    timingHash: "5ef4f3c0ef568f34bc257969fe37f81689e1eb2196fb4f8aa5a901bbea35a626",
    graphHash: "54383a235b65264c4c8e269d9fd49901de439c8c92e256963179393b87832ab4",
  }),
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertGoldenCuePartition(manifest, draft, timingContext) {
  const source = manifest.sourceBindings;
  assert.equal(draft.contentHash, source.approvedDraftHash);
  assert.equal(timingContext.alignmentHash, source.alignmentHash);
  assert.equal(timingContext.draftHash, source.approvedDraftHash);
  assert.equal(timingContext.fps, source.fps);
  assert.equal(timingContext.durationFrames, source.durationFrames);
  assert.equal(timingContext.words.length, source.wordCount);
  const visitedWordIndices = new Set();

  for (const authorBeat of manifest.beats) {
    const draftBeat = draft.script.beats.find((beat) => beat.id === authorBeat.beatId);
    const timingBeat = timingContext.beats.find((beat) => beat.beatId === authorBeat.beatId);
    assert.ok(draftBeat, `missing approved beat ${authorBeat.beatId}`);
    assert.ok(timingBeat, `missing aligned beat ${authorBeat.beatId}`);
    assert.equal(authorBeat.role, draftBeat.role);
    assert.deepEqual(
      {
        beatId: authorBeat.beatId,
        wordStartIndex: authorBeat.wordSpan.startIndex,
        wordEndIndex: authorBeat.wordSpan.endIndexExclusive,
        startFrame: authorBeat.frameSpan.startFrame,
        endFrame: authorBeat.frameSpan.endFrame,
      },
      timingBeat,
      `${authorBeat.beatId} must preserve the real forced-alignment boundaries`,
    );

    let nextWordIndex = authorBeat.wordSpan.startIndex;
    for (const proposition of authorBeat.propositions) {
      const cue = proposition.cue;
      const cueWords = timingContext.words.slice(cue.wordStartIndex, cue.wordEndIndexExclusive);
      assert.equal(cue.wordStartIndex, nextWordIndex, `${proposition.id} must start at the exact next word`);
      assert.ok(cueWords.length > 0, `${proposition.id} must cover aligned words`);
      assert.equal(cue.text, cueWords.map((word) => word.text).join(" "), `${proposition.id} exact text`);
      assert.equal(cue.startFrame, cueWords[0].startFrame, `${proposition.id} exact start frame`);
      assert.equal(cue.endFrame, cueWords.at(-1).endFrame, `${proposition.id} exact end frame`);
      cueWords.forEach((word) => {
        assert.equal(visitedWordIndices.has(word.index), false, `${proposition.id} must not reuse word ${word.index}`);
        visitedWordIndices.add(word.index);
      });
      nextWordIndex = cue.wordEndIndexExclusive;
    }

    assert.equal(nextWordIndex, authorBeat.wordSpan.endIndexExclusive);
  }
  assert.equal(visitedWordIndices.size, timingContext.words.length);
}

function loadGolden(definition) {
  const manifestPath = resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "semantic-events",
    definition.fileName,
  );
  const manifest = readJson(manifestPath);
  const draft = normalizeDraftBundle(readJson(resolve(ROOT, manifest.sourceBindings.fixturePath)));
  const timingContext = normalizeAnimationTimingContext(readJson(resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "semantic-events",
    "timing",
    definition.timingFileName,
  )));
  assertGoldenCuePartition(manifest, draft, timingContext);
  const graph = buildSemanticEventGraph({ draft, timingContext, manifest });
  return { ...definition, manifest, draft, timingContext, graph };
}

function authorProposition(manifest, id) {
  const proposition = manifest.beats
    .flatMap((beat) => beat.propositions)
    .find((candidate) => candidate.id === id);
  assert.ok(proposition, `missing author proposition ${id}`);
  return proposition;
}

function graphProposition(graph, id) {
  const proposition = graph.propositions.find((candidate) => candidate.id === id);
  assert.ok(proposition, `missing graph proposition ${id}`);
  return proposition;
}

function graphEntity(graph, id) {
  const entity = graph.entities.find((candidate) => candidate.id === id);
  assert.ok(entity, `missing graph entity ${id}`);
  return entity;
}

function factsByAttribute(facts) {
  return Object.fromEntries(facts.map((fact) => [fact.attribute, fact.value]));
}

function assertDeepFrozen(value, field = "graph", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, `${field} must be frozen`);
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${field}.${key}`, seen);
  }
}

function assertSemanticEventInvalid(action, reason) {
  assert.throws(action, (error) => {
    assert.equal(error?.code, "ANIMATION_SEMANTIC_EVENT_INVALID");
    assert.equal(error?.details?.reason, reason);
    return true;
  });
}

function reverseAuthoringOrder(manifest) {
  const reordered = structuredClone(manifest);
  reordered.entities.reverse();
  reordered.beats.reverse();
  reordered.beats.forEach((beat) => beat.propositions.reverse());
  reordered.continuity.reverse();
  reordered.epistemicConstraints.reverse();
  return reordered;
}

test("both v3 goldens compile from exact cue boundaries into stable deeply frozen graphs", () => {
  for (const definition of GOLDENS) {
    const value = loadGolden(definition);
    assert.equal(value.timingContext.contentHash, definition.timingHash, definition.id);
    assert.equal(value.graph.contentHash, definition.graphHash, definition.id);
    assert.equal(semanticEventGraphContentHash(value.graph), definition.graphHash, definition.id);
    assert.deepEqual(
      validateSemanticEventGraphAgainstDraft(value.graph, value),
      value.graph,
      definition.id,
    );
    assert.deepEqual(normalizeSemanticEventGraph(structuredClone(value.graph)), value.graph, definition.id);
    assertDeepFrozen(value.graph, `${definition.id}.graph`);

    const reordered = buildSemanticEventGraph({
      draft: value.draft,
      timingContext: value.timingContext,
      manifest: reverseAuthoringOrder(value.manifest),
    });
    assert.deepEqual(reordered, value.graph, `${definition.id} authoring order must not affect the graph`);
    assert.equal(reordered.contentHash, definition.graphHash, definition.id);
    assert.throws(() => {
      value.graph.propositions[0].predicate = "appears";
    }, TypeError);
  }
});

test("the GPS graph preserves the finite-counter mechanism and explicitly negates time reversal", () => {
  const { graph } = loadGolden(GOLDENS[0]);
  assert.equal(graph.narrativeShape, "mechanism_reveal_v1");
  assert.deepEqual(
    {
      kind: graphEntity(graph, "legacy_gps_week_counter").kind,
      visualSubjectKind: graphEntity(graph, "legacy_gps_week_counter").visualSubjectKind,
      persistent: graphEntity(graph, "legacy_gps_week_counter").persistent,
    },
    { kind: "finite_counter", visualSubjectKind: "finite_counter", persistent: true },
  );

  const tenBit = graphProposition(graph, "gps_context_ten_bit_storage");
  assert.equal(tenBit.eventKind, "structural_relation");
  assert.equal(tenBit.predicate, "stores_week_number_in_field");
  assert.deepEqual(tenBit.object.entityIds, ["week_number_field"]);
  assert.deepEqual(factsByAttribute(tenBit.attributes), { bitWidth: 10 });
  assert.deepEqual(tenBit.quantities.map((quantity) => quantity.value), ["ten"]);
  assert.equal(tenBit.quantities[0].valueSourceRef.value, "ten");
  assert.equal(tenBit.quantities[0].unit, "bits");
  assert.deepEqual(tenBit.visualIntent, {
    focusEntityId: "legacy_civil_signal",
    predicate: "mechanism_reveal",
    subjectKind: "mapping",
    stateTransition: "reveal_structure",
  });

  const future = graphProposition(graph, "gps_turn_legacy_2038");
  assert.equal(future.eventKind, "future_event");
  assert.deepEqual(factsByAttribute(future.attributes), { year: 2038 });
  assert.deepEqual(future.quantities.map((quantity) => quantity.value), ["2038"]);

  const time = graphProposition(graph, "gps_payoff_time_did_not_reset");
  assert.equal(time.eventKind, "negated_state_transition");
  assert.equal(time.predicate, "reset_or_move_backward");
  assert.equal(time.polarity, "negated");
  assert.equal(time.epistemicStatus, "qualified_analysis");
  assert.equal(time.certainty, "qualified");
  assert.deepEqual(factsByAttribute(time.state.before), { direction: "forward" });
  assert.deepEqual(factsByAttribute(time.state.after), { direction: "forward" });
  assert.equal(time.visualAction.operation, "contrast_counter_reset_with_continuing_time");
  assert.ok(graph.epistemicConstraints.some((constraint) => constraint.id === "gps_no_time_reversal"));
  assert.deepEqual(
    graph.continuity.find((binding) => binding.entityId === "legacy_gps_week_counter").beatIds,
    ["beat_hook", "beat_context", "beat_evidence", "beat_turn", "beat_payoff"],
  );
});

test("the Baychimo graph separates observed absence, historical assumption, drift, and unknown fate", () => {
  const { graph } = loadGolden(GOLDENS[1]);
  assert.equal(graph.narrativeShape, "historical_reconstruction_v1");
  assert.deepEqual(
    { kind: graphEntity(graph, "baychimo").kind, persistent: graphEntity(graph, "baychimo").persistent },
    { kind: "steamship", persistent: true },
  );

  const absence = graphProposition(graph, "baychimo_hook_observed_absence");
  assert.equal(absence.eventKind, "observed_state_change");
  assert.equal(absence.predicate, "found_ship_absent_from_last_seen_ice");
  assert.deepEqual(factsByAttribute(absence.state.before), {
    baychimoVisibilityAtLastSeenIce: "present",
  });
  assert.deepEqual(factsByAttribute(absence.state.after), {
    baychimoVisibilityAtLastSeenIce: "not_observed",
  });
  assert.deepEqual(absence.visualIntent, {
    focusEntityId: "baychimo",
    predicate: "disappearance",
    subjectKind: "vessel",
    stateTransition: "occlude_then_absent",
  });

  const assumption = graphProposition(graph, "baychimo_context_sinking_assumption");
  assert.equal(assumption.eventKind, "attributed_hypothesis");
  assert.equal(assumption.epistemicStatus, "historical_assumption");
  assert.deepEqual(assumption.object.entityIds, ["sinking_assumption"]);

  const drift = graphProposition(graph, "baychimo_evidence_pack_ice_drift");
  assert.equal(drift.eventKind, "coupled_motion");
  assert.equal(drift.predicate, "drifted_with");
  assert.deepEqual(factsByAttribute(drift.state.after), { motionCarrier: "arctic_pack_ice" });

  const supernatural = graphProposition(graph, "baychimo_payoff_not_supernatural");
  assert.equal(supernatural.eventKind, "rejected_interpretation");
  assert.equal(supernatural.polarity, "negated");
  assert.equal(supernatural.certainty, "qualified");

  const fate = graphProposition(graph, "baychimo_payoff_unknown_fate");
  assert.equal(fate.eventKind, "epistemic_state");
  assert.equal(fate.predicate, "remains_unknown");
  assert.equal(fate.epistemicStatus, "unknown");
  assert.deepEqual(factsByAttribute(fate.state.after), { knowledgeStatus: "unknown" });
  assert.ok(graph.epistemicConstraints.some((constraint) => constraint.id === "baychimo_no_exact_route"));
});

test("the two documented-mystery graphs retain story-specific structural diversity", () => {
  const gps = loadGolden(GOLDENS[0]);
  const baychimo = loadGolden(GOLDENS[1]);
  assert.equal(gps.graph.storyFormat, "documented_mystery_v1");
  assert.equal(baychimo.graph.storyFormat, "documented_mystery_v1");
  assert.notEqual(gps.graph.narrativeShape, baychimo.graph.narrativeShape);

  const gpsIntents = new Set(gps.graph.propositions.map((proposition) => proposition.visualIntent.predicate));
  const baychimoIntents = new Set(
    baychimo.graph.propositions.map((proposition) => proposition.visualIntent.predicate),
  );
  assert.ok([...gpsIntents].some((intent) => baychimoIntents.has(intent)));
  assert.ok([...gpsIntents].some((intent) => !baychimoIntents.has(intent)));
  assert.ok([...baychimoIntents].some((intent) => !gpsIntents.has(intent)));
  assert.deepEqual(
    gps.draft.script.beats.map(
      (beat) => gps.graph.propositions.filter((proposition) => proposition.beatId === beat.id).length,
    ),
    [4, 2, 4, 2, 4],
  );
  assert.deepEqual(
    baychimo.draft.script.beats.map(
      (beat) => baychimo.graph.propositions.filter((proposition) => proposition.beatId === beat.id).length,
    ),
    [3, 2, 5, 2, 3],
  );
  assert.equal(graphEntity(gps.graph, "legacy_gps_week_counter").kind, "finite_counter");
  assert.equal(graphEntity(baychimo.graph, "baychimo").kind, "steamship");
});

test("v3 authoring and graph validation fail closed on adversarial cues, claims, and source bindings", () => {
  const gps = loadGolden(GOLDENS[0]);
  const baychimo = loadGolden(GOLDENS[1]);

  const alteredCueText = structuredClone(gps.manifest);
  authorProposition(alteredCueText, "gps_hook_date").cue.text = "On April 6, 2018,";
  assertSemanticEventInvalid(
    () => buildSemanticEventGraph({
      draft: gps.draft,
      timingContext: gps.timingContext,
      manifest: alteredCueText,
    }),
    "cue_not_found_verbatim_at_word_span",
  );

  const shiftedCueBoundary = structuredClone(gps.manifest);
  authorProposition(shiftedCueBoundary, "gps_hook_date").cue.endFrame += 1;
  assertSemanticEventInvalid(
    () => buildSemanticEventGraph({
      draft: gps.draft,
      timingContext: gps.timingContext,
      manifest: shiftedCueBoundary,
    }),
    "word_span_frame_mismatch",
  );

  const claimFromAnotherBeat = structuredClone(gps.manifest);
  authorProposition(claimFromAnotherBeat, "gps_hook_date").claimIds = ["claim_counter"];
  assertSemanticEventInvalid(
    () => buildSemanticEventGraph({
      draft: gps.draft,
      timingContext: gps.timingContext,
      manifest: claimFromAnotherBeat,
    }),
    "claim_not_grounded_to_beat",
  );

  const reboundManifest = structuredClone(baychimo.manifest);
  reboundManifest.sourceBindings.alignmentHash = "0".repeat(64);
  assertSemanticEventInvalid(
    () => buildSemanticEventGraph({
      draft: baychimo.draft,
      timingContext: baychimo.timingContext,
      manifest: reboundManifest,
    }),
    "authoring_source_binding_mismatch",
  );

  const shiftedSourceRef = structuredClone(baychimo.graph);
  delete shiftedSourceRef.contentHash;
  const sourceRef = graphProposition(
    shiftedSourceRef,
    "baychimo_hook_year",
  ).sourceRefs[0];
  sourceRef.startOffset += 1;
  sourceRef.endOffset += 1;
  assertSemanticEventInvalid(
    () => validateSemanticEventGraphAgainstDraft(shiftedSourceRef, baychimo),
    "source_value_mismatch",
  );

  const cueRefFromAnotherProposition = structuredClone(gps.graph);
  delete cueRefFromAnotherProposition.contentHash;
  const date = graphProposition(cueRefFromAnotherProposition, "gps_hook_date");
  const counterReset = graphProposition(cueRefFromAnotherProposition, "gps_hook_counter_reset");
  date.wordSpan = structuredClone(counterReset.wordSpan);
  assertSemanticEventInvalid(
    () => validateSemanticEventGraphAgainstDraft(cueRefFromAnotherProposition, gps),
    "exact_narration_cue_source_required",
  );

  const uncoveredWords = structuredClone(baychimo.graph);
  delete uncoveredWords.contentHash;
  uncoveredWords.propositions = uncoveredWords.propositions.filter(
    (proposition) => proposition.id !== "baychimo_evidence_boardings",
  );
  assertSemanticEventInvalid(
    () => validateSemanticEventGraphAgainstDraft(uncoveredWords, baychimo),
    "word_spans_must_partition_beat",
  );

  const mismatchedVisualFocus = structuredClone(gps.graph);
  delete mismatchedVisualFocus.contentHash;
  const wrongDateFocus = graphProposition(mismatchedVisualFocus, "gps_hook_date");
  wrongDateFocus.visualIntent.focusEntityId = "affected_devices";
  assertSemanticEventInvalid(
    () => validateSemanticEventGraphAgainstDraft(mismatchedVisualFocus, gps),
    "focus_entity_subject_kind_mismatch",
  );

  const forgedHash = structuredClone(gps.graph);
  forgedHash.contentHash = "0".repeat(64);
  assertSemanticEventInvalid(
    () => validateSemanticEventGraphAgainstDraft(forgedHash, gps),
    "content_hash_mismatch",
  );
});
