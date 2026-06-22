# ShortsEngine YouTube Ingest Manual Smoke

This guide is for an explicit, operator-run proof that ShortsEngine can ingest an authorized YouTube URL, convert it into a local MP4 artifact, render a short, and download the resulting MP4. It is not part of default CI and it must not run without an explicit manual flag.

## Safety And Rights

- Use only videos you own, have licensed, or are otherwise authorized to process.
- Respect YouTube terms, copyright, privacy, platform rules, and local law.
- Do not use private videos, credentialed URLs, playlists, live streams, channel pages, search pages, or embeds.
- Keep YouTube ingest disabled in default local, CI, and staging environments until a human operator enables it intentionally.
- Do not commit `.env` files, cookies, downloader output, downloaded videos, generated reports, uploads, renders, storage keys, or secrets.

## What This Smoke Proves

The smoke runner checks:

- `/health` is ready and includes safe `youtubeIngest` readiness.
- `/api/youtube/validate` accepts only a safe YouTube URL with rights confirmation.
- `/api/youtube/ingest` creates a project/upload only after downloader, FFprobe, upload validation, and artifact commit succeed.
- render generation completes and creates an export.
- the export download returns a bounded MP4 with a valid `ftyp` signature.
- `demo/results/youtube-smoke-latest.json` contains only safe summaries and request-id presence, not raw URLs, local paths, storage keys, stdout, stderr, cookies, tokens, or provider errors.

## Install And Verify Downloader

ShortsEngine never installs a downloader automatically. Install and patch it outside the app, then point ShortsEngine at the managed binary if needed.

Examples:

```bash
yt-dlp --version
ffmpeg -version
ffprobe -version
```

If the downloader is not on `PATH`, configure:

```bash
export SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN="/path/to/managed/yt-dlp"
```

Do not use shell aliases, command strings with spaces, cookies, or downloader configs that require private credentials.
`SHORTSENGINE_YOUTUBE_AUTHORIZED_IMPORT_ENABLED=0` is the safe default. It is a foundation flag only; this milestone does not accept cookies, tokens, browser sessions or private video credentials.

## Enable Manual Ingest

In one terminal, start the app with explicit ingest enabled:

```bash
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 npm run dev
```

Use the port printed by the server, usually `http://127.0.0.1:4175`.

## Run Doctor

Run a no-download readiness check:

```bash
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_DOCTOR_URL="http://127.0.0.1:4175" \
npm run youtube:doctor
```

The doctor checks the explicit flag, FFmpeg, FFprobe, staging storage, downloader readiness, and optional live `/health` shape. It reports safe `nextAction` strings for operator recovery.

Default disabled mode is expected to skip safely:

```bash
npm run youtube:doctor
```

## Run Manual Smoke

Prefer an allowlist for the exact video id:

```bash
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_SMOKE=1 \
SHORTSENGINE_YOUTUBE_SMOKE_URL="https://www.youtube.com/watch?v=<authorized-video-id>" \
SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS="<authorized-video-id>" \
SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL="http://127.0.0.1:4175" \
npm run youtube:smoke
```

For a one-off manual proof, use the unlisted gate only when the URL was reviewed:

```bash
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_SMOKE=1 \
SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED=1 \
SHORTSENGINE_YOUTUBE_SMOKE_URL="https://www.youtube.com/watch?v=<authorized-video-id>" \
SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL="http://127.0.0.1:4175" \
npm run youtube:smoke
```

Useful bounded settings:

```bash
SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS=120000
SHORTSENGINE_YOUTUBE_SMOKE_TIMEOUT_MS=120000
SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS=90000
SHORTSENGINE_YOUTUBE_SMOKE_DOWNLOAD_MAX_BYTES=83886080
```

Raise timeouts only for an intentional manual proof with a known short source.

## Run Local Live E2E Proof

Use this when you want the script to start a local server, verify doctor readiness, run validate -> ingest -> generate -> render -> download, and write a dedicated local proof report.
Run `npm run env:check` first; the proof runner also executes the same env readiness gate before doctor, server bind, browser work or downloader-backed smoke. It validates the live proof flags, URL shape, rights confirmation, ingest enablement and allowlist/manual gate before any server or downloader work.

```bash
SHORTSENGINE_YOUTUBE_LIVE_E2E=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED=1 \
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_URL="https://www.youtube.com/watch?v=<authorized-video-id>" \
SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS="<authorized-video-id>" \
npm run youtube:e2e:local
```

