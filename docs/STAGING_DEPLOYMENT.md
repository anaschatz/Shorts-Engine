# ShortsEngine Staging Deployment Contract

This milestone prepares ShortsEngine for a real Render staging deployment while keeping the default readiness-only and safe: no production deploy, no hardcoded credentials, no cloud integration by default and no video uploads during deployed smoke.

Run:

```bash
npm run render:manual
npm run render:proof
npm run staging:check
npm run render:check
```

For a deployed app, run:

```bash
SHORTSENGINE_STAGING_URL=https://your-staging-host.example npm run staging:smoke
```

## GitHub Environment `staging`

Create a GitHub Environment named `staging` and protect it before adding real deploy credentials.

Recommended rules:

- Require manual approval for first staging deploys.
- Limit who can approve deployment.
- Store provider credentials as environment secrets, not repository-wide secrets.
- Store non-sensitive deployment settings as environment variables.
- Keep real cloud integration disabled unless the cloud integration script is explicitly being tested.

## Staging Variables

| Variable | Required | Default | Allowed values | Secret | Purpose |
| --- | --- | --- | --- | --- | --- |
| `SHORTSENGINE_DEPLOY_TARGET` | No | `local` | `local`, `staging` | No | Enables strict staging-mode validation when set to `staging`. |
| `SHORTSENGINE_STAGING_DEPLOY_PROVIDER` | Required when target is `staging` | `none` | `none`, `render` | No | Names the deploy provider. `none` means readiness-only, not deployed. |
| `SHORTSENGINE_STAGING_SERVICE_ID` | Required for Render staging deploy | empty | Render service id beginning with `srv-` | No | Identifies the Render service to deploy. Store it as a protected GitHub Environment variable. |
| `SHORTSENGINE_STAGING_URL` | Required when target is `staging` or when running smoke | empty | `http` or `https` URL without credentials, private IPs or local-network hosts | No | Base URL for deployed `/health` smoke. |
| `SHORTSENGINE_STAGING_ALLOW_LOCAL_URL` | No | `0` | boolean | No | Allows localhost/private-network smoke only for explicit local testing. Keep disabled for remote staging. |
| `SHORTSENGINE_STAGING_SMOKE_TIMEOUT_MS` | No | `30000` | integer `1000..120000` | No | Timeout for each deployed health request. |
| `SHORTSENGINE_STAGING_SMOKE_RETRIES` | No | `2` | integer `0..5` | No | Bounded retry count for deployed health smoke. |
| `SHORTSENGINE_STAGING_DEPLOY_TOKEN` | Required when target is `staging` and provider is `render` | empty | GitHub Environment secret | Yes | Render API token used only by the staging deploy workflow. |

## Required GitHub Secrets

For readiness-only staging, no deploy secret is required.

For Render staging, configure:

- `SHORTSENGINE_STAGING_DEPLOY_TOKEN`

And configure these as GitHub Environment variables:

- `SHORTSENGINE_DEPLOY_TARGET=staging`
- `SHORTSENGINE_STAGING_DEPLOY_PROVIDER=render`
- `SHORTSENGINE_STAGING_SERVICE_ID=srv-...`
- `SHORTSENGINE_STAGING_URL=https://your-render-staging-host.example`

Only configure these if the staging environment intentionally uses the related adapters/providers:

- `OPENAI_API_KEY`
- `MATCHCUTS_STORAGE_ACCESS_KEY_ID`
- `MATCHCUTS_STORAGE_SECRET_ACCESS_KEY`
- `MATCHCUTS_STORAGE_SESSION_TOKEN`

Do not commit `.env` files or copy secret values into docs, logs, reports or issue comments.

## Expected Runtime Modes

Safe readiness-only defaults:

