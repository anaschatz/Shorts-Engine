# Rights-Cleared Local MP4 Proof

Milestone: Rights-Cleared Local MP4 Proof Path + Downloader Failure Triage.

Purpose:

- Unblock product proof when live YouTube download fails before OCR/evidence analysis.
- Let an operator provide a rights-cleared local MP4 and run the same upload -> generate -> render -> output QA path.
- Avoid misleading success: no generated MP4 is written unless the valid-goals-only video output gate proves the expected counted-goal coverage.

Key contracts:

- `npm run proof:local-video` and `npm run youtube:proof:local` default to skipped.
- Required flags are `SHORTSENGINE_LOCAL_PROOF_SOURCE`, `SHORTSENGINE_LOCAL_PROOF_RIGHTS_CONFIRMED=1`, and `SHORTSENGINE_LOCAL_PROOF_EXPECTED_COUNTED_GOALS`.
- The source file is validated as a regular `.mp4` with an `ftyp` container signature.
- The proof uploads the file through `/api/uploads` with source marker `local-video-proof`.
- `local-video-proof` forces `valid_goals_only` in render orchestration.
- OCR flags are proof-scoped through `SHORTSENGINE_LOCAL_PROOF_SCOREBOARD_OCR` and `SHORTSENGINE_LOCAL_PROOF_SCOREBOARD_OCR_QA`.
- Reports are written to `demo/results/local-video-proof-latest.json`.
- Successful MP4 outputs are saved under `manual-downloads/` only after output QA and ffprobe pass.

Safety notes:

- The source file is never mutated or deleted.
- Reports use safe relative refs only.
- Reports must not include absolute paths, storage keys, stdout, stderr, cookies, tokens, secrets, raw OCR text, raw provider errors, raw downloader output, or downloaded GitHub/YouTube artifacts.
- `YOUTUBE_DOWNLOAD_FAILED` now points operators to the rights-cleared local MP4 proof path or downloader repair, not OCR troubleshooting when download never reached OCR.

Tests:

- `tests/local-video-proof.test.mjs` covers skipped defaults, rights requirement, unsafe source rejection, corrupt MP4 rejection, safe source summary, source immutability, proof-scoped OCR flags, and no MP4 write when output QA fails.
