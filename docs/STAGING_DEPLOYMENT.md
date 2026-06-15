# ShortsEngine Staging Deployment Contract

This milestone prepares ShortsEngine for a real staging deployment without pretending that a provider is already wired. The default is readiness-only and safe: no production deploy, no hardcoded credentials, no cloud integration by default and no video uploads during deployed smoke.

Run:

```bash
npm run staging:check
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
| `SHORTSENGINE_STAGING_DEPLOY_PROVIDER` | Required when target is `staging` | `none` | `none`, `render`, `fly`, `railway`, `vercel`, `cloud-run`, `custom` | No | Names the deploy provider. `none` means readiness-only, not deployed. |
| `SHORTSENGINE_STAGING_URL` | Required when target is `staging` or when running smoke | empty | `http` or `https` URL without credentials | No | Base URL for deployed `/health` smoke. |
| `SHORTSENGINE_STAGING_ALLOW_LOCAL_URL` | No | `0` | boolean | No | Allows localhost smoke only for explicit local testing. Keep disabled for remote staging. |
| `SHORTSENGINE_STAGING_SMOKE_TIMEOUT_MS` | No | `30000` | integer `1000..120000` | No | Timeout for each deployed health request. |
| `SHORTSENGINE_STAGING_SMOKE_RETRIES` | No | `2` | integer `0..5` | No | Bounded retry count for deployed health smoke. |
| `SHORTSENGINE_STAGING_DEPLOY_TOKEN` | Required when target is `staging` and provider is not `none` | empty | GitHub Environment secret | Yes | Provider-neutral deploy credential placeholder. Provider-specific milestones can replace or expand this. |

## Required GitHub Secrets

For readiness-only staging, no deploy secret is required.

For real provider staging, configure:

- `SHORTSENGINE_STAGING_DEPLOY_TOKEN`

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

## Workflow Behavior

The staging workflow lives at `.github/workflows/staging.yml`.

It runs in two cases:

- manually with `workflow_dispatch`
- automatically after `ShortsEngine CI` completes successfully

The workflow uses the GitHub Environment named `staging`, runs `npm run env:check` and `npm run staging:check`, then reaches a provider-neutral deploy guard:

- provider `none`: pass readiness-only with a notice; no fake deploy is claimed
- any real provider: fail closed until an explicit provider deploy step is implemented

If `SHORTSENGINE_STAGING_URL` is configured, the workflow also runs `npm run staging:smoke`.

## Deployed Smoke

`npm run staging:smoke` checks only:

- `GET /health`
- HTTP success response
- structured response shape
- `data.status` is `ready` or `degraded`
- required health sections exist
- no secret, path or storage-key leakage

It does not upload videos, create jobs, render clips, delete artifacts or call real cloud integration.

## Status Meaning

- `ready`: FFmpeg, FFprobe, storage, repositories, adapters, transcription provider and analysis layer are ready.
- `degraded`: the app responded safely but at least one readiness dependency is missing or unavailable.
- failed smoke: the URL is invalid, unreachable, unsafe, leaked sensitive data or returned an invalid health payload.

## Rollback / Manual Recovery

- Disable or remove `SHORTSENGINE_STAGING_URL` to stop deployed smoke while keeping readiness checks.
- Set `SHORTSENGINE_STAGING_DEPLOY_PROVIDER=none` to return to readiness-only mode.
- Revert provider-specific workflow steps if a deploy integration fails.
- Keep generated reports, uploads, renders, databases and `.env` files out of commits.

## Local Commands

```bash
npm run env:check
npm run staging:check
npm run release:check
npm run release:evidence
```

Use local smoke only when explicitly needed:

```bash
SHORTSENGINE_STAGING_ALLOW_LOCAL_URL=1 SHORTSENGINE_STAGING_URL=http://127.0.0.1:4175 npm run staging:smoke
```
