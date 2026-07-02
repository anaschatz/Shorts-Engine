# Long-Source YouTube Proof Runtime + Async Progress

## Purpose

Long YouTube proof runs must not fail as a vague `analyze_media` timeout. The operator needs bounded runtime steps, active progress metadata and safe failure reports that show exactly where the proof stalled.

## Runtime Contract

- Use explicit per-request and total job timeouts for live YouTube smoke/proof commands.
- Preserve the active job `phase`, `step`, `substep`, `startedAt`, `budgetMs`, `longSource` and `scorebugFirst` metadata.
- Treat unchanged job status/progress/step/substep as a stall after the configured stall budget.
- Report stale jobs as structured failures instead of misleading success.
- Never expose raw downloader output, stack traces, absolute paths, tokens, storage keys, logs or artifacts in proof reports.

## Long-Source Strategy

- For YouTube sources longer than the short-source threshold, run scorebug-first OCR before broad visual frame extraction.
- Convert stable score changes into bounded visual candidate windows.
- Merge scorebug windows with media-signal windows before frame extraction so late goals are not dropped.
- Keep the valid-goals-only output gate active; runtime hardening must not relax counted-goal truth requirements.

## Safe Defaults

- Live YouTube proof remains opt-in and requires rights confirmation.
- Downloader/network work remains disabled unless operator flags allow it.
- Tests/eval do not require API keys or external paid providers.
- Failure reports must include `nextAction` and safe phase details.

## Verification Expectations

- Focused tests should cover request timeout phase reporting, stalled job reporting and scorebug-first long-source orchestration.
- Full validation should still include lint, build, tests, eval, reference eval, brain health, YouTube/OCR doctors, smoke checks and release checks.
