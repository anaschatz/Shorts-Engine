# Authorized YouTube Proof Execution - 2026-06-16

## Decisions

- Added an explicit operator alias for the authorized YouTube proof while keeping live ingest skipped by default.
- Proof reports now carry `command`, `passed` and `skipped` in addition to `phase`, `nextAction` and triage.
- Remote CI proof now records top-level proof metadata and distinguishes missing CLI, missing auth, network unavailable, pending, failed and cancelled states.

## Safety Notes

- No real YouTube ingest should run without explicit rights, ingest, URL and allowlist/manual-gate flags.
- Remote CI proof remains read-only and does not download logs or artifacts.
- Reports must remain free of secrets, local paths, raw URLs, storage keys and provider/downloader output.
