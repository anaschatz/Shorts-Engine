# Backend Pipeline L2 Details

Source files:

- `server/app.cjs`: HTTP API, static serving, upload endpoint, generate endpoint, job polling, cancel, download.
- `server/render-job.cjs`: render job orchestration, adapter injection, defensive pipeline validation, progress, cancellation, export persistence.
- `server/job-worker.cjs`: local durable worker for queued/recovered jobs.
- `server/media.cjs`: filename/type/signature validation and ffprobe metadata extraction.
- `server/analysis.cjs`: FFmpeg-backed media signals, deterministic fallback signals, highlight ranking, candidate edit-plan generation.
- `server/edit-plan.cjs`: deterministic edit-plan generation and validation.
- `server/transcription.cjs`: transcription provider abstraction with mock and OpenAI provider.
- `server/render.cjs`: FFmpeg audio extraction, ASS subtitle generation, 9:16 render.
- `server/jobs.cjs`: durable job lifecycle, idempotency, attempts, heartbeat, persistence and recovery.
- `server/storage/artifact-store.cjs`: local artifact storage contract and safe key/path resolution.
- `server/repositories/`: project, upload, export and project-state repository boundaries.
- `MVP_PIPELINE.md`: operating guide.

Storage:

- `data/uploads`
- `data/audio`
- `data/renders`
- `data/projects`
- `data/jobs`
- `data/tmp`

Generate job path:

1. Route validates project/upload/payload and delegates to `enqueueRenderJob`.
2. Orchestration updates `extract_audio`.
3. Orchestration updates `analyze_media`.
4. Orchestration updates `transcribe`.
5. Orchestration validates transcript output.
6. Orchestration updates `detect_highlights`.
7. Orchestration validates highlight moments.
8. Orchestration updates `create_edit_plan`.
9. Orchestration validates edit plan.
10. Orchestration updates `render_short`.
11. Export is created only after render output verification.
12. Job becomes `completed` and project becomes `ready`.

Startup recovery path:

1. `loadPersistedProjectState` reloads projects/uploads/render exports through repositories.
2. `JobStore.recover` loads `data/jobs`, rebuilds idempotency, skips corrupt records and handles stale processing jobs.
3. Completed jobs restore exports when their render file still exists.
4. The local worker starts queued/recovered jobs.

Persistence foundation:

- Routes and orchestration should avoid direct raw map/file access when a repository or artifact-store helper exists.
- Uploads are staged as artifacts before probing and become available only after validation succeeds.
- Exports are repository records backed by existing render artifacts, not speculative download handles.

Current environment note:

- FFmpeg-full is configured when available at `/opt/homebrew/opt/ffmpeg-full/bin`.
- `/health` reports redacted readiness for FFmpeg, storage, transcription and analysis features.
- Render smoke and API e2e synthetic upload/generate checks pass when FFmpeg-full is installed.
