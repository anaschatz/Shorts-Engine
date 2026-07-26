const { createHash, randomUUID } = require("node:crypto");
const { createReadStream, createWriteStream } = require("node:fs");
const { mkdir, open, stat, unlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const {
  artifactStorageKey,
} = require("../../../storage/r2-artifact-store.cjs");
const {
  readableBody,
} = require("../../../storage/upload-validation-service.cjs");
const {
  renderFootballCandidatePreview,
} = require("./preview-renderer.cjs");

function assertActive(signal) {
  if (signal && signal.aborted) {
    throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 499);
  }
}

function safeFailure(error) {
  if (error instanceof AppError) return error;
  return new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500);
}

class FootballPreviewBatchService {
  constructor(options = {}) {
    if (
      !options.persistence
      || !options.reviewRepository
      || !options.store
    ) {
      throw new AppError(
        "ADAPTER_CONTRACT_INVALID",
        SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
        500,
      );
    }
    this.persistence = options.persistence;
    this.reviewRepository = options.reviewRepository;
    this.store = options.store;
    this.renderPreview = options.renderPreview || renderFootballCandidatePreview;
    this.randomUUID = options.randomUUID || randomUUID;
    this.clock = options.clock || { now: () => Date.now() };
    this.retentionSeconds = Math.max(
      300,
      Math.min(86_400, Number(options.retentionSeconds || 3_600)),
    );
    this.stagingRoot = options.stagingRoot
      || join(tmpdir(), "shortsengine-football-previews");
  }

  async downloadSource(source, sourcePath, signal) {
    const expectedChecksum = String(source.checksumSha256 || "").trim();
    const hash = createHash("sha256");
    let bytes = 0;
    const handle = await open(sourcePath, "wx", 0o600);
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
        createWriteStream(sourcePath, { fd: handle.fd, autoClose: false }),
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
    return bytes;
  }

  async renderCandidate({
    ownerId,
    review,
    candidate,
    sourcePath,
    jobId,
    signal,
  }) {
    assertActive(signal);
    const requestedArtifactId = `art_${this.randomUUID()}`;
    const requestedStorageKey = artifactStorageKey({
      ownerId,
      artifactId: requestedArtifactId,
      purpose: "preview",
      extension: "mp4",
    });
    const requestedExpiresAt = new Date(
      this.clock.now() + this.retentionSeconds * 1_000,
    ).toISOString();
    const outputPath = join(
      this.stagingRoot,
      `preview-${candidate.id}-${this.randomUUID()}.mp4`,
    );
    let begun = false;
    let artifactId = requestedArtifactId;
    let storageKey = requestedStorageKey;
    let expiresAt = requestedExpiresAt;
    try {
      const preview = await this.reviewRepository.beginCandidatePreview({
        ownerId,
        reviewId: review.id,
        candidateId: candidate.id,
        artifactId: requestedArtifactId,
        storageKey: requestedStorageKey,
        expiresAt: requestedExpiresAt,
        jobId,
      });
      artifactId = preview.artifactId;
      storageKey = preview.storageKey;
      expiresAt = preview.expiresAt;
      begun = true;
      const rendered = await this.renderPreview({
        candidate,
        sourceDurationSeconds: Number(
          review.sourceDurationSeconds
          || candidate.sourceEnd,
        ),
        sourcePath,
        outputPath,
        signal,
      });
      assertActive(signal);
      const file = await stat(outputPath);
      const head = await this.store.putObjectStream({
        storageKey,
        body: createReadStream(outputPath),
        byteSize: file.size,
        contentType: "video/mp4",
        metadata: {
          sha256: rendered.manifest.checksumSha256,
          planhash: rendered.manifest.planHash,
          sourcerevision: rendered.manifest.sourceRevision,
        },
        signal,
      });
      if (
        Number(head.byteSize) !== file.size
        || head.contentType !== "video/mp4"
        || head.metadata.sha256 !== rendered.manifest.checksumSha256
        || head.metadata.planhash !== rendered.manifest.planHash
        || head.metadata.sourcerevision !== rendered.manifest.sourceRevision
      ) {
        throw new AppError(
          "CLOUD_STORAGE_FAILED",
          SAFE_MESSAGES.CLOUD_STORAGE_FAILED,
          502,
        );
      }
      const updated = await this.reviewRepository.publishCandidatePreview({
        ownerId,
        reviewId: review.id,
        candidateId: candidate.id,
        artifactId,
        checksumSha256: rendered.manifest.checksumSha256,
        byteSize: file.size,
        durationSeconds: rendered.manifest.durationSeconds,
        expiresAt,
        manifest: rendered.manifest,
      });
      return {
        candidateId: candidate.id,
        status: "ready",
        reviewStatus: updated.status,
        durationSeconds: rendered.manifest.durationSeconds,
      };
    } catch (error) {
      const safe = safeFailure(error);
      if (begun) {
        await this.reviewRepository.failCandidatePreview({
          ownerId,
          reviewId: review.id,
          candidateId: candidate.id,
          errorCode: safe.code,
        }).catch(() => {});
      }
      throw safe;
    } finally {
      await unlink(outputPath).catch(() => {});
    }
  }

  async renderBatch(input = {}) {
    const { ownerId, reviewId, jobId, signal } = input;
    assertActive(signal);
    const review = await this.reviewRepository.getOwnedReview(
      reviewId,
      ownerId,
    );
    if (
      !["preparing", "pending"].includes(review.status)
      || review.rightsConfirmed !== true
    ) {
      throw new AppError(
        "FOOTBALL_REVIEW_STATE_INVALID",
        SAFE_MESSAGES.FOOTBALL_REVIEW_STATE_INVALID,
        409,
      );
    }
    const source = await this.persistence.getAvailableUploadArtifactOwnedBy(
      review.sourceUploadId,
      ownerId,
    );
    if (!source || source.projectId !== review.projectId) {
      throw new AppError(
        "FOOTBALL_REVIEW_SOURCE_INVALID",
        SAFE_MESSAGES.FOOTBALL_REVIEW_SOURCE_INVALID,
        409,
      );
    }
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const extension = source.contentType === "video/webm"
      ? "webm"
      : source.contentType === "video/quicktime"
        ? "mov"
        : "mp4";
    const sourcePath = join(
      this.stagingRoot,
      `source-${this.randomUUID()}.${extension}`,
    );
    try {
      await this.downloadSource(source, sourcePath, signal);
      const results = [];
      for (const candidate of review.candidates) {
        if (candidate.preview.status === "ready") continue;
        assertActive(signal);
        results.push(await this.renderCandidate({
          ownerId,
          review,
          candidate,
          sourcePath,
          jobId,
          signal,
        }));
      }
      const current = await this.reviewRepository.getOwnedReview(
        reviewId,
        ownerId,
      );
      return {
        reviewId,
        status: current.status,
        readyPreviewCount: current.candidates.filter(
          (candidate) => candidate.preview.status === "ready",
        ).length,
        results,
      };
    } finally {
      await unlink(sourcePath).catch(() => {});
    }
  }
}

module.exports = {
  FootballPreviewBatchService,
};
