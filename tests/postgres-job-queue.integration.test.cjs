const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createPostgresPersistenceAdapter,
} = require("../server/adapters/postgres-persistence-adapter.cjs");
const {
  PostgresJobQueue,
} = require("../server/queue/postgres-job-queue.cjs");

const databaseUrl = String(process.env.TEST_POSTGRES_URL || "");

function id(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function cleanupQueueTestUsers(persistence) {
  const users = await persistence.query(
    "SELECT user_id FROM user_identities WHERE issuer = $1",
    ["https://queue-test.invalid/"],
  );
  const ownerIds = users.rows.map((row) => row.user_id);
  if (!ownerIds.length) return;
  await persistence.query(
    "DELETE FROM job_dead_letters WHERE owner_id = ANY($1::text[])",
    [ownerIds],
  );
  await persistence.query(
    "DELETE FROM idempotency_records WHERE owner_id = ANY($1::text[])",
    [ownerIds],
  );
  await persistence.query(
    "DELETE FROM jobs WHERE owner_id = ANY($1::text[])",
    [ownerIds],
  );
  await persistence.query(
    "DELETE FROM projects WHERE owner_id = ANY($1::text[])",
    [ownerIds],
  );
  await persistence.query(
    "DELETE FROM user_identities WHERE user_id = ANY($1::text[])",
    [ownerIds],
  );
  await persistence.query(
    "DELETE FROM users WHERE id = ANY($1::text[])",
    [ownerIds],
  );
}

test("PostgreSQL queue provides multi-worker claims, fencing, retries, DLQ and quotas", {
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
  await cleanupQueueTestUsers(persistence);

  const ownerA = id("usr");
  const ownerB = id("usr");
  const projectA = id("prj");
  const projectB = id("prj");
  await persistence.createUserFromIdentity({
    userId: ownerA,
    issuer: "https://queue-test.invalid/",
    subject: id("subject"),
  });
  await persistence.createUserFromIdentity({
    userId: ownerB,
    issuer: "https://queue-test.invalid/",
    subject: id("subject"),
  });
  await persistence.createProject({
    id: projectA,
    ownerId: ownerA,
    projectType: "football",
    title: "Queue A",
  });
  await persistence.createProject({
    id: projectB,
    ownerId: ownerB,
    projectType: "football",
    title: "Queue B",
  });

  const workerA = new PostgresJobQueue({
    persistenceAdapter: persistence,
    config: { worker: { leaseMs: 60_000 } },
    workerId: "worker-a",
    maxRetries: 3,
    dailyRenderQuota: 10,
    ownerConcurrency: 2,
  });
  const workerB = new PostgresJobQueue({
    persistenceAdapter: persistence,
    config: { worker: { leaseMs: 60_000 } },
    workerId: "worker-b",
    maxRetries: 3,
    dailyRenderQuota: 10,
    ownerConcurrency: 2,
  });

  try {
    const first = await workerA.enqueue({
      ownerId: ownerA,
      projectId: projectA,
      action: "validate_upload",
      pipelineType: "upload",
      payload: { alpha: 1, beta: 2 },
    }, { idempotencyKey: "first" });
    const replay = await workerB.enqueue({
      ownerId: ownerA,
      projectId: projectA,
      action: "validate_upload",
      pipelineType: "upload",
      payload: { beta: 2, alpha: 1 },
    }, { idempotencyKey: "first" });
    assert.equal(replay.replayed, true);
    assert.equal(replay.job.id, first.job.id);
    await assert.rejects(
      workerB.enqueue({
        ownerId: ownerA,
        projectId: projectA,
        action: "validate_upload",
        pipelineType: "upload",
        payload: { alpha: 99 },
      }, { idempotencyKey: "first" }),
      (error) => error.code === "IDEMPOTENCY_CONFLICT",
    );

    await workerA.enqueue({
      ownerId: ownerB,
      projectId: projectB,
      action: "validate_upload",
      pipelineType: "upload",
    });
    const [claimA, claimB] = await Promise.all([
      workerA.claimNext(),
      workerB.claimNext(),
    ]);
    assert.ok(claimA);
    assert.ok(claimB);
    assert.notEqual(claimA.job.id, claimB.job.id);
    await workerA.heartbeat(claimA.job, claimA.lease);
    await workerA.complete(claimA.job, { result: { worker: "a" } }, claimA.lease);
    await workerB.complete(claimB.job, { result: { worker: "b" } }, claimB.lease);

    const reclaim = await workerA.enqueue({
      ownerId: ownerA,
      projectId: projectA,
      action: "validate_upload",
      pipelineType: "upload",
    });
    const staleClaim = await workerA.claim(reclaim.job.id, { leaseMs: 10_000 });
    await persistence.query(
      "UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [reclaim.job.id],
    );
    const recoveredClaim = await workerB.claim(reclaim.job.id);
    assert.equal(recoveredClaim.job.id, reclaim.job.id);
    assert.equal(recoveredClaim.lease.attempt, staleClaim.lease.attempt + 1);
    await assert.rejects(
      workerA.complete(staleClaim.job, {}, staleClaim.lease),
      (error) => error.code === "JOB_LEASE_INVALID",
    );
    await workerB.complete(recoveredClaim.job, {}, recoveredClaim.lease);

    const retryRecord = await workerA.enqueue({
      ownerId: ownerA,
      projectId: projectA,
      action: "validate_upload",
      pipelineType: "upload",
    });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const active = await workerA.claim(retryRecord.job.id);
      const retried = await workerA.retry(
        active.job,
        Object.assign(new Error("private provider response"), { code: "PROVIDER_FAILED" }),
        active.lease,
        { baseMs: 100 },
      );
      if (attempt < 4) {
        assert.equal(retried.status, "queued");
        await persistence.query(
          "UPDATE jobs SET next_retry_at = clock_timestamp() WHERE id = $1",
          [retryRecord.job.id],
        );
      } else {
        assert.equal(retried.status, "failed");
      }
    }
    const deadLetters = await workerA.inspectDeadLetters();
    assert.ok(deadLetters.some((entry) => entry.jobId === retryRecord.job.id));
    const redriven = await workerA.redriveDeadLetter({
      jobId: retryRecord.job.id,
      operatorId: "queue-test",
    });
    assert.equal(redriven.status, "queued");
    await workerA.cancel(retryRecord.job.id, { ownerId: ownerA });

    const cancelledRecord = await workerA.enqueue({
      ownerId: ownerA,
      projectId: projectA,
      action: "validate_upload",
      pipelineType: "upload",
    });
    await assert.rejects(
      workerA.cancel(cancelledRecord.job.id, { ownerId: ownerB }),
      (error) => error.code === "JOB_NOT_FOUND",
    );
    assert.equal(
      (await workerA.cancel(cancelledRecord.job.id, { ownerId: ownerA })).status,
      "cancelled",
    );

    const activeCancellation = await workerA.enqueue({
      ownerId: ownerA,
      projectId: projectA,
      action: "validate_upload",
      pipelineType: "upload",
    });
    const activeCancellationClaim = await workerA.claim(activeCancellation.job.id);
    assert.equal(
      (await workerA.cancel(activeCancellation.job.id, { ownerId: ownerA })).status,
      "processing",
    );
    assert.ok(
      (await workerA.heartbeat(
        activeCancellationClaim.job,
        activeCancellationClaim.lease,
      )).cancelRequestedAt,
    );
    assert.equal(
      (await workerA.complete(
        activeCancellationClaim.job,
        { result: { mustNotPublish: true } },
        activeCancellationClaim.lease,
      )).status,
      "cancelled",
    );

    const quotaQueue = new PostgresJobQueue({
      persistenceAdapter: persistence,
      config: { worker: { leaseMs: 60_000 } },
      dailyRenderQuota: 1,
    });
    const quotaJob = await quotaQueue.enqueue({
      ownerId: ownerB,
      projectId: projectB,
      action: "render",
      pipelineType: "football",
    });
    await assert.rejects(
      quotaQueue.enqueue({
        ownerId: ownerB,
        projectId: projectB,
        action: "render",
        pipelineType: "football",
      }),
      (error) => error.code === "RENDER_QUOTA_EXCEEDED",
    );
    await quotaQueue.cancel(quotaJob.job.id, { ownerId: ownerB });

    const concurrencyQueue = new PostgresJobQueue({
      persistenceAdapter: persistence,
      config: { worker: { leaseMs: 60_000 } },
      dailyRenderQuota: 10,
      ownerConcurrency: 1,
    });
    const renderOne = await concurrencyQueue.enqueue({
      ownerId: ownerA,
      projectId: projectA,
      action: "render",
      pipelineType: "football",
    });
    const renderTwo = await concurrencyQueue.enqueue({
      ownerId: ownerA,
      projectId: projectA,
      action: "render",
      pipelineType: "football",
    });
    const concurrentClaims = await Promise.all([
      concurrencyQueue.claimNext({ workerId: "concurrency-a" }),
      concurrencyQueue.claimNext({ workerId: "concurrency-b" }),
    ]);
    const activeClaims = concurrentClaims.filter(Boolean);
    assert.equal(activeClaims.length, 1);
    const activeRender = activeClaims[0];
    assert.ok([renderOne.job.id, renderTwo.job.id].includes(activeRender.job.id));
    await concurrencyQueue.complete(activeRender.job, {}, activeRender.lease);
    assert.ok(await concurrencyQueue.claimNext());
    const health = await concurrencyQueue.health();
    assert.equal(health.ready, true);
    assert.equal(health.workerRuntime.multiWorkerSafe, true);
  } finally {
    await cleanupQueueTestUsers(persistence).catch(() => {});
    await persistence.close();
  }
});
