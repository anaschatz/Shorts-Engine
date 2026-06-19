# Manual OCR QA Review UI

ShortsEngine now exposes manual OCR QA calibration through the local Quality review UI.

## Contract

- `GET /api/ocr-qa/latest` loads the latest managed OCR QA manifest from `demo/results/ocr-latest.json`.
- `GET /api/ocr-qa/crop?manifest=...&id=...` streams only manifest-validated PNG crop thumbnails.
- `POST /api/ocr-qa/review` writes the same support-only calibration report as `npm run ocr:qa:review`.
- The browser receives crop ids, kind, size, and safe thumbnail URLs. It never receives local crop paths.

## Safety

- OCR evidence remains `support_only`.
- OCR-only goal confirmation is not allowed.
- Missing manifests keep review submit disabled.
- Reports and API responses must not include raw OCR text, full frames, absolute paths, storage keys, stdout/stderr, provider output, tokens, or secrets.
- Crop artifacts stay local/debug-only and outside default release artifacts.

## Operator Flow

1. Generate managed OCR QA artifacts:
   `SHORTSENGINE_OCR_QA_ARTIFACTS=1 npm run ocr:smoke`
2. Open the local UI and review OCR crop thumbnails in the Quality review panel.
3. Mark scoreboard, clock, score, readability, usefulness, and optional safe notes.
4. Submit OCR QA to create `demo/results/ocr-qa-review-latest.json`.
5. Use the calibration only as supporting evidence next to football action evidence.
