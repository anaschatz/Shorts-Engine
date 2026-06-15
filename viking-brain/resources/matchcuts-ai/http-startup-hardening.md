# HTTP + Startup Hardening

Source files:

- `server/app.cjs`: request body bounds, multipart parser limits, safe download filename normalization, response headers.
- `server/errors.cjs`: shared safe response headers for JSON errors/success.
- `server/repositories/project-state.cjs`: filtered project-state restore with filename and size gates.
- `tests/backend.test.cjs`: HTTP bounds, safe headers and filename regressions.
- `tests/persistence-foundation.test.cjs`: unrelated/corrupt project metadata restore regressions.

Contracts:

- Upload body size is `maxUploadBytes` plus a small multipart overhead allowance, not an unbounded field allowance.
- Multipart boundaries, part headers and text fields are bounded before file validation.
- Generate JSON requests use a small explicit body limit and reject oversized declared content before job creation.
- JSON/static/download responses include safe default headers: `cache-control: no-store`, `referrer-policy: no-referrer`, `x-content-type-options: nosniff`, and `x-frame-options: DENY`.
- Download filenames are normalized before `Content-Disposition`.
- Startup project restore ignores unrelated `.json` files before read and caps project-state file size.

Limitations:

- Local data cleanup/retention is still manual; a dedicated retention policy remains a future production milestone.