- `MATCHCUTS_TRANSCRIPTION_PROVIDER=mock`
- `MATCHCUTS_STORAGE_ADAPTER=local`
- `MATCHCUTS_PERSISTENCE_ADAPTER=sqlite` in GitHub staging workflow, or `local` for developer machines
- `MATCHCUTS_RUN_REAL_CLOUD_TESTS=0`
- `SHORTSENGINE_STAGING_DEPLOY_PROVIDER=none`

Object storage and real AI provider modes remain opt-in and fail closed when required credentials are missing.

## Render Provider Contract

Render is the first supported provider-specific staging deploy path.

Required GitHub Environment variables:

- `SHORTSENGINE_DEPLOY_TARGET=staging`
- `SHORTSENGINE_STAGING_DEPLOY_PROVIDER=render`
- `SHORTSENGINE_STAGING_SERVICE_ID=srv-...`
- `SHORTSENGINE_STAGING_URL=https://...`

Required GitHub Environment secret:

- `SHORTSENGINE_STAGING_DEPLOY_TOKEN`

The deploy helper calls Render's service deploy API, requests a deploy with cache kept by default, and prints only a sanitized summary. It does not print the API token, the raw provider response, local paths or storage keys.
Render provider responses are read with a bounded body limit, parsed as JSON only after the size check, and reduced to safe status metadata. Oversized or invalid provider responses fail closed without copying the raw response body into logs or reports.

`npm run render:check` validates this contract without calling Render:

- provider `none` remains readiness-only and no-network
- provider `render` requires target `staging`, service id, deploy token and public staging URL
- local/private/link-local staging URLs are rejected for real Render staging
- mock transcription remains the safe default unless a real provider is explicitly configured
- output stays sanitized and never includes token values or raw provider data

## Render Service Setup

Create a Render Web Service connected to this GitHub repository.

Recommended service settings:

