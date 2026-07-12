const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");

const DATA_DIR = mkdtempSync(join(tmpdir(), "narrated-render-job-"));
process.env.MATCHCUTS_DATA_DIR = DATA_DIR;

const { ensureDataDirs } = require("../server/config.cjs");
ensureDataDirs();
const { LocalArtifactAdapter } = require("../server/adapters/local-artifact-adapter.cjs");
const { InMemoryArtifactRepository } = require("../server/repositories/artifact-repository.cjs");
const { ContentArtifactRepository } = require("../server/repositories/content-artifact-repository.cjs");
const { ContentApprovalRepository } = require("../server/repositories/content-approval-repository.cjs");
const { InMemoryProjectRepository } = require("../server/repositories/project-repository.cjs");
const { InMemoryExportRepository } = require("../server/repositories/export-repository.cjs");
const { JobStore } = require("../server/jobs.cjs");
const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { runNarratedRenderJob } = require("../server/pipelines/narrated-short/render-job.cjs");

test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

test("narrated render job enforces approval and persists preview artifacts", async () => {
  const artifactStore = new LocalArtifactAdapter();
  const artifactRepository = new InMemoryArtifactRepository({ persist: false });
  const contentArtifactRepository = new ContentArtifactRepository({ artifactStore, artifactRepository });
  const contentApprovalRepository = new ContentApprovalRepository({ persist: false });
  const projectRepository = new InMemoryProjectRepository();
  const exportRepository = new InMemoryExportRepository({ artifactStore });
  const jobs = new JobStore({ persist: false, logger: null });
  const projectId = `prj_${randomUUID()}`;
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(resolve(__dirname, "..", "eval", "narrated", "fixtures", "001_overload_explainer.json"), "utf8")));
  const draftArtifact = contentArtifactRepository.createJson({ type: "approval_bundle", projectId, revision: 1, body: draft });
  const project = projectRepository.create({
    id: projectId,
    projectType: "narrated_short",
    title: draft.script.title,
    language: "en",
    status: "awaiting_approval",
    input: {
      type: "content_brief",
      briefArtifactId: draftArtifact.artifact.id,
      claimLedgerArtifactId: draftArtifact.artifact.id,
      scriptArtifactId: draftArtifact.artifact.id,
      storyboardArtifactId: draftArtifact.artifact.id,
      revision: 1,
    },
  });
  contentApprovalRepository.approve({
    projectId,
    projectRevision: 1,
    draftArtifactId: draftArtifact.artifact.id,
    draftHash: draftArtifact.envelope.contentHash,
    renderProfile: "preview",
  });
  const job = jobs.create({
    projectId,
    action: "render_narrated_short",
    pipelineType: "narrated_short",
    payload: {
      projectRevision: 1,
      language: "en",
      approvedDraftArtifactId: draftArtifact.artifact.id,
      approvedDraftHash: draftArtifact.envelope.contentHash,
      renderProfile: "preview",
    },
  });
  jobs.claimJob(job.id, { workerId: `wrk_${randomUUID()}` });

  await runNarratedRenderJob({
    jobs,
    job,
    project,
    payload: job.payload,
    exportRepository,
    dependencies: {
      artifactStore,
      artifactRepository,
      contentArtifactRepository,
      contentApprovalRepository,
      projectRepository,
      renderNarratedKeyframes: async ({ timelinePath, outputDir }) => {
        const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
        return {
          timelineHash: timeline.contentHash,
          frames: [{ globalFrame: 0, fileName: "frame.png", outputPath: join(outputDir, "frame.png") }],
        };
      },
      composeNarratedPreview: async ({ timeline, outputPath, renderProfile }) => {
        writeFileSync(outputPath, Buffer.from("fake-mp4"));
        return {
          schemaVersion: 1,
          outputPath,
          width: timeline.width,
          height: timeline.height,
          fps: timeline.fps,
          totalFrames: timeline.totalFrames,
          durationSeconds: timeline.totalFrames / timeline.fps,
          audioIncluded: false,
          renderProfile,
          timelineHash: timeline.contentHash,
          keyframeCount: 1,
        };
      },
    },
  });

  assert.equal(job.status, "completed");
  assert.equal(projectRepository.get(projectId).status, "ready");
  assert.match(job.exportId, /^exp_/);
  assert.equal(job.narratedRender.silentPreview, true);
  assert.ok(contentArtifactRepository.readJson(job.narratedRender.manifestArtifactId));
  assert.ok(exportRepository.get(job.exportId));
});

