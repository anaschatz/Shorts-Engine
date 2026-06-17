const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const { CONFIG } = require("../server/config.cjs");
const { detectContainer, validateUploadCandidate, commandAvailable } = require("../server/media.cjs");
const { createEditPlan, validateEditPlan } = require("../server/edit-plan.cjs");
const { JobStore, idempotencyKey } = require("../server/jobs.cjs");
const { runFfmpeg, renderShort } = require("../server/render.cjs");
const { SAFE_MESSAGES } = require("../server/errors.cjs");
const { assertStoragePath, storageHealth, storagePath, writeJsonAtomic } = require("../server/storage.cjs");
const {
  route,
  uploads,
  projects,
  createAppServer,
  attachServerErrorHandler,
  serverListenFailurePayload,
  parseMultipart,
  safeDownloadFileName,
  MAX_JSON_BODY_BYTES,
  MAX_MULTIPART_FIELD_BYTES,
} = require("../server/app.cjs");

const mp4Header = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00,
]);

function mockRequest({ method = "GET", url = "/", headers = {}, body = Buffer.alloc(0) }) {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: "test-client" },
    async *[Symbol.asyncIterator]() {
      if (body.length) yield body;
    },
  };
}

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.entries(headers).forEach(([key, value]) => {
        this.headers[key.toLowerCase()] = value;
      });
    },
    end(chunk) {
      this.body = chunk ? Buffer.from(chunk) : Buffer.alloc(0);
    },
  };
}

function makeMultipart({ fieldName, fileName, mimeType, content }) {
  return makeMultipartParts([{ fieldName, fileName, mimeType, content }]);
}

function makeMultipartParts(parts) {
  const boundary = "----matchcuts-test-boundary";
  const chunks = [];
  for (const part of parts) {
    if (part.fileName !== undefined) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.fieldName}"; filename="${part.fileName}"\r\nContent-Type: ${part.mimeType}\r\n\r\n`,
          "utf8",
        ),
        Buffer.from(part.content),
        Buffer.from("\r\n", "utf8"),
      );
    } else {
      chunks.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.fieldName}"\r\n\r\n`, "utf8"),
        Buffer.from(part.content),
        Buffer.from("\r\n", "utf8"),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

