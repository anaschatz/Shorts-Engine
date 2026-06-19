#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { join, relative, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const CWD = process.cwd();
const BRAIN_ROOT = join(CWD, "viking-brain");
const URI_ROOT = "viking://matchcuts";
const MAX_READ_BYTES = 4 * 1024;
const DEFAULT_MAX_SEARCH_FILES = 24;
const DEFAULT_MAX_SEARCH_NODES = 96;
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "στο",
  "στη",
  "στην",
  "και",
  "για",
  "που",
  "των",
  "του",
  "της",
  "ένα",
  "μια",
  "με",
]);

const seedFiles = [
  {
    path: ".abstract",
    content:
      "OpenViking-style brain for ShortsEngine, formerly MatchCuts AI, organizing resources, memories, and skills as a traceable local filesystem.",
  },
  {
    path: ".overview",
    content: `# ShortsEngine Brain Overview

This local OpenViking-style brain applies the filesystem management paradigm to the ShortsEngine project. The previous internal working name was MatchCuts AI.

- \`resources/\`: project code, OpenViking reference notes, downloaded repos, and production contracts.
- \`user/default/memories/\`: user goals, preferences, and product direction.
- \`agent/matchcuts-ai/memories/\`: implementation decisions, hardening outcomes, and session-derived experience.
- \`agent/matchcuts-ai/skills/\`: reusable execution playbooks for video AI, safety hardening, retrieval debugging, and PM evaluation.
- \`trajectories/\`: JSON and HTML traces from recursive retrieval runs.
- \`sessions/inbox/\`: append-only session transcripts waiting for commit.

Context loading follows OpenViking's L0/L1/L2 idea: read \`.abstract\` first, \`.overview\` second, and only open detailed files when the retrieval path justifies it.
`,
  },
  {
    path: "resources/.abstract",
    content: "Resources contain code, docs, repo references, and project knowledge used by the ShortsEngine agent.",
  },
  {
    path: "resources/.overview",
    content: `# Resources

Use this area for durable source material. Prefer directory-level \`.abstract\` and \`.overview\` files before loading detailed files.

Primary resource groups:

- \`matchcuts-ai/\`: current frontend prototype, hardening layer, tests, and production notes.
- \`openviking-reference/\`: distilled notes from the cloned OpenViking repo.
- \`external-repos/\`: local pointers to cloned research/tooling repos.
`,
  },
  {
    path: "resources/matchcuts-ai/.abstract",
    content:
      "ShortsEngine is a hardened prototype for turning football highlights into short-form vertical content; MatchCuts AI was the earlier working name.",
  },
  {
    path: "resources/matchcuts-ai/.overview",
    content: `# ShortsEngine Resource Overview

The project currently contains a static frontend studio with production-hardening scaffolding.

Important files:

- \`index.html\`: studio shell, CSP, upload controls, consent, retry/cancel/export UI.
- \`styles.css\`: responsive UI, error states, disabled states, status badges, reduced motion.
- \`app.js\`: guarded frontend state machine for upload validation, generate/export jobs, retry/cancel, and safe UI rendering.
- \`hardening.js\`: shared validation/contracts layer with structured responses, file validation, idempotency, rate limits, job helpers.
- \`server/jobs.cjs\`: durable job store with atomic JSON persistence, recovery policy, attempts, heartbeat, and idempotency reload.
- \`server/job-worker.cjs\`: local durable worker that processes queued jobs and restarts recovered work safely.
- \`server/render-job.cjs\`: dedicated render orchestration layer with injected adapters and safe job failure handling.
- \`server/storage/artifact-store.cjs\`: local artifact store contract for uploads, audio, subtitles, renders and exports.
- \`server/repositories/\`: in-memory repository boundaries for projects, uploads, exports and project/render state.
- \`server/adapters/\`: explicit persistence/artifact adapter contracts and local adapter stubs for future DB/object storage.
- \`PRODUCTION_HARDENING.md\`: backend/API/database/video pipeline contract.
- \`resources/matchcuts-ai/job-orchestration.md\`: route decomposition and orchestration architecture notes.
- \`resources/matchcuts-ai/durable-queue.md\`: local durable queue and worker recovery contract.
- \`resources/matchcuts-ai/production-persistence-foundation.md\`: repository and artifact lifecycle contracts.
- \`resources/matchcuts-ai/database-object-storage-adapters.md\`: database/object-storage adapter contract notes.
- \`resources/matchcuts-ai/cloud-storage-staging.md\`: S3/R2/GCS-ready artifact adapter modes and FFmpeg local staging contracts.
- \`resources/matchcuts-ai/real-cloud-object-storage.md\`: real S3/R2-compatible adapter, signed delivery and cloud failure handling.
- \`resources/matchcuts-ai/async-cloud-streaming-lifecycle.md\`: streaming-oriented S3/R2 staging, multipart uploads and temp artifact lifecycle cleanup.
- \`resources/matchcuts-ai/scheduled-cleanup-artifact-index.md\`: DB-ready artifact index, scheduled cleanup worker and opt-in real cloud integration suite.
- \`resources/matchcuts-ai/production-risk-reduction-20260615.md\`: scoped hardening pass for numeric config validation and artifact index path safety.
- \`resources/matchcuts-ai/http-startup-hardening.md\`: HTTP bounds, safe headers and startup restore filtering.
- \`tests/\`: no-dependency unit/static/build checks.
`,
  },
  {
    path: "resources/matchcuts-ai/frontend.md",
    content: `# Frontend L2 Details

Source files:

- \`/Users/anastaseschatzedakes/Desktop/short form /index.html\`
- \`/Users/anastaseschatzedakes/Desktop/short form /styles.css\`
- \`/Users/anastaseschatzedakes/Desktop/short form /app.js\`

Behavioral contract:

- Upload preview must not run before validation.
- Generate/export actions must use safe state transitions.
- User-facing errors must be clear and structured.
- Mobile and desktop layouts must avoid horizontal overflow.
- Generated content should be rendered with DOM APIs, not raw HTML injection.
`,
  },
  {
    path: "resources/matchcuts-ai/hardening.md",
    content: `# Hardening L2 Details

Source files:

- \`hardening.js\`
- \`server/app.cjs\`
- \`server/jobs.cjs\`
- \`server/job-worker.cjs\`
- \`server/render-job.cjs\`
- \`server/adapters/\`
- \`PRODUCTION_HARDENING.md\`
- \`tests/validation.test.js\`
- \`tests/backend.test.cjs\`
- \`tests/render-job.test.cjs\`
- \`tests/adapter-contracts.test.cjs\`
- \`tests/static-lint.mjs\`
- \`tests/build-smoke.mjs\`

Key contracts:

- API response shape: \`{ ok, data, error }\`.
- Upload checks: filename, extension, MIME, signature, size, duration.
- Job statuses: queued, processing, failed, completed, cancelled.
- Generate/export actions use idempotency keys.
- Client validation is a guardrail only; backend must enforce the same rules.
- Routes must stay thin: HTTP validation/delegation in \`server/app.cjs\`, job orchestration in \`server/render-job.cjs\`.
- Render orchestration validates upload metadata, transcript shape, highlight moments, edit plans, output existence, and export creation order.
- Durable jobs live under \`data/jobs\`; startup recovery rebuilds idempotency, skips corrupt records, requeues stale processing jobs within max attempts, and keeps terminal jobs terminal.
- Terminal jobs must be immutable except for idempotent same-status checks; progress, output and error mutations after completion/failure/cancel are rejected.
- \`/health\` may expose safe aggregate queue readiness counts, but never job storage paths, output paths, secrets, or raw provider errors.
- Orchestration failure handling must tolerate missing project/upload context and fail the job safely without creating exports.
- Persistence boundaries must go through repositories for projects/uploads/exports and artifact adapters for filesystem/object-storage resolution.
- \`server/adapters/\` defines fail-closed persistence and artifact adapter contracts before any real DB/S3 migration.
- Local adapters must expose capability metadata in health without storage keys, local paths or provider details.
- Upload artifacts start as \`staging\`; export records are created only after a render artifact exists.
- Public API/health payloads must not expose \`storageKey\`, \`outputPath\`, local paths, or repository internals.
- Artifact id/size/buffer inputs and artifact path/key consistency are validation boundaries, not caller assumptions.
- Static serving uses frontend asset allowlists; multipart upload parsing bounds files/fields and rejects unexpected file fields.
- HTTP responses should include safe default headers: no-store, no-referrer, nosniff, and DENY framing.
- Upload multipart parsing must bound request overhead, boundary length, part header length and text field size before media validation.
- Generate JSON requests must have an explicit small body limit and reject oversized declared content before job creation.
- Startup project-state restore should only read valid \`prj_*.json\` / \`prj_*.render.json\` records under a size cap; unrelated or corrupt metadata is ignored before JSON parsing.
`,
  },
  {
    path: "resources/matchcuts-ai/production-persistence-foundation.md",
    content: `# Production Persistence Foundation

Source files:

- \`server/storage/artifact-store.cjs\`: local artifact contracts, safe storage keys, type/status validation, controlled deletion.
- \`server/adapters/artifact-adapter.cjs\`: artifact adapter contract and capability checks.
- \`server/adapters/persistence-adapter.cjs\`: database-facing persistence adapter contract and capability checks.
- \`server/adapters/local-artifact-adapter.cjs\`: local object-storage stub around the filesystem artifact store.
- \`server/adapters/local-persistence-adapter.cjs\`: local persistence adapter around in-memory repositories.
- \`server/repositories/project-repository.cjs\`: project repository boundary.
- \`server/repositories/upload-repository.cjs\`: upload repository boundary and public upload view.
- \`server/repositories/export-repository.cjs\`: export repository boundary, completed-export enforcement, path-safe public view.
- \`server/repositories/project-state.cjs\`: project/upload/render rehydration and persistence helpers.
- \`tests/persistence-foundation.test.cjs\`: artifact and repository boundary regressions.
- \`tests/adapter-contracts.test.cjs\`: adapter contract, health and no-leak regressions.

Contracts:

- Keep local filesystem and in-memory maps for now; do not introduce Postgres, Redis, S3, or cloud storage in this milestone.
- Use explicit adapter contracts so future DB/object-storage implementations can replace local defaults without rewriting routes.
- Adapter contract validation must fail closed when required capabilities are missing.
- Adapter health must expose mode/capability metadata only, not absolute paths, storage keys or output paths.
- Treat artifact \`storageKey\` as internal metadata and absolute paths as internal-only runtime values.
- Object-storage-like adapters must never expose permanent local paths; FFmpeg receives explicit local staging paths only.
- Local mode can use stable render paths, but cloud/mock-cloud modes must stage inputs/outputs under configured staging storage and clean staging files after commit/failure.
- Upload artifacts are written as \`staging\` and become \`available\` only after media probing succeeds.
- Staging upload artifacts are deleted when media probing fails.
- Artifact records validate ids, storage keys, sizes, buffer inputs, types and statuses at the boundary.
- Repository records reject path/storage-key mismatches so metadata cannot point at one artifact while runtime reads another path.
- Export records are created only after a render artifact exists as a file.
- Repositories expose public views that omit raw paths, storage keys and secrets.
- \`/health\` reports repository and artifact readiness using aggregate counts only.
- \`server/app.cjs\` should delegate record persistence to repositories and artifact resolution to \`LocalArtifactStore\`.
- \`server/render-job.cjs\` can accept repositories/adapters but must keep map fallback behavior for focused tests.

Limitations:

- This is not yet a database-backed implementation.
- The object-storage adapter is still a local filesystem stub, not S3/GCS/R2.
- Distributed workers, cleanup retention, quotas, signed download URLs, transactions and cross-process locking remain future milestones.
`,
  },
  {
    path: "resources/matchcuts-ai/database-object-storage-adapters.md",
    content: `# Database Adapter Interface + Object Storage Adapter Stub

Source files:

- \`server/adapters/persistence-adapter.cjs\`: required persistence methods and fail-closed contract validation.
- \`server/adapters/artifact-adapter.cjs\`: required artifact methods and fail-closed contract validation.
- \`server/adapters/local-persistence-adapter.cjs\`: local adapter around project/upload/export repositories.
- \`server/adapters/local-artifact-adapter.cjs\`: local object-storage-shaped adapter around \`LocalArtifactStore\`.
- \`server/app.cjs\`: wires local adapters into startup, upload/generate/download routes and health.
- \`tests/adapter-contracts.test.cjs\`: contract, capability, restore and no-leak regressions.

Contracts:

- Routes should depend on adapter-shaped persistence/artifact boundaries, not raw maps or filesystem paths.
- Persistence adapter capabilities include project/upload/export CRUD, public views, export path resolution, state restore and render/upload persistence.
- Artifact adapter capabilities include artifact record creation, public records, safe resolution, existence/stat checks, writes, availability transitions and allowed cleanup.
- Missing adapter capabilities throw \`ADAPTER_CONTRACT_INVALID\` before runtime work begins.
- Default mode remains local and dependency-free: no Postgres, Redis, S3, GCS or network dependency.
- \`/health\` reports adapter mode and capability booleans while omitting local paths, storage keys and output paths.

Limitations:

- Local persistence is still in-memory plus existing JSON state files.
- Object storage is still local filesystem-backed; signed URLs, streaming object downloads, bucket policies and retention rules are future work.
`,
  },
  {
    path: "resources/matchcuts-ai/cloud-storage-staging.md",
    content: `# Real S3/R2/GCS Adapter + FFmpeg Local Staging Strategy

Source files:

- \`server/config.cjs\`: storage adapter mode/config validation and staging root.
- \`server/storage.cjs\`: configured \`staging\` storage area.
- \`server/storage/artifact-store.cjs\`: local artifact store with staging methods.
- \`server/adapters/artifact-adapter.cjs\`: artifact adapter contract including staging, commit and cleanup methods.
- \`server/adapters/object-storage-adapter.cjs\`: adapter factory and cloud placeholder fail-closed behavior.
- \`server/adapters/mock-cloud-artifact-adapter.cjs\`: object-storage-like local adapter for tests without exposing permanent paths.
- \`server/render-job.cjs\`: render orchestration stages upload/audio/subtitles/output through artifact adapters.
- \`tests/cloud-storage-staging.test.cjs\`: config, mock-cloud, staging, render orchestration and no-leak regressions.

Contracts:

- Default adapter remains \`local\`; \`mock-cloud\` is the deterministic cloud-shaped adapter for local tests.
- Real \`s3\` and \`r2\` modes use the S3-compatible adapter; \`gcs\` remains fail-closed until a dedicated adapter is implemented.
- FFmpeg must never read directly from a cloud object. Inputs are staged to local paths first, outputs are rendered to a local stage, then committed through the artifact adapter.
- Cloud-shaped adapters must throw on \`resolveLocalPath\` and permanent local path access.
- Render/export records must not expose storage keys, absolute paths, signed tokens or provider details.
- Staging cleanup is bounded to the configured staging directory and must not delete uploads or committed renders.
- Export records are created only after the staged render has been committed and verified as an available artifact.
- \`/health\` can expose adapter mode, readiness, capabilities and staging probe booleans, but no bucket names, endpoints, storage keys or local paths.

Limitations:

- \`mock-cloud\` is still backed by local files to keep tests deterministic and network-free.
- Multipart uploads, presigned provider URLs, IAM/bucket policy checks, retention lifecycle, GCS and background cleanup are future production milestones.
`,
  },
  {
    path: "resources/matchcuts-ai/real-cloud-object-storage.md",
    content: `# Real Cloud Object Storage Adapter + Signed Delivery

Source files:

- \`server/config.cjs\`: validates S3/R2 bucket, region, endpoint, credentials and signed URL TTL.
- \`server/adapters/s3-artifact-adapter.cjs\`: S3-compatible artifact adapter with SigV4 request signing, opaque signed delivery tokens, local FFmpeg staging and safe cloud error mapping.
- \`server/adapters/s3-request-worker.cjs\`: small no-dependency HTTP worker used by the default S3 client.
- \`server/adapters/object-storage-adapter.cjs\`: creates local, mock-cloud, s3 and r2 adapters; keeps gcs fail-closed.
- \`server/errors.cjs\`: adds \`CLOUD_STORAGE_FAILED\` and redacts cloud credentials/signatures.
- \`tests/s3-artifact-adapter.test.cjs\`: mocked-client contract tests for S3/R2, staging, signed delivery and render orchestration.

Contracts:

- Local remains the default adapter and needs no cloud credentials.
- \`mock-cloud\` remains the deterministic no-network object-storage test mode.
- \`s3\` requires bucket, region, access key id and secret access key.
- \`r2\` requires bucket, endpoint, access key id and secret access key; region defaults to \`auto\` when validated.
- \`gcs\` is intentionally fail-closed because it needs a different production adapter.
- Routes and repositories still talk only to artifact/persistence contracts, never to cloud SDK/client code.
- FFmpeg never reads cloud objects directly. Inputs download to local staging, outputs render locally, then commit through the artifact adapter.
- Signed delivery uses opaque server-side tokens by default so public API responses do not expose storage keys, bucket names, provider URLs or credentials.
- Signed download tokens are validated fail-closed against downloadable artifact type and optional expected export/project/job scope before streaming.
- Invalid signed URL TTL config is rejected at startup/config validation instead of silently becoming \`NaN\` or an unsafe runtime default.
- Cloud provider failures map to \`CLOUD_STORAGE_FAILED\` and must not leak raw SDK/HTTP errors.

Limitations:

- The default S3 client remains no-dependency and process-worker based; high-volume production should still consider an async SDK/client worker with backpressure metrics.
- Direct presigned provider URLs, IAM/bucket policy verification and GCS remain future milestones.
`,
  },
  {
    path: "resources/matchcuts-ai/async-cloud-streaming-lifecycle.md",
    content: `# Async Cloud Streaming + Multipart Uploads + Artifact Lifecycle Policy

Source files:

- \`server/config.cjs\`: validates multipart threshold, part size and lifecycle cleanup defaults.
- \`server/adapters/artifact-adapter.cjs\`: requires streaming, async stage/commit and lifecycle cleanup capabilities.
- \`server/storage/artifact-store.cjs\`: local streaming helpers and dry-run temp artifact cleanup policy.
- \`server/adapters/local-artifact-adapter.cjs\`: local adapter wrappers for the expanded artifact contract.
- \`server/adapters/mock-cloud-artifact-adapter.cjs\`: deterministic cloud-shaped streaming/lifecycle wrappers for tests.
- \`server/adapters/s3-request-worker.cjs\`: no-dependency worker operations for download-to-file and upload-from-file.
- \`server/adapters/s3-artifact-adapter.cjs\`: S3/R2 streaming-oriented staging, single-file upload, multipart selection and abort-on-failure.
- \`tests/s3-artifact-adapter.test.cjs\`: mocked-client regressions for streaming, multipart, cancellation and lifecycle cleanup.

Contracts:

- Local and mock-cloud remain deterministic default/no-network paths.
- FFmpeg still receives only local staging paths; cloud objects are staged to local files before processing.
- S3/R2 input staging should prefer download-to-file worker operations instead of returning full objects through parent process buffers.
- S3/R2 render commit should prefer upload-from-file worker operations for single uploads.
- Multipart upload is selected when artifact size crosses the configured threshold and the client exposes multipart methods.
- Multipart failures must abort best-effort and leave no completed artifact record.
- Lifecycle cleanup is dry-run capable, bounded by max age and max artifacts, and limited to temporary artifact types.
- Uploads and completed renders/exports must not be deleted by generic lifecycle cleanup.
- Health can expose capability booleans and safe size thresholds, but not storage keys, bucket names, endpoints, signatures or credentials.

Limitations:

- Multipart tests use mocked clients by default; real cloud integration remains opt-in.
- Multipart upload still uses bounded part buffers in the default no-dependency client; future high-volume production can move part upload to a streaming SDK/client worker.
- Cleanup operates on provided artifact records; a future database-backed index should drive scheduled cleanup runs.
`,
  },
  {
    path: "resources/matchcuts-ai/scheduled-cleanup-artifact-index.md",
    content: `# Scheduled Cleanup Worker + Artifact Index

Working product name: ShortsEngine.

Source files:

- \`server/repositories/artifact-repository.cjs\`: DB-ready local artifact index with validation, persisted JSON records and public no-leak views.
- \`server/artifact-cleanup-worker.cjs\`: scheduled/manual cleanup service for old temp artifacts.
- \`server/adapters/local-persistence-adapter.cjs\`: wires artifact index through the persistence adapter contract.
- \`server/render-job.cjs\`: indexes temporary render stages and committed rendered artifacts for recovery/cleanup visibility.
- \`server/app.cjs\`: exposes safe artifact index and cleanup readiness in \`/health\`.
- \`scripts/run-real-cloud-integration.mjs\`: opt-in real S3/R2 integration suite with deterministic skip behavior by default.
- \`tests/artifact-cleanup-worker.test.cjs\`: artifact index and cleanup worker regressions.
- \`tests/real-cloud-integration.test.mjs\`: real cloud integration skip-path regression.

Contracts:

- Routes and orchestration should not read or mutate raw artifact maps directly when a repository boundary exists.
- Cleanup candidates come from the artifact index, not from recursive filesystem/object-storage scans.
- Cleanup is temp-type only and must never delete uploads or completed renders/exports.
- Active queued/processing jobs protect their owned artifacts from scheduled deletion.
- Cleanup runs are dry-run capable, bounded by max age and max artifact count, and expose only safe aggregate health.
- Real cloud integration remains explicit through \`MATCHCUTS_RUN_REAL_CLOUD_TESTS=1\` plus S3/R2 credentials.

Limitations:

- Artifact index is still a local JSON/in-memory repository, not a real database table.
- Scheduled cleanup is disabled unless \`MATCHCUTS_ARTIFACT_CLEANUP_INTERVAL_MS\` is configured.
- Real cloud integration is not part of default tests because it needs external credentials/network.
`,
  },
  {
    path: "resources/matchcuts-ai/production-risk-reduction-20260615.md",
    content: `# Production Risk Reduction Pass - 2026-06-15

Working product name: ShortsEngine.

Scope:

- Tightened server numeric config validation in \`server/config.cjs\`.
- Tightened artifact index path validation in \`server/repositories/artifact-repository.cjs\`.
- Added focused regressions in \`tests/cloud-storage-staging.test.cjs\`.
- Added focused regressions in \`tests/artifact-cleanup-worker.test.cjs\`.

Contracts:

- Numeric env config must fail closed instead of allowing \`NaN\` into runtime paths.
- Ports, upload size, media duration, timeout and retry settings must have bounded defaults.
- Artifact repository records may keep internal \`path\` metadata, but only after validating it is inside the storage area for that artifact type.
- Public artifact views must still omit paths and storage keys.
- Corrupt or unsafe persisted artifact metadata should be ignored or rejected safely.

Limitations:

- This is still local JSON/in-memory persistence, not a database-backed repository.
- A future DB adapter should enforce the same path/storage-key invariants at adapter contract boundaries.
`,
  },
  {
    path: "resources/matchcuts-ai/http-startup-hardening.md",
    content: `# HTTP + Startup Hardening

Source files:

- \`server/app.cjs\`: request body bounds, multipart parser limits, safe download filename normalization, response headers.
- \`server/errors.cjs\`: shared safe response headers for JSON errors/success.
- \`server/repositories/project-state.cjs\`: filtered project-state restore with filename and size gates.
- \`tests/backend.test.cjs\`: HTTP bounds, safe headers and filename regressions.
- \`tests/persistence-foundation.test.cjs\`: unrelated/corrupt project metadata restore regressions.

Contracts:

- Upload body size is \`maxUploadBytes\` plus a small multipart overhead allowance, not an unbounded field allowance.
- Multipart boundaries, part headers and text fields are bounded before file validation.
- Generate JSON requests use a small explicit body limit and reject oversized declared content before job creation.
- JSON/static/download responses include safe default headers: \`cache-control: no-store\`, \`referrer-policy: no-referrer\`, \`x-content-type-options: nosniff\`, and \`x-frame-options: DENY\`.
- Download filenames are normalized before \`Content-Disposition\`.
- Startup project restore ignores unrelated \`.json\` files before read and caps project-state file size.

Limitations:

- Local data cleanup/retention is still manual; a dedicated retention policy remains a future production milestone.
`,
  },
  {
    path: "resources/matchcuts-ai/durable-queue.md",
    content: `# Durable Queue + Worker Persistence

Source files:

- \`server/jobs.cjs\`: durable job store, atomic JSON persistence, idempotency index recovery, stale processing recovery.
- \`server/job-worker.cjs\`: local worker abstraction for queued/recovered jobs.
- \`server/app.cjs\`: startup recovery, completed export restoration, API enqueue delegation.
- \`server/config.cjs\`: \`data/jobs\` storage configuration.
- \`tests/job-persistence.test.cjs\`: reload, stale, corrupt, unsafe, worker, cancellation and idempotency regressions.

Storage:

- Durable job files live under \`data/jobs/\`.
- Runtime-only \`_controller\` is never persisted.
- Public job responses omit \`outputPath\`; persisted records may keep storage-safe internal render paths for recovery.

Recovery policy:

- Completed, failed and cancelled jobs stay terminal.
- Queued jobs are picked up by the local worker.
- Processing jobs with stale/missing heartbeat are requeued while attempts are under the safe limit.
- Processing jobs at/over the attempt limit become failed with \`JOB_STALE\`.
- Corrupt or unsafe job records are skipped without crashing startup.

Worker contract:

- The local worker marks queued jobs processing, increments attempts through \`JobStore\`, calls \`runRenderJob\`, and respects cancellation.
- Missing project/upload during recovery fails closed with safe structured errors.
- No duplicate worker is scheduled for a job already running in-process.

Limitations:

- This is a local durable queue, not a distributed queue.
- Multi-process locking, database transactions, object storage and cross-machine workers remain future production milestones.
`,
  },
  {
    path: "resources/matchcuts-ai/job-orchestration.md",
    content: `# Job Orchestration Architecture

Source files:

- \`server/app.cjs\`: HTTP route parsing, validation, rate limiting, idempotency, and delegation.
- \`server/render-job.cjs\`: render/generate orchestration, progress, cancellation, adapters, defensive validation, export persistence.
- \`server/jobs.cjs\`: state machine and idempotency.
- \`tests/render-job.test.cjs\`: mocked orchestration success/failure/cancel regressions.

Contracts:

- Routes must not own FFmpeg/transcription/analysis/edit-plan business logic.
- \`enqueueRenderJob\` starts only queued jobs and avoids restarting active idempotent jobs.
- \`runRenderJob\` accepts injected adapters for tests and defaults to real local modules in production.
- Exports are created only after render success and output verification.
- Project status becomes \`ready\` only after job completion; failures become \`failed\`; cancellations leave projects unexported.
- Logs include requestId/jobId/projectId/step/error code without absolute local paths or secrets.
`,
  },
  {
    path: "resources/openviking-reference/.abstract",
    content:
      "OpenViking organizes agent context as viking:// filesystem paths with L0 abstracts, L1 overviews, L2 details, recursive retrieval, traces, and session memory.",
  },
  {
    path: "resources/openviking-reference/.overview",
    content: `# OpenViking Reference Overview

Distilled from the cloned \`OpenViking\` repository.

Core ideas applied here:

- Filesystem management paradigm: resources, memories, and skills are directories.
- Tiered loading: \`.abstract\` is L0, \`.overview\` is L1, normal files are L2.
- Directory recursive retrieval: score directories first, then drill into promising branches.
- Visualized retrieval trajectory: every search writes a trace under \`trajectories/\`.
- Automatic session management: append turns to \`sessions/inbox/\`, then commit summaries into agent memories.

Native OpenViking server can replace this local implementation later when model provider and embedding config are ready.
`,
  },
  {
    path: "resources/openviking-reference/concepts.md",
    content: `# OpenViking Concepts Used

Filesystem paradigm:

- \`viking://resources/\` maps to durable source material.
- \`viking://user/default/memories/\` maps to user preferences and goals.
- \`viking://agent/matchcuts-ai/skills/\` maps to reusable procedures.

Tiered context:

- L0: \`.abstract\`, a one-sentence relevance signal.
- L1: \`.overview\`, a compact planning summary.
- L2: detailed markdown files or direct source files opened only when needed.

Retrieval:

- Analyze query tokens.
- Score directory L0/L1 content.
- Descend recursively into high-signal branches.
- Score L2 files.
- Write trace JSON and HTML for observability.

Session:

- Append conversation turns.
- Commit session into long-term memories.
- Keep raw transcript and extracted memory linked.
`,
  },
  {
    path: "resources/openviking-reference/codex-plugin.md",
    content: `# Codex Plugin Reference

The cloned OpenViking repo includes \`examples/codex-memory-plugin\`.

Useful ideas:

- UserPromptSubmit can recall relevant memories.
- Stop can append turns to an OpenViking session.
- PreCompact can commit the session and extract long-term memory.
- Codex MCP can talk to OpenViking's \`/mcp\` endpoint when a server is configured.

This workspace implementation does not modify global Codex config. It keeps everything local under \`viking-brain/\`.
`,
  },
  {
    path: "resources/external-repos/.abstract",
    content: "Pointers to downloaded repositories that can inform MatchCuts AI product and evaluation work.",
  },
  {
    path: "resources/external-repos/.overview",
    content: `# External Repositories

Downloaded locally:

- \`OpenViking/\`: agent context database and memory paradigm.
- \`promptfoo/\`: LLM evaluation, prompt testing, and red-team style workflows.
- \`pm-skills/\`: product-management skills and agent playbooks.

Use these as resources. Do not bulk-load them; retrieve by directory and targeted files.
`,
  },
  {
    path: "resources/external-repos/promptfoo.md",
    content:
      "# promptfoo Resource\n\nLocal path: `promptfoo/`.\n\nUse for evaluating AI-generated captions, hooks, safety behavior, and prompt regressions before production launch.\n",
  },
  {
    path: "resources/external-repos/pm-skills.md",
    content:
      "# pm-skills Resource\n\nLocal path: `pm-skills/`.\n\nUse for product strategy, roadmap framing, MVP prioritization, and launch-readiness thinking.\n",
  },
  {
    path: "user/default/memories/.abstract",
    content: "User wants a serious AI-generated short-form sports content platform with strong production safety.",
  },
  {
    path: "user/default/memories/.overview",
    content: `# User Memory Overview

Durable preferences inferred from this project:

- Build practical product artifacts, not only strategy.
- Keep the platform production-minded and safe.
- Focus on football highlights, subtitles, trendy edits, and attention-grabbing short-form output.
- Prefer concrete implementation and verification.
`,
  },
  {
    path: "user/default/memories/product-goal.md",
    content: `# Product Goal Memory

The user wants an AI-generated platform that accepts football match highlights and creates short-form content with subtitles, trendy editing, animations, and attention-grabbing presentation for TikTok/Reels/Shorts.
`,
  },
  {
    path: "agent/matchcuts-ai/memories/.abstract",
    content: "Agent memories record implementation decisions, hardening outcomes, retrieval lessons, and session summaries.",
  },
  {
    path: "agent/matchcuts-ai/memories/.overview",
    content: `# Agent Memory Overview

Use this area to preserve project-specific operating knowledge:

- architecture decisions
- validation and security constraints
- UI verification outcomes
- retrieval/session lessons
- future implementation warnings
`,
  },
  {
    path: "agent/matchcuts-ai/memories/hardening-decisions.md",
    content: `# Hardening Decisions

- Keep the current app static and dependency-light until backend requirements are concrete.
- Validate uploads before preview.
- Use structured safe errors.
- Render generated UI content with DOM APIs.
- Use local tests for validation, static lint, and build smoke checks.
- Treat client-side validation as convenience only; production backend must enforce all checks.
- Keep HTTP routes thin; route files should delegate video/render orchestration to dedicated modules.
- Protect job lifecycle with explicit states and do not create exports before successful render output verification.
- Test orchestration with mocked providers/tools so provider, render, AI-output, and cancellation failures are deterministic.
- Persist job records under \`data/jobs\` with atomic writes and rebuild idempotency on startup.
- Requeue stale processing jobs only while attempts remain under the local retry limit; otherwise fail with \`JOB_STALE\`.
- Keep public job responses path-safe while allowing storage-safe internal paths in durable records for recovery.
- Reject terminal job mutations except idempotent same-status checks, and expose only safe aggregate queue health in \`/health\`.
- Keep project/upload/export persistence behind repository interfaces and artifact paths behind \`LocalArtifactStore\` before introducing database or object-storage adapters.
- Keep local storage as the default, use \`mock-cloud\` for object-storage-shaped tests, use the S3-compatible adapter for \`s3\`/\`r2\`, and keep \`gcs\` fail-closed until its dedicated adapter is implemented.
- FFmpeg must use adapter-owned local staging paths for cloud-shaped storage; cleanup staging files after commit/failure without deleting uploads or committed renders.
- Signed delivery should prefer opaque server-side tokens so public responses avoid bucket, endpoint and storage-key leakage.
- Working product name is ShortsEngine for now; existing internal MatchCuts paths may remain until a dedicated rename milestone.
- Artifact cleanup should be driven by a DB-ready artifact index with public no-leak views, not direct filesystem/object-storage scans.
- Scheduled cleanup must be temp-type only, bounded, dry-run capable and protective of active job-owned artifacts.
- Real cloud integration must stay opt-in and skip safely unless explicit env flag and credentials are present.
- Numeric runtime config must use bounded validation helpers so deployment mistakes fail closed instead of producing \`NaN\` behavior.
- Artifact index paths must be validated against the artifact type storage area before persistence.
`,
  },
  {
    path: "agent/matchcuts-ai/skills/.abstract",
    content: "Reusable skills for developing, hardening, retrieving, and evaluating MatchCuts AI.",
  },
  {
    path: "agent/matchcuts-ai/skills/.overview",
    content: `# MatchCuts AI Skills

Skills are practical playbooks the agent can load on demand:

- \`video-pipeline.md\`: AI video pipeline sequence and contracts.
- \`production-hardening.md\`: safety and stability checklist.
- \`retrieval-debugging.md\`: how to inspect retrieval traces and tune context.
- \`evaluation.md\`: how to evaluate prompts/captions using promptfoo-style thinking.
`,
  },
  {
    path: "agent/matchcuts-ai/skills/video-pipeline.md",
    content: `# Skill: Video Pipeline

Use when implementing backend video processing.

Steps:

1. Ingest and validate media.
2. Scan for malware/media safety.
3. Analyze scenes and camera motion.
4. Transcribe and align word timings.
5. Detect highlights and rank moments.
6. Generate edit plan.
7. Validate AI output.
8. Render preview.
9. Export final formats.

Every step needs schema validation, timeout, retry, idempotency, and traceable artifacts.
`,
  },
  {
    path: "agent/matchcuts-ai/skills/production-hardening.md",
    content: `# Skill: Production Hardening

Use before shipping code.

Checklist:

- Validate every user input.
- Add loading, empty, success, error, retry, and cancel states.
- Keep user errors safe and technical logs structured.
- Add idempotency keys for jobs.
- Add rate limits for expensive operations.
- Add tests for edge cases and failure paths.
- Verify desktop/mobile layout for overflow.
- Persist jobs durably before/while processing so server restarts do not lose work.
- Add heartbeat and max-attempt recovery policy for processing jobs.
- Skip corrupt persisted records safely and keep terminal jobs terminal.
- Reject terminal job mutations except idempotent same-status checks.
- Expose only aggregate queue health in readiness endpoints.
- Add no-leak regression tests for safe errors, health payloads, and loggable job output.
- Bound JSON and multipart request bodies at the route boundary before expensive parsing or job creation.
- Apply safe default response headers consistently for JSON, static assets and downloads.
- Keep startup restore filters strict so unrelated/corrupt local metadata cannot slow or block app boot.
- Put project/upload/export persistence behind repositories before adding real databases.
- Put uploads, audio, subtitles, renders and exports behind artifact-store contracts before adding object storage.
- Validate persistence and artifact adapter capabilities at startup before swapping in database or object-storage implementations.
- Keep adapter health limited to mode/capability/readiness metadata, never raw paths or storage keys.
- Treat artifact storage keys as internal only; never include them in public responses or health payloads.
- Stage FFmpeg input/output through artifact adapters so cloud storage can be added without leaking permanent object paths.
- Keep GCS fail-closed until its adapter is implemented; keep multipart/direct-provider signed URL behavior opt-in until explicitly tested.
- For \`s3\`/\`r2\`, validate bucket/region/endpoint/credentials at config time and convert provider failures to \`CLOUD_STORAGE_FAILED\`.
- Validate signed delivery TTLs as bounded numbers and reject invalid config fail-closed.
- Validate signed download tokens against downloadable artifact type plus expected export/project/job scope whenever the caller has that context.
- For cloud artifacts, prefer download-to-file and upload-from-file staging paths so large objects do not flow through public APIs or unbounded parent-process buffers.
- Multipart upload thresholds and part sizes must be validated config, tested with mocked clients, and abort best-effort on failure.
- Lifecycle cleanup must be dry-run capable, max-age/max-count bounded, temp-type only, and must never delete uploads or completed renders/exports by default.
- Use mocked cloud clients in default tests; real cloud integration must stay opt-in through explicit env flags.
- Test staging cleanup for probe/render failures that happen after a file has been written.
- Drive scheduled cleanup from a validated artifact index/repository, not from ad hoc recursive storage scans.
- Protect artifacts owned by active queued/processing jobs from cleanup.
- Expose cleanup/index readiness as aggregate health fields only: no storage keys, local paths, bucket names or provider errors.
- Keep real S3/R2 integration in an explicit \`integration:cloud\` script that skips safely without \`MATCHCUTS_RUN_REAL_CLOUD_TESTS=1\` and credentials.
- Validate numeric env/config values with bounded helpers; never allow \`NaN\` ports, limits, durations, timeouts or retry counts into runtime.
- Validate any persisted artifact \`path\` against the storage area for its artifact type before indexing it.
`,
  },
  {
    path: "agent/matchcuts-ai/skills/retrieval-debugging.md",
    content: `# Skill: Retrieval Debugging

Use when a search returns wrong or noisy context.

Steps:

1. Open the latest file in \`viking-brain/trajectories/\`.
2. Check which directories scored highest.
3. Inspect whether \`.abstract\` or \`.overview\` is misleading.
4. Tighten directory summaries before changing detailed files.
5. Re-run \`npm run brain:find -- "query"\`.
`,
  },
  {
    path: "agent/matchcuts-ai/skills/evaluation.md",
    content: `# Skill: Evaluation

Use promptfoo-style evaluation thinking for captions, hooks, and generated edit plans.

Evaluate:

- Hook clarity in first 2 seconds.
- Caption accuracy and language fit.
- Copyright/safety warnings.
- No fabricated sports events.
- Stable output format.
- Regression cases for failed upload, missing captions, and failed render.
`,
  },
  {
    path: "sessions/.abstract",
    content: "Sessions hold append-only transcripts before they are committed into durable agent memories.",
  },
  {
    path: "sessions/.overview",
    content:
      "# Sessions\n\nUse `session-add` to append user/assistant turns and `session-commit` to compress them into `agent/matchcuts-ai/memories/sessions/`.\n",
  },
  {
    path: "trajectories/.abstract",
    content: "Retrieval trajectories show why a query selected certain directories and files.",
  },
  {
    path: "trajectories/.overview",
    content:
      "# Retrieval Trajectories\n\nEvery `find` command writes a JSON trace and an HTML visualization here for observability.\n",
  },
];

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeIfMissing(path, content, refresh = false) {
  ensureDir(dirname(path));
  const nextContent = `${content.trim()}\n`;
  if (existsSync(path)) {
    if (!refresh) return;
    if (readMaybe(path) === nextContent) return;
  }
  writeFileSync(path, nextContent, "utf8");
}

