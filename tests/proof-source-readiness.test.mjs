import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  checkProofSourceReadiness,
  writeProofSourceReadinessReport,
} from "../demo/check-proof-source-readiness.mjs";

const VIDEO_ID = "dQw4w9WgXcQ";
const SAFE_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

function mp4Buffer(extraBytes = 64) {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.alloc(extraBytes),
  ]);
}

function tempMp4() {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-proof-readiness-"));
  const file = join(dir, "source.mp4");
  writeFileSync(file, mp4Buffer());
  return { dir, file };
}

function localEnv(file, overrides = {}) {
  return {
    SHORTSENGINE_LOCAL_PROOF_SOURCE: file,
    SHORTSENGINE_LOCAL_PROOF_RIGHTS_CONFIRMED: "1",
    SHORTSENGINE_LOCAL_PROOF_EXPECTED_COUNTED_GOALS: "3",
    SHORTSENGINE_LOCAL_PROOF_SOURCE_LABEL: "authorized-local-test",
    ...overrides,
  };
}

function liveEnv(overrides = {}) {
  return {
    SHORTSENGINE_YOUTUBE_LIVE_E2E: "1",
    SHORTSENGINE_YOUTUBE_INGEST_ENABLED: "1",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED: "1",
    SHORTSENGINE_YOUTUBE_LIVE_E2E_URL: SAFE_URL,
    SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS: VIDEO_ID,
    SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS: "5",
    ...overrides,
  };
}

function readyDoctor() {
  return {
    ok: true,
    status: "passed",
    code: null,
    youtubeIngest: {
      enabled: true,
      ingestAvailable: true,
      downloaderConfigured: true,
      sourceCache: { configured: false },
    },
    ffmpeg: {
      ffmpeg: true,
      ffprobe: true,
    },
    storage: {
      stagingReady: true,
      tmpReady: true,
      artifactsReady: true,
    },
  };
}

test("proof source readiness skips safely when no source is configured", async () => {
  let doctorCalls = 0;
  const report = await checkProofSourceReadiness({
    env: {},
    nowMs: Date.parse("2026-07-04T12:00:00.000Z"),
    checkYouTubeIngestImpl: async () => {
      doctorCalls += 1;
      return readyDoctor();
    },
  });

  assert.equal(report.status, "skipped");
  assert.equal(report.skipped, true);
  assert.equal(report.outputPolicy.networkCallsStarted, false);
  assert.equal(report.outputPolicy.downloaderStarted, false);
  assert.equal(report.outputPolicy.mp4Produced, false);
  assert.equal(doctorCalls, 0);
  assert.equal(findSensitiveLeak(report), null);
});

test("proof source readiness accepts a rights-cleared local mp4 without leaking local paths", async () => {
  const { dir, file } = tempMp4();
  try {
    const report = await checkProofSourceReadiness({ env: localEnv(file) });

    assert.equal(report.status, "ready");
    assert.equal(report.passed, true);
    assert.equal(report.localProof.canRun, true);
    assert.equal(report.localProof.expectedCountedGoals, 3);
    assert.equal(report.localProof.source.fileName, "source.mp4");
    assert.match(report.localProof.nextCommand, /proof:local-video/);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proof source readiness fails local proof before exposing source details when rights are missing", async () => {
  const { dir, file } = tempMp4();
  try {
    const report = await checkProofSourceReadiness({
      env: localEnv(file, { SHORTSENGINE_LOCAL_PROOF_RIGHTS_CONFIRMED: "0" }),
    });

    assert.equal(report.status, "failed");
    assert.equal(report.localProof.code, "LOCAL_VIDEO_PROOF_RIGHTS_REQUIRED");
    assert.equal(report.localProof.source, undefined);
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proof source readiness requires known counted goal count for live YouTube proof", async () => {
  let doctorCalls = 0;
  const report = await checkProofSourceReadiness({
    env: liveEnv({ SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS: "" }),
    checkYouTubeIngestImpl: async () => {
      doctorCalls += 1;
      return readyDoctor();
    },
  });

  assert.equal(report.status, "failed");
  assert.equal(report.youtubeProof.code, "PROOF_YOUTUBE_EXPECTED_COUNT_REQUIRED");
  assert.equal(report.youtubeProof.canRun, false);
  assert.equal(doctorCalls, 0);
  assert.equal(findSensitiveLeak(report), null);
});

test("proof source readiness accepts live YouTube proof only after source and runtime gates are ready", async () => {
  let doctorCalls = 0;
  const report = await checkProofSourceReadiness({
    env: liveEnv(),
    checkYouTubeIngestImpl: async () => {
      doctorCalls += 1;
      return readyDoctor();
    },
  });

  assert.equal(report.status, "ready");
  assert.equal(report.youtubeProof.canRun, true);
  assert.equal(report.youtubeProof.expectedCountedGoals, 5);
  assert.equal(report.youtubeProof.source.videoId, VIDEO_ID);
  assert.equal(report.youtubeProof.runtime.ingestAvailable, true);
  assert.equal(doctorCalls, 1);
  assert.equal(findSensitiveLeak(report), null);
});

test("proof source readiness surfaces safe YouTube runtime blockers", async () => {
  const report = await checkProofSourceReadiness({
    env: liveEnv(),
    checkYouTubeIngestImpl: async () => ({
      ok: false,
      status: "failed",
      code: "YOUTUBE_DOWNLOADER_MISSING",
      youtubeIngest: {
        enabled: true,
        ingestAvailable: false,
        downloaderConfigured: false,
        sourceCache: { configured: false },
      },
      ffmpeg: { ffmpeg: true, ffprobe: true },
      storage: { stagingReady: true, tmpReady: true, artifactsReady: true },
    }),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.youtubeProof.code, "YOUTUBE_DOWNLOADER_MISSING");
  assert.equal(report.youtubeProof.runtime.downloaderConfigured, false);
  assert.equal(findSensitiveLeak(report), null);
});

test("proof source readiness writes latest and timestamped safe reports", async () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "shortsengine-proof-readiness-results-"));
  try {
    const report = await checkProofSourceReadiness({
      env: {},
      nowMs: Date.parse("2026-07-04T12:34:56.000Z"),
    });
    const written = writeProofSourceReadinessReport(report, { resultsDir });
    const latest = join(resultsDir, "proof-source-readiness-latest.json");
    const timestamped = join(resultsDir, "proof-source-readiness-2026-07-04T12-34-56-000Z.json");

    assert.equal(written.latestRef, "demo/results/proof-source-readiness-latest.json");
    assert.equal(written.timestampedRef, "demo/results/proof-source-readiness-2026-07-04T12-34-56-000Z.json");
    assert.equal(existsSync(latest), true);
    assert.equal(existsSync(timestamped), true);

    const payload = JSON.parse(readFileSync(latest, "utf8"));
    assert.equal(payload.status, "skipped");
    assert.equal(payload.outputPolicy.oldMp4Reused, false);
    assert.equal(findSensitiveLeak(payload), null);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
  }
});
