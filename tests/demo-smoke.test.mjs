import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildFfmpegFixtureArgs,
  ensureDemoFixture,
  fixtureMetadata,
} from "../demo/create-fixture.mjs";
import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  buildReport,
  createMultipartBody,
  hasSensitiveLeak,
  safeJobSnapshot,
  writeDemoReport,
} from "../demo/run-smoke.mjs";

test("demo fixture helpers are deterministic and safe to reuse", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "shortsengine-fixture-"));
  const fixturePath = join(tempDir, "fixture.mp4");
  writeFileSync(fixturePath, Buffer.from("fixture-bytes"));

  const args = buildFfmpegFixtureArgs(fixturePath, 9);
  assert.ok(args.includes("testsrc2=size=1280x720:rate=30:duration=9"));
  assert.ok(args.includes("sine=frequency=880:sample_rate=44100:duration=9"));
  assert.equal(args.at(-1), fixturePath);

  const result = ensureDemoFixture({ outputPath: fixturePath, ffmpegBin: "definitely-not-ffmpeg" });
  assert.equal(result.ok, true);
  assert.equal(result.generated, false);
  assert.equal(result.fixture.exists, true);

  const metadata = fixtureMetadata(fixturePath);
  assert.equal(metadata.exists, true);
  assert.equal(metadata.sizeBytes, Buffer.byteLength("fixture-bytes"));
  assert.equal(metadata.sha256.length, 64);
  assert.doesNotMatch(JSON.stringify(metadata), /\/Users|\/private|storageKey/);
});

test("demo multipart helper builds bounded upload payloads", () => {
  const multipart = createMultipartBody([
    { name: "title", value: "ShortsEngine Demo" },
    { name: "video", fileName: "clip.mp4", mimeType: "video/mp4", value: Buffer.from("video") },
  ]);
  const text = multipart.body.toString("utf8");
  assert.match(multipart.contentType, /^multipart\/form-data; boundary=----shortsengine-demo-/);
  assert.match(text, /name="title"/);
  assert.match(text, /filename="clip\.mp4"/);
  assert.match(text, /Content-Type: video\/mp4/);
});

test("demo smoke snapshots and reports do not expose internals", () => {
  const job = safeJobSnapshot({
    id: "job_demo",
    projectId: "prj_demo",
    uploadId: "upl_demo",
    status: "failed",
    progress: 48,
    step: "render_short",
    outputPath: "/Users/example/data/renders/private.mp4",
    error: {
      code: "RENDER_FAILED",
      message: "The video render failed.",
      details: { stderr: "/Users/example OPENAI_API_KEY=secret" },
    },
  });
  assert.deepEqual(job.error, { code: "RENDER_FAILED", message: "The video render failed." });
  assert.doesNotMatch(JSON.stringify(job), /\/Users|OPENAI_API_KEY|outputPath/);

  const cleanReport = buildReport({
    baseUrl: "http://127.0.0.1:4123",
    checks: [{ name: "server_health_ready", passed: true }],
    durationMs: 123,
    exportResult: { status: 200, contentType: "video/mp4", sizeBytes: 100 },
    failedCases: [],
    fixture: { exists: true, fileName: "shortsengine-demo-source.mp4", relativePath: "demo/fixtures/shortsengine-demo-source.mp4" },
    health: { payload: { data: { status: "ready", ffmpeg: { ffmpeg: true, ffprobe: true }, transcription: { activeProvider: "mock" } } } },
    jobLifecycle: [job],
    serverEvents: [{ event: "server_listening" }],
    status: "passed",
  });
  assert.equal(cleanReport.status, "passed");
  assert.equal(cleanReport.server.origin, "http://127.0.0.1:<port>");
  assert.equal(hasSensitiveLeak(cleanReport), false);
  assert.equal(hasSensitiveLeak({ payload: { data: { downloadUrl: "/api/artifacts/download?token=opaque" } } }), false);

  const leakedReport = buildReport({
    baseUrl: "http://127.0.0.1:4123",
    checks: [],
    durationMs: 1,
    exportResult: null,
    failedCases: [],
    fixture: { relativePath: "/Users/example/private.mp4" },
    health: null,
    jobLifecycle: [],
    serverEvents: [],
    status: "passed",
  });
  assert.equal(leakedReport.status, "failed");
  assert.equal(leakedReport.failedCases[0].code, "REPORT_LEAK_GUARD");
  assert.equal(leakedReport.failedCases[0].leakCode, "LOCAL_PATH");
  assert.equal(leakedReport.failedCases[0].leakPath, "$.fixture.relativePath");
});