function createDarkRenderContext(renderProfile) {
  const artifactStore = new LocalArtifactAdapter();
  const artifactRepository = new InMemoryArtifactRepository({ persist: false });
  const contentArtifactRepository = new ContentArtifactRepository({ artifactStore, artifactRepository });
  const contentApprovalRepository = new ContentApprovalRepository({ persist: false });
  const projectRepository = new InMemoryProjectRepository();
  const exportRepository = new InMemoryExportRepository({ artifactStore });
  const jobs = new JobStore({ persist: false, logger: null });
  const projectId = `prj_${randomUUID()}`;
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(
    resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json"),
    "utf8",
  )));
  const draftArtifact = contentArtifactRepository.createJson({ type: "approval_bundle", projectId, revision: 1, body: draft });
  const project = projectRepository.create({
    id: projectId,
    projectType: "narrated_short",
    title: draft.script.title,
    language: "en",
    status: "awaiting_approval",
    input: {
      type: "content_brief",
      briefArtifactId: draftArtifact.artifact.id,
      claimLedgerArtifactId: draftArtifact.artifact.id,
      scriptArtifactId: draftArtifact.artifact.id,
      storyboardArtifactId: draftArtifact.artifact.id,
      revision: 1,
      activeNarration: {
        status: "uploaded_unaligned",
        projectRevision: 1,
        manifestArtifactId: `art_${"c".repeat(40)}`,
        manifestHash: "c".repeat(64),
        audioArtifactId: `art_${"d".repeat(40)}`,
        audioHash: "d".repeat(64),
        draftArtifactId: draftArtifact.artifact.id,
        draftHash: draftArtifact.envelope.contentHash,
        scriptHash: draft.script.contentHash,
        voiceProfileId: "operator_voice_01",
        language: "en",
        media: { container: "wav", codec: "pcm_s16le", sampleRate: 48000, channels: 1, durationSeconds: 32, bytes: 3072000 },
        rights: { commercialUseAllowed: true, ownershipBasis: "self_recorded", consentDeclared: true, licenseDeclared: false },
        aligned: false,
        renderReady: false,
      },
    },
  });
  contentApprovalRepository.approve({
    projectId,
    projectRevision: 1,
    draftArtifactId: draftArtifact.artifact.id,
    draftHash: draftArtifact.envelope.contentHash,
    renderProfile,
  });
  const job = jobs.create({
    projectId,
    action: "render_narrated_short",
    pipelineType: "narrated_short",
    payload: {
      projectRevision: 1,
      language: "en",
      approvedDraftArtifactId: draftArtifact.artifact.id,
      approvedDraftHash: draftArtifact.envelope.contentHash,
      renderProfile,
    },
  });
  jobs.claimJob(job.id, { workerId: `wrk_${randomUUID()}` });
  return {
    jobs,
    job,
    project,
    exportRepository,
    dependencies: {
      artifactStore,
      artifactRepository,
      contentArtifactRepository,
      contentApprovalRepository,
      projectRepository,
      renderNarratedKeyframes: async ({ timelinePath, outputDir }) => {
        const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
        assert.ok(timeline.tracks.some((track) => track.type === "visual_scene"));
        return {
          timelineHash: timeline.contentHash,
          frames: [{ globalFrame: 0, fileName: "frame.png", outputPath: join(outputDir, "frame.png") }],
        };
      },
      composeNarratedPreview: async ({ timeline, outputPath, renderProfile: profile }) => {
        writeFileSync(outputPath, Buffer.from("fake-dark-preview"));
        return {
          schemaVersion: 1,
          outputPath,
          width: timeline.width,
          height: timeline.height,
          fps: timeline.fps,
          totalFrames: timeline.totalFrames,
          durationSeconds: timeline.totalFrames / timeline.fps,
          audioIncluded: false,
          renderProfile: profile,
          timelineHash: timeline.contentHash,
          keyframeCount: 1,
        };
      },
    },
  };
}

test("Dark Curiosity render job persists a non-publishable silent 720x1280 preview", async () => {
  const context = createDarkRenderContext("preview");
  await runNarratedRenderJob({ ...context, payload: context.job.payload });

  assert.equal(context.job.status, "completed");
  assert.equal(context.job.narratedRender.silentPreview, true);
  assert.equal(context.job.narratedRender.previewOnly, true);
  assert.equal(context.job.narratedRender.publishable, false);
  assert.equal(context.job.narratedRender.narrationStatus, "uploaded_unaligned");
  assert.equal(context.job.narratedRender.narrationUsed, false);
  assert.equal(context.job.narratedRender.narrationTimingUsed, false);
  assert.equal(context.job.narratedRender.audioIncluded, false);
  assert.equal(context.job.narratedRender.timingMode, "estimated_silent");
  const publicJob = context.jobs.publicJob(context.job);
  assert.equal(publicJob.narratedRender.previewOnly, true);
  assert.equal(publicJob.narratedRender.publishable, false);
  assert.equal(publicJob.outputPath, undefined);
  const manifest = context.dependencies.contentArtifactRepository.readJson(context.job.narratedRender.manifestArtifactId);
  assert.equal(manifest.body.width, 720);
  assert.equal(manifest.body.height, 1280);
  assert.equal(manifest.body.previewOnly, true);
  assert.equal(manifest.body.publishable, false);
  assert.equal(manifest.body.narrationStatus, "uploaded_unaligned");
  assert.equal(manifest.body.narrationUsed, false);
});

test("Dark Curiosity render job rejects final output before invoking a renderer", async () => {
  const context = createDarkRenderContext("final");
  let rendererInvoked = false;
  context.dependencies.renderNarratedKeyframes = async () => {
    rendererInvoked = true;
    throw new Error("renderer should not be invoked");
  };

  await assert.rejects(
    () => runNarratedRenderJob({ ...context, payload: context.job.payload }),
    (error) => error.code === "NARRATION_ALIGNMENT_REQUIRED" && error.status === 409,
  );
  assert.equal(rendererInvoked, false);
});
