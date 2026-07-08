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

test("scoreboard truth accepts home or away scoring in chronological source order", () => {
  const goals = [
    { shot: 28, finish: 31, confirm: 42, scoreBefore: "0-0", scoreAfter: "0-1", scoringSide: "away" },
    { shot: 76, finish: 79, confirm: 91, scoreBefore: "0-1", scoreAfter: "0-2", scoringSide: "away" },
    { shot: 132, finish: 135, confirm: 148, scoreBefore: "0-2", scoreAfter: "1-2", scoringSide: "home" },
  ];
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 180, goalSelectionMode: "valid_goals_only" },
    visualSignals: visualSignals(goals.flatMap((goal) => [
      { start: goal.shot - 8, end: goal.shot - 6, types: ["fast_break_motion", "ball_visible"], confidence: 0.86 },
      { start: goal.shot, end: goal.shot + 1.5, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: goal.finish, end: goal.finish + 1.5, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.94 },
      { start: goal.confirm, end: goal.confirm + 1, types: ["scoreboard_goal_confirmed"], confidence: 0.9 },
    ])),
    scoreboardOcr: goals.map((goal, index) => ({
      id: `side_agnostic_score_change_${index + 1}`,
      timestamp: goal.confirm,
      scoreBefore: goal.scoreBefore,
      scoreAfter: goal.scoreAfter,
      status: "score_changed",
      confidence: 0.92,
      temporalConsistency: true,
      scoreChanged: true,
      source: "local_scorebug_digit_reader_gray_line",
    })),
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  const confirmed = result.events.filter((event) => event.type === "confirmed_goal");
  assert.equal(result.summary.countedGoalEventCount, 3);
  assert.equal(result.summary.selectedCountedGoals, 3);
  assert.deepEqual(confirmed.map((event) => event.scoreAfter), ["0-1", "0-2", "1-2"]);
  assert.deepEqual(confirmed.map((event) => event.scoringSide), ["away", "away", "home"]);
  assert.deepEqual(confirmed.map((event) => event.scoreChangeTime), [42, 91, 148]);
  assert.ok(confirmed.every((event) => event.sourceStart <= event.scoreChangeTime - 20));
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
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

test("turns stable scorebug score increase into counted goal truth when live action exists", () => {
  const result = analyzeMatchEventTruth({
    metadata,
    visualSignals: visualSignals([
      { start: 126, end: 128, types: ["ball_visible", "shot_contact"], confidence: 0.9 },
      { start: 128, end: 131, types: ["ball_toward_goal", "goal_mouth_visible"], confidence: 0.88 },
      { start: 132, end: 134, type: "ball_in_net", confidence: 0.9 },
    ]),
    scoreboardOcr: [{
      id: "scorebug_counted_goal",
      timestamp: 141,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      confidence: 0.93,
      temporalConsistency: true,
      source: "local_scorebug_digit_reader_gray_line",
      imageDecoderStatus: "decoded",
      imageSegmentationStatus: "readable",
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.confirmedGoalCount, 1);
  assert.equal(result.summary.scoreTimelineObservationCount, 1);
  assert.equal(result.summary.countedGoalEventCount, 1);
  assert.equal(result.summary.stableScoreChangeAnchorCount, 1);
  assert.equal(result.summary.anchorsLinkedToGoalPhaseCount, 1);
  assert.equal(result.summary.anchorsMissingVisualSupportCount, 0);
  assert.equal(result.summary.selectedGoalCount, 1);
  assert.equal(result.summary.decoderStatusSummary.decoded, 1);
  assert.equal(result.scoreChanges[0].outcome, "counted_goal");
  assert.equal(result.scoreChangeAnchors[0].scoreBefore, "0-0");
  assert.equal(result.scoreChangeAnchors[0].scoreAfter, "1-0");
  assert.equal(result.scoreChangeAnchors[0].source, "scoreboard_ocr");
  assert.equal(result.scoreChangeAnchors[0].selectedForRender, true);
  assert.equal(result.scoreChangeAnchors[0].hasLiveAction, true);
  assert.equal(result.scoreChangeAnchors[0].hasVisibleFinish, true);
  assert.equal(result.scoreChangeAnchors[0].replayOnly, false);
  assert.equal(result.events[0].type, "confirmed_goal");
  assert.equal(result.events[0].scoreBefore, "0-0");
  assert.equal(result.events[0].scoreAfter, "1-0");
  assert.ok(result.events[0].evidenceCodes.includes("scoreboard_ocr_score_change"));
  assert.ok(result.events[0].evidenceCodes.includes("scoreboard_backed_goal_sequence"));
  assert.equal(result.events[0].phaseCoverage.replayOnly, false);
  assert.ok(result.events[0].phaseCoverage.hasShot);
  assert.ok(result.events[0].phaseCoverage.hasConfirmation);
});

test("links delayed scorebug changes back to earlier live goal action", () => {
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 180 },
    visualSignals: visualSignals([
      { start: 82, end: 84, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.91 },
      { start: 86, end: 88, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.93 },
      { start: 126, end: 127, types: ["scoreboard_goal_confirmed"], confidence: 0.88 },
    ]),
    scoreboardOcr: [
      {
        id: "delayed_pending_counted_goal",
        timestamp: 90,
        scoreBefore: "0-0",
        scoreAfter: "1-0",
        status: "ambiguous",
        confidence: 0.86,
        temporalConsistency: false,
        ambiguous: true,
        transitionDecision: "score_change_pending_confirmation",
        transitionReasonCodes: ["unit_score_increase_candidate"],
      },
      {
        id: "delayed_counted_goal",
        timestamp: 126,
        scoreBefore: "0-0",
        scoreAfter: "1-0",
        status: "score_changed",
        confidence: 0.93,
        temporalConsistency: true,
      },
    ],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  const publicTruth = publicMatchEventTruth(result);

  assert.equal(result.summary.confirmedGoalCount, 1);
  assert.equal(result.summary.scoreChangeAnchorsFound, 1);
  assert.equal(result.summary.anchorsWithLiveActionEvidence, 1);
  assert.equal(result.summary.selectedCountedGoals, 1);
  assert.equal(result.summary.stableScoreChangeAnchorCount, 1);
  assert.equal(result.summary.anchorsLinkedToGoalPhaseCount, 1);
  assert.equal(result.summary.anchorsMissingVisualSupportCount, 0);
  assert.equal(result.summary.anchorsRejected, 0);
  assert.equal(result.summary.ocrOnlyBlockedCount, 0);
  assert.equal(result.events[0].scoreChangeTime, 126);
  assert.equal(result.events[0].cannotConfirmGoalAlone, true);
  assert.ok(result.events[0].sourceStart <= 82);
  assert.ok(result.events[0].sourceEnd >= 91);
  assert.ok(result.events[0].sourceEnd < 126);
  assert.equal(result.events[0].phaseCoverage.replayOnly, false);
  assert.ok(result.events[0].evidenceCodes.includes("scoreboard_confirmation_decoupled_from_clip_tail"));
  assert.ok(result.events[0].anchorDiagnostics.searchWindow.start <= 82);
  assert.ok(result.events[0].anchorDiagnostics.searchWindow.end >= 126);
  assert.equal(publicTruth.summary.selectedCountedGoals, 1);
  assert.equal(publicTruth.summary.stableScoreChangeAnchorCount, 1);
  assert.equal(publicTruth.scoreChangeAnchors[0].selectedForRender, true);
  assert.equal(publicTruth.scoreChangeAnchors[0].firstSeenAt, 90);
  assert.equal(publicTruth.scoreChangeAnchors[0].confirmedAt, 126);
  assert.equal(publicTruth.scoreChangeAnchors[0].stableUntil, 134);
  assert.doesNotMatch(JSON.stringify(publicTruth), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
});

test("score-change recovery rejects scoreboard-only finish even with stable OCR", () => {
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 180, sourceType: "youtube", goalSelectionMode: "valid_goals_only" },
    visualSignals: visualSignals([
      { start: 124, end: 126, type: "scoreboard_goal_confirmed", confidence: 0.9 },
      { start: 126, end: 128, type: "scoreboard_context", confidence: 0.82 },
    ]),
    scoreboardOcr: [{
      id: "scoreboard_only_stable_score",
      timestamp: 126,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      confidence: 0.93,
      temporalConsistency: true,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.summary.countedGoalEventCount, 1);
  assert.equal(result.summary.stableScoreChangeAnchorCount, 1);
  assert.equal(result.summary.selectedCountedGoals, 0);
  assert.equal(result.summary.anchorsRejected, 1);
  assert.equal(result.summary.anchorsMissingVisualSupportCount, 1);
  assert.equal(result.scoreChangeAnchors[0].selectedForRender, false);
  assert.equal(result.scoreChangeAnchors[0].hasVisibleFinish, false);
  assert.ok(result.scoreChangeAnchors[0].missingEvidence.includes("visible_goal_phase"));
  assert.ok(result.rejectedEvents.some((event) => event.anchorDiagnostics.visibleGoalRecovery.failureCode === "SCOREBOARD_ONLY"));
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
});

test("score-change recovery selects visible finish over later replay and celebration", () => {
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 220, sourceType: "youtube", goalSelectionMode: "valid_goals_only" },
    visualSignals: visualSignals([
      { start: 92, end: 94, types: ["fast_break_motion", "ball_visible"], confidence: 0.86 },
      { start: 102, end: 104, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: 106, end: 108, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.94 },
      { start: 118, end: 120, types: ["scoreboard_goal_confirmed", "referee_goal_signal"], confidence: 0.9 },
      { start: 124, end: 128, types: ["replay_indicator", "replay_angle", "ball_in_net"], confidence: 0.88 },
      { start: 127, end: 128, type: "celebration_after_shot", confidence: 0.86 },
    ]),
    scoreboardOcr: [{
      id: "visible_score_change",
      timestamp: 120,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      confidence: 0.93,
      temporalConsistency: true,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.confirmedGoalCount, 1);
  assert.equal(result.summary.selectedCountedGoals, 1);
  assert.equal(result.events[0].primarySource, "live_action");
  assert.equal(result.events[0].phaseCoverage.replayOnly, false);
  assert.equal(result.events[0].phaseCoverage.visualGoalPayoff.hasVisibleGoalPayoff, true);
  assert.ok(result.events[0].sourceStart <= 102);
  assert.ok(result.events[0].visibleGoalRecovery.rejectedReplayWindows.length >= 1);
  assert.ok(result.events[0].visibleGoalRecovery.rejectedCelebrationWindows.length >= 1);
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
});

test("uses high-motion media support as review context but not visible goal proof", () => {
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 240 },
    mediaSignals: {
      durationSeconds: 240,
      highMotionCandidates: [{ time: 172, confidence: 0.89, source: "fixture" }],
      audioPeaks: [{ time: 177, energyScore: 0.86, source: "fixture" }],
    },
    visualSignals: visualSignals([
      { start: 205, end: 207, type: "scoreboard_context", confidence: 0.7 },
    ]),
    scoreboardOcr: [{
      id: "media_anchored_score_change",
      timestamp: 207,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      confidence: 0.93,
      temporalConsistency: true,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.summary.scoreChangeAnchorsFound, 1);
  assert.equal(result.summary.anchorsWithLiveActionEvidence, 1);
  assert.equal(result.summary.selectedCountedGoals, 0);
  assert.equal(result.summary.ocrOnlyBlockedCount, 1);
  assert.ok(result.rejectedEvents[0].sourceStart <= 168);
  assert.ok(result.rejectedEvents[0].sourceEnd >= 207);
  assert.ok(result.rejectedEvents[0].evidenceCodes.includes("media_high_motion_goal_phase_support"));
  assert.ok(result.rejectedEvents[0].evidenceCodes.includes("scoreboard_backed_goal_sequence"));
  assert.equal(result.rejectedEvents[0].anchorDiagnostics.mediaActionWindowCount, 1);
  assert.equal(result.rejectedEvents[0].anchorDiagnostics.visibleGoalRecovery.failureCode, "SCOREBOARD_ONLY");
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
});

test("uses normalized local OCR scoreChanged rows as anchors without requiring strong QA", () => {
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 360, sourceType: "youtube", goalSelectionMode: "valid_goals_only" },
    mediaSignals: {
      durationSeconds: 360,
      highMotionCandidates: [{ time: 274, confidence: 0.9, source: "fixture" }],
      audioPeaks: [{ time: 280, energyScore: 0.88, source: "fixture" }],
    },
    visualSignals: visualSignals([
      { start: 275, end: 277, type: "scoreboard_context", confidence: 0.7 },
      { start: 295, end: 298, type: "scoreboard_context", confidence: 0.72 },
    ]),
    scoreboardOcr: [
      {
        id: "local_ocr_pending_score_change",
        timestamp: 277,
        scoreBefore: "1-0",
        scoreAfter: "2-0",
        status: "ambiguous",
        confidence: 0.86,
        temporalConsistency: false,
        ambiguous: true,
        transitionDecision: "score_change_pending_confirmation",
        transitionReasonCodes: ["unit_score_increase_candidate"],
      },
      {
        id: "local_ocr_score_change",
        timestamp: 298,
        scoreBefore: "1-0",
        scoreAfter: "2-0",
        status: "score_changed",
        confidence: 0.88,
        temporalConsistency: true,
        scoreChanged: true,
        source: "local-scoreboard-ocr-command",
      },
    ],
    ocrQaCalibration: {
      status: "missing",
      usable: false,
      decisionSupportLevel: "ignore",
      goalEvidencePolicy: "support_only",
      goalDecisionAllowed: false,
      noFalseGoalFromOcrOnly: true,
    },
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.scoreChangeCount, 1);
  assert.equal(result.summary.countedGoalEventCount, 1);
  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.summary.anchorsWithLiveActionEvidence, 1);
  assert.equal(result.summary.selectedCountedGoals, 0);
  assert.equal(result.summary.ocrOnlyBlockedCount, 1);
  assert.equal(result.scoreChanges[0].outcome, "counted_goal");
  assert.equal(result.scoreChanges[0].actionAnchorTime, 277);
  assert.equal(result.scoreChanges[0].hasPendingObservation, true);
  assert.equal(result.rejectedEvents[0].scoreAfter, "2-0");
  assert.ok(result.rejectedEvents[0].evidenceCodes.includes("media_high_motion_goal_phase_support"));
  assert.ok(result.rejectedEvents[0].evidenceCodes.includes("scoreboard_backed_goal_sequence"));
  assert.equal(result.rejectedEvents[0].anchorDiagnostics.visibleGoalRecovery.failureCode, "SCOREBOARD_ONLY");
  assert.equal(result.summary.noFalseGoalFromOcrOnly, 1);
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
});

test("uses first observed pending score increase as action anchor for delayed stable changes", () => {
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 390, sourceType: "youtube", goalSelectionMode: "valid_goals_only" },
    mediaSignals: {
      durationSeconds: 390,
      highMotionCandidates: [{ time: 305, confidence: 0.9, source: "fixture" }],
      audioPeaks: [{ time: 311, energyScore: 0.88, source: "fixture" }],
    },
    visualSignals: visualSignals([
      { start: 318, end: 320, type: "scoreboard_context", confidence: 0.72 },
      { start: 359, end: 361, type: "scoreboard_context", confidence: 0.73 },
    ]),
    scoreboardOcr: [
      {
        id: "third_goal_pending_score",
        timestamp: 318,
        scoreBefore: "2-0",
        scoreAfter: "3-0",
        status: "ambiguous",
        confidence: 0.86,
        temporalConsistency: false,
        ambiguous: true,
        transitionDecision: "score_change_pending_confirmation",
        transitionReasonCodes: ["unit_score_increase_candidate"],
      },
      {
        id: "third_goal_stable_score",
        timestamp: 359,
        scoreBefore: "2-0",
        scoreAfter: "3-0",
        status: "score_changed",
        confidence: 0.9,
        temporalConsistency: true,
        scoreChanged: true,
        source: "local-scoreboard-ocr-command",
      },
    ],
    ocrQaCalibration: {
      status: "missing",
      usable: false,
      decisionSupportLevel: "ignore",
      goalEvidencePolicy: "support_only",
      goalDecisionAllowed: false,
      noFalseGoalFromOcrOnly: true,
    },
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.summary.countedGoalEventCount, 1);
  assert.equal(result.summary.selectedCountedGoals, 0);
  assert.equal(result.summary.ocrOnlyBlockedCount, 1);
  assert.equal(result.scoreChanges[0].changeTime, 359);
  assert.equal(result.scoreChanges[0].actionAnchorTime, 318);
  assert.equal(result.rejectedEvents[0].scoreChangeTime, 359);
  assert.equal(result.rejectedEvents[0].phaseCoverage.confirmationTime, 359);
  assert.ok(result.rejectedEvents[0].sourceStart <= 305);
  assert.ok(result.rejectedEvents[0].sourceEnd >= 360);
  assert.equal(result.rejectedEvents[0].anchorDiagnostics.actionAnchorTime, 318);
  assert.equal(result.rejectedEvents[0].anchorDiagnostics.changeTime, 359);
  assert.equal(result.rejectedEvents[0].anchorDiagnostics.visibleGoalRecovery.failureCode, "SCOREBOARD_ONLY");
  assert.equal(result.summary.noFalseGoalFromOcrOnly, 1);
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
});

