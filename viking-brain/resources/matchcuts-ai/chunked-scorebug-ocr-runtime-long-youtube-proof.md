# Chunked Scorebug OCR Runtime + Long YouTube Proof

## Purpose

Long YouTube proofs must not run scorebug OCR as one blocking full-source step. Scorebug discovery should scan bounded chunks, emit progress during each chunk and fail with useful diagnostics when a chunk or total OCR budget is exceeded.

## Runtime Contract

- Split long-source scorebug OCR into time chunks.
- Each chunk carries start/end time, sampling windows, per-chunk timeout, total budget and cancellation support.
- Progress metadata must include `chunkIndex`, `chunkCount`, `chunkStart`, `chunkEnd`, `scannedChunks`, `discoveredScoreChanges`, `chunkTimeoutMs` and `totalBudgetMs`.
- The smoke/proof stall detector must treat chunk progress as real progress.
- Public reports may include chunk summaries, but not paths, raw OCR text, stderr/stdout, storage keys, cookies, tokens or provider raw errors.

## OCR Sampling

- Use explicit OCR sampling windows for chunked runs.
- Explicit sampling windows bypass full-source periodic sampling so each chunk stays bounded.
- Keep deterministic/mock OCR available by default for tests and local demos.
- Do not require paid providers or API keys.

## Goal Proof Rules

- Stable score changes discovered in any chunk become candidate windows before sampled visual frame extraction.
- Late score changes must be eligible for downstream goal evidence and output-gate coverage.
- The final MP4 gate remains strict: no MP4 success unless counted goals are covered with valid visible goal phases.
- If proof cannot produce a valid MP4, return a structured failure with OCR chunk summary and next action.

## Verification Expectations

- Tests should cover all chunk scanning, late score-change discovery, per-chunk timeout behavior, progress metadata, safe report shape and explicit sampling-window behavior.
- Live proof should be run only with explicit rights confirmation and operator flags.
