const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, readdir, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const {
  FootballAnalysisService,
} = require("../server/pipelines/football/analysis-service.cjs");

test("football analysis binds verified source signals to a new preview review", async () => {
  const root = await mkdtemp(join(tmpdir(), "football-analysis-test-"));
  const bytes = Buffer.from("verified-football-source");
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const calls = [];
  const service = new FootballAnalysisService({
    stagingRoot: root,
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    store: {
      async getObjectStream(key) {
        calls.push({ method: "getObjectStream", key });
        return { body: Readable.from(bytes) };
      },
    },
    persistence: {
      async getAvailableUploadArtifactOwnedBy(uploadId, ownerId) {
        calls.push({ method: "source", uploadId, ownerId });
        return {
          uploadId,
          projectId: "prj_12345678",
          storageKey: "source/opaque/object.mp4",
          contentType: "video/mp4",
          byteSize: bytes.length,
          checksumSha256,
          metadata: {
            durationSeconds: 24,
            width: 1920,
            height: 1080,
            hasAudio: true,
          },
        };
      },
      async getProjectOwnedBy(projectId, ownerId) {
        calls.push({ method: "project", projectId, ownerId });
        return {
          id: projectId,
          title: "Match",
          language: "auto",
          recordVersion: 2,
        };
      },
    },
    async extractMediaSignals(input) {
      calls.push({ method: "signals", inputPath: input.inputPath });
      return {
        durationSeconds: 24,
        width: 1920,
        height: 1080,
        hasAudio: true,
        audioPeaks: [],
        sceneChanges: [],
      };
    },
    detectHighlights(input) {
      calls.push({ method: "highlights", input });
      return { moments: [{ id: "mom_test", start: 2, end: 10 }] };
    },
    createCandidateEditPlans(input) {
      calls.push({ method: "plans", input });
      return [{ sourceStart: 2, sourceEnd: 10 }];
    },
    buildReviewCandidates(input) {
      calls.push({ method: "candidates", input });
      return [{ id: "candidate_server_only" }, { id: "candidate_alternate" }];
    },
    reviewRepository: {
      async createReviewAndEnqueuePreviews(input) {
        calls.push({ method: "review", input });
        return {
          review: { id: "fbr_12345678" },
          job: { id: "job_preview1" },
        };
      },
    },
  });
  const updates = [];
  try {
    const result = await service.analyze({
      id: "job_analysis1",
      ownerId: "usr_12345678",
      projectId: "prj_12345678",
      uploadId: "upl_12345678",
      traceparent: "00-test",
    }, {
      signal: new AbortController().signal,
      async update(patch) {
        updates.push(patch);
      },
    });
    assert.deepEqual(result, {
      reviewId: "fbr_12345678",
      previewJobId: "job_preview1",
      sourceRevision: result.sourceRevision,
      candidateCount: 2,
    });
    assert.match(result.sourceRevision, /^[a-f0-9]{64}$/);
    const review = calls.find((call) => call.method === "review").input;
    assert.equal(review.ownerId, "usr_12345678");
    assert.equal(review.sourceJobId, "job_analysis1");
    assert.equal(review.rightsConfirmed, true);
    assert.equal(review.candidates.length, 2);
    assert.deepEqual(updates, [
      { progress: 25, step: "analyzing_football_signals" },
      { progress: 80, step: "creating_football_review" },
    ]);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("football analysis rejects a source whose bytes do not match persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "football-analysis-test-"));
  const service = new FootballAnalysisService({
    stagingRoot: root,
    store: {
      async getObjectStream() {
        return { body: Readable.from(Buffer.from("wrong")) };
      },
    },
    persistence: {
      async getAvailableUploadArtifactOwnedBy() {
        return {
          projectId: "prj_12345678",
          storageKey: "source/opaque/object.mp4",
          contentType: "video/mp4",
          byteSize: 999,
          checksumSha256: "a".repeat(64),
          metadata: { durationSeconds: 10 },
        };
      },
      async getProjectOwnedBy() {
        return { title: "Match", recordVersion: 1 };
      },
    },
    reviewRepository: {},
  });
  try {
    await assert.rejects(
      service.analyze({
        id: "job_analysis1",
        ownerId: "usr_12345678",
        projectId: "prj_12345678",
        uploadId: "upl_12345678",
      }),
      (error) => error.code === "FILE_SIGNATURE_MISMATCH",
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
