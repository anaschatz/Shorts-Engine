# ShortsEngine Environment Contract

This contract prepares ShortsEngine for staging without committing real secrets or requiring cloud deployment. Defaults stay local, deterministic and safe.

Run:

```bash
npm run env:check
```

The command prints a safe JSON readiness summary. It fails closed for invalid numbers, unsupported modes, incomplete cloud configuration, real provider selection without credentials, unsafe browser skip flags and suspicious example secrets.

## App/runtime

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `PORT` | No | `4175` | integer `1..65535` | No | Set from platform port when deploying. | Invalid or out-of-range port fails startup/readiness. |

## Upload/media limits

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `MATCHCUTS_MAX_UPLOAD_BYTES` | No | `262144000` | integer `1024..21474836480` | No | Keep conservative until storage/render capacity is measured. | Invalid size fails readiness. |
| `MATCHCUTS_MAX_DURATION_SECONDS` | No | `1800` | integer `1..86400` | No | Keep short for staging smoke tests. | Invalid duration fails readiness. |

## Remote URL ingest

YouTube URL validation remains available through `POST /api/youtube/validate`. Real YouTube ingest is disabled by default and requires explicit opt-in with `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1`. When enabled, the local adapter invokes the configured downloader with `execFile`, writes only to controlled local staging, validates the MP4 with the same upload/container/size/duration/FFprobe checks, then creates upload/project records only after artifact commit succeeds.

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `SHORTSENGINE_YOUTUBE_INGEST_ENABLED` | No | `0` | boolean | No | Keep disabled until downloader/legal policy is reviewed. | Disabled mode returns `YOUTUBE_INGEST_NOT_ENABLED` and performs no network/downloader work. |
| `SHORTSENGINE_YOUTUBE_AUTHORIZED_IMPORT_ENABLED` | No | `0` | boolean | No | Foundation flag only; keep disabled until a reviewed authorized import adapter exists. | `/health` reports `authorizedImportAvailable: false`; no cookies/tokens are accepted or stored. |
| `SHORTSENGINE_YOUTUBE_DOWNLOADER_BIN` | Only when ingest enabled | `yt-dlp` | command name or absolute binary path without spaces/shell metacharacters | No | Install/manage the downloader outside the app image or platform build step. | Missing downloader returns `YOUTUBE_DOWNLOADER_MISSING`; invalid config fails startup. |
| `SHORTSENGINE_YOUTUBE_PLAYER_CLIENT` | No | empty | enum: `android`, `ios`, `web` | No | Optional yt-dlp YouTube player client override for operator proof when default web clients are throttled or require PO token setup. | Invalid values fail env/config validation; no cookies, visitor data, PO tokens, or raw extractor args are accepted. |
| `SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS` | No | `120000` | integer `1000..600000` | No | Keep bounded; raise only for known long videos within upload limits. | Timeout returns `YOUTUBE_DOWNLOAD_TIMEOUT`. |
| `SHORTSENGINE_YOUTUBE_DOWNLOADER_OUTPUT_BYTES` | No | `65536` | integer `1024..1048576` | No | Keep small to avoid raw provider output in memory. | Oversized downloader output fails safely as `YOUTUBE_DOWNLOAD_FAILED`. |
| `SHORTSENGINE_YOUTUBE_FORMAT_SELECTOR` | No | `bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best` | bounded yt-dlp format selector using safe characters only | No | Prefer MP4-compatible video/audio so FFprobe and render validation stay predictable. | Invalid selectors fail env/config validation before downloader work. |
| `SHORTSENGINE_YOUTUBE_FALLBACK_FORMAT_SELECTOR` | No | `best[ext=mp4]/best` | bounded yt-dlp format selector using safe characters only | No | Used after the first failed attempt to recover from unavailable MP4 split formats. | Invalid selectors fail env/config validation before downloader work. |
| `SHORTSENGINE_YOUTUBE_DOWNLOAD_ATTEMPTS` | No | `2` | integer `1..4` | No | Keep low; this is a reliability retry, not a bypass loop. | Exhausted attempts return the last safe downloader failure with attempt metadata. |
| `SHORTSENGINE_YOUTUBE_RETRY_BACKOFF_MS` | No | `500` | integer `0..10000` | No | Keep short and bounded for operator proof. | Invalid backoff fails env/config validation. |
| `SHORTSENGINE_SOURCE_CACHE_ENABLED` | No | `0` | boolean | No | Enable only for an operator-approved rights-cleared local source cache. | Disabled mode performs no cache lookup; cache misses fall back to downloader when configured. |
| `SHORTSENGINE_SOURCE_CACHE_DIR` | No | `data/source-cache` | safe directory under `data` or system temp | No | Store manually prepared rights-cleared MP4 files here using `<youtube-video-id>.mp4`. | Traversal or outside-storage paths fail configuration/readiness. |
| `SHORTSENGINE_SOURCE_CACHE_REQUIRE_CHECKSUM` | No | `0` | boolean | No | Set `1` when the operator writes a matching `<youtube-video-id>.sha256` file. | Missing or mismatched checksum fails closed without deleting the cache file. |
| `SHORTSENGINE_SOURCE_CACHE_MAX_BYTES` | No | `262144000` | integer `1024..21474836480` | No | Keep at or below upload limits unless storage/render capacity is reviewed. | Oversized cache files are rejected before artifact commit. |
| `SHORTSENGINE_YOUTUBE_PROGRESS_HEARTBEAT_MS` | No | `5000` | integer `250..30000` | No | Keep default unless a managed downloader runtime needs slower staging checks. | The downloader monitor reports bounded heartbeat metadata without raw logs. |
| `SHORTSENGINE_YOUTUBE_NO_PROGRESS_TIMEOUT_MS` | No | `45000` | integer `1000..600000` | No | Raise only for authorized long videos whose staging file is known to pause between chunks. | No-progress stalls return `YOUTUBE_NO_PROGRESS_TIMEOUT` with safe progress diagnostics and partial cleanup. |
| `SHORTSENGINE_YOUTUBE_DOCTOR_URL` | No | empty | `http` or `https` base URL | No | Leave empty for no-network local checks; set only when checking a live local/staging `/health`. | Missing value skips live health validation safely. |
| `SHORTSENGINE_YOUTUBE_DOCTOR_TIMEOUT_MS` | No | `5000` | integer `1000..120000` | No | Keep short; doctor should not become a long-running smoke. | Invalid timeout fails doctor safely. |
| `SHORTSENGINE_YOUTUBE_SMOKE` | No | `0` | explicit `1` to enable | No | Keep disabled except for manual authorized real-ingest proof. | Smoke exits as skipped and performs no network work unless enabled. |
| `SHORTSENGINE_YOUTUBE_SMOKE_URL` | Only when smoke enabled | empty | supported YouTube watch, shortlink or shorts URL | No | Use only a URL you are authorized to download/process. | Empty, playlist, live, embed, channel, search, credentialed or non-YouTube URLs fail before network. |
| `SHORTSENGINE_YOUTUBE_SMOKE_BASE_URL` | No | local `PORT` base | `http` or `https` base URL without credentials | No | Set to local/staging app base URL when testing a running server. | Invalid base URL fails before network. |
| `SHORTSENGINE_YOUTUBE_SMOKE_ALLOWED_IDS` | No | empty | comma-separated YouTube video ids | No | Prefer allowlisting known safe smoke videos. | If unset, `SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED=1` is required. |
| `SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED` | No | `0` | boolean | No | Use only for intentional manual smoke runs. | Smoke fails before network when URL is not allowlisted and this is disabled. |
| `SHORTSENGINE_YOUTUBE_SMOKE_TIMEOUT_MS` | No | `120000` | integer `1000..900000` | No | Keep bounded. | Invalid timeout fails smoke. |
| `SHORTSENGINE_YOUTUBE_SMOKE_REQUEST_TIMEOUT_MS` | No | computed from `SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS * SHORTSENGINE_YOUTUBE_DOWNLOAD_ATTEMPTS + 30000`, minimum `120000` | integer `1000..900000` | No | Override only for authorized videos whose ingest request needs more time while the downloader stages media; default covers the bounded retry cycle. | Invalid timeout fails smoke; request timeout returns structured ingest diagnostics instead of misleading success. |
| `SHORTSENGINE_YOUTUBE_SMOKE_JOB_TIMEOUT_MS` | No | `90000` | integer `1000..600000` | No | Keep bounded for render proof. | Invalid job timeout fails smoke. |
| `SHORTSENGINE_YOUTUBE_SMOKE_POLL_INTERVAL_MS` | No | `750` | integer `100..10000` | No | Keep default unless staging needs slower polling. | Invalid poll interval fails smoke. |
| `SHORTSENGINE_YOUTUBE_SMOKE_DOWNLOAD_MAX_BYTES` | No | `83886080` | integer `1024..536870912` | No | Keep downloads bounded for smoke reports. | Oversized download fails smoke before report write. |
| `SHORTSENGINE_YOUTUBE_LIVE_E2E` | No | `0` | boolean | No | Keep disabled except for an operator-run local proof. | Enabled mode fails `env:check` unless ingest, rights, URL and allowlist/manual gate are configured. |
| `SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED` | No | `0` | boolean | No | Set only after rights/legal review for the configured URL. | Live proof fails before doctor/server work when missing. |
| `SHORTSENGINE_YOUTUBE_LIVE_E2E_URL` | Only when live/browser proof enabled | empty | supported YouTube watch, shortlink or shorts URL | No | Use only an authorized URL you are allowed to process. | Empty, playlist, live, embed, channel, search, credentialed or non-YouTube URLs fail before network. |
| `SHORTSENGINE_YOUTUBE_LIVE_E2E_PORT` | No | auto | integer `1..65535` | No | Leave unset unless a fixed local port is required. | Invalid port fails readiness/proof before server bind. |
| `SHORTSENGINE_YOUTUBE_LIVE_E2E_TIMEOUT_MS` | No | `900000` | integer `1000..900000` | No | Keep bounded; lower for short local proof runs if needed. | Invalid timeout fails readiness/proof. |
| `SHORTSENGINE_YOUTUBE_LIVE_E2E_BROWSER` | No | `0` | boolean | No | Keep disabled in CI release gates; enable only for manual UI proof. | Enabled mode uses the same ingest, rights, URL and allowlist/manual gates. |

