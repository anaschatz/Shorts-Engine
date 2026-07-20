const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { InMemoryArtifactRepository } = require("./artifact-repository.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("./ids.cjs");
const { LocalArtifactStore } = require("../storage/artifact-store.cjs");
const { contentHash } = require("../pipelines/narrated-short/contracts.cjs");

const JSON_CONTENT_ARTIFACT_TYPES = Object.freeze([
  "content_brief",
  "claim_ledger",
  "narrative_script",
  "storyboard",
  "approval_bundle",
  "narration_manifest",
  "narration_alignment",
  "caption_manifest",
  "audio_normalization_report",
  "timeline_ir",
  "animation_timing_context",
  "animation_scene_dsl_plan",
  "animation_plan",
  "animation_ir",
  "animation_render_manifest",
  "animation_qa_report",
  "render_manifest",
  "qa_report",
  "rights_manifest",
  "invalidation_report",
  "export_metadata",
  "provenance_report",
  "publish_approval",
]);
const MAX_CONTENT_ARTIFACT_BYTES = 512 * 1024;

function normalizeContentArtifactType(value) {
  const type = sanitizeText(value, 60).toLowerCase();
  if (!JSON_CONTENT_ARTIFACT_TYPES.includes(type)) {
    throw new AppError("ARTIFACT_TYPE_INVALID", SAFE_MESSAGES.ARTIFACT_TYPE_INVALID, 400);
  }
  return type;
}

function normalizeRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1 || revision > 1_000_000) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "revision" });
  }
  return revision;
}

function normalizeDependencyHashes(values) {
  const normalized = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => sanitizeText(value, 80).toLowerCase().replace(/^sha256:/, "")))]
    .filter((value) => /^[a-f0-9]{64}$/.test(value))
    .sort();
  if (normalized.length > 24) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "dependencyHashes" });
  }
  return normalized;
}

function checksum(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function canonicalBodyHash(body) {
  const canonical = jsonClone(body);
  const declared = canonical && typeof canonical.contentHash === "string" ? canonical.contentHash.toLowerCase() : null;
  if (canonical && typeof canonical === "object") delete canonical.contentHash;
  const calculated = contentHash(canonical);
  if (declared && declared !== calculated) {
    throw new AppError("ARTIFACT_CONTENT_INVALID", "Content body contains an invalid declared hash.", 409);
  }
  return calculated;
}

function validateEnvelope(envelope, record = null) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new AppError("ARTIFACT_CONTENT_INVALID", "Content artifact is invalid.", 409);
  }
  const artifactType = normalizeContentArtifactType(envelope.artifactType);
  const projectId = validateResourceId(envelope.projectId, "prj");
  const ownerJobId = envelope.ownerJobId ? validateResourceId(envelope.ownerJobId, "job") : null;
  const revision = normalizeRevision(envelope.revision);
  const bodyHash = canonicalBodyHash(envelope.body);
  if (bodyHash !== envelope.contentHash) {
    throw new AppError("ARTIFACT_CONTENT_INVALID", "Content artifact hash does not match its body.", 409);
  }
  if (record) {
    if (record.type !== artifactType || record.ownerProjectId !== projectId || (record.ownerJobId || null) !== ownerJobId) {
      throw new AppError("ARTIFACT_CONTENT_INVALID", "Content artifact ownership does not match its envelope.", 409);
    }
  }
  return {
    schemaVersion: 1,
    artifactType,
    projectId,
    ownerJobId,
    revision,
    contentHash: bodyHash,
    dependencyHashes: normalizeDependencyHashes(envelope.dependencyHashes),
    createdAt: sanitizeText(envelope.createdAt, 40),
    body: jsonClone(envelope.body),
  };
}

class ContentArtifactRepository {
  constructor(options = {}) {
    this.artifactStore = options.artifactStore || new LocalArtifactStore();
    this.artifactRepository = options.artifactRepository || new InMemoryArtifactRepository({ persist: false });
    this.clock = options.clock || nowIso;
  }

  createJson(input = {}) {
    const artifactType = normalizeContentArtifactType(input.type);
    const projectId = validateResourceId(input.projectId, "prj");
    const ownerJobId = input.jobId ? validateResourceId(input.jobId, "job") : null;
    const revision = normalizeRevision(input.revision);
    if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "body" });
    }
    const body = jsonClone(input.body);
    const bodyHash = canonicalBodyHash(body);
    const dependencyHashes = normalizeDependencyHashes(input.dependencyHashes);
    const envelope = {
      schemaVersion: 1,
      artifactType,
      projectId,
      ownerJobId,
      revision,
      contentHash: bodyHash,
      dependencyHashes,
      createdAt: this.clock(),
      body,
    };
    const identityHash = contentHash({ artifactType, projectId, revision, bodyHash, dependencyHashes });
    const artifactId = `art_${identityHash.slice(0, 40)}`;
    const existing = this.artifactRepository.get(artifactId);
    if (existing) return { artifact: existing, envelope: this.readJson(artifactId) };
    const buffer = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    if (buffer.byteLength > MAX_CONTENT_ARTIFACT_BYTES) {
      throw new AppError("FILE_TOO_LARGE", SAFE_MESSAGES.FILE_TOO_LARGE, 413);
    }
    const storageKey = `content/${projectId}/${artifactType}/${identityHash}.json`;
    const artifact = this.artifactStore.writeBuffer({
      id: artifactId,
      type: artifactType,
      ownerProjectId: projectId,
      ownerJobId,
      storageKey,
      contentType: "application/json",
      checksumSha256: checksum(buffer),
      buffer,
      status: "available",
    });
    this.artifactRepository.create(artifact);
    return { artifact, envelope: validateEnvelope(envelope, artifact) };
  }

  readJson(artifactId) {
    const record = this.artifactRepository.get(artifactId);
    if (!record) throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    normalizeContentArtifactType(record.type);
    const buffer = this.artifactStore.readArtifact(record, { maxBytes: MAX_CONTENT_ARTIFACT_BYTES });
    if (record.checksumSha256 && checksum(buffer) !== record.checksumSha256) {
      throw new AppError("ARTIFACT_CONTENT_INVALID", "Content artifact checksum is invalid.", 409);
    }
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new AppError("ARTIFACT_CONTENT_INVALID", "Content artifact JSON is invalid.", 409);
    }
    return validateEnvelope(parsed, record);
  }

  publicRecord(artifactId) {
    const record = this.artifactRepository.get(artifactId);
    if (!record) return null;
    const envelope = this.readJson(artifactId);
    return {
      artifact: this.artifactRepository.publicArtifact(record),
      artifactType: envelope.artifactType,
      revision: envelope.revision,
      contentHash: envelope.contentHash,
      dependencyHashes: envelope.dependencyHashes,
      createdAt: envelope.createdAt,
    };
  }
}

module.exports = {
  ContentArtifactRepository,
  JSON_CONTENT_ARTIFACT_TYPES,
  MAX_CONTENT_ARTIFACT_BYTES,
  normalizeContentArtifactType,
  validateContentArtifactEnvelope: validateEnvelope,
};
