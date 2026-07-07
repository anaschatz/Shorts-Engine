import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  analyzeVisualGoalQA,
  safeRelativeRef,
  writeVisualGoalQA,
} from "../demo/visual-goal-qa.mjs";

const NOW = "2026-07-07T18:00:00.000Z";

function writeJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function createWorkspace() {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-visual-goal-qa-"));
  mkdirSync(join(rootDir, "demo", "results"), { recursive: true });
  mkdirSync(join(rootDir, "manual-downloads"), { recursive: true });
  return {
    rootDir,
    resultsDir: join(rootDir, "demo", "results"),
    proofReport: "demo/results/youtube-live-e2e-latest.json",
    outputRelativePath: "manual-downloads/shortsengine-youtube-WuuGus5Obkg-2026-07-07T18-00-00-000Z.mp4",
  };
}

function scoreTransitions() {
  return [
    ["0-0", "1-0", 123.75],
    ["1-0", "1-1", 482.04],
    ["1-1", "2-1", 514.04],
    ["2-1", "2-2", 555.72],
    ["2-2", "3-2", 686.25],
  ];
}

function segmentWindows() {
  return scoreTransitions().map(([before, after, confirmationTime], index) => {
    const sourceStart = confirmationTime - 18;
    const finishTime = confirmationTime - 3;
    return {
      index: index + 1,
      goalNumber: index + 1,
      scoreBefore: before,
      scoreAfter: after,
      scoreChangeTime: confirmationTime,
      sourceStart,
      shotStart: finishTime - 2,
      finishTime,
      confirmationTime,
      sourceEnd: confirmationTime + 2,
      replayOnly: false,
      phaseCoverage: {
        hasBuildup: true,
        hasShot: true,
        hasFinish: true,
        hasConfirmation: true,
      },
    };
  });
}

function goalProofs(overrides = {}) {
  return segmentWindows().map((segment, index) => {
    const timelineStart = index * 20;
    const frames = [
      ["pre_shot", timelineStart + 8, true],
      ["finish", timelineStart + 14, true],
      ["payoff", timelineStart + 14.5, true],
      ["confirmation", timelineStart + 17, true],
    ].map(([role, time, clear]) => ({
      role,
      time,
      status: clear ? "clear" : "failed",
      clear,
      confidence: clear ? 0.9 : 0.2,
      reason: clear ? null : `${role}_not_clear`,
    }));
    const goalOverride = overrides[index + 1] || {};
    return {
      goalNumber: index + 1,
      segmentIndex: index + 1,
      verdict: goalOverride.verdict || "clear",
      timeline: {
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd,
        timelineStart,
        preShot: timelineStart + 8,
        finish: timelineStart + 14,
        payoff: timelineStart + 14.5,
        confirmation: timelineStart + 17,
        timelineEnd: timelineStart + 20,
      },
      frameCount: 4,
      frameRefs: goalOverride.frameRefs || frames,
      failedFrameReasons: goalOverride.failedFrameReasons || [],
    };
  });
}

function proofReport({ outputRelativePath, overrides = {} } = {}) {
  const segments = overrides.segmentWindows || segmentWindows();
  return {
    timestamp: NOW,
    generatedAt: NOW,
    status: "passed",
    passed: true,
    source: { sourceType: "youtube", videoId: "WuuGus5Obkg" },
    generatedArtifact: {
      relativePath: outputRelativePath,
      durationSeconds: 110,
      width: 1080,
      height: 1920,
      downloadVerified: true,
    },
    outputProof: {
      expectedCountedGoals: 5,
      countedGoalsFound: 5,
      outputMp4: { relativePath: outputRelativePath },
      ffprobe: {
        status: "passed",
        relativePath: outputRelativePath,
        durationSeconds: 110,
        width: 1080,
        height: 1920,
      },
      baselineCoveredGoalCount: 2,
      newCoveredGoalCount: 5,
      improvementDelta: 3,
      nonGoalFillerRate: 0,
      replayOnlyGoalRate: 0,
      averageGoalSegmentDuration: 22,
      scoreChangeAnchors: (overrides.scoreTransitions || scoreTransitions()).map(([scoreBefore, scoreAfter, firstSeenAt], index) => ({
        index: index + 1,
        scoreBefore,
        scoreAfter,
        firstSeenAt,
        confirmedAt: firstSeenAt,
      })),
      segmentWindows: segments,
      renderedGoalProof: {
        passed: true,
        status: "passed",
        goalCount: 5,
        clearGoalCount: 5,
        goals: overrides.goals || goalProofs(overrides.goalOverrides),
      },
      renderedSocialPolishQA: {
        renderedHook: { passed: true },
        dynamicCaptions: {
          passed: overrides.captionObstruction ? false : true,
          textObstructionRisk: overrides.captionObstruction === true,
        },
        smoothEditing: { passed: true },
        renderedActionFraming: { passed: true },
      },
      dynamicWordCaptionCount: 7,
      openingHookCaptionRendered: true,
      hookFirstTwoSecondsPassed: true,
    },
    failedCases: [],
  };
}

