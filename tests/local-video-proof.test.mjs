import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  LOCAL_PROOF_SOURCE_MARKER,
  runLocalVideoProof,
  validateLocalProofConfig,
} from "../demo/run-local-video-proof.mjs";

function mp4Buffer(extraBytes = 64) {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.alloc(extraBytes),
  ]);
}

function tempMp4() {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-local-proof-test-"));
  const file = join(dir, "source.mp4");
  writeFileSync(file, mp4Buffer());
  return { dir, file };
}

function proofEnv(file, overrides = {}) {
  return {
    SHORTSENGINE_LOCAL_PROOF_SOURCE: file,
    SHORTSENGINE_LOCAL_PROOF_RIGHTS_CONFIRMED: "1",
    SHORTSENGINE_LOCAL_PROOF_EXPECTED_COUNTED_GOALS: "3",
    SHORTSENGINE_LOCAL_PROOF_SOURCE_LABEL: "test-local-proof",
    ...overrides,
  };
}

function completedJob({ qaOverrides = {}, segmentOverrides = {} } = {}) {
  const segments = [1, 2, 3].map((goalNumber, index) => ({
    id: `goal_${goalNumber}`,
    sourceStart: 90 + index * 60,
    shotStart: 100 + index * 60,
    finishTime: 104 + index * 60,
    confirmationTime: 111 + index * 60,
    sourceEnd: 116 + index * 60,
    goalNumber,
    highlightType: "goal",
    goalOutcome: {
      eventType: "ball_in_net",
      outcome: "confirmed_goal",
    },
    replayOnly: false,
    phaseCoverage: {
      hasBuildup: true,
      hasShot: true,
      hasFinish: true,
      hasConfirmation: true,
    },
    ...segmentOverrides,
  }));
  return {
    id: "job_12345678",
    projectId: "prj_12345678",
    uploadId: "upl_12345678",
    status: "completed",
    progress: 100,
    step: "completed",
    exportId: "exp_12345678",
    videoOutputQA: {
      status: "passed",
      passed: true,
      goalSelectionMode: "valid_goals_only",
      expectedGoalCount: 3,
      actualConfirmedGoalSegmentCount: 3,
      coveredGoalCount: 3,
      missingGoalNumbers: [],
      failedReasons: [],
      hook: {
        passed: true,
        hookType: "goal_payoff",
        hookStart: 0,
        hookEnd: 1.8,
        hookText: "THE GOALS COUNT",
        relatedGoalNumber: 1,
        evidenceCodes: ["confirmed_goal", "score_change"],
        noFalseGoalClaim: true,
        reasons: [],
      },
      captions: {
        passed: true,
        captionCount: 3,
        dynamicCaptionCount: 3,
        readableCaptionCount: 3,
        openingHookCaptionInFirstTwoSeconds: true,
        stylePresets: ["hormozi_sports"],
        safeAreas: ["lower_third"],
        reasons: [],
      },
      animations: {
        passed: true,
        cueCount: 4,
        hookCueCount: 2,
        cueTypes: ["intro_hook", "caption_word_pop", "segment_flash", "smooth_transition"],
        reasons: [],
      },
      audioPolicy: {
        passed: true,
        audioMode: "source_only",
        licenseStatus: "source_rights_confirmed",
        externalAudioBundled: false,
        copyrightedTrackBundled: false,
        reasons: [],
      },
      creativeStyle: {
        passed: true,
        colorGrade: "sports_clean",
        mildZoom: 1.02,
        mirror: false,
        copyrightEvasion: false,
        watermarkObscuring: false,
        reasons: [],
      },
      ...qaOverrides,
    },
    editPlan: {
      mode: "multi_moment_compilation",
      goalSelectionMode: "valid_goals_only",
      totalDuration: 78,
      segments,
      captions: [
        {
          start: 0.1,
          end: 1.8,
          text: "THE GOALS COUNT",
          role: "opening_hook",
          words: ["THE", "GOALS", "COUNT"],
          activeWordTiming: [
            { word: "THE", start: 0.1, end: 0.45 },
            { word: "GOALS", start: 0.45, end: 1.1 },
            { word: "COUNT", start: 1.1, end: 1.8 },
          ],
          stylePreset: "hormozi_sports",
          contrastMode: "outlined_shadow",
          safeArea: { name: "lower_third" },
        },
        {
          start: 24,
          end: 26,
          text: "GOAL CONFIRMED",
          role: "confirmation",
          words: ["GOAL", "CONFIRMED"],
          activeWordTiming: [
            { word: "GOAL", start: 24, end: 24.6 },
            { word: "CONFIRMED", start: 24.6, end: 25.5 },
          ],
          stylePreset: "hormozi_sports",
          contrastMode: "outlined_shadow",
          safeArea: { name: "lower_third" },
        },
        {
          start: 50,
          end: 52,
          text: "THIRD FINISH",
          role: "goal_payoff",
          words: ["THIRD", "FINISH"],
          activeWordTiming: [
            { word: "THIRD", start: 50, end: 50.8 },
            { word: "FINISH", start: 50.8, end: 51.8 },
          ],
          stylePreset: "hormozi_sports",
          contrastMode: "outlined_shadow",
          safeArea: { name: "lower_third" },
        },
      ],
      renderPolishQA: {
        transitionRenderedCount: 2,
        hardCutFallbackCount: 0,
        transitions: [
          { timelineStart: 26, type: "short_fade", transitionDurationSeconds: 0.35, renderedBy: "segment_fade_concat" },
          { timelineStart: 52, type: "short_fade", transitionDurationSeconds: 0.35, renderedBy: "segment_fade_concat" },
        ],
        animatedCaptionCount: 3,
        dynamicWordCaptionCount: 3,
        staticCaptionFallbackCount: 0,
        captionMotion: "ass_word_by_word_highlight",
        overlayRenderedCount: 3,
        overlayFallbackCount: 0,
        visualPolishScore: 98,
        renderPolishWarnings: [],
      },
      visualPolishQA: {
        abruptCutRiskCount: 0,
        cutSmoothnessScore: 1,
        phaseCoverageScore: 1,
        referencePacingScore: 1,
        visualPolishScore: 98,
        referenceSimilarityNotes: ["local_proof_social_polish_ready"],
      },
      visualTrackingSummary: {
        trackingProviderMode: "safe-tracking-provider",
        ballCandidateConfidence: 0,
        playerClusterConfidence: 0,
        trackingConfidence: 0,
        fallbackUsed: true,
        ballTrackCount: 0,
        playerClusterCount: 0,
        goalClaimAllowed: false,
      },
      cropPlan: {
        mode: "wide_safe",
        cropMode: "wide_safe",
        targetAspectRatio: "9:16",
        safeArea: { x: 0, y: 0, width: 1920, height: 1080 },
        cropBox: { x: 0, y: 0, width: 1920, height: 1080 },
        confidence: 0,
        trackingConfidence: 0,
        actionCenterX: 960,
        actionCenterY: 540,
        maxPanSpeed: 0,
        actionSafeZones: [],
        textSafeZones: [{ name: "bottom_caption", x: 0.08, y: 0.74, width: 0.84, height: 0.18 }],
        fallbackUsed: true,
        textObstructionRisk: false,
      },
    },
  };
}

