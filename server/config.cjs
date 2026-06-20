const { tmpdir } = require("node:os");
const { isAbsolute, join, relative, resolve } = require("node:path");
const { existsSync, mkdirSync } = require("node:fs");

const ROOT_DIR = resolve(__dirname, "..");
const DEFAULT_DATA_DIR = join(ROOT_DIR, "data");
function isInside(baseDir, candidatePath) {
  const fromBase = relative(resolve(baseDir), resolve(candidatePath));
  return fromBase === "" || (!fromBase.startsWith("..") && !isAbsolute(fromBase));
}

function validateDataDir(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_DATA_DIR;
  const raw = String(value).trim();
  if (!raw || raw.includes("\u0000") || raw.length > 500) {
    throw new Error("Invalid data directory configuration.");
  }
  const resolved = resolve(raw);
  const tempRoot = resolve(tmpdir());
  if (!isInside(ROOT_DIR, resolved) && !isInside(tempRoot, resolved)) {
    throw new Error("Invalid data directory configuration.");
  }
  return resolved;
}

const DATA_DIR = validateDataDir(process.env.MATCHCUTS_DATA_DIR);
const UPLOAD_DIR = join(DATA_DIR, "uploads");
const AUDIO_DIR = join(DATA_DIR, "audio");
const RENDER_DIR = join(DATA_DIR, "renders");
const PROJECT_DIR = join(DATA_DIR, "projects");
const JOB_DIR = join(DATA_DIR, "jobs");
const ARTIFACT_DIR = join(DATA_DIR, "artifacts");
const REVIEW_DRAFT_DIR = join(DATA_DIR, "review-drafts");
const REVIEW_APPROVAL_DIR = join(DATA_DIR, "review-approvals");
const REVIEW_APPROVAL_OUTBOX_DIR = join(DATA_DIR, "review-approval-outbox");
const DB_DIR = join(DATA_DIR, "db");
const TMP_DIR = join(DATA_DIR, "tmp");
const STAGING_DIR = join(TMP_DIR, "staging");
const FFMPEG_FULL_BIN = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFPROBE_FULL_BIN = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";
const STORAGE_ADAPTER_MODES = Object.freeze(["local", "mock-cloud", "s3", "r2", "gcs"]);
const PERSISTENCE_ADAPTER_MODES = Object.freeze(["local", "sqlite"]);
const SCOREBOARD_OCR_PROVIDER_MODES = Object.freeze(["deterministic", "local"]);
const DEFAULT_YOUTUBE_DOWNLOADER_BIN = "yt-dlp";
const DEFAULT_SCOREBOARD_OCR_BIN = "tesseract";

function boolFromEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function validateStorageAdapterMode(value = "local") {
  const mode = String(value || "local").trim().toLowerCase();
  if (!STORAGE_ADAPTER_MODES.includes(mode)) {
    throw new Error("Invalid MATCHCUTS_STORAGE_ADAPTER value.");
  }
  return mode;
}

function validatePersistenceAdapterMode(value = "local") {
  const mode = String(value || "local").trim().toLowerCase();
  if (!PERSISTENCE_ADAPTER_MODES.includes(mode)) {
    throw new Error("Invalid MATCHCUTS_PERSISTENCE_ADAPTER value.");
  }
  return mode;
}

function validateSignedUrlTtlSeconds(value = 5 * 60) {
  const raw = value === undefined || value === null || value === "" ? 5 * 60 : Number(value);
  if (!Number.isFinite(raw)) {
    throw new Error("Invalid storage signed URL TTL configuration.");
  }
  return Math.max(1, Math.min(Math.floor(raw), 15 * 60));
}

function validateByteConfig(value, options = {}) {
  const {
    name = "byte",
    fallback,
    min = 1,
    max = Number.MAX_SAFE_INTEGER,
  } = options;
  const raw = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(raw) || raw < min || raw > max) {
    throw new Error(`Invalid ${name} configuration.`);
  }
  return Math.floor(raw);
}

function validatePositiveIntegerConfig(value, options = {}) {
  const {
    name = "integer",
    fallback,
    min = 1,
    max = Number.MAX_SAFE_INTEGER,
  } = options;
  const raw = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(`Invalid ${name} configuration.`);
  }
  return raw;
}

