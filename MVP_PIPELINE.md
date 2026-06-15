# MatchCuts AI Video-To-Short MVP Pipeline

This milestone adds a real backend/render pipeline around the existing frontend.

It is still an MVP, not production-ready. It is designed to prove the vertical slice:

```text
uploaded video -> backend validation -> media signal analysis -> transcription provider -> highlight ranking -> candidate edit plans -> FFmpeg 9:16 MP4 render -> download
```

## Run

```bash
npm run dev
```

Open:

```text
http://localhost:4175
```

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Reports service, FFmpeg/FFprobe, storage, transcription and analysis readiness without local path leakage. |
| `POST` | `/api/uploads` | Accepts multipart `video` upload and validates media with ffprobe. |
| `POST` | `/api/projects/:projectId/generate` | Starts one render job for the uploaded project. |
| `GET` | `/api/jobs/:jobId` | Returns job status, progress, error, highlights, candidate edit plans, selected edit plan, and export id. |
| `POST` | `/api/jobs/:jobId/cancel` | Cancels a queued/processing job. |
| `GET` | `/api/exports/:exportId/download` | Downloads final rendered MP4. |

Every JSON endpoint returns:

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

or:

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "SAFE_ERROR_CODE",
    "message": "Safe user-facing message"
  }
}
```

## Local Storage

Generated files are kept out of version control by `.gitignore`.

```text
data/uploads/   uploaded source videos
data/audio/     extracted WAV audio
data/renders/   rendered MP4 outputs
data/projects/  project/job metadata snapshots
data/jobs/      durable job records and idempotency recovery
data/tmp/       temporary ASS subtitles and test artifacts
```

## Durable Jobs

Generate/render jobs are persisted under `data/jobs/` as atomic JSON records. The persisted record keeps the job id, project/upload ids, action, idempotency key, status, progress, step, safe error, attempts, heartbeat, output/export ids and sanitized render payload. Runtime-only cancellation controllers are never written to disk.

On startup the server reloads durable jobs:

- `completed`, `failed`, and `cancelled` jobs remain terminal.
- `queued` jobs are picked up by the local worker.
- stale `processing` jobs are requeued while attempts remain under the safe retry limit.
- stale jobs beyond the attempt limit are marked failed with `JOB_STALE`.
- corrupt or unsafe job files are skipped without crashing the server.

## FFmpeg Requirement

The pipeline needs both:

```bash
ffmpeg
ffprobe
```

The app starts without them, but `/health` reports `status: "degraded"` and upload/render flows fail safely with `FFPROBE_MISSING` or `FFMPEG_MISSING`.

## Transcription Providers

The default provider is deterministic mock transcription so the pipeline can run without API keys.

Optional OpenAI provider:

```bash
export MATCHCUTS_TRANSCRIPTION_PROVIDER=openai
export OPENAI_API_KEY=...
export OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
```

If not configured, the mock provider produces timed captions.

## Real AI Analysis Layer

The generate job now includes deterministic analysis before render:

1. `extract_audio`: FFmpeg WAV extraction when source audio exists.
2. `analyze_media`: duration/resolution/aspect ratio, audio activity peaks, scene-change candidates, high-motion candidates and sample timestamps.
3. `transcribe`: OpenAI provider when configured, otherwise mock fallback with segments/captions.
4. `detect_highlights`: ranked short-form moments with reason codes such as `goal_like_phrase`, `audio_peak`, `scene_change_cluster`, `replay_marker`, `crowd_reaction`, and `tactical_build_up`.
5. `create_edit_plan`: 2-3 validated candidate plans, with the top candidate selected for MVP render.
6. `render_short`: FFmpeg 9:16 MP4 render with burned-in captions.

The analysis layer fails closed when candidate plans cannot validate, and uses deterministic fallback moments only when transcript/signals are limited but still safe to render.

## Evaluation Quality Loop

Run deterministic local evaluation:

```bash
npm run eval
```

The evaluation dataset lives in:

```text
eval/fixtures/   synthetic football highlight fixtures
eval/results/    generated JSON reports
```

The runner measures top-1 overlap, top-3 recall, reason-code precision/recall, retention sanity, candidate edit-plan validity, caption timing validity and fallback usage rate. It exits non-zero when aggregate or per-fixture thresholds fail.

## Current MVP Limitations

- Jobs are durable on local disk, but this is still a local single-process queue rather than Redis/SQS/database-backed multi-worker infrastructure.
- Upload parsing is dependency-free and currently buffers the request in memory.
- Smart crop is deterministic center crop, not ball/player tracking.
- Trendy editing is still template-based: 9:16 crop, slight punchy color treatment, hook caption, burned-in subtitles, reason-driven effects metadata.
- Auth, multi-user ownership, object storage, Redis queue, malware scanning, and billing are not implemented yet.
