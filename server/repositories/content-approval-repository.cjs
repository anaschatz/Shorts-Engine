const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { storagePath, writeJsonAtomic } = require("../storage.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("./ids.cjs");
const { stableStringify } = require("../pipelines/narrated-short/contracts.cjs");

const APPROVAL_STATUSES = Object.freeze(["approved", "revoked"]);
const RENDER_PROFILES = Object.freeze(["preview", "final"]);
const APPROVAL_FILE_RE = /^capr_[a-f0-9]{40}\.json$/;
const MAX_APPROVAL_BYTES = 64 * 1024;

function approvalIdFor(value) {
  return `capr_${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 40)}`;
}

function normalizeArtifactId(value, field) {
  const safe = sanitizeText(value, 100);
  if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field });
  }
  return safe;
}

function normalizeHash(value, field) {
  const safe = sanitizeText(value, 80).toLowerCase().replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field });
  }
  return safe;
}

function normalizeApproval(record = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  const projectId = validateResourceId(record.projectId, "prj");
  const projectRevision = Number(record.projectRevision);
  if (!Number.isInteger(projectRevision) || projectRevision < 1 || projectRevision > 1_000_000) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "projectRevision" });
  }
  const draftArtifactId = normalizeArtifactId(record.draftArtifactId, "draftArtifactId");
  const draftHash = normalizeHash(record.draftHash, "draftHash");
  const status = sanitizeText(record.status || "approved", 24).toLowerCase();
  if (!APPROVAL_STATUSES.includes(status)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "status" });
  }
  const renderProfile = sanitizeText(record.renderProfile || "preview", 24).toLowerCase();
  if (!RENDER_PROFILES.includes(renderProfile)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "renderProfile" });
  }
  const voiceProfileId = sanitizeText(record.voiceProfileId || "voice_default", 80);
  const identity = { projectId, projectRevision, draftArtifactId, draftHash, voiceProfileId, renderProfile };
  const approvalId = record.approvalId || approvalIdFor(identity);
  if (!/^capr_[a-f0-9]{40}$/.test(approvalId)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  const approvedAt = sanitizeText(record.approvedAt || nowIso(), 40);
  if (!Number.isFinite(Date.parse(approvedAt))) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "approvedAt" });
  }
  let replacementApprovalId = null;
  if (status === "revoked" && record.replacementApprovalId) {
    replacementApprovalId = sanitizeText(record.replacementApprovalId, 100);
    if (!/^capr_[a-f0-9]{40}$/.test(replacementApprovalId)) {
      throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400, { field: "replacementApprovalId" });
    }
  }
  return {
    schemaVersion: 1,
    approvalId,
    projectId,
    projectRevision,
    draftArtifactId,
    draftHash,
    status,
    voiceProfileId,
    renderProfile,
    operatorNote: sanitizeText(record.operatorNote || "", 500),
    revokedReason: status === "revoked" ? sanitizeText(record.revokedReason || "revoked", 80) : null,
    replacementApprovalId,
    approvedAt,
    updatedAt: sanitizeText(record.updatedAt || approvedAt, 40),
  };
}

class ContentApprovalRepository {
  constructor(options = {}) {
    this.records = options.records || new Map();
    this.persist = options.persist !== false;
    this.dir = options.dir || CONFIG.contentApprovalDir;
    if (this.persist) mkdirSync(this.dir, { recursive: true });
  }

  pathFor(approvalId) {
    return storagePath("contentApprovals", `${approvalId}.json`);
  }

  save(record) {
    const approval = normalizeApproval(record);
    this.records.set(approval.approvalId, approval);
    if (this.persist) writeJsonAtomic(this.pathFor(approval.approvalId), approval);
    return approval;
  }

