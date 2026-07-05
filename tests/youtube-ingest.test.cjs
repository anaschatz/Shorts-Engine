const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const { CONFIG } = require("../server/config.cjs");
const { AppError, SAFE_MESSAGES } = require("../server/errors.cjs");
const {
  buildDownloaderArgs,
  buildMetadataArgs,
  createLocalYouTubeIngestAdapter,
  downloaderVersion,
  formatStrategySummary,
  parseMetadataOutput,
} = require("../server/adapters/local-youtube-ingest-adapter.cjs");
const {
  classifyYouTubeDownloaderFailure,
  toSafeYouTubeDownloaderError,
} = require("../server/youtube-downloader-errors.cjs");
const { createMockYouTubeIngestAdapter } = require("../server/adapters/mock-youtube-ingest-adapter.cjs");
const {
  cleanupYouTubeStage,
  createYouTubeIngestService,
  createYouTubeStagePaths,
} = require("../server/youtube-ingest-service.cjs");
const {
  MAX_YOUTUBE_URL_LENGTH,
  normalizeYouTubeUrl,
  validateYouTubeSource,
  youtubeIngestHealth,
} = require("../server/youtube-ingest.cjs");
const {
  createSourceAcquisitionService,
  validateSourceAcquisitionRequest,
} = require("../server/source-acquisition/source-acquisition-service.cjs");
const {
  cacheFileNameForVideoId,
  checksumFileNameForVideoId,
  createLocalSourceCacheAdapter,
  sourceCacheKeyForVideoId,
} = require("../server/source-acquisition/local-source-cache-adapter.cjs");

const mp4Header = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00,
]);

function youtubeStageChildren() {
  const dir = join(CONFIG.stagingDir, "youtube");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

function createFakeArtifactStore() {
  return {
    async streamLocalPathToArtifact(localPath, input) {
      return {
        ...input,
        size: statSync(localPath).size,
        status: "available",
        createdAt: new Date().toISOString(),
      };
    },
  };
}

function createFakePersistenceAdapter(created) {
  return {
    createProjectUpload(record) {
      created.push(record);
      return {
        project: record.project,
        upload: record.upload,
      };
    },
    publicUpload(upload) {
      return {
        id: upload.id,
        projectId: upload.projectId,
        originalFilename: upload.originalFilename,
        byteSize: upload.byteSize,
        mimeType: upload.mimeType,
        metadata: upload.metadata,
        artifact: {
          id: upload.artifact.id,
          type: upload.artifact.type,
          status: upload.artifact.status,
          size: upload.artifact.size,
        },
      };
    },
    publicProject(project) {
      return { ...project };
    },
  };
}

function createWritingAdapter(fileBuffer, options = {}) {
  const calls = [];
  return {
    calls,
    enabled: true,
    networkCalls: true,
    async getMetadata() {
      return {
        title: options.title || "Authorized Match Clip",
        durationSeconds: options.durationSeconds || null,
        metadataStatus: "local-deferred",
        ingestAvailable: true,
      };
    },
    async ingest(source, ingestOptions = {}) {
      calls.push({ source, outputPath: ingestOptions.outputPath });
      mkdirSync(dirname(ingestOptions.outputPath), { recursive: true });
      writeFileSync(ingestOptions.outputPath, fileBuffer);
      return { outputPath: ingestOptions.outputPath, size: fileBuffer.length };
    },
    health() {
      return {
        ready: true,
        mode: "local",
        enabled: true,
        networkCalls: true,
        downloaderConfigured: true,
        ingestAvailable: true,
      };
    },
  };
}

function validMp4Buffer(extraBytes = 128) {
  return Buffer.concat([mp4Header, Buffer.alloc(extraBytes)]);
}

function makeSourceCacheDir(name) {
  const dir = join(CONFIG.sourceCacheDir, `test-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function removeSourceCacheDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("youtube url normalization accepts supported video formats", () => {
  assert.deepEqual(normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), {
    sourceType: "youtube",
    kind: "watch",
    videoId: "dQw4w9WgXcQ",
    canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  assert.equal(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ").kind, "shortlink");
  assert.equal(normalizeYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ").kind, "shorts");
});

test("youtube url normalization rejects unsupported and unsafe urls", () => {
  assert.throws(() => normalizeYouTubeUrl("https://vimeo.com/123"), (error) => error.code === "YOUTUBE_URL_INVALID");
  assert.throws(() => normalizeYouTubeUrl("http://www.youtube.com/watch?v=dQw4w9WgXcQ"), (error) => error.code === "YOUTUBE_URL_INVALID");
  assert.throws(() => normalizeYouTubeUrl("http://youtu.be/dQw4w9WgXcQ"), (error) => error.code === "YOUTUBE_URL_INVALID");
  assert.throws(() => normalizeYouTubeUrl("javascript:alert(1)"), (error) => error.code === "YOUTUBE_URL_INVALID");
  assert.throws(
    () => normalizeYouTubeUrl("https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ"),
    (error) => error.code === "YOUTUBE_URL_INVALID",
  );
  assert.throws(
    () => normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123"),
    (error) => error.code === "YOUTUBE_PLAYLIST_UNSUPPORTED",
  );
  assert.throws(
    () => normalizeYouTubeUrl("https://www.youtube.com/live/dQw4w9WgXcQ"),
    (error) => error.code === "YOUTUBE_LIVE_UNSUPPORTED",
  );
  assert.throws(
    () => normalizeYouTubeUrl("https://www.youtube.com/embed/dQw4w9WgXcQ"),
    (error) => error.code === "YOUTUBE_URL_INVALID",
  );
  assert.throws(
    () => normalizeYouTubeUrl(`https://www.youtube.com/watch?v=dQw4w9WgXcQ${"a".repeat(MAX_YOUTUBE_URL_LENGTH)}`),
    (error) => error.code === "YOUTUBE_URL_INVALID",
  );
  assert.throws(
    () => normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ\u0000"),
    (error) => error.code === "YOUTUBE_URL_INVALID",
  );
});

test("mock youtube ingest adapter is validate-only and no-network", async () => {
  const adapter = createMockYouTubeIngestAdapter({
    metadataByVideoId: {
      dQw4w9WgXcQ: { title: "Safe title", durationSeconds: 120 },
    },
  });
  const source = await validateYouTubeSource({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
    adapter,
    maxDurationSeconds: 180,
  });
  assert.equal(source.videoId, "dQw4w9WgXcQ");
  assert.equal(source.title, "Safe title");
  assert.equal(source.metadataStatus, "mock");
  assert.equal(source.durationSeconds, 120);
  assert.equal(source.ingestAvailable, false);
  assert.equal(source.downloaderConfigured, false);
  assert.equal(source.nextAction, "youtube-ingest-disabled-until-mp4-artifact-exists");
  assert.deepEqual(youtubeIngestHealth(adapter), {
    ready: true,
    mode: "mock",
    enabled: false,
    networkCalls: false,
    downloaderConfigured: false,
    ingestAvailable: false,
    authorizedImportAvailable: false,
  });
});

