const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeGoalEvidence,
  deterministicGoalEvidence,
  mergeGoalEvidenceIntoVisualSignals,
  normalizeOcrEvidence,
  publicGoalEvidence,
  validateGoalEvidenceOutput,
} = require("../server/goal-evidence-provider.cjs");
const { visualReasonCodesForWindow } = require("../server/vision.cjs");

const metadata = { durationSeconds: 80, width: 1920, height: 1080 };

function strongOcrQaCalibration() {
  return {
    status: "available",
    available: true,
    stale: false,
    invalid: false,
    usable: true,
    decisionSupportLevel: "strong",
    scoreboardCropQuality: "high",
    goalEvidencePolicy: "support_only",
    goalDecisionAllowed: false,
    noFalseGoalFromOcrOnly: true,
    supportWeight: 1,
    generatedAt: "2026-06-19T10:00:00.000Z",
    reasonCode: "ocr_qa_strong",
  };
}

test("goal evidence provider confirms ball-in-net only with explicit decision evidence", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 34.4, end: 35.6, text: "Goal confirmed, the finish counts" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 24, end: 25.5, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
        { start: 27, end: 28.5, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.91 },
      ],
    },
  });

  assert.equal(goalEvidence.summary.validGoalCount, 1);
  assert.equal(goalEvidence.events[0].outcomeHint, "valid_goal");
  assert.equal(goalEvidence.events[0].ballInNetEvidence, true);
  assert.equal(goalEvidence.events[0].commentatorGoalCall, true);
  assert.ok(goalEvidence.events[0].reasonCodes.includes("confirmed_by_commentary"));
  assert.doesNotMatch(JSON.stringify(publicGoalEvidence(goalEvidence)), /\/Users|storageKey|localPath|token|secret/i);
});

test("goal evidence provider marks post-goal offside/no-goal context without creating valid goal", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 39, end: 40.2, text: "The flag is up, no goal for offside" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 28, end: 29.4, types: ["shot_contact", "ball_toward_goal"], confidence: 0.88 },
        { start: 31, end: 32.5, types: ["ball_in_net"], confidence: 0.9 },
        { start: 39, end: 40.2, types: ["assistant_referee_flag", "referee_no_goal_signal"], confidence: 0.86 },
      ],
    },
  });

  assert.equal(goalEvidence.summary.validGoalCount, 0);
  assert.equal(goalEvidence.summary.offsideOrNoGoalCount, 1);
  assert.equal(goalEvidence.events[0].outcomeHint, "offside_goal");
  assert.equal(goalEvidence.events[0].offsideFlag, true);
  assert.equal(goalEvidence.events[0].VARNoGoalSignal, true);
});

test("goal evidence provider recovers counted goal from live finish plus combined support without OCR", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 42.2, end: 44, text: "The crowd explodes as play restarts" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 30, end: 31.5, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
        { start: 34, end: 35.2, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.92 },
        { start: 39, end: 41, types: ["crowd_reaction"], confidence: 0.86 },
      ],
    },
  });

  assert.equal(goalEvidence.summary.validGoalCount, 1);
  assert.equal(goalEvidence.summary.combinedGoalConfirmationCount, 1);
  assert.equal(goalEvidence.summary.scoreboardConfirmedGoalCount, 0);
  assert.equal(goalEvidence.events[0].outcomeHint, "valid_goal");
  assert.ok(goalEvidence.events[0].reasonCodes.includes("shot_sequence_support"));
  assert.ok(goalEvidence.events[0].reasonCodes.includes("combined_goal_confirmation"));
  assert.equal(goalEvidence.events[0].combinedGoalConfirmation, true);
  assert.equal(goalEvidence.events[0].liveShotFinishSequence, true);
});

