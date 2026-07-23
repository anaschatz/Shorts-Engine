# Football Human Review Beta

This slice adds a fail-closed football review path between uncertain analysis and a downloadable render. It is intended for local and single-instance staging validation. It is not a claim that ShortsEngine is production-ready.

## Contract

- A completed clip job whose `humanReviewGate.requiresReview` is true cannot be downloaded as a final export.
- `POST /api/projects/:projectId/football-reviews` creates or replays a review for the current project revision and source checksum.
- The review exposes two to four bounded candidates. Public records contain only safe evidence summaries, framing summaries, timestamps, confidence and short-lived preview URLs; the full edit plan stays server-side.
- `POST /api/projects/:projectId/football-reviews/:reviewId/decision` accepts exactly one of `select`, `reject_all` or `regenerate`.
- A selection queues only the server-held plan bound to the candidate id. Rejection creates no render. Regeneration queues a fresh analysis job.
- Decisions require the owner, confirmed rights, the current review version, the current source revision and an idempotency key. Stale or conflicting writes fail closed.
- Every durable transition records actor, timestamp, from/to state, decision metadata and job linkage.
- An approved render receives a review binding and is the only downloadable output; approving a candidate never unlocks the uncertain source render.

## New runtime controls

```bash
MATCHCUTS_RENDER_QUOTA_PER_USER_PER_DAY=20
MATCHCUTS_RENDER_CONCURRENCY_PER_USER=2
MATCHCUTS_RENDER_CONCURRENCY_GLOBAL=4
MATCHCUTS_ANALYSIS_CACHE_TTL_MS=86400000
MATCHCUTS_ANALYSIS_CACHE_MAX_ENTRIES=500
```

The active local/SQLite runtime enforces the quota and concurrency limits before direct generation, approved rendering and regeneration. Idempotent replay is checked first so a retry does not consume another slot. Candidate-plan caching is invalidated by the source SHA-256, planner version, evidence-contract version and material settings. `/health` reports only bounded cache/control/metrics health; it does not expose owner ids, source paths, tokens or high-cardinality labels.

Metrics currently live in-process and cover queue latency, candidate-analysis duration, render duration, failures, retries and cache requests/hits. They are a safe instrumentation seam, not a durable telemetry backend. Provider billing integration is still required before `estimated_cost_usd` can be considered authoritative.

## Staging validation

1. Use `SHORTSENGINE_ENVIRONMENT=staging`, `SHORTSENGINE_AUTH_MODE=operator`, a strong secret-managed operator token, `MATCHCUTS_PERSISTENCE_ADAPTER=sqlite`, and object storage or an attached persistent disk.
2. Apply the SQLite migration through normal server startup and verify schema version 7. The PostgreSQL SQL file under `server/migrations/postgres/` is design groundwork only; there is no selectable PostgreSQL persistence/queue adapter yet.
3. Start with conservative render limits and call `GET /health`. Confirm the football review repository, execution controls, analysis cache and observability report ready.
4. Upload a rights-cleared football fixture and generate a clip that produces `humanReviewGate.requiresReview: true`.
5. Verify the original export endpoint returns `FOOTBALL_REVIEW_REQUIRED`.
6. Create the review with the current project revision. Verify two to four candidates, bounded timestamps, no raw edit plan, and working short-lived preview delivery.
7. Submit a selection with `expectedVersion`, `expectedSourceRevision`, `candidateId` and a unique idempotency key. Replay the identical request and confirm the same render job id. Change the body while reusing the key and confirm a conflict.
8. Repeat with `reject_all` and verify no render is queued. Repeat with `regenerate` and verify a new analysis job is linked.
9. Mutate the project revision or replace the source checksum before deciding and confirm the stale write is rejected.
10. Attempt the same review with another operator principal and confirm every read/write/download fails ownership checks.
11. Let the approved render complete. Confirm only that approved render downloads, then inspect the durable review audit and job linkage.
12. Saturate per-user and global limits and confirm new work returns a safe `429` while an idempotent replay still succeeds.
13. Run the repository test, lint, build, release-readiness and staging smoke commands. Treat any skipped browser, object-storage, authentication or distributed-worker proof as an unclosed release risk.

## Remaining production blockers

- The runtime queue is the existing single-process durable lease queue. The PostgreSQL `FOR UPDATE SKIP LOCKED` schema is not wired to a queue adapter, so multi-instance claiming has not been proven.
- Football review persistence is durable file storage in local mode. SQLite review tables exist as migration scaffolding but the review repository is not yet backed by transactional SQLite/PostgreSQL writes.
- Metrics and analysis cache are process-local. They reset on restart and do not coordinate across instances.
- OIDC/multi-user identity, managed database failover, object-storage integration, distributed cancellation/retry/dead-letter operations, and cost attribution still need staging proof.
- Preview playback in operator mode needs a browser authentication flow or a principal-bound delivery mechanism validated end to end.
