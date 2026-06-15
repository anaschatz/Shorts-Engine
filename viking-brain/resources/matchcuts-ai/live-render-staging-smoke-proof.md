# ShortsEngine Live Render Staging Smoke Proof

Milestone: Live Render Staging Deploy + Smoke Proof.

Decisions:

- Keep real Render deploys gated behind GitHub Environment `staging`.
- Add `npm run render:manual` to print a safe live setup checklist with placeholders only.
- Add `npm run render:proof` to run env/staging/render/deploy checks in provider `none` mode without network.
- Keep `npm run render:check` no-network and keep `npm run staging:deploy` as the only Render API caller.
- Keep deployed smoke health-only: `GET /health`, no uploads and no render jobs.

Manual live proof:

- Create Render Node.js Web Service from branch `main`.
- Build command: `npm ci`.
- Start command: `npm start`.
- Health check path: `/health`.
- Keep Render Auto deploy off or controlled until the staging gate is stable.
- Configure GitHub Environment variables and secret, then manually dispatch `.github/workflows/staging.yml`.
- Inspect safe workflow status and sanitized summaries only.

Rollback:

- Set provider back to `none`.
- Remove staging URL, service id and deploy token from the GitHub Environment.
- Rerun staging workflow in readiness-only mode.

Limitations:

- Render local filesystem is ephemeral without persistent storage.
- Full deployed video upload/render smoke is still intentionally out of scope.
- Durable object storage and DB-backed persistence are the next production milestone.
