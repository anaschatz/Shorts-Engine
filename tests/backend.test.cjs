const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const TEST_TMP_ROOT = resolve(__dirname, "..", "tmp");
mkdirSync(TEST_TMP_ROOT, { recursive: true });
const TEST_DATA_DIR = mkdtempSync(resolve(TEST_TMP_ROOT, "backend-data-"));
process.env.MATCHCUTS_DATA_DIR = TEST_DATA_DIR;

test.after(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

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
  publicHumanVisualReviewReport,
  MAX_JSON_BODY_BYTES,
  MAX_MULTIPART_FIELD_BYTES,
  jobs,
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

function backendReviewIds(suffix = "aaaa") {
  return {
    projectId: `prj_${suffix}${suffix}${suffix}${suffix}-${suffix}-4${suffix.slice(1)}-${suffix}-${suffix}${suffix}${suffix}`,
    uploadId: `upl_${suffix}${suffix}${suffix}${suffix}-${suffix}-4${suffix.slice(1)}-${suffix}-${suffix}${suffix}${suffix}`,
    jobId: `job_${suffix}${suffix}${suffix}${suffix}-${suffix}-4${suffix.slice(1)}-${suffix}-${suffix}${suffix}${suffix}`,
    exportId: `exp_${suffix}${suffix}${suffix}${suffix}-${suffix}-4${suffix.slice(1)}-${suffix}-${suffix}${suffix}${suffix}`,
  };
}

let backendReviewSuffixCounter = 0;

function isolatedReviewSuffix(seed = "t") {
  backendReviewSuffixCounter += 1;
  const suffixSeed = `${seed}${process.pid}${Date.now()}${backendReviewSuffixCounter}`;
  return suffixSeed.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-4).padStart(4, "a");
}

function writeBackendReviewRecords(overrides = {}) {
  const ids = overrides.ids || backendReviewIds(overrides.suffix || "aaaa");
  const uploadPath = overrides.uploadPath || storagePath("uploads", `${ids.uploadId}.mp4`);
  const renderPath = overrides.renderPath || storagePath("renders", `${ids.jobId}.mp4`);
  if (overrides.writeUpload === false) rmSync(uploadPath, { force: true });
  else writeFileSync(uploadPath, Buffer.from("review-source-video"));
  if (overrides.writeRender === false) rmSync(renderPath, { force: true });
  else writeFileSync(renderPath, Buffer.from("review-rendered-video"));
  let editPlan = validateEditPlan(
    createEditPlan({
      metadata: { durationSeconds: 16, width: 1920, height: 1080 },
      transcript: {
        captions: [
          { start: 0, end: 2, text: "The chance opens" },
          { start: 2, end: 4, text: "Pressure builds fast" },
          { start: 4, end: 7, text: "Almost punished in one touch" },
        ],
      },
      preset: "hype",
      title: "Review registration API sample",
    }),
    { durationSeconds: 16 },
  );
  if (typeof overrides.mutateEditPlan === "function") {
    editPlan = overrides.mutateEditPlan(editPlan) || editPlan;
  }
  const projectRecord = {
    project: {
      id: ids.projectId,
      uploadId: ids.uploadId,
      title: "Review registration API sample",
      status: "ready",
    },
    upload: {
      id: ids.uploadId,
      projectId: ids.projectId,
      path: uploadPath,
      metadata: { durationSeconds: 16, width: 1920, height: 1080 },
      byteSize: 19,
      extension: "mp4",
      artifact: {
        id: ids.uploadId,
        type: "upload",
        ownerProjectId: ids.projectId,
        status: "available",
        size: 19,
        contentType: "video/mp4",
        storageKey: `${ids.uploadId}.mp4`,
      },
    },
  };
  const renderRecord = {
    project: projectRecord.project,
    job: {
      id: ids.jobId,
      projectId: ids.projectId,
      uploadId: ids.uploadId,
      status: overrides.jobStatus || "completed",
      exportId: ids.exportId,
      payload: {
        language: "English",
        stylePreset: "social_sports_v1",
        styleTarget: "vertical_9_16_reference_style",
      },
    },
    exportId: ids.exportId,
    exportRecord: {
      id: ids.exportId,
      projectId: ids.projectId,
      jobId: ids.jobId,
      outputPath: renderPath,
      fileName: `${ids.projectId}-short.mp4`,
      artifact: {
        id: ids.exportId,
        type: "export",
        ownerProjectId: ids.projectId,
        ownerJobId: ids.jobId,
        status: "available",
        size: 21,
        contentType: "video/mp4",
        storageKey: `${ids.jobId}.mp4`,
      },
    },
    highlights: [{
      start: editPlan.sourceStart,
      end: editPlan.sourceEnd,
      highlightType: "big_chance",
      reasonCodes: ["big_chance", "audio_energy_spike", "crowd_reaction"],
      retentionScore: 88,
    }],
    editPlan,
  };
  writeJsonAtomic(storagePath("projects", `${ids.projectId}.json`), projectRecord);
  writeJsonAtomic(storagePath("projects", `${ids.projectId}.render.json`), renderRecord);
  return ids;
}

