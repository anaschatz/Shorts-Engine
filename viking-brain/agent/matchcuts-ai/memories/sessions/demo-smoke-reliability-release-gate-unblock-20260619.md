# Session Memory: Demo Smoke Reliability + Release Gate Unblock

Created: 2026-06-19

## Summary

ShortsEngine unblocked the local release gate by making demo smoke, browser smoke, full tests and report validation bounded and deterministic. The milestone also cleaned old accidental OpenViking dirty files and replaced them with this scoped memory/resource update.

## Root Cause

- App startup and tests could touch the default local `data/` tree, making health checks slow or flaky.
- Demo/browser smoke scripts needed stronger abort propagation and guaranteed cleanup.
- Some tests imported app modules without isolated persistence roots, leaving worker handles or recovery scans active.
- CI report failures needed clearer recovery commands so stale report failures are easier to fix.

## Decisions

- Add `MATCHCUTS_DATA_DIR` validation and use isolated temp data roots for tests and smoke commands.
- Add explicit health, request and browser launch timeouts.
- Abort underlying async work instead of only racing promises.
- Clean up child server processes, browser contexts and app workers deterministically.
- Keep public smoke/report errors safe: codes, phases and next actions only; no raw paths, logs or secrets.
- Keep generated reports out of the commit unless they are explicit release evidence.

## Validation

- Full `npm test` completed with 609 passing tests.
- Demo smoke passed with 18 checks.
- Evaluation passed with aggregate score 99 across 27 fixtures.
- Reference evaluation passed with aggregate score 98 across 9 fixtures.
- Browser and Playwright smoke passed locally.
- `ci:reports` and `release:check` passed after fresh report generation.

## Limitation

This milestone fixes local release-gate reliability. It does not change product AI behavior or remote CI infrastructure.
