const { AppError, SAFE_MESSAGES } = require("../../errors.cjs");
const { normalizeDraftBundle } = require("./contracts.cjs");

function assertArtifactEnvelope(envelope, expected = {}) {
  if (!envelope || envelope.artifactType !== expected.type) {
    throw new AppError("ARTIFACT_CONTENT_INVALID", `Expected ${expected.type} content artifact.`, 409);
  }
  if (envelope.projectId !== expected.projectId || envelope.revision !== expected.revision) {
    throw new AppError("ARTIFACT_CONTENT_INVALID", "Content artifact revision or ownership does not match the project.", 409);
  }
  return envelope;
}

async function runNarratedDraftJob(context = {}) {
  const { jobs, job, project, payload = {}, dependencies = {} } = context;
  const contentArtifacts = dependencies.contentArtifactRepository;
  const projectRepository = dependencies.projectRepository;
  if (!jobs || !job || !project || !contentArtifacts || !projectRepository) {
    throw new AppError("PIPELINE_HANDLER_UNAVAILABLE", "Narrated draft dependencies are unavailable.", 503);
  }
  if (project.projectType !== "narrated_short") {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "projectType" });
  }
  if (payload.providerMode !== "manual") {
    throw new AppError("SCRIPT_PROVIDER_UNAVAILABLE", "The structured script provider is not configured.", 503);
  }
  for (const field of ["briefArtifactId", "claimLedgerArtifactId", "scriptArtifactId", "storyboardArtifactId"]) {
    if (!payload[field]) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field });
  }
  const revision = Number(payload.projectRevision);
  if (project.input.revision !== revision) {
    throw new AppError("PROJECT_REVISION_STALE", "The narrated project revision has changed.", 409);
  }

  jobs.update(job, { progress: 10, step: "validate_brief" });
  const brief = assertArtifactEnvelope(contentArtifacts.readJson(payload.briefArtifactId), {
    type: "content_brief", projectId: project.id, revision,
  });
  jobs.update(job, { progress: 25, step: "validate_claim_ledger" });
  const claimLedger = assertArtifactEnvelope(contentArtifacts.readJson(payload.claimLedgerArtifactId), {
    type: "claim_ledger", projectId: project.id, revision,
  });
  jobs.update(job, { progress: 45, step: "validate_script" });
  const script = assertArtifactEnvelope(contentArtifacts.readJson(payload.scriptArtifactId), {
    type: "narrative_script", projectId: project.id, revision,
  });
  jobs.update(job, { progress: 65, step: "validate_storyboard" });
  const storyboard = assertArtifactEnvelope(contentArtifacts.readJson(payload.storyboardArtifactId), {
    type: "storyboard", projectId: project.id, revision,
  });

  const draftBundle = normalizeDraftBundle({
    brief: brief.body,
    claimLedger: claimLedger.body,
    script: script.body,
    storyboard: storyboard.body,
  });
  jobs.update(job, { progress: 85, step: "write_draft_artifacts" });
  const approvalBundle = contentArtifacts.createJson({
    type: "approval_bundle",
    projectId: project.id,
    jobId: job.id,
    revision,
    dependencyHashes: [brief.contentHash, claimLedger.contentHash, script.contentHash, storyboard.contentHash],
    body: draftBundle,
  });
  const updatedProject = projectRepository.update(project.id, { status: "awaiting_approval" });
  if (dependencies.persistenceAdapter && typeof dependencies.persistenceAdapter.persistProject === "function") {
    dependencies.persistenceAdapter.persistProject({ project: updatedProject });
  }
  jobs.complete(job, {
    step: "draft_ready_for_approval",
    contentDraft: {
      artifactId: approvalBundle.artifact.id,
      contentHash: approvalBundle.envelope.contentHash,
      projectRevision: revision,
      formatId: draftBundle.brief.formatId,
      sceneCount: draftBundle.storyboard.scenes.length,
      beatCount: draftBundle.script.beats.length,
      approvalRequired: true,
    },
  });
  return approvalBundle;
}

module.exports = {
  runNarratedDraftJob,
};
