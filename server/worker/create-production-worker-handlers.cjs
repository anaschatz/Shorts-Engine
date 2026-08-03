const { AppError, SAFE_MESSAGES } = require("../errors.cjs");

function createProductionWorkerHandlers(options = {}) {
  const {
    approvedRenderService,
    footballAnalysisService,
    previewBatchService,
    uploadValidationService,
  } = options;
  if (
    !approvedRenderService
    || !footballAnalysisService
    || !previewBatchService
    || !uploadValidationService
  ) {
    throw new AppError(
      "ADAPTER_CONTRACT_INVALID",
      SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
      500,
    );
  }
  return Object.freeze({
    async validate_upload(job, context) {
      await context.update({ progress: 5, step: "validating_upload" });
      return await uploadValidationService.validateUpload({
        ownerId: job.ownerId,
        uploadId: job.uploadId,
        signal: context.signal,
      });
    },
    async analyze_football(job, context) {
      return await footballAnalysisService.analyze(job, context);
    },
    async football_review_preview_batch(job, context) {
      await context.update({ progress: 5, step: "rendering_review_previews" });
      return await previewBatchService.renderBatch({
        ownerId: job.ownerId,
        reviewId: job.payload && job.payload.reviewId,
        jobId: job.id,
        signal: context.signal,
      });
    },
    async render_approved_candidate(job, context) {
      return await approvedRenderService.renderApproved(job, context);
    },
  });
}

module.exports = {
  createProductionWorkerHandlers,
};