function stagedUploadArtifacts(byteLength, startedAtMs) {
  return readdirSync(CONFIG.uploadDir)
    .filter((fileName) => /^upl_[A-Za-z0-9-]+\.mp4$/.test(fileName))
    .map((fileName) => {
      const filePath = join(CONFIG.uploadDir, fileName);
      const stat = statSync(filePath);
      return { fileName, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .filter((entry) => entry.size === byteLength && entry.mtimeMs >= startedAtMs - 1000);
}

test("backend upload validation rejects unsafe media candidates", () => {
  assert.equal(detectContainer(mp4Header), "mp4");
  const valid = Buffer.concat([mp4Header, Buffer.alloc(64)]);
  const result = validateUploadCandidate({
    fileName: "derby.mp4",
    mimeType: "video/mp4",
    size: valid.length,
    buffer: valid,
  });
  assert.equal(result.extension, "mp4");
  assert.equal(result.container, "mp4");

  assert.throws(
    () =>
      validateUploadCandidate({
        fileName: "../bad.mp4",
        mimeType: "video/mp4",
        size: valid.length,
        buffer: valid,
      }),
    /filename is not safe/i,
  );
  assert.throws(
    () =>
      validateUploadCandidate({
        fileName: "bad.txt",
        mimeType: "text/plain",
        size: 4,
        buffer: Buffer.from("nope"),
      }),
    /supported/i,
  );
});

test("edit plan validation enforces safe MP4 export shapes with captions", () => {
  const metadata = { durationSeconds: 20 };
  const plan = createEditPlan({
    metadata,
    transcript: {
      captions: [
        { start: 0, end: 2, text: "Opening hook" },
        { start: 2, end: 4, text: "Second beat" },
      ],
    },
    preset: "hype",
    title: "Derby",
  });
  const validated = validateEditPlan(plan, metadata);
  assert.equal(validated.aspectRatio, "9:16");
  assert.equal(validated.export.width, 1080);
  assert.equal(validated.export.height, 1920);
  assert.equal(validated.captions.length, 2);
  assert.equal(validated.highlightType, "generic_highlight");
  assert.equal(validated.stylePreset, "social_sports_v1");
  assert.equal(validated.framingMode, "wide_safe_vertical");
  assert.equal(validated.cropStrategy.preserveFullFrame, true);
  assert.ok(validated.animationCues.length > 0);
  assert.ok(validated.captionEmphasis.length > 0);

  const square = validateEditPlan({ ...plan, aspectRatio: "1:1", export: { width: 1080, height: 1080, format: "mp4" } }, metadata);
  assert.equal(square.aspectRatio, "1:1");
  assert.equal(square.export.height, 1080);
  assert.throws(() => validateEditPlan({ ...plan, aspectRatio: "4:5" }, metadata), /Unsupported export aspect ratio/);
  assert.throws(() => validateEditPlan({ ...plan, highlightType: "goalish" }, metadata), /Unsupported highlight type/);
  assert.throws(() => validateEditPlan({ ...plan, framingMode: "tight_crop" }, metadata), /Unsupported framing mode/);
  assert.throws(() => validateEditPlan({ ...plan, effects: ["wide_safe_framing", "secret_effect"] }, metadata), /effect is invalid/);
  assert.throws(
    () =>
      validateEditPlan(
        {
          ...plan,
          visualEvidenceSummary: {
            providerMode: "fixture",
            fallbackUsed: false,
            windowCount: 1,
            topTypes: ["ball_tracker_secret"],
            reasonCodes: ["visual_ball_visible"],
            actionFocusConfidence: 0.5,
          },
        },
        metadata,
      ),
    /Visual evidence type is invalid/,
  );
  assert.throws(
    () =>
      validateEditPlan(
        {
          ...plan,
          captionEmphasis: [{ captionIndex: 0, words: ["OPEN"], style: "unsafe_script", start: 0, end: 1 }],
        },
        metadata,
      ),
    /Caption emphasis style is invalid/,
  );
  assert.throws(
    () =>
      validateEditPlan(
        {
          ...plan,
          highlightType: "save",
          reasonCodes: ["save"],
          hook: "WHAT A GOAL",
          captions: [{ start: 0, end: 2, text: "Goal changes everything" }],
        },
        metadata,
      ),
    /goal language/i,
  );
});

test("job lifecycle supports idempotency and cancellation", () => {
  const store = new JobStore();
  const key = idempotencyKey("generate", { projectId: "p1", uploadId: "u1" });
  const first = store.create({ projectId: "p1", action: "generate", idempotencyKey: key });
  const second = store.create({ projectId: "p1", action: "generate", idempotencyKey: key });
  assert.equal(first.id, second.id);
  store.update(first, { status: "processing", progress: 25 });
  const cancelled = store.cancel(first.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(store.publicJob(cancelled)._controller, undefined);
});

test("job store clamps progress and rejects invalid terminal transitions", () => {
  const store = new JobStore();
  const job = store.create({ projectId: "p1", action: "generate", idempotencyKey: "state-key" });
  store.update(job, { status: "processing", progress: 148 });
  assert.equal(job.progress, 100);
  store.update(job, { progress: -10 });
  assert.equal(job.progress, 0);
  store.complete(job, { outputPath: "render.mp4" });
  assert.equal(job.status, "completed");
  assert.equal(job.progress, 100);
  assert.equal(job.step, "completed");
  assert.throws(() => store.update(job, { progress: 80 }), (error) => error.code === "JOB_STATE_INVALID");
  assert.throws(() => store.update(job, { status: "processing" }), (error) => error.code === "JOB_STATE_INVALID");
  assert.throws(() => store.cancel(job.id), (error) => error.code === "CANCEL_NOT_SUPPORTED");
});

test("job failures keep user-facing messages safe", () => {
  const store = new JobStore();
  const job = store.create({ projectId: "p1", action: "generate", idempotencyKey: "safe-key" });
  store.fail(job, new Error("/Users/example/project OPENAI_API_KEY=secret-provider-details"));
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "RENDER_FAILED");
  assert.equal(job.error.message, SAFE_MESSAGES.RENDER_FAILED);
});

test("storage adapter keeps project files inside configured roots", () => {
  const filePath = storagePath("projects", `storage-test-${Date.now()}.json`);
  writeJsonAtomic(filePath, { ok: true, nested: { value: 1 } });
  assert.equal(existsSync(filePath), true);
  assert.equal(assertStoragePath(filePath, "projects"), filePath);
  assert.throws(() => storagePath("projects", "../outside.json"), (error) => error.code === "STORAGE_PATH_UNSAFE");
  assert.throws(() => assertStoragePath("/etc/passwd", "renders"), (error) => error.code === "STORAGE_PATH_UNSAFE");
  const health = storageHealth();
  assert.equal(typeof health.projects.readable, "boolean");
  assert.equal(typeof health.projects.writable, "boolean");
});

test("multipart upload parser rejects unexpected and duplicate file fields", () => {
  const unexpected = makeMultipart({
    fieldName: "attachment",
    fileName: "clip.mp4",
    mimeType: "video/mp4",
    content: Buffer.concat([mp4Header, Buffer.alloc(64)]),
  });
  assert.throws(() => parseMultipart(unexpected.body, unexpected.contentType), (error) => error.code === "UPLOAD_FIELD_INVALID");

  const duplicate = makeMultipartParts([
    { fieldName: "video", fileName: "one.mp4", mimeType: "video/mp4", content: Buffer.concat([mp4Header, Buffer.alloc(64)]) },
    { fieldName: "video", fileName: "two.mp4", mimeType: "video/mp4", content: Buffer.concat([mp4Header, Buffer.alloc(64)]) },
  ]);
  assert.throws(() => parseMultipart(duplicate.body, duplicate.contentType), (error) => error.code === "UPLOAD_FIELD_INVALID");
});

test("multipart parser bounds boundaries, headers and field sizes", () => {
  const oversizedField = makeMultipartParts([
    { fieldName: "title", content: Buffer.alloc(MAX_MULTIPART_FIELD_BYTES + 1, "a") },
    { fieldName: "video", fileName: "clip.mp4", mimeType: "video/mp4", content: Buffer.concat([mp4Header, Buffer.alloc(64)]) },
  ]);
  assert.throws(() => parseMultipart(oversizedField.body, oversizedField.contentType), (error) => error.code === "UPLOAD_FIELD_INVALID");

  const unsafeBoundary = Buffer.from("--bad boundary\r\n\r\n--bad boundary--\r\n");
  assert.throws(() => parseMultipart(unsafeBoundary, "multipart/form-data; boundary=bad boundary"), (error) => error.code === "VALIDATION_ERROR");
});

test("render worker reports missing FFmpeg safely", async () => {
  await assert.rejects(
    () => runFfmpeg(["-version"], { ffmpegBin: "definitely-not-ffmpeg-for-matchcuts" }),
    (error) => error.code === "FFMPEG_MISSING",
  );
});

test("API health returns structured status", async () => {
  const req = mockRequest({ method: "GET", url: "/health" });
  const res = mockResponse();
  await route(req, res);
  const payload = JSON.parse(res.body.toString("utf8"));
  assert.equal(res.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.service, "shortsengine-mvp");
  assert.ok(["ready", "degraded"].includes(payload.data.status));
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(typeof payload.data.ffmpeg.ffmpeg, "boolean");
  assert.equal(typeof payload.data.storage.uploads.readable, "boolean");
  assert.equal(payload.data.artifacts.ready, true);
  assert.equal(payload.data.adapters.artifacts.mode, "local");
  assert.equal(payload.data.adapters.artifacts.objectStorage, false);
  assert.equal(payload.data.adapters.artifacts.capabilities.createArtifactRecord, true);
  assert.equal(payload.data.adapters.persistence.mode, "local");
  assert.equal(payload.data.adapters.persistence.database, false);
  assert.equal(payload.data.adapters.persistence.capabilities.createProject, true);
  assert.equal(payload.data.adapters.persistence.capabilities.createArtifact, true);
  assert.equal(payload.data.repositories.projects.ready, true);
  assert.equal(typeof payload.data.repositories.uploads.total, "number");
  assert.equal(payload.data.repositories.artifacts.ready, true);
  assert.equal(payload.data.artifactIndexReady, true);
  assert.equal(typeof payload.data.cleanupWorkerConfigured, "boolean");
  assert.equal(payload.data.cleanupLastRunAt === null || typeof payload.data.cleanupLastRunAt === "string", true);
  assert.equal(payload.data.cleanupLastResult === null || typeof payload.data.cleanupLastResult === "object", true);
  assert.equal(typeof payload.data.realCloudIntegrationEnabled, "boolean");
  assert.equal(payload.data.jobs.persisted, true);
  assert.equal(typeof payload.data.jobs.statuses.queued, "number");
  assert.equal(typeof payload.data.jobs.staleProcessing, "number");
  assert.equal(payload.data.queue.adapter, "local-job-queue");
  assert.equal(payload.data.queue.workerRuntime.multiWorkerSafe, true);
  assert.equal(typeof payload.data.queue.workers.active, "number");
  assert.equal(typeof payload.data.queue.leases.active, "number");
  assert.equal(typeof payload.data.queue.jobs.retryScheduled, "number");
  assert.equal(typeof payload.data.worker.workerId, "string");
  assert.equal(typeof payload.data.worker.running, "number");
  assert.equal(typeof payload.data.worker.heartbeat.enabled, "boolean");
  assert.equal(typeof payload.data.worker.heartbeat.intervalMs, "number");
  assert.ok(["running", "draining", "stopping", "stopped"].includes(payload.data.supervisor.state));
  assert.equal(typeof payload.data.supervisor.drainMode, "boolean");
  assert.equal(typeof payload.data.supervisor.activeJobs, "number");
  assert.equal(typeof payload.data.supervisor.queuedJobs, "number");
  assert.equal(typeof payload.data.supervisor.retryScheduled, "number");
  assert.equal(typeof payload.data.supervisor.activeLeases, "number");
  assert.equal(typeof payload.data.supervisor.worker.heartbeat.enabled, "boolean");
  assert.equal(typeof payload.data.transcription.activeProvider, "string");
  assert.equal(payload.data.analysis.ready, true);
  assert.equal(payload.data.analysis.features.includes("candidate_edit_plans"), true);
  assert.equal(payload.data.frameExtraction.ready, true);
  assert.equal(payload.data.frameExtraction.fallbackMode, "mock");
  assert.equal(payload.data.frameExtraction.objectTracking, false);
  assert.equal(payload.data.vision.ready, true);
  assert.equal(payload.data.vision.goalClaimAllowed, false);
  assert.equal(payload.data.vision.externalProviderEnabled, false);
  assert.equal(payload.data.vision.fallbackAvailable, true);
  assert.equal(payload.data.vision.allowedLabels.includes("crowd_reaction"), true);
  assert.equal(payload.data.youtubeIngest.mode, "mock");
  assert.equal(payload.data.youtubeIngest.enabled, false);
  assert.equal(payload.data.youtubeIngest.networkCalls, false);
  assert.equal(payload.data.youtubeIngest.downloaderConfigured, false);
  assert.equal(payload.data.youtubeIngest.ingestAvailable, false);
  assert.equal(payload.data.youtubeIngest.authorizedImportAvailable, false);
  assert.equal(payload.data.releaseReadiness.ready, true);
  assert.equal(payload.data.releaseReadiness.networkCalls, false);
  assert.equal(payload.data.releaseReadiness.remoteMutation, false);
  assert.equal(payload.data.releaseReadiness.remoteProof.automaticAuth, false);
  assert.doesNotMatch(JSON.stringify(payload.data), /\/Users\//);
  assert.doesNotMatch(JSON.stringify(payload.data), /storageKey|outputPath|jobDir/);
  assert.doesNotMatch(JSON.stringify(payload.data.jobs), /data\/jobs|jobDir|\/private\//);
  assert.doesNotMatch(JSON.stringify(payload.data.queue), /\/Users|\/private|storageKey|outputPath|filePath|secret/i);
  assert.doesNotMatch(JSON.stringify(payload.data.releaseReadiness), /\/Users|\/private|storageKey|secret|ghp_|github_pat_|Bearer\s+|sk-[A-Za-z0-9_-]{10,}/i);
});

test("API validates authorized YouTube URLs without creating renderable uploads", async () => {
  const body = Buffer.from(JSON.stringify({
    url: "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    rightsConfirmed: true,
  }));
  const req = mockRequest({
    method: "POST",
    url: "/api/youtube/validate",
    headers: {
      "content-type": "application/json",
      "content-length": String(body.length),
    },
    body,
  });
  const res = mockResponse();
  await route(req, res);
  const payload = JSON.parse(res.body.toString("utf8"));
  assert.equal(res.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.source.sourceType, "youtube");
  assert.equal(payload.data.source.videoId, "dQw4w9WgXcQ");
  assert.equal(payload.data.source.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(payload.data.source.ingestAvailable, false);
  assert.equal(payload.data.source.downloaderConfigured, false);
  assert.equal(payload.data.source.nextAction, "youtube-ingest-disabled-until-mp4-artifact-exists");
  assert.equal(payload.data.upload, undefined);
  assert.equal(payload.data.project, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /\/Users|\/private|storageKey|secret|token|outputPath|filePath/i);
});

test("API keeps YouTube ingest disabled by default without creating records", async () => {
  const body = Buffer.from(JSON.stringify({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
  }));
  const beforeUploads = uploads.size;
  const beforeProjects = projects.size;
  const req = mockRequest({
    method: "POST",
    url: "/api/youtube/ingest",
    headers: {
      "content-type": "application/json",
      "content-length": String(body.length),
    },
    body,
  });
  const res = mockResponse();
  await route(req, res);
  const payload = JSON.parse(res.body.toString("utf8"));
  assert.equal(res.statusCode, 503);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "YOUTUBE_INGEST_NOT_ENABLED");
  assert.equal(uploads.size, beforeUploads);
  assert.equal(projects.size, beforeProjects);
  assert.doesNotMatch(JSON.stringify(payload), /\/Users|\/private|storageKey|secret|token|outputPath|filePath|stderr|stack/i);
});

test("API rejects unsafe YouTube validation input with safe structured errors", async () => {
  for (const [url, rightsConfirmed, code] of [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", false, "YOUTUBE_RIGHTS_REQUIRED"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123", true, "YOUTUBE_PLAYLIST_UNSUPPORTED"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", true, "YOUTUBE_LIVE_UNSUPPORTED"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", true, "YOUTUBE_URL_INVALID"],
    [`https://www.youtube.com/watch?v=dQw4w9WgXcQ${"a".repeat(2200)}`, true, "YOUTUBE_URL_INVALID"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ\u0000", true, "YOUTUBE_URL_INVALID"],
    ["file:///Users/example/video.mp4", true, "YOUTUBE_URL_INVALID"],
    ["https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ", true, "YOUTUBE_URL_INVALID"],
  ]) {
    const body = Buffer.from(JSON.stringify({ url, rightsConfirmed }));
    const req = mockRequest({
      method: "POST",
      url: "/api/youtube/validate",
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
    });
    const res = mockResponse();
    await route(req, res);
    const payload = JSON.parse(res.body.toString("utf8"));
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, code);
    assert.doesNotMatch(JSON.stringify(payload), /\/Users|user:pass|storageKey|secret|token|stack/i);
  }
});

test("API YouTube validation enforces JSON content type and bounded body size", async () => {
  const validBody = Buffer.from(JSON.stringify({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
  }));
  const wrongType = mockRequest({
    method: "POST",
    url: "/api/youtube/validate",
    headers: {
      "content-type": "text/plain",
      "content-length": String(validBody.length),
    },
    body: validBody,
  });
  const wrongTypeRes = mockResponse();
  await route(wrongType, wrongTypeRes);
  const wrongTypePayload = JSON.parse(wrongTypeRes.body.toString("utf8"));
  assert.equal(wrongTypeRes.statusCode, 415);
  assert.equal(wrongTypePayload.ok, false);
  assert.equal(wrongTypePayload.error.code, "VALIDATION_ERROR");

  const oversized = Buffer.alloc(MAX_JSON_BODY_BYTES + 1, "a");
  const tooLarge = mockRequest({
    method: "POST",
    url: "/api/youtube/validate",
    headers: {
      "content-type": "application/json",
      "content-length": String(oversized.length),
    },
    body: oversized,
  });
  const tooLargeRes = mockResponse();
  await route(tooLarge, tooLargeRes);
  const tooLargePayload = JSON.parse(tooLargeRes.body.toString("utf8"));
  assert.equal(tooLargeRes.statusCode, 413);
  assert.equal(tooLargePayload.ok, false);
  assert.equal(tooLargePayload.error.code, "FILE_TOO_LARGE");
  assert.doesNotMatch(JSON.stringify(tooLargePayload), /\/Users|\/private|storageKey|secret|token|stack/i);
});

test("server listen failures are logged as safe structured events", () => {
  const payload = serverListenFailurePayload(
    {
      code: "EADDRINUSE",
      syscall: "listen",
      stack: "/Users/example/project OPENAI_API_KEY=secret",
      path: "/Users/example/project/server/app.cjs",
    },
    4175,
  );

  assert.equal(payload.level, "error");
  assert.equal(payload.event, "server_listen_failed");
  assert.equal(payload.code, "EADDRINUSE");
  assert.equal(payload.port, 4175);
  assert.doesNotMatch(JSON.stringify(payload), /\/Users|\/private|OPENAI_API_KEY|secret|stack|filePath|path/i);
});

test("server startup error handler prevents unhandled listen error path leaks", () => {
  const server = createAppServer();
  const lines = [];
  attachServerErrorHandler(server, {
    port: 4175,
    logger: {
      error(line) {
        lines.push(line);
      },
    },
  });

  server.emit("error", Object.assign(new Error("/Users/example/server/app.cjs"), {
    code: "EACCES",
    syscall: "listen",
    address: "/Users/example/socket",
  }));

  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.event, "server_listen_failed");
  assert.equal(payload.code, "EACCES");
  assert.doesNotMatch(lines[0], /\/Users|\/private|socket|app\.cjs|stack|secret/i);
});

test("download filenames are normalized for Content-Disposition", () => {
  assert.equal(safeDownloadFileName('bad"name\r\n.mp4', "fallback.mp4"), "bad_name_.mp4");
  assert.equal(safeDownloadFileName("../unsafe", "project-short.mp4"), "unsafe.mp4");
  assert.equal(safeDownloadFileName("", "project-short.mp4"), "project-short.mp4");
});

test("API rejects invalid upload with structured error", async () => {
  const multipart = makeMultipart({
    fieldName: "video",
    fileName: "bad.txt",
    mimeType: "text/plain",
    content: "not a real video",
  });
  const req = mockRequest({
    method: "POST",
    url: "/api/uploads",
    headers: { "content-type": multipart.contentType },
    body: multipart.body,
  });
  const res = mockResponse();
  await route(req, res);
  const payload = JSON.parse(res.body.toString("utf8"));
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "FILE_TYPE_UNSUPPORTED");
});

test("API cleans staged upload artifact when media probe fails", async () => {
  const corruptMp4 = Buffer.concat([mp4Header, Buffer.alloc(128, 1)]);
  const before = Date.now();
  const multipart = makeMultipart({
    fieldName: "video",
    fileName: "corrupt.mp4",
    mimeType: "video/mp4",
    content: corruptMp4,
  });
  const req = mockRequest({
    method: "POST",
    url: "/api/uploads",
    headers: { "content-type": multipart.contentType },
    body: multipart.body,
  });
  const res = mockResponse();
  await route(req, res);
  const payload = JSON.parse(res.body.toString("utf8"));

  assert.equal(payload.ok, false);
  assert.ok(["VIDEO_DURATION_INVALID", "FFPROBE_MISSING"].includes(payload.error.code));
  assert.deepEqual(stagedUploadArtifacts(corruptMp4.length, before), []);
});

test("API rejects oversized declared uploads before reading media", async () => {
  const req = mockRequest({
    method: "POST",
    url: "/api/uploads",
    headers: {
      "content-type": "multipart/form-data; boundary=oversized",
      "content-length": String(CONFIG.maxUploadBytes + 1024 * 1024 + 1),
    },
  });
  const res = mockResponse();
  await route(req, res);
  const payload = JSON.parse(res.body.toString("utf8"));
  assert.equal(res.statusCode, 413);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "FILE_TOO_LARGE");
});

test("API rejects oversized generate JSON before job creation", async () => {
  const projectId = "prj_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const uploadId = "upl_dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  projects.set(projectId, { id: projectId, uploadId, title: "Derby Final" });
  uploads.set(uploadId, { id: uploadId, metadata: { durationSeconds: 10 } });
  try {
    const body = Buffer.from(`{"title":"${"x".repeat(MAX_JSON_BODY_BYTES)}","rightsConfirmed":true}`);
    const req = mockRequest({
      method: "POST",
      url: `/api/projects/${projectId}/generate`,
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
    });
    const res = mockResponse();
    await route(req, res);
    const payload = JSON.parse(res.body.toString("utf8"));

    assert.equal(res.statusCode, 413);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "FILE_TOO_LARGE");
  } finally {
    projects.delete(projectId);
    uploads.delete(uploadId);
  }
});

