# Report and Log Leak Guard Hardening - 2026-06-16

## Decisions

- Extended shared report leak detection beyond unsafe keys to raw provider/downloader secret strings.
- Added detection for app/provider env-style secrets with `=`, `:` or whitespace separators.
- Hardened server log redaction for `SHORTSENGINE_*`, `MATCHCUTS_*`, `YOUTUBE_*`, `YT_DLP_*` and `GOOGLE_*` secret/cookie/credential values.
- Added `/tmp` and `/var/folders` local path redaction to server log messages.

## Tests Added

- Demo report leak guard catches raw YouTube smoke tokens and downloader cookie strings.
- Server log redaction removes YouTube smoke token/cookie values and temp paths.
- YouTube smoke failure summaries remain safe when raw fetch errors contain temp paths and downloader/provider secret-looking text.

## Limitation

- This is a pattern-based guard. New provider-specific identifier formats should be added to `demo/report-safety.mjs` and `server/errors.cjs` when introduced.