function removeGeneratedFiles(dir, shouldRemove) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!shouldRemove(name)) continue;
    const source = join(dir, name);
    try {
      unlinkSync(source);
    } catch {
      // Best-effort cleanup of generated brain artifacts before deterministic refresh.
    }
  }
}

function initBrain({ refresh = false } = {}) {
  ensureDir(BRAIN_ROOT);
  for (const file of seedFiles) {
    writeIfMissing(join(BRAIN_ROOT, file.path), file.content, refresh);
  }
  ensureDir(join(BRAIN_ROOT, "sessions", "inbox"));
  ensureDir(join(BRAIN_ROOT, "agent", "matchcuts-ai", "memories", "sessions"));
  ensureDir(join(BRAIN_ROOT, "trajectories"));
  if (refresh) {
    removeGeneratedFiles(join(BRAIN_ROOT, "sessions", "inbox"), (name) => name.endsWith(".jsonl"));
    removeGeneratedFiles(join(BRAIN_ROOT, "trajectories"), (name) => name.endsWith(".json") || name.endsWith(".html"));
  }
  return { root: BRAIN_ROOT, files: seedFiles.length };
}

function toUri(path) {
  const rel = relative(BRAIN_ROOT, path).split("/").filter(Boolean).join("/");
  return rel ? `${URI_ROOT}/${rel}` : URI_ROOT;
}

