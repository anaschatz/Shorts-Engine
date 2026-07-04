# Rights-Cleared Football Source Proof Readiness

Milestone: Rights-Cleared Football Source Proof + Real Fresh MP4 Comparison.

Purpose:

- Add a source readiness gate before any local or live YouTube proof run.
- Prevent misleading success when no rights-cleared football source is configured.
- Keep proof execution explicit: no downloader, no server, no network and no MP4 output during readiness.

Contract:

- `npm run proof:readiness` writes `demo/results/proof-source-readiness-latest.json`.
- Default state is safe `skipped` with `PROOF_SOURCE_NOT_CONFIGURED`.
- Local MP4 readiness requires `SHORTSENGINE_LOCAL_PROOF_SOURCE`, `SHORTSENGINE_LOCAL_PROOF_RIGHTS_CONFIRMED=1` and `SHORTSENGINE_LOCAL_PROOF_EXPECTED_COUNTED_GOALS`.
- Live YouTube readiness requires `SHORTSENGINE_YOUTUBE_LIVE_E2E=1`, `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1`, `SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED=1`, a safe URL, allowlist/manual gate and `SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS`.
- YouTube runtime readiness is summarized through the safe `youtube:doctor` contract.

Safety notes:

- Readiness does not start ingest, downloader, local server or render.
- Readiness does not reuse old MP4 artifacts as success.
- Reports include safe source summaries only: file name, size, checksum prefix or YouTube video id.
- Reports must not include absolute local paths, raw URLs with secrets, cookies, tokens, storage keys, stdout/stderr, raw logs or provider errors.

Next proof flow:

1. Run `npm run proof:readiness`.
2. If local proof is `ready`, run `npm run proof:local-video`.
3. If YouTube proof is `ready`, run `npm run youtube:proof:operator`.
4. Trust a generated MP4 only if the output gate, ffprobe, rendered social polish QA and visual-frame QA pass.
