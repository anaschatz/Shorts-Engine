const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const {
  FootballApprovedRenderService,
  validateApprovedOutput,
} = require("../server/pipelines/football/review/approved-render-service.cjs");

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("approved render publishes export inside the fenced completion transaction", async () => {
  const sourceBody = Buffer.from("approved-source");
  const outputBody = Buffer.from("approved-output");
  const stagingRoot = mkdtempSync(join(tmpdir(), "approved-render-test-"));
  const ownerId = id("usr");
  const projectId = id("prj");
  const uploadId = id("upl");
  const job = {
    id: id("job"),
    ownerId,
    projectId,
    uploadId,
    workerId: "worker-a",
    leaseId: "lease-a",
    payload: {
      approvedEditPlan: {
        sourceStart: 3,
        sourceEnd: 12,
        totalDuration: 9,
        captionsEnabled: false,
        cropPlan: { mode: "wide_safe", fallbackUsed: true },
      },
      footballReviewApproval: {
        reviewId: `fbr_${randomUUID()}`,
        candidateId: `fcand_${"a".repeat(32)}`,
        sourceRevision: "b".repeat(64),
        planHash: "c".repeat(64),
      },
    },
  };
  const calls = [];
  const persistence = {
    async getAvailableUploadArtifactOwnedBy() {
      return {
        projectId,
        storageKey: "source/test/object.mp4",
        contentType: "video/mp4",
        byteSize: sourceBody.length,
        checksumSha256: hash(sourceBody),
      };
    },
    async beginRenderArtifact(record) {
      calls.push({ method: "begin", record });
      return true;
    },
    async publishRenderExportInTransaction(transaction, record) {
      calls.push({ method: "publish", transaction, record });
      return true;
    },
    async failRenderArtifact(record) {
      calls.push({ method: "fail", record });
      return true;
    },
  };
  const store = {
    async getObjectStream() {
      return { body: Readable.from([sourceBody]) };
    },
    async putObjectStream(input) {
      const chunks = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), outputBody);
      return {
        byteSize: outputBody.length,
        contentType: "video/mp4",
        metadata: { ...input.metadata },
      };
    },
  };
  const service = new FootballApprovedRenderService({
    persistence,
    store,
    stagingRoot,
    async render(input) {
      assert.equal(input.plan.renderProfile, "quality");
      assert.equal(input.plan.aspectRatio, "9:16");
      await writeFile(input.outputPath, outputBody, { mode: 0o600 });
    },
    async probe() {
      return {
        streams: [{
          codec_type: "video",
          codec_name: "h264",
          width: 1080,
          height: 1920,
        }],
        format: { duration: "9.000" },
      };
    },
    hashFile() {
      return hash(outputBody);
    },
  });
  const transaction = { query() {} };
  const updates = [];
  try {
    const result = await service.renderApproved(job, {
      signal: new AbortController().signal,
      async update(patch) {
        updates.push(patch);
      },
      async completeAtomically(completion, mutation) {
        calls.push({ method: "complete", completion });
        await mutation(transaction);
        return { status: "completed" };
      },
    });
    assert.equal(result.checksumSha256, hash(outputBody));
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["begin", "complete", "publish"],
    );
    assert.equal(calls.at(-1).transaction, transaction);
    assert.equal(calls.at(-1).record.jobId, job.id);
    assert.equal(calls.at(-1).record.artifactId, result.artifactId);
    assert.deepEqual(updates, [
      { progress: 20, step: "rendering_approved_candidate" },
      { progress: 80, step: "uploading_approved_render" },
    ]);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test("approved output validation rejects non-production dimensions", () => {
  assert.throws(
    () => validateApprovedOutput({
      streams: [{
        codec_type: "video",
        codec_name: "h264",
        width: 540,
        height: 960,
      }],
      format: { duration: "9" },
    }),
    (error) => error.code === "RENDER_FAILED",
  );
});
