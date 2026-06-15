# Browser E2E Upload Harness

ShortsEngine has a browser-facing acceptance layer for demo readiness and a real Playwright E2E runner for the full local flow.

## Commands

- `npm run demo:browser` writes `demo/results/browser-latest.json`.
- `npm run demo:browser:e2e` writes `demo/results/playwright-latest.json`.
- `npm run demo:manual` prints the manual browser checklist.

## Current Implementation

The dependency-light browser smoke runner validates:

- ShortsEngine page identity and CSP.
- Stable `data-testid` selectors for upload, consent, generate, cancel, export, download, error, progress and status controls.
- Initial fail-closed markup for export, download, cancel and progress controls.
- UI contracts for missing-upload safe error handling and completed-job export gating.
- Responsive CSS contracts.
- Manual demo documentation.
- Full API demo smoke as the upload/generate/render/download fallback.

The Playwright runner additionally drives Chromium through the actual UI:

- file upload from browser context
- missing upload and rights validation
- progress/cancel state
- completed render
- post-completion export/download gate
- rendered MP4 endpoint validation

## Limitation

Playwright browser binaries need local/CI setup. In constrained CI, missing-runtime skip must be explicit with `SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP=1`.