test("youtube source validation sanitizes adapter title metadata", async () => {
  const adapter = createMockYouTubeIngestAdapter({
    metadataByVideoId: {
      dQw4w9WgXcQ: { title: "  Derby\u0000 Final\tHighlights  ", durationSeconds: 120 },
    },
  });
  const source = await validateYouTubeSource({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
    adapter,
    maxDurationSeconds: 180,
  });
  assert.equal(source.title, "Derby Final Highlights");
});

test("youtube source validation carries safe ingest warnings from metadata probes", async () => {
  const adapter = {
    async getMetadata() {
      return {
        metadataStatus: "auth-required",
        ingestRisk: "authorized-import-required",
        warningCode: "YOUTUBE_AUTH_REQUIRED",
        nextAction: "try-public-video-or-use-authorized-import",
        retryable: false,
        authorizedImportRequired: true,
        ingestAvailable: true,
      };
    },
    health() {
      return {
        ready: true,
        mode: "local",
        enabled: true,
        networkCalls: true,
        downloaderConfigured: true,
        ingestAvailable: true,
        authorizedImportAvailable: false,
      };
    },
  };
  const source = await validateYouTubeSource({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
    adapter,
  });
  assert.equal(source.metadataStatus, "auth-required");
  assert.equal(source.ingestRisk, "authorized-import-required");
  assert.equal(source.warningCode, "YOUTUBE_AUTH_REQUIRED");
  assert.equal(source.authorizedImportRequired, true);
  assert.equal(source.nextAction, "try-public-video-or-use-authorized-import");
  assert.equal(source.authorizedImportAvailable, false);
  assert.doesNotMatch(JSON.stringify(source), /stderr|stdout|\/Users|cookies/i);
});

test("youtube source validation requires rights and enforces duration limits", async () => {
  const adapter = createMockYouTubeIngestAdapter({
    metadataByVideoId: {
      dQw4w9WgXcQ: { durationSeconds: 200 },
    },
  });
  await assert.rejects(
    () => validateYouTubeSource({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", rightsConfirmed: false, adapter }),
    (error) => error.code === "YOUTUBE_RIGHTS_REQUIRED",
  );
  await assert.rejects(
    () => validateYouTubeSource({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      rightsConfirmed: true,
      adapter,
      maxDurationSeconds: 60,
    }),
    (error) => error.code === "YOUTUBE_DURATION_TOO_LONG",
  );
});

test("source acquisition boundary validates rights source and adapter contract", async () => {
  const uploadId = "upl_source01-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  try {
    assert.throws(
      () => validateSourceAcquisitionRequest({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        rightsConfirmed: false,
        outputPath,
      }),
      (error) => error.code === "YOUTUBE_RIGHTS_REQUIRED",
    );
    assert.throws(
      () => validateSourceAcquisitionRequest({
        url: "https://vimeo.com/123",
        rightsConfirmed: true,
        outputPath,
      }),
      (error) => error.code === "YOUTUBE_URL_INVALID",
    );
    assert.throws(
      () => createSourceAcquisitionService({ adapter: {} }),
      (error) => error.code === "ADAPTER_CONTRACT_INVALID",
    );
  } finally {
    cleanupYouTubeStage(stageDir);
  }
});

test("source acquisition boundary wraps successful local adapter output safely", async () => {
  const uploadId = "upl_source02-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  const adapter = {
    mode: "local",
    health() {
      return {
        ready: true,
        mode: "local",
        enabled: true,
        networkCalls: true,
        downloaderConfigured: true,
        ingestAvailable: true,
        authorizedImportAvailable: false,
        formatStrategy: {
          formatSelector: "best[ext=mp4]/best",
          fallbackFormatSelector: "best[ext=mp4]/best",
          attemptsConfigured: 1,
          timeoutMs: 1000,
        },
      };
    },
    async ingest(_source, ingestOptions = {}) {
      writeFileSync(ingestOptions.outputPath, Buffer.concat([mp4Header, Buffer.alloc(128)]));
      return {
        outputPath: ingestOptions.outputPath,
        size: 144,
        attempts: 1,
        attemptsConfigured: 1,
        timeoutMs: 1000,
        formatSelector: "best[ext=mp4]/best",
        fallbackFormatSelector: "best[ext=mp4]/best",
        fallbackUsed: false,
      };
    },
  };
  try {
    const service = createSourceAcquisitionService({ adapter });
    const result = await service.acquireSource({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      rightsConfirmed: true,
      outputPath,
    });
    assert.equal(result.outputPath, outputPath);
    assert.equal(result.sourceAcquisition.status, "acquired");
    assert.equal(result.sourceAcquisition.strategy.attempts, 1);
    assert.equal(result.sourceAcquisition.strategy.formatSelector, "best[ext=mp4]/best");
    assert.equal(result.sourceAcquisition.outputBytes, 144);
    assert.doesNotMatch(JSON.stringify(result.sourceAcquisition), /\/Users|stderr|stdout|token|cookie/i);
  } finally {
    cleanupYouTubeStage(stageDir);
  }
});

test("source cache is disabled by default and keys are video-id based", async () => {
  const uploadId = "upl_cache01-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  const cacheDir = makeSourceCacheDir("disabled");
  const adapter = createLocalSourceCacheAdapter({
    config: {
      enabled: false,
      dir: cacheDir,
      requireChecksum: false,
      maxBytes: CONFIG.maxUploadBytes,
    },
  });
  try {
    assert.equal(sourceCacheKeyForVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
    assert.equal(cacheFileNameForVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ.mp4");
    assert.throws(() => sourceCacheKeyForVideoId("../bad-video"), (error) => error.code === "YOUTUBE_URL_INVALID");
    await assert.rejects(
      () => adapter.acquireSource(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), { outputPath }),
      (error) => {
        assert.equal(error.code, "SOURCE_CACHE_MISS");
        assert.equal(error.details.cacheChecked, true);
        assert.equal(error.details.cacheHit, false);
        assert.equal(error.details.cacheValidated, false);
        return true;
      },
    );
  } finally {
    cleanupYouTubeStage(stageDir);
    removeSourceCacheDir(cacheDir);
  }
});

test("source cache rejects unsafe cache directory configuration", async () => {
  const uploadId = "upl_cache99-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  const adapter = createLocalSourceCacheAdapter({
    config: {
      enabled: true,
      dir: "/etc",
      requireChecksum: false,
      maxBytes: CONFIG.maxUploadBytes,
    },
  });
  try {
    await assert.rejects(
      () => adapter.acquireSource(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), { outputPath }),
      (error) => {
        assert.equal(error.code, "STORAGE_PATH_UNSAFE");
        assert.equal(error.details.cacheChecked, true);
        assert.equal(error.details.cacheValidated, false);
        return true;
      },
    );
  } finally {
    cleanupYouTubeStage(stageDir);
  }
});

