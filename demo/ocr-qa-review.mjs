import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OCR_ARTIFACTS_RELATIVE_DIR,
  OCR_QA_ARTIFACT_MANIFEST_FILE,
  RESULTS_DIR,
} from "./run-ocr-smoke.mjs";
import { findSensitiveLeak, safeError as safeReportError } from "./report-safety.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OCR_QA_REVIEW_LATEST_RELATIVE_PATH = "demo/results/ocr-qa-review-latest.json";
const MAX_REVIEW_INPUT_BYTES = 256 * 1024;
const MAX_REVIEW_CROPS = 12;
const MAX_NOTE_LENGTH = 160;
const REVIEW_SCHEMA_VERSION = 1;
const MANIFEST_RE = new RegExp(
  `^${OCR_ARTIFACTS_RELATIVE_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/ocr-[A-Za-z0-9._-]+/${OCR_QA_ARTIFACT_MANIFEST_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
);
const REVIEW_INPUT_KEYS = new Set(["manifestPath", "manifestRef", "crops", "operatorDecision"]);
const CROP_REVIEW_KEYS = new Set([
  "id",
  "scoreboardVisible",
  "clockVisible",
  "scoreVisible",
  "readable",
  "cropUsefulForDecision",
  "notes",
]);
const ALLOWED_OPERATOR_DECISIONS = new Set(["useful", "borderline", "not_useful"]);
const RAW_OCR_NOTE_RE = /(?:raw\s+ocr|ocr\s+text|stdout|stderr|token|secret|absolute path|storage key|provider output)/i;

class OcrQaReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OcrQaReviewError";
    this.code = code;
    this.details = details;
  }
}

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function timestampSlug(timestamp) {
  return String(timestamp).replace(/[:.]/g, "-");
}

function relativeFromRoot(filePath) {
  const target = resolve(filePath);
  const fromRoot = relative(ROOT_DIR, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot.includes("\\")) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_PATH_UNSAFE", "OCR QA review path is outside the project root.");
  }
  return fromRoot;
}

function safeReportRef(filePath) {
  try {
    return relativeFromRoot(filePath);
  } catch {
    return OCR_QA_REVIEW_LATEST_RELATIVE_PATH;
  }
}

function assertNoUnknownKeys(value, allowedKeys, code) {
  for (const key of Object.keys(value || {})) {
    if (!allowedKeys.has(key)) {
      throw new OcrQaReviewError(code, "OCR QA review contains an unsupported field.", { field: key });
    }
  }
}

function assertSafeReport(report) {
  const leak = findSensitiveLeak(report);
  if (leak) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_REPORT_LEAK", "OCR QA review report contains unsafe data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function parseJsonFile(filePath, { maxBytes, missingCode, invalidCode }) {
  if (!existsSync(filePath)) {
    throw new OcrQaReviewError(missingCode, "OCR QA review input file is missing.");
  }
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
    throw new OcrQaReviewError(invalidCode, "OCR QA review input file is empty or too large.");
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new OcrQaReviewError(invalidCode, "OCR QA review input file is not valid JSON.");
  }
}

function assertSafeRelativeRef(value, code = "OCR_QA_REVIEW_PATH_UNSAFE") {
  const text = String(value || "");
  if (
    !text ||
    text.includes("..") ||
    text.includes("\\") ||
    text.includes("\u0000") ||
    text.startsWith("/") ||
    /^[A-Za-z]:\\/.test(text) ||
    /^file:/i.test(text)
  ) {
    throw new OcrQaReviewError(code, "OCR QA review reference is unsafe.");
  }
  return text;
}

function validateManifestRelativeRef(value) {
  const ref = assertSafeRelativeRef(value, "OCR_QA_REVIEW_MANIFEST_REF_UNSAFE");
  if (!MANIFEST_RE.test(ref)) {
    throw new OcrQaReviewError(
      "OCR_QA_REVIEW_MANIFEST_REF_INVALID",
      "OCR QA review manifest must point at a managed OCR QA manifest.",
    );
  }
  return ref;
}

function validateManifestFileRecord(file, manifest) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_MANIFEST_INVALID", "OCR QA manifest crop record is invalid.");
  }
  const id = String(file.id || "");
  const relativePath = assertSafeRelativeRef(file.relativePath, "OCR_QA_REVIEW_MANIFEST_REF_UNSAFE");
  const prefix = `${manifest.directory}/`;
  if (
    !id ||
    id.length > 96 ||
    !relativePath.startsWith(prefix) ||
    !relativePath.endsWith(".png") ||
    findSensitiveLeak({ relativePath })
  ) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_MANIFEST_INVALID", "OCR QA manifest crop record is unsafe.");
  }
  return {
    id,
    kind: String(file.kind || "scoreboard_crop").slice(0, 48),
    sizeBytes: Math.max(0, Math.round(Number(file.sizeBytes || 0))),
    relativePath,
  };
}

function readOcrQaManifest(manifestRef) {
  const relativePath = validateManifestRelativeRef(manifestRef);
  const absolutePath = resolve(ROOT_DIR, relativePath);
  const manifest = parseJsonFile(absolutePath, {
    maxBytes: MAX_REVIEW_INPUT_BYTES,
    missingCode: "OCR_QA_REVIEW_MANIFEST_MISSING",
    invalidCode: "OCR_QA_REVIEW_MANIFEST_INVALID",
  });
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || findSensitiveLeak(manifest)) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_MANIFEST_INVALID", "OCR QA manifest is unsafe.");
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "ocr-crop-qa-artifacts" ||
    manifest.relativeRefsOnly !== true ||
    manifest.fullFramesStored !== false ||
    manifest.ocrTextStored !== false ||
    manifest.logsDownloaded !== false ||
    manifest.artifactsDownloaded !== false
  ) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_MANIFEST_INVALID", "OCR QA manifest contract is invalid.");
  }
  const directory = assertSafeRelativeRef(manifest.directory, "OCR_QA_REVIEW_MANIFEST_REF_UNSAFE");
  if (!relativePath.startsWith(`${directory}/`) || !directory.startsWith(`${OCR_ARTIFACTS_RELATIVE_DIR}/ocr-`)) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_MANIFEST_INVALID", "OCR QA manifest directory is invalid.");
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length > MAX_REVIEW_CROPS || Number(manifest.cropCount || 0) > MAX_REVIEW_CROPS) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_MANIFEST_TOO_LARGE", "OCR QA manifest has too many crop refs.");
  }
  const safeFiles = files.map((file) => validateManifestFileRecord(file, manifest));
  const ids = new Set(safeFiles.map((file) => file.id));
  if (ids.size !== safeFiles.length) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_MANIFEST_INVALID", "OCR QA manifest crop ids must be unique.");
  }
  return {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    relativePath,
    runId: String(manifest.runId || "").slice(0, 96),
    directory,
    cropCount: safeFiles.length,
    maxCropCount: Math.max(0, Math.round(Number(manifest.maxCropCount || MAX_REVIEW_CROPS))),
    maxArtifactBytes: Math.max(0, Math.round(Number(manifest.maxArtifactBytes || 0))),
    files: safeFiles,
  };
}

function sanitizeNote(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new OcrQaReviewError("OCR_QA_REVIEW_NOTE_INVALID", "OCR QA review notes must be strings.");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_NOTE_TOO_LONG", "OCR QA review notes are too long.");
  }
  const leak = findSensitiveLeak(trimmed);
  if (leak || RAW_OCR_NOTE_RE.test(trimmed)) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_NOTE_UNSAFE", "OCR QA review notes contain unsafe data.");
  }
  return trimmed || null;
}

function booleanField(value, field) {
  if (typeof value !== "boolean") {
    throw new OcrQaReviewError("OCR_QA_REVIEW_FIELD_INVALID", "OCR QA review crop fields must be booleans.", { field });
  }
  return value;
}

function validateCropReview(crop, manifestIds) {
  if (!crop || typeof crop !== "object" || Array.isArray(crop)) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_CROP_INVALID", "OCR QA review crop entry is invalid.");
  }
  assertNoUnknownKeys(crop, CROP_REVIEW_KEYS, "OCR_QA_REVIEW_FIELD_UNSUPPORTED");
  const id = String(crop.id || "");
  if (!manifestIds.has(id)) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_CROP_UNKNOWN", "OCR QA review crop id is not in the manifest.");
  }
  return {
    id,
    scoreboardVisible: booleanField(crop.scoreboardVisible, "scoreboardVisible"),
    clockVisible: booleanField(crop.clockVisible, "clockVisible"),
    scoreVisible: booleanField(crop.scoreVisible, "scoreVisible"),
    readable: booleanField(crop.readable, "readable"),
    cropUsefulForDecision: booleanField(crop.cropUsefulForDecision, "cropUsefulForDecision"),
    notes: sanitizeNote(crop.notes),
  };
}

function validateReviewInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_INPUT_INVALID", "OCR QA review input must be an object.");
  }
  assertNoUnknownKeys(input, REVIEW_INPUT_KEYS, "OCR_QA_REVIEW_FIELD_UNSUPPORTED");
  const manifest = readOcrQaManifest(input.manifestRef || input.manifestPath);
  const manifestIds = new Set(manifest.files.map((file) => file.id));
  const crops = Array.isArray(input.crops) ? input.crops : [];
  if (!crops.length || crops.length > MAX_REVIEW_CROPS || crops.length > manifest.cropCount) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_CROPS_INVALID", "OCR QA review crop count is invalid.");
  }
  const reviewed = crops.map((crop) => validateCropReview(crop, manifestIds));
  const ids = new Set(reviewed.map((crop) => crop.id));
  if (ids.size !== reviewed.length) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_CROP_DUPLICATE", "OCR QA review crop ids must be unique.");
  }
  const operatorDecision = input.operatorDecision === undefined || input.operatorDecision === null
    ? null
    : String(input.operatorDecision);
  if (operatorDecision && !ALLOWED_OPERATOR_DECISIONS.has(operatorDecision)) {
    throw new OcrQaReviewError("OCR_QA_REVIEW_DECISION_INVALID", "OCR QA review operator decision is invalid.");
  }
  return { manifest, crops: reviewed, operatorDecision };
}

function ratio(count, total) {
  if (!total) return 0;
  return Number((count / total).toFixed(4));
}

function scoreReviewCrops(crops) {
  const total = crops.length;
  const scoreboardVisible = crops.filter((crop) => crop.scoreboardVisible).length;
  const clockVisible = crops.filter((crop) => crop.clockVisible).length;
  const scoreVisible = crops.filter((crop) => crop.scoreVisible).length;
  const readable = crops.filter((crop) => crop.readable).length;
  const useful = crops.filter((crop) => crop.cropUsefulForDecision).length;
  const visibilityScore = Number(((ratio(scoreboardVisible, total) + ratio(clockVisible, total) + ratio(scoreVisible, total)) / 3).toFixed(4));
  const readabilityScore = ratio(readable, total);
  const usefulnessScore = ratio(useful, total);
  const decisionSupportScore = Number((visibilityScore * 0.25 + readabilityScore * 0.4 + usefulnessScore * 0.35).toFixed(4));
  return {
    visibilityScore,
    readabilityScore,
    usefulnessScore,
    decisionSupportScore,
    counts: {
      reviewed: total,
      scoreboardVisible,
      clockVisible,
      scoreVisible,
      readable,
      useful,
    },
  };
}

function defaultOperatorDecision(scores) {
  if (scores.decisionSupportScore >= 0.82 && scores.readabilityScore >= 0.8 && scores.usefulnessScore >= 0.8) {
    return "useful";
  }
  if (scores.decisionSupportScore >= 0.55 && scores.readabilityScore >= 0.5 && scores.usefulnessScore >= 0.5) {
    return "borderline";
  }
  return "not_useful";
}

function qualityForScores(scores) {
  if (scores.decisionSupportScore >= 0.82 && scores.readabilityScore >= 0.8 && scores.usefulnessScore >= 0.8) return "high";
  if (scores.decisionSupportScore >= 0.55 && scores.readabilityScore >= 0.5 && scores.usefulnessScore >= 0.5) return "medium";
  return "low";
}

function supportLevel({ quality, operatorDecision }) {
  if (operatorDecision === "not_useful" || quality === "low") return "ignore";
  if (operatorDecision === "borderline" || quality === "medium") return "supporting";
  return "strong";
}

function calibrationForReview({ scores, operatorDecision }) {
  const decision = operatorDecision || defaultOperatorDecision(scores);
  const scoreboardCropQuality = qualityForScores(scores);
  const decisionSupportLevel = supportLevel({ quality: scoreboardCropQuality, operatorDecision: decision });
  return {
    goalEvidencePolicy: "support_only",
    ocrEvidenceUsable: decisionSupportLevel !== "ignore",
    decisionSupportLevel,
    scoreboardCropQuality,
    operatorDecision: decision,
    goalDecisionAllowed: false,
    noFalseGoalFromOcrOnly: true,
    calibrationNotes: [
      decisionSupportLevel === "ignore"
        ? "Downweight or ignore OCR crops until readability and usefulness improve."
        : "Use OCR review as supporting evidence only, paired with football action evidence.",
      "OCR QA review must never promote OCR-only score changes into confirmed goals.",
    ],
  };
}

function publicReviewedCrop(crop) {
  return {
    id: crop.id,
    scoreboardVisible: crop.scoreboardVisible,
    clockVisible: crop.clockVisible,
    scoreVisible: crop.scoreVisible,
    readable: crop.readable,
    cropUsefulForDecision: crop.cropUsefulForDecision,
    notes: crop.notes,
  };
}

function buildOcrQaReviewReport(input, options = {}) {
  const timestamp = nowIso(options.nowMs);
  const validated = validateReviewInput(input);
  const scores = scoreReviewCrops(validated.crops);
  const calibration = calibrationForReview({
    scores,
    operatorDecision: validated.operatorDecision,
  });
  const report = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    timestamp,
    generatedAt: timestamp,
    command: "npm run ocr:qa:review",
    phase: "ocr-qa-review",
    status: "passed",
    passed: true,
    skipped: false,
    degraded: calibration.decisionSupportLevel !== "strong",
    nextAction: calibration.ocrEvidenceUsable
      ? "Use this OCR QA calibration only as support next to visual football evidence."
      : "Improve scoreboard crop visibility/readability before using OCR evidence in calibration.",
    manifest: {
      relativePath: validated.manifest.relativePath,
      runId: validated.manifest.runId,
      directory: validated.manifest.directory,
      cropCount: validated.manifest.cropCount,
      maxCropCount: validated.manifest.maxCropCount,
      maxArtifactBytes: validated.manifest.maxArtifactBytes,
    },
    cropCount: validated.manifest.cropCount,
    reviewedCropCount: validated.crops.length,
    scores,
    calibration,
    reviewedCrops: validated.crops.map(publicReviewedCrop),
    checks: [
      {
        name: "ocr_qa_review_report_safe",
        passed: true,
        required: true,
        status: "safe",
      },
      {
        name: "ocr_qa_review_support_only_goal_policy",
        passed: calibration.goalEvidencePolicy === "support_only" && calibration.goalDecisionAllowed === false,
        required: true,
        status: calibration.goalEvidencePolicy,
      },
      {
        name: "ocr_qa_review_no_raw_ocr_text",
        passed: true,
        required: true,
        status: "raw_text_omitted",
      },
    ],
    failedCases: [],
    limitations: [
      "Manual OCR QA review scores crop quality, not match truth.",
      "OCR remains supporting evidence and cannot confirm goals without football action evidence.",
    ],
    logsDownloaded: false,
    artifactsDownloaded: false,
    ocrTextStored: false,
    fullFramesStored: false,
  };
  assertSafeReport(report);
  return report;
}

function buildSkippedOcrQaReviewReport(options = {}) {
  const timestamp = nowIso(options.nowMs);
  const report = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    timestamp,
    generatedAt: timestamp,
    command: "npm run ocr:qa:review",
    phase: "ocr-qa-review-skipped",
    status: "passed",
    passed: true,
    skipped: true,
    degraded: false,
    nextAction: "Run SHORTSENGINE_OCR_QA_ARTIFACTS=1 npm run ocr:smoke, then pass a review JSON to npm run ocr:qa:review.",
    manifest: null,
    cropCount: 0,
    reviewedCropCount: 0,
    scores: null,
    calibration: {
      goalEvidencePolicy: "support_only",
      ocrEvidenceUsable: false,
      decisionSupportLevel: "ignore",
      scoreboardCropQuality: "unknown",
      operatorDecision: "not_useful",
      goalDecisionAllowed: false,
      noFalseGoalFromOcrOnly: true,
      calibrationNotes: ["No operator review input was provided; OCR QA review is skipped safely."],
    },
    checks: [
      {
        name: "ocr_qa_review_skipped_without_manual_input",
        passed: true,
        required: false,
        status: "skipped",
      },
    ],
    failedCases: [],
    limitations: ["Default release gates do not require manual OCR QA review."],
    logsDownloaded: false,
    artifactsDownloaded: false,
    ocrTextStored: false,
    fullFramesStored: false,
  };
  assertSafeReport(report);
  return report;
}

function writeOcrQaReviewReport(report, options = {}) {
  const resultsDir = resolve(options.resultsDir || RESULTS_DIR);
  mkdirSync(resultsDir, { recursive: true });
  const timestamp = timestampSlug(report.timestamp || nowIso(options.nowMs));
  const reportFile = `ocr-qa-review-${timestamp}.json`;
  const reportPath = resolve(resultsDir, reportFile);
  const latestPath = resolve(ROOT_DIR, OCR_QA_REVIEW_LATEST_RELATIVE_PATH);
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, payload);
  writeFileSync(latestPath, payload);
  return {
    reportPath: safeReportRef(reportPath),
    latestPath: safeReportRef(latestPath),
  };
}

function runOcrQaReview(input, options = {}) {
  const report = input ? buildOcrQaReviewReport(input, options) : buildSkippedOcrQaReviewReport(options);
  const paths = writeOcrQaReviewReport(report, options);
  return {
    ...report,
    reportPath: paths.reportPath,
    latestPath: paths.latestPath,
  };
}

function resolveInputFileRef(value) {
  const ref = assertSafeRelativeRef(value, "OCR_QA_REVIEW_INPUT_REF_UNSAFE");
  const target = resolve(ROOT_DIR, ref);
  relativeFromRoot(target);
  return target;
}

function runOcrQaReviewFromFile(inputFileRef, options = {}) {
  if (!inputFileRef) return runOcrQaReview(null, options);
  const inputPath = resolveInputFileRef(inputFileRef);
  const input = parseJsonFile(inputPath, {
    maxBytes: MAX_REVIEW_INPUT_BYTES,
    missingCode: "OCR_QA_REVIEW_INPUT_MISSING",
    invalidCode: "OCR_QA_REVIEW_INPUT_INVALID",
  });
  return runOcrQaReview(input, options);
}

function safeFailureReport(error, options = {}) {
  const timestamp = nowIso(options.nowMs);
  const report = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    timestamp,
    generatedAt: timestamp,
    command: "npm run ocr:qa:review",
    phase: "ocr-qa-review-failed",
    status: "failed",
    passed: false,
    skipped: false,
    degraded: true,
    nextAction: "Fix the OCR QA review input or regenerate the OCR QA manifest, then rerun npm run ocr:qa:review.",
    failedCases: [safeReportError(error)],
    logsDownloaded: false,
    artifactsDownloaded: false,
    ocrTextStored: false,
    fullFramesStored: false,
  };
  assertSafeReport(report);
  return report;
}

export {
  MAX_REVIEW_CROPS,
  OCR_QA_REVIEW_LATEST_RELATIVE_PATH,
  OcrQaReviewError,
  buildOcrQaReviewReport,
  buildSkippedOcrQaReviewReport,
  calibrationForReview,
  readOcrQaManifest,
  runOcrQaReview,
  runOcrQaReviewFromFile,
  safeFailureReport,
  scoreReviewCrops,
  validateManifestRelativeRef,
  validateReviewInput,
  writeOcrQaReviewReport,
};
