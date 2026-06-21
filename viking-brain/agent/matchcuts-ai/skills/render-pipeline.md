# Skill: MVP Render Pipeline

Use when working on the real video-to-short vertical slice.

Core path:

1. `POST /api/uploads` accepts multipart `video`.
2. Validate filename, extension, MIME, signature, size, and ffprobe metadata.
3. `POST /api/projects/:projectId/generate` creates an idempotent render job.
4. Extract WAV audio with FFmpeg when audio exists.
5. Transcribe with configured provider or deterministic mock fallback.
6. Plan a football story, then generate and validate a 9:16 or 1:1 MP4 edit plan.
7. Write role-specific ASS kinetic captions from the validated caption contract.
8. Apply bounded beat/cue overlays without cropping away the foreground action.
9. Render via FFmpeg using safe contain framing, color punch, subtitles, H.264 MP4.
10. Poll `GET /api/jobs/:jobId`.
11. Download via `GET /api/exports/:exportId/download`.

Architecture rule:

- Keep `server/app.cjs` thin: request parsing, route validation, rate limiting, idempotency, and delegation only.
- Keep the heavy generate/render sequence in `server/render-job.cjs`.
- Keep durable job persistence/recovery in `server/jobs.cjs` and queue execution in `server/job-worker.cjs`.
- Use repository boundaries for projects, uploads and exports; use `LocalArtifactStore` for filesystem artifact resolution.
- Use injected adapters in orchestration tests for transcription, media signals, highlight detection, edit-plan creation, render, storage writes, and scheduling.
- Create exports only after render output exists and the job can be completed.
- On startup, recover `data/jobs`, requeue stale processing jobs only within max attempts, and never restart terminal jobs.
- Keep terminal job records immutable after completed, failed, or cancelled states except for idempotent same-status checks.

Safety notes:

- Do not expose stack traces in API responses.
- Keep generated media under `data/` and out of version control.
- Treat client-side validation as convenience only.
- Keep render smoke conditional when FFmpeg is missing.
- Reject invalid transcript/highlight/edit-plan output before FFmpeg render.
- Persist only safe job state; never persist `_controller`, raw provider errors, secrets, or public absolute paths.
- Treat missing project/upload context as a safe job failure, not an uncaught orchestration crash.
- Treat object storage/database migration as an adapter swap after repository and artifact contracts are stable.
- 1:1 square sports edits are supported through validated export dimensions; unsupported animation cues should be ignored with metadata instead of failing render.
- Supported renderer styles are `clean_sports`, `social_sports_v1`, `punchy_highlight` and `reference_football_multi_goal_v1`; unknown styles must fail closed before enqueue/render.
- Kinetic captions must keep role, emphasis, layout, timing and style tokens valid before ASS generation.
- Punchy effects should use bounded overlays/background push and must not imply ball/player tracking or crop away the full foreground frame.
- Candidate edit plans expose `reviewMetadata` for reference-style quality review: render style, caption roles, cue types, aspect ratio, highlight type, forbidden claim checks, framing and evidence summaries.
- Use `npm run eval:reference` before release when changing ASS captions, cue timing, style presets, framing or football story output.
