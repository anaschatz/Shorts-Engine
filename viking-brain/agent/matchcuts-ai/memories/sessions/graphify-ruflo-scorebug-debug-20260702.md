# Session Memory: Graphify/Ruflo Scorebug Debug Contract

Created: 2026-07-02T14:27:38Z

## Summary

Added a safe scorebug debugging contract for live YouTube proof failures where OCR runs but finds no stable score changes. Ruflo and Graphify remain optional local references only; no CLI install, init, graph export, network call or generated third-party output is required by default.

## Decisions

- Keep agent tooling optional and validate it with `npm run agent:tools:doctor`.
- Report scorebug diagnosis as bounded metadata: `score_changes_detected`, `scorebug_static`, `scorebug_unreadable`, `scorebug_ambiguous` or `scorebug_missing`.
- Preserve safe ROI debug summaries in OCR QA reports, public OCR summaries, render logs and YouTube live output proofs.
- Use safe `nextAction` guidance instead of raw OCR/provider output when live proof cannot discover counted goals.
- Restore stale OpenViking test-memory diffs instead of committing unrelated brain churn.

## Validation

- `npm run agent:tools:doctor`
- `npm run lint`
- `npm run build`
- `npm test`
- `npm run eval`
- `npm run eval:reference`
- `npm run brain:health`
- `npm run youtube:doctor`
- `npm run ocr:doctor`
- `npm run ocr:smoke`
- `npm run ocr:qa:review`
- `npm run ci:reports`
- `npm run release:check`

## Limitations

- Live YouTube ingest stays opt-in and disabled by default.
- Local OCR runtime remains optional; deterministic fallback is still valid for CI/demo.
- The new contract improves proof/debug observability but does not by itself guarantee every real broadcast scorebug is readable.