`npm run youtube:proof` is an alias for the same proof, and `npm run youtube:proof:operator` labels the generated report as the explicit operator proof command:

```bash
SHORTSENGINE_YOUTUBE_LIVE_E2E=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED=1 \
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_URL="https://www.youtube.com/watch?v=<authorized-video-id>" \
SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS="<authorized-video-id>" \
npm run youtube:proof:operator
```

For a reviewed one-off URL, use the same explicit unlisted gate as smoke:

```bash
SHORTSENGINE_YOUTUBE_LIVE_E2E=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED=1 \
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_URL="https://www.youtube.com/watch?v=<authorized-video-id>" \
npm run youtube:e2e:local
```

For the current three-counted-goal verification fixture, keep the URL allowlisted and set the expected goal count explicitly. The proof must either write a verified MP4 under `manual-downloads/` or fail with the exact missing goal numbers:

```bash
SHORTSENGINE_YOUTUBE_LIVE_E2E=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED=1 \
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_URL="https://www.youtube.com/watch?v=gxiRyFZXJV8" \
SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS="gxiRyFZXJV8" \
SHORTSENGINE_YOUTUBE_LIVE_E2E_EXPECTED_COUNTED_GOALS=3 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR_QA=1 \
npm run youtube:proof:operator
```

`SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR=1` maps only this operator proof server to local scoreboard OCR (`SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1`, provider `local` unless overridden). It still requires a local OCR runtime; if OCR is disabled, unavailable, unreadable or ambiguous, the proof fails closed and writes evidence trace fields such as `scoreboardOcrAttempted`, `scoreboardOcrEnabled`, `scoreboardObservationCount`, `scoreChangeCount`, `stableScoreChangeCount`, `missingEvidenceByCandidate` and `nextAction`. OCR QA artifacts are opt-in with `SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR_QA=1` and are referenced only by safe relative paths for local debugging.

The default command is safe and skips without starting a server:

```bash
npm run youtube:e2e:local
npm run youtube:proof:operator
```

The report is written to:

```bash
demo/results/youtube-live-e2e-latest.json
```

The live E2E wrapper does not call the downloader directly. It runs `youtube:doctor`, starts the local app with ingest enabled only after explicit flags are present, then reuses the same leak-guarded `youtube:smoke` pipeline against that local server.

## Run Rights-Cleared Local MP4 Proof

Use this path when the YouTube downloader is blocked before OCR/evidence analysis, but you have a rights-cleared MP4 of the same source. The command starts an isolated local server, uploads the MP4 through `/api/uploads`, marks the upload as `local-video-proof`, runs the normal generate/render job, enforces the same valid-goals-only video output QA gate, and writes an MP4 only if the final gate passes.

Default mode is safe and skipped:

```bash
npm run proof:local-video
npm run youtube:proof:local
```

Operator proof example:

```bash
SHORTSENGINE_LOCAL_PROOF_SOURCE="/absolute/path/to/rights-cleared-source.mp4" \
SHORTSENGINE_LOCAL_PROOF_RIGHTS_CONFIRMED=1 \
SHORTSENGINE_LOCAL_PROOF_EXPECTED_COUNTED_GOALS=3 \
SHORTSENGINE_LOCAL_PROOF_SOURCE_LABEL="authorized-match-highlight" \
SHORTSENGINE_LOCAL_PROOF_SCOREBOARD_OCR=1 \
SHORTSENGINE_LOCAL_PROOF_SCOREBOARD_OCR_QA=1 \
npm run proof:local-video
```

Safety contract:

- The source file must be a regular `.mp4` with an `ftyp` container signature.
- The command never mutates or deletes the source file.
- The source is copied through the upload/artifact boundary, not read directly by render orchestration.
- OCR flags apply only to the isolated proof server.
- Reports use safe relative refs only and never include absolute local paths, raw OCR text, storage keys, stdout, stderr, cookies, tokens, secrets, or raw provider/downloader errors.
- If 3/3 counted goals cannot be proven, no MP4 is written as a successful proof.

Reports are written to:

```bash
demo/results/local-video-proof-latest.json
```

Successful reports include `outputProof.outputMp4.relativePath` under `manual-downloads/`, an ffprobe summary, counted-goal coverage, missing-goal fields, and `logsDownloaded: false` / `artifactsDownloaded: false`.

## Run Local UI E2E Demo

