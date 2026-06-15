# Session: Browser E2E Upload Harness

Date: 2026-06-15

## Decisions

- Added stable `data-testid` selectors to the user-facing controls without changing visual design.
- Added a dependency-light browser contract runner instead of adding a browser dependency.
- Browser smoke report writes `demo/results/browser-latest.json`.
- Manual QA steps live in `demo/MANUAL_TESTING.md` and can be printed with `npm run demo:manual`.
- The API demo smoke remains the automated proof of upload/generate/render/download while manual/in-app browser checks cover true UI interaction.

## Checks

- `npm run demo:browser` should pass after `npm run demo:fixture`.
- `npm run demo:smoke` remains the full API E2E fallback.

## Next

Consider adding a scoped Playwright test package only when browser CI is required.
