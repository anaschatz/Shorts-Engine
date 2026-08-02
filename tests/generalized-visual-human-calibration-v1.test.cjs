"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { compileGeneralizedVisualCalibrationCorpus } = require("../server/pipelines/narrated-short/animation/generalized-visual-calibration-corpus.cjs");
const {
  BOOLEAN_KEYS,
  ISSUE_CODES,
  RUBRIC_KEYS,
  aggregateHumanCalibration,
  createHumanCalibrationAssignment,
  createHumanCalibrationResponse,
  normalizeHumanCalibrationAssignment,
  normalizeHumanCalibrationResult,
  normalizeHumanCalibrationResponse,
  publicBlindedAssignment,
} = require("../server/pipelines/narrated-short/animation/generalized-visual-human-calibration-contract.cjs");

const COMMIT = "e157e6306cf5d5ce27f959fc0295afc6b3e9aa4f";

function assignment(seed = "test-calibration-seed") {
  return createHumanCalibrationAssignment({ corpus: compileGeneralizedVisualCalibrationCorpus(), commitSha: COMMIT, seed });
}

function responseFor(item, value, source = "human", reviewerConfirmed = true) {
  return {
    reviewerSessionId: `reviewer_${value}`,
    itemId: item.itemId,
    source,
    answers: { silent: item.recipeId, narrated: item.recipeId },
    rubric: Object.fromEntries(RUBRIC_KEYS.map((key) => [key, 5])),
    booleans: Object.fromEntries(BOOLEAN_KEYS.map((key) => [key, ["wouldRequireManualEdit", "neededNarrationToUnderstand"].includes(key) ? false : true])),
    confusedWith: null,
    issueCodes: [],
    reviewerConfirmed,
  };
}

test("assignment is seeded, blinded in its public view, immutable, and hash-bound", () => {
  const first = assignment();
  const repeated = assignment();
  const changed = assignment("different-seed");
  assert.deepEqual(first, repeated);
  assert.notEqual(first.contentHash, changed.contentHash);
  assert.equal(first.items.length, 36);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.items[0]));
  const publicView = publicBlindedAssignment(first);
  const serialized = JSON.stringify(publicView);
  assert.doesNotMatch(serialized, /recipeId|compositionFamily|caseIndex|sceneIndex|uncertaintyClass/);
  assert.doesNotMatch(serialized, /spokenText|narration|https?:\/\//);
  const tampered = structuredClone(first);
  tampered.items[0].ordinal = 7;
  assert.throws(() => normalizeHumanCalibrationAssignment(tampered), /canonical|contentHash/);
});

test("responses are bounded, exact, duplicate-safe, and mock data never approves", () => {
  const assigned = assignment();
  const mock = createHumanCalibrationResponse(responseFor(assigned.items[0], "mock_a", "mock", false), assigned);
  assert.ok(Object.isFrozen(mock));
  const pending = aggregateHumanCalibration({ assignment: assigned, responses: [mock], reviewerFinalConfirmation: true });
  assert.equal(pending.calibrationStatus, "insufficient_evidence");
  assert.equal(pending.humanReviewStatus, "pending");
  assert.equal(pending.humanApproved, false);
  assert.equal(pending.productionReady, false);
  assert.ok(Object.values(pending.perRecipe).every((entry) => entry.metrics === null));
  assert.equal(pending.overall.metrics, null);
  const hostile = structuredClone(mock);
  hostile.issueCodes = [...ISSUE_CODES, "FREEFORM_OTHER"].sort();
  assert.throws(() => normalizeHumanCalibrationResponse(hostile, assigned), /invalid|unsupported/);
  assert.throws(() => aggregateHumanCalibration({ assignment: assigned, responses: [mock, mock] }), /duplicate/);
});

test("two confirmed human sessions per scene calibrate metrics but never open production", () => {
  const assigned = assignment();
  const responses = [];
  for (const item of assigned.items) {
    responses.push(createHumanCalibrationResponse(responseFor(item, "human_a"), assigned));
    responses.push(createHumanCalibrationResponse(responseFor(item, "human_b"), assigned));
  }
  const withoutFinalConfirmation = aggregateHumanCalibration({ assignment: assigned, responses });
  assert.equal(withoutFinalConfirmation.calibrationStatus, "calibrated");
  assert.equal(withoutFinalConfirmation.humanReviewStatus, "complete");
  assert.equal(withoutFinalConfirmation.humanApproved, false);
  const confirmed = aggregateHumanCalibration({ assignment: assigned, responses, reviewerFinalConfirmation: true });
  assert.equal(confirmed.humanApproved, true);
  assert.equal(confirmed.productionReady, false);
  for (const entry of Object.values(confirmed.perRecipe)) {
    assert.equal(entry.status, "calibrated");
    assert.equal(entry.metrics.silentComprehensionRate, 1);
    assert.equal(entry.metrics.narratedComprehensionRate, 1);
    assert.equal(entry.metrics.manualEditRate, 0);
    assert.equal(entry.metrics.primaryIdentificationRate, 1);
    assert.equal(entry.metrics.understoodWithoutReplayRate, 1);
    assert.equal(entry.metrics.narrationDependencyRate, 0);
    assert.ok(Object.values(entry.metrics.issueCodeFrequency).every((value) => value.count === 0 && value.rate === 0));
  }
  assert.equal(confirmed.overall.humanCoverageRate, 1);
  assert.equal(confirmed.overall.metrics.rubricMedians.visualDistinctiveness, 5);
  assert.deepEqual(
    aggregateHumanCalibration({ assignment: assigned, responses: [...responses].reverse(), reviewerFinalConfirmation: true }),
    confirmed,
  );
  assert.deepEqual(normalizeHumanCalibrationResult(confirmed, { assignment: assigned, responses, reviewerFinalConfirmation: true }), confirmed);
  const tampered = structuredClone(confirmed);
  tampered.unboundedNote = "not allowed";
  assert.throws(() => normalizeHumanCalibrationResult(tampered, { assignment: assigned, responses, reviewerFinalConfirmation: true }), /canonical/);
  assert.throws(() => normalizeHumanCalibrationResult(confirmed, { assignment: assignment("stale-seed"), responses, reviewerFinalConfirmation: true }));
});
