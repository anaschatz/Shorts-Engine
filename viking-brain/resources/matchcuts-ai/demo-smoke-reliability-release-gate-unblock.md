# Demo Smoke Reliability + Release Gate Unblock

ShortsEngine demo and release gates must be bounded, deterministic and safe to debug. Local smoke commands should either pass or fail with a structured reason; they should not hang on app startup, browser launch, stale reports or open worker handles.

## Root Cause

- Demo smoke started the app against the default local `data/` directory, which can contain many persisted records and slow startup recovery.
- Smoke scripts did not consistently abort in-flight health checks, API calls, browser work and server processes after timeout.
- Some backend tests imported app modules without an isolated data root, so workers and recovery scans could leave open handles.
- CI report validation surfaced stale failures but did not always tell the operator which command regenerates the failed report.

## Decisions

- Use isolated repo-local temp data roots for demo smoke and Playwright smoke through `MATCHCUTS_DATA_DIR`.
- Validate custom data roots so they stay inside the repo or the OS temp directory.
- Add bounded request, health and browser launch timeouts with safe failure codes.
- Keep child process, browser context and worker cleanup in `finally` paths.
- Keep `npm test` bounded with an explicit Node test timeout so silent hangs become actionable failures.
- Pass safe review record refs from the API layer so review/regeneration flows work with isolated data roots.
- Keep report recovery instructions command-oriented and free of local paths, raw logs or secrets.

## Validation

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

## Known Limitation

Browser smoke still depends on local Chromium/Playwright availability. Missing browser runtime should fail clearly in release gates rather than skip or hang.