async function postJson(url, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const req = mockRequest({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      "content-length": String(body.length),
    },
    body,
  });
  const res = mockResponse();
  await route(req, res);
  return { res, payload: JSON.parse(res.body.toString("utf8")) };
}

function writeOcrQaApiFixture(t) {
  const runId = `ocr-api-${process.pid}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const relativeDir = `demo/results/ocr-artifacts/${runId}`;
  const absoluteDir = join(CONFIG.rootDir, relativeDir);
  const resultsDir = join(CONFIG.rootDir, "demo", "results");
  const latestReportPath = join(resultsDir, "ocr-latest.json");
  const reviewLatestPath = join(resultsDir, "ocr-qa-review-latest.json");
  const beforeFiles = new Set(existsSync(resultsDir) ? readdirSync(resultsDir) : []);
  const previousLatest = existsSync(latestReportPath) ? readFileSync(latestReportPath) : null;
  const previousReviewLatest = existsSync(reviewLatestPath) ? readFileSync(reviewLatestPath) : null;
  mkdirSync(absoluteDir, { recursive: true });
  const cropRef = `${relativeDir}/ocr-crop-01.png`;
  writeFileSync(join(CONFIG.rootDir, cropRef), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]));
  const manifestRef = `${relativeDir}/ocr-qa-manifest.json`;
  writeFileSync(join(CONFIG.rootDir, manifestRef), JSON.stringify({
    schemaVersion: 1,
    kind: "ocr-crop-qa-artifacts",
    runId,
    generatedAt: "2026-06-19T00:00:00.000Z",
    directory: relativeDir,
    cropCount: 1,
    maxCropCount: 12,
    maxArtifactBytes: 512000,
    files: [{
      id: "ocr-crop-01",
      kind: "scoreboard_crop",
      sizeBytes: 12,
      relativePath: cropRef,
    }],
    relativeRefsOnly: true,
    fullFramesStored: false,
    ocrTextStored: false,
    logsDownloaded: false,
    artifactsDownloaded: false,
  }, null, 2));
  writeFileSync(latestReportPath, JSON.stringify({
    schemaVersion: 1,
    status: "passed",
    qaArtifactManifest: { relativePath: manifestRef },
  }, null, 2));

  t.after(() => {
    rmSync(absoluteDir, { recursive: true, force: true });
    if (previousLatest) writeFileSync(latestReportPath, previousLatest);
    else rmSync(latestReportPath, { force: true });
    if (previousReviewLatest) writeFileSync(reviewLatestPath, previousReviewLatest);
    else rmSync(reviewLatestPath, { force: true });
    if (existsSync(resultsDir)) {
      for (const fileName of readdirSync(resultsDir)) {
        if (!beforeFiles.has(fileName) && /^ocr-qa-review-.*\.json$/.test(fileName)) {
          rmSync(join(resultsDir, fileName), { force: true });
        }
      }
    }
  });

  return { manifestRef, cropRef };
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
  assert.equal(validated.captions[0].role, "opening_hook");
  assert.equal(validated.captions[1].role, "closing_punch");
  assert.equal(validated.framingMode, "wide_safe_vertical");
  assert.equal(validated.cropStrategy.preserveFullFrame, true);
  assert.ok(validated.animationCues.length > 0);
  assert.ok(validated.captionEmphasis.length > 0);

  const square = validateEditPlan({ ...plan, aspectRatio: "1:1", export: { width: 1080, height: 1080, format: "mp4" } }, metadata);
  assert.equal(square.aspectRatio, "1:1");
  assert.equal(square.export.height, 1080);
  const referenceStyle = validateEditPlan({ ...plan, stylePreset: "reference_football_multi_goal_v1" }, metadata);
  assert.equal(referenceStyle.stylePreset, "reference_football_multi_goal_v1");
  assert.throws(() => validateEditPlan({ ...plan, aspectRatio: "4:5" }, metadata), /Unsupported export aspect ratio/);
  assert.throws(() => validateEditPlan({ ...plan, highlightType: "goalish" }, metadata), /Unsupported highlight type/);
  assert.throws(() => validateEditPlan({ ...plan, framingMode: "tight_crop" }, metadata), /Unsupported framing mode/);
  assert.throws(() => validateEditPlan({ ...plan, stylePreset: "neon_chaos" }, metadata), /Unsupported edit style preset/);
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
  assert.equal(payload.data.repositories.regenerationDrafts.ready, true);
  assert.equal(payload.data.repositories.regenerationApprovals.ready, true);
  assert.equal(payload.data.repositories.approvalOutbox.ready, true);
  assert.equal(typeof payload.data.repositories.approvalOutbox.statuses.pending, "number");
  assert.equal(payload.data.outbox.ready, true);
  assert.equal(payload.data.outbox.externalDeliveryEnabled, false);
  assert.equal(typeof payload.data.outbox.pending, "number");
  assert.equal(typeof payload.data.outbox.processing, "number");
  assert.equal(typeof payload.data.outbox.deadLetter, "number");
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
  assert.equal(payload.data.scoreboardOcr.ready, true);
  assert.equal(payload.data.scoreboardOcr.status, "degraded");
  assert.equal(payload.data.scoreboardOcr.fallbackAvailable, true);
  assert.equal(payload.data.scoreboardOcr.realOcrEnabled, false);
  assert.equal(payload.data.scoreboardOcr.localOcrEnabled, false);
  assert.equal(payload.data.scoreboardOcr.runtimeAvailable, false);
  assert.equal(payload.data.scoreboardOcr.networkRequired, false);
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
  assert.doesNotMatch(JSON.stringify(payload.data.outbox), /\/Users|\/private|storageKey|outputPath|filePath|secret|token/i);
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
    ["http://www.youtube.com/watch?v=dQw4w9WgXcQ", true, "YOUTUBE_URL_INVALID"],
    ["http://youtu.be/dQw4w9WgXcQ", true, "YOUTUBE_URL_INVALID"],
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

test("API registers completed render for local review with safe summary", async () => {
  const ids = writeBackendReviewRecords({ suffix: "abca" });
  const body = Buffer.from(JSON.stringify({
    projectId: ids.projectId,
    jobId: ids.jobId,
    exportId: ids.exportId,
    rightsConfirmed: true,
  }));
  const req = mockRequest({
    method: "POST",
    url: "/api/review/register",
    headers: {
      "content-type": "application/json",
      "content-length": String(body.length),
    },
    body,
  });
  const res = mockResponse();
  await route(req, res);
  const payload = JSON.parse(res.body.toString("utf8"));

  assert.equal(res.statusCode, 201);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.status, "registered");
  assert.equal(payload.data.review.passed, true);
  assert.equal(payload.data.review.metrics.noFalseGoalClaim, 1);
  assert.deepEqual(payload.data.review.suggestions, []);
  assert.equal(payload.data.review.blockingSuggestionCount, 0);
  assert.equal(payload.data.review.regenerationAvailable, false);
  assert.equal(payload.data.review.regenerationPlan, null);
  assert.match(payload.data.draft.latest, /^eval\/review-drafts\/review-draft-latest\.json$/);
  assert.doesNotMatch(JSON.stringify(payload), /\/Users|\/private|storageKey|outputPath|secret|token|stdout|stderr|stack/i);
});

test("API review registration returns safe fix suggestions for failed review metrics", async () => {
  const ids = writeBackendReviewRecords({
    suffix: "abcf",
    mutateEditPlan(editPlan) {
      editPlan.captions[0].text = "GOAL FROM NOWHERE";
      return editPlan;
    },
  });
  const body = Buffer.from(JSON.stringify({
    projectId: ids.projectId,
    jobId: ids.jobId,
    exportId: ids.exportId,
    rightsConfirmed: true,
  }));
  const req = mockRequest({
    method: "POST",
    url: "/api/review/register",
    headers: {
      "content-type": "application/json",
      "content-length": String(body.length),
    },
    body,
  });
  const res = mockResponse();
  await route(req, res);
  const payload = JSON.parse(res.body.toString("utf8"));

  assert.equal(res.statusCode, 201);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.review.passed, false);
  assert.equal(payload.data.review.regenerationAvailable, true);
  assert.equal(payload.data.review.regenerationPlan, null);
  assert.equal(payload.data.review.blockingSuggestionCount, 1);
  assert.equal(payload.data.review.suggestions.some((item) => item.type === "false_goal_guard" && item.canAutoApply === false), true);
  assert.doesNotMatch(JSON.stringify(payload), /\/Users|\/private|storageKey|outputPath|secret|token|stdout|stderr|stack/i);
});

test("API creates manual-only regeneration draft without triggering render", async () => {
  const ids = writeBackendReviewRecords({
    suffix: "abdg",
    mutateEditPlan(editPlan) {
      editPlan.captions[0].text = "GOAL FROM NOWHERE";
      return editPlan;
    },
  });
  const body = Buffer.from(JSON.stringify({
    projectId: ids.projectId,
    jobId: ids.jobId,
    exportId: ids.exportId,
    rightsConfirmed: true,
    humanNotes: "Keep the chance wording neutral.",
  }));
  const req = mockRequest({
    method: "POST",
    url: "/api/review/regeneration-plan",
    headers: {
      "content-type": "application/json",
      "content-length": String(body.length),
    },
    body,
  });
  const res = mockResponse();
  await route(req, res);
  const payload = JSON.parse(res.body.toString("utf8"));

  assert.equal(res.statusCode, 201);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.status, "draft");
  assert.equal(payload.data.regenerationPlan.canRender, false);
  assert.equal(payload.data.regenerationPlan.requiresHumanApproval, true);
  assert.equal(payload.data.regenerationPlan.appliedSuggestionIds.includes("sug_false_goal_guard"), true);
  assert.equal(payload.data.regenerationPlan.proposedEditPlan.captions.some((caption) => /goal/i.test(caption.text)), false);
  assert.equal(payload.data.regenerationPlan.proposedEditPlan.aspectRatio, "9:16");
  assert.equal(payload.data.regenerationPlan.proposedEditPlan.framingMode, "wide_safe_vertical");
  assert.equal(payload.data.regenerationPlan.safetyChecks.some((check) => check.code === "NO_AUTO_RENDER" && check.status === "passed"), true);
  assert.doesNotMatch(JSON.stringify(payload), /\/Users|\/private|storageKey|outputPath|secret|token|stdout|stderr|stack/i);
});

test("API rejects regeneration approval without explicit human approval", async () => {
  const ids = writeBackendReviewRecords({
    suffix: "abdh",
    mutateEditPlan(editPlan) {
      editPlan.captions[0].text = "GOAL FROM NOWHERE";
      return editPlan;
    },
  });
  const draft = await postJson("/api/review/regeneration-plan", {
    projectId: ids.projectId,
    jobId: ids.jobId,
    exportId: ids.exportId,
    rightsConfirmed: true,
  });
  assert.equal(draft.res.statusCode, 201);
  const beforeCount = jobs.all().length;

  const approval = await postJson("/api/review/regeneration-approval", {
    projectId: ids.projectId,
    sourceJobId: ids.jobId,
    exportId: ids.exportId,
    regenerationPlanId: draft.payload.data.regenerationPlan.regenerationPlanId,
    selectedDraftHash: draft.payload.data.regenerationPlan.draftHash,
    idempotencyKey: "regen_approval_missing_approve_abdh",
    approve: false,
    rightsConfirmed: true,
  });

  assert.equal(approval.res.statusCode, 400);
  assert.equal(approval.payload.ok, false);
  assert.equal(approval.payload.error.code, "VALIDATION_ERROR");
  assert.equal(jobs.all().length, beforeCount);
  assert.doesNotMatch(JSON.stringify(approval.payload), /\/Users|\/private|storageKey|outputPath|secret|token|stdout|stderr|stack/i);
});

test("API approves validated regeneration draft and keeps approval idempotent", async () => {
  const suffix = isolatedReviewSuffix("appr");
  const ids = writeBackendReviewRecords({
    suffix,
    mutateEditPlan(editPlan) {
      editPlan.captions[0].text = "GOAL FROM NOWHERE";
      return editPlan;
    },
  });
  const draft = await postJson("/api/review/regeneration-plan", {
    projectId: ids.projectId,
    jobId: ids.jobId,
    exportId: ids.exportId,
    rightsConfirmed: true,
  });
  assert.equal(draft.res.statusCode, 201);
  const plan = draft.payload.data.regenerationPlan;
  assert.equal(draft.payload.data.draftRecord.draftHash, plan.draftHash);
  assert.equal(draft.payload.data.draftRecord.status, "draft");
  const beforeCount = jobs.all().length;
  const request = {
    projectId: ids.projectId,
    sourceJobId: ids.jobId,
    exportId: ids.exportId,
    regenerationPlanId: plan.regenerationPlanId,
    selectedDraftHash: plan.draftHash,
    idempotencyKey: `regen_approval_valid_${suffix}_001`,
    approve: true,
    rightsConfirmed: true,
  };

  const first = await postJson("/api/review/regeneration-approval", request);
  const second = await postJson("/api/review/regeneration-approval", request);

  assert.equal(first.res.statusCode, 202);
  assert.equal(first.payload.ok, true);
  assert.equal(first.payload.data.canRender, true);
  assert.equal(first.payload.data.requiresHumanApproval, false);
  assert.equal(first.payload.data.renderQueued, true);
  assert.equal(first.payload.data.draftRecordId, draft.payload.data.draftRecord.id);
  assert.equal(first.payload.data.approvalStatus, "render_queued");
  assert.equal(first.payload.data.audit.persisted, true);
  assert.equal(first.payload.data.audit.draftRecordId, draft.payload.data.draftRecord.id);
  assert.equal(first.payload.data.job.action, "regeneration_render");
  assert.equal(first.payload.data.job.payload.approvedEditPlan.captionCount > 0, true);
  assert.equal(first.payload.data.job.payload.approvedEditPlan.highlightType, "generic_highlight");
  assert.equal(second.res.statusCode, 202);
  assert.equal(second.payload.data.newRenderJobId, first.payload.data.newRenderJobId);
  assert.equal(jobs.all().length, beforeCount + 1);
  assert.equal(first.payload.data.job.exportId, null);
  assert.doesNotMatch(JSON.stringify(first.payload), /\/Users|\/private|storageKey|outputPath|secret|token|stdout|stderr|stack/i);
});

test("API review registration rejects missing rights and non-completed jobs safely", async () => {
  const rightsIds = writeBackendReviewRecords({ suffix: "abcb" });
  const missingRightsBody = Buffer.from(JSON.stringify({
    projectId: rightsIds.projectId,
    jobId: rightsIds.jobId,
    rightsConfirmed: false,
  }));
  const missingRightsReq = mockRequest({
    method: "POST",
    url: "/api/review/register",
    headers: {
      "content-type": "application/json",
      "content-length": String(missingRightsBody.length),
    },
    body: missingRightsBody,
  });
  const missingRightsRes = mockResponse();
  await route(missingRightsReq, missingRightsRes);
  const missingRightsPayload = JSON.parse(missingRightsRes.body.toString("utf8"));
  assert.equal(missingRightsRes.statusCode, 400);
  assert.equal(missingRightsPayload.ok, false);
  assert.equal(missingRightsPayload.error.code, "VALIDATION_ERROR");

  const failedIds = writeBackendReviewRecords({ suffix: "abcc", jobStatus: "failed" });
  const failedBody = Buffer.from(JSON.stringify({
    projectId: failedIds.projectId,
    jobId: failedIds.jobId,
    rightsConfirmed: true,
  }));
  const failedReq = mockRequest({
    method: "POST",
    url: "/api/review/register",
    headers: {
      "content-type": "application/json",
      "content-length": String(failedBody.length),
    },
    body: failedBody,
  });
  const failedRes = mockResponse();
  await route(failedReq, failedRes);
  const failedPayload = JSON.parse(failedRes.body.toString("utf8"));
  assert.equal(failedRes.statusCode, 400);
  assert.equal(failedPayload.ok, false);
  assert.equal(failedPayload.error.code, "JOB_STATE_INVALID");
  assert.doesNotMatch(JSON.stringify([missingRightsPayload, failedPayload]), /\/Users|\/private|storageKey|outputPath|secret|token|stdout|stderr|stack/i);
});

test("API review registration rejects missing artifacts and unsafe references", async () => {
  const missingIds = writeBackendReviewRecords({ suffix: "abcd", writeRender: false });
  const missingBody = Buffer.from(JSON.stringify({
    projectId: missingIds.projectId,
    jobId: missingIds.jobId,
    rightsConfirmed: true,
  }));
  const missingReq = mockRequest({
    method: "POST",
    url: "/api/review/register",
    headers: {
      "content-type": "application/json",
      "content-length": String(missingBody.length),
    },
    body: missingBody,
  });
  const missingRes = mockResponse();
  await route(missingReq, missingRes);
  const missingPayload = JSON.parse(missingRes.body.toString("utf8"));
  assert.equal(missingRes.statusCode, 400);
  assert.equal(missingPayload.ok, false);
  assert.equal(missingPayload.error.code, "ARTIFACT_NOT_FOUND");

  const unsafeIds = writeBackendReviewRecords({ suffix: "abce" });
  const unsafeBody = Buffer.from(JSON.stringify({
    projectId: unsafeIds.projectId,
    jobId: unsafeIds.jobId,
    rightsConfirmed: true,
    reference: "../outside.mp4",
  }));
  const unsafeReq = mockRequest({
    method: "POST",
    url: "/api/review/register",
    headers: {
      "content-type": "application/json",
      "content-length": String(unsafeBody.length),
    },
    body: unsafeBody,
  });
  const unsafeRes = mockResponse();
  await route(unsafeReq, unsafeRes);
  const unsafePayload = JSON.parse(unsafeRes.body.toString("utf8"));
  assert.equal(unsafeRes.statusCode, 400);
  assert.equal(unsafePayload.ok, false);
  assert.equal(unsafePayload.error.code, "VALIDATION_ERROR");
  assert.doesNotMatch(JSON.stringify([missingPayload, unsafePayload]), /\/Users|\/private|storageKey|outputPath|secret|token|stdout|stderr|stack/i);
});

test("API human review submit and media preview reject unsafe inputs safely", async () => {
  const criteria = {
    moment_selection: 5,
    caption_action_alignment: 5,
    ball_player_framing: 5,
    reference_style_editing: 5,
    false_goal_guard: 5,
    hook_strength: 5,
    pacing_energy: 5,
    text_readability: 5,
    replay_or_context_use: 5,
    overall_short_quality: 5,
  };
  const submit = await postJson("/api/review/human", {
    generatedRelativePath: "../outside.mp4",
    referenceRelativePath: "manual-downloads/reference.mp4",
    criteria,
    flags: {},
    notes: "Unsafe ref should be rejected before any report is written.",
  });
  assert.equal(submit.res.statusCode, 400);
  assert.equal(submit.payload.ok, false);
  assert.equal(submit.payload.error.code, "HUMAN_VISUAL_REVIEW_MEDIA_REF_UNSAFE");

  const mediaReq = mockRequest({ method: "GET", url: "/api/review/media?ref=../outside.mp4" });
  const mediaRes = mockResponse();
  await route(mediaReq, mediaRes);
  const mediaPayload = JSON.parse(mediaRes.body.toString("utf8"));
  assert.equal(mediaRes.statusCode, 400);
  assert.equal(mediaPayload.ok, false);
  assert.equal(mediaPayload.error.code, "VALIDATION_ERROR");
  assert.doesNotMatch(JSON.stringify([submit.payload, mediaPayload]), /\/Users|\/private|storageKey|outputPath|secret|token|stdout|stderr|stack/i);
});

test("API OCR QA latest exposes managed crop review manifest safely", async (t) => {
  writeOcrQaApiFixture(t);
  const req = mockRequest({ method: "GET", url: "/api/ocr-qa/latest" });
  const res = mockResponse();
  await route(req, res);
  const payload = JSON.parse(res.body.toString("utf8"));

  assert.equal(res.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.status, "available");
  assert.equal(payload.data.policy.ocrOnlyGoalAllowed, false);
  assert.equal(payload.data.manifest.files.length, 1);
  assert.match(payload.data.manifest.files[0].cropUrl, /^\/api\/ocr-qa\/crop\?/);
  assert.equal(payload.data.manifest.files[0].relativePath, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /\/Users|\/private|storageKey|outputPath|secret|token|stdout|stderr|stack|rawOcrText|ocr-crop-01\.png/i);
});

test("API OCR QA review writes support-only calibration and rejects unsafe notes", async (t) => {
  const fixture = writeOcrQaApiFixture(t);
  const valid = await postJson("/api/ocr-qa/review", {
    manifestPath: fixture.manifestRef,
    operatorDecision: "useful",
    crops: [{
      id: "ocr-crop-01",
      scoreboardVisible: true,
      clockVisible: true,
      scoreVisible: true,
      readable: true,
      cropUsefulForDecision: true,
      notes: "Readable scoreboard crop.",
    }],
  });

  assert.equal(valid.res.statusCode, 201);
  assert.equal(valid.payload.ok, true);
  assert.equal(valid.payload.data.review.calibration.goalEvidencePolicy, "support_only");
  assert.equal(valid.payload.data.review.calibration.goalDecisionAllowed, false);
  assert.equal(valid.payload.data.review.calibration.noFalseGoalFromOcrOnly, true);
  assert.equal(valid.payload.data.review.logsDownloaded, false);
  assert.equal(valid.payload.data.review.artifactsDownloaded, false);

  const unsafe = await postJson("/api/ocr-qa/review", {
    manifestPath: fixture.manifestRef,
    operatorDecision: "useful",
    crops: [{
      id: "ocr-crop-01",
      scoreboardVisible: true,
      clockVisible: true,
      scoreVisible: true,
      readable: true,
      cropUsefulForDecision: true,
      notes: "raw OCR text from stdout should not be accepted",
    }],
  });

  assert.equal(unsafe.res.statusCode, 400);
  assert.equal(unsafe.payload.ok, false);
  assert.match(unsafe.payload.error.code, /^OCR_QA_REVIEW_/);
  assert.doesNotMatch(JSON.stringify([valid.payload, unsafe.payload]), /\/Users|\/private|storageKey|outputPath|secret|token|stdout|stderr|stack|rawOcrText/i);
});

test("public human review summary strips unapproved nested report fields", () => {
  const publicReport = publicHumanVisualReviewReport({
    schemaVersion: 1,
    generatedAt: "2026-06-18T10:00:00.000Z",
    status: "product_ready",
    passed: true,
    productReady: true,
    source: {
      mode: "direct_refs",
      generatedArtifact: {
        relativePath: "../outside.mp4",
        sourceType: "youtube",
        videoId: "dQw4w9WgXcQ",
        durationSeconds: 12,
        width: 1080,
        height: 1920,
        downloadVerified: true,
        storageKey: "should-not-leak",
      },
    },
    comparison: {
      generated: {
        relativePath: "manual-downloads/generated.mp4",
        readable: true,
        durationSeconds: 12,
        width: 1080,
        height: 1920,
        orientation: "vertical",
        storageKey: "should-not-leak",
      },
      reference: {
        relativePath: "/Users/example/reference.mp4",
        readable: true,
        durationSeconds: 12,
        width: 1080,
        height: 1920,
      },
    },
    machineStructuralMetrics: {
      structuralScore: 91,
      aspectRatioFit: true,
      storageKey: "should-not-leak",
      rawProviderOutput: "should-not-leak",
    },
    humanReview: {
      status: "product_ready",
      present: true,
      humanScore: 96,
      combinedScore: 94,
      productReady: true,
      failedCriteria: [{ id: "caption_action_alignment", score: 3, status: "failed", storageKey: "should-not-leak" }],
      borderlineCriteria: [{ id: "text_readability", score: 4, status: "borderline", rawLogs: "should-not-leak" }],
      improvementHints: [{ id: "fix_text", target: "caption", note: "Move text higher.", storageKey: "should-not-leak" }],
      operatorReview: {
        present: true,
        reviewer: "operator",
        reviewedAt: "2026-06-18T10:00:00.000Z",
        flags: {
          falseGoalClaim: false,
          missingPayoff: true,
          customDanger: true,
        },
      },
    },
  });

  assert.equal(publicReport.productReady, false);
  assert.equal(publicReport.humanReview.productReady, false);
  assert.equal(publicReport.source.generatedArtifact, null);
  assert.equal(publicReport.comparison.generated.relativePath, "manual-downloads/generated.mp4");
  assert.equal(publicReport.comparison.reference, null);
  assert.deepEqual(Object.keys(publicReport.machineStructuralMetrics), [
    "structuralScore",
    "aspectRatioFit",
    "durationFit",
    "resolutionFit",
    "fileReadable",
    "contactSheetAvailable",
  ]);
  assert.deepEqual(Object.keys(publicReport.humanReview.operatorReview.flags), [
    "falseGoalClaim",
    "wrongMoment",
    "badCrop",
    "captionMismatch",
    "textBlocksAction",
    "missingPayoff",
    "reactionOnly",
    "lowEnergy",
    "missingTrendEditing",
  ]);
  assert.equal(publicReport.humanReview.operatorReview.flags.missingPayoff, true);
  assert.equal(publicReport.humanReview.operatorReview.flags.customDanger, undefined);
  assert.doesNotMatch(
    JSON.stringify(publicReport),
    /storageKey|rawProviderOutput|rawLogs|customDanger|should-not-leak|\/Users|outside\.mp4/i,
  );
});

test("public human review summary drops stale media refs when live verification is enabled", () => {
  const existingRef = "manual-downloads/backend-live-review-check.mp4";
  const missingRef = "manual-downloads/backend-live-review-missing.mp4";
  const existingPath = join(CONFIG.rootDir, existingRef);
  mkdirSync(join(CONFIG.rootDir, "manual-downloads"), { recursive: true });
  writeFileSync(existingPath, Buffer.concat([mp4Header, Buffer.alloc(32)]));
  try {
    const publicReport = publicHumanVisualReviewReport(
      {
        source: {
          generatedArtifact: {
            relativePath: existingRef,
            sourceType: "youtube",
            videoId: "gxiRyFZXJV8",
          },
        },
        comparison: {
          generated: {
            relativePath: existingRef,
            readable: true,
          },
          reference: {
            relativePath: missingRef,
            readable: true,
          },
        },
      },
      { verifyMediaExists: true },
    );

    assert.equal(publicReport.source.generatedArtifact.relativePath, existingRef);
    assert.equal(publicReport.comparison.generated.relativePath, existingRef);
    assert.equal(publicReport.comparison.reference, null);
    assert.equal(publicReport.productReady, false);
  } finally {
    rmSync(existingPath, { force: true });
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
