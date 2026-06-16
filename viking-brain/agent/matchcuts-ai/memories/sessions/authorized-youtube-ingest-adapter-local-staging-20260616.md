# Authorized YouTube Ingest Adapter + Local Staging - 2026-06-16

## Decisions

- Keep mock/no-network YouTube ingest as the default.
- Enable real ingest only with `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1`.
- Use a dedicated local adapter with `execFile`, explicit downloader args, bounded timeout and bounded output.
- Stage downloads under `data/tmp/staging/youtube/<uploadId>/source.mp4`.
- Validate downloaded media with upload signature checks and FFprobe before committing artifacts.
- Create upload/project records only after artifact commit succeeds.
- Keep API responses and health free of paths, storage keys, raw downloader output and secrets.

## Tests Added

- Downloader args are explicit and shell-free.
- Missing downloader and timeout map to safe errors.
- Invalid URL/rights failures happen before downloader invocation.
- Success creates upload/project only after validation.
- Corrupt media and FFprobe failure clean staging and create no records.
- Default API ingest route returns `YOUTUBE_INGEST_NOT_ENABLED`.

## Limitations

- Default tests remain no-network and do not execute real `yt-dlp`.
- Downloader installation and legal policy are deployment/product responsibilities before enabling real ingest.
