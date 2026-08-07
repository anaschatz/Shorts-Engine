# Football Human Review Beta

This slice adds a fail-closed football review path between uncertain analysis and a downloadable render. It is implemented for local development and the distributed production-beta runtime. It is not a claim that ShortsEngine is fully production-ready.

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

The local/SQLite adapters and PostgreSQL production runtime enforce quota and concurrency limits before direct generation, approved rendering and regeneration. Idempotent replay is checked first so a retry does not consume another slot. Candidate-plan caching is invalidated by the source SHA-256, planner version, evidence-contract version and material settings. `/health` reports only bounded cache/control/metrics health; it does not expose owner ids, source paths, tokens or high-cardinality labels.

The production runtime persists bounded usage/cost events and exposes bounded metrics; tests use a no-network memory adapter. Unknown provider rates remain unknown rather than being recorded as zero. A real external telemetry exporter and provider price coverage still require staging proof.

## Staging validation

1. Configure the strict staging profile from `docs/STAGING_DEPLOYMENT.md`: PostgreSQL persistence/queue, R2, OIDC and PostgreSQL telemetry.
2. Run the migration entrypoint and verify the immutable PostgreSQL migration chain before starting web or workers.
3. Start the web service and two independent workers with conservative render limits. Call `GET /health` and require ready status.
4. Upload a rights-cleared football fixture and generate a clip that produces `humanReviewGate.requiresReview: true`.
5. Verify the original export endpoint returns `FOOTBALL_REVIEW_REQUIRED`.
6. Create the review with the current project revision. Verify two to four candidates, bounded timestamps, no raw edit plan, and working short-lived preview delivery.
7. Submit a selection with `expectedVersion`, `expectedSourceRevision`, `candidateId` and a unique idempotency key. Replay the identical request and confirm the same render job id. Change the body while reusing the key and confirm a conflict.
8. Repeat with `reject_all` and verify no render is queued. Repeat with `regenerate` and verify a new analysis job is linked.
9. Mutate the project revision or replace the source checksum before deciding and confirm the stale write is rejected.
10. Attempt the same review with a second OIDC user and confirm every read/write/download returns the same non-enumerating response as a missing resource.
11. Let the approved render complete. Confirm only that approved render downloads, then inspect the durable review audit and job linkage.
12. Saturate per-user and global limits and confirm new work returns a safe `429` while an idempotent replay still succeeds.
13. Run the repository test, lint, build, release-readiness and staging smoke commands. Treat any skipped browser, object-storage, authentication or distributed-worker proof as an unclosed release risk.

## Remaining production blockers

- Real external OIDC login, managed PostgreSQL, private R2 and deployed Range delivery still need exact-SHA staging proof.
- Two deployed workers must demonstrate lease loss/recovery, retries, cancellation and dead-letter operation outside disposable CI.
- A real telemetry backend and provider price-book coverage must be verified; unknown cost is intentionally not reported as zero.
- Browser preview, approval and final download must be exercised end to end with two real users after a web restart.