Operator-only local proof guardrails:

| Variable | Purpose |
| --- | --- |
| `SHORTSENGINE_YOUTUBE_LIVE_E2E` | Enables `npm run youtube:e2e:local`; defaults to skipped and must be paired with ingest enablement, URL, rights confirmation and the smoke allowlist or explicit unlisted gate. |
| `SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED` | Explicit confirmation that the operator has rights to process the configured URL. |
| `SHORTSENGINE_YOUTUBE_LIVE_E2E_URL` | Authorized YouTube URL for local live proof; same URL restrictions as smoke. |
| `SHORTSENGINE_YOUTUBE_LIVE_E2E_PORT` | Optional fixed local server port; invalid values fail before server bind. |
| `SHORTSENGINE_YOUTUBE_LIVE_E2E_TIMEOUT_MS` | Bounded wall-clock timeout for the local proof. |
| `SHORTSENGINE_YOUTUBE_LIVE_E2E_BROWSER` | Enables the optional Playwright browser YouTube live path; defaults off and must not be used in CI release gates. |

`npm run env:check` validates these live proof flags too. The user must explicitly confirm usage rights before validation or ingest. Playlists, live streams, credentialed URLs, unsupported hosts, embeds, channels and search pages are rejected before any downloader call. Downloader failures are classified into safe codes such as `YOUTUBE_AUTH_REQUIRED`, `YOUTUBE_BOT_CHECK_REQUIRED`, `YOUTUBE_COOKIES_REQUIRED`, `YOUTUBE_VIDEO_PRIVATE`, `YOUTUBE_VIDEO_UNAVAILABLE`, `YOUTUBE_GEO_RESTRICTED`, `YOUTUBE_AGE_RESTRICTED` and `YOUTUBE_RATE_LIMITED`; the recovery path is another public video, retry when marked retryable, or MP4 fallback until authorized import is built. Public responses, doctor output and smoke reports never include local paths, storage keys, raw stdout/stderr, signed tokens or secrets.

