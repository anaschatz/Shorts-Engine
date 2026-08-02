"use strict";

const { createHash } = require("node:crypto");
const { stableStringify } = require("./canonical-json.cjs");

const ASSIGNMENT_PROFILE = "generalized_visual_human_calibration_assignment_v1";
const RESPONSE_PROFILE = "generalized_visual_human_calibration_response_v1";
const RESULT_PROFILE = "generalized_visual_human_calibration_result_v1";
const MODES = Object.freeze(["silent", "narrated"]);
const RECIPE_IDS = Object.freeze([
  "bounded_uncertainty", "cause_effect", "chronology", "comparison",
  "evidence_inspection", "finite_cycle", "map_route", "negative_space_absence",
]);
const RUBRIC_KEYS = Object.freeze([
  "narrationVisualCorrespondence", "immediateComprehensibility", "focalClarity",
  "textLegibility", "revealClarity", "pacing", "visualDistinctiveness",
]);
const BOOLEAN_KEYS = Object.freeze([
  "understoodWithoutReplay", "neededNarrationToUnderstand", "primaryObjectIdentified",
  "helperImprovedMeaning", "textReadableOnMobile", "wouldRequireManualEdit",
]);
const ISSUE_CODES = Object.freeze([
  "CLUTTERED", "FOCUS_UNCLEAR", "HELPER_CONFUSING", "HELPER_TOO_SMALL",
  "MEANING_UNCLEAR", "MOTION_TOO_FAST", "MOTION_TOO_SLOW", "OFF_CENTER",
  "REPETITIVE", "TEXT_TOO_SMALL", "TIMING_UNCLEAR", "WRONG_RELATION",
]);
const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SAFE_ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const SAFE_REF_RE = /^previews\/[a-z0-9_-]{3,96}\.html$/;

