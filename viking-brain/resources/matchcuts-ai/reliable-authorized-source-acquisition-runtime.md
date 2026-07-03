# Reliable Authorized Source Acquisition Runtime

## Decision

ShortsEngine now routes authorized YouTube source downloads through a source acquisition boundary before media validation and artifact commit. The boundary keeps the current local downloader as the default adapter while making the acquisition contract provider-neutral for future runtimes.

## Safety Contract

- YouTube ingest remains disabled by default.
- Rights confirmation is required before acquisition.
- The downloader receives safe argument arrays, never shell strings.
- No cookies, tokens, browser sessions, private-video bypasses, DRM bypasses, or raw downloader logs are accepted.
- Source files are downloaded only to managed staging paths.
- Upload/project records are created only after source acquisition, file signature validation, ffprobe validation, and artifact commit succeed.
- Partial staging files are cleaned on failure.

## Runtime Observability

The local downloader now reports safe progress diagnostics:

- `sourceAcquisitionStatus`
- `stallClassification`
- `heartbeatIntervalMs`
- `noProgressTimeoutMs`
- `progressHeartbeatCount`
- `progressEventCount`
- `progressBytesObserved`

No-progress stalls fail as `YOUTUBE_NO_PROGRESS_TIMEOUT`, separate from process-level `YOUTUBE_DOWNLOAD_TIMEOUT`.

## Limitations

This does not bypass YouTube restrictions or require credentials. If a public long video still cannot be acquired reliably by the local downloader, the safe next step is an operator-approved authorized source cache or a reviewed provider-neutral acquisition backend.
