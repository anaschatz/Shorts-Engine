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

The current repository already provides S3/R2 object storage, repository contracts, leased jobs, retry recovery and worker supervision. Production beta still requires:

1. A real Postgres persistence adapter implementing the existing persistence contract and transactional job claims.
2. Postgres-backed multi-worker queue claims; process-local notification may be added for latency, but Postgres remains the durable source of truth.
3. S3/R2 storage with lifecycle policy and tested signed delivery.
4. OIDC/account identity mapped to the existing `ownerId` authorization boundary.

SQLite and an operator token remain valid local/staging tools, but the production-beta gate intentionally rejects them.

## 4. Exit criteria

Default thresholds are:

- at least 20 and at most 50 rights-cleared matches
- at least 70% accepted without manual edit
- no more than 1% false-goal rate
- no more than 5% render failure rate
- at least 4/5 average for selection, framing, captions, pacing and overall quality
- measured cost coverage for 100% of attempted videos

Thresholds may be tightened in the dataset manifest. Lowering them should require an explicit product decision and a reviewed change.