test("demo report leak guard catches unsafe keys, paths and tokens", () => {
  const signedToken = "adt_11111111-1111-4111-8111-111111111111_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  assert.equal(hasSensitiveLeak({ artifact: { storageKey: "exports/private.mp4" } }), true);
  assert.deepEqual(findSensitiveLeak({ artifact: { storageKey: "exports/private.mp4" } }), {
    code: "UNSAFE_KEY",
    path: "$.artifact.storageKey",
  });
  assert.equal(hasSensitiveLeak({ error: { message: "/Users/example/render.mp4 failed" } }), true);
  assert.equal(hasSensitiveLeak({ provider: { stderr: "OPENAI_API_KEY=secret" } }), true);
  assert.equal(hasSensitiveLeak({ provider: { message: "SHORTSENGINE_YOUTUBE_SMOKE_TOKEN secret-value" } }), true);
  assert.equal(hasSensitiveLeak({ provider: { message: "YOUTUBE_COOKIE: private-cookie-value" } }), true);
  assert.equal(hasSensitiveLeak({ provider: { message: "YT_DLP_COOKIES=private-cookie-value" } }), true);
  assert.equal(hasSensitiveLeak({ provider: { message: "VISITOR_INFO1_LIVE=private-cookie-value" } }), true);
  assert.equal(hasSensitiveLeak({ deploy: { serviceId: "srv-realstaging123" } }), true);
  assert.equal(hasSensitiveLeak({ deploy: { renderService: "srv-realstaging123" } }), true);
  assert.equal(hasSensitiveLeak({ github: { token: "ghp_abcdefghijklmnopqrstuvwx1234567890" } }), true);
  assert.equal(hasSensitiveLeak({ github: { message: "ghs_abcdefghijklmnopqrstuvwx1234567890" } }), true);
  assert.equal(hasSensitiveLeak({ gitlab: { message: "glpat-abcdefghijklmnopqrstuvwx123456" } }), true);
  assert.equal(hasSensitiveLeak({ slack: { message: "xoxb-1234567890-private-token" } }), true);
  assert.equal(hasSensitiveLeak({ pem: { message: "-----BEGIN PRIVATE KEY-----" } }), true);
  assert.deepEqual(findSensitiveLeak({ youtube: { cookies: "SID=private-cookie-value" } }), {
    code: "UNSAFE_KEY",
    path: "$.youtube.cookies",
  });
  assert.deepEqual(findSensitiveLeak({ logs: { rawLogs: "provider output" } }), {
    code: "UNSAFE_KEY",
    path: "$.logs.rawLogs",
  });
  assert.deepEqual(findSensitiveLeak({ deploy: { serviceId: "srv-realstaging123" } }), {
    code: "UNSAFE_KEY",
    path: "$.deploy.serviceId",
  });
  assert.deepEqual(findSensitiveLeak({ deploy: { renderService: "srv-realstaging123" } }), {
    code: "RENDER_SERVICE_ID",
    path: "$.deploy.renderService",
  });
  assert.equal(hasSensitiveLeak({ downloadUrl: `/api/artifacts/download?token=${signedToken}` }), true);
  assert.equal(hasSensitiveLeak({ downloadUrl: `/api/artifacts/download?token=${signedToken}` }, { allowSignedDownloadToken: true }), false);
  assert.equal(hasSensitiveLeak({ health: { credentialsConfigured: false, activeSignedTokens: 0 } }), false);
  assert.equal(hasSensitiveLeak({ staging: { serviceIdConfigured: true, deployTokenConfigured: false } }), false);
  assert.equal(hasSensitiveLeak({ relativePath: "demo/fixtures/shortsengine-demo-source.mp4", latestPath: "demo/results/latest.json" }), false);
});

test("demo report writer creates latest report and timestamped report", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "shortsengine-demo-results-"));
  const report = {
    timestamp: "2026-06-15T16:30:00.000Z",
    status: "passed",
    checks: [],
    failedCases: [],
  };
  const written = writeDemoReport(report, tempDir);
  assert.match(written.reportPath, /demo-smoke-2026-06-15T16-30-00-000Z\.json$/);
  const latest = JSON.parse(readFileSync(join(tempDir, "latest.json"), "utf8"));
  assert.equal(latest.status, "passed");
});
