"use strict";

const { createHash } = require("node:crypto");
const { stableStringify } = require("./canonical-json.cjs");

const ASSIGNMENT_PROFILE = "generalized_visual_v2_human_review_assignment_v1";
const RESPONSE_PROFILE = "generalized_visual_v2_human_review_response_v1";
const RESULT_PROFILE = "generalized_visual_v2_human_review_result_v1";
const PUBLIC_PROFILE = "generalized_visual_v2_human_review_blinded_view_v1";
const REQUIRED_REVIEWER_COUNT = 5;
const QUESTION_KINDS = Object.freeze(["factual", "factual", "factual", "uncertainty"]);
const RUBRIC_KEYS = Object.freeze([
  "narrationVisualAlignment",
  "focalClarity",
  "pacing",
  "visualVariety",
  "animationHelpfulness",
  "polish",
]);
const BOOLEAN_KEYS = Object.freeze([
  "understoodWithoutReplay",
  "textReadableOnMobile",
  "wouldRequireManualEdit",
]);
const ISSUE_CODES = Object.freeze([
  "CLUTTERED",
  "CUT_ABRUPT",
  "ENDING_UNCLEAR",
  "FOCUS_UNCLEAR",
  "MEANING_UNCLEAR",
  "MOTION_NARRATION_MISMATCH",
  "MOTION_TOO_FAST",
  "MOTION_TOO_SLOW",
  "OFF_CENTER",
  "REPETITIVE",
  "TEXT_TOO_SMALL",
  "TIMING_UNCLEAR",
  "WRONG_RELATION",
]);

const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SAFE_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const SAFE_MEDIA_REF_RE = /^media\/media_[a-f0-9]{24}\.mp4$/;

function sha(value) {
  return createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : stableStringify(value))
    .digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function plain(value, field) {
  const prototype = value && typeof value === "object" && !Array.isArray(value)
    ? Object.getPrototypeOf(value)
    : null;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)
  ) throw new TypeError(`${field} must be a plain object.`);
  return value;
}

function exact(value, keys, field) {
  plain(value, field);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(`${field} has an unsupported field.`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${field} is missing a field.`);
  }
}

function id(value, field) {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

function hash(value, field) {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} is out of range.`);
  }
  return value;
}

function boundedText(value, field, minimum, maximum) {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
    || /https?:\/\//iu.test(value)
  ) throw new TypeError(`${field} is invalid.`);
  return value;
}