function fromUri(uri) {
  if (!uri || uri === URI_ROOT) return BRAIN_ROOT;
  const rel = uri.replace(`${URI_ROOT}/`, "");
  return join(BRAIN_ROOT, rel);
}

function tokenize(text) {
  return [...String(text || "").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)]
    .map((match) => match[0])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function readMaybe(path) {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8").slice(0, MAX_READ_BYTES);
  } catch {
    return "";
  }
}

function scoreText(queryTokens, text) {
  const textTokens = tokenize(text);
  if (textTokens.length === 0 || queryTokens.length === 0) return 0;
  const counts = new Map();
  for (const token of textTokens) counts.set(token, (counts.get(token) || 0) + 1);
  let score = 0;
  for (const query of queryTokens) {
    if (counts.has(query)) score += 3 + Math.min(4, counts.get(query));
    else if (textTokens.some((token) => token.includes(query) || query.includes(token))) score += 0.75;
  }
  return Number((score / Math.sqrt(textTokens.length)).toFixed(4));
}

function isHiddenOrGenerated(name) {
  return (
    name === ".DS_Store" ||
    name === "node_modules" ||
    name === ".git" ||
    name.includes(".unreadable-") ||
    name.includes(".refresh-backup-") ||
    name.endsWith(".jsonl") ||
    name.endsWith(".html") ||
    name.endsWith(".json")
  );
}

