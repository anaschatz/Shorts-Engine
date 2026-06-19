const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeMatchEventTruth,
  publicMatchEventTruth,
  validateMatchEventTruthOutput,
} = require("../server/match-event-truth.cjs");

const metadata = Object.freeze({
  durationSeconds: 240,
  width: 1920,
  height: 1080,
});

function strongOcrQaCalibration() {
  return {
    schemaVersion: 1,
    status: "available",
    available: true,
    stale: false,
    invalid: false,
    usable: true,
    decisionSupportLevel: "strong",
    scoreboardCropQuality: "high",
    operatorDecision: "useful",
    goalEvidencePolicy: "support_only",
    goalDecisionAllowed: false,
    noFalseGoalFromOcrOnly: true,
    supportWeight: 1,
    generatedAt: "2026-06-19T10:00:00.000Z",
    reasonCode: "ocr_qa_strong",
  };
}

function visualSignals(windows) {
  return {
    providerMode: "fixture-vision",
    fallbackUsed: false,
    confidence: 0.88,
    providerMetadata: { latencyMs: 0 },
    windows,
  };
}

function goalEvidence(events) {
  return {
    providerMode: "fixture-goal-evidence",
    fallbackUsed: false,
    confidence: 0.9,
    events,
    supplementalVisualWindows: [],
    summary: {
      eventCount: events.length,
      validGoalCount: 0,
      offsideOrNoGoalCount: 0,
      unconfirmedGoalCount: 0,
      nonGoalChanceCount: 0,
      celebrationOnlyCount: 0,
      anthemOrIntroCount: 0,
      ocrEvidenceCount: 0,
      scoreboardConfirmedGoalCount: 0,
      ambiguousOcrCount: 0,
      goalEvidenceCoverage: 0,
    },
    ocrQaCalibration: strongOcrQaCalibration(),
  };
}

