const { existsSync, readFileSync, statSync } = require("node:fs");
const { isAbsolute, relative, resolve } = require("node:path");

const BETA_SAMPLE_MIN = 20;
const BETA_SAMPLE_MAX = 50;
const MAX_REVIEW_BYTES = 128 * 1024;
const SCORE_CRITERIA = Object.freeze([
  "moment_selection",
  "ball_player_framing",
  "caption_action_alignment",
  "pacing_energy",
  "overall_short_quality",
]);
const REQUIRED_REVIEW_CRITERIA = Object.freeze([...SCORE_CRITERIA, "false_goal_guard"]);
const RENDER_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function safeText(value, max = 100) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function safeJsonRef(rootDir, value) {
  const ref = String(value || "").trim().replace(/\\/g, "/");
  if (!ref || isAbsolute(ref) || ref.split("/").some((part) => part === "..") || !ref.endsWith(".json")) return null;
  const target = resolve(rootDir, ref);
  const fromRoot = relative(resolve(rootDir), target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return null;
  return { ref, target };
}

function readReview(rootDir, ref) {
  const safe = safeJsonRef(rootDir, ref);
  if (!safe || !existsSync(safe.target)) return null;
  const stat = statSync(safe.target);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_REVIEW_BYTES) return null;
  try {
    return JSON.parse(readFileSync(safe.target, "utf8"));
  } catch {
    return null;
  }
}

function criterionScore(value) {
  const score = Number(value && typeof value === "object" ? value.score : value);
  return Number.isFinite(score) && score >= 0 && score <= 5 ? score : null;
}

function normalizeReview(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  const criteria = review.criteria && typeof review.criteria === "object" && !Array.isArray(review.criteria)
    ? review.criteria
    : null;
  if (!criteria) return null;
  const scores = Object.fromEntries(REQUIRED_REVIEW_CRITERIA.map((criterion) => [
    criterion,
    criterionScore(criteria[criterion]),
  ]));
  if (Object.values(scores).some((score) => score === null)) return null;
  const flags = review.flags && typeof review.flags === "object" && !Array.isArray(review.flags) ? review.flags : {};
  return {
    scores,
    falseGoalClaim: flags.falseGoalClaim === true || scores.false_goal_guard < 4,
  };
}

function normalizeMatch(entry, rootDir) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const matchId = safeText(entry.matchId, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(matchId)) return null;
  const renderStatus = safeText(entry.renderStatus, 20).toLowerCase();
  if (!RENDER_STATUSES.includes(renderStatus)) return null;
  const review = normalizeReview(entry.review || readReview(rootDir, entry.reviewRef));
  const acceptedWithoutEdit = typeof entry.acceptedWithoutEdit === "boolean" ? entry.acceptedWithoutEdit : null;
  const costUsd = entry.costUsd === null || entry.costUsd === undefined || entry.costUsd === ""
    ? null
    : Number(entry.costUsd);
  if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > 10000)) return null;
  return {
    matchId,
    rightsConfirmed: entry.rightsConfirmed === true,
    renderStatus,
    review,
    acceptedWithoutEdit,
    costUsd,
  };
}

function average(values) {
  const safe = values.filter(Number.isFinite);
  return safe.length ? round(safe.reduce((sum, value) => sum + value, 0) / safe.length, 3) : null;
}

function rate(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator, 4) : null;
}

function thresholdConfig(input = {}) {
  const value = (key, fallback, min, max) => {
    const number = Number(input[key]);
    return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
  };
  return {
    minAcceptedWithoutEditRate: value("minAcceptedWithoutEditRate", 0.7, 0, 1),
    maxFalseGoalRate: value("maxFalseGoalRate", 0.01, 0, 1),
    maxRenderFailureRate: value("maxRenderFailureRate", 0.05, 0, 1),
    minHumanCriterionScore: value("minHumanCriterionScore", 4, 0, 5),
    minCostCoverageRate: value("minCostCoverageRate", 1, 0, 1),
  };
}