function sha(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function plain(value, field) {
  const prototype = value && typeof value === "object" && !Array.isArray(value) ? Object.getPrototypeOf(value) : null;
  if (!value || typeof value !== "object" || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) throw new TypeError(`${field} must be a plain object.`);
  return value;
}

function exact(value, keys, field) {
  plain(value, field);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new TypeError(`${field} has an unsupported field.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new TypeError(`${field} is missing a field.`);
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`${field} is out of range.`);
  return value;
}

function id(value, field) {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) throw new TypeError(`${field} is invalid.`);
  return value;
}

function hash(value, field) {
  if (typeof value !== "string" || !HASH_RE.test(value)) throw new TypeError(`${field} is invalid.`);
  return value;
}

function enumValue(value, field, allowed) {
  if (!allowed.includes(value)) throw new TypeError(`${field} is unsupported.`);
  return value;
}

function canonicalList(value, field, allowed, maximum = allowed.length) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${field} is invalid.`);
  value.forEach((entry) => enumValue(entry, field, allowed));
  if (new Set(value).size !== value.length || [...value].sort().join("|") !== value.join("|")) throw new TypeError(`${field} must be unique and sorted.`);
  return [...value];
}

function seededOrder(values, seed) {
  const output = [...values];
  let state = Number.parseInt(sha(seed).slice(0, 8), 16) || 1;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}

function optionIdsFor(recipeId, seed) {
  const distractors = seededOrder(RECIPE_IDS.filter((entry) => entry !== recipeId), `${seed}:${recipeId}`).slice(0, 3);
  return seededOrder([recipeId, ...distractors], `${seed}:${recipeId}:options`);
}

function unsigned(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return copy;
}

function validateHash(value, field) {
  if (value.contentHash !== sha(unsigned(value))) throw new TypeError(`${field}.contentHash is invalid.`);
}

function normalizeAssignmentItem(input, index) {
  exact(input, [
    "itemId", "ordinal", "caseIndex", "sceneIndex", "recipeId", "compositionFamily",
    "uncertaintyClass", "helperPresent", "modeOrder", "previewRefs", "optionIds",
  ], `assignment.items.${index}`);
  id(input.itemId, `assignment.items.${index}.itemId`);
  integer(input.ordinal, `assignment.items.${index}.ordinal`, 0, 255);
  integer(input.caseIndex, `assignment.items.${index}.caseIndex`, 0, 63);
  integer(input.sceneIndex, `assignment.items.${index}.sceneIndex`, 0, 7);
  enumValue(input.recipeId, `assignment.items.${index}.recipeId`, RECIPE_IDS);
  id(input.compositionFamily, `assignment.items.${index}.compositionFamily`);
  enumValue(input.uncertaintyClass, `assignment.items.${index}.uncertaintyClass`, ["verified", "qualified", "disputed", "unknown"]);
  if (typeof input.helperPresent !== "boolean") throw new TypeError("assignment helper flag is invalid.");
  if (!Array.isArray(input.modeOrder) || input.modeOrder.join("|") !== MODES.join("|")) throw new TypeError("assignment mode order is invalid.");
  exact(input.previewRefs, MODES, `assignment.items.${index}.previewRefs`);
  for (const mode of MODES) if (typeof input.previewRefs[mode] !== "string" || !SAFE_REF_RE.test(input.previewRefs[mode])) throw new TypeError("assignment preview reference is unsafe.");
  if (!Array.isArray(input.optionIds) || input.optionIds.length !== 4 || new Set(input.optionIds).size !== 4) throw new TypeError("assignment options are invalid.");
  input.optionIds.forEach((entry) => enumValue(entry, "assignment option", RECIPE_IDS));
  if (!input.optionIds.includes(input.recipeId)) throw new TypeError("assignment options omit the grounded answer.");
  return {
    itemId: input.itemId,
    ordinal: input.ordinal,
    caseIndex: input.caseIndex,
    sceneIndex: input.sceneIndex,
    recipeId: input.recipeId,
    compositionFamily: input.compositionFamily,
    uncertaintyClass: input.uncertaintyClass,
    helperPresent: input.helperPresent,
    modeOrder: [...MODES],
    previewRefs: { ...input.previewRefs },
    optionIds: [...input.optionIds],
  };
}

function normalizeHumanCalibrationAssignment(input) {
  exact(input, ["schemaVersion", "profile", "commitSha", "corpusHash", "seedHash", "calibrationId", "items", "contentHash"], "assignment");
  if (input.schemaVersion !== 1 || input.profile !== ASSIGNMENT_PROFILE || !COMMIT_RE.test(input.commitSha)) throw new TypeError("assignment identity is invalid.");
  hash(input.corpusHash, "assignment.corpusHash");
  hash(input.seedHash, "assignment.seedHash");
  id(input.calibrationId, "assignment.calibrationId");
  if (!Array.isArray(input.items) || input.items.length < 36 || input.items.length > 96) throw new TypeError("assignment must contain at least 36 review scenes.");
  const items = input.items.map(normalizeAssignmentItem);
  if (new Set(items.map((entry) => entry.itemId)).size !== items.length) throw new TypeError("assignment item IDs must be unique.");
  if (new Set(items.map((entry) => entry.ordinal)).size !== items.length || items.some((entry, index) => entry.ordinal !== index)) throw new TypeError("assignment order must be canonical.");
  const recipeCounts = Object.fromEntries(RECIPE_IDS.map((recipeId) => [recipeId, items.filter((entry) => entry.recipeId === recipeId).length]));
  if (Object.values(recipeCounts).some((count) => count < 3)) throw new TypeError("assignment recipe coverage is insufficient.");
  const normalized = {
    schemaVersion: 1,
    profile: ASSIGNMENT_PROFILE,
    commitSha: input.commitSha,
    corpusHash: input.corpusHash,
    seedHash: input.seedHash,
    calibrationId: input.calibrationId,
    items,
  };
  const contentHash = sha(normalized);
  if (input.contentHash !== contentHash) throw new TypeError("assignment contentHash is invalid.");
  return deepFreeze({ ...normalized, contentHash });
}

function createHumanCalibrationAssignment({ corpus, commitSha, seed = "generalized-visual-calibration-v1" }) {
  if (!corpus || !corpus.manifest || !Array.isArray(corpus.cases) || corpus.cases.length < 12 || !COMMIT_RE.test(commitSha || "")) throw new TypeError("calibration assignment input is invalid.");
  const seedHash = sha(`${seed}:${commitSha}:${corpus.manifest.contentHash}`);
  const unordered = corpus.cases.flatMap((entry, caseIndex) => entry.compiled.visualRecipePlan.scenes.map((scene, sceneIndex) => ({ entry, caseIndex, scene, sceneIndex })));
  const ordered = seededOrder(unordered, seedHash);
  const calibrationId = `calibration_${sha(`${commitSha}:${seedHash}`).slice(0, 24)}`;
  const items = ordered.map(({ entry, caseIndex, scene, sceneIndex }, ordinal) => {
    const itemId = `item_${sha(`${calibrationId}:${entry.corpusCase.caseId}:${sceneIndex}`).slice(0, 24)}`;
    const previewStem = `preview_${sha(`${itemId}:preview`).slice(0, 24)}`;
    return {
      itemId,
      ordinal,
      caseIndex,
      sceneIndex,
      recipeId: scene.recipeId,
      compositionFamily: scene.layout.compositionFamily,
      uncertaintyClass: entry.corpusCase.semanticUncertainty,
      helperPresent: Boolean(scene.layout.helper),
      modeOrder: [...MODES],
      previewRefs: { silent: `previews/${previewStem}.html`, narrated: `previews/${previewStem}.html` },
      optionIds: optionIdsFor(scene.recipeId, `${seedHash}:${itemId}`),
    };
  });
  const base = { schemaVersion: 1, profile: ASSIGNMENT_PROFILE, commitSha, corpusHash: corpus.manifest.contentHash, seedHash, calibrationId, items };
  return normalizeHumanCalibrationAssignment({ ...base, contentHash: sha(base) });
}

function normalizeRubric(input) {
  exact(input, RUBRIC_KEYS, "response.rubric");
  return Object.fromEntries(RUBRIC_KEYS.map((key) => [key, integer(input[key], `response.rubric.${key}`, 1, 5)]));
}

function normalizeBooleans(input) {
  exact(input, BOOLEAN_KEYS, "response.booleans");
  for (const key of BOOLEAN_KEYS) if (typeof input[key] !== "boolean") throw new TypeError(`response.booleans.${key} must be boolean.`);
  return Object.fromEntries(BOOLEAN_KEYS.map((key) => [key, input[key]]));
}

function normalizeHumanCalibrationResponse(input, assignment) {
  const normalizedAssignment = normalizeHumanCalibrationAssignment(assignment);
  exact(input, [
    "schemaVersion", "profile", "assignmentHash", "commitSha", "calibrationId", "responseId",
    "reviewerSessionId", "itemId", "source", "answers", "rubric", "booleans",
    "confusedWith", "issueCodes", "reviewerConfirmed", "contentHash",
  ], "response");
  if (input.schemaVersion !== 1 || input.profile !== RESPONSE_PROFILE || input.assignmentHash !== normalizedAssignment.contentHash || input.commitSha !== normalizedAssignment.commitSha || input.calibrationId !== normalizedAssignment.calibrationId) throw new TypeError("response binding is invalid.");
  id(input.responseId, "response.responseId");
  id(input.reviewerSessionId, "response.reviewerSessionId");
  id(input.itemId, "response.itemId");
  const item = normalizedAssignment.items.find((entry) => entry.itemId === input.itemId);
  if (!item) throw new TypeError("response item is not assigned.");
  enumValue(input.source, "response.source", ["human", "mock"]);
  exact(input.answers, MODES, "response.answers");
  for (const mode of MODES) enumValue(input.answers[mode], `response.answers.${mode}`, item.optionIds);
  const rubric = normalizeRubric(input.rubric);
  const booleans = normalizeBooleans(input.booleans);
  if (input.confusedWith !== null) enumValue(input.confusedWith, "response.confusedWith", item.optionIds.filter((entry) => entry !== item.recipeId));
  const issueCodes = canonicalList(input.issueCodes, "response.issueCodes", ISSUE_CODES, 8);
  if (typeof input.reviewerConfirmed !== "boolean") throw new TypeError("response reviewer confirmation is invalid.");
  if (input.source === "mock" && input.reviewerConfirmed) throw new TypeError("mock response cannot claim human confirmation.");
  const normalized = {
    schemaVersion: 1,
    profile: RESPONSE_PROFILE,
    assignmentHash: input.assignmentHash,
    commitSha: input.commitSha,
    calibrationId: input.calibrationId,
    responseId: input.responseId,
    reviewerSessionId: input.reviewerSessionId,
    itemId: input.itemId,
    source: input.source,
    answers: { silent: input.answers.silent, narrated: input.answers.narrated },
    rubric,
    booleans,
    confusedWith: input.confusedWith,
    issueCodes,
    reviewerConfirmed: input.reviewerConfirmed,
  };
  const contentHash = sha(normalized);
  if (input.contentHash !== contentHash) throw new TypeError("response contentHash is invalid.");
  return deepFreeze({ ...normalized, contentHash });
}

function createHumanCalibrationResponse(raw, assignment) {
  const normalizedAssignment = normalizeHumanCalibrationAssignment(assignment);
  const responseId = `response_${sha(`${raw.reviewerSessionId}:${raw.itemId}:${normalizedAssignment.contentHash}`).slice(0, 24)}`;
  const base = {
    schemaVersion: 1,
    profile: RESPONSE_PROFILE,
    assignmentHash: normalizedAssignment.contentHash,
    commitSha: normalizedAssignment.commitSha,
    calibrationId: normalizedAssignment.calibrationId,
    responseId,
    reviewerSessionId: raw.reviewerSessionId,
    itemId: raw.itemId,
    source: raw.source,
    answers: raw.answers,
    rubric: raw.rubric,
    booleans: raw.booleans,
    confusedWith: raw.confusedWith,
    issueCodes: raw.issueCodes,
    reviewerConfirmed: raw.reviewerConfirmed,
  };
  return normalizeHumanCalibrationResponse({ ...base, contentHash: sha(base) }, normalizedAssignment);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(3));
}

