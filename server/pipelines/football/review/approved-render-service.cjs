const { createHash, randomUUID } = require("node:crypto");
const { createReadStream, createWriteStream } = require("node:fs");
const { mkdir, open, stat, unlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { ffprobeJson, sha256 } = require("../../../media.cjs");
const { renderShort } = require("../../../render.cjs");
const {
  artifactStorageKey,
} = require("../../../storage/r2-artifact-store.cjs");
const {
  readableBody,
} = require("../../../storage/upload-validation-service.cjs");

function assertActive(signal) {
  if (signal && signal.aborted) {
    throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 499);
  }
}

function safeRenderFailure(error) {
  if (error instanceof AppError) return error;
  return new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500);
}

function validateApprovedOutput(probe) {
  const streams = Array.isArray(probe && probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const durationSeconds = Number(probe && probe.format && probe.format.duration);
  if (
    !video
    || video.codec_name !== "h264"
    || Number(video.width) !== 1080
    || Number(video.height) !== 1920
    || !Number.isFinite(durationSeconds)
    || durationSeconds < 0.25
    || durationSeconds > 90
  ) {
    throw new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500);
  }
  return {
    width: Number(video.width),
    height: Number(video.height),
    videoCodec: video.codec_name,
    durationSeconds: Number(durationSeconds.toFixed(3)),
  };
}

class FootballApprovedRenderService {
  constructor(options = {}) {
    if (!options.persistence || !options.store) {
      throw new AppError(
        "ADAPTER_CONTRACT_INVALID",
        SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
        500,
      );
    }
    this.persistence = options.persistence;
    this.store = options.store;
    this.render = options.render || renderShort;
    this.probe = options.probe || ffprobeJson;
    this.hashFile = options.hashFile || sha256;
    this.randomUUID = options.randomUUID || randomUUID;
    this.clock = options.clock || { now: () => Date.now() };
    this.stagingRoot = options.stagingRoot
      || join(tmpdir(), "shortsengine-football-exports");
  }

  async downloadSource(source, outputPath, signal) {
    const expectedChecksum = String(source.checksumSha256 || "");
    const hash = createHash("sha256");
    let bytes = 0;
    const handle = await open(outputPath, "wx", 0o600);
    try {
      const object = await this.store.getObjectStream(source.storageKey, {
        signal,
      });
      const inspector = new Transform({
        transform(chunk, encoding, callback) {
          const buffer = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk, encoding);
          bytes += buffer.length;
          hash.update(buffer);
          callback(null, buffer);
        },
      });
      await pipeline(
        readableBody(object.body),
        inspector,
        createWriteStream(outputPath, { fd: handle.fd, autoClose: false }),
        { signal },
      );
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    if (
      bytes !== Number(source.byteSize)
      || expectedChecksum && hash.digest("hex") !== expectedChecksum
    ) {
      throw new AppError(
        "SOURCE_CACHE_CHECKSUM_MISMATCH",
        SAFE_MESSAGES.SOURCE_CACHE_CHECKSUM_MISMATCH,
        422,
      );
    }
  }

