const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { sanitizeText, validateResourceId } = require("../../../repositories/ids.cjs");
const { contentHash } = require("../contracts.cjs");

const PUBLISH_PROFILE = "dark_curiosity_publish_approval_v1";
const PUBLISH_PROFILE_VERSION = "1.0.0";
const WARNING_CODES = Object.freeze(["DISCLOSURE_REVIEW_REQUIRED", "READING_RATE_NEAR_LIMIT", "SCRIPT_SIMILARITY_WARNING", "SOURCE_DIVERSITY_WARNING", "VISUAL_STASIS_WARNING"]);
const REF_KEYS = Object.freeze(["artifactId", "hash"]);
const REF_FIELDS = Object.freeze(["approvedDraft", "narrationManifest", "narrationAudio", "narrationAlignment", "renderManifest", "finalOutput", "qaReport", "contactSheet", "rightsManifest", "provenanceReport", "exportMetadata"]);

function fail(field) { throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 409, { field }); }
function exact(value, keys, field) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(field); const allowed = new Set(keys); for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field}.${key}`); }
function hash(value, field) { const safe = sanitizeText(value, 80).toLowerCase().replace(/^sha256:/, ""); if (!/^[a-f0-9]{64}$/.test(safe)) fail(field); return safe; }
function artifactId(value, field) { const safe = sanitizeText(value, 100); if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe) && !/^exp_[A-Za-z0-9-]{8,80}$/.test(safe)) fail(field); return safe; }
function ref(value, field) { exact(value, REF_KEYS, field); return { artifactId: artifactId(value.artifactId, `${field}.artifactId`), hash: hash(value.hash, `${field}.hash`) }; }
function iso(value, field) { const safe = sanitizeText(value, 40); if (!Number.isFinite(Date.parse(safe))) fail(field); return safe; }

function normalizeWarnings(values = []) {
  if (!Array.isArray(values) || values.length > WARNING_CODES.length) throw new AppError("PUBLISH_WARNING_INVALID", SAFE_MESSAGES.PUBLISH_WARNING_INVALID, 409);
  const normalized = values.map((value) => sanitizeText(value, 80).toUpperCase()).sort();
  if (normalized.some((value) => !WARNING_CODES.includes(value)) || new Set(normalized).size !== normalized.length) throw new AppError("PUBLISH_WARNING_INVALID", SAFE_MESSAGES.PUBLISH_WARNING_INVALID, 409);
  return normalized;
}

function normalizePublishApproval(input = {}) {
  exact(input, ["schemaVersion", "profile", "profileVersion", "approvalId", "projectId", "projectRevision", "contentApprovalId", ...REF_FIELDS, "warningAcknowledgements", "operatorIdentityHash", "operatorNote", "decision", "issuedAt", "expiresAt", "releaseTokenHash", "requestHash", "idempotencyKeyHash", "status", "contentHash"], "publishApproval");
  if (Number(input.schemaVersion) !== 1 || input.profile !== PUBLISH_PROFILE || input.profileVersion !== PUBLISH_PROFILE_VERSION || input.decision !== "approve" || input.status !== "active") fail("profile");
  const approvalId = sanitizeText(input.approvalId, 100); if (!/^papr_[a-f0-9]{40}$/.test(approvalId)) fail("approvalId");
  const contentApprovalId = sanitizeText(input.contentApprovalId, 100); if (!/^capr_[a-f0-9]{40}$/.test(contentApprovalId)) fail("contentApprovalId");
  const projectRevision = Number(input.projectRevision); if (!Number.isInteger(projectRevision) || projectRevision < 1) fail("projectRevision");
  const issuedAt = iso(input.issuedAt, "issuedAt"); const expiresAt = iso(input.expiresAt, "expiresAt"); const ttl = Date.parse(expiresAt) - Date.parse(issuedAt); if (ttl < 300000 || ttl > 1800000) fail("expiresAt");
  const normalized = { schemaVersion: 1, profile: PUBLISH_PROFILE, profileVersion: PUBLISH_PROFILE_VERSION, approvalId, projectId: validateResourceId(input.projectId, "prj"), projectRevision, contentApprovalId };
  for (const field of REF_FIELDS) normalized[field] = ref(input[field], field);
  Object.assign(normalized, { warningAcknowledgements: normalizeWarnings(input.warningAcknowledgements), operatorIdentityHash: hash(input.operatorIdentityHash, "operatorIdentityHash"), operatorNote: sanitizeText(input.operatorNote || "", 500), decision: "approve", issuedAt, expiresAt, releaseTokenHash: hash(input.releaseTokenHash, "releaseTokenHash"), requestHash: hash(input.requestHash, "requestHash"), idempotencyKeyHash: hash(input.idempotencyKeyHash, "idempotencyKeyHash"), status: "active" });
  const calculated = contentHash(normalized); if (input.contentHash && input.contentHash !== calculated) fail("contentHash"); return { ...normalized, contentHash: calculated };
}

function publicPublishApproval(record) {
  const body = normalizePublishApproval(record.body || record);
  return { publishApprovalId: body.approvalId, projectId: body.projectId, projectRevision: body.projectRevision, outputHash: body.finalOutput.hash, expiresAt: body.expiresAt, status: record.stateStatus || body.status, warningAcknowledgements: body.warningAcknowledgements, approvalArtifactId: record.approvalArtifactId || null, approvalArtifactHash: record.approvalArtifactHash || body.contentHash };
}

module.exports = { PUBLISH_PROFILE, PUBLISH_PROFILE_VERSION, WARNING_CODES, normalizePublishApproval, normalizeWarnings, publicPublishApproval };
