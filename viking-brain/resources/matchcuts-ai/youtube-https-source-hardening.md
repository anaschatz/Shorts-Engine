# YouTube HTTPS Source Hardening

Milestone: Production risk-reduction pass for YouTube source validation.

Purpose:
- Reduce remote ingest risk by accepting only HTTPS YouTube source URLs.
- Keep server-side validation and shared UI validation aligned.
- Fail closed before adapter metadata probes, downloader execution, project creation or artifact creation.

Decision:
- `server/youtube-ingest.cjs` rejects non-HTTPS YouTube URLs with `YOUTUBE_URL_INVALID`.
- `hardening.js` applies the same HTTPS-only rule in the browser/shared validation core.
- Canonical URLs remain normalized to `https://www.youtube.com/watch?v=<videoId>`.

Safety impact:
- Prevents accidental protocol downgrade input for YouTube watch, Shorts and `youtu.be` links.
- Keeps playlist, live, credentialed URL, file URL and overlong URL rejection behavior unchanged.
- Preserves rights-gated and default-disabled ingest behavior.

Tests:
- Server URL normalization rejects `http://www.youtube.com/watch?...` and `http://youtu.be/...`.
- Browser/shared core rejects the same URLs.
- API validation route returns safe structured `YOUTUBE_URL_INVALID` and creates no upload/project.
