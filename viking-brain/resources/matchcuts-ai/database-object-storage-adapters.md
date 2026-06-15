# Database Adapter Interface + Object Storage Adapter Stub

Source files:

- `server/adapters/persistence-adapter.cjs`: required persistence methods and fail-closed contract validation.
- `server/adapters/artifact-adapter.cjs`: required artifact methods and fail-closed contract validation.
- `server/adapters/local-persistence-adapter.cjs`: local adapter around project/upload/export repositories.
- `server/adapters/local-artifact-adapter.cjs`: local object-storage-shaped adapter around `LocalArtifactStore`.
- `server/app.cjs`: wires local adapters into startup, upload/generate/download routes and health.
- `tests/adapter-contracts.test.cjs`: contract, capability, restore and no-leak regressions.

Contracts:

- Routes should depend on adapter-shaped persistence/artifact boundaries, not raw maps or filesystem paths.
- Persistence adapter capabilities include project/upload/export CRUD, public views, export path resolution, state restore and render/upload persistence.
- Artifact adapter capabilities include artifact record creation, public records, safe resolution, existence/stat checks, writes, availability transitions and allowed cleanup.
- Missing adapter capabilities throw `ADAPTER_CONTRACT_INVALID` before runtime work begins.
- Default mode remains local and dependency-free: no Postgres, Redis, S3, GCS or network dependency.
- `/health` reports adapter mode and capability booleans while omitting local paths, storage keys and output paths.

Limitations:

- Local persistence is still in-memory plus existing JSON state files.
- Object storage is still local filesystem-backed; signed URLs, streaming object downloads, bucket policies and retention rules are future work.
