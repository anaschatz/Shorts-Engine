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

## FFmpeg/render limits

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `FFMPEG_BIN` | No | `ffmpeg` | command name or deployment-managed binary reference | No | Prefer platform-installed `ffmpeg`. | Value is not echoed in readiness output. |
| `FFPROBE_BIN` | No | `ffprobe` | command name or deployment-managed binary reference | No | Prefer platform-installed `ffprobe`. | Value is not echoed in readiness output. |
| `MATCHCUTS_RENDER_TIMEOUT_MS` | No | `300000` | integer `1000..3600000` | No | Keep default for staging. | Invalid timeout fails readiness. |
| `MATCHCUTS_ANALYSIS_TIMEOUT_MS` | No | `45000` | integer `1000..600000` | No | Keep default unless fixtures become slower. | Invalid timeout fails readiness. |

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

## Transcription/AI provider

| Variable | Required | Default | Allowed values | Secret | Staging recommendation | Fail-closed behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `MATCHCUTS_TRANSCRIPTION_PROVIDER` | No | `mock` | `mock`, `openai` | No | Keep `mock` until real-provider staging is intentional. | `openai` without credential fails readiness. |
| `MATCHCUTS_TRANSCRIPTION_TIMEOUT_MS` | No | `60000` | integer `1000..900000` | No | Keep default. | Invalid timeout fails readiness. |
| `MATCHCUTS_TRANSCRIPTION_RETRIES` | No | `1` | integer `0..5` | No | Keep default. | Invalid retry count fails readiness. |
| `OPENAI_TRANSCRIPTION_MODEL` | No | `gpt-4o-mini-transcribe` | provider model name | No | Set only when testing a specific model. | Value is not used unless provider is real. |
| `OPENAI_API_KEY` | Required only for `openai` provider | empty | deployment secret | Yes | Store only in the hosting provider secret manager. | Real provider without credential fails readiness. |

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

## Staging Readiness Checklist

1. Install dependencies with `npm ci`.
2. Run `npm run env:check`.
3. Run `npm run staging:check`.
4. Run `npm run render:check`.
5. Run `npm run render:manual`.
6. Run `npm run render:proof`.
7. Run `npm run release:check`.
8. Run `npm run release:readiness`.
9. If remote GitHub proof is needed, run `npm run github:setup` and authenticate `gh` manually before `npm run github:doctor`.
10. Start the server with staging env values.
11. Check `GET /health` and require `status: "ready"` unless a documented degraded dependency is expected.
12. Run deployed smoke with `SHORTSENGINE_STAGING_URL=... npm run staging:smoke`.
13. Run opt-in full smoke only when intentional: `SHORTSENGINE_STAGING_FULL_SMOKE=1 SHORTSENGINE_STAGING_URL=... npm run staging:smoke:full`.
14. Run cleanup dry-run after full smoke: `npm run staging:smoke:cleanup`.
15. Run explicit smoke cleanup only when intended: `SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP=1 npm run staging:smoke:cleanup`.
16. Run `npm run demo:fixture`, `npm run demo:smoke`, `npm run demo:browser`, and `npm run demo:browser:ci`.
17. Run `npm run ci:reports` and `npm run release:evidence`.
18. Inspect failure-only artifacts only if a gate fails.
19. Configure GitHub branch protection as documented in `docs/RELEASE.md` and GitHub Environment protection as documented in `docs/STAGING_DEPLOYMENT.md`.

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