test("source acquisition uses valid source cache before downloader fallback", async () => {
  const uploadId = "upl_cache02-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  const cacheDir = makeSourceCacheDir("hit");
  const cachePath = join(cacheDir, cacheFileNameForVideoId("dQw4w9WgXcQ"));
  const cachedBytes = validMp4Buffer(256);
  writeFileSync(cachePath, cachedBytes);
  const cacheAdapter = createLocalSourceCacheAdapter({
    config: {
      enabled: true,
      dir: cacheDir,
      requireChecksum: false,
      maxBytes: CONFIG.maxUploadBytes,
    },
  });
  const downloader = createWritingAdapter(validMp4Buffer(64));
  try {
    const service = createSourceAcquisitionService({ adapter: downloader, cacheAdapter });
    const result = await service.acquireSource({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      rightsConfirmed: true,
      outputPath,
    });
    assert.equal(result.sourceAcquisition.sourceAcquisitionStrategy, "cache");
    assert.equal(result.sourceAcquisition.cacheChecked, true);
    assert.equal(result.sourceAcquisition.cacheHit, true);
    assert.equal(result.sourceAcquisition.cacheValidated, true);
    assert.equal(result.sourceAcquisition.downloaderFallbackUsed, false);
    assert.match(result.sourceAcquisition.checksumSha256, /^[a-f0-9]{64}$/);
    assert.equal(statSync(outputPath).size, cachedBytes.length);
    assert.equal(existsSync(cachePath), true);
    assert.equal(downloader.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result.sourceAcquisition), /\/Users|\/private|storageKey|outputPath|stderr|stdout|cookie|token/i);
  } finally {
    cleanupYouTubeStage(stageDir);
    removeSourceCacheDir(cacheDir);
  }
});

test("source acquisition falls back to downloader on source cache miss", async () => {
  const uploadId = "upl_cache03-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  const cacheDir = makeSourceCacheDir("miss");
  const cacheAdapter = createLocalSourceCacheAdapter({
    config: {
      enabled: true,
      dir: cacheDir,
      requireChecksum: false,
      maxBytes: CONFIG.maxUploadBytes,
    },
  });
  const downloader = createWritingAdapter(validMp4Buffer(128));
  try {
    const service = createSourceAcquisitionService({ adapter: downloader, cacheAdapter });
    const result = await service.acquireSource({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      rightsConfirmed: true,
      outputPath,
    });
    assert.equal(result.sourceAcquisition.sourceAcquisitionStrategy, "cache_miss_downloader");
    assert.equal(result.sourceAcquisition.cacheChecked, true);
    assert.equal(result.sourceAcquisition.cacheHit, false);
    assert.equal(result.sourceAcquisition.cacheValidated, false);
    assert.equal(result.sourceAcquisition.cacheFailureCode, "SOURCE_CACHE_MISS");
    assert.equal(result.sourceAcquisition.downloaderFallbackUsed, true);
    assert.equal(downloader.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result.sourceAcquisition), /\/Users|\/private|storageKey|outputPath|stderr|stdout|cookie|token/i);
  } finally {
    cleanupYouTubeStage(stageDir);
    removeSourceCacheDir(cacheDir);
  }
});

test("youtube ingest service commits valid cached source after staging validation", async () => {
  const created = [];
  const before = youtubeStageChildren();
  const cacheDir = makeSourceCacheDir("service-hit");
  const cachePath = join(cacheDir, cacheFileNameForVideoId("dQw4w9WgXcQ"));
  const cachedBytes = validMp4Buffer(512);
  writeFileSync(cachePath, cachedBytes);
  const cacheAdapter = createLocalSourceCacheAdapter({
    config: {
      enabled: true,
      dir: cacheDir,
      requireChecksum: false,
      maxBytes: CONFIG.maxUploadBytes,
    },
  });
  const downloader = createWritingAdapter(validMp4Buffer(64), { title: "Cached Derby Clip" });
  const service = createYouTubeIngestService({
    adapter: downloader,
    cacheAdapter,
    dependencies: {
      artifactStore: createFakeArtifactStore(),
      persistenceAdapter: createFakePersistenceAdapter(created),
      logger: null,
      probeMedia: async () => ({ durationSeconds: 22, width: 1280, height: 720, hasAudio: true }),
    },
  });
  try {
    const result = await service.ingest({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      rightsConfirmed: true,
      title: "Cached Source Project",
    });
    assert.equal(created.length, 1);
    assert.equal(downloader.calls.length, 0);
    assert.equal(result.source.videoId, "dQw4w9WgXcQ");
    assert.equal(result.upload.byteSize, cachedBytes.length);
    assert.equal(result.upload.artifact.status, "available");
    assert.equal(created[0].upload.metadata.sourceType, "youtube");
    assert.equal(existsSync(cachePath), true);
    assert.deepEqual(youtubeStageChildren(), before);
    assert.doesNotMatch(JSON.stringify(result), /\/Users|\/private|storageKey|outputPath|filePath|secret|token/i);
  } finally {
    removeSourceCacheDir(cacheDir);
  }
});

test("source cache checksum mismatch fails closed without downloader or records", async () => {
  const created = [];
  const cacheDir = makeSourceCacheDir("checksum");
  const cachePath = join(cacheDir, cacheFileNameForVideoId("dQw4w9WgXcQ"));
  writeFileSync(cachePath, validMp4Buffer(256));
  writeFileSync(join(cacheDir, checksumFileNameForVideoId("dQw4w9WgXcQ")), `${"0".repeat(64)}\n`);
  const cacheAdapter = createLocalSourceCacheAdapter({
    config: {
      enabled: true,
      dir: cacheDir,
      requireChecksum: true,
      maxBytes: CONFIG.maxUploadBytes,
    },
  });
  const downloader = createWritingAdapter(validMp4Buffer(64));
  const service = createYouTubeIngestService({
    adapter: downloader,
    cacheAdapter,
    dependencies: {
      artifactStore: createFakeArtifactStore(),
      persistenceAdapter: createFakePersistenceAdapter(created),
      logger: null,
      probeMedia: async () => ({ durationSeconds: 18, width: 1280, height: 720, hasAudio: true }),
    },
  });
  try {
    await assert.rejects(
      () => service.ingest({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        rightsConfirmed: true,
      }),
      (error) => {
        assert.equal(error.code, "SOURCE_CACHE_CHECKSUM_MISMATCH");
        assert.equal(error.details.cacheChecked, true);
        assert.equal(error.details.cacheHit, true);
        assert.equal(error.details.cacheValidated, false);
        assert.equal(error.details.downloaderFallbackUsed, false);
        assert.equal(error.details.cleanupSucceeded, true);
        assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|storageKey|outputPath|stderr|stdout|cookie|token/i);
        return true;
      },
    );
    assert.equal(created.length, 0);
    assert.equal(downloader.calls.length, 0);
    assert.equal(existsSync(cachePath), true);
  } finally {
    removeSourceCacheDir(cacheDir);
  }
});