Use this path after `npm run youtube:doctor` is passing with ingest enabled and a live `/health` URL.

1. Start the app with `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 npm run dev`.
2. Open the local URL printed by the server, usually `http://127.0.0.1:4175`.
3. Switch the source selector to `YouTube URL`.
4. Paste only an authorized YouTube watch, Shorts or youtu.be URL.
5. Confirm the YouTube-specific rights checkbox.
6. Confirm validation starts automatically after typing stops; use `Retry validation` only if validation fails.
7. Confirm the preview shows only safe source metadata such as video id/kind, not a raw canonical URL.
8. Confirm the match title fills from safe source metadata when available; if no title is available, type it manually.
9. If `/health` reports `youtubeIngest` ready, click `Ingest video`.
10. Confirm the status changes to ready-to-generate and the main `Generate shorts` action becomes available.
11. Click `Generate shorts`, wait for job progress to complete, then download the MP4.

Expected disabled states:

- Auto validation waits until URL and rights confirmation are present; the retry control stays hidden unless validation is running or fails.
- `Ingest video` is disabled until validation passes and health says downloader-backed ingest is ready.
- `Generate shorts` is disabled for YouTube sources until ingest creates project/upload state.
- Export and Download stay disabled/hidden until render completion.

If ingest is disabled, the validate-only UI path should still work safely and explain that local uploads remain available.
If validation passes but ingest later fails with `YOUTUBE_AUTH_REQUIRED`, `YOUTUBE_BOT_CHECK_REQUIRED`, `YOUTUBE_COOKIES_REQUIRED`, `YOUTUBE_AGE_RESTRICTED`, `YOUTUBE_VIDEO_PRIVATE`, `YOUTUBE_VIDEO_UNAVAILABLE`, `YOUTUBE_GEO_RESTRICTED` or `YOUTUBE_RATE_LIMITED`, the UI should keep Generate/Download disabled, show retry/another-link/MP4 fallback recovery controls, and avoid raw downloader output.

## Run Opt-In Browser Live E2E

If Playwright Chromium is installed and the local environment permits server binding, the browser runner can exercise the YouTube UI path too:

```bash
SHORTSENGINE_YOUTUBE_LIVE_E2E_BROWSER=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED=1 \
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_URL="https://www.youtube.com/watch?v=<authorized-video-id>" \
SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS="<authorized-video-id>" \
npm run demo:browser:ci
```

This path opens the app, selects `YouTube URL`, validates the source, checks safe preview metadata, ingests only if health reports readiness, generates the render, and verifies Download after completion. If local server binding fails with `EPERM`, treat it as an environment limitation and use the generated safe report rather than diagnosing it as a product regression.

## Read The Report

Open:

```bash
demo/results/youtube-smoke-latest.json
```

For local live E2E proof, open:

```bash
demo/results/youtube-live-e2e-latest.json
```

Expected passing report:

- `status: "passed"`
- `command: "youtube:proof"` or `command: "youtube:proof:operator"`
- `passed: true`
- `skipped: false`
- `phase: "completed"`
- `triage.failedPhase: null`
- `triage.preflight` booleans for ingest, rights, source and allowlist/manual gate readiness
- `triage.doctor` booleans for downloader, FFmpeg, FFprobe and storage readiness
- safe `source` with `sourceType`, `kind`, and `videoId`
- safe `target` with protocol, host type, and mount only
- project/upload/job/export ids
- `health.requestIdPresent` and per-step `requestIdPresent`
- export `contentType`, `sizeBytes`, and `sha256Prefix`
- `generatedArtifact.relativePath` under `manual-downloads/` for successful live operator proof
- `generatedArtifact.downloadVerified: true` with project/job/export ids and safe media metadata

Failure reports should include only safe `code`, `phase`, `nextAction` and bounded readiness summaries. Common phases are `env`, `doctor`, `server-bind`, `validation`, `ingest`, `probe`, `render`, `download` and `browser`. They must not contain raw URLs, local absolute paths, storage keys, stdout, stderr, cookies, tokens, secrets, or raw provider/downloader errors.

When the final video output gate fails, the smoke/live proof report should include bounded QA fields so the operator can see why no MP4 was trusted: `countedGoalEventCount`, `actualConfirmedGoalSegmentCount`, `coveredGoalCount`, `missingGoalNumbers`, `failedReasons`, and `outputProof.videoOutputQA`. These fields are safe summaries only; the report must still keep `logsDownloaded: false` and `artifactsDownloaded: false`.

