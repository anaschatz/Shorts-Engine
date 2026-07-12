const { existsSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { createHash } = require("node:crypto");
const { createDefaultAdapters } = require("../../../adapters/local-persistence-adapter.cjs");
const { fasterWhisperVersion } = require("../../../adapters/faster-whisper-adapter.cjs");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { JobStore, idempotencyKey } = require("../../../jobs.cjs");
const { ContentArtifactRepository } = require("../../../repositories/content-artifact-repository.cjs");
const { ContentApprovalRepository } = require("../../../repositories/content-approval-repository.cjs");
const { PublishApprovalRepository } = require("../../../repositories/publish-approval-repository.cjs");
const { runNarratedDraftJob } = require("../draft-job.cjs");
const { runNarrationAlignmentJob } = require("../narration/align-job.cjs");
const { ingestUploadedNarration } = require("../narration/upload.cjs");
const { runNarratedRenderJob } = require("../render-job.cjs");
const { createPublishApproval, verifyReleaseEligibility } = require("../publish/service.cjs");
const { revokeFailedReleaseProof } = require("./release-proof.cjs");
const { CAPTION_RENDERER_VERSION, CAPTION_PROFILE_VERSION } = require("../captions/contract.cjs");
const { AUDIO_PROFILE_VERSION } = require("../audio-normalization.cjs");
const { NARRATED_COMPOSITOR_VERSION } = require("../video-compositor.cjs");
const { QA_PROFILE_VERSION } = require("../qa/contract.cjs");
const { EVIDENCE_PROFILE_VERSION } = require("../evidence/contract.cjs");

function deterministicUuid(hash) { const chars = hash.slice(0, 32).split(""); chars[12] = "4"; chars[16] = ["8", "9", "a", "b"][parseInt(chars[16], 16) % 4]; const value = chars.join(""); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`; }
function startJob(jobs, input) { const job = jobs.create(input); if (job.status === "queued") jobs.update(job, { status: "processing", progress: 1, step: "pilot_dispatch" }); return job; }
function ref(artifactId, hash) { return artifactId && hash ? { artifactId, hash } : null; }

function renderPayload(project, approval, profile) {
  const active = project.input.activeNarration;
  return { projectRevision: project.input.revision, language: project.language, approvedDraftArtifactId: approval.draftArtifactId, approvedDraftHash: approval.draftHash, renderProfile: profile, narrationManifestHash: active && active.manifestHash, audioHash: active && active.audioHash, alignmentHash: active && active.alignmentHash, captionRendererVersion: CAPTION_RENDERER_VERSION, captionProfileVersion: CAPTION_PROFILE_VERSION, audioNormalizationProfileVersion: AUDIO_PROFILE_VERSION, compositorVersion: NARRATED_COMPOSITOR_VERSION, qaProfileVersion: QA_PROFILE_VERSION, evidenceProfileVersion: EVIDENCE_PROFILE_VERSION };
}

function createLocalPilotRuntime(options = {}, overrides = {}) {
  const adapters = overrides.adapters || createDefaultAdapters(); const { artifactAdapter, persistenceAdapter } = adapters;
  if (typeof persistenceAdapter.restoreState === "function") persistenceAdapter.restoreState();
  const projects = persistenceAdapter.projectRepository; const artifacts = persistenceAdapter.artifactRepository; const exports = persistenceAdapter.exportRepository;
  const content = new ContentArtifactRepository({ artifactStore: artifactAdapter, artifactRepository: artifacts });
  const approvals = overrides.approvals || new ContentApprovalRepository(); approvals.recover();
  const publishApprovals = overrides.publishApprovals || new PublishApprovalRepository(); publishApprovals.recover();
  const jobs = overrides.jobs || new JobStore({ persist: false });
  const deps = { artifactStore: artifactAdapter, artifactRepository: artifacts, contentArtifactRepository: content, contentApprovalRepository: approvals, projectRepository: projects, persistenceAdapter, ...overrides.dependencies };

  async function executeRender(context, profile) {
    const project = projects.get(context.projectId); const approval = approvals.findApproved(project.id, project.input.revision); if (!approval) throw new AppError("ACTIVE_APPROVAL_REQUIRED", SAFE_MESSAGES.ACTIVE_APPROVAL_REQUIRED, 409);
    const payload = renderPayload(project, approval, profile); const job = startJob(jobs, { projectId: project.id, ownerId: options.operatorId, action: "render_narrated_short", pipelineType: "narrated_short", idempotencyKey: idempotencyKey(`pilot_${profile}`, { runId: context.runId, ...payload }), payload });
    const result = await runNarratedRenderJob({ jobs, job, project, payload: job.payload, dependencies: deps, exportRepository: exports });
    return { job, result };
  }

  return {
    operatorBindings(report) { const approval = report.projectId ? approvals.findApproved(report.projectId, report.projectRevision) : null; return { contentApprovalId: approval ? approval.approvalId : null }; },
    async executeStage(stage, context) {
      if (context.signal && context.signal.aborted) throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
      if (stage === "project_created") {
        const projectId = `prj_${deterministicUuid(createHash("sha256").update(context.runId).digest("hex"))}`; const revision = 1;
        let project = projects.get(projectId);
        if (!project) {
          const create = (type, body, hashes = []) => content.createJson({ type, projectId, revision, dependencyHashes: hashes, body });
          const brief = create("content_brief", context.fixture.brief); const claims = create("claim_ledger", context.fixture.claimLedger, [brief.envelope.contentHash]); const script = create("narrative_script", context.fixture.script, [brief.envelope.contentHash, claims.envelope.contentHash]); const storyboard = create("storyboard", context.fixture.storyboard, [script.envelope.contentHash]);
          project = persistenceAdapter.persistProject({ project: { id: projectId, projectType: "narrated_short", title: context.fixture.script.title, language: context.fixture.brief.language, ownerId: options.operatorId, status: "draft", input: { type: "content_brief", revision, briefArtifactId: brief.artifact.id, claimLedgerArtifactId: claims.artifact.id, scriptArtifactId: script.artifact.id, storyboardArtifactId: storyboard.artifact.id } } });
        }
        if (project.input.revision !== 1) throw new AppError("PILOT_CHECKPOINT_INVALID", SAFE_MESSAGES.PILOT_CHECKPOINT_INVALID, 409);
        const expected = [["briefArtifactId", "content_brief", context.fixture.brief.contentHash], ["claimLedgerArtifactId", "claim_ledger", context.fixture.claimLedger.contentHash], ["scriptArtifactId", "narrative_script", context.fixture.script.contentHash], ["storyboardArtifactId", "storyboard", context.fixture.storyboard.contentHash]];
        for (const [pointer, type, hash] of expected) { const envelope = content.readJson(project.input[pointer]); if (envelope.artifactType !== type || envelope.projectId !== project.id || envelope.revision !== 1 || envelope.contentHash !== hash) throw new AppError("PILOT_CHECKPOINT_INVALID", SAFE_MESSAGES.PILOT_CHECKPOINT_INVALID, 409); }
        return { context: { projectId, projectRevision: 1 } };
      }
      if (stage === "draft_ready") {
        const project = projects.get(context.projectId); const payload = { projectRevision: project.input.revision, language: project.language, providerMode: "manual", briefArtifactId: project.input.briefArtifactId, claimLedgerArtifactId: project.input.claimLedgerArtifactId, scriptArtifactId: project.input.scriptArtifactId, storyboardArtifactId: project.input.storyboardArtifactId };
        const job = startJob(jobs, { projectId: project.id, ownerId: options.operatorId, action: "draft_narrated_short", pipelineType: "narrated_short", idempotencyKey: idempotencyKey("pilot_draft", { runId: context.runId, ...payload }), payload });
        const bundle = await runNarratedDraftJob({ jobs, job, project, payload: job.payload, dependencies: deps });
        return { context: { draftArtifactId: bundle.artifact.id, draftHash: bundle.envelope.contentHash }, evidence: { approvedDraft: ref(bundle.artifact.id, bundle.envelope.contentHash) } };
      }
      if (stage === "content_approved") {
        approvals.approve({ projectId: context.projectId, projectRevision: context.projectRevision, draftArtifactId: context.draftArtifactId, draftHash: context.draftHash, voiceProfileId: "voice_operator_v1", renderProfile: "final", operatorNote: "Dark Curiosity pilot approval" }); return {};
      }
      if (stage === "narration_uploaded") {
        const project = projects.get(context.projectId); let ttsProvenance = null;
        const sidecar = join(dirname(options.audioPath), "narration.provenance.json");
        if (existsSync(sidecar)) {
          const { verifyTtsNarration } = require("../narration/tts/service.cjs");
          ttsProvenance = (await verifyTtsNarration({ projectDir: dirname(options.audioPath), fixture: options.fixturePath })).manifest;
        }
        const rightsFields = ttsProvenance ? { ownershipBasis: "ai_generated_licensed", rightsHolder: options.operatorId, consentReference: ttsProvenance.license.attestedBy, licenseReference: ttsProvenance.license.termsReference, ttsProvenance } : { ownershipBasis: "self_recorded", rightsHolder: options.operatorId, consentReference: `pilot-${context.runId.slice(-12)}`, licenseReference: null };
        const uploaded = await ingestUploadedNarration({ project, fields: { draftArtifactId: context.draftArtifactId, draftHash: context.draftHash, scriptHash: context.fixture.script.contentHash, projectRevision: context.projectRevision, voiceProfileId: ttsProvenance ? `tts_${ttsProvenance.provider}_${ttsProvenance.voiceId}` : "voice_operator_v1", language: project.language, commercialUseAllowed: true, ...rightsFields }, file: { fileName: "authorized-narration.wav", buffer: readFileSync(options.audioPath) } }, deps);
        return { evidence: { narrationManifest: ref(uploaded.manifestArtifact.artifact.id, uploaded.manifestArtifact.envelope.contentHash), narrationAudio: ref(uploaded.audioArtifact.id, uploaded.audioArtifact.checksumSha256) } };
      }
      if (stage === "narration_aligned") {
        const project = projects.get(context.projectId); const active = project.input.activeNarration; const payload = { projectRevision: project.input.revision, language: project.language, approvedDraftArtifactId: context.draftArtifactId, approvedDraftHash: context.draftHash, narrationManifestArtifactId: active.manifestArtifactId, narrationManifestHash: active.manifestHash, audioArtifactId: active.audioArtifactId, audioHash: active.audioHash, scriptHash: active.scriptHash, alignerVersion: fasterWhisperVersion(process.env) };
        const job = startJob(jobs, { projectId: project.id, ownerId: options.operatorId, action: "align_narration", pipelineType: "narrated_short", idempotencyKey: idempotencyKey("pilot_align", { runId: context.runId, ...payload }), payload }); const aligned = await runNarrationAlignmentJob({ jobs, job, project, payload: job.payload, dependencies: deps });
        return { evidence: { narrationAlignment: ref(aligned.artifact.artifact.id, aligned.artifact.envelope.contentHash) } };
      }
      if (stage === "preview_ready") {
        const { job, result } = await executeRender(context, "preview"); context.previewResult = result; return { evidence: { preview: { jobId: job.id, exportArtifactId: result.committedArtifact.id, outputHash: result.committedArtifact.checksumSha256, status: "completed" } } };
      }
      if (stage === "technical_final_staged") { const { job, result } = await executeRender(context, "final"); context.finalJob = job; context.finalResult = result; return {}; }
      if (stage === "technical_qa_passed") {
        const qa = context.finalJob && context.finalJob.technicalQa; if (!qa || qa.qaPassed !== true) throw new AppError("QA_BLOCKED", "Technical QA blocked this output.", 409); return { evidence: { qa: { report: ref(qa.qaReportArtifactId, qa.qaReportHash), blockingGateCount: qa.blockingGateCount, blockingPassedCount: qa.blockingPassedCount, blockingFailedCount: qa.blockingFailedCount, warningCount: qa.warningCount } } };
      }
      if (stage === "evidence_packaged") {
        const pack = context.finalJob && context.finalJob.evidencePackage; if (!pack || pack.packageStatus !== "complete") throw new AppError("TECHNICAL_EXPORT_BLOCKED", "The technical evidence package is incomplete.", 409); return { evidence: { contactSheet: ref(pack.contactSheetArtifactId, pack.contactSheetHash), rightsManifest: ref(pack.rightsManifestArtifactId, pack.rightsManifestHash), provenanceReport: ref(pack.provenanceReportArtifactId, pack.provenanceReportHash), exportMetadata: ref(pack.exportMetadataArtifactId, pack.exportMetadataHash) } };
      }
      if (stage === "technical_final_committed") { const result = context.finalResult; if (!result || !artifacts.get(result.committedArtifact.id) || !exports.get(result.exportId)) throw new AppError("TECHNICAL_EXPORT_BLOCKED", "The technical final was not committed.", 409); return { evidence: { final: { jobId: context.finalJob.id, exportArtifactId: result.committedArtifact.id, outputHash: result.committedArtifact.checksumSha256, status: "completed" } } };
      }
      if (stage === "pilot_complete") return {};
      throw new AppError("PILOT_STATE_INVALID", SAFE_MESSAGES.PILOT_STATE_INVALID, 409, { stage });
    },
    verifyCompletedReport(report) {
      const artifact = report.final && artifacts.get(report.final.exportArtifactId); const project = report.projectId && projects.get(report.projectId);
      if (!artifact || artifact.status !== "available" || artifact.checksumSha256 !== report.final.outputHash || !project || project.input.revision !== report.projectRevision) return false;
      const typed = [[report.approvedDraft, "approval_bundle"], [report.narrationManifest, "narration_manifest"], [report.narrationAlignment, "narration_alignment"], [report.qa && report.qa.report, "qa_report"], [report.rightsManifest, "rights_manifest"], [report.provenanceReport, "provenance_report"], [report.exportMetadata, "export_metadata"]];
      try { for (const [reference, type] of typed) { const envelope = content.readJson(reference.artifactId); if (envelope.artifactType !== type || envelope.projectId !== project.id || envelope.revision !== project.input.revision || envelope.contentHash !== reference.hash) return false; } } catch { return false; }
      const audio = artifacts.get(report.narrationAudio.artifactId); const contact = artifacts.get(report.contactSheet.artifactId);
      return Boolean(audio && audio.ownerProjectId === project.id && audio.checksumSha256 === report.narrationAudio.hash && contact && contact.ownerProjectId === project.id && contact.checksumSha256 === report.contactSheet.hash);
    },
    createReleaseProof(report) {
      if (!this.verifyCompletedReport(report)) throw new AppError("PILOT_CHECKPOINT_INVALID", SAFE_MESSAGES.PILOT_CHECKPOINT_INVALID, 409);
      const project = projects.get(report.projectId); let created = null;
      try {
        created = createPublishApproval({ project, operatorId: options.operatorId, request: { expectedRevision: report.projectRevision, finalOutputHash: report.final.outputHash, qaReportArtifactId: report.qa.report.artifactId, qaReportHash: report.qa.report.hash, exportMetadataArtifactId: report.exportMetadata.artifactId, exportMetadataHash: report.exportMetadata.hash, operatorDecision: "approve", warningAcknowledgements: [], operatorNote: "Explicit Dark Curiosity operator release proof", idempotencyKey: `pilot-release-${report.runId}` } }, { publishApprovalRepository: publishApprovals, contentArtifactRepository: content, contentApprovalRepository: approvals, artifactRepository: artifacts, exportRepository: exports });
        if (!created.releaseToken) throw new AppError("RELEASE_TOKEN_INVALID", SAFE_MESSAGES.RELEASE_TOKEN_INVALID, 403);
        const eligibility = verifyReleaseEligibility({ project, request: { releaseToken: created.releaseToken, outputHash: report.final.outputHash } }, { publishApprovalRepository: publishApprovals, contentApprovalRepository: approvals, artifactRepository: artifacts });
        const exportRecord = exports.all().find((value) => value.projectId === project.id && value.artifact && value.artifact.id === eligibility.artifact.id && value.status === "completed");
        if (!exportRecord) throw new AppError("FINAL_DOWNLOAD_BLOCKED", SAFE_MESSAGES.FINAL_DOWNLOAD_BLOCKED, 409);
        const remaining = Math.max(1, Math.floor((Date.parse(eligibility.expiresAt) - Date.now()) / 1000)); const job = jobs.get(exportRecord.jobId);
        const signed = persistenceAdapter.createSignedExportDownload(exportRecord, { job, basePath: "/api/artifacts/download", ttlSeconds: Math.min(300, remaining) });
        if (options.downloadProof) { const outputPath = persistenceAdapter.resolveExportOutputPath(exportRecord); if (createHash("sha256").update(readFileSync(outputPath)).digest("hex") !== report.final.outputHash) throw new AppError("OUTPUT_HASH_MISMATCH", SAFE_MESSAGES.OUTPUT_HASH_MISMATCH, 409); }
        return { contentApprovalId: created.record.body.contentApprovalId, publishApprovalId: created.approval.publishApprovalId, approvalArtifactId: created.approval.approvalArtifactId, approvalArtifactHash: created.approval.approvalArtifactHash, outputHash: eligibility.outputHash, tokenIssued: true, tokenVerified: true, releaseExpiresAt: eligibility.expiresAt, guardedDownloadIssued: Boolean(signed && signed.downloadUrl), downloadExpiresAt: signed.expiresAt, downloadVerified: options.downloadProof === true };
      } catch (error) { revokeFailedReleaseProof(created, publishApprovals, project); throw error; }
    },
  };
}

module.exports = { createLocalPilotRuntime, deterministicUuid, renderPayload };
