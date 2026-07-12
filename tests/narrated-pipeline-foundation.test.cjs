const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { createLocalJobWorker } = require("../server/job-worker.cjs");
const { JobStore } = require("../server/jobs.cjs");
const { createLocalJobQueue } = require("../server/queue/local-job-queue.cjs");
const { InMemoryProjectRepository, normalizeProject } = require("../server/repositories/project-repository.cjs");

const PROJECT_ID = "prj_11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "upl_22222222-2222-4222-8222-222222222222";
const BRIEF_ARTIFACT_ID = "art_33333333-3333-4333-8333-333333333333";
const DRAFT_ARTIFACT_ID = "art_44444444-4444-4444-8444-444444444444";
const DRAFT_HASH = "a".repeat(64);

test("Project v2 normalizes legacy clip projects without changing their upload contract", () => {
  const project = normalizeProject({
    id: PROJECT_ID,
    uploadId: UPLOAD_ID,
    title: "Legacy clip",
    status: "draft",
  });

  assert.equal(project.schemaVersion, 2);
  assert.equal(project.projectType, "clip");
  assert.equal(project.uploadId, UPLOAD_ID);
  assert.deepEqual(project.input, { type: "upload", uploadId: UPLOAD_ID });
});

test("Project v2 supports narrated projects without fake uploads", () => {
  const repository = new InMemoryProjectRepository();
  const project = repository.create({
    id: PROJECT_ID,
    projectType: "narrated_short",
    title: "Overload explainer",
    language: "en",
    input: { type: "content_brief", briefArtifactId: BRIEF_ARTIFACT_ID, revision: 1 },
    status: "awaiting_approval",
  });

  assert.equal(project.uploadId, null);
  assert.equal(project.projectType, "narrated_short");
  assert.equal(project.input.briefArtifactId, BRIEF_ARTIFACT_ID);
  assert.equal(project.status, "awaiting_approval");
});

test("narrated job payload survives durable persistence and recovery", () => {
  const jobDir = mkdtempSync(join(tmpdir(), "narrated-jobs-"));
  try {
    const first = new JobStore({ persist: true, jobDir, logger: null });
    const job = first.create({
      projectId: PROJECT_ID,
      action: "render_narrated_short",
      pipelineType: "narrated_short",
      idempotencyKey: "narrated-render-foundation",
      payload: {
        projectRevision: 2,
        language: "en",
        approvedDraftArtifactId: DRAFT_ARTIFACT_ID,
        approvedDraftHash: DRAFT_HASH,
        renderProfile: "preview",
      },
    });
    const raw = JSON.parse(readFileSync(join(jobDir, `${job.id}.json`), "utf8"));
    assert.equal(raw.pipelineType, "narrated_short");
    assert.equal(raw.uploadId, null);
    assert.equal(raw.payload.approvedDraftArtifactId, DRAFT_ARTIFACT_ID);

    const second = new JobStore({ persist: true, jobDir, logger: null });
    assert.equal(second.recover().records, 1);
    const recovered = second.get(job.id);
    assert.equal(recovered.pipelineType, "narrated_short");
    assert.equal(recovered.payload.approvedDraftHash, DRAFT_HASH);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("worker dispatches narrated draft jobs without looking up an upload", async () => {
  const jobs = new JobStore();
  const queue = createLocalJobQueue({ jobs, logger: null });
  const projects = new InMemoryProjectRepository();
  const project = projects.create({
    id: PROJECT_ID,
    projectType: "narrated_short",
    title: "Overload explainer",
    language: "en",
    input: { type: "content_brief", briefArtifactId: BRIEF_ARTIFACT_ID, revision: 1 },
  });
  const job = jobs.create({
    projectId: project.id,
    action: "draft_narrated_short",
    pipelineType: "narrated_short",
    idempotencyKey: "narrated-draft-worker",
    payload: {
      projectRevision: 1,
      language: "en",
      briefArtifactId: BRIEF_ARTIFACT_ID,
    },
  });
  let observed = null;
  const worker = createLocalJobWorker({
    jobs,
    queue,
    projectRepository: projects,
    uploadRepository: { get() { throw new Error("upload lookup must not run"); } },
    exportRepository: { records: new Map() },
    dependencies: {
      logger: null,
      runNarratedDraftJob: async (context) => {
        observed = context;
        context.jobs.complete(context.job, { step: "draft_ready_for_approval" });
      },
    },
  });

  await worker.process(job, { requestId: "narrated_foundation" });

  assert.equal(job.status, "completed");
  assert.equal(job.step, "draft_ready_for_approval");
  assert.equal(observed.upload, null);
  assert.equal(observed.pipeline.pipelineType, "narrated_short");
  assert.equal(observed.payload.briefArtifactId, BRIEF_ARTIFACT_ID);
});

test("pipeline type and action mismatch fails closed", () => {
  const jobs = new JobStore();
  assert.throws(
    () => jobs.create({
      projectId: PROJECT_ID,
      uploadId: UPLOAD_ID,
      action: "generate",
      pipelineType: "narrated_short",
      idempotencyKey: "mismatched-pipeline",
      payload: {},
    }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});