test("corrupt source cache is rejected and creates no records", async () => {
  const created = [];
  const before = youtubeStageChildren();
  const cacheDir = makeSourceCacheDir("corrupt");
  const cachePath = join(cacheDir, cacheFileNameForVideoId("dQw4w9WgXcQ"));
  writeFileSync(cachePath, Buffer.from("not an mp4"));
  const cacheAdapter = createLocalSourceCacheAdapter({
    config: {
      enabled: true,
      dir: cacheDir,
      requireChecksum: false,
      maxBytes: CONFIG.maxUploadBytes,
    },
  });
  const downloader = createWritingAdapter(validMp4Buffer(64));
  const service = createYouTubeIngestService({
    adapter: downloader,
    cacheAdapter,
    dependencies: {
      artifactStore: createFakeArtifactStore(),
      persistenceAdapter: createFakePersistenceAdapter(created),
      logger: null,
      probeMedia: async () => ({ durationSeconds: 18, width: 1280, height: 720, hasAudio: true }),
    },
  });
  try {
    await assert.rejects(
      () => service.ingest({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        rightsConfirmed: true,
      }),
      (error) => {
        assert.equal(error.code, "FILE_SIGNATURE_UNSUPPORTED");
        assert.equal(error.details.cacheChecked, true);
        assert.equal(error.details.cacheHit, true);
        assert.equal(error.details.cacheValidated, false);
        assert.equal(error.details.downloaderFallbackUsed, false);
        assert.equal(error.details.cleanupSucceeded, true);
        assert.doesNotMatch(JSON.stringify(error.details), /\/Users|\/private|storageKey|outputPath|stderr|stdout|cookie|token/i);
        return true;
      },
    );
    assert.equal(created.length, 0);
    assert.equal(downloader.calls.length, 0);
    assert.equal(existsSync(cachePath), true);
    assert.deepEqual(youtubeStageChildren(), before);
  } finally {
    removeSourceCacheDir(cacheDir);
  }
});

test("youtube adapter failures fail closed without leaking raw provider errors", async () => {
  const adapter = {
    downloaderConfigured: true,
    async getMetadata() {
      throw new Error("/Users/example OPENAI_API_KEY=secret raw provider failure");
    },
    health() {
      throw new Error("/Users/example secret health failure");
    },
  };
  await assert.rejects(
    () => validateYouTubeSource({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      rightsConfirmed: true,
      adapter,
    }),
    (error) => {
      assert.equal(error.code, "YOUTUBE_INGEST_NOT_ENABLED");
      assert.doesNotMatch(error.userMessage, /\/Users|OPENAI_API_KEY|raw provider/i);
      return true;
    },
  );
  assert.deepEqual(youtubeIngestHealth(adapter), {
    ready: false,
    mode: "unknown",
    enabled: false,
    networkCalls: false,
    downloaderConfigured: false,
    ingestAvailable: false,
    authorizedImportAvailable: false,
  });
});

test("youtube ingest health rejects malformed adapter readiness without leaking output", () => {
  const adapter = {
    health() {
      return {
        ready: "true",
        mode: "/Users/example OPENAI_API_KEY=secret",
        enabled: "true",
        networkCalls: "yes",
        downloaderConfigured: "true",
        ingestAvailable: "true",
      };
    },
  };
  const health = youtubeIngestHealth(adapter);
  assert.deepEqual(health, {
    ready: false,
    mode: "unknown",
    enabled: false,
    networkCalls: false,
    downloaderConfigured: false,
    ingestAvailable: false,
    authorizedImportAvailable: false,
  });
  assert.doesNotMatch(JSON.stringify(health), /\/Users|OPENAI_API_KEY|secret/i);
});

test("local youtube downloader adapter builds explicit safe args without shell strings", async () => {
  const uploadId = "upl_12345678-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  let captured = null;
  const adapter = createLocalYouTubeIngestAdapter({
    config: {
      enabled: true,
      downloaderBin: "yt-dlp",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
    },
    spawnSync: () => ({ status: 0 }),
    execFile: (command, args, options, callback) => {
      captured = { command, args, options };
      writeFileSync(outputPath, Buffer.concat([mp4Header, Buffer.alloc(128)]));
      callback(null, "", "");
    },
  });
  try {
    await adapter.ingest(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), { outputPath });
  } finally {
    cleanupYouTubeStage(stageDir);
  }
  assert.equal(captured.command, "yt-dlp");
  assert.equal(captured.args.includes("--no-playlist"), true);
  assert.equal(captured.args.includes("--output"), true);
  assert.equal(captured.args.includes(outputPath), true);
  assert.equal(captured.args.at(-1), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(captured.options.timeout, 1000);
  assert.equal(captured.options.maxBuffer, 4096);
  assert.doesNotMatch(captured.args.join(" "), /[;&|`$<>]/);
});

test("local youtube downloader adapter supports safe player client override", async () => {
  const uploadId = "upl_12345678-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  let captured = null;
  const adapter = createLocalYouTubeIngestAdapter({
    config: {
      enabled: true,
      downloaderBin: "yt-dlp",
      playerClient: "android",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
    },
    spawnSync: () => ({ status: 0 }),
    execFile: (command, args, options, callback) => {
      captured = { command, args, options };
      writeFileSync(outputPath, Buffer.concat([mp4Header, Buffer.alloc(128)]));
      callback(null, "", "");
    },
  });
  try {
    await adapter.ingest(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), { outputPath });
  } finally {
    cleanupYouTubeStage(stageDir);
  }
  const extractorIndex = captured.args.indexOf("--extractor-args");
  assert.notEqual(extractorIndex, -1);
  assert.equal(captured.args[extractorIndex + 1], "youtube:player_client=android");
  assert.equal(adapter.health().playerClient, "android");
  assert.doesNotMatch(captured.args.join(" "), /[;&|`$<>]/);
});

test("local youtube downloader adapter retries with fallback format and cleans partial output", async () => {
  const uploadId = "upl_retry12-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  const calls = [];
  const adapter = createLocalYouTubeIngestAdapter({
    config: {
      enabled: true,
      downloaderBin: "yt-dlp",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      formatSelector: "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
      fallbackFormatSelector: "best[ext=mp4]/best",
      downloadAttempts: 2,
      retryBackoffMs: 0,
    },
    spawnSync: () => ({ status: 0, stdout: "2026.01.01\n" }),
    execFile: (_command, args, _options, callback) => {
      calls.push(args);
      if (calls.length === 1) {
        writeFileSync(outputPath, Buffer.from("partial"));
        writeFileSync(`${outputPath}.part`, Buffer.from("partial-fragment"));
        callback(Object.assign(new Error("Requested format is not available"), {
          stderr: "format not available",
        }));
        return;
      }
      assert.equal(existsSync(outputPath), false);
      assert.equal(existsSync(`${outputPath}.part`), false);
      writeFileSync(outputPath, Buffer.concat([mp4Header, Buffer.alloc(128)]));
      callback(null, "", "");
    },
  });
  try {
    const result = await adapter.ingest(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), { outputPath });
    assert.equal(calls.length, 2);
    assert.equal(calls[0][calls[0].indexOf("--format") + 1], "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best");
    assert.equal(calls[1][calls[1].indexOf("--format") + 1], "best[ext=mp4]/best");
    assert.equal(result.attempts, 2);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.formatSelector, "best[ext=mp4]/best");
  } finally {
    cleanupYouTubeStage(stageDir);
  }
});

