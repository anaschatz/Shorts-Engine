const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { sanitizeText, validateResourceId } = require("../../../repositories/ids.cjs");
const { contentHash } = require("../contracts.cjs");

const QA_PROFILE = "dark_curiosity_technical_v1";
const QA_PROFILE_VERSION = "1.0.0";
const REQUIRED_CATEGORIES = Object.freeze(["audio", "caption", "content", "rendered_video", "rights", "timeline"]);
const GATE_CODES = Object.freeze([
  "CONTENT_APPROVAL_EXACT", "CONTENT_DRAFT_HASH_VALID", "CONTENT_SCRIPT_HASH_VALID", "CONTENT_STORYBOARD_VALID", "CONTENT_CLAIMS_BOUND", "CONTENT_RISK_ALLOWED",
  "RIGHTS_NARRATION_COMMERCIAL", "RIGHTS_NARRATION_CONSENT", "RIGHTS_NARRATION_LICENSE", "RIGHTS_AUDIO_BINDING_VALID", "RIGHTS_VISUAL_ASSETS_ALLOWED", "RIGHTS_BACKGROUND_MUSIC_ABSENT",
  "AUDIO_ALIGNMENT_EXACT", "AUDIO_WORD_COVERAGE_COMPLETE", "AUDIO_DURATION_MATCH", "AUDIO_STREAM_PRESENT", "AUDIO_CODEC_VALID", "AUDIO_SAMPLE_RATE_VALID", "AUDIO_NORMALIZATION_PROFILE_VALID", "AUDIO_LOUDNESS_IN_RANGE", "AUDIO_BACKGROUND_MUSIC_ABSENT",
  "CAPTION_ALIGNMENT_EXACT", "CAPTION_WORD_COVERAGE_COMPLETE", "CAPTION_TIMINGS_VALID", "CAPTION_SAFE_ZONE_VALID", "CAPTION_FONT_VALID", "CAPTION_ASS_BOUND", "CAPTION_BURN_CONFIRMED",
  "TIMELINE_HASH_VALID", "TIMELINE_ALIGNED_MODE", "TIMELINE_DURATION_VALID", "TIMELINE_BEATS_VALID", "TIMELINE_SCENES_VALID", "TIMELINE_CAPTIONS_VALID", "TIMELINE_TRACKS_COMPLETE",
  "VIDEO_FILE_READABLE", "VIDEO_CONTAINER_VALID", "VIDEO_DIMENSIONS_VALID", "VIDEO_FPS_VALID", "VIDEO_CODEC_VALID", "VIDEO_PIXEL_FORMAT_VALID", "VIDEO_DURATION_MATCH", "VIDEO_BLACK_OUTPUT_ABSENT", "VIDEO_EXCESSIVE_FREEZE_ABSENT", "VIDEO_AUDIO_NOT_SILENT",
  "WARNING_READING_RATE", "WARNING_CAPTION_DENSITY", "WARNING_VISUAL_STASIS", "WARNING_LOUDNESS_MARGIN", "WARNING_SOURCE_DIVERSITY",
]);
const BINDING_KEYS = Object.freeze(["draftArtifactId", "draftHash", "scriptHash", "narrationManifestArtifactId", "narrationManifestHash", "audioArtifactId", "audioHash", "alignmentArtifactId", "alignmentHash", "captionManifestArtifactId", "captionManifestHash", "captionAssArtifactId", "captionAssHash", "audioNormalizationReportArtifactId", "audioNormalizationReportHash", "timelineArtifactId", "timelineHash", "outputHash"]);
const DETAIL_KEYS = Object.freeze(["expected", "actual", "ratio", "seconds", "count", "limit", "profile", "mode"]);

function fail(field = "qa") { throw new AppError("QA_REPORT_INVALID", SAFE_MESSAGES.QA_REPORT_INVALID, 409, { field }); }
function exactKeys(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) fail(`${field}.${key}`);
}
function artifactId(value, field) { const safe = sanitizeText(value, 100); if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe)) fail(field); return safe; }
function hash(value, field) { const safe = sanitizeText(value, 80).toLowerCase(); if (!/^[a-f0-9]{64}$/.test(safe)) fail(field); return safe; }
function detailValue(value, field) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) fail(field); return Number(value.toFixed(4)); }
  const safe = sanitizeText(value, 60); if (!safe) fail(field); return safe;
}
function normalizeGate(input, index) {
  exactKeys(input, ["code", "category", "severity", "passed", "details"], `gates[${index}]`);
  const code = sanitizeText(input.code, 80).toUpperCase();
  const category = sanitizeText(input.category, 40).toLowerCase();
  const severity = sanitizeText(input.severity, 20).toLowerCase();
  if (!GATE_CODES.includes(code) || ![...REQUIRED_CATEGORIES, "warning"].includes(category) || !["blocking", "warning"].includes(severity) || typeof input.passed !== "boolean") fail(`gates[${index}]`);
  if ((severity === "warning") !== (category === "warning")) fail(`gates[${index}].severity`);
  const details = input.details || {};
  exactKeys(details, DETAIL_KEYS, `gates[${index}].details`);
  return { code, category, severity, passed: input.passed, details: Object.fromEntries(Object.keys(details).sort().map((key) => [key, detailValue(details[key], `gates[${index}].details.${key}`)])) };
}

