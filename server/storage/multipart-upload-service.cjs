const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const {
  MAX_PARTS,
  artifactStorageKey,
} = require("./r2-artifact-store.cjs");

const ALLOWED_CONTENT_TYPES = new Map([
  ["video/mp4", "mp4"],
  ["video/quicktime", "mov"],
  ["video/webm", "webm"],
]);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function safeUploadError(code = "UPLOAD_NOT_FOUND", status = 404) {
  return new AppError(code, SAFE_MESSAGES[code], status);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function opaqueToken(random = randomBytes) {
  return random(32).toString("base64url");
}

function safeOriginalFilename(value, extension) {
  const leaf = String(value || `upload.${extension}`).split(/[\\/]/).at(-1);
  const normalized = leaf
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .trim()
    .slice(0, 160);
  return normalized || `upload.${extension}`;
}

function checksum(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return normalized;
}

function positiveByteSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
    throw new AppError("FILE_TOO_LARGE", SAFE_MESSAGES.FILE_TOO_LARGE, 413);
  }
  return size;
}

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

function parseHttpRange(value, byteSize) {
  const size = Number(byteSize);
  if (!value) {
    return {
      range: null,
      status: 200,
      contentLength: size,
      contentRange: null,
    };
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size < 1) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 416);
  }
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 416);
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || start >= size
      || end < start
    ) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 416);
    }
    end = Math.min(end, size - 1);
  }
  return {
    range: { start, end },
    status: 206,
    contentLength: end - start + 1,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

class MultipartUploadService {
  constructor(options = {}) {
    this.persistence = options.persistence;
    this.store = options.store;
    this.jobQueue = options.jobQueue || null;
    this.clock = options.clock || { now: () => Date.now() };
    this.randomBytes = options.randomBytes || randomBytes;
    this.randomUUID = options.randomUUID || randomUUID;
    this.partSizeBytes = Number(
      options.partSizeBytes
      || (this.store && this.store.partSizeBytes)
      || 16 * 1024 * 1024,
    );
  }

  async createUpload(input) {
    if (!input || input.rightsConfirmed !== true) {
      throw new AppError(
        "FOOTBALL_REVIEW_RIGHTS_REQUIRED",
        SAFE_MESSAGES.FOOTBALL_REVIEW_RIGHTS_REQUIRED,
        400,
      );
    }
    const contentType = String(input.contentType || "").toLowerCase();
    const extension = ALLOWED_CONTENT_TYPES.get(contentType);
    if (!extension) {
      throw new AppError(
        "FILE_TYPE_UNSUPPORTED",
        SAFE_MESSAGES.FILE_TYPE_UNSUPPORTED,
        415,
      );
    }
    const ownerId = String(input.ownerId || "");
    const expectedByteSize = positiveByteSize(input.byteSize);
    const expectedParts = Math.ceil(expectedByteSize / this.partSizeBytes);
    if (expectedParts < 1 || expectedParts > MAX_PARTS) {
      throw new AppError("FILE_TOO_LARGE", SAFE_MESSAGES.FILE_TOO_LARGE, 413);
    }
    const projectId = `prj_${this.randomUUID()}`;
    const uploadId = `upl_${this.randomUUID()}`;
    const artifactId = `art_${this.randomUUID()}`;
    const sessionId = `ups_${this.randomUUID()}`;
    const storageKey = artifactStorageKey({
      ownerId,
      artifactId,
      purpose: "source",
      extension,
    });
    const expectedChecksumSha256 = checksum(input.checksumSha256);
    let providerUploadId = null;
    let databaseCreated = false;
    try {
      const session = await persistenceMethod(
        this.persistence,
        "createMultipartUploadSession",
      )({
        sessionId,
        ownerId,
        projectId,
        uploadId,
        artifactId,
        projectType: input.projectType || "clip",
        title: String(input.title || "ShortsEngine Short").slice(0, 120),
        originalFilename: safeOriginalFilename(input.filename, extension),
        contentType,
        expectedByteSize,
        expectedChecksumSha256,
        partSizeBytes: this.partSizeBytes,
        expectedParts,
        storageKey,
        expiresAt: new Date(this.clock.now() + UPLOAD_SESSION_TTL_MS).toISOString(),
        retentionUntil: new Date(this.clock.now() + UPLOAD_SESSION_TTL_MS).toISOString(),
        artifactMetadata: { validation: "pending" },
        uploadMetadata: { rightsConfirmed: true },
        source: { type: "direct_upload", rightsConfirmed: true },
      });
      databaseCreated = Boolean(session);
      const created = await this.store.createMultipartUpload({
        storageKey,
        contentType,
        artifactId,
      });
      providerUploadId = created.uploadId;
      const attached = await persistenceMethod(
        this.persistence,
        "attachMultipartUpload",
      )({
        ownerId,
        uploadId,
        providerUploadId,
      });
      if (!attached) throw new Error("multipart attach failed");
      const parts = [];
      for (let number = 1; number <= expectedParts; number += 1) {
        parts.push(await this.store.presignUploadPart({
          storageKey,
          uploadId: providerUploadId,
          partNumber: number,
        }));
      }
      return {
        project: { id: projectId, status: "uploading" },
        upload: {
          id: uploadId,
          status: "uploading",
          byteSize: expectedByteSize,
          contentType,
        },
        multipart: {
          partSizeBytes: this.partSizeBytes,
          expectedParts,
          expiresAt: parts.reduce(
            (earliest, part) => !earliest || part.expiresAt < earliest
              ? part.expiresAt
              : earliest,
            null,
          ),
          parts,
        },
      };
    } catch (error) {
      if (providerUploadId) {
        await this.store.abortMultipartUpload({ storageKey, uploadId: providerUploadId })
          .catch(() => {});
      }
      if (databaseCreated) {
        await persistenceMethod(this.persistence, "failMultipartUpload")({
          ownerId,
          uploadId,
          operationId: `sop_${this.randomUUID()}`,
          operation: "abort_multipart",
          errorCode: error instanceof AppError ? error.code : "CLOUD_STORAGE_FAILED",
        }).catch(() => {});
      }
      if (error instanceof AppError) throw error;
      throw new AppError(
        "CLOUD_STORAGE_FAILED",
        SAFE_MESSAGES.CLOUD_STORAGE_FAILED,
        502,
      );
    }
  }

  async completeUpload({ ownerId, uploadId, parts }) {
    const session = await persistenceMethod(
      this.persistence,
      "getMultipartUploadOwnedBy",
    )(uploadId, ownerId);
    if (!session || session.status !== "uploading" || !session.providerUploadId) {
      throw safeUploadError();
    }
    let objectCompleted = false;
    try {
      await this.store.completeMultipartUpload({
        storageKey: session.storageKey,
        uploadId: session.providerUploadId,
        parts,
        expectedParts: session.expectedParts,
      });
      objectCompleted = true;
      const head = await this.store.headObject(session.storageKey);
      if (head.byteSize !== session.expectedByteSize) {
        throw new AppError(
          "FILE_SIGNATURE_MISMATCH",
          SAFE_MESSAGES.FILE_SIGNATURE_MISMATCH,
          422,
        );
      }
      let validationJob = null;
      let completed;
      if (
        this.jobQueue
        && typeof this.jobQueue.enqueueInTransaction === "function"
        && this.persistence
        && typeof this.persistence.withTransaction === "function"
        && typeof this.persistence.markMultipartUploadCompleteInTransaction === "function"
      ) {
        const result = await this.persistence.withTransaction(async (transaction) => {
          const upload = await this.persistence.markMultipartUploadCompleteInTransaction(
            transaction,
            { ownerId, uploadId },
          );
          if (!upload) return null;
          const queued = await this.jobQueue.enqueueInTransaction(transaction, {
            ownerId,
            projectId: upload.projectId,
            uploadId,
            action: "validate_upload",
            pipelineType: "football",
            payload: {
              uploadSessionId: upload.id,
              artifactId: upload.artifactId,
            },
          }, {
            idempotencyKey: `validate-upload-${uploadId}`,
          });
          return { upload, job: queued.job };
        });
        completed = result && result.upload;
        validationJob = result && result.job;
      } else {
        completed = await persistenceMethod(
          this.persistence,
          "markMultipartUploadComplete",
        )({ ownerId, uploadId });
      }
      if (!completed) throw new Error("multipart completion state failed");
      return {
        upload: {
          id: uploadId,
          status: "validating",
          byteSize: head.byteSize,
          contentType: head.contentType,
        },
        validation: {
          status: validationJob ? "queued" : "pending",
          jobType: "validate_upload",
          jobId: validationJob && validationJob.id || null,
        },
      };
    } catch (error) {
      await persistenceMethod(this.persistence, "failMultipartUpload")({
        ownerId,
        uploadId,
        operationId: `sop_${this.randomUUID()}`,
        operation: objectCompleted ? "delete_object" : "abort_multipart",
        errorCode: error instanceof AppError ? error.code : "CLOUD_STORAGE_FAILED",
      }).catch(() => {});
      if (error instanceof AppError) throw error;
      throw new AppError(
        "CLOUD_STORAGE_FAILED",
        SAFE_MESSAGES.CLOUD_STORAGE_FAILED,
        502,
      );
    }
  }

  async issueDeliveryGrant({ ownerId, artifactId, purpose }) {
    const safePurpose = String(purpose || "");
    if (!["preview", "export"].includes(safePurpose)) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    const ttlSeconds = safePurpose === "preview" ? 120 : 300;
    const token = opaqueToken(this.randomBytes);
    const grant = await persistenceMethod(this.persistence, "createDeliveryGrant")({
      id: `dgr_${this.randomUUID()}`,
      ownerId,
      artifactId,
      tokenHash: sha256(token),
      purpose: safePurpose,
      expiresAt: new Date(this.clock.now() + ttlSeconds * 1000).toISOString(),
    });
    if (!grant) throw safeUploadError("ARTIFACT_NOT_FOUND", 404);
    return {
      token,
      expiresAt: grant.expiresAt,
      url: `/api/delivery/${encodeURIComponent(token)}`,
    };
  }

  async openDelivery({ ownerId, token, rangeHeader: requestedRange, signal }) {
    const grant = await persistenceMethod(
      this.persistence,
      "resolveDeliveryGrant",
    )({
      ownerId,
      tokenHash: sha256(token),
    });
    if (!grant) {
      throw new AppError(
        "ARTIFACT_TOKEN_INVALID",
        SAFE_MESSAGES.ARTIFACT_TOKEN_INVALID,
        404,
      );
    }
    const requested = parseHttpRange(requestedRange, grant.artifact.byteSize);
    const object = await this.store.getObjectStream(grant.artifact.storageKey, {
      range: requested.range,
      signal,
    });
    return {
      status: requested.status,
      headers: {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-length": String(requested.contentLength),
        "content-type": grant.artifact.contentType,
        ...(requested.contentRange
          ? { "content-range": requested.contentRange }
          : {}),
      },
      body: object.body,
    };
  }
}

module.exports = {
  MAX_UPLOAD_BYTES,
  MultipartUploadService,
  UPLOAD_SESSION_TTL_MS,
  parseHttpRange,
  safeOriginalFilename,
};