function rate(values) {
  return values.length ? Number((values.filter(Boolean).length / values.length).toFixed(3)) : null;
}

function recipeMetrics(recipeItems, responses) {
  const itemIds = new Set(recipeItems.map((entry) => entry.itemId));
  const relevant = responses.filter((entry) => itemIds.has(entry.itemId));
  const responsesByItem = new Map(recipeItems.map((entry) => [entry.itemId, relevant.filter((response) => response.itemId === entry.itemId)]));
  const sceneCoverageComplete = [...responsesByItem.values()].every((entries) => new Set(entries.map((entry) => entry.reviewerSessionId)).size >= 2);
  if (recipeItems.length < 3 || !sceneCoverageComplete) {
    return { status: "insufficient_evidence", sceneCount: recipeItems.length, responseCount: relevant.length, metrics: null };
  }
  const itemById = new Map(recipeItems.map((entry) => [entry.itemId, entry]));
  return {
    status: "calibrated",
    sceneCount: recipeItems.length,
    responseCount: relevant.length,
    metrics: {
      rubricMedians: Object.fromEntries(RUBRIC_KEYS.map((key) => [key, median(relevant.map((entry) => entry.rubric[key]))])),
      silentComprehensionRate: rate(relevant.map((entry) => entry.answers.silent === itemById.get(entry.itemId).recipeId)),
      narratedComprehensionRate: rate(relevant.map((entry) => entry.answers.narrated === itemById.get(entry.itemId).recipeId)),
      narrationImprovementRate: rate(relevant.map((entry) => entry.answers.silent !== itemById.get(entry.itemId).recipeId && entry.answers.narrated === itemById.get(entry.itemId).recipeId)),
      primaryIdentificationRate: rate(relevant.map((entry) => entry.booleans.primaryObjectIdentified)),
      understoodWithoutReplayRate: rate(relevant.map((entry) => entry.booleans.understoodWithoutReplay)),
      narrationDependencyRate: rate(relevant.map((entry) => entry.booleans.neededNarrationToUnderstand)),
      manualEditRate: rate(relevant.map((entry) => entry.booleans.wouldRequireManualEdit)),
      mobileReadabilityRate: rate(relevant.map((entry) => entry.booleans.textReadableOnMobile)),
      helperValueRate: rate(relevant.filter((entry) => itemById.get(entry.itemId).helperPresent).map((entry) => entry.booleans.helperImprovedMeaning)),
      issueCodeFrequency: Object.fromEntries(ISSUE_CODES.map((code) => {
        const count = relevant.filter((entry) => entry.issueCodes.includes(code)).length;
        return [code, { count, rate: Number((count / relevant.length).toFixed(3)) }];
      })),
    },
  };
}

