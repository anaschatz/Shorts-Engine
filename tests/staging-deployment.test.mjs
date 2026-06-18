import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  STAGING_ENV_CONTRACT,
  checkStagingReadiness,
  safeError as safeReadinessError,
  validateStagingUrl,
  verifyStagingWorkflowContract,
} from "../tools/release/check-staging-readiness.mjs";
import {
  MAX_HEALTH_RESPONSE_BYTES,
  checkStagingSmoke,
  healthUrlFor,
  safeError as safeSmokeError,
  validateHealthPayload,
} from "../tools/release/check-staging-smoke.mjs";
import {
  runStagingFullSmoke,
  safeError as safeFullSmokeError,
  validateFixturePath,
} from "../tools/release/check-staging-full-smoke.mjs";
import {
  STAGING_FULL_SMOKE_SOURCE,
  runStagingFullSmokeCleanup,
  safeError as safeCleanupError,
} from "../tools/release/cleanup-staging-full-smoke.mjs";
import {
  MAX_RENDER_DEPLOY_RESPONSE_BYTES,
  runStagingDeploy,
  safeError as safeDeployError,
  validateRenderServiceId,
} from "../tools/release/staging-deploy.mjs";
import {
  checkRenderStaging,
  safeError as safeRenderCheckError,
} from "../tools/release/check-render-staging.mjs";
import { buildRenderStagingChecklist } from "../tools/release/print-render-staging-checklist.mjs";
import { runRenderStagingProof } from "../tools/release/render-staging-proof.mjs";
import { buildReleaseEvidence } from "../tools/release/write-release-evidence.mjs";

const ENV_DOCS = readFileSync("docs/ENVIRONMENT.md", "utf8");
const ENV_EXAMPLE = readFileSync(".env.example", "utf8");
const STAGING_DOCS = readFileSync("docs/STAGING_DEPLOYMENT.md", "utf8");
const STAGING_WORKFLOW = readFileSync(".github/workflows/staging.yml", "utf8");
const CI_WORKFLOW = readFileSync(".github/workflows/ci.yml", "utf8");
const PACKAGE_JSON = JSON.parse(readFileSync("package.json", "utf8"));

function readinessOptions(env = {}) {
  return {
    env,
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
    environmentDocsText: ENV_DOCS,
    environmentExampleText: ENV_EXAMPLE,
    docsText: STAGING_DOCS,
    workflowText: STAGING_WORKFLOW,
  };
}

function healthPayload(overrides = {}) {
  return {
    ok: true,
    data: {
      service: "shortsengine-mvp",
      status: "ready",
      ffmpeg: { ffmpeg: true, ffprobe: true, configured: true },
      storage: { uploads: { readable: true, writable: true } },
      artifacts: { ready: true, mode: "local" },
      repositories: { projects: { ready: true } },
      adapters: { artifacts: { ready: true }, persistence: { ready: true } },
      transcription: { ready: true, provider: "mock" },
      analysis: { ready: true },
      requestId: "req_staging_smoke",
      ...overrides,
    },
  };
}

function okFetch(payload = healthPayload()) {
  return async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function writeJson(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function createReportDirs(nowMs) {
  const root = mkdtempSync(join(tmpdir(), "shortsengine-staging-evidence-"));
  const demoResultsDir = join(root, "demo-results");
  const evalResultsDir = join(root, "eval-results");
  mkdirSync(demoResultsDir, { recursive: true });
  mkdirSync(evalResultsDir, { recursive: true });
  const timestamp = new Date(nowMs).toISOString();
  writeJson(join(demoResultsDir, "latest.json"), { timestamp, status: "passed", failedCases: [] });
  writeJson(join(demoResultsDir, "ocr-latest.json"), {
    timestamp,
    generatedAt: timestamp,
    status: "passed",
    passed: true,
    skipped: true,
    degraded: true,
    runtime: {
      providerMode: "deterministic-scoreboard-ocr",
      localOcrEnabled: false,
      fallbackAvailable: true,
      networkRequired: false,
    },
    checks: [{ name: "scoreboard_ocr_output_valid", passed: true }],
    failedCases: [],
  });
  writeJson(join(demoResultsDir, "browser-latest.json"), { timestamp, status: "passed", failedCases: [] });
  writeJson(join(demoResultsDir, "playwright-latest.json"), {
    timestamp,
    status: "passed",
    artifacts: {
      directory: "demo/results/playwright-artifacts",
      traceOnFailure: false,
      videoOnFailure: false,
      files: [],
    },
    failedCases: [],
  });
  writeJson(join(evalResultsDir, "latest.json"), {
    generatedAt: timestamp,
    passed: true,
    aggregate: { aggregateScore: 99 },
    failedCases: [],
  });
  writeJson(join(evalResultsDir, "reference-latest.json"), {
    generatedAt: timestamp,
    passed: true,
    aggregate: { aggregateScore: 95, fixtureCount: 8 },
    failedCases: [],
    borderlineCases: [],
  });
  return { demoResultsDir, evalResultsDir };
}

function createFullSmokeFixture(bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(32)])) {
  const root = mkdtempSync(join(tmpdir(), "shortsengine-full-smoke-"));
  const fixtureDir = join(root, "demo", "fixtures");
  mkdirSync(fixtureDir, { recursive: true });
  const fixtureFile = join(fixtureDir, "shortsengine-demo-source.mp4");
  writeFileSync(fixtureFile, bytes);
  return { root, fixtureFile };
}