test("confirms a late goal only when action evidence and decision support agree", () => {
  const result = analyzeMatchEventTruth({
    metadata,
    visualSignals: visualSignals([
      { start: 208, end: 209.5, type: "shot_contact", confidence: 0.9 },
      { start: 209, end: 211, type: "ball_toward_goal", confidence: 0.88 },
      { start: 211, end: 213, type: "ball_in_net", confidence: 0.92 },
      { start: 214, end: 216, type: "scoreboard_goal_confirmed", confidence: 0.9 },
    ]),
    scoreboardOcr: [{
      timestamp: 215,
      status: "score_changed",
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      confidence: 0.94,
      temporalConsistency: true,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([{
      id: "late_valid_goal",
      start: 208,
      end: 216,
      confidence: 0.91,
      outcomeHint: "valid_goal",
      reasonCodes: ["visual_shot_contact", "visual_ball_toward_goal", "visual_ball_in_net", "scoreboard_ocr_score_change"],
      ballInNetEvidence: true,
      scoreboardGoalConfirmed: true,
    }]),
  });

  assert.equal(result.summary.confirmedGoalCount, 1);
  assert.equal(result.summary.lateConfirmedGoalCount, 1);
  assert.equal(result.summary.noFalseGoalFromOcrOnly, 1);
  assert.equal(result.events[0].type, "confirmed_goal");
  assert.ok(result.events[0].sourceStart <= 208);
  assert.ok(result.events[0].sourceEnd >= 216);
  assert.ok(result.events[0].evidenceCodes.includes("visual_ball_in_net"));
});

test("keeps OCR-only score changes out of confirmed-goal decisions", () => {
  const result = analyzeMatchEventTruth({
    metadata,
    visualSignals: visualSignals([
      { start: 58, end: 60, type: "scoreboard_context", confidence: 0.7 },
    ]),
    scoreboardOcr: [{
      timestamp: 60,
      status: "score_changed",
      scoreBefore: "1-1",
      scoreAfter: "2-1",
      confidence: 0.9,
      temporalConsistency: true,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([{
      id: "ocr_only_score_change",
      start: 58,
      end: 62,
      confidence: 0.82,
      reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
      scoreboardGoalConfirmed: true,
    }]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.summary.noFalseGoalFromOcrOnly, 1);
  assert.ok(result.rejectedEvents.every((event) => event.type !== "confirmed_goal"));
});

test("classifies ball-in-net plus offside/decision evidence as disallowed", () => {
  const result = analyzeMatchEventTruth({
    metadata,
    visualSignals: visualSignals([
      { start: 75, end: 77, type: "shot_contact", confidence: 0.86 },
      { start: 77, end: 79, type: "ball_in_net", confidence: 0.9 },
      { start: 81, end: 83, type: "assistant_referee_flag", confidence: 0.87 },
      { start: 83, end: 86, type: "offside_line_replay", confidence: 0.84 },
    ]),
    scoreboardOcr: [{
      timestamp: 84,
      status: "score_unchanged",
      scoreBefore: "0-0",
      scoreAfter: "0-0",
      confidence: 0.88,
      temporalConsistency: true,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([{
      id: "offside_goal",
      start: 75,
      end: 86,
      confidence: 0.86,
      outcomeHint: "offside_goal",
      reasonCodes: ["visual_shot_contact", "visual_ball_in_net", "visual_offside_flag", "scoreboard_ocr_score_unchanged"],
      ballInNetEvidence: true,
      offsideFlag: true,
    }]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.summary.disallowedGoalCount, 1);
  assert.equal(result.events[0].type, "disallowed_offside");
  assert.equal(result.events[0].outcome, "disallowed_offside");
  assert.ok(result.events[0].decisionWindow);
  assert.ok(result.events[0].safetyFlags.includes("no_confirmed_goal_caption"));
});

test("treats celebration/crowd reaction without action evidence as support only", () => {
  const result = analyzeMatchEventTruth({
    metadata,
    visualSignals: visualSignals([
      { start: 20, end: 23, type: "crowd_reaction", confidence: 0.8 },
      { start: 23, end: 26, type: "celebration_after_shot", confidence: 0.78 },
    ]),
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([{
      id: "celebration_only",
      start: 20,
      end: 26,
      confidence: 0.74,
      outcomeHint: "celebration_only",
      reasonCodes: ["visual_crowd_reaction", "visual_celebration_after_shot"],
      crowdReactionSupport: true,
    }]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.ok(result.events.some((event) => event.type === "crowd_reaction"));
  assert.ok(result.rejectedEvents.some((event) => event.safetyFlags.includes("reaction_support_only")));
});

test("public truth reports keep safe late-goal summary and reject leaks", () => {
  const truth = validateMatchEventTruthOutput({
    providerMode: "unit-truth",
    fallbackUsed: false,
    ocrQaCalibration: strongOcrQaCalibration(),
    events: [{
      id: "safe_event",
      type: "confirmed_goal",
      outcome: "confirmed_goal",
      confidence: 0.9,
      sourceStart: 210,
      sourceEnd: 225,
      evidenceCodes: ["visual_ball_in_net", "scoreboard_ocr_score_change"],
      safetyFlags: ["no_false_goal_from_ocr_only"],
      renderPriority: 1000,
    }],
    rejectedEvents: [],
  }, metadata);
  const publicTruth = publicMatchEventTruth(truth);

  assert.equal(publicTruth.summary.lateConfirmedGoalCount, 1);
  assert.doesNotMatch(JSON.stringify(publicTruth), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
  assert.throws(
    () => validateMatchEventTruthOutput({
      events: [{
        id: "leaky_event",
        type: "confirmed_goal",
        outcome: "confirmed_goal",
        confidence: 0.9,
        sourceStart: 1,
        sourceEnd: 5,
        evidenceCodes: ["/Users/example/raw-frame.jpg"],
      }],
    }, metadata),
    (error) => error && error.code === "AI_OUTPUT_INVALID",
  );
});
