# Session Memory: YouTube HTTPS Source Hardening

Date: 2026-06-17

Risk addressed:
- YouTube source validation accepted both `http:` and `https:` source URLs. The canonical URL was HTTPS, but production ingest should reject non-HTTPS input before adapter/downloader work.

Changes:
- Enforced HTTPS-only YouTube source URLs in `server/youtube-ingest.cjs`.
- Mirrored the same rule in `hardening.js` so UI/shared validation matches backend validation.
- Added regression coverage in:
  - `tests/youtube-ingest.test.cjs`
  - `tests/validation.test.js`
  - `tests/backend.test.cjs`

Expected behavior:
- `https://www.youtube.com/watch?v=<id>`, `https://www.youtube.com/shorts/<id>` and `https://youtu.be/<id>` remain valid.
- `http://www.youtube.com/watch?v=<id>` and `http://youtu.be/<id>` fail closed with `YOUTUBE_URL_INVALID`.
- Invalid URL responses stay structured and do not create uploads, projects or artifacts.

Validation:
- Run the normal release gate after this pass:
  - `npm run lint`
  - `npm run build`
  - `npm test`
  - `npm run eval`
  - `npm run eval:reference`
  - `npm run brain:health`
  - `npm run ci:reports`
  - `npm run release:check`
  - demo/browser smoke checks when available.
