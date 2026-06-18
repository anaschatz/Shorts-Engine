import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import { runOcrSmoke } from "../demo/run-ocr-smoke.mjs";
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
  assert.equal(result.latestPath, "demo/results/ocr-latest.json");
  assert.equal(findSensitiveLeak(result), null);
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
