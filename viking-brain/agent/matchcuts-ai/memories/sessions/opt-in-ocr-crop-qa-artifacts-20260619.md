# Session Memory: Opt-in OCR Crop QA Artifacts

## Decisions
- OCR crop QA thumbnails are opt-in only with `SHORTSENGINE_OCR_QA_ARTIFACTS=1`.
- Generated crop artifacts are written under `demo/results/ocr-artifacts/<run-id>/`.
- Reports expose only safe relative refs and bounded OCR evidence summaries.
- Default CI/demo still requires no Tesseract and no OCR artifacts.

## Safety
- No raw OCR text, stdout/stderr, binary paths, staging paths, storage keys or secrets in reports.
- Artifact run ids reject path traversal.
- Retention deletes only managed `ocr-*` artifact directories.
- Default GitHub Actions failure uploads include `demo/results/ocr-latest.json` but not the crop artifact directory.

## Operator Flow
- Run `npm run ocr:doctor` first.
- For local Tesseract proof, run `SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1 SHORTSENGINE_SCOREBOARD_OCR_PROVIDER=local SHORTSENGINE_OCR_QA_ARTIFACTS=1 npm run ocr:smoke`.
- Missing Tesseract returns `OCR_RUNTIME_MISSING` with safe next action.
