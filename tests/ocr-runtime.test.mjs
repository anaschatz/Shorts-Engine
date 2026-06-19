import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  OCR_ARTIFACTS_RELATIVE_DIR,
  cleanupOcrQaArtifacts,
  normalizeRunId,
  resolveOcrArtifactRunDir,
  runOcrSmoke,
} from "../demo/run-ocr-smoke.mjs";
import { checkOcrRuntime } from "../tools/release/check-ocr-runtime.mjs";

function fakeStorageHealth() {
  return {
    staging: { exists: true, readable: true, writable: true },
    tmp: { exists: true, readable: true, writable: true },
  };
}

function fakeFrameHealth() {
  return {
    ffmpegAvailable: true,
    fallbackMode: "mock",
    maxFrames: 10,
    maxDimension: 640,
  };
}

function createFixtureFile() {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-ocr-smoke-"));
  const fixturePath = join(dir, "fixture.mp4");
  writeFileSync(fixturePath, "fake-video", "utf8");
  return fixturePath;
}

function fakeEnsureFixture({ outputPath }) {
  return {
    ok: true,
    generated: false,
    fixture: {
      exists: true,
      fileName: "fixture.mp4",
      relativePath: "demo/fixtures/shortsengine-demo-source.mp4",
      sizeBytes: 10,
      sha256: "0".repeat(64),
      durationSeconds: 9,
    },
    outputPath,
  };
}

