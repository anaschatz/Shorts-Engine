const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const { CONFIG } = require("../server/config.cjs");
const { AppError, SAFE_MESSAGES } = require("../server/errors.cjs");
const { createLocalYouTubeIngestAdapter } = require("../server/adapters/local-youtube-ingest-adapter.cjs");
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
  });
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
  });
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