Default skipped reports should show `status: "skipped"`, `passed: false`, `skipped: true`, `phase: "skipped"` and a `nextAction` that points at the missing opt-in flag. A skipped proof must not start the server, call the downloader or run network ingest.

## Human Visual Review After Live Proof

After a successful `npm run youtube:proof:operator`, create the human visual review report:

```bash
npm run demo:human-review -- --reference=manual-downloads/shortsengine-reference-rZZUzMSfaQ.mp4
```

The command reads `demo/results/youtube-live-e2e-latest.json`, extracts the safe
`generatedArtifact.relativePath`, runs the side-by-side structural comparison,
and writes:

```bash
demo/results/human-visual-review-latest.json
```

Without a human review JSON, the report should be `status:
"pending_human_review"` and `productReady: false`. To score creative readiness,
create a small JSON review under `demo/reviews/` and rerun:

```bash
npm run demo:human-review -- \
  --reference=manual-downloads/shortsengine-reference-rZZUzMSfaQ.mp4 \
  --review=demo/reviews/example-side-by-side-review.json
```

The review checklist covers action/goal sequence visibility, shot/contact,
ball/goal-mouth/keeper/payoff visibility, reaction-as-support, payoff timing,
ball/player framing, caption/action alignment, false-goal safety, text
obstruction and reference-style pacing. Reports must include only safe relative
refs and must not include raw downloader logs, absolute paths, storage keys,
cookies or tokens.

The browser UI can complete the same review without editing JSON by hand. After
the generated MP4 and reference MP4 are available under `manual-downloads/`,
open the app, use the Human review section, confirm the generated/reference
refs, score every criterion from `0` to `5`, set any relevant issue flags, add
bounded notes and submit. The UI calls `GET /api/review/latest` and
`POST /api/review/human`; previews use `/api/review/media?ref=...` and only
serve safe `manual-downloads/*.mp4` files.

`productReady` must stay `false` until a human review is present. It also stays
`false` whenever critical flags are enabled, including false goal claim, wrong
moment, bad crop, caption mismatch, text blocking action, missing payoff or
reaction-only output. This keeps the product gate honest when a clip has no
goal, starts on the wrong beat, loses the ball, or copies reference energy
without showing the actual football action.

## Safe Cleanup

Do not manually delete uploads, renders, exports, database files, or object-storage records unless a dedicated lifecycle policy says so.

Allowed cleanup after a failed manual run:

- remove temporary staging files created by the current run only after the process has exited.
- keep `demo/results/youtube-smoke-latest.json` long enough to debug safe failure codes.

If cleanup requires deleting committed artifacts or exports, stop and add a dedicated cleanup milestone first.

## Troubleshooting Codes

