# Production Beta Plan

ShortsEngine must not call itself a production beta based only on local fixtures or a successful render. The `/health` response exposes a `productionBeta` gate with seven independent checks. Every check must pass.

## 1. Rights-cleared evaluation

Create `eval/beta-dataset.json` from `eval/beta-dataset.example.json` with 20-50 distinct matches. Every entry must record:

- explicit `rightsConfirmed: true`
- terminal `renderStatus`
- a human rubric through `reviewRef` or an inline `review`
- whether the first generated clip was `acceptedWithoutEdit`
- measured `costUsd` for that video

Run:

```bash
npm run eval:beta
```

The report is written to `eval/results/beta-latest.json`. It aggregates moment selection, framing, caption alignment, pacing, overall quality, false-goal rate, render failure rate, first-pass acceptance and cost per completed video. Missing labels remain missing; the runner does not infer successful outcomes or zero cost.

## 2. Ambiguous-goal review

Every render receives a `humanReviewGate`. Unconfirmed goals, uncertain score changes and counted goals missing visual support set:

```json
{
  "requiresReview": true,
  "previewPolicy": "allowed",
  "publishingPolicy": "human_approval_required"
}
```

This allows an operator to inspect the preview while preventing downstream publishing from treating it as automatically approved. The existing human-review UI and regeneration approval flow remain the approval surfaces.

## 3. Infrastructure boundary

The repository now implements the production contracts: PostgreSQL persistence,
transactional multi-worker claims, fenced leases, S3/R2 multipart artifacts,
session-bound delivery, OIDC identity/session handling and durable usage events.
The disposable production integration workflow proves PostgreSQL/S3 worker and
ownership behavior at the exact commit SHA.

This is not external production proof. The remaining gate is a protected deployment
of that exact SHA using managed PostgreSQL, private R2, a real OIDC provider, two
independent workers and a durable telemetry backend. SQLite, local storage and
operator authentication remain development tools and are rejected by the strict
staging/production composition root.

### Migration compatibility boundary

The canonical PostgreSQL chain is `0001_identity_sessions_audit.sql` through
`0007_production_controls_telemetry.sql`. The runner serializes concurrent runs,
stores checksums and rejects any version, name or checksum mismatch.

The earlier `0001_production_beta.sql` prototype is not an upgrade base for this
chain. Repository deployment records show no staging deployment after that legacy
file entered `main`, so the production-beta environment remains greenfield. If an
operator discovers an external database with the legacy migration applied, they
must stop: do not rename, replace or replay migrations. Preserve the database and
prepare a reviewed additive migration path before deploying this release.

## 4. Exit criteria

Default thresholds are:

- at least 20 and at most 50 rights-cleared matches
- at least 70% accepted without manual edit
- no more than 1% false-goal rate
- no more than 5% render failure rate
- at least 4/5 average for selection, framing, captions, pacing and overall quality
- measured cost coverage for 100% of attempted videos

Thresholds may be tightened in the dataset manifest. Lowering them should require an explicit product decision and a reviewed change.
