const { createHash, timingSafeEqual } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { storagePath, writeJsonAtomic } = require("../storage.cjs");
const { sanitizeText, validateResourceId } = require("./ids.cjs");
const { normalizePublishApproval, publicPublishApproval } = require("../pipelines/narrated-short/publish/contract.cjs");

const STORE_FILE = "publish-approvals-v1.json";
const STATE_STATUSES = Object.freeze(["active", "expired", "revoked", "superseded"]);
function tokenDigest(token) { return createHash("sha256").update(String(token)).digest("hex"); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function normalizeRecord(input = {}) {
  const body = normalizePublishApproval(input.body);
  const stateStatus = sanitizeText(input.stateStatus || "active", 24).toLowerCase(); if (!STATE_STATUSES.includes(stateStatus)) throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 409);
  const approvalArtifactId = sanitizeText(input.approvalArtifactId, 100); if (!/^art_[A-Za-z0-9-]{8,80}$/.test(approvalArtifactId)) throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 409);
  const approvalArtifactHash = sanitizeText(input.approvalArtifactHash, 80).toLowerCase(); if (!/^[a-f0-9]{64}$/.test(approvalArtifactHash) || approvalArtifactHash !== body.contentHash) throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 409);
  const supersededBy = input.supersededBy ? sanitizeText(input.supersededBy, 100) : null; if (supersededBy && !/^papr_[a-f0-9]{40}$/.test(supersededBy)) throw new AppError("PUBLISH_APPROVAL_INVALID", SAFE_MESSAGES.PUBLISH_APPROVAL_INVALID, 409);
  return { body, approvalArtifactId, approvalArtifactHash, stateStatus, supersededBy, updatedAt: sanitizeText(input.updatedAt || body.issuedAt, 40) };
}

