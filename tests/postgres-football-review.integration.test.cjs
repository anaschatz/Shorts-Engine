const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

const {
  createPostgresPersistenceAdapter,
} = require("../server/adapters/postgres-persistence-adapter.cjs");
const {
  buildFootballReviewCandidates,
} = require("../server/pipelines/football/review/candidate-builder.cjs");
const {
  PostgresFootballReviewRepository,
} = require("../server/pipelines/football/review/postgres-review-repository.cjs");
const {
  PostgresJobQueue,
} = require("../server/queue/postgres-job-queue.cjs");

const databaseUrl = String(process.env.TEST_POSTGRES_URL || "");
const issuer = "https://football-review-test.invalid/";

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

async function cleanup(persistence) {
  const owners = await persistence.query(
    "SELECT user_id FROM user_identities WHERE issuer = $1",
    [issuer],
  );
  const ownerIds = owners.rows.map((row) => row.user_id);
  if (!ownerIds.length) return;
  const tables = [
    ["delivery_grants", "owner_id"],
    ["storage_operations", "owner_id"],
    ["artifact_references", "owner_id"],
    ["football_review_audit", "owner_id"],
    ["football_review_decisions", "owner_id"],
    ["football_review_candidates", "owner_id"],
    ["football_reviews", "owner_id"],
    ["job_dead_letters", "owner_id"],
    ["idempotency_records", "owner_id"],
    ["exports", "owner_id"],
    ["jobs", "owner_id"],
    ["upload_sessions", "owner_id"],
    ["uploads", "owner_id"],
    ["artifacts", "owner_id"],
    ["projects", "owner_id"],
    ["sessions", "user_id"],
    ["user_identities", "user_id"],
    ["users", "id"],
  ];
  await persistence.withTransaction(async (transaction) => {
    await transaction.query("SET CONSTRAINTS ALL DEFERRED");
    for (const [table, column] of tables) {
      await transaction.query(
        `DELETE FROM ${table} WHERE ${column} = ANY($1::text[])`,
        [ownerIds],
      );
    }
  });
}

async function createSource(persistence, queue, ownerId, suffix = "") {
  const projectId = id("prj");
  const uploadId = id("upl");
  const artifactId = id("art");
  await persistence.createProject({
    id: projectId,
    ownerId,
    projectType: "football",
    title: `Review ${suffix}`,
  });
  await persistence.query(
    `INSERT INTO artifacts(
       id, owner_id, owner_project_id, type, status, storage_key,
       content_type, byte_size, checksum_sha256, metadata_json
     )
     VALUES (
       $1, $2, $3, 'upload', 'available', $4,
       'video/mp4', 1024, $5, $6::jsonb
     )`,
    [
      artifactId,
      ownerId,
      projectId,
      `source/test/${artifactId}.mp4`,
      "a".repeat(64),
      JSON.stringify({ durationSeconds: 60 }),
    ],
  );
  await persistence.query(
    `INSERT INTO uploads(
       id, owner_id, project_id, artifact_id, status, original_filename,
       mime_type, byte_size, checksum_sha256, metadata_json
     )
     VALUES (
       $1, $2, $3, $4, 'available', 'source.mp4',
       'video/mp4', 1024, $5, $6::jsonb
     )`,
    [
      uploadId,
      ownerId,
      projectId,
      artifactId,
      "a".repeat(64),
      JSON.stringify({ durationSeconds: 60 }),
    ],
  );
  await persistence.query(
    "UPDATE projects SET upload_id = $3, status = 'ready' WHERE id = $1 AND owner_id = $2",
    [projectId, ownerId, uploadId],
  );
  const source = await queue.enqueue({
    ownerId,
    projectId,
    uploadId,
    action: "football_analysis",
    pipelineType: "football",
    payload: { rightsConfirmed: true },
  });
  await persistence.query(
    `UPDATE jobs
     SET status = 'completed', progress = 100, step = 'completed',
         completed_at = clock_timestamp()
     WHERE id = $1`,
    [source.job.id],
  );
  return {
    projectId,
    uploadId,
    sourceUploadId: uploadId,
    sourceJobId: source.job.id,
    sourceRevision: "b".repeat(64),
  };
}

function candidatesFor(source) {
  return buildFootballReviewCandidates({
    projectId: source.projectId,
    sourceJobId: source.sourceJobId,
    sourceRevision: source.sourceRevision,
    sourceDurationSeconds: 60,
    candidatePlans: [{
      sourceStart: 10,
      sourceEnd: 25,
      confidence: 0.74,
      highlightType: "possible_goal",
      reasonCodes: ["goal_uncertain"],
      cropPlan: {
        mode: "wide_safe",
        confidence: 0.74,
        fallbackUsed: true,
      },
    }],
  });
}

async function makeReviewReady(repository, ownerId, created) {
  let current = created.review;
  for (const candidate of created.review.candidates.slice(0, 2)) {
    const artifactId = id("art");
    const checksumSha256 = candidate.planHash;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await repository.beginCandidatePreview({
      ownerId,
      reviewId: created.review.id,
      candidateId: candidate.id,
      artifactId,
      storageKey: `preview/test/${artifactId}.mp4`,
      expiresAt,
      jobId: created.job.id,
    });
    current = await repository.publishCandidatePreview({
      ownerId,
      reviewId: created.review.id,
      candidateId: candidate.id,
      artifactId,
      checksumSha256,
      byteSize: 2048,
      durationSeconds: candidate.durationSeconds,
      expiresAt,
      manifest: {
        schemaVersion: 1,
        candidateId: candidate.id,
        sourceRevision: created.review.sourceRevision,
        planHash: candidate.planHash,
        checksumSha256,
        durationSeconds: candidate.durationSeconds,
        width: 540,
        height: 960,
        fps: 24,
        videoCodec: "h264",
        audioCodec: "aac",
        byteSize: 2048,
      },
    });
  }
  return current;
}

