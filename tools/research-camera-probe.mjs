#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { __testing: renderJobTesting } = require("../server/render-job.cjs");
const { analyzeVisualTracking, calibrateCropPlan } = require("../server/visual-tracking.cjs");
const renderModule = require("../server/render.cjs");

const metadata = Object.freeze({ durationSeconds: 180, width: 1920, height: 1080 });

function goalSegment(goalNumber, sourceStart) {
  const finishTime = sourceStart + 10;
  const confirmationTime = finishTime + 8;
  return {
    id: `goal_${goalNumber}`,
    goalNumber,
    sourceStart,
    shotStart: finishTime - 3,
    finishTime,
    confirmationTime,
    scoreChangeTime: confirmationTime,
    sourceEnd: confirmationTime + 2,
    highlightType: "goal",
    reasonCodes: ["goal", "scoreboard_backed_goal_sequence", "visual_shot_contact", "visual_ball_in_net"],
    goalOutcome: { eventType: "ball_in_net", outcome: "confirmed_goal", offsideStatus: "onside" },
    phaseCoverage: { hasBuildup: true, hasShot: true, hasFinish: true, hasConfirmation: true },
  };
}

function phaseSamplingMetric(segments) {
  const windows = renderJobTesting.goalTrackingCandidateWindows({ segments }, metadata);
  const goalsPassing = segments.filter((segment) => {
    const goalHint = `goal_${segment.goalNumber}`;
    const goalWindows = windows.filter((window) => window.visualHints.includes(goalHint));
    const ball = goalWindows.filter((window) => window.visualHints.includes("ball_follow"));
    const scorer = goalWindows.filter((window) => window.visualHints.includes("scorer_follow"));
    return ball.length >= 3 && scorer.length >= 2;
  }).length;
  return {
    score: segments.length ? goalsPassing / segments.length : 0,
    windowCount: windows.length,
    goalsPassing,
  };
}

function targetHandoffMetric() {
  const tracking = analyzeVisualTracking({
    metadata,
    visualTracking: {
      frameCount: 4,
      sampledTimestamps: [2, 8, 13, 17],
      trackingSamples: [
        { time: 2, ballBox: { x: 300, y: 440, width: 24, height: 24 }, ballConfidence: 0.86, playerClusterBox: { x: 220, y: 300, width: 320, height: 420 }, playerClusterConfidence: 0.76, actionCenter: { x: 312, y: 452 }, source: "ball_detection", phase: "ball_follow" },
        { time: 8, ballBox: { x: 900, y: 430, width: 24, height: 24 }, ballConfidence: 0.88, playerClusterBox: { x: 760, y: 300, width: 360, height: 420 }, playerClusterConfidence: 0.8, actionCenter: { x: 912, y: 442 }, source: "ball_detection", phase: "ball_follow" },
        { time: 13, ballBox: { x: 180, y: 500, width: 24, height: 24 }, ballConfidence: 0.91, playerClusterBox: { x: 1320, y: 170, width: 360, height: 650 }, playerClusterConfidence: 0.82, actionCenter: { x: 1500, y: 495 }, source: "ball_detection", phase: "scorer_follow" },
        { time: 17, ballBox: { x: 160, y: 500, width: 24, height: 24 }, ballConfidence: 0.9, playerClusterBox: { x: 1380, y: 170, width: 360, height: 650 }, playerClusterConfidence: 0.84, actionCenter: { x: 1560, y: 495 }, source: "ball_detection", phase: "scorer_follow" },
      ],
      estimatedActionBounds: { x: 160, y: 170, width: 1580, height: 650 },
      ballCandidateConfidence: 0.91,
      playerClusterConfidence: 0.84,
      trackingConfidence: 0.84,
      recommendedFramingMode: "ball_follow",
      cropSafetyReason: "ball_follow_validated_tracking_timeline",
      fallbackUsed: false,
    },
  });
  const cropPlan = calibrateCropPlan({ metadata, trackingSummary: tracking, targetAspectRatio: "9:16" });
  const scorerFrames = Array.isArray(cropPlan.keyframes)
    ? cropPlan.keyframes.filter((keyframe) => keyframe.phase === "scorer_follow")
    : [];
  return {
    score: scorerFrames.length >= 2 && scorerFrames.every((keyframe) => (
      keyframe.trackingTarget !== "ball" &&
      ["celebration_group_fallback", "celebration_face_detection", "celebration_person_head_estimate"].includes(keyframe.source)
    )) ? 1 : 0,
    cropPlan,
    tracking,
  };
}

function cameraReportMetric(segment, cropPlan, tracking) {
  if (typeof renderModule.twoPhaseGoalCameraSummary !== "function") return { score: 0, report: null };
  const report = renderModule.twoPhaseGoalCameraSummary({ segments: [segment], cropPlan, visualTrackingSummary: tracking });
  return { score: report && report.passed === true ? 1 : 0, report };
}

function main() {
  const segments = [1, 2, 3, 4, 5].map((goalNumber) => goalSegment(goalNumber, 10 + (goalNumber - 1) * 30));
  const phaseSampling = phaseSamplingMetric(segments);
  const handoff = targetHandoffMetric();
  const report = cameraReportMetric(goalSegment(1, 0), handoff.cropPlan, handoff.tracking);
  const aggregateScore = Number((
    phaseSampling.score * 40 +
    handoff.score * 25 +
    report.score * 25 +
    10
  ).toFixed(2));
  console.log(JSON.stringify({
    passed: aggregateScore >= 90,
    aggregateScore,
    metrics: {
      phaseSamplingCoverage: Number(phaseSampling.score.toFixed(2)),
      scorerTargetHandoff: handoff.score,
      twoPhaseReportContract: report.score,
      goalClaimAllowed: false,
      sampledWindowCount: phaseSampling.windowCount,
      sampledGoalCount: segments.length,
    },
  }, null, 2));
}

main();
