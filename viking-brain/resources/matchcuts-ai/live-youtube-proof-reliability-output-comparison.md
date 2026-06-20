# Live YouTube Proof Reliability + Real Output Comparison

Date: 2026-06-20

## Purpose

ShortsEngine needs a reliable operator proof loop before visual comparison work can be trusted. The live YouTube proof must avoid stale MP4s, start with isolated local state, prove server readiness before ingest and write safe output diagnostics for both success and failure.

## Runtime Contract

- The live proof server uses an isolated `MATCHCUTS_DATA_DIR` under `tmp/` so old local artifacts cannot slow startup or affect the proof.
- Managed generated MP4 cleanup is limited to allowlisted proof files under `manual-downloads/`.
- Reference videos and operator-named MP4s are not deleted by the proof cleanup.
- Server readiness failure reports include safe phase, timeout/attempt metadata and next actions without paths, logs or provider output.
- Success reports include generated MP4 refs, ffprobe metadata, counted-goal coverage, replay-only segment count and comparison readiness.
- Failure reports still include `outputProof` with source id, expected counted goals, safe goal-discovery diagnostics and `OUTPUT_MP4_NOT_CREATED`.

## Live Proof Result

- The previous `YOUTUBE_LIVE_E2E_SERVER_READY_TIMEOUT` blocker was removed: the server reached `/health` in the live proof.
- One live run reached ingest/generate and failed in render selection with `NO_VALID_GOALS_FOUND` for the test source.
- A later live run failed earlier at the downloader boundary with `YOUTUBE_DOWNLOAD_FAILED`.
- No MP4 was produced by the final live run, so no side-by-side visual comparison is available yet.

## Next Step

Fix real-source valid goal detection for the downloaded source, then rerun `npm run youtube:proof:operator` and compare the generated MP4 against the reference.
