const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { sanitizeText, validateResourceId } = require("../../../repositories/ids.cjs");
const { idempotencyKey } = require("../../../shared/core/idempotency.cjs");
const { buildFootballReviewCandidates, sourceRevisionFor } = require("./candidate-builder.cjs");
const { validateReviewId } = require("./review-repository.cjs");

function projectRevision(project) {
  const revision = Number(project && project.input && project.input.revision || 1);
  return Number.isInteger(revision) && revision >= 1 ? revision : 1;
}

function assertProjectRevision(project, expectedRevision) {
  const currentRevision = projectRevision(project);
  if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) !== currentRevision) {
    throw new AppError("FOOTBALL_REVIEW_STALE", SAFE_MESSAGES.FOOTBALL_REVIEW_STALE, 409, {
      expectedRevision: Number(expectedRevision),
      currentRevision,
    });
  }
  return currentRevision;
}

function assertSourceJob(project, upload, sourceJob) {
  if (!sourceJob || sourceJob.projectId !== project.id || sourceJob.uploadId !== upload.id || sourceJob.status !== "completed") {
    throw new AppError("FOOTBALL_REVIEW_SOURCE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_SOURCE_INVALID, 409);
  }
  if (!sourceJob.humanReviewGate || sourceJob.humanReviewGate.requiresReview !== true) {
    throw new AppError("FOOTBALL_REVIEW_NOT_REQUIRED", SAFE_MESSAGES.FOOTBALL_REVIEW_NOT_REQUIRED, 409);
  }
  if (sourceJob.payload && sourceJob.payload.rightsConfirmed !== true) {
    throw new AppError("FOOTBALL_REVIEW_RIGHTS_REQUIRED", SAFE_MESSAGES.FOOTBALL_REVIEW_RIGHTS_REQUIRED, 409);
  }
  return sourceJob;
}

function safePreviewOptions(artifactAdapter, upload, candidate, ttlSeconds) {
  if (!artifactAdapter || typeof artifactAdapter.createSignedDownloadUrl !== "function" || !upload || !upload.artifact) return {};
  const signed = artifactAdapter.createSignedDownloadUrl(upload.artifact, {
    basePath: "/api/artifacts/download",
    ttlSeconds,
  });
  return {
    previewUrl: `${signed.url}#t=${candidate.sourceStart},${candidate.sourceEnd}`,
    previewExpiresAt: signed.expiresAt,
  };
}

function createFootballReviewService(dependencies = {}) {
  const {
    artifactAdapter,
    footballReviewRepository,
    jobQueue,
    projectRepository,
    uploadRepository,
    workerSupervisor,
    executionControls,
  } = dependencies;
  if (!footballReviewRepository || !jobQueue || !projectRepository || !uploadRepository) {
    throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
  }

  function loadProject(projectId) {
    const project = projectRepository.get(validateResourceId(projectId, "prj"));
    if (!project) throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
    if (project.projectType !== "clip") {
      throw new AppError("FOOTBALL_REVIEW_SOURCE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_SOURCE_INVALID, 409);
    }
    return project;
  }

  function loadUpload(project) {
    const upload = uploadRepository.get(project.uploadId);
    if (!upload) throw new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404);
    return upload;
  }

  function createReview(input = {}) {
    const project = loadProject(input.projectId);
    const upload = loadUpload(project);
    const revision = assertProjectRevision(project, input.expectedRevision);
    const sourceJob = assertSourceJob(project, upload, jobQueue.get(validateResourceId(input.sourceJobId, "job")));
    const sourceRevision = sourceRevisionFor(upload, revision);
    const existing = footballReviewRepository.getForSource({
      projectId: project.id,
      sourceJobId: sourceJob.id,
      sourceRevision,
    });
    if (existing) return { review: existing, project, upload, replayed: true };
    const candidates = buildFootballReviewCandidates({
      projectId: project.id,
      sourceJobId: sourceJob.id,
      sourceRevision,
      sourceDurationSeconds: Number(upload.metadata && upload.metadata.durationSeconds || 0),
      candidatePlans: sourceJob.candidatePlans,
      editPlan: sourceJob.editPlan,
      reviewReasonCodes: sourceJob.humanReviewGate.reasonCodes,
    });
    const review = footballReviewRepository.create({
      projectId: project.id,
      ownerId: project.ownerId || input.ownerId,
      sourceJobId: sourceJob.id,
      sourceUploadId: upload.id,
      sourceRevision,
      projectRevision: revision,
      candidates,
      rightsConfirmed: sourceJob.payload && sourceJob.payload.rightsConfirmed === true,
    });
    return { review, project, upload, replayed: false };
  }

  function getReview(input = {}) {
    const project = loadProject(input.projectId);
    const upload = loadUpload(project);
    const review = input.reviewId
      ? footballReviewRepository.get(validateReviewId(input.reviewId))
      : footballReviewRepository.latestForProject(project.id);
    if (!review || review.projectId !== project.id) {
      throw new AppError("FOOTBALL_REVIEW_NOT_FOUND", SAFE_MESSAGES.FOOTBALL_REVIEW_NOT_FOUND, 404);
    }
    return { review, project, upload };
  }

  function publicReview(input = {}) {
    const { review, upload } = getReview(input);
    const candidateOptions = new Map();
    const ttlSeconds = Math.max(1, Math.min(Number(input.ttlSeconds || 120), 300));
    for (const candidate of review.candidates) {
      candidateOptions.set(candidate.id, safePreviewOptions(artifactAdapter, upload, candidate, ttlSeconds));
    }
    return footballReviewRepository.publicReview(review, candidateOptions);
  }

  function assertDecisionState({ project, upload, review, input }) {
    if (review.ownerId !== input.reviewerId || project.ownerId && project.ownerId !== input.reviewerId) {
      throw new AppError("FORBIDDEN", SAFE_MESSAGES.FORBIDDEN, 403);
    }
    const revision = assertProjectRevision(project, review.projectRevision);
    const currentSourceRevision = sourceRevisionFor(upload, revision);
    if (review.sourceRevision !== currentSourceRevision || input.expectedSourceRevision !== currentSourceRevision) {
      throw new AppError("FOOTBALL_REVIEW_STALE", SAFE_MESSAGES.FOOTBALL_REVIEW_STALE, 409, {
        currentRevision: revision,
      });
    }
    if (review.rightsConfirmed !== true) {
      throw new AppError("FOOTBALL_REVIEW_RIGHTS_REQUIRED", SAFE_MESSAGES.FOOTBALL_REVIEW_RIGHTS_REQUIRED, 409);
    }
  }

  function queueApprovedRender({ project, upload, review, candidate, input }) {
    const sourceJob = jobQueue.get(review.sourceJobId);
    assertSourceJob(project, upload, sourceJob);
    const key = idempotencyKey("football-review-render", {
      reviewId: review.id,
      candidateId: candidate.id,
      sourceRevision: review.sourceRevision,
    });
    const job = jobQueue.create({
      projectId: project.id,
      uploadId: upload.id,
      ownerId: input.reviewerId,
      action: "generate",
      idempotencyKey: key,
      payload: {
        ...(sourceJob.payload || {}),
        rightsConfirmed: true,
        approvedEditPlan: candidate.editPlan,
        footballReviewApproval: {
          reviewId: review.id,
          reviewVersion: review.version,
          candidateId: candidate.id,
          sourceRevision: review.sourceRevision,
          projectRevision: review.projectRevision,
          reviewedAt: review.reviewedAt,
          reviewerId: input.reviewerId,
        },
      },
    });
    const marked = review.renderJobId
      ? review
      : footballReviewRepository.markJob(review.id, {
          kind: "render",
          jobId: job.id,
          actorId: input.reviewerId,
          status: "render_queued",
        });
    if (job.status === "queued" && workerSupervisor && typeof workerSupervisor.enqueue === "function") {
      workerSupervisor.enqueue(jobQueue.enqueue(job, { requestId: input.requestId || "football_review" }), {
        requestId: input.requestId || "football_review",
      });
    }
    return { review: marked, job };
  }

  function queueRegeneration({ project, upload, review, input }) {
    const sourceJob = jobQueue.get(review.sourceJobId);
    assertSourceJob(project, upload, sourceJob);
    const key = idempotencyKey("football-review-regenerate", {
      reviewId: review.id,
      sourceRevision: review.sourceRevision,
    });
    const job = jobQueue.create({
      projectId: project.id,
      uploadId: upload.id,
      ownerId: input.reviewerId,
      action: "generate",
      idempotencyKey: key,
      payload: {
        ...(sourceJob.payload || {}),
        rightsConfirmed: true,
      },
    });
    const marked = review.regenerationJobId
      ? review
      : footballReviewRepository.markJob(review.id, {
          kind: "regeneration",
          jobId: job.id,
          actorId: input.reviewerId,
        });
    if (job.status === "queued" && workerSupervisor && typeof workerSupervisor.enqueue === "function") {
      workerSupervisor.enqueue(jobQueue.enqueue(job, { requestId: input.requestId || "football_review" }), {
        requestId: input.requestId || "football_review",
      });
    }
    return { review: marked, job };
  }

  function decide(input = {}) {
    const { review: current, project, upload } = getReview(input);
    assertDecisionState({ project, upload, review: current, input });
    if (executionControls && input.action === "select") {
      const candidate = current.candidates.find((item) => item.id === input.candidateId);
      if (!candidate) {
        throw new AppError("FOOTBALL_REVIEW_CANDIDATE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID, 409);
      }
      executionControls.assertCanEnqueue({
        ownerId: input.reviewerId,
        idempotencyKey: idempotencyKey("football-review-render", {
          reviewId: current.id,
          candidateId: candidate.id,
          sourceRevision: current.sourceRevision,
        }),
      });
    }
    if (executionControls && input.action === "regenerate") {
      executionControls.assertCanEnqueue({
        ownerId: input.reviewerId,
        idempotencyKey: idempotencyKey("football-review-regenerate", {
          reviewId: current.id,
          sourceRevision: current.sourceRevision,
        }),
      });
    }
    const decision = footballReviewRepository.decide(current.id, input);
    let review = decision.record;
    let job = null;
    if (decision.replayed && (review.renderJobId || review.regenerationJobId)) {
      job = jobQueue.get(review.renderJobId || review.regenerationJobId);
      return {
        review,
        job,
        replayed: true,
        publicReview: footballReviewRepository.publicReview(review),
        publicJob: job ? jobQueue.publicJobSummary(job) : null,
      };
    }
    if (review.decision === "select") {
      const candidate = footballReviewRepository.selectedCandidate(review);
      if (!candidate) {
        throw new AppError("FOOTBALL_REVIEW_CANDIDATE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID, 409);
      }
      ({ review, job } = queueApprovedRender({ project, upload, review, candidate, input }));
    } else if (review.decision === "regenerate") {
      ({ review, job } = queueRegeneration({ project, upload, review, input }));
    }
    return {
      review,
      job,
      replayed: decision.replayed,
      publicReview: footballReviewRepository.publicReview(review),
      publicJob: job ? jobQueue.publicJobSummary(job) : null,
    };
  }

  function assertExportAllowed(job) {
    if (!job || !job.humanReviewGate || job.humanReviewGate.requiresReview !== true) return true;
    const review = footballReviewRepository.all().find((record) => (
      record.sourceJobId === job.id &&
      ["render_queued", "render_processing", "render_completed"].includes(record.status)
    ));
    if (!review) {
      throw new AppError("FOOTBALL_REVIEW_REQUIRED", SAFE_MESSAGES.FOOTBALL_REVIEW_REQUIRED, 409, {
        nextAction: "complete-football-review",
      });
    }
    throw new AppError("FOOTBALL_REVIEW_REQUIRED", SAFE_MESSAGES.FOOTBALL_REVIEW_REQUIRED, 409, {
      nextAction: "download-approved-review-render",
    });
  }

  return {
    assertExportAllowed,
    createReview,
    decide,
    getReview,
    projectRevision,
    publicReview,
  };
}

module.exports = {
  createFootballReviewService,
  projectRevision,
};