test("static serving blocks repo internals and traversal fallback", async () => {
  for (const url of ["/server/app.cjs", "/%2e%2e/server/app.cjs"]) {
    const req = mockRequest({ method: "GET", url });
    const res = mockResponse();
    await route(req, res);
    const body = res.body.toString("utf8");
    const payload = JSON.parse(body);
    assert.equal(res.statusCode, 404);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "ROUTE_NOT_FOUND");
    assert.doesNotMatch(body, /createServer|\/Users\//);
  }
});

test("API rejects malformed resource ids and unsafe idempotency keys", async () => {
  const malformedReq = mockRequest({ method: "GET", url: "/api/jobs/not-valid" });
  const malformedRes = mockResponse();
  await route(malformedReq, malformedRes);
  const malformedPayload = JSON.parse(malformedRes.body.toString("utf8"));
  assert.equal(malformedPayload.ok, false);
  assert.equal(malformedPayload.error.code, "RESOURCE_ID_INVALID");

  const projectId = "prj_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const uploadId = "upl_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  projects.set(projectId, { id: projectId, uploadId, title: "Derby Final" });
  uploads.set(uploadId, { id: uploadId, metadata: { durationSeconds: 10 } });
  try {
    const req = mockRequest({
      method: "POST",
      url: `/api/projects/${projectId}/generate`,
      body: Buffer.from(JSON.stringify({ rightsConfirmed: true, idempotencyKey: "bad key!" })),
    });
    const res = mockResponse();
    await route(req, res);
    const payload = JSON.parse(res.body.toString("utf8"));
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "VALIDATION_ERROR");
  } finally {
    projects.delete(projectId);
    uploads.delete(uploadId);
  }
});

test("render smoke creates a vertical MP4 when FFmpeg is installed", async (t) => {
  if (!commandAvailable(CONFIG.ffmpegBin) || !commandAvailable(CONFIG.ffprobeBin)) {
    t.skip("FFmpeg/FFprobe not installed in this environment");
    return;
  }
  mkdirSync(CONFIG.tmpDir, { recursive: true });
  const input = join(CONFIG.tmpDir, "synthetic-input.mp4");
  const output = join(CONFIG.tmpDir, "synthetic-output.mp4");
  const subtitles = join(CONFIG.tmpDir, "synthetic-output.ass");
  const makeInput = spawnSync(CONFIG.ffmpegBin, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=44100",
    "-t",
    "4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    input,
  ]);
  assert.equal(makeInput.status, 0);
  const plan = validateEditPlan(
    createEditPlan({
      metadata: { durationSeconds: 4 },
      transcript: { captions: [{ start: 0, end: 2.5, text: "Synthetic football hook" }] },
      preset: "hype",
      title: "Synthetic",
    }),
    { durationSeconds: 4 },
  );
  await renderShort({ inputPath: input, outputPath: output, subtitlesPath: subtitles, plan });
  assert.equal(existsSync(output), true);
});
