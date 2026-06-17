const { redactForLogs } = require("./errors.cjs");

const TERMINAL_APPROVAL_STATUSES = new Set(["render_completed", "render_failed", "cancelled", "rejected"]);

function logInfo(logger, payload) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(JSON.stringify(redactForLogs({ level: "info", ...payload })));
}

function jobById(jobs, jobId) {
  if (!jobs || !jobId) return null;
  if (typeof jobs.get === "function") return jobs.get(jobId);
  if (typeof jobs.all === "function") return jobs.all().find((job) => job.id === jobId) || null;
  return null;
}

function writeOutboxEvent(repository, input) {
  if (!repository || typeof repository.createLifecycleEvent !== "function") return null;
  return repository.createLifecycleEvent(input);
}

function updateApprovalFromJob({ approval, job, approvalRepository, outboxRepository, requestId }) {
  if (!job) {
    const failed = approvalRepository.markRenderFailed(approval.approvalId, {
      jobId: approval.newRenderJobId,
      errorCode: "JOB_NOT_FOUND",
    });
    writeOutboxEvent(outboxRepository, {
      eventType: "render_failed",
      requestId,
      approvalRecord: failed,
      jobId: approval.newRenderJobId,
      errorCode: "JOB_NOT_FOUND",
      status: failed.status,
    });
    return { status: "render_failed", record: failed };
  }
  if (job.status === "completed" && job.exportId) {
    const completed = approvalRepository.markRenderCompleted(approval.approvalId, {
      jobId: job.id,
      exportId: job.exportId,
    });
    writeOutboxEvent(outboxRepository, {
      eventType: "render_completed",
      requestId,
      approvalRecord: completed,
      jobId: job.id,
      exportId: job.exportId,
      status: completed.status,
    });
    return { status: "render_completed", record: completed };
  }
  if (job.status === "failed") {
    const failed = approvalRepository.markRenderFailed(approval.approvalId, {
      jobId: job.id,
      errorCode: job.error && job.error.code ? job.error.code : "RENDER_FAILED",
    });
    writeOutboxEvent(outboxRepository, {
      eventType: "render_failed",
      requestId,
      approvalRecord: failed,
      jobId: job.id,
      errorCode: failed.errorCode,
      status: failed.status,
    });
    return { status: "render_failed", record: failed };
  }
  if (job.status === "cancelled") {
    const cancelled = approvalRepository.markRenderCancelled(approval.approvalId, { jobId: job.id });
    writeOutboxEvent(outboxRepository, {
      eventType: "render_cancelled",
      requestId,
      approvalRecord: cancelled,
      jobId: job.id,
      errorCode: "JOB_CANCELLED",
      status: cancelled.status,
    });
    return { status: "cancelled", record: cancelled };
  }
  if (job.status === "processing") {
    const processing = approvalRepository.markRenderProcessing(approval.approvalId, job.id);
    writeOutboxEvent(outboxRepository, {
      eventType: "render_processing",
      requestId,
      approvalRecord: processing,
      jobId: job.id,
      status: processing.status,
    });
    return { status: "render_processing", record: processing };
  }
  if (job.status === "queued") {
    const queued = approvalRepository.markRenderQueued(approval.approvalId, job.id);
    writeOutboxEvent(outboxRepository, {
      eventType: "render_queued",
      requestId,
      approvalRecord: queued,
      jobId: job.id,
      status: queued.status,
    });
    return { status: "render_queued", record: queued };
  }
  return { status: "ignored", record: approval };
}

function recoverApprovalAudits({
  regenerationApprovalRepository,
  approvalOutboxRepository,
  jobs,
  logger = console,
  requestId = "approval_audit_recovery",
} = {}) {
  const summary = {
    checked: 0,
    updated: 0,
    ignored: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    queued: 0,
    processing: 0,
  };
  if (!regenerationApprovalRepository || typeof regenerationApprovalRepository.all !== "function") {
    return { ...summary, skipped: true };
  }
  for (const approval of regenerationApprovalRepository.all()) {
    summary.checked += 1;
    if (!approval || TERMINAL_APPROVAL_STATUSES.has(approval.status) || !approval.newRenderJobId) {
      summary.ignored += 1;
      continue;
    }
    try {
      const job = jobById(jobs, approval.newRenderJobId);
      const result = updateApprovalFromJob({
        approval,
        job,
        approvalRepository: regenerationApprovalRepository,
        outboxRepository: approvalOutboxRepository,
        requestId,
      });
      if (result.status === "ignored" || result.status === approval.status) {
        summary.ignored += 1;
      } else {
        summary.updated += 1;
      }
      if (result.status === "render_completed") summary.completed += 1;
      if (result.status === "render_failed") summary.failed += 1;
      if (result.status === "cancelled") summary.cancelled += 1;
      if (result.status === "render_queued") summary.queued += 1;
      if (result.status === "render_processing") summary.processing += 1;
    } catch (error) {
      summary.failed += 1;
      logInfo(logger, {
        event: "approval_audit_recovery_failed",
        requestId,
        approvalId: approval && approval.approvalId,
        jobId: approval && approval.newRenderJobId,
        code: error.code || "APPROVAL_AUDIT_RECOVERY_FAILED",
      });
    }
  }
  if (summary.updated > 0 || summary.failed > 0) {
    logInfo(logger, { event: "approval_audit_recovered", requestId, ...summary });
  }
  return summary;
}

module.exports = {
  recoverApprovalAudits,
};
