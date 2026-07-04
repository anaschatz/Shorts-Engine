const { createHash } = require("node:crypto");
const { normalizeOwnerId } = require("./auth.cjs");
const { AppError, SAFE_MESSAGES, redactForLogs } = require("./errors.cjs");
const { validateEditPlan } = require("./edit-plan.cjs");
const { idempotencyKey } = require("./jobs.cjs");
const { jsonClone, sanitizeText, validateResourceId } = require("./repositories/ids.cjs");
const {
  createRegenerationPlanFromReviewRegistration,
  validateRegenerationPlan,
} = require("./regeneration-plan.cjs");

const APPROVAL_SCHEMA_VERSION = 1;
const APPROVAL_STATES = Object.freeze([
  "draft",
  "approval_required",
  "approved",
  "render_queued",
  "render_processing",
  "render_completed",
  "render_failed",
  "rejected",
  "cancelled",
]);
const MAX_OPERATOR_NOTE_LENGTH = 500;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,160}$/;
const DRAFT_HASH_RE = /^[a-f0-9]{16,64}$/;

function nowIso() {
  return new Date().toISOString();
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function approvalIdFor(input) {
  const hash = createHash("sha256").update(stableStringify(input || {})).digest("hex").slice(0, 32);
  return `appr_${hash}`;
}

function validateIdempotencyKey(value) {
  const safe = sanitizeText(value, 160);
  if (!IDEMPOTENCY_RE.test(safe)) {
    throw new AppError("VALIDATION_ERROR", "Approval idempotency key is invalid.", 400, { field: "idempotencyKey" });
  }
  return safe;
}

function validateOptionalDraftHash(value) {
  if (value === undefined || value === null || value === "") return null;
  const safe = sanitizeText(value, 80).toLowerCase();
  if (!DRAFT_HASH_RE.test(safe)) {
    throw new AppError("VALIDATION_ERROR", "Selected draft hash is invalid.", 400, { field: "selectedDraftHash" });
  }
  return safe;
}

function validateApprove(value) {
  if (value !== true) {
    throw new AppError("VALIDATION_ERROR", "Explicit human approval is required before render.", 400, { field: "approve" });
  }
  return true;
}

function validateApprovalRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  const projectId = validateResourceId(input.projectId, "prj");
  const sourceJobId = validateResourceId(input.sourceJobId || input.jobId, "job");
  const exportId = validateResourceId(input.exportId, "exp");
  const regenerationPlanId = validateResourceId(input.regenerationPlanId, "regen");
  return {
    projectId,
    sourceJobId,
    exportId,
    regenerationPlanId,
    ownerId: input.ownerId ? normalizeOwnerId(input.ownerId) : null,
    idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
    approve: validateApprove(input.approve),
    rightsConfirmed: input.rightsConfirmed === true || input.rightsConfirmed === "true" || input.rightsConfirmed === "1",
    selectedDraftHash: validateOptionalDraftHash(input.selectedDraftHash || input.draftHash),
    operatorNote: sanitizeText(input.operatorNote || "", MAX_OPERATOR_NOTE_LENGTH),
    reviewerNotes: sanitizeText(input.reviewerNotes || "", MAX_OPERATOR_NOTE_LENGTH),
    humanNotes: sanitizeText(input.humanNotes || "", MAX_OPERATOR_NOTE_LENGTH),
    title: input.title ? sanitizeText(input.title, 160) : null,
    reference: input.reference ? sanitizeText(input.reference, 300) : null,
  };
}

function assertRightsConfirmed(value) {
  if (!value) {
    throw new AppError("VALIDATION_ERROR", "Confirm footage rights before approving this draft.", 400, { field: "rightsConfirmed" });
  }
}

function assertDraftCanBeApproved(plan) {
  if (!plan || plan.status !== "draft" || !plan.proposedEditPlan) {
    throw new AppError("VALIDATION_ERROR", "A validated regeneration draft is required before approval.", 400, { field: "regenerationPlan" });
  }
  if (plan.canRender !== false || plan.requiresHumanApproval !== true) {
    throw new AppError("VALIDATION_ERROR", "Regeneration drafts must remain render-locked before approval.", 400, { field: "canRender" });
  }
  const blockingReasons = Array.isArray(plan.blockingReasons) ? plan.blockingReasons : [];
  if (blockingReasons.length > 0) {
    throw new AppError("VALIDATION_ERROR", "Resolve blocking regeneration suggestions before approval.", 400, {
      field: "blockingReasons",
      nextAction: "manual-review-required",
    });
  }
  const failedSafety = (Array.isArray(plan.safetyChecks) ? plan.safetyChecks : []).find((check) => check.status !== "passed");
  if (failedSafety) {
    throw new AppError("VALIDATION_ERROR", "Regeneration draft safety checks must pass before approval.", 400, {
      field: "safetyChecks",
      nextAction: "manual-review-required",
    });
  }
}

