# Session Memory: Manual OCR QA Review UI

Date: 2026-06-19

## Decisions

- Added a local operator dashboard for OCR QA inside the existing Quality review panel.
- Kept browser access behind API routes instead of serving `demo/results` directly.
- Returned only crop ids, kind, size, and safe thumbnail URLs to the UI.
- Kept OCR calibration support-only with `goalDecisionAllowed: false`.
- Cleaned ignored OpenViking `.refresh-backup-*` noise and `.DS_Store` files.

## Validation Targets

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run eval`
- `npm run eval:reference`
- `npm run feedback:summary`
- `npm run brain:health`
- `npm run demo:fixture`
- `npm run demo:smoke`
- `npm run demo:browser`
- `npm run demo:browser:ci`
- `npm run ci:reports`
- `npm run release:check`

## Limitations

- OCR QA review remains manual/operator-assisted.
- Crop artifacts are local debug artifacts and are not uploaded in passing CI.
- OCR can support goal/offside reasoning only when paired with football action evidence.