Run `npm run youtube:doctor` at any time. With default config it returns a safe skipped summary and next action; with ingest enabled it validates downloader or operator-approved source cache readiness, downloader version when available, configured timeout, bounded format strategy, FFmpeg/FFprobe, storage staging readiness and optionally a live `/health` `youtubeIngest` shape when `SHORTSENGINE_YOUTUBE_DOCTOR_URL` is configured.

Run `npm run youtube:smoke` only for manual authorized proof. It requires `SHORTSENGINE_YOUTUBE_SMOKE=1`, `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1`, a safe URL, downloader or source-cache readiness, and either a smoke URL allowlist or `SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED=1`. It validates `/health`, `/api/youtube/validate`, `/api/youtube/ingest`, generate, job polling, export download and MP4 signature, then writes `demo/results/youtube-smoke-latest.json`.

Run `npm run youtube:e2e:local`, `npm run youtube:proof`, or the explicit operator alias `npm run youtube:proof:operator` only for manual local proof. They default to skipped, run `env:check` before doctor/server work, require `SHORTSENGINE_YOUTUBE_LIVE_E2E=1`, `SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED=1`, a safe URL, `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1`, downloader or operator-approved source cache readiness, and the same smoke allowlist or explicit unlisted gate. They write `demo/results/youtube-live-e2e-latest.json` with safe `command`, `phase`, `passed`, `skipped`, `nextAction` and triage summaries.

Run `npm run proof:local-video` or `npm run youtube:proof:local` only when the operator has a rights-cleared local MP4 and the downloader path is blocked before OCR/evidence analysis. The commands default to skipped and require `SHORTSENGINE_LOCAL_PROOF_SOURCE`, `SHORTSENGINE_LOCAL_PROOF_RIGHTS_CONFIRMED=1`, and `SHORTSENGINE_LOCAL_PROOF_EXPECTED_COUNTED_GOALS`. Optional proof-only OCR flags are `SHORTSENGINE_LOCAL_PROOF_SCOREBOARD_OCR=1` and `SHORTSENGINE_LOCAL_PROOF_SCOREBOARD_OCR_QA=1`. Reports go to `demo/results/local-video-proof-latest.json`; successful MP4s are written under `manual-downloads/` only after the valid-goals-only output gate, the independent segment proof contract, ffprobe, rendered social-polish QA, and bounded visual-frame QA pass. Visual-frame QA decodes sampled timestamps from the final MP4 with FFmpeg but stores only safe frame status metadata, not raw frames. If ffprobe or visual-frame QA fails, the generated proof artifact is discarded and the report stays failed.

Use `docs/YOUTUBE_INGEST_MANUAL_SMOKE.md` before the first real downloader run. It documents rights review, downloader verification, safe env flags, report reading, safe cleanup and troubleshooting codes.

## FFmpeg/render limits

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `FFMPEG_BIN` | No | `ffmpeg` | command name or deployment-managed binary reference | No | Prefer platform-installed `ffmpeg`. | Value is not echoed in readiness output. |
| `FFPROBE_BIN` | No | `ffprobe` | command name or deployment-managed binary reference | No | Prefer platform-installed `ffprobe`. | Value is not echoed in readiness output. |
| `MATCHCUTS_RENDER_TIMEOUT_MS` | No | `300000` | integer `1000..3600000` | No | Keep default for staging. | Invalid timeout fails readiness. |
| `MATCHCUTS_ANALYSIS_TIMEOUT_MS` | No | `45000` | integer `1000..600000` | No | Keep default unless fixtures become slower. | Invalid timeout fails readiness. |

## Scoreboard OCR