function writeWorkspaceProof(workspace, proof = proofReport({ outputRelativePath: workspace.outputRelativePath }), { writeMp4 = true } = {}) {
  writeJson(join(workspace.rootDir, workspace.proofReport), proof);
  if (writeMp4) {
    writeFileSync(join(workspace.rootDir, workspace.outputRelativePath), Buffer.from("fake-mp4"));
  }
}

test("visual goal QA writes a passing report and contact sheet for a fresh MP4 proof", () => {
  const workspace = createWorkspace();
  writeWorkspaceProof(workspace);

  const result = writeVisualGoalQA({
    rootDir: workspace.rootDir,
    resultsDir: workspace.resultsDir,
    proofReport: workspace.proofReport,
    now: NOW,
    maxAgeMs: 60_000,
  });

  assert.equal(result.report.passed, true);
  assert.equal(result.report.goalCount, 5);
  assert.equal(result.report.rubric.goalVisibilityScore, 100);
  assert.equal(result.report.rubric.finishClarityScore, 100);
  assert.equal(result.report.rubric.chronologicalScoreProgressionScore, 100);
  assert.equal(existsSync(join(workspace.rootDir, result.reportPath)), true);
  assert.equal(existsSync(join(workspace.rootDir, result.contactSheetPath)), true);
  assert.equal(findSensitiveLeak(result.report), null);
});

test("visual goal QA fails closed when the referenced MP4 is missing", () => {
  const workspace = createWorkspace();
  writeWorkspaceProof(workspace, proofReport({ outputRelativePath: workspace.outputRelativePath }), { writeMp4: false });

  const report = analyzeVisualGoalQA({
    rootDir: workspace.rootDir,
    proofReport: workspace.proofReport,
    now: NOW,
    maxAgeMs: 60_000,
  });

  assert.equal(report.passed, false);
  assert.equal(report.failedReasons.includes("output_mp4_missing"), true);
});

test("visual goal QA fails when any goal is missing finish or payoff frame refs", () => {
  const workspace = createWorkspace();
  const goals = goalProofs({
    3: {
      verdict: "failed",
      frameRefs: goalProofs()[2].frameRefs.map((frame) => (
        ["finish", "payoff"].includes(frame.role)
          ? { ...frame, status: "failed", clear: false, reason: `${frame.role}_not_clear` }
          : frame
      )),
    },
  });
  writeWorkspaceProof(workspace, proofReport({ outputRelativePath: workspace.outputRelativePath, overrides: { goals } }));

  const report = analyzeVisualGoalQA({
    rootDir: workspace.rootDir,
    proofReport: workspace.proofReport,
    now: NOW,
    maxAgeMs: 60_000,
  });

  assert.equal(report.passed, false);
  assert.equal(report.perGoalVerdict.find((goal) => goal.goalNumber === 3).verdict, "failed");
  assert.equal(report.rubric.finishClarityScore < 100, true);
});

test("visual goal QA lowers caption readability score when captions obstruct action", () => {
  const workspace = createWorkspace();
  writeWorkspaceProof(workspace, proofReport({
    outputRelativePath: workspace.outputRelativePath,
    overrides: { captionObstruction: true },
  }));

  const report = analyzeVisualGoalQA({
    rootDir: workspace.rootDir,
    proofReport: workspace.proofReport,
    now: NOW,
    maxAgeMs: 60_000,
  });

  assert.equal(report.rubric.captionReadabilityScore, 50);
  assert.equal(report.rubric.overallHumanWatchabilityScore < 100, true);
});

test("visual goal QA requires observed chronological score progression", () => {
  const workspace = createWorkspace();
  writeWorkspaceProof(workspace, proofReport({
    outputRelativePath: workspace.outputRelativePath,
    overrides: {
      scoreTransitions: [
        ["0-0", "1-0", 120],
        ["1-0", "2-1", 480],
        ["2-1", "2-2", 520],
        ["2-2", "3-2", 560],
        ["3-2", "4-2", 680],
      ],
    },
  }));

  const report = analyzeVisualGoalQA({
    rootDir: workspace.rootDir,
    proofReport: workspace.proofReport,
    now: NOW,
    maxAgeMs: 60_000,
  });

  assert.equal(report.passed, false);
  assert.equal(report.scoreProgression.passed, false);
  assert.equal(report.failedReasons.includes("score_transition_not_unit_increase"), true);
});

test("visual goal QA rejects unsafe proof references and fails latest MP4 refs", () => {
  const workspace = createWorkspace();
  assert.equal(safeRelativeRef(workspace.rootDir, "../demo/results/youtube-live-e2e-latest.json").ok, false);
  const latestMp4 = "manual-downloads/latest.mp4";
  writeWorkspaceProof(workspace, proofReport({ outputRelativePath: latestMp4 }));
  writeFileSync(join(workspace.rootDir, latestMp4), Buffer.from("fake-mp4"));

  const report = analyzeVisualGoalQA({
    rootDir: workspace.rootDir,
    proofReport: workspace.proofReport,
    now: NOW,
    maxAgeMs: 60_000,
  });

  assert.equal(report.passed, false);
  assert.equal(report.failedReasons.includes("output_mp4_reference_not_unique"), true);
});