async function fakeFfmpegRunner(args) {
  const outputPath = args[args.length - 1];
  mkdirSync(outputPath.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(outputPath, "fake-frame-or-crop", "utf8");
}

test("OCR doctor passes safely with deterministic fallback defaults", () => {
  const result = checkOcrRuntime({
    nowMs: Date.parse("2026-06-19T12:00:00.000Z"),
    scoreboardConfig: {
      enabled: false,
      provider: "deterministic",
      bin: "tesseract",
      timeoutMs: 10000,
    },
    storageHealth: fakeStorageHealth,
    frameExtractionHealth: fakeFrameHealth,
    toolCommandChecker: () => true,
  });

  assert.equal(result.passed, true);
  assert.equal(result.status, "degraded");
  assert.equal(result.runtime.localOcrEnabled, false);
  assert.equal(result.runtime.runtimeChecked, false);
  assert.equal(findSensitiveLeak(result), null);
});

test("OCR doctor fails closed when local OCR is enabled but runtime is missing", () => {
  const result = checkOcrRuntime({
    nowMs: Date.parse("2026-06-19T12:00:00.000Z"),
    scoreboardConfig: {
      enabled: true,
      provider: "local",
      bin: "tesseract",
      timeoutMs: 10000,
    },
    storageHealth: fakeStorageHealth,
    frameExtractionHealth: fakeFrameHealth,
    ocrCommandChecker: () => false,
    toolCommandChecker: () => true,
  });

  assert.equal(result.passed, false);
  assert.equal(result.status, "failed");
  assert.equal(result.failedCases[0].code, "OCR_RUNTIME_MISSING");
  assert.equal(findSensitiveLeak(result), null);
});

test("OCR smoke writes a safe skipped proof with fallback defaults", async () => {
  const fixturePath = createFixtureFile();
  const resultsDir = mkdtempSync(join(tmpdir(), "shortsengine-ocr-results-"));

  const result = await runOcrSmoke({
    nowMs: Date.parse("2026-06-19T12:30:00.000Z"),
    fixturePath,
    resultsDir,
    ensureFixture: fakeEnsureFixture,
    ffmpegRunner: fakeFfmpegRunner,
    scoreboardConfig: {
      enabled: false,
      provider: "deterministic",
      bin: "tesseract",
      timeoutMs: 10000,
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(result.skipped, true);
  assert.equal(result.runtime.networkRequired, false);
  assert.equal(result.frameExtraction.summary.frameCount, 3);
  assert.equal(result.qa.cropArtifacts.enabled, false);
  assert.equal(result.cropCount, 0);
  assert.deepEqual(result.cropArtifacts, []);
  assert.equal(result.latestPath, "demo/results/ocr-latest.json");
  assert.equal(findSensitiveLeak(result), null);
});

test("OCR smoke writes opt-in crop QA artifacts with safe relative refs", async () => {
  const fixturePath = createFixtureFile();
  const runId = `qa-artifacts-${Date.now()}`;
  const safeRunId = normalizeRunId(runId);

  try {
    const result = await runOcrSmoke({
      nowMs: Date.parse("2026-06-19T12:35:00.000Z"),
      runId,
      qaArtifactsEnabled: true,
      qaArtifactRetentionMax: 50,
      fixturePath,
      ensureFixture: fakeEnsureFixture,
      ffmpegRunner: fakeFfmpegRunner,
      qaArtifactFfmpegRunner: fakeFfmpegRunner,
      scoreboardConfig: {
        enabled: false,
        provider: "deterministic",
        bin: "tesseract",
        timeoutMs: 10000,
      },
    });

    assert.equal(result.status, "passed");
    assert.equal(result.qa.cropArtifacts.enabled, true);
    assert.equal(result.qaArtifactDirectory, `${OCR_ARTIFACTS_RELATIVE_DIR}/${safeRunId}`);
    assert.equal(result.cropArtifacts.length > 0, true);
    assert.equal(result.cropCount, result.cropArtifacts.length);
    for (const artifact of result.cropArtifacts) {
      assert.match(artifact.relativePath, new RegExp(`^${OCR_ARTIFACTS_RELATIVE_DIR}/${safeRunId}/ocr-crop-`));
      assert.equal(existsSync(resolve(process.cwd(), artifact.relativePath)), true);
      assert.doesNotMatch(artifact.relativePath, /\.\.|\\/);
    }
    assert.equal(findSensitiveLeak(result), null);
  } finally {
    rmSync(resolve(process.cwd(), OCR_ARTIFACTS_RELATIVE_DIR, safeRunId), { recursive: true, force: true });
  }
});

test("OCR smoke rejects unsafe artifact run ids", async () => {
  await assert.rejects(
    runOcrSmoke({
      runId: "../bad",
      qaArtifactsEnabled: true,
      fixturePath: createFixtureFile(),
      ensureFixture: fakeEnsureFixture,
      ffmpegRunner: fakeFfmpegRunner,
      scoreboardConfig: {
        enabled: false,
        provider: "deterministic",
        bin: "tesseract",
        timeoutMs: 10000,
      },
    }),
    (error) => error.code === "OCR_QA_ARTIFACT_PATH_UNSAFE",
  );
});

test("OCR QA artifact cleanup deletes only managed run directories", () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "shortsengine-ocr-artifact-cleanup-"));
  const current = resolveOcrArtifactRunDir({ resultsDir, runId: "current" });
  const stale = resolveOcrArtifactRunDir({ resultsDir, runId: "stale" });
  const unmanaged = resolve(current.root, "manual-not-managed");
  mkdirSync(current.runDir, { recursive: true });
  mkdirSync(stale.runDir, { recursive: true });
  mkdirSync(unmanaged, { recursive: true });
  writeFileSync(join(current.runDir, "crop.png"), "current", "utf8");
  writeFileSync(join(stale.runDir, "crop.png"), "stale", "utf8");
  writeFileSync(join(unmanaged, "keep.png"), "keep", "utf8");

  const cleanup = cleanupOcrQaArtifacts({
    resultsDir,
    retentionMax: 1,
    currentRunId: "current",
  });

  assert.equal(cleanup.removedCount, 1);
  assert.equal(existsSync(current.runDir), true);
  assert.equal(existsSync(stale.runDir), false);
  assert.equal(existsSync(unmanaged), true);
});

test("OCR smoke validates local runtime output without leaking command text", async () => {
  const fixturePath = createFixtureFile();
  const resultsDir = mkdtempSync(join(tmpdir(), "shortsengine-ocr-results-"));
  let call = 0;

  const result = await runOcrSmoke({
    nowMs: Date.parse("2026-06-19T12:45:00.000Z"),
    fixturePath,
    resultsDir,
    ensureFixture: fakeEnsureFixture,
    ffmpegRunner: fakeFfmpegRunner,
    ocrCropFfmpegRunner: fakeFfmpegRunner,
    ocrCommandChecker: () => true,
    ocrRunner: async () => {
      call += 1;
      if (call <= 3) return { stdout: "HOME 0-0 AWAY 12:00" };
      return { stdout: "HOME 1-0 AWAY 23:00" };
    },
    scoreboardConfig: {
      enabled: true,
      provider: "local",
      bin: "tesseract",
      timeoutMs: 10000,
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(result.skipped, false);
  assert.equal(result.scoreboardOcr.summary.scoreChangeCount >= 1, true);
  assert.equal(result.qa.rows.some((row) => row.status === "score_changed"), true);
  assert.doesNotMatch(JSON.stringify(result), /HOME|AWAY|stdout|stderr|\/Users|token|secret/i);
  assert.equal(findSensitiveLeak(result), null);
});

test("OCR smoke fails closed when local runtime is explicitly requested but missing", async () => {
  const fixturePath = createFixtureFile();
  const resultsDir = mkdtempSync(join(tmpdir(), "shortsengine-ocr-results-"));

  const result = await runOcrSmoke({
    nowMs: Date.parse("2026-06-19T13:00:00.000Z"),
    fixturePath,
    resultsDir,
    ensureFixture: fakeEnsureFixture,
    ffmpegRunner: fakeFfmpegRunner,
    scoreboardConfig: {
      enabled: true,
      provider: "local",
      bin: "tesseract",
      timeoutMs: 10000,
    },
    ocrCommandChecker: () => false,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.passed, false);
  assert.equal(result.failedCases[0].code, "OCR_RUNTIME_MISSING");
  assert.equal(findSensitiveLeak(result), null);
});
