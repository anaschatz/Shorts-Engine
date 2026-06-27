const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const { CONFIG } = require("../server/config.cjs");
const { AppError, SAFE_MESSAGES } = require("../server/errors.cjs");
const {
  buildMetadataArgs,
  createLocalYouTubeIngestAdapter,
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
      return true;
    },
  );
  assert.equal(created.length, 0);
  const combinedLogs = logs.join("\n");
  assert.match(combinedLogs, /YOUTUBE_BOT_CHECK_REQUIRED/);
  assert.match(combinedLogs, /authorizedImportRequired/);
  assert.doesNotMatch(combinedLogs, /\/Users|cookies-from-browser|token|stderr|stdout/i);
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