function aggregateHumanCalibration({ assignment, responses = [], reviewerFinalConfirmation = false }) {
  const normalizedAssignment = normalizeHumanCalibrationAssignment(assignment);
  if (!Array.isArray(responses) || typeof reviewerFinalConfirmation !== "boolean") throw new TypeError("calibration aggregate input is invalid.");
  const normalizedResponses = responses.map((entry) => normalizeHumanCalibrationResponse(entry, normalizedAssignment));
  const unique = new Set();
  for (const response of normalizedResponses) {
    const key = `${response.reviewerSessionId}:${response.itemId}`;
    if (unique.has(key)) throw new TypeError("duplicate reviewer response for item.");
    unique.add(key);
  }
  normalizedResponses.sort((left, right) => left.responseId.localeCompare(right.responseId));
  const humanResponses = normalizedResponses.filter((entry) => entry.source === "human" && entry.reviewerConfirmed);
  const perRecipe = Object.fromEntries(RECIPE_IDS.map((recipeId) => [
    recipeId,
    recipeMetrics(normalizedAssignment.items.filter((entry) => entry.recipeId === recipeId), humanResponses),
  ]));
  const calibrated = Object.values(perRecipe).every((entry) => entry.status === "calibrated");
  const thresholdsPassed = calibrated && Object.values(perRecipe).every((entry) => (
    entry.metrics.rubricMedians.immediateComprehensibility >= 3
    && entry.metrics.rubricMedians.focalClarity >= 3
    && entry.metrics.rubricMedians.textLegibility >= 3
    && entry.metrics.rubricMedians.revealClarity >= 3
    && entry.metrics.narratedComprehensionRate >= 0.7
    && entry.metrics.primaryIdentificationRate >= 0.7
    && entry.metrics.mobileReadabilityRate >= 0.7
  ));
  const humanReviewStatus = humanResponses.length === 0 ? "pending" : calibrated ? "complete" : "partial";
  const humanApproved = Boolean(reviewerFinalConfirmation && calibrated && thresholdsPassed && normalizedResponses.length === humanResponses.length);
  const overallMetrics = calibrated
    ? recipeMetrics(normalizedAssignment.items, humanResponses).metrics
    : null;
  const base = {
    schemaVersion: 1,
    profile: RESULT_PROFILE,
    commitSha: normalizedAssignment.commitSha,
    calibrationId: normalizedAssignment.calibrationId,
    assignmentHash: normalizedAssignment.contentHash,
    responseCount: normalizedResponses.length,
    confirmedHumanResponseCount: humanResponses.length,
    recipeCount: RECIPE_IDS.length,
    perRecipe,
    overall: {
      status: calibrated ? "calibrated" : "insufficient_evidence",
      sceneCount: normalizedAssignment.items.length,
      responseCount: humanResponses.length,
      humanCoverageRate: Number(Math.min(1, humanResponses.length / (normalizedAssignment.items.length * 2)).toFixed(3)),
      metrics: overallMetrics,
    },
    calibrationStatus: calibrated ? (thresholdsPassed ? "calibrated" : "calibrated_below_threshold") : "insufficient_evidence",
    humanReviewStatus,
    reviewerFinalConfirmation,
    humanApproved,
    productionReady: false,
  };
  return deepFreeze({ ...base, contentHash: sha(base) });
}