test("goal evidence provider does not promote crowd/commentary support without ball-in-net", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 12, end: 13.4, text: "The crowd explodes after that chance" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 10, end: 12, types: ["shot_like_motion", "goal_area_visible", "crowd_reaction"], confidence: 0.9 },
      ],
    },
  });

  assert.equal(goalEvidence.summary.validGoalCount, 0);
  assert.equal(goalEvidence.events[0].outcomeHint, "non_goal_chance");
  assert.equal(goalEvidence.events[0].ballInNetEvidence, false);
  assert.equal(goalEvidence.events[0].commentatorGoalCall, false);
});

test("goal evidence provider preserves visual support codes and recovery diagnostics", () => {
  const goalEvidence = validateGoalEvidenceOutput({
    providerMode: "unit-goal-evidence",
    fallbackUsed: false,
    events: [{
      id: "recoverable_live_candidate",
      start: 30,
      end: 48,
      confidence: 0.84,
      outcomeHint: "non_goal_chance",
      evidenceSource: "unit",
      reasonCodes: [
        "visual_shot_contact",
        "visual_ball_toward_goal",
        "visual_goal_mouth",
        "visual_crowd_reaction",
        "replay_goal_confirmation",
        "live_shot_finish_sequence",
      ],
    }],
  }, metadata);
  const event = goalEvidence.events[0];

  assert.equal(goalEvidence.summary.recoverableCandidateCount, 1);
  assert.equal(event.recoveryEligibility, "recoverable_live_goal_candidate");
  assert.equal(event.rejectionReason, null);
  assert.ok(event.reasonCodes.includes("visual_shot_contact"));
  assert.ok(event.reasonCodes.includes("visual_goal_mouth"));
  assert.ok(event.missingEvidence.includes("explicit_ball_in_net"));
  assert.doesNotMatch(JSON.stringify(publicGoalEvidence(goalEvidence)), /\/Users|storageKey|localPath|token|secret|stderr|stdout/i);
});

test("goal evidence provider does not promote crowd-only ball-in-net sequence to counted goal", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 37.2, end: 39, text: "The crowd explodes after the finish" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 30, end: 31.5, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
        { start: 34, end: 35.2, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.92 },
        { start: 37, end: 39, types: ["crowd_reaction"], confidence: 0.86 },
      ],
    },
  });

  assert.equal(goalEvidence.summary.validGoalCount, 0);
  assert.equal(goalEvidence.summary.unconfirmedGoalCount, 1);
  assert.equal(goalEvidence.summary.combinedGoalConfirmationCount, 0);
  assert.equal(goalEvidence.events[0].outcomeHint, "possible_goal_unconfirmed");
  assert.equal(goalEvidence.events[0].combinedGoalConfirmation, false);
});

test("goal evidence supplemental windows are safe and merge back into visual signals", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 44, end: 45, text: "Goal confirmed, it counts" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 34, end: 36, types: ["ball_in_net"], confidence: 0.9 },
        { start: 44, end: 45, types: ["scoreboard_goal_confirmed"], confidence: 0.86 },
      ],
    },
  });
  const visualSignals = mergeGoalEvidenceIntoVisualSignals({
    providerMode: "fixture-visual",
    fallbackUsed: false,
    windows: [
      { start: 34, end: 36, types: ["ball_in_net"], confidence: 0.9 },
      { start: 44, end: 45, types: ["scoreboard_goal_confirmed"], confidence: 0.86 },
    ],
  }, goalEvidence, metadata);

  const reasons = visualSignals.windows.flatMap(visualReasonCodesForWindow);
  assert.ok(reasons.includes("visual_ball_in_net"));
  assert.ok(reasons.includes("visual_scoreboard_goal_confirmed"));
  assert.doesNotMatch(JSON.stringify(visualSignals), /\/Users|storageKey|localPath|token|secret/i);
});

