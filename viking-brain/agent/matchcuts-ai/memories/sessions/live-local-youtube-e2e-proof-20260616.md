# Live Local YouTube E2E Proof - 2026-06-16

## Decisions

- Add a dedicated `youtube:e2e:local` runner instead of making `youtube:smoke` start servers.
- Keep the runner skipped by default and require explicit live, rights, ingest and URL flags.
- Reuse `youtube:doctor` for readiness and `runYouTubeSmoke` for the actual API proof.
- Add an optional Playwright YouTube live path behind a separate browser flag.
- Treat local server bind `EPERM` as an environment limitation with a safe code.

## Proof

- `tests/youtube-runtime.test.mjs` covers skipped default, missing rights, unsafe URL, doctor failure, server bind failure, mocked success and report writing.
- `tests/playwright-smoke.test.mjs` covers browser live config gating.
- Static lint asserts scripts, docs, report names and no downloader execution in the live wrapper.

## Limitations

- Real downloader execution still requires an operator-managed downloader and authorized URL.
- Live proof cannot run inside environments that block local server binding.