function normalizeHumanCalibrationResult(input, { assignment, responses = [], reviewerFinalConfirmation = false } = {}) {
  plain(input, "result");
  const expected = aggregateHumanCalibration({ assignment, responses, reviewerFinalConfirmation });
  if (stableStringify(input) !== stableStringify(expected)) throw new TypeError("calibration result is not canonical or evidence-bound.");
  return expected;
}

function publicBlindedAssignment(assignment) {
  const normalized = normalizeHumanCalibrationAssignment(assignment);
  return deepFreeze({
    schemaVersion: 1,
    profile: "generalized_visual_human_calibration_blinded_view_v1",
    calibrationId: normalized.calibrationId,
    assignmentHash: normalized.contentHash,
    items: normalized.items.map((entry) => ({
      itemId: entry.itemId,
      ordinal: entry.ordinal,
      helperPresent: entry.helperPresent,
      modeOrder: [...entry.modeOrder],
      previewRefs: { ...entry.previewRefs },
      optionIds: [...entry.optionIds],
    })),
  });
}

module.exports = {
  ASSIGNMENT_PROFILE,
  BOOLEAN_KEYS,
  ISSUE_CODES,
  MODES,
  RECIPE_IDS,
  RESPONSE_PROFILE,
  RESULT_PROFILE,
  RUBRIC_KEYS,
  aggregateHumanCalibration,
  createHumanCalibrationAssignment,
  createHumanCalibrationResponse,
  normalizeHumanCalibrationAssignment,
  normalizeHumanCalibrationResult,
  normalizeHumanCalibrationResponse,
  publicBlindedAssignment,
  shaCalibrationValue: sha,
};