function jobStatusToApprovalState(job) {
  if (!job) return "approved";
  if (job.status === "queued") return "render_queued";
  if (job.status === "processing") return "render_processing";
  if (job.status === "completed") return "render_completed";
  if (job.status === "failed") return "render_failed";
  if (job.status === "cancelled") return "cancelled";
  return "approved";
}

function persistDraftRecord(repository, plan, request, createdAt) {
  if (!repository || typeof repository.createFromPlan !== "function") return null;
  return repository.createFromPlan(plan, {
    projectId: request.projectId,
    sourceJobId: request.sourceJobId,
    sourceExportId: request.exportId,
    createdAt,
  });
}

function persistApprovalRecord(repository, record) {
  if (!repository || typeof repository.createIdempotent !== "function") return null;
  return repository.createIdempotent(record);
}

function markApprovalForJob(repository, approvalId, job) {
  if (!repository || !approvalId || !job) return null;
  if (job.status === "queued" && typeof repository.markRenderQueued === "function") {
    return repository.markRenderQueued(approvalId, job.id);
  }
  if (job.status === "processing" && typeof repository.markRenderProcessing === "function") {
    return repository.markRenderProcessing(approvalId, job.id);
  }
  if (job.status === "completed" && typeof repository.markRenderCompleted === "function") {
    return repository.markRenderCompleted(approvalId, { jobId: job.id, exportId: job.exportId });
  }
  if (job.status === "failed" && typeof repository.markRenderFailed === "function") {
    return repository.markRenderFailed(approvalId, { jobId: job.id, errorCode: job.error && job.error.code });
  }
  if (job.status === "cancelled" && typeof repository.markRenderCancelled === "function") {
    return repository.markRenderCancelled(approvalId, { jobId: job.id });
  }
  return repository.get && typeof repository.get === "function" ? repository.get(approvalId) : null;
}

function logInfo(logger, payload) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(JSON.stringify(redactForLogs({ level: "info", ...payload })));
}

function createApprovalOutboxEvent(repository, input = {}) {
  if (!repository || typeof repository.createLifecycleEvent !== "function") return null;
  return repository.createLifecycleEvent(input);
}

function runInPersistenceTransaction(adapter, callback) {
  if (adapter && typeof adapter.transaction === "function") {
    return adapter.transaction(callback);
  }
  return callback();
}

function markApprovalFailed(repository, approvalId, job, error) {
  if (!repository || !approvalId || typeof repository.markRenderFailed !== "function") return null;
  return repository.markRenderFailed(approvalId, {
    jobId: job && job.id,
    errorCode: (error && error.code) || "REGENERATION_RENDER_QUEUE_FAILED",
  });
}

function publicApprovalResult(result = {}) {
  const job = result.job || null;
  const approvalRecord = result.approvalRecord || null;
  const draftRecord = result.draftRecord || null;
  const status = approvalRecord && APPROVAL_STATES.includes(approvalRecord.status)
    ? approvalRecord.status
    : APPROVAL_STATES.includes(result.status)
      ? result.status
      : "approval_required";
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    approvalId: sanitizeText(result.approvalId || "", 80),
    regenerationPlanId: sanitizeText(result.regenerationPlanId || "", 120),
    draftHash: result.draftHash ? sanitizeText(result.draftHash, 80) : null,
    draftRecordId: draftRecord && draftRecord.id ? sanitizeText(draftRecord.id, 80) : approvalRecord && approvalRecord.draftRecordId ? sanitizeText(approvalRecord.draftRecordId, 80) : null,
    projectId: sanitizeText(result.projectId || "", 120),
    sourceJobId: sanitizeText(result.sourceJobId || "", 120),
    sourceExportId: sanitizeText(result.sourceExportId || "", 120),
    newRenderJobId: job ? sanitizeText(job.id, 120) : null,
    completedExportId: approvalRecord && approvalRecord.completedExportId ? sanitizeText(approvalRecord.completedExportId, 120) : null,
    approvalStatus: status,
    status,
    canRender: result.canRender === true,
    renderQueued: Boolean(result.renderQueued),
    requiresHumanApproval: false,
    message: sanitizeText(result.message || "Draft approved and render queued.", 220),
    approvedAt: sanitizeText(result.approvedAt || "", 80),
    appliedSuggestionCount: Number.isFinite(Number(result.appliedSuggestionCount)) ? Number(result.appliedSuggestionCount) : 0,
    skippedSuggestionCount: Number.isFinite(Number(result.skippedSuggestionCount)) ? Number(result.skippedSuggestionCount) : 0,
    blockingSuggestionCount: Number.isFinite(Number(result.blockingSuggestionCount)) ? Number(result.blockingSuggestionCount) : 0,
    audit: {
      approvalId: sanitizeText(result.approvalId || "", 80),
      draftRecordId: draftRecord && draftRecord.id ? sanitizeText(draftRecord.id, 80) : approvalRecord && approvalRecord.draftRecordId ? sanitizeText(approvalRecord.draftRecordId, 80) : null,
      status,
      persisted: Boolean(approvalRecord),
    },
    job: job && result.publicJob ? result.publicJob(job) : null,
  };
}

