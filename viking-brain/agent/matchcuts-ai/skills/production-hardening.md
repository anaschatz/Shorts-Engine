# Skill: Production Hardening

Use before shipping code.

Checklist:

- Validate every user input.
- Add loading, empty, success, error, retry, and cancel states.
- Keep user errors safe and technical logs structured.
- Add idempotency keys for jobs.
- Add rate limits for expensive operations.
- Add tests for edge cases and failure paths.
- Verify desktop/mobile layout for overflow.
- Persist jobs durably before/while processing so server restarts do not lose work.
- Add heartbeat and max-attempt recovery policy for processing jobs.
- Skip corrupt persisted records safely and keep terminal jobs terminal.
- Reject terminal job mutations except idempotent same-status checks.
- Expose only aggregate queue health in readiness endpoints.
- Add no-leak regression tests for safe errors, health payloads, and loggable job output.
- Bound JSON and multipart request bodies at the route boundary before expensive parsing or job creation.
- Apply safe default response headers consistently for JSON, static assets and downloads.
- Keep startup restore filters strict so unrelated/corrupt local metadata cannot slow or block app boot.
- Put project/upload/export persistence behind repositories before adding real databases.
- Put uploads, audio, subtitles, renders and exports behind artifact-store contracts before adding object storage.
- Validate persistence and artifact adapter capabilities at startup before swapping in database or object-storage implementations.
- Keep adapter health limited to mode/capability/readiness metadata, never raw paths or storage keys.
- Treat artifact storage keys as internal only; never include them in public responses or health payloads.
- Stage FFmpeg input/output through artifact adapters so cloud storage can be added without leaking permanent object paths.
- Keep GCS fail-closed until its adapter is implemented; keep multipart/direct-provider signed URL behavior opt-in until explicitly tested.
- For `s3`/`r2`, validate bucket/region/endpoint/credentials at config time and convert provider failures to `CLOUD_STORAGE_FAILED`.
- Validate signed delivery TTLs as bounded numbers and reject invalid config fail-closed.
- Validate signed download tokens against downloadable artifact type plus expected export/project/job scope whenever the caller has that context.
- For cloud artifacts, prefer download-to-file and upload-from-file staging paths so large objects do not flow through public APIs or unbounded parent-process buffers.
- Multipart upload thresholds and part sizes must be validated config, tested with mocked clients, and abort best-effort on failure.
- Lifecycle cleanup must be dry-run capable, max-age/max-count bounded, temp-type only, and must never delete uploads or completed renders/exports by default.
- Use mocked cloud clients in default tests; real cloud integration must stay opt-in through explicit env flags.
- Test staging cleanup for probe/render failures that happen after a file has been written.
- Drive scheduled cleanup from a validated artifact index/repository, not from ad hoc recursive storage scans.
- Protect artifacts owned by active queued/processing jobs from cleanup.
- Expose cleanup/index readiness as aggregate health fields only: no storage keys, local paths, bucket names or provider errors.
- Keep real S3/R2 integration in an explicit `integration:cloud` script that skips safely without `MATCHCUTS_RUN_REAL_CLOUD_TESTS=1` and credentials.
- Validate numeric env/config values with bounded helpers; never allow `NaN` ports, limits, durations, timeouts or retry counts into runtime.
- Validate any persisted artifact `path` against the storage area for its artifact type before indexing it.
- Treat staging smoke URLs as untrusted input; reject credentials, localhost/private/link-local targets unless explicit local mode is enabled.
- Bound deployed health-smoke response bodies before JSON parsing and convert oversized/invalid JSON responses into safe structured failures.
- Keep staging deploy provider-specific and explicit: Render deploys require target `staging`, provider `render`, a `srv-...` service id, a protected deploy token and a safe staging URL.
- Unsupported staging deploy providers must fail closed; provider `none` remains a no-network readiness-only path.
- Validate live Render staging config with `npm run render:check` before deploy; it must remain no-network and public-URL-only.
- Use `render:manual` and `render:proof` for live staging setup evidence before adding real GitHub Environment secrets.
- Bound provider deploy response bodies before parsing and expose only sanitized provider status metadata.
- Keep full staging upload/render smoke manual and opt-in; bound fixture, polling, response and download sizes before reporting.
- For staging smoke cleanup, require source markers plus ownership-chain validation, keep dry-run as the default, and never delete active job artifacts or non-smoke records.
- Extend report/log leak guards whenever a new provider identifier, token shape or public artifact delivery mechanism is introduced.
- After push, prefer safe remote CI summaries from `npm run remote:ci`; if CI fails, fix forward with a new validated commit instead of mutating release evidence or past commits.
- For GitHub release readiness, run `npm run github:doctor` before remote proof and keep branch protection checks read-only; if permissions return `unknown`, confirm settings in the GitHub UI.
