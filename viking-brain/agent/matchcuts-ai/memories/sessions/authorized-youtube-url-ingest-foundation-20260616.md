# Session Memory: Authorized YouTube URL Ingest Foundation

Date: 2026-06-16

Decisions:

- Added YouTube support as a validation-only foundation, not a downloader.
- Kept mock/no-network adapter as the default.
- Required explicit YouTube rights confirmation before validation succeeds.
- Kept generate/render/export disabled for YouTube sources until an MP4 artifact exists.
- Added health metadata for YouTube ingest without provider calls, paths, storage keys or secrets.

Implementation notes:

- Backend validation lives in `server/youtube-ingest.cjs`.
- Default adapter lives in `server/adapters/mock-youtube-ingest-adapter.cjs`.
- Public route is `POST /api/youtube/validate`.
- UI source selector is in the ingest panel.
- Client validation mirrors server URL rules for faster feedback, but server validation remains authoritative.

Known limitation:

- YouTube links do not produce renderable uploads yet. The next milestone should add a real authorized ingest adapter and FFmpeg staging validation before enabling generation.
