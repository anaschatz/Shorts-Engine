# Authorized YouTube Proof Execution

## Purpose

The authorized YouTube path now has an operator proof command that can be run outside sandboxed environments while staying skipped and no-network by default.

## Commands

- `npm run youtube:proof`
- `npm run youtube:proof:operator`
- `npm run remote:ci`
- `npm run remote:ci:proof`

## YouTube Operator Proof Contract

`youtube:proof:operator` must:

1. Run central env readiness before doctor, server bind or smoke work.
2. Require explicit live proof, ingest enablement, rights confirmation and an authorized URL.
3. Require allowlist or explicit manual unlisted gate.
4. Run the YouTube doctor before starting the local server.
5. Reuse the safe smoke pipeline for validate, ingest, generate, render, download and MP4 signature verification.
6. Write `demo/results/youtube-live-e2e-latest.json`.

Reports must include `command`, `status`, `passed`, `skipped`, `phase`, `nextAction` and `triage`.

## Remote CI Proof Contract

`remote:ci:proof` must write `release/results/remote-ci-latest.json` and timestamped proof files with:

- `command`
- `phase`
- `status`
- `passed`
- `skipped`
- `nextAction`
- `triage`
- safe failure code/message where applicable

It distinguishes `GITHUB_CLI_MISSING`, `GITHUB_AUTH_MISSING`, `REMOTE_CI_NETWORK_UNAVAILABLE`, pending timeouts, failed release gates and cancelled workflow runs without raw logs or artifacts.

## Safety

Proof reports must not contain raw YouTube URLs, local absolute paths, storage keys, raw stderr/stdout, downloaded logs/artifacts, cookies, GitHub tokens or provider errors.
