const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const test = require("node:test");

const { AppError } = require("../server/errors.cjs");
const {
  createProductionWebApp,
  publicJob,
} = require("../server/web/production-web-app.cjs");

function request(method, url, body = null, headers = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return req;
}

function response() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk = "") {
      this.body += chunk;
    },
  };
}

function runtime(overrides = {}) {
  const calls = [];
  const auth = {
    allowedOrigin: "https://app.example.test",
    sessionTokenFromCookie() {
      return "session-token";
    },
    csrfTokenFromCookie() {
      return "csrf-token";
    },
    async resolveSession() {
      return {
        userId: "usr_12345678",
        csrfTokenHash: "hash",
        principal: {
          id: "usr_12345678",
          authMode: "oidc",
        },
      };
    },
    assertCsrf({ csrfToken, origin }) {
      if (
        csrfToken !== "csrf-token"
        || origin !== "https://app.example.test"
      ) {
        throw new AppError("CSRF_INVALID", undefined, 403);
      }
      return true;
    },
    ...overrides.auth,
  };
  return {
    calls,
    role: "web",
    config: {
      oidc: { publicBaseUrl: "https://app.example.test/" },
    },
    publicConfig: {
      environment: "staging",
      adapters: {
        persistence: "postgres",
        queue: "postgres",
        auth: "oidc",
        storage: "r2",
      },
    },
    auth,
    queue: {
      async get(jobId, ownerId) {
        calls.push({ method: "getJob", jobId, ownerId });
        return overrides.job || null;
      },
    },
    services: {
      uploads: {
        async createUpload(input) {
          calls.push({ method: "createUpload", input });
          return { project: { id: "prj_12345678" } };
        },
        async completeUpload(input) {
          calls.push({ method: "completeUpload", input });
          return {
            upload: { id: input.uploadId, status: "validating" },
            validation: { jobId: "job_validate1" },
          };
        },
        async issueDeliveryGrant(input) {
          calls.push({ method: "grant", input });
          return {
            url: "/api/delivery/opaque",
            expiresAt: "2026-07-26T12:02:00.000Z",
          };
        },
      },
      footballReviews: {
        async expirePreviews(input) {
          calls.push({ method: "getReview", input });
          return overrides.review || {
            id: "fbr_12345678",
            projectId: "prj_12345678",
            sourceRevision: "a".repeat(64),
            projectRevision: 1,
            version: 1,
            status: "preparing",
            selectedCandidateId: null,
            candidates: [],
            createdAt: "2026-07-26T12:00:00.000Z",
            updatedAt: "2026-07-26T12:00:00.000Z",
          };
        },
        publicReview(review) {
          return {
            id: review.id,
            status: review.status,
            candidates: review.candidates,
          };
        },
        async decideAndEnqueueReview(input) {
          calls.push({ method: "decision", input });
          return {
            review: {
              id: input.reviewId,
              status: "selected",
              candidates: [],
            },
            job: {
              id: "job_render1",
              projectId: "prj_12345678",
              action: "render_approved_candidate",
              pipelineType: "football",
              status: "queued",
              progress: 0,
              step: "queued",
              attempts: 0,
              maxAttempts: 4,
              nextRetryAt: null,
              error: null,
              result: null,
              createdAt: "2026-07-26T12:00:00.000Z",
              updatedAt: "2026-07-26T12:00:00.000Z",
            },
            replayed: false,
          };
        },
      },
    },
    async readiness() {
      return { ready: true, role: "web" };
    },
  };
}

async function invoke(app, req) {
  const res = response();
  await app(req, res);
  return {
    status: res.status,
    headers: res.headers,
    json: res.body ? JSON.parse(res.body) : null,
  };
}

test("production API resolves a session and returns only public runtime config", async () => {
  const rt = runtime();
  const app = createProductionWebApp({ runtime: rt });
  const result = await invoke(
    app,
    request("GET", "/api/session", null, { cookie: "opaque" }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.json.data.principal.id, "usr_12345678");
  assert.equal(result.json.data.csrfToken, "csrf-token");
  assert.equal(JSON.stringify(result.json).includes("session-token"), false);
});

test("multipart routes force the authenticated owner and enqueue real validation", async () => {
  const rt = runtime();
  const app = createProductionWebApp({ runtime: rt });
  const headers = {
    cookie: "opaque",
    origin: "https://app.example.test",
    "x-csrf-token": "csrf-token",
  };
  const created = await invoke(app, request(
    "POST",
    "/api/uploads/multipart",
    {
      ownerId: "usr_attacker",
      contentType: "video/mp4",
      byteSize: 100,
      rightsConfirmed: true,
    },
    headers,
  ));
  assert.equal(created.status, 201);
  assert.equal(
    rt.calls.find((call) => call.method === "createUpload").input.ownerId,
    "usr_12345678",
  );
  const completed = await invoke(app, request(
    "POST",
    "/api/uploads/upl_12345678/complete",
    { parts: [{ partNumber: 1, etag: "etag" }] },
    headers,
  ));
  assert.equal(completed.status, 202);
  assert.equal(completed.json.data.validation.jobId, "job_validate1");
  assert.equal(
    rt.calls.find((call) => call.method === "completeUpload").input.ownerId,
    "usr_12345678",
  );
});

test("review decisions bind owner, version, source revision and idempotency", async () => {
  const rt = runtime();
  const app = createProductionWebApp({ runtime: rt });
  const result = await invoke(app, request(
    "POST",
    "/api/football/reviews/fbr_12345678/decision",
    {
      action: "select",
      candidateId: "fcand_0123456789abcdef0123456789abcdef",
      expectedVersion: 3,
      expectedSourceRevision: "a".repeat(64),
    },
    {
      cookie: "opaque",
      origin: "https://app.example.test",
      "x-csrf-token": "csrf-token",
      "idempotency-key": "decision-key-123",
    },
  ));
  assert.equal(result.status, 202);
  const decision = rt.calls.find((call) => call.method === "decision").input;
  assert.equal(decision.ownerId, "usr_12345678");
  assert.equal(decision.expectedVersion, 3);
  assert.equal(decision.idempotencyKey, "decision-key-123");
  assert.equal(result.json.data.job.id, "job_render1");
});

test("public job projection never exposes worker payload or unbounded result fields", () => {
  const projected = publicJob({
    id: "job_12345678",
    projectId: "prj_12345678",
    action: "render_approved_candidate",
    pipelineType: "football",
    status: "completed",
    progress: 100,
    step: "completed",
    attempts: 1,
    maxAttempts: 4,
    payload: {
      approvedEditPlan: { serverOnly: true },
      secret: "must-not-leak",
    },
    result: {
      artifactId: "art_12345678",
      exportId: "exp_12345678",
      storageKey: "must-not-leak",
      rawProviderResponse: "must-not-leak",
    },
  });
  assert.deepEqual(projected.result, {
    artifactId: "art_12345678",
    exportId: "exp_12345678",
  });
  assert.equal("payload" in projected, false);
});
