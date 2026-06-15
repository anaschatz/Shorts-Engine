const { createHash, createHmac, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { dirname, extname, join } = require("node:path");
const { Readable, Writable } = require("node:stream");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { assertStoragePath, storagePath } = require("../storage.cjs");
const {
  ARTIFACT_STATUSES,
  ARTIFACT_TYPES,
  DOWNLOAD_ARTIFACT_TYPES,
  LocalArtifactStore,
  TEMP_ARTIFACT_TYPES,
  assertSignedDownloadTokenScope,
} = require("../storage/artifact-store.cjs");
const { artifactAdapterCapabilities, validateArtifactAdapter } = require("./artifact-adapter.cjs");

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OBJECT_BYTES = 300 * 1024 * 1024;
const DEFAULT_MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
const MIN_MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(value) {
  return createHash("sha256").update(value || Buffer.alloc(0)).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function amzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    dateStamp: iso.slice(0, 8),
    timestamp: `${iso.slice(0, 15)}Z`,
  };
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalKeyPath(storageKey) {
  return `/${String(storageKey).split("/").map(encodePathSegment).join("/")}`;
}

function headerValue(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [String(key).toLowerCase(), headerValue(value)]),
  );
}

function signedHeaderNames(headers) {
  return Object.keys(headers).sort();
}

function signingKey(secretAccessKey, dateStamp, region, service = "s3") {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function stageExtension(storageKey) {
  const ext = extname(String(storageKey || "")).toLowerCase();
  return /^[.][a-z0-9]{1,12}$/.test(ext) ? ext : ".bin";
}

function safeCloudError(error, statusCode = 502) {
  if (error instanceof AppError) return error;
  return new AppError("CLOUD_STORAGE_FAILED", SAFE_MESSAGES.CLOUD_STORAGE_FAILED, statusCode);
}

function responseHeader(headers, name) {
  const key = String(name).toLowerCase();
  return headers && Object.prototype.hasOwnProperty.call(headers, key) ? headers[key] : undefined;
}

function parseContentLength(headers) {
  const value = Number(responseHeader(headers, "content-length"));
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function assertNotAborted(signal) {
  if (signal && signal.aborted) {
    throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 499);
  }
}

function boundedPositiveInteger(value, fallback, options = {}) {
  const min = Number(options.min || 1);
  const max = Number(options.max || Number.MAX_SAFE_INTEGER);
  const raw = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(raw) || raw < min || raw > max) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return Math.floor(raw);
}

