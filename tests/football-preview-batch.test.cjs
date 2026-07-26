const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const {
  buildFootballReviewCandidates,
} = require("../server/pipelines/football/review/candidate-builder.cjs");
const {
  FootballPreviewBatchService,
} = require("../server/pipelines/football/review/preview-batch-service.cjs");

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

test("preview batch downloads the source once and publishes distinct bound previews", async () => {
  const ownerId = id("usr");
  const projectId = id("prj");
  const sourceJobId = id("job");
  const sourceUploadId = id("upl");
  const sourceRevision = "a".repeat(64);
  const source = Buffer.from("bounded-source-fixture");
  const candidates = buildFootballReviewCandidates({
    projectId,
    sourceJobId,
    sourceRevision,
    sourceDurationSeconds: 60,
    candidatePlans: [{
      sourceStart: 10,
      sourceEnd: 25,
      confidence: 0.7,
      highlightType: "possible_goal",
      reasonCodes: ["goal_uncertain"],
      cropPlan: {
        mode: "wide_safe",
        confidence: 0.7,
        fallbackUsed: true,
      },
    }],
  });
  const review = {
    id: `fbr_${randomUUID()}`,
    ownerId,
    projectId,
    sourceJobId,
    sourceUploadId,
    sourceRevision,
    rightsConfirmed: true,
    status: "preparing",
    candidates,
  };
  const stagingRoot = mkdtempSync(join(tmpdir(), "preview-batch-test-"));
  let sourceReads = 0;
  const uploads = [];
  const repository = {
    async getOwnedReview() {
      return review;
    },
    async beginCandidatePreview(input) {
      const candidate = review.candidates.find((item) => item.id === input.candidateId);
      candidate.preview.status = "rendering";
      candidate.preview.artifactId = input.artifactId;
      return {
        artifactId: input.artifactId,
        storageKey: input.storageKey,
        expiresAt: input.expiresAt,
      };
    },
    async publishCandidatePreview(input) {
      const candidate = review.candidates.find((item) => item.id === input.candidateId);
      candidate.preview = {
        status: "ready",
        artifactId: input.artifactId,
        checksumSha256: input.checksumSha256,
        durationSeconds: input.durationSeconds,
        expiresAt: input.expiresAt,
      };
      if (review.candidates.filter((item) => item.preview.status === "ready").length >= 2) {
        review.status = "pending";
      }
      return review;
    },
    async failCandidatePreview() {
      assert.fail("no candidate should fail");
    },
  };
  const store = {
    async getObjectStream() {
      sourceReads += 1;
      return { body: Readable.from([source]) };
    },
    async putObjectStream(input) {
      const chunks = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      uploads.push({ ...input, body });
      return {
        byteSize: body.length,
        contentType: input.contentType,
        metadata: { ...input.metadata },
      };
    },
  };
  const service = new FootballPreviewBatchService({
    persistence: {
      async getAvailableUploadArtifactOwnedBy() {
        return {
          uploadId: sourceUploadId,
          projectId,
          storageKey: "source/test/object.mp4",
          contentType: "video/mp4",
          byteSize: source.length,
          checksumSha256: sha256(source),
        };
      },
    },
    reviewRepository: repository,
    store,
    stagingRoot,
    async renderPreview(input) {
      const body = Buffer.from(`preview:${input.candidate.purpose.code}`);
      await writeFile(input.outputPath, body, { mode: 0o600 });
      return {
        manifest: {
          schemaVersion: 1,
          candidateId: input.candidate.id,
          sourceRevision: input.candidate.sourceRevision,
          planHash: input.candidate.planHash,
          checksumSha256: sha256(body),
          durationSeconds: input.candidate.durationSeconds,
          width: 540,
          height: 960,
          fps: 24,
          videoCodec: "h264",
          audioCodec: "aac",
          byteSize: body.length,
        },
      };
    },
  });
  try {
    const result = await service.renderBatch({
      ownerId,
      reviewId: review.id,
      jobId: id("job"),
    });
    assert.equal(sourceReads, 1);
    assert.equal(uploads.length, candidates.length);
    assert.equal(result.readyPreviewCount, candidates.length);
    assert.equal(result.status, "pending");
    assert.equal(
      new Set(uploads.map((upload) => upload.metadata.planhash)).size,
      candidates.length,
    );
    assert.ok(uploads.every((upload) => upload.metadata.sourcerevision === sourceRevision));
    assert.deepEqual(
      uploads.map((upload) => upload.body.toString()).sort(),
      candidates.map((candidate) => `preview:${candidate.purpose.code}`).sort(),
    );
    assert.equal(
      review.candidates.every((candidate) => candidate.preview.status === "ready"),
      true,
    );
    assert.equal(
      review.candidates.some((candidate) => existsSync(
        join(stagingRoot, `preview-${candidate.id}.mp4`),
      )),
      false,
    );
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
});
