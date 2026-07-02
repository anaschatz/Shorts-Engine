# Chunked Scorebug OCR Runtime Session

Date: 2026-07-02

## Decisions

- Replaced the monolithic long-source scorebug-first OCR call with a chunked runner in render orchestration.
- Added explicit OCR sampling windows so chunked scorebug OCR does not accidentally re-run full-source periodic sampling inside every chunk.
- Aggregated per-chunk OCR evidence into a validated public scoreboard OCR result with a safe `chunkSummary`.
- Extended job progress metadata and YouTube proof reporting with chunk fields so late-source work is observable and stall detection does not misclassify active chunk progress.
- Kept the final video output gate unchanged and strict. Chunking improves discovery/runtime behavior but does not relax counted-goal proof requirements.

## Verification

- Focused render-job, YouTube runtime and scoreboard OCR tests passed after implementation.
- Added regression coverage for late score-change discovery from a late chunk, per-chunk timeout failure metadata and explicit sampling-window behavior.

## Limitations

- Real YouTube proof still depends on operator-enabled ingest flags, rights confirmation, downloader readiness and local OCR runtime speed.
- If OCR chunks complete but the final edit plan misses counted goals or visible phase evidence, the output gate should still fail without producing a misleading MP4.
