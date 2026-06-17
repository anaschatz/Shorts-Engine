# Session Memory: Transactional Outbox Worker

Date: 2026-06-18

Decisions:

- Added a dedicated outbox worker instead of placing delivery logic inside API routes.
- Kept default delivery local/no-op to avoid webhook/email/cloud side effects in tests, demos and CI.
- Expanded approval outbox lifecycle to `pending`, `processing`, `delivered`, `failed` and `dead_letter`.
- Treated legacy `processed` as `delivered` for safe restore compatibility.
- Added SQLite migration v4 for lock/delivery lifecycle fields.

Safety:

- Event payloads remain restricted to safe ids, statuses and error codes.
- Worker output and health expose aggregate counts only.
- Stale locks recover safely; terminal events are protected.

Validation:

- Added focused worker/repository tests for claim, delivery, retry, dead-letter, stale lock recovery, cancellation and leak guards.
- Extended SQLite adapter test to cover transactional claim and delivery.
