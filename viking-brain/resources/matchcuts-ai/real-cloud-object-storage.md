# Real Cloud Object Storage Adapter + Signed Delivery

Source files:

- `server/config.cjs`: validates S3/R2 bucket, region, endpoint, credentials and signed URL TTL.
- `server/adapters/s3-artifact-adapter.cjs`: S3-compatible artifact adapter with SigV4 request signing, opaque signed delivery tokens, local FFmpeg staging and safe cloud error mapping.
- `server/adapters/s3-request-worker.cjs`: small no-dependency HTTP worker used by the default S3 client.
- `server/adapters/object-storage-adapter.cjs`: creates local, mock-cloud, s3 and r2 adapters; keeps gcs fail-closed.
- `server/errors.cjs`: adds `CLOUD_STORAGE_FAILED` and redacts cloud credentials/signatures.
- `tests/s3-artifact-adapter.test.cjs`: mocked-client contract tests for S3/R2, staging, signed delivery and render orchestration.

Contracts:

- Local remains the default adapter and needs no cloud credentials.
- `mock-cloud` remains the deterministic no-network object-storage test mode.
- `s3` requires bucket, region, access key id and secret access key.
- `r2` requires bucket, endpoint, access key id and secret access key; region defaults to `auto` when validated.
- `gcs` is intentionally fail-closed because it needs a different production adapter.
- Routes and repositories still talk only to artifact/persistence contracts, never to cloud SDK/client code.
- FFmpeg never reads cloud objects directly. Inputs download to local staging, outputs render locally, then commit through the artifact adapter.
- Signed delivery uses opaque server-side tokens by default so public API responses do not expose storage keys, bucket names, provider URLs or credentials.
- Signed download tokens are validated fail-closed against downloadable artifact type and optional expected export/project/job scope before streaming.
- Invalid signed URL TTL config is rejected at startup/config validation instead of silently becoming `NaN` or an unsafe runtime default.
- Cloud provider failures map to `CLOUD_STORAGE_FAILED` and must not leak raw SDK/HTTP errors.

Limitations:

- The default S3 client remains no-dependency and process-worker based; high-volume production should still consider an async SDK/client worker with backpressure metrics.
- Direct presigned provider URLs, IAM/bucket policy verification and GCS remain future milestones.
