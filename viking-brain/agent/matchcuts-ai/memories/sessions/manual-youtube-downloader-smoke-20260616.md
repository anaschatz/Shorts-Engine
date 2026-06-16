# Manual Authorized YouTube Downloader Smoke - 2026-06-16

## Decisions

- Keep real YouTube ingest manual and opt-in.
- Add an operator guide before any live downloader smoke.
- Make `youtube:doctor` next actions specific for disabled ingest, missing downloader, FFmpeg/FFprobe, staging storage and live health shape failures.
- Make `youtube:smoke` reports store request-id presence instead of raw request ids.
- Fail smoke closed when health is not ready, public responses leak internals, jobs time out or downloads are not valid MP4 files.

## Proof

- Runtime tests cover doctor next actions, safe health-shape failures, no raw URL in smoke reports, public response leak handling, health-not-ready failures and MP4 signature validation.
- Static tests cover manual guide presence, rights/no-auto-install language, doctor/smoke commands, key troubleshooting codes and default-safe CI behavior.

## Limitations

- Real downloader smoke still requires a human-provided authorized URL and locally installed downloader.
- Default CI remains no-network and no-downloader by design.
