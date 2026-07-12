const { createHash, randomBytes } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { sanitizeText } = require("../../../repositories/ids.cjs");
const { contentHash } = require("../contracts.cjs");
const { evaluatePublishGuard } = require("./publish-guard.cjs");
const { PUBLISH_PROFILE, PUBLISH_PROFILE_VERSION, normalizePublishApproval, normalizeWarnings, publicPublishApproval } = require("./contract.cjs");

const DEFAULT_RELEASE_TTL_SECONDS = 15 * 60;
const MIN_RELEASE_TTL_SECONDS = 5 * 60;
const MAX_RELEASE_TTL_SECONDS = 30 * 60;
function sha(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function exactRequest(input, keys) { if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 400); const allowed = new Set(keys); for (const key of Object.keys(input)) if (!allowed.has(key)) throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 400, { field: key }); }
function safeHash(value, field) { const safe = sanitizeText(value, 80).toLowerCase().replace(/^sha256:/, ""); if (!/^[a-f0-9]{64}$/.test(safe)) throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 400, { field }); return safe; }
function safeArtifact(value, field) { const safe = sanitizeText(value, 100); if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe)) throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 400, { field }); return safe; }

function normalizePublishRequest(input = {}) {
  exactRequest(input, ["expectedRevision", "finalOutputHash", "qaReportArtifactId", "qaReportHash", "exportMetadataArtifactId", "exportMetadataHash", "operatorDecision", "warningAcknowledgements", "operatorNote", "idempotencyKey"]);
  const expectedRevision = Number(input.expectedRevision); if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 400, { field: "expectedRevision" });
  if (input.operatorDecision !== "approve") throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 400, { field: "operatorDecision" });
  const idempotencyKey = sanitizeText(input.idempotencyKey || "", 160); if (idempotencyKey && !/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 400, { field: "idempotencyKey" });
  const operatorNote = sanitizeText(input.operatorNote || "", 500); if (/\/Users|\/private|storageKey|secret|token=/i.test(operatorNote)) throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 400, { field: "operatorNote" });
  return { expectedRevision, finalOutputHash: safeHash(input.finalOutputHash, "finalOutputHash"), qaReportArtifactId: safeArtifact(input.qaReportArtifactId, "qaReportArtifactId"), qaReportHash: safeHash(input.qaReportHash, "qaReportHash"), exportMetadataArtifactId: safeArtifact(input.exportMetadataArtifactId, "exportMetadataArtifactId"), exportMetadataHash: safeHash(input.exportMetadataHash, "exportMetadataHash"), operatorDecision: "approve", warningAcknowledgements: normalizeWarnings(input.warningAcknowledgements || []), operatorNote, idempotencyKey };
}

