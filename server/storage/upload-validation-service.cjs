const { createHash, randomUUID } = require("node:crypto");
const { createWriteStream } = require("node:fs");
const { mkdir, open, unlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { probeMedia, validateSignature } = require("../media.cjs");

const CONTENT_TYPE_EXTENSIONS = Object.freeze({
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
});
const HEADER_CAPTURE_BYTES = 32;

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

function safeValidationError(error) {
  if (error instanceof AppError) return error;
  return new AppError(
    "CLOUD_STORAGE_FAILED",
    SAFE_MESSAGES.CLOUD_STORAGE_FAILED,
    502,
  );
}

const TERMINAL_VALIDATION_CODES = new Set([
  "FILE_SIGNATURE_MISMATCH",
  "FILE_SIGNATURE_UNSUPPORTED",
  "FILE_TYPE_UNSUPPORTED",
  "FILE_TOO_LARGE",
  "FILE_TOO_SMALL",
  "VIDEO_DURATION_INVALID",
  "VIDEO_TOO_LONG",
  "VIDEO_TOO_SHORT",
]);

function terminalValidationError(error) {
  return error instanceof AppError && TERMINAL_VALIDATION_CODES.has(error.code);
}

class UploadValidationService {
  constructor(options = {}) {
    this.persistence = options.persistence;
    this.store = options.store;
    this.jobQueue = options.jobQueue || null;
    this.probeMedia = options.probeMedia || probeMedia;
    this.validateSignature = options.validateSignature || validateSignature;
    this.randomUUID = options.randomUUID || randomUUID;
    this.stagingRoot = options.stagingRoot
      || join(tmpdir(), "shortsengine-upload-validation");
  }

  async validateUpload({ ownerId, uploadId, signal }) {
    assertNotCancelled(signal);
    const session = await persistenceMethod(
      this.persistence,
      "getMultipartUploadOwnedBy",
    )(uploadId, ownerId);
    if (!session || session.status !== "completed") {
      throw new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404);
    }
    const extension = CONTENT_TYPE_EXTENSIONS[session.contentType];
    if (!extension) {
      throw new AppError(
        "FILE_TYPE_UNSUPPORTED",
        SAFE_MESSAGES.FILE_TYPE_UNSUPPORTED,
        415,
      );
    }

    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const stagePath = join(
      this.stagingRoot,
      `validation-${this.randomUUID()}.${extension}`,
    );
    let fileHandle = null;
    let object = null;
    const hash = createHash("sha256");
    let bytes = 0;
    let header = Buffer.alloc(0);
    try {
      fileHandle = await open(stagePath, "wx", 0o600);
      object = await this.store.getObjectStream(session.storageKey, { signal });
      const inspector = new Transform({
        transform(chunk, encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
          bytes += buffer.length;
          hash.update(buffer);
          if (header.length < HEADER_CAPTURE_BYTES) {
            header = Buffer.concat([
              header,
              buffer.subarray(0, HEADER_CAPTURE_BYTES - header.length),
            ]);
          }
          callback(null, buffer);
        },
      });
      const output = createWriteStream(stagePath, {
        fd: fileHandle.fd,
        autoClose: false,
      });
      await pipeline(readableBody(object.body), inspector, output, { signal });
      await fileHandle.sync();
      assertNotCancelled(signal);
      if (bytes !== session.expectedByteSize) {
        throw new AppError(
          "FILE_SIGNATURE_MISMATCH",
          SAFE_MESSAGES.FILE_SIGNATURE_MISMATCH,
          422,
        );
      }
      const checksumSha256 = hash.digest("hex");
      if (
        session.expectedChecksumSha256
        && checksumSha256 !== session.expectedChecksumSha256
      ) {
        throw new AppError(
          "FILE_SIGNATURE_MISMATCH",
          SAFE_MESSAGES.FILE_SIGNATURE_MISMATCH,
          422,
        );
      }
      const container = this.validateSignature(
        header,
        extension,
        session.contentType,
      );
      const media = await this.probeMedia(stagePath);
      assertNotCancelled(signal);
      const publishRecord = {
        ownerId,
        uploadId,
        checksumSha256,
        byteSize: bytes,
        metadata: {
          container,
          durationSeconds: media.durationSeconds,
          width: media.width,
          height: media.height,
          hasAudio: media.hasAudio,
          videoCodec: media.videoCodec,
          audioCodec: media.audioCodec,
        },
      };
      let analysisJob = null;
      let published;
      if (
        this.jobQueue
        && typeof this.jobQueue.enqueueInTransaction === "function"
        && this.persistence
        && typeof this.persistence.withTransaction === "function"
        && typeof this.persistence.publishValidatedUploadInTransaction === "function"
      ) {
        const result = await this.persistence.withTransaction(async (transaction) => {
          const available = await this.persistence.publishValidatedUploadInTransaction(
            transaction,
            publishRecord,
          );
          if (!available) return null;
          const queued = await this.jobQueue.enqueueInTransaction(transaction, {
            ownerId,
            projectId: session.projectId,
            uploadId,
            action: "analyze_football",
            pipelineType: "football",
            payload: {
              sourceValidation: {
                checksumSha256,
                byteSize: bytes,
              },
              rightsConfirmed: true,
            },
          }, {
            idempotencyKey: `analyze-football-${uploadId}`,
          });
          return { published: available, job: queued.job };
        });
        published = Boolean(result && result.published);
        analysisJob = result && result.job;
      } else {
        published = await persistenceMethod(
          this.persistence,
          "publishValidatedUpload",
        )(publishRecord);
      }
      if (!published) {
        throw new AppError(
          "PROJECT_STATE_LOCKED",
          SAFE_MESSAGES.PROJECT_STATE_LOCKED,
          409,
        );
      }
      return {
        uploadId,
        status: "available",
        checksumSha256,
        byteSize: bytes,
        media,
        analysisJobId: analysisJob && analysisJob.id || null,
      };
    } catch (error) {
      const safeError = safeValidationError(error);
      if (terminalValidationError(safeError)) {
        safeError.retryable = false;
        await persistenceMethod(this.persistence, "failMultipartUpload")({
          ownerId,
          uploadId,
          operationId: `sop_${this.randomUUID()}`,
          operation: "delete_object",
          errorCode: safeError.code,
        }).catch(() => {});
      }
      throw safeError;
    } finally {
      if (fileHandle) await fileHandle.close().catch(() => {});
      await unlink(stagePath).catch(() => {});
    }
  }
}

module.exports = {
  HEADER_CAPTURE_BYTES,
  UploadValidationService,
  readableBody,
  terminalValidationError,
};
