const { randomUUID } = require("node:crypto");
const { existsSync, statSync } = require("node:fs");
const { AppError, SAFE_MESSAGES, redactForLogs } = require("./errors.cjs");
const { createCandidateEditPlans, detectHighlights, extractMediaSignals } = require("./analysis.cjs");
const { validateEditPlan } = require("./edit-plan.cjs");
const { cleanupSampledFrames, extractSampledFrames, publicFrameSummary } = require("./frame-extraction.cjs");
const { sanitizeText } = require("./media.cjs");
const { extractAudio, renderShort } = require("./render.cjs");
const { chooseTranscriptionProvider } = require("./transcription.cjs");
const { assertStoragePath, storagePath, writeJsonAtomic } = require("./storage.cjs");
const { analyzeTracking, publicTrackingProviderOutput } = require("./tracking-provider.cjs");
const { analyzeFrames, publicVisualSignals, validateVisualSignals } = require("./vision.cjs");
const { analyzeVisualTracking, publicVisualTrackingSummary } = require("./visual-tracking.cjs");

function isRegularFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function createDefaultDependencies(overrides = {}) {
  const { LocalArtifactAdapter } = require("./adapters/local-artifact-adapter.cjs");
  const deps = {
    assertStoragePath,
    artifactStore: new LocalArtifactAdapter(),
    chooseTranscriptionProvider,
    analyzeFrames,
    createCandidateEditPlans,
    createExportId: () => `exp_${randomUUID()}`,
    detectHighlights,
    extractAudio,
    extractSampledFrames,
    extractMediaSignals,
    fileExists: existsSync,
    analyzeTracking,
    analyzeVisualTracking,
    isRegularFile,
    logger: console,
    renderShort,
    scheduler: setImmediate,
    cleanupSampledFrames,
    storagePath,
    statFile: statSync,
    validateEditPlan,
    writeJsonAtomic,
    ...overrides,
  };
  if (!deps.artifactStore) deps.artifactStore = new LocalArtifactAdapter();
  return deps;
}

function logInfo(logger, payload) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(JSON.stringify(redactForLogs({ level: "info", ...payload })));
}

function nowIso() {
  return new Date().toISOString();
}

function resolveLocalArtifactPath(artifactStore, artifact) {
  if (artifactStore && typeof artifactStore.resolveLocalPath === "function") {
    return artifactStore.resolveLocalPath(artifact);
  }
  if (artifactStore && typeof artifactStore.resolveArtifact === "function") {
    return artifactStore.resolveArtifact(artifact);
  }
  return artifactStore.resolve(artifact);
}

function localPathForNewArtifact(artifactStore, input) {
  return artifactStore.createOutputStage(input.type, input);
}

function assertUploadReady(upload, deps) {
  if (!upload || typeof upload !== "object" || !upload.id || (!upload.path && !upload.artifact && !upload.storageKey) || !upload.metadata) {
    throw new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404);
  }
  const inputArtifact = upload.artifact
    ? deps.artifactStore.createRecord(upload.artifact)
    : deps.artifactStore.createRecord({
        id: upload.id,
        type: "upload",
        ownerProjectId: upload.projectId,
        storageKey: upload.storageKey || `${upload.id}.${upload.extension || "mp4"}`,
        size: upload.byteSize,
        status: "available",
        createdAt: upload.createdAt,
      });
  const hasExplicitArtifact = Boolean(upload.artifact || upload.storageKey);
  let inputStage;
  let inputPath;
  if (!hasExplicitArtifact && upload.path) {
    inputPath = deps.assertStoragePath(upload.path, "uploads");
    inputStage = {
      id: `stage_${upload.id}`,
      purpose: "input",
      adapterMode: "legacy-local",
      artifact: null,
      localPath: inputPath,
      permanentLocal: true,
      cleanupRequired: false,
      createdAt: nowIso(),
    };
  } else {
    inputStage = deps.artifactStore.stageInputForProcessing(inputArtifact, { step: "stage_source_upload" });
    inputPath = inputStage.localPath;
    if (upload.path && inputStage.permanentLocal && inputPath !== deps.assertStoragePath(upload.path, "uploads")) {
      throw new AppError("ARTIFACT_PATH_MISMATCH", SAFE_MESSAGES.ARTIFACT_PATH_MISMATCH, 400);
    }
  }
  if (!deps.fileExists(inputPath) || !deps.isRegularFile(inputPath)) {
    throw new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404);
  }
  const durationSeconds = Number(upload.metadata.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new AppError("VALIDATION_ERROR", "Upload metadata is invalid.", 400);
  }
  return { inputArtifact, inputPath, inputStage, metadata: { ...upload.metadata, durationSeconds } };
}

