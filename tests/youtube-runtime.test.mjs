import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  runYouTubeLiveE2E,
  writeYouTubeLiveE2EReport,
} from "../demo/run-youtube-live-e2e.mjs";
import { runYouTubeSmoke, writeYouTubeSmokeReport } from "../demo/run-youtube-smoke.mjs";
import {
  YouTubeDoctorError,
  checkYouTubeIngest,
  safeError as safeDoctorError,
} from "../tools/release/check-youtube-ingest.mjs";

const VIDEO_ID = "dQw4w9WgXcQ";
const SAFE_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

function readyStorage() {
  return {
    staging: { exists: true, readable: true, writable: true },
    tmp: { exists: true, readable: true, writable: true },
    artifacts: { exists: true, readable: true, writable: true },
  };
}

function jsonResponse(payload, status = 200, requestId = "req_test") {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
}

function mp4Response() {
  const buffer = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
    Buffer.alloc(128),
  ]);
  return new Response(buffer, {
    status: 200,
    headers: {
      "content-type": "video/mp4",
      "content-length": String(buffer.length),
      "x-request-id": "req_download",
    },
  });
}

function createFetchMock(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = String(options.method || "GET").toUpperCase();
    const key = `${method} ${parsed.pathname}`;
    calls.push({ key, body: options.body || null });
    if (overrides[key]) return overrides[key]({ url: String(url), options });
    if (key === "GET /health") {
      return jsonResponse({
        ok: true,
        data: {
          service: "shortsengine-mvp",
          status: "ready",
          requestId: "rid_health",
          ffmpeg: { ffmpeg: true, ffprobe: true },
          youtubeIngest: {
            enabled: true,
            mode: "local",
            ready: true,
            downloaderConfigured: true,
            ingestAvailable: true,
          },
        },
      }, 200, "req_health");
    }
    if (key === "POST /api/youtube/validate") {
      const body = JSON.parse(options.body);
      assert.equal(body.url, SAFE_URL);
      assert.equal(body.rightsConfirmed, true);
      return jsonResponse({
        ok: true,
        data: {
          source: {
            sourceType: "youtube",
            kind: "watch",
            videoId: VIDEO_ID,
            ingestAvailable: true,
            downloaderConfigured: true,
          },
        },
      }, 200, "req_validate");
    }
    if (key === "POST /api/youtube/ingest") {
      const body = JSON.parse(options.body);
      assert.equal(body.url, SAFE_URL);
      assert.equal(body.rightsConfirmed, true);
      return jsonResponse({
        ok: true,
        data: {
          project: { id: "prj_12345678", status: "draft" },
          upload: {
            id: "upl_12345678",
            projectId: "prj_12345678",
            metadata: { durationSeconds: 12, width: 1280, height: 720 },
            artifact: { id: "upl_12345678", type: "upload", status: "available", size: 1024 },
          },
          source: {
            sourceType: "youtube",
            kind: "watch",
            videoId: VIDEO_ID,
            durationSeconds: 12,
          },
        },
      }, 201, "req_ingest");
    }
    if (key === "POST /api/projects/prj_12345678/generate") {
      const body = JSON.parse(options.body);
      assert.equal(body.rightsConfirmed, true);
      assert.match(body.idempotencyKey, /^youtube_smoke_/);
      return jsonResponse({
        ok: true,
        data: {
          job: { id: "job_12345678", projectId: "prj_12345678", uploadId: "upl_12345678", status: "queued" },
        },
      }, 202, "req_generate");
    }
    if (key === "GET /api/jobs/job_12345678") {
      return jsonResponse({
        ok: true,
        data: {
          job: {
            id: "job_12345678",
            projectId: "prj_12345678",
            uploadId: "upl_12345678",
            status: "completed",
            progress: 100,
            step: "completed",
            exportId: "exp_12345678",
          },
        },
      }, 200, "req_job");
    }
    if (key === "GET /api/exports/exp_12345678/download") return mp4Response();
    return jsonResponse({ ok: false, error: { code: "TEST_ROUTE_NOT_FOUND", message: "Missing mocked route." } }, 404);
  };
  return { fetchImpl, calls };
}