test("local youtube downloader adapter recovers from unavailable after progress with bounded fallback ladder", async () => {
  const uploadId = "upl_recover1-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  const calls = [];
  const adapter = createLocalYouTubeIngestAdapter({
    config: {
      enabled: true,
      downloaderBin: "yt-dlp",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      formatSelector: "b[height<=720][ext=mp4]/best[height<=720]/best",
      fallbackFormatSelector: "b[height<=480][ext=mp4]/best[height<=480]/best",
      downloadAttempts: 3,
      retryBackoffMs: 0,
    },
    spawnSync: () => ({ status: 0, stdout: "2026.01.01\n" }),
    execFile: (_command, args, _options, callback) => {
      calls.push(args);
      if (calls.length === 1) {
        writeFileSync(outputPath, Buffer.alloc(4096));
        writeFileSync(`${outputPath}.part`, Buffer.alloc(2048));
        callback(Object.assign(new Error("Video unavailable after fragment /Users/raw"), {
          stderr: "raw stderr token",
        }));
        return;
      }
      if (calls.length === 2) {
        assert.equal(existsSync(outputPath), false);
        assert.equal(existsSync(`${outputPath}.part`), false);
        writeFileSync(outputPath, Buffer.from("partial-progressive"));
        callback(Object.assign(new Error("Requested format is not available"), {
          stderr: "format raw stderr",
        }));
        return;
      }
      assert.equal(existsSync(outputPath), false);
      writeFileSync(outputPath, Buffer.concat([mp4Header, Buffer.alloc(128)]));
      callback(null, "", "");
    },
  });
  try {
    const result = await adapter.ingest(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), { outputPath });
    const formats = calls.map((args) => args[args.indexOf("--format") + 1]);
    assert.deepEqual(formats, [
      "b[height<=720][ext=mp4]/best[height<=720]/best",
      "18/best[ext=mp4]/best",
      "b[height<=480][ext=mp4]/best[height<=480]/best",
    ]);
    assert.equal(result.attempts, 3);
    assert.equal(result.attemptsConfigured, 3);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.downloadedOutputReady, true);
    assert.equal(result.attemptDiagnostics.length, 3);
    assert.equal(result.attemptDiagnostics[0].code, "YOUTUBE_DOWNLOAD_INCOMPLETE");
    assert.equal(result.attemptDiagnostics[0].failureClassification, "partial_fragment_unavailable_after_progress");
    assert.equal(result.attemptDiagnostics[0].partialCleanupSucceeded, true);
    assert.equal(result.attemptDiagnostics[1].code, "YOUTUBE_FORMAT_UNAVAILABLE");
    assert.equal(result.attemptDiagnostics[1].recoveryKind, "progressive_mp4");
    assert.equal(result.attemptDiagnostics[2].status, "passed");
    assert.equal(result.attemptDiagnostics[2].recoveryKind, "configured_fallback");
    assert.doesNotMatch(JSON.stringify(result.attemptDiagnostics), /\/Users|stderr|stdout|token|raw/i);
  } finally {
    cleanupYouTubeStage(stageDir);
  }
});

test("local youtube downloader adapter reports exhausted retries safely", async () => {
  const uploadId = "upl_retry34-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  let calls = 0;
  const adapter = createLocalYouTubeIngestAdapter({
    config: {
      enabled: true,
      downloaderBin: "yt-dlp",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      formatSelector: "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
      fallbackFormatSelector: "best[ext=mp4]/best",
      downloadAttempts: 2,
      retryBackoffMs: 0,
    },
    spawnSync: () => ({ status: 0, stdout: "2026.01.01\n" }),
    execFile: (_command, _args, _options, callback) => {
      calls += 1;
      writeFileSync(outputPath, Buffer.from("partial"));
      callback(Object.assign(new Error("HTTP Error 429: too many requests /Users/raw"), {
        stderr: "secret stderr",
      }));
    },
  });
  try {
    await assert.rejects(
      () => adapter.ingest(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), { outputPath }),
      (error) => {
        assert.equal(error.code, "YOUTUBE_RATE_LIMITED");
        assert.equal(error.details.attempts, 2);
        assert.equal(error.details.attemptsConfigured, 2);
        assert.equal(error.details.fallbackUsed, true);
        assert.equal(error.details.phase, "ingest");
        assert.equal(error.details.step, "download_source");
        assert.equal(error.details.substep, "youtube_downloader");
        assert.equal(error.details.partialCleanupSucceeded, true);
        assert.equal(error.details.partialCleanupRemovedCount > 0, true);
        assert.equal(existsSync(outputPath), false);
        assert.doesNotMatch(JSON.stringify(error.details), /\/Users|secret|stderr/i);
        return true;
      },
    );
    assert.equal(calls, 2);
  } finally {
    cleanupYouTubeStage(stageDir);
  }
});

test("local youtube downloader adapter classifies generic failure after partial progress", async () => {
  const uploadId = "upl_incomp1-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  const adapter = createLocalYouTubeIngestAdapter({
    config: {
      enabled: true,
      downloaderBin: "yt-dlp",
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      downloadAttempts: 1,
      progressHeartbeatMs: 250,
      noProgressTimeoutMs: 1000,
    },
    spawnSync: () => ({ status: 0 }),
    execFile: (_command, _args, _options, callback) => {
      writeFileSync(outputPath, Buffer.alloc(4096));
      writeFileSync(`${outputPath}.part`, Buffer.alloc(2048));
      callback(Object.assign(new Error("downloader exited 1 /Users/raw"), {
        stderr: "raw stderr token",
        stdout: "raw stdout",
      }));
    },
  });
  try {
    await assert.rejects(
      () => adapter.ingest(normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), { outputPath }),
      (error) => {
        assert.equal(error.code, "YOUTUBE_DOWNLOAD_INCOMPLETE");
        assert.equal(error.details.failureReason, "download_incomplete_after_progress");
        assert.equal(error.details.safeMessage, SAFE_MESSAGES.YOUTUBE_DOWNLOAD_INCOMPLETE);
        assert.equal(error.details.nextAction, "retry-with-lower-proof-format-or-use-authorized-source-cache");
        assert.equal(error.details.retryable, true);
        assert.equal(error.details.progressBytesObserved >= 4096, true);
        assert.equal(error.details.partialCleanupSucceeded, true);
        assert.equal(error.details.partialCleanupRemovedCount >= 2, true);
        assert.equal(existsSync(outputPath), false);
        assert.equal(existsSync(`${outputPath}.part`), false);
        assert.doesNotMatch(JSON.stringify(error.details), /\/Users|stderr|stdout|token|raw/i);
        return true;
      },
    );
  } finally {
    cleanupYouTubeStage(stageDir);
  }
});