function listEntries(dir) {
  return readdirSync(dir)
    .filter((name) => !isHiddenOrGenerated(name))
    .map((name) => join(dir, name))
    .sort((a, b) => a.localeCompare(b));
}

function shouldSearchDirectory(path) {
  const name = basename(path);
  const parent = basename(dirname(path));
  if (name === "trajectories") return false;
  if (parent === "sessions" && name === "inbox") return false;
  return true;
}

function summarizeFile(path) {
  const content = readMaybe(path);
  return content.split(/\n+/).slice(0, 8).join(" ").slice(0, 320);
}

function searchDirectory(dir, queryTokens, options, trace, depth = 0, state = { visited: new Set(), files: 0 }) {
  if (state.visited.has(dir) || trace.nodes.length >= options.maxNodes) return [];
  state.visited.add(dir);
  const abstract = readMaybe(join(dir, ".abstract"));
  const overview = readMaybe(join(dir, ".overview"));
  const dirScore = scoreText(queryTokens, `${abstract}\n${overview}\n${basename(dir)}`);
  const uri = toUri(dir);
  const node = {
    type: "directory",
    uri,
    depth,
    score: dirScore,
    l0: abstract.trim(),
    decision: depth === 0 || dirScore >= options.directoryThreshold ? "explore" : "scan-lightly",
    children: [],
  };
  if (trace.nodes.length < options.maxNodes) trace.nodes.push(node);

  const results = [];
  const entries = listEntries(dir);
  const dirs = entries.filter((entry) => depth + 1 <= options.maxDepth && statSync(entry).isDirectory() && shouldSearchDirectory(entry));
  const files = entries.filter((entry) => statSync(entry).isFile() && ![".abstract", ".overview"].includes(basename(entry)));

  for (const file of files) {
    if (state.files >= options.maxFiles || trace.nodes.length >= options.maxNodes) break;
    state.files += 1;
    const content = readMaybe(file);
    const fileScore = scoreText(queryTokens, `${basename(file)}\n${content}`);
    const fileResult = {
      type: "file",
      uri: toUri(file),
      path: relative(CWD, file),
      score: fileScore,
      layer: "L2",
      summary: summarizeFile(file),
    };
    if (trace.nodes.length < options.maxNodes) {
      trace.nodes.push({
        type: "file",
        uri: fileResult.uri,
        depth: depth + 1,
        score: fileScore,
        decision: fileScore > 0 ? "candidate" : "low-signal",
      });
    }
    if (fileScore > 0) results.push(fileResult);
  }

  const sortedDirs = dirs
    .map((child) => ({
      path: child,
      score: scoreText(queryTokens, `${basename(child)}\n${readMaybe(join(child, ".abstract"))}\n${readMaybe(join(child, ".overview"))}`),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  for (const child of sortedDirs) {
    if (trace.nodes.length >= options.maxNodes) break;
    if (depth + 1 > options.maxDepth) continue;
    const childResults = searchDirectory(child.path, queryTokens, options, trace, depth + 1, state);
    results.push(...childResults);
  }

  return results;
}

function slugify(text) {
  return String(text || "query")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "query";
}

function renderTrajectoryHtml(trace, jsonName) {
  const rows = trace.nodes
    .map(
      (node) =>
        `<tr><td>${"&nbsp;".repeat(node.depth * 4)}${escapeHtml(node.uri)}</td><td>${node.type}</td><td>${node.score}</td><td>${escapeHtml(node.decision)}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenViking Retrieval Trajectory</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; background: #f6f7f3; color: #151a18; }
    main { max-width: 1100px; margin: 0 auto; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #ccd5c8; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #e4eadf; text-align: left; vertical-align: top; }
    th { background: #151a18; color: white; }
    code { background: #e9eee5; padding: 2px 5px; border-radius: 6px; }
  </style>
</head>
<body>
  <main>
    <h1>Retrieval Trajectory</h1>
    <p><strong>Query:</strong> ${escapeHtml(trace.query)}</p>
    <p><strong>Trace JSON:</strong> <code>${escapeHtml(jsonName)}</code></p>
    <table>
      <thead><tr><th>URI</th><th>Type</th><th>Score</th><th>Decision</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>
`;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findContext(query, options = {}) {
  if (!existsSync(BRAIN_ROOT)) initBrain();
  const queryTokens = tokenize(query);
  const trace = {
    query,
    queryTokens,
    createdAt: new Date().toISOString(),
    root: URI_ROOT,
    nodes: [],
  };
  const searchOptions = {
    maxDepth: Number(options.maxDepth || 3),
    directoryThreshold: Number(options.directoryThreshold || 0.01),
    maxFiles: Number(options.maxFiles || DEFAULT_MAX_SEARCH_FILES),
    maxNodes: Number(options.maxNodes || DEFAULT_MAX_SEARCH_NODES),
  };
  const results = searchDirectory(BRAIN_ROOT, queryTokens, searchOptions, trace)
    .sort((a, b) => b.score - a.score || a.uri.localeCompare(b.uri))
    .slice(0, Number(options.limit || 8));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonName = `${stamp}-${slugify(query)}.json`;
  const htmlName = `${stamp}-${slugify(query)}.html`;
  const traceDir = join(BRAIN_ROOT, "trajectories");
  ensureDir(traceDir);
  const tracePayload = { ...trace, results };
  writeFileSync(join(traceDir, jsonName), `${JSON.stringify(tracePayload, null, 2)}\n`, "utf8");
  writeFileSync(join(traceDir, htmlName), renderTrajectoryHtml(tracePayload, jsonName), "utf8");

  return {
    query,
    results,
    trajectory: {
      json: join("viking-brain", "trajectories", jsonName),
      html: join("viking-brain", "trajectories", htmlName),
    },
  };
}

function printTree(dir = BRAIN_ROOT, maxDepth = 3, depth = 0, lines = []) {
  if (!existsSync(dir)) initBrain();
  if (depth === 0) lines.push(`${basename(dir)}/`);
  if (depth >= maxDepth) return lines;
  const entries = listEntries(dir);
  for (const entry of entries) {
    const prefix = "  ".repeat(depth + 1);
    const name = basename(entry);
    if (statSync(entry).isDirectory()) {
      lines.push(`${prefix}${name}/`);
      printTree(entry, maxDepth, depth + 1, lines);
    } else {
      lines.push(`${prefix}${name}`);
    }
  }
  return lines;
}

function sessionPath(sessionId) {
  const safe = slugify(sessionId || "default-session");
  return join(BRAIN_ROOT, "sessions", "inbox", `${safe}.jsonl`);
}

function sessionAdd({ sessionId, role, text }) {
  if (!existsSync(BRAIN_ROOT)) initBrain();
  if (!["user", "assistant", "tool"].includes(role)) {
    throw new Error("role must be user, assistant, or tool");
  }
  const record = {
    ts: new Date().toISOString(),
    role,
    text: String(text || "").trim(),
  };
  if (!record.text) throw new Error("text is required");
  const path = sessionPath(sessionId);
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return { path: relative(CWD, path), record };
}

function extractMemoryLines(records) {
  const joined = records.map((record) => `${record.role}: ${record.text}`).join("\n");
  const fileRefs = [...joined.matchAll(/(?:^|\s)([A-Za-z0-9_.\/ -]+\.(?:js|html|css|md|json|mjs|py|toml))/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .slice(0, 12);
  const keySentences = joined
    .split(/(?<=[.!?;。])\s+|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 24)
    .slice(0, 8);
  return { fileRefs: [...new Set(fileRefs)], keySentences };
}

function sessionCommit(sessionId) {
  if (!existsSync(BRAIN_ROOT)) initBrain();
  const path = sessionPath(sessionId);
  if (!existsSync(path)) throw new Error(`No session inbox found for ${sessionId}`);
  const records = readFileSync(path, "utf8")
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (records.length === 0) throw new Error("Session inbox is empty");
  const extracted = extractMemoryLines(records);
  const safe = slugify(sessionId || "default-session");
  const target = join(BRAIN_ROOT, "agent", "matchcuts-ai", "memories", "sessions", `${safe}.md`);
  const content = `# Session Memory: ${sessionId}

Created: ${new Date().toISOString()}
Source transcript: \`${relative(CWD, path)}\`

## Summary

${extracted.keySentences.length ? extracted.keySentences.map((line) => `- ${line}`).join("\n") : "- Session captured for future retrieval."}

## Referenced Files

${extracted.fileRefs.length ? extracted.fileRefs.map((ref) => `- \`${ref}\``).join("\n") : "- None detected."}

## Retrieval Hints

- session
- matchcuts-ai
- implementation-memory
- openviking-lite
`;
  writeIfMissing(target, content, true);
  writeIfMissing(
    join(dirname(target), ".abstract"),
    "Committed session memories for MatchCuts AI implementation and product work.",
    true,
  );
  writeIfMissing(
    join(dirname(target), ".overview"),
    "# Session Memories\n\nCompressed session memories extracted from append-only local transcripts.\n",
    true,
  );
  return { target: relative(CWD, target), records: records.length };
}

function health() {
  const required = [
    ".abstract",
    ".overview",
    "resources/.abstract",
    "resources/matchcuts-ai/.overview",
    "agent/matchcuts-ai/skills/.overview",
    "user/default/memories/.overview",
    "sessions/inbox",
    "trajectories",
  ];
  const missing = required.filter((entry) => !existsSync(join(BRAIN_ROOT, entry)));
  return {
    ok: missing.length === 0,
    root: BRAIN_ROOT,
    missing,
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || "help";
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (!next || next.startsWith("--")) options[key] = true;
      else {
        options[key] = next;
        index += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, options, positional };
}

function usage() {
  return `OpenViking Lite for MatchCuts AI

Commands:
  init [--refresh]                         Create/update viking-brain filesystem
  tree [--depth 4]                         Print context tree
  find "query" [--limit 8] [--max-depth 3] Recursive retrieval with trace output
  session-add --session ID --role ROLE --text TEXT
  session-commit --session ID              Compress transcript into agent memory
  health                                   Validate required brain files
`;
}

function main() {
  const { command, options, positional } = parseArgs(process.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "init") {
    console.log(JSON.stringify(initBrain({ refresh: Boolean(options.refresh) }), null, 2));
    return;
  }
  if (command === "tree") {
    console.log(printTree(BRAIN_ROOT, Number(options.depth || 4)).join("\n"));
    return;
  }
  if (command === "find") {
    const query = positional.join(" ").trim();
    if (!query) throw new Error("find requires a query");
    console.log(JSON.stringify(findContext(query, { limit: options.limit, maxDepth: options["max-depth"] }), null, 2));
    return;
  }
  if (command === "session-add") {
    console.log(JSON.stringify(sessionAdd({ sessionId: options.session, role: options.role, text: options.text }), null, 2));
    return;
  }
  if (command === "session-commit") {
    console.log(JSON.stringify(sessionCommit(options.session), null, 2));
    return;
  }
  if (command === "health") {
    const result = health();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export {
  BRAIN_ROOT,
  URI_ROOT,
  initBrain,
  findContext,
  printTree,
  sessionAdd,
  sessionCommit,
  tokenize,
  scoreText,
  health,
};
