const { randomUUID } = require("node:crypto");
const { existsSync, statSync } = require("node:fs");
const { AppError, SAFE_MESSAGES, redactForLogs } = require("./errors.cjs");
const { runRenderJob } = require("./render-job.cjs");
const { assertStoragePath } = require("./storage.cjs");
const { LocalArtifactAdapter } = require("./adapters/local-artifact-adapter.cjs");
const { createLocalJobQueue } = require("./queue/local-job-queue.cjs");
const { createPipelineRegistry } = require("./pipelines/pipeline-registry.cjs");

function logInfo(logger, payload) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(JSON.stringify(redactForLogs({ level: "info", ...payload })));
}

function outputExists(outputPath) {
  try {
    return existsSync(outputPath) && statSync(outputPath).isFile();
  } catch {
    return false;
  }
}

function payloadForJob(job, project) {
  const payload = {
    title: (job.payload && job.payload.title) || project.title || "ShortsEngine Short",
    preset: (job.payload && job.payload.preset) || "hype",
    language: (job.payload && job.payload.language) || "auto",
    styleTarget: (job.payload && job.payload.styleTarget) || "vertical_9_16",
    editIntensity: (job.payload && job.payload.editIntensity) || "balanced",
    stylePreset: (job.payload && job.payload.stylePreset) || "social_sports_v1",
    compositionMode: (job.payload && job.payload.compositionMode) || "auto",
  };
  if (job.payload && job.payload.goalSelectionMode) payload.goalSelectionMode = job.payload.goalSelectionMode;
  if (job.payload && Number.isInteger(Number(job.payload.expectedCountedGoals))) {
    payload.expectedCountedGoals = Number(job.payload.expectedCountedGoals);
  }
  if (job.payload && /^\d{1,2}-\d{1,2}$/.test(String(job.payload.expectedFinalScore || ""))) {
    payload.expectedFinalScore = String(job.payload.expectedFinalScore);
  }
  if (job.payload && job.payload.source) payload.source = job.payload.source;
  if (job.payload && job.payload.approvedEditPlan) payload.approvedEditPlan = job.payload.approvedEditPlan;
  if (job.payload && job.payload.regenerationApproval) payload.regenerationApproval = job.payload.regenerationApproval;
  return payload;
}

function createWorkerId() {
  return `wrk_${randomUUID()}`;
}

function terminalStatus(status) {
  return ["completed", "failed", "cancelled"].includes(status);
}

function heartbeatIntervalMs(input, leaseDurationMs) {
  if (input === 0) return 0;
  const leaseMs = Number.isFinite(Number(leaseDurationMs)) ? Number(leaseDurationMs) : 5 * 60 * 1000;
  const fallback = Math.max(1000, Math.min(30 * 1000, Math.floor(leaseMs / 2)));
  const value = input === undefined || input === null ? fallback : Number(input);
  if (!Number.isFinite(value) || value < 250 || value > 5 * 60 * 1000) return fallback;
  return Math.floor(value);
}