function buildBetaBenchmark(manifest = {}, options = {}) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const rawMatches = Array.isArray(manifest.matches) ? manifest.matches : [];
  const normalized = rawMatches.map((entry) => normalizeMatch(entry, rootDir));
  const invalidEntryCount = normalized.filter((entry) => !entry).length;
  const matches = normalized.filter(Boolean);
  const duplicateIds = matches.length - new Set(matches.map((entry) => entry.matchId)).size;
  const completed = matches.filter((entry) => entry.renderStatus === "completed");
  const failed = matches.filter((entry) => entry.renderStatus === "failed");
  const reviewed = completed.filter((entry) => entry.review);
  const acceptanceLabeled = completed.filter((entry) => entry.acceptedWithoutEdit !== null);
  const acceptedWithoutEdit = acceptanceLabeled.filter((entry) => entry.acceptedWithoutEdit).length;
  const falseGoalCount = reviewed.filter((entry) => entry.review.falseGoalClaim).length;
  const costCovered = matches.filter((entry) => entry.costUsd !== null);
  const completedCostCovered = completed.filter((entry) => entry.costUsd !== null);
  const totalCostUsd = round(costCovered.reduce((sum, entry) => sum + entry.costUsd, 0), 4);
  const completedCostUsd = round(completedCostCovered.reduce((sum, entry) => sum + entry.costUsd, 0), 4);
  const criterionScores = Object.fromEntries(SCORE_CRITERIA.map((criterion) => [
    criterion,
    average(reviewed.map((entry) => entry.review.scores[criterion])),
  ]));
  const thresholds = thresholdConfig(manifest.thresholds);
  const metrics = {
    matchCount: matches.length,
    rightsClearedCount: matches.filter((entry) => entry.rightsConfirmed).length,
    completedRenderCount: completed.length,
    failedRenderCount: failed.length,
    reviewedClipCount: reviewed.length,
    acceptedWithoutEditCount: acceptedWithoutEdit,
    acceptedWithoutEditRate: rate(acceptedWithoutEdit, acceptanceLabeled.length),
    acceptanceLabelCoverageRate: rate(acceptanceLabeled.length, completed.length),
    falseGoalCount,
    falseGoalRate: rate(falseGoalCount, reviewed.length),
    renderFailureRate: rate(failed.length, matches.length),
    humanScores: criterionScores,
    costCoveredVideoCount: costCovered.length,
    costCoverageRate: rate(costCovered.length, matches.length),
    totalCostUsd: costCovered.length === matches.length && matches.length ? totalCostUsd : null,
    costPerVideoUsd: costCovered.length === matches.length && matches.length
      ? round(totalCostUsd / matches.length, 4)
      : null,
    costPerCompletedVideoUsd: completedCostCovered.length === completed.length && completed.length
      ? round(completedCostUsd / completed.length, 4)
      : null,
  };
  const checks = [
    { id: "sample_size_20_50", passed: matches.length >= BETA_SAMPLE_MIN && matches.length <= BETA_SAMPLE_MAX },
    { id: "all_entries_valid", passed: invalidEntryCount === 0 && duplicateIds === 0 },
    { id: "rights_cleared", passed: matches.length > 0 && metrics.rightsClearedCount === matches.length },
    { id: "human_review_complete", passed: completed.length > 0 && reviewed.length === completed.length },
    { id: "acceptance_labels_complete", passed: completed.length > 0 && acceptanceLabeled.length === completed.length },
    { id: "accepted_without_edit_rate", passed: metrics.acceptedWithoutEditRate !== null && metrics.acceptedWithoutEditRate >= thresholds.minAcceptedWithoutEditRate },
    { id: "false_goal_rate", passed: metrics.falseGoalRate !== null && metrics.falseGoalRate <= thresholds.maxFalseGoalRate },
    { id: "render_failure_rate", passed: metrics.renderFailureRate !== null && metrics.renderFailureRate <= thresholds.maxRenderFailureRate },
    { id: "human_quality_scores", passed: SCORE_CRITERIA.every((criterion) => metrics.humanScores[criterion] !== null && metrics.humanScores[criterion] >= thresholds.minHumanCriterionScore) },
    { id: "cost_coverage", passed: metrics.costCoverageRate !== null && metrics.costCoverageRate >= thresholds.minCostCoverageRate },
  ];
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.id);
  return {
    schemaVersion: 1,
    generatedAt: safeText(options.now || new Date().toISOString(), 40),
    datasetId: safeText(manifest.datasetId || "beta-evaluation", 80),
    status: failedChecks.length ? "blocked" : "passed",
    productionBetaReady: failedChecks.length === 0,
    samplePolicy: { minMatches: BETA_SAMPLE_MIN, maxMatches: BETA_SAMPLE_MAX },
    thresholds,
    metrics,
    checks,
    failedChecks,
    invalidEntryCount,
    duplicateMatchIdCount: duplicateIds,
  };
}

module.exports = {
  BETA_SAMPLE_MAX,
  BETA_SAMPLE_MIN,
  REQUIRED_REVIEW_CRITERIA,
  SCORE_CRITERIA,
  buildBetaBenchmark,
  normalizeReview,
};