function normalizeQaReport(input = {}) {
  exactKeys(input, ["schemaVersion", "status", "decision", "projectId", "projectRevision", "verticalId", "renderProfile", "qaProfile", "qaProfileVersion", "bindings", "gates", "summary", "contentHash"], "qa");
  if (Number(input.schemaVersion) !== 1 || !["passed", "failed"].includes(input.status) || !["technical_qa_passed", "technical_qa_failed"].includes(input.decision) || input.verticalId !== "dark_curiosity" || !["preview", "final"].includes(input.renderProfile) || input.qaProfile !== QA_PROFILE || input.qaProfileVersion !== QA_PROFILE_VERSION) fail();
  exactKeys(input.bindings, BINDING_KEYS, "bindings");
  exactKeys(input.summary, ["blockingGateCount", "blockingPassedCount", "blockingFailedCount", "warningCount"], "summary");
  const bindings = {};
  for (const key of BINDING_KEYS) bindings[key] = key.endsWith("ArtifactId") ? artifactId(input.bindings[key], `bindings.${key}`) : hash(input.bindings[key], `bindings.${key}`);
  if (!Array.isArray(input.gates) || input.gates.length < REQUIRED_CATEGORIES.length || input.gates.length > 80) fail("gates");
  const gates = input.gates.map(normalizeGate).sort((a, b) => a.category.localeCompare(b.category) || a.code.localeCompare(b.code));
  if (new Set(gates.map((gate) => gate.code)).size !== gates.length) fail("gates.duplicate");
  for (const category of REQUIRED_CATEGORIES) if (!gates.some((gate) => gate.category === category && gate.severity === "blocking")) fail(`gates.${category}`);
  const blocking = gates.filter((gate) => gate.severity === "blocking");
  const blockingPassedCount = blocking.filter((gate) => gate.passed).length;
  const blockingFailedCount = blocking.length - blockingPassedCount;
  const warningCount = gates.filter((gate) => gate.severity === "warning" && !gate.passed).length;
  const summary = { blockingGateCount: Number(input.summary.blockingGateCount), blockingPassedCount: Number(input.summary.blockingPassedCount), blockingFailedCount: Number(input.summary.blockingFailedCount), warningCount: Number(input.summary.warningCount) };
  if (![summary.blockingGateCount, summary.blockingPassedCount, summary.blockingFailedCount, summary.warningCount].every(Number.isInteger) || summary.blockingGateCount !== blocking.length || summary.blockingPassedCount !== blockingPassedCount || summary.blockingFailedCount !== blockingFailedCount || summary.warningCount !== warningCount) fail("summary");
  const passed = blockingFailedCount === 0;
  if ((input.status === "passed") !== passed || (input.decision === "technical_qa_passed") !== passed) fail("decision");
  const normalized = { schemaVersion: 1, status: passed ? "passed" : "failed", decision: passed ? "technical_qa_passed" : "technical_qa_failed", projectId: validateResourceId(input.projectId, "prj"), projectRevision: Number(input.projectRevision), verticalId: "dark_curiosity", renderProfile: input.renderProfile, qaProfile: QA_PROFILE, qaProfileVersion: QA_PROFILE_VERSION, bindings, gates, summary };
  if (!Number.isInteger(normalized.projectRevision) || normalized.projectRevision < 1) fail("projectRevision");
  const calculated = contentHash(normalized);
  if (input.contentHash && input.contentHash !== calculated) fail("contentHash");
  return { ...normalized, contentHash: calculated };
}

function createQaReport({ projectId, projectRevision, renderProfile, bindings, gates }) {
  const normalizedGates = gates.map(normalizeGate).sort((a, b) => a.category.localeCompare(b.category) || a.code.localeCompare(b.code));
  const blocking = normalizedGates.filter((gate) => gate.severity === "blocking");
  const failed = blocking.filter((gate) => !gate.passed).length;
  return normalizeQaReport({ schemaVersion: 1, status: failed ? "failed" : "passed", decision: failed ? "technical_qa_failed" : "technical_qa_passed", projectId, projectRevision, verticalId: "dark_curiosity", renderProfile, qaProfile: QA_PROFILE, qaProfileVersion: QA_PROFILE_VERSION, bindings, gates: normalizedGates, summary: { blockingGateCount: blocking.length, blockingPassedCount: blocking.length - failed, blockingFailedCount: failed, warningCount: normalizedGates.filter((gate) => gate.severity === "warning" && !gate.passed).length } });
}
function gate(code, category, passed, details = {}) { return { code, category, severity: "blocking", passed: Boolean(passed), details }; }

module.exports = { BINDING_KEYS, GATE_CODES, QA_PROFILE, QA_PROFILE_VERSION, REQUIRED_CATEGORIES, createQaReport, gate, normalizeQaReport };
