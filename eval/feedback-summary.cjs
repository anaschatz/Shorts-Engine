const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const { AppError } = require("../server/errors.cjs");
const { sanitizeReportText } = require("./scoring.cjs");

const FALSE_CLAIM_FLAGS = Object.freeze([
  "caption_action_mismatch",
  "generic_caption",
  "goal_without_evidence",
  "other",
  "unsafe_path_or_secret",
  "wrong_action_claim",
]);

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
}

function isSafeId(value) {
  return /^[a-z0-9][a-z0-9_-]{2,100}$/i.test(String(value || ""));
}

function safeOpaqueRef(value) {
  const safe = sanitizeReportText(value, 160);
  if (!safe || safe.startsWith("/") || safe.includes("\\") || safe.includes("..")) return null;
  if (/\/Users\/|\/private\/|storageKey|Bearer\s+|gho_[A-Za-z0-9_]+|OPENAI_API_KEY=/i.test(safe)) return null;
  if (!/^[a-z0-9][a-z0-9._/@:-]{1,158}$/i.test(safe)) return null;
  return safe;
}

function score1to5(value, field) {
  const score = Number(value);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new AppError("VALIDATION_ERROR", `${field} must be an integer from 1 to 5.`, 400);
  }
  return score;
}

function validateFeedbackItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new AppError("VALIDATION_ERROR", "Feedback item must be an object.", 400);
  }
  const fixtureId = item.fixtureId ? sanitizeReportText(item.fixtureId, 100) : null;
  const projectId = item.projectId ? sanitizeReportText(item.projectId, 100) : null;
  if ((fixtureId && !isSafeId(fixtureId)) || (projectId && !isSafeId(projectId)) || (!fixtureId && !projectId)) {
    throw new AppError("VALIDATION_ERROR", "Feedback item needs a safe fixtureId or projectId.", 400);
  }
  const generatedShortRef = safeOpaqueRef(item.generatedShortRef || `${fixtureId || projectId}:latest`);
  if (!generatedShortRef) {
    throw new AppError("VALIDATION_ERROR", "Feedback generatedShortRef is unsafe.", 400);
  }
  const selectedMomentCorrect = Boolean(item.selectedMomentCorrect);
  const captionAlignmentScore = score1to5(item.captionAlignmentScore, "captionAlignmentScore");
  const captionSpecificityScore = score1to5(item.captionSpecificityScore, "captionSpecificityScore");
  const falseClaimFlags = [...new Set((Array.isArray(item.falseClaimFlags) ? item.falseClaimFlags : [])
    .map((flag) => sanitizeReportText(flag, 60).toLowerCase())
    .filter(Boolean))];
  if (falseClaimFlags.some((flag) => !FALSE_CLAIM_FLAGS.includes(flag))) {
    throw new AppError("VALIDATION_ERROR", "Feedback falseClaimFlags contain an unsupported value.", 400);
  }
  const preferredCaptionExamples = (Array.isArray(item.preferredCaptionExamples) ? item.preferredCaptionExamples : [])
    .map((caption) => sanitizeReportText(caption, 120))
    .filter(Boolean)
    .slice(0, 5);
  const createdAt = sanitizeReportText(item.createdAt || new Date(0).toISOString(), 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(createdAt)) {
    throw new AppError("VALIDATION_ERROR", "Feedback createdAt must be ISO-like.", 400);
  }
  return {
    fixtureId,
    projectId,
    generatedShortRef,
    selectedMomentCorrect,
    captionAlignmentScore,
    captionSpecificityScore,
    falseClaimFlags,
    notes: sanitizeReportText(item.notes, 500),
    preferredCaptionExamples,
    reviewer: sanitizeReportText(item.reviewer || "anonymous", 80),
    createdAt,
  };
}

function loadFeedbackItems(feedbackDir) {
  if (!feedbackDir || !existsSync(feedbackDir)) return [];
  const files = readdirSync(feedbackDir).filter((file) => file.endsWith(".json")).sort();
  return files.flatMap((fileName) => {
    const raw = JSON.parse(readFileSync(join(feedbackDir, fileName), "utf8"));
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map(validateFeedbackItem);
  });
}