function approveRegenerationDraft(options = {}) {
  const request = validateApprovalRequest(options.request || options);
  assertRightsConfirmed(request.rightsConfirmed);
  const createdAt = options.createdAt || nowIso();
  const { registered, regenerationPlan } = createRegenerationPlanFromReviewRegistration({
    projectId: request.projectId,
    jobId: request.sourceJobId,
    exportId: request.exportId,
    rightsConfirmed: true,
    reference: request.reference,
    reviewerNotes: request.reviewerNotes,
    humanNotes: request.humanNotes,
    title: request.title,
    projectRecord: options.projectRecord,
    renderRecord: options.renderRecord,
    rootDir: options.rootDir,
    regenerationPlanId: request.regenerationPlanId,
  });
  const editPlan = registered.draft.generatedMetadata.editPlan;
  const selectedMoment = registered.draft.generatedMetadata.selectedMoment;
  const metadata = {
    durationSeconds: editPlan.sourceDurationSeconds || selectedMoment.end,
    width: editPlan.sourceWidth,
    height: editPlan.sourceHeight,
  };
  validateRegenerationPlan(regenerationPlan, metadata);
  assertDraftCanBeApproved(regenerationPlan);
  if (request.selectedDraftHash && request.selectedDraftHash !== regenerationPlan.draftHash) {
    throw new AppError("VALIDATION_ERROR", "Selected draft hash no longer matches the server-approved draft.", 409, {
      field: "selectedDraftHash",
      nextAction: "refresh-regeneration-draft",
    });
  }
  const approvedEditPlan = validateEditPlan(regenerationPlan.proposedEditPlan, metadata);
  const approvalId = approvalIdFor({
    projectId: request.projectId,
    sourceJobId: request.sourceJobId,
    exportId: request.exportId,
    regenerationPlanId: request.regenerationPlanId,
    idempotencyKey: request.idempotencyKey,
  });
  const key = request.idempotencyKey || idempotencyKey("regeneration-approval", {
    projectId: request.projectId,
    sourceJobId: request.sourceJobId,
    exportId: request.exportId,
    regenerationPlanId: request.regenerationPlanId,
    draftHash: regenerationPlan.draftHash,
  });
  const registeredProject = registered.draft && registered.draft.generatedMetadata && registered.draft.generatedMetadata.registration
    ? {
        id: registered.draft.generatedMetadata.registration.projectId,
        uploadId: registered.draft.generatedMetadata.registration.uploadId,
        title: registered.draft.title,
      }
    : null;
  const project = options.persistenceAdapter && typeof options.persistenceAdapter.getProject === "function"
    ? options.persistenceAdapter.getProject(request.projectId)
    : options.projectRepository && typeof options.projectRepository.get === "function"
      ? options.projectRepository.get(request.projectId)
      : registeredProject;
  const projectForRender = project || registeredProject;
  if (!projectForRender || !projectForRender.uploadId) {
    throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
  }
  const queue = options.jobQueue || options.queue;
  if (!queue || typeof queue.create !== "function" || typeof queue.publicJob !== "function") {
    throw new AppError("ADAPTER_CONTRACT_INVALID", SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID, 500);
  }
  let draftRecord = null;
  let approvalRecord = null;
  let job = null;
  try {
    ({ draftRecord, approvalRecord, job } = runInPersistenceTransaction(options.persistenceAdapter, () => {
      const persistedDraft = persistDraftRecord(options.regenerationDraftRepository, regenerationPlan, request, createdAt);
      let persistedApproval = persistApprovalRecord(options.regenerationApprovalRepository, {
        approvalId,
        regenerationPlanId: request.regenerationPlanId,
        draftHash: regenerationPlan.draftHash,
        projectId: request.projectId,
        sourceJobId: request.sourceJobId,
        sourceExportId: request.exportId,
        idempotencyKey: key,
        approvedAt: createdAt,
        approvedBy: "operator/manual/local",
        status: "approved",
        draftRecordId: persistedDraft && persistedDraft.id,
        createdAt,
      });
      createApprovalOutboxEvent(options.approvalOutboxRepository, {
        eventType: "approval_created",
        requestId: options.requestId,
        approvalRecord: persistedApproval,
        status: "approved",
        createdAt,
      });
      logInfo(options.logger || console, {
        event: "approval_audit_created",
        requestId: options.requestId,
        projectId: request.projectId,
        approvalId,
        draftRecordId: persistedDraft && persistedDraft.id,
        status: "approved",
      });
      const createdJob = queue.create({
        projectId: request.projectId,
        uploadId: projectForRender.uploadId,
        ownerId: request.ownerId || null,
        action: "regeneration_render",
        idempotencyKey: key,
        payload: {
          title: request.title || projectForRender.title || "ShortsEngine Short",
          preset: "hype",
          language: (registered.draft.generatedMetadata.registration && registered.draft.generatedMetadata.registration.language) || "auto",
          styleTarget: approvedEditPlan.styleTarget || "vertical_9_16",
          editIntensity: approvedEditPlan.editIntensity || "balanced",
          stylePreset: approvedEditPlan.stylePreset || "social_sports_v1",
          source: projectForRender.source,
          approvedEditPlan: jsonClone(approvedEditPlan),
          regenerationApproval: {
            schemaVersion: APPROVAL_SCHEMA_VERSION,
            approvalId,
            regenerationPlanId: request.regenerationPlanId,
            draftHash: regenerationPlan.draftHash,
            draftRecordId: persistedDraft && persistedDraft.id,
            sourceJobId: request.sourceJobId,
            sourceExportId: request.exportId,
            approvedAt: createdAt,
            approvedBy: "operator/manual/local",
          },
        },
      });
      persistedApproval = markApprovalForJob(options.regenerationApprovalRepository, approvalId, createdJob) || persistedApproval;
      createApprovalOutboxEvent(options.approvalOutboxRepository, {
        eventType: "render_queued",
        requestId: options.requestId,
        approvalRecord: persistedApproval,
        jobId: createdJob && createdJob.id,
        status: persistedApproval && persistedApproval.status,
        createdAt,
      });
      return { draftRecord: persistedDraft, approvalRecord: persistedApproval, job: createdJob };
    }));
  } catch (error) {
    const failedApproval = markApprovalFailed(options.regenerationApprovalRepository, approvalId, job, error);
    if (failedApproval) {
      createApprovalOutboxEvent(options.approvalOutboxRepository, {
        eventType: "render_failed",
        requestId: options.requestId,
        approvalRecord: failedApproval,
        jobId: job && job.id,
        errorCode: failedApproval.errorCode || error.code,
        status: failedApproval.status,
        createdAt: nowIso(),
      });
      logInfo(options.logger || console, {
        event: "approval_audit_failed",
        requestId: options.requestId,
        projectId: request.projectId,
        approvalId,
        jobId: job && job.id,
        code: failedApproval.errorCode || error.code || "REGENERATION_RENDER_QUEUE_FAILED",
      });
    }
    throw error;
  }
  let renderQueued = ["queued", "processing"].includes(job.status);
  if (job.status === "queued" && options.workerSupervisor && typeof options.workerSupervisor.enqueue === "function") {
    const enqueued = queue.enqueue(job, { requestId: options.requestId || "regeneration_approval" });
    options.workerSupervisor.enqueue(enqueued, { requestId: options.requestId || "regeneration_approval" });
    renderQueued = true;
  }
  return {
    approvalId,
    regenerationPlanId: request.regenerationPlanId,
    draftHash: regenerationPlan.draftHash,
    projectId: request.projectId,
    sourceJobId: request.sourceJobId,
    sourceExportId: request.exportId,
    draftRecord,
    approvalRecord,
    job,
    status: jobStatusToApprovalState(job),
    canRender: true,
    renderQueued,
    approvedAt: createdAt,
    appliedSuggestionCount: Array.isArray(regenerationPlan.appliedSuggestionIds) ? regenerationPlan.appliedSuggestionIds.length : 0,
    skippedSuggestionCount: Array.isArray(regenerationPlan.skippedSuggestionIds) ? regenerationPlan.skippedSuggestionIds.length : 0,
    blockingSuggestionCount: Array.isArray(regenerationPlan.blockingReasons) ? regenerationPlan.blockingReasons.length : 0,
    message: "Draft approved. A regeneration render job was queued.",
    publicJob: (item) => queue.publicJob(item),
  };
}

module.exports = {
  APPROVAL_SCHEMA_VERSION,
  APPROVAL_STATES,
  approveRegenerationDraft,
  approvalIdFor,
  publicApprovalResult,
  validateApprovalRequest,
};