test("blocks local OCR score changes without finish support even when action exists", () => {
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 120, sourceType: "youtube", goalSelectionMode: "valid_goals_only" },
    mediaSignals: {
      durationSeconds: 120,
      highMotionCandidates: [{ time: 36, confidence: 0.9, source: "fixture" }],
      audioPeaks: [{ time: 42, energyScore: 0.9, source: "fixture" }],
    },
    visualSignals: visualSignals([
      { start: 32, end: 36, types: ["shot_like_motion", "ball_visible", "goal_area_visible"], confidence: 0.88 },
      { start: 43, end: 45, type: "scoreboard_context", confidence: 0.72 },
    ]),
    scoreboardOcr: [{
      id: "local_ocr_action_no_finish",
      timestamp: 43,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      confidence: 0.88,
      temporalConsistency: true,
      scoreChanged: true,
      source: "local-scoreboard-ocr-command",
    }],
    ocrQaCalibration: {
      status: "missing",
      usable: false,
      decisionSupportLevel: "ignore",
      goalEvidencePolicy: "support_only",
      goalDecisionAllowed: false,
      noFalseGoalFromOcrOnly: true,
    },
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.summary.countedGoalEventCount, 1);
  assert.equal(result.summary.selectedCountedGoals, 0);
  assert.equal(result.summary.ocrOnlyBlockedCount, 1);
  assert.ok(result.rejectedEvents.some((event) => event.missingEvidence.includes("finish_or_stable_score_confirmation")));
  assert.equal(result.summary.noFalseGoalFromOcrOnly, 1);
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
});