| Code | Meaning | Next action |
| --- | --- | --- |
| `YOUTUBE_INGEST_DISABLED` | Real ingest is intentionally off. | Set `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1` only for manual proof. |
| `YOUTUBE_DOWNLOADER_MISSING` | The configured downloader is unavailable. | Install/configure downloader or set `SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN`. |
| `YOUTUBE_AUTH_REQUIRED` | YouTube requires authorized access for this video. | Use another public video or upload an MP4 fallback until authorized import is built. |
| `YOUTUBE_BOT_CHECK_REQUIRED` | YouTube blocked the download with an anti-bot check. | Use another public video or upload an MP4 fallback; do not paste cookies/tokens into the app. |
| `YOUTUBE_COOKIES_REQUIRED` | The downloader says browser/cookie authorization is required. | Use MP4 fallback; authorized import is not enabled yet. |
| `YOUTUBE_VIDEO_PRIVATE` | The video is private. | Use a public authorized video or MP4 fallback. |
| `YOUTUBE_VIDEO_UNAVAILABLE` | The video is unavailable or removed. | Check the link or use another video. |
| `YOUTUBE_GEO_RESTRICTED` | The video is unavailable from this environment. | Use an accessible authorized video or MP4 fallback. |
| `YOUTUBE_AGE_RESTRICTED` | The video requires age-gated access. | Use MP4 fallback until authorized import is built. |
| `YOUTUBE_RATE_LIMITED` | YouTube rate-limited the ingest attempt. | Retry later or upload MP4 fallback. |
| `YOUTUBE_DOWNLOAD_FAILED` | Generic downloader failure before OCR/evidence analysis. | Use `npm run proof:local-video` with a rights-cleared MP4, or fix the downloader and rerun. |
| `FFMPEG_MISSING` | FFmpeg is unavailable. | Install FFmpeg or set `FFMPEG_BIN`. |
| `FFPROBE_MISSING` | FFprobe is unavailable. | Install FFprobe or set `FFPROBE_BIN`. |
| `YOUTUBE_STAGING_STORAGE_UNAVAILABLE` | Local staging storage is not ready. | Check data directory permissions and staging storage. |
| `YOUTUBE_DOCTOR_HEALTH_URL_NOT_CONFIGURED` | Doctor did not check live health. | Set `SHORTSENGINE_YOUTUBE_DOCTOR_URL` when a server is running. |
| `YOUTUBE_DOCTOR_HEALTH_YOUTUBE_INVALID` | Live health has the wrong `youtubeIngest` shape. | Fix health response shape before relying on live proof. |
| `YOUTUBE_SMOKE_URL_NOT_ALLOWED` | URL is not allowlisted. | Set `SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS` or the explicit unlisted gate. |
| `YOUTUBE_PLAYLIST_UNSUPPORTED` | Playlist URLs are rejected before network. | Use one authorized watch or shorts URL. |
| `YOUTUBE_LIVE_UNSUPPORTED` | Live streams are rejected before network. | Use a completed authorized video. |
| `YOUTUBE_SMOKE_HEALTH_NOT_READY` | `/health` is not ready for ingest. | Start a ready server with ingest and downloader configured. |
| `YOUTUBE_SMOKE_FETCH_FAILED` | Smoke could not reach the configured base URL. | Start the server or fix `SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL`. |
| `YOUTUBE_SMOKE_JOB_TIMEOUT` | Render job did not finish in time. | Inspect safe job progress and raise timeout only if expected. |
| `YOUTUBE_SMOKE_DOWNLOAD_NOT_MP4` | Export download did not return MP4. | Check render/export download contract. |
| `YOUTUBE_SMOKE_MP4_SIGNATURE_INVALID` | Downloaded file did not have an MP4 signature. | Check render output and download contract. |
| `YOUTUBE_SMOKE_RESPONSE_LEAK` | Public API response included unsafe fields. | Remove internal fields from public response. |
| `YOUTUBE_SMOKE_REPORT_LEAK` | Smoke report leak guard failed closed. | Remove sensitive output before storing reports. |
| `YOUTUBE_LIVE_E2E_DISABLED` | Local live proof was not explicitly enabled. | Set `SHORTSENGINE_YOUTUBE_LIVE_E2E=1` for manual proof. |
| `YOUTUBE_LIVE_E2E_RIGHTS_REQUIRED` | Local live proof has no explicit rights confirmation. | Set `SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED=1` after rights review. |
| `YOUTUBE_LIVE_E2E_SERVER_BIND_FAILED` | Local server could not bind, often due to sandbox restrictions. | Run outside the restricted sandbox or choose an available local port. |
| `ENV_YOUTUBE_LIVE_E2E_INGEST_DISABLED` | Env readiness rejected live proof before doctor/server work. | Set `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1` only for the manual proof. |
| `ENV_YOUTUBE_LIVE_E2E_URL_MISSING` | Env readiness found no authorized URL. | Set `SHORTSENGINE_YOUTUBE_LIVE_E2E_URL`. |
| `ENV_YOUTUBE_LIVE_E2E_URL_NOT_ALLOWED` | Env readiness found no allowlist/manual gate. | Set `SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS` or `SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED=1`. |

## Default CI Contract

Default CI and local checks must remain no-network and no-downloader:

- `npm run youtube:doctor` is safe with defaults and should skip real ingest.
- `npm run youtube:smoke` is skipped unless `SHORTSENGINE_YOUTUBE_SMOKE=1`.
- `npm run youtube:e2e:local` is skipped unless `SHORTSENGINE_YOUTUBE_LIVE_E2E=1`.
- `npm run proof:local-video` and `npm run youtube:proof:local` are skipped unless `SHORTSENGINE_LOCAL_PROOF_SOURCE` is set with explicit rights confirmation.
- the Playwright YouTube live path is disabled unless `SHORTSENGINE_YOUTUBE_LIVE_E2E_BROWSER=1`.
- Real cloud integration, downloader installation, and authorized YouTube smoke remain manual operator actions.
