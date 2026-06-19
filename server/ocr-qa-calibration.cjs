const { existsSync, readFileSync, statSync } = require("node:fs");
const { isAbsolute, relative, resolve } = require("node:path");
const { sanitizeText } = require("./media.cjs");

const OCR_QA_REVIEW_LATEST_RELATIVE_PATH = "demo/results/ocr-qa-review-latest.json";
const MAX_OCR_QA_REPORT_BYTES = 512 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SUPPORT_LEVELS = Object.freeze(["ignore", "supporting", "strong"]);
const QUALITY_LEVELS = Object.freeze(["unknown", "low", "medium", "high"]);
const SAFE_STATUSES = Object.freeze(["missing", "skipped", "invalid", "stale", "available"]);
const SENSITIVE_RE =
  /\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout|rawOcr|rawText/i;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function safeStatus(value, fallback = "invalid") {
  const status = sanitizeText(value || fallback, 32);
  return SAFE_STATUSES.includes(status) ? status : fallback;
}

function safeSupportLevel(value) {
  const level = sanitizeText(value || "ignore", 32);
  return SUPPORT_LEVELS.includes(level) ? level : "ignore";
}

function safeQuality(value) {
  const quality = sanitizeText(value || "unknown", 32);
  return QUALITY_LEVELS.includes(quality) ? quality : "unknown";
}

function hasSensitiveLeak(value) {
  try {
    return SENSITIVE_RE.test(JSON.stringify(value || {}));
  } catch {
    return true;
  }
}

function supportWeightForLevel(level) {
  if (level === "strong") return 1;
  if (level === "supporting") return 0.65;
  return 0;
}

function defaultOcrQaCalibration(status = "missing") {
  const safe = safeStatus(status, "missing");
  return {
    schemaVersion: 1,
    status: safe,
    available: false,
    stale: safe === "stale",
    invalid: safe === "invalid",
    usable: false,
    decisionSupportLevel: "ignore",
    scoreboardCropQuality: "unknown",
    operatorDecision: "not_useful",
    goalEvidencePolicy: "support_only",
    goalDecisionAllowed: false,
    noFalseGoalFromOcrOnly: true,
    supportWeight: 0,
    generatedAt: null,
    reasonCode: `ocr_qa_${safe}`,
  };
}

function parsedTimestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeScores(scores) {
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) return null;
  return {
    visibilityScore: round(clamp(scores.visibilityScore, 0, 1)),
    readabilityScore: round(clamp(scores.readabilityScore, 0, 1)),
    usefulnessScore: round(clamp(scores.usefulnessScore, 0, 1)),
    decisionSupportScore: round(clamp(scores.decisionSupportScore, 0, 1)),
  };
}

function normalizeOcrQaCalibrationReport(report, options = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report) || hasSensitiveLeak(report)) {
    return defaultOcrQaCalibration("invalid");
  }
  if (report.skipped === true) return defaultOcrQaCalibration("skipped");

  const calibration = report.calibration && typeof report.calibration === "object" && !Array.isArray(report.calibration)
    ? report.calibration
    : null;
  if (
    report.status !== "passed" ||
    report.passed !== true ||
    !calibration ||
    calibration.goalEvidencePolicy !== "support_only" ||
    calibration.goalDecisionAllowed !== false ||
    calibration.noFalseGoalFromOcrOnly !== true
  ) {
    return defaultOcrQaCalibration("invalid");
  }

  const generatedAt = sanitizeText(report.generatedAt || report.timestamp || "", 80);
  const generatedAtMs = parsedTimestampMs(generatedAt);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const maxAgeMs = Math.max(60 * 1000, Number(options.maxAgeMs || DEFAULT_MAX_AGE_MS));
  if (!generatedAtMs || nowMs - generatedAtMs > maxAgeMs || generatedAtMs - nowMs > 60 * 60 * 1000) {
    return {
      ...defaultOcrQaCalibration("stale"),
      generatedAt: generatedAt || null,
    };
  }

  const decisionSupportLevel = safeSupportLevel(calibration.decisionSupportLevel);
  const scoreboardCropQuality = safeQuality(calibration.scoreboardCropQuality);
  const usable = decisionSupportLevel !== "ignore" && Boolean(calibration.ocrEvidenceUsable);
  const status = usable ? "available" : "skipped";
  return {
    schemaVersion: 1,
    status,
    available: usable,
    stale: false,
    invalid: false,
    usable,
    decisionSupportLevel: usable ? decisionSupportLevel : "ignore",
    scoreboardCropQuality,
    operatorDecision: sanitizeText(calibration.operatorDecision || "not_useful", 32) || "not_useful",
    goalEvidencePolicy: "support_only",
    goalDecisionAllowed: false,
    noFalseGoalFromOcrOnly: true,
    supportWeight: usable ? supportWeightForLevel(decisionSupportLevel) : 0,
    generatedAt,
    scores: normalizeScores(report.scores),
    reasonCode: usable ? `ocr_qa_${decisionSupportLevel}` : "ocr_qa_ignored",
  };
}

