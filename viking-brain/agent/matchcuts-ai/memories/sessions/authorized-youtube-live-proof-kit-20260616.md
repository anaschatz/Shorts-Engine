# Session Memory: Authorized YouTube Live Proof Kit

Date: 2026-06-16

Decisions:

- Added `youtube:proof` as an operator alias for the local live YouTube proof.
- Moved `env:check` into the proof runner before config validation, doctor, server bind or smoke work.
- Added report-driven triage with safe `phase`, `nextAction`, `triage.preflight` and `triage.doctor`.
- Reused the central environment gate for the optional Playwright YouTube live path.

Safety:

- Default proof remains skipped and does not start a server or downloader/network work.
- Reports avoid raw YouTube URLs, local paths, storage keys, provider output and secrets.

Known limitation:

- Real live proof still requires operator-owned/authorized media, downloader availability and a local environment that permits server binding.