function canonicalList(value, field, allowed, maximum = allowed.length) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${field} is invalid.`);
  for (const entry of value) {
    if (!allowed.includes(entry)) throw new TypeError(`${field} is unsupported.`);
  }
  if (new Set(value).size !== value.length || [...value].sort().join("|") !== value.join("|")) {
    throw new TypeError(`${field} must be unique and sorted.`);
  }
  return [...value];
}

function seededOrder(values, seed) {
  const output = [...values];
  let state = Number.parseInt(sha(seed).slice(0, 8), 16) || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}

function normalizeOption(input, field) {
  exact(input, ["optionId", "label"], field);
  return {
    optionId: id(input.optionId, `${field}.optionId`),
    label: boundedText(input.label, `${field}.label`, 1, 160),
  };
}

function normalizeQuestion(input, index, field) {
  exact(input, ["questionId", "kind", "prompt", "options", "expectedOptionId"], field);
  id(input.questionId, `${field}.questionId`);
  if (input.kind !== QUESTION_KINDS[index]) throw new TypeError(`${field}.kind is invalid.`);
  boundedText(input.prompt, `${field}.prompt`, 8, 220);
  if (!Array.isArray(input.options) || input.options.length < 3 || input.options.length > 4) {
    throw new TypeError(`${field}.options is invalid.`);
  }
  const options = input.options.map((entry, optionIndex) => normalizeOption(entry, `${field}.options.${optionIndex}`));
  const optionIds = options.map((entry) => entry.optionId);
  if (new Set(optionIds).size !== options.length) throw new TypeError(`${field}.options must be unique.`);
  id(input.expectedOptionId, `${field}.expectedOptionId`);
  if (!optionIds.includes(input.expectedOptionId)) throw new TypeError(`${field} omits its expected answer.`);
  return {
    questionId: input.questionId,
    kind: input.kind,
    prompt: input.prompt,
    options,
    expectedOptionId: input.expectedOptionId,
  };
}

function normalizeAssignmentItem(input, index) {
  const field = `assignment.items.${index}`;
  exact(input, [
    "itemId",
    "ordinal",
    "storyId",
    "mediaRef",
    "mediaHash",
    "mediaBytes",
    "reportHash",
    "programHash",
    "compositionHash",
    "styleHash",
    "questions",
  ], field);
  id(input.itemId, `${field}.itemId`);
  integer(input.ordinal, `${field}.ordinal`, 0, 2);
  id(input.storyId, `${field}.storyId`);
  if (typeof input.mediaRef !== "string" || !SAFE_MEDIA_REF_RE.test(input.mediaRef)) {
    throw new TypeError(`${field}.mediaRef is invalid.`);
  }
  hash(input.mediaHash, `${field}.mediaHash`);
  integer(input.mediaBytes, `${field}.mediaBytes`, 16, 1_000_000_000);
  hash(input.reportHash, `${field}.reportHash`);
  hash(input.programHash, `${field}.programHash`);
  hash(input.compositionHash, `${field}.compositionHash`);
  hash(input.styleHash, `${field}.styleHash`);
  if (!Array.isArray(input.questions) || input.questions.length !== QUESTION_KINDS.length) {
    throw new TypeError(`${field}.questions is invalid.`);
  }
  const questions = input.questions.map((entry, questionIndex) => (
    normalizeQuestion(entry, questionIndex, `${field}.questions.${questionIndex}`)
  ));
  if (new Set(questions.map((entry) => entry.questionId)).size !== questions.length) {
    throw new TypeError(`${field}.question IDs must be unique.`);
  }
  return {
    itemId: input.itemId,
    ordinal: input.ordinal,
    storyId: input.storyId,
    mediaRef: input.mediaRef,
    mediaHash: input.mediaHash,
    mediaBytes: input.mediaBytes,
    reportHash: input.reportHash,
    programHash: input.programHash,
    compositionHash: input.compositionHash,
    styleHash: input.styleHash,
    questions,
  };
}

function normalizeHumanReviewAssignment(input) {
  exact(input, [
    "schemaVersion",
    "profile",
    "commitSha",
    "comparisonHash",
    "seedHash",
    "reviewId",
    "requiredReviewerCount",
    "items",
    "contentHash",
  ], "assignment");
  if (
    input.schemaVersion !== 1
    || input.profile !== ASSIGNMENT_PROFILE
    || !COMMIT_RE.test(input.commitSha || "")
  ) throw new TypeError("assignment identity is invalid.");
  hash(input.comparisonHash, "assignment.comparisonHash");
  hash(input.seedHash, "assignment.seedHash");
  id(input.reviewId, "assignment.reviewId");
  if (input.requiredReviewerCount !== REQUIRED_REVIEWER_COUNT) {
    throw new TypeError("assignment reviewer requirement is invalid.");
  }
  if (!Array.isArray(input.items) || input.items.length !== 3) {
    throw new TypeError("assignment must contain exactly three full-video items.");
  }
  const items = input.items.map(normalizeAssignmentItem);
  if (
    new Set(items.map((entry) => entry.itemId)).size !== 3
    || new Set(items.map((entry) => entry.storyId)).size !== 3
    || new Set(items.map((entry) => entry.mediaRef)).size !== 3
    || items.some((entry, index) => entry.ordinal !== index)
  ) throw new TypeError("assignment item identity or order is invalid.");
  if (new Set(items.map((entry) => entry.styleHash)).size !== 1) {
    throw new TypeError("assignment items must use one locked style hash.");
  }
  if (new Set(items.map((entry) => entry.programHash)).size !== 3) {
    throw new TypeError("assignment program hashes must be story-distinct.");
  }
  const base = {
    schemaVersion: 1,
    profile: ASSIGNMENT_PROFILE,
    commitSha: input.commitSha,
    comparisonHash: input.comparisonHash,
    seedHash: input.seedHash,
    reviewId: input.reviewId,
    requiredReviewerCount: REQUIRED_REVIEWER_COUNT,
    items,
  };
  const contentHash = sha(base);
  if (input.contentHash !== contentHash) throw new TypeError("assignment contentHash is invalid.");
  return deepFreeze({ ...base, contentHash });
}

function createHumanReviewAssignment({ items, commitSha, comparisonHash, seed = "generalized-visual-v2-human-review-v1" } = {}) {
  if (!Array.isArray(items) || items.length !== 3 || !COMMIT_RE.test(commitSha || "") || !HASH_RE.test(comparisonHash || "")) {
    throw new TypeError("human review assignment input is invalid.");
  }
  const seedHash = sha(`${seed}:${commitSha}:${comparisonHash}`);
  const reviewId = `review_${sha(`${commitSha}:${comparisonHash}:${seedHash}`).slice(0, 24)}`;
  const ordered = seededOrder(items, seedHash);
  const normalizedItems = ordered.map((entry, ordinal) => {
    const mediaRef = `media/media_${entry.mediaHash.slice(0, 24)}.mp4`;
    const itemId = `item_${sha(`${reviewId}:${entry.storyId}:${entry.mediaHash}`).slice(0, 24)}`;
    const questions = entry.questions.map((question, questionIndex) => ({
      ...question,
      options: seededOrder(question.options, `${seedHash}:${itemId}:${questionIndex}`),
    }));
    return { ...entry, itemId, ordinal, mediaRef, questions };
  });
  const base = {
    schemaVersion: 1,
    profile: ASSIGNMENT_PROFILE,
    commitSha,
    comparisonHash,
    seedHash,
    reviewId,
    requiredReviewerCount: REQUIRED_REVIEWER_COUNT,
    items: normalizedItems,
  };
  return normalizeHumanReviewAssignment({ ...base, contentHash: sha(base) });
}

function normalizeRubric(input) {
  exact(input, RUBRIC_KEYS, "response.rubric");
  return Object.fromEntries(RUBRIC_KEYS.map((key) => [
    key,
    integer(input[key], `response.rubric.${key}`, 1, 5),
  ]));
}

function normalizeBooleans(input) {
  exact(input, BOOLEAN_KEYS, "response.booleans");
  for (const key of BOOLEAN_KEYS) {
    if (typeof input[key] !== "boolean") throw new TypeError(`response.booleans.${key} must be boolean.`);
  }
  return Object.fromEntries(BOOLEAN_KEYS.map((key) => [key, input[key]]));
}

function normalizeAnswers(input, item) {
  exact(input, item.questions.map((entry) => entry.questionId), "response.answers");
  return Object.fromEntries(item.questions.map((question) => {
    const allowed = question.options.map((entry) => entry.optionId);
    if (!allowed.includes(input[question.questionId])) {
      throw new TypeError(`response.answers.${question.questionId} is unsupported.`);
    }
    return [question.questionId, input[question.questionId]];
  }));
}

function normalizePlayback(input) {
  exact(input, ["completed", "normalSpeed", "replayCount"], "response.playback");
  if (input.completed !== true || input.normalSpeed !== true || input.replayCount !== 0) {
    throw new TypeError("response playback evidence must record one completed normal-speed play.");
  }
  return { completed: true, normalSpeed: true, replayCount: 0 };
}

function normalizeHumanReviewResponse(input, assignment) {
  const normalizedAssignment = normalizeHumanReviewAssignment(assignment);
  exact(input, [
    "schemaVersion",
    "profile",
    "assignmentHash",
    "commitSha",
    "reviewId",
    "responseId",
    "reviewerSessionId",
    "itemId",
    "source",
    "playback",
    "answers",
    "rubric",
    "booleans",
    "issueCodes",
    "reviewerConfirmed",
    "contentHash",
  ], "response");
  if (
    input.schemaVersion !== 1
    || input.profile !== RESPONSE_PROFILE
    || input.assignmentHash !== normalizedAssignment.contentHash
    || input.commitSha !== normalizedAssignment.commitSha
    || input.reviewId !== normalizedAssignment.reviewId
  ) throw new TypeError("response binding is invalid.");
  id(input.responseId, "response.responseId");
  id(input.reviewerSessionId, "response.reviewerSessionId");
  id(input.itemId, "response.itemId");
  const item = normalizedAssignment.items.find((entry) => entry.itemId === input.itemId);
  if (!item) throw new TypeError("response item is not assigned.");
  if (!['human', 'mock'].includes(input.source)) throw new TypeError("response source is unsupported.");
  const playback = normalizePlayback(input.playback);
  const answers = normalizeAnswers(input.answers, item);
  const rubric = normalizeRubric(input.rubric);
  const booleans = normalizeBooleans(input.booleans);
  const issueCodes = canonicalList(input.issueCodes, "response.issueCodes", ISSUE_CODES, 8);
  if (typeof input.reviewerConfirmed !== "boolean") {
    throw new TypeError("response reviewer confirmation is invalid.");
  }
  if (input.source === "mock" && input.reviewerConfirmed) {
    throw new TypeError("mock response cannot claim human confirmation.");
  }
  const base = {
    schemaVersion: 1,
    profile: RESPONSE_PROFILE,
    assignmentHash: input.assignmentHash,
    commitSha: input.commitSha,
    reviewId: input.reviewId,
    responseId: input.responseId,
    reviewerSessionId: input.reviewerSessionId,
    itemId: input.itemId,
    source: input.source,
    playback,
    answers,
    rubric,
    booleans,
    issueCodes,
    reviewerConfirmed: input.reviewerConfirmed,
  };
  const contentHash = sha(base);
  if (input.contentHash !== contentHash) throw new TypeError("response contentHash is invalid.");
  return deepFreeze({ ...base, contentHash });
}

function createHumanReviewResponse(raw, assignment) {
  const normalizedAssignment = normalizeHumanReviewAssignment(assignment);
  exact(raw, [
    "reviewerSessionId",
    "itemId",
    "source",
    "playback",
    "answers",
    "rubric",
    "booleans",
    "issueCodes",
    "reviewerConfirmed",
  ], "rawResponse");
  id(raw?.reviewerSessionId, "response.reviewerSessionId");
  id(raw?.itemId, "response.itemId");
  const responseId = `response_${sha(`${raw.reviewerSessionId}:${raw.itemId}:${normalizedAssignment.contentHash}`).slice(0, 24)}`;
  const base = {
    schemaVersion: 1,
    profile: RESPONSE_PROFILE,
    assignmentHash: normalizedAssignment.contentHash,
    commitSha: normalizedAssignment.commitSha,
    reviewId: normalizedAssignment.reviewId,
    responseId,
    reviewerSessionId: raw.reviewerSessionId,
    itemId: raw.itemId,
    source: raw.source,
    playback: raw.playback,
    answers: raw.answers,
    rubric: raw.rubric,
    booleans: raw.booleans,
    issueCodes: raw.issueCodes,
    reviewerConfirmed: raw.reviewerConfirmed,
  };
  return normalizeHumanReviewResponse({ ...base, contentHash: sha(base) }, normalizedAssignment);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(3));
}

function rate(values) {
  return values.length
    ? Number((values.filter(Boolean).length / values.length).toFixed(3))
    : null;
}

function metricsForItem(item, responses) {
  if (responses.length < REQUIRED_REVIEWER_COUNT) {
    return {
      status: "insufficient_evidence",
      reviewerCount: responses.length,
      metrics: null,
      passed: false,
    };
  }
  const questionAccuracy = Object.fromEntries(item.questions.map((question) => [
    question.questionId,
    rate(responses.map((entry) => entry.answers[question.questionId] === question.expectedOptionId)),
  ]));
  const factualQuestions = item.questions.filter((entry) => entry.kind === "factual");
  const uncertaintyQuestion = item.questions.find((entry) => entry.kind === "uncertainty");
  const factualComprehensionRate = rate(responses.flatMap((entry) => factualQuestions.map(
    (question) => entry.answers[question.questionId] === question.expectedOptionId,
  )));
  const uncertaintyComprehensionRate = rate(responses.map(
    (entry) => entry.answers[uncertaintyQuestion.questionId] === uncertaintyQuestion.expectedOptionId,
  ));
  const rubricMedians = Object.fromEntries(RUBRIC_KEYS.map((key) => [
    key,
    median(responses.map((entry) => entry.rubric[key])),
  ]));
  const booleanRates = {
    understoodWithoutReplay: rate(responses.map((entry) => entry.booleans.understoodWithoutReplay)),
    textReadableOnMobile: rate(responses.map((entry) => entry.booleans.textReadableOnMobile)),
    wouldRequireManualEdit: rate(responses.map((entry) => entry.booleans.wouldRequireManualEdit)),
  };
  const issueCodeFrequency = Object.fromEntries(ISSUE_CODES.map((code) => {
    const count = responses.filter((entry) => entry.issueCodes.includes(code)).length;
    return [code, { count, rate: Number((count / responses.length).toFixed(3)) }];
  }));
  const metrics = {
    questionAccuracy,
    factualComprehensionRate,
    uncertaintyComprehensionRate,
    rubricMedians,
    booleanRates,
    issueCodeFrequency,
  };
  const passed = (
    Object.values(questionAccuracy).every((value) => value >= 0.8)
    && Object.values(rubricMedians).every((value) => value >= 4)
    && booleanRates.understoodWithoutReplay >= 0.8
    && booleanRates.textReadableOnMobile >= 0.8
    && booleanRates.wouldRequireManualEdit <= 0.2
  );
  return { status: passed ? "passed" : "below_threshold", reviewerCount: responses.length, metrics, passed };
}

function aggregateHumanReview({ assignment, responses = [], reviewerFinalConfirmation = false } = {}) {
  const normalizedAssignment = normalizeHumanReviewAssignment(assignment);
  if (!Array.isArray(responses) || typeof reviewerFinalConfirmation !== "boolean") {
    throw new TypeError("human review aggregate input is invalid.");
  }
  const normalizedResponses = responses.map((entry) => normalizeHumanReviewResponse(entry, normalizedAssignment));
  const unique = new Set();
  for (const response of normalizedResponses) {
    const key = `${response.reviewerSessionId}:${response.itemId}`;
    if (unique.has(key)) throw new TypeError("duplicate reviewer response for item.");
    unique.add(key);
  }
  normalizedResponses.sort((left, right) => left.responseId.localeCompare(right.responseId));
  const confirmedHuman = normalizedResponses.filter((entry) => entry.source === "human" && entry.reviewerConfirmed);
  const assignedItemIds = new Set(normalizedAssignment.items.map((entry) => entry.itemId));
  const sessions = new Map();
  for (const response of confirmedHuman) {
    if (!sessions.has(response.reviewerSessionId)) sessions.set(response.reviewerSessionId, new Set());
    sessions.get(response.reviewerSessionId).add(response.itemId);
  }
  const completeSessionIds = [...sessions.entries()]
    .filter(([, itemIds]) => itemIds.size === assignedItemIds.size && [...assignedItemIds].every((itemId) => itemIds.has(itemId)))
    .map(([sessionId]) => sessionId)
    .sort();
  const completeSessionSet = new Set(completeSessionIds);
  const eligibleResponses = confirmedHuman.filter((entry) => completeSessionSet.has(entry.reviewerSessionId));
  const complete = completeSessionIds.length >= REQUIRED_REVIEWER_COUNT;
  const perStory = Object.fromEntries(normalizedAssignment.items.map((item) => [
    item.storyId,
    metricsForItem(item, eligibleResponses.filter((entry) => entry.itemId === item.itemId)),
  ]));
  const thresholdsPassed = complete && Object.values(perStory).every((entry) => entry.passed);
  const allEvidenceEligible = normalizedResponses.length === eligibleResponses.length;
  const humanReviewStatus = confirmedHuman.length === 0 ? "pending" : complete ? "complete" : "partial";
  const humanApproved = Boolean(
    reviewerFinalConfirmation
    && complete
    && thresholdsPassed
    && allEvidenceEligible
  );
  const base = {
    schemaVersion: 1,
    profile: RESULT_PROFILE,
    commitSha: normalizedAssignment.commitSha,
    reviewId: normalizedAssignment.reviewId,
    assignmentHash: normalizedAssignment.contentHash,
    comparisonHash: normalizedAssignment.comparisonHash,
    requiredReviewerCount: REQUIRED_REVIEWER_COUNT,
    responseCount: normalizedResponses.length,
    confirmedHumanResponseCount: confirmedHuman.length,
    completeHumanReviewerCount: completeSessionIds.length,
    storyCount: normalizedAssignment.items.length,
    perStory,
    coverage: {
      status: complete ? "complete" : "insufficient_evidence",
      completeHumanReviewerCount: completeSessionIds.length,
      requiredReviewerCount: REQUIRED_REVIEWER_COUNT,
      responseCount: eligibleResponses.length,
      expectedMinimumResponseCount: normalizedAssignment.items.length * REQUIRED_REVIEWER_COUNT,
      rate: Number(Math.min(1, completeSessionIds.length / REQUIRED_REVIEWER_COUNT).toFixed(3)),
    },
    reviewStatus: complete ? (thresholdsPassed ? "reviewed_passed" : "reviewed_below_threshold") : "insufficient_evidence",
    humanReviewStatus,
    reviewerFinalConfirmation,
    humanApproved,
    publishable: false,
    productionReady: false,
  };
  return deepFreeze({ ...base, contentHash: sha(base) });
}

function normalizeHumanReviewResult(input, { assignment, responses = [], reviewerFinalConfirmation = false } = {}) {
  plain(input, "result");
  const expected = aggregateHumanReview({ assignment, responses, reviewerFinalConfirmation });
  if (stableStringify(input) !== stableStringify(expected)) {
    throw new TypeError("human review result is not canonical or evidence-bound.");
  }
  return expected;
}

function publicBlindedAssignment(assignment) {
  const normalized = normalizeHumanReviewAssignment(assignment);
  return deepFreeze({
    schemaVersion: 1,
    profile: PUBLIC_PROFILE,
    reviewId: normalized.reviewId,
    assignmentHash: normalized.contentHash,
    requiredReviewerCount: REQUIRED_REVIEWER_COUNT,
    items: normalized.items.map((item) => ({
      itemId: item.itemId,
      ordinal: item.ordinal,
      mediaRef: item.mediaRef,
      mediaHash: item.mediaHash,
      questions: item.questions.map((question) => ({
        questionId: question.questionId,
        kind: question.kind,
        prompt: question.prompt,
        options: question.options.map((option) => ({ ...option })),
      })),
    })),
  });
}

module.exports = {
  ASSIGNMENT_PROFILE,
  BOOLEAN_KEYS,
  ISSUE_CODES,
  PUBLIC_PROFILE,
  REQUIRED_REVIEWER_COUNT,
  RESPONSE_PROFILE,
  RESULT_PROFILE,
  RUBRIC_KEYS,
  aggregateHumanReview,
  createHumanReviewAssignment,
  createHumanReviewResponse,
  normalizeHumanReviewAssignment,
  normalizeHumanReviewResponse,
  normalizeHumanReviewResult,
  publicBlindedAssignment,
  shaHumanReviewValue: sha,
};
