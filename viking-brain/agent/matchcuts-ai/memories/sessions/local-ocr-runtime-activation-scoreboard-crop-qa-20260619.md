# Session Memory: Local OCR Runtime Activation + Scoreboard Crop QA Proof

## Decisions
- Added `ocr:doctor` as the read-only operator readiness check for scoreboard OCR.
- Added `ocr:smoke` as the safe local proof report for sampled-frame OCR fallback/runtime behavior.
- Kept local OCR disabled by default; deterministic fallback remains CI-safe and no-network.
- Added OCR smoke to the CI/release report contract without uploading crop thumbnails.

## Safety
- No automatic Tesseract install.
- No raw OCR text, stdout/stderr, binary path, local crop path, storage key, provider raw error or secret in reports.
- Missing local OCR runtime fails only when local OCR is explicitly enabled.

## Validation Focus
- Doctor/smoke output safety.
- CI report contract including `demo/results/ocr-latest.json`.
- Clock-only and impossible score jumps fail closed in local OCR evidence.

## Limitation
- Real OCR quality still depends on operator-installed OCR runtime and actual scoreboard crop readability.