test("local youtube downloader adapter exposes safe format strategy and version metadata", () => {
  const strategy = formatStrategySummary({
    formatSelector: "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/best",
    fallbackFormatSelector: "best[ext=mp4]/best",
    downloadAttempts: 3,
    timeoutMs: 120000,
    playerClient: "android",
  });
  assert.equal(strategy.attemptsConfigured, 3);
  assert.equal(strategy.playerClient, "android");
  assert.equal(strategy.formatSelector, "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/best");
  assert.equal(strategy.fallbackFormatSelector, "best[ext=mp4]/best");
  assert.equal(strategy.continueEnabled, true);
  assert.equal(strategy.resumableStateEnabled, false);
  assert.deepEqual(downloaderVersion("yt-dlp", () => ({ status: 0, stdout: "2026.01.01\n" })), {
    available: true,
    version: "2026.01.01",
  });
  const args = buildDownloaderArgs(
    normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"),
    createYouTubeStagePaths("upl_strategy-1234-1234-1234-123456789abc").outputPath,
    strategy,
    { formatSelector: "b[height<=720][ext=mp4]/best[height<=720]/best" },
  );
  assert.equal(args[args.indexOf("--format") + 1], "b[height<=720][ext=mp4]/best[height<=720]/best");
  assert.equal(args.includes("--continue"), true);
  assert.doesNotMatch(args.join(" "), /[;&|`$]/);
});

test("local youtube downloader adapter reads bounded metadata without downloading media", async () => {
  let captured = null;
  const adapter = createLocalYouTubeIngestAdapter({
    config: {
      enabled: true,
      downloaderBin: "yt-dlp",
      timeoutMs: 120000,
      maxOutputBytes: 4096,
    },
    spawnSync: () => ({ status: 0 }),
    execFile: (command, args, options, callback) => {
      captured = { command, args, options };
      callback(null, "title:Derby Final Highlights\nduration:93\n", "");
    },
  });
  const metadata = await adapter.getMetadata(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"));
  assert.equal(metadata.title, "Derby Final Highlights");
  assert.equal(metadata.durationSeconds, 93);
  assert.equal(metadata.metadataStatus, "local");
  assert.equal(captured.command, "yt-dlp");
  assert.equal(captured.args.includes("--skip-download"), true);
  assert.equal(captured.args.includes("--output"), false);
  assert.equal(captured.args.at(-1), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(captured.options.maxBuffer, 4096);
  assert.equal(captured.options.timeout, 15000);
  assert.doesNotMatch(captured.args.join(" "), /[;&|`$<>]/);
});

test("local youtube metadata helpers sanitize output and fail open to manual title entry", async () => {
  assert.deepEqual(parseMetadataOutput("title:  Derby\u0000 Final   \nduration:not-a-number\n"), {
    title: "Derby Final",
    durationSeconds: null,
  });
  const args = buildMetadataArgs(normalizeYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"));
  assert.equal(args.includes("--skip-download"), true);
  assert.equal(args.includes("--output"), false);

  const adapter = createLocalYouTubeIngestAdapter({
    config: { enabled: true, downloaderBin: "yt-dlp", timeoutMs: 120000, maxOutputBytes: 4096 },
    spawnSync: () => ({ status: 0 }),
    execFile: (_command, _args, _options, callback) => callback(new Error("/Users/raw downloader failure")),
  });
  const metadata = await adapter.getMetadata(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"));
  assert.deepEqual(metadata, {
    title: null,
    durationSeconds: null,
    metadataStatus: "local-unavailable",
    ingestAvailable: true,
  });
});

test("youtube downloader classifier maps auth bot and availability failures to safe contracts", () => {
  const bot = classifyYouTubeDownloaderFailure(Object.assign(new Error("Sign in to confirm you are not a bot"), {
    stderr: "Use --cookies-from-browser or --cookies",
  }));
  assert.equal(bot.code, "YOUTUBE_BOT_CHECK_REQUIRED");
  assert.equal(bot.metadataStatus, "bot-check-required");
  assert.equal(bot.ingestRisk, "authorized-import-required");
  assert.equal(bot.authorizedImportRequired, true);
  assert.equal(bot.retryable, false);

  const privateVideo = classifyYouTubeDownloaderFailure(new Error("This video is private"));
  assert.equal(privateVideo.code, "YOUTUBE_VIDEO_PRIVATE");
  assert.equal(privateVideo.retryable, false);

  const rateLimited = classifyYouTubeDownloaderFailure(new Error("HTTP Error 429: too many requests"));
  assert.equal(rateLimited.code, "YOUTUBE_RATE_LIMITED");
  assert.equal(rateLimited.retryable, true);

  const safeError = toSafeYouTubeDownloaderError(Object.assign(new Error("/Users/raw cookie secret"), {
    stderr: "Sign in to confirm you are not a bot. Use --cookies-from-browser.",
  }));
  assert.equal(safeError.code, "YOUTUBE_BOT_CHECK_REQUIRED");
  assert.equal(safeError.details.authorizedImportRequired, true);
  assert.doesNotMatch(safeError.userMessage, /\/Users|cookies-from-browser|secret/i);
  assert.doesNotMatch(JSON.stringify(safeError.details), /\/Users|cookies-from-browser|secret/i);
});

test("local youtube metadata surfaces authorized import warning without raw downloader output", async () => {
  const adapter = createLocalYouTubeIngestAdapter({
    config: { enabled: true, downloaderBin: "yt-dlp", timeoutMs: 120000, maxOutputBytes: 4096 },
    spawnSync: () => ({ status: 0 }),
    execFile: (_command, _args, _options, callback) => callback(
      Object.assign(new Error("raw failure"), {
        stderr: "Sign in to confirm you are not a bot. Use --cookies-from-browser.",
      }),
    ),
  });
  const metadata = await adapter.getMetadata(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"));
  assert.equal(metadata.metadataStatus, "bot-check-required");
  assert.equal(metadata.ingestRisk, "authorized-import-required");
  assert.equal(metadata.warningCode, "YOUTUBE_BOT_CHECK_REQUIRED");
  assert.equal(metadata.authorizedImportRequired, true);
  assert.equal(metadata.ingestAvailable, true);
  assert.doesNotMatch(JSON.stringify(metadata), /cookies-from-browser|raw failure|\/Users/i);
});

test("local youtube downloader adapter maps timeout and missing tools to safe errors", async () => {
  const uploadId = "upl_abcdef12-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  const source = normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  try {
    const timeoutAdapter = createLocalYouTubeIngestAdapter({
      config: { enabled: true, downloaderBin: "yt-dlp", timeoutMs: 1, maxOutputBytes: 1024 },
      spawnSync: () => ({ status: 0 }),
      execFile: (_command, _args, _options, callback) => callback(Object.assign(new Error("raw /Users/path"), { killed: true })),
    });
    await assert.rejects(
      () => timeoutAdapter.ingest(source, { outputPath }),
      (error) => {
        assert.equal(error.code, "YOUTUBE_DOWNLOAD_TIMEOUT");
        assert.equal(error.details.phase, "ingest");
        assert.equal(error.details.step, "download_source");
        assert.equal(error.details.timeoutClassification, "DOWNLOAD_STALLED_NO_PROGRESS");
        assert.equal(error.details.continueEnabled, true);
        assert.equal(error.details.continueAttempted, true);
        assert.equal(error.details.resumableStateEnabled, false);
        assert.equal(error.details.resumeStateRetained, false);
        assert.equal(error.details.partialCleanupSucceeded, true);
        assert.doesNotMatch(error.userMessage, /\/Users|raw/);
        return true;
      },
    );
    const missingAdapter = createLocalYouTubeIngestAdapter({
      config: { enabled: true, downloaderBin: "yt-dlp", timeoutMs: 1000, maxOutputBytes: 1024 },
      spawnSync: () => ({ status: 127 }),
    });
    await assert.rejects(
      () => missingAdapter.ingest(source, { outputPath }),
      (error) => error.code === "YOUTUBE_DOWNLOADER_MISSING",
    );
  } finally {
    cleanupYouTubeStage(stageDir);
  }
});

test("local youtube downloader adapter distinguishes timeout with observed progress", async () => {
  const uploadId = "upl_prog123-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  const adapter = createLocalYouTubeIngestAdapter({
    config: {
      enabled: true,
      downloaderBin: "yt-dlp",
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      downloadAttempts: 1,
      progressHeartbeatMs: 250,
      noProgressTimeoutMs: 1000,
    },
    spawnSync: () => ({ status: 0 }),
    execFile: (_command, _args, _options, callback) => {
      writeFileSync(outputPath, Buffer.alloc(4096));
      callback(Object.assign(new Error("still downloading"), { killed: true }));
    },
  });
  try {
    await assert.rejects(
      () => adapter.ingest(normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), { outputPath }),
      (error) => {
        assert.equal(error.code, "YOUTUBE_DOWNLOAD_TIMEOUT");
        assert.equal(error.details.timeoutClassification, "DOWNLOAD_TIMED_OUT_WITH_PROGRESS");
        assert.equal(error.details.bytesStillMovingAtTimeout, true);
        assert.equal(error.details.progressBytesObserved >= 4096, true);
        assert.equal(error.details.progressEventCount >= 1, true);
        assert.equal(error.details.lastProgressAgeMs >= 0, true);
        assert.equal(error.details.partialCleanupSucceeded, true);
        assert.equal(existsSync(outputPath), false);
        assert.doesNotMatch(JSON.stringify(error.details), /\/Users|stderr|stdout|cookie|token/i);
        return true;
      },
    );
  } finally {
    cleanupYouTubeStage(stageDir);
  }
});

