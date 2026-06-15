# Production Risk Reduction Pass - 2026-06-15

Working product name: ShortsEngine.

Scope:

- Tightened server numeric config validation in `server/config.cjs`.
- Tightened artifact index path validation in `server/repositories/artifact-repository.cjs`.
- Added focused regressions in `tests/cloud-storage-staging.test.cjs`.
- Added focused regressions in `tests/artifact-cleanup-worker.test.cjs`.

Contracts:

- Numeric env config must fail closed instead of allowing `NaN` into runtime paths.
- Ports, upload size, media duration, timeout and retry settings must have bounded defaults.
- Artifact repository records may keep internal `path` metadata, but only after validating it is inside the storage area for that artifact type.
- Public artifact views must still omit paths and storage keys.
- Corrupt or unsafe persisted artifact metadata should be ignored or rejected safely.

Limitations:

- This is still local JSON/in-memory persistence, not a database-backed repository.
- A future DB adapter should enforce the same path/storage-key invariants at adapter contract boundaries.
