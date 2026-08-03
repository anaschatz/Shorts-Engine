const { createHash, randomUUID } = require("node:crypto");
const { createWriteStream } = require("node:fs");
const { mkdir, open, unlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { AppError, SAFE_MESSAGES } = require("../../errors.cjs");
const {
  createCandidateEditPlans,
  detectHighlights,
  extractMediaSignals,
} = require("../../analysis.cjs");
const {
  buildFootballReviewCandidates,
  sourceRevisionFor,
} = require("./review/candidate-builder.cjs");

function persistenceMethod(persistence, method) {
  if (persistence && typeof persistence[method] === "function") {
    return persistence[method].bind(persistence);
  }
  if (persistence && typeof persistence.call === "function") {
    return (...args) => persistence.call(method, ...args);
  }
  throw new AppError(
    "ADAPTER_CONTRACT_INVALID",
    SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
    500,
  );
}

function readableBody(body) {
  if (body && typeof body.pipe === "function") return body;
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    return Readable.from(body);
  }
  throw new AppError(
    "CLOUD_STORAGE_FAILED",
    SAFE_MESSAGES.CLOUD_STORAGE_FAILED,
    502,
  );
}

function assertNotCancelled(signal) {
  if (signal && signal.aborted) {
    throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 499);
  }
}

function sourceExtension(contentType) {
  return {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
  }[String(contentType || "")] || "bin";
}

class FootballAnalysisService {
  constructor(options = {}) {
    this.persistence = options.persistence;
    this.reviewRepository = options.reviewRepository;
    this.store = options.store;
    this.extractMediaSignals = options.extractMediaSignals || extractMediaSignals;
    this.detectHighlights = options.detectHighlights || detectHighlights;
    this.createCandidateEditPlans = options.createCandidateEditPlans
      || createCandidateEditPlans;
    this.buildReviewCandidates = options.buildReviewCandidates
      || buildFootballReviewCandidates;
    this.randomUUID = options.randomUUID || randomUUID;
    this.stagingRoot = options.stagingRoot
      || join(tmpdir(), "shortsengine-football-analysis");
  }

  async analyze(job, context = {}) {
    const ownerId = String(job && job.ownerId || "");
    const uploadId = String(job && job.uploadId || "");
    const projectId = String(job && job.projectId || "");
    const signal = context.signal;
    assertNotCancelled(signal);
    const [source, project] = await Promise.all([
      persistenceMethod(
        this.persistence,
        "getAvailableUploadArtifactOwnedBy",
      )(uploadId, ownerId),
      persistenceMethod(this.persistence, "getProjectOwnedBy")(projectId, ownerId),
    ]);
    if (!source) {
      throw new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404);
    }
    if (!project) {
      throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
    }
    const metadata = source.metadata && typeof source.metadata === "object"
      ? source.metadata
      : {};
    const durationSeconds = Number(metadata.durationSeconds || 0);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new AppError(
        "VIDEO_DURATION_INVALID",
        SAFE_MESSAGES.VIDEO_DURATION_INVALID,
        422,
      );
    }

    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const stagePath = join(
      this.stagingRoot,
      `analysis-${this.randomUUID()}.${sourceExtension(source.contentType)}`,
    );
    let fileHandle = null;
    try {
      fileHandle = await open(stagePath, "wx", 0o600);
      const object = await this.store.getObjectStream(source.storageKey, { signal });
      const hash = createHash("sha256");
      let bytes = 0;
      const verifier = new Transform({
        transform(chunk, encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
          bytes += buffer.length;
          hash.update(buffer);
          callback(null, buffer);
        },
      });
      const output = createWriteStream(stagePath, {
        fd: fileHandle.fd,
        autoClose: false,
      });
      await pipeline(readableBody(object.body), verifier, output, { signal });
      await fileHandle.sync();
      assertNotCancelled(signal);
      const checksumSha256 = hash.digest("hex");
      if (
        bytes !== Number(source.byteSize)
        || source.checksumSha256
          && checksumSha256 !== String(source.checksumSha256).trim()
      ) {
        throw new AppError(
          "FILE_SIGNATURE_MISMATCH",
          SAFE_MESSAGES.FILE_SIGNATURE_MISMATCH,
          422,
        );
      }

      if (typeof context.update === "function") {
        await context.update({ progress: 25, step: "analyzing_football_signals" });
      }
      const mediaSignals = await this.extractMediaSignals({
        inputPath: stagePath,
        metadata,
        signal,
      });
      assertNotCancelled(signal);
      const highlights = this.detectHighlights({
        transcript: null,
        signals: mediaSignals,
        visualSignals: null,
        preset: "hype",
      });
      const candidatePlans = this.createCandidateEditPlans({
        moments: highlights.moments,
        metadata,
        mediaSignals,
        visualSignals: null,
        transcript: null,
        title: project.title,
        language: project.language || "auto",
        preset: "hype",
        styleTarget: "vertical_9_16",
        editIntensity: "balanced",
        stylePreset: "social_sports_v1",
        compositionMode: "single_moment",
      });
      const sourceRevision = sourceRevisionFor(
        { checksumSha256 },
        project.recordVersion,
      );
      const candidates = this.buildReviewCandidates({
        projectId,
        sourceJobId: job.id,
        sourceRevision,
        sourceDurationSeconds: durationSeconds,
        candidatePlans,
        reviewReasonCodes: [
          "production_signal_analysis",
          "human_review_required",
        ],
      });
      if (typeof context.update === "function") {
        await context.update({ progress: 80, step: "creating_football_review" });
      }
      const created = await this.reviewRepository.createReviewAndEnqueuePreviews({
        ownerId,
        projectId,
        sourceJobId: job.id,
        sourceUploadId: uploadId,
        sourceRevision,
        projectRevision: project.recordVersion,
        candidates,
        rightsConfirmed: true,
        traceparent: job.traceparent || null,
      });
      return {
        reviewId: created.review.id,
        previewJobId: created.job && created.job.id || null,
        sourceRevision,
        candidateCount: candidates.length,
      };
    } finally {
      if (fileHandle) await fileHandle.close().catch(() => {});
      await unlink(stagePath).catch(() => {});
    }
  }
}

module.exports = {
  FootballAnalysisService,
};
