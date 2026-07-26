# Stage 2 production hardening

Date: 2026-07-26

## Readiness status

The codebase has a production topology and reproducible disposable integration
environment. It is **not yet declared production-ready** because this machine
does not provide Docker, a running PostgreSQL service, an S3-compatible test
service, external OIDC credentials, or a real staging deployment. Unit and
contract verification is recorded below; the external proof must still run in
CI or staging.

## Architecture

```text
Browser
  |
  v
Node web process ---- OIDC provider
  |       |
  |       +---- PostgreSQL sessions, ownership and audit
  |
  +---- PostgreSQL jobs/reviews/quotas/metrics/costs
  |
  +---- S3-compatible object storage
              ^
              |
      worker-a / worker-b
      PostgreSQL SKIP LOCKED claims
```

Node remains the control plane. Python remains behind the versioned v1 worker
contract for analysis, ranking, HookGate, rendering and media QA. No new video
style or automatic publishing path was added.

Production, staging and migration processes:

```text
npm run start:production
npm run start:worker
npm run start:migrate
```

Production configuration fails closed unless PostgreSQL persistence and queue,
OIDC, R2 storage and PostgreSQL telemetry are selected. Secrets are accepted
only from runtime environment variables and are excluded from public config,
health output and safe errors.

## Database schema and migrations

Canonical immutable migrations:

1. identity, sessions and audit;
2. projects, uploads, artifacts, exports and idempotency;
3. durable jobs, leases and dead letters;
4. football reviews, candidates, decisions and immutable review audit;
5. multipart sessions, cleanup operations and delivery grants;
6. deterministic cache, provider usage and cost rollups;
7. project memberships, durable attempt history, quota policies, per-job cost
   records and durable metric events/views.

Migration 0007 also backfills an owner membership for each existing project.
Binary video data is never stored in PostgreSQL.

## Queue semantics

- Claims use a short transaction and `FOR UPDATE ... SKIP LOCKED`.
- Every processing mutation is fenced by job ID, worker ID, lease ID, attempt
  and a non-expired database-time lease.
- A reclaimed job closes the old attempt as `lease_expired` and creates a new
  durable attempt row.
- Heartbeats update the job lease and attempt history atomically.
- Retries use deterministic exponential backoff with bounded jitter.
- Exhausted jobs enter the dead-letter table.
- Cancellation is owner-scoped, audited and observed during processing.
- Graceful shutdown stops new claims and leaves unfinished work recoverable by
  lease expiry.
- Per-user and global concurrency are enforced in the claim transaction.
- Daily/monthly render limits and attributed provider budget are enforced in
  the enqueue transaction. Owner quota policies may reduce these defaults but
  cannot raise the global upload-size or source-duration ceilings.
- Completion, failure and cancellation create/update a durable job cost record.

## Authentication and authorization

OIDC uses Authorization Code + PKCE, state and nonce. The internal user is
stable across logins through the unique issuer/subject mapping. Only a hash of
the opaque session token is persisted. Sessions have absolute and idle expiry;
mutating cookie-authenticated requests require origin and session-bound CSRF
validation.

API ownership comes exclusively from the authenticated principal. Request body
user IDs are ignored. Project/resource lookups include owner scope and foreign
resources use the same not-found response as missing resources.

Preview/export delivery uses owner-bound, short-lived, hashed delivery grants
and an authenticated application proxy with HTTP Range support. Reusable raw
object-store URLs are not returned.

## Object-storage lifecycle

```text
staging -> validating -> available -> delete_pending -> deleted
                       \-> failed
```

Object keys are generated from opaque owner/artifact identifiers, not
filenames. Multipart parts are bounded and contiguous. Upload completion checks
object size before queueing validation; the validation worker streams SHA-256,
checks the media signature and duration, then publishes metadata transactionally.
Failures create durable abort/delete operations. Previews and exports use
separate retention settings.

The disposable integration test creates two independent storage clients and
proves that an object written by one can be ranged/read and deleted by the
other.

## Quotas and cost model

Typed server-side limits cover:

- maximum upload bytes and source duration;
- daily and monthly render counts;
- per-user and global active render concurrency;
- monthly attributed provider budget;
- analysis and render timeouts;
- maximum attempts and retry base interval;
- staging, preview, export and metric retention.

`provider_usage_events` remains append-only. Unknown prices remain `NULL`, not
zero. `job_cost_records.final_cost_usd` is populated only at complete cost
coverage; otherwise the estimated cost and coverage remain explicit.

## Durable telemetry

