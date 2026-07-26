const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProductionWorkerHandlers,
} = require("../server/worker/create-production-worker-handlers.cjs");

test("production worker handlers route bounded job identity into each service", async () => {
  const calls = [];
  const handlers = createProductionWorkerHandlers({
    uploadValidationService: {
      async validateUpload(input) {
        calls.push({ method: "validate", input });
        return { status: "available" };
      },
    },
    footballAnalysisService: {
      async analyze(job, context) {
        calls.push({ method: "analysis", job, context });
        return { reviewId: "fbr_test" };
      },
    },
    previewBatchService: {
      async renderBatch(input) {
        calls.push({ method: "preview", input });
        return { readyPreviewCount: 4 };
      },
    },
    approvedRenderService: {
      async renderApproved(job, context) {
        calls.push({ method: "render", job, context });
        return { exportId: "exp_test" };
      },
    },
  });
  const signal = new AbortController().signal;
  const updates = [];
  const context = {
    signal,
    async update(patch) {
      updates.push(patch);
    },
  };
  const base = {
    id: "job_test",
    ownerId: "usr_test",
    projectId: "prj_test",
    uploadId: "upl_test",
    payload: { reviewId: "fbr_test" },
  };
  assert.deepEqual(
    await handlers.validate_upload(base, context),
    { status: "available" },
  );
  assert.deepEqual(
    await handlers.analyze_football(base, context),
    { reviewId: "fbr_test" },
  );
  assert.deepEqual(
    await handlers.football_review_preview_batch(base, context),
    { readyPreviewCount: 4 },
  );
  assert.deepEqual(
    await handlers.render_approved_candidate(base, context),
    { exportId: "exp_test" },
  );
  assert.equal(calls[0].input.ownerId, base.ownerId);
  assert.equal(calls[0].input.uploadId, base.uploadId);
  assert.equal(calls[1].job, base);
  assert.equal(calls[2].input.reviewId, base.payload.reviewId);
  assert.equal(calls[2].input.jobId, base.id);
  assert.equal(calls[3].job, base);
  assert.equal(calls[3].context, context);
  assert.deepEqual(updates, [
    { progress: 5, step: "validating_upload" },
    { progress: 5, step: "rendering_review_previews" },
  ]);
});

test("production worker handler factory fails closed on an incomplete service set", () => {
  assert.throws(
    () => createProductionWorkerHandlers({}),
    (error) => error.code === "ADAPTER_CONTRACT_INVALID",
  );
});
