"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  COMPOSITION_GRAMMAR_CAPABILITIES,
  PREDICATE_CAPABILITIES,
  SEMANTIC_ASSET_CAPABILITIES,
  normalizeVisualCapabilityProposition,
  scoreVisualCapabilityCandidate,
  selectVisualCapability,
  validateVisualCapabilityRegistry,
} = require("../server/pipelines/narrated-short/animation/visual-capability-registry.cjs");

const GPS_ROLLOVER = Object.freeze({
  predicate: "state_change",
  subjectKind: "finite_counter",
  stateTransition: "wrap_to_origin",
});

const BAYCHIMO_DISAPPEARANCE = Object.freeze({
  predicate: "disappearance",
  subjectKind: "vessel",
  stateTransition: "occlude_then_absent",
});

function assertCapabilityError(action, details) {
  assert.throws(action, (error) => {
    assert.equal(error.code, "ANIMATION_VISUAL_CAPABILITY_INVALID");
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, details);
    return true;
  });
}

test("the visual capability registry self-validates and is deeply frozen", () => {
  assert.equal(validateVisualCapabilityRegistry(), true);
  assert.equal(validateVisualCapabilityRegistry(), true);

  for (const registry of [
    PREDICATE_CAPABILITIES,
    SEMANTIC_ASSET_CAPABILITIES,
    COMPOSITION_GRAMMAR_CAPABILITIES,
  ]) {
    assert.ok(Object.isFrozen(registry));
    for (const entry of Object.values(registry)) {
      assert.ok(Object.isFrozen(entry));
      assert.ok(Object.isFrozen(entry.capabilities));
      for (const capability of entry.capabilities) {
        assert.ok(Object.isFrozen(capability));
        assert.ok(Object.isFrozen(capability.subjectKinds));
        assert.ok(Object.isFrozen(capability.stateTransitions));
      }
    }
  }
});

test("GPS finite-counter rollover deterministically selects the finite-cycle grammar", () => {
  const first = selectVisualCapability({ proposition: GPS_ROLLOVER });
  const second = selectVisualCapability({ proposition: GPS_ROLLOVER });

  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    proposition: GPS_ROLLOVER,
    assetId: "finite_counter",
    grammarId: "finite_cycle",
    score: 200030,
    semanticScore: 200,
    continuityScore: 0,
    noveltyScore: 30,
  });
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.proposition));
});

test("Baychimo vessel disappearance selects negative space instead of generic transition grammar", () => {
  const selected = selectVisualCapability({
    proposition: BAYCHIMO_DISAPPEARANCE,
  });

  assert.equal(selected.assetId, "vessel");
  assert.equal(selected.grammarId, "negative_space_absence");
  assert.equal(selected.semanticScore, 200);
  assert.equal(selected.continuityScore, 0);
  assert.equal(selected.noveltyScore, 30);
});

test("incompatible propositions fail closed at the subject and transition boundaries", () => {
  assertCapabilityError(
    () => normalizeVisualCapabilityProposition({
      predicate: "state_change",
      subjectKind: "vessel",
      stateTransition: "wrap_to_origin",
    }),
    {
      field: "proposition.subjectKind",
      reason: "predicate_subject_incompatible",
    },
  );

  assertCapabilityError(
    () => normalizeVisualCapabilityProposition({
      predicate: "disappearance",
      subjectKind: "vessel",
      stateTransition: "become_visible",
    }),
    {
      field: "proposition.stateTransition",
      reason: "predicate_subject_transition_incompatible",
    },
  );
});

test("continuity and novelty signals cannot make semantically incompatible candidates scoreable", () => {
  const continuityFavoredAsset = scoreVisualCapabilityCandidate({
    proposition: GPS_ROLLOVER,
    assetId: "vessel",
    grammarId: "finite_cycle",
    recentGrammarIds: ["before_after", "finite_cycle", "state_transition"],
    recentAssetIds: ["finite_counter"],
    carriedAssetIds: ["vessel"],
  });
  assert.deepEqual(continuityFavoredAsset, {
    compatible: false,
    score: null,
    semanticScore: 0,
    continuityScore: 0,
    noveltyScore: 0,
    reasons: ["asset_semantically_incompatible"],
  });

  const novelButIncompatibleGrammar = scoreVisualCapabilityCandidate({
    proposition: GPS_ROLLOVER,
    assetId: "finite_counter",
    grammarId: "negative_space_absence",
    recentGrammarIds: ["before_after", "finite_cycle", "state_transition"],
    recentAssetIds: ["finite_counter"],
    carriedAssetIds: ["finite_counter"],
  });
  assert.deepEqual(novelButIncompatibleGrammar, {
    compatible: false,
    score: null,
    semanticScore: 0,
    continuityScore: 0,
    noveltyScore: 0,
    reasons: ["grammar_semantically_incompatible"],
  });
});

test("repeated recent choices are accepted as history and deterministically reduce novelty", () => {
  const fresh = scoreVisualCapabilityCandidate({
    proposition: GPS_ROLLOVER,
    assetId: "finite_counter",
    grammarId: "finite_cycle",
  });
  const repeated = scoreVisualCapabilityCandidate({
    proposition: GPS_ROLLOVER,
    assetId: "finite_counter",
    grammarId: "finite_cycle",
    recentGrammarIds: ["finite_cycle", "finite_cycle", "finite_cycle"],
    recentAssetIds: ["finite_counter", "finite_counter"],
  });

  assert.equal(fresh.compatible, true);
  assert.equal(repeated.compatible, true);
  assert.ok(repeated.noveltyScore < fresh.noveltyScore);
  assert.ok(repeated.score < fresh.score);
});

test("grammar fit is specific to the proposition tuple instead of a global grammar rank", () => {
  const cases = [
    [
      {
        predicate: "last_known_record",
        subjectKind: "record",
        stateTransition: "mark_last_known",
      },
      "chronology_accumulation",
    ],
    [
      {
        predicate: "negation",
        subjectKind: "hypothesis",
        stateTransition: "reject_hypothesis",
      },
      "side_by_side_comparison",
    ],
    [
      {
        predicate: "recurrence",
        subjectKind: "timeline",
        stateTransition: "repeat_cycle",
      },
      "chronology_accumulation",
    ],
  ];

  for (const [proposition, grammarId] of cases) {
    const selected = selectVisualCapability({ proposition });
    assert.equal(selected.grammarId, grammarId);
    assert.equal(selected.semanticScore, 200);
  }
});
