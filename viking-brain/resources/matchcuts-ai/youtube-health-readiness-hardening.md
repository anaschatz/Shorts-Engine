# YouTube Health Readiness Hardening

Date: 2026-06-16

Source files:

- `server/youtube-ingest.cjs`
- `tests/youtube-ingest.test.cjs`

Production risk:

- YouTube ingest readiness is exposed through `/health` and is also used by the ingest service gate.
- Adapter health output is an external boundary and must not be trusted as truthy/falsy JavaScript values.
- Malformed values such as `"true"` or unsafe `mode` strings could create incorrect readiness or leak provider/runtime details.

Contracts:

- Missing adapter health stays in the safe mock-disabled shape.
- Throwing adapter health returns `ready: false`, `mode: "unknown"` and all capabilities disabled.
- Non-object or malformed health payloads fail closed.
- Health booleans must be strict booleans.
- `ingestAvailable` is true only when `ready`, `enabled`, `downloaderConfigured` and adapter-provided `ingestAvailable` are all true.
- Health `mode` is sanitized to a short lowercase token and unsafe strings become `unknown`.
- Public health output must not include local paths, secrets, downloader raw output or provider raw errors.

Validation:

- `tests/youtube-ingest.test.cjs` covers malformed health payloads with unsafe path/secret-shaped strings.
- Default mock and throwing-adapter failure tests still prove disabled/no-network safe behavior.
