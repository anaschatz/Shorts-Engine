const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { resolve } = require("node:path");

const TEST_TMP_ROOT = resolve(__dirname, "..", "tmp");
mkdirSync(TEST_TMP_ROOT, { recursive: true });
const TEST_DATA_DIR = mkdtempSync(resolve(TEST_TMP_ROOT, "auth-boundary-data-"));
process.env.MATCHCUTS_DATA_DIR = TEST_DATA_DIR;
process.env.SHORTSENGINE_AUTH_MODE = "operator";
process.env.SHORTSENGINE_OPERATOR_ID = "ownerA";
process.env.SHORTSENGINE_OPERATOR_AUTH_TOKEN = "test_operator_token_1234567890abcdef";

const {
  artifactStore,
  jobs,
  persistenceAdapter,
  route,
  stopWorkers,
} = require("../server/app.cjs");
const {
  authenticateRequest,
  validateAuthConfig,
} = require("../server/auth.cjs");

test.after(async () => {
  await stopWorkers({ requestId: "auth_boundary_test_shutdown", timeoutMs: 0 });
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function authHeader(token = process.env.SHORTSENGINE_OPERATOR_AUTH_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

function mockRequest({ method = "GET", url = "/", headers = {}, body = Buffer.alloc(0) }) {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: "auth-test-client" },
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

async function request(options) {
  const req = mockRequest(options);
  const res = mockResponse();
  await route(req, res);
  let payload = null;
  try {
    payload = JSON.parse(res.body.toString("utf8") || "{}");
  } catch {
    payload = null;
  }
  return { res, payload };
}

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

test("protected upload route rejects missing auth before request validation", async () => {
  const { res, payload } = await request({ method: "POST", url: "/api/uploads" });
  assert.equal(res.statusCode, 401);
  assert.equal(payload.error.code, "AUTH_REQUIRED");
  assert.doesNotMatch(JSON.stringify(payload), /test_operator_token|authorization|Bearer/i);
});

test("operator auth accepts valid bearer token and rejects invalid token", () => {
  const config = validateAuthConfig({
    mode: "operator",
    environment: "development",
    operatorId: "ownerA",
    operatorToken: process.env.SHORTSENGINE_OPERATOR_AUTH_TOKEN,
  });
  const principal = authenticateRequest({ headers: authHeader() }, config);
  assert.equal(principal.id, "ownerA");
  assert.throws(
    () => authenticateRequest({ headers: authHeader("wrong_token_1234567890abcdef") }, config),
    /Authentication is required/,
  );
});

test("local auth mode is explicit and not allowed in production", () => {
  const local = validateAuthConfig({ mode: "local", environment: "development", operatorId: "localOperator" });
  assert.equal(local.localAnonymous, true);
  assert.throws(
    () => validateAuthConfig({ mode: "local", environment: "production", operatorId: "localOperator" }),
    /Local anonymous auth mode is not allowed/,
  );
});

test("job reads require matching owner", async () => {
  const projectId = id("prj");
  const owned = jobs.create({ projectId, ownerId: "ownerA", action: "generate", idempotencyKey: `auth-owned-${randomUUID()}` });
  const other = jobs.create({ projectId, ownerId: "ownerB", action: "generate", idempotencyKey: `auth-other-${randomUUID()}` });

  const allowed = await request({ method: "GET", url: `/api/jobs/${owned.id}`, headers: authHeader() });
  assert.equal(allowed.res.statusCode, 200);
  assert.equal(allowed.payload.data.job.id, owned.id);

  const denied = await request({ method: "GET", url: `/api/jobs/${other.id}`, headers: authHeader() });
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.payload.error.code, "FORBIDDEN");
});

test("export download-url requires auth and owner access", async () => {
  const projectId = id("prj");
  const uploadId = id("upl");
  const job = jobs.create({
    projectId,
    uploadId,
    ownerId: "ownerB",
    action: "generate",
    idempotencyKey: `auth-export-${randomUUID()}`,
  });
  jobs.update(job, { status: "processing", progress: 90, step: "render_short" });
  jobs.complete(job, { exportId: id("exp") });
  persistenceAdapter.createProject({
    id: projectId,
    uploadId,
    title: "Auth boundary export",
    status: "ready",
    ownerId: "ownerB",
  });
  const artifact = artifactStore.writeBuffer({
    id: job.exportId,
    type: "export",
    ownerProjectId: projectId,
    ownerJobId: job.id,
    storageKey: `${job.id}.mp4`,
    buffer: Buffer.from("auth export"),
  });
  persistenceAdapter.createExport({
    id: job.exportId,
    projectId,
    jobId: job.id,
    ownerId: "ownerB",
    artifact,
    fileName: `${projectId}-short.mp4`,
  });

  const missingAuth = await request({ method: "GET", url: `/api/exports/${job.exportId}/download-url` });
  assert.equal(missingAuth.res.statusCode, 401);

  const denied = await request({ method: "GET", url: `/api/exports/${job.exportId}/download-url`, headers: authHeader() });
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.payload.error.code, "FORBIDDEN");
});
