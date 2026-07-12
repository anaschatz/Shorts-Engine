const { randomUUID } = require("node:crypto");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { CONFIG } = require("../../config.cjs");
const { AppError } = require("../../errors.cjs");
const { sha256 } = require("../../media.cjs");
const { renderNarratedKeyframes } = require("../../adapters/narrated-renderer-adapter.cjs");
const { normalizeDraftBundle } = require("./contracts.cjs");
const { createPreviewTimingManifest } = require("./preview-timing.cjs");
const { alignmentToNarrationManifest, normalizeAlignment } = require("./narration/alignment.cjs");
const { normalizeNarrationAsset } = require("./narration/contract.cjs");
const { compileTimeline } = require("./timeline-compiler.cjs");
const { NARRATED_COMPOSITOR_VERSION, composeNarratedPreview } = require("./video-compositor.cjs");
const { verticalDescriptor } = require("./vertical-registry.cjs");
const { createCaptionManifest, CAPTION_RENDERER_VERSION, CAPTION_PROFILE_VERSION } = require("./captions/contract.cjs");
const { captionFontConfig, generateAss } = require("./captions/ass-generator.cjs");
const { persistAssArtifact } = require("./captions/artifact.cjs");
const { AUDIO_PROFILE_VERSION, createAudioNormalizationReport } = require("./audio-normalization.cjs");
const { QA_PROFILE_VERSION } = require("./qa/contract.cjs");
const { publicQaSummary, runQaOrchestrator } = require("./qa/qa-orchestrator.cjs");
const { generateEvidencePackage, publicEvidenceSummary } = require("./evidence/package-orchestrator.cjs");
const { EVIDENCE_PROFILE_VERSION } = require("./evidence/contract.cjs");

function persistProject(dependencies, project) {
  if (dependencies.persistenceAdapter && typeof dependencies.persistenceAdapter.persistProject === "function") {
    dependencies.persistenceAdapter.persistProject({ project });
  }
}

