import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FIXTURE_PATH,
  ensureDemoFixture,
  fixtureMetadata,
  relativeFromRoot,
} from "./create-fixture.mjs";
import { findSensitiveLeak, hasSensitiveLeak, safeError } from "./report-safety.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = resolve(ROOT_DIR, "demo", "results");
const DEFAULT_TIMEOUT_MS = 90_000;
const JOB_TIMEOUT_MS = 75_000;
const POLL_INTERVAL_MS = 500;

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function safeJobSnapshot(job) {
  if (!job || typeof job !== "object") return null;
  return {
    id: job.id,
    projectId: job.projectId,
    uploadId: job.uploadId,
    status: job.status,
    progress: Number.isFinite(Number(job.progress)) ? Number(job.progress) : 0,
    step: job.step || null,
    exportId: job.exportId || null,
    error: safeError(job.error),
  };
}

function createMultipartBody(parts) {
  const boundary = `----shortsengine-demo-${randomUUID()}`;
  const chunks = [];
  for (const part of parts) {
    const headers = [`--${boundary}`];
    if (part.fileName) {
      headers.push(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.fileName}"`,
        `Content-Type: ${part.mimeType || "application/octet-stream"}`,
      );
    } else {
      headers.push(`Content-Disposition: form-data; name="${part.name}"`);
    }
    chunks.push(Buffer.from(`${headers.join("\r\n")}\r\n\r\n`, "utf8"));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value || ""), "utf8"));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json().catch(() => null);
  return {
    ok: response.ok && payload && payload.ok === true,
    status: response.status,
    payload,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

async function requestDownload(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    sizeBytes: buffer.length,
    sha256: response.ok ? createHash("sha256").update(buffer).digest("hex") : null,
  };
}

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close(() => {
        if (port) resolvePort(port);
        else rejectPort(new Error("Could not allocate local port."));
      });
    });
  });
}

function startServer(port) {
  const child = spawn(process.execPath, ["server/app.cjs"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      MATCHCUTS_TRANSCRIPTION_PROVIDER: "mock",
      MATCHCUTS_PERSISTENCE_ADAPTER: "sqlite",
      MATCHCUTS_SQLITE_FILE: "demo-smoke.sqlite",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events = [];
  const collect = (chunk, stream) => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      let event = { stream, level: stream === "stderr" ? "error" : "info" };
      try {
        const parsed = JSON.parse(line);
        event = {
          stream,
          level: parsed.level || event.level,
          event: parsed.event || null,
          code: parsed.code || null,
          service: parsed.service || null,
        };
      } catch {
        event.event = "server_output";
      }
      events.push(event);
      if (events.length > 30) events.shift();
    }
  };
  child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
  child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
  return { child, events };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveStop) => child.once("exit", resolveStop)),
    delay(2500).then(() => {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    }),
  ]);
}

async function waitForHealth(baseUrl, timeoutMs = 15_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await requestJson(baseUrl, "/health");
      if (last.ok) return last;
    } catch (error) {
      last = { ok: false, error: safeError(error) };
    }
    await delay(300);
  }
  return last || { ok: false, error: { code: "HEALTH_TIMEOUT", message: "Health endpoint did not respond." } };
}

async function uploadFixture(baseUrl, fixturePath) {
  const multipart = createMultipartBody([
    { name: "title", value: "ShortsEngine Demo Derby" },
    {
      name: "video",
      fileName: "shortsengine-demo-source.mp4",
      mimeType: "video/mp4",
      value: readFileSync(fixturePath),
    },
  ]);
  return requestJson(baseUrl, "/api/uploads", {
    method: "POST",
    headers: {
      "content-type": multipart.contentType,
      "content-length": String(multipart.body.length),
    },
    body: multipart.body,
  });
}

async function uploadInvalidFixture(baseUrl) {
  const multipart = createMultipartBody([
    {
      name: "video",
      fileName: "../unsafe.mp4",
      mimeType: "video/mp4",
      value: Buffer.from("not-a-real-video", "utf8"),
    },
  ]);
  return requestJson(baseUrl, "/api/uploads", {
    method: "POST",
    headers: {
      "content-type": multipart.contentType,
      "content-length": String(multipart.body.length),
    },
    body: multipart.body,
  });
}

