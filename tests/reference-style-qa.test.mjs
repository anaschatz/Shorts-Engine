import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  analyzeReferenceStyleQA,
  buildReferenceStyleQAReport,
  writeReferenceStyleQA,
} from "../demo/reference-style-qa.mjs";

function writeJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function goal(goalNumber, overrides = {}) {
  const start = 100 + goalNumber * 40;
  const shot = start + 10;
  const finish = shot + 3;
  const confirmation = finish + 4;
  const end = confirmation + 2;
  return {
    goalNumber,
    scoreTransition: {
      before: overrides.before || `${goalNumber - 1}-0`,
      after: overrides.after || `${goalNumber}-0`,
      scoreChangeTime: confirmation,
    },
    segment: {
      sourceStart: start,
      shotStart: shot,
      finishTime: finish,
      confirmationTime: confirmation,
      sourceEnd: end,
      durationSeconds: end - start,
      replayOnly: false,
      ...(overrides.segment || {}),
    },
    renderedTimeline: {
      timelineStart: (goalNumber - 1) * 19,
      preShot: (goalNumber - 1) * 19 + 10,
      finish: (goalNumber - 1) * 19 + 13,
      payoff: (goalNumber - 1) * 19 + 13.4,
      confirmation: (goalNumber - 1) * 19 + 17,
      timelineEnd: goalNumber * 19,
    },
    verdict: "clear",
    clear: true,
    frames: ["buildup", "pre_shot", "finish", "payoff", "confirmation"].map((role) => ({
      role,
      renderedTimelineTime: role === "buildup" ? (goalNumber - 1) * 19 : (goalNumber - 1) * 19 + 10,
      sourceTime: role === "buildup" ? start : shot,
      status: "clear",
      clear: true,
      confidence: 0.9,
      reason: null,
    })),
    missingRoles: [],
    failedFrameReasons: [],
    ...overrides,
  };
}

function proof(timestamp, relativePath = "manual-downloads/proof.mp4", overrides = {}) {
  return {
    timestamp,
    generatedAt: timestamp,
    status: "passed",
    passed: true,
    outputProof: {
      outputMp4: { relativePath },
      ffprobe: { status: "passed", durationSeconds: 95, width: 1080, height: 1920 },
      expectedCountedGoals: 5,
      renderedSocialPolishQA: {
        status: "passed",
        passed: true,
        renderedHook: {
          passed: true,
          hookStart: 0,
          hookEnd: 1.6,
          hookType: "shot",
          hookText: "5 GOALS, ONE MATCH",
          evidenceCodes: ["scoreboard_backed_goal_sequence"],
          noFalseGoalClaim: true,
        },
        dynamicCaptions: {
          passed: true,
          dynamicWordCaptionCount: 6,
          captionCount: 6,
          readableCaptionCount: 6,
          openingHookCaptionRendered: true,
          activeWordHighlightRendered: true,
          textObstructionRisk: false,
        },
        smoothEditing: {
          passed: true,
          segmentCount: 5,
          transitionRenderedCount: 4,
          hardCutFallbackCount: 0,
          abruptCutRiskCount: 0,
          transitions: [{ type: "short_fade", timelineStart: 19, durationSeconds: 0.4 }],
        },
        renderedActionFraming: {
          passed: true,
          cropMode: "wide_safe",
          fallbackUsed: true,
          textObstructionRisk: false,
          abruptCropPanRisk: false,
        },
      },
      ...overrides.outputProof,
    },
    ...overrides,
  };
}

function fixture({ overrides = {}, goals = null, timestamp = "2026-07-08T12:00:00.000Z" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "shortsengine-reference-style-qa-"));
  const proofPath = "demo/results/youtube-live-e2e-latest.json";
  const visualPath = "demo/results/visual-goal-qa-latest.json";
  const contactPath = "demo/results/visual-goal-contact-sheet-proof.json";
  const mp4Path = "manual-downloads/proof.mp4";
  mkdirSync(join(root, "manual-downloads"), { recursive: true });
  writeFileSync(join(root, mp4Path), Buffer.from("fake-mp4"));
  const contactGoals = goals || [1, 2, 3, 4, 5].map((number) => goal(number));
  writeJson(join(root, contactPath), {
    schemaVersion: 1,
    generatedAt: timestamp,
    outputMp4: { relativePath: mp4Path, durationSeconds: 95, width: 1080, height: 1920 },
    goalCount: contactGoals.length,
    goals: contactGoals,
  });
  writeJson(join(root, proofPath), proof(timestamp, mp4Path, overrides.proof || {}));
  writeJson(join(root, visualPath), {
    schemaVersion: 1,
    timestamp,
    generatedAt: timestamp,
    status: "passed",
    passed: true,
    outputMp4: { relativePath: mp4Path, durationSeconds: 95, width: 1080, height: 1920 },
    contactSheetPath: contactPath,
    goalCount: contactGoals.length,
    expectedGoalCount: 5,
    rubric: {
      captionReadabilityScore: 100,
    },
    failedCases: [],
    failedReasons: [],
    ...(overrides.visual || {}),
  });
  return { root, proofPath, visualPath, contactPath, mp4Path, timestamp };
}

