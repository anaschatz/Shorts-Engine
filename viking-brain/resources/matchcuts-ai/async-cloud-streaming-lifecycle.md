# Async Cloud Streaming + Multipart Uploads + Artifact Lifecycle Policy

Source files:

- `server/config.cjs`: validates multipart threshold, part size and lifecycle cleanup defaults.
- `server/adapters/artifact-adapter.cjs`: requires streaming, async stage/commit and lifecycle cleanup capabilities.
- `server/storage/artifact-store.cjs`: local streaming helpers and dry-run temp artifact cleanup policy.
- `server/adapters/local-artifact-adapter.cjs`: local adapter wrappers for the expanded artifact contract.
- `server/adapters/mock-cloud-artifact-adapter.cjs`: deterministic cloud-shaped streaming/lifecycle wrappers for tests.
- `server/adapters/s3-request-worker.cjs`: no-dependency worker operations for download-to-file and upload-from-file.
- `server/adapters/s3-artifact-adapter.cjs`: S3/R2 streaming-oriented staging, single-file upload, multipart selection and abort-on-failure.
- `tests/s3-artifact-adapter.test.cjs`: mocked-client regressions for streaming, multipart, cancellation and lifecycle cleanup.

Contracts:

- Local and mock-cloud remain deterministic default/no-network paths.
- FFmpeg still receives only local staging paths; cloud objects are staged to local files before processing.
- S3/R2 input staging should prefer download-to-file worker operations instead of returning full objects through parent process buffers.
- S3/R2 render commit should prefer upload-from-file worker operations for single uploads.
- Multipart upload is selected when artifact size crosses the configured threshold and the client exposes multipart methods.
- Multipart failures must abort best-effort and leave no completed artifact record.
- Lifecycle cleanup is dry-run capable, bounded by max age and max artifacts, and limited to temporary artifact types.
- Uploads and completed renders/exports must not be deleted by generic lifecycle cleanup.
- Health can expose capability booleans and safe size thresholds, but not storage keys, bucket names, endpoints, signatures or credentials.

Limitations:

- Multipart tests use mocked clients by default; real cloud integration remains opt-in.
- Multipart upload still uses bounded part buffers in the default no-dependency client; future high-volume production can move part upload to a streaming SDK/client worker.
- Cleanup operates on provided artifact records; a future database-backed index should drive scheduled cleanup runs.