test("local youtube downloader adapter classifies no-progress stalls safely", async () => {
  const uploadId = "upl_stall12-1234-1234-1234-123456789abc";
  const { stageDir, outputPath } = createYouTubeStagePaths(uploadId);
  mkdirSync(stageDir, { recursive: true });
  let killed = false;
  const adapter = createLocalYouTubeIngestAdapter({
    config: {
      enabled: true,
      downloaderBin: "yt-dlp",
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      downloadAttempts: 1,
      progressHeartbeatMs: 250,
      noProgressTimeoutMs: 30,
    },
    spawnSync: () => ({ status: 0 }),
    execFile: () => ({
      kill(signal) {
        killed = signal === "SIGTERM";
      },
    }),
  });
  try {
    await assert.rejects(
      () => adapter.ingest(normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), { outputPath }),
      (error) => {
        assert.equal(error.code, "YOUTUBE_NO_PROGRESS_TIMEOUT");
        assert.equal(error.details.phase, "ingest");
        assert.equal(error.details.step, "download_source");
        assert.equal(error.details.substep, "youtube_downloader");
        assert.equal(error.details.stallClassification, "no_progress_timeout");
        assert.equal(error.details.timeoutClassification, "DOWNLOAD_STALLED_NO_PROGRESS");
        assert.equal(error.details.noProgressTimeoutMs, 30);
        assert.equal(error.details.progressHeartbeatCount >= 1, true);
        assert.equal(error.details.progressBytesObserved, 0);
        assert.equal(error.details.retryable, true);
        assert.equal(killed, true);
        assert.doesNotMatch(JSON.stringify(error.details), /\/Users|stderr|stdout|cookie|token/i);
        return true;
      },
    );
  } finally {
    cleanupYouTubeStage(stageDir);
  }
});

test("youtube ingest service blocks invalid input before downloader calls", async () => {
  const adapter = createWritingAdapter(Buffer.concat([mp4Header, Buffer.alloc(128)]));
  const created = [];
  const service = createYouTubeIngestService({
    adapter,
    dependencies: {
      artifactStore: createFakeArtifactStore(),
      persistenceAdapter: createFakePersistenceAdapter(created),
      logger: null,
      probeMedia: async () => ({ durationSeconds: 12, width: 1280, height: 720, hasAudio: true }),
    },
  });
  await assert.rejects(
    () => service.ingest({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
      rightsConfirmed: true,
    }),
    (error) => error.code === "YOUTUBE_PLAYLIST_UNSUPPORTED",
  );
  await assert.rejects(
    () => service.ingest({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      rightsConfirmed: false,
    }),
    (error) => error.code === "YOUTUBE_RIGHTS_REQUIRED",
  );
  assert.equal(adapter.calls.length, 0);
  assert.equal(created.length, 0);
});

test("youtube ingest service keeps authorized import failures safe and creates no records", async () => {
  const created = [];
  const logs = [];
  const adapter = {
    async getMetadata() {
      return {
        metadataStatus: "bot-check-required",
        ingestRisk: "authorized-import-required",
        warningCode: "YOUTUBE_BOT_CHECK_REQUIRED",
        nextAction: "try-public-video-or-use-authorized-import",
        authorizedImportRequired: true,
        retryable: false,
        ingestAvailable: true,
      };
    },
    async ingest() {
      throw toSafeYouTubeDownloaderError(Object.assign(new Error("/Users/raw token"), {
        stderr: "Sign in to confirm you are not a bot. Use --cookies-from-browser.",
      }));
    },
    health() {
      return {
        ready: true,
        mode: "local",
        enabled: true,
        networkCalls: true,
        downloaderConfigured: true,
        ingestAvailable: true,
        authorizedImportAvailable: false,
      };
    },
  };
  const service = createYouTubeIngestService({
    adapter,
    dependencies: {
      artifactStore: createFakeArtifactStore(),
      persistenceAdapter: createFakePersistenceAdapter(created),
      logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
      probeMedia: async () => ({ durationSeconds: 18, width: 1280, height: 720, hasAudio: true }),
    },
  });
  await assert.rejects(
    () => service.ingest({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      rightsConfirmed: true,
    }),
    (error) => {
      assert.equal(error.code, "YOUTUBE_BOT_CHECK_REQUIRED");
      assert.equal(error.details.authorizedImportRequired, true);
      assert.equal(error.details.metadataPreflightStatus, "bot-check-required");
      assert.equal(error.details.cleanupSucceeded, true);
      return true;
    },
  );
  assert.equal(created.length, 0);
  const combinedLogs = logs.join("\n");
  assert.match(combinedLogs, /YOUTUBE_BOT_CHECK_REQUIRED/);
  assert.match(combinedLogs, /authorizedImportRequired/);
  assert.match(combinedLogs, /metadata_preflight/);
  assert.match(combinedLogs, /cleanupSucceeded/);
  assert.doesNotMatch(combinedLogs, /\/Users|cookies-from-browser|token|stderr|stdout/i);
});