function smokeEnv(overrides = {}) {
  return {
    SHORTSENGINE_YOUTUBE_SMOKE: "1",
    SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
    SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED: "1",
    SHORTSENGINE_YOUTUBE_SMOKE_URL: SAFE_URL,
    SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL: "http://127.0.0.1:4175",
    ...overrides,
  };
}

test("youtube doctor disabled default returns a safe skipped summary", async () => {
  let downloaderChecked = false;
  const result = await checkYouTubeIngest({
    env: {},
    nowMs: Date.parse("2026-06-16T00:00:00.000Z"),
    commandAvailable: () => true,
    downloaderAvailable: () => {
      downloaderChecked = true;
      return false;
    },
    storageHealth: readyStorage,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "skipped");
  assert.equal(result.code, "YOUTUBE_INGEST_DISABLED");
  assert.equal(result.youtubeIngest.enabled, false);
  assert.match(result.nextAction, /SHORTSENGINE_YOUTUBE_INGEST_ENABLED/);
  assert.equal(downloaderChecked, false);
  assert.equal(findSensitiveLeak(result), null);
});

test("youtube doctor enabled reports missing downloader safely", async () => {
  const result = await checkYouTubeIngest({
    env: { SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1" },
    commandAvailable: () => true,
    downloaderAvailable: () => false,
    storageHealth: readyStorage,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.code, "YOUTUBE_DOWNLOADER_MISSING");
  assert.equal(result.youtubeIngest.ingestAvailable, false);
  assert.match(result.nextAction, /downloader|SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN/);
  assert.equal(findSensitiveLeak(result), null);
});

test("youtube doctor live health shape failures include safe next actions", async () => {
  const result = await checkYouTubeIngest({
    env: {
      SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
      SHORTSENGINE_YOUTUBE_DOCTOR_URL: "http://127.0.0.1:4175",
    },
    commandAvailable: () => true,
    downloaderAvailable: () => true,
    storageHealth: readyStorage,
    fetchImpl: async () => jsonResponse({
      ok: true,
      data: {
        service: "shortsengine-mvp",
        status: "ready",
      },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "YOUTUBE_DOCTOR_HEALTH_YOUTUBE_MISSING");
  assert.equal(result.serverHealth.code, "YOUTUBE_DOCTOR_HEALTH_YOUTUBE_MISSING");
  assert.match(result.serverHealth.nextAction, /youtubeIngest-shape/);
  assert.equal(findSensitiveLeak(result), null);
});

test("youtube doctor safeError maps live health shape errors to operator guidance", () => {
  const safe = safeDoctorError(new YouTubeDoctorError(
    "YOUTUBE_DOCTOR_HEALTH_YOUTUBE_INVALID",
    "Health youtubeIngest readiness shape is invalid.",
  ));
  assert.equal(safe.status, "failed");
  assert.match(safe.nextAction, /youtubeIngest-shape/);
  assert.equal(findSensitiveLeak(safe), null);
});

test("youtube smoke skips safely without explicit flag", async () => {
  let calls = 0;
  const report = await runYouTubeSmoke({
    env: {},
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
  });
  assert.equal(report.status, "skipped");
  assert.equal(calls, 0);
  assert.equal(report.checks[0].code, "YOUTUBE_SMOKE_DISABLED");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke rejects unsafe URLs before network", async () => {
  let calls = 0;
  const report = await runYouTubeSmoke({
    env: smokeEnv({ SHORTSENGINE_YOUTUBE_SMOKE_URL: `${SAFE_URL}&list=PL123` }),
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(calls, 0);
  assert.equal(report.failedCases[0].code, "YOUTUBE_PLAYLIST_UNSUPPORTED");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke requires allowlist or explicit manual flag before network", async () => {
  let calls = 0;
  const report = await runYouTubeSmoke({
    env: smokeEnv({ SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED: "0", SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS: "" }),
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(calls, 0);
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_URL_NOT_ALLOWED");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke successful mocked flow validates ingest generate job and download contract", async () => {
  const { fetchImpl, calls } = createFetchMock();
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  assert.equal(report.status, "passed");
  assert.equal(report.ids.projectId, "prj_12345678");
  assert.equal(report.ids.uploadId, "upl_12345678");
  assert.equal(report.ids.jobId, "job_12345678");
  assert.equal(report.ids.exportId, "exp_12345678");
  assert.equal(report.export.contentType, "video/mp4");
  assert.equal(report.export.sizeBytes > 0, true);
  assert.equal(report.steps.every((step) => !Object.hasOwn(step, "requestId")), true);
  assert.equal(report.steps.every((step) => step.status !== "passed" || step.requestIdPresent === true || step.step === "job"), true);
  assert.deepEqual(calls.map((call) => call.key), [
    "GET /health",
    "POST /api/youtube/validate",
    "POST /api/youtube/ingest",
    "POST /api/projects/prj_12345678/generate",
    "GET /api/jobs/job_12345678",
    "GET /api/exports/exp_12345678/download",
  ]);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(SAFE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke fails closed when health is not ready", async () => {
  const { fetchImpl } = createFetchMock({
    "GET /health": () => jsonResponse({
      ok: true,
      data: {
        service: "shortsengine-mvp",
        status: "degraded",
        requestId: "rid_health",
        ffmpeg: { ffmpeg: true, ffprobe: true },
        youtubeIngest: {
          enabled: true,
          mode: "local",
          ready: false,
          downloaderConfigured: true,
          ingestAvailable: true,
        },
      },
    }),
  });
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_HEALTH_NOT_READY");
  assert.match(report.failedCases[0].nextAction, /ready-server/);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke report writer creates stable safe latest report", async () => {
  const { fetchImpl } = createFetchMock();
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  const outputDir = mkdtempSync(join(tmpdir(), "shortsengine-youtube-smoke-"));
  const written = writeYouTubeSmokeReport(report, outputDir);
  const latestFile = join(outputDir, "youtube-smoke-latest.json");
  assert.equal(existsSync(latestFile), true);
  assert.equal(written.latestPath.endsWith("youtube-smoke-latest.json"), true);
  const persisted = JSON.parse(readFileSync(latestFile, "utf8"));
  assert.equal(persisted.status, "passed");
  assert.equal(findSensitiveLeak(persisted), null);
});

test("youtube smoke fails closed when public responses leak unsafe fields", async () => {
  const { fetchImpl } = createFetchMock({
    "POST /api/youtube/ingest": () => jsonResponse({
      ok: true,
      data: {
        project: { id: "prj_12345678" },
        upload: {
          id: "upl_12345678",
          storageKey: "private/storage/key.mp4",
          metadata: { durationSeconds: 12 },
          artifact: { id: "upl_12345678", type: "upload", status: "available", size: 1024 },
        },
        source: { sourceType: "youtube", videoId: VIDEO_ID, durationSeconds: 12 },
      },
    }, 201),
  });
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_RESPONSE_LEAK");
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke fails closed when public responses contain raw downloader output", async () => {
  const { fetchImpl } = createFetchMock({
    "POST /api/youtube/validate": () => jsonResponse({
      ok: true,
      data: {
        source: {
          sourceType: "youtube",
          kind: "watch",
          videoId: VIDEO_ID,
          ingestAvailable: true,
          downloaderConfigured: true,
          stdout: "yt-dlp --cookies /tmp/private-cookie.txt",
        },
      },
    }, 200),
  });
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_RESPONSE_LEAK");
  assert.match(report.failedCases[0].nextAction, /public-api-response/);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke validates downloaded MP4 signature", async () => {
  const { fetchImpl } = createFetchMock({
    "GET /api/exports/exp_12345678/download": () => new Response(Buffer.from("not an mp4"), {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": "10",
        "x-request-id": "req_download",
      },
    }),
  });
  const report = await runYouTubeSmoke({ env: smokeEnv(), fetchImpl });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_MP4_SIGNATURE_INVALID");
  assert.match(report.failedCases[0].nextAction, /render-output/);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube smoke timeout and runtime failures produce safe summaries", async () => {
  const report = await runYouTubeSmoke({
    env: smokeEnv(),
    fetchImpl: async () => {
      throw new Error("/tmp/local/path SHORTSENGINE_YOUTUBE_SMOKE_TOKEN secret YOUTUBE_COOKIE: private-cookie");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_SMOKE_FETCH_FAILED");
  assert.equal(findSensitiveLeak(report), null);
  assert.doesNotMatch(JSON.stringify(report), /\/tmp|SHORTSENGINE_YOUTUBE_SMOKE_TOKEN|YOUTUBE_COOKIE|private-cookie|secret/);
});

function liveEnv(overrides = {}) {
  return {
    SHORTSENGINE_YOUTUBE_LIVE_E2E: "1",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED: "1",
    SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: SAFE_URL,
    SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED: "1",
    ...overrides,
  };
}

function passedDoctor() {
  return {
    ok: true,
    status: "passed",
    code: null,
    youtubeIngest: {
      enabled: true,
      mode: "local",
      downloaderConfigured: true,
      ingestAvailable: true,
      defaultDisabled: false,
    },
    ffmpeg: { ffmpeg: true, ffprobe: true },
    storage: { stagingReady: true, tmpReady: true, artifactsReady: true },
    serverHealth: { checked: false },
  };
}

function passedSmokeReport() {
  return {
    status: "passed",
    source: { sourceType: "youtube", kind: "watch", videoId: VIDEO_ID },
    target: { configured: true, protocol: "http", hostType: "local", mount: "root" },
    checks: [
      { name: "youtube_ingest_created_project", passed: true },
      { name: "youtube_ingest_created_upload", passed: true },
      { name: "youtube_render_created_export", passed: true },
      { name: "youtube_download_mp4_signature_valid", passed: true },
    ],
    steps: [
      { step: "health", status: "passed", requestIdPresent: true },
      { step: "validate", status: "passed", requestIdPresent: true, videoId: VIDEO_ID },
      { step: "ingest", status: "passed", requestIdPresent: true, projectId: "prj_12345678", uploadId: "upl_12345678" },
      { step: "generate", status: "passed", requestIdPresent: true, jobId: "job_12345678" },
      { step: "job", status: "passed", jobId: "job_12345678", exportId: "exp_12345678" },
      { step: "download", status: "passed", requestIdPresent: true, exportId: "exp_12345678", sizeBytes: 140 },
    ],
    ids: {
      projectId: "prj_12345678",
      uploadId: "upl_12345678",
      artifactId: "upl_12345678",
      jobId: "job_12345678",
      exportId: "exp_12345678",
    },
    health: {
      status: "ready",
      ffmpeg: true,
      ffprobe: true,
      youtubeIngest: {
        enabled: true,
        downloaderConfigured: true,
        ingestAvailable: true,
        mode: "local",
      },
      requestIdPresent: true,
    },
    jobLifecycle: [
      { id: "job_12345678", status: "completed", progress: 100, exportId: "exp_12345678" },
    ],
    export: { status: 200, contentType: "video/mp4", sizeBytes: 140, sha256Prefix: "abc123" },
    failedCases: [],
  };
}

test("youtube live local e2e skips safely without explicit flag", async () => {
  let serverStarted = false;
  const report = await runYouTubeLiveE2E({
    env: {},
    startServer: () => {
      serverStarted = true;
      throw new Error("should not start");
    },
    runYouTubeSmoke: async () => {
      throw new Error("should not run smoke");
    },
  });
  assert.equal(report.status, "skipped");
  assert.equal(report.checks[0].code, "YOUTUBE_LIVE_E2E_DISABLED");
  assert.equal(serverStarted, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e requires rights confirmation before server work", async () => {
  let doctorCalled = false;
  let serverStarted = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED: "0" }),
    checkYouTubeIngest: async () => {
      doctorCalled = true;
      return passedDoctor();
    },
    startServer: () => {
      serverStarted = true;
      throw new Error("should not start");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_LIVE_E2E_RIGHTS_REQUIRED");
  assert.equal(doctorCalled, false);
  assert.equal(serverStarted, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e rejects unsafe URL before doctor and server", async () => {
  let doctorCalled = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: `${SAFE_URL}&list=PL123` }),
    checkYouTubeIngest: async () => {
      doctorCalled = true;
      return passedDoctor();
    },
    startServer: () => {
      throw new Error("should not start");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_PLAYLIST_UNSUPPORTED");
  assert.equal(doctorCalled, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e fails safely when doctor is not ready", async () => {
  let serverStarted = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => ({
      ok: false,
      status: "failed",
      code: "YOUTUBE_DOWNLOADER_MISSING",
      nextAction: "install-configure-downloader-or-set-SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN",
      youtubeIngest: { enabled: true, downloaderConfigured: false, ingestAvailable: false },
    }),
    startServer: () => {
      serverStarted = true;
      throw new Error("should not start");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_DOWNLOADER_MISSING");
  assert.equal(report.doctor.code, "YOUTUBE_DOWNLOADER_MISSING");
  assert.equal(serverStarted, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e reports server bind failures as environment limitations", async () => {
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => {
      throw Object.assign(new Error("bind failed"), { code: "EPERM" });
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_LIVE_E2E_SERVER_BIND_FAILED");
  assert.match(report.failedCases[0].nextAction, /restricted-sandbox|local-port/);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e rejects invalid configured port safely", async () => {
  let serverStarted = false;
  const report = await runYouTubeLiveE2E({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_PORT: "99999" }),
    checkYouTubeIngest: async () => passedDoctor(),
    startServer: () => {
      serverStarted = true;
      throw new Error("should not start");
    },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "YOUTUBE_LIVE_E2E_PORT_INVALID");
  assert.equal(serverStarted, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e mocked success wraps smoke proof without raw URL leakage", async () => {
  let stopped = false;
  let smokeEnvSeen = null;
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [{ event: "server_started", level: "info" }] }),
    stopServer: async () => {
      stopped = true;
    },
    runYouTubeSmoke: async ({ env }) => {
      smokeEnvSeen = env;
      return passedSmokeReport();
    },
  });
  assert.equal(report.status, "passed");
  assert.equal(report.source.videoId, VIDEO_ID);
  assert.equal(report.smoke.ids.projectId, "prj_12345678");
  assert.equal(report.smoke.export.contentType, "video/mp4");
  assert.equal(stopped, true);
  assert.equal(smokeEnvSeen.SHORTSENGINE_YOUTUBE_SMOKE, "1");
  assert.equal(smokeEnvSeen.SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL, "http://127.0.0.1:4175");
  assert.doesNotMatch(JSON.stringify(report), new RegExp(SAFE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(findSensitiveLeak(report), null);
});

test("youtube live local e2e report writer creates stable safe latest report", async () => {
  const report = await runYouTubeLiveE2E({
    env: liveEnv(),
    checkYouTubeIngest: async () => passedDoctor(),
    getFreePort: async () => 4175,
    startServer: () => ({ child: { exitCode: null, signalCode: null }, events: [] }),
    stopServer: async () => {},
    runYouTubeSmoke: async () => passedSmokeReport(),
  });
  const outputDir = mkdtempSync(join(tmpdir(), "shortsengine-youtube-live-e2e-"));
  const written = writeYouTubeLiveE2EReport(report, outputDir);
  const latestFile = join(outputDir, "youtube-live-e2e-latest.json");
  assert.equal(existsSync(latestFile), true);
  assert.equal(written.latestPath.endsWith("youtube-live-e2e-latest.json"), true);
  const persisted = JSON.parse(readFileSync(latestFile, "utf8"));
  assert.equal(persisted.status, "passed");
  assert.equal(findSensitiveLeak(persisted), null);
});