Scoreboard OCR is deterministic fallback by default. Local OCR must be installed and enabled by the operator outside ShortsEngine; the app never installs OCR runtimes, never requests tokens and never requires network for OCR. When local OCR is enabled, ShortsEngine crops bounded top scoreboard regions from sampled frames in staging, runs the configured OCR command with `execFile`, normalizes only structured score/clock evidence, and cleans OCR crops after analysis. OCR evidence can support a valid goal only when paired with ball-in-net/action context; OCR-only score changes and ambiguous/unreadable text fail closed.

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `SHORTSENGINE_SCOREBOARD_OCR_ENABLED` | No | `0` | boolean | No | Keep disabled until a local OCR runtime is installed and verified manually. | Disabled mode uses deterministic fallback and does not spawn OCR. |
| `SHORTSENGINE_SCOREBOARD_OCR_PROVIDER` | No | `deterministic` | `deterministic`, `local` | No | Use `local` only for operator-controlled environments with OCR installed. | Unsupported provider fails readiness/startup. |
| `SHORTSENGINE_SCOREBOARD_OCR_BIN` | No | `tesseract` | command name or absolute binary path without spaces/shell metacharacters | No | Install/manage the OCR command outside the app; verify manually with `tesseract --version`. | Missing runtime reports degraded health and falls back. |
| `SHORTSENGINE_SCOREBOARD_OCR_TIMEOUT_MS` | No | `10000` | integer `250..60000` | No | Keep bounded; raise only if OCR is consistently timing out on known hardware. | Timeout falls back without raw stdout/stderr in public output. |
| `SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS` | No | `0` | boolean | No | Enable only for live scoreboard OCR proof debugging. | Disabled mode writes no live scoreboard OCR crop/contact-sheet artifacts. |
| `SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACT_RETENTION` | No | `8` | integer `1..50` | No | Keep bounded so live OCR crop QA runs do not grow without limit. | Invalid retention fails environment readiness. |
| `SHORTSENGINE_OCR_QA_ARTIFACTS` | No | `0` | boolean | No | Enable only for local/operator debugging. | Disabled mode writes no crop thumbnails. |
| `SHORTSENGINE_OCR_QA_ARTIFACT_RETENTION` | No | `8` | integer `1..50` | No | Keep bounded so local debug crops do not grow without limit. | Invalid retention fails environment readiness. |
| `SHORTSENGINE_OCR_QA_REVIEW_REF` | No | `demo/results/ocr-qa-review-latest.json` | safe repo-relative JSON report path | No | Use only with an operator-reviewed OCR QA report when testing local OCR support. | Missing/invalid/stale reports are ignored and OCR remains support-only. |

Manual local OCR check:

```bash
npm run ocr:doctor
npm run ocr:smoke
tesseract --version
SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1 SHORTSENGINE_SCOREBOARD_OCR_PROVIDER=local npm run ocr:doctor
SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1 SHORTSENGINE_SCOREBOARD_OCR_PROVIDER=local npm run ocr:smoke
SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1 SHORTSENGINE_SCOREBOARD_OCR_PROVIDER=local SHORTSENGINE_OCR_QA_ARTIFACTS=1 npm run ocr:smoke
SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1 SHORTSENGINE_SCOREBOARD_OCR_PROVIDER=local SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS=1 npm run youtube:proof:operator
npm run ocr:qa:review
SHORTSENGINE_OCR_QA_REVIEW_INPUT=demo/results/ocr-qa-review-input.json npm run ocr:qa:review
SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1 SHORTSENGINE_SCOREBOARD_OCR_PROVIDER=local SHORTSENGINE_OCR_QA_REVIEW_REF=demo/results/ocr-qa-review-2026-06-19T10-00-00-000Z.json npm run youtube:proof:operator
```

`npm run ocr:doctor` is readiness-only and never installs Tesseract. `npm run ocr:smoke` writes `demo/results/ocr-latest.json` plus a timestamped OCR smoke report. With defaults it passes in deterministic fallback mode; with local OCR explicitly enabled it fails closed when the runtime is missing. OCR smoke reports keep crop thumbnails disabled by default and never persist OCR text, binary paths, local crop paths, stdout, stderr or secrets.

When `SHORTSENGINE_OCR_QA_ARTIFACTS=1`, OCR smoke writes bounded scoreboard crop thumbnails under `demo/results/ocr-artifacts/<run-id>/` plus `ocr-qa-manifest.json` with safe relative refs, crop counts and byte limits. For live scoreboard proof, prefer `SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS=1`; it writes `demo/results/ocr-scoreboard-qa-latest.json`, a `contact-sheet.json` and a local `review.html` under `demo/results/scoreboard-ocr-artifacts/<run-id>/` with each OCR attempt, crop ref, preprocessing variant, digit-reader status, image-decoder status, image-segmentation status, digit-box counts, sanitized OCR text preview, parsed score and ambiguity reason. The focused scorebug digit reader now tries explicit structured readings first, then image-based segmentation for staging-safe focused scorebug crops, then calibrated fallback, and otherwise fails closed. Real PNG/JPG scorebug crops are converted through a bounded FFmpeg-to-PGM decoder before segmentation; unsupported/corrupt/timeout cases remain fail-closed with safe reason codes. These artifacts are local debug-only, ignored by git, omitted from default CI artifact uploads and cleaned by bounded retention. OCR crop QA helps verify scoreboard framing and readability; OCR/digit evidence still cannot confirm a goal without matching football action evidence.

