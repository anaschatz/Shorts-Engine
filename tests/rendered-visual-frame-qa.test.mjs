import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  analyzeRenderedVisualFrameQA,
  sampleTimestamps,
  safeRelativeMp4Ref,
} from "../demo/rendered-visual-frame-qa.mjs";

function tempWorkspaceMp4() {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-visual-frame-qa-"));
  const manual = join(dir, "manual-downloads");
  mkdirSync(manual, { recursive: true });
  const file = join(manual, "shortsengine-local-proof-test-2026-07-04T10-00-00-000Z.mp4");
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.alloc(256),
  ]));
  return {
    dir,
    relativePath: "manual-downloads/shortsengine-local-proof-test-2026-07-04T10-00-00-000Z.mp4",
  };
}

function renderPlan(overrides = {}) {
  return {
    cropPlan: {
      mode: "soft_follow",
      cropMode: "soft_follow",
      actionCenterX: 960,
      actionCenterY: 520,
      textSafeZones: [{ name: "bottom_caption", x: 0.08, y: 0.74, width: 0.84, height: 0.18 }],
    },
    ...overrides,
  };
}

function socialProof(overrides = {}) {
  return {
    passed: true,
    dynamicCaptions: {
      textObstructionRisk: false,
    },
    renderedActionFraming: {
      passed: true,
      cropMode: "soft_follow",
      trackingProviderMode: "opencv-object-tracking",
      trackingConfidence: 0.91,
      fallbackUsed: false,
      ballPlayerVisibilityScore: 0.88,
      actionSafeZoneCoverage: 1,
      textObstructionRisk: false,
      abruptCropPanRisk: false,
    },
    ...overrides,
  };
}

test("visual frame QA passes with bounded decoded frame samples", () => {
  const { dir, relativePath } = tempWorkspaceMp4();
  try {
    const report = analyzeRenderedVisualFrameQA({
      rootDir: dir,
      outputMp4: { relativePath, sizeBytes: 280, downloadVerified: true },
      ffprobe: { status: "passed", durationSeconds: 30, width: 1080, height: 1920 },
      renderPlan: renderPlan(),
      renderedSocialPolishQA: socialProof(),
      frameSampler: ({ timestamp }) => ({ decoded: true, status: "passed", code: null, timestamp }),
    });

    assert.equal(report.passed, true);
    assert.equal(report.sampledFrameCount, 5);
    assert.equal(report.decodedFrameCount, 5);
    assert.equal(report.outputRelativePath, relativePath);
    assert.equal(report.cropSafetyVerdict, "passed");
    assert.equal(report.cropMode, "soft_follow");
    assert.equal(report.visibleActionCenter.x, 960);
    assert.equal(report.captionBoxPosition.name, "bottom_caption");
    assert.equal(report.logsDownloaded, false);
    assert.equal(report.artifactsDownloaded, false);
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("visual frame QA fails closed when a frame cannot be decoded", () => {
  const { dir, relativePath } = tempWorkspaceMp4();
  try {
    const report = analyzeRenderedVisualFrameQA({
      rootDir: dir,
      outputMp4: { relativePath, sizeBytes: 280, downloadVerified: true },
      ffprobe: { status: "passed", durationSeconds: 30, width: 1080, height: 1920 },
      renderPlan: renderPlan(),
      renderedSocialPolishQA: socialProof(),
      frameSampler: ({ timestamp }) => (
        timestamp > 10
          ? { decoded: false, status: "failed", code: "FRAME_SAMPLE_DECODE_FAILED" }
          : { decoded: true, status: "passed", code: null }
      ),
    });

    assert.equal(report.passed, false);
    assert.equal(report.decodedFrameCount < report.sampledFrameCount, true);
    assert.equal(report.failedFrameReasons.includes("FRAME_SAMPLE_DECODE_FAILED"), true);
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("visual frame QA rejects latest or unsafe output references", () => {
  const { dir } = tempWorkspaceMp4();
  try {
    const latest = analyzeRenderedVisualFrameQA({
      rootDir: dir,
      outputMp4: { relativePath: "manual-downloads/latest.mp4" },
      ffprobe: { status: "passed", durationSeconds: 12 },
      renderPlan: renderPlan(),
      renderedSocialPolishQA: socialProof(),
      frameSampler: () => ({ decoded: true, status: "passed", code: null }),
    });
    const unsafe = safeRelativeMp4Ref(dir, "../outside.mp4");

    assert.equal(latest.passed, false);
    assert.equal(latest.failedFrameReasons.includes("output_mp4_reference_not_unique"), true);
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.code, "VISUAL_FRAME_QA_OUTPUT_REF_UNSAFE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("visual frame QA catches text obstruction and unsafe crop pan", () => {
  const { dir, relativePath } = tempWorkspaceMp4();
  try {
    const report = analyzeRenderedVisualFrameQA({
      rootDir: dir,
      outputMp4: { relativePath, sizeBytes: 280, downloadVerified: true },
      ffprobe: { status: "passed", durationSeconds: 30, width: 1080, height: 1920 },
      renderPlan: renderPlan(),
      renderedSocialPolishQA: socialProof({
        passed: false,
        dynamicCaptions: { textObstructionRisk: true },
        renderedActionFraming: {
          passed: false,
          cropMode: "soft_follow",
          trackingProviderMode: "opencv-object-tracking",
          trackingConfidence: 0.91,
          fallbackUsed: false,
          ballPlayerVisibilityScore: 0.88,
          actionSafeZoneCoverage: 0,
          textObstructionRisk: true,
          abruptCropPanRisk: true,
        },
      }),
      frameSampler: () => ({ decoded: true, status: "passed", code: null }),
    });

    assert.equal(report.passed, false);
    assert.equal(report.obstructionRisk, true);
    assert.equal(report.abruptCropPanRisk, true);
    assert.equal(report.failedFrameReasons.includes("caption_text_obstruction_risk"), true);
    assert.equal(report.failedFrameReasons.includes("abrupt_crop_pan_risk"), true);
    assert.equal(report.failedFrameReasons.includes("action_safe_zone_not_contained"), true);
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("visual frame QA timestamp sampling is bounded and deterministic", () => {
  assert.deepEqual(sampleTimestamps({ durationSeconds: 1 }, 5), [0.1, 0.35, 0.42, 0.68, 0.5]);
  assert.equal(sampleTimestamps({ durationSeconds: 120 }, 50).length, 5);
  assert.deepEqual(sampleTimestamps({ durationSeconds: 0 }, 5), []);
});
