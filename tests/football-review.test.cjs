const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { AppError } = require("../server/errors.cjs");
const { buildFootballReviewCandidates, sourceRevisionFor } = require("../server/pipelines/football/review/candidate-builder.cjs");
const { FootballReviewRepository } = require("../server/pipelines/football/review/review-repository.cjs");
const { createFootballReviewService } = require("../server/pipelines/football/review/review-service.cjs");

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function plan(overrides = {}) {
  return {
    sourceStart: 12,
    sourceEnd: 28,
    confidence: 0.61,
    highlightType: "possible_goal",
    reasonCodes: ["possible_goal_unconfirmed", "visual_shot_like_motion"],
    aspectRatio: "9:16",
    framingMode: "wide_safe",
    cropPlan: {
      mode: "wide_safe",
      confidence: 0.55,
      fallbackUsed: true,
      reasonCodes: ["wide_safe_visual_context_low_confidence"],
    },
    captions: [{ start: 0, end: 2, text: "Possible goal" }],
    animationCues: [],
    ...overrides,
  };
}

function fixture() {
  const ownerId = "owner_test";
  const projectId = id("prj");
  const uploadId = id("upl");
  const project = {
    id: projectId,
    projectType: "clip",
    uploadId,
    ownerId,
    input: { type: "upload", uploadId },
    title: "Uncertain football moment",
  };
  const upload = {
    id: uploadId,
    projectId,
    ownerId,
    checksumSha256: "a".repeat(64),
    metadata: { durationSeconds: 80, width: 1920, height: 1080 },
    artifact: {
      id: uploadId,
      type: "upload",
      ownerProjectId: projectId,
      status: "available",
      checksumSha256: "a".repeat(64),
    },
  };
  const sourceJob = {
    id: id("job"),
    projectId,
    uploadId,
    ownerId,
    action: "generate",
    pipelineType: "clip",
    status: "completed",
    payload: { title: project.title, preset: "hype", rightsConfirmed: true },
    candidatePlans: [plan(), plan({ sourceStart: 8, sourceEnd: 31, confidence: 0.57 })],
    editPlan: plan(),
    humanReviewGate: {
      schemaVersion: 1,
      status: "required",
      requiresReview: true,
      reviewed: false,
      reasonCodes: ["possible_goal_unconfirmed"],
      reviewItemCount: 1,
    },
  };
  const jobRecords = new Map([[sourceJob.id, sourceJob]]);
  const idempotentJobs = new Map();
  const jobQueue = {
    get: (jobId) => jobRecords.get(jobId) || null,
    create(record) {
      const existing = idempotentJobs.get(record.idempotencyKey);
      if (existing) return existing;
      const job = {
        id: id("job"),
        status: "queued",
        progress: 0,
        step: "queued",
        pipelineType: "clip",
        ...record,
      };
      jobRecords.set(job.id, job);
      idempotentJobs.set(record.idempotencyKey, job);
      return job;
    },
    enqueue(job) {
      return job;
    },
    publicJobSummary(job) {
      return {
        id: job.id,
        projectId: job.projectId,
        status: job.status,
        step: job.step,
      };
    },
  };
  const repository = new FootballReviewRepository({ persist: false });
  const enqueued = [];
  const service = createFootballReviewService({
    artifactAdapter: {
      createSignedDownloadUrl() {
        return { url: "/api/artifacts/download?token=adt_test", expiresAt: "2030-01-01T00:00:00.000Z" };
      },
    },
    footballReviewRepository: repository,
    jobQueue,
    projectRepository: { get: (candidateId) => candidateId === projectId ? project : null },
    uploadRepository: { get: (candidateId) => candidateId === uploadId ? upload : null },
    workerSupervisor: {
      enqueue(job) {
        enqueued.push(job.id);
        return job;
      },
    },
  });
  return { enqueued, jobQueue, ownerId, project, repository, service, sourceJob, upload };
}

test("football review candidate builder creates two to four bounded safe candidates", () => {
  const projectId = id("prj");
  const sourceJobId = id("job");
  const sourceRevision = "b".repeat(64);
  const candidates = buildFootballReviewCandidates({
    projectId,
    sourceJobId,
    sourceRevision,
    sourceDurationSeconds: 50,
    candidatePlans: [plan()],
    editPlan: plan(),
    reviewReasonCodes: ["uncertain_goal_evidence"],
  });
  assert.ok(candidates.length >= 2 && candidates.length <= 4);
  assert.equal(new Set(candidates.map((candidate) => candidate.id)).size, candidates.length);
  for (const candidate of candidates) {
    assert.ok(candidate.sourceStart >= 0);
    assert.ok(candidate.sourceEnd <= 50);
    assert.ok(candidate.durationSeconds <= 90);
    assert.ok(candidate.reasonCodes.includes("uncertain_goal_evidence"));
    assert.ok(["safe_fallback", "tracked", "low_confidence"].includes(candidate.framing.status));
  }
});

