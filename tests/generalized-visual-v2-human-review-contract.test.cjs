"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BOOLEAN_KEYS,
  REQUIRED_REVIEWER_COUNT,
  RUBRIC_KEYS,
  aggregateHumanReview,
  createHumanReviewAssignment,
  createHumanReviewResponse,
  normalizeHumanReviewAssignment,
  normalizeHumanReviewResponse,
  normalizeHumanReviewResult,
  publicBlindedAssignment,
  shaHumanReviewValue,
} = require("../server/pipelines/narrated-short/animation/generalized-visual-v2-human-review-contract.cjs");

const COMMIT = "e157e6306cf5d5ce27f959fc0295afc6b3e9aa4f";
const COMPARISON_HASH = shaHumanReviewValue("three-story-comparison");

function questions(storyIndex) {
  return [0, 1, 2, 3].map((questionIndex) => ({
    questionId: `question_${storyIndex}_${questionIndex}`,
    kind: questionIndex < 3 ? "factual" : "uncertainty",
    prompt: `What did bounded event ${questionIndex + 1} communicate?`,
    options: [0, 1, 2].map((optionIndex) => ({
      optionId: `option_${questionIndex}_${optionIndex}`,
      label: `Bounded answer ${optionIndex + 1}`,
    })),
    expectedOptionId: `option_${questionIndex}_0`,
  }));
}

function assignment(seed = "human-review-contract-test") {
  return createHumanReviewAssignment({
    commitSha: COMMIT,
    comparisonHash: COMPARISON_HASH,
    seed,
    items: [0, 1, 2].map((index) => ({
      storyId: `story_${index}`,
      mediaHash: shaHumanReviewValue(`media-${index}`),
      mediaBytes: 1_000 + index,
      reportHash: shaHumanReviewValue(`report-${index}`),
      programHash: shaHumanReviewValue(`program-${index}`),
      compositionHash: shaHumanReviewValue(`composition-${index}`),
      styleHash: shaHumanReviewValue("locked-style"),
      questions: questions(index),
    })),
  });
}

function rawResponse(assigned, item, reviewerIndex, overrides = {}) {
  const answers = Object.fromEntries(item.questions.map((question) => [
    question.questionId,
    question.expectedOptionId,
  ]));
  return {
    reviewerSessionId: `reviewer_human_${reviewerIndex}`,
    itemId: item.itemId,
    source: "human",
    playback: { completed: true, normalSpeed: true, replayCount: 0 },
    answers,
    rubric: Object.fromEntries(RUBRIC_KEYS.map((key) => [key, 5])),
    booleans: Object.fromEntries(BOOLEAN_KEYS.map((key) => [
      key,
      key !== "wouldRequireManualEdit",
    ])),
    issueCodes: [],
    reviewerConfirmed: true,
    ...overrides,
  };
}

function completeResponses(assigned, reviewerCount = REQUIRED_REVIEWER_COUNT) {
  const responses = [];
  for (let reviewerIndex = 0; reviewerIndex < reviewerCount; reviewerIndex += 1) {
    for (const item of assigned.items) {
      responses.push(createHumanReviewResponse(rawResponse(assigned, item, reviewerIndex), assigned));
    }
  }
  return responses;
}

test("three-video assignment is deterministic, immutable, hash-bound, and publicly blinded", () => {
  const first = assignment();
  const repeated = assignment();
  const changed = assignment("different-seed");
  assert.deepEqual(first, repeated);
  assert.notEqual(first.contentHash, changed.contentHash);
  assert.equal(first.items.length, 3);
  assert.equal(first.requiredReviewerCount, 5);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.items[0].questions[0].options));

  const publicView = publicBlindedAssignment(first);
  const serialized = JSON.stringify(publicView);
  assert.doesNotMatch(serialized, /storyId|programHash|compositionHash|reportHash|styleHash|expectedOptionId/);
  assert.doesNotMatch(serialized, /story_[0-2]/);
  assert.match(serialized, /media\/media_[a-f0-9]{24}\.mp4/);
  assert.match(serialized, /question_\d_\d/);

  const tampered = structuredClone(first);
  tampered.items[0].ordinal = 2;
  assert.throws(() => normalizeHumanReviewAssignment(tampered), /order|contentHash/);
});

