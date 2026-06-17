const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { approveRegenerationDraft, validateApprovalRequest } = require("../server/regeneration-approval.cjs");
const { createEditPlan, validateEditPlan } = require("../server/edit-plan.cjs");

function ids(suffix = "appr") {
  return {
    projectId: `prj_${suffix}${suffix}${suffix}${suffix}-${suffix}-4${suffix.slice(1)}-${suffix}-${suffix}${suffix}${suffix}`,
    uploadId: `upl_${suffix}${suffix}${suffix}${suffix}-${suffix}-4${suffix.slice(1)}-${suffix}-${suffix}${suffix}${suffix}`,
    sourceJobId: `job_${suffix}${suffix}${suffix}${suffix}-${suffix}-4${suffix.slice(1)}-${suffix}-${suffix}${suffix}${suffix}`,
    exportId: `exp_${suffix}${suffix}${suffix}${suffix}-${suffix}-4${suffix.slice(1)}-${suffix}-${suffix}${suffix}${suffix}`,
    regenerationPlanId: `regen_${suffix}${suffix}${suffix}${suffix}-${suffix}-4${suffix.slice(1)}-${suffix}-${suffix}${suffix}${suffix}`,
  };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createReviewWorkspace(suffix = "appr") {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-approval-"));
  const dataDir = join(rootDir, "data");
  const projectsDir = join(dataDir, "projects");
  const uploadsDir = join(dataDir, "uploads");
  const rendersDir = join(dataDir, "renders");
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(rendersDir, { recursive: true });
  const safeIds = ids(suffix);
  const uploadPath = join(uploadsDir, `${safeIds.uploadId}.mp4`);
  const renderPath = join(rendersDir, `${safeIds.sourceJobId}.mp4`);
  writeFileSync(uploadPath, Buffer.from("approval-source-video"));
  writeFileSync(renderPath, Buffer.from("approval-render-video"));
  const editPlan = validateEditPlan(
    createEditPlan({
      metadata: { durationSeconds: 16, width: 1920, height: 1080 },
      transcript: {
        captions: [
          { start: 0, end: 2, text: "The chance opens" },
          { start: 2, end: 4, text: "Pressure builds fast" },
        ],
      },
      preset: "hype",
      title: "Approval fixture",
    }),
    { durationSeconds: 16 },
  );
  editPlan.captions[0].text = "GOAL FROM NOWHERE";
  const project = {
    id: safeIds.projectId,
    uploadId: safeIds.uploadId,
    title: "Approval fixture",
    status: "ready",
  };
  writeJson(join(projectsDir, `${safeIds.projectId}.json`), {
    project,
    upload: {
      id: safeIds.uploadId,
      projectId: safeIds.projectId,
      path: uploadPath,
      metadata: { durationSeconds: 16, width: 1920, height: 1080 },
      byteSize: 21,
      extension: "mp4",
      artifact: {
        id: safeIds.uploadId,
        type: "upload",
        ownerProjectId: safeIds.projectId,
        status: "available",
        size: 21,
        contentType: "video/mp4",
        storageKey: `${safeIds.uploadId}.mp4`,
      },
    },
  });
  writeJson(join(projectsDir, `${safeIds.projectId}.render.json`), {
    project,
    job: {
      id: safeIds.sourceJobId,
      projectId: safeIds.projectId,
      uploadId: safeIds.uploadId,
      status: "completed",
      exportId: safeIds.exportId,
      payload: { language: "en", stylePreset: "social_sports_v1" },
    },
    exportId: safeIds.exportId,
    exportRecord: {
      id: safeIds.exportId,
      projectId: safeIds.projectId,
      jobId: safeIds.sourceJobId,
      outputPath: renderPath,
      fileName: `${safeIds.projectId}-short.mp4`,
      artifact: {
        id: safeIds.exportId,
        type: "export",
        ownerProjectId: safeIds.projectId,
        ownerJobId: safeIds.sourceJobId,
        status: "available",
        size: 21,
        contentType: "video/mp4",
        storageKey: `${safeIds.sourceJobId}.mp4`,
      },
    },
    highlights: [{
      start: editPlan.sourceStart,
      end: editPlan.sourceEnd,
      highlightType: "big_chance",
      reasonCodes: ["big_chance", "audio_energy_spike"],
      retentionScore: 88,
    }],
    editPlan,
  });
  return { rootDir, ids: safeIds, project };
}

function fakeQueue() {
  const jobsByKey = new Map();
  const created = [];
  return {
    created,
    create(record) {
      if (jobsByKey.has(record.idempotencyKey)) return jobsByKey.get(record.idempotencyKey);
      const job = {
        id: `job_approval_render_${String(created.length + 1).padStart(8, "0")}`,
        projectId: record.projectId,
        uploadId: record.uploadId,
        action: record.action,
        idempotencyKey: record.idempotencyKey,
        payload: record.payload,
        status: "queued",
        exportId: null,
      };
      created.push(job);
      jobsByKey.set(record.idempotencyKey, job);
      return job;
    },
    enqueue(job) {
      return job;
    },
    publicJob(job) {
      return JSON.parse(JSON.stringify(job));
    },
  };
}

test("approval request requires explicit approve and valid ids", () => {
  const safeIds = ids("apra");
  assert.throws(
    () => validateApprovalRequest({
      projectId: safeIds.projectId,
      sourceJobId: safeIds.sourceJobId,
      exportId: safeIds.exportId,
      regenerationPlanId: safeIds.regenerationPlanId,
      idempotencyKey: "approval_request_apra",
      approve: false,
      rightsConfirmed: true,
    }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("approval accepts a validated draft and creates one idempotent render job", () => {
  const workspace = createReviewWorkspace("aprb");
  const queue = fakeQueue();
  const enqueued = [];
  const first = approveRegenerationDraft({
    request: {
      projectId: workspace.ids.projectId,
      sourceJobId: workspace.ids.sourceJobId,
      exportId: workspace.ids.exportId,
      regenerationPlanId: workspace.ids.regenerationPlanId,
      idempotencyKey: "approval_request_aprb",
      approve: true,
      rightsConfirmed: true,
    },
    rootDir: workspace.rootDir,
    persistenceAdapter: { getProject: () => workspace.project },
    jobQueue: queue,
    workerSupervisor: {
      enqueue(job) {
        enqueued.push(job.id);
      },
    },
    requestId: "req_approval_unit",
  });
  const second = approveRegenerationDraft({
    request: {
      projectId: workspace.ids.projectId,
      sourceJobId: workspace.ids.sourceJobId,
      exportId: workspace.ids.exportId,
      regenerationPlanId: workspace.ids.regenerationPlanId,
      idempotencyKey: "approval_request_aprb",
      approve: true,
      rightsConfirmed: true,
    },
    rootDir: workspace.rootDir,
    persistenceAdapter: { getProject: () => workspace.project },
    jobQueue: queue,
    workerSupervisor: { enqueue() {} },
    requestId: "req_approval_unit",
  });

  assert.equal(first.status, "render_queued");
  assert.equal(first.canRender, true);
  assert.equal(first.blockingSuggestionCount, 0);
  assert.equal(first.job.action, "regeneration_render");
  assert.equal(first.job.payload.approvedEditPlan.captions.some((caption) => /goal/i.test(caption.text)), false);
  assert.equal(first.job.payload.regenerationApproval.regenerationPlanId, workspace.ids.regenerationPlanId);
  assert.equal(second.job.id, first.job.id);
  assert.equal(queue.created.length, 1);
  assert.deepEqual(enqueued, [first.job.id]);
});