function validateStorageConfig(input = {}) {
  const adapter = validateStorageAdapterMode(input.adapter || "local");
  const bucket = String(input.bucket || "").trim();
  const region = String(input.region || "").trim();
  const endpoint = String(input.endpoint || "").trim();
  const accessKeyId = String(input.accessKeyId || "").trim();
  const secretAccessKey = String(input.secretAccessKey || "").trim();
  const sessionToken = String(input.sessionToken || "").trim();
  if (bucket && !/^[A-Za-z0-9][A-Za-z0-9._-]{1,120}$/.test(bucket)) {
    throw new Error("Invalid storage bucket configuration.");
  }
  if (region && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(region)) {
    throw new Error("Invalid storage region configuration.");
  }
  if (endpoint) {
    try {
      const parsed = new URL(endpoint);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported");
    } catch {
      throw new Error("Invalid storage endpoint configuration.");
    }
  }
  if (accessKeyId && !/^[A-Za-z0-9._:/+=@-]{3,160}$/.test(accessKeyId)) {
    throw new Error("Invalid storage access key configuration.");
  }
  if (secretAccessKey && (secretAccessKey.length < 8 || secretAccessKey.length > 240 || /[\u0000-\u001f\u007f]/.test(secretAccessKey))) {
    throw new Error("Invalid storage secret key configuration.");
  }
  if (sessionToken && (sessionToken.length < 8 || sessionToken.length > 2048 || /[\u0000-\u001f\u007f]/.test(sessionToken))) {
    throw new Error("Invalid storage session token configuration.");
  }
  if (["s3", "r2"].includes(adapter)) {
    if (!bucket) throw new Error("Cloud storage bucket is required.");
    if (!accessKeyId || !secretAccessKey) throw new Error("Cloud storage credentials are required.");
    if (adapter === "s3" && !region) throw new Error("S3 storage region is required.");
    if (adapter === "r2" && !endpoint) throw new Error("R2 storage endpoint is required.");
  }
  const multipartThresholdBytes = validateByteConfig(input.multipartThresholdBytes, {
    name: "storage multipart threshold",
    fallback: 64 * 1024 * 1024,
    min: 5 * 1024 * 1024,
    max: 5 * 1024 * 1024 * 1024,
  });
  const multipartPartSizeBytes = validateByteConfig(input.multipartPartSizeBytes, {
    name: "storage multipart part size",
    fallback: 16 * 1024 * 1024,
    min: 5 * 1024 * 1024,
    max: 512 * 1024 * 1024,
  });
  if (multipartPartSizeBytes > multipartThresholdBytes) {
    throw new Error("Invalid storage multipart configuration.");
  }
  return {
    adapter,
    bucket,
    region: region || (adapter === "r2" ? "auto" : ""),
    endpoint,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    credentialsConfigured: Boolean(accessKeyId && secretAccessKey),
    forcePathStyle: Boolean(input.forcePathStyle),
    signedUrlTtlSeconds: validateSignedUrlTtlSeconds(input.signedUrlTtlSeconds),
    multipartThresholdBytes,
    multipartPartSizeBytes,
    lifecycleCleanupMaxAgeSeconds: validatePositiveIntegerConfig(input.lifecycleCleanupMaxAgeSeconds, {
      name: "artifact cleanup max age",
      fallback: 24 * 60 * 60,
      min: 60,
      max: 365 * 24 * 60 * 60,
    }),
    lifecycleCleanupMaxPerRun: validatePositiveIntegerConfig(input.lifecycleCleanupMaxPerRun, {
      name: "artifact cleanup max per run",
      fallback: 100,
      min: 1,
      max: 1000,
    }),
  };
}

function validateSqliteFileName(value = "shortsengine.sqlite") {
  const fileName = String(value || "shortsengine.sqlite").trim();
  if (
    !fileName ||
    fileName.includes("\u0000") ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(sqlite|sqlite3|db)$/i.test(fileName)
  ) {
    throw new Error("Invalid SQLite database file configuration.");
  }
  return fileName;
}

function validateDatabaseConfig(input = {}) {
  const adapter = validatePersistenceAdapterMode(input.adapter || "local");
  const fileName = validateSqliteFileName(input.fileName || "shortsengine.sqlite");
  return {
    adapter,
    database: adapter === "sqlite",
    fileName,
    filePath: join(DB_DIR, fileName),
  };
}