test("scoreboard OCR score change confirms goal only with temporal consistency and ball-in-net", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 42.5, end: 44.1, text: "The scoreboard changes after the finish" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 30, end: 32, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
        { start: 34, end: 35.2, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.92 },
      ],
    },
    scoreboardOcr: [{
      timestamp: 43,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      temporalConsistency: true,
      confidence: 0.88,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
  });

  assert.equal(goalEvidence.summary.validGoalCount, 1);
  assert.equal(goalEvidence.summary.ocrEvidenceCount, 1);
  assert.equal(goalEvidence.summary.scoreboardConfirmedGoalCount, 1);
  assert.equal(goalEvidence.summary.ocrQaUsable, true);
  assert.equal(goalEvidence.events[0].outcomeHint, "valid_goal");
  assert.ok(goalEvidence.events[0].reasonCodes.includes("scoreboard_ocr_score_change"));
  assert.equal(goalEvidence.events[0].scoreboardOcrEvidence, true);
  assert.equal(goalEvidence.events[0].scoreboardGoalConfirmed, true);
});

test("scoreboard OCR score reversion marks ball-in-net as disallowed instead of counted", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 43.5, end: 45.1, text: "The scoreboard returns after the flag" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 30, end: 32, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
        { start: 34, end: 35.2, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.92 },
      ],
    },
    scoreboardOcr: [{
      timestamp: 43,
      scoreBefore: "1-0",
      scoreAfter: "0-0",
      temporalConsistency: true,
      confidence: 0.88,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
  });

  assert.equal(goalEvidence.summary.validGoalCount, 0);
  assert.equal(goalEvidence.summary.offsideOrNoGoalCount, 1);
  assert.equal(goalEvidence.summary.scoreboardGoalRemovedCount, 1);
  assert.equal(goalEvidence.ocrEvidence[0].status, "goal_removed");
  assert.equal(goalEvidence.ocrEvidence[0].scoreChanged, false);
  assert.equal(goalEvidence.ocrEvidence[0].scoreReverted, true);
  assert.equal(goalEvidence.events[0].outcomeHint, "offside_goal");
  assert.ok(goalEvidence.events[0].reasonCodes.includes("scoreboard_ocr_goal_removed"));
  assert.ok(goalEvidence.events[0].reasonCodes.includes("scoreboard_ocr_score_unchanged"));
});

test("scoreboard OCR score change can recover a missed ball-in-net goal only with nearby shot evidence", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata: { ...metadata, durationSeconds: 140 },
    transcript: {
      captions: [{ start: 96.8, end: 98.1, text: "The scoreboard changes after the finish" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 82, end: 83.4, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
        { start: 84.2, end: 85.5, types: ["goal_mouth_visible"], confidence: 0.82 },
      ],
    },
    scoreboardOcr: [{
      timestamp: 97,
      scoreBefore: "1-1",
      scoreAfter: "2-1",
      status: "score_changed",
      temporalConsistency: true,
      confidence: 0.9,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
  });

  const recoveredGoal = goalEvidence.events.find((event) => event.outcomeHint === "valid_goal");
  assert.equal(goalEvidence.summary.validGoalCount, 1);
  assert.ok(recoveredGoal);
  assert.equal(recoveredGoal.ballInNetEvidence, false);
  assert.equal(recoveredGoal.scoreboardBackedGoalSequence, true);
  assert.ok(recoveredGoal.reasonCodes.includes("scoreboard_backed_goal_sequence"));
  assert.ok(recoveredGoal.reasonCodes.includes("scoreboard_ocr_score_change"));
});

