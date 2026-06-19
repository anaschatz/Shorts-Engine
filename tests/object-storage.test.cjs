const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { Writable } = require("node:stream");

const TEST_TMP_ROOT = resolve(__dirname, "..", "tmp");
mkdirSync(TEST_TMP_ROOT, { recursive: true });
const TEST_DATA_DIR = mkdtempSync(resolve(TEST_TMP_ROOT, "object-storage-data-"));
process.env.MATCHCUTS_DATA_DIR = TEST_DATA_DIR;

const {
  artifactCleanupWorker,
  artifactAdapter,
  jobs,
  outboxWorker,
  persistenceAdapter,
  route,
  stopWorkers,
} = require("../server/app.cjs");
const { validateArtifactAdapter } = require("../server/adapters/artifact-adapter.cjs");
const { LocalArtifactAdapter } = require("../server/adapters/local-artifact-adapter.cjs");
const { CONFIG } = require("../server/config.cjs");
const { redactForLogs } = require("../server/errors.cjs");

const TEST_JOB_KEY_PREFIXES = Object.freeze(["object-storage-", "object-pending-"]);

test.after(async () => {
  artifactCleanupWorker.stop();
  if (outboxWorker && typeof outboxWorker.stop === "function") outboxWorker.stop();
  await stopWorkers({ requestId: "object_storage_test_shutdown", timeoutMs: 0 });
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function validId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function uniqueKey(prefix, extension = "mp4") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`;
}

function cleanupArtifact(adapter, artifact) {
  try {
    const filePath = adapter.resolveArtifact(artifact);
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Best-effort test cleanup.
  }
}

function cleanupPersistedJob(job) {
  if (!job || !job.id) return;
  try {
    unlinkSync(join(CONFIG.jobDir, `${job.id}.json`));
  } catch {
    // Best-effort test cleanup.
  }
  if (jobs.jobs && typeof jobs.jobs.delete === "function") jobs.jobs.delete(job.id);
  if (job.idempotencyKey && jobs.idempotency && typeof jobs.idempotency.delete === "function") {
    jobs.idempotency.delete(job.idempotencyKey);
  }
}

function cleanupObjectStorageTestJobs() {
  let fileNames = [];
  try {
    fileNames = readdirSync(CONFIG.jobDir);
  } catch {
    return;
  }
  for (const fileName of fileNames) {
    if (!/^job_[A-Za-z0-9-]{8,80}\.json$/.test(fileName)) continue;
    const filePath = join(CONFIG.jobDir, fileName);
    let record;
    try {
      record = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (!TEST_JOB_KEY_PREFIXES.some((prefix) => String(record.idempotencyKey || "").startsWith(prefix))) continue;
    cleanupPersistedJob(record);
  }
}

cleanupObjectStorageTestJobs();

function mockRequest({ method = "GET", url = "/", headers = {}, body = Buffer.alloc(0) }) {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: "object-storage-test" },
    async *[Symbol.asyncIterator]() {
      if (body.length) yield body;
    },
  };
}

function streamResponse() {
  const chunks = [];
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.statusCode = 0;
  res.headers = {};
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
  };
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    Object.entries(headers).forEach(([key, value]) => {
      res.headers[key.toLowerCase()] = value;
    });
  };
  res.bodyBuffer = () => Buffer.concat(chunks);
  return res;
}

async function invokeRoute(req, res = streamResponse()) {
  await route(req, res);
  if (!res.writableEnded) await once(res, "finish");
  return res;
}

async function readStream(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await once(stream, "end");
  return Buffer.concat(chunks);
}

function createCompletedExport(body = Buffer.from("rendered-video")) {
  const projectId = validId("prj");
  const uploadId = validId("upl");
  const job = jobs.create({
    projectId,
    uploadId,
    action: "generate",
    idempotencyKey: `object-storage-${randomUUID()}`,
    payload: { title: "Derby Final", preset: "hype", language: "en" },
  });
  jobs.update(job, { status: "processing", progress: 90, step: "render_short" });
  const exportId = validId("exp");
  const artifact = artifactAdapter.writeArtifact({
    id: exportId,
    type: "export",
    ownerProjectId: projectId,
    ownerJobId: job.id,
    storageKey: uniqueKey(`export-${job.id}`),
    contentType: "video/mp4",
    buffer: body,
  });
  const exportRecord = persistenceAdapter.createExport({
    id: exportId,
    projectId,
    jobId: job.id,
    artifact,
    fileName: 'Final "Bad".mp4',
  });
  jobs.complete(job, {
    exportId,
    outputPath: artifactAdapter.resolveArtifact(artifact),
  });
  return { artifact, body, exportId, exportRecord, job, projectId };
}

test("local artifact adapter exposes object-storage contract without public leaks", async () => {
  const adapter = validateArtifactAdapter(new LocalArtifactAdapter());
  const projectId = validId("prj");
  const jobId = validId("job");
  const exportId = validId("exp");
  const artifact = adapter.putArtifact({
    id: exportId,
    type: "rendered_video",
    ownerProjectId: projectId,
    ownerJobId: jobId,
    storageKey: uniqueKey("object-contract"),
    contentType: "video/mp4",
    buffer: Buffer.from("video-bytes"),
  });

  try {
    assert.equal(adapter.artifactExists(artifact), true);
    assert.equal(adapter.getArtifactMetadata(artifact).size, "video-bytes".length);
    assert.equal(adapter.readArtifact(artifact).toString("utf8"), "video-bytes");
    assert.equal((await readStream(adapter.createReadStream(artifact))).toString("utf8"), "video-bytes");
    const health = adapter.health();
    assert.equal(health.probe.write, true);
    assert.equal(health.probe.read, true);
    assert.equal(health.probe.cleanup, true);
    assert.equal(health.capabilities.pruneSignedTokens, true);
    assert.doesNotMatch(JSON.stringify(adapter.publicArtifactRecord(artifact)), /storageKey|path|\/Users|\/private/);
    assert.doesNotMatch(JSON.stringify(health), /storageKey|path|\/Users|\/private|adt_[A-Fa-f0-9-]{36}/);
    assert.throws(() => adapter.putArtifact({ type: "upload", storageKey: "../bad.mp4", buffer: Buffer.from("x") }), (error) => error.code === "ARTIFACT_KEY_INVALID");
  } finally {
    cleanupArtifact(adapter, artifact);
  }
});

test("signed download tokens are opaque and expire fail-closed", () => {
  const adapter = new LocalArtifactAdapter();
  const ownerProjectId = validId("prj");
  const ownerJobId = validId("job");
  const artifact = adapter.writeArtifact({
    id: validId("exp"),
    type: "export",
    ownerProjectId,
    ownerJobId,
    storageKey: uniqueKey("signed-token"),
    buffer: Buffer.from("download"),
  });

  try {
    const signed = adapter.createSignedDownloadUrl(artifact, { ttlSeconds: 3 });
    assert.match(signed.downloadUrl || signed.url, /^\/api\/artifacts\/download\?token=adt_/);
    assert.doesNotMatch(JSON.stringify(signed), /storageKey|\/Users|\/private/);
    assert.equal(adapter.validateSignedDownloadToken(signed.token, {
      expectedArtifactId: artifact.id,
      expectedProjectId: ownerProjectId,
      expectedJobId: ownerJobId,
    }).id, artifact.id);
    assert.throws(
      () => adapter.validateSignedDownloadToken(signed.token, { expectedProjectId: validId("prj") }),
      (error) => error.code === "ARTIFACT_TOKEN_INVALID",
    );
    assert.throws(
      () => adapter.validateSignedDownloadToken(signed.token, { expectedJobId: validId("job") }),
      (error) => error.code === "ARTIFACT_TOKEN_INVALID",
    );
    assert.throws(
      () => adapter.validateSignedDownloadToken(signed.token, { expectedArtifactId: validId("exp") }),
      (error) => error.code === "ARTIFACT_TOKEN_INVALID",
    );
    assert.throws(
      () => adapter.validateSignedDownloadToken(signed.token, { nowMs: Date.parse(signed.expiresAt) + 1 }),
      (error) => error.code === "ARTIFACT_TOKEN_INVALID",
    );
  } finally {
    cleanupArtifact(adapter, artifact);
  }
});

test("signed download tokens reject unknown values and keep the local token store bounded", () => {
  const adapter = new LocalArtifactAdapter({ maxSignedTokens: 1 });
  const firstArtifact = adapter.writeArtifact({
    id: validId("exp"),
    type: "export",
    ownerProjectId: validId("prj"),
    ownerJobId: validId("job"),
    storageKey: uniqueKey("bounded-token-one"),
    buffer: Buffer.from("one"),
  });
  const secondArtifact = adapter.writeArtifact({
    id: validId("exp"),
    type: "export",
    ownerProjectId: validId("prj"),
    ownerJobId: validId("job"),
    storageKey: uniqueKey("bounded-token-two"),
    buffer: Buffer.from("two"),
  });

  try {
    const first = adapter.createSignedDownloadUrl(firstArtifact, { ttlSeconds: 30 });
    const second = adapter.createSignedDownloadUrl(secondArtifact, { ttlSeconds: 30 });
    const unknown = `adt_${randomUUID()}_${randomUUID().replace(/-/g, "")}`;

    assert.equal(adapter.health().activeSignedTokens, 1);
    assert.throws(() => adapter.validateSignedDownloadToken(first.token), (error) => error.code === "ARTIFACT_TOKEN_INVALID");
    assert.equal(adapter.validateSignedDownloadToken(second.token).id, secondArtifact.id);
    assert.throws(() => adapter.validateSignedDownloadToken(unknown), (error) => error.code === "ARTIFACT_TOKEN_INVALID");
  } finally {
    cleanupArtifact(adapter, firstArtifact);
    cleanupArtifact(adapter, secondArtifact);
  }
});

test("export download URL and signed artifact route only serve completed exports", async () => {
  const fixture = createCompletedExport(Buffer.from("signed-render"));
  try {
    const urlRes = await invokeRoute(mockRequest({ url: `/api/exports/${fixture.exportId}/download-url` }));
    const payload = JSON.parse(urlRes.bodyBuffer().toString("utf8"));

    assert.equal(urlRes.statusCode, 200);
    assert.equal(payload.ok, true);
    assert.match(payload.data.downloadUrl, /^\/api\/artifacts\/download\?token=adt_/);
    assert.doesNotMatch(JSON.stringify(payload), /storageKey|outputPath|\/Users|\/private/);

    const downloadRes = await invokeRoute(mockRequest({ url: payload.data.downloadUrl }));
    assert.equal(downloadRes.statusCode, 200);
    assert.equal(downloadRes.headers["content-type"], "video/mp4");
    assert.equal(downloadRes.bodyBuffer().toString("utf8"), "signed-render");
  } finally {
    cleanupArtifact(artifactAdapter, fixture.artifact);
    cleanupPersistedJob(fixture.job);
  }
});

test("signed artifact route rejects unknown tokens without echoing token values", async () => {
  const unknown = `adt_${randomUUID()}_${randomUUID().replace(/-/g, "")}`;
  const res = await invokeRoute(mockRequest({ url: `/api/artifacts/download?token=${unknown}` }));
  const payload = JSON.parse(res.bodyBuffer().toString("utf8"));

  assert.equal(res.statusCode, 404);
  assert.equal(payload.error.code, "ARTIFACT_TOKEN_INVALID");
  assert.doesNotMatch(res.bodyBuffer().toString("utf8"), new RegExp(unknown));
});

test("direct export download enforces completed job, safe filename and existing artifact", async () => {
  const fixture = createCompletedExport(Buffer.from("direct-render"));
  try {
    const res = await invokeRoute(mockRequest({ url: `/api/exports/${fixture.exportId}/download` }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-disposition"], 'attachment; filename="Final_Bad_.mp4"');
    assert.equal(res.bodyBuffer().toString("utf8"), "direct-render");

    cleanupArtifact(artifactAdapter, fixture.artifact);
    const missingRes = await invokeRoute(mockRequest({ url: `/api/exports/${fixture.exportId}/download` }));
    const missingPayload = JSON.parse(missingRes.bodyBuffer().toString("utf8"));
    assert.equal(missingRes.statusCode, 404);
    assert.equal(missingPayload.error.code, "EXPORT_NOT_FOUND");
  } finally {
    cleanupArtifact(artifactAdapter, fixture.artifact);
    cleanupPersistedJob(fixture.job);
  }
});

test("export download is rejected when job has not completed", async () => {
  const projectId = validId("prj");
  const uploadId = validId("upl");
  const job = jobs.create({
    projectId,
    uploadId,
    action: "generate",
    idempotencyKey: `object-pending-${randomUUID()}`,
  });
  const exportId = validId("exp");
  const artifact = artifactAdapter.writeArtifact({
    id: exportId,
    type: "export",
    ownerProjectId: projectId,
    ownerJobId: job.id,
    storageKey: uniqueKey(`pending-export-${job.id}`),
    buffer: Buffer.from("pending"),
  });
  persistenceAdapter.createExport({ id: exportId, projectId, jobId: job.id, artifact });

  try {
    const res = await invokeRoute(mockRequest({ url: `/api/exports/${exportId}/download` }));
    const payload = JSON.parse(res.bodyBuffer().toString("utf8"));
    assert.equal(res.statusCode, 404);
    assert.equal(payload.error.code, "EXPORT_NOT_FOUND");
  } finally {
    cleanupArtifact(artifactAdapter, artifact);
    cleanupPersistedJob(job);
  }
});

test("export download rejects owner mismatch even when the artifact exists", async () => {
  const projectId = validId("prj");
  const uploadId = validId("upl");
  const job = jobs.create({
    projectId,
    uploadId,
    action: "generate",
    idempotencyKey: `object-storage-owner-${randomUUID()}`,
  });
  jobs.update(job, { status: "processing", progress: 90, step: "render_short" });
  const exportId = validId("exp");
  const artifact = artifactAdapter.writeArtifact({
    id: exportId,
    type: "export",
    ownerProjectId: validId("prj"),
    ownerJobId: job.id,
    storageKey: uniqueKey(`mismatched-export-${job.id}`),
    buffer: Buffer.from("mismatch"),
  });
  persistenceAdapter.createExport({ id: exportId, projectId, jobId: job.id, artifact });
  jobs.complete(job, {
    exportId,
    outputPath: artifactAdapter.resolveArtifact(artifact),
  });

  try {
    const res = await invokeRoute(mockRequest({ url: `/api/exports/${exportId}/download` }));
    const payload = JSON.parse(res.bodyBuffer().toString("utf8"));
    assert.equal(res.statusCode, 404);
    assert.equal(payload.error.code, "EXPORT_NOT_FOUND");
  } finally {
    cleanupArtifact(artifactAdapter, artifact);
    cleanupPersistedJob(job);
  }
});

test("log redaction removes token, storage key and local path details", () => {
  const token = `adt_${randomUUID()}_${randomUUID().replace(/-/g, "")}`;
  const redacted = redactForLogs({
    token,
    storageKey: "exports/private-key.mp4",
    serviceId: "srv-realstaging123",
    outputPath: "/Users/example/render.mp4",
    nested: {
      filePath: "/private/tmp/render.mp4",
      apiKey: "sk-secretsecretsecret",
      githubToken: "ghs_abcdefghijklmnopqrstuvwx1234567890",
      gitlabToken: "glpat-abcdefghijklmnopqrstuvwx123456",
      slackToken: "xoxb-1234567890-private-token",
    },
    staging: "/tmp/shortsengine/private.mp4",
    message: `download ${token} OPENAI_API_KEY=secret srv-realstaging123 SHORTSENGINE_YOUTUBE_SMOKE_TOKEN secret VISITOR_INFO1_LIVE=private-cookie https://provider.example/cb?access_token=oauth-secret https://storage.example/object?X-Amz-Security-Token=session-secret -----BEGIN PRIVATE KEY----- private -----END PRIVATE KEY-----`,
  });
  const body = JSON.stringify(redacted);

  assert.doesNotMatch(body, new RegExp(token));
  assert.doesNotMatch(body, /exports\/private-key|\/Users|\/private|\/tmp|OPENAI_API_KEY=secret|sk-secret|srv-realstaging123|ghs_|glpat-|xoxb-|SHORTSENGINE_YOUTUBE_SMOKE_TOKEN secret|VISITOR_INFO1_LIVE=private-cookie|oauth-secret|session-secret|BEGIN PRIVATE KEY/);
  assert.match(body, /\[redacted\]/);
});