function sha256FileRangeHex(filePath, start = 0, length = null) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(64 * 1024, Number(length || 1024 * 1024))));
  const fd = openSync(filePath, "r");
  let remaining = length === null ? Infinity : Number(length);
  let position = start;
  try {
    while (remaining > 0) {
      const readLength = Math.min(buffer.length, remaining);
      const bytesRead = readSync(fd, buffer, 0, readLength, position);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (Number.isFinite(remaining)) remaining -= bytesRead;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function readFileRange(filePath, start, length) {
  const buffer = Buffer.alloc(length);
  const fd = openSync(filePath, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function parseXmlValue(xml, tagName) {
  const match = new RegExp(`<${tagName}>([^<]+)</${tagName}>`, "i").exec(String(xml || ""));
  return match ? match[1] : "";
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

class S3CompatibleClient {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.requestTimeoutMs = Number(options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxObjectBytes = Number(options.maxObjectBytes || DEFAULT_MAX_OBJECT_BYTES);
    this.workerPath = options.workerPath || join(__dirname, "s3-request-worker.cjs");
    this.clock = options.clock || (() => new Date());
  }

  endpointForKey(storageKey) {
    const endpoint = this.config.endpoint || `https://s3.${this.config.region}.amazonaws.com`;
    const parsed = new URL(endpoint);
    const keyPath = canonicalKeyPath(storageKey);
    if (this.config.forcePathStyle || this.config.endpoint) {
      parsed.pathname = `/${this.config.bucket}${keyPath}`;
      return parsed;
    }
    parsed.hostname = `${this.config.bucket}.${parsed.hostname}`;
    parsed.pathname = keyPath;
    return parsed;
  }

  signedRequest(method, storageKey, options = {}) {
    const body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body || "");
    const url = this.endpointForKey(storageKey);
    if (options.query && typeof options.query === "object") {
      for (const [key, value] of Object.entries(options.query).sort(([left], [right]) => left.localeCompare(right))) {
        url.searchParams.set(key, String(value));
      }
    }
    const { dateStamp, timestamp } = amzDate(this.clock());
    const payloadHash = options.payloadHash || sha256Hex(body);
    const headers = normalizeHeaders({
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp,
      "x-amz-security-token": this.config.sessionToken,
      ...options.headers,
    });
    const headerNames = signedHeaderNames(headers);
    const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name]}\n`).join("");
    const canonicalRequest = [
      method,
      url.pathname,
      url.searchParams.toString(),
      canonicalHeaders,
      headerNames.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256Hex(canonicalRequest)].join("\n");
    const signature = hmac(signingKey(this.config.secretAccessKey, dateStamp, this.config.region), stringToSign, "hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${headerNames.join(";")}, Signature=${signature}`;
    return { body, headers, url: url.toString() };
  }

  request(method, storageKey, options = {}) {
    const signed = this.signedRequest(method, storageKey, options);
    const payload = {
      operation: options.operation || "request",
      method,
      url: signed.url,
      headers: signed.headers,
      bodyBase64: signed.body.length ? signed.body.toString("base64") : "",
      filePath: options.filePath,
      timeoutMs: this.requestTimeoutMs,
    };
    const result = spawnSync(process.execPath, [this.workerPath], {
      input: `${JSON.stringify(payload)}\n`,
      encoding: "utf8",
      maxBuffer: this.maxObjectBytes,
    });
    if (result.error || result.status !== 0) {
      throw safeCloudError(result.error || new Error(result.stderr || "cloud request failed"));
    }
    try {
      const parsed = JSON.parse(result.stdout || "{}");
      return {
        statusCode: Number(parsed.statusCode || 0),
        headers: normalizeHeaders(parsed.headers || {}),
        body: parsed.bodyBase64 ? Buffer.from(parsed.bodyBase64, "base64") : Buffer.alloc(0),
      };
    } catch {
      throw safeCloudError(new Error("cloud response parse failed"));
    }
  }

  headObject(storageKey) {
    return this.request("HEAD", storageKey);
  }

  getObject(storageKey) {
    return this.request("GET", storageKey);
  }

  putObject(storageKey, options = {}) {
    return this.request("PUT", storageKey, {
      body: options.body || Buffer.alloc(0),
      headers: {
        "content-type": options.contentType || "application/octet-stream",
        "content-length": Buffer.byteLength(options.body || Buffer.alloc(0)),
      },
    });
  }

  deleteObject(storageKey) {
    return this.request("DELETE", storageKey);
  }

  downloadObjectToFile(storageKey, filePath) {
    return this.request("GET", storageKey, {
      operation: "downloadToFile",
      filePath,
    });
  }

  uploadFileFromPath(storageKey, filePath, options = {}) {
    const fileStat = statSync(filePath);
    return this.request("PUT", storageKey, {
      operation: "uploadFromFile",
      filePath,
      payloadHash: sha256FileRangeHex(filePath),
      headers: {
        "content-type": options.contentType || "application/octet-stream",
        "content-length": fileStat.size,
      },
    });
  }

  createMultipartUpload(storageKey, options = {}) {
    const response = this.request("POST", storageKey, {
      query: { uploads: "" },
      headers: {
        "content-type": options.contentType || "application/octet-stream",
      },
    });
    return {
      ...response,
      uploadId: parseXmlValue(response.body && response.body.toString("utf8"), "UploadId"),
    };
  }

  uploadPart(storageKey, options = {}) {
    return this.request("PUT", storageKey, {
      body: options.body || Buffer.alloc(0),
      query: {
        partNumber: options.partNumber,
        uploadId: options.uploadId,
      },
      headers: {
        "content-length": Buffer.byteLength(options.body || Buffer.alloc(0)),
      },
    });
  }

  uploadPartFromFile(storageKey, options = {}) {
    const start = Number(options.start || 0);
    const length = Number(options.length || 0);
    return this.uploadPart(storageKey, {
      uploadId: options.uploadId,
      partNumber: options.partNumber,
      body: readFileRange(options.filePath, start, length),
    });
  }

  completeMultipartUpload(storageKey, options = {}) {
    const partsXml = (options.parts || [])
      .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`)
      .join("");
    return this.request("POST", storageKey, {
      body: Buffer.from(`<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`),
      query: { uploadId: options.uploadId },
      headers: { "content-type": "application/xml" },
    });
  }

  abortMultipartUpload(storageKey, options = {}) {
    return this.request("DELETE", storageKey, {
      query: { uploadId: options.uploadId },
    });
  }
}

class S3CompatibleArtifactAdapter {
  constructor(options = {}) {
    this.mode = options.mode || "s3";
    this.config = options.config || {};
    this.validator = options.validator || new LocalArtifactStore(options);
    this.client = options.client || new S3CompatibleClient(this.config, options);
    this.clock = options.clock || nowIso;
    this.tokenTtlSeconds = Math.max(1, Math.min(Number(options.tokenTtlSeconds || this.config.signedUrlTtlSeconds || 5 * 60), 15 * 60));
    this.maxSignedTokens = Math.max(1, Math.min(Number(options.maxSignedTokens || 500), 5000));
    this.multipartThresholdBytes = boundedPositiveInteger(
      options.multipartThresholdBytes || this.config.multipartThresholdBytes,
      DEFAULT_MULTIPART_THRESHOLD_BYTES,
      { min: MIN_MULTIPART_PART_SIZE_BYTES, max: 5 * 1024 * 1024 * 1024 },
    );
    this.multipartPartSizeBytes = boundedPositiveInteger(
      options.multipartPartSizeBytes || this.config.multipartPartSizeBytes,
      DEFAULT_MULTIPART_PART_SIZE_BYTES,
      { min: MIN_MULTIPART_PART_SIZE_BYTES, max: 512 * 1024 * 1024 },
    );
    if (this.multipartPartSizeBytes > this.multipartThresholdBytes) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    this.signedTokens = options.signedTokens || new Map();
    validateArtifactAdapter(this);
  }

  createArtifactRecord(input) {
    const record = this.validator.createRecord(input);
    const { path, ...cloudRecord } = record;
    return cloudRecord;
  }

  createRecord(input) {
    return this.createArtifactRecord(input);
  }

  publicArtifactRecord(record) {
    if (!record) return null;
    const { storageKey, path, ...safe } = this.createArtifactRecord(record);
    return safe;
  }

  publicRecord(record) {
    return this.publicArtifactRecord(record);
  }

  resolveArtifact() {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }

  resolve() {
    return this.resolveArtifact();
  }

  resolveLocalPath() {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }

  responseOk(response) {
    return response && response.statusCode >= 200 && response.statusCode < 300;
  }

  assertSuccess(response, statusCode = 502) {
    if (!this.responseOk(response)) {
      if (response && response.statusCode === 404) {
        throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
      }
      throw new AppError("CLOUD_STORAGE_FAILED", SAFE_MESSAGES.CLOUD_STORAGE_FAILED, statusCode);
    }
    return response;
  }

  head(record) {
    const artifact = this.createArtifactRecord(record);
    try {
      return this.client.headObject(artifact.storageKey);
    } catch (error) {
      throw safeCloudError(error);
    }
  }

  artifactExists(record) {
    try {
      const response = this.head(record);
      return this.responseOk(response);
    } catch (error) {
      if (error.code === "ARTIFACT_NOT_FOUND") return false;
      return false;
    }
  }

  exists(record) {
    return this.artifactExists(record);
  }

  isFile(record) {
    return this.artifactExists(record);
  }

  stat(record) {
    const artifact = this.getArtifactMetadata(record);
    if (artifact.status !== "available") {
      throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    }
    return {
      size: artifact.size || 0,
      isFile: () => true,
    };
  }

  getArtifactMetadata(record) {
    const artifact = this.createArtifactRecord(record);
    try {
      const response = this.head(artifact);
      if (response.statusCode === 404) {
        return this.createArtifactRecord({ ...artifact, status: "missing", size: artifact.size ?? null, updatedAt: this.clock() });
      }
      this.assertSuccess(response);
      return this.createArtifactRecord({
        ...artifact,
        size: parseContentLength(response.headers) ?? artifact.size,
        contentType: responseHeader(response.headers, "content-type") || artifact.contentType,
        status: "available",
        updatedAt: this.clock(),
      });
    } catch (error) {
      if (error.code === "ARTIFACT_NOT_FOUND") {
        return this.createArtifactRecord({ ...artifact, status: "missing", size: artifact.size ?? null, updatedAt: this.clock() });
      }
      throw safeCloudError(error);
    }
  }

  assertReadableArtifact(record) {
    const artifact = this.getArtifactMetadata(record);
    if (artifact.status !== "available") {
      throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    }
    return artifact;
  }

  readArtifact(record) {
    const artifact = this.assertReadableArtifact(record);
    try {
      const response = this.assertSuccess(this.client.getObject(artifact.storageKey));
      return Buffer.from(response.body || Buffer.alloc(0));
    } catch (error) {
      throw safeCloudError(error);
    }
  }

  createReadStream(record) {
    return Readable.from(this.readArtifact(record));
  }

  createWriteStream(input = {}) {
    const record = this.createArtifactRecord({ ...input, status: input.status || "staging" });
    const chunks = [];
    const stream = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final: (callback) => {
        try {
          this.writeBuffer({ ...record, ...input, buffer: Buffer.concat(chunks) });
          callback();
        } catch (error) {
          callback(safeCloudError(error));
        }
      },
    });
    return { record, stream };
  }

  writeBuffer(input = {}) {
    if (!Buffer.isBuffer(input.buffer)) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    const artifact = this.createArtifactRecord(input);
    try {
      this.assertSuccess(
        this.client.putObject(artifact.storageKey, {
          body: input.buffer,
          contentType: artifact.contentType,
        }),
      );
      return this.createArtifactRecord({
        ...artifact,
        size: input.buffer.length,
        status: input.status || "available",
        updatedAt: this.clock(),
      });
    } catch (error) {
      throw safeCloudError(error);
    }
  }

  writeArtifact(input = {}) {
    if (Buffer.isBuffer(input.buffer)) return this.writeBuffer(input);
    if (typeof input.body === "string" || Buffer.isBuffer(input.body)) {
      return this.writeBuffer({ ...input, buffer: Buffer.from(input.body) });
    }
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }

  putArtifact(input) {
    return this.writeArtifact(input);
  }

  markAvailable(record) {
    return this.createArtifactRecord({ ...record, status: "available", updatedAt: this.clock() });
  }

  stagingPath(storageKey, prefix = "s3-stage") {
    return storagePath("staging", `${prefix}-${randomUUID()}${stageExtension(storageKey)}`);
  }

  assertStagingPath(filePath) {
    return assertStoragePath(filePath, "staging");
  }

  stageInputForProcessing(record, options = {}) {
    const artifact = this.assertReadableArtifact(record);
    const localPath = this.stagingPath(artifact.storageKey, `${this.mode}-input`);
    this.streamArtifactToLocalPath(artifact, localPath, options);
    return {
      id: `stage_${randomUUID()}`,
      purpose: "input",
      adapterMode: this.mode,
      artifact,
      localPath,
      permanentLocal: false,
      cleanupRequired: true,
      createdAt: this.clock(),
      step: options.step || "stage_input",
    };
  }

  async stageInputForProcessingAsync(record, options = {}) {
    return this.stageInputForProcessing(record, options);
  }

  stageArtifactToLocalPath(record, options) {
    return this.stageInputForProcessing(record, options);
  }

  createOutputStage(type, metadata = {}) {
    const artifact = this.createArtifactRecord({
      ...metadata,
      type,
      storageKey: metadata.storageKey || `${type}-${randomUUID()}`,
      status: "staging",
    });
    const localPath = this.stagingPath(artifact.storageKey, `${this.mode}-output`);
    mkdirSync(dirname(localPath), { recursive: true });
    return {
      id: `stage_${randomUUID()}`,
      purpose: "output",
      adapterMode: this.mode,
      artifact,
      localPath,
      permanentLocal: false,
      cleanupRequired: true,
      createdAt: this.clock(),
    };
  }

  validateStage(stage) {
    if (!stage || typeof stage !== "object" || !stage.id || !stage.localPath) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    this.assertStagingPath(stage.localPath);
    return stage;
  }

  commitOutputStage(stage, metadata = {}) {
    const safeStage = this.validateStage(stage);
    if (!existsSync(safeStage.localPath) || !statSync(safeStage.localPath).isFile()) {
      throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    }
    return this.streamLocalPathToArtifact(safeStage.localPath, {
      ...safeStage.artifact,
      ...metadata,
      status: "available",
    }, metadata);
  }

  async commitOutputStageAsync(stage, metadata = {}) {
    return this.commitOutputStage(stage, metadata);
  }

  streamArtifactToLocalPath(record, localPath, options = {}) {
    assertNotAborted(options.signal);
    const artifact = this.assertReadableArtifact(record);
    const safePath = this.assertStagingPath(localPath);
    mkdirSync(dirname(safePath), { recursive: true });
    const startedAt = Date.now();
    try {
      const response = typeof this.client.downloadObjectToFile === "function"
        ? this.client.downloadObjectToFile(artifact.storageKey, safePath)
        : null;
      if (response) {
        this.assertSuccess(response);
        assertNotAborted(options.signal);
        return {
          artifact,
          bytes: statSync(safePath).size,
          durationMs: Date.now() - startedAt,
          localPath: safePath,
          operation: "stream_download",
          strategy: "worker-stream",
        };
      }
      writeFileSync(safePath, this.readArtifact(artifact));
      assertNotAborted(options.signal);
      return {
        artifact,
        bytes: statSync(safePath).size,
        durationMs: Date.now() - startedAt,
        localPath: safePath,
        operation: "stream_download",
        strategy: "buffered-fallback",
      };
    } catch (error) {
      try {
        unlinkSync(safePath);
      } catch {
        // Best-effort failed stream cleanup.
      }
      throw safeCloudError(error);
    }
  }

  supportsMultipartUpload() {
    return (
      typeof this.client.createMultipartUpload === "function" &&
      typeof this.client.uploadPart === "function" &&
      typeof this.client.completeMultipartUpload === "function" &&
      typeof this.client.abortMultipartUpload === "function"
    );
  }

  uploadStrategyForSize(size) {
    const safeSize = Number(size);
    if (Number.isFinite(safeSize) && safeSize >= this.multipartThresholdBytes && this.supportsMultipartUpload()) {
      return "multipart";
    }
    return "single";
  }

  uploadMultipartFromPath(artifact, localPath, options = {}) {
    assertNotAborted(options.signal);
    const fileStat = statSync(localPath);
    const started = this.client.createMultipartUpload(artifact.storageKey, { contentType: artifact.contentType });
    this.assertSuccess(started);
    const uploadId = started.uploadId;
    if (!uploadId) {
      throw new AppError("CLOUD_STORAGE_FAILED", SAFE_MESSAGES.CLOUD_STORAGE_FAILED, 502);
    }
    const parts = [];
    try {
      let offset = 0;
      let partNumber = 1;
      while (offset < fileStat.size) {
        assertNotAborted(options.signal);
        const length = Math.min(this.multipartPartSizeBytes, fileStat.size - offset);
        const response = typeof this.client.uploadPartFromFile === "function"
          ? this.client.uploadPartFromFile(artifact.storageKey, {
              filePath: localPath,
              length,
              partNumber,
              start: offset,
              uploadId,
            })
          : this.client.uploadPart(artifact.storageKey, {
              body: readFileRange(localPath, offset, length),
              partNumber,
              uploadId,
            });
        this.assertSuccess(response);
        parts.push({
          etag: responseHeader(response.headers, "etag") || `"part-${partNumber}"`,
          partNumber,
          size: length,
        });
        offset += length;
        partNumber += 1;
      }
      const completed = this.client.completeMultipartUpload(artifact.storageKey, { uploadId, parts });
      this.assertSuccess(completed);
      return { parts, strategy: "multipart", uploadId };
    } catch (error) {
      try {
        this.client.abortMultipartUpload(artifact.storageKey, { uploadId });
      } catch {
        // Best-effort multipart abort.
      }
      throw safeCloudError(error);
    }
  }

  streamLocalPathToArtifact(localPath, input = {}, options = {}) {
    assertNotAborted(options.signal);
    const safePath = this.assertStagingPath(localPath);
    if (!existsSync(safePath) || !statSync(safePath).isFile()) {
      throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    }
    const artifact = this.createArtifactRecord(input);
    const fileStat = statSync(safePath);
    const startedAt = Date.now();
    const strategy = this.uploadStrategyForSize(fileStat.size);
    try {
      let uploadDetails = { strategy };
      if (strategy === "multipart") {
        uploadDetails = this.uploadMultipartFromPath(artifact, safePath, options);
      } else if (typeof this.client.uploadFileFromPath === "function") {
        this.assertSuccess(
          this.client.uploadFileFromPath(artifact.storageKey, safePath, {
            contentType: artifact.contentType,
          }),
        );
      } else {
        if (fileStat.size > this.multipartThresholdBytes) {
          throw new AppError("CLOUD_STORAGE_FAILED", SAFE_MESSAGES.CLOUD_STORAGE_FAILED, 502);
        }
        this.assertSuccess(
          this.client.putObject(artifact.storageKey, {
            body: readFileSync(safePath),
            contentType: artifact.contentType,
          }),
        );
        uploadDetails.strategy = "buffered-fallback";
      }
      assertNotAborted(options.signal);
      return this.createArtifactRecord({
        ...artifact,
        size: input.size ?? fileStat.size,
        status: input.status || "available",
        updatedAt: this.clock(),
        uploadStrategy: uploadDetails.strategy,
        multipartParts: uploadDetails.parts ? uploadDetails.parts.length : 0,
        transfer: {
          bytes: fileStat.size,
          durationMs: Date.now() - startedAt,
          operation: uploadDetails.strategy === "multipart" ? "multipart_upload" : "stream_upload",
          strategy: uploadDetails.strategy,
        },
      });
    } catch (error) {
      throw safeCloudError(error);
    }
  }

  cleanupArtifactsByPolicy(records = [], options = {}) {
    const result = this.validator.cleanupArtifactsByPolicy(records, { ...options, dryRun: true });
    if (options.dryRun !== false) {
      this.pruneSignedTokens(options.nowMs);
      return result;
    }
    result.dryRun = false;
    result.deleted = 0;
    result.errors = 0;
    for (const rawRecord of Array.isArray(records) ? records : []) {
      if (result.deleted >= result.maxArtifacts) break;
      let artifact;
      try {
        artifact = this.createArtifactRecord(rawRecord);
        if (!TEMP_ARTIFACT_TYPES.includes(artifact.type)) continue;
        const timestamp = Date.parse(artifact.updatedAt || artifact.createdAt || "");
        const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
        if (!Number.isFinite(timestamp) || nowMs - timestamp < result.maxAgeSeconds * 1000) continue;
        this.deleteTempArtifact(artifact);
        result.deleted += 1;
      } catch {
        result.errors += 1;
      }
    }
    this.pruneSignedTokens(options.nowMs);
    return result;
  }

  commitLocalArtifact(stage, metadata) {
    return this.commitOutputStage(stage, metadata);
  }

  cleanupStage(stage) {
    if (!stage) return { cleaned: false };
    const safeStage = this.validateStage(stage);
    if (!safeStage.cleanupRequired) return { cleaned: false };
    try {
      unlinkSync(this.assertStagingPath(safeStage.localPath));
      return { cleaned: true };
    } catch {
      return { cleaned: false };
    }
  }

  cleanupStagedArtifact(stage) {
    return this.cleanupStage(stage);
  }

  deleteStagingArtifact(record) {
    const artifact = this.createArtifactRecord(record);
    if (artifact.status !== "staging") {
      throw new AppError("ARTIFACT_DELETE_FORBIDDEN", SAFE_MESSAGES.ARTIFACT_DELETE_FORBIDDEN, 403);
    }
    try {
      this.client.deleteObject(artifact.storageKey);
    } catch {
      // Best-effort cleanup of an uncommitted cloud artifact.
    }
    return this.createArtifactRecord({ ...artifact, status: "deleted", updatedAt: this.clock() });
  }

  deleteTempArtifact(record) {
    const artifact = this.createArtifactRecord(record);
    if (!TEMP_ARTIFACT_TYPES.includes(artifact.type)) {
      throw new AppError("ARTIFACT_DELETE_FORBIDDEN", SAFE_MESSAGES.ARTIFACT_DELETE_FORBIDDEN, 403);
    }
    try {
      this.client.deleteObject(artifact.storageKey);
    } catch {
      // Best-effort cleanup of temporary cloud artifacts.
    }
    return this.createArtifactRecord({ ...artifact, status: "deleted", updatedAt: this.clock() });
  }

  deleteMarkedArtifact(record, options = {}) {
    const artifact = this.createArtifactRecord(record);
    this.validator.deleteMarkedArtifact(artifact, { source: options.source });
    try {
      this.client.deleteObject(artifact.storageKey);
    } catch {
      // Best-effort cleanup of explicitly marked staging smoke artifacts.
    }
    return this.createArtifactRecord({ ...artifact, status: "deleted", updatedAt: this.clock() });
  }

  pruneSignedTokens(nowMs = Date.now()) {
    const safeNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    for (const [token, entry] of this.signedTokens.entries()) {
      if (!entry || !Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= safeNowMs) {
        this.signedTokens.delete(token);
      }
    }
    while (this.signedTokens.size > this.maxSignedTokens) {
      const oldest = this.signedTokens.keys().next().value;
      if (!oldest) break;
      this.signedTokens.delete(oldest);
    }
    return this.signedTokens.size;
  }

  createSignedDownloadUrl(record, options = {}) {
    this.pruneSignedTokens();
    const artifact = this.assertReadableArtifact(record);
    if (!DOWNLOAD_ARTIFACT_TYPES.includes(artifact.type)) {
      throw new AppError("ARTIFACT_TYPE_INVALID", SAFE_MESSAGES.ARTIFACT_TYPE_INVALID, 400);
    }
    const ttlSeconds = Math.max(1, Math.min(Number(options.ttlSeconds || this.tokenTtlSeconds), 15 * 60));
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const token = `adt_${randomUUID()}_${randomUUID().replace(/-/g, "")}`;
    this.signedTokens.set(token, {
      artifact: this.createArtifactRecord(artifact),
      expiresAtMs: Date.parse(expiresAt),
      createdAt: this.clock(),
    });
    this.pruneSignedTokens();
    const basePath = String(options.basePath || "/api/artifacts/download");
    return {
      url: `${basePath}?token=${encodeURIComponent(token)}`,
      token,
      expiresAt,
      ttlSeconds,
    };
  }

  validateSignedDownloadToken(token, options = {}) {
    const safeToken = String(token || "");
    if (!/^adt_[A-Fa-f0-9-]{36}_[A-Fa-f0-9]{32}$/.test(safeToken)) {
      throw new AppError("ARTIFACT_TOKEN_INVALID", SAFE_MESSAGES.ARTIFACT_TOKEN_INVALID, 404);
    }
    const entry = this.signedTokens.get(safeToken);
    const nowMs = Number(options.nowMs ?? Date.now());
    if (!entry || !Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= nowMs) {
      this.signedTokens.delete(safeToken);
      throw new AppError("ARTIFACT_TOKEN_INVALID", SAFE_MESSAGES.ARTIFACT_TOKEN_INVALID, 404);
    }
    return assertSignedDownloadTokenScope(this.assertReadableArtifact(entry.artifact), options);
  }

  healthProbe() {
    const artifact = this.writeArtifact({
      id: `health_${randomUUID()}`,
      type: "render_temp",
      storageKey: `health-${randomUUID()}.txt`,
      contentType: "text/plain",
      buffer: Buffer.from("ok"),
      status: "staging",
    });
    const body = this.readArtifact(artifact).toString("utf8");
    const deleted = this.deleteTempArtifact(artifact);
    return {
      write: true,
      read: body === "ok",
      cleanup: deleted.status === "deleted",
    };
  }

  stagingHealthProbe() {
    const stage = this.createOutputStage("render_temp", {
      storageKey: `stage-health-${randomUUID()}.txt`,
      contentType: "text/plain",
    });
    writeFileSync(stage.localPath, "ok", "utf8");
    const committed = this.commitOutputStage(stage, { contentType: "text/plain" });
    const body = this.readArtifact(committed).toString("utf8");
    const cleanup = this.cleanupStage(stage);
    this.deleteTempArtifact(committed);
    return {
      stage: true,
      commit: committed.status === "available" && body === "ok",
      cleanup: Boolean(cleanup.cleaned),
    };
  }

  health() {
    let probe = { write: false, read: false, cleanup: false };
    let staging = { stage: false, commit: false, cleanup: false };
    try {
      probe = this.healthProbe();
    } catch {
      probe = { write: false, read: false, cleanup: false };
    }
    try {
      staging = this.stagingHealthProbe();
    } catch {
      staging = { stage: false, commit: false, cleanup: false };
    }
    this.pruneSignedTokens();
    return {
      ready: Boolean(probe.write && probe.read && probe.cleanup && staging.stage && staging.commit && staging.cleanup),
      adapter: "s3-compatible-artifact",
      mode: this.mode,
      objectStorage: true,
      signedUrls: true,
      signedDownloadTtlSeconds: this.tokenTtlSeconds,
      maxSignedTokens: this.maxSignedTokens,
      activeSignedTokens: this.signedTokens.size,
      durable: true,
      credentialsConfigured: Boolean(this.config.credentialsConfigured),
      bucketConfigured: Boolean(this.config.bucket),
      endpointConfigured: Boolean(this.config.endpoint),
      capabilities: artifactAdapterCapabilities(this),
      types: ARTIFACT_TYPES.length,
      statuses: ARTIFACT_STATUSES.length,
      streamingSupported: true,
      multipartSupported: this.supportsMultipartUpload(),
      lifecycleCleanupSupported: true,
      multipartThresholdBytes: this.multipartThresholdBytes,
      multipartPartSizeBytes: this.multipartPartSizeBytes,
      probe,
      staging,
    };
  }
}

module.exports = {
  S3CompatibleArtifactAdapter,
  S3CompatibleClient,
  safeCloudError,
};