`npm run ocr:qa:review` scores a manual/operator review JSON against an existing OCR QA manifest. With no input it writes a safe skipped report to `demo/results/ocr-qa-review-latest.json`; with `SHORTSENGINE_OCR_QA_REVIEW_INPUT` it validates the manifest ref, bounded crop ids and boolean crop-quality observations, then writes support-only calibration metrics. The report stores no raw OCR text, full frames, local crop paths, stdout/stderr, provider output, tokens or secrets. The backend consumes only a normalized calibration summary from `server/ocr-qa-calibration.cjs`: missing, skipped, stale or invalid reports are ignored, while high-quality OCR QA can only become supporting evidence next to visual football action. It never confirms a goal without football action evidence.

`/health` reports `scoreboardOcr.providerMode`, `localOcrEnabled`, `runtimeAvailable`, `fallbackAvailable` and `networkRequired` without binary paths, local crop paths, raw OCR text, stdout, stderr or secrets.

## Optional Action Tracking

Action-aware framing is deterministic and safe by default. Optional OpenCV tracking can be enabled on an operator machine to provide stronger ball/player/action-center hints, but it is not required for tests, eval, demo or CI. Tracking never confirms goals and cannot override the goal evidence gate.

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `SHORTSENGINE_TRACKING_PROVIDER` | No | `safe` | `safe`, `mock`, `external`, `opencv` | No | Keep `safe` unless an operator has installed and verified OpenCV locally. | Unknown values fall back to the safe deterministic provider. |
| `SHORTSENGINE_OPENCV_TRACKING_ENABLED` | No | `0` | boolean | No | Enable only for manual local proof on a machine with Python/OpenCV installed. | Disabled mode returns deterministic tracking fallback and does not spawn Python. |
| `SHORTSENGINE_OPENCV_PYTHON_BIN` | No | `python3` | command name or absolute binary path without spaces/shell metacharacters | No | Install/manage Python/OpenCV outside the app; verify manually. | Missing runtime reports safe degraded tracking health and falls back. |
| `SHORTSENGINE_OPENCV_TRACKING_TIMEOUT_MS` | No | `3500` | integer `250..12000` | No | Keep short; tracking is a hint provider, not a blocking render dependency. | Timeout returns `OPENCV_TRACKING_TIMEOUT` and falls back without raw stdout/stderr. |

`/health` reports `trackingProvider.mode`, `enabled`, `pythonAvailable`, `opencvAvailable`, `objectTracking`, `fallbackMode` and safe failure codes only. It does not expose binary paths, sampled frame paths, stdout/stderr, tokens, cookies, storage keys or raw provider errors. If tracking confidence is low, crop planning must use `wide_safe` or `locked_wide`; `soft_follow` is allowed only with reliable ball/player/action evidence and contained action bounds.

## Worker/job settings

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `MATCHCUTS_WORKER_POLL_INTERVAL_MS` | No | `0` | integer `0..60000` | No | Keep `0` for in-process/local queue behavior. | Invalid interval fails readiness. |
| `MATCHCUTS_WORKER_SHUTDOWN_TIMEOUT_MS` | No | `10000` | integer `0..600000` | No | Keep default. | Invalid timeout fails readiness. |
| `MATCHCUTS_WORKER_RETRY_INITIAL_DELAY_MS` | No | `1000` | integer `0..600000` | No | Keep default. | Invalid retry delay fails readiness. |
| `MATCHCUTS_WORKER_RETRY_MAX_DELAY_MS` | No | `30000` | integer `0..3600000` | No | Keep default. | Initial delay greater than max delay fails readiness. |
| `MATCHCUTS_WORKER_RETRY_MAX_ATTEMPTS` | No | `2` | integer `1..10` | No | Keep low in staging. | Invalid attempts fail readiness. |
| `MATCHCUTS_ARTIFACT_CLEANUP_INTERVAL_MS` | No | `0` | integer `0..86400000` | No | Keep disabled until cleanup policy is reviewed. | Invalid interval fails readiness. |

