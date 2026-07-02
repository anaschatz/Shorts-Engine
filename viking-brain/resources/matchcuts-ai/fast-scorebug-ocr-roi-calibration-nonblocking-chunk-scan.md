# Fast Scorebug OCR ROI Calibration + Non-Blocking Chunk Scan

## Purpose

Long YouTube sources must not stall or fail the whole proof on the first slow scorebug OCR window. Scorebug OCR should scan bounded chunks, preserve safe progress metadata, continue to later chunks when a chunk times out, and only allow MP4 proof when the final output gate can prove counted-goal coverage.

## Architecture

- Keep scorebug OCR inside the render orchestration boundary, not API routes.
- Split long-source scorebug scanning into bounded chunks with per-chunk timeout metadata.
- Record chunk status as `scanned`, `timed_out`, `failed` or `skipped`.
- Aggregate ROI calibration and scorebug debug state from successful chunks only.
- Store public OCR summaries on the job when OCR fails closed, so reports can explain the blocker without raw OCR output.
- Keep final MP4 proof gated on counted-goal coverage, visible phase coverage and non-replay-only segments.

## Safety Rules

- Per-chunk OCR timeout must not block scanning later chunks while total budget remains.
- If every chunk fails or times out, fail closed with `SCOREBOARD_OCR_TIMEOUT`.
- Do not expose raw OCR text, provider stderr/stdout, absolute paths, cookies, tokens or storage keys in reports.
- Do not produce a misleading MP4 when counted-goal coverage cannot be proven.
- Live YouTube proof remains opt-in with explicit rights confirmation and allowlisted/manual source gates.

## Validation

- Focused render-job, YouTube runtime and scoreboard OCR tests cover chunk timeout, late score change recovery and safe report shape.
- Full local validation should include lint, build, test, eval, reference eval, YouTube doctor, OCR smoke/review, CI reports, release check and brain health.

## Known Limitation

This milestone makes OCR scanning non-blocking and observable, but live YouTube proof can still fail before OCR if the downloader cannot fetch the source in the operator environment. That failure should remain structured and must not produce an MP4.
