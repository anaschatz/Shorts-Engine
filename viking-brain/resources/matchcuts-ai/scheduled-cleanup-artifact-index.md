# Scheduled Cleanup Worker + Artifact Index

Working product name: ShortsEngine.

Source files:

- `server/repositories/artifact-repository.cjs`: DB-ready local artifact index with validation, persisted JSON records and public no-leak views.
- `server/artifact-cleanup-worker.cjs`: scheduled/manual cleanup service for old temp artifacts.
- `server/adapters/local-persistence-adapter.cjs`: wires artifact index through the persistence adapter contract.
- `server/render-job.cjs`: indexes temporary render stages and committed rendered artifacts for recovery/cleanup visibility.
- `server/app.cjs`: exposes safe artifact index and cleanup readiness in `/health`.
- `scripts/run-real-cloud-integration.mjs`: opt-in real S3/R2 integration suite with deterministic skip behavior by default.
- `tests/artifact-cleanup-worker.test.cjs`: artifact index and cleanup worker regressions.
- `tests/real-cloud-integration.test.mjs`: real cloud integration skip-path regression.

Contracts:

- Routes and orchestration should not read or mutate raw artifact maps directly when a repository boundary exists.
- Cleanup candidates come from the artifact index, not from recursive filesystem/object-storage scans.
- Cleanup is temp-type only and must never delete uploads or completed renders/exports.
- Active queued/processing jobs protect their owned artifacts from scheduled deletion.
- Cleanup runs are dry-run capable, bounded by max age and max artifact count, and expose only safe aggregate health.
- Real cloud integration remains explicit through `MATCHCUTS_RUN_REAL_CLOUD_TESTS=1` plus S3/R2 credentials.

Limitations:

- Artifact index is still a local JSON/in-memory repository, not a real database table.
- Scheduled cleanup is disabled unless `MATCHCUTS_ARTIFACT_CLEANUP_INTERVAL_MS` is configured.
- Real cloud integration is not part of default tests because it needs external credentials/network.