## Storage/artifact adapter

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `MATCHCUTS_STORAGE_ADAPTER` | No | `local` | `local`, `mock-cloud`, `s3`, `r2`, `gcs` | No | Use `local` or `mock-cloud` first; use `s3`/`r2` only with explicit credentials. | Unsupported mode fails readiness; `gcs` is not staging-ready yet. |
| `MATCHCUTS_STORAGE_BUCKET` | Only for `s3`/`r2` | empty | provider bucket name | No | Configure only for object-storage staging. | Missing bucket with cloud adapter fails readiness. |
| `MATCHCUTS_STORAGE_REGION` | Required for `s3` | empty | provider region | No | Required for S3 staging. | Missing S3 region fails readiness. |
| `MATCHCUTS_STORAGE_ENDPOINT` | Required for `r2` | empty | `http` or `https` URL | No | Required for R2 staging. | Invalid or missing R2 endpoint fails readiness. |
| `MATCHCUTS_STORAGE_ACCESS_KEY_ID` | Only for `s3`/`r2` | empty | deployment secret | Yes | Store only in the hosting provider secret manager. | Missing cloud credential fails readiness. |
| `MATCHCUTS_STORAGE_SECRET_ACCESS_KEY` | Only for `s3`/`r2` | empty | deployment secret | Yes | Store only in the hosting provider secret manager. | Missing cloud credential fails readiness. |
| `MATCHCUTS_STORAGE_SESSION_TOKEN` | No | empty | deployment secret | Yes | Use only when provider requires temporary credentials. | Invalid credential shape fails readiness. |
| `MATCHCUTS_STORAGE_FORCE_PATH_STYLE` | No | `false` | boolean | No | Use only for S3-compatible endpoints that need it. | Invalid boolean fails readiness. |
| `MATCHCUTS_MULTIPART_THRESHOLD_BYTES` | No | `67108864` | integer `5242880..5368709120` | No | Keep default. | Invalid multipart config fails readiness. |
| `MATCHCUTS_MULTIPART_PART_SIZE_BYTES` | No | `16777216` | integer `5242880..536870912` | No | Keep default. | Part size greater than threshold fails readiness. |
| `MATCHCUTS_ARTIFACT_CLEANUP_MAX_AGE_SECONDS` | No | `86400` | integer `60..31536000` | No | Keep default. | Invalid age fails readiness. |
| `MATCHCUTS_ARTIFACT_CLEANUP_MAX_PER_RUN` | No | `100` | integer `1..1000` | No | Keep default. | Invalid count fails readiness. |

## Persistence adapter

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `MATCHCUTS_PERSISTENCE_ADAPTER` | No | `local` | `local`, `sqlite` | No | Use `sqlite` for staging-like durable behavior. | Unsupported adapter fails readiness. |
| `MATCHCUTS_SQLITE_FILE` | No | `shortsengine.sqlite` | filename ending `.sqlite`, `.sqlite3`, or `.db` | No | Use a simple filename only. | Traversal, separators or invalid extension fail readiness. |

When `sqlite` is enabled, the adapter owns projects, uploads, artifacts, exports, jobs, regeneration draft audits, regeneration approvals and approval outbox rows behind the same repository boundary used by local defaults. Approval audit/outbox rows store only safe identifiers, lifecycle statuses, timestamps and error codes; they must not include raw edit plans, captions, provider output, local paths, storage keys or secrets. `/health` reports aggregate repository readiness and outbox counts only.

The approval outbox has a worker-ready lifecycle: `pending`, `processing`, `delivered`, `failed` and `dead_letter`. `processed` is treated as a legacy alias for `delivered` during restore. The default worker uses a local no-op audit handler, so `npm run outbox:health` and `npm run outbox:drain` require no secrets, no network and no external delivery provider. Stale processing locks are recovered with bounded retries and dead-lettering after max attempts. `/health` exposes only aggregate outbox readiness, counts, oldest pending age and worker configuration; it must not expose payload internals, storage keys, local paths or raw handler/provider errors.

## Transcription/AI provider

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `MATCHCUTS_TRANSCRIPTION_PROVIDER` | No | `mock` | `mock`, `openai` | No | Keep `mock` until real-provider staging is intentional. | `openai` without credential fails readiness. |
| `MATCHCUTS_TRANSCRIPTION_TIMEOUT_MS` | No | `60000` | integer `1000..900000` | No | Keep default. | Invalid timeout fails readiness. |
| `MATCHCUTS_TRANSCRIPTION_RETRIES` | No | `1` | integer `0..5` | No | Keep default. | Invalid retry count fails readiness. |
| `OPENAI_TRANSCRIPTION_MODEL` | No | `gpt-4o-mini-transcribe` | provider model name | No | Set only when testing a specific model. | Value is not used unless provider is real. |
| `OPENAI_API_KEY` | Required only for `openai` provider | empty | deployment secret | Yes | Store only in the hosting provider secret manager. | Real provider without credential fails readiness. |

## Football analysis safety

Goal classification is evidence-gated. The analysis layer may use sampled visual
labels such as `shot_contact`, `ball_toward_goal`, `goal_mouth_visible`,
`keeper_action`, `ball_in_net` and `celebration_after_shot`, but it must not
claim `goal` from crowd noise, coach reaction, goal-area visibility or shot-like
motion alone. A goal claim requires a strong action sequence, such as shot or
contact evidence, ball trajectory toward the goal, goal-mouth context and either
ball-in-net/line-crossing evidence or celebration after the shot. Weak or medium
visual evidence remains a chance/save/reaction style moment.

Action-first story windows prefer build-up, shot/contact, ball trajectory,
goal-mouth/keeper action and payoff before reaction shots. Strong or medium
goal-sequence evidence may expand the selected source window to a 12-22 second
story segment; reaction-only windows are demoted unless they support an action
moment. Evaluation reports include safe aggregate metrics such as
`goalSequenceRecall`, `shotToPayoffCoverage`, `actionWindowCoverage`,
`ballPlayerVisibilityScore` and `referenceStyleSimilarity`.

## Signed delivery

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `MATCHCUTS_STORAGE_SIGNED_URL_TTL_SECONDS` | No | `300` | integer `1..900` | No | Keep short in staging. | Out-of-bounds TTL fails readiness. |

## Cloud integration

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `MATCHCUTS_RUN_REAL_CLOUD_TESTS` | No | `0` | `0` or explicit `1` | No | Keep `0` in CI and default staging. | Enabling without object storage config fails readiness. |