test("football review selection is optimistic, idempotent, audited, and queues only the approved plan", () => {
  const ctx = fixture();
  const created = ctx.service.createReview({
    projectId: ctx.project.id,
    sourceJobId: ctx.sourceJob.id,
    expectedRevision: 1,
    ownerId: ctx.ownerId,
  });
  assert.equal(created.review.status, "pending");
  assert.ok(created.review.candidates.length >= 2 && created.review.candidates.length <= 4);
  const candidate = created.review.candidates[1];
  const request = {
    projectId: ctx.project.id,
    reviewId: created.review.id,
    reviewerId: ctx.ownerId,
    expectedVersion: 1,
    expectedSourceRevision: created.review.sourceRevision,
    action: "select",
    candidateId: candidate.id,
    note: "Use the wider context.",
    idempotencyKey: `review_${randomUUID().replace(/-/g, "")}`,
    requestId: "test_review_select",
  };
  const selected = ctx.service.decide(request);
  assert.equal(selected.review.status, "render_queued");
  assert.equal(selected.review.selectedCandidateId, candidate.id);
  assert.equal(selected.review.reviewerId, ctx.ownerId);
  assert.equal(selected.review.audit.map((event) => event.type).includes("candidate_selected"), true);
  assert.equal(selected.review.audit.map((event) => event.type).includes("render_queued"), true);
  assert.equal(selected.job.payload.approvedEditPlan.sourceStart, candidate.sourceStart);
  assert.equal(selected.job.payload.footballReviewApproval.candidateId, candidate.id);
  assert.deepEqual(ctx.enqueued, [selected.job.id]);

  const replay = ctx.service.decide(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.id, selected.job.id);
  assert.deepEqual(ctx.enqueued, [selected.job.id]);
});

test("football review rejection never creates or queues a render job", () => {
  const ctx = fixture();
  const created = ctx.service.createReview({
    projectId: ctx.project.id,
    sourceJobId: ctx.sourceJob.id,
    expectedRevision: 1,
    ownerId: ctx.ownerId,
  });
  const result = ctx.service.decide({
    projectId: ctx.project.id,
    reviewId: created.review.id,
    reviewerId: ctx.ownerId,
    expectedVersion: 1,
    expectedSourceRevision: created.review.sourceRevision,
    action: "reject_all",
    note: "None show the decision clearly.",
    idempotencyKey: `reject_${randomUUID().replace(/-/g, "")}`,
  });
  assert.equal(result.review.status, "rejected");
  assert.equal(result.job, null);
  assert.deepEqual(ctx.enqueued, []);
  assert.throws(
    () => ctx.service.assertExportAllowed(ctx.sourceJob),
    (error) => error instanceof AppError && error.code === "FOOTBALL_REVIEW_REQUIRED",
  );
});

test("football review rejects stale versions, stale sources, and non-owner decisions", () => {
  const ctx = fixture();
  const created = ctx.service.createReview({
    projectId: ctx.project.id,
    sourceJobId: ctx.sourceJob.id,
    expectedRevision: 1,
    ownerId: ctx.ownerId,
  });
  const base = {
    projectId: ctx.project.id,
    reviewId: created.review.id,
    reviewerId: ctx.ownerId,
    expectedVersion: 2,
    expectedSourceRevision: created.review.sourceRevision,
    action: "reject_all",
    idempotencyKey: `stale_${randomUUID().replace(/-/g, "")}`,
  };
  assert.throws(
    () => ctx.service.decide(base),
    (error) => error.code === "FOOTBALL_REVIEW_STALE",
  );
  assert.throws(
    () => ctx.service.decide({ ...base, expectedVersion: 1, expectedSourceRevision: "c".repeat(64) }),
    (error) => error.code === "FOOTBALL_REVIEW_STALE",
  );
  assert.throws(
    () => ctx.service.decide({ ...base, expectedVersion: 1, reviewerId: "owner_other" }),
    (error) => error.code === "FORBIDDEN",
  );
});

test("source revision invalidates when checksum or project revision changes", () => {
  const upload = { checksumSha256: "a".repeat(64) };
  assert.notEqual(sourceRevisionFor(upload, 1), sourceRevisionFor(upload, 2));
  assert.notEqual(sourceRevisionFor(upload, 1), sourceRevisionFor({ checksumSha256: "b".repeat(64) }, 1));
});
