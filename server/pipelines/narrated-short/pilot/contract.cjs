const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { sanitizeText, validateResourceId } = require("../../../repositories/ids.cjs");
const { contentHash } = require("../contracts.cjs");

const PILOT_PROFILE = "dark_curiosity_pilot_report_v1";
const PILOT_PROFILE_VERSION = "1.0.0";
const PILOT_STAGES = Object.freeze([
  "fixture_validated", "project_created", "draft_ready", "content_approved",
  "narration_uploaded", "narration_aligned", "preview_ready", "technical_final_staged",
  "technical_qa_passed", "evidence_packaged", "technical_final_committed", "pilot_complete",
]);
const PILOT_STATUSES = Object.freeze(["complete", "failed", "report_only"]);

function invalid(field) { throw new AppError("PILOT_REPORT_INVALID", SAFE_MESSAGES.PILOT_REPORT_INVALID, 409, { field }); }
function exact(value, keys, field) { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field); const allowed = new Set(keys); for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${field}.${key}`); }
function safeHash(value, field, optional = false) { if (optional && !value) return null; const safe = sanitizeText(value, 80).toLowerCase().replace(/^sha256:/, ""); if (!/^[a-f0-9]{64}$/.test(safe)) invalid(field); return safe; }
function safeArtifactId(value, field, optional = false) { if (optional && !value) return null; const safe = sanitizeText(value, 100); if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe)) invalid(field); return safe; }
function safeExportArtifactId(value, field, optional = false) { if (optional && !value) return null; const safe = sanitizeText(value, 100); if (!/^(?:art|exp)_[A-Za-z0-9-]{8,80}$/.test(safe)) invalid(field); return safe; }
function safeJobId(value, field) { const safe = sanitizeText(value, 100); if (!/^job_[A-Za-z0-9-]{8,80}$/.test(safe)) invalid(field); return safe; }

function artifactRef(value, field, optional = true) {
  if ((value === null || value === undefined) && optional) return null;
  exact(value, ["artifactId", "hash"], field);
  return { artifactId: safeArtifactId(value.artifactId, `${field}.artifactId`), hash: safeHash(value.hash, `${field}.hash`) };
}

function jobOutput(value, field) {
  if (!value) return null;
  exact(value, ["jobId", "exportArtifactId", "outputHash", "status"], field);
  const status = sanitizeText(value.status, 24).toLowerCase();
  if (!["completed", "failed"].includes(status)) invalid(`${field}.status`);
  return { jobId: safeJobId(value.jobId, `${field}.jobId`), exportArtifactId: safeExportArtifactId(value.exportArtifactId, `${field}.exportArtifactId`, status === "failed"), outputHash: safeHash(value.outputHash, `${field}.outputHash`, status === "failed"), status };
}

function normalizeReadiness(value) {
  exact(value, ["status", "environmentReady", "ffmpeg", "ffprobe", "renderer", "aligner", "managedStorage", "fixtureValid", "narrationAvailable", "rightsConfirmed", "previewCapable", "technicalFinalCapable", "blockingReasons", "nextActions"], "readiness");
  const status = sanitizeText(value.status, 24).toLowerCase();
  if (!["ready", "blocked", "report_only"].includes(status)) invalid("readiness.status");
  const booleans = ["environmentReady", "ffmpeg", "ffprobe", "renderer", "aligner", "managedStorage", "fixtureValid", "narrationAvailable", "rightsConfirmed", "previewCapable", "technicalFinalCapable"];
  const result = { status };
  for (const key of booleans) { if (typeof value[key] !== "boolean") invalid(`readiness.${key}`); result[key] = value[key]; }
  for (const key of ["blockingReasons", "nextActions"]) { if (!Array.isArray(value[key]) || value[key].length > 12) invalid(`readiness.${key}`); const items = value[key].map((item) => sanitizeText(item, 100)).filter(Boolean); if (items.length !== value[key].length || new Set(items).size !== items.length) invalid(`readiness.${key}`); result[key] = items; }
  return result;
}

function qaSummary(value) {
  if (!value) return null;
  exact(value, ["report", "blockingGateCount", "blockingPassedCount", "blockingFailedCount", "warningCount"], "qa");
  const counts = {};
  for (const key of ["blockingGateCount", "blockingPassedCount", "blockingFailedCount", "warningCount"]) { const count = Number(value[key]); if (!Number.isInteger(count) || count < 0 || count > 1000) invalid(`qa.${key}`); counts[key] = count; }
  if (counts.blockingPassedCount + counts.blockingFailedCount !== counts.blockingGateCount) invalid("qa.blockingGateCount");
  return { report: artifactRef(value.report, "qa.report", false), ...counts };
}

function failureSummary(value, status) {
  if (!value) { if (status === "failed") invalid("failure"); return null; }
  exact(value, ["stage", "code", "nextAction"], "failure");
  const stage = sanitizeText(value.stage, 60).toLowerCase(); const code = sanitizeText(value.code, 80).toUpperCase(); const nextAction = sanitizeText(value.nextAction, 120);
  if (![...PILOT_STAGES, "pilot_failed", "readiness"].includes(stage) || !/^[A-Z][A-Z0-9_]{2,79}$/.test(code) || !nextAction) invalid("failure");
  return { stage, code, nextAction };
}

function technicalBody(input) {
  const { startedAt: _startedAt, completedAt: _completedAt, durationMs: _durationMs, contentHash: _contentHash, ...technical } = input;
  return technical;
}

function normalizePilotReport(input = {}) {
  exact(input, ["schemaVersion", "profile", "profileVersion", "runId", "status", "projectId", "projectRevision", "fixture", "approvedDraft", "narrationManifest", "narrationAudio", "narrationAlignment", "preview", "final", "qa", "contactSheet", "rightsManifest", "provenanceReport", "exportMetadata", "completedStages", "failure", "readiness", "technicalFinal", "qaPassed", "publishable", "publishApprovalRequired", "startedAt", "completedAt", "durationMs", "contentHash"], "pilotReport");
  if (Number(input.schemaVersion) !== 1 || input.profile !== PILOT_PROFILE || input.profileVersion !== PILOT_PROFILE_VERSION) invalid("profile");
  const runId = sanitizeText(input.runId, 80).toLowerCase(); if (!/^pilot_[a-f0-9]{40}$/.test(runId)) invalid("runId");
  const status = sanitizeText(input.status, 24).toLowerCase(); if (!PILOT_STATUSES.includes(status)) invalid("status");
  const projectId = input.projectId ? validateResourceId(input.projectId, "prj") : null;
  const projectRevision = input.projectRevision == null ? null : Number(input.projectRevision); if (projectRevision !== null && (!Number.isInteger(projectRevision) || projectRevision < 1)) invalid("projectRevision");
  exact(input.fixture, ["fixtureId", "hash"], "fixture"); const fixture = { fixtureId: sanitizeText(input.fixture.fixtureId, 100), hash: safeHash(input.fixture.hash, "fixture.hash") }; if (!/^[A-Za-z0-9._-]{1,100}$/.test(fixture.fixtureId)) invalid("fixture.fixtureId");
  const completedStages = Array.isArray(input.completedStages) ? input.completedStages.map((value) => sanitizeText(value, 60).toLowerCase()) : invalid("completedStages");
  if (completedStages.length > PILOT_STAGES.length || new Set(completedStages).size !== completedStages.length || completedStages.some((stage, index) => stage !== PILOT_STAGES[index])) invalid("completedStages");
  const startedAt = sanitizeText(input.startedAt, 40); const completedAt = sanitizeText(input.completedAt, 40); const durationMs = Number(input.durationMs);
  if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(completedAt)) || !Number.isInteger(durationMs) || durationMs < 0 || durationMs > 86400000) invalid("runtime");
  const normalized = { schemaVersion: 1, profile: PILOT_PROFILE, profileVersion: PILOT_PROFILE_VERSION, runId, status, projectId, projectRevision, fixture, approvedDraft: artifactRef(input.approvedDraft, "approvedDraft"), narrationManifest: artifactRef(input.narrationManifest, "narrationManifest"), narrationAudio: artifactRef(input.narrationAudio, "narrationAudio"), narrationAlignment: artifactRef(input.narrationAlignment, "narrationAlignment"), preview: jobOutput(input.preview, "preview"), final: jobOutput(input.final, "final"), qa: qaSummary(input.qa), contactSheet: artifactRef(input.contactSheet, "contactSheet"), rightsManifest: artifactRef(input.rightsManifest, "rightsManifest"), provenanceReport: artifactRef(input.provenanceReport, "provenanceReport"), exportMetadata: artifactRef(input.exportMetadata, "exportMetadata"), completedStages, failure: failureSummary(input.failure, status), readiness: normalizeReadiness(input.readiness), technicalFinal: input.technicalFinal === true, qaPassed: input.qaPassed === true, publishable: false, publishApprovalRequired: true, startedAt, completedAt, durationMs };
  if (input.publishable !== false || input.publishApprovalRequired !== true) invalid("publishable");
  if (status === "complete" && (!normalized.technicalFinal || !normalized.qaPassed || completedStages.at(-1) !== "pilot_complete" || !normalized.final || !normalized.exportMetadata)) invalid("status");
  if (status !== "complete" && (normalized.technicalFinal || normalized.qaPassed)) invalid("technicalFinal");
  const calculated = contentHash(technicalBody(normalized)); if (input.contentHash && safeHash(input.contentHash, "contentHash") !== calculated) invalid("contentHash");
  return { ...normalized, contentHash: calculated };
}

function pilotRunId({ fixtureHash, audioHash = null, renderProfile = "final", operatorId = "local_operator" }) {
  const identity = contentHash({ profile: PILOT_PROFILE, profileVersion: PILOT_PROFILE_VERSION, fixtureHash: safeHash(fixtureHash, "fixtureHash"), audioHash: audioHash ? safeHash(audioHash, "audioHash") : null, renderProfile: sanitizeText(renderProfile, 24), operatorId: sanitizeText(operatorId, 80) });
  return `pilot_${identity.slice(0, 40)}`;
}

class PilotStateMachine {
  constructor(stages = []) { this.completed = []; this.failed = false; for (const stage of stages) this.transition(stage); }
  transition(stage) { const expected = PILOT_STAGES[this.completed.length]; if (this.failed || this.completed.at(-1) === "pilot_complete" || stage !== expected) throw new AppError("PILOT_STATE_INVALID", SAFE_MESSAGES.PILOT_STATE_INVALID, 409, { stage, expectedStage: expected }); this.completed.push(stage); return stage; }
  fail() { if (this.failed || this.completed.at(-1) === "pilot_complete") throw new AppError("PILOT_STATE_INVALID", SAFE_MESSAGES.PILOT_STATE_INVALID, 409); this.failed = true; return "pilot_failed"; }
}

module.exports = { PILOT_PROFILE, PILOT_PROFILE_VERSION, PILOT_STAGES, PilotStateMachine, normalizePilotReport, pilotRunId };
