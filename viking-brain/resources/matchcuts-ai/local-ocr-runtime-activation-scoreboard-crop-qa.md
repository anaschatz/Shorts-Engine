# Local OCR Runtime Activation + Scoreboard Crop QA Proof

## Boundary
- `tools/release/check-ocr-runtime.mjs` owns OCR operator readiness.
- `demo/run-ocr-smoke.mjs` owns the local OCR smoke proof and safe report writing.
- Core rendering/analysis remains unchanged: OCR runtime activation is verified outside routes and orchestration.

## Safe Defaults
- Deterministic scoreboard OCR remains the default for CI, tests, eval and local demo.
- Local OCR is opt-in with `SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1` and `SHORTSENGINE_SCOREBOARD_OCR_PROVIDER=local`.
- ShortsEngine never installs Tesseract, never starts auth and never calls network services for OCR readiness.

## Report Contract
- `npm run ocr:smoke` writes `demo/results/ocr-latest.json` plus a timestamped OCR smoke report.
- Reports include provider mode, fallback/runtime status, sampled frame summary, public scoreboard OCR evidence and bounded QA rows.
- Reports must not include OCR text dumps, stdout/stderr, binary paths, local crop paths, storage keys, provider raw errors or secrets.
- Crop artifacts are disabled by default and require `SHORTSENGINE_OCR_QA_ARTIFACTS=1`.
- Enabled crop artifacts are written only under `demo/results/ocr-artifacts/<run-id>/`.
- Retention is bounded by `SHORTSENGINE_OCR_QA_ARTIFACT_RETENTION`.

## Release Gate
- CI runs `npm run ocr:doctor` and `npm run ocr:smoke`.
- `npm run ci:reports` validates `demo/results/ocr-latest.json`.
- Failure artifact upload includes only the safe latest OCR smoke report, not crop thumbnails or staging files.

## Evaluation Notes
- Clock-only, unreadable, ambiguous and impossible score jumps fail closed.
- OCR cannot confirm a goal without matching football action evidence.
- Local OCR runtime quality still depends on scoreboard visibility and crop quality.