test("reference style QA writes safe passing report with pacing and style categories", () => {
  const fx = fixture();
  const result = writeReferenceStyleQA({
    rootDir: fx.root,
    now: fx.timestamp,
    maxAgeMs: 60_000,
  });

  assert.equal(result.report.status, "passed");
  assert.equal(result.report.goalCount, 5);
  assert.equal(result.report.categoryScores.hookStrength, 100);
  assert.equal(result.report.referenceStyleChecklist.every((check) => check.passed === true), true);
  assert.equal(existsSync(join(fx.root, result.reportPath)), true);
  assert.equal(JSON.parse(readFileSync(join(fx.root, result.latestPath), "utf8")).phase, "reference_style_side_by_side_qa");
  assert.equal(findSensitiveLeak(result.report), null);
});

test("reference style QA fails if generated MP4 is missing", () => {
  const fx = fixture();
  const report = analyzeReferenceStyleQA({
    rootDir: fx.root,
    now: fx.timestamp,
    maxAgeMs: 60_000,
  });
  assert.equal(report.passed, true);

  const missing = buildReferenceStyleQAReport({
    proof: proof(fx.timestamp, "manual-downloads/missing.mp4"),
    visual: {
      timestamp: fx.timestamp,
      generatedAt: fx.timestamp,
      status: "passed",
      passed: true,
      expectedGoalCount: 5,
      outputMp4: { relativePath: "manual-downloads/missing.mp4" },
      rubric: { captionReadabilityScore: 100 },
    },
    contactSheet: { goals: [1, 2, 3, 4, 5].map((number) => goal(number)) },
    outputRef: { ok: true, relativePath: "manual-downloads/missing.mp4" },
    mp4Stats: null,
    generatedAt: fx.timestamp,
  });
  assert.equal(missing.passed, false);
  assert.ok(missing.failedReasons.includes("output_mp4_missing"));
});

test("reference style QA detects dead-air pacing risk and suggests edit changes", () => {
  const slowGoals = [1, 2, 3, 4, 5].map((number) => goal(number));
  slowGoals[1] = goal(2, {
    segment: {
      sourceStart: 140,
      shotStart: 174,
      finishTime: 177,
      confirmationTime: 181,
      sourceEnd: 183,
      durationSeconds: 43,
    },
  });
  const fx = fixture({ goals: slowGoals });
  const report = analyzeReferenceStyleQA({ rootDir: fx.root, now: fx.timestamp, maxAgeMs: 60_000 });
  assert.equal(report.passed, false);
  assert.ok(report.pacing.goalPacing[1].reasons.includes("segment_too_long_dead_air_risk"));
  assert.ok(report.suggestedEditPlanChanges.includes("goal_2_tighten_goal_phase_window"));
});

test("reference style QA fails if opening hook or dynamic captions regress", () => {
  const fx = fixture({
    overrides: {
      proof: {
        outputProof: {
          renderedSocialPolishQA: {
            renderedHook: {
              passed: false,
              hookStart: 4,
              hookEnd: 6,
              noFalseGoalClaim: true,
            },
            dynamicCaptions: {
              passed: false,
              dynamicWordCaptionCount: 0,
              captionCount: 5,
              openingHookCaptionRendered: false,
              textObstructionRisk: true,
            },
            smoothEditing: {
              passed: true,
              segmentCount: 5,
              transitionRenderedCount: 4,
              hardCutFallbackCount: 0,
              abruptCutRiskCount: 0,
            },
            renderedActionFraming: { passed: true },
          },
        },
      },
    },
  });
  const report = analyzeReferenceStyleQA({ rootDir: fx.root, now: fx.timestamp, maxAgeMs: 60_000 });
  assert.equal(report.passed, false);
  assert.ok(report.failedReasons.includes("rendered_hook_gate_failed"));
  assert.ok(report.failedReasons.includes("dynamic_caption_gate_failed"));
  assert.ok(report.failedReasons.includes("caption_text_obstruction_risk"));
});

test("reference style QA detects duplicate score transitions and overlap", () => {
  const duplicateGoals = [
    goal(1),
    goal(2, { before: "1-0", after: "1-1" }),
    goal(3, { before: "1-0", after: "1-1", segment: { sourceStart: 181, shotStart: 188, finishTime: 191, confirmationTime: 195, sourceEnd: 198, durationSeconds: 17 } }),
    goal(4, { before: "1-1", after: "2-1" }),
    goal(5, { before: "2-1", after: "3-1" }),
  ];
  const fx = fixture({ goals: duplicateGoals });
  const report = analyzeReferenceStyleQA({ rootDir: fx.root, now: fx.timestamp, maxAgeMs: 60_000 });
  assert.equal(report.passed, false);
  assert.ok(report.failedReasons.includes("duplicate_score_transition"));
  assert.ok(report.failedReasons.includes("score_transition_chain_mismatch"));
});

test("reference style QA fails stale visual proof reports", () => {
  const fx = fixture({ timestamp: "2026-07-08T12:00:00.000Z" });
  const report = analyzeReferenceStyleQA({
    rootDir: fx.root,
    now: "2026-07-08T14:30:00.000Z",
    maxAgeMs: 60_000,
  });
  assert.equal(report.passed, false);
  assert.ok(report.failedReasons.includes("live_youtube_proof_stale"));
  assert.ok(report.failedReasons.includes("visual_goal_qa_stale"));
});