function flagCounts(items) {
  const counts = {};
  for (const item of items) {
    for (const flag of item.falseClaimFlags) counts[flag] = (counts[flag] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([flag, count]) => ({ flag, count }));
}

function buildFeedbackSummaryReport({ items, timestamp = new Date().toISOString() } = {}) {
  const safeItems = (Array.isArray(items) ? items : []).map(validateFeedbackItem);
  const count = safeItems.length || 1;
  const avg = (selector) => round(safeItems.reduce((sum, item) => sum + selector(item), 0) / count);
  const failedCases = safeItems
    .filter((item) => !item.selectedMomentCorrect || item.captionAlignmentScore <= 2 || item.captionSpecificityScore <= 2 || item.falseClaimFlags.length)
    .map((item) => ({
      fixtureId: item.fixtureId,
      projectId: item.projectId,
      generatedShortRef: item.generatedShortRef,
      selectedMomentCorrect: item.selectedMomentCorrect,
      captionAlignmentScore: item.captionAlignmentScore,
      captionSpecificityScore: item.captionSpecificityScore,
      falseClaimFlags: item.falseClaimFlags,
      notes: item.notes,
    }));
  return {
    schemaVersion: 1,
    generatedAt: timestamp,
    command: "npm run feedback:summary",
    metadata: {
      runner: "shortsengine-human-feedback-summary",
      networkRequired: false,
      providerAuthRequired: false,
      trainingDataMutation: false,
    },
    aggregate: {
      itemCount: safeItems.length,
      selectedMomentAccuracy: avg((item) => (item.selectedMomentCorrect ? 1 : 0)),
      avgCaptionAlignmentScore: avg((item) => item.captionAlignmentScore),
      avgCaptionSpecificityScore: avg((item) => item.captionSpecificityScore),
      falseClaimRate: avg((item) => (item.falseClaimFlags.length ? 1 : 0)),
      topFalseClaimFlags: flagCounts(safeItems).slice(0, 8),
      reviewerCount: new Set(safeItems.map((item) => item.reviewer)).size,
      preferredCaptionExamples: safeItems.flatMap((item) => item.preferredCaptionExamples).slice(0, 12),
    },
    failedCases,
    items: safeItems.map((item) => ({
      fixtureId: item.fixtureId,
      projectId: item.projectId,
      generatedShortRef: item.generatedShortRef,
      selectedMomentCorrect: item.selectedMomentCorrect,
      captionAlignmentScore: item.captionAlignmentScore,
      captionSpecificityScore: item.captionSpecificityScore,
      falseClaimFlags: item.falseClaimFlags,
      reviewer: item.reviewer,
      createdAt: item.createdAt,
    })),
    suggestedDebuggingNotes: failedCases.length
      ? [...new Set(failedCases.flatMap((item) => item.falseClaimFlags).concat(failedCases.map((item) => item.notes).filter(Boolean)))].slice(0, 10)
      : ["Feedback summary is clean. Keep reviewing captions against real shorts."],
  };
}

function safeWriteReportFile(filePath, payload) {
  if (existsSync(filePath)) {
    try {
      renameSync(filePath, `${filePath}.previous-${Date.now()}`);
    } catch {
      // The write below will surface the real filesystem failure.
    }
  }
  writeFileSync(filePath, payload, "utf8");
}

function writeFeedbackSummaryReport(report, resultsDir) {
  mkdirSync(resultsDir, { recursive: true });
  const safeTimestamp = report.generatedAt.replace(/[:.]/g, "-");
  const fileName = `feedback-summary-${safeTimestamp}.json`;
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  const target = join(resultsDir, fileName);
  safeWriteReportFile(target, payload);
  safeWriteReportFile(join(resultsDir, "feedback-latest.json"), payload);
  return {
    fileName: basename(target),
    latest: "feedback-latest.json",
  };
}

function runFeedbackSummary({ feedbackDir, resultsDir, timestamp } = {}) {
  const items = loadFeedbackItems(feedbackDir);
  const report = buildFeedbackSummaryReport({ items, timestamp });
  const output = resultsDir ? writeFeedbackSummaryReport(report, resultsDir) : null;
  return { report, output };
}

module.exports = {
  FALSE_CLAIM_FLAGS,
  buildFeedbackSummaryReport,
  loadFeedbackItems,
  runFeedbackSummary,
  validateFeedbackItem,
  writeFeedbackSummaryReport,
};
