# MatchCuts AI Production Hardening Notes

This repository is now a local MVP with a Node backend, FFmpeg render pipeline and hardened static frontend. Client validation remains an early guardrail only; production safety is enforced again server-side before uploads, jobs and downloads proceed.

## Implemented In This Prototype

- File validation for name, size, extension, MIME type, container signature and video duration.
- Safe user-facing errors with structured `{ ok, data, error }` response shape.
- Consent gating for copyrighted sports footage workflows.
- Local rate limits for upload, generate and export actions.
- Idempotency keys for generate/export actions.
- Job statuses: `queued`, `processing`, `failed`, `completed`, `cancelled`.
- Retry, timeout and cancellation helpers for long-running jobs.
- AI output validation before rendering generated moments.
- No raw `innerHTML` assignment for generated UI content.
- Disabled/loading/error/empty UI states.
- Static tests for validators, rate limits, idempotency and project safety contracts.
- Backend upload, media probing, transcription adapter, edit-plan and FFmpeg render modules.
- Storage boundary checks for uploads, audio, renders, projects and temp artifacts.
- Atomic JSON persistence for project/render records and best-effort state rehydration on startup.
- Redacted health output with FFmpeg, storage and transcription provider readiness.
- Route id and idempotency-key validation before job orchestration.
- Safe job failure messages that avoid leaking provider/internal error details to clients.
- Frontend stale render-state reset when a new upload starts.

## API Contract

Every endpoint should return:

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
    "code": "UPLOAD_INVALID",
    "message": "Safe user-facing message"
  }
}
```

Recommended endpoints:

| Method | Path | Safety Requirements |
| --- | --- | --- |
| `GET` | `/health` | No auth secrets or local paths, returns service and dependency status. |
| `POST` | `/api/uploads` | Payload schema validation, rate limit, filename/MIME/signature/duration checks. |
| `POST` | `/projects` | Auth, title/settings schema validation. |
| `GET` | `/projects?cursor=` | Auth, ownership filter, pagination. |
| `POST` | `/api/projects/:id/generate` | Route id validation, idempotency key, consent check, queue job. |
| `POST` | `/projects/:id/exports` | Auth, ownership, idempotency key, generated clip check, queue job. |
| `POST` | `/api/jobs/:id/cancel` | Route id validation and safe cancellation. |
| `GET` | `/api/jobs/:id` | Route id validation and structured status. |
| `GET` | `/api/exports/:id/download` | Export id validation, render storage boundary check, no-store download. |

## Database Schema Sketch

```sql
create table users (
  id uuid primary key,
  email text unique not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table projects (
  id uuid primary key,
  user_id uuid not null references users(id),
  title text not null,
  language text not null,
  settings jsonb not null default '{}',
  status text not null check (status in ('draft', 'processing', 'ready', 'failed', 'archived')),
  rights_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table media_assets (
  id uuid primary key,
  project_id uuid not null references projects(id),
  user_id uuid not null references users(id),
  storage_key text not null unique,
  original_filename text not null,
  mime_type text not null,
  byte_size bigint not null,
  duration_seconds numeric,
  checksum_sha256 text,
  safety_status text not null check (safety_status in ('pending', 'passed', 'failed')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table generated_clips (
  id uuid primary key,
  project_id uuid not null references projects(id),
  media_asset_id uuid references media_assets(id),
  edit_plan jsonb not null,
  status text not null check (status in ('draft', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table captions (
  id uuid primary key,
  generated_clip_id uuid not null references generated_clips(id),
  language text not null,
  cues jsonb not null,
  created_at timestamptz not null default now()
);

create table render_jobs (
  id uuid primary key,
  project_id uuid not null references projects(id),
  generated_clip_id uuid references generated_clips(id),
  idempotency_key text not null,
  status text not null check (status in ('queued', 'processing', 'failed', 'completed', 'cancelled')),
  attempts integer not null default 0,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, idempotency_key)
);

create table export_jobs (
  id uuid primary key,
  project_id uuid not null references projects(id),
  generated_clip_id uuid not null references generated_clips(id),
  target text not null,
  idempotency_key text not null,
  status text not null check (status in ('queued', 'processing', 'failed', 'completed', 'cancelled')),
  output_storage_key text,
  attempts integer not null default 0,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, idempotency_key)
);

create table audit_events (
  id uuid primary key,
  user_id uuid references users(id),
  project_id uuid references projects(id),
  event_type text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index projects_user_status_idx on projects(user_id, status) where deleted_at is null;
create index media_assets_project_idx on media_assets(project_id) where deleted_at is null;
create index render_jobs_status_idx on render_jobs(status, created_at);
create index export_jobs_status_idx on export_jobs(status, created_at);
create index audit_events_project_created_idx on audit_events(project_id, created_at desc);
```

## AI Video Pipeline Contract

Each step should read immutable input artifacts and write a versioned output artifact:

1. `ingest`: validated media metadata, checksum, storage key, safety result.
2. `analyze`: scene cuts, ball/player confidence, camera motion, audio energy.
3. `transcribe`: language, word timings, confidence, profanity/safety flags.
4. `detect_highlights`: ranked moments with timestamps and reason codes.
5. `generate_edit_plan`: clips, captions, overlays, pace, aspect ratio.
6. `generate_captions`: cue list with word timing and style tokens.
7. `render_preview`: low-resolution preview with trace id.
8. `export_final`: target-specific output, checksum and storage key.

Every step needs:

- Input schema validation.
- Output schema validation before persistence.
- Timeout and retry policy.
- Idempotency key.
- Status updates with audit event.
- Deterministic fallback template when AI output is missing or invalid.

## Production Launch Checklist

- Enforce validation server-side, not only in the browser.
- Add authenticated object storage with short-lived upload URLs.
- Add malware/media safety scanning before analysis.
- Add queue workers with dead-letter queues.
- Add structured logs with request id, job id and user id.
- Add metrics for queue latency, render failures, upload failures and API rate limits.
- Add real integration tests against storage, database and queue.
- Add legal review for sports footage rights and platform export policies.