test("scoreboard OCR score change can anchor a delayed confirmation to earlier live action", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata: { ...metadata, durationSeconds: 180 },
    transcript: {
      captions: [{ start: 126, end: 128, text: "The scoreboard changes after the finish" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 82, end: 84, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.91 },
        { start: 86, end: 88, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.93 },
      ],
    },
    scoreboardOcr: [{
      timestamp: 126,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      temporalConsistency: true,
      confidence: 0.93,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
  });

  const recoveredGoal = goalEvidence.events.find((event) => event.outcomeHint === "valid_goal");

  assert.ok(recoveredGoal);
  assert.equal(goalEvidence.summary.validGoalCount, 1);
  assert.equal(goalEvidence.summary.scoreChangeAnchorsFound, 1);
  assert.equal(goalEvidence.summary.anchorsWithLiveActionEvidence, 1);
  assert.equal(goalEvidence.summary.anchorsRejected, 0);
  assert.equal(goalEvidence.summary.ocrOnlyBlockedCount, 0);
  assert.equal(goalEvidence.summary.missingActionEvidenceCount, 0);
  assert.equal(recoveredGoal.scoreboardBackedGoalSequence, true);
  assert.equal(recoveredGoal.start, 82);
  assert.ok(recoveredGoal.end >= 128);
  assert.ok(recoveredGoal.reasonCodes.includes("live_shot_finish_sequence"));
  assert.equal(findSensitiveLeakSafe(publicGoalEvidence(goalEvidence)), null);
});

test("goal evidence provider keeps late source-wide counted goals under bounded caps", () => {
  const durationSeconds = 520;
  const scoreChanges = Array.from({ length: 36 }, (_, index) => 30 + index * 13);
  const visualWindows = scoreChanges.flatMap((timestamp, index) => ([
    { start: timestamp - 13, end: timestamp - 12, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.82 + (index % 3) * 0.02 },
    { start: timestamp - 11.5, end: timestamp - 10.5, types: ["goal_mouth_visible"], confidence: 0.8 },
  ]));
  const goalEvidence = deterministicGoalEvidence({
    metadata: { ...metadata, durationSeconds },
    transcript: { captions: [] },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: visualWindows,
    },
    scoreboardOcr: scoreChanges.map((timestamp, index) => ({
      timestamp,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      temporalConsistency: true,
      confidence: 0.78 + (index % 4) * 0.02,
    })),
    ocrQaCalibration: strongOcrQaCalibration(),
  });

  const validGoals = goalEvidence.events.filter((event) => event.outcomeHint === "valid_goal");
  assert.equal(goalEvidence.events.length <= 32, true);
  assert.ok(validGoals.length >= 24);
  assert.ok(validGoals.some((event) => event.start > durationSeconds * 0.85));
  assert.ok(validGoals[validGoals.length - 1].start > durationSeconds * 0.85);
  assert.equal(goalEvidence.summary.validGoalCount, validGoals.length);
  assert.equal(findSensitiveLeakSafe(publicGoalEvidence(goalEvidence)), null);
});

function findSensitiveLeakSafe(value) {
  const text = JSON.stringify(value);
  return /\/Users|storageKey|localPath|token|secret|stderr|stdout/i.test(text) ? { text } : null;
}

test("scoreboard OCR score change alone remains non-goal without nearby shot evidence", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata: { ...metadata, durationSeconds: 140 },
    transcript: {
      captions: [{ start: 96.8, end: 98.1, text: "The scoreboard changes" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 92, end: 94, types: ["crowd_reaction"], confidence: 0.82 },
      ],
    },
    scoreboardOcr: [{
      timestamp: 97,
      scoreBefore: "1-1",
      scoreAfter: "2-1",
      status: "score_changed",
      temporalConsistency: true,
      confidence: 0.9,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
  });

  assert.equal(goalEvidence.summary.validGoalCount, 0);
  assert.equal(goalEvidence.events.some((event) => event.reasonCodes.includes("scoreboard_backed_goal_sequence")), false);
});

test("ambiguous OCR does not promote a ball-in-net moment to valid goal", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 42.5, end: 44.1, text: "The crowd waits for the decision" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 30, end: 32, types: ["shot_contact", "ball_toward_goal"], confidence: 0.9 },
        { start: 34, end: 35.2, types: ["ball_in_net"], confidence: 0.92 },
      ],
    },
    scoreboardOcr: [{
      timestamp: 43,
      detectedScoreText: "1-?",
      status: "ambiguous",
      confidence: 0.42,
    }],
  });

  assert.equal(goalEvidence.summary.validGoalCount, 0);
  assert.equal(goalEvidence.summary.unconfirmedGoalCount, 1);
  assert.equal(goalEvidence.summary.ambiguousOcrCount, 1);
  assert.equal(goalEvidence.events[0].outcomeHint, "possible_goal_unconfirmed");
  assert.ok(goalEvidence.events[0].reasonCodes.includes("scoreboard_ocr_ambiguous"));
});