test("log redaction covers modern credential-shaped keys without hiding readiness booleans", () => {
  const redacted = redactForLogs({
    oauth: {
      clientSecret: "provider-secret",
      refreshToken: "provider-refresh-token",
      authorizationHeader: "Bearer provider-token",
    },
    storage: {
      accessKeyId: "AKIATESTKEY123456",
      sessionToken: "session-secret",
      privateKey: "-----BEGIN PRIVATE KEY----- private -----END PRIVATE KEY-----",
    },
    readiness: {
      credentialsConfigured: false,
      deployTokenConfigured: false,
      providerCredentialConfigured: false,
      serviceIdConfigured: true,
      tokensRequested: false,
      secretsIncluded: false,
      credentialRefs: ["SHORTSENGINE_STAGING_DEPLOY_TOKEN"],
      githubEnvironmentSecrets: ["SHORTSENGINE_STAGING_DEPLOY_TOKEN"],
      rawLogsRequired: false,
      rawArtifactsRequired: false,
    },
  });

  assert.equal(redacted.oauth.clientSecret, "[redacted]");
  assert.equal(redacted.oauth.refreshToken, "[redacted]");
  assert.equal(redacted.oauth.authorizationHeader, "[redacted]");
  assert.equal(redacted.storage.accessKeyId, "[redacted]");
  assert.equal(redacted.storage.sessionToken, "[redacted]");
  assert.equal(redacted.storage.privateKey, "[redacted]");
  assert.deepEqual(redacted.readiness, {
    credentialsConfigured: false,
    deployTokenConfigured: false,
    providerCredentialConfigured: false,
    serviceIdConfigured: true,
    tokensRequested: false,
    secretsIncluded: false,
    credentialRefs: ["SHORTSENGINE_STAGING_DEPLOY_TOKEN"],
    githubEnvironmentSecrets: ["SHORTSENGINE_STAGING_DEPLOY_TOKEN"],
    rawLogsRequired: false,
    rawArtifactsRequired: false,
  });
  assert.doesNotMatch(JSON.stringify(redacted), /provider-secret|provider-refresh-token|AKIATEST|session-secret|BEGIN PRIVATE KEY|Bearer provider-token/);
});