Production uses the PostgreSQL observability adapter. Metric names and label
keys are allowlisted. User, project and job identifiers are never metric
labels. Raw identifiers may be used only for trace/log correlation. Worker
outcomes persist queue wait, processing time, success/failure, retry,
dead-letter and fully attributed per-video cost observations. Queue health
persists bounded queued/processing depth observations, and quota denials are
recorded by category.

Useful queries:

```sql
SELECT * FROM production_job_outcomes ORDER BY pipeline_type;

SELECT metric_name, labels_json, sample_count, p50, p95
FROM production_metric_summary
ORDER BY metric_name, labels_json;

SELECT pipeline_type, completed,
       avg(final_cost_usd) AS average_fully_attributed_cost
FROM job_cost_records
GROUP BY pipeline_type, completed;

SELECT count(*) AS active_dead_letters
FROM job_dead_letters
WHERE resolved_at IS NULL;
```

Readiness combines web/worker role, database, queue, OIDC, storage and durable
telemetry health.

## Human review

The production football flow keeps 2–4 distinct candidate previews. Review
decisions bind owner, review version, source revision, candidate ID, plan hash
and idempotency key. Selection and render enqueue share one PostgreSQL
transaction. Stale, cross-project, rejected and duplicate decisions fail
closed. The approved render publishes only the exact approved candidate
artifact/hash under the active job lease.

## Reproducible verification

Fast gates:

```text
npm run lint
npm run build
npm test
python -m unittest discover -s tests -v
python scripts/run_python_tests_isolated.py
python research/eval.py
```

Local results for the final working tree:

- static lint: passed;
- build smoke: passed;
- Node: 1,620 tests, 1,613 passed, 7 integration/explicit-flag skips,
  0 failed and 0 cancelled;
- Python unit suite: 496 passed;
- isolated Python modules: 50/50 passed;
- offline HookGate evaluation: quality score 96.2981 with all hard
  guardrails passing.

Disposable PostgreSQL/S3 integration:

```text
docker compose -f compose.production-test.yml up -d --wait
npm run integration:production
docker compose -f compose.production-test.yml down --volumes
```

The runner writes a sanitized reduced proof to
`release/results/stage2-local-integration-proof.json`. The report deliberately
keeps `productionReady=false` until external OIDC and real staging are proven.
The disposable integration command was not executable on this workstation
because Docker/Podman and an S3-compatible service are absent. A native
PostgreSQL 16 cluster was also attempted, but the execution sandbox denied the
required shared-memory operation and the permission escalation timed out
twice. No passing integration report was fabricated.

## Tested failure scenarios

- concurrent workers and no duplicate claim;
- stale lease recovery and stale-worker fencing;
- retryable and permanent worker failures;
- queued and in-process cancellation;
- duplicate idempotency key and conflicting replay;
- daily/monthly/provider and concurrency limits;
- malformed or expired OIDC transaction/session;
- cross-user resource lookup;
- object-size/checksum/signature mismatch;
- storage provider failure and durable cleanup;
- stale review revision, invalid candidate and duplicate approval;
- processing timeout and graceful worker shutdown;
- migration rerun, checksum mismatch and rollback.

## Deployment

1. Provision one PostgreSQL database and one private S3-compatible bucket.
2. Run `npm run start:migrate` using the release image and exact commit.
3. Deploy the web process with role `web`.
4. Deploy at least two identical worker processes with unique worker IDs.
5. Configure the OIDC callback and allowed application origin.
6. Inject credentials only through the platform secret manager.
7. Run the full staging proof with two real accounts and a rights-cleared media
   fixture.
8. Promote traffic only when readiness and the exact-commit proof pass.

## Rollback

Application rollback is performed by deploying the previous tested image/commit.
Do not delete or edit applied migration files. Migration 0007 is additive, so
the previous application can continue using migrations 0001–0006 while the new
tables remain unused. Stop workers before rollback, allow active leases to
expire, deploy the previous workers, and verify queue/readiness before restoring
web traffic. Object cleanup continues from durable storage operations; never
delete the bucket as part of application rollback.

## Remaining production risks

- Real PostgreSQL and S3 integration were not executable on this machine;
  PostgreSQL initialization was explicitly attempted and blocked by the
  execution sandbox's shared-memory restriction.
- External OIDC issuer/audience/callback behavior is covered by deterministic
  tests but not by a real provider proof.
- A full deployed staging run with real restarts and a rights-cleared video has
  not yet passed.
- Provider/model usage and actual billing reconciliation need real credentials
  and price-book data.
- Operational alert routing and dashboard provisioning remain deployment tasks.

Until those items pass for the exact commit, the system is production-shaped
and integration-ready, but not production-ready.
