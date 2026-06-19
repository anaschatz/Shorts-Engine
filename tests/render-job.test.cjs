const test = require("node:test");
const assert = require("node:assert/strict");
const { writeFileSync } = require("node:fs");

const { AppError, SAFE_MESSAGES } = require("../server/errors.cjs");
const { validateEditPlan } = require("../server/edit-plan.cjs");
const { JobStore } = require("../server/jobs.cjs");
const {
  enqueueRenderJob,
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
      { type: "intro_hook", start: 0, end: 1.2 },
      { type: "caption_pop", start: 0.2, end: 1.8 },
      { type: "beat_pulse", start: 1.6, end: 2.1 },
      { type: "end_replay_prompt", start: 6.7, end: 8 },
    ],
    safetyNotes: ["No object or ball tracking is claimed in v1."],
    reasonCodes: ["goal", "audio_energy_spike"],
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
    analyzeScoreboardOcr: async ({ frames, visualSignals }) => {
      calls.push("analyze_scoreboard_ocr");
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
    loadOcrQaCalibration: () => options.ocrQaCalibration || defaultOcrQaCalibration(),
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
  assert.equal(context.calls.includes("analyze_frames"), true);
  assert.equal(context.calls.includes("analyze_tracking"), true);
  assert.equal(context.calls.includes("analyze_scoreboard_ocr"), true);
  assert.equal(context.calls.includes("analyze_goal_evidence"), true);
  assert.equal(context.calls.includes("analyze_match_event_truth"), true);
  assert.equal(context.calls.includes("extract_sampled_frames"), true);
  assert.equal(context.visualCandidateWindows.length > 0, true);
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

test("youtube long-source render requests valid-goals-only planning", async () => {
  const context = makeContext({
    durationSeconds: 180,
    metadata: { sourceType: "youtube", videoId: "dQw4w9WgXcQ" },
  });
  await runContext(context);

  assert.equal(context.job.status, "completed");
  assert.equal(context.createPlanInput.metadata.goalSelectionMode, "valid_goals_only");
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
    candidatePlans: [],
  });
  await runContext(context);

  assert.equal(context.job.status, "failed");
  assert.equal(context.project.status, "failed");
  assert.equal(context.exportsById.size, 0);
  assert.equal(context.job.error.code, "NO_VALID_GOALS_FOUND");
  assert.equal(context.calls.includes("render_short"), false);
  assert.doesNotMatch(JSON.stringify(context.job.error), /\/Users|storageKey|secret|stderr|stdout/i);
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