function successDeps(job = completedJob(), captures = {}) {
  return {
    cleanupGeneratedArtifacts: () => ({
      directory: "manual-downloads",
      attempted: true,
      deletedCount: 0,
      deleted: [],
      skippedCount: 0,
      errors: [],
      destructiveOutsideManualDownloads: false,
    }),
    getFreePort: async () => 49152,
    startServer: (port, env, config) => {
      captures.startServer = { port, env, config };
      return { child: { exitCode: null, signalCode: null }, dataDir: null, events: [] };
    },
    stopServer: async () => {},
    waitForServerReady: async () => ({ attempts: 1, waitedMs: 5, status: 200 }),
    uploadLocalMp4: async ({ config }) => {
      captures.uploadSource = config.source;
      return { projectId: "prj_12345678", uploadId: "upl_12345678", requestIdPresent: true };
    },
    startGenerate: async () => ({ jobId: "job_12345678", requestIdPresent: true }),
    pollJob: async () => ({ job, lifecycle: [], timeout: false }),
    fetchDownload: async () => ({
      ok: true,
      status: 200,
      requestId: "req_download",
      contentType: "video/mp4",
      buffer: mp4Buffer(128),
    }),
    writeOutputArtifact: ({ downloadSummary }) => {
      captures.writeOutputArtifact = true;
      return {
        type: "rendered_video",
        status: "available",
        relativePath: "manual-downloads/shortsengine-local-proof-test-2026-06-23T00-00-00-000Z.mp4",
        sourceType: "local_mp4",
        sizeBytes: downloadSummary.sizeBytes,
        contentType: downloadSummary.contentType,
        sha256Prefix: downloadSummary.sha256Prefix,
        downloadVerified: true,
        logsDownloaded: false,
        artifactsDownloaded: false,
      };
    },
    probeGeneratedMp4: () => ({
      checked: true,
      status: "passed",
      code: null,
      relativePath: "manual-downloads/shortsengine-local-proof-test-2026-06-23T00-00-00-000Z.mp4",
      sizeBytes: 140,
      durationSeconds: 78,
      width: 1080,
      height: 1920,
      videoCodec: "h264",
      audioPresent: true,
    }),
    analyzeVisualFrameQa: () => ({
      schemaVersion: 1,
      status: "passed",
      passed: true,
      outputRelativePath: "manual-downloads/shortsengine-local-proof-test-2026-06-23T00-00-00-000Z.mp4",
      sampledFrameCount: 5,
      decodedFrameCount: 5,
      frameTimestamps: [0.5, 1.75, 32.76, 53.04, 77.5],
      frames: [
        { index: 1, timestamp: 0.5, status: "passed", decoded: true, code: null },
        { index: 2, timestamp: 1.75, status: "passed", decoded: true, code: null },
      ],
      cropSafetyVerdict: "passed",
      cropMode: "wide_safe",
      trackingProviderMode: "safe-tracking-provider",
      trackingConfidence: 0,
      fallbackUsed: true,
      visibleActionCenter: { x: 960, y: 540 },
      captionBoxPosition: { name: "bottom_caption", x: 0.08, y: 0.74, width: 0.84, height: 0.18 },
      ballPlayerVisibilityEstimate: null,
      actionSafeZoneCoverage: 1,
      obstructionRisk: false,
      abruptCropPanRisk: false,
      failedFrameReasons: [],
      logsDownloaded: false,
      artifactsDownloaded: false,
    }),
  };
}