## Staging deployment/readiness

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `SHORTSENGINE_DEPLOY_TARGET` | No | `local` | `local`, `staging` | No | Keep `local` until Render staging is configured. | `staging` requires URL, supported provider and protected credential. |
| `SHORTSENGINE_STAGING_DEPLOY_PROVIDER` | Required when target is `staging` | `none` | `none`, `render` | No | Keep `none` for readiness-only mode; use `render` only after the GitHub Environment is configured. | Provider without staging target or unsupported provider fails readiness/deploy safely. |
| `SHORTSENGINE_STAGING_SERVICE_ID` | Required for Render staging deploy | empty | Render service id beginning with `srv-` | No | Store as a protected GitHub Environment variable. | Missing or invalid Render service id fails readiness/deploy. |
| `SHORTSENGINE_STAGING_URL` | Required for deployed smoke and staging target | empty | `http` or `https` URL without credentials, private IPs or local-network hosts | No | Set to the deployed staging base URL after a provider is wired. | Missing, invalid, credentialed, private, link-local or unsafe local URLs fail smoke/readiness. |
| `SHORTSENGINE_STAGING_ALLOW_LOCAL_URL` | No | `0` | boolean | No | Keep disabled for remote staging; enable only for explicit local smoke. | Localhost/private-network staging URLs fail unless this is enabled. |
| `SHORTSENGINE_STAGING_SMOKE_TIMEOUT_MS` | No | `30000` | integer `1000..120000` | No | Keep default. | Invalid timeout fails readiness/smoke. |
| `SHORTSENGINE_STAGING_SMOKE_RETRIES` | No | `2` | integer `0..5` | No | Keep default. | Invalid retry count fails readiness/smoke. |
| `SHORTSENGINE_STAGING_DEPLOY_TOKEN` | Required when target is `staging` and provider is `render` | empty | GitHub Environment secret | Yes | Store only in the GitHub Environment `staging`. | Missing provider credential fails readiness/deploy. |
| `SHORTSENGINE_STAGING_FULL_SMOKE` | No | `0` | explicit `1` to enable | No | Keep disabled except for manual full upload/render proof. | Full staging smoke fails closed unless enabled. |
| `SHORTSENGINE_STAGING_FULL_SMOKE_FIXTURE` | No | `demo/fixtures/shortsengine-demo-source.mp4` | safe file under `demo/fixtures/` | No | Use the default fixture for deterministic staging proof. | Traversal, unsupported extensions or missing files fail full smoke. |
| `SHORTSENGINE_STAGING_FULL_SMOKE_TIMEOUT_MS` | No | `120000` | integer `5000..600000` | No | Keep default. | Invalid timeout fails full smoke. |
| `SHORTSENGINE_STAGING_FULL_SMOKE_JOB_TIMEOUT_MS` | No | `90000` | integer within full timeout | No | Keep default. | Invalid job timeout fails full smoke. |
| `SHORTSENGINE_STAGING_FULL_SMOKE_POLL_INTERVAL_MS` | No | `750` | integer `100..10000` | No | Keep default. | Invalid poll interval fails full smoke. |
| `SHORTSENGINE_STAGING_FULL_SMOKE_DOWNLOAD_MAX_BYTES` | No | `83886080` | integer `1024..536870912` | No | Keep bounded for staging exports. | Oversized downloads fail full smoke. |
| `SHORTSENGINE_STAGING_FULL_SMOKE_FIXTURE_MAX_BYTES` | No | `33554432` | integer `1024..262144000` | No | Keep fixture small. | Oversized fixtures fail full smoke. |
| `SHORTSENGINE_STAGING_FULL_SMOKE_ALLOW_DEGRADED` | No | `0` | boolean | No | Use only when health is degraded but FFmpeg/FFprobe are ready and the degradation is understood. | Degraded health fails full smoke by default. |
| `SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP` | No | `0` | explicit `1` to delete | No | Keep unset for dry-run cleanup. | Real cleanup is disabled unless exactly `1`. |
| `SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP_MAX_AGE_SECONDS` | No | `0` | integer `0..31536000` | No | Use `0` for immediate manual smoke cleanup or raise it for retention. | Invalid max age fails cleanup. |
| `SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP_MAX_COUNT` | No | `20` | integer `1..1000` | No | Keep bounded per run. | Invalid max count fails cleanup. |

## Browser/demo/CI flags

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `DEMO_SMOKE_PORT` | No | auto | integer `1..65535` | No | Leave unset. | Invalid port fails readiness. |
| `DEMO_SMOKE_TIMEOUT_MS` | No | `120000` | integer `1000..600000` | No | Keep default. | Invalid timeout fails readiness. |
| `PLAYWRIGHT_SMOKE_PORT` | No | auto | integer `1..65535` | No | Leave unset. | Invalid port fails readiness. |
| `PLAYWRIGHT_SMOKE_JOB_TIMEOUT_MS` | No | `120000` | integer `1000..600000` | No | Keep default. | Invalid timeout fails readiness. |
| `PLAYWRIGHT_SMOKE_TIMEOUT_MS` | No | `120000` | integer `1000..600000` | No | Keep default. | Invalid timeout fails readiness. |
| `SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP` | No | `0` | boolean | No | Keep disabled for release/staging readiness. | Enabled skip fails readiness. |
| `SHORTSENGINE_BROWSER_E2E_RETENTION_MAX` | No | `20` | integer `1..200` | No | Keep default. | Invalid retention fails readiness. |
| `SHORTSENGINE_BROWSER_E2E_TRACE` | No | `0` | boolean | No | Enable only for debugging failures. | Invalid boolean fails readiness. |
| `SHORTSENGINE_BROWSER_E2E_VIDEO` | No | `0` | boolean | No | Enable only for debugging failures. | Invalid boolean fails readiness. |
| `SHORTSENGINE_CI_REPORT_MAX_AGE_MS` | No | `7200000` | integer `60000..86400000` | No | Keep default. | Invalid freshness window fails readiness. |