function createLeaseBoundJobs(queue, lease) {
  return new Proxy(queue, {
    get(target, property) {
      if (property === "update") return (job, patch) => target.updateWithLease(job, patch, lease);
      if (property === "heartbeat") return (job, options) => target.heartbeatWithLease(job, lease, options);
      if (property === "complete") return (job, patch) => target.completeWithLease(job, patch, lease);
      if (property === "fail") return (job, error) => target.failWithLease(job, error, lease);
      if (property === "retry") return (job, error, options) => target.retryWithLease(job, error, lease, options);
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createHeartbeatLoop({
  clearHeartbeatInterval,
  intervalMs,
  job,
  lease,
  leaseMs,
  leasedJobs,
  logger,
  nowMs,
  projectId,
  requestId,
  setHeartbeatInterval,
  workerId,
}) {
  if (!intervalMs) {
    return { active: false, stop() {} };
  }
  let stopped = false;
  let timer = null;
  let timerCleared = false;
  let inFlight = false;

  function clearTimer() {
    if (timerCleared) return;
    timerCleared = true;
    if (timer) clearHeartbeatInterval(timer);
  }

  async function beat() {
    if (stopped || inFlight || terminalStatus(job.status)) return;
    inFlight = true;
    try {
      leasedJobs.heartbeat(job, { leaseMs, nowMs: nowMs() });
      logInfo(logger, {
        event: "worker_heartbeat",
        requestId,
        jobId: job.id,
        projectId,
        workerId,
        leaseId: lease.leaseId,
        attempt: job.attempts,
        leaseExpiresAt: job.leaseExpiresAt,
      });
    } catch (error) {
      stopped = true;
      clearTimer();
      if (job && job._controller && !job._controller.signal.aborted) job._controller.abort();
      logInfo(logger, {
        event: "worker_heartbeat_failed",
        requestId,
        jobId: job.id,
        projectId,
        workerId,
        leaseId: lease.leaseId,
        code: error.code || "JOB_LEASE_INVALID",
      });
    } finally {
      inFlight = false;
    }
  }
  timer = setHeartbeatInterval(() => {
    return beat().catch((error) => {
      stopped = true;
      clearTimer();
      if (job && job._controller && !job._controller.signal.aborted) job._controller.abort();
      logInfo(logger, {
        event: "worker_heartbeat_failed",
        requestId,
        jobId: job.id,
        projectId,
        workerId,
        leaseId: lease.leaseId,
        code: error.code || "UNEXPECTED",
      });
    });
  }, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  logInfo(logger, {
    event: "worker_heartbeat_started",
    requestId,
    jobId: job.id,
    projectId,
    workerId,
    leaseId: lease.leaseId,
    intervalMs,
  });
  return {
    active: true,
    stop() {
      if (stopped && timerCleared) return;
      stopped = true;
      clearTimer();
      logInfo(logger, {
        event: "worker_heartbeat_stopped",
        requestId,
        jobId: job.id,
        projectId,
        workerId,
        leaseId: lease.leaseId,
      });
    },
  };
}

function restoreExportsFromCompletedJobs({ jobs, exportsById, exportRepository, artifactStore = new LocalArtifactAdapter(), logger = console } = {}) {
  let restored = 0;
  for (const job of jobs.all()) {
    if (job.status !== "completed" || !job.exportId || !job.outputPath) continue;
    let outputPath;
    try {
      outputPath = assertStoragePath(job.outputPath, "renders");
    } catch {
      continue;
    }
    if (!outputExists(outputPath)) continue;
    const record = {
      id: job.exportId,
      projectId: job.projectId,
      jobId: job.id,
      outputPath,
      artifact: artifactStore.createRecord({
        id: job.exportId,
        type: "export",
        ownerProjectId: job.projectId,
        ownerJobId: job.id,
        storageKey: `${job.id}.mp4`,
        size: statSync(outputPath).size,
        status: "available",
        createdAt: job.updatedAt || new Date().toISOString(),
      }),
      fileName: `${job.projectId}-short.mp4`,
      createdAt: job.updatedAt || new Date().toISOString(),
    };
    if (exportRepository) {
      if (exportRepository.restore(record)) restored += 1;
    } else if (exportsById) {
      exportsById.set(job.exportId, record);
      restored += 1;
    }
  }
  if (restored > 0) {
    logInfo(logger, { event: "job_exports_recovered", records: restored });
  }
  return restored;
}

function getRecord(repository, records, id) {
  if (repository && typeof repository.get === "function") return repository.get(id);
  return records && typeof records.get === "function" ? records.get(id) : null;
}

function createLocalJobWorker({
  jobs,
  queue,
  projects,
  uploads,
  exportsById,
  projectRepository,
  uploadRepository,
  exportRepository,
  artifactStore,
  dependencies = {},
}) {
  const jobQueue = queue || createLocalJobQueue({ jobs, logger: dependencies.logger || null });
  const running = new Set();
  const logger = Object.prototype.hasOwnProperty.call(dependencies, "logger") ? dependencies.logger : console;
  const scheduler = dependencies.scheduler || setImmediate;
  const render = dependencies.runRenderJob || runRenderJob;
  const pipelineRegistry = dependencies.pipelineRegistry || createPipelineRegistry({
    clipHandler: render,
    narratedDraftHandler: dependencies.runNarratedDraftJob,
    narrationAlignHandler: dependencies.runNarrationAlignmentJob,
    narratedRenderHandler: dependencies.runNarratedRenderJob,
  });
  const renderDependencies = dependencies.renderDependencies || dependencies;
  const workerId = dependencies.workerId || createWorkerId();
  const nowMs = typeof dependencies.nowMs === "function" ? dependencies.nowMs : Date.now;
  const leaseMs = Number.isFinite(Number(jobQueue.store && jobQueue.store.leaseDurationMs)) ? Number(jobQueue.store.leaseDurationMs) : 5 * 60 * 1000;
  const heartbeatMs = heartbeatIntervalMs(dependencies.heartbeatIntervalMs, leaseMs);
  const setHeartbeatInterval = dependencies.setHeartbeatInterval || setInterval;
  const clearHeartbeatInterval = dependencies.clearHeartbeatInterval || clearInterval;

  function safeFail(leasedJobs, job, error, requestId) {
    if (!job || terminalStatus(job.status)) return;
    try {
      leasedJobs.fail(job, error);
    } catch (leaseError) {
      logInfo(logger, {
        event: "worker_lease_write_rejected",
        requestId,
        jobId: job.id,
        projectId: job.projectId,
        workerId,
        code: leaseError.code || "JOB_LEASE_INVALID",
      });
    }
  }

  async function process(job, { requestId = "worker", lease = null, retryHandler = null } = {}) {
    if (!job || running.has(job.id)) return job || null;
    let claim = lease ? { job, lease } : null;
    if (!claim) {
      try {
        claim = jobQueue.claim(job.id, { workerId, nowMs: nowMs(), leaseMs, requestId });
        job = claim.job;
      } catch (error) {
        logInfo(logger, {
          event: "worker_claim_skipped",
          requestId,
          jobId: job.id,
          projectId: job.projectId,
          workerId,
          code: error.code || "JOB_LEASE_INVALID",
        });
        return job;
      }
    }
    const leasedJobs = createLeaseBoundJobs(jobQueue, claim.lease);
    let heartbeat = { stop() {} };
    running.add(job.id);
    logInfo(logger, {
      event: "worker_started",
      requestId,
      jobId: job.id,
      projectId: job.projectId,
      workerId,
      leaseId: claim.lease.leaseId,
      attempt: claim.lease.attempt,
      leaseExpiresAt: claim.lease.leaseExpiresAt,
    });
    try {
      const project = getRecord(projectRepository, projects, job.projectId);
      if (!project) {
        leasedJobs.fail(job, new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404));
        logInfo(logger, { event: "worker_failed", requestId, jobId: job.id, projectId: job.projectId, workerId, leaseId: claim.lease.leaseId, code: "PROJECT_NOT_FOUND" });
        return job;
      }
      const pipeline = pipelineRegistry.resolve(job);
      const upload = pipeline.requiresUpload
        ? job.uploadId
          ? getRecord(uploadRepository, uploads, job.uploadId)
          : project.uploadId
            ? getRecord(uploadRepository, uploads, project.uploadId)
            : null
        : null;
      if (pipeline.requiresUpload && !upload) {
        leasedJobs.fail(job, new AppError("UPLOAD_NOT_FOUND", SAFE_MESSAGES.UPLOAD_NOT_FOUND, 404));
        logInfo(logger, { event: "worker_failed", requestId, jobId: job.id, projectId: job.projectId, workerId, leaseId: claim.lease.leaseId, code: "UPLOAD_NOT_FOUND" });
        return job;
      }
      heartbeat = createHeartbeatLoop({
        clearHeartbeatInterval,
        intervalMs: heartbeatMs,
        job,
        lease: claim.lease,
        leaseMs,
        leasedJobs,
        logger,
        nowMs,
        projectId: job.projectId,
        requestId,
        setHeartbeatInterval,
        workerId,
      });
      await pipeline.handler({
        jobs: leasedJobs,
        exportsById,
        exportRepository,
        job,
        project,
        upload,
        payload: pipeline.pipelineType === "clip" ? payloadForJob(job, project) : job.payload,
        pipeline,
        requestId,
        dependencies: { artifactStore, exportRepository, projectRepository, ...renderDependencies },
      });
      logInfo(logger, { event: "worker_finished", requestId, jobId: job.id, projectId: job.projectId, workerId, leaseId: claim.lease.leaseId, status: job.status });
      return job;
    } catch (error) {
      if (typeof retryHandler === "function") {
        const scheduled = retryHandler({
          error,
          job,
          lease: claim.lease,
          leasedJobs,
          requestId,
          workerId,
        });
        if (scheduled) {
          logInfo(logger, {
            event: "worker_retry_delegated",
            requestId,
            jobId: job.id,
            projectId: job.projectId,
            workerId,
            leaseId: claim.lease.leaseId,
            code: error.code || "UNEXPECTED",
          });
          return job;
        }
      }
      safeFail(leasedJobs, job, error, requestId);
      logInfo(logger, {
        event: "worker_failed",
        requestId,
        jobId: job.id,
        projectId: job.projectId,
        workerId,
        leaseId: claim.lease.leaseId,
        code: error.code || (job.error && job.error.code) || "UNEXPECTED",
      });
      return job;
    } finally {
      heartbeat.stop();
      running.delete(job.id);
    }
  }

  function enqueue(job, { requestId = "worker" } = {}) {
    if (!job || running.has(job.id)) return job || null;
    let claim;
    try {
      claim = jobQueue.claim(job.id, { workerId, nowMs: nowMs(), leaseMs, requestId });
      job = claim.job;
    } catch (error) {
      logInfo(logger, {
        event: "worker_claim_skipped",
        requestId,
        jobId: job.id,
        projectId: job.projectId,
        workerId,
        code: error.code || "JOB_LEASE_INVALID",
      });
      return job;
    }
    scheduler(() => {
      process(job, { requestId, lease: claim.lease }).catch((error) => {
        logInfo(logger, {
          event: "worker_failed",
          requestId,
          jobId: job.id,
          projectId: job.projectId,
          workerId,
          leaseId: claim.lease.leaseId,
          code: error.code || "UNEXPECTED",
        });
      });
    });
    return job;
  }

  function startQueued({ requestId = "startup_recovery" } = {}) {
    let started = 0;
    while (true) {
      const claim = jobQueue.claimNext({ workerId, nowMs: nowMs(), leaseMs, requestId });
      if (!claim) break;
      started += 1;
      scheduler(() => {
        process(claim.job, { requestId, lease: claim.lease }).catch((error) => {
          logInfo(logger, {
            event: "worker_failed",
            requestId,
            jobId: claim.job.id,
            projectId: claim.job.projectId,
            workerId,
            leaseId: claim.lease.leaseId,
            code: error.code || "UNEXPECTED",
          });
        });
      });
    }
    return started;
  }

  return {
    enqueue,
    process,
    running,
    startQueued,
    workerId,
    health: () => ({
      workerId,
      running: running.size,
      heartbeat: {
        enabled: heartbeatMs > 0,
        intervalMs: heartbeatMs,
        leaseDurationMs: leaseMs,
      },
      queue: {
        backend: jobQueue.health().backend,
        queueBackend: jobQueue.health().queueBackend,
      },
    }),
  };
}

module.exports = {
  createLocalJobWorker,
  restoreExportsFromCompletedJobs,
};