test("does not let previous disallowed phase contaminate the next counted goal window", () => {
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 180 },
    visualSignals: visualSignals([
      { start: 61, end: 63, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.91 },
      { start: 65, end: 66.5, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.92 },
      { start: 73, end: 75, types: ["assistant_referee_flag", "offside_line_replay", "referee_no_goal_signal"], confidence: 0.91 },
      { start: 98, end: 100, types: ["fast_break_motion", "ball_visible"], confidence: 0.84 },
      { start: 104, end: 106, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: 108, end: 110, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.94 },
      { start: 118, end: 120, types: ["scoreboard_goal_confirmed", "referee_goal_signal"], confidence: 0.9 },
    ]),
    scoreboardOcr: [{
      timestamp: 120,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      confidence: 0.91,
      temporalConsistency: true,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([{
      id: "next_counted_goal",
      start: 108,
      end: 120,
      confidence: 0.9,
      outcomeHint: "valid_goal",
      reasonCodes: [
        "visual_shot_contact",
        "visual_ball_toward_goal",
        "visual_ball_in_net",
        "scoreboard_ocr_score_change",
        "scoreboard_temporal_consistency",
        "confirmed_by_commentary",
      ],
      ballInNetEvidence: true,
      scoreboardGoalConfirmed: true,
    }]),
  });

  assert.equal(result.summary.confirmedGoalCount, 1);
  assert.equal(result.summary.disallowedGoalCount, 0);
  assert.ok(result.events[0].sourceStart >= 94);
  assert.ok(result.events[0].sourceStart <= 104);
  assert.ok(result.events[0].sourceEnd >= 120);
  assert.equal(result.events[0].phaseCoverage.replayOnly, false);
  assert.equal(result.events[0].phaseCoverage.shotStart, 104);
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
});