function fullSmokeEnv(extra = {}) {
  return {
    SHORTSENGINE_STAGING_FULL_SMOKE: "1",
    SHORTSENGINE_STAGING_URL: "https://staging.example.test",
    SHORTSENGINE_STAGING_FULL_SMOKE_JOB_TIMEOUT_MS: "1000",
    SHORTSENGINE_STAGING_FULL_SMOKE_POLL_INTERVAL_MS: "100",
    ...extra,
  };
}

function mp4Buffer() {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(128)]);
}

function createFullSmokeFetch(options = {}) {
  const jobStates = [...(options.jobStates || [{ status: "completed", exportId: "exp_stagingfull1" }])];
  return async (url, request = {}) => {
    const parsed = new URL(url);
    if (request.method === "GET" && parsed.pathname.endsWith("/health")) {
      return new Response(JSON.stringify(options.healthPayload || healthPayload({
        adapters: {
          artifacts: { ready: true, mode: "local", objectStorage: false },
          persistence: { ready: true, mode: "sqlite", database: true },
        },
      })), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (request.method === "POST" && parsed.pathname === "/api/uploads") {
      return new Response(JSON.stringify(options.uploadPayload || {
        ok: true,
        data: { project: { id: "prj_stagingfull1" }, upload: { id: "upl_stagingfull1" } },
      }), { status: options.uploadStatus || 201, headers: { "content-type": "application/json" } });
    }
    if (request.method === "POST" && parsed.pathname === "/api/projects/prj_stagingfull1/generate") {
      return new Response(JSON.stringify(options.generatePayload || {
        ok: true,
        data: { job: { id: "job_stagingfull1" } },
      }), { status: options.generateStatus || 202, headers: { "content-type": "application/json" } });
    }
    if (request.method === "GET" && parsed.pathname === "/api/jobs/job_stagingfull1") {
      const state = jobStates.length > 1 ? jobStates.shift() : jobStates[0];
      return new Response(JSON.stringify({
        ok: true,
        data: { job: { id: "job_stagingfull1", projectId: "prj_stagingfull1", uploadId: "upl_stagingfull1", ...state } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (request.method === "GET" && parsed.pathname === "/api/exports/exp_stagingfull1/download") {
      return new Response(options.downloadBody || mp4Buffer(), {
        status: options.downloadStatus || 200,
        headers: { "content-type": options.downloadContentType || "video/mp4" },
      });
    }
    return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
}

function repository(records = []) {
  const rows = new Map(records.map((record) => [record.id, record]));
  return {
    records: rows,
    all: () => [...rows.values()],
    delete: (id) => rows.delete(id),
    markDeleted: (id) => {
      const current = rows.get(id);
      if (!current) return null;
      current.status = "deleted";
      return current;
    },
  };
}

function smokeCleanupState(options = {}) {
  const createdAt = options.createdAt || "2026-06-14T19:30:00.000Z";
  const status = options.status || "completed";
  const source = options.missingSource ? null : STAGING_FULL_SMOKE_SOURCE;
  const project = {
    id: "prj_cleanupfull1",
    uploadId: "upl_cleanupfull1",
    title: "ShortsEngine Staging Full Smoke",
    status: "ready",
    source,
    createdAt,
    updatedAt: createdAt,
  };
  const uploadArtifact = {
    id: "upl_cleanupfull1",
    type: "upload",
    ownerProjectId: project.id,
    storageKey: "redacted-upload.mp4",
    status: "available",
    source,
    createdAt,
    updatedAt: createdAt,
  };
  const upload = {
    id: "upl_cleanupfull1",
    projectId: project.id,
    artifact: uploadArtifact,
    source,
    createdAt,
  };
  const job = {
    id: "job_cleanupfull1",
    projectId: project.id,
    uploadId: upload.id,
    exportId: "exp_cleanupfull1",
    status,
    idempotencyKey: "staging_full_1800000000000",
    payload: { source: STAGING_FULL_SMOKE_SOURCE, title: "ShortsEngine Staging Full Smoke", preset: "hype", language: "English" },
    createdAt,
    updatedAt: createdAt,
  };
  const exportArtifact = {
    id: "exp_cleanupfull1",
    type: "export",
    ownerProjectId: project.id,
    ownerJobId: job.id,
    storageKey: "redacted-export.mp4",
    status: "available",
    source,
    createdAt,
    updatedAt: createdAt,
  };
  const exportRecord = {
    id: "exp_cleanupfull1",
    projectId: project.id,
    jobId: job.id,
    artifact: exportArtifact,
    source,
    createdAt,
  };
  const renderedArtifact = {
    id: "rendered_video_cleanupfull1",
    type: "rendered_video",
    ownerProjectId: project.id,
    ownerJobId: job.id,
    storageKey: "redacted-render.mp4",
    status: "available",
    source,
    createdAt,
    updatedAt: createdAt,
  };
  const nonSmokeProject = {
    id: "prj_regularuser1",
    uploadId: "upl_regularuser1",
    title: "User Upload",
    status: "ready",
    source: null,
    createdAt,
    updatedAt: createdAt,
  };
  const nonSmokeArtifact = {
    id: "exp_regularuser1",
    type: "export",
    ownerProjectId: nonSmokeProject.id,
    ownerJobId: "job_regularuser1",
    storageKey: "protected-user-export.mp4",
    status: "available",
    source: null,
    createdAt,
    updatedAt: createdAt,
  };
  const deletedArtifacts = [];
  const artifactStore = {
    deleteMarkedArtifact: (artifact, deleteOptions = {}) => {
      if (artifact.source !== deleteOptions.source) throw new Error("forbidden");
      deletedArtifacts.push(artifact.id);
      return { ...artifact, status: "deleted" };
    },
  };
  return {
    deletedArtifacts,
    artifactStore,
    projectRepository: repository([project, nonSmokeProject]),
    uploadRepository: repository([upload]),
    exportRepository: repository([exportRecord]),
    artifactRepository: repository([uploadArtifact, exportArtifact, renderedArtifact, nonSmokeArtifact]),
    jobRecords: [job],
  };
}

test("staging docs mention all staging environment variables", () => {
  for (const spec of STAGING_ENV_CONTRACT) {
    assert.match(STAGING_DOCS, new RegExp(`\\b${spec.name}\\b`), `${spec.name} should be documented`);
    assert.match(ENV_EXAMPLE, new RegExp(`^${spec.name}=`, "m"), `${spec.name} should be present in .env.example`);
  }
});

test("staging readiness passes in default readiness-only mode", () => {
  const summary = checkStagingReadiness(readinessOptions());
  assert.equal(summary.ok, true);
  assert.equal(summary.deployment.target, "local");
  assert.equal(summary.deployment.provider, "none");
  assert.equal(summary.deployment.mode, "readiness-only");
  assert.equal(summary.smoke.uploadsVideo, false);
  assert.equal(summary.smoke.expensiveRender, false);
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging readiness fails closed when staging target lacks required values", () => {
  let error;
  try {
    checkStagingReadiness(readinessOptions({ SHORTSENGINE_DEPLOY_TARGET: "staging" }));
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /Staging URL is required/);
  assert.equal(safeReadinessError(error).code, "STAGING_URL_REQUIRED");
  assert.equal(findSensitiveLeak(safeReadinessError(error)), null);
});

test("staging readiness accepts Render target with protected credential and service id", () => {
  const summary = checkStagingReadiness(readinessOptions({
    SHORTSENGINE_DEPLOY_TARGET: "staging",
    SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
    SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
    SHORTSENGINE_STAGING_URL: "https://staging.example.test",
    SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
  }));
  assert.equal(summary.deployment.target, "staging");
  assert.equal(summary.deployment.provider, "render");
  assert.equal(summary.deployment.providerConfigured, true);
  assert.equal(summary.deployment.deployCredentialConfigured, true);
  assert.equal(summary.deployment.deployServiceIdConfigured, true);
  assert.equal(summary.deployment.stagingUrlHostType, "remote");
  assert.equal(findSensitiveLeak(summary), null);
});

test("Render staging configuration check passes default readiness-only mode without network", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("render check should not fetch");
  };
  try {
    const summary = checkRenderStaging({
      env: {},
      nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
      environmentDocsText: ENV_DOCS,
      environmentExampleText: ENV_EXAMPLE,
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.provider, "none");
    assert.equal(summary.readinessOnly, true);
    assert.equal(summary.networkCalls, false);
    assert.equal(summary.render.supported, false);
    assert.equal(summary.render.buildCommand, "npm ci");
    assert.equal(summary.render.startCommand, "npm start");
    assert.equal(summary.render.healthCheckPath, "/health");
    assert.equal(findSensitiveLeak(summary), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Render staging configuration check accepts valid mocked Render env", () => {
  const summary = checkRenderStaging({
    env: {
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
      SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
      MATCHCUTS_TRANSCRIPTION_PROVIDER: "mock",
      MATCHCUTS_PERSISTENCE_ADAPTER: "sqlite",
      MATCHCUTS_STORAGE_ADAPTER: "mock-cloud",
    },
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
    environmentDocsText: ENV_DOCS,
    environmentExampleText: ENV_EXAMPLE,
  });
  assert.equal(summary.mode, "render-staging");
  assert.equal(summary.render.supported, true);
  assert.equal(summary.render.serviceIdConfigured, true);
  assert.equal(summary.render.deployTokenConfigured, true);
  assert.equal(summary.render.stagingUrlHostType, "remote");
  assert.equal(summary.safeDefaults.transcriptionProvider, "mock");
  assert.equal(summary.safeDefaults.storageAdapter, "mock-cloud");
  assert.equal(summary.safeDefaults.persistenceAdapter, "sqlite");
  assert.equal(findSensitiveLeak(summary), null);
});

test("Render staging configuration check fails safely for missing token url and private URL", () => {
  const baseEnv = {
    SHORTSENGINE_DEPLOY_TARGET: "staging",
    SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
    SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
  };
  const missingUrl = (() => {
    try {
      checkRenderStaging({ env: { ...baseEnv, SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token" } });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.equal(safeRenderCheckError(missingUrl).code, "STAGING_URL_REQUIRED");

  const missingToken = (() => {
    try {
      checkRenderStaging({ env: { ...baseEnv, SHORTSENGINE_STAGING_URL: "https://staging.example.test" } });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.equal(safeRenderCheckError(missingToken).code, "STAGING_CREDENTIAL_MISSING");

  const privateUrl = (() => {
    try {
      checkRenderStaging({
        env: {
          ...baseEnv,
          SHORTSENGINE_STAGING_URL: "http://10.0.0.5",
          SHORTSENGINE_STAGING_ALLOW_LOCAL_URL: "1",
          SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
        },
      });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.equal(safeRenderCheckError(privateUrl).code, "RENDER_STAGING_URL_PUBLIC_REQUIRED");
  assert.equal(findSensitiveLeak(safeRenderCheckError(privateUrl)), null);
});

test("Render manual checklist contains no secrets or real service ids", () => {
  const checklist = buildRenderStagingChecklist();
  assert.equal(checklist.ok, true);
  assert.equal(checklist.secretsIncluded, false);
  assert.equal(checklist.networkCalls, false);
  assert.equal(checklist.renderService.buildCommand, "npm ci");
  assert.equal(checklist.renderService.startCommand, "npm start");
  assert.equal(checklist.renderService.healthCheckPath, "/health");
  assert.equal(JSON.stringify(checklist).includes("copy-from-render-dashboard"), true);
  assert.doesNotMatch(JSON.stringify(checklist), /srv-[A-Za-z0-9_-]{6,80}/);
  assert.equal(findSensitiveLeak(checklist), null);
});

test("Render local proof runs in provider none mode without network", async () => {
  const summary = await runRenderStagingProof({
    env: {
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
      SHORTSENGINE_STAGING_SERVICE_ID: "srv-wouldnotbeused",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
    },
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
    fetchImpl: async () => {
      throw new Error("proof must not fetch");
    },
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.networkCalls, false);
  assert.equal(summary.deployTriggered, false);
  assert.equal(summary.checks.environment, true);
  assert.equal(summary.checks.staging, true);
  assert.equal(summary.checks.render, true);
  assert.equal(summary.checks.deployReadinessOnly, true);
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging readiness rejects unsupported provider safely", () => {
  assert.throws(
    () => checkStagingReadiness(readinessOptions({
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "custom",
      SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
    })),
    /not supported/,
  );
});

test("staging readiness rejects Render target without service id", () => {
  assert.throws(
    () => checkStagingReadiness(readinessOptions({
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
    })),
    /service id/,
  );
});

test("staging deploy passes readiness-only mode without network", async () => {
  const summary = await runStagingDeploy({
    env: {},
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
    fetchImpl: async () => {
      throw new Error("should not fetch in readiness-only mode");
    },
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.provider, "none");
  assert.equal(summary.mode, "readiness-only");
  assert.equal(summary.deployTriggered, false);
  assert.equal(summary.providerResult, null);
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging deploy triggers Render with sanitized output", async () => {
  let request;
  const summary = await runStagingDeploy({
    env: {
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
      SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
    },
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        id: "dep_123",
        status: "created",
        rawError: "raw provider fields must be ignored",
        storageKey: "internal/render/key.mp4",
      }), { status: 201 });
    },
  });
  assert.equal(request.url, "https://api.render.com/v1/services/srv-shortsengine1/deploys");
  assert.equal(request.options.method, "POST");
  assert.match(request.options.headers.authorization, /^Bearer /);
  assert.equal(summary.provider, "render");
  assert.equal(summary.deployTriggered, true);
  assert.equal(summary.providerResult.providerRequestAccepted, true);
  assert.equal(summary.providerResult.deployIdPresent, true);
  assert.deepEqual(Object.keys(summary.providerResult).sort(), ["deployIdPresent", "providerRequestAccepted", "status"]);
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging deploy sanitizes suspicious Render status strings", async () => {
  const summary = await runStagingDeploy({
    env: {
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
      SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
    },
    fetchImpl: async () => new Response(JSON.stringify({
      id: "dep_123",
      status: ["Bearer", "raw-provider-token-should-not-survive"].join(" "),
    }), { status: 201 }),
  });
  assert.equal(summary.providerResult.status, "unknown");
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging deploy sanitizes service-id-like Render status strings", async () => {
  const summary = await runStagingDeploy({
    env: {
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
      SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
    },
    fetchImpl: async () => new Response(JSON.stringify({
      id: "dep_123",
      status: "srv-realstaging123",
    }), { status: 201 }),
  });
  assert.equal(summary.providerResult.status, "unknown");
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging deploy fails safely for missing Render service id", async () => {
  const error = await runStagingDeploy({
    env: {
      SHORTSENGINE_DEPLOY_TARGET: "staging",
      SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
    },
  }).catch((caught) => caught);
  assert.equal(safeDeployError(error).code, "STAGING_SERVICE_ID_MISSING");
  assert.equal(findSensitiveLeak(safeDeployError(error)), null);
});

test("staging deploy fails safely for Render non-2xx and fetch failures", async () => {
  const env = {
    SHORTSENGINE_DEPLOY_TARGET: "staging",
    SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
    SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
    SHORTSENGINE_STAGING_URL: "https://staging.example.test",
    SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
  };
  const nonSuccess = await runStagingDeploy({
    env,
    fetchImpl: async () => new Response("raw provider error should stay hidden", { status: 500 }),
  }).catch((caught) => caught);
  assert.equal(safeDeployError(nonSuccess).code, "STAGING_RENDER_DEPLOY_HTTP_FAILED");
  assert.equal(findSensitiveLeak(safeDeployError(nonSuccess)), null);

  const fetchFailure = await runStagingDeploy({
    env,
    fetchImpl: async () => {
      throw new Error("raw provider connection failure");
    },
  }).catch((caught) => caught);
  assert.equal(safeDeployError(fetchFailure).code, "STAGING_RENDER_DEPLOY_REQUEST_FAILED");
  assert.equal(findSensitiveLeak(safeDeployError(fetchFailure)), null);
});

test("staging deploy fails safely for oversized and invalid Render responses", async () => {
  const env = {
    SHORTSENGINE_DEPLOY_TARGET: "staging",
    SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "render",
    SHORTSENGINE_STAGING_SERVICE_ID: "srv-shortsengine1",
    SHORTSENGINE_STAGING_URL: "https://staging.example.test",
    SHORTSENGINE_STAGING_DEPLOY_TOKEN: "placeholder-deploy-token",
  };
  const oversized = await runStagingDeploy({
    env,
    fetchImpl: async () => new Response("x".repeat(MAX_RENDER_DEPLOY_RESPONSE_BYTES + 1), { status: 201 }),
  }).catch((caught) => caught);
  assert.equal(safeDeployError(oversized).code, "STAGING_RENDER_DEPLOY_RESPONSE_TOO_LARGE");
  assert.equal(findSensitiveLeak(safeDeployError(oversized)), null);

  const invalidJson = await runStagingDeploy({
    env,
    fetchImpl: async () => new Response("not-json", { status: 201 }),
  }).catch((caught) => caught);
  assert.equal(safeDeployError(invalidJson).code, "STAGING_RENDER_DEPLOY_JSON_INVALID");
  assert.equal(findSensitiveLeak(safeDeployError(invalidJson)), null);
});

test("Render service id validation is strict", () => {
  assert.equal(validateRenderServiceId("srv-shortsengine1"), "srv-shortsengine1");
  assert.throws(() => validateRenderServiceId("service-123"), /valid service id/);
});

test("staging URL validation rejects invalid and credentialed URLs", () => {
  assert.throws(() => validateStagingUrl("ftp://staging.example.test", { required: true }), /http or https/);
  assert.throws(() => validateStagingUrl("https://user:pass@staging.example.test", { required: true }), /must not embed credentials/);
});

test("staging URL validation rejects localhost unless explicit local mode is enabled", () => {
  assert.throws(() => validateStagingUrl("http://127.0.0.1:4175", { required: true }), /Private or local staging URLs require explicit local mode/);
  assert.equal(validateStagingUrl("http://127.0.0.1:4175", { required: true, allowLocal: true }).hostType, "local");
});

test("staging URL validation rejects private and link-local IPs unless explicit local mode is enabled", () => {
  for (const url of [
    "http://10.0.0.5",
    "http://172.16.0.5",
    "http://192.168.1.5",
    "http://169.254.169.254",
    "http://[fd00::1]",
  ]) {
    assert.throws(() => validateStagingUrl(url, { required: true }), /Private or local staging URLs require explicit local mode/);
  }
  assert.equal(validateStagingUrl("http://10.0.0.5", { required: true, allowLocal: true }).hostType, "private");
});

test("staging workflow contract is protected and does not publish artifacts", () => {
  const workflow = verifyStagingWorkflowContract(STAGING_WORKFLOW);
  assert.equal(workflow.environment, "staging");
  assert.equal(workflow.artifactUploadDefault, false);
  assert.equal(workflow.browserRuntimeSkipAllowed, false);
  assert.equal(workflow.realCloudIntegrationDefault, false);
});

test("staging smoke validates deployed health response safely", async () => {
  const summary = await checkStagingSmoke({
    env: {
      SHORTSENGINE_STAGING_URL: "https://staging.example.test",
      SHORTSENGINE_STAGING_SMOKE_RETRIES: "0",
    },
    fetchImpl: okFetch(),
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.health.status, "ready");
  assert.equal(summary.target.hostType, "remote");
  assert.equal(findSensitiveLeak(summary), null);
});

test("staging smoke rejects missing URL and keeps safe errors", async () => {
  await assert.rejects(
    () => checkStagingSmoke({ env: {}, fetchImpl: okFetch() }),
    /Staging URL is required/,
  );
  const error = await checkStagingSmoke({ env: {}, fetchImpl: okFetch() }).catch((caught) => caught);
  assert.equal(safeSmokeError(error).code, "STAGING_URL_REQUIRED");
  assert.equal(findSensitiveLeak(safeSmokeError(error)), null);
});

test("staging smoke rejects health response leaks", () => {
  assert.throws(
    () => validateHealthPayload(healthPayload({ storageKey: "renders/private/object.mp4" })),
    /contains sensitive data/,
  );
});

test("staging smoke rejects oversized and invalid JSON health responses safely", async () => {
  await assert.rejects(
    () => checkStagingSmoke({
      env: {
        SHORTSENGINE_STAGING_URL: "https://staging.example.test",
        SHORTSENGINE_STAGING_SMOKE_RETRIES: "0",
      },
      fetchImpl: async () => new Response("x".repeat(MAX_HEALTH_RESPONSE_BYTES + 1), { status: 200 }),
    }),
    /Staging health response is too large/,
  );
  await assert.rejects(
    () => checkStagingSmoke({
      env: {
        SHORTSENGINE_STAGING_URL: "https://staging.example.test",
        SHORTSENGINE_STAGING_SMOKE_RETRIES: "0",
      },
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    }),
    /not valid JSON/,
  );
});

test("staging smoke health URL is derived without query strings", () => {
  assert.equal(
    healthUrlFor("https://staging.example.test/app?token=redacted#frag"),
    "https://staging.example.test/app/health",
  );
});

test("full staging smoke is disabled by default", async () => {
  const { root, fixtureFile } = createFullSmokeFixture();
  const error = await runStagingFullSmoke({
    env: { SHORTSENGINE_STAGING_URL: "https://staging.example.test" },
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch(),
  }).catch((caught) => caught);
  assert.equal(safeFullSmokeError(error).code, "STAGING_FULL_SMOKE_DISABLED");
  assert.equal(findSensitiveLeak(safeFullSmokeError(error)), null);
});

test("full staging smoke rejects unsafe URLs and allows local only explicitly", async () => {
  const { root, fixtureFile } = createFullSmokeFixture();
  const unsafe = await runStagingFullSmoke({
    env: fullSmokeEnv({ SHORTSENGINE_STAGING_URL: "http://127.0.0.1:4175" }),
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch(),
  }).catch((caught) => caught);
  assert.equal(safeFullSmokeError(unsafe).code, "STAGING_URL_LOCAL_UNSAFE");

  const summary = await runStagingFullSmoke({
    env: fullSmokeEnv({
      SHORTSENGINE_STAGING_URL: "http://127.0.0.1:4175",
      SHORTSENGINE_STAGING_ALLOW_LOCAL_URL: "1",
    }),
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch(),
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
  });
  assert.equal(summary.target.hostType, "local");
  assert.equal(summary.flow.jobCompleted, true);
  assert.equal(findSensitiveLeak(summary), null);
});

test("full staging smoke validates fixture safety and size bounds", () => {
  const { root, fixtureFile } = createFullSmokeFixture(Buffer.alloc(4096));
  assert.equal(validateFixturePath({ rootDir: root, fixturePath: fixtureFile }).public.relativePath, "demo/fixtures/shortsengine-demo-source.mp4");
  assert.throws(
    () => validateFixturePath({ rootDir: root, fixturePath: "../unsafe.mp4" }),
    /inside demo fixtures/,
  );
  assert.throws(
    () => validateFixturePath({
      rootDir: root,
      fixturePath: fixtureFile,
      env: { SHORTSENGINE_STAGING_FULL_SMOKE_FIXTURE_MAX_BYTES: "1024" },
    }),
    /too large/,
  );
});

test("full staging smoke reuses health validation and reports durability safely", async () => {
  const { root, fixtureFile } = createFullSmokeFixture();
  const notReady = await runStagingFullSmoke({
    env: fullSmokeEnv(),
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch({ healthPayload: healthPayload({ status: "degraded" }) }),
  }).catch((caught) => caught);
  assert.equal(safeFullSmokeError(notReady).code, "STAGING_FULL_HEALTH_NOT_READY");

  const summary = await runStagingFullSmoke({
    env: fullSmokeEnv(),
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch({
      healthPayload: healthPayload({
        adapters: {
          artifacts: { ready: true, mode: "s3", objectStorage: true },
          persistence: { ready: true, mode: "sqlite", database: true },
        },
      }),
    }),
  });
  assert.equal(summary.health.durabilityMode, "durable-capable");
  assert.equal(findSensitiveLeak(summary), null);
});

test("full staging smoke completes upload generate job export and download", async () => {
  const { root, fixtureFile } = createFullSmokeFixture();
  const summary = await runStagingFullSmoke({
    env: fullSmokeEnv(),
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch({
      jobStates: [
        { status: "processing", progress: 55 },
        { status: "completed", exportId: "exp_stagingfull1" },
      ],
    }),
    nowMs: Date.parse("2026-06-15T19:30:00.000Z"),
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.gated.explicitFlag, true);
  assert.equal(summary.gated.healthOnly, false);
  assert.equal(summary.flow.uploadAccepted, true);
  assert.equal(summary.flow.generateAccepted, true);
  assert.equal(summary.flow.jobCompleted, true);
  assert.equal(summary.flow.exportDownloadable, true);
  assert.equal(summary.flow.pollCount, 2);
  assert.equal(summary.export.contentType, "video/mp4");
  assert.equal(summary.cleanup.source, STAGING_FULL_SMOKE_SOURCE);
  assert.equal(summary.cleanup.explicitCleanupFlag, "SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP=1");
  assert.equal(summary.health.durabilityMode, "ephemeral-staging");
  assert.equal(findSensitiveLeak(summary), null);
});

test("full staging smoke fails closed for invalid upload response and response leaks", async () => {
  const { root, fixtureFile } = createFullSmokeFixture();
  const invalidUpload = await runStagingFullSmoke({
    env: fullSmokeEnv(),
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch({
      uploadPayload: { ok: true, data: { project: { id: "bad" }, upload: { id: "upl_stagingfull1" } } },
    }),
  }).catch((caught) => caught);
  assert.equal(safeFullSmokeError(invalidUpload).code, "STAGING_FULL_UPLOAD_RESPONSE_INVALID");

  const tokenValue = ["adt", "11111111-1111-4111-8111-111111111111", "abcdefabcdefabcdefabcdefabcdefab"].join("_");
  const leaked = await runStagingFullSmoke({
    env: fullSmokeEnv(),
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch({
      uploadPayload: { ok: true, data: { project: { id: "prj_stagingfull1" }, upload: { id: "upl_stagingfull1" }, signed: tokenValue } },
    }),
  }).catch((caught) => caught);
  assert.equal(safeFullSmokeError(leaked).code, "STAGING_FULL_RESPONSE_LEAK");
  assert.equal(findSensitiveLeak(safeFullSmokeError(leaked)), null);
});

test("full staging smoke fails closed for job failure timeout and missing export", async () => {
  const { root, fixtureFile } = createFullSmokeFixture();
  const failedJob = await runStagingFullSmoke({
    env: fullSmokeEnv(),
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch({ jobStates: [{ status: "failed", error: { code: "RENDER_FAILED" } }] }),
  }).catch((caught) => caught);
  assert.equal(safeFullSmokeError(failedJob).code, "STAGING_FULL_JOB_TERMINAL_FAILURE");

  const missingExport = await runStagingFullSmoke({
    env: fullSmokeEnv(),
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch({ jobStates: [{ status: "completed" }] }),
  }).catch((caught) => caught);
  assert.equal(safeFullSmokeError(missingExport).code, "STAGING_FULL_EXPORT_MISSING");

  const timeout = await runStagingFullSmoke({
    env: fullSmokeEnv({ SHORTSENGINE_STAGING_FULL_SMOKE_JOB_TIMEOUT_MS: "1000" }),
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch({ jobStates: [{ status: "processing" }] }),
  }).catch((caught) => caught);
  assert.equal(safeFullSmokeError(timeout).code, "STAGING_FULL_JOB_TIMEOUT");
});

test("full staging smoke validates export download content type and MP4 signature", async () => {
  const { root, fixtureFile } = createFullSmokeFixture();
  const wrongType = await runStagingFullSmoke({
    env: fullSmokeEnv(),
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch({ downloadContentType: "text/plain" }),
  }).catch((caught) => caught);
  assert.equal(safeFullSmokeError(wrongType).code, "STAGING_FULL_DOWNLOAD_CONTENT_TYPE_INVALID");

  const wrongSignature = await runStagingFullSmoke({
    env: fullSmokeEnv(),
    rootDir: root,
    fixturePath: fixtureFile,
    fetchImpl: createFullSmokeFetch({ downloadBody: Buffer.from("not-an-mp4") }),
  }).catch((caught) => caught);
  assert.equal(safeFullSmokeError(wrongSignature).code, "STAGING_FULL_DOWNLOAD_SIGNATURE_INVALID");
});

test("full staging smoke cleanup is dry-run by default and reports safely", async () => {
  const state = smokeCleanupState();
  const summary = await runStagingFullSmokeCleanup({
    ...state,
    env: {},
    nowMs: Date.parse("2026-06-16T19:30:00.000Z"),
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.cleanupEnabled, false);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.deleted, 0);
  assert.equal(state.deletedArtifacts.length, 0);
  assert.equal(state.projectRepository.records.has("prj_cleanupfull1"), true);
  assert.equal(findSensitiveLeak(summary), null);
  assert.doesNotMatch(JSON.stringify(summary), /storageKey|redacted-export|\/Users|\/private/);
});

test("full staging smoke cleanup requires explicit numeric delete flag", async () => {
  const error = await runStagingFullSmokeCleanup({
    ...smokeCleanupState(),
    env: { SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP: "true" },
    nowMs: Date.parse("2026-06-16T19:30:00.000Z"),
  }).catch((caught) => caught);
  const safe = safeCleanupError(error);

  assert.equal(safe.code, "STAGING_FULL_CLEANUP_FLAG_INVALID");
  assert.equal(findSensitiveLeak(safe), null);
});

test("full staging smoke cleanup deletes only smoke-marked ownership chains", async () => {
  const state = smokeCleanupState();
  const summary = await runStagingFullSmokeCleanup({
    ...state,
    env: { SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP: "1" },
    nowMs: Date.parse("2026-06-16T19:30:00.000Z"),
  });

  assert.equal(summary.dryRun, false);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.deletedArtifacts, 3);
  assert.equal(state.deletedArtifacts.sort().join(","), "exp_cleanupfull1,rendered_video_cleanupfull1,upl_cleanupfull1");
  assert.equal(state.projectRepository.records.has("prj_cleanupfull1"), false);
  assert.equal(state.projectRepository.records.has("prj_regularuser1"), true);
  assert.equal(state.artifactRepository.records.get("exp_regularuser1").status, "available");
  assert.equal(findSensitiveLeak(summary), null);
});

test("full staging smoke cleanup protects active jobs", async () => {
  const state = smokeCleanupState({ status: "processing" });
  const summary = await runStagingFullSmokeCleanup({
    ...state,
    env: { SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP: "1" },
    nowMs: Date.parse("2026-06-16T19:30:00.000Z"),
  });

  assert.equal(summary.eligible, 0);
  assert.equal(summary.skippedActive, 1);
  assert.equal(summary.deleted, 0);
  assert.equal(state.deletedArtifacts.length, 0);
  assert.equal(state.projectRepository.records.has("prj_cleanupfull1"), true);
});

test("full staging smoke cleanup ignores missing markers and respects max-age max-count bounds", async () => {
  const missingMarker = await runStagingFullSmokeCleanup({
    ...smokeCleanupState({ missingSource: true }),
    env: { SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP: "1" },
    nowMs: Date.parse("2026-06-16T19:30:00.000Z"),
  });
  assert.equal(missingMarker.eligible, 0);
  assert.equal(missingMarker.skippedUnmarked, 2);
  assert.equal(missingMarker.deleted, 0);

  const young = await runStagingFullSmokeCleanup({
    ...smokeCleanupState({ createdAt: "2026-06-16T19:29:59.000Z" }),
    env: {
      SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP: "1",
      SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP_MAX_AGE_SECONDS: "60",
    },
    nowMs: Date.parse("2026-06-16T19:30:00.000Z"),
  });
  assert.equal(young.eligible, 0);
  assert.equal(young.skippedYoung, 1);

  const bounded = await runStagingFullSmokeCleanup({
    ...smokeCleanupState(),
    env: {
      SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP: "1",
      SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP_MAX_COUNT: "1",
    },
    nowMs: Date.parse("2026-06-16T19:30:00.000Z"),
  });
  assert.equal(bounded.bounds.maxCount, 1);
  assert.equal(bounded.eligible, 1);
});

test("release evidence includes staging readiness safely", () => {
  const nowMs = Date.parse("2026-06-15T19:30:00.000Z");
  const reportDirs = createReportDirs(nowMs);
  const evidence = buildReleaseEvidence({
    env: {},
    nowMs,
    packageJson: PACKAGE_JSON,
    workflowText: CI_WORKFLOW,
    docsText: ENV_DOCS,
    exampleText: ENV_EXAMPLE,
    stagingDocsText: STAGING_DOCS,
    stagingWorkflowText: STAGING_WORKFLOW,
    demoResultsDir: reportDirs.demoResultsDir,
    evalResultsDir: reportDirs.evalResultsDir,
    maxAgeMs: 60_000,
  });
  assert.equal(evidence.stagingReadiness.ok, true);
  assert.equal(evidence.stagingReadiness.deployment.provider, "none");
  assert.equal(findSensitiveLeak(evidence.stagingReadiness), null);
});
