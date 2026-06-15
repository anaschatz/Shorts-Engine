# Object Storage Adapter + Signed Artifact Delivery

Source files:

- `server/storage/artifact-store.cjs`: local object-store-shaped artifact lifecycle, metadata, streams, signed token validation and temp-only deletion.
- `server/adapters/artifact-adapter.cjs`: required storage adapter contract.
- `server/adapters/local-artifact-adapter.cjs`: local filesystem implementation of the object-store contract.
- `server/repositories/export-repository.cjs`: completed-export download descriptors and signed download descriptors.
- `server/adapters/local-persistence-adapter.cjs`: persistence adapter bridge for export download descriptors.
- `server/app.cjs`: direct export download and signed artifact download routes.
- `tests/object-storage.test.cjs`: contract, token lifecycle, download guard, missing artifact, owner mismatch and no-leak regressions.

Contracts:

- Public APIs must not expose artifact storage keys, absolute local paths or bucket details.
- Downloads go through export repository plus artifact adapter, not raw route-level filesystem reads.
- Export delivery is allowed only when the export record exists, its artifact exists, ownership matches and the job is completed.
- Signed download URLs use short-lived opaque local tokens; they do not encode storage keys.
- Signed token storage is bounded and pruned, so repeated URL creation cannot grow memory unbounded.
- Unknown and expired signed tokens fail closed with `ARTIFACT_TOKEN_INVALID` and are not echoed in API responses.
- Adapter health performs a safe temp artifact write/read/delete probe and reports only booleans/capabilities, not paths, keys or token values.
- Local adapter keeps `resolveLocalPath` as an internal capability for FFmpeg/staging until a real object-store adapter is introduced.
- Cleanup remains conservative: staging uploads and temp artifacts only, never uploads/renders/exports without an explicit lifecycle policy.
- Render orchestration may use local paths only through explicit adapter local staging capability, not arbitrary route-level filesystem access.

Limitations:

- Signed tokens are local in-memory tokens and do not survive restart.
- Object storage remains filesystem-backed; S3/R2/GCS adapters are future work.
- FFmpeg still needs local paths, so a cloud adapter will need explicit staging/download-to-temp behavior.