test("PostgreSQL football review binds real previews and decides with render enqueue atomically", {
  skip: databaseUrl ? false : "TEST_POSTGRES_URL is not configured",
  timeout: 60_000,
}, async () => {
  const persistence = await createPostgresPersistenceAdapter({
    config: {
      postgres: {
        url: databaseUrl,
        sslMode: "disable",
        transactionTimeoutMs: 60_000,
      },
    },
    logger: null,
  });
  await persistence.migrate();
  await cleanup(persistence);
  const ownerId = id("usr");
  const foreignOwnerId = id("usr");
  await persistence.createUserFromIdentity({
    userId: ownerId,
    issuer,
    subject: id("subject"),
  });
  await persistence.createUserFromIdentity({
    userId: foreignOwnerId,
    issuer,
    subject: id("subject"),
  });
  const queue = new PostgresJobQueue({
    persistenceAdapter: persistence,
    dailyRenderQuota: 10,
  });
  const repository = new PostgresFootballReviewRepository({
    persistenceAdapter: persistence,
    jobQueue: queue,
  });
  try {
    const source = await createSource(persistence, queue, ownerId, "atomic");
    const created = await repository.createReviewAndEnqueuePreviews({
      ownerId,
      ...source,
      projectRevision: 1,
      rightsConfirmed: true,
      candidates: candidatesFor(source),
    });
    assert.equal(created.review.status, "preparing");
    assert.equal(created.job.action, "football_review_preview_batch");
    const ready = await makeReviewReady(repository, ownerId, created);
    assert.equal(ready.status, "pending");
    assert.equal(ready.version, 2);
    assert.equal(
      ready.candidates.filter((candidate) => candidate.preview.status === "ready").length,
      2,
    );

    let foreignError;
    let missingError;
    await repository.getOwnedReview(created.review.id, foreignOwnerId)
      .catch((error) => { foreignError = error; });
    await repository.getOwnedReview(`fbr_${randomUUID()}`, foreignOwnerId)
      .catch((error) => { missingError = error; });
    assert.deepEqual(
      [foreignError.code, foreignError.status, foreignError.message],
      [missingError.code, missingError.status, missingError.message],
    );

    const selected = ready.candidates.find(
      (candidate) => candidate.preview.status === "ready",
    );
    const decisionInput = {
      ownerId,
      reviewId: ready.id,
      expectedVersion: ready.version,
      expectedSourceRevision: ready.sourceRevision,
      action: "select",
      candidateId: selected.id,
      idempotencyKey: `decision-${randomUUID()}`,
    };
    const decided = await repository.decideAndEnqueueReview(decisionInput);
    assert.equal(decided.replayed, false);
    assert.equal(decided.review.status, "selected");
    assert.equal(decided.review.selectedCandidateId, selected.id);
    assert.equal(decided.job.action, "render_approved_candidate");
    assert.equal(
      decided.job.payload.footballReviewApproval.planHash,
      selected.planHash,
    );
    const replay = await repository.decideAndEnqueueReview(decisionInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.job.id, decided.job.id);

    const rollbackSource = await createSource(
      persistence,
      queue,
      ownerId,
      "rollback",
    );
    const rollbackCreated = await repository.createReviewAndEnqueuePreviews({
      ownerId,
      ...rollbackSource,
      projectRevision: 1,
      rightsConfirmed: true,
      candidates: candidatesFor(rollbackSource),
    });
    const rollbackReady = await makeReviewReady(
      repository,
      ownerId,
      rollbackCreated,
    );
    const failingRepository = new PostgresFootballReviewRepository({
      persistenceAdapter: persistence,
      jobQueue: {
        async enqueueInTransaction() {
          throw new Error("injected enqueue failure");
        },
      },
    });
    const rollbackKey = `decision-${randomUUID()}`;
    await assert.rejects(
      failingRepository.decideAndEnqueueReview({
        ownerId,
        reviewId: rollbackReady.id,
        expectedVersion: rollbackReady.version,
        expectedSourceRevision: rollbackReady.sourceRevision,
        action: "select",
        candidateId: rollbackReady.candidates.find(
          (candidate) => candidate.preview.status === "ready",
        ).id,
        idempotencyKey: rollbackKey,
      }),
      (error) => error.code === "DB_TRANSACTION_FAILED",
    );
    const unchanged = await repository.getOwnedReview(
      rollbackReady.id,
      ownerId,
    );
    assert.equal(unchanged.status, "pending");
    const idempotency = await persistence.query(
      `SELECT count(*)::integer AS count
       FROM idempotency_records
       WHERE owner_id = $1
         AND scope = 'football-review-decision'
         AND key = $2`,
      [ownerId, rollbackKey],
    );
    assert.equal(Number(idempotency.rows[0].count), 0);
  } finally {
    await cleanup(persistence).catch(() => {});
    await persistence.close();
  }
});
