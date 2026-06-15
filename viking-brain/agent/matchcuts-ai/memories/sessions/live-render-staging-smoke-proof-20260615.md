# Live Render Staging Smoke Proof - 2026-06-15

Added safe manual proof helpers for the live Render staging milestone.

Decisions:

- `render:manual` prints a checklist without real tokens, service ids or URLs.
- `render:proof` forces provider `none` and proves env/staging/render/deploy checks without network.
- `staging:deploy` remains the only helper allowed to call Render APIs.
- Render deploy output and errors stay sanitized; raw provider errors are not surfaced.
- Deployed smoke remains `/health` only.

Validation focus:

- Manual checklist is report-safe.
- No-network proof stays readiness-only even if caller env includes render-looking values.
- Render API non-2xx and fetch failures produce safe structured errors.
