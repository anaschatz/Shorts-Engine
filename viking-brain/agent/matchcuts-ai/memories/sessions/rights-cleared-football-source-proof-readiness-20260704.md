# Session Memory: Rights-Cleared Football Source Proof Readiness

Date: 2026-07-04

Decision:

- Add a no-network proof source readiness gate before fresh MP4 proof execution.
- Keep missing source as a safe skipped state, not a product success.
- Require explicit counted-goal expectations before live YouTube proof can be considered ready.

Implemented:

- `demo/check-proof-source-readiness.mjs`
- `npm run proof:readiness`
- focused tests for local source, YouTube source, runtime blockers, report writing and leak safety
- docs updates in `docs/ENVIRONMENT.md` and `docs/YOUTUBE_INGEST_MANUAL_SMOKE.md`

Safety:

- The readiness command does not start a server, downloader, network ingest, render or MP4 output.
- Reports use safe relative refs and source summaries only.
- Old MP4 artifacts are never reused as successful proof by readiness.

Limitation:

- A real fresh MP4 still requires an operator-configured rights-cleared source or fully ready authorized YouTube proof flags.
