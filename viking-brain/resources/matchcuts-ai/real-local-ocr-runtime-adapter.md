# Real Local OCR Runtime Adapter

## Boundary
- `server/adapters/local-ocr-adapter.cjs` owns safe command execution for local OCR.
- `server/scoreboard-ocr.cjs` owns scoreboard crop selection, staging-safe crop paths, cleanup, provider fallback and output validation.
- The default remains deterministic scoreboard OCR. Local OCR is opt-in with `SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1` and `SHORTSENGINE_SCOREBOARD_OCR_PROVIDER=local`.

## Runtime Contract
- The local adapter runs the configured OCR binary with `execFile`, never through a shell.
- `SHORTSENGINE_SCOREBOARD_OCR_BIN` defaults to `tesseract`; the project never auto-installs it.
- OCR reads bounded frame crops from staging paths only and writes temporary crop files under configured staging.
- Timeouts and cancellation fail closed to deterministic fallback or `JOB_CANCELLED`.
- Health exposes safe readiness fields: provider mode, enabled flag, runtime availability and fallback availability. It does not expose binary paths, stdout/stderr or provider errors.

## Goal Safety
- OCR cannot confirm a goal by itself.
- `score_changed` can support a valid goal only with ball-in-net/action context and temporal consistency.
- `score_unchanged` after ball-in-net supports offside/no-goal context.
- `clock_only`, `unreadable` and `ambiguous` OCR never create confirmed-goal claims.

## Evaluation
- Added `ocr_score_unchanged_disallowed_goal` to prove unchanged scoreboard OCR keeps a ball-in-net sequence as disallowed/offside context.
- Eval reports now expose `clockOnlyCount` and `unreadableCount` alongside score-change, unchanged and ambiguous OCR counts.

## Safe Defaults
- No API keys or network are required for tests, eval or local demo.
- Local OCR remains disabled by default.
- Reports and public responses must not contain raw OCR text, absolute paths, storage keys, stdout/stderr, tokens or provider errors.

## Operator Proof
- `npm run ocr:doctor` checks OCR readiness without installing Tesseract or calling network services.
- `npm run ocr:smoke` writes `demo/results/ocr-latest.json` plus a timestamped safe proof report.
- Default OCR smoke passes in deterministic fallback mode; local OCR runtime is required only when explicitly enabled.
- Crop QA artifacts stay disabled by default under `demo/results/ocr-artifacts/`; reports keep safe relative refs only.