function validateExecutableReference(value, options = {}) {
  const fallback = options.fallback || "";
  const name = options.name || "executable";
  const raw = value === undefined || value === null || value === "" ? fallback : String(value).trim();
  if (
    !raw ||
    raw.length > 240 ||
    /[\u0000-\u001f\u007f\s`$;&|<>]/.test(raw) ||
    raw.includes("\\") ||
    raw.includes("..")
  ) {
    throw new Error(`Invalid ${name} configuration.`);
  }
  if (raw.includes("/")) {
    if (!raw.startsWith("/") || !/^\/[A-Za-z0-9._/@:+-]+$/.test(raw)) {
      throw new Error(`Invalid ${name} configuration.`);
    }
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(raw)) {
    throw new Error(`Invalid ${name} configuration.`);
  }
  return raw;
}

function validateYouTubeIngestConfig(input = {}) {
  return {
    enabled: Boolean(input.enabled),
    authorizedImportEnabled: Boolean(input.authorizedImportEnabled),
    downloaderBin: validateExecutableReference(input.downloaderBin, {
      name: "YouTube downloader binary",
      fallback: DEFAULT_YOUTUBE_DOWNLOADER_BIN,
    }),
    timeoutMs: validatePositiveIntegerConfig(input.timeoutMs, {
      name: "YouTube ingest timeout",
      fallback: 2 * 60 * 1000,
      min: 1000,
      max: 10 * 60 * 1000,
    }),
    maxOutputBytes: validateByteConfig(input.maxOutputBytes, {
      name: "YouTube downloader output bytes",
      fallback: 64 * 1024,
      min: 1024,
      max: 1024 * 1024,
    }),
  };
}

function validateScoreboardOcrConfig(input = {}) {
  const provider = String(input.provider || "deterministic").trim().toLowerCase();
  if (!SCOREBOARD_OCR_PROVIDER_MODES.includes(provider)) {
    throw new Error("Invalid SHORTSENGINE_SCOREBOARD_OCR_PROVIDER value.");
  }
  return {
    enabled: Boolean(input.enabled),
    provider,
    bin: validateExecutableReference(input.bin, {
      name: "scoreboard OCR binary",
      fallback: DEFAULT_SCOREBOARD_OCR_BIN,
    }),
    timeoutMs: validatePositiveIntegerConfig(input.timeoutMs, {
      name: "scoreboard OCR timeout",
      fallback: 10 * 1000,
      min: 250,
      max: 60 * 1000,
    }),
    qaArtifactsEnabled: Boolean(input.qaArtifactsEnabled),
    qaArtifactRetention: validatePositiveIntegerConfig(input.qaArtifactRetention, {
      name: "scoreboard OCR QA artifact retention",
      fallback: 8,
      min: 1,
      max: 50,
    }),
  };
}

const STORAGE_CONFIG = validateStorageConfig({
  adapter: process.env.MATCHCUTS_STORAGE_ADAPTER || "local",
  bucket: process.env.MATCHCUTS_STORAGE_BUCKET || "",
  region: process.env.MATCHCUTS_STORAGE_REGION || "",
  endpoint: process.env.MATCHCUTS_STORAGE_ENDPOINT || "",
  accessKeyId: process.env.MATCHCUTS_STORAGE_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.MATCHCUTS_STORAGE_SECRET_ACCESS_KEY || "",
  sessionToken: process.env.MATCHCUTS_STORAGE_SESSION_TOKEN || "",
  forcePathStyle: boolFromEnv(process.env.MATCHCUTS_STORAGE_FORCE_PATH_STYLE),
  signedUrlTtlSeconds: process.env.MATCHCUTS_STORAGE_SIGNED_URL_TTL_SECONDS || 5 * 60,
  multipartThresholdBytes: process.env.MATCHCUTS_MULTIPART_THRESHOLD_BYTES,
  multipartPartSizeBytes: process.env.MATCHCUTS_MULTIPART_PART_SIZE_BYTES,
  lifecycleCleanupMaxAgeSeconds: process.env.MATCHCUTS_ARTIFACT_CLEANUP_MAX_AGE_SECONDS,
  lifecycleCleanupMaxPerRun: process.env.MATCHCUTS_ARTIFACT_CLEANUP_MAX_PER_RUN,
});

const DATABASE_CONFIG = validateDatabaseConfig({
  adapter: process.env.MATCHCUTS_PERSISTENCE_ADAPTER || "local",
  fileName: process.env.MATCHCUTS_SQLITE_FILE || "shortsengine.sqlite",
});
const YOUTUBE_INGEST_CONFIG = validateYouTubeIngestConfig({
  enabled: boolFromEnv(process.env.SHORTSENGINE_YOUTUBE_INGEST_ENABLED),
  authorizedImportEnabled: boolFromEnv(process.env.SHORTSENGINE_YOUTUBE_AUTHORIZED_IMPORT_ENABLED),
  downloaderBin: process.env.SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN || DEFAULT_YOUTUBE_DOWNLOADER_BIN,
  timeoutMs: process.env.SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS,
  maxOutputBytes: process.env.SHORTSENGINE_YOUTUBE_DOWNLOADER_OUTPUT_BYTES,
});
const SCOREBOARD_OCR_CONFIG = validateScoreboardOcrConfig({
  enabled: boolFromEnv(process.env.SHORTSENGINE_SCOREBOARD_OCR_ENABLED),
  provider: process.env.SHORTSENGINE_SCOREBOARD_OCR_PROVIDER || "deterministic",
  bin: process.env.SHORTSENGINE_SCOREBOARD_OCR_BIN || DEFAULT_SCOREBOARD_OCR_BIN,
  timeoutMs: process.env.SHORTSENGINE_SCOREBOARD_OCR_TIMEOUT_MS,
  qaArtifactsEnabled: boolFromEnv(process.env.SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS) ||
    boolFromEnv(process.env.SHORTSENGINE_OCR_QA_ARTIFACTS),
  qaArtifactRetention: process.env.SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACT_RETENTION ||
    process.env.SHORTSENGINE_OCR_QA_ARTIFACT_RETENTION,
});

const PORT = validatePositiveIntegerConfig(process.env.PORT, {
  name: "server port",
  fallback: 4175,
  min: 1,
  max: 65535,
});
const MAX_UPLOAD_BYTES = validateByteConfig(process.env.MATCHCUTS_MAX_UPLOAD_BYTES, {
  name: "max upload bytes",
  fallback: 250 * 1024 * 1024,
  min: 1024,
  max: 20 * 1024 * 1024 * 1024,
});
const MAX_DURATION_SECONDS = validatePositiveIntegerConfig(process.env.MATCHCUTS_MAX_DURATION_SECONDS, {
  name: "max video duration",
  fallback: 30 * 60,
  min: 1,
  max: 24 * 60 * 60,
});
const RENDER_TIMEOUT_MS = validatePositiveIntegerConfig(process.env.MATCHCUTS_RENDER_TIMEOUT_MS, {
  name: "render timeout",
  fallback: 5 * 60 * 1000,
  min: 1000,
  max: 60 * 60 * 1000,
});
const ANALYSIS_TIMEOUT_MS = validatePositiveIntegerConfig(process.env.MATCHCUTS_ANALYSIS_TIMEOUT_MS, {
  name: "analysis timeout",
  fallback: 45 * 1000,
  min: 1000,
  max: 10 * 60 * 1000,
});
const TRANSCRIPTION_TIMEOUT_MS = validatePositiveIntegerConfig(process.env.MATCHCUTS_TRANSCRIPTION_TIMEOUT_MS, {
  name: "transcription timeout",
  fallback: 60 * 1000,
  min: 1000,
  max: 15 * 60 * 1000,
});
const TRANSCRIPTION_RETRIES = validatePositiveIntegerConfig(process.env.MATCHCUTS_TRANSCRIPTION_RETRIES, {
  name: "transcription retries",
  fallback: 1,
  min: 0,
  max: 5,
});
const WORKER_POLL_INTERVAL_MS = validatePositiveIntegerConfig(process.env.MATCHCUTS_WORKER_POLL_INTERVAL_MS, {
  name: "worker poll interval",
  fallback: 0,
  min: 0,
  max: 60 * 1000,
});
const WORKER_SHUTDOWN_TIMEOUT_MS = validatePositiveIntegerConfig(process.env.MATCHCUTS_WORKER_SHUTDOWN_TIMEOUT_MS, {
  name: "worker shutdown timeout",
  fallback: 10 * 1000,
  min: 0,
  max: 10 * 60 * 1000,
});
const WORKER_RETRY_INITIAL_DELAY_MS = validatePositiveIntegerConfig(process.env.MATCHCUTS_WORKER_RETRY_INITIAL_DELAY_MS, {
  name: "worker retry initial delay",
  fallback: 1000,
  min: 0,
  max: 10 * 60 * 1000,
});
const WORKER_RETRY_MAX_DELAY_MS = validatePositiveIntegerConfig(process.env.MATCHCUTS_WORKER_RETRY_MAX_DELAY_MS, {
  name: "worker retry max delay",
  fallback: 30 * 1000,
  min: 0,
  max: 60 * 60 * 1000,
});
const WORKER_RETRY_MAX_ATTEMPTS = validatePositiveIntegerConfig(process.env.MATCHCUTS_WORKER_RETRY_MAX_ATTEMPTS, {
  name: "worker retry max attempts",
  fallback: 2,
  min: 1,
  max: 10,
});
if (WORKER_RETRY_INITIAL_DELAY_MS > WORKER_RETRY_MAX_DELAY_MS) {
  throw new Error("Invalid worker retry delay configuration.");
}

const CONFIG = Object.freeze({
  rootDir: ROOT_DIR,
  dataDir: DATA_DIR,
  uploadDir: UPLOAD_DIR,
  audioDir: AUDIO_DIR,
  renderDir: RENDER_DIR,
  projectDir: PROJECT_DIR,
  jobDir: JOB_DIR,
  artifactDir: ARTIFACT_DIR,
  reviewDraftDir: REVIEW_DRAFT_DIR,
  reviewApprovalDir: REVIEW_APPROVAL_DIR,
  reviewApprovalOutboxDir: REVIEW_APPROVAL_OUTBOX_DIR,
  dbDir: DB_DIR,
  tmpDir: TMP_DIR,
  stagingDir: STAGING_DIR,
  storage: Object.freeze(STORAGE_CONFIG),
  storageAdapter: STORAGE_CONFIG.adapter,
  persistence: Object.freeze(DATABASE_CONFIG),
  persistenceAdapter: DATABASE_CONFIG.adapter,
  youtubeIngest: Object.freeze(YOUTUBE_INGEST_CONFIG),
  scoreboardOcr: Object.freeze(SCOREBOARD_OCR_CONFIG),
  artifactCleanupIntervalMs: validatePositiveIntegerConfig(process.env.MATCHCUTS_ARTIFACT_CLEANUP_INTERVAL_MS, {
    name: "artifact cleanup interval",
    fallback: 0,
    min: 0,
    max: 24 * 60 * 60 * 1000,
  }),
  realCloudIntegrationEnabled: boolFromEnv(process.env.MATCHCUTS_RUN_REAL_CLOUD_TESTS),
  port: PORT,
  maxUploadBytes: MAX_UPLOAD_BYTES,
  maxDurationSeconds: MAX_DURATION_SECONDS,
  minDurationSeconds: 1,
  ffmpegBin: process.env.FFMPEG_BIN || (existsSync(FFMPEG_FULL_BIN) ? FFMPEG_FULL_BIN : "ffmpeg"),
  ffprobeBin: process.env.FFPROBE_BIN || (existsSync(FFPROBE_FULL_BIN) ? FFPROBE_FULL_BIN : "ffprobe"),
  renderTimeoutMs: RENDER_TIMEOUT_MS,
  analysisTimeoutMs: ANALYSIS_TIMEOUT_MS,
  transcriptionTimeoutMs: TRANSCRIPTION_TIMEOUT_MS,
  transcriptionRetries: TRANSCRIPTION_RETRIES,
  workerPollIntervalMs: WORKER_POLL_INTERVAL_MS,
  workerShutdownTimeoutMs: WORKER_SHUTDOWN_TIMEOUT_MS,
  workerRetryInitialDelayMs: WORKER_RETRY_INITIAL_DELAY_MS,
  workerRetryMaxDelayMs: WORKER_RETRY_MAX_DELAY_MS,
  workerRetryMaxAttempts: WORKER_RETRY_MAX_ATTEMPTS,
  allowedExtensions: Object.freeze(["mp4", "mov", "webm"]),
  allowedMimeTypes: Object.freeze(["video/mp4", "video/quicktime", "video/webm"]),
});

function ensureDataDirs() {
  for (const dir of [DATA_DIR, UPLOAD_DIR, AUDIO_DIR, RENDER_DIR, PROJECT_DIR, JOB_DIR, ARTIFACT_DIR, REVIEW_DRAFT_DIR, REVIEW_APPROVAL_DIR, REVIEW_APPROVAL_OUTBOX_DIR, DB_DIR, TMP_DIR, STAGING_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  CONFIG,
  PERSISTENCE_ADAPTER_MODES,
  STORAGE_ADAPTER_MODES,
  SCOREBOARD_OCR_PROVIDER_MODES,
  ensureDataDirs,
  validateByteConfig,
  validateDatabaseConfig,
  validateDataDir,
  validatePersistenceAdapterMode,
  validatePositiveIntegerConfig,
  validateExecutableReference,
  validateSignedUrlTtlSeconds,
  validateStorageAdapterMode,
  validateStorageConfig,
  validateScoreboardOcrConfig,
  validateYouTubeIngestConfig,
};
