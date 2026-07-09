const test = require("node:test");
const assert = require("node:assert/strict");
const { writeFileSync } = require("node:fs");

const { AppError, SAFE_MESSAGES } = require("../server/errors.cjs");
const { validateEditPlan } = require("../server/edit-plan.cjs");
const { JobStore } = require("../server/jobs.cjs");
const { assertVideoOutputCoverage } = require("../server/video-output-gate.cjs");
const {
  __testing,
  enqueueRenderJob,
  ocrQaCalibrationOptionsFromEnv,
  runRenderJob,
  scoreChangeCandidateWindowsFromOcr,
  validateHighlightResult,
  validateTranscript,
  visualCandidateWindowsFromSignals,
} = require("../server/render-job.cjs");
const { storagePath } = require("../server/storage.cjs");

function uniqueUploadPath() {
  return storagePath("uploads", `orchestration-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
}

function validTranscript() {
  return {
    provider: "mock",
    language: "en",
    text: "What a goal",
    captions: [
      { start: 0, end: 2, text: "What a goal" },
      { start: 2.2, end: 4.4, text: "The crowd reacts" },
    ],
    segments: [{ start: 0, end: 2, text: "What a goal" }],
  };
}

function validMoment() {
  return {
    id: "mom_test",
    rank: 1,
    start: 0,
    end: 8,
    center: 4,
    title: "Goal impact beat",
    summary: "What a goal",
    reasonCodes: ["goal", "audio_energy_spike"],
    highlightType: "goal",
    confidence: 0.92,
    retentionScore: 92,
    suggestedPreset: "hype",
    hook: "ΤΟ ΓΚΟΛ ΠΟΥ ΑΛΛΑΞΕ ΤΟ ΜΑΤΣ",
    captionBeats: [
      { start: 0, end: 2, text: "What a goal" },
      { start: 2.2, end: 4.4, text: "The crowd reacts" },
    ],
  };
}

function validPlan() {
  return {
    sourceStart: 0,
    sourceEnd: 8,
    aspectRatio: "9:16",
    highlightType: "goal",
    confidence: 0.92,
    hook: "ΤΟ ΓΚΟΛ ΠΟΥ ΑΛΛΑΞΕ ΤΟ ΜΑΤΣ",
    title: "Derby Final",
    captions: [
      { start: 0, end: 2, text: "What a goal" },
      { start: 2.2, end: 4.4, text: "The crowd reacts" },
    ],
    effects: ["wide_safe_framing", "social_caption_pop", "caption_emphasis", "beat_sync_pulse"],
    framingMode: "wide_safe",
    cropStrategy: {
      type: "wide_safe_contain",
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
      zoom: 1,
      background: "blurred_fill",
      preserveFullFrame: true,
      maxCropPercent: 0,
    },
    stylePreset: "social_sports_v1",
    captionEmphasis: [{ captionIndex: 0, words: ["GOAL"], style: "kinetic_bold", start: 0, end: 2 }],
    animationCues: [
      { type: "intro_hook", start: 0, end: 1.2, safeForMotion: true },
      { type: "caption_word_pop", start: 0, end: 1.8, safeForMotion: true },
      { type: "kinetic_caption", start: 0.2, end: 1.8, safeForMotion: true },
      { type: "beat_pulse", start: 1.6, end: 2.1, safeForMotion: true },
      { type: "end_replay_prompt", start: 6.7, end: 8, safeForMotion: true },
    ],
    safetyNotes: ["No object or ball tracking is claimed in v1."],
    reasonCodes: ["goal", "audio_energy_spike"],
    export: { width: 1080, height: 1920, format: "mp4" },
  };
}

function validGoalOutcome(decisionTimestamp) {
  return {
    eventType: "ball_in_net",
    outcome: "confirmed_goal",
    offsideStatus: "onside",
    confidence: 0.93,
    decisionTimestamp,
    decisionEvidence: ["scoreboard_goal_confirmed", "scoreboard_backed_goal_sequence"],
  };
}

function validGoalSegment(index, sourceStart, shotStart, finishTime, confirmationTime) {
  const sourceEnd = confirmationTime + 4;
  return {
    id: `goal_segment_${index}`,
    sourceStart,
    sourceEnd,
    highlightType: "goal",
    reasonCodes: [
      "goal",
      "visual_shot_contact",
      "visual_ball_toward_goal",
      "visual_ball_in_net",
      "live_shot_finish_sequence",
      "scoreboard_ocr_score_change",
      "scoreboard_temporal_consistency",
      "scoreboard_backed_goal_sequence",
    ],
    goalOutcome: validGoalOutcome(confirmationTime),
    goalNumber: index,
    buildupStart: sourceStart,
    shotStart,
    finishTime,
    confirmationTime,
    replayUsed: false,
    replayOnly: false,
    phaseCoverage: {
      hasBuildup: true,
      hasShot: true,
      hasFinish: true,
      hasConfirmation: true,
      liveActionStart: sourceStart,
      shotStart,
      finishTime,
      confirmationTime,
      replayUsed: false,
      replayOnly: false,
      visualGoalPayoff: {
        hasVisibleGoalPayoff: true,
        hasBallInNetEvidence: true,
        hasLiveFinishSequence: true,
        scoreboardOnly: false,
        evidenceCodes: ["visual_ball_in_net", "live_shot_finish_sequence"],
      },
    },
    finishFrameEvidence: {
      frameTime: finishTime,
      confidence: 0.9,
      visibilityVerdict: "clear",
      hasVisibleFinish: true,
      hasBallInNetOrPayoff: true,
      hasGoalMouth: true,
      hasPreShotActionFrame: true,
      hasFinishActionFrame: true,
      hasPayoffFrame: true,
      hasConfirmationFrame: true,
      continuousActionFrameCount: 4,
      isBlurred: false,
      isOverZoomed: false,
      isLabelOnly: false,
      isReplayOnly: false,
      isCelebrationOnly: false,
      isScoreboardOnly: false,
      evidenceCodes: ["finish_frame_visible", "ball_in_net_or_payoff_visible"],
    },
    confidence: 0.92,
    retentionScore: 94,
    captionTheme: "confirmed_goal_caption",
    whySelected: "Confirmed counted goal with full visible phase.",
    safetyFlags: ["confirmed_goal_requires_action_and_support"],
  };
}

function nonGoalFillerSegment() {
  return {
    id: "random_big_chance",
    sourceStart: 180,
    sourceEnd: 191,
    highlightType: "big_chance",
    reasonCodes: ["visual_shot_like_motion", "visual_crowd_reaction"],
    goalOutcome: { eventType: "none", outcome: "none" },
    confidence: 0.61,
    retentionScore: 61,
    captionTheme: "big_chance_caption",
    whySelected: "A non-goal chance that must not appear in valid-goals-only output.",
    safetyFlags: [],
  };
}

function countedGoalTruth(count = 3) {
  const changes = [
    { changeTime: 48, actionAnchorTime: 39, startScore: "0-0", endScore: "1-0" },
    { changeTime: 126, actionAnchorTime: 116, startScore: "1-0", endScore: "2-0" },
    { changeTime: 214, actionAnchorTime: 205, startScore: "2-0", endScore: "3-0" },
  ].slice(0, count);
  return {
    schemaVersion: 1,
    providerMode: "mock-match-event-truth",
    fallbackUsed: false,
    events: changes.map((change, index) => ({
      id: `score_change_truth_${index + 1}`,
      type: "confirmed_goal",
      outcome: "confirmed_goal",
      confidence: 0.92,
      sourceStart: change.actionAnchorTime - 3,
      sourceEnd: change.changeTime + 4,
      goalNumber: index + 1,
      scoreBefore: change.startScore,
      scoreAfter: change.endScore,
      scoreChangeTime: change.changeTime,
      shotStart: change.actionAnchorTime,
      finishTime: change.changeTime - 1,
      confirmationTime: change.changeTime,
      evidenceCodes: [
        "scoreboard_ocr_score_change",
        "scoreboard_temporal_consistency",
        "scoreboard_backed_goal_sequence",
        "visual_shot_contact",
        "visual_ball_in_net",
        "live_shot_finish_sequence",
      ],
      missingEvidence: [],
      safetyFlags: ["scorebug_truth_integration"],
      phaseCoverage: {
        hasBuildup: true,
        hasShot: true,
        hasFinish: true,
        hasConfirmation: true,
        liveActionStart: change.actionAnchorTime - 8,
        shotStart: change.actionAnchorTime,
        finishTime: change.changeTime - 1,
        confirmationTime: change.changeTime,
        replayUsed: false,
        replayOnly: false,
      },
    })),
    rejectedEvents: [],
    scoreChanges: changes.map((change, index) => ({
      id: `score_change_${index + 1}`,
      startScore: change.startScore,
      endScore: change.endScore,
      changeTime: change.changeTime,
      actionAnchorTime: change.actionAnchorTime,
      hasPendingObservation: false,
      strongAuthority: true,
      teamSide: "home",
      scoreDelta: 1,
      confidence: 0.92,
      persistedDuration: 35,
      reverted: false,
      outcome: "counted_goal",
      reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
    })),
    summary: {
      eventCount: count,
      confirmedGoalCount: count,
      disallowedGoalCount: 0,
      possibleGoalCount: 0,
      countedGoalEventCount: count,
      selectedCountedGoals: count,
      noFalseGoalFromOcrOnly: 1,
    },
  };
}

function countedGoalTruthFromSegments(segments) {
  return {
    schemaVersion: 1,
    providerMode: "mock-match-event-truth",
    fallbackUsed: false,
    events: segments.map((segment, index) => ({
      id: `score_change_truth_${index + 1}`,
      type: "confirmed_goal",
      outcome: "confirmed_goal",
      confidence: 0.92,
      sourceStart: segment.sourceStart,
      sourceEnd: segment.sourceEnd,
      goalNumber: segment.goalNumber,
      scoreBefore: `${index}-0`,
      scoreAfter: `${index + 1}-0`,
      scoreChangeTime: segment.confirmationTime,
      shotStart: segment.shotStart,
      finishTime: segment.finishTime,
      confirmationTime: segment.confirmationTime,
      evidenceCodes: [
        "scoreboard_ocr_score_change",
        "scoreboard_temporal_consistency",
        "scoreboard_backed_goal_sequence",
        "visual_shot_contact",
        "visual_ball_in_net",
        "live_shot_finish_sequence",
      ],
      missingEvidence: [],
      safetyFlags: ["scorebug_truth_integration"],
      phaseCoverage: {
        hasBuildup: true,
        hasShot: true,
        hasFinish: true,
        hasConfirmation: true,
        liveActionStart: segment.sourceStart,
        shotStart: segment.shotStart,
        finishTime: segment.finishTime,
        confirmationTime: segment.confirmationTime,
        replayUsed: false,
        replayOnly: false,
      },
    })),
    rejectedEvents: [],
    scoreChanges: segments.map((segment, index) => ({
      id: `score_change_${index + 1}`,
      startScore: `${index}-0`,
      endScore: `${index + 1}-0`,
      changeTime: segment.confirmationTime,
      actionAnchorTime: segment.shotStart,
      hasPendingObservation: false,
      strongAuthority: true,
      teamSide: "home",
      scoreDelta: 1,
      confidence: 0.92,
      persistedDuration: 35,
      reverted: false,
      outcome: "counted_goal",
      reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"],
    })),
    summary: {
      eventCount: segments.length,
      confirmedGoalCount: segments.length,
      disallowedGoalCount: 0,
      possibleGoalCount: 0,
      countedGoalEventCount: segments.length,
      selectedCountedGoals: segments.length,
      noFalseGoalFromOcrOnly: 1,
    },
  };
}

function validGoalCompilationPlan(segments) {
  const totalDuration = segments.reduce((sum, segment) => sum + (segment.sourceEnd - segment.sourceStart), 0);
  return {
    mode: "multi_moment_compilation",
    sourceStart: segments[0].sourceStart,
    sourceEnd: Math.max(...segments.map((segment) => segment.sourceEnd)),
    totalDuration: segments.length >= 5 ? 64 : totalDuration,
    segments,
    aspectRatio: "9:16",
    highlightType: "generic_highlight",
    confidence: 0.91,
    hook: "VALID FINISHES ONLY",
    title: "Derby Final",
    captions: [
      { start: 0, end: 2, text: "FINISH 1 COUNTS", goalEvidence: true },
      { start: Math.max(2.2, totalDuration - 3), end: Math.max(4.2, totalDuration - 1), text: "ALL COUNTED FINISHES", goalEvidence: false },
    ],
    effects: ["wide_safe_framing", "social_caption_pop", "caption_emphasis", "beat_sync_pulse"],
    framingMode: "wide_safe_vertical",
    framingReason: "wide_safe_multi_goal_output_gate_fixture",
    cropStrategy: {
      type: "wide_safe_contain",
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
      zoom: 1,
      background: "blurred_fill",
      preserveFullFrame: true,
      maxCropPercent: 0,
    },
    stylePreset: "reference_football_multi_goal_v1",
    captionEmphasis: [{ captionIndex: 0, words: ["Goal"], style: "kinetic_bold", start: 0, end: 2 }],
    animationCues: [
      { type: "intro_hook", start: 0, end: 1.2, safeForMotion: true },
      { type: "caption_word_pop", start: 0, end: 1.8, safeForMotion: true },
      { type: "kinetic_caption", start: 0.2, end: 1.8, safeForMotion: true },
      { type: "goal_counter_overlay", start: 0, end: 3.6, safeForMotion: true },
    ],
    safetyNotes: ["Valid-goals-only proof fixture."],
    reasonCodes: ["goal", "scoreboard_backed_goal_sequence", "visual_ball_in_net"],
    export: { width: 1080, height: 1920, format: "mp4" },
  };
}

function cleanRenderPolishQA(plan = {}) {
  return {
    ...(plan.renderPolishQA || {}),
    cleanActionLayoutRequired: true,
    cleanActionLayoutPassed: true,
    actionLayoutMode: "clean_action_letterbox",
    blurredBackgroundUsed: false,
    duplicateBackgroundUsed: false,
    splitLayoutCaptionCount: 0,
  };
}

function defaultOcrQaCalibration() {
  return {
    status: "missing",
    available: false,
    stale: false,
    invalid: false,
    usable: false,
    decisionSupportLevel: "ignore",
    scoreboardCropQuality: "unknown",
    goalEvidencePolicy: "support_only",
    goalDecisionAllowed: false,
    noFalseGoalFromOcrOnly: true,
    supportWeight: 0,
    generatedAt: null,
    reasonCode: "ocr_qa_missing",
  };
}

function makeContext(options = {}) {
  const jobs = new JobStore();
  const job = jobs.create({ projectId: "prj_orchestration", action: "generate", idempotencyKey: `orch-${Math.random()}` });
  const exportsById = new Map();
  const uploadPath = uniqueUploadPath();
  writeFileSync(uploadPath, Buffer.from("synthetic-video-placeholder"));
  const project = {
    id: "prj_orchestration",
    uploadId: "upl_orchestration",
    title: "Derby Final",
    status: "draft",
    source: options.source || null,
    updatedAt: new Date().toISOString(),
  };
  const upload = {
    id: "upl_orchestration",
    projectId: project.id,
    path: uploadPath,
    metadata: {
      durationSeconds: options.durationSeconds || 12,
      width: 1280,
      height: 720,
      hasAudio: options.hasAudio !== false,
      ...(options.metadata || {}),
    },
    source: options.source || null,
  };
  const payload = {
    title: "Derby Final",
    preset: "hype",
    language: "en",
    styleTarget: "square_1_1",
    editIntensity: "punchy",
    stylePreset: "punchy_highlight",
  };
  const calls = [];
  const logs = [];
  const writes = [];
  const providerOptions = [];
  const context = { jobs, job, exportsById, project, upload, payload, calls, logs, writes, providerOptions };
  const dependencies = {
    logger: {
      info(line) {
        logs.push(JSON.parse(line));
      },
    },
    createExportId: () => "exp_orchestration_test",
    extractAudio: async () => {
      calls.push("extract_audio");
    },
    extractMediaSignals: async () => {
      calls.push("extract_media_signals");
      return {
        durationSeconds: upload.metadata.durationSeconds,
        width: upload.metadata.width,
        height: upload.metadata.height,
        hasAudio: upload.metadata.hasAudio,
        audioPeaks: [{ time: 4, energyScore: 0.88 }],
        sceneChanges: [{ time: 3.8, confidence: 0.76 }],
        highMotionCandidates: [{ time: 4, confidence: 0.7 }],
      };
    },
    extractSampledFrames: async ({ candidateWindows, maxFrames }) => {
      calls.push("extract_sampled_frames");
      context.frameCandidateWindows = candidateWindows;
      context.frameExtractionMaxFrames = maxFrames;
      return options.sampledFrames || {
        providerMode: "mock-frame-extraction",
        fallbackUsed: false,
        outputDir: null,
        frames: [
          {
            id: "frame_test_1",
            windowStart: 2.5,
            windowEnd: 5.5,
            timestamp: 4,
            width: 640,
            height: 360,
            localPath: storagePath("staging", "unit-frame-test.jpg"),
            purpose: "vision_context",
            source: "unit_test",
          },
        ],
        summary: {
          frameCount: 1,
          sampledWindows: 1,
          skippedWindows: 0,
          extractionMs: 4,
        },
      };
    },
    cleanupSampledFrames: ({ frames }) => {
      calls.push("cleanup_sampled_frames");
      context.cleanedFrameCount = Array.isArray(frames) ? frames.length : 0;
      return { cleanedCount: context.cleanedFrameCount };
    },
    analyzeFrames: async ({ candidateWindows, frames }) => {
      calls.push("analyze_frames");
      context.visualCandidateWindows = candidateWindows;
      context.visualFrameCount = Array.isArray(frames) ? frames.length : 0;
      return options.visualSignals || {
        providerMode: "mock-vision",
        fallbackUsed: true,
        confidence: 0.72,
        providerMetadata: { latencyMs: 5, frameCount: context.visualFrameCount },
        windows: [{ start: 2.7, end: 5.1, type: "unknown_visual_action", confidence: 0.72 }],
      };
    },
    analyzeScoreboardOcr: async ({ frames, visualSignals, candidateWindows, ocrSamplingWindows, scorebugFirstOnly, scorebugFirstRegionIds, timeoutMs }) => {
      calls.push("analyze_scoreboard_ocr");
      context.scoreboardOcrCalls = context.scoreboardOcrCalls || [];
      context.scoreboardOcrCalls.push({
        frameCount: Array.isArray(frames) ? frames.length : 0,
        visualWindowCount: visualSignals && Array.isArray(visualSignals.windows)
          ? visualSignals.windows.length
          : 0,
        candidateWindowCount: Array.isArray(candidateWindows) ? candidateWindows.length : 0,
        ocrSamplingWindows: Array.isArray(ocrSamplingWindows) ? ocrSamplingWindows : [],
        scorebugFirstOnly: Boolean(scorebugFirstOnly),
        scorebugFirstRegionIds: Array.isArray(scorebugFirstRegionIds) ? scorebugFirstRegionIds : [],
        timeoutMs,
      });
      context.scoreboardOcrFrameCount = Array.isArray(frames) ? frames.length : 0;
      context.scoreboardOcrVisualWindowCount = visualSignals && Array.isArray(visualSignals.windows)
        ? visualSignals.windows.length
        : 0;
      return options.scoreboardOcr || {
        providerMode: "mock-scoreboard-ocr",
        fallbackUsed: true,
        confidence: 0,
        evidence: [],
        summary: {
          evidenceCount: 0,
          scoreChangeCount: 0,
          scoreUnchangedCount: 0,
          ambiguousCount: 0,
          sampledFrameCount: context.scoreboardOcrFrameCount,
          regionCount: 0,
          fallbackUsed: true,
        },
      };
    },
    loadOcrQaCalibration: (calibrationOptions) => {
      context.loadOcrQaCalibrationOptions = calibrationOptions || {};
      return options.ocrQaCalibration || defaultOcrQaCalibration();
    },
    analyzeGoalEvidence: async ({ visualSignals, scoreboardOcr, ocrQaCalibration }) => {
      calls.push("analyze_goal_evidence");
      context.goalEvidenceVisualWindowCount = visualSignals && Array.isArray(visualSignals.windows)
        ? visualSignals.windows.length
        : 0;
      context.goalEvidenceOcrEvidenceCount = Array.isArray(scoreboardOcr) ? scoreboardOcr.length : 0;
      context.goalEvidenceOcrQaCalibration = ocrQaCalibration;
      return options.goalEvidence || {
        providerMode: "mock-goal-evidence",
        fallbackUsed: false,
        confidence: 0,
        events: [],
        supplementalVisualWindows: [],
        summary: {
          eventCount: 0,
          validGoalCount: 0,
          offsideOrNoGoalCount: 0,
          unconfirmedGoalCount: 0,
          nonGoalChanceCount: 0,
          celebrationOnlyCount: 0,
          anthemOrIntroCount: 0,
          ocrEvidenceCount: context.goalEvidenceOcrEvidenceCount,
          scoreboardConfirmedGoalCount: 0,
          ambiguousOcrCount: 0,
          goalEvidenceCoverage: 0,
          ocrQaStatus: ocrQaCalibration && ocrQaCalibration.status,
          ocrQaUsable: Boolean(ocrQaCalibration && ocrQaCalibration.usable),
          ocrQaSupportLevel: ocrQaCalibration && ocrQaCalibration.decisionSupportLevel,
        },
        ocrQaCalibration,
      };
    },
    analyzeMatchEventTruth: ({ goalEvidence, ocrQaCalibration }) => {
      calls.push("analyze_match_event_truth");
      context.matchEventTruthGoalEvidenceEventCount = goalEvidence && goalEvidence.summary
        ? goalEvidence.summary.eventCount
        : 0;
      context.matchEventTruthOcrQaCalibration = ocrQaCalibration;
      return options.matchEventTruth || {
        schemaVersion: 1,
        providerMode: "mock-match-event-truth",
        fallbackUsed: false,
        ocrQaCalibration,
        events: [],
        rejectedEvents: [],
        summary: {
          eventCount: 0,
          confirmedGoalCount: 0,
          disallowedGoalCount: 0,
          possibleGoalCount: 0,
          chanceOrSaveCount: 0,
          rejectedEventCount: 0,
          lateConfirmedGoalCount: 0,
          noFalseGoalFromOcrOnly: 1,
          ocrQaSupportStatus: ocrQaCalibration && ocrQaCalibration.usable ? "usable" : "ignored",
        },
      };
    },
    analyzeTracking: async ({ frames }) => {
      calls.push("analyze_tracking");
      context.trackingFrameCount = Array.isArray(frames) ? frames.length : 0;
      return options.trackingProviderOutput || {
        providerMode: "mock-tracking",
        fallbackUsed: true,
        frameCount: context.trackingFrameCount,
        ballTracks: [],
        playerClusters: [],
        actionBounds: null,
        actionCenter: null,
        cameraMotionLevel: 0,
        confidence: 0,
        reasonCodes: ["tracking_fallback_no_ball_player_evidence"],
      };
    },
    chooseTranscriptionProvider: (providerOpts) => {
      providerOptions.push(providerOpts);
      return {
        transcribe: async () => options.transcript || validTranscript(),
      };
    },
    detectHighlights: () => options.highlightResult || { fallback: false, moments: [validMoment()] },
    createCandidateEditPlans: (input) => {
      context.createPlanInput = input;
      if (Object.prototype.hasOwnProperty.call(options, "candidatePlans")) return options.candidatePlans;
      return [validPlan()];
    },
    validateEditPlan,
    renderShort: async ({ outputPath, plan }) => {
      context.renderObserved = {
        exportCount: exportsById.size,
        projectStatus: project.status,
      };
      calls.push("render_short");
      if (options.renderError) throw options.renderError;
      if (plan && typeof plan === "object" && !plan.renderPolishQA) {
        plan.renderPolishQA = cleanRenderPolishQA(plan);
      }
      writeFileSync(outputPath, Buffer.from("rendered-short"));
    },
    analyzeRenderedGoalProof: async ({ editPlan }) => {
      calls.push("analyze_rendered_goal_proof");
      const segments = Array.isArray(editPlan && editPlan.segments) ? editPlan.segments : [];
      let timelineCursor = 0;
      const updatedSegments = segments.map((segment, index) => {
        const duration = Number(segment.duration || Number(segment.sourceEnd) - Number(segment.sourceStart)) || 0;
        const isConfirmedGoal = segment.highlightType === "goal" &&
          segment.goalOutcome &&
          segment.goalOutcome.outcome === "confirmed_goal";
        if (!isConfirmedGoal) {
          timelineCursor += Math.max(0, duration);
          return segment;
        }
        const frameTime = Number(segment.finishTime) || Number(segment.sourceStart) || 0;
        const supportFrames = [
          { role: "pre_shot", time: Math.max(timelineCursor, frameTime - Number(segment.sourceStart || 0) - 1), status: "clear", clear: true },
          { role: "finish", time: Math.max(timelineCursor, frameTime - Number(segment.sourceStart || 0)), status: "clear", clear: true },
          { role: "payoff", time: Math.max(timelineCursor, frameTime - Number(segment.sourceStart || 0) + 0.8), status: "clear", clear: true },
          { role: "confirmation", time: Math.max(timelineCursor, Number(segment.confirmationTime || frameTime) - Number(segment.sourceStart || 0)), status: "clear", clear: true },
        ];
        timelineCursor += Math.max(0, duration);
        const finishFrameEvidence = {
          ...(segment.finishFrameEvidence || {}),
          frameTime,
          confidence: 0.91,
          visibilityVerdict: "clear",
          hasVisibleFinish: true,
          hasBallInNetOrPayoff: true,
          hasGoalMouth: true,
          hasPreShotActionFrame: true,
          hasFinishActionFrame: true,
          hasPayoffFrame: true,
          hasConfirmationFrame: true,
          continuousActionFrameCount: 4,
          supportFrames,
          isBlurred: false,
          isOverZoomed: false,
          isLabelOnly: false,
          isReplayOnly: false,
          isCelebrationOnly: false,
          isScoreboardOnly: false,
          isPlayerCloseupOnly: false,
          isFrameTooWideUnclear: false,
          evidenceCodes: ["rendered_finish_frame_visible", "ball_in_net_or_payoff_visible", "clear_goal_payoff_visible"],
          proofMethod: "mock_rendered_goal_proof",
        };
        return {
          ...segment,
          finishFrameEvidence,
          phaseCoverage: {
            ...(segment.phaseCoverage || {}),
            finishFrameEvidence,
            visualGoalPayoff: {
              ...((segment.phaseCoverage && segment.phaseCoverage.visualGoalPayoff) || {}),
              finishFrameEvidence,
            },
          },
        };
      });
      const goalCount = updatedSegments.filter((segment) =>
        segment.highlightType === "goal" &&
        segment.goalOutcome &&
        segment.goalOutcome.outcome === "confirmed_goal").length;
      const summary = {
        schemaVersion: 1,
        providerMode: "mock-rendered-goal-proof",
        goalCount,
        clearGoalCount: goalCount,
        borderlineGoalCount: 0,
        failedGoalCount: 0,
        contactSheetRef: "data/staging/rendered-goal-proof/unit/contact-sheet.json",
        goals: updatedSegments
          .filter((segment) => segment.highlightType === "goal")
          .map((segment, index) => ({
            goalNumber: segment.goalNumber || index + 1,
            segmentIndex: index + 1,
            verdict: "clear",
            frameCount: 4,
          })),
        logsDownloaded: false,
        artifactsDownloaded: false,
      };
      return {
        editPlan: { ...editPlan, segments: updatedSegments, renderedGoalProof: summary },
        summary,
      };
    },
    fileExists: () => true,
    isRegularFile: () => true,
    writeJsonAtomic: (filePath, payloadToWrite) => {
      writes.push({ filePath, payload: payloadToWrite });
    },
    scheduler: (fn) => fn(),
    ...options.dependencies,
  };
  context.dependencies = dependencies;
  return context;
}

async function runContext(context) {
  await runRenderJob({
    jobs: context.jobs,
    exportsById: context.exportsById,
    job: context.job,
    project: context.project,
    upload: context.upload,
    payload: context.payload,
    requestId: "req_orchestration_test",
    dependencies: context.dependencies,
  });
}

test("render orchestration completes success path with mocked adapters", async () => {
  const context = makeContext();
  await runContext(context);

  assert.equal(context.job.status, "completed");
  assert.equal(context.job.progress, 100);
  assert.equal(context.project.status, "ready");
  assert.equal(context.exportsById.size, 1);
  assert.equal(context.job.exportId, "exp_orchestration_test");
  assert.equal(context.renderObserved.exportCount, 0);
  assert.equal(context.renderObserved.projectStatus, "draft");
  assert.equal(context.writes.length, 1);
  assert.deepEqual(
    context.logs.filter((entry) => entry.event === "job_step").map((entry) => entry.step),
    [
      "extract_audio",
      "analyze_media",
      "extract_sampled_frames",
      "analyze_visuals",
      "analyze_scoreboard_ocr",
      "transcribe",
      "analyze_goal_evidence",
      "detect_highlights",
      "plan_story",
      "create_edit_plan",
      "render_kinetic_captions",
      "render_beat_effects",
      "render_short",
    ],
  );
  assert.equal(context.createPlanInput.styleTarget, "square_1_1");
  assert.equal(context.createPlanInput.editIntensity, "punchy");
  assert.equal(context.createPlanInput.stylePreset, "punchy_highlight");
  assert.equal(context.createPlanInput.language, "en");
  assert.equal(context.createPlanInput.matchEventTruth.providerMode, "mock-match-event-truth");
  assert.equal(context.calls.includes("analyze_frames"), true);
  assert.equal(context.calls.includes("analyze_tracking"), true);
  assert.equal(context.calls.includes("analyze_scoreboard_ocr"), true);
  assert.equal(context.calls.includes("analyze_goal_evidence"), true);
  assert.equal(context.calls.includes("analyze_match_event_truth"), true);
  assert.equal(context.calls.includes("extract_sampled_frames"), true);
  assert.equal(context.visualCandidateWindows.length > 0, true);
  assert.equal(context.job.progressMeta.phase, "completed");
  assert.equal(context.visualFrameCount, 1);
  assert.equal(context.cleanedFrameCount, 1);
  assert.equal(context.job.sampledFrames.summary.frameCount, 1);
  assert.doesNotMatch(JSON.stringify(context.job.sampledFrames), /\/Users|storageKey|localPath/i);
  const selectedPlanLog = context.logs.find((entry) => entry.event === "edit_plan_selected");
  assert.equal(selectedPlanLog.highlightType, "goal");
  assert.equal(selectedPlanLog.stylePreset, "social_sports_v1");
  assert.equal(selectedPlanLog.framingMode, "wide_safe_vertical");
  assert.equal(selectedPlanLog.falseGoalGuardTriggered, false);
  assert.equal(selectedPlanLog.visualProviderMode, "mock-vision");
  assert.equal(typeof selectedPlanLog.actionFocusConfidence, "number");
  const visualAnalysisLog = context.logs.find((entry) => entry.event === "visual_analysis_completed");
  assert.equal(visualAnalysisLog.providerMode, "mock-vision");
  assert.equal(visualAnalysisLog.frameCount, 1);
  assert.equal(visualAnalysisLog.visualWindowCount, 1);
  assert.equal(visualAnalysisLog.fallbackUsed, true);
  assert.equal(visualAnalysisLog.latencyMs, 5);
  assert.doesNotMatch(JSON.stringify(visualAnalysisLog), /\/Users|storageKey|localPath|secret/i);
  assert.equal(context.job.visualSignals.summary.goalClaimAllowed, false);
  assert.equal(context.job.scoreboardOcr.providerMode, "mock-scoreboard-ocr");
  assert.equal(context.job.scoreboardOcr.summary.evidenceCount, 0);
  assert.equal(context.job.goalEvidence.providerMode, "mock-goal-evidence");
  assert.equal(context.job.goalEvidence.summary.eventCount, 0);
  assert.equal(context.job.matchEventTruth.providerMode, "mock-match-event-truth");
  assert.equal(context.job.matchEventTruth.summary.confirmedGoalCount, 0);
  assert.equal(context.job.matchEventTruth.summary.noFalseGoalFromOcrOnly, 1);
  assert.equal(context.job.ocrQaCalibration.status, "missing");
  assert.equal(context.job.ocrQaCalibration.goalDecisionAllowed, false);
  assert.equal(context.goalEvidenceOcrQaCalibration.status, "missing");
  assert.equal(context.matchEventTruthOcrQaCalibration.status, "missing");
  assert.equal(context.job.visualTracking.goalClaimAllowed, false);
  assert.equal(context.job.trackingProviderOutput.providerMode, "mock-tracking");
  assert.equal(context.job.trackingProviderOutput.fallbackUsed, true);
  assert.equal(context.job.trackingProviderOutput.ballTrackCount, 0);
  assert.equal(typeof context.job.visualTracking.trackingConfidence, "number");
  const visualTrackingLog = context.logs.find((entry) => entry.event === "visual_tracking_completed");
  assert.equal(visualTrackingLog.providerMode, "mock-tracking");
  assert.equal(visualTrackingLog.recommendedFramingMode, "wide_safe");
  assert.equal(visualTrackingLog.ballTrackCount, 0);
  assert.equal(typeof visualTrackingLog.trackingConfidence, "number");
  assert.doesNotMatch(JSON.stringify(visualTrackingLog), /\/Users|storageKey|localPath|secret/i);
  const scoreboardOcrLog = context.logs.find((entry) => entry.event === "scoreboard_ocr_completed");
  assert.equal(scoreboardOcrLog.providerMode, "mock-scoreboard-ocr");
  assert.equal(scoreboardOcrLog.evidenceCount, 0);
  assert.equal(scoreboardOcrLog.sampledFrameCount, 1);
  assert.doesNotMatch(JSON.stringify(scoreboardOcrLog), /\/Users|storageKey|localPath|secret|rawOcr|rawText/i);
  const goalEvidenceLog = context.logs.find((entry) => entry.event === "goal_evidence_completed");
  assert.equal(goalEvidenceLog.providerMode, "mock-goal-evidence");
  assert.equal(goalEvidenceLog.evidenceEventCount, 0);
  assert.equal(goalEvidenceLog.ocrQaStatus, "missing");
  assert.equal(goalEvidenceLog.ocrQaUsable, false);
  const matchEventTruthLog = context.logs.find((entry) => entry.event === "match_event_truth_completed");
  assert.equal(matchEventTruthLog.providerMode, "mock-match-event-truth");
  assert.equal(matchEventTruthLog.confirmedGoalCount, 0);
  assert.equal(matchEventTruthLog.noFalseGoalFromOcrOnly, 1);
  assert.doesNotMatch(JSON.stringify(matchEventTruthLog), /\/Users|storageKey|localPath|secret|rawOcr|rawText/i);
  const ocrQaLog = context.logs.find((entry) => entry.event === "ocr_qa_calibration_loaded");
  assert.equal(ocrQaLog.status, "missing");
  assert.equal(ocrQaLog.goalEvidencePolicy, "support_only");
  assert.equal(ocrQaLog.goalDecisionAllowed, false);
  assert.equal(context.goalEvidenceOcrEvidenceCount, 0);
  assert.doesNotMatch(JSON.stringify(goalEvidenceLog), /\/Users|storageKey|localPath|secret/i);
});

test("youtube long-source render uses scorebug-first OCR before visual frame extraction", async () => {
  const context = makeContext({
    durationSeconds: 644,
    metadata: { sourceType: "youtube", videoId: "KxGedHh0Ruc" },
    matchEventTruth: countedGoalTruth(2),
    candidatePlans: [
      validGoalCompilationPlan([
        validGoalSegment(1, 31, 39, 47, 48),
        validGoalSegment(2, 108, 116, 125, 126),
      ]),
    ],
    scoreboardOcr: {
      providerMode: "mock-scoreboard-ocr",
      fallbackUsed: false,
      confidence: 0.9,
      evidence: [{
        id: "ocr_goal_1",
        timestamp: 512,
        scoreChanged: true,
        temporalConsistency: true,
        scoreBefore: "1-1",
        scoreAfter: "2-1",
        confidence: 0.92,
      }],
      summary: {
        evidenceCount: 1,
        scoreChangeCount: 1,
        scoreUnchangedCount: 0,
        ambiguousCount: 0,
        sampledFrameCount: 36,
        regionCount: 1,
        fallbackUsed: false,
        scoreTimeline: [{
          timestamp: 512,
          status: "score_changed",
          scoreBefore: "1-1",
          scoreAfter: "2-1",
          temporalConsistency: true,
        }],
      },
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "completed");
  assert.equal(context.calls.filter((call) => call === "analyze_scoreboard_ocr").length, 8);
  assert.ok(context.calls.indexOf("analyze_scoreboard_ocr") < context.calls.indexOf("extract_sampled_frames"));
  assert.equal(context.scoreboardOcrVisualWindowCount, 0);
  assert.equal(context.scoreboardOcrCalls.length, 8);
  assert.equal(context.scoreboardOcrCalls.every((call) => call.ocrSamplingWindows.length > 0), true);
  assert.equal(context.scoreboardOcrCalls.every((call) => call.scorebugFirstOnly === true), true);
  assert.equal(context.scoreboardOcrCalls.at(-1).ocrSamplingWindows.some((window) => Number(window.timestamp) >= 585), true);
  assert.equal(context.frameExtractionMaxFrames, 18);
  assert.equal(context.frameCandidateWindows.some((window) => (
    window.source === "scorebug_first_live_action_anchor" &&
    Number(window.time) === 506 &&
    Array.isArray(window.visualHints) &&
    window.visualHints.includes("shot_contact") &&
    window.visualHints.includes("goal_mouth_visible")
  )), true);
  assert.equal(context.frameCandidateWindows.some((window) => (
    window.source === "scorebug_first_live_action_anchor" &&
    Number(window.time) === 509 &&
    Array.isArray(window.visualHints) &&
    window.visualHints.includes("goal_mouth_visible")
  )), true);
  assert.equal(context.frameCandidateWindows.some((window) => window.source === "scorebug_first_score_confirmation" && Number(window.time) === 512), true);
  assert.equal(context.job.scoreboardOcr.providerMode, "chunked-scoreboard-ocr");
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunkCount, 8);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.scannedChunks, 8);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks.at(-1).end, 644);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].roiCandidateIds.includes("scorebug_broadcast_compact"), true);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].sampledFrameTimestamps.length > 0, true);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].plannedFrameCount > 0, true);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].attemptedRoiCount, 5);
  assert.equal(
    context.job.scoreboardOcr.summary.chunkSummary.chunks[0].attemptedObservationCount,
    context.job.scoreboardOcr.summary.chunkSummary.chunks[0].plannedFrameCount * 5,
  );
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].stableScoreDecision, "score_changes_detected");
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].normalizedScoreCandidates.includes("2-1"), true);
  const stepEvents = context.logs.filter((entry) => entry.event === "job_step");
  assert.equal(stepEvents.some((entry) => entry.step === "run_scorebug_ocr" && entry.progressMeta.scorebugFirst === true), true);
  assert.equal(stepEvents.some((entry) => entry.progressMeta.chunkIndex === 8), true);
  assert.equal(stepEvents.some((entry) => entry.substep === "scorebug_anchor_visual_windows"), true);
  assert.equal(context.job.progressMeta.longSource, true);
});

test("youtube long-source invalid narrowed visual output falls back before final gates", async () => {
  const context = makeContext({
    durationSeconds: 644,
    metadata: { sourceType: "youtube", videoId: "WuuGus5Obkg" },
    matchEventTruth: countedGoalTruth(1),
    candidatePlans: [
      validGoalCompilationPlan([
        validGoalSegment(1, 31, 39, 47, 48),
      ]),
    ],
    dependencies: {
      analyzeFrames: async () => {
        context.calls.push("analyze_frames");
        return {
          providerMode: "bad-vision",
          fallbackUsed: false,
          windows: [{ start: 12, end: 8, type: "shot_like_motion" }],
        };
      },
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "completed");
  assert.equal(context.calls.includes("analyze_goal_evidence"), true);
  assert.equal(context.job.visualSignals.providerMode, "scorebug-narrowed-visual-fallback");
  assert.equal(context.job.visualSignals.fallbackUsed, true);
  assert.equal(context.job.visualSignals.failure.code, "AI_OUTPUT_INVALID");
  assert.equal(context.logs.some((entry) => entry.event === "visual_analysis_fallback_used"), true);
  assert.doesNotMatch(JSON.stringify(context.job.visualSignals), /\/Users|storageKey|secret|stdout|stderr|raw/i);
});

test("youtube long-source invalid tracking output falls back before final gates", async () => {
  const context = makeContext({
    durationSeconds: 644,
    metadata: { sourceType: "youtube", videoId: "WuuGus5Obkg" },
    matchEventTruth: countedGoalTruth(1),
    candidatePlans: [
      validGoalCompilationPlan([
        validGoalSegment(1, 31, 39, 47, 48),
      ]),
    ],
    dependencies: {
      analyzeTracking: async () => {
        context.calls.push("analyze_tracking");
        return {
          providerMode: "bad-tracking",
          fallbackUsed: false,
          ballTracks: [{ timestamp: 40, label: "goal", bounds: { x: 0, y: 0, width: 100, height: 100 } }],
          playerClusters: [],
          actionBounds: null,
          actionCenter: null,
          cameraMotionLevel: 0,
          confidence: 0.9,
          reasonCodes: ["tracking_ball_visible"],
        };
      },
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "completed");
  assert.equal(context.calls.includes("analyze_goal_evidence"), true);
  assert.equal(context.job.trackingProviderOutput.providerMode, "safe-tracking-fallback");
  assert.equal(context.job.trackingProviderOutput.fallbackUsed, true);
  assert.equal(context.job.trackingProviderOutput.failure.code, "AI_OUTPUT_INVALID");
  assert.equal(context.logs.some((entry) => entry.event === "tracking_analysis_fallback_used"), true);
  assert.doesNotMatch(JSON.stringify(context.job.trackingProviderOutput), /\/Users|storageKey|secret|stdout|stderr|raw/i);
});

test("youtube long-source render fails closed with chunk context when scorebug OCR exceeds its budget", async () => {
  const context = makeContext({
    durationSeconds: 644,
    metadata: { sourceType: "youtube", videoId: "KxGedHh0Ruc" },
    dependencies: {
      scoreboardOcrTimeouts: { scorebugFirstMs: 250 },
      analyzeScoreboardOcr: async () => new Promise(() => {}),
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "failed");
  assert.equal(context.project.status, "failed");
  assert.equal(context.job.error.code, "SCOREBOARD_OCR_TIMEOUT");
  assert.equal(context.job.progressMeta.step, "run_scorebug_ocr");
  assert.equal(context.job.progressMeta.substep, "scorebug_first_chunk");
  assert.equal(context.job.progressMeta.chunkIndex, 1);
  assert.equal(context.job.progressMeta.chunkCount, 8);
  assert.equal(context.job.progressMeta.chunkStart, 0);
  assert.equal(context.job.progressMeta.chunkEnd, 90);
  assert.equal(context.job.progressMeta.budgetMs, 250);
  assert.equal(context.job.scoreboardOcr.providerMode, "chunked-scoreboard-ocr");
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunkCount, 8);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.scannedChunks, 0);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.skippedChunks >= 1, true);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].status, "timed_out");
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].sampledFrameTimestamps.length > 0, true);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].roiCandidateIds.includes("scoreboard_top_center"), true);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].plannedFrameCount > 0, true);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].attemptedRoiCount, 5);
  assert.equal(
    context.job.scoreboardOcr.summary.chunkSummary.chunks[0].attemptedObservationCount,
    context.job.scoreboardOcr.summary.chunkSummary.chunks[0].plannedFrameCount * 5,
  );
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].stableScoreDecision, "timed_out");
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[0].nextAction, "reduce-scorebug-ocr-workload-or-enable-scoreboard-ocr-qa-artifacts");
  assert.equal(context.job.scoreboardOcr.summary.scorebugDebug.attemptedRoiCount, 5);
  assert.equal(context.job.scoreboardOcr.summary.scorebugDebug.attemptedObservationCount > 0, true);
  assert.equal(context.job.scoreboardOcr.summary.scorebugDebug.reasonCodes.includes("scorebug_roi_candidates_attempted"), true);
  assert.equal(context.calls.includes("extract_sampled_frames"), false);
  assert.equal(context.calls.includes("render_short"), false);
  assert.doesNotMatch(JSON.stringify(context.job.error), /\/Users|storageKey|localPath|secret|stderr|stdout|rawOcr|rawText/i);
  assert.doesNotMatch(JSON.stringify(context.job.scoreboardOcr), /\/Users|storageKey|localPath|secret|stderr|stdout|rawOcr|rawText/i);
});

test("youtube long-source first OCR chunk timeout does not block later score changes", async () => {
  const truth = countedGoalTruth(1);
  truth.scoreChanges[0] = {
    ...truth.scoreChanges[0],
    changeTime: 612,
    actionAnchorTime: 603,
    startScore: "4-0",
    endScore: "5-0",
  };
  let callIndex = 0;
  const context = makeContext({
    durationSeconds: 644,
    metadata: { sourceType: "youtube", videoId: "KxGedHh0Ruc" },
    matchEventTruth: truth,
    candidatePlans: [
      validGoalCompilationPlan([
        validGoalSegment(1, 594, 603, 611, 612),
      ]),
    ],
    dependencies: {
      scoreboardOcrChunking: { chunkTimeoutMs: 250, totalBudgetMs: 4000 },
      analyzeScoreboardOcr: async ({ ocrSamplingWindows }) => {
        context.calls.push("analyze_scoreboard_ocr");
        context.scoreboardOcrCalls = context.scoreboardOcrCalls || [];
        context.scoreboardOcrCalls.push({ ocrSamplingWindows });
        callIndex += 1;
        if (callIndex === 1) return new Promise(() => {});
        const foundLateChunk = Array.isArray(ocrSamplingWindows) &&
          ocrSamplingWindows.some((window) => Number(window.timestamp) >= 600);
        return {
          providerMode: "mock-scoreboard-ocr",
          fallbackUsed: !foundLateChunk,
          confidence: foundLateChunk ? 0.94 : 0,
          evidence: foundLateChunk
            ? [{
                id: "late_ocr_goal_after_timeout",
                timestamp: 612,
                start: 610.8,
                end: 613.2,
                status: "score_changed",
                scoreChanged: true,
                temporalConsistency: true,
                scoreBefore: "4-0",
                scoreAfter: "5-0",
                confidence: 0.94,
                source: "late_chunk_scorebug",
              }]
            : [],
          summary: {
            evidenceCount: foundLateChunk ? 1 : 0,
            scoreChangeCount: foundLateChunk ? 1 : 0,
            scoreUnchangedCount: 0,
            ambiguousCount: 0,
            sampledFrameCount: Array.isArray(ocrSamplingWindows) ? ocrSamplingWindows.length : 0,
            regionCount: foundLateChunk ? 1 : 0,
            fallbackUsed: !foundLateChunk,
          },
        };
      },
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "completed", JSON.stringify(context.job.error));
  const chunkSummary = context.job.scoreboardOcr.summary.chunkSummary;
  assert.equal(chunkSummary.chunkCount, 8);
  assert.equal(chunkSummary.chunks[0].status, "timed_out");
  assert.equal(chunkSummary.timedOutChunks >= 1, true);
  assert.equal(chunkSummary.scannedChunks >= 6, true);
  assert.equal(chunkSummary.discoveredScoreChanges >= 1, true);
  assert.equal(chunkSummary.chunks.at(-1).status, "completed");
  assert.equal(chunkSummary.chunks.at(-1).stableScoreDecision, "score_changes_detected");
  assert.equal(chunkSummary.chunks.at(-1).normalizedScoreCandidates.includes("5-0"), true);
  assert.equal(context.frameCandidateWindows.some((window) => (
    window.source === "scorebug_first_live_action_anchor" &&
    Number(window.time) === 606 &&
    Array.isArray(window.visualHints) &&
    window.visualHints.includes("shot_contact") &&
    window.visualHints.includes("goal_mouth_visible")
  )), true);
  assert.equal(context.frameCandidateWindows.some((window) => (
    window.source === "scorebug_first_live_action_anchor" &&
    Number(window.time) === 609 &&
    Array.isArray(window.visualHints) &&
    window.visualHints.includes("goal_mouth_visible")
  )), true);
  assert.equal(context.frameCandidateWindows.some((window) => window.source === "scorebug_first_score_confirmation" && Number(window.time) === 612), true);
  assert.equal(context.job.videoOutputQA.coveredGoalCount, 1);
  assert.doesNotMatch(JSON.stringify(context.job.scoreboardOcr), /\/Users|storageKey|localPath|secret|stderr|stdout|rawOcr|rawText/i);
});

test("youtube long-source chunked OCR reuses selected scorebug ROI after calibration", async () => {
  const truth = countedGoalTruth(1);
  truth.scoreChanges[0] = {
    ...truth.scoreChanges[0],
    changeTime: 612,
    actionAnchorTime: 603,
    startScore: "4-0",
    endScore: "5-0",
  };
  let callIndex = 0;
  const context = makeContext({
    durationSeconds: 644,
    metadata: { sourceType: "youtube", videoId: "KxGedHh0Ruc" },
    matchEventTruth: truth,
    candidatePlans: [
      validGoalCompilationPlan([
        validGoalSegment(1, 594, 603, 611, 612),
      ]),
    ],
    dependencies: {
      analyzeScoreboardOcr: async ({ ocrSamplingWindows, scorebugFirstRegionIds }) => {
        context.calls.push("analyze_scoreboard_ocr");
        context.scoreboardOcrCalls = context.scoreboardOcrCalls || [];
        context.scoreboardOcrCalls.push({
          ocrSamplingWindows,
          scorebugFirstRegionIds: Array.isArray(scorebugFirstRegionIds) ? scorebugFirstRegionIds : [],
        });
        callIndex += 1;
        const foundLateChunk = Array.isArray(ocrSamplingWindows) &&
          ocrSamplingWindows.some((window) => Number(window.timestamp) >= 600);
        return {
          providerMode: "mock-scoreboard-ocr",
          fallbackUsed: false,
          confidence: foundLateChunk ? 0.94 : 0.72,
          evidence: foundLateChunk
            ? [{
                id: "late_ocr_goal_after_roi_calibration",
                timestamp: 612,
                start: 610.8,
                end: 613.2,
                status: "score_changed",
                scoreChanged: true,
                temporalConsistency: true,
                scoreBefore: "4-0",
                scoreAfter: "5-0",
                confidence: 0.94,
                source: "late_chunk_scorebug",
              }]
            : [],
          summary: {
            evidenceCount: foundLateChunk ? 1 : 0,
            scoreChangeCount: foundLateChunk ? 1 : 0,
            scoreUnchangedCount: foundLateChunk ? 0 : 1,
            ambiguousCount: 0,
            sampledFrameCount: Array.isArray(ocrSamplingWindows) ? ocrSamplingWindows.length : 0,
            regionCount: Array.isArray(ocrSamplingWindows) ? ocrSamplingWindows.length : 0,
            fallbackUsed: false,
            roiCalibration: {
              selectedRoi: {
                regionId: "scorebug_broadcast_compact",
                layoutId: "broadcast-compact-score-only-v1",
                readableObservationCount: 1,
                scoreChangeCount: foundLateChunk ? 1 : 0,
                averageConfidence: foundLateChunk ? 0.94 : 0.72,
                reasonCodes: ["scorebug_region_readable"],
              },
              candidateCount: 1,
            },
            scorebugDebug: {
              selectedRoi: {
                regionId: "scorebug_broadcast_compact",
                layoutId: "broadcast-compact-score-only-v1",
                readableObservationCount: 1,
                scoreChangeCount: foundLateChunk ? 1 : 0,
                averageConfidence: foundLateChunk ? 0.94 : 0.72,
                reasonCodes: ["scorebug_region_readable"],
              },
              readableObservationCount: 1,
              attemptedObservationCount: Array.isArray(ocrSamplingWindows) ? ocrSamplingWindows.length : 0,
              reasonCodes: ["scorebug_region_readable"],
            },
          },
        };
      },
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "completed", JSON.stringify(context.job.error));
  assert.equal(callIndex, 8);
  assert.deepEqual(context.scoreboardOcrCalls[0].scorebugFirstRegionIds, []);
  assert.equal(
    context.scoreboardOcrCalls.slice(1).every((call) =>
      call.scorebugFirstRegionIds.length === 1 &&
      call.scorebugFirstRegionIds[0] === "scorebug_broadcast_compact"),
    true,
  );
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[1].roiCandidateIds.length, 1);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.chunks[1].attemptedRoiCount, 1);
  assert.equal(context.job.scoreboardOcr.summary.scoreChangeCount, 1);
  assert.equal(context.job.videoOutputQA.coveredGoalCount, 1);
});

test("youtube long-source chunked OCR builds global score changes across chunks", async () => {
  const truth = countedGoalTruth(1);
  truth.scoreChanges[0] = {
    ...truth.scoreChanges[0],
    changeTime: 126,
    actionAnchorTime: 116,
    startScore: "0-0",
    endScore: "1-0",
  };
  const context = makeContext({
    durationSeconds: 220,
    metadata: { sourceType: "youtube", videoId: "WuuGus5Obkg" },
    matchEventTruth: truth,
    candidatePlans: [
      validGoalCompilationPlan([
        validGoalSegment(1, 108, 116, 125, 126),
      ]),
    ],
    dependencies: {
      analyzeScoreboardOcr: async ({ ocrSamplingWindows, scorebugFirstRegionIds }) => {
        context.calls.push("analyze_scoreboard_ocr");
        context.scoreboardOcrCalls = context.scoreboardOcrCalls || [];
        context.scoreboardOcrCalls.push({
          ocrSamplingWindows,
          scorebugFirstRegionIds: Array.isArray(scorebugFirstRegionIds) ? scorebugFirstRegionIds : [],
        });
        const lateChunk = Array.isArray(ocrSamplingWindows) &&
          ocrSamplingWindows.some((window) => Number(window.timestamp) >= 90);
        const scoreAfter = lateChunk ? "1-0" : "0-0";
        const baseTimestamp = lateChunk ? 122 : 42;
        const evidence = [0, 8].map((offset, index) => ({
          id: `chunk_static_score_${lateChunk ? "after" : "before"}_${index + 1}`,
          timestamp: baseTimestamp + offset,
          start: baseTimestamp + offset - 0.8,
          end: baseTimestamp + offset + 0.8,
          status: index === 0 ? "ambiguous" : "score_unchanged",
          scoreChanged: false,
          scoreUnchanged: index > 0,
          temporalConsistency: index > 0,
          scoreBefore: scoreAfter,
          scoreAfter,
          confidence: 0.88,
          source: "chunk_static_scorebug",
          regionId: "scorebug_broadcast_compact",
          layoutId: "broadcast-compact-score-only-v1",
        }));
        return {
          providerMode: "mock-scoreboard-ocr",
          fallbackUsed: false,
          confidence: 0.88,
          evidence,
          summary: {
            evidenceCount: evidence.length,
            scoreChangeCount: 0,
            scoreUnchangedCount: 1,
            ambiguousCount: 1,
            sampledFrameCount: Array.isArray(ocrSamplingWindows) ? ocrSamplingWindows.length : 0,
            regionCount: Array.isArray(ocrSamplingWindows) ? ocrSamplingWindows.length : 0,
            fallbackUsed: false,
            roiCalibration: {
              selectedRoi: {
                regionId: "scorebug_broadcast_compact",
                layoutId: "broadcast-compact-score-only-v1",
                readableObservationCount: evidence.length,
                scoreChangeCount: 0,
                averageConfidence: 0.88,
                reasonCodes: ["scorebug_region_readable", "static_score_timeline"],
              },
              candidateCount: 1,
            },
            scorebugDebug: {
              selectedRoi: {
                regionId: "scorebug_broadcast_compact",
                layoutId: "broadcast-compact-score-only-v1",
                readableObservationCount: evidence.length,
                scoreChangeCount: 0,
                averageConfidence: 0.88,
                reasonCodes: ["scorebug_region_readable", "static_score_timeline"],
              },
              readableObservationCount: evidence.length,
              attemptedObservationCount: evidence.length,
              reasonCodes: ["scorebug_region_readable", "static_score_timeline"],
            },
          },
        };
      },
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "completed", JSON.stringify(context.job.error));
  assert.equal(context.job.scoreboardOcr.summary.scoreChangeCount, 1);
  assert.equal(
    context.job.scoreboardOcr.summary.scoreTimeline.some((item) =>
      item.status === "score_changed" &&
      item.scoreBefore === "0-0" &&
      item.scoreAfter === "1-0"),
    true,
  );
  assert.equal(
    context.job.scoreboardOcr.evidence.some((item) =>
      item.status === "score_changed" &&
      item.scoreBefore === "0-0" &&
      item.scoreAfter === "1-0" &&
      item.source === "chunked_scorebug_global_timeline"),
    true,
  );
  assert.equal(context.job.scoreboardOcr.summary.scorebugDebug.state, "score_changes_detected");
  assert.equal(context.frameCandidateWindows.some((window) => (
    window.source === "scorebug_first_live_action_anchor" &&
    Array.isArray(window.visualHints) &&
    window.visualHints.includes("shot_contact") &&
    window.visualHints.includes("goal_mouth_visible")
  )), true);
  assert.equal(context.frameCandidateWindows.some((window) => window.source === "scorebug_first_score_confirmation"), true);
  assert.doesNotMatch(JSON.stringify(context.job.scoreboardOcr), /\/Users|storageKey|localPath|secret|stderr|stdout|rawOcr|rawText/i);
});

test("youtube long-source chunked OCR promotes five observed score changes without synthetic bridges", async () => {
  const truth = countedGoalTruth(3);
  truth.scoreChanges = [
    { changeTime: 123, actionAnchorTime: 115, startScore: "0-0", endScore: "1-0", outcome: "counted_goal", teamSide: "home", scoreDelta: 1, confidence: 0.9, reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"] },
    { changeTime: 483, actionAnchorTime: 475, startScore: "1-0", endScore: "1-1", outcome: "counted_goal", teamSide: "away", scoreDelta: 1, confidence: 0.9, reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"] },
    { changeTime: 520, actionAnchorTime: 512, startScore: "1-1", endScore: "2-1", outcome: "counted_goal", teamSide: "home", scoreDelta: 1, confidence: 0.9, reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"] },
    { changeTime: 550, actionAnchorTime: 542, startScore: "2-1", endScore: "2-2", outcome: "counted_goal", teamSide: "away", scoreDelta: 1, confidence: 0.9, reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"] },
    { changeTime: 620, actionAnchorTime: 612, startScore: "2-2", endScore: "3-2", outcome: "counted_goal", teamSide: "home", scoreDelta: 1, confidence: 0.9, reasonCodes: ["scoreboard_ocr_score_change", "scoreboard_temporal_consistency"] },
  ];
  truth.summary = {
    ...truth.summary,
    countedGoalEventCount: 5,
    scoreChangeCount: 5,
    selectedCountedGoals: 5,
  };
  const segments = [
    validGoalSegment(1, 113, 119, 121, 123),
    validGoalSegment(2, 473, 479, 481, 483),
    validGoalSegment(3, 510, 516, 518, 520),
    validGoalSegment(4, 540, 546, 548, 550),
    validGoalSegment(5, 610, 616, 618, 620),
  ];
  const context = makeContext({
    durationSeconds: 764,
    metadata: { sourceType: "youtube", videoId: "WuuGus5Obkg", expectedCountedGoals: 5 },
    matchEventTruth: truth,
    candidatePlans: [validGoalCompilationPlan(segments)],
    dependencies: {
      analyzeScoreboardOcr: async ({ ocrSamplingWindows }) => {
        context.calls.push("analyze_scoreboard_ocr");
        const timestamps = (Array.isArray(ocrSamplingWindows) ? ocrSamplingWindows : [])
          .map((window) => Number(window.timestamp))
          .filter(Number.isFinite);
        const start = Math.min(...timestamps);
        const candidates = start < 90
          ? ["0-0"]
          : start < 180
            ? ["1-0"]
            : start < 270
              ? [
                  { score: "1-0", timestamp: 236.25 },
                  { score: "1-1", timestamp: 260.25 },
                ]
              : start < 360
                ? ["3-3", "0-0"]
                : start < 450
                  ? []
                  : start < 540
                    ? ["4-1", "0-0", "6-6", "2-1"]
                    : start < 630
                      ? ["2-2", "3-2"]
                      : start < 720
                        ? ["3-2"]
                        : [];
        const scoreTimeline = candidates.map((candidate, index) => {
          const score = typeof candidate === "string" ? candidate : candidate.score;
          return {
          timestamp: Number(candidate && candidate.timestamp) || timestamps[index] || start + index + 1,
          status: "ambiguous",
          detectedScoreText: score,
          scoreAfter: score,
          temporalConsistency: false,
          confidence: 0.75,
          source: "mock_sparse_scorebug_candidate",
          regionId: "scorebug_broadcast_compact",
          layoutId: "broadcast-compact-score-only-v1",
          transitionDecision: "score_candidate_pending_progression",
          transitionReasonCodes: ["unit_score_increase_candidate"],
        };
        });
        return {
          providerMode: "mock-scoreboard-ocr",
          fallbackUsed: false,
          confidence: candidates.length ? 0.78 : 0,
          evidence: [],
          summary: {
            evidenceCount: scoreTimeline.length,
            scoreChangeCount: 0,
            scoreUnchangedCount: 0,
            ambiguousCount: scoreTimeline.length,
            sampledFrameCount: timestamps.length,
            regionCount: timestamps.length,
            fallbackUsed: false,
            scoreTimeline,
            roiCalibration: {
              selectedRoi: {
                regionId: "scorebug_broadcast_compact",
                layoutId: "broadcast-compact-score-only-v1",
                readableObservationCount: scoreTimeline.length,
                scoreChangeCount: 0,
                averageConfidence: 0.78,
                reasonCodes: ["scorebug_region_readable", "ambiguous_score_timeline"],
              },
              candidateCount: 1,
            },
            scorebugDebug: {
              selectedRoi: {
                regionId: "scorebug_broadcast_compact",
                layoutId: "broadcast-compact-score-only-v1",
                readableObservationCount: scoreTimeline.length,
                scoreChangeCount: 0,
                averageConfidence: 0.78,
                reasonCodes: ["scorebug_region_readable", "ambiguous_score_timeline"],
              },
              textPresentObservationCount: scoreTimeline.length,
              readableObservationCount: scoreTimeline.length,
              attemptedObservationCount: timestamps.length,
              reasonCodes: ["scorebug_region_readable", "ambiguous_score_timeline"],
            },
          },
        };
      },
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "completed", JSON.stringify(context.job.error));
  assert.equal(context.job.scoreboardOcr.summary.scoreChangeCount, 5);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.discoveredScoreChanges, 5);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.scoreCandidateDiagnostics.acceptedScoreChangeCount, 5);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.scoreCandidateDiagnostics.finalScore, "3-2");
  assert.equal(
    context.job.scoreboardOcr.evidence.filter((item) => item.source === "chunked_scorebug_candidate_progression").length >= 4,
    true,
  );
  assert.equal(
    context.job.scoreboardOcr.evidence
      .filter((item) => item.source === "chunked_scorebug_candidate_progression")
      .every((item) => item.synthetic !== true && item.bridgeGenerated !== true),
    true,
  );
  const acceptedScoreChangeTimestamps = context.job.scoreboardOcr.summary.chunkSummary.scoreCandidateDiagnostics.acceptedCandidates
    .filter((candidate) => candidate.scoreBefore && candidate.scoreAfter)
    .map((candidate) => Number(candidate.timestamp))
    .filter(Number.isFinite);
  assert.equal(acceptedScoreChangeTimestamps.length >= 4, true);
  for (let index = 1; index < acceptedScoreChangeTimestamps.length; index += 1) {
    assert.equal(
      acceptedScoreChangeTimestamps[index] - acceptedScoreChangeTimestamps[index - 1] >= 10,
      true,
      JSON.stringify(acceptedScoreChangeTimestamps),
    );
  }
  assert.equal(
    context.job.scoreboardOcr.evidence.some((item) =>
      item.status === "score_changed" &&
      item.scoreBefore === "0-0" &&
      item.scoreAfter === "1-0"),
    true,
  );
  assert.equal(
    context.job.scoreboardOcr.evidence.some((item) =>
      item.status === "score_changed" &&
      item.scoreBefore === "1-0" &&
      item.scoreAfter === "1-1"),
    true,
  );
  assert.equal(
    context.job.scoreboardOcr.summary.chunkSummary.scoreCandidateDiagnostics.rejectedCandidates.some((candidate) =>
      candidate.score === "6-6" && candidate.reason === "score_candidate_jump_too_large"),
    true,
  );
  assert.equal(
      context.frameCandidateWindows.filter((window) => (
      window.source === "scorebug_first_live_action_anchor" &&
      Array.isArray(window.visualHints) &&
      window.visualHints.includes("shot_contact") &&
      window.visualHints.includes("goal_mouth_visible")
    )).length >= 5,
    true,
  );
  assert.equal(
    context.frameCandidateWindows.filter((window) => (
      window.source === "scorebug_first_delayed_finish_anchor" &&
      Array.isArray(window.visualHints) &&
      window.visualHints.includes("shot_contact") &&
      window.visualHints.includes("goal_mouth_visible")
    )).length >= 5,
    true,
  );
  assert.doesNotMatch(JSON.stringify(context.job.scoreboardOcr), /\/Users|storageKey|localPath|secret|stderr|stdout|rawOcr|rawText/i);
});

test("youtube long-source chunked OCR can discover late score changes", async () => {
  const truth = countedGoalTruth(1);
  truth.scoreChanges[0] = {
    ...truth.scoreChanges[0],
    changeTime: 612,
    actionAnchorTime: 603,
    startScore: "4-0",
    endScore: "5-0",
  };
  const context = makeContext({
    durationSeconds: 644,
    metadata: { sourceType: "youtube", videoId: "KxGedHh0Ruc" },
    matchEventTruth: truth,
    candidatePlans: [
      validGoalCompilationPlan([
        validGoalSegment(1, 594, 603, 611, 612),
      ]),
    ],
    dependencies: {
      analyzeScoreboardOcr: async ({ ocrSamplingWindows }) => {
        context.calls.push("analyze_scoreboard_ocr");
        context.scoreboardOcrCalls = context.scoreboardOcrCalls || [];
        context.scoreboardOcrCalls.push({ ocrSamplingWindows });
        const foundLateChunk = Array.isArray(ocrSamplingWindows) &&
          ocrSamplingWindows.some((window) => Number(window.timestamp) >= 600);
        return {
          providerMode: "mock-scoreboard-ocr",
          fallbackUsed: !foundLateChunk,
          confidence: foundLateChunk ? 0.94 : 0,
          evidence: foundLateChunk
            ? [{
                id: "late_ocr_goal_5",
                timestamp: 612,
                start: 610.8,
                end: 613.2,
                status: "score_changed",
                scoreChanged: true,
                temporalConsistency: true,
                scoreBefore: "4-0",
                scoreAfter: "5-0",
                confidence: 0.94,
                source: "late_chunk_scorebug",
              }]
            : [],
          summary: {
            evidenceCount: foundLateChunk ? 1 : 0,
            scoreChangeCount: foundLateChunk ? 1 : 0,
            scoreUnchangedCount: 0,
            ambiguousCount: 0,
            sampledFrameCount: Array.isArray(ocrSamplingWindows) ? ocrSamplingWindows.length : 0,
            regionCount: foundLateChunk ? 1 : 0,
            fallbackUsed: !foundLateChunk,
          },
        };
      },
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "completed", JSON.stringify(context.job.error));
  assert.equal(context.job.scoreboardOcr.summary.scoreChangeCount, 1);
  assert.equal(context.job.scoreboardOcr.summary.chunkSummary.scannedChunks, 8);
  assert.equal(context.frameCandidateWindows.some((window) => (
    window.source === "scorebug_first_live_action_anchor" &&
    Number(window.time) === 606 &&
    Array.isArray(window.visualHints) &&
    window.visualHints.includes("shot_contact") &&
    window.visualHints.includes("goal_mouth_visible")
  )), true);
  assert.equal(context.frameCandidateWindows.some((window) => (
    window.source === "scorebug_first_live_action_anchor" &&
    Number(window.time) === 609 &&
    Array.isArray(window.visualHints) &&
    window.visualHints.includes("goal_mouth_visible")
  )), true);
  assert.equal(context.frameCandidateWindows.some((window) => window.source === "scorebug_first_score_confirmation" && Number(window.time) === 612), true);
  assert.equal(context.job.videoOutputQA.coveredGoalCount, 1);
});

test("render orchestration passes OCR QA calibration into goal evidence analysis", async () => {
  const context = makeContext({
    ocrQaCalibration: {
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
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "completed");
  assert.equal(context.goalEvidenceOcrQaCalibration.usable, true);
  assert.equal(context.goalEvidenceOcrQaCalibration.decisionSupportLevel, "strong");
  assert.equal(context.job.ocrQaCalibration.decisionSupportLevel, "strong");
  assert.equal(context.job.goalEvidence.summary.ocrQaSupportLevel, "strong");
  assert.equal(context.matchEventTruthOcrQaCalibration.decisionSupportLevel, "strong");
  assert.equal(context.job.matchEventTruth.summary.ocrQaSupportStatus, "usable");
  const ocrQaLog = context.logs.find((entry) => entry.event === "ocr_qa_calibration_loaded");
  assert.equal(ocrQaLog.usable, true);
  assert.equal(ocrQaLog.decisionSupportLevel, "strong");
  assert.doesNotMatch(JSON.stringify(ocrQaLog), /\/Users|storageKey|localPath|secret|rawOcr|rawText/i);
});

test("OCR QA calibration env option is passed to the loader without leaking the ref", async () => {
  const previousRef = process.env.SHORTSENGINE_OCR_QA_REVIEW_REF;
  process.env.SHORTSENGINE_OCR_QA_REVIEW_REF = "demo/results/ocr-qa-review-2026-06-19T10-00-00-000Z.json";
  try {
    const context = makeContext();
    await runContext(context);

    assert.equal(
      context.loadOcrQaCalibrationOptions.reportRef,
      "demo/results/ocr-qa-review-2026-06-19T10-00-00-000Z.json",
    );
    const ocrQaLog = context.logs.find((entry) => entry.event === "ocr_qa_calibration_loaded");
    assert.equal(ocrQaLog.reportRefConfigured, true);
    assert.doesNotMatch(
      JSON.stringify(ocrQaLog),
      /ocr-qa-review-2026-06-19T10-00-00-000Z|\/Users|storageKey|localPath|secret|rawOcr|rawText/i,
    );
  } finally {
    if (previousRef === undefined) {
      delete process.env.SHORTSENGINE_OCR_QA_REVIEW_REF;
    } else {
      process.env.SHORTSENGINE_OCR_QA_REVIEW_REF = previousRef;
    }
  }
});

test("OCR QA calibration env helper returns an empty option by default", () => {
  assert.deepEqual(ocrQaCalibrationOptionsFromEnv({}), {});
  assert.deepEqual(ocrQaCalibrationOptionsFromEnv({ SHORTSENGINE_OCR_QA_REVIEW_REF: "demo/results/ocr-qa-review-latest.json" }), {
    reportRef: "demo/results/ocr-qa-review-latest.json",
  });
});

test("youtube long-source render requests valid-goals-only planning", async () => {
  const context = makeContext({
    durationSeconds: 240,
    metadata: { sourceType: "youtube", videoId: "dQw4w9WgXcQ" },
    matchEventTruth: countedGoalTruth(2),
    candidatePlans: [
      validGoalCompilationPlan([
        validGoalSegment(1, 31, 39, 47, 48),
        validGoalSegment(2, 108, 116, 125, 126),
      ]),
    ],
  });
  await runContext(context);

  assert.equal(context.job.status, "completed");
  assert.equal(context.createPlanInput.metadata.goalSelectionMode, "valid_goals_only");
  assert.equal(context.job.videoOutputQA.expectedGoalCount, 2);
  assert.equal(context.job.videoOutputQA.coveredGoalCount, 2);
});

test("render orchestration passes scoreboard OCR evidence into goal evidence analysis", async () => {
  const context = makeContext({
    scoreboardOcr: {
      providerMode: "mock-scoreboard-ocr",
      fallbackUsed: false,
      confidence: 0.88,
      evidence: [{
        id: "ocr_1",
        timestamp: 6,
        start: 5.5,
        end: 6.5,
        status: "score_changed",
        scoreBefore: "0-0",
        scoreAfter: "1-0",
        confidence: 0.88,
        temporalConsistency: true,
        ambiguous: false,
        scoreChanged: true,
        scoreUnchanged: false,
        source: "test_fixture",
      }],
      summary: {
        evidenceCount: 1,
        scoreChangeCount: 1,
        scoreUnchangedCount: 0,
        ambiguousCount: 0,
        sampledFrameCount: 1,
        regionCount: 3,
        fallbackUsed: false,
      },
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "completed");
  assert.equal(context.job.scoreboardOcr.summary.evidenceCount, 1);
  assert.equal(context.goalEvidenceOcrEvidenceCount, 1);
  const scoreboardOcrLog = context.logs.find((entry) => entry.event === "scoreboard_ocr_completed");
  assert.equal(scoreboardOcrLog.scoreChangeCount, 1);
  assert.doesNotMatch(JSON.stringify(context.job.scoreboardOcr), /\/Users|storageKey|localPath|secret|rawOcr|rawText/i);
});

test("visual candidate windows keep late long-source regions before frame extraction", () => {
  const mediaSignals = {
    durationSeconds: 360,
    highMotionCandidates: Array.from({ length: 32 }, (_, index) => ({
      time: 6 + index * 8,
      confidence: 0.74 + (index % 5) * 0.03,
      source: "signal_cluster",
    })),
    audioPeaks: [
      { time: 22, energyScore: 0.95, source: "fixture" },
      { time: 248, energyScore: 0.91, source: "fixture" },
      { time: 324, energyScore: 0.93, source: "fixture" },
    ],
    sceneChanges: [
      { time: 64, confidence: 0.82, source: "fixture" },
      { time: 264, confidence: 0.81, source: "fixture" },
      { time: 337, confidence: 0.83, source: "fixture" },
    ],
  };

  const windows = visualCandidateWindowsFromSignals(mediaSignals);

  assert.ok(windows.length <= 24);
  assert.ok(windows.some((window) => Number(window.time) >= 240));
  assert.ok(windows.some((window) => Number(window.time) >= 320));
  assert.ok(windows.some((window) => Array.isArray(window.visualHints) && window.visualHints.includes("shot_like_motion")));
});

test("score-change OCR windows add bounded live finish probes for long-source proof", () => {
  const windows = scoreChangeCandidateWindowsFromOcr({
    evidence: [
      {
        timestamp: 236.25,
        status: "score_changed",
        scoreChanged: true,
        temporalConsistency: true,
        confidence: 0.94,
        scoreBefore: "0-0",
        scoreAfter: "1-0",
      },
      {
        timestamp: 596.25,
        status: "score_changed",
        scoreChanged: true,
        temporalConsistency: true,
        confidence: 0.92,
        scoreBefore: "2-2",
        scoreAfter: "3-2",
      },
    ],
  }, { durationSeconds: 764.52 });

  const liveAnchors = windows.filter((window) => window.source === "scorebug_first_live_action_anchor");
  const phaseBacktracks = windows.filter((window) => window.source === "scorebug_first_live_phase_backtrack");
  const confirmations = windows.filter((window) => window.source === "scorebug_first_score_confirmation");

  assert.equal(confirmations.length, 2);
  assert.equal(phaseBacktracks.length, 2);
  assert.ok(phaseBacktracks.every((window) => Number(window.backtrackOffsetSeconds) === 24));
  assert.ok(phaseBacktracks.some((window) => Number(window.scoreChangeTime) === 596.25 && Number(window.time) === 572.25));
  assert.ok(liveAnchors.some((window) => Number(window.scoreChangeTime) === 236.25 && window.visualHints.includes("shot_contact")));
  assert.ok(liveAnchors.some((window) => Number(window.scoreChangeTime) === 596.25 && window.visualHints.includes("goal_mouth_visible")));
  assert.ok(windows.every((window) => Number(window.time) >= 0 && Number(window.time) <= 764.52));
  assert.doesNotMatch(JSON.stringify(windows), /\/Users|storageKey|secret|stderr|stdout/i);
});

test("youtube valid-goals-only render fails closed when no valid goals are found", async () => {
  const context = makeContext({
    durationSeconds: 180,
    metadata: { sourceType: "youtube", videoId: "dQw4w9WgXcQ" },
    goalEvidence: {
      providerMode: "mock-goal-evidence",
      fallbackUsed: false,
      confidence: 0.58,
      events: [{
        id: "non_goal_chance_1",
        start: 42,
        end: 56,
        outcomeHint: "non_goal_chance",
        confidence: 0.58,
        reasonCodes: ["non_goal_chance", "shot_sequence_support"],
        missingEvidence: ["explicit_ball_in_net", "decision_or_reaction_confirmation"],
        recoveryEligibility: "not_recoverable",
        rejectionReason: "explicit_ball_in_net",
      }],
      supplementalVisualWindows: [],
      summary: {
        eventCount: 1,
        validGoalCount: 0,
        offsideOrNoGoalCount: 0,
        unconfirmedGoalCount: 0,
        nonGoalChanceCount: 1,
        celebrationOnlyCount: 0,
        anthemOrIntroCount: 0,
        ocrEvidenceCount: 0,
        scoreboardConfirmedGoalCount: 0,
        ambiguousOcrCount: 0,
        rejectedCandidateCount: 1,
        goalEvidenceCoverage: 0,
      },
    },
    candidatePlans: [],
  });
  await runContext(context);

  assert.equal(context.job.status, "failed");
  assert.equal(context.project.status, "failed");
  assert.equal(context.exportsById.size, 0);
  assert.equal(context.job.error.code, "NO_VALID_GOALS_FOUND");
  assert.equal(context.job.error.details.phase, "planning");
  assert.equal(context.job.error.details.step, "create_edit_plan");
  assert.equal(context.job.error.details.substep, "build_edit_plan");
  assert.equal(context.job.error.details.sourceValidated, true);
  assert.equal(context.job.error.details.downloadedSourceReady, true);
  assert.equal(context.job.error.details.candidateCount, 1);
  assert.equal(context.job.error.details.rejectedCandidateCount, 1);
  assert.deepEqual(context.job.error.details.topRejectionReasons, [
    { reason: "explicit_ball_in_net", count: 2 },
    { reason: "decision_or_reaction_confirmation", count: 1 },
  ]);
  assert.equal(context.job.error.details.goalEvidenceCandidates[0].outcomeHint, "non_goal_chance");
  assert.equal(context.calls.includes("render_short"), false);
  assert.doesNotMatch(JSON.stringify(context.job.error), /\/Users|storageKey|secret|stderr|stdout/i);
});

test("youtube valid-goals-only output gate fails when final plan misses counted goals", async () => {
  const context = makeContext({
    durationSeconds: 240,
    metadata: { sourceType: "youtube", videoId: "gxiRyFZXJV8" },
    matchEventTruth: countedGoalTruth(3),
    candidatePlans: [
      validGoalCompilationPlan([
        validGoalSegment(1, 31, 39, 47, 48),
        validGoalSegment(2, 108, 116, 125, 126),
      ]),
    ],
  });
  await runContext(context);

  assert.equal(context.job.status, "failed");
  assert.equal(context.project.status, "failed");
  assert.equal(context.exportsById.size, 0);
  assert.equal(context.job.error.code, "VIDEO_OUTPUT_QA_FAILED");
  assert.equal(context.job.videoOutputQA.status, "failed");
  assert.equal(context.job.videoOutputQA.expectedGoalCount, 3);
  assert.equal(context.job.videoOutputQA.actualConfirmedGoalSegmentCount, 2);
  assert.equal(context.job.videoOutputQA.coveredGoalCount, 2);
  assert.deepEqual(context.job.videoOutputQA.missingGoalNumbers, [3]);
  assert.equal(context.job.step, "failed");
  const qaLog = context.logs.find((entry) => entry.event === "video_output_qa_failed");
  assert.equal(qaLog.expectedGoalCount, 3);
  assert.deepEqual(qaLog.missingGoalNumbers, [3]);
  assert.equal(context.calls.includes("render_short"), false);
  assert.doesNotMatch(JSON.stringify(context.job.videoOutputQA), /\/Users|storageKey|secret|stderr|stdout|rawOcr|rawText/i);
  assert.doesNotMatch(JSON.stringify(context.job.error), /\/Users|storageKey|secret|stderr|stdout|rawOcr|rawText/i);
});

test("youtube valid-goals-only output gate rejects non-goal filler segments", async () => {
  const context = makeContext({
    durationSeconds: 240,
    metadata: { sourceType: "youtube", videoId: "gxiRyFZXJV8" },
    matchEventTruth: countedGoalTruth(1),
    candidatePlans: [
      validGoalCompilationPlan([
        validGoalSegment(1, 31, 39, 47, 48),
        nonGoalFillerSegment(),
      ]),
    ],
  });
  await runContext(context);

  assert.equal(context.job.status, "failed");
  assert.equal(context.exportsById.size, 0);
  assert.equal(context.job.error.code, "VIDEO_OUTPUT_QA_FAILED");
  assert.equal(context.job.videoOutputQA.status, "failed");
  assert.equal(context.job.videoOutputQA.failedReasons.includes("non_goal_segments_present"), true);
  assert.equal(context.calls.includes("render_short"), false);
});

test("youtube valid-goals-only output gate passes when all counted goals are covered", async () => {
  const context = makeContext({
    durationSeconds: 240,
    metadata: { sourceType: "youtube", videoId: "gxiRyFZXJV8" },
    matchEventTruth: countedGoalTruth(3),
    candidatePlans: [
      validGoalCompilationPlan([
        validGoalSegment(1, 31, 39, 47, 48),
        validGoalSegment(2, 108, 116, 125, 126),
        validGoalSegment(3, 197, 205, 213, 214),
      ]),
    ],
  });
  await runContext(context);

  assert.equal(context.job.status, "completed");
  assert.equal(context.exportsById.size, 1);
  assert.equal(context.calls.includes("render_short"), true);
  assert.equal(context.job.videoOutputQA.status, "passed");
  assert.equal(context.job.videoOutputQA.expectedGoalCount, 3);
  assert.equal(context.job.videoOutputQA.coveredGoalCount, 3);
  assert.equal(context.job.videoOutputQA.actualConfirmedGoalSegmentCount, 3);
  assert.equal(context.job.editPlan.videoOutputQA.passed, true);
  const qaLog = context.logs.find((entry) => entry.event === "video_output_qa_completed");
  assert.equal(qaLog.expectedGoalCount, 3);
  assert.equal(qaLog.coveredGoalCount, 3);
  assert.doesNotMatch(JSON.stringify(context.job.videoOutputQA), /\/Users|storageKey|secret|stderr|stdout|rawOcr|rawText/i);
});

test("reference duration gate accepts 5/5 rendered visible goals under the expanded reference limit", () => {
  const metadata = { durationSeconds: 764.52, width: 1280, height: 720 };
  const sourceSegments = [
    { goal: 1, start: 223.6, shot: 229.75, finish: 234.25, confirm: 236.25, end: 238.6 },
    { goal: 2, start: 461.35, shot: 467.5, finish: 471.75, confirm: 472.15, end: 472.25 },
    { goal: 3, start: 471.1, shot: 477.25, finish: 483.25, confirm: 483.75, end: 486.1 },
    { goal: 4, start: 532.25, shot: 536.35, finish: 538.45, confirm: 558.45, end: 569.65 },
    { goal: 5, start: 583.6, shot: 589.75, finish: 594.25, confirm: 596.25, end: 598.6 },
  ].map((item) => ({
    ...validGoalSegment(item.goal, item.start, item.shot, item.finish, item.confirm),
    sourceEnd: item.end,
    duration: Number((item.end - item.start).toFixed(2)),
  }));
  const proofRoleSourceTimes = new Map([
    [1, { pre_shot: 226.8, finish: 228.25, payoff: 235.4, confirmation: 236.25 }],
    [2, { pre_shot: 461.75, finish: 471.35, payoff: 471.7, confirmation: 472 }],
    [3, { pre_shot: 471.5, finish: 477.25, payoff: 485.5, confirmation: 483.75 }],
    [4, { pre_shot: 532.65, finish: 533.95, payoff: 539, confirmation: 558.45 }],
    [5, { pre_shot: 586.8, finish: 589.75, payoff: 594.8, confirmation: 596.25 }],
  ]);
  const editPlan = validateEditPlan({
    ...validGoalCompilationPlan(sourceSegments),
    totalDuration: 91.3,
    renderPolishQA: cleanRenderPolishQA(),
  }, metadata);
  const matchEventTruth = countedGoalTruthFromSegments(editPlan.segments);
  const initialReport = assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth,
    editPlan,
  });
  assert.equal(initialReport.status, "passed");
  assert.equal(initialReport.coveredGoalCount, 5);
  assert.deepEqual(initialReport.missingGoalNumbers, []);
  assert.equal(initialReport.renderedGoalVisibility.passed, true);
  assert.equal(initialReport.referenceStyleDuration.totalDuration <= 125, true);

  let timelineCursor = 0;
  const proofGoals = editPlan.segments.map((segment, index) => {
    const sourceTimes = proofRoleSourceTimes.get(Number(segment.goalNumber));
    const frameRefs = ["pre_shot", "finish", "payoff", "confirmation"].map((role) => ({
      role,
      time: Number((timelineCursor + sourceTimes[role] - segment.sourceStart).toFixed(2)),
      status: "clear",
      clear: true,
      confidence: 0.91,
      reason: null,
    }));
    timelineCursor += segment.sourceEnd - segment.sourceStart;
    return {
      goalNumber: segment.goalNumber,
      segmentIndex: index + 1,
      verdict: "clear",
      frameCount: 4,
      frameRefs,
      candidateFrameCount: 24,
      failedFrameReasons: [],
    };
  });
  const compaction = __testing.compactVisibleGoalSegmentsForReferenceDuration({
    editPlan,
    renderedGoalProof: {
      summary: {
        schemaVersion: 1,
        providerMode: "mock-rendered-goal-proof",
        goalCount: 5,
        clearGoalCount: 5,
        borderlineGoalCount: 0,
        failedGoalCount: 0,
        goals: proofGoals,
      },
    },
  });

  assert.equal(compaction.applied, false);
  assert.equal(compaction.summary, null);
  assert.doesNotMatch(JSON.stringify(compaction), /\/Users|storageKey|secret|stderr|stdout|rawOcr|rawText/i);

  for (const segment of editPlan.segments) {
    assert.equal(segment.shotStart - segment.sourceStart >= 4, true);
    assert.equal(segment.sourceEnd >= segment.confirmationTime, true);
  }
  const goal4 = editPlan.segments.find((segment) => Number(segment.goalNumber) === 4);
  assert.ok(goal4);
  assert.equal(goal4.sourceEnd >= goal4.confirmationTime, true);
  assert.equal(goal4.phaseCoverage.hasFinish, true);
  assert.equal(goal4.phaseCoverage.hasConfirmation, true);
});

test("reference duration compaction trims verified padding while preserving five visible goals", () => {
  const metadata = { durationSeconds: 764.52, width: 1280, height: 720 };
  const sourceSegments = [
    { goal: 1, start: 103.75, shot: 115.75, finish: 121.75, confirm: 123.75, end: 126.1 },
    { goal: 2, start: 452.54, shot: 474.44, finish: 475.34, confirm: 482.04, end: 484.39 },
    { goal: 3, start: 484.54, shot: 506.44, finish: 508.54, confirm: 514.04, end: 516.39 },
    { goal: 4, start: 526.22, shot: 547.37, finish: 547.72, confirm: 555.72, end: 558.07 },
    { goal: 5, start: 662.75, shot: 680.65, finish: 682.75, confirm: 686.25, end: 688.6 },
  ].map((item) => ({
    ...validGoalSegment(item.goal, item.start, item.shot, item.finish, item.confirm),
    sourceEnd: item.end,
    duration: Number((item.end - item.start).toFixed(2)),
  }));
  const editPlan = validateEditPlan({
    ...validGoalCompilationPlan(sourceSegments),
    renderPolishQA: cleanRenderPolishQA(),
  }, metadata);
  assert.equal(editPlan.totalDuration > 125, true);

  const sourceRoleTimes = new Map([
    [1, { pre_shot: 115.4, finish: 121.75, payoff: 122.3, confirmation: 123.75 }],
    [2, { pre_shot: 474.09, finish: 475.34, payoff: 476.74, confirmation: 482.04 }],
    [3, { pre_shot: 506.09, finish: 508.54, payoff: 509.14, confirmation: 514.04 }],
    [4, { pre_shot: 547.77, finish: 547.72, payoff: 548.77, confirmation: 555.72 }],
    [5, { pre_shot: 680.3, finish: 682.75, payoff: 683.3, confirmation: 686.25 }],
  ]);
  let timelineCursor = 0;
  const proofGoals = editPlan.segments.map((segment, index) => {
    const sourceTimes = sourceRoleTimes.get(Number(segment.goalNumber));
    const frameRefs = ["pre_shot", "finish", "payoff", "confirmation"].map((role) => ({
      role,
      time: Number((timelineCursor + sourceTimes[role] - segment.sourceStart).toFixed(2)),
      status: "clear",
      clear: true,
      confidence: 0.91,
      reason: null,
    }));
    timelineCursor += segment.sourceEnd - segment.sourceStart;
    return {
      goalNumber: segment.goalNumber,
      segmentIndex: index + 1,
      verdict: "clear",
      frameCount: 4,
      frameRefs,
      candidateFrameCount: 40,
      failedFrameReasons: [],
    };
  });

  const compaction = __testing.compactVisibleGoalSegmentsForReferenceDuration({
    editPlan,
    metadata,
    renderedGoalProof: {
      summary: {
        schemaVersion: 1,
        providerMode: "mock-rendered-goal-proof",
        goalCount: 5,
        clearGoalCount: 5,
        borderlineGoalCount: 0,
        failedGoalCount: 0,
        goals: proofGoals,
      },
    },
  });

  assert.equal(compaction.applied, true);
  assert.equal(compaction.summary.passedDurationTarget, true);
  assert.equal(compaction.editPlan.totalDuration <= 125, true);
  assert.equal(compaction.summary.compactedGoalCount >= 1, true);
  const report = assertVideoOutputCoverage({
    goalSelectionMode: "valid_goals_only",
    matchEventTruth: countedGoalTruthFromSegments(compaction.editPlan.segments),
    editPlan: compaction.editPlan,
  });
  assert.equal(report.status, "passed");
  assert.equal(report.coveredGoalCount, 5);
  assert.deepEqual(report.missingGoalNumbers, []);
  assert.equal(report.referenceStyleDuration.passed, true);
  assert.equal(report.renderedGoalVisibility.passed, true);
  assert.doesNotMatch(JSON.stringify(compaction), /\/Users|storageKey|secret|stderr|stdout|rawOcr|rawText/i);
});

test("render orchestration rebinds and rerenders failed visible goal proof once", async () => {
  let proofAttempt = 0;
  const truth = countedGoalTruth(1);
  truth.events[0] = {
    ...truth.events[0],
    sourceStart: 540,
    sourceEnd: 554,
    scoreChangeTime: 550,
    shotStart: 546,
    finishTime: 548,
    confirmationTime: 550,
    phaseCoverage: {
      ...truth.events[0].phaseCoverage,
      liveActionStart: 540,
      shotStart: 546,
      finishTime: 548,
      confirmationTime: 550,
    },
  };
  truth.scoreChanges[0] = {
    ...truth.scoreChanges[0],
    changeTime: 550,
    actionAnchorTime: 546,
  };
  const context = makeContext({
    durationSeconds: 620,
    metadata: { sourceType: "youtube", videoId: "WuuGus5Obkg", expectedCountedGoals: 1 },
    matchEventTruth: truth,
    candidatePlans: [
      validGoalCompilationPlan([
        validGoalSegment(1, 540, 546, 548, 550),
      ]),
    ],
    dependencies: {
      analyzeRenderedGoalProof: async ({ editPlan }) => {
        proofAttempt += 1;
        context.calls.push("analyze_rendered_goal_proof");
        const [segment] = editPlan.segments;
        const failedFrameRefs = [
          { role: "pre_shot", time: 2, status: "failed", clear: false, reason: "semantic_frame_forbidden_content", confidence: 0.29 },
          { role: "finish", time: 7, status: "failed", clear: false, reason: "semantic_frame_not_clear", confidence: 0.47 },
          { role: "payoff", time: 8, status: "failed", clear: false, reason: "semantic_frame_not_clear", confidence: 0.46 },
          { role: "confirmation", time: 10, status: "clear", clear: true, reason: null, confidence: 0.91 },
        ];
        if (
          proofAttempt === 1 ||
          segment.finishTime >= segment.confirmationTime - 0.4 ||
          segment.finishTime < segment.confirmationTime - 48 ||
          segment.sourceStart > segment.confirmationTime - 8
        ) {
          const finishFrameEvidence = {
            frameTime: segment.finishTime,
            confidence: 0.2,
            visibilityVerdict: "failed",
            hasVisibleFinish: false,
            hasBallInNetOrPayoff: false,
            hasGoalMouth: false,
            hasPreShotActionFrame: false,
            hasFinishActionFrame: false,
            hasPayoffFrame: false,
            hasConfirmationFrame: true,
            continuousActionFrameCount: 1,
            supportFrames: failedFrameRefs,
            isBlurred: false,
            isOverZoomed: false,
            isLabelOnly: false,
            isReplayOnly: false,
            isCelebrationOnly: false,
            isScoreboardOnly: false,
            isPlayerCloseupOnly: false,
            isFrameTooWideUnclear: false,
            evidenceCodes: ["rendered_frame_samples_semantically_unverified"],
            reasons: ["semantic_frame_not_clear"],
          };
          return {
            editPlan: {
              ...editPlan,
              segments: [{
                ...segment,
                finishFrameEvidence,
                phaseCoverage: {
                  ...(segment.phaseCoverage || {}),
                  finishFrameEvidence,
                  visualGoalPayoff: {
                    ...((segment.phaseCoverage && segment.phaseCoverage.visualGoalPayoff) || {}),
                    finishFrameEvidence,
                  },
                },
              }],
            },
            summary: {
              schemaVersion: 1,
              providerMode: "mock-rendered-goal-proof",
              goalCount: 1,
              clearGoalCount: 0,
              borderlineGoalCount: 0,
              failedGoalCount: 1,
              contactSheetRef: "data/staging/rendered-goal-proof/unit/contact-sheet.json",
              goals: [{
                goalNumber: 1,
                segmentIndex: 1,
                verdict: "failed",
                frameCount: 1,
                frameRefs: failedFrameRefs,
              }],
              logsDownloaded: false,
              artifactsDownloaded: false,
            },
          };
        }
        assert.ok(segment.confirmationTime - segment.sourceStart >= 12);
        assert.ok(segment.duration <= 64);
        assert.ok(segment.finishTime >= segment.confirmationTime - 48);
        assert.ok(segment.finishTime <= segment.confirmationTime - 0.5);
        assert.equal(editPlan.renderedGoalRebinding.attemptCount, proofAttempt - 1);
        const clearFrameRefs = [
          { role: "pre_shot", time: 4, status: "clear", clear: true, reason: null, confidence: 0.9 },
          { role: "finish", time: 18, status: "clear", clear: true, reason: null, confidence: 0.92 },
          { role: "payoff", time: 20, status: "clear", clear: true, reason: null, confidence: 0.91 },
          { role: "confirmation", time: 28, status: "clear", clear: true, reason: null, confidence: 0.94 },
        ];
        const finishFrameEvidence = {
          frameTime: segment.finishTime,
          confidence: 0.91,
          visibilityVerdict: "clear",
          hasVisibleFinish: true,
          hasBallInNetOrPayoff: true,
          hasGoalMouth: true,
          hasPreShotActionFrame: true,
          hasFinishActionFrame: true,
          hasPayoffFrame: true,
          hasConfirmationFrame: true,
          continuousActionFrameCount: 4,
          supportFrames: clearFrameRefs,
          isBlurred: false,
          isOverZoomed: false,
          isLabelOnly: false,
          isReplayOnly: false,
          isCelebrationOnly: false,
          isScoreboardOnly: false,
          isPlayerCloseupOnly: false,
          isFrameTooWideUnclear: false,
          evidenceCodes: ["rendered_finish_frame_visible", "ball_in_net_or_payoff_visible", "clear_goal_payoff_visible"],
          proofMethod: "mock_rebound_rendered_goal_proof",
        };
        return {
          editPlan: {
            ...editPlan,
            segments: [{
              ...segment,
              finishFrameEvidence,
              phaseCoverage: {
                ...(segment.phaseCoverage || {}),
                finishFrameEvidence,
                visualGoalPayoff: {
                  ...((segment.phaseCoverage && segment.phaseCoverage.visualGoalPayoff) || {}),
                  finishFrameEvidence,
                },
              },
            }],
          },
          summary: {
            schemaVersion: 1,
            providerMode: "mock-rendered-goal-proof",
            goalCount: 1,
            clearGoalCount: 1,
            borderlineGoalCount: 0,
            failedGoalCount: 0,
            contactSheetRef: "data/staging/rendered-goal-proof/unit/contact-sheet.json",
            goals: [{
              goalNumber: 1,
              segmentIndex: 1,
              verdict: "clear",
              frameCount: 4,
              frameRefs: clearFrameRefs,
            }],
            logsDownloaded: false,
            artifactsDownloaded: false,
          },
        };
      },
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "completed", JSON.stringify({
    error: context.job.error,
    videoOutputQA: context.job.videoOutputQA,
    renderedGoalRebinding: context.job.renderedGoalRebinding,
    calls: context.calls,
    proofAttempt,
  }, null, 2));
  assert.equal(proofAttempt, 2);
  assert.equal(context.calls.filter((call) => call === "render_short").length, 2);
  assert.equal(context.job.videoOutputQA.status, "passed");
  assert.equal(context.job.renderedGoalRebinding.applied, true);
  assert.equal(context.job.renderedGoalRebinding.reboundGoalCount, 1);
  assert.equal(context.job.editPlan.segments[0].confirmationTime - context.job.editPlan.segments[0].sourceStart >= 12, true);
  assert.equal(context.job.editPlan.segments[0].duration <= 64, true);
  assert.equal(context.job.editPlan.segments[0].finishTime >= context.job.editPlan.segments[0].confirmationTime - 48, true);
  assert.equal(context.job.editPlan.segments[0].finishTime <= context.job.editPlan.segments[0].confirmationTime - 0.5, true);
  assert.equal(context.logs.some((entry) => entry.event === "rendered_goal_rebinding_attempted"), true);
  assert.equal(context.logs.some((entry) => entry.event === "rendered_goal_rebinding_recovered"), true);
  assert.doesNotMatch(JSON.stringify(context.job.renderedGoalRebinding), /\/Users|storageKey|secret|stderr|stdout|rawOcr|rawText/i);
});

test("rendered goal rebinding cannot reuse the previous counted goal window", () => {
  const segments = [
    validGoalSegment(1, 103.75, 115.75, 121.75, 123.75),
    validGoalSegment(2, 444.04, 459.69, 460.04, 482.04),
    validGoalSegment(3, 494.04, 506.04, 509.54, 514.04),
    validGoalSegment(4, 497.72, 525.62, 527.72, 555.72),
    validGoalSegment(5, 666.25, 678.25, 684.25, 686.25),
  ];
  segments[0].sourceEnd = 126.1;
  segments[1].sourceEnd = 484.39;
  segments[2].sourceEnd = 516.39;
  segments[3].sourceEnd = 558.07;
  segments[4].sourceEnd = 688.6;

  const rebind = __testing.rebindRenderedGoalFailureSegments({
    editPlan: {
      mode: "multi_moment_compilation",
      sourceStart: 103.75,
      sourceEnd: 688.6,
      totalDuration: segments.reduce((sum, segment) => sum + segment.sourceEnd - segment.sourceStart, 0),
      segments,
    },
    renderedGoalProof: {
      summary: {
        goals: [
          {
            goalNumber: 4,
            segmentIndex: 4,
            verdict: "failed",
            frameRefs: [{ role: "finish", clear: false, reason: "semantic_frame_not_clear" }],
          },
        ],
      },
    },
    metadata: { durationSeconds: 720 },
    attemptNumber: 3,
  });

  assert.equal(rebind.applied, true);
  const reboundGoal3 = rebind.editPlan.segments[2];
  const reboundGoal4 = rebind.editPlan.segments[3];
  assert.equal(reboundGoal4.goalNumber, 4);
  assert.equal(reboundGoal4.sourceStart >= reboundGoal3.confirmationTime + 1.49, true);
  assert.equal(reboundGoal4.sourceStart < reboundGoal3.sourceEnd + 0.49, true);
  assert.equal(reboundGoal4.finishTime > reboundGoal4.sourceStart, true);
  assert.equal(reboundGoal4.finishTime < reboundGoal4.confirmationTime, true);
  assert.equal(reboundGoal4.confirmationTime - reboundGoal4.finishTime <= 3, true);
  assert.equal(reboundGoal4.phaseCoverage.scoreChangeTime, 555.72);
  assert.equal(reboundGoal4.phaseCoverage.scoreChangeConfirmedOutsideClip, true);
  assert.equal(reboundGoal4.renderedVisibilityRebinding.rebindingSearchWindow.start >= reboundGoal3.confirmationTime + 1.49, true);
  assert.equal(reboundGoal4.renderedVisibilityRebinding.scoreChangeConfirmedOutsideClip, true);
  assert.equal(rebind.summary.diagnostics[0].chronologicalBounds.lowerBoundReason, "previous_confirmed_goal_anchor");
  assert.equal(rebind.summary.diagnostics[0].profile.finishLeadSeconds, 30);
  assert.equal(rebind.summary.diagnostics[0].profile.compactedDelayedScoreConfirmation, true);
});

test("rendered goal rebinding keeps close score-change finish anchored 13-15 seconds before the scoreboard update", () => {
  const segments = [
    validGoalSegment(3, 504.75, 510.9, 514.75, 528.75),
    validGoalSegment(4, 545.8, 551.95, 556.45, 550.45),
    validGoalSegment(5, 595.75, 601.9, 604.75, 618.75),
  ];
  segments[0].sourceEnd = 529.95;
  segments[1].sourceEnd = 560.8;
  segments[2].sourceEnd = 619.95;
  segments[1].scoreChangeTime = 550.45;
  segments[1].goalOutcome.scoreChangeTime = 550.45;

  const rebind = __testing.rebindRenderedGoalFailureSegments({
    editPlan: {
      mode: "multi_moment_compilation",
      sourceStart: 504.75,
      sourceEnd: 619.95,
      totalDuration: segments.reduce((sum, segment) => sum + segment.sourceEnd - segment.sourceStart, 0),
      segments,
    },
    renderedGoalProof: {
      summary: {
        goals: [
          {
            goalNumber: 4,
            segmentIndex: 2,
            verdict: "failed",
            frameRefs: [{ role: "finish", clear: false, reason: "semantic_frame_forbidden_content" }],
          },
        ],
      },
    },
    metadata: { durationSeconds: 764.52 },
    attemptNumber: 1,
  });

  assert.equal(rebind.applied, true);
  const reboundGoal4 = rebind.editPlan.segments[1];
  assert.equal(reboundGoal4.sourceStart, 530.25);
  assert.equal(reboundGoal4.finishTime, 535.45);
  assert.equal(reboundGoal4.scoreChangeTime, 550.45);
  assert.equal(Number((reboundGoal4.scoreChangeTime - reboundGoal4.finishTime).toFixed(2)), 15);
  assert.equal(reboundGoal4.renderedVisibilityRebinding.scoreChangeConfirmedOutsideClip, false);
  assert.equal(rebind.summary.diagnostics[0].profile.finishLeadSeconds, 15);
  assert.equal(rebind.summary.diagnostics[0].profile.lowerBoundClippedBuildup, true);
});

test("approved regeneration render uses the validated draft without rerunning AI analysis", async () => {
  const context = makeContext();
  const approvedEditPlan = validateEditPlan(validPlan(), context.upload.metadata);
  const auditUpdates = [];
  const outboxEvents = [];
  context.dependencies.regenerationApprovalRepository = {
    markRenderProcessing(approvalId, jobId) {
      auditUpdates.push({ status: "render_processing", approvalId, jobId });
      return { approvalId, status: "render_processing", newRenderJobId: jobId };
    },
    markRenderCompleted(approvalId, { jobId, exportId }) {
      auditUpdates.push({ status: "render_completed", approvalId, jobId, exportId });
      return { approvalId, status: "render_completed", newRenderJobId: jobId, completedExportId: exportId };
    },
  };
  context.dependencies.approvalOutboxRepository = {
    createLifecycleEvent(event) {
      outboxEvents.push(event);
      return { id: `aout_${outboxEvents.length}`, ...event };
    },
  };
  context.job.payload = {
    ...context.payload,
    approvedEditPlan,
    regenerationApproval: {
      approvalId: "appr_1234567890abcdef1234567890abcdef",
      regenerationPlanId: "regen_1234567890abcdef1234567890abcdef",
      draftHash: "1234567890abcdef1234567890abcdef",
      sourceJobId: "job_source12345678",
      sourceExportId: "exp_source12345678",
      approvedAt: new Date().toISOString(),
    },
  };
  context.payload = context.job.payload;

  await runContext(context);

  assert.equal(context.job.status, "completed");
  assert.equal(context.exportsById.size, 1);
  assert.equal(context.calls.includes("extract_media_signals"), false);
  assert.equal(context.calls.includes("extract_sampled_frames"), false);
  assert.equal(context.calls.includes("analyze_frames"), false);
  assert.equal(context.calls.includes("render_short"), true);
  assert.equal(context.job.editPlan.highlightType, approvedEditPlan.highlightType);
  assert.equal(context.job.candidatePlans.length, 1);
  assert.equal(context.job.sampledFrames.providerMode, "approved_regeneration_draft");
  assert.equal(context.job.visualSignals.providerMode, "approved_regeneration_draft");
  assert.deepEqual(auditUpdates.map((item) => item.status), ["render_processing", "render_completed"]);
  assert.equal(auditUpdates[1].exportId, "exp_orchestration_test");
  assert.deepEqual(outboxEvents.map((event) => event.eventType), ["render_processing", "render_completed"]);
  const selectedPlanLog = context.logs.find((entry) => entry.event === "approved_edit_plan_selected");
  assert.equal(selectedPlanLog.approvalId, "appr_1234567890abcdef1234567890abcdef");
  assert.doesNotMatch(JSON.stringify(selectedPlanLog), /\/Users|storageKey|secret|caption/i);
});

test("approved regeneration render failures update approval audit without creating exports", async () => {
  const context = makeContext({
    renderError: new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500, {
      stderr: "/Users/example/secret render stderr",
    }),
  });
  const approvedEditPlan = validateEditPlan(validPlan(), context.upload.metadata);
  const auditUpdates = [];
  const outboxEvents = [];
  context.dependencies.regenerationApprovalRepository = {
    markRenderProcessing(approvalId, jobId) {
      auditUpdates.push({ status: "render_processing", approvalId, jobId });
      return { approvalId, status: "render_processing" };
    },
    markRenderFailed(approvalId, { jobId, errorCode }) {
      auditUpdates.push({ status: "render_failed", approvalId, jobId, errorCode });
      return { approvalId, status: "render_failed", errorCode };
    },
  };
  context.dependencies.approvalOutboxRepository = {
    createLifecycleEvent(event) {
      outboxEvents.push(event);
      return { id: `aout_${outboxEvents.length}`, ...event };
    },
  };
  context.job.payload = {
    ...context.payload,
    approvedEditPlan,
    regenerationApproval: {
      approvalId: "appr_abcdefabcdefabcdefabcdefabcdefab",
      regenerationPlanId: "regen_abcdefabcdefabcdefabcdefabcdefab",
      draftHash: "abcdefabcdefabcdefabcdefabcdefab",
      draftRecordId: "rdft_abcdefabcdefabcdefabcdefabcdefab",
      sourceJobId: "job_source12345678",
      sourceExportId: "exp_source12345678",
      approvedAt: new Date().toISOString(),
    },
  };
  context.payload = context.job.payload;

  await runContext(context);

  assert.equal(context.job.status, "failed");
  assert.equal(context.exportsById.size, 0);
  assert.deepEqual(auditUpdates.map((item) => item.status), ["render_processing", "render_failed"]);
  assert.equal(auditUpdates[1].errorCode, "RENDER_FAILED");
  assert.deepEqual(outboxEvents.map((event) => event.eventType), ["render_processing", "render_failed"]);
  assert.doesNotMatch(JSON.stringify(context.job.error), /\/Users|secret|stderr/i);
});

test("render orchestration uses mock provider fallback when upload has no audio", async () => {
  const context = makeContext({ hasAudio: false });
  await runContext(context);

  assert.equal(context.job.status, "completed");
  assert.equal(context.calls.includes("extract_audio"), false);
  assert.equal(context.providerOptions[0].forceMock, true);
});

test("provider failures fail the job safely without creating exports", async () => {
  const context = makeContext({
    dependencies: {
      chooseTranscriptionProvider: () => ({
        transcribe: async () => {
          throw new AppError("TRANSCRIPTION_FAILED", SAFE_MESSAGES.TRANSCRIPTION_FAILED, 503, {
            raw: "/Users/example OPENAI_API_KEY=secret",
          });
        },
      }),
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "failed");
  assert.equal(context.project.status, "failed");
  assert.equal(context.exportsById.size, 0);
  assert.equal(context.job.error.code, "TRANSCRIPTION_FAILED");
  assert.doesNotMatch(JSON.stringify(context.job.error), /\/Users|OPENAI_API_KEY|secret/);
});

test("render failures fail closed before export creation", async () => {
  const context = makeContext({
    renderError: new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500, {
      stderr: "/Users/example/render failed",
    }),
  });
  await runContext(context);

  assert.equal(context.job.status, "failed");
  assert.equal(context.project.status, "failed");
  assert.equal(context.exportsById.size, 0);
  assert.equal(context.job.error.code, "RENDER_FAILED");
});

test("cancellation during orchestration leaves the project unexported", async () => {
  const context = makeContext({
    dependencies: {
      extractMediaSignals: async () => {
        context.jobs.cancel(context.job.id);
        throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
      },
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "cancelled");
  assert.equal(context.project.status, "draft");
  assert.equal(context.exportsById.size, 0);
  assert.equal(context.job.error.code, "JOB_CANCELLED");
});

test("invalid transcript and highlight outputs are rejected before render", async () => {
  assert.throws(
    () => validateTranscript({ captions: [{ start: 4, end: 2, text: "bad timing" }] }, { durationSeconds: 12 }),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
  assert.throws(
    () => validateHighlightResult({ moments: [] }, { durationSeconds: 12 }),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );

  const context = makeContext({
    transcript: { provider: "mock", language: "en", text: "bad", captions: [{ start: 4, end: 2, text: "bad timing" }] },
  });
  await runContext(context);
  assert.equal(context.job.status, "failed");
  assert.equal(context.job.error.code, "AI_OUTPUT_INVALID");
  assert.equal(context.calls.includes("render_short"), false);
});

test("invalid visual analysis output fails safely before transcription and render", async () => {
  const context = makeContext({
    dependencies: {
      analyzeFrames: async () => ({ providerMode: "bad", windows: [{ start: 9, end: 4, type: "shot_like_motion" }] }),
    },
  });
  await runContext(context);

  assert.equal(context.job.status, "failed");
  assert.equal(context.job.error.code, "AI_OUTPUT_INVALID");
  assert.equal(context.calls.includes("render_short"), false);
  assert.doesNotMatch(JSON.stringify(context.job.error), /\/Users|secret|storageKey/i);
});

test("chunked score progression starts at 0-0 and only accepts observed unit score changes", () => {
  const progression = __testing.buildScoreCandidateProgressionFromChunks({
    chunks: [
      {
        index: 1,
        start: 0,
        end: 90,
        status: "completed",
        sampledFrameTimestamps: [37.8],
        selectedRoiId: "scorebug_broadcast_compact",
        normalizedScoreCandidates: ["7-0"],
        readableObservationCount: 1,
      },
      {
        index: 2,
        start: 90,
        end: 180,
        status: "completed",
        sampledFrameTimestamps: [123.75],
        selectedRoiId: "scorebug_broadcast_compact",
        normalizedScoreCandidates: ["1-0"],
        readableObservationCount: 2,
      },
      {
        index: 3,
        start: 180,
        end: 270,
        status: "completed",
        sampledFrameTimestamps: [191.25, 213.75, 236.25, 258.75, 264.25],
        selectedRoiId: "scorebug_broadcast_compact",
        normalizedScoreCandidates: ["1-0", "1-1"],
        scoreCandidateFirstSeenAt: [
          { score: "1-0", timestamp: 236.25 },
          { score: "1-1", timestamp: 260.25 },
        ],
        readableObservationCount: 3,
      },
      {
        index: 6,
        start: 450,
        end: 540,
        status: "completed",
        sampledFrameTimestamps: [461.25, 470.04, 483.75, 506.25, 528.75],
        selectedRoiId: "scorebug_broadcast_compact",
        normalizedScoreCandidates: ["4-1", "2-1"],
        scoreCandidateFirstSeenAt: [
          { score: "4-1", timestamp: 470.04 },
          { score: "2-1", timestamp: 483.75 },
        ],
        readableObservationCount: 3,
      },
      {
        index: 7,
        start: 540,
        end: 630,
        status: "completed",
        sampledFrameTimestamps: [596.25],
        selectedRoiId: "scorebug_broadcast_compact",
        normalizedScoreCandidates: ["2-2"],
        readableObservationCount: 2,
      },
      {
        index: 8,
        start: 630,
        end: 720,
        status: "completed",
        sampledFrameTimestamps: [686.25],
        selectedRoiId: "scorebug_broadcast_compact",
        normalizedScoreCandidates: ["3-2"],
        readableObservationCount: 1,
      },
    ],
  });

  assert.deepEqual(
    progression.evidence.map((item) => `${item.scoreBefore}->${item.scoreAfter}`),
    ["0-0->1-0", "1-0->1-1", "1-1->2-1", "2-1->2-2", "2-2->3-2"],
  );
  assert.deepEqual(
    progression.evidence.map((item) => item.changedSide),
    ["home", "away", "home", "away", "home"],
  );
  assert.equal(progression.evidence.some((item) => item.scoreAfter === "2-0"), false);
  assert.equal(progression.evidence.every((item) => item.synthetic === false && item.bridgeGenerated === false), true);
  assert.equal(progression.diagnostics.acceptedCandidates[0].score, "0-0");
  assert.equal(progression.diagnostics.acceptedCandidates[0].role, "assumed_initial_score_state");
  assert.equal(
    progression.diagnostics.rejectedCandidates.some((candidate) =>
      candidate.score === "7-0" &&
      candidate.currentScore === "0-0" &&
      candidate.reason === "score_candidate_jump_too_large"),
    true,
  );
  assert.equal(
    progression.diagnostics.rejectedCandidates.some((candidate) =>
      candidate.score === "4-1" &&
      candidate.currentScore === "2-1" &&
      candidate.reason === "missing_observed_intermediate_score_state"),
    true,
  );
  assert.deepEqual(
    progression.evidence
      .filter((item) => item.regionId === "scorebug_broadcast_compact" && item.source === "chunked_scorebug_candidate_progression")
      .map((item) => item.timestamp),
    [123.75, 260.25, 483.75, 596.25, 686.25],
  );
  assert.equal(progression.diagnostics.finalScore, "3-2");
  assert.doesNotMatch(JSON.stringify(progression), /\/Users|\/private|token|secret|stdout|stderr/i);
});

test("chunked score progression does not synthesize missing intermediate states from sparse jumps", () => {
  const progression = __testing.buildScoreCandidateProgressionFromChunks({
    chunks: [
      {
        index: 1,
        start: 90,
        end: 180,
        status: "completed",
        sampledFrameTimestamps: [123.75],
        selectedRoiId: "scorebug_broadcast_compact",
        normalizedScoreCandidates: ["1-0"],
        readableObservationCount: 2,
      },
      {
        index: 6,
        start: 450,
        end: 540,
        status: "completed",
        sampledFrameTimestamps: [461.25, 528.75],
        selectedRoiId: "scorebug_broadcast_compact",
        normalizedScoreCandidates: ["2-1"],
        readableObservationCount: 1,
      },
    ],
  });

  assert.deepEqual(
    progression.evidence.map((item) => `${item.scoreBefore}->${item.scoreAfter}`),
    ["0-0->1-0"],
  );
  assert.equal(progression.evidence.some((item) => item.scoreAfter === "2-0"), false);
  assert.equal(
    progression.diagnostics.rejectedCandidates.some((candidate) =>
      candidate.score === "2-1" &&
      candidate.currentScore === "1-0" &&
      candidate.reason === "missing_observed_intermediate_score_state"),
    true,
  );
  assert.doesNotMatch(JSON.stringify(progression), /\/Users|\/private|token|secret|stdout|stderr/i);
});

test("chunked score progression corrects OCR-noisy observed unit changes without hardcoded home-first bridges", () => {
  const progression = __testing.buildScoreCandidateProgressionFromChunks({
    chunks: [
      {
        index: 1,
        start: 90,
        end: 180,
        status: "completed",
        sampledFrameTimestamps: [123.75],
        selectedRoiId: "scorebug_broadcast_compact",
        normalizedScoreCandidates: ["1-0"],
        readableObservationCount: 2,
      },
      {
        index: 6,
        start: 450,
        end: 540,
        status: "completed",
        sampledFrameTimestamps: [461.25, 506.25, 528.75],
        selectedRoiId: "scorebug_broadcast_compact",
        normalizedScoreCandidates: ["4-1", "2-1"],
        readableObservationCount: 3,
      },
    ],
  });

  assert.deepEqual(
    progression.evidence.map((item) => `${item.scoreBefore}->${item.scoreAfter}`),
    ["0-0->1-0", "1-0->1-1", "1-1->2-1"],
  );
  assert.equal(progression.evidence.some((item) => item.scoreAfter === "2-0"), false);
  const corrected = progression.evidence.find((item) => item.scoreAfter === "1-1");
  assert.equal(corrected.changedSide, "away");
  assert.equal(corrected.ocrCorrected, true);
  assert.equal(corrected.observedScoreText, "4-1");
  assert.equal(corrected.synthetic, false);
  assert.equal(corrected.bridgeGenerated, false);
  assert.equal(
    corrected.transitionReasonCodes.includes("home_score_ocr_noise_carried_forward"),
    true,
  );
  assert.doesNotMatch(JSON.stringify(progression), /\/Users|\/private|token|secret|stdout|stderr/i);
});

test("chunked score progression accepts chronological away-side goals without home-team assumptions", () => {
  const progression = __testing.buildScoreCandidateProgressionFromChunks({
    chunks: [
      {
        index: 1,
        start: 0,
        end: 120,
        status: "completed",
        sampledFrameTimestamps: [36, 84],
        selectedRoiId: "scorebug_broadcast_compact",
        normalizedScoreCandidates: ["0-0", "0-1"],
        readableObservationCount: 2,
      },
      {
        index: 2,
        start: 120,
        end: 240,
        status: "completed",
        sampledFrameTimestamps: [156, 214],
        selectedRoiId: "scorebug_broadcast_compact",
        normalizedScoreCandidates: ["0-2", "1-2"],
        readableObservationCount: 2,
      },
    ],
  });

  assert.deepEqual(
    progression.evidence.map((item) => `${item.scoreBefore}->${item.scoreAfter}`),
    ["0-0->0-1", "0-1->0-2", "0-2->1-2"],
  );
  assert.deepEqual(
    progression.evidence.map((item) => item.scoreAfter),
    ["0-1", "0-2", "1-2"],
  );
  assert.deepEqual(
    progression.evidence.map((item) => item.changedSide),
    ["away", "away", "home"],
  );
  assert.equal(progression.diagnostics.acceptedCandidates[0].score, "0-0");
  assert.equal(
    progression.evidence.every((item) => {
      const [beforeHome, beforeAway] = item.scoreBefore.split("-").map(Number);
      const [afterHome, afterAway] = item.scoreAfter.split("-").map(Number);
      const homeDelta = afterHome - beforeHome;
      const awayDelta = afterAway - beforeAway;
      return (homeDelta === 1 && awayDelta === 0) || (homeDelta === 0 && awayDelta === 1);
    }),
    true,
  );
  assert.doesNotMatch(JSON.stringify(progression), /\/Users|\/private|token|secret|stdout|stderr/i);
});

test("render orchestration fails safely when project context is missing", async () => {
  const context = makeContext();
  await runRenderJob({
    jobs: context.jobs,
    exportsById: context.exportsById,
    job: context.job,
    project: null,
    upload: context.upload,
    payload: context.payload,
    requestId: "req_missing_project",
    dependencies: context.dependencies,
  });

  assert.equal(context.job.status, "failed");
  assert.equal(context.job.error.code, "PROJECT_NOT_FOUND");
  assert.equal(context.exportsById.size, 0);
  assert.equal(context.calls.includes("render_short"), false);
});

test("enqueueRenderJob delegates queued work and avoids restarting active jobs", () => {
  const context = makeContext();
  let scheduled = 0;
  context.dependencies.scheduler = () => {
    scheduled += 1;
  };

  enqueueRenderJob({
    jobs: context.jobs,
    exportsById: context.exportsById,
    job: context.job,
    project: context.project,
    upload: context.upload,
    payload: context.payload,
    requestId: "req_enqueue_test",
    dependencies: context.dependencies,
  });
  enqueueRenderJob({
    jobs: context.jobs,
    exportsById: context.exportsById,
    job: context.job,
    project: context.project,
    upload: context.upload,
    payload: context.payload,
    requestId: "req_enqueue_test",
    dependencies: context.dependencies,
  });

  assert.equal(context.job.status, "processing");
  assert.equal(context.job.progress, 1);
  assert.equal(scheduled, 1);
});