## Manual OCR QA Review UI

The local UI exposes an operator-only OCR QA panel through safe API boundaries:

- `GET /api/ocr-qa/latest` loads the latest managed OCR crop manifest from the latest OCR smoke report.
- `GET /api/ocr-qa/crop?manifest=...&id=...` streams only validated managed PNG crop thumbnails.
- `POST /api/ocr-qa/review` writes support-only calibration to `demo/results/ocr-qa-review-latest.json`.

Generate reviewable crops manually with:

```bash
SHORTSENGINE_OCR_QA_ARTIFACTS=1 npm run ocr:smoke
```

The UI never displays raw OCR text, full frames, local absolute paths, storage keys, stdout/stderr or provider output. OCR calibration remains support-only and cannot confirm goals without football action evidence.

## Staging Readiness Checklist

1. Install dependencies with `npm ci`.
2. Run `npm run env:check`.
3. Run `npm run staging:check`.
4. Run `npm run render:check`.
5. Run `npm run render:manual`.
6. Run `npm run render:proof`.
7. Run `npm run release:check`.
8. Run `npm run release:readiness`.
9. If remote GitHub proof is needed, run `npm run github:setup` and authenticate `gh` manually before `npm run github:doctor`; safe failures may suggest `brew install gh`, `gh --version`, `gh auth login` and `gh auth status`, but ShortsEngine never executes those setup/auth commands automatically.
10. After a validated push, run `npm run remote:ci` and `npm run remote:ci:proof`; the proof must match the exact commit SHA and uses `GITHUB_CLI_MISSING`, `GITHUB_AUTH_MISSING`, `GITHUB_NETWORK_UNAVAILABLE`, `REMOTE_CI_NETWORK_UNAVAILABLE`, `REMOTE_CI_RUN_NOT_FOUND`, `REMOTE_CI_TIMEOUT` and `REMOTE_CI_SHA_MISMATCH` as safe recovery codes.
11. Run `npm run youtube:doctor`; default disabled mode should return a safe skipped summary.
12. Start the server with staging env values.
13. Check `GET /health` and require `status: "ready"` unless a documented degraded dependency is expected.
14. Run deployed smoke with `SHORTSENGINE_STAGING_URL=... npm run staging:smoke`.
15. Run opt-in full smoke only when intentional: `SHORTSENGINE_STAGING_FULL_SMOKE=1 SHORTSENGINE_STAGING_URL=... npm run staging:smoke:full`.
16. Run opt-in YouTube smoke only when authorized and downloader-ready: `SHORTSENGINE_YOUTUBE_SMOKE=1 SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 SHORTSENGINE_YOUTUBE_SMOKE_URL=... npm run youtube:smoke`.
17. Run explicit operator YouTube proof only when authorized and downloader-ready: `SHORTSENGINE_YOUTUBE_LIVE_E2E=1 SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED=1 SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 SHORTSENGINE_YOUTUBE_LIVE_E2E_URL=... npm run youtube:proof:operator`.
18. Run cleanup dry-run after full smoke: `npm run staging:smoke:cleanup`.
19. Run explicit smoke cleanup only when intended: `SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP=1 npm run staging:smoke:cleanup`.
20. Run `npm run demo:fixture`, `npm run demo:smoke`, `npm run demo:browser`, and `npm run demo:browser:ci`.
21. Run `npm run outbox:health` and, when pending approval lifecycle events should be locally delivered to the no-op handler, `npm run outbox:drain`.
22. Run `npm run ci:reports` and `npm run release:evidence`.
23. Inspect failure-only artifacts only if a gate fails.
24. Configure GitHub branch protection as documented in `docs/RELEASE.md` and GitHub Environment protection as documented in `docs/STAGING_DEPLOYMENT.md`.

## Render Staging Runtime

For the first live staging deployment, use a Render Node.js Web Service with:

- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/health`
- `PORT` supplied by Render
- `MATCHCUTS_TRANSCRIPTION_PROVIDER=mock`
- `MATCHCUTS_PERSISTENCE_ADAPTER=sqlite`
- `MATCHCUTS_STORAGE_ADAPTER=local` or `mock-cloud`

`npm run render:check` validates the Render-facing environment contract without calling Render APIs. It keeps provider `none` as readiness-only and requires public URL, `srv-...` service id and protected deploy token before provider `render` can proceed.

`npm run render:manual` prints the safe live setup checklist. `npm run render:proof` executes the local readiness chain in provider `none` mode so no Render API call is made.

Render local filesystem storage is ephemeral unless a disk is attached. Treat local/mock-cloud storage as initial staging only; durable staging should move uploads/renders to object storage and use database-backed persistence.

Never commit real `.env` files, provider keys, cloud credentials, database files, uploads, renders, or generated reports.
