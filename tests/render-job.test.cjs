const test = require("node:test");
const assert = require("node:assert/strict");
const { writeFileSync } = require("node:fs");

const { AppError, SAFE_MESSAGES } = require("../server/errors.cjs");
const { validateEditPlan } = require("../server/edit-plan.cjs");
const { JobStore } = require("../server/jobs.cjs");
const {
  enqueueRenderJob,
  ocrQaCalibrationOptionsFromEnv,
  runRenderJob,
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

function validGoalCompilationPlan(segments) {
  const totalDuration = segments.reduce((sum, segment) => sum + (segment.sourceEnd - segment.sourceStart), 0);
  return {
    mode: "multi_moment_compilation",
    sourceStart: segments[0].sourceStart,
    sourceEnd: Math.max(...segments.map((segment) => segment.sourceEnd)),
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
    extractSampledFrames: async ({ candidateWindows }) => {
      calls.push("extract_sampled_frames");
      context.frameCandidateWindows = candidateWindows;
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
    renderShort: async ({ outputPath }) => {
      context.renderObserved = {
        exportCount: exportsById.size,
        projectStatus: project.status,
      };
      calls.push("render_short");
      if (options.renderError) throw options.renderError;
      writeFileSync(outputPath, Buffer.from("rendered-short"));
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
  assert.equal(context.frameCandidateWindows.some((window) => window.source === "scorebug_first_score_change"), true);
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
  assert.equal(context.frameCandidateWindows.some((window) => window.source === "scorebug_first_score_change" && Number(window.time) === 612), true);
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
  assert.equal(context.frameCandidateWindows.some((window) => window.source === "scorebug_first_score_change"), true);
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
  assert.equal(context.frameCandidateWindows.some((window) => window.source === "scorebug_first_score_change" && Number(window.time) === 612), true);
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
