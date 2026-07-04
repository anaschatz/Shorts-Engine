# Operator-Approved Source Cache + Resumable Authorized Source Backend

## Purpose

Long public YouTube sources can make progress but still exceed bounded downloader timeouts. ShortsEngine now has a safe source-cache boundary so an operator can provide a rights-cleared MP4 for a YouTube `videoId` without adding cookies, browser sessions, private-video bypasses or misleading proof output.

## Runtime Contract

- YouTube ingest remains opt-in with `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1`.
- Source cache remains disabled by default with `SHORTSENGINE_SOURCE_CACHE_ENABLED=0`.
- Cache keys are the YouTube `videoId`, not raw URLs.
- Expected cache file naming is `<videoId>.mp4`; optional checksum metadata is `<videoId>.sha256`.
- Cache directories must stay under managed `data` or system temp roots.
- A cache hit is copied into managed staging before normal upload signature, FFprobe, artifact-store and repository boundaries run.
- Cache files are never deleted or mutated by ingest cleanup.
- Cache miss can fall back to the local downloader when configured.
- Corrupt, oversized or checksum-mismatched cache files fail closed and do not create upload, project, job or export records.

## Safe Report Fields

Reports and public safe errors may expose only:

- `sourceAcquisitionStrategy`
- `cacheChecked`
- `cacheHit`
- `cacheValidated`
- `cacheFailureCode`
- `downloaderFallbackUsed`
- safe `checksumSha256`

Never expose absolute cache paths, staging paths, storage keys, raw downloader stdout/stderr, cookies, tokens or provider raw errors.

## Validation Expectations

Tests should prove:

- cache disabled by default
- invalid cache dir/path traversal rejection
- video-id-based cache key
- cache miss downloader fallback
- valid cached MP4 reaches artifact commit
- corrupt cache rejection
- checksum mismatch fail-closed behavior
- no records on cache validation failure
- approved cache file is not deleted
- doctor/report summaries contain safe cache diagnostics
