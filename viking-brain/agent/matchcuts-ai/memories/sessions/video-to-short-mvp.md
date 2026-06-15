# Session Memory: video-to-short-mvp

Created: 2026-06-14T11:14:07.325Z
Source transcript: `viking-brain/sessions/inbox/video-to-short-mvp.jsonl`

## Summary

- user: Build the next MatchCuts AI milestone: real video-to-short MVP pipeline with upload validation, transcription, edit plan, FFmpeg render jobs, status polling, and download.
- assistant: Implemented Node backend modules server/app.cjs server/media.cjs server/edit-plan.cjs server/transcription.cjs server/render.cjs server/jobs.cjs, connected app.js frontend to upload/generate/job/download APIs, added MVP_PIPELINE.md and backend tests.
- Health is degraded until ffmpeg and ffprobe are installed.
- assistant: Final verification: lint/build/tests pass, FFmpeg render smoke passes with ffmpeg-full, health is ready, browser smoke confirms hidden export controls before render and no desktop/mobile horizontal overflow.

## Referenced Files

- `connected app.js`
- `added MVP_PIPELINE.md`

## Retrieval Hints

- session
- matchcuts-ai
- implementation-memory
- openviking-lite