async function startGenerate(baseUrl, projectId) {
  return requestJson(baseUrl, `/api/projects/${projectId}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "ShortsEngine Demo Derby",
      preset: "hype",
      language: "English",
      rightsConfirmed: true,
      idempotencyKey: `demo_smoke_${Date.now()}`,
    }),
  });
}

async function pollJob(baseUrl, jobId, timeoutMs = JOB_TIMEOUT_MS) {
  const started = Date.now();
  const lifecycle = [];
  let current = null;
  while (Date.now() - started < timeoutMs) {
    const response = await requestJson(baseUrl, `/api/jobs/${jobId}`);
    current = response.payload && response.payload.data ? response.payload.data.job : null;
    if (current) lifecycle.push(safeJobSnapshot(current));
    if (current && ["completed", "failed", "cancelled"].includes(current.status)) {
      return { job: current, lifecycle };
    }
    await delay(POLL_INTERVAL_MS);
  }
  return { job: current, lifecycle, timeout: true };
}

function addCheck(checks, name, passed, details = {}) {
  checks.push({ name, passed: Boolean(passed), ...details });
}

function atomicWriteJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function buildReport({
  baseUrl,
  checks,
  durationMs,
  exportResult,
  failedCases,
  fixture,
  health,
  jobLifecycle,
  serverEvents,
  status,
}) {
  const report = {
    timestamp: nowIso(),
    status,
    durationMs,
    fixture,
    server: {
      origin: baseUrl.replace(/:\d+$/, ":<port>"),
      healthStatus: health?.payload?.data?.status || null,
      ffmpeg: Boolean(health?.payload?.data?.ffmpeg?.ffmpeg),
      ffprobe: Boolean(health?.payload?.data?.ffmpeg?.ffprobe),
      transcriptionProvider: health?.payload?.data?.transcription?.activeProvider || null,
    },
    checks,
    jobLifecycle,
    export: exportResult,
    failedCases,
    serverEvents,
  };
  const leak = findSensitiveLeak(report);
  if (leak) {
    return {
      timestamp: report.timestamp,
      status: "failed",
      durationMs,
      fixture,
      checks: [{ name: "report_no_sensitive_leaks", passed: false, code: "REPORT_LEAK_GUARD", leakCode: leak.code, leakPath: leak.path }],
      failedCases: [{ name: "report_no_sensitive_leaks", code: "REPORT_LEAK_GUARD", leakCode: leak.code, leakPath: leak.path }],
    };
  }
  return report;
}

async function runDemoSmoke(options = {}) {
  const started = Date.now();
  const checks = [];
  const failedCases = [];
  const serverEvents = [];
  let server = null;
  let baseUrl = null;
  let health = null;
  let jobLifecycle = [];
  let exportResult = null;
  const fixtureResult = ensureDemoFixture({ outputPath: options.fixturePath || DEFAULT_FIXTURE_PATH });
  addCheck(checks, "demo_fixture_ready", fixtureResult.ok, { code: fixtureResult.error?.code || null });
  if (!fixtureResult.ok) {
    failedCases.push({ name: "demo_fixture_ready", code: fixtureResult.error?.code || "FIXTURE_NOT_READY" });
    return buildReport({
      baseUrl: "http://127.0.0.1:<port>",
      checks,
      durationMs: Date.now() - started,
      exportResult,
      failedCases,
      fixture: fixtureResult.fixture,
      health,
      jobLifecycle,
      serverEvents,
      status: "failed",
    });
  }
  try {
    const port = Number(options.port || process.env.DEMO_SMOKE_PORT) || await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = startServer(port);
    serverEvents.push(...server.events);

    health = await waitForHealth(baseUrl);
    addCheck(checks, "server_health_ready", health && health.ok && health.payload?.data?.status === "ready", {
      status: health?.payload?.data?.status || null,
    });
    addCheck(checks, "health_no_sensitive_leaks", !hasSensitiveLeak(health));

    const invalidUpload = await uploadInvalidFixture(baseUrl);
    addCheck(checks, "invalid_upload_rejected", invalidUpload.status >= 400 && invalidUpload.payload?.ok === false, {
      status: invalidUpload.status,
      code: invalidUpload.payload?.error?.code || null,
    });
    addCheck(checks, "invalid_upload_safe_error", !hasSensitiveLeak(invalidUpload));

    const earlyDownload = await requestJson(baseUrl, "/api/exports/exp_12345678/download");
    addCheck(checks, "download_before_export_rejected", earlyDownload.status === 404 && earlyDownload.payload?.ok === false, {
      code: earlyDownload.payload?.error?.code || null,
    });

    const upload = await uploadFixture(baseUrl, options.fixturePath || DEFAULT_FIXTURE_PATH);
    const projectId = upload.payload?.data?.project?.id;
    const uploadId = upload.payload?.data?.upload?.id;
    addCheck(checks, "valid_fixture_upload_accepted", upload.ok && Boolean(projectId) && Boolean(uploadId), {
      status: upload.status,
      projectId,
      uploadId,
    });
    addCheck(checks, "upload_response_no_sensitive_leaks", !hasSensitiveLeak(upload));

    const generate = projectId ? await startGenerate(baseUrl, projectId) : null;
    const jobId = generate?.payload?.data?.job?.id;
    addCheck(checks, "generate_job_started", Boolean(generate?.ok && jobId), {
      status: generate?.status || null,
      jobId,
    });

    const polled = jobId ? await pollJob(baseUrl, jobId, options.jobTimeoutMs || JOB_TIMEOUT_MS) : { lifecycle: [] };
    jobLifecycle = polled.lifecycle;
    const finalJob = polled.job;
    addCheck(checks, "job_lifecycle_terminal", Boolean(finalJob && ["completed", "failed", "cancelled"].includes(finalJob.status)), {
      status: finalJob?.status || null,
      timeout: Boolean(polled.timeout),
    });
    addCheck(checks, "job_completed_with_export", Boolean(finalJob && finalJob.status === "completed" && finalJob.exportId), {
      exportId: finalJob?.exportId || null,
      errorCode: finalJob?.error?.code || null,
    });
    addCheck(checks, "job_response_no_sensitive_leaks", !hasSensitiveLeak(jobLifecycle));

    if (finalJob && finalJob.status === "completed" && finalJob.exportId) {
      const signed = await requestJson(baseUrl, `/api/exports/${finalJob.exportId}/download-url`);
      addCheck(checks, "download_url_created_after_success", signed.ok && Boolean(signed.payload?.data?.downloadUrl), {
        status: signed.status,
      });
      addCheck(checks, "download_url_response_no_sensitive_leaks", !hasSensitiveLeak(signed, { allowSignedDownloadToken: true }));
      const download = await requestDownload(baseUrl, `/api/exports/${finalJob.exportId}/download`);
      exportResult = {
        status: download.status,
        contentType: download.contentType,
        sizeBytes: download.sizeBytes,
        sha256: download.sha256,
      };
      addCheck(checks, "download_returns_rendered_video", download.ok && download.contentType.includes("video/mp4") && download.sizeBytes > 0, {
        status: download.status,
        sizeBytes: download.sizeBytes,
      });
    }
  } catch (error) {
    failedCases.push({ name: "demo_smoke_unexpected", ...safeError(error) });
  } finally {
    if (server) {
      serverEvents.push(...server.events);
      await stopServer(server.child);
    }
  }
  for (const check of checks) {
    if (!check.passed) failedCases.push({ name: check.name, code: check.code || "CHECK_FAILED" });
  }
  const status = failedCases.length ? "failed" : "passed";
  return buildReport({
    baseUrl: baseUrl || "http://127.0.0.1:<port>",
    checks,
    durationMs: Date.now() - started,
    exportResult,
    failedCases,
    fixture: fixtureMetadata(options.fixturePath || DEFAULT_FIXTURE_PATH),
    health,
    jobLifecycle,
    serverEvents,
    status,
  });
}

function writeDemoReport(report, outputDir = RESULTS_DIR) {
  mkdirSync(outputDir, { recursive: true });
  const stamp = report.timestamp.replace(/[:.]/g, "-");
  const reportPath = resolve(outputDir, `demo-smoke-${stamp}.json`);
  atomicWriteJson(reportPath, report);
  atomicWriteJson(resolve(outputDir, "latest.json"), report);
  return {
    reportPath: relativeFromRoot(reportPath),
    latestPath: relativeFromRoot(resolve(outputDir, "latest.json")),
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  const timeout = Number(process.env.DEMO_SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  let timeoutId;
  const timeoutPromise = new Promise((resolveTimeout) => {
    timeoutId = setTimeout(() => {
      resolveTimeout({
        timestamp: nowIso(),
        status: "failed",
        durationMs: timeout,
        fixture: fixtureMetadata(),
        checks: [{ name: "demo_smoke_timeout", passed: false, code: "DEMO_SMOKE_TIMEOUT" }],
        jobLifecycle: [],
        export: null,
        failedCases: [{ name: "demo_smoke_timeout", code: "DEMO_SMOKE_TIMEOUT" }],
        serverEvents: [],
      });
    }, timeout);
    if (timeoutId && typeof timeoutId.unref === "function") timeoutId.unref();
  });
  const report = await Promise.race([runDemoSmoke(), timeoutPromise]);
  if (timeoutId) clearTimeout(timeoutId);
  const written = writeDemoReport(report);
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, failedCases: report.failedCases, ...written }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

export {
  DEFAULT_TIMEOUT_MS,
  JOB_TIMEOUT_MS,
  RESULTS_DIR,
  addCheck,
  buildReport,
  createMultipartBody,
  hasSensitiveLeak,
  pollJob,
  runDemoSmoke,
  safeJobSnapshot,
  writeDemoReport,
};
