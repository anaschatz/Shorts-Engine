const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");

const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PART_SIZE_BYTES = 512 * 1024 * 1024;
const MAX_PARTS = 10_000;
const MAX_KEY_BYTES = 512;
const PURPOSES = new Set(["source", "preview", "export"]);

function cloudFailure() {
  return new AppError(
    "CLOUD_STORAGE_FAILED",
    SAFE_MESSAGES.CLOUD_STORAGE_FAILED,
    502,
  );
}

function validateStorageKey(value) {
  const key = String(value || "");
  if (
    !key
    || Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES
    || key.startsWith("/")
    || key.endsWith("/")
    || key.includes("\\")
    || key.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || !/^[A-Za-z0-9._/-]+$/.test(key)
  ) {
    throw new AppError("ARTIFACT_KEY_INVALID", SAFE_MESSAGES.ARTIFACT_KEY_INVALID, 400);
  }
  return key;
}

function artifactStorageKey({ ownerId, artifactId, purpose, extension = "bin" }) {
  const safeArtifactId = String(artifactId || "");
  const safePurpose = String(purpose || "");
  const safeExtension = String(extension || "").toLowerCase().replace(/^\./, "");
  if (!/^[A-Za-z0-9_-]{3,160}$/.test(safeArtifactId)) {
    throw new AppError("ARTIFACT_KEY_INVALID", SAFE_MESSAGES.ARTIFACT_KEY_INVALID, 400);
  }
  if (!PURPOSES.has(safePurpose) || !/^[a-z0-9]{1,12}$/.test(safeExtension)) {
    throw new AppError("ARTIFACT_KEY_INVALID", SAFE_MESSAGES.ARTIFACT_KEY_INVALID, 400);
  }
  const ownerScope = createHash("sha256")
    .update(String(ownerId || ""), "utf8")
    .digest("hex")
    .slice(0, 24);
  return validateStorageKey(
    `${safePurpose}/${ownerScope}/${safeArtifactId}/object.${safeExtension}`,
  );
}

function partNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_PARTS) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return number;
}

function partSize(value) {
  const number = Number(value);
  if (
    !Number.isInteger(number)
    || number < MIN_PART_SIZE_BYTES
    || number > MAX_PART_SIZE_BYTES
  ) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return number;
}

function etag(value) {
  const normalized = String(value || "").trim();
  if (
    !normalized
    || normalized.length > 160
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || !/^"?[A-Za-z0-9+/=_:.-]+"?$/.test(normalized)
  ) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return normalized;
}

function normalizeCompletedParts(parts, expectedParts = null) {
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  const normalized = parts
    .map((part) => ({
      PartNumber: partNumber(part && part.partNumber),
      ETag: etag(part && part.etag),
    }))
    .sort((left, right) => left.PartNumber - right.PartNumber);
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index].PartNumber !== index + 1) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
  }
  if (expectedParts !== null && normalized.length !== Number(expectedParts)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return normalized;
}

function rangeHeader(range) {
  if (!range) return undefined;
  const start = Number(range.start);
  const end = range.end === undefined || range.end === null ? null : Number(range.end);
  if (
    !Number.isInteger(start)
    || start < 0
    || (end !== null && (!Number.isInteger(end) || end < start))
  ) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 416);
  }
  return `bytes=${start}-${end === null ? "" : end}`;
}

function publicHead(result) {
  return {
    byteSize: Number(result.ContentLength || 0),
    contentType: result.ContentType || "application/octet-stream",
    etag: result.ETag || null,
    lastModified: result.LastModified instanceof Date
      ? result.LastModified.toISOString()
      : null,
    metadata: result.Metadata && typeof result.Metadata === "object"
      ? { ...result.Metadata }
      : {},
  };
}

function safeObjectMetadata(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).slice(0, 16).map(([key, item]) => {
    const safeKey = String(key || "").toLowerCase();
    const safeValue = String(item || "");
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(safeKey)
      || !safeValue
      || safeValue.length > 256
      || /[\u0000-\u001f\u007f]/.test(safeValue)
    ) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    return [safeKey, safeValue];
  });
  return Object.fromEntries(entries);
}