async function runNarratedRenderJob(context = {}) {
  const { jobs, job, project, payload = {}, dependencies = {}, exportRepository } = context;
  const contentArtifacts = dependencies.contentArtifactRepository;
  const approvals = dependencies.contentApprovalRepository;
  const projectRepository = dependencies.projectRepository;
  const artifactStore = dependencies.artifactStore;
  const artifactRepository = dependencies.artifactRepository;
  if (!jobs || !job || !project || !contentArtifacts || !approvals || !projectRepository || !artifactStore || !artifactRepository || !exportRepository) {
    throw new AppError("PIPELINE_HANDLER_UNAVAILABLE", "Narrated render dependencies are unavailable.", 503);
  }
  if (payload.captionRendererVersion !== CAPTION_RENDERER_VERSION || payload.captionProfileVersion !== CAPTION_PROFILE_VERSION || payload.audioNormalizationProfileVersion !== AUDIO_PROFILE_VERSION || payload.compositorVersion !== NARRATED_COMPOSITOR_VERSION || payload.qaProfileVersion !== QA_PROFILE_VERSION || payload.evidenceProfileVersion !== EVIDENCE_PROFILE_VERSION) throw new AppError("VALIDATION_ERROR", "Narrated render versions are invalid.", 409);
  if (project.projectType !== "narrated_short" || project.input.revision !== payload.projectRevision) {
    throw new AppError("PROJECT_REVISION_STALE", "The narrated project revision has changed.", 409);
  }
  const approval = approvals.findApproved(project.id, project.input.revision);
  if (!approval || approval.draftArtifactId !== payload.approvedDraftArtifactId || approval.draftHash !== payload.approvedDraftHash) {
    throw new AppError("CONTENT_APPROVAL_REQUIRED", "The exact narrated draft must be approved before rendering.", 409);
  }
  if (approval.renderProfile !== payload.renderProfile && !(approval.renderProfile === "final" && payload.renderProfile === "preview")) {
    throw new AppError("CONTENT_APPROVAL_REQUIRED", "The approved render profile does not match this job.", 409);
  }
  const envelope = contentArtifacts.readJson(payload.approvedDraftArtifactId);
  if (envelope.artifactType !== "approval_bundle" || envelope.projectId !== project.id || envelope.revision !== project.input.revision || envelope.contentHash !== payload.approvedDraftHash) {
    throw new AppError("ARTIFACT_CONTENT_INVALID", "The approved draft artifact is invalid.", 409);
  }

  const renderer = dependencies.renderNarratedKeyframes || renderNarratedKeyframes;
  const compositor = dependencies.composeNarratedPreview || composeNarratedPreview;
  const draft = normalizeDraftBundle(envelope.body);
  const vertical = verticalDescriptor(draft.verticalId, draft.brief.formatId);
  if (!["available", "preview_available"].includes(vertical.renderCapability)) {
    throw new AppError("VERTICAL_RENDERER_UNAVAILABLE", "The approved content vertical does not have a render implementation yet.", 503, {
      verticalId: vertical.verticalId,
    });
  }
  let narration = createPreviewTimingManifest(draft);
  const uploadedNarrationStatus = project.input.activeNarration && project.input.activeNarration.projectRevision === project.input.revision
    ? project.input.activeNarration.status
    : "not_uploaded";
  let timing = { timingMode: "estimated_silent", alignmentArtifactId: null, alignmentHash: null };
  let alignedContext = null;
  if (uploadedNarrationStatus === "aligned") {
    const active = project.input.activeNarration;
    if (active.aligned !== true || active.timingReady !== true) throw new AppError("NARRATION_ALIGNMENT_REQUIRED", "Exact narration alignment is required.", 409);
    const narrationEnvelope = contentArtifacts.readJson(active.manifestArtifactId);
    const alignmentEnvelope = contentArtifacts.readJson(active.alignmentArtifactId);
    if (narrationEnvelope.artifactType !== "narration_manifest" || alignmentEnvelope.artifactType !== "narration_alignment" || narrationEnvelope.projectId !== project.id || alignmentEnvelope.projectId !== project.id || narrationEnvelope.revision !== project.input.revision || alignmentEnvelope.revision !== project.input.revision || narrationEnvelope.contentHash !== active.manifestHash || alignmentEnvelope.contentHash !== active.alignmentHash) {
      throw new AppError("NARRATION_ALIGNMENT_STALE", "Narration alignment references are stale.", 409);
    }
    const uploaded = normalizeNarrationAsset(narrationEnvelope.body);
    const alignment = normalizeAlignment(alignmentEnvelope.body);
    if (alignment.projectId !== project.id || alignment.projectRevision !== project.input.revision || alignment.draftArtifactId !== payload.approvedDraftArtifactId || alignment.draftHash !== payload.approvedDraftHash || alignment.scriptHash !== draft.script.contentHash || alignment.narrationManifestArtifactId !== active.manifestArtifactId || alignment.narrationManifestHash !== active.manifestHash || alignment.audioArtifactId !== active.audioArtifactId || alignment.audioHash !== active.audioHash || uploaded.audioArtifactId !== active.audioArtifactId || uploaded.audioHash !== active.audioHash) {
      throw new AppError("NARRATION_ALIGNMENT_STALE", "Narration alignment references are stale.", 409);
    }
    narration = alignmentToNarrationManifest(alignment, uploaded);
    timing = { timingMode: "uploaded_aligned", alignmentArtifactId: active.alignmentArtifactId, alignmentHash: active.alignmentHash };
    const audioArtifact = artifactRepository.get(active.audioArtifactId);
    if (!audioArtifact || audioArtifact.type !== "narration_audio" || audioArtifact.ownerProjectId !== project.id || audioArtifact.checksumSha256 !== active.audioHash || audioArtifact.status !== "available") throw new AppError("NARRATION_AUDIO_STALE", "Narration audio references are stale.", 409);
    if (alignment.durationFrames !== Math.ceil(uploaded.media.durationSeconds * 30)) throw new AppError("AUDIO_DURATION_MISMATCH", "Narration and timeline durations do not match.", 409);
    if (payload.narrationManifestHash !== active.manifestHash || payload.audioHash !== active.audioHash || payload.alignmentHash !== active.alignmentHash) throw new AppError("NARRATION_ALIGNMENT_STALE", "Narration alignment references are stale.", 409);
    alignedContext = { active, alignment, uploaded, audioArtifact };
  }
  if (payload.renderProfile === "final" && !alignedContext) throw new AppError("NARRATION_ALIGNMENT_REQUIRED", "Exact narration alignment is required before final rendering.", 409);
  const dimensions = payload.renderProfile === "final" ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
  const timeline = compileTimeline({ draftBundle: draft, narrationManifest: narration, ...timing, ...dimensions });
  const tempRoot = mkdtempSync(join(CONFIG.tmpDir, `narrated-${job.id}-`));
  const timelinePath = join(tempRoot, "timeline.json");
  const draftPath = join(tempRoot, "draft.json");
  const keyframesDir = join(tempRoot, "keyframes");
  mkdirSync(keyframesDir, { recursive: true });
  writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
  writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  const exportId = `exp_${randomUUID()}`;
  const outputStage = artifactStore.createOutputStage("export", {
    id: exportId,
    ownerProjectId: project.id,
    ownerJobId: job.id,
    storageKey: `narrated/${job.id}.mp4`,
    contentType: "video/mp4",
  });

  let updatedProject = projectRepository.update(project.id, { status: "processing" });
  let audioStage = null;
  let assStage = null;
  persistProject(dependencies, updatedProject);
  try {
    jobs.update(job, { progress: 10, step: "compile_timeline" });
    const timelineArtifact = contentArtifacts.createJson({
      type: "timeline_ir",
      projectId: project.id,
      jobId: job.id,
      revision: project.input.revision,
      dependencyHashes: [envelope.contentHash, narration.contentHash, timing.alignmentHash].filter(Boolean),
      body: timeline,
    });
    let captionManifestArtifact = null;
    let captionManifest = null;
    let captionAssArtifact = null;
    let ass = null;
    if (alignedContext) {
      jobs.update(job, { progress: 20, step: "compile_captions" });
      captionManifest = createCaptionManifest({ alignment: alignedContext.alignment, alignmentArtifactId: alignedContext.active.alignmentArtifactId, alignmentHash: alignedContext.active.alignmentHash });
      captionManifestArtifact = contentArtifacts.createJson({ type: "caption_manifest", projectId: project.id, jobId: job.id, revision: project.input.revision, dependencyHashes: [envelope.contentHash, alignedContext.active.manifestHash, alignedContext.active.audioHash, alignedContext.active.alignmentHash], body: captionManifest });
      const font = dependencies.captionFont || captionFontConfig(dependencies.captionEnv || process.env);
      ass = (dependencies.generateAss || generateAss)(captionManifest, { font });
      captionAssArtifact = persistAssArtifact({ artifactStore, artifactRepository, projectId: project.id, projectRevision: project.input.revision, jobId: job.id, captionManifestHash: captionManifestArtifact.envelope.contentHash, alignmentHash: alignedContext.active.alignmentHash, rendererVersion: CAPTION_RENDERER_VERSION, buffer: ass.buffer });
      audioStage = artifactStore.stageInputForProcessing(alignedContext.audioArtifact, { step: "mux_narration" });
      assStage = artifactStore.stageInputForProcessing(captionAssArtifact, { step: "burn_captions" });
    }
    jobs.update(job, { progress: 30, step: "render_keyframes" });
    const keyframes = await renderer({
      timelinePath,
      timelineArea: "tmp",
      draftPath,
      draftArea: "tmp",
      outputDir: keyframesDir,
      outputArea: "tmp",
      signal: job._controller && job._controller.signal,
    });
    jobs.update(job, { progress: 65, step: "compose_preview" });
    const renderResult = await compositor({
      timeline,
      keyframeManifest: keyframes,
      outputPath: outputStage.localPath,
      renderProfile: payload.renderProfile,
      audioPath: audioStage && audioStage.localPath,
      assPath: assStage && assStage.localPath,
      font: ass && ass.font,
      signal: job._controller && job._controller.signal,
    });
    if (alignedContext && (!renderResult.audioIncluded || !renderResult.captionsIncluded || !renderResult.captionsBurned || !renderResult.audioNormalized || !renderResult.loudness)) throw new AppError("NARRATED_COMPOSITION_FAILED", "Narrated preview composition failed.", 409);
    let audioNormalizationArtifact = null;
    let normalizationReport = null;
    if (alignedContext) {
      normalizationReport = createAudioNormalizationReport({ projectId: project.id, projectRevision: project.input.revision, audioArtifactId: alignedContext.active.audioArtifactId, audioHash: alignedContext.active.audioHash, alignmentArtifactId: alignedContext.active.alignmentArtifactId, alignmentHash: alignedContext.active.alignmentHash, loudness: renderResult.loudness });
      audioNormalizationArtifact = contentArtifacts.createJson({ type: "audio_normalization_report", projectId: project.id, jobId: job.id, revision: project.input.revision, dependencyHashes: [alignedContext.active.audioHash, alignedContext.active.alignmentHash], body: normalizationReport });
    }
    let qaArtifact = null;
    let qaSummary = null;
    let qaReport = null;
    let qaAnalysis = null;
    let evidencePackage = null;
    let evidenceSummary = null;
    const outputHash = sha256(outputStage.localPath);
    if (alignedContext) {
      jobs.update(job, { progress: 85, step: "technical_qa" });
      const qaRunner = dependencies.runQaOrchestrator || runQaOrchestrator;
      const qa = await qaRunner({ project, approval, draftEnvelope: { ...envelope, artifactId: payload.approvedDraftArtifactId }, draft, active: alignedContext.active, narration: alignedContext.uploaded, audioArtifact: alignedContext.audioArtifact, alignment: alignedContext.alignment, caption: captionManifest, captionManifestArtifact, captionAssArtifact, normalization: normalizationReport, normalizationArtifact: audioNormalizationArtifact, timeline, timelineArtifact, renderResult, outputPath: outputStage.localPath, outputHash, renderProfile: payload.renderProfile, fontAvailable: Boolean(ass && ass.font), signal: job._controller && job._controller.signal }, { analyzeRenderedVideo: dependencies.analyzeRenderedVideo, ffprobeJson: dependencies.qaFfprobeJson, ffmpegRunner: dependencies.qaFfmpegRunner });
      qaReport = qa.report;
      qaAnalysis = qa.analysis;
      qaArtifact = contentArtifacts.createJson({ type: "qa_report", projectId: project.id, jobId: job.id, revision: project.input.revision, dependencyHashes: [envelope.contentHash, alignedContext.active.manifestHash, alignedContext.active.audioHash, alignedContext.active.alignmentHash, captionManifestArtifact.envelope.contentHash, captionAssArtifact.checksumSha256, audioNormalizationArtifact.envelope.contentHash, timeline.contentHash, outputHash], body: qa.report });
      qaSummary = { ...publicQaSummary(qa.report, qaArtifact), qaStatus: qa.report.status, qaPassed: qa.report.status === "passed", technicalFinal: payload.renderProfile === "final", publishable: false };
      jobs.update(job, { progress: 92, step: qa.report.status === "passed" ? "qa_passed" : "qa_blocked", technicalQa: qaSummary });
      if (qa.report.status !== "passed") throw new AppError("QA_BLOCKED", "Technical QA blocked this output.", 409, { failedGateCodes: qaSummary.failedGateCodes, blockingFailedCount: qaSummary.blockingFailedCount, nextAction: "fix-blocking-qa-gates" });
    }
    if (payload.renderProfile === "final") {
      jobs.update(job, { progress: 95, step: "build_evidence_package" });
      try {
        const packageRunner = dependencies.generateEvidencePackage || generateEvidencePackage;
        evidencePackage = await packageRunner({ project, approval, draftEnvelope: { ...envelope, artifactId: payload.approvedDraftArtifactId }, draft, active: alignedContext.active, narration: alignedContext.uploaded, alignmentArtifact: { artifact: { id: alignedContext.active.alignmentArtifactId }, envelope: { contentHash: alignedContext.active.alignmentHash } }, captionManifestArtifact, captionAssArtifact, normalizationArtifact: audioNormalizationArtifact, timelineArtifact, qaArtifact, qaReport, qaAnalysis, outputHash, outputPath: outputStage.localPath, timeline, artifactStore, artifactRepository, contentArtifacts, jobId: job.id, fontId: ass && ass.font && ass.font.name || "managed_caption_font", signal: job._controller && job._controller.signal }, { generateContactSheet: dependencies.generateContactSheet, ffmpegRunner: dependencies.contactSheetFfmpegRunner, ffprobeJson: dependencies.contactSheetFfprobeJson });
        evidenceSummary = evidencePackage && evidencePackage.summary || publicEvidenceSummary(evidencePackage);
        jobs.update(job, { progress: 98, step: "evidence_package_validated", evidencePackage: evidenceSummary });
      } catch (error) {
        const failedArtifactCode = String(error && error.details && error.details.failedArtifactCode || error && error.code || "EVIDENCE_PACKAGE_INCOMPLETE").slice(0, 80);
        jobs.update(job, { step: "evidence_package_blocked", evidencePackage: { packageStatus: "failed", failedArtifactCode, outputHash, technicalFinal: true, qaPassed: true, publishable: false, publishApprovalRequired: true } });
        if (error && error.code === "JOB_CANCELLED") throw error;
        if (error instanceof AppError) throw error;
        throw new AppError("TECHNICAL_EXPORT_BLOCKED", "The technical export is blocked by its evidence package.", 409, { failedArtifactCode, nextAction: "fix-technical-evidence-package" });
      }
    }
    const committedArtifact = artifactStore.commitOutputStage(outputStage, { checksumSha256: outputHash });
    artifactRepository.create(committedArtifact);
    const { loudness: _loudness, ...safeRenderResult } = renderResult;
    const renderManifest = contentArtifacts.createJson({
      type: "render_manifest",
      projectId: project.id,
      jobId: job.id,
      revision: project.input.revision,
      dependencyHashes: [envelope.contentHash, timelineArtifact.envelope.contentHash, captionManifestArtifact && captionManifestArtifact.envelope.contentHash, captionAssArtifact && captionAssArtifact.checksumSha256, audioNormalizationArtifact && audioNormalizationArtifact.envelope.contentHash, qaArtifact && qaArtifact.envelope.contentHash, evidenceSummary && evidenceSummary.rightsManifestHash, evidenceSummary && evidenceSummary.provenanceReportHash, evidenceSummary && evidenceSummary.exportMetadataHash, evidenceSummary && evidenceSummary.contactSheetHash].filter(Boolean),
      body: {
        ...safeRenderResult,
        outputPath: undefined,
        exportArtifactId: committedArtifact.id,
        outputSha256: committedArtifact.checksumSha256,
        silentPreview: !alignedContext,
        previewOnly: payload.renderProfile === "preview",
        publishable: false,
        narrationMode: narration.providerMode,
        narrationStatus: uploadedNarrationStatus,
        narrationUsed: Boolean(alignedContext),
        narrationTimingUsed: timing.timingMode === "uploaded_aligned",
        audioIncluded: Boolean(alignedContext),
        captionsIncluded: Boolean(alignedContext),
        captionsBurned: Boolean(alignedContext),
        audioNormalized: Boolean(alignedContext),
        captionManifestArtifactId: captionManifestArtifact && captionManifestArtifact.artifact.id,
        captionManifestHash: captionManifestArtifact && captionManifestArtifact.envelope.contentHash,
        captionAssArtifactId: captionAssArtifact && captionAssArtifact.id,
        captionAssHash: captionAssArtifact && captionAssArtifact.checksumSha256,
        audioNormalizationReportArtifactId: audioNormalizationArtifact && audioNormalizationArtifact.artifact.id,
        audioNormalizationReportHash: audioNormalizationArtifact && audioNormalizationArtifact.envelope.contentHash,
        timingMode: timing.timingMode,
        qaStatus: qaSummary && qaSummary.qaStatus || "not_run",
        qaPassed: qaSummary && qaSummary.qaPassed || false,
        qaReportArtifactId: qaSummary && qaSummary.qaReportArtifactId || null,
        qaReportHash: qaSummary && qaSummary.qaReportHash || null,
        technicalFinal: payload.renderProfile === "final",
        packageStatus: evidenceSummary && evidenceSummary.packageStatus || "not_required",
        contactSheetArtifactId: evidenceSummary && evidenceSummary.contactSheetArtifactId || null,
        contactSheetHash: evidenceSummary && evidenceSummary.contactSheetHash || null,
        rightsManifestArtifactId: evidenceSummary && evidenceSummary.rightsManifestArtifactId || null,
        rightsManifestHash: evidenceSummary && evidenceSummary.rightsManifestHash || null,
        provenanceReportArtifactId: evidenceSummary && evidenceSummary.provenanceReportArtifactId || null,
        provenanceReportHash: evidenceSummary && evidenceSummary.provenanceReportHash || null,
        exportMetadataArtifactId: evidenceSummary && evidenceSummary.exportMetadataArtifactId || null,
        exportMetadataHash: evidenceSummary && evidenceSummary.exportMetadataHash || null,
        publishApprovalRequired: payload.renderProfile === "final",
      },
    });
    const createdAt = new Date().toISOString();
    exportRepository.create({
      id: exportId,
      projectId: project.id,
      jobId: job.id,
      ownerId: job.ownerId,
      artifact: committedArtifact,
      outputPath: outputStage.localPath,
      fileName: `${project.id}-narrated-${payload.renderProfile}.mp4`,
      status: "completed",
      createdAt,
    });
    updatedProject = projectRepository.update(project.id, { status: "ready" });
    persistProject(dependencies, updatedProject);
    jobs.complete(job, {
      step: payload.renderProfile === "final" ? "technical_final_ready" : "narrated_preview_ready",
      outputPath: outputStage.localPath,
      exportId,
      narratedRender: {
        manifestArtifactId: renderManifest.artifact.id,
        manifestHash: renderManifest.envelope.contentHash,
        timelineArtifactId: timelineArtifact.artifact.id,
        timelineHash: timeline.contentHash,
        renderProfile: payload.renderProfile,
        silentPreview: !alignedContext,
        previewOnly: payload.renderProfile === "preview",
        publishable: false,
        narrationStatus: uploadedNarrationStatus,
        narrationUsed: Boolean(alignedContext),
        narrationTimingUsed: timing.timingMode === "uploaded_aligned",
        audioIncluded: Boolean(alignedContext),
        captionsIncluded: Boolean(alignedContext),
        captionsBurned: Boolean(alignedContext),
        audioNormalized: Boolean(alignedContext),
        captionManifestArtifactId: captionManifestArtifact && captionManifestArtifact.artifact.id,
        captionManifestHash: captionManifestArtifact && captionManifestArtifact.envelope.contentHash,
        captionAssArtifactId: captionAssArtifact && captionAssArtifact.id,
        captionAssHash: captionAssArtifact && captionAssArtifact.checksumSha256,
        audioNormalizationReportArtifactId: audioNormalizationArtifact && audioNormalizationArtifact.artifact.id,
        audioNormalizationReportHash: audioNormalizationArtifact && audioNormalizationArtifact.envelope.contentHash,
        timingMode: timing.timingMode,
        qaStatus: qaSummary && qaSummary.qaStatus || "not_run",
        qaPassed: qaSummary && qaSummary.qaPassed || false,
        qaReportArtifactId: qaSummary && qaSummary.qaReportArtifactId || null,
        qaReportHash: qaSummary && qaSummary.qaReportHash || null,
        blockingGateCount: qaSummary && qaSummary.blockingGateCount || 0,
        blockingPassedCount: qaSummary && qaSummary.blockingPassedCount || 0,
        blockingFailedCount: qaSummary && qaSummary.blockingFailedCount || 0,
        warningCount: qaSummary && qaSummary.warningCount || 0,
        failedGateCodes: qaSummary && qaSummary.failedGateCodes || [],
        technicalFinal: payload.renderProfile === "final",
        packageStatus: evidenceSummary && evidenceSummary.packageStatus || "not_required",
        contactSheetArtifactId: evidenceSummary && evidenceSummary.contactSheetArtifactId || null,
        contactSheetHash: evidenceSummary && evidenceSummary.contactSheetHash || null,
        rightsManifestArtifactId: evidenceSummary && evidenceSummary.rightsManifestArtifactId || null,
        rightsManifestHash: evidenceSummary && evidenceSummary.rightsManifestHash || null,
        provenanceReportArtifactId: evidenceSummary && evidenceSummary.provenanceReportArtifactId || null,
        provenanceReportHash: evidenceSummary && evidenceSummary.provenanceReportHash || null,
        exportMetadataArtifactId: evidenceSummary && evidenceSummary.exportMetadataArtifactId || null,
        exportMetadataHash: evidenceSummary && evidenceSummary.exportMetadataHash || null,
        publishApprovalRequired: payload.renderProfile === "final",
      },
      technicalQa: qaSummary,
      evidencePackage: evidenceSummary,
    });
    return { exportId, renderManifest, timelineArtifact, committedArtifact, captionManifestArtifact, captionAssArtifact, audioNormalizationArtifact, qaArtifact, evidencePackage };
  } catch (error) {
    try { artifactStore.deleteStagingArtifact(outputStage.artifact); } catch { /* best-effort uncommitted output cleanup */ }
    updatedProject = projectRepository.update(project.id, { status: "failed" });
    persistProject(dependencies, updatedProject);
    throw error;
  } finally {
    if (audioStage && audioStage.cleanupRequired) artifactStore.cleanupStage(audioStage);
    if (assStage && assStage.cleanupRequired) artifactStore.cleanupStage(assStage);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

module.exports = { runNarratedRenderJob };