  approve(record) {
    const approval = normalizeApproval({ ...record, status: "approved" });
    const existing = this.records.get(approval.approvalId);
    if (existing) {
      if (existing.status === "approved" && JSON.stringify(existing) === JSON.stringify(approval)) return existing;
      if (existing.status === "approved" && existing.draftArtifactId === approval.draftArtifactId && existing.draftHash === approval.draftHash && existing.voiceProfileId === approval.voiceProfileId && existing.renderProfile === approval.renderProfile) return existing;
      throw new AppError("CONTENT_APPROVAL_CONFLICT", SAFE_MESSAGES.CONTENT_APPROVAL_CONFLICT, 409);
    }
    const active = [...this.records.values()].filter((value) => value.projectId === approval.projectId && value.projectRevision === approval.projectRevision && value.status === "approved");
    const sameDraftConflict = active.find((value) => value.draftArtifactId === approval.draftArtifactId && value.draftHash === approval.draftHash && (value.voiceProfileId !== approval.voiceProfileId || value.renderProfile !== approval.renderProfile));
    if (sameDraftConflict) throw new AppError("CONTENT_APPROVAL_CONFLICT", SAFE_MESSAGES.CONTENT_APPROVAL_CONFLICT, 409);
    for (const current of active) this.save({ ...current, status: "revoked", revokedReason: "superseded", replacementApprovalId: approval.approvalId, updatedAt: approval.approvedAt });
    return this.save(approval);
  }

  revoke(approvalId, updatedAt = nowIso(), metadata = {}) {
    const current = this.get(approvalId);
    if (!current) throw new AppError("RESOURCE_NOT_FOUND", "Content approval was not found.", 404);
    return this.save({ ...current, status: "revoked", revokedReason: metadata.reason || "revoked", replacementApprovalId: metadata.replacementApprovalId || null, updatedAt });
  }

  get(approvalId) {
    const safe = sanitizeText(approvalId, 100);
    if (!/^capr_[a-f0-9]{40}$/.test(safe)) {
      throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
    }
    return this.records.get(safe) || null;
  }

  findApproved(projectId, projectRevision) {
    const safeProjectId = validateResourceId(projectId, "prj");
    const matches = [...this.records.values()].filter((record) => (
      record.projectId === safeProjectId &&
      record.projectRevision === Number(projectRevision) &&
      record.status === "approved"
    ));
    if (matches.length > 1) throw new AppError("CONTENT_APPROVAL_STATE_INVALID", SAFE_MESSAGES.CONTENT_APPROVAL_STATE_INVALID, 409);
    return matches[0] || null;
  }

  publicApproval(record) {
    return record ? jsonClone(normalizeApproval(record)) : null;
  }

  recover() {
    if (!this.persist || !existsSync(this.dir)) return { records: 0, ignored: 0 };
    let records = 0;
    let ignored = 0;
    for (const fileName of readdirSync(this.dir).sort()) {
      if (!APPROVAL_FILE_RE.test(fileName)) {
        ignored += 1;
        continue;
      }
      try {
        const filePath = storagePath("contentApprovals", fileName);
        const stat = statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_APPROVAL_BYTES) throw new Error("invalid");
        const approval = normalizeApproval(JSON.parse(readFileSync(filePath, "utf8")));
        if (`${approval.approvalId}.json` !== fileName) throw new Error("invalid");
        this.records.set(approval.approvalId, approval);
        records += 1;
      } catch {
        ignored += 1;
      }
    }
    const groups = new Map();
    for (const record of this.records.values()) {
      if (record.status !== "approved") continue;
      const key = `${record.projectId}:${record.projectRevision}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    for (const recordsForRevision of groups.values()) {
      if (recordsForRevision.length < 2) continue;
      const ordered = recordsForRevision.sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt)) || b.approvalId.localeCompare(a.approvalId));
      const keeper = ordered[0];
      for (const stale of ordered.slice(1)) this.save({ ...stale, status: "revoked", revokedReason: "recovery_duplicate", replacementApprovalId: keeper.approvalId, updatedAt: keeper.approvedAt });
    }
    return { records, ignored };
  }
}

module.exports = {
  APPROVAL_STATUSES,
  ContentApprovalRepository,
  normalizeContentApproval: normalizeApproval,
};
