# Authorized YouTube Ingest Adapter + Local Staging

## Contract

ShortsEngine supports real YouTube ingest only when `SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1` is explicitly configured. The default remains mock/no-network.

## Architecture

- `server/youtube-ingest.cjs` owns URL parsing, rights confirmation and safe source validation.
- `server/adapters/youtube-ingest-adapter.cjs` selects mock versus local adapter.
- `server/adapters/local-youtube-ingest-adapter.cjs` invokes the configured downloader with `execFile`, explicit args, bounded timeout and bounded output.
- `server/youtube-ingest-service.cjs` orchestrates local staging, media validation, artifact commit and project/upload record creation.
- `server/app.cjs` keeps routes thin: parse, rate-limit, delegate, respond.

## Safety Rules

- Reject playlists, live streams, embeds, channels, search pages, credentialed URLs and unsupported hosts before downloader invocation.
- Require source-specific rights confirmation before validation or ingest.
- Downloader output goes only to `data/tmp/staging/youtube/<uploadId>/source.mp4`.
- Validate existence, non-empty size, max bytes, MP4/container signature and FFprobe metadata before committing an upload artifact.
- Create upload/project records only after artifact commit succeeds.
- Cleanup staging files on success and failure.
- Public API and health output must not include paths, storage keys, raw stdout/stderr or secrets.

## Current Limitations

- Real downloader/network tests are not part of default CI.
- `yt-dlp` or another compatible downloader must be installed outside the app and explicitly enabled.
- Legal/copyright responsibility is represented by explicit user rights confirmation; deeper provider/legal policy remains a future product milestone.
