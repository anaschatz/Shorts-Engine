# Production Persistence Foundation

Source files:

- `server/storage/artifact-store.cjs`: local artifact contracts, safe storage keys, type/status validation, controlled deletion.
- `server/adapters/artifact-adapter.cjs`: artifact adapter contract and capability checks.
- `server/adapters/persistence-adapter.cjs`: database-facing persistence adapter contract and capability checks.
- `server/adapters/local-artifact-adapter.cjs`: local object-storage stub around the filesystem artifact store.
- `server/adapters/local-persistence-adapter.cjs`: local persistence adapter around in-memory repositories.
- `server/repositories/project-repository.cjs`: project repository boundary.
- `server/repositories/upload-repository.cjs`: upload repository boundary and public upload view.
- `server/repositories/export-repository.cjs`: export repository boundary, completed-export enforcement, path-safe public view.
- `server/repositories/project-state.cjs`: project/upload/render rehydration and persistence helpers.
- `tests/persistence-foundation.test.cjs`: artifact and repository boundary regressions.
- `tests/adapter-contracts.test.cjs`: adapter contract, health and no-leak regressions.

Contracts:

- Keep local filesystem and in-memory maps for now; do not introduce Postgres, Redis, S3, or cloud storage in this milestone.
- Use explicit adapter contracts so future DB/object-storage implementations can replace local defaults without rewriting routes.
- Adapter contract validation must fail closed when required capabilities are missing.
- Adapter health must expose mode/capability metadata only, not absolute paths, storage keys or output paths.
- Treat artifact `storageKey` as internal metadata and absolute paths as internal-only runtime values.
- Object-storage-like adapters must never expose permanent local paths; FFmpeg receives explicit local staging paths only.
- Local mode can use stable render paths, but cloud/mock-cloud modes must stage inputs/outputs under configured staging storage and clean staging files after commit/failure.
- Upload artifacts are written as `staging` and become `available` only after media probing succeeds.
- Staging upload artifacts are deleted when media probing fails.
- Artifact records validate ids, storage keys, sizes, buffer inputs, types and statuses at the boundary.
- Repository records reject path/storage-key mismatches so metadata cannot point at one artifact while runtime reads another path.
- Export records are created only after a render artifact exists as a file.
- Repositories expose public views that omit raw paths, storage keys and secrets.
- `/health` reports repository and artifact readiness using aggregate counts only.
- `server/app.cjs` should delegate record persistence to repositories and artifact resolution to `LocalArtifactStore`.
- `server/render-job.cjs` can accept repositories/adapters but must keep map fallback behavior for focused tests.

Limitations:

- This is not yet a database-backed implementation.
- The object-storage adapter is still a local filesystem stub, not S3/GCS/R2.
- Distributed workers, cleanup retention, quotas, signed download URLs, transactions and cross-process locking remain future milestones.
