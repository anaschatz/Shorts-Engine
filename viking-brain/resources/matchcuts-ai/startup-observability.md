# Startup Observability

Source files:

- `server/app.cjs`: `startServer`, `attachServerErrorHandler`, `serverListenFailurePayload`.
- `tests/backend.test.cjs`: listen failure no-leak regression coverage.

Contracts:

- Attach a server `error` handler before calling `listen`.
- Log successful startup as `server_listening`.
- Log bind/listen failures as `server_listen_failed`.
- Startup failure logs must include safe fields only: event, service, code, syscall and port.
- Startup failure logs must not expose stack traces, absolute local paths, socket paths, secrets or raw provider errors.
- CLI startup sets `process.exitCode = 1` on listen failure, while tests can call the handler without forcing process exit.

Why:

Before this guard, port bind failures could surface Node's default unhandled `error` stack trace, including local project paths. This is a production observability and leakage risk.