function createPublishApproval(input = {}, dependencies = {}) {
  const request = normalizePublishRequest(input.request); const { project, operatorId } = input; const { publishApprovalRepository: repository, contentArtifactRepository: content } = dependencies;
  if (!repository || !content) throw new AppError("PIPELINE_HANDLER_UNAVAILABLE", "Publish approval dependencies are unavailable.", 503);
  const requestHash = contentHash({ projectId: project.id, expectedRevision: request.expectedRevision, finalOutputHash: request.finalOutputHash, qaReportArtifactId: request.qaReportArtifactId, qaReportHash: request.qaReportHash, exportMetadataArtifactId: request.exportMetadataArtifactId, exportMetadataHash: request.exportMetadataHash, operatorDecision: request.operatorDecision, warningAcknowledgements: request.warningAcknowledgements, operatorNote: request.operatorNote });
  const now = dependencies.now ? dependencies.now() : new Date(); const idempotencyKeyHash = sha(request.idempotencyKey || requestHash); let existing = repository.findActive(project.id, request.expectedRevision, request.finalOutputHash);
  if (existing && Date.parse(existing.body.expiresAt) <= now.getTime()) { repository.expire(existing.body.approvalId, now.toISOString()); existing = null; }
  if (existing && existing.body.requestHash === requestHash && existing.body.idempotencyKeyHash === idempotencyKeyHash) return { record: existing, approval: repository.publicRecord(existing), releaseToken: null, replayed: true, guard: null };
  if (existing && existing.body.idempotencyKeyHash === idempotencyKeyHash && existing.body.requestHash !== requestHash) throw new AppError("PUBLISH_APPROVAL_CONFLICT", SAFE_MESSAGES.PUBLISH_APPROVAL_CONFLICT, 409);
  const guard = (dependencies.evaluatePublishGuard || evaluatePublishGuard)({ project, ...request }, { contentArtifacts: content, contentApprovalRepository: dependencies.contentApprovalRepository, artifactRepository: dependencies.artifactRepository, exportRepository: dependencies.exportRepository });
  const requestedTtl = Number(dependencies.releaseTtlSeconds); const ttlSeconds = Math.max(MIN_RELEASE_TTL_SECONDS, Math.min(Number.isFinite(requestedTtl) ? Math.floor(requestedTtl) : DEFAULT_RELEASE_TTL_SECONDS, MAX_RELEASE_TTL_SECONDS)); const issuedAt = now.toISOString(); const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const releaseToken = randomBytes(32).toString("base64url"); const releaseTokenHash = sha(releaseToken); const approvalId = `papr_${contentHash({ projectId: project.id, revision: project.input.revision, requestHash, issuedAt }).slice(0, 40)}`;
  const body = normalizePublishApproval({ schemaVersion: 1, profile: PUBLISH_PROFILE, profileVersion: PUBLISH_PROFILE_VERSION, approvalId, projectId: project.id, projectRevision: project.input.revision, contentApprovalId: guard.approval.approvalId, ...guard.refs, warningAcknowledgements: guard.warningAcknowledgements, operatorIdentityHash: sha(operatorId), operatorNote: request.operatorNote, decision: "approve", issuedAt, expiresAt, releaseTokenHash, requestHash, idempotencyKeyHash, status: "active" });
  const artifact = content.createJson({ type: "publish_approval", projectId: project.id, revision: project.input.revision, dependencyHashes: Object.values(guard.refs).map((value) => value.hash), body });
  const activated = repository.activate({ body, approvalArtifactId: artifact.artifact.id, approvalArtifactHash: artifact.envelope.contentHash, stateStatus: "active", updatedAt: issuedAt });
  return { record: activated.record, approval: publicPublishApproval(activated.record), releaseToken, replayed: false, guard };
}

function verifyReleaseEligibility(input = {}, dependencies = {}) {
  exactRequest(input.request, ["releaseToken", "outputHash"]); const token = String(input.request.releaseToken || ""); if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new AppError("RELEASE_TOKEN_INVALID", SAFE_MESSAGES.RELEASE_TOKEN_INVALID, 403);
  const outputHash = safeHash(input.request.outputHash, "outputHash"); const { project } = input; const record = dependencies.publishApprovalRepository.verifyToken({ projectId: project.id, revision: project.input.revision, outputHash, token, now: dependencies.now ? dependencies.now() : new Date() });
  const contentApproval = dependencies.contentApprovalRepository.findApproved(project.id, project.input.revision); if (!contentApproval || contentApproval.approvalId !== record.body.contentApprovalId || record.body.projectRevision !== project.input.revision) throw new AppError("RELEASE_ELIGIBILITY_STALE", SAFE_MESSAGES.RELEASE_ELIGIBILITY_STALE, 409);
  const artifact = dependencies.artifactRepository.get(record.body.finalOutput.artifactId); if (!artifact || artifact.status !== "available" || artifact.ownerProjectId !== project.id || artifact.checksumSha256 !== outputHash) throw new AppError("RELEASE_ELIGIBILITY_STALE", SAFE_MESSAGES.RELEASE_ELIGIBILITY_STALE, 409);
  return { eligible: true, projectId: project.id, projectRevision: project.input.revision, outputHash, expiresAt: record.body.expiresAt, publishApprovalId: record.body.approvalId, record, artifact };
}

module.exports = { DEFAULT_RELEASE_TTL_SECONDS, MAX_RELEASE_TTL_SECONDS, MIN_RELEASE_TTL_SECONDS, createPublishApproval, normalizePublishRequest, verifyReleaseEligibility };