function assertPipelineContext({ job, project, upload, payload, deps }) {
  if (!job || !job.id || !job._controller) {
    throw new AppError("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, 404);
  }
  if (!project || !project.id || !project.uploadId) {
    throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  }
  if (!payload || typeof payload !== "object") {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  if (upload && project.uploadId !== upload.id) {
    throw new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404);
  }
  const { inputArtifact, inputPath, inputStage, metadata } = assertUploadReady(upload, deps);
  const title = sanitizeText(payload.title || project.title || "ShortsEngine Short", 120);
  const preset = sanitizeText(payload.preset || "hype", 40).toLowerCase();
  const language = sanitizeText(payload.language || "auto", 32) || "auto";
  const styleTarget = sanitizeText(payload.styleTarget || "vertical_9_16", 40).toLowerCase() || "vertical_9_16";
  const editIntensity = sanitizeText(payload.editIntensity || "balanced", 40).toLowerCase() || "balanced";
  const stylePreset = sanitizeText(payload.stylePreset || "social_sports_v1", 40).toLowerCase() || "social_sports_v1";
  const source = payload.source || project.source || upload.source || null;
  if (!title || !preset) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  const approvedEditPlan = payload.approvedEditPlan
    ? deps.validateEditPlan(payload.approvedEditPlan, metadata)
    : null;
  const audioKey = `${job.id}.wav`;
  const subtitlesKey = `${job.id}.ass`;
  const outputKey = `${job.id}.mp4`;
  const audio = localPathForNewArtifact(deps.artifactStore, { type: "extracted_audio", storageKey: audioKey, ownerProjectId: project.id, ownerJobId: job.id, source });
  const output = localPathForNewArtifact(deps.artifactStore, { type: "rendered_video", storageKey: outputKey, ownerProjectId: project.id, ownerJobId: job.id, source });
  const subtitles = localPathForNewArtifact(deps.artifactStore, { type: "subtitle_temp", storageKey: subtitlesKey, ownerProjectId: project.id, ownerJobId: job.id, source });
  return {
    audioKey,
    audioPath: audio.localPath,
    audioStage: audio,
    inputArtifact,
    inputPath,
    inputStage,
    language,
    metadata,
    outputKey,
    outputPath: output.localPath,
    outputStage: output,
    preset,
    source,
    subtitlesKey,
    subtitlesPath: subtitles.localPath,
    subtitlesStage: subtitles,
    stylePreset,
    styleTarget,
    editIntensity,
    title,
    approvedEditPlan,
    regenerationApproval: payload.regenerationApproval && typeof payload.regenerationApproval === "object"
      ? {
          approvalId: sanitizeText(payload.regenerationApproval.approvalId || "", 80),
          regenerationPlanId: sanitizeText(payload.regenerationApproval.regenerationPlanId || "", 120),
          draftHash: sanitizeText(payload.regenerationApproval.draftHash || "", 80),
          draftRecordId: sanitizeText(payload.regenerationApproval.draftRecordId || "", 80),
          sourceJobId: sanitizeText(payload.regenerationApproval.sourceJobId || "", 120),
          sourceExportId: sanitizeText(payload.regenerationApproval.sourceExportId || "", 120),
          approvedAt: sanitizeText(payload.regenerationApproval.approvedAt || "", 80),
          approvedBy: sanitizeText(payload.regenerationApproval.approvedBy || "", 80),
        }
      : null,
  };
}

function normalizedCaption(caption, mediaDuration) {
  const start = Number(caption && caption.start);
  const end = Number(caption && caption.end);
  const text = sanitizeText(caption && caption.text, 160);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !text) return null;
  if (Number.isFinite(mediaDuration) && end > mediaDuration + 1) return null;
  return { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), text };
}

