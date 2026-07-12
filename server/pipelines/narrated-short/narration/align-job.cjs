const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { fasterWhisperConfig, fasterWhisperVersion, probeFasterWhisperRuntime, transcribeWithFasterWhisper } = require("../../../adapters/faster-whisper-adapter.cjs");
const { normalizeDraftBundle } = require("../contracts.cjs");
const { normalizeNarrationAsset } = require("./contract.cjs");
const { createAlignment } = require("./alignment.cjs");

function stale(field) {
  throw new AppError("NARRATION_ALIGNMENT_STALE", SAFE_MESSAGES.NARRATION_ALIGNMENT_STALE, 409, { field });
}

async function runNarrationAlignmentJob(context = {}) {
  const { jobs, job, project, payload = {}, dependencies = {} } = context;
  const content = dependencies.contentArtifactRepository;
  const approvals = dependencies.contentApprovalRepository;
  const projects = dependencies.projectRepository;
  const artifacts = dependencies.artifactRepository;
  const store = dependencies.artifactStore;
  if (!jobs || !job || !project || !content || !approvals || !projects || !artifacts || !store) throw new AppError("PIPELINE_HANDLER_UNAVAILABLE", "Narration alignment dependencies are unavailable.", 503);
  const active = project.input.activeNarration;
  if (!active) throw new AppError("NARRATION_ALIGNMENT_REQUIRED", SAFE_MESSAGES.NARRATION_ALIGNMENT_REQUIRED, 409);
  if (project.input.revision !== payload.projectRevision || active.projectRevision !== payload.projectRevision) stale("projectRevision");
  const expected = {
    manifestArtifactId: payload.narrationManifestArtifactId, manifestHash: payload.narrationManifestHash,
    audioArtifactId: payload.audioArtifactId, audioHash: payload.audioHash, draftArtifactId: payload.approvedDraftArtifactId,
    draftHash: payload.approvedDraftHash, scriptHash: payload.scriptHash,
  };
  for (const [field, value] of Object.entries(expected)) if (active[field] !== value) stale(field);
  const approval = approvals.findApproved(project.id, project.input.revision);
  if (!approval || approval.draftArtifactId !== payload.approvedDraftArtifactId || approval.draftHash !== payload.approvedDraftHash) stale("approval");
  const draftEnvelope = content.readJson(payload.approvedDraftArtifactId);
  const narrationEnvelope = content.readJson(payload.narrationManifestArtifactId);
  if (draftEnvelope.artifactType !== "approval_bundle" || narrationEnvelope.artifactType !== "narration_manifest" || draftEnvelope.projectId !== project.id || narrationEnvelope.projectId !== project.id || draftEnvelope.contentHash !== payload.approvedDraftHash || narrationEnvelope.contentHash !== payload.narrationManifestHash) stale("artifact");
  const draft = normalizeDraftBundle(draftEnvelope.body);
  const narration = normalizeNarrationAsset(narrationEnvelope.body);
  if (draft.script.contentHash !== payload.scriptHash || narration.audioHash !== payload.audioHash) stale("hash");
  const audio = artifacts.get(payload.audioArtifactId);
  if (!audio || audio.ownerProjectId !== project.id || audio.type !== "narration_audio" || audio.checksumSha256 !== payload.audioHash || audio.status !== "available") stale("audioArtifactId");
  const config = fasterWhisperConfig(dependencies.alignerEnv || process.env);
  if (payload.alignerVersion !== fasterWhisperVersion(dependencies.alignerEnv || process.env)) stale("alignerVersion");
  if (!dependencies.alignNarration) {
    const runtime = (dependencies.probeAlignerRuntime || probeFasterWhisperRuntime)(dependencies.alignerEnv || process.env);
    if (!runtime.available) throw new AppError("NARRATION_ALIGNER_UNAVAILABLE", SAFE_MESSAGES.NARRATION_ALIGNER_UNAVAILABLE, 409);
  }
  const stage = store.stageInputForProcessing(audio, { step: "align_narration" });
  try {
    jobs.update(job, { progress: 20, step: "align_narration" });
    let providerResult;
    try {
      providerResult = await (dependencies.alignNarration || transcribeWithFasterWhisper)({ audioPath: stage.localPath, language: payload.language, env: dependencies.alignerEnv || process.env, signal: job._controller && job._controller.signal });
    } catch (error) {
      if (error && error.code === "JOB_CANCELLED") throw error;
      if (error && error.code === "TRANSCRIPTION_TIMEOUT") throw error;
      throw new AppError("NARRATION_ALIGNMENT_FAILED", SAFE_MESSAGES.NARRATION_ALIGNMENT_FAILED, 409);
    }
    const alignment = createAlignment({ project, draft, narration, narrationSummary: active, providerResult, provider: { model: config.model, device: config.device, computeType: config.computeType } });
    jobs.update(job, { progress: 75, step: "persist_alignment" });
    const artifact = content.createJson({ type: "narration_alignment", projectId: project.id, jobId: job.id, revision: project.input.revision, dependencyHashes: [payload.approvedDraftHash, payload.scriptHash, payload.narrationManifestHash, payload.audioHash], body: alignment });
    const summary = { ...active, status: "aligned", alignmentArtifactId: artifact.artifact.id, alignmentHash: artifact.envelope.contentHash, aligned: true, timingReady: true, renderReady: false };
    const updated = projects.update(project.id, { input: { ...project.input, activeNarration: summary } });
    if (dependencies.persistenceAdapter && typeof dependencies.persistenceAdapter.persistProject === "function") dependencies.persistenceAdapter.persistProject({ project: updated });
    jobs.complete(job, { step: "narration_aligned", narrationAlignment: { artifactId: artifact.artifact.id, contentHash: artifact.envelope.contentHash, durationFrames: alignment.durationFrames, wordCount: alignment.words.length, exactSequenceMatch: true } });
    return { artifact, alignment, project: updated };
  } finally {
    if (stage.cleanupRequired) store.cleanupStage(stage);
  }
}

module.exports = { runNarrationAlignmentJob };
