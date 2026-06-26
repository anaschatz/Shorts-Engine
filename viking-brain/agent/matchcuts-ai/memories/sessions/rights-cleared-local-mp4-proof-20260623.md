# Rights-Cleared Local MP4 Proof Session - 2026-06-23

Decision:

- Added a safe local MP4 proof path because live YouTube proof was blocked at the downloader boundary with `YOUTUBE_DOWNLOAD_FAILED` before OCR/evidence analysis.
- The operator can now run `npm run proof:local-video` or `npm run youtube:proof:local` with explicit rights confirmation and expected counted-goal count.
- The proof uses the normal upload, generate, render, output QA, download and ffprobe path.
- The upload source marker `local-video-proof` forces `valid_goals_only` so the proof cannot quietly fall back to balanced highlight selection.

Safety:

- Default command skips without server startup.
- Source file must be a regular MP4 with `ftyp` signature and is never mutated or deleted.
- No MP4 is written unless the final output QA confirms the expected counted-goal coverage and all segments have visible phase coverage.
- The local proof runner now independently rejects replay-only, celebration-only, non-goal, and random-chance segments even if an upstream QA report is optimistic.
- If a generated MP4 fails ffprobe, the proof artifact is discarded and the report remains failed.
- Reports use safe relative artifact refs and keep logs/artifacts downloaded flags false.

Triage:

- Generic `YOUTUBE_DOWNLOAD_FAILED` now recommends rights-cleared local MP4 proof or downloader repair.
- The live proof remains honest: if download fails, the report stays in the download/pre-render path and does not claim OCR evidence.

Validation:

- Added focused local proof tests for skipped/default behavior, missing rights, unsafe/corrupt source files, output gate failures, source immutability, OCR proof flags, and leak guards.
- Added focused regression tests for random-chance rejection, celebration-only rejection, and ffprobe-failed artifact discard.