function validateTranscript(transcript, metadata = {}) {
  if (!transcript || typeof transcript !== "object") {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const mediaDuration = Number(metadata.durationSeconds || 0);
  const captions = Array.isArray(transcript.captions) ? transcript.captions.map((caption) => normalizedCaption(caption, mediaDuration)) : [];
  if (!captions.length || captions.some((caption) => !caption)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const segments = Array.isArray(transcript.segments)
    ? transcript.segments.map((segment) => normalizedCaption(segment, mediaDuration)).filter(Boolean)
    : [];
  return {
    ...transcript,
    provider: sanitizeText(transcript.provider || "unknown", 40),
    language: sanitizeText(transcript.language || "auto", 32) || "auto",
    text: sanitizeText(transcript.text || captions.map((caption) => caption.text).join(" "), 4000),
    captions,
    segments,
  };
}

function validateMediaSignals(signals, metadata = {}) {
  if (!signals || typeof signals !== "object") {
    throw new AppError("ANALYSIS_FAILED", SAFE_MESSAGES.ANALYSIS_FAILED, 502);
  }
  const durationSeconds = Number(signals.durationSeconds || metadata.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new AppError("ANALYSIS_FAILED", SAFE_MESSAGES.ANALYSIS_FAILED, 502);
  }
  return {
    ...signals,
    durationSeconds,
    audioPeaks: Array.isArray(signals.audioPeaks) ? signals.audioPeaks : [],
    sceneChanges: Array.isArray(signals.sceneChanges) ? signals.sceneChanges : [],
    highMotionCandidates: Array.isArray(signals.highMotionCandidates) ? signals.highMotionCandidates : [],
  };
}

function visualCandidateWindowsFromSignals(mediaSignals = {}) {
  const windows = [];
  for (const item of Array.isArray(mediaSignals.highMotionCandidates) ? mediaSignals.highMotionCandidates : []) {
    windows.push({
      time: item.time,
      confidence: item.confidence,
      source: item.source || "high_motion_candidate",
    });
  }
  for (const item of Array.isArray(mediaSignals.audioPeaks) ? mediaSignals.audioPeaks : []) {
    windows.push({
      time: item.time,
      confidence: Math.min(0.78, Number(item.energyScore || 0.55)),
      source: item.source || "audio_peak_context",
    });
  }
  for (const item of Array.isArray(mediaSignals.sceneChanges) ? mediaSignals.sceneChanges : []) {
    windows.push({
      time: item.time,
      confidence: Math.min(0.72, Number(item.confidence || 0.5)),
      source: item.source || "scene_change_context",
    });
  }
  return windows.slice(0, 16);
}

function validateHighlightResult(result, metadata = {}) {
  if (!result || typeof result !== "object" || !Array.isArray(result.moments) || result.moments.length === 0) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  const durationSeconds = Number(metadata.durationSeconds || 0);
  const moments = result.moments.slice(0, 3).map((moment, index) => {
    const start = Number(moment && moment.start);
    const end = Number(moment && moment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > durationSeconds + 0.25) {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
    }
    if (!Array.isArray(moment.reasonCodes)) {
      throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
    }
    return {
      ...moment,
      id: sanitizeText(moment.id || `moment_${index + 1}`, 60),
      rank: Number.isFinite(Number(moment.rank)) ? Number(moment.rank) : index + 1,
      start,
      end,
      highlightType: sanitizeText(moment.highlightType || "generic_highlight", 60),
      confidence: Number.isFinite(Number(moment.confidence)) ? Number(moment.confidence) : 0,
      reasonCodes: moment.reasonCodes.map((reason) => sanitizeText(reason, 60)).filter(Boolean),
      retentionScore: Number.isFinite(Number(moment.retentionScore)) ? Number(moment.retentionScore) : 0,
    };
  });
  return { ...result, moments };
}

function publicMediaSignals(mediaSignals) {
  return {
    durationSeconds: mediaSignals.durationSeconds,
    audioPeaks: mediaSignals.audioPeaks,
    sceneChanges: mediaSignals.sceneChanges,
  };
}

function updateJobStep({ jobs, job, projectId, requestId, logger, progress, step }) {
  jobs.update(job, { status: "processing", progress, step });
  logInfo(logger, {
    event: "job_step",
    requestId,
    projectId,
    jobId: job.id,
    step,
    progress: job.progress,
  });
}

function completeCancelledJob({ jobs, job, logger, projectId, requestId }) {
  if (!job) return;
  if (job.status !== "cancelled") {
    jobs.update(job, {
      status: "cancelled",
      error: { code: "JOB_CANCELLED", message: SAFE_MESSAGES.JOB_CANCELLED },
      step: "cancelled",
    });
  }
  logInfo(logger, { event: "job_cancelled", requestId, projectId, jobId: job.id, code: "JOB_CANCELLED" });
}

function failJob({ jobs, job, project, error, logger, requestId }) {
  if (project) {
    project.status = "failed";
    project.updatedAt = nowIso();
  }
  if (job) jobs.fail(job, error);
  logInfo(logger, {
    event: "job_failed",
    requestId,
    projectId: project && project.id,
    jobId: job && job.id,
    code: (job && job.error && job.error.code) || error.code || "UNEXPECTED",
  });
}

function projectSetReady(project, deps) {
  project.status = "ready";
  project.updatedAt = nowIso();
  if (deps.projectRepository && typeof deps.projectRepository.save === "function") {
    deps.projectRepository.save(project);
  }
}

function createExportRecord({ deps, exportsById, record }) {
  if (deps.exportRepository && typeof deps.exportRepository.create === "function") {
    return deps.exportRepository.create(record);
  }
  if (exportsById && typeof exportsById.set === "function") {
    exportsById.set(record.id, record);
    return record;
  }
  throw new AppError("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, 500);
}

function persistExportAndReadyProject({ deps, exportsById, project, record }) {
  if (deps.persistenceAdapter && typeof deps.persistenceAdapter.transaction === "function") {
    return deps.persistenceAdapter.transaction(() => {
      const exportRecord = createExportRecord({ deps, exportsById, record });
      projectSetReady(project, deps);
      return exportRecord;
    });
  }
  const exportRecord = createExportRecord({ deps, exportsById, record });
  projectSetReady(project, deps);
  return exportRecord;
}

function persistRenderResult(deps, record) {
  if (deps.persistRenderRecord && typeof deps.persistRenderRecord === "function") {
    deps.persistRenderRecord(record);
    return;
  }
  deps.writeJsonAtomic(deps.storagePath("projects", `${record.project.id}.render.json`), record);
}

function artifactSize(deps, filePath) {
  try {
    return deps.statFile(filePath).size;
  } catch {
    return null;
  }
}

function indexArtifact(deps, artifact) {
  if (!artifact || !deps.artifactRepository || typeof deps.artifactRepository.create !== "function") return;
  try {
    deps.artifactRepository.create(artifact);
  } catch (error) {
    logInfo(deps.logger, {
      event: "artifact_index_skipped",
      artifactId: artifact.id,
      code: error.code || "ARTIFACT_INDEX_FAILED",
    });
  }
}

function indexPipelineStages(deps, context) {
  if (!context) return;
  for (const stage of [context.audioStage, context.subtitlesStage]) {
    if (stage && stage.artifact) indexArtifact(deps, stage.artifact);
  }
}

function cleanupPipelineStages({ deps, context, logger, requestId, projectId, jobId }) {
  if (!context || !deps.artifactStore || typeof deps.artifactStore.cleanupStage !== "function") return;
  const stages = [context.inputStage, context.audioStage, context.subtitlesStage, context.outputStage].filter(Boolean);
  for (const stage of stages) {
    const result = deps.artifactStore.cleanupStage(stage);
    if (result && result.cleaned) {
      if (deps.artifactRepository && typeof deps.artifactRepository.markDeleted === "function" && stage.artifact) {
        try {
          deps.artifactRepository.markDeleted(stage.artifact.id);
        } catch {
          // The artifact index is best-effort for already-cleaned temp files.
        }
      }
      logInfo(logger, {
        event: "artifact_stage_cleaned",
        requestId,
        projectId,
        jobId,
        artifactId: stage.artifact && stage.artifact.id,
        storageMode: stage.adapterMode,
        step: "cleanup_stage",
      });
    }
  }
}

function updateApprovalAudit({ deps, context, job, projectId, requestId, status, exportId, error }) {
  const repository = deps && deps.regenerationApprovalRepository;
  const outboxRepository = deps && deps.approvalOutboxRepository;
  const approvalId = context && context.regenerationApproval && context.regenerationApproval.approvalId;
  if (!repository || !approvalId) return null;
  try {
    let record = null;
    let eventType = null;
    if (status === "render_processing" && typeof repository.markRenderProcessing === "function") {
      record = repository.markRenderProcessing(approvalId, job && job.id);
      eventType = "render_processing";
    } else if (status === "render_completed" && typeof repository.markRenderCompleted === "function") {
      record = repository.markRenderCompleted(approvalId, { jobId: job && job.id, exportId });
      eventType = "render_completed";
    } else if (status === "render_failed" && typeof repository.markRenderFailed === "function") {
      record = repository.markRenderFailed(approvalId, {
        jobId: job && job.id,
        errorCode: (error && error.code) || "RENDER_FAILED",
      });
      eventType = "render_failed";
    } else if (status === "cancelled" && typeof repository.markRenderCancelled === "function") {
      record = repository.markRenderCancelled(approvalId, { jobId: job && job.id });
      eventType = "render_cancelled";
    }
    if (record && eventType && outboxRepository && typeof outboxRepository.createLifecycleEvent === "function") {
      outboxRepository.createLifecycleEvent({
        eventType,
        requestId,
        approvalRecord: record,
        jobId: job && job.id,
        exportId,
        errorCode: (error && error.code) || (record && record.errorCode),
        status: record.status,
      });
      logInfo(deps.logger, {
        event: "approval_outbox_created",
        requestId,
        projectId,
        jobId: job && job.id,
        approvalId,
        eventType,
      });
    }
    logInfo(deps.logger, {
      event: "approval_audit_updated",
      requestId,
      projectId,
      jobId: job && job.id,
      approvalId,
      status,
    });
    return record;
  } catch (auditError) {
    logInfo(deps.logger, {
      event: "approval_audit_update_failed",
      requestId,
      projectId,
      jobId: job && job.id,
      approvalId,
      code: auditError.code || "APPROVAL_AUDIT_UPDATE_FAILED",
    });
    return null;
  }
}

function transcriptFromApprovedPlan(plan, context) {
  const captions = Array.isArray(plan.captions)
    ? plan.captions.map((caption) => ({
        start: caption.start,
        end: caption.end,
        text: sanitizeText(caption.text, 160),
      }))
    : [];
  return validateTranscript({
    provider: "approved_regeneration_draft",
    language: context.language,
    text: captions.map((caption) => caption.text).join(" "),
    captions,
    segments: captions,
  }, context.metadata);
}

function mediaSignalsFromApprovedPlan(context) {
  return validateMediaSignals({
    durationSeconds: context.metadata.durationSeconds,
    audioPeaks: [],
    sceneChanges: [],
    highMotionCandidates: [],
  }, context.metadata);
}

function visualSignalsFromApprovedPlan(plan, context) {
  return validateVisualSignals({
    providerMode: "approved_regeneration_draft",
    fallbackUsed: false,
    confidence: Number.isFinite(Number(plan.actionFocusConfidence)) ? Number(plan.actionFocusConfidence) : 0,
    providerMetadata: {
      model: "human-approved-draft",
      latencyMs: 0,
    },
    windows: [],
  }, context.metadata);
}

function highlightResultFromApprovedPlan(plan) {
  return {
    moments: [{
      id: "approved_regeneration_moment",
      rank: 1,
      start: plan.sourceStart,
      end: plan.sourceEnd,
      highlightType: plan.highlightType || "generic_highlight",
      confidence: Number.isFinite(Number(plan.confidence)) ? Number(plan.confidence) : 0.8,
      reasonCodes: Array.isArray(plan.reasonCodes) ? plan.reasonCodes : [plan.highlightType || "generic_highlight"],
      retentionScore: Number.isFinite(Number(plan.retentionScore)) ? Number(plan.retentionScore) : 88,
    }],
  };
}

async function runRenderJob(options) {
  const {
    jobs,
    exportsById,
    exportRepository,
    projectRepository,
    job,
    project,
    upload,
    payload,
    requestId,
    dependencies,
  } = options || {};
  const deps = createDefaultDependencies({ exportRepository, projectRepository, ...dependencies });
  const signal = job && job._controller ? job._controller.signal : null;
  let context = null;
  let sampledFrames = null;
  let sampledFrameSummary = null;
  let transcript = null;
  let mediaSignals = null;
  let visualSignals = null;
  let trackingProviderOutput = null;
  let visualTracking = null;
  let highlightResult = null;
  let candidatePlans = null;
  let editPlan = null;
  try {
    context = assertPipelineContext({ job, project, upload, payload, deps });
    indexPipelineStages(deps, context);

    if (context.approvedEditPlan) {
      updateApprovalAudit({
        deps,
        context,
        job,
        projectId: project.id,
        requestId,
        status: "render_processing",
      });
      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 72, step: "approved_edit_plan" });
      editPlan = deps.validateEditPlan(context.approvedEditPlan, context.metadata);
      candidatePlans = [editPlan];
      highlightResult = validateHighlightResult(highlightResultFromApprovedPlan(editPlan), context.metadata);
      mediaSignals = mediaSignalsFromApprovedPlan(context);
      visualSignals = visualSignalsFromApprovedPlan(editPlan, context);
      trackingProviderOutput = null;
      visualTracking = publicVisualTrackingSummary(editPlan.visualTrackingSummary || null, context.metadata);
      transcript = transcriptFromApprovedPlan(editPlan, context);
      sampledFrameSummary = {
        providerMode: "approved_regeneration_draft",
        fallbackUsed: false,
        summary: {
          frameCount: 0,
          sampledWindows: 0,
          skippedWindows: 0,
        },
        frames: [],
      };
      logInfo(deps.logger, {
        event: "approved_edit_plan_selected",
        requestId,
        projectId: project.id,
        jobId: job.id,
        approvalId: context.regenerationApproval && context.regenerationApproval.approvalId,
        regenerationPlanId: context.regenerationApproval && context.regenerationApproval.regenerationPlanId,
        highlightType: editPlan.highlightType,
        framingMode: editPlan.framingMode,
        aspectRatio: editPlan.aspectRatio,
      });
    } else {
      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 8, step: "extract_audio" });
      if (context.metadata.hasAudio) {
        await deps.extractAudio(context.inputPath, context.audioPath, { signal });
      }

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 22, step: "analyze_media" });
      mediaSignals = validateMediaSignals(
        await deps.extractMediaSignals({
          inputPath: context.inputPath,
          metadata: context.metadata,
          signal,
        }),
        context.metadata,
      );

      const visualCandidateWindows = visualCandidateWindowsFromSignals(mediaSignals);
      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 30, step: "extract_sampled_frames" });
      sampledFrames = await deps.extractSampledFrames({
        inputPath: context.inputPath,
        metadata: context.metadata,
        candidateWindows: visualCandidateWindows,
        signal,
      });
      sampledFrameSummary = publicFrameSummary(sampledFrames);
      logInfo(deps.logger, {
        event: "frame_extraction_completed",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "extract_sampled_frames",
        providerMode: sampledFrameSummary.providerMode,
        fallbackUsed: sampledFrameSummary.fallbackUsed,
        frameCount: sampledFrameSummary.summary.frameCount,
        sampledWindows: sampledFrameSummary.summary.sampledWindows,
        skippedWindows: sampledFrameSummary.summary.skippedWindows,
      });

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 38, step: "analyze_visuals" });
      visualSignals = validateVisualSignals(
        await deps.analyzeFrames({
          inputPath: context.inputPath,
          metadata: context.metadata,
          candidateWindows: visualCandidateWindows,
          mediaSignals,
          frames: sampledFrames.frames,
          frameSummary: sampledFrameSummary,
          signal,
        }),
        context.metadata,
      );
      trackingProviderOutput = publicTrackingProviderOutput(await deps.analyzeTracking({
        inputPath: context.inputPath,
        metadata: context.metadata,
        candidateWindows: visualCandidateWindows,
        mediaSignals,
        visualSignals,
        frames: sampledFrames.frames,
        frameSummary: sampledFrameSummary,
        signal,
      }), context.metadata);
      visualTracking = publicVisualTrackingSummary(deps.analyzeVisualTracking({
        inputPath: context.inputPath,
        metadata: context.metadata,
        candidateWindows: visualCandidateWindows,
        mediaSignals,
        visualSignals,
        trackingProviderOutput,
        frames: sampledFrames.frames,
        frameSummary: sampledFrameSummary,
      }), context.metadata);
      logInfo(deps.logger, {
        event: "visual_analysis_completed",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "analyze_visuals",
        providerMode: visualSignals.providerMode,
        frameCount: sampledFrameSummary.summary.frameCount,
        visualWindowCount: visualSignals.summary.windowCount,
        fallbackUsed: visualSignals.fallbackUsed,
        latencyMs: visualSignals.providerMetadata && visualSignals.providerMetadata.latencyMs,
        errorCode: visualSignals.failure && visualSignals.failure.code,
      });
      logInfo(deps.logger, {
        event: "visual_tracking_completed",
        requestId,
        projectId: project.id,
        jobId: job.id,
        step: "analyze_visual_tracking",
        providerMode: trackingProviderOutput.providerMode,
        frameCount: visualTracking.frameCount,
        ballTrackCount: trackingProviderOutput.ballTrackCount,
        playerClusterCount: trackingProviderOutput.playerClusterCount,
        trackingConfidence: visualTracking.trackingConfidence,
        ballCandidateConfidence: visualTracking.ballCandidateConfidence,
        playerClusterConfidence: visualTracking.playerClusterConfidence,
        recommendedFramingMode: visualTracking.recommendedFramingMode,
        cropSafetyReason: visualTracking.cropSafetyReason,
        fallbackUsed: visualTracking.fallbackUsed,
        errorCode: trackingProviderOutput.failure && trackingProviderOutput.failure.code,
      });

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 46, step: "transcribe" });
      const provider = deps.chooseTranscriptionProvider({ forceMock: !context.metadata.hasAudio });
      transcript = validateTranscript(
        await provider.transcribe({
          audioPath: context.audioPath,
          metadata: context.metadata,
          preset: context.preset,
          title: context.title,
          language: context.language,
        }),
        context.metadata,
      );

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 58, step: "detect_highlights" });
      highlightResult = validateHighlightResult(
        deps.detectHighlights({
          transcript,
          signals: mediaSignals,
          visualSignals,
          preset: context.preset,
          title: context.title,
        }),
        context.metadata,
      );

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 66, step: "plan_story" });

      updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 72, step: "create_edit_plan" });
      candidatePlans = deps.createCandidateEditPlans({
        moments: highlightResult.moments,
        metadata: context.metadata,
        transcript,
        mediaSignals,
        visualSignals,
        visualTracking,
        preset: context.preset,
        title: context.title,
        language: context.language,
        styleTarget: context.styleTarget,
        editIntensity: context.editIntensity,
        stylePreset: context.stylePreset,
      });
      if (!Array.isArray(candidatePlans) || candidatePlans.length === 0) {
        throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
      }
      editPlan = deps.validateEditPlan(candidatePlans[0], context.metadata);
      if (candidatePlans[0] && candidatePlans[0].visualQA) {
        editPlan.visualQA = candidatePlans[0].visualQA;
      }
    }
    logInfo(deps.logger, {
      event: "edit_plan_selected",
      requestId,
      projectId: project.id,
      jobId: job.id,
      highlightType: editPlan.highlightType,
      confidence: editPlan.confidence,
      framingMode: editPlan.framingMode,
      stylePreset: editPlan.stylePreset,
      styleTarget: editPlan.styleTarget,
      editIntensity: editPlan.editIntensity,
      aspectRatio: editPlan.aspectRatio,
      captionSafetyStatus: editPlan.highlightType === "goal" ? "goal-language-allowed" : "false-goal-guarded",
      falseGoalGuardTriggered: editPlan.highlightType !== "goal",
      visualProviderMode: visualSignals.providerMode,
      visualWindowCount: visualSignals.summary.windowCount,
      visualTrackingConfidence: visualTracking && visualTracking.trackingConfidence,
      cropPlanMode: editPlan.cropPlan && editPlan.cropPlan.mode,
      cropPlanFallbackUsed: editPlan.cropPlan && editPlan.cropPlan.fallbackUsed,
      actionFocusConfidence: editPlan.actionFocusConfidence,
      framingReason: editPlan.framingReason,
      animationCueCount: Array.isArray(editPlan.animationCues) ? editPlan.animationCues.length : 0,
      unsupportedAnimationCueCount: Array.isArray(editPlan.unsupportedAnimationCues) ? editPlan.unsupportedAnimationCues.length : 0,
    });

    updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 78, step: "render_kinetic_captions" });
    updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 82, step: "render_beat_effects" });
    updateJobStep({ jobs, job, projectId: project.id, requestId, logger: deps.logger, progress: 86, step: "render_short" });
    await deps.renderShort({
      inputPath: context.inputPath,
      outputPath: context.outputPath,
      subtitlesPath: context.subtitlesPath,
      plan: editPlan,
      signal,
    });
    if (!deps.fileExists(context.outputPath) || !deps.isRegularFile(context.outputPath)) {
      throw new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500);
    }

    const renderedArtifact = typeof deps.artifactStore.commitOutputStageAsync === "function"
      ? await deps.artifactStore.commitOutputStageAsync(context.outputStage, {
          contentType: "video/mp4",
          status: "available",
          signal,
        })
      : deps.artifactStore.commitOutputStage(context.outputStage, {
          contentType: "video/mp4",
          status: "available",
        });
    logInfo(deps.logger, {
      event: "artifact_committed",
      requestId,
      projectId: project.id,
      jobId: job.id,
      artifactId: renderedArtifact.id,
      storageMode: context.outputStage.adapterMode,
      step: "commit_render",
    });
    indexArtifact(deps, renderedArtifact);

    const exportId = deps.createExportId();
    const exportRecord = persistExportAndReadyProject({
      deps,
      exportsById,
      project,
      record: {
        id: exportId,
        projectId: project.id,
        jobId: job.id,
        outputPath: context.outputStage.permanentLocal ? context.outputPath : null,
        artifact: deps.artifactStore.createRecord({
          id: exportId,
          type: "export",
          ownerProjectId: project.id,
          ownerJobId: job.id,
          storageKey: context.outputKey,
          size: renderedArtifact.size ?? artifactSize(deps, context.outputPath),
          contentType: renderedArtifact.contentType || "video/mp4",
          source: context.source,
          status: "available",
        }),
        fileName: `${project.id}-short.mp4`,
        source: context.source,
        createdAt: nowIso(),
      },
    });
    jobs.complete(job, {
      outputPath: context.outputStage.permanentLocal ? context.outputPath : null,
      exportId,
      editPlan,
      candidatePlans,
      highlights: highlightResult.moments,
      mediaSignals: publicMediaSignals(mediaSignals),
      visualSignals: publicVisualSignals(visualSignals),
      trackingProviderOutput,
      visualTracking,
      sampledFrames: sampledFrameSummary,
      step: "completed",
    });
    updateApprovalAudit({
      deps,
      context,
      job,
      projectId: project.id,
      requestId,
      status: "render_completed",
      exportId,
    });
    persistRenderResult(deps, {
      project,
      job: jobs.publicJob(job),
      transcript,
      mediaSignals,
      visualSignals,
      trackingProviderOutput,
      visualTracking,
      sampledFrames: sampledFrameSummary,
      highlights: highlightResult.moments,
      candidatePlans,
      editPlan,
      exportId,
      exportRecord,
    });
    logInfo(deps.logger, {
      event: "job_completed",
      requestId,
      projectId: project.id,
      jobId: job.id,
      exportId,
      highlightType: editPlan.highlightType,
      confidence: editPlan.confidence,
      framingMode: editPlan.framingMode,
      stylePreset: editPlan.stylePreset,
      styleTarget: editPlan.styleTarget,
      editIntensity: editPlan.editIntensity,
      aspectRatio: editPlan.aspectRatio,
      captionSafetyStatus: editPlan.highlightType === "goal" ? "goal-language-allowed" : "false-goal-guarded",
      falseGoalGuardTriggered: editPlan.highlightType !== "goal",
      visualProviderMode: visualSignals.providerMode,
      visualWindowCount: visualSignals.summary.windowCount,
      visualTrackingConfidence: visualTracking && visualTracking.trackingConfidence,
      cropPlanMode: editPlan.cropPlan && editPlan.cropPlan.mode,
      cropPlanFallbackUsed: editPlan.cropPlan && editPlan.cropPlan.fallbackUsed,
      actionFocusConfidence: editPlan.actionFocusConfidence,
      framingReason: editPlan.framingReason,
      animationCueCount: Array.isArray(editPlan.animationCues) ? editPlan.animationCues.length : 0,
      unsupportedAnimationCueCount: Array.isArray(editPlan.unsupportedAnimationCues) ? editPlan.unsupportedAnimationCues.length : 0,
    });
  } catch (error) {
    if ((signal && signal.aborted) || (job && job.status === "cancelled") || error.code === "JOB_CANCELLED") {
      completeCancelledJob({ jobs, job, logger: deps.logger, projectId: project && project.id, requestId });
      updateApprovalAudit({
        deps,
        context,
        job,
        projectId: project && project.id,
        requestId,
        status: "cancelled",
        error,
      });
      return;
    }
    failJob({ jobs, job, project, error, logger: deps.logger, requestId });
    updateApprovalAudit({
      deps,
      context,
      job,
      projectId: project && project.id,
      requestId,
      status: "render_failed",
      error,
    });
  } finally {
    if (sampledFrames && typeof deps.cleanupSampledFrames === "function") {
      const cleanupResult = deps.cleanupSampledFrames({
        outputDir: sampledFrames.outputDir,
        frames: sampledFrames.frames,
      });
      if (cleanupResult && cleanupResult.cleanedCount > 0) {
        logInfo(deps.logger, {
          event: "sampled_frames_cleaned",
          requestId,
          projectId: project && project.id,
          jobId: job && job.id,
          step: "cleanup_sampled_frames",
          cleanedCount: cleanupResult.cleanedCount,
        });
      }
    }
    cleanupPipelineStages({
      deps,
      context,
      logger: deps.logger,
      requestId,
      projectId: project && project.id,
      jobId: job && job.id,
    });
  }
}

function enqueueRenderJob(options) {
  const { jobs, job, project, requestId, dependencies } = options || {};
  const deps = createDefaultDependencies(dependencies);
  if (!job || job.status !== "queued") return job;
  jobs.update(job, { status: "processing", progress: 1, step: "queued" });
  logInfo(deps.logger, {
    event: "job_started",
    requestId,
    projectId: project && project.id,
    jobId: job.id,
  });
  deps.scheduler(() => {
    runRenderJob({ ...options, dependencies: deps }).catch((error) => {
      logInfo(deps.logger, {
        event: "job_unhandled_rejection",
        requestId,
        projectId: project && project.id,
        jobId: job.id,
        code: error && error.code ? error.code : "UNEXPECTED",
      });
    });
  });
  return job;
}

module.exports = {
  createDefaultDependencies,
  enqueueRenderJob,
  runRenderJob,
  validateHighlightResult,
  validateMediaSignals,
  validateTranscript,
  visualCandidateWindowsFromSignals,
  resolveLocalArtifactPath,
};
