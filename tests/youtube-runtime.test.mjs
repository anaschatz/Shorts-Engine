import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import { runYouTubeSmoke, writeYouTubeSmokeReport } from "../demo/run-youtube-smoke.mjs";
import { checkYouTubeIngest } from "../tools/release/check-youtube-ingest.mjs";

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
  assert.equal(findSensitiveLeak(result), null);
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
  assert.deepEqual(calls.map((call) => call.key), [
    "GET /health",
    "POST /api/youtube/validate",
    "POST /api/youtube/ingest",
    "POST /api/projects/prj_12345678/generate",
    "GET /api/jobs/job_12345678",
    "GET /api/exports/exp_12345678/download",
  ]);
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