test("marks score increase followed by scorebug revert as disallowed truth", () => {
  const result = analyzeMatchEventTruth({
    metadata,
    visualSignals: visualSignals([
      { start: 50, end: 52, type: "shot_contact", confidence: 0.9 },
      { start: 52, end: 55, type: "ball_toward_goal", confidence: 0.88 },
      { start: 55, end: 57, type: "ball_in_net", confidence: 0.9 },
      { start: 65, end: 67, type: "scoreboard_goal_removed", confidence: 0.88 },
    ]),
    scoreboardOcr: [
      {
        id: "temporary_score_change",
        timestamp: 58,
        scoreBefore: "0-0",
        scoreAfter: "1-0",
        status: "score_changed",
        confidence: 0.92,
        temporalConsistency: true,
      },
      {
        id: "score_reverted",
        timestamp: 66,
        scoreBefore: "1-0",
        scoreAfter: "0-0",
        status: "goal_removed",
        confidence: 0.91,
        temporalConsistency: true,
      },
    ],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.summary.disallowedGoalCount, 1);
  assert.equal(result.summary.disallowedGoalEventCount, 1);
  assert.equal(result.scoreChanges[0].outcome, "disallowed_goal");
  assert.equal(result.scoreChanges[0].reverted, true);
  assert.equal(result.summary.revertedScoreChangeAnchorCount, 1);
  assert.equal(result.scoreChangeAnchors[0].outcome, "disallowed_goal");
  assert.equal(result.scoreChangeAnchors[0].reverted, true);
  assert.equal(result.scoreChangeAnchors[0].selectedForRender, false);
  assert.equal(result.scoreChangeAnchors[0].stableUntil, 66);
  assert.ok(result.events.some((event) => event.type === "disallowed_no_goal"));
  assert.ok(result.events.some((event) => event.evidenceCodes.includes("scoreboard_ocr_goal_removed")));
});

test("keeps noisy scorebug OCR as review item without false goal", () => {
  const result = analyzeMatchEventTruth({
    metadata,
    visualSignals: visualSignals([
      { start: 100, end: 103, type: "scoreboard_context", confidence: 0.7 },
    ]),
    scoreboardOcr: [{
      id: "noisy_score_change",
      timestamp: 105,
      scoreBefore: "1-1",
      scoreAfter: "2-1",
      status: "score_changed",
      confidence: 0.51,
      temporalConsistency: false,
      ambiguous: true,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.summary.scoreChangeCount, 1);
  assert.equal(result.scoreChanges[0].outcome, "uncertain_review");
  assert.ok(result.summary.uncertainReviewItemCount >= 1);
  assert.ok(result.summary.missedGoalReasons.includes("ambiguous_scorebug_observation"));
  assert.equal(result.summary.noFalseGoalFromOcrOnly, 1);
});

test("valid-goals-only mode rejects random high-energy chance without stable score change", () => {
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, sourceType: "youtube", goalSelectionMode: "valid_goals_only" },
    visualSignals: visualSignals([
      { start: 76, end: 78, types: ["shot_contact", "ball_toward_goal", "goal_mouth_visible"], confidence: 0.9 },
      { start: 80, end: 82, type: "crowd_reaction", confidence: 0.88 },
    ]),
    scoreboardOcr: [],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.summary.countedGoalEventCount, 0);
  assert.equal(result.summary.selectedGoalCount, 0);
  assert.equal(result.events.some((event) => event.type === "big_chance"), false);
  assert.ok(result.rejectedEvents.some((event) => event.type === "big_chance"));
  assert.equal(result.summary.noFalseGoalFromOcrOnly, 1);
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
});

test("selects three source-wide counted goals including late scorebug changes", () => {
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 420, sourceType: "youtube", goalSelectionMode: "valid_goals_only" },
    visualSignals: visualSignals([
      { start: 129, end: 131, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: 133, end: 135, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.94 },
      { start: 251, end: 253, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: 255, end: 257, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.94 },
      { start: 371, end: 373, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.93 },
      { start: 375, end: 377, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.95 },
    ]),
    scoreboardOcr: [
      { timestamp: 144, scoreBefore: "0-0", scoreAfter: "1-0", status: "score_changed", confidence: 0.92, temporalConsistency: true },
      { timestamp: 266, scoreBefore: "1-0", scoreAfter: "2-0", status: "score_changed", confidence: 0.93, temporalConsistency: true },
      { timestamp: 386, scoreBefore: "2-0", scoreAfter: "3-0", status: "score_changed", confidence: 0.94, temporalConsistency: true },
    ],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  const confirmed = result.events.filter((event) => event.type === "confirmed_goal");
  assert.equal(result.summary.confirmedGoalCount, 3);
  assert.equal(result.summary.countedGoalEventCount, 3);
  assert.equal(result.summary.scoreChangeAnchorsFound, 3);
  assert.equal(result.summary.anchorsWithLiveActionEvidence, 3);
  assert.equal(result.summary.selectedCountedGoals, 3);
  assert.equal(result.summary.anchorsRejected, 0);
  assert.deepEqual(confirmed.map((event) => event.goalNumber), [1, 2, 3]);
  assert.equal(result.summary.lateConfirmedGoalCount, 1);
  assert.deepEqual(confirmed.map((event) => event.scoreAfter), ["1-0", "2-0", "3-0"]);
  assert.deepEqual(confirmed.map((event) => event.scoreChangeTime), [144, 266, 386]);
  assert.ok(confirmed.every((event) => event.phaseCoverage.replayOnly === false));
  assert.ok(confirmed.every((event) => event.phaseCoverage.hasShot));
  assert.ok(confirmed.every((event) => event.cannotConfirmGoalAlone === true));
  assert.ok(confirmed.every((event) => event.anchorDiagnostics && event.anchorDiagnostics.missingActionEvidence === false));
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
});

test("selects five YouTube counted goals across the full source when each has visible action", () => {
  const goalWindows = [
    { shot: 94, finish: 99, confirm: 111, scoreBefore: "0-0", scoreAfter: "1-0" },
    { shot: 218, finish: 224, confirm: 238, scoreBefore: "1-0", scoreAfter: "2-0" },
    { shot: 312, finish: 318, confirm: 334, scoreBefore: "2-0", scoreAfter: "3-0" },
    { shot: 449, finish: 455, confirm: 470, scoreBefore: "3-0", scoreAfter: "4-0" },
    { shot: 566, finish: 572, confirm: 590, scoreBefore: "4-0", scoreAfter: "5-0" },
  ];
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 644, sourceType: "youtube", goalSelectionMode: "valid_goals_only" },
    visualSignals: visualSignals(goalWindows.flatMap((goal) => [
      { start: goal.shot - 6, end: goal.shot - 4, types: ["fast_break_motion", "ball_visible"], confidence: 0.86 },
      { start: goal.shot, end: goal.shot + 2, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: goal.finish, end: goal.finish + 2, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.94 },
      { start: goal.confirm, end: goal.confirm + 2, types: ["scoreboard_goal_confirmed", "referee_goal_signal"], confidence: 0.89 },
    ])),
    scoreboardOcr: goalWindows.map((goal, index) => ({
      id: `youtube_counted_goal_${index + 1}`,
      timestamp: goal.confirm,
      scoreBefore: goal.scoreBefore,
      scoreAfter: goal.scoreAfter,
      status: "score_changed",
      confidence: 0.9 + index * 0.01,
      temporalConsistency: true,
      scoreChanged: true,
      source: "local_scorebug_digit_reader_gray_line",
      imageDecoderStatus: "decoded",
      imageSegmentationStatus: "readable",
    })),
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  const confirmed = result.events.filter((event) => event.type === "confirmed_goal");
  assert.equal(result.summary.confirmedGoalCount, 5);
  assert.equal(result.summary.countedGoalEventCount, 5);
  assert.equal(result.summary.scoreChangeAnchorsFound, 5);
  assert.equal(result.summary.anchorsWithLiveActionEvidence, 5);
  assert.equal(result.summary.selectedCountedGoals, 5);
  assert.equal(result.summary.anchorsRejected, 0);
  assert.deepEqual(confirmed.map((event) => event.goalNumber), [1, 2, 3, 4, 5]);
  assert.deepEqual(confirmed.map((event) => event.scoreAfter), ["1-0", "2-0", "3-0", "4-0", "5-0"]);
  assert.ok(confirmed.every((event) => event.phaseCoverage.replayOnly === false));
  assert.ok(confirmed.every((event) => event.phaseCoverage.hasBuildup));
  assert.ok(confirmed.every((event) => event.phaseCoverage.hasShot));
  assert.ok(confirmed.every((event) => event.phaseCoverage.hasFinish));
  assert.ok(confirmed.every((event) => event.phaseCoverage.hasConfirmation));
  assert.equal(result.summary.noFalseGoalFromOcrOnly, 1);
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
});

