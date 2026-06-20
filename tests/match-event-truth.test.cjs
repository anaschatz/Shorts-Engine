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

test("classifies scoreboard score reversion after ball-in-net as disallowed goal", () => {
  const result = analyzeMatchEventTruth({
    metadata,
    visualSignals: visualSignals([
      { start: 58, end: 59.5, type: "shot_contact", confidence: 0.9 },
      { start: 59, end: 61, type: "ball_toward_goal", confidence: 0.88 },
      { start: 62, end: 64, type: "ball_in_net", confidence: 0.92 },
      { start: 70, end: 72, type: "scoreboard_goal_removed", confidence: 0.9 },
    ]),
    scoreboardOcr: [{
      timestamp: 71,
      scoreBefore: "1-0",
      scoreAfter: "0-0",
      confidence: 0.91,
      temporalConsistency: true,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([{
      id: "score_reverted_goal",
      start: 58,
      end: 72,
      confidence: 0.9,
      outcomeHint: "offside_goal",
      reasonCodes: [
        "visual_shot_contact",
        "visual_ball_toward_goal",
        "visual_ball_in_net",
        "scoreboard_ocr_goal_removed",
        "scoreboard_ocr_score_unchanged",
      ],
      ballInNetEvidence: true,
      VARNoGoalSignal: true,
    }]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.summary.disallowedGoalCount, 1);
  assert.equal(result.events[0].type, "disallowed_offside");
  assert.equal(result.events[0].truth.evidence.scoreboardReverted, true);
  assert.equal(result.events[0].truth.disallowed, true);
  assert.ok(result.events[0].evidenceCodes.includes("scoreboard_ocr_goal_removed"));
});

test("confirms scoreboard-backed goal sequence when shot evidence and score change agree", () => {
  const result = analyzeMatchEventTruth({
    metadata,
    visualSignals: visualSignals([
      { start: 204, end: 205.5, type: "shot_contact", confidence: 0.9 },
      { start: 205, end: 207, type: "ball_toward_goal", confidence: 0.88 },
      { start: 208, end: 210, type: "goal_mouth_visible", confidence: 0.82 },
    ]),
    scoreboardOcr: [{
      timestamp: 221,
      status: "score_changed",
      scoreBefore: "1-1",
      scoreAfter: "2-1",
      confidence: 0.94,
      temporalConsistency: true,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([{
      id: "scoreboard_backed_late_goal",
      start: 204,
      end: 222,
      confidence: 0.88,
      outcomeHint: "valid_goal",
      reasonCodes: ["scoreboard_backed_goal_sequence", "shot_sequence_support", "scoreboard_ocr_score_change"],
      scoreboardGoalConfirmed: true,
      scoreboardBackedGoalSequence: true,
    }]),
  });

  assert.equal(result.summary.confirmedGoalCount, 1);
  assert.equal(result.summary.lateConfirmedGoalCount, 1);
  assert.equal(result.summary.noFalseGoalFromOcrOnly, 1);
  assert.equal(result.events[0].type, "confirmed_goal");
  assert.ok(result.events[0].evidenceCodes.includes("scoreboard_backed_goal_sequence"));
  assert.ok(result.events[0].missingEvidence.every((code) => code !== "ball_in_net_evidence"));
});

test("confirms combined live finish evidence without OCR while keeping truth details safe", () => {
  const result = analyzeMatchEventTruth({
    metadata,
    visualSignals: visualSignals([
      { start: 104, end: 105.5, type: "shot_contact", confidence: 0.9 },
      { start: 105, end: 107, type: "ball_toward_goal", confidence: 0.88 },
      { start: 108, end: 110, type: "ball_in_net", confidence: 0.92 },
      { start: 112, end: 114, type: "crowd_reaction", confidence: 0.86 },
    ]),
    goalEvidence: goalEvidence([{
      id: "combined_live_goal",
      start: 104,
      end: 123,
      confidence: 0.88,
      outcomeHint: "valid_goal",
      reasonCodes: [
        "ball_in_net",
        "visual_ball_in_net",
        "shot_sequence_support",
        "live_shot_finish_sequence",
        "crowd_reaction_support",
        "combined_goal_confirmation",
      ],
      ballInNetEvidence: true,
      crowdReactionSupport: true,
      combinedGoalConfirmation: true,
    }]),
  });

  assert.equal(result.summary.confirmedGoalCount, 1);
  assert.equal(result.summary.noFalseGoalFromOcrOnly, 1);
  assert.equal(result.events[0].type, "confirmed_goal");
  assert.equal(result.events[0].truth.outcome, "confirmed_goal");
  assert.equal(result.events[0].truth.evidence.combinedGoalConfirmation, true);
  assert.equal(result.events[0].truth.evidence.scoreboardChange, false);
  assert.equal(result.events[0].truth.disallowed, false);
  assert.ok(result.events[0].phaseCoverage.hasShot);
  assert.ok(result.events[0].phaseCoverage.hasFinish);
  assert.ok(result.events[0].phaseCoverage.hasConfirmation);
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
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

test("recovers bounded YouTube valid-goal candidates from source-wide action clusters", () => {
  const result = analyzeMatchEventTruth({
    metadata: {
      durationSeconds: 360,
      width: 1920,
      height: 1080,
      sourceType: "youtube",
      goalSelectionMode: "valid_goals_only",
      allowCandidateClusterRecovery: true,
    },
    mediaSignals: {
      durationSeconds: 360,
      audioPeaks: [
        { time: 134, energyScore: 0.94 },
        { time: 204, energyScore: 0.92 },
        { time: 229, energyScore: 0.88 },
      ],
      sceneChanges: [
        { time: 136, confidence: 0.8 },
        { time: 226, confidence: 0.8 },
      ],
    },
    visualSignals: visualSignals([
      { start: 132, end: 136, types: ["shot_like_motion", "ball_visible", "crowd_reaction"], confidence: 0.84 },
      { start: 150, end: 154, types: ["shot_like_motion", "ball_visible"], confidence: 0.72 },
      { start: 202, end: 206, types: ["shot_like_motion", "ball_visible", "crowd_reaction"], confidence: 0.86 },
      { start: 226, end: 230, types: ["shot_like_motion", "ball_visible", "replay_indicator"], confidence: 0.82 },
    ]),
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.confirmedGoalCount, 3);
  assert.deepEqual(result.events.slice(0, 3).map((event) => event.id), [
    "cluster_recovered_goal_1",
    "cluster_recovered_goal_2",
    "cluster_recovered_goal_3",
  ]);
  assert.ok(result.events.slice(0, 3).every((event) => event.evidenceCodes.includes("goal_candidate_cluster_recovery")));
  assert.ok(result.events.slice(0, 3).every((event) => event.phaseCoverage.hasBuildup));
  assert.ok(result.events.slice(0, 3).every((event) => event.phaseCoverage.hasShot));
  assert.ok(result.events.slice(0, 3).every((event) => event.phaseCoverage.hasFinish));
  assert.ok(result.events.slice(0, 3).every((event) => event.phaseCoverage.replayOnly === false));
});

test("does not recover crowd-only or non-youtube action clusters as confirmed goals", () => {
  const crowdOnly = analyzeMatchEventTruth({
    metadata: {
      durationSeconds: 360,
      width: 1920,
      height: 1080,
      sourceType: "youtube",
      goalSelectionMode: "valid_goals_only",
    },
    mediaSignals: { durationSeconds: 360, audioPeaks: [{ time: 134, energyScore: 0.94 }], sceneChanges: [] },
    visualSignals: visualSignals([
      { start: 132, end: 136, types: ["crowd_reaction"], confidence: 0.84 },
    ]),
    goalEvidence: goalEvidence([]),
  });
  const nonYoutube = analyzeMatchEventTruth({
    metadata: {
      durationSeconds: 360,
      width: 1920,
      height: 1080,
      sourceType: "upload",
      goalSelectionMode: "valid_goals_only",
    },
    mediaSignals: { durationSeconds: 360, audioPeaks: [{ time: 134, energyScore: 0.94 }], sceneChanges: [] },
    visualSignals: visualSignals([
      { start: 132, end: 136, types: ["shot_like_motion", "ball_visible", "crowd_reaction"], confidence: 0.84 },
    ]),
    goalEvidence: goalEvidence([]),
  });

  assert.equal(crowdOnly.summary.confirmedGoalCount, 0);
  assert.equal(nonYoutube.summary.confirmedGoalCount, 0);
});

test("does not recover YouTube action clusters by default without scoreboard authority", () => {
  const result = analyzeMatchEventTruth({
    metadata: {
      durationSeconds: 360,
      width: 1920,
      height: 1080,
      sourceType: "youtube",
      goalSelectionMode: "valid_goals_only",
    },
    mediaSignals: {
      durationSeconds: 360,
      audioPeaks: [{ time: 134, energyScore: 0.94 }],
      sceneChanges: [{ time: 136, confidence: 0.8 }],
    },
    visualSignals: visualSignals([
      { start: 132, end: 136, types: ["shot_like_motion", "ball_visible", "crowd_reaction"], confidence: 0.84 },
      { start: 202, end: 206, types: ["shot_like_motion", "ball_visible", "crowd_reaction"], confidence: 0.86 },
      { start: 226, end: 230, types: ["shot_like_motion", "ball_visible", "replay_indicator"], confidence: 0.82 },
    ]),
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.ok(result.events.every((event) => event.type !== "confirmed_goal"));
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
  assert.equal(publicTruth.selectedEvents[0].eventType, "valid_goal");
  assert.equal(publicTruth.selectedEvents[0].truthStatus, "valid_goal");
  assert.equal(publicTruth.selectedEvents[0].decisionWindowStart, null);
  assert.deepEqual(publicTruth.selectedEvents[0].disqualifiers, []);
  assert.ok(publicTruth.selectedEvents[0].evidence.includes("visual_ball_in_net"));
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

test("public truth contract marks disallowed goals with safe disqualifiers", () => {
  const truth = validateMatchEventTruthOutput({
    providerMode: "unit-truth",
    fallbackUsed: false,
    ocrQaCalibration: strongOcrQaCalibration(),
    events: [{
      id: "safe_offside_event",
      type: "disallowed_offside",
      outcome: "disallowed_offside",
      confidence: 0.9,
      sourceStart: 72,
      sourceEnd: 88,
      decisionWindow: { start: 82, end: 88 },
      evidenceCodes: ["visual_ball_in_net", "visual_offside_flag", "scoreboard_ocr_score_unchanged"],
      safetyFlags: ["no_confirmed_goal_caption"],
      renderPriority: 740,
    }],
    rejectedEvents: [],
  }, metadata);
  const publicTruth = publicMatchEventTruth(truth);
  const event = publicTruth.selectedEvents[0];

  assert.equal(event.eventType, "disallowed_goal");
  assert.equal(event.truthStatus, "disallowed_goal");
  assert.equal(event.decisionWindowStart, 82);
  assert.equal(event.decisionWindowEnd, 88);
  assert.ok(event.disqualifiers.includes("offside"));
  assert.ok(event.disqualifiers.includes("no_goal_decision"));
  assert.doesNotMatch(JSON.stringify(publicTruth), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
});
