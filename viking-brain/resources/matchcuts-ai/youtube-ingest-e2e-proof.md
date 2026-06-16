# YouTube Ingest E2E Proof + Runtime Validation

## Contract

ShortsEngine has a two-level proof model for authorized YouTube ingest:

- `npm run youtube:doctor` is safe to run by default. With ingest disabled it returns a skipped summary and performs no downloader/network work.
- `npm run youtube:smoke` is manual and opt-in. It requires `SHORTSENGINE_YOUTUBE_SMOKE=1`, `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1`, a safe YouTube URL, downloader readiness, rights confirmation and either an allowlisted video id or `SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED=1`.

## Runtime Checks

The doctor validates:

- ingest flag state
- FFmpeg/FFprobe availability
- staging/artifact storage readiness
- downloader availability only when ingest is enabled
- optional live `/health` `youtubeIngest` shape when `SHORTSENGINE_YOUTUBE_DOCTOR_URL` is set
- leak-free summary output

The smoke validates:

- unsafe YouTube URLs are rejected before any fetch
- `/health` has FFmpeg/FFprobe and ingest readiness
- `/api/youtube/validate` returns ingest-ready source metadata
- `/api/youtube/ingest` creates public project/upload/artifact metadata without paths or storage keys
- `/api/projects/:id/generate` starts a render job
- `/api/jobs/:id` reaches completed state with an export id
- `/api/exports/:id/download` returns bounded `video/mp4` with a valid MP4 `ftyp` signature

## Report Safety

`demo/results/youtube-smoke-latest.json` must never include:

- local absolute paths
- storage keys
- signed tokens
- raw downloader stdout/stderr
- secrets
- raw provider errors

Default CI may run `youtube:doctor`; real `youtube:smoke` stays out of the default gate because it performs downloader/network work and requires legal/rights context.