test("keeps inferred score-change goalmouth payoff pending rendered proof", () => {
  const goalWindows = [
    { shot: 94, finish: 100, confirm: 112, scoreBefore: "0-0", scoreAfter: "1-0" },
    { shot: 218, finish: 224, confirm: 239, scoreBefore: "1-0", scoreAfter: "2-0" },
    { shot: 312, finish: 318, confirm: 335, scoreBefore: "2-0", scoreAfter: "3-0" },
    { shot: 449, finish: 455, confirm: 471, scoreBefore: "3-0", scoreAfter: "4-0" },
    { shot: 566, finish: 572, confirm: 591, scoreBefore: "4-0", scoreAfter: "5-0" },
  ];
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 644, sourceType: "youtube", goalSelectionMode: "valid_goals_only" },
    visualSignals: visualSignals(goalWindows.flatMap((goal) => [
      { start: goal.shot - 7, end: goal.shot - 5, types: ["fast_break_motion", "ball_visible"], confidence: 0.86 },
      { start: goal.shot, end: goal.shot + 2, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: goal.finish, end: goal.finish + 2, types: ["goal_mouth_visible"], confidence: 0.9 },
      { start: goal.confirm, end: goal.confirm + 2, types: ["scoreboard_goal_confirmed"], confidence: 0.89 },
    ])),
    scoreboardOcr: goalWindows.map((goal, index) => ({
      id: `efficient_counted_goal_${index + 1}`,
      timestamp: goal.confirm,
      scoreBefore: goal.scoreBefore,
      scoreAfter: goal.scoreAfter,
      status: "score_changed",
      confidence: 0.9 + index * 0.01,
      temporalConsistency: true,
      scoreChanged: true,
      source: "local_scorebug_digit_reader_gray_line",
      imageDecoderStatus: "decoded",
      imageSegmentationStatus: "readable",
    })),
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  const confirmed = result.events.filter((event) => event.type === "confirmed_goal");
  assert.equal(result.summary.confirmedGoalCount, 5);
  assert.equal(result.summary.countedGoalEventCount, 5);
  assert.equal(result.summary.anchorsLinkedToGoalPhaseCount, 0);
  assert.equal(result.summary.anchorsMissingVisualSupportCount, 5);
  assert.equal(result.summary.selectedCountedGoals, 5);
  assert.equal(result.summary.ocrOnlyBlockedCount, 0);
  assert.deepEqual(confirmed.map((event) => event.goalNumber), [1, 2, 3, 4, 5]);
  assert.ok(confirmed.every((event) => event.primarySource === "live_action"));
  assert.ok(confirmed.every((event) => event.phaseCoverage.hasBuildup));
  assert.ok(confirmed.every((event) => event.phaseCoverage.hasShot));
  assert.ok(confirmed.every((event) => event.phaseCoverage.hasFinish === false));
  assert.ok(confirmed.every((event) => event.phaseCoverage.hasConfirmation));
  assert.ok(confirmed.every((event) => event.phaseCoverage.visualGoalPayoff.hasVisibleGoalPayoff === false));
  assert.ok(confirmed.every((event) => event.phaseCoverage.visualGoalPayoff.hasBallInNetEvidence === false));
  assert.ok(confirmed.every((event) => event.phaseCoverage.visualGoalPayoff.inferredFromStableScoreChange === true));
  assert.ok(confirmed.every((event) => event.phaseCoverage.finishFrameEvidence.visibilityVerdict === "failed"));
  assert.ok(confirmed.every((event) => (
    event.phaseCoverage.finishFrameEvidence.evidenceCodes || []
  ).includes("score_change_anchor_pending_rendered_finish")));
  assert.ok(confirmed.every((event) => event.anchorDiagnostics.bindingFullSourceScanUsed === false));
  assert.ok(confirmed.every((event) => event.anchorDiagnostics.bindingSampledFrameBudget <= 24));
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath|stderr|stdout/i);
});