test("youtube ingest service reports downloader timeout diagnostics and creates no records", async () => {
  const created = [];
  const before = youtubeStageChildren();
  const service = createYouTubeIngestService({
    adapter: {
      async getMetadata() {
        return {
          title: "Long Authorized Match",
          durationSeconds: 540,
          metadataStatus: "local",
          ingestAvailable: true,
        };
      },
      async ingest(_source, ingestOptions = {}) {
        mkdirSync(dirname(ingestOptions.outputPath), { recursive: true });
        writeFileSync(ingestOptions.outputPath, Buffer.from("partial"));
        writeFileSync(`${ingestOptions.outputPath}.part`, Buffer.from("partial"));
        throw new AppError("YOUTUBE_DOWNLOAD_TIMEOUT", SAFE_MESSAGES.YOUTUBE_DOWNLOAD_TIMEOUT, 504, {
          phase: "ingest",
          step: "download_source",
          substep: "youtube_downloader",
          retryable: true,
          attempts: 2,
          attemptsConfigured: 2,
          timeoutMs: 120000,
          formatSelector: "best[ext=mp4]/best",
          fallbackFormatSelector: "best[ext=mp4]/best",
          fallbackUsed: true,
          partialCleanupSucceeded: true,
          partialCleanupRemovedCount: 2,
	          timeoutClassification: "DOWNLOAD_TIMED_OUT_WITH_PROGRESS",
	          progressBytesObserved: 147904182,
	          progressEventCount: 22,
          failureClassification: "download_timeout",
	          continueEnabled: true,
	          continueAttempted: true,
	          resumableStateEnabled: false,
	          resumeStateRetained: false,
          downloadedOutputReady: false,
          attemptDiagnostics: [
            {
              attempt: 1,
              status: "failed",
              formatSelector: "b[height<=720][ext=mp4]/best[height<=720]/best",
              fallbackUsed: false,
              recoveryKind: "primary",
              code: "YOUTUBE_DOWNLOAD_TIMEOUT",
              failureClassification: "download_timeout",
              progressBytesObserved: 147904182,
              partialCleanupSucceeded: true,
              partialCleanupRemovedCount: 2,
              downloadedOutputReady: false,
            },
          ],
	          nextAction: "retry-ingest-or-upload-mp4",
	        });
      },
      health() {
        return {
          ready: true,
          mode: "local",
          enabled: true,
          networkCalls: true,
          downloaderConfigured: true,
          ingestAvailable: true,
          authorizedImportAvailable: false,
        };
      },
    },
    dependencies: {
      artifactStore: createFakeArtifactStore(),
      persistenceAdapter: createFakePersistenceAdapter(created),
      logger: null,
      probeMedia: async () => ({ durationSeconds: 18, width: 1280, height: 720, hasAudio: true }),
    },
  });
  await assert.rejects(
    () => service.ingest({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      rightsConfirmed: true,
    }),
    (error) => {
      assert.equal(error.code, "YOUTUBE_DOWNLOAD_TIMEOUT");
      assert.equal(error.details.step, "download_source");
      assert.equal(error.details.substep, "youtube_downloader");
      assert.equal(error.details.metadataPreflightStatus, "local");
      assert.equal(error.details.metadataPreflightDurationSeconds, 540);
      assert.equal(error.details.cleanupSucceeded, true);
      assert.equal(error.details.fallbackUsed, true);
      assert.equal(error.details.timeoutClassification, "DOWNLOAD_TIMED_OUT_WITH_PROGRESS");
	      assert.equal(error.details.progressBytesObserved, 147904182);
      assert.equal(error.details.failureClassification, "download_timeout");
      assert.equal(error.details.downloadedOutputReady, false);
      assert.equal(error.details.attemptDiagnostics.length, 1);
      assert.equal(error.details.attemptDiagnostics[0].formatSelector, "b[height<=720][ext=mp4]/best[height<=720]/best");
      assert.equal(error.details.attemptDiagnostics[0].partialCleanupSucceeded, true);
	      assert.equal(error.details.continueAttempted, true);
      assert.equal(error.details.resumableStateEnabled, false);
      assert.equal(error.details.sourceAcquisitionStatus, "failed");
      assert.doesNotMatch(JSON.stringify(error.details), /\/Users|stderr|stdout|secret/i);
      return true;
    },
  );
  assert.equal(created.length, 0);
  assert.deepEqual(youtubeStageChildren(), before);
});

test("youtube ingest service creates upload and project only after validation", async () => {
  const created = [];
  const before = youtubeStageChildren();
  const service = createYouTubeIngestService({
    adapter: createWritingAdapter(Buffer.concat([mp4Header, Buffer.alloc(256)]), { title: "Derby Clip" }),
    dependencies: {
      artifactStore: createFakeArtifactStore(),
      persistenceAdapter: createFakePersistenceAdapter(created),
      logger: null,
      probeMedia: async () => ({ durationSeconds: 18, width: 1280, height: 720, hasAudio: true }),
    },
  });
  const result = await service.ingest({
    url: "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    rightsConfirmed: true,
    title: "Safe YouTube Project",
  });
  assert.equal(result.source.sourceType, "youtube");
  assert.equal(result.source.videoId, "dQw4w9WgXcQ");
  assert.match(result.upload.id, /^upl_/);
  assert.match(result.project.id, /^prj_/);
  assert.equal(created.length, 1);
  assert.equal(created[0].upload.metadata.sourceType, "youtube");
  assert.deepEqual(youtubeStageChildren(), before);
  assert.doesNotMatch(JSON.stringify(result), /\/Users|\/private|storageKey|outputPath|filePath|secret/i);
});

test("youtube ingest service cleans staging and creates no records on corrupt or failed probe", async () => {
  for (const [buffer, probeMedia, code] of [
    [Buffer.from("not-video"), async () => ({ durationSeconds: 12 }), "FILE_SIGNATURE_UNSUPPORTED"],
    [
      Buffer.concat([mp4Header, Buffer.alloc(128)]),
      async () => {
        throw new AppError("VIDEO_DURATION_INVALID", SAFE_MESSAGES.VIDEO_DURATION_INVALID, 400);
      },
      "VIDEO_DURATION_INVALID",
    ],
  ]) {
    const created = [];
    const before = youtubeStageChildren();
    const service = createYouTubeIngestService({
      adapter: createWritingAdapter(buffer),
      dependencies: {
        artifactStore: createFakeArtifactStore(),
        persistenceAdapter: createFakePersistenceAdapter(created),
        logger: null,
        probeMedia,
      },
    });
    await assert.rejects(
      () => service.ingest({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        rightsConfirmed: true,
      }),
      (error) => error.code === code,
    );
    assert.equal(created.length, 0);
    assert.deepEqual(youtubeStageChildren(), before);
  }
});
