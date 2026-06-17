# Transactional Outbox Worker + Reliable Event Delivery

## Purpose

ShortsEngine approval/render lifecycle events now move from audit-only storage into a reliable local delivery lifecycle. The first delivery implementation is intentionally no-op and local so tests, demos and CI can prove worker behavior without external side effects.

## Architecture

- `server/repositories/approval-outbox-repository.cjs` owns event lifecycle validation, safe payload filtering, claim/lock, retry, stale-lock recovery and dead-letter state.
- `server/outbox-handlers.cjs` defines the handler contract and default no-op audit handler.
- `server/outbox-worker.cjs` owns drain behavior, bounded batches, handler execution, retries and safe structured logs.
- `server/adapters/sqlite-persistence-adapter.cjs` migration v4 adds lock/delivery columns and uses transaction-backed claim/update through the same repository contract.
- `server/app.cjs` exposes outbox worker health without starting external delivery by default.
- `tools/outbox-health.mjs` and `tools/outbox-drain.mjs` provide safe local operator commands.

## Event Lifecycle

Statuses are `pending`, `processing`, `delivered`, `failed` and `dead_letter`. Legacy `processed` restores as `delivered`.

Events store only safe ids, lifecycle status, timestamps, attempts, lock owner, max attempts and error codes. They must not store raw captions, transcripts, edit plans, provider output, stdout/stderr, local paths, storage keys, signed URLs, secrets or tokens.

## Reliability Policy

- Claim due `pending`/due `failed` events with a bounded batch and worker lock.
- Do not claim `processing` events twice.
- Recover stale processing locks into retry/dead-letter state.
- Mark delivered events terminal and do not reprocess them.
- Retry with bounded exponential backoff.
- Dead-letter after max attempts.
- Keep external delivery disabled by default.

## Commands

```bash
npm run outbox:health
npm run outbox:drain
```

Both commands are local, no-network and no-secret by default. Output is safe JSON with aggregate counts and no raw payload internals.