function safeRootRelativePath(rootDir, relativePath) {
  const root = resolve(rootDir || process.cwd());
  const ref = sanitizeText(relativePath || OCR_QA_REVIEW_LATEST_RELATIVE_PATH, 160);
  if (!ref || ref.includes("..") || ref.includes("\\") || ref.includes("\u0000") || isAbsolute(ref)) {
    return null;
  }
  const target = resolve(root, ref);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return null;
  return target;
}

function loadOcrQaCalibration(options = {}) {
  const reportPath = safeRootRelativePath(options.rootDir, options.reportRef || OCR_QA_REVIEW_LATEST_RELATIVE_PATH);
  if (!reportPath) return defaultOcrQaCalibration("invalid");
  if (!existsSync(reportPath)) return defaultOcrQaCalibration("missing");
  try {
    const stat = statSync(reportPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OCR_QA_REPORT_BYTES) {
      return defaultOcrQaCalibration("invalid");
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    return normalizeOcrQaCalibrationReport(report, options);
  } catch {
    return defaultOcrQaCalibration("invalid");
  }
}

function publicOcrQaCalibration(calibration) {
  if (!calibration) calibration = defaultOcrQaCalibration("missing");
  let normalized;
  if (calibration && typeof calibration === "object" && calibration.schemaVersion === 1) {
    normalized = calibration;
  } else if (
    calibration &&
    typeof calibration === "object" &&
    !Array.isArray(calibration) &&
    calibration.goalEvidencePolicy === "support_only" &&
    calibration.goalDecisionAllowed === false &&
    calibration.noFalseGoalFromOcrOnly === true
  ) {
    normalized = {
      schemaVersion: 1,
      status: safeStatus(calibration.status, "missing"),
      available: Boolean(calibration.available),
      stale: Boolean(calibration.stale),
      invalid: Boolean(calibration.invalid),
      usable: Boolean(calibration.usable),
      decisionSupportLevel: safeSupportLevel(calibration.decisionSupportLevel),
      scoreboardCropQuality: safeQuality(calibration.scoreboardCropQuality),
      goalEvidencePolicy: "support_only",
      goalDecisionAllowed: false,
      noFalseGoalFromOcrOnly: true,
      supportWeight: calibration.usable ? supportWeightForLevel(safeSupportLevel(calibration.decisionSupportLevel)) : 0,
      generatedAt: calibration.generatedAt ? sanitizeText(calibration.generatedAt, 80) : null,
      reasonCode: sanitizeText(calibration.reasonCode || "ocr_qa_missing", 48),
    };
  } else {
    normalized = normalizeOcrQaCalibrationReport(calibration);
  }
  return {
    status: safeStatus(normalized.status, "missing"),
    available: Boolean(normalized.available),
    stale: Boolean(normalized.stale),
    invalid: Boolean(normalized.invalid),
    usable: Boolean(normalized.usable),
    decisionSupportLevel: safeSupportLevel(normalized.decisionSupportLevel),
    scoreboardCropQuality: safeQuality(normalized.scoreboardCropQuality),
    goalEvidencePolicy: "support_only",
    goalDecisionAllowed: false,
    noFalseGoalFromOcrOnly: true,
    supportWeight: round(clamp(normalized.supportWeight, 0, 1)),
    generatedAt: normalized.generatedAt ? sanitizeText(normalized.generatedAt, 80) : null,
    reasonCode: sanitizeText(normalized.reasonCode || "ocr_qa_missing", 48),
  };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  OCR_QA_REVIEW_LATEST_RELATIVE_PATH,
  defaultOcrQaCalibration,
  loadOcrQaCalibration,
  normalizeOcrQaCalibrationReport,
  publicOcrQaCalibration,
};
