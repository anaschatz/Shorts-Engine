const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { RegenerationApprovalRepository } = require("../server/repositories/regeneration-approval-repository.cjs");
const { RegenerationDraftRepository } = require("../server/repositories/regeneration-draft-repository.cjs");

const SAFE_IDS = Object.freeze({
  projectId: "prj_auditproject0001",
  sourceJobId: "job_auditjob000001",
  sourceExportId: "exp_auditexport001",
  regenerationPlanId: "regen_auditregen001",
  draftHash: "1234567890abcdef1234567890abcdef",
  approvalId: "appr_1234567890abcdef1234567890abcdef",
  jobId: "job_auditrender001",
  exportId: "exp_auditdone0001",
});

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function draftPlan(overrides = {}) {
  return {
    projectId: SAFE_IDS.projectId,
    jobId: SAFE_IDS.sourceJobId,
    exportId: SAFE_IDS.sourceExportId,
    regenerationPlanId: SAFE_IDS.regenerationPlanId,
    draftHash: SAFE_IDS.draftHash,
    status: "draft",
    appliedSuggestionIds: ["caption_fix"],
    skippedSuggestionIds: ["manual_audio_review"],
    proposedChanges: ["captions", "framing"],
    blockingReasons: [],
    safetyChecks: [{ code: "NO_FALSE_GOAL", status: "passed" }],
    proposedEditPlan: {
      aspectRatio: "9:16",
      highlightType: "big_chance",
      framingMode: "wide_safe",
      stylePreset: "social_sports_v1",
      styleTarget: "vertical_9_16",
      editIntensity: "balanced",
      sourceStart: 2,
      sourceEnd: 10,
      captions: [{ start: 0, end: 1.5, text: "/Users/private secret caption" }],
      animationCues: [{ type: "caption_pop", start: 0.2, end: 1.1 }],
      effects: ["wide_safe_framing"],
    },
    ...overrides,
  };
}

function approvalRecord(overrides = {}) {
  return {
    approvalId: SAFE_IDS.approvalId,
    regenerationPlanId: SAFE_IDS.regenerationPlanId,
    draftHash: SAFE_IDS.draftHash,
    projectId: SAFE_IDS.projectId,
    sourceJobId: SAFE_IDS.sourceJobId,
    sourceExportId: SAFE_IDS.sourceExportId,
    idempotencyKey: "auditapprovalkey001",
    approvedAt: "2026-06-17T00:00:00.000Z",
    approvedBy: "operator/manual/local",
    status: "approved",
    draftRecordId: "rdft_1234567890abcdef1234567890abcdef",
    ...overrides,
  };
}

test("regeneration draft repository persists safe summaries and restores records", () => {
  const dir = tempDir("shortsengine-draft-audit-");
  const repo = new RegenerationDraftRepository({ dir });
  const record = repo.createFromPlan(draftPlan());

  assert.equal(record.version, 1);
  assert.equal(record.proposedEditPlanSummary.captionCount, 1);
  assert.equal(record.proposedEditPlanSummary.animationCueCount, 1);
  assert.equal(record.proposedEditPlanSummary.effectCount, 1);
  assert.equal(repo.get(record.id).id, record.id);
  assert.equal(repo.getByPlanHash({
    regenerationPlanId: SAFE_IDS.regenerationPlanId,
    draftHash: SAFE_IDS.draftHash,
  }).id, record.id);

  const publicRecord = repo.publicDraft(record);
  assert.equal(publicRecord.proposedEditPlanSummary.captionCount, 1);
  assert.equal(publicRecord.proposedEditPlan, undefined);
  assert.doesNotMatch(JSON.stringify(publicRecord), /\/Users|secret|caption text|storageKey|outputPath/i);

  const secondVersion = repo.createFromPlan(draftPlan({
    draftHash: "abcdefabcdefabcdefabcdefabcdefab",
  }));
  assert.equal(secondVersion.version, 2);

  const restored = new RegenerationDraftRepository({ dir });
  assert.deepEqual(restored.restore(), { records: 2, ignored: 0 });
  assert.equal(restored.get(record.id).proposedEditPlanSummary.captionCount, 1);
});

test("regeneration draft repository ignores corrupt persisted metadata safely", () => {
  const dir = tempDir("shortsengine-draft-audit-corrupt-");
  const repo = new RegenerationDraftRepository({ dir });
  repo.createFromPlan(draftPlan());
  writeFileSync(join(dir, "rdft_ffffffffffffffffffffffffffffffff.json"), "{not-json", "utf8");

  const restored = new RegenerationDraftRepository({ dir });
  assert.deepEqual(restored.restore(), { records: 1, ignored: 1 });
});

test("regeneration approval repository enforces idempotency and lifecycle updates", () => {
  const dir = tempDir("shortsengine-approval-audit-");
  const repo = new RegenerationApprovalRepository({ dir });
  const created = repo.createIdempotent(approvalRecord());
  const duplicate = repo.createIdempotent(approvalRecord());

  assert.equal(duplicate.approvalId, created.approvalId);
  assert.equal(repo.all().length, 1);
  assert.throws(
    () => repo.createIdempotent(approvalRecord({
      sourceJobId: "job_otherjob000001",
    })),
    (error) => error.code === "VALIDATION_ERROR" && error.status === 409,
  );

  assert.equal(repo.markRenderQueued(SAFE_IDS.approvalId, SAFE_IDS.jobId).status, "render_queued");
  assert.equal(repo.markRenderProcessing(SAFE_IDS.approvalId, SAFE_IDS.jobId).status, "render_processing");
  const completed = repo.markRenderCompleted(SAFE_IDS.approvalId, {
    jobId: SAFE_IDS.jobId,
    exportId: SAFE_IDS.exportId,
  });
  assert.equal(completed.status, "render_completed");
  assert.equal(completed.completedExportId, SAFE_IDS.exportId);
  assert.equal(repo.getByRenderJobId(SAFE_IDS.jobId).approvalId, SAFE_IDS.approvalId);

  const publicRecord = repo.publicApproval(completed);
  assert.equal(publicRecord.idempotencyKey, "auditapprovalkey001");
  assert.doesNotMatch(JSON.stringify(publicRecord), /\/Users|\/private|secret|token|stdout|stderr|storageKey|outputPath/i);

  const restored = new RegenerationApprovalRepository({ dir });
  assert.deepEqual(restored.restore(), { records: 1, ignored: 0 });
  assert.equal(restored.get(SAFE_IDS.approvalId).status, "render_completed");
});

test("regeneration approval repository records safe failed and cancelled states", () => {
  const repo = new RegenerationApprovalRepository({ persist: false });
  repo.createIdempotent(approvalRecord());

  const failed = repo.markRenderFailed(SAFE_IDS.approvalId, {
    jobId: SAFE_IDS.jobId,
    errorCode: "RENDER_FAILED",
  });
  assert.equal(failed.status, "render_failed");
  assert.equal(failed.errorCode, "RENDER_FAILED");

  const cancelled = repo.markRenderCancelled(SAFE_IDS.approvalId, { jobId: SAFE_IDS.jobId });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.errorCode, "JOB_CANCELLED");
});