  async renderApproved(job, context = {}) {
    const approval = job.payload
      && job.payload.footballReviewApproval;
    const approvedEditPlan = job.payload
      && job.payload.approvedEditPlan;
    if (
      !approval
      || !approvedEditPlan
      || approval.reviewId === undefined
      || approval.candidateId === undefined
      || approval.sourceRevision === undefined
      || approval.planHash === undefined
    ) {
      throw new AppError(
        "FOOTBALL_REVIEW_SOURCE_INVALID",
        SAFE_MESSAGES.FOOTBALL_REVIEW_SOURCE_INVALID,
        409,
      );
    }
    const source = await this.persistence.getAvailableUploadArtifactOwnedBy(
      job.uploadId,
      job.ownerId,
    );
    if (!source || source.projectId !== job.projectId) {
      throw new AppError(
        "FOOTBALL_REVIEW_SOURCE_INVALID",
        SAFE_MESSAGES.FOOTBALL_REVIEW_SOURCE_INVALID,
        409,
      );
    }
    assertActive(context.signal);
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const artifactId = `art_${this.randomUUID()}`;
    const exportId = `exp_${this.randomUUID()}`;
    const storageKey = artifactStorageKey({
      ownerId: job.ownerId,
      artifactId,
      purpose: "export",
      extension: "mp4",
    });
    const retentionUntil = new Date(
      this.clock.now() + 30 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const begun = await this.persistence.beginRenderArtifact({
      artifactId,
      ownerId: job.ownerId,
      projectId: job.projectId,
      jobId: job.id,
      workerId: job.workerId,
      leaseId: job.leaseId,
      storageKey,
      retentionUntil,
      metadata: {
        reviewId: approval.reviewId,
        candidateId: approval.candidateId,
        sourceRevision: approval.sourceRevision,
        planHash: approval.planHash,
      },
    });
    if (!begun) {
      throw new AppError(
        "JOB_LEASE_INVALID",
        SAFE_MESSAGES.JOB_LEASE_INVALID,
        409,
      );
    }
    const sourceExtension = source.contentType === "video/webm"
      ? "webm"
      : source.contentType === "video/quicktime"
        ? "mov"
        : "mp4";
    const sourcePath = join(
      this.stagingRoot,
      `source-${this.randomUUID()}.${sourceExtension}`,
    );
    const outputPath = join(
      this.stagingRoot,
      `export-${this.randomUUID()}.mp4`,
    );
    const subtitlesPath = join(
      this.stagingRoot,
      `captions-${this.randomUUID()}.ass`,
    );
    try {
      await this.downloadSource(source, sourcePath, context.signal);
      await context.update({ progress: 20, step: "rendering_approved_candidate" });
      const plan = JSON.parse(JSON.stringify(approvedEditPlan));
      plan.renderProfile = "quality";
      plan.aspectRatio = "9:16";
      plan.export = { width: 1080, height: 1920, fps: 30 };
      await this.render({
        inputPath: sourcePath,
        outputPath,
        subtitlesPath,
        plan,
        signal: context.signal,
        enhancementConfig: { enabled: false },
      });
      const media = validateApprovedOutput(await this.probe(outputPath));
      const file = await stat(outputPath);
      const checksumSha256 = this.hashFile(outputPath);
      await context.update({ progress: 80, step: "uploading_approved_render" });
      const head = await this.store.putObjectStream({
        storageKey,
        body: createReadStream(outputPath),
        byteSize: file.size,
        contentType: "video/mp4",
        metadata: {
          sha256: checksumSha256,
          planhash: approval.planHash,
          sourcerevision: approval.sourceRevision,
        },
        signal: context.signal,
      });
      if (
        Number(head.byteSize) !== file.size
        || head.contentType !== "video/mp4"
        || head.metadata.sha256 !== checksumSha256
        || head.metadata.planhash !== approval.planHash
        || head.metadata.sourcerevision !== approval.sourceRevision
      ) {
        throw new AppError(
          "CLOUD_STORAGE_FAILED",
          SAFE_MESSAGES.CLOUD_STORAGE_FAILED,
          502,
        );
      }
      const result = {
        exportId,
        artifactId,
        checksumSha256,
        byteSize: file.size,
        media,
      };
      const completed = await context.completeAtomically(
        result,
        async (transaction) => {
          await this.persistence.publishRenderExportInTransaction(
            transaction,
            {
              exportId,
              artifactId,
              ownerId: job.ownerId,
              projectId: job.projectId,
              jobId: job.id,
              fileName: `shortsengine-${job.projectId}.mp4`,
              checksumSha256,
              byteSize: file.size,
              metadata: {
                reviewId: approval.reviewId,
                candidateId: approval.candidateId,
                sourceRevision: approval.sourceRevision,
                planHash: approval.planHash,
                media,
              },
            },
          );
        },
      );
      if (completed.status !== "completed") {
        await this.persistence.failRenderArtifact({
          ownerId: job.ownerId,
          artifactId,
          operationId: `sop_${this.randomUUID()}`,
          errorCode: "JOB_CANCELLED",
        });
      }
      return result;
    } catch (error) {
      const safe = safeRenderFailure(error);
      await this.persistence.failRenderArtifact({
        ownerId: job.ownerId,
        artifactId,
        operationId: `sop_${this.randomUUID()}`,
        errorCode: safe.code,
      }).catch(() => {});
      throw safe;
    } finally {
      await unlink(sourcePath).catch(() => {});
      await unlink(outputPath).catch(() => {});
      await unlink(subtitlesPath).catch(() => {});
    }
  }
}

module.exports = {
  FootballApprovedRenderService,
  validateApprovedOutput,
};