test("local video proof defaults to a safe skipped report", async () => {
  const report = await runLocalVideoProof({
    env: {},
    getFreePort: async () => {
      throw new Error("server should not start");
    },
  });
  assert.equal(report.status, "skipped");
  assert.equal(report.skipped, true);
  assert.match(report.nextAction, /SHORTSENGINE_LOCAL_PROOF_SOURCE/);
  assert.equal(findSensitiveLeak(report), null);
});

test("local video proof requires rights confirmation before reading source details", async () => {
  const { dir, file } = tempMp4();
  try {
    const report = await runLocalVideoProof({
      env: {
        SHORTSENGINE_LOCAL_PROOF_SOURCE: file,
        SHORTSENGINE_LOCAL_PROOF_EXPECTED_COUNTED_GOALS: "3",
      },
    });
    assert.equal(report.status, "failed");
    assert.equal(report.failedCases[0].code, "LOCAL_VIDEO_PROOF_RIGHTS_REQUIRED");
    assert.equal(report.outputProof.outputMp4, null);
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local video proof rejects traversal-like source references safely", async () => {
  const report = await runLocalVideoProof({
    env: proofEnv("../unsafe.mp4"),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failedCases[0].code, "LOCAL_VIDEO_PROOF_SOURCE_UNSAFE");
  assert.equal(findSensitiveLeak(report), null);
});

test("local video proof rejects corrupt mp4 signature before server startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-local-proof-corrupt-"));
  const file = join(dir, "corrupt.mp4");
  writeFileSync(file, Buffer.from("not-a-real-mp4", "utf8"));
  try {
    const report = await runLocalVideoProof({ env: proofEnv(file) });
    assert.equal(report.status, "failed");
    assert.equal(report.failedCases[0].code, "LOCAL_VIDEO_PROOF_SOURCE_SIGNATURE_INVALID");
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local video proof config exposes only safe source metadata", () => {
  const { dir, file } = tempMp4();
  try {
    const config = validateLocalProofConfig(proofEnv(file));
    assert.equal(config.skipped, false);
    assert.equal(config.source.fileName, "source.mp4");
    assert.equal(config.source.extension, ".mp4");
    assert.equal(config.expectedCountedGoals, 3);
    assert.equal(config.source.sha256Prefix.length, 16);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local video proof passes only after output gate and uses the local proof source marker", async () => {
  const { dir, file } = tempMp4();
  const captures = {};
  const before = statSync(file);
  try {
    const report = await runLocalVideoProof({
      env: proofEnv(file, {
        SHORTSENGINE_LOCAL_PROOF_SCOREBOARD_OCR: "1",
        SHORTSENGINE_LOCAL_PROOF_SCOREBOARD_OCR_QA: "1",
      }),
      fetchImpl: async () => {
        throw new Error("network should be mocked by deps");
      },
      ...successDeps(completedJob(), captures),
    });
    const after = statSync(file);
    assert.equal(report.status, "passed");
    assert.equal(report.outputProof.expectedCountedGoals, 3);
    assert.equal(report.outputProof.coveredGoalCount, 3);
    assert.equal(report.outputProof.renderedSocialPolishQA.passed, true);
    assert.equal(report.outputProof.visualFrameQA.passed, true);
    assert.equal(report.outputProof.visualFrameQA.sampledFrameCount, 5);
    assert.equal(report.outputProof.actionFramingVerdict.cropMode, "wide_safe");
    assert.equal(report.outputProof.referenceStyleComparisonSummary.socialPolishScore, 98);
    assert.equal(report.outputProof.dynamicWordCaptionCount, 3);
    assert.equal(report.outputProof.openingHookCaptionRendered, true);
    assert.equal(report.outputProof.hookFirstTwoSecondsPassed, true);
    assert.equal(report.outputProof.outputMp4.relativePath.startsWith("manual-downloads/"), true);
    assert.equal(captures.writeOutputArtifact, true);
    assert.equal(captures.startServer.config.scoreboardOcrEnabled, true);
    assert.equal(captures.startServer.config.scoreboardOcrQaEnabled, true);
    assert.equal(LOCAL_PROOF_SOURCE_MARKER, "local-video-proof");
    assert.equal(captures.uploadSource.fileName, "source.mp4");
    assert.equal(after.size, before.size);
    assert.deepEqual(readFileSync(file), mp4Buffer());
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local video proof discards generated output when visual frame QA fails", async () => {
  const { dir, file } = tempMp4();
  let discarded = false;
  try {
    const report = await runLocalVideoProof({
      env: proofEnv(file),
      fetchImpl: async () => {
        throw new Error("network should be mocked by deps");
      },
      ...successDeps(completedJob()),
      analyzeVisualFrameQa: () => ({
        schemaVersion: 1,
        status: "failed",
        passed: false,
        outputRelativePath: "manual-downloads/shortsengine-local-proof-test-2026-06-23T00-00-00-000Z.mp4",
        sampledFrameCount: 5,
        decodedFrameCount: 5,
        frameTimestamps: [0.5, 1.75, 32.76, 53.04, 77.5],
        frames: [],
        cropSafetyVerdict: "failed",
        cropMode: "soft_follow",
        trackingProviderMode: "opencv-object-tracking",
        trackingConfidence: 0.91,
        fallbackUsed: false,
        visibleActionCenter: { x: 1200, y: 540 },
        captionBoxPosition: { name: "bottom_caption", x: 0.08, y: 0.74, width: 0.84, height: 0.18 },
        ballPlayerVisibilityEstimate: 0.4,
        actionSafeZoneCoverage: 0,
        obstructionRisk: true,
        abruptCropPanRisk: true,
        failedFrameReasons: ["caption_text_obstruction_risk", "action_safe_zone_not_contained"],
        logsDownloaded: false,
        artifactsDownloaded: false,
      }),
      discardFailedOutputArtifact: (artifact) => {
        discarded = true;
        return { attempted: true, deleted: true, relativePath: artifact.relativePath };
      },
    });
    assert.equal(report.status, "failed");
    assert.equal(report.failedCases[0].code, "LOCAL_VIDEO_PROOF_VISUAL_QA_FAILED");
    assert.equal(report.outputProof.outputMp4, null);
    assert.equal(report.outputProof.visualFrameQA.passed, false);
    assert.equal(report.outputProof.visualFrameQA.obstructionRisk, true);
    assert.equal(report.outputProof.failedOutputCleanup.deleted, true);
    assert.equal(discarded, true);
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local video proof does not download or write an mp4 when final gate fails", async () => {
  const { dir, file } = tempMp4();
  let downloadCalled = false;
  let writeCalled = false;
  try {
    const report = await runLocalVideoProof({
      env: proofEnv(file),
      fetchImpl: async () => {
        throw new Error("network should be mocked by deps");
      },
      ...successDeps(completedJob({
        qaOverrides: {
          status: "failed",
          passed: false,
          actualConfirmedGoalSegmentCount: 1,
          coveredGoalCount: 1,
          missingGoalNumbers: [2, 3],
          failedReasons: ["missing_or_invalid_counted_goal_segment"],
        },
      })),
      fetchDownload: async () => {
        downloadCalled = true;
        return {};
      },
      writeOutputArtifact: () => {
        writeCalled = true;
        return {};
      },
    });
    assert.equal(report.status, "failed");
    assert.equal(report.failedCases[0].code, "LOCAL_VIDEO_PROOF_OUTPUT_QA_FAILED");
    assert.equal(report.outputProof.outputMp4, null);
    assert.deepEqual(report.outputProof.missingGoalNumbers, [2, 3]);
    assert.equal(downloadCalled, false);
    assert.equal(writeCalled, false);
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local video proof rejects random chance segments even when upstream QA is optimistic", async () => {
  const { dir, file } = tempMp4();
  let downloadCalled = false;
  try {
    const report = await runLocalVideoProof({
      env: proofEnv(file),
      fetchImpl: async () => {
        throw new Error("network should be mocked by deps");
      },
      ...successDeps(completedJob({
        segmentOverrides: {
          highlightType: "chance",
          goalOutcome: null,
          reasonCodes: ["big_chance"],
        },
      })),
      fetchDownload: async () => {
        downloadCalled = true;
        return {};
      },
    });
    assert.equal(report.status, "failed");
    assert.equal(report.failedCases[0].code, "LOCAL_VIDEO_PROOF_OUTPUT_QA_FAILED");
    assert.equal(report.outputProof.outputMp4, null);
    assert.equal(report.outputProof.randomChanceCandidates.length, 3);
    assert.equal(report.outputProof.failedReasons.includes("local_proof_segment_contract_failed"), true);
    assert.equal(downloadCalled, false);
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local video proof rejects celebration-only goal segments before download", async () => {
  const { dir, file } = tempMp4();
  let downloadCalled = false;
  try {
    const report = await runLocalVideoProof({
      env: proofEnv(file),
      fetchImpl: async () => {
        throw new Error("network should be mocked by deps");
      },
      ...successDeps(completedJob({
        segmentOverrides: {
          celebrationOnly: true,
          reasonCodes: ["visual_celebration_after_shot"],
        },
      })),
      fetchDownload: async () => {
        downloadCalled = true;
        return {};
      },
    });
    assert.equal(report.status, "failed");
    assert.equal(report.failedCases[0].code, "LOCAL_VIDEO_PROOF_OUTPUT_QA_FAILED");
    assert.equal(report.outputProof.celebrationOnlyCandidates.length, 3);
    assert.equal(report.outputProof.outputMp4, null);
    assert.equal(downloadCalled, false);
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local video proof discards generated output when ffprobe fails", async () => {
  const { dir, file } = tempMp4();
  let discarded = false;
  try {
    const report = await runLocalVideoProof({
      env: proofEnv(file),
      fetchImpl: async () => {
        throw new Error("network should be mocked by deps");
      },
      ...successDeps(completedJob()),
      probeGeneratedMp4: () => ({
        checked: true,
        status: "failed",
        code: "FFPROBE_UNREADABLE",
        relativePath: "manual-downloads/shortsengine-local-proof-test-2026-06-23T00-00-00-000Z.mp4",
      }),
      discardFailedOutputArtifact: (artifact) => {
        discarded = true;
        return { attempted: true, deleted: true, relativePath: artifact.relativePath };
      },
    });
    assert.equal(report.status, "failed");
    assert.equal(report.failedCases[0].code, "LOCAL_VIDEO_PROOF_FFPROBE_FAILED");
    assert.equal(report.outputProof.outputMp4, null);
    assert.equal(report.outputProof.ffprobe.status, "failed");
    assert.equal(report.outputProof.failedOutputCleanup.deleted, true);
    assert.equal(discarded, true);
    assert.equal(findSensitiveLeak(report), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