test("scoreboard OCR unchanged after ball-in-net supports no-goal context", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 43, end: 44, text: "The decision is still being checked" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 30, end: 32, types: ["shot_contact", "ball_toward_goal"], confidence: 0.9 },
        { start: 34, end: 35.2, types: ["ball_in_net"], confidence: 0.92 },
      ],
    },
    scoreboardOcr: [{
      timestamp: 43,
      scoreBefore: "0-0",
      scoreAfter: "0-0",
      status: "score_unchanged",
      temporalConsistency: true,
      confidence: 0.82,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
  });

  assert.equal(goalEvidence.summary.validGoalCount, 0);
  assert.equal(goalEvidence.summary.offsideOrNoGoalCount, 1);
  assert.equal(goalEvidence.summary.ocrQaUsable, true);
  assert.equal(goalEvidence.events[0].outcomeHint, "offside_goal");
  assert.ok(goalEvidence.events[0].reasonCodes.includes("scoreboard_ocr_score_unchanged"));
  assert.equal(goalEvidence.events[0].VARNoGoalSignal, true);
});

test("celebration-only and anthem/intro evidence are explicit non-goal outcomes", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata: { ...metadata, durationSeconds: 120 },
    transcript: {
      captions: [
        { start: 8, end: 10, text: "The anthem plays before kick off" },
        { start: 54, end: 55, text: "The players celebrate with the fans" },
      ],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 52, end: 55, types: ["celebration_after_shot", "crowd_reaction"], confidence: 0.88 },
      ],
    },
  });

  assert.equal(goalEvidence.summary.validGoalCount, 0);
  assert.equal(goalEvidence.summary.celebrationOnlyCount, 1);
  assert.equal(goalEvidence.summary.anthemOrIntroCount, 1);
  assert.deepEqual(goalEvidence.events.map((event) => event.outcomeHint).sort(), ["anthem_or_intro", "celebration_only"]);
});

test("OCR evidence contract normalizes score changes without raw text leaks", () => {
  const ocr = normalizeOcrEvidence([{
    timestamp: 22,
    scoreBefore: { home: 1, away: 1 },
    scoreAfter: { home: 2, away: 1 },
    source: "provider",
    confidence: 0.91,
    temporalConsistency: true,
  }], metadata);

  assert.equal(ocr.length, 1);
  assert.equal(ocr[0].scoreChanged, true);
  assert.equal(ocr[0].scoreBefore, "1-1");
  assert.equal(ocr[0].scoreAfter, "2-1");
  assert.doesNotMatch(JSON.stringify(ocr), /\/Users|storageKey|localPath|token|secret|stderr|stdout/i);
});

test("goal evidence contract rejects unsafe provider output", () => {
  assert.throws(
    () => validateGoalEvidenceOutput({
      providerMode: "external-goal-evidence-adapter",
      fallbackUsed: false,
      events: [{
        id: "bad",
        start: 1,
        end: 2,
        outcomeHint: "valid_goal",
        confidence: 0.9,
        evidenceSource: "/Users/example/private",
        reasonCodes: ["ball_in_net", "visual_scoreboard_goal_confirmed"],
      }],
    }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
});

test("goal evidence provider cancellation is fail-closed", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    analyzeGoalEvidence({
      mode: "external",
      metadata,
      signal: controller.signal,
      client: {
        analyzeGoalEvidence: () => new Promise(() => {}),
      },
    }),
    (error) => error.code === "JOB_CANCELLED",
  );
});
