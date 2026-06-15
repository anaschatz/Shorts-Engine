# Real S3/R2/GCS Adapter + FFmpeg Local Staging Strategy

Source files:

- `server/config.cjs`: storage adapter mode/config validation and staging root.
- `server/storage.cjs`: configured `staging` storage area.
- `server/storage/artifact-store.cjs`: local artifact store with staging methods.
- `server/adapters/artifact-adapter.cjs`: artifact adapter contract including staging, commit and cleanup methods.
- `server/adapters/object-storage-adapter.cjs`: adapter factory and cloud placeholder fail-closed behavior.
- `server/adapters/mock-cloud-artifact-adapter.cjs`: object-storage-like local adapter for tests without exposing permanent paths.
- `server/render-job.cjs`: render orchestration stages upload/audio/subtitles/output through artifact adapters.
- `tests/cloud-storage-staging.test.cjs`: config, mock-cloud, staging, render orchestration and no-leak regressions.

Contracts:

- Default adapter remains `local`; `mock-cloud` is the deterministic cloud-shaped adapter for local tests.
- Real `s3` and `r2` modes use the S3-compatible adapter; `gcs` remains fail-closed until a dedicated adapter is implemented.
- FFmpeg must never read directly from a cloud object. Inputs are staged to local paths first, outputs are rendered to a local stage, then committed through the artifact adapter.
- Cloud-shaped adapters must throw on `resolveLocalPath` and permanent local path access.
- Render/export records must not expose storage keys, absolute paths, signed tokens or provider details.
- Staging cleanup is bounded to the configured staging directory and must not delete uploads or committed renders.
- Export records are created only after the staged render has been committed and verified as an available artifact.
- `/health` can expose adapter mode, readiness, capabilities and staging probe booleans, but no bucket names, endpoints, storage keys or local paths.

Limitations:

- `mock-cloud` is still backed by local files to keep tests deterministic and network-free.
- Multipart uploads, presigned provider URLs, IAM/bucket policy checks, retention lifecycle, GCS and background cleanup are future production milestones.