class PublishApprovalRepository {
  constructor(options = {}) { this.records = options.records || new Map(); this.persist = options.persist !== false; this.filePath = options.filePath || storagePath("data", STORE_FILE); }
  snapshot(records = this.records) { return { schemaVersion: 1, records: [...records.values()].map(clone).sort((a, b) => a.body.approvalId.localeCompare(b.body.approvalId)) }; }
  commit(next) { if (this.persist) writeJsonAtomic(this.filePath, this.snapshot(next)); this.records = next; }
  snapshotState() { return new Map([...this.records].map(([key, value]) => [key, clone(value)])); }
  restoreState(snapshot) { const next = new Map([...snapshot].map(([key, value]) => [key, clone(value)])); this.commit(next); }
  activate(input) {
    const record = normalizeRecord(input); const id = record.body.approvalId; const existing = this.records.get(id);
    if (existing) {
      if (existing.body.requestHash === record.body.requestHash && existing.body.releaseTokenHash === record.body.releaseTokenHash) return { record: existing, replayed: true };
      throw new AppError("PUBLISH_APPROVAL_CONFLICT", SAFE_MESSAGES.PUBLISH_APPROVAL_CONFLICT, 409);
    }
    const active = [...this.records.values()].filter((value) => value.stateStatus === "active" && value.body.projectId === record.body.projectId && value.body.projectRevision === record.body.projectRevision);
    const idempotencyConflict = active.find((value) => value.body.idempotencyKeyHash === record.body.idempotencyKeyHash && value.body.requestHash !== record.body.requestHash);
    if (idempotencyConflict) throw new AppError("PUBLISH_APPROVAL_CONFLICT", SAFE_MESSAGES.PUBLISH_APPROVAL_CONFLICT, 409);
    const keyConflict = active.find((value) => value.body.requestHash !== record.body.requestHash && value.body.finalOutput.hash === record.body.finalOutput.hash);
    if (keyConflict) throw new AppError("PUBLISH_APPROVAL_CONFLICT", SAFE_MESSAGES.PUBLISH_APPROVAL_CONFLICT, 409);
    const next = new Map(this.records);
    for (const previous of active) next.set(previous.body.approvalId, { ...previous, stateStatus: "superseded", supersededBy: id, updatedAt: record.body.issuedAt });
    next.set(id, record); this.commit(next); return { record, replayed: false };
  }
  findActive(projectId, revision, outputHash = null) {
    const safeProjectId = validateResourceId(projectId, "prj"); const matches = [...this.records.values()].filter((value) => value.stateStatus === "active" && value.body.projectId === safeProjectId && value.body.projectRevision === Number(revision) && (!outputHash || value.body.finalOutput.hash === outputHash));
    if (matches.length > 1) throw new AppError("PUBLISH_APPROVAL_CONFLICT", SAFE_MESSAGES.PUBLISH_APPROVAL_CONFLICT, 409); return matches[0] || null;
  }
  expire(approvalId, at = new Date().toISOString()) { const current = this.records.get(approvalId); if (!current || current.stateStatus !== "active") return current || null; const next = new Map(this.records); next.set(approvalId, { ...current, stateStatus: "expired", updatedAt: at }); this.commit(next); return next.get(approvalId); }
  revokeRevision(projectId, revision, reason = "revision_invalidated", at = new Date().toISOString()) {
    const safeProjectId = validateResourceId(projectId, "prj"); const next = new Map(this.records); let count = 0;
    for (const [id, record] of next) if (record.stateStatus === "active" && record.body.projectId === safeProjectId && record.body.projectRevision === Number(revision)) { next.set(id, { ...record, stateStatus: "revoked", supersededBy: null, updatedAt: at, revocationReason: sanitizeText(reason, 80) }); count += 1; }
    if (count) this.commit(next); return count;
  }
  verifyToken({ projectId, revision, outputHash, token, now = new Date() }) {
    const record = this.findActive(projectId, revision); if (!record) throw new AppError("RELEASE_TOKEN_REVOKED", SAFE_MESSAGES.RELEASE_TOKEN_REVOKED, 409);
    if (record.body.finalOutput.hash !== outputHash) throw new AppError("RELEASE_TOKEN_OUTPUT_MISMATCH", SAFE_MESSAGES.RELEASE_TOKEN_OUTPUT_MISMATCH, 409);
    if (Date.parse(record.body.expiresAt) <= now.getTime()) throw new AppError("RELEASE_TOKEN_EXPIRED", SAFE_MESSAGES.RELEASE_TOKEN_EXPIRED, 409, { expiresAt: record.body.expiresAt });
    const supplied = Buffer.from(tokenDigest(token), "hex"); const expected = Buffer.from(record.body.releaseTokenHash, "hex"); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AppError("RELEASE_TOKEN_INVALID", SAFE_MESSAGES.RELEASE_TOKEN_INVALID, 403);
    return record;
  }
  recover() {
    if (!this.persist || !existsSync(this.filePath)) return { records: 0, ignored: 0 };
    let parsed; try { parsed = JSON.parse(readFileSync(this.filePath, "utf8")); } catch { return { records: 0, ignored: 1 }; }
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) return { records: 0, ignored: 1 };
    const next = new Map(); let ignored = 0;
    for (const item of parsed.records.slice(0, 10000)) { try { const record = normalizeRecord(item); next.set(record.body.approvalId, record); } catch { ignored += 1; } }
    const groups = new Map(); for (const record of next.values()) if (record.stateStatus === "active") { const key = `${record.body.projectId}:${record.body.projectRevision}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(record); }
    for (const group of groups.values()) if (group.length > 1) { group.sort((a, b) => b.body.issuedAt.localeCompare(a.body.issuedAt) || b.body.approvalId.localeCompare(a.body.approvalId)); for (const stale of group.slice(1)) next.set(stale.body.approvalId, { ...stale, stateStatus: "superseded", supersededBy: group[0].body.approvalId, updatedAt: group[0].body.issuedAt }); }
    this.records = next; if (this.persist && ignored === 0) this.commit(next); return { records: next.size, ignored };
  }
  publicRecord(record) { return record ? publicPublishApproval(record) : null; }
}

module.exports = { PublishApprovalRepository, normalizePublishApprovalRecord: normalizeRecord, tokenDigest };
