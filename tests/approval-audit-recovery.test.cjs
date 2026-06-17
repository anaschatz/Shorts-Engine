const test = require("node:test");
const assert = require("node:assert/strict");

const { recoverApprovalAudits } = require("../server/approval-audit-recovery.cjs");
const { ApprovalOutboxRepository } = require("../server/repositories/approval-outbox-repository.cjs");
const { RegenerationApprovalRepository } = require("../server/repositories/regeneration-approval-repository.cjs");

function approval(overrides = {}) {
  return {
    approvalId: overrides.approvalId || "appr_11111111111111111111111111111111",
    regenerationPlanId: "regen_recoveryplan001",
    draftHash: "abcdefabcdefabcdefabcdefabcdefab",
    projectId: "prj_recoveryproject",
    sourceJobId: "job_recoverysource",
    sourceExportId: "exp_recoverysource",
    idempotencyKey: overrides.idempotencyKey || "recoveryapprovalkey001",
    approvedBy: "operator/manual/local",
    status: overrides.status || "render_queued",
    newRenderJobId: overrides.newRenderJobId || "job_recoveryrender001",
    ...overrides,
  };
}

test("approval audit recovery reconciles completed failed and missing jobs safely", () => {
  const approvalRepository = new RegenerationApprovalRepository({ persist: false });
  const outboxRepository = new ApprovalOutboxRepository({ persist: false });
  approvalRepository.createIdempotent(approval({
    approvalId: "appr_11111111111111111111111111111111",
    idempotencyKey: "recoveryapprovalkey001",
    status: "render_processing",
    newRenderJobId: "job_recoveryrender001",
  }));
  approvalRepository.createIdempotent(approval({
    approvalId: "appr_22222222222222222222222222222222",
    idempotencyKey: "recoveryapprovalkey002",
    status: "render_processing",
    newRenderJobId: "job_recoveryrender002",
  }));
  approvalRepository.createIdempotent(approval({
    approvalId: "appr_33333333333333333333333333333333",
    idempotencyKey: "recoveryapprovalkey003",
    status: "render_queued",
    newRenderJobId: "job_recoverymissing",
  }));
  const jobs = {
    get(jobId) {
      return {
        job_recoveryrender001: {
          id: "job_recoveryrender001",
          status: "completed",
          exportId: "exp_recoverydone001",
        },
        job_recoveryrender002: {
          id: "job_recoveryrender002",
          status: "failed",
          error: { code: "RENDER_FAILED", message: "safe" },
        },
      }[jobId] || null;
    },
  };
  const logs = [];
  const logger = {
    info(line) {
      logs.push(JSON.parse(line));
    },
  };

  const summary = recoverApprovalAudits({
    regenerationApprovalRepository: approvalRepository,
    approvalOutboxRepository: outboxRepository,
    jobs,
    logger,
    requestId: "req_recovery",
  });

  assert.equal(summary.checked, 3);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 2);
  assert.equal(approvalRepository.get("appr_11111111111111111111111111111111").status, "render_completed");
  assert.equal(approvalRepository.get("appr_22222222222222222222222222222222").errorCode, "RENDER_FAILED");
  assert.equal(approvalRepository.get("appr_33333333333333333333333333333333").errorCode, "JOB_NOT_FOUND");
  assert.deepEqual(outboxRepository.all().map((event) => event.eventType).sort(), [
    "render_completed",
    "render_failed",
    "render_failed",
  ].sort());
  assert.doesNotMatch(JSON.stringify({ summary, logs, outbox: outboxRepository.all() }), /\/Users|\/private|secret|token|storageKey|outputPath|stdout|stderr/i);
});
