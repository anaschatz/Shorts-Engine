# ShortsEngine Live Render Staging Configuration

Milestone: Live Render Staging Configuration + Deployment Readiness.

Decisions:

- Keep `SHORTSENGINE_STAGING_DEPLOY_PROVIDER=none` as the default no-network path.
- Add `npm run render:check` for no-network Render configuration readiness.
- Run `render:check` in the GitHub staging workflow before `staging:deploy`.
- Treat Render staging URL as public-only: localhost, private and link-local URLs are invalid for real Render staging.
- Keep deployed smoke health-only: `GET /health`, no uploads and no render jobs.

Render service contract:

- Runtime: Node.js web service.
- Build command: `npm ci`.
- Start command: `npm start`.
- Health check path: `/health`.
- Render supplies `PORT`.
- `ffmpeg` and `ffprobe` must be available for real rendering; otherwise health may be degraded and render jobs fail safely.
- Local filesystem storage on Render is ephemeral unless a disk is attached.

GitHub Environment `staging`:

- Variables: target `staging`, provider `render`, service id `srv-...`, staging URL, mock transcription, sqlite persistence, local/mock-cloud storage.
- Secret: `SHORTSENGINE_STAGING_DEPLOY_TOKEN`.
- Optional secrets only for intentional real AI or object storage staging.

Validation:

- `npm run render:check` never calls Render APIs.
- `npm run staging:deploy` is the only deploy trigger.
- `npm run staging:smoke` validates public `/health` output after deploy.