class R2ArtifactStore {
  constructor(options = {}) {
    const sdk = options.sdk || require("@aws-sdk/client-s3");
    this.sdk = sdk;
    this.config = options.config && options.config.storage
      ? options.config.storage
      : options.config;
    this.clock = options.clock || { now: () => Date.now() };
    this.getSignedUrl = options.getSignedUrl
      || require("@aws-sdk/s3-request-presigner").getSignedUrl;
    this.client = options.client || new sdk.S3Client({
      region: this.config.region || "auto",
      endpoint: this.config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
        ...(this.config.sessionToken ? { sessionToken: this.config.sessionToken } : {}),
      },
      maxAttempts: 3,
    });
    this.bucket = this.config.bucket;
    this.partSizeBytes = partSize(
      options.partSizeBytes || this.config.partSizeBytes || 16 * 1024 * 1024,
    );
    this.presignTtlSeconds = Math.max(
      60,
      Math.min(900, Number(options.presignTtlSeconds || this.config.presignTtlSeconds || 600)),
    );
  }

  async send(command, options = {}) {
    try {
      return await this.client.send(command, options);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw cloudFailure();
    }
  }

  async createMultipartUpload({ storageKey, contentType, artifactId }) {
    const key = validateStorageKey(storageKey);
    const response = await this.send(new this.sdk.CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: String(contentType || "application/octet-stream"),
      Metadata: {
        artifactid: String(artifactId || "").slice(0, 160),
      },
    }));
    const uploadId = String(response.UploadId || "");
    if (!uploadId || uploadId.length > 2048 || /[\u0000-\u001f\u007f]/.test(uploadId)) {
      throw cloudFailure();
    }
    return { uploadId };
  }

  async presignUploadPart({ storageKey, uploadId, partNumber: number }) {
    const key = validateStorageKey(storageKey);
    const safePartNumber = partNumber(number);
    try {
      const url = await this.getSignedUrl(
        this.client,
        new this.sdk.UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: String(uploadId),
          PartNumber: safePartNumber,
        }),
        { expiresIn: this.presignTtlSeconds },
      );
      return {
        partNumber: safePartNumber,
        url,
        expiresAt: new Date(
          this.clock.now() + this.presignTtlSeconds * 1000,
        ).toISOString(),
      };
    } catch {
      throw cloudFailure();
    }
  }

  async completeMultipartUpload({ storageKey, uploadId, parts, expectedParts = null }) {
    const key = validateStorageKey(storageKey);
    const normalized = normalizeCompletedParts(parts, expectedParts);
    await this.send(new this.sdk.CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: String(uploadId),
      MultipartUpload: { Parts: normalized },
    }));
    return { partCount: normalized.length };
  }

  async abortMultipartUpload({ storageKey, uploadId }) {
    const key = validateStorageKey(storageKey);
    await this.send(new this.sdk.AbortMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: String(uploadId),
    }));
    return true;
  }

  async headObject(storageKey) {
    const key = validateStorageKey(storageKey);
    const response = await this.send(new this.sdk.HeadObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    return publicHead(response);
  }

  async getObjectStream(storageKey, options = {}) {
    const key = validateStorageKey(storageKey);
    const response = await this.send(new this.sdk.GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Range: rangeHeader(options.range),
    }), {
      abortSignal: options.signal,
    });
    if (!response.Body) throw cloudFailure();
    return {
      body: response.Body,
      byteSize: Number(response.ContentLength || 0),
      contentLength: Number(response.ContentLength || 0),
      contentRange: response.ContentRange || null,
      contentType: response.ContentType || "application/octet-stream",
      etag: response.ETag || null,
    };
  }

  async putObjectStream({
    storageKey,
    body,
    byteSize,
    contentType,
    metadata,
    signal,
  }) {
    const key = validateStorageKey(storageKey);
    const size = Number(byteSize);
    if (!Number.isInteger(size) || size < 0) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    await this.send(new this.sdk.PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentLength: size,
      ContentType: String(contentType || "application/octet-stream"),
      Metadata: safeObjectMetadata(metadata),
    }), { abortSignal: signal });
    return await this.headObject(key);
  }

  async deleteObject(storageKey) {
    const key = validateStorageKey(storageKey);
    await this.send(new this.sdk.DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    return true;
  }

  async readiness() {
    try {
      await this.send(new this.sdk.HeadBucketCommand({ Bucket: this.bucket }));
      return {
        ready: true,
        mode: "r2",
        async: true,
        multipart: true,
        directUpload: true,
        appProxiedDelivery: true,
      };
    } catch {
      return {
        ready: false,
        mode: "r2",
        async: true,
        multipart: true,
        directUpload: true,
        appProxiedDelivery: true,
      };
    }
  }

  async health() {
    return await this.readiness();
  }

  async close() {
    if (this.client && typeof this.client.destroy === "function") {
      this.client.destroy();
    }
    return true;
  }
}

function createR2ArtifactStore(options = {}) {
  return new R2ArtifactStore(options);
}

module.exports = {
  MAX_PARTS,
  MIN_PART_SIZE_BYTES,
  R2ArtifactStore,
  artifactStorageKey,
  createR2ArtifactStore,
  normalizeCompletedParts,
  rangeHeader,
  safeObjectMetadata,
  validateStorageKey,
};