test("responses are exact, one-play bounded, and duplicate-safe", () => {
  const assigned = assignment();
  const raw = rawResponse(assigned, assigned.items[0], 0);
  const response = createHumanReviewResponse(raw, assigned);
  assert.ok(Object.isFrozen(response));
  assert.deepEqual(normalizeHumanReviewResponse(response, assigned), response);

  assert.throws(() => createHumanReviewResponse({
    ...raw,
    playback: { completed: true, normalSpeed: true, replayCount: 1 },
  }, assigned), /one completed normal-speed play/);
  assert.throws(() => createHumanReviewResponse({ ...raw, freeText: "unbounded" }, assigned), /unsupported field/);
  assert.throws(() => aggregateHumanReview({ assignment: assigned, responses: [response, response] }), /duplicate/);
});

test("mock and incomplete sessions cannot count as five human reviewers", () => {
  const assigned = assignment();
  const responses = completeResponses(assigned, 4);
  responses.push(createHumanReviewResponse(rawResponse(assigned, assigned.items[0], 4), assigned));
  const partial = aggregateHumanReview({ assignment: assigned, responses, reviewerFinalConfirmation: true });
  assert.equal(partial.completeHumanReviewerCount, 4);
  assert.equal(partial.humanReviewStatus, "partial");
  assert.equal(partial.reviewStatus, "insufficient_evidence");
  assert.equal(partial.humanApproved, false);
  assert.equal(partial.productionReady, false);

  const mockRaw = rawResponse(assigned, assigned.items[1], 99, {
    reviewerSessionId: "reviewer_mock_99",
    source: "mock",
    reviewerConfirmed: false,
  });
  const mock = createHumanReviewResponse(mockRaw, assigned);
  const mockOnly = aggregateHumanReview({ assignment: assigned, responses: [mock], reviewerFinalConfirmation: true });
  assert.equal(mockOnly.completeHumanReviewerCount, 0);
  assert.equal(mockOnly.humanReviewStatus, "pending");
  assert.equal(mockOnly.humanApproved, false);
});

test("five complete passing humans can approve calibration but never production", () => {
  const assigned = assignment();
  const responses = completeResponses(assigned);
  const beforeConfirmation = aggregateHumanReview({ assignment: assigned, responses });
  assert.equal(beforeConfirmation.humanReviewStatus, "complete");
  assert.equal(beforeConfirmation.reviewStatus, "reviewed_passed");
  assert.equal(beforeConfirmation.humanApproved, false);

  const confirmed = aggregateHumanReview({
    assignment: assigned,
    responses,
    reviewerFinalConfirmation: true,
  });
  assert.equal(confirmed.completeHumanReviewerCount, 5);
  assert.equal(confirmed.coverage.rate, 1);
  assert.equal(confirmed.humanApproved, true);
  assert.equal(confirmed.publishable, false);
  assert.equal(confirmed.productionReady, false);
  assert.ok(Object.values(confirmed.perStory).every((entry) => (
    entry.status === "passed"
    && entry.metrics.factualComprehensionRate === 1
    && entry.metrics.uncertaintyComprehensionRate === 1
  )));
  assert.deepEqual(
    normalizeHumanReviewResult(confirmed, {
      assignment: assigned,
      responses,
      reviewerFinalConfirmation: true,
    }),
    confirmed,
  );
});

test("per-story thresholds fail closed and aggregate averages cannot hide a weak story", () => {
  const assigned = assignment();
  const responses = [];
  for (let reviewerIndex = 0; reviewerIndex < 5; reviewerIndex += 1) {
    for (const [itemIndex, item] of assigned.items.entries()) {
      const raw = rawResponse(assigned, item, reviewerIndex);
      if (itemIndex === 0 && reviewerIndex < 2) {
        raw.answers[item.questions[0].questionId] = item.questions[0].options.find(
          (option) => option.optionId !== item.questions[0].expectedOptionId,
        ).optionId;
        raw.rubric.pacing = 1;
        raw.booleans.wouldRequireManualEdit = true;
      }
      responses.push(createHumanReviewResponse(raw, assigned));
    }
  }
  const result = aggregateHumanReview({
    assignment: assigned,
    responses,
    reviewerFinalConfirmation: true,
  });
  assert.equal(result.humanReviewStatus, "complete");
  assert.equal(result.reviewStatus, "reviewed_below_threshold");
  assert.equal(result.humanApproved, false);
  assert.ok(Object.values(result.perStory).some((entry) => entry.status === "below_threshold"));
});
