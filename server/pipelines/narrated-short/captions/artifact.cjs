const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { contentHash } = require("../contracts.cjs");
const { MAX_ASS_BYTES } = require("./ass-generator.cjs");

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }

function persistAssArtifact({ artifactStore, artifactRepository, projectId, projectRevision, jobId, captionManifestHash, alignmentHash, rendererVersion, buffer }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.byteLength > MAX_ASS_BYTES) throw new AppError("ASS_GENERATION_FAILED", SAFE_MESSAGES.ASS_GENERATION_FAILED, 409);
  const checksumSha256 = sha256(buffer);
  const identity = contentHash({ projectId, projectRevision, captionManifestHash, alignmentHash, rendererVersion, checksumSha256 });
  const id = `art_${identity.slice(0, 40)}`;
  const existing = artifactRepository.get(id);
  if (existing) {
    if (existing.type !== "caption_ass" || existing.checksumSha256 !== checksumSha256) throw new AppError("ARTIFACT_CONTENT_INVALID", SAFE_MESSAGES.ARTIFACT_CONTENT_INVALID, 409);
    return existing;
  }
  const artifact = artifactStore.writeBuffer({ id, type: "caption_ass", ownerProjectId: projectId, ownerJobId: jobId, storageKey: `content/${projectId}/caption_ass/${identity}.ass`, contentType: "text/x-ass", checksumSha256, buffer, status: "available" });
  artifactRepository.create(artifact);
  return artifact;
}

module.exports = { persistAssArtifact };
