# Authorized YouTube Live Proof Kit

## Purpose

The YouTube link-to-shorts path should be testable by an operator with an authorized URL while remaining skipped, no-network and no-downloader by default.

## Flow

`npm run youtube:e2e:local`, `npm run youtube:proof` and `npm run youtube:proof:operator` run the same proof. The operator alias labels the persisted report with `command: "youtube:proof:operator"` so release evidence can distinguish explicit operator proof from the generic alias.

1. Run central `env:check` first.
2. Validate explicit live proof flag, ingest enablement, rights confirmation, URL shape and allowlist/manual gate.
3. Run `youtube:doctor`.
4. Start a local server only after env and doctor pass.
5. Reuse the safe YouTube smoke pipeline for validate, ingest, generate, job polling and MP4 download verification.

## Report Triage

Reports include:

- `command`
- `status`
- `passed`
- `skipped`
- `phase`
- `nextAction`
- `triage.preflight`
- `triage.doctor`
- safe `failedCases`

Allowed failure phases are `env`, `doctor`, `server-bind`, `validation`, `ingest`, `probe`, `render`, `download`, `browser` and `report`.

Reports must not include raw YouTube URLs, local absolute paths, storage keys, downloader stdout/stderr, cookies, tokens, signed URLs, secrets or raw provider errors.

## Default Safety

Without explicit flags, proof stays skipped and does not start a server, call network APIs or invoke downloader-backed ingest.