- Runtime: Node.js
- Branch: `main`
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/health`
- Auto deploy: keep off or controlled until the staging gate is stable.
- Node version: use the repository `engines.node` value unless you intentionally pin a newer version in Render settings.
- Required system tools: `ffmpeg` and `ffprobe` must be available to render real clips. If they are missing, `/health` should report degraded readiness and render jobs should fail safely.

Recommended Render environment variables for initial staging:

- `MATCHCUTS_TRANSCRIPTION_PROVIDER=mock`
- `MATCHCUTS_PERSISTENCE_ADAPTER=sqlite`
- `MATCHCUTS_STORAGE_ADAPTER=local` or `mock-cloud`
- Leave `OPENAI_API_KEY` empty until real-provider staging is intentional.
- Let Render provide `PORT`; do not hardcode it.

Local filesystem storage on Render should be treated as ephemeral unless a Render disk is explicitly attached. Initial staging can use local or mock-cloud storage to prove deployment and health, but durable uploads/renders need object storage and database-backed persistence in a later milestone.

After the service exists:

1. Copy the Render service id, which starts with `srv-`.
2. Create a Render API token with the least practical scope for triggering deploys.
3. Add the service id to GitHub Environment `staging` as `SHORTSENGINE_STAGING_SERVICE_ID`.
4. Add the API token to GitHub Environment `staging` as secret `SHORTSENGINE_STAGING_DEPLOY_TOKEN`.
5. Add the public Render service URL as `SHORTSENGINE_STAGING_URL`.
6. Run `npm run render:check` locally with placeholder values first, then run the GitHub staging workflow manually.

Local proof before touching live secrets:

```bash
npm run render:manual
npm run render:proof
```

`npm run render:manual` prints a safe checklist with placeholders only. `npm run render:proof` runs the local readiness chain in provider `none` mode and does not call Render.

## Workflow Behavior

The staging workflow lives at `.github/workflows/staging.yml`.

It runs in two cases:

- manually with `workflow_dispatch`
- automatically after `ShortsEngine CI` completes successfully

The workflow uses the GitHub Environment named `staging`, runs `npm run env:check`, `npm run staging:check` and `npm run render:check`, then runs `npm run staging:deploy`:

- provider `none`: pass readiness-only; no fake deploy is claimed
- provider `render`: trigger a Render deploy only when target, service id, staging URL and protected deploy token are configured
- unsupported providers: fail closed with a safe structured error

If `SHORTSENGINE_STAGING_URL` is configured, the workflow also runs `npm run staging:smoke`.

## Live Smoke Proof

Trigger `.github/workflows/staging.yml` manually with `workflow_dispatch` after the GitHub Environment is configured.

Inspect only safe evidence:

- workflow status
- `env:check` passed
- `staging:check` passed
- `render:check` passed
- `staging:deploy` returned a sanitized deploy-trigger summary
- `staging:smoke` passed against the public `/health` URL

Do not copy provider raw errors, tokens, service ids, local paths, storage keys or screenshots containing secret values into issues or docs.

## Deployed Smoke

`npm run staging:smoke` checks only:

- `GET /health`
- HTTP success response
- bounded health response size
- structured response shape
- `data.status` is `ready` or `degraded`
- required health sections exist
- no secret, path or storage-key leakage
- no private, link-local or localhost target unless explicit local mode is enabled

It does not upload videos, create jobs, render clips, delete artifacts or call real cloud integration.

## Status Meaning

- `ready`: FFmpeg, FFprobe, storage, repositories, adapters, transcription provider and analysis layer are ready.
- `degraded`: the app responded safely but at least one readiness dependency is missing or unavailable.
- failed smoke: the URL is invalid, unreachable, unsafe, leaked sensitive data or returned an invalid health payload.

## Rollback / Manual Recovery

- Disable or remove `SHORTSENGINE_STAGING_URL` to stop deployed smoke while keeping readiness checks.
- Set `SHORTSENGINE_STAGING_DEPLOY_PROVIDER=none` to return to readiness-only mode.
- Remove `SHORTSENGINE_STAGING_SERVICE_ID` and `SHORTSENGINE_STAGING_DEPLOY_TOKEN` when disabling Render deploys.
- Keep generated reports, uploads, renders, databases and `.env` files out of commits.

If GitHub Actions reports a failed staging run:

- `STAGING_URL_REQUIRED`: add `SHORTSENGINE_STAGING_URL` or return to provider `none`.
- `STAGING_SERVICE_ID_MISSING`: add `SHORTSENGINE_STAGING_SERVICE_ID=srv-...`.
- `STAGING_CREDENTIAL_MISSING`: add the GitHub Environment secret `SHORTSENGINE_STAGING_DEPLOY_TOKEN`.
- `RENDER_STAGING_URL_PUBLIC_REQUIRED`: use the public Render URL, not localhost or a private IP.
- `STAGING_RENDER_DEPLOY_HTTP_FAILED`: check the Render service id, token permissions and Render service status.
- `STAGING_RENDER_DEPLOY_REQUEST_FAILED`: check Render availability and GitHub runner network access.
- `STAGING_RENDER_DEPLOY_RESPONSE_TOO_LARGE`: the provider response exceeded the bounded deploy summary limit.
- `STAGING_RENDER_DEPLOY_JSON_INVALID`: the provider returned invalid JSON for a successful deploy request.
- smoke failure after deploy: open `/health` on the Render URL and verify FFmpeg, storage, repositories, adapters, transcription and analysis readiness.

## Local Commands

```bash
npm run env:check
npm run staging:check
npm run render:check
npm run render:manual
npm run render:proof
npm run release:check
npm run release:evidence
```

Use local smoke only when explicitly needed:

```bash
SHORTSENGINE_STAGING_ALLOW_LOCAL_URL=1 SHORTSENGINE_STAGING_URL=http://127.0.0.1:4175 npm run staging:smoke
```

## Render References

- Render Web Services: https://render.com/docs/web-services
- Render Node.js version/runtime guidance: https://render.com/docs/node-version
- Render health checks: https://render.com/docs/health-checks
- Render persistent disks: https://render.com/docs/disks
- Render API deploys: https://api-docs.render.com/reference/create-deploy
