# Live Render Staging Configuration - 2026-06-15

Implemented the no-network Render configuration readiness layer.

Decisions:

- Add `tools/release/check-render-staging.mjs` and `npm run render:check`.
- Wire staging workflow to run `env:check`, `staging:check`, `render:check`, `staging:deploy`, then `staging:smoke` when URL exists.
- Keep `provider=none` readiness-only by default.
- Require Render staging to have target `staging`, provider `render`, service id, deploy token and public staging URL.
- Document Render runtime setup: Node.js, build `npm ci`, start `npm start`, health path `/health`, Render-managed `PORT`.
- Document Render local filesystem as ephemeral unless a disk/object storage path is configured.

Validation focus:

- Readiness checks do not call Render APIs.
- Deploy trigger remains isolated in `staging-deploy`.
- Smoke remains health-only with no uploads or renders.