test("operator YouTube proof can backtrack stable score changes when sampled vision lacks finish labels", () => {
  const scoreChanges = [
    { confirm: 137.61, scoreBefore: "0-0", scoreAfter: "1-0" },
    { confirm: 474, scoreBefore: "1-0", scoreAfter: "1-1" },
    { confirm: 483.75, scoreBefore: "1-1", scoreAfter: "2-1" },
    { confirm: 558.45, scoreBefore: "2-1", scoreAfter: "2-2" },
    { confirm: 596.25, scoreBefore: "2-2", scoreAfter: "3-2" },
  ];
  const result = analyzeMatchEventTruth({
    metadata: {
      ...metadata,
      durationSeconds: 764.52,
      sourceType: "youtube",
      goalSelectionMode: "valid_goals_only",
      allowScoreChangeBacktrackFallback: true,
    },
    visualSignals: visualSignals(scoreChanges.flatMap((goal) => [
      { start: goal.confirm - 22, end: goal.confirm - 18, types: ["fast_break_motion", "ball_visible"], confidence: 0.7 },
      { start: goal.confirm, end: goal.confirm + 1, type: "scoreboard_goal_confirmed", confidence: 0.86 },
    ])),
    scoreboardOcr: scoreChanges.map((goal, index) => ({
      id: `live_score_change_${index + 1}`,
      timestamp: goal.confirm,
      scoreBefore: goal.scoreBefore,
      scoreAfter: goal.scoreAfter,
      status: "score_changed",
      confidence: 0.9,
      temporalConsistency: true,
      scoreChanged: true,
      source: "local_scorebug_digit_reader_gray_line",
      imageDecoderStatus: "decoded",
      imageSegmentationStatus: "readable",
    })),
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  const confirmed = result.events.filter((event) => event.type === "confirmed_goal");
  assert.equal(result.summary.confirmedGoalCount, 5);
  assert.equal(result.summary.countedGoalEventCount, 5);
  assert.equal(result.summary.selectedCountedGoals, 5);
  assert.equal(result.summary.anchorsRejected, 0);
  assert.deepEqual(confirmed.map((event) => event.goalNumber), [1, 2, 3, 4, 5]);
  assert.deepEqual(confirmed.map((event) => event.scoreAfter), ["1-0", "1-1", "2-1", "2-2", "3-2"]);
  assert.ok(confirmed.every((event) => event.primarySource === "score_change_backtrack"));
  assert.ok(confirmed.every((event) => event.phaseCoverage.replayOnly === false));
  assert.ok(confirmed.every((event) => event.phaseCoverage.hasBuildup));
  assert.ok(confirmed.every((event) => event.phaseCoverage.hasShot));
  assert.ok(confirmed.every((event) => event.phaseCoverage.hasFinish));
  assert.ok(confirmed.every((event) => event.anchorDiagnostics.bindingStrategy === "score_change_backtrack_fallback"));
  assert.ok(confirmed.every((event) => event.sourceStart <= event.scoreChangeTime - 8));
  assert.ok(confirmed.every((event) => event.phaseCoverage.shotStart <= event.scoreChangeTime - 1));
  assert.doesNotMatch(JSON.stringify(publicMatchEventTruth(result)), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath|stderr|stdout/i);
});

test("keeps distinct close score transitions from being swallowed by overlapping goal windows", () => {
  const closeGoalWindows = [
    { shot: 550, finish: 554, confirm: 558.4, scoreBefore: "2-1", scoreAfter: "2-2" },
    { shot: 558.8, finish: 562, confirm: 565.2, scoreBefore: "2-2", scoreAfter: "3-2" },
  ];
  const result = analyzeMatchEventTruth({
    metadata: { ...metadata, durationSeconds: 660, sourceType: "youtube", goalSelectionMode: "valid_goals_only" },
    visualSignals: visualSignals(closeGoalWindows.flatMap((goal) => [
      { start: goal.shot - 7, end: goal.shot - 5, types: ["fast_break_motion", "ball_visible"], confidence: 0.86 },
      { start: goal.shot, end: goal.shot + 1.5, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.92 },
      { start: goal.finish, end: goal.finish + 1.5, types: ["goal_mouth_visible"], confidence: 0.9 },
      { start: goal.confirm, end: goal.confirm + 1, types: ["scoreboard_goal_confirmed"], confidence: 0.89 },
    ])),
    scoreboardOcr: closeGoalWindows.map((goal, index) => ({
      id: `close_counted_goal_${index + 1}`,
      timestamp: goal.confirm,
      scoreBefore: goal.scoreBefore,
      scoreAfter: goal.scoreAfter,
      status: "score_changed",
      confidence: 0.93,
      temporalConsistency: true,
      scoreChanged: true,
      source: "local_scorebug_digit_reader_gray_line",
      imageDecoderStatus: "decoded",
      imageSegmentationStatus: "readable",
    })),
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  const confirmed = result.events.filter((event) => event.type === "confirmed_goal");
  assert.equal(result.summary.scoreChangeAnchorsFound, 2);
  assert.equal(result.summary.countedGoalEventCount, 2);
  assert.equal(result.summary.confirmedGoalCount, 2);
  assert.equal(result.summary.selectedCountedGoals, 2);
  assert.deepEqual(confirmed.map((event) => event.scoreBefore), ["2-1", "2-2"]);
  assert.deepEqual(confirmed.map((event) => event.scoreAfter), ["2-2", "3-2"]);
  assert.deepEqual(confirmed.map((event) => event.goalNumber), [1, 2]);
  assert.ok(confirmed.every((event) => event.anchorDiagnostics.bindingFullSourceScanUsed === false));
  assert.ok(confirmed.every((event) => event.phaseCoverage.replayOnly === false));
});

test("rejects scorebug counted candidate when only replay context is visible", () => {
  const result = analyzeMatchEventTruth({
    metadata,
    visualSignals: visualSignals([
      { start: 118, end: 122, types: ["replay_indicator", "replay_angle"], confidence: 0.9 },
      { start: 122, end: 124, type: "crowd_reaction", confidence: 0.86 },
    ]),
    scoreboardOcr: [{
      timestamp: 124,
      scoreBefore: "0-0",
      scoreAfter: "1-0",
      status: "score_changed",
      confidence: 0.93,
      temporalConsistency: true,
    }],
    ocrQaCalibration: strongOcrQaCalibration(),
    goalEvidence: goalEvidence([]),
  });

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.summary.countedGoalEventCount, 1);
  assert.equal(result.summary.scoreChangeAnchorsFound, 1);
  assert.equal(result.summary.anchorsWithLiveActionEvidence, 0);
  assert.equal(result.summary.selectedCountedGoals, 0);
  assert.equal(result.summary.anchorsRejected, 1);
  assert.equal(result.summary.ocrOnlyBlockedCount, 1);
  assert.equal(result.summary.missingActionEvidenceCount, 1);
  assert.ok(result.rejectedEvents.some((event) => event.missingEvidence.includes("live_goal_phase")));
  assert.ok(result.rejectedEvents.some((event) => event.anchorDiagnostics && event.anchorDiagnostics.ocrOnlyBlocked === true));
  assert.ok(result.summary.missedGoalReasons.includes("counted_score_change_not_selected"));
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

test("does not recover bounded YouTube action clusters without strong visible finish support", () => {
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

  assert.equal(result.summary.confirmedGoalCount, 0);
  assert.equal(result.events.some((event) => event.id.startsWith("cluster_recovered_goal_")), false);
  assert.equal(result.summary.noFalseGoalFromOcrOnly, 1);
});

test("recovers bounded YouTube live goal clusters with explicit payoff support", () => {
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
      audioPeaks: [{ time: 145, energyScore: 0.94 }],
      sceneChanges: [{ time: 148, confidence: 0.8 }],
    },
    visualSignals: visualSignals([
      { start: 136, end: 138, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
      { start: 140, end: 142, types: ["goal_mouth_visible", "ball_in_net", "crowd_reaction"], confidence: 0.86 },
      { start: 146, end: 149, types: ["replay_indicator", "replay_angle"], confidence: 0.84 },
    ]),
    goalEvidence: goalEvidence([{
      id: "support_only_live_goal_cluster",
      type: "possible_goal_unconfirmed",
      start: 136,
      end: 149,
      confidence: 0.82,
      outcomeHint: "possible_goal_unconfirmed",
      reasonCodes: [
        "visual_shot_contact",
        "visual_ball_toward_goal",
        "visual_ball_in_net",
        "visual_goal_mouth",
        "visual_crowd_reaction",
        "visual_replay_indicator",
        "replay_goal_confirmation",
        "live_shot_finish_sequence",
      ],
      liveShotFinishSequence: true,
      crowdReactionSupport: true,
      combinedGoalConfirmation: true,
    }]),
  });

  const confirmed = result.events.filter((event) => event.type === "confirmed_goal");
  assert.equal(result.summary.confirmedGoalCount, 1);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].phaseCoverage.replayOnly, false);
  assert.equal(confirmed[0].phaseCoverage.hasShot, true);
  assert.equal(confirmed[0].phaseCoverage.hasFinish, true);
  assert.equal(confirmed[0].phaseCoverage.visualGoalPayoff.hasVisibleGoalPayoff, true);
  assert.equal(confirmed[0].phaseCoverage.visualGoalPayoff.hasLiveFinishSequence, true);
  assert.ok(confirmed[0].evidenceCodes.includes("visual_ball_in_net"));
  assert.ok(confirmed[0].evidenceCodes.includes("live_shot_finish_sequence"));
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

test("anchors pending score observations to the stable scoreboard change confirmation", () => {
  const result = analyzeMatchEventTruth({
    metadata: {
      durationSeconds: 240,
      width: 1920,
      height: 1080,
      sourceType: "youtube",
      goalSelectionMode: "valid_goals_only",
      allowScoreChangeBacktrackFallback: true,
    },
    mediaSignals: { durationSeconds: 240, audioPeaks: [], sceneChanges: [] },
    visualSignals: visualSignals([]),
    scoreboardOcr: [
      {
        id: "pending_1_0",
        timestamp: 124,
        scoreBefore: "0-0",
        scoreAfter: "1-0",
        confidence: 0.62,
        ambiguous: true,
        transitionDecision: "score_change_pending_confirmation",
        transitionReasonCodes: ["unit_score_increase_candidate"],
      },
      {
        id: "stable_1_0",
        timestamp: 137.61,
        status: "score_changed",
        scoreBefore: "0-0",
        scoreAfter: "1-0",
        confidence: 0.94,
        temporalConsistency: true,
        scoreChanged: true,
        decoderStatus: "decoded",
        imageSegmentationStatus: "readable",
        source: "scorebug_digit_reader",
      },
    ],
    goalEvidence: goalEvidence([]),
  });

  const event = result.events[0];
  assert.equal(result.summary.countedGoalEventCount, 1);
  assert.equal(event.type, "confirmed_goal");
  assert.equal(event.scoreChangeTime, 137.61);
  assert.equal(event.confirmationTime, 137.61);
  assert.ok(event.sourceStart <= 124);
  assert.ok(event.sourceEnd >= 137.61 + 1.2);
  assert.equal(event.phaseCoverage.replayOnly, false);
  assert.ok(event.evidenceCodes.includes("score_change_backtrack_window"));
  assert.equal(event.anchorDiagnostics.actionAnchorTime, 124);
  assert.equal(event.anchorDiagnostics.changeTime, 137.61);
  assert.doesNotMatch(JSON.stringify(result), /\/Users|OPENAI_API_KEY|rawOcr|rawText|storageKey|localPath/i);
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
