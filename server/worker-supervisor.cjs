const { CONFIG } = require("./config.cjs");
const { ACTIVE_JOB_STATUSES, TERMINAL_JOB_STATUSES } = require("./jobs.cjs");
const { redactForLogs } = require("./errors.cjs");
const { createLocalJobQueue } = require("./queue/local-job-queue.cjs");
const { validateQueueContract } = require("./queue/queue-contracts.cjs");

const SUPERVISOR_STATES = Object.freeze(["stopped", "starting", "running", "draining", "stopping"]);
const DEFAULT_RETRYABLE_CODES = Object.freeze([
  "TRANSCRIPTION_FAILED",
  "TRANSCRIPTION_TIMEOUT",
  "CLOUD_STORAGE_FAILED",
  "DB_TRANSACTION_FAILED",
  "PROJECT_STATE_LOCKED",
]);

function logInfo(logger, payload) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(JSON.stringify(redactForLogs({ level: "info", ...payload })));
}

function logWarn(logger, payload) {
  if (!logger || typeof logger.warn !== "function") return;
  logger.warn(JSON.stringify(redactForLogs({ level: "warn", ...payload })));
}

function validateDurationMs(value, { name, fallback, min = 0, max = 60 * 60 * 1000 } = {}) {
  const raw = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(`Invalid ${name || "duration"} configuration.`);
  }
  return raw;
}

function normalizeRetryPolicy(policy = {}, jobs = null) {
  const maxAttempts = validateDurationMs(policy.maxAttempts, {
    name: "worker retry max attempts",
    fallback: CONFIG.workerRetryMaxAttempts,
    min: 1,
    max: 10,
  });
  const storeMaxAttempts = Number.isInteger(jobs && jobs.maxAttempts) ? jobs.maxAttempts : maxAttempts;
  const initialDelayMs = validateDurationMs(policy.initialDelayMs, {
    name: "worker retry initial delay",
    fallback: CONFIG.workerRetryInitialDelayMs,
    min: 0,
    max: 10 * 60 * 1000,
  });
  const maxDelayMs = validateDurationMs(policy.maxDelayMs, {
    name: "worker retry max delay",
    fallback: CONFIG.workerRetryMaxDelayMs,
    min: 0,
    max: 60 * 60 * 1000,
  });
  if (initialDelayMs > maxDelayMs) {
    throw new Error("Invalid worker retry delay configuration.");
  }
  const retryableCodes = Array.isArray(policy.retryableCodes)
    ? policy.retryableCodes.map((code) => String(code || "").trim()).filter(Boolean)
    : [...DEFAULT_RETRYABLE_CODES];
  return {
    enabled: policy.enabled !== false,
    initialDelayMs,
    maxDelayMs,
    maxAttempts: Math.min(maxAttempts, storeMaxAttempts),
    retryableCodes: new Set(retryableCodes),
  };
}

function terminalStatus(status) {
  return TERMINAL_JOB_STATUSES.includes(status);
}

function activeStatus(status) {
  return ACTIVE_JOB_STATUSES.includes(status);
}

function retryDue(job, nowMs) {
  const retryAtMs = Date.parse(job && job.nextRetryAt ? job.nextRetryAt : "");
  return !Number.isFinite(retryAtMs) || retryAtMs <= nowMs;
}

function retryScheduled(job, nowMs) {
  const retryAtMs = Date.parse(job && job.nextRetryAt ? job.nextRetryAt : "");
  return job && job.status === "queued" && Number.isFinite(retryAtMs) && retryAtMs > nowMs;
}

function createWorkerSupervisor({
  jobs,
  queue,
  worker,
  logger = console,
  options = {},
  dependencies = {},
} = {}) {
  const jobQueue = validateQueueContract(queue || createLocalJobQueue({ jobs }));
  if (!worker || typeof worker.process !== "function") {
    throw new Error("Worker supervisor requires a worker.");
  }

  const nowMs = typeof dependencies.nowMs === "function" ? dependencies.nowMs : Date.now;
  const scheduler = typeof dependencies.scheduler === "function" ? dependencies.scheduler : setImmediate;
  const waitMs = typeof dependencies.waitMs === "function"
    ? dependencies.waitMs
    : (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));
  const setPollInterval = dependencies.setPollInterval || setInterval;
  const clearPollInterval = dependencies.clearPollInterval || clearInterval;
  const setRetryTimeout = dependencies.setRetryTimeout || setTimeout;
  const clearRetryTimeout = dependencies.clearRetryTimeout || clearTimeout;

  const pollIntervalMs = validateDurationMs(options.pollIntervalMs, {
    name: "worker poll interval",
    fallback: CONFIG.workerPollIntervalMs,
    min: 0,
    max: 60 * 1000,
  });
  const shutdownTimeoutMs = validateDurationMs(options.shutdownTimeoutMs, {
    name: "worker shutdown timeout",
    fallback: CONFIG.workerShutdownTimeoutMs,
    min: 0,
    max: 10 * 60 * 1000,
  });
  const retryPolicy = normalizeRetryPolicy(options.retryPolicy, jobQueue.store);

  let state = "stopped";
  let pollTimer = null;
  const activeRuns = new Map();
  const scheduledJobIds = new Set();
  const retryTimers = new Map();

  function setState(nextState) {
    if (!SUPERVISOR_STATES.includes(nextState)) {
      throw new Error("Invalid worker supervisor state.");
    }
    state = nextState;
  }

  function acceptingJobs() {
    return state === "running";
  }

  function activeJobIds() {
    const ids = new Set(activeRuns.keys());
    if (worker.running && typeof worker.running[Symbol.iterator] === "function") {
      for (const jobId of worker.running) ids.add(jobId);
    }
    return [...ids];
  }

  function queueCounts() {
    const health = jobQueue.store && typeof jobQueue.store.health === "function" ? jobQueue.store.health(nowMs()) : null;
    const statuses = health && health.statuses ? health.statuses : {};
    return {
      queued: Number(statuses.queued || 0),
      processing: Number(statuses.processing || 0),
      failed: Number(statuses.failed || 0),
      retryScheduled: health && typeof health.retryScheduled === "number"
        ? health.retryScheduled
        : jobQueue.all().filter((job) => retryScheduled(job, nowMs())).length,
      activeLeases: Number(health && health.activeLeases || 0),
      expiredLeases: Number(health && health.expiredLeases || 0),
    };
  }

  function clearPollTimer() {
    if (!pollTimer) return;
    clearPollInterval(pollTimer);
    pollTimer = null;
  }

  function clearRetryTimer(jobId) {
    const timer = retryTimers.get(jobId);
    if (!timer) return;
    clearRetryTimeout(timer);
    retryTimers.delete(jobId);
  }

  function clearRetryTimers() {
    for (const jobId of [...retryTimers.keys()]) clearRetryTimer(jobId);
  }

  function startPollTimer(requestId) {
    clearPollTimer();
    if (!pollIntervalMs) return;
    pollTimer = setPollInterval(() => {
      if (!acceptingJobs()) return;
      startQueued({ requestId: requestId || "worker_poll" });
    }, pollIntervalMs);
    if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
  }

  function scheduleRetryTimer(job, delayMs, requestId) {
    if (!job || terminalStatus(job.status)) return false;
    clearRetryTimer(job.id);
    const safeDelayMs = Math.max(0, Math.min(Math.floor(Number(delayMs || 0)), retryPolicy.maxDelayMs));
    const timer = setRetryTimeout(() => {
      retryTimers.delete(job.id);
      if (!acceptingJobs()) return;
      startQueued({ requestId: requestId || "retry_timer" });
    }, safeDelayMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    retryTimers.set(job.id, timer);
    return true;
  }

  function scheduleFutureRetry(job, requestId) {
    const retryAtMs = Date.parse(job && job.nextRetryAt ? job.nextRetryAt : "");
    if (!Number.isFinite(retryAtMs) || retryAtMs <= nowMs()) return false;
    return scheduleRetryTimer(job, retryAtMs - nowMs(), requestId);
  }

  function backoffForAttempt(attempt) {
    const exponent = Math.max(0, Number(attempt || 1) - 1);
    const delay = retryPolicy.initialDelayMs * (2 ** exponent);
    return Math.min(delay, retryPolicy.maxDelayMs);
  }

  function retryHandler({ error, job, leasedJobs, requestId, workerId, lease }) {
    const code = error && error.code ? error.code : "UNEXPECTED";
    if (!retryPolicy.enabled || !retryPolicy.retryableCodes.has(code)) {
      logInfo(logger, {
        event: "job_retry_skipped",
        requestId,
        jobId: job && job.id,
        projectId: job && job.projectId,
        workerId,
        leaseId: lease && lease.leaseId,
        attempt: job && job.attempts,
        code,
        reason: "non_retryable",
      });
      return false;
    }
    if (!job || terminalStatus(job.status) || Number(job.attempts || 0) >= retryPolicy.maxAttempts) {
      logInfo(logger, {
        event: "job_retry_skipped",
        requestId,
        jobId: job && job.id,
        projectId: job && job.projectId,
        workerId,
        leaseId: lease && lease.leaseId,
        attempt: job && job.attempts,
        code,
        reason: "max_attempts_or_terminal",
      });
      return false;
    }
    const backoffMs = backoffForAttempt(job.attempts);
    const nextRetryAt = new Date(nowMs() + backoffMs).toISOString();
    try {
      leasedJobs.retry(job, error, { backoffMs, nextRetryAt, nowMs: nowMs() });
    } catch (retryError) {
      logWarn(logger, {
        event: "job_retry_skipped",
        requestId,
        jobId: job.id,
        projectId: job.projectId,
        workerId,
        leaseId: lease && lease.leaseId,
        attempt: job.attempts,
        code: retryError.code || "JOB_LEASE_INVALID",
        reason: "retry_write_rejected",
      });
      return false;
    }
    scheduleRetryTimer(job, backoffMs, requestId);
    logInfo(logger, {
      event: "job_retry_scheduled",
      requestId,
      jobId: job.id,
      projectId: job.projectId,
      workerId,
      leaseId: lease && lease.leaseId,
      attempt: job.attempts,
      code,
      backoffMs,
      nextRetryAt,
    });
    return true;
  }

  async function runJob(job, { requestId = "worker_supervisor" } = {}) {
    if (!job || activeRuns.has(job.id)) return job || null;
    activeRuns.set(job.id, Promise.resolve());
    try {
      return await worker.process(job, { requestId, retryHandler });
    } finally {
      activeRuns.delete(job.id);
    }
  }

  function scheduleJob(job, { requestId = "worker_supervisor" } = {}) {
    if (!job || !acceptingJobs() || terminalStatus(job.status)) return false;
    if (scheduledJobIds.has(job.id) || activeRuns.has(job.id)) return false;
    if (job.status === "queued" && !retryDue(job, nowMs())) {
      return scheduleFutureRetry(job, requestId);
    }
    scheduledJobIds.add(job.id);
    scheduler(() => {
      scheduledJobIds.delete(job.id);
      if (!acceptingJobs()) return;
      runJob(job, { requestId }).catch((error) => {
        logWarn(logger, {
          event: "worker_supervisor_job_failed",
          requestId,
          jobId: job.id,
          projectId: job.projectId,
          code: error.code || "UNEXPECTED",
        });
      });
    });
    return true;
  }

  function startQueued({ requestId = "worker_supervisor" } = {}) {
    if (!acceptingJobs()) return 0;
    try {
      jobQueue.releaseExpiredLeases({ requestId, nowMs: nowMs() });
    } catch (error) {
      logWarn(logger, {
        event: "queue_expired_lease_release_skipped",
        requestId,
        code: error.code || "JOB_STATE_INVALID",
      });
    }
    let started = 0;
    for (const job of jobQueue.all().filter((record) => record.status === "queued")) {
      if (!retryDue(job, nowMs())) {
        scheduleFutureRetry(job, requestId);
        continue;
      }
      if (scheduleJob(job, { requestId })) started += 1;
    }
    return started;
  }

  function enqueue(job, { requestId = "worker_supervisor" } = {}) {
    if (!job || terminalStatus(job.status)) return job || null;
    jobQueue.enqueue(job, { requestId });
    if (!acceptingJobs()) {
      logInfo(logger, {
        event: "supervisor_enqueue_skipped",
        requestId,
        jobId: job.id,
        projectId: job.projectId,
        status: job.status,
        state,
      });
      return job;
    }
    scheduleJob(job, { requestId });
    return job;
  }

  function start({ requestId = "worker_supervisor_start" } = {}) {
    if (state === "running") return health();
    if (state !== "stopped") {
      throw new Error("Invalid worker supervisor state transition.");
    }
    setState("starting");
    logInfo(logger, { event: "supervisor_starting", requestId });
    setState("running");
    startPollTimer(requestId);
    const queued = startQueued({ requestId });
    logInfo(logger, { event: "supervisor_started", requestId, queued, state });
    return { state, queued };
  }

  function drain({ requestId = "worker_supervisor_drain" } = {}) {
    if (state === "stopped") return health();
    if (state !== "draining") {
      setState("draining");
      clearPollTimer();
      clearRetryTimers();
      logInfo(logger, {
        event: "supervisor_draining",
        requestId,
        activeJobs: activeJobIds().length,
      });
    }
    return health();
  }

  async function waitForIdle({ timeoutMs = shutdownTimeoutMs } = {}) {
    const startedAt = nowMs();
    while (activeJobIds().length > 0) {
      if (timeoutMs <= 0 || nowMs() - startedAt >= timeoutMs) return false;
      await waitMs(Math.min(25, Math.max(1, timeoutMs - (nowMs() - startedAt))));
    }
    return true;
  }

  function abortActiveJobs(requestId) {
    for (const jobId of activeJobIds()) {
      const job = jobQueue.get(jobId);
      if (!job || !activeStatus(job.status)) continue;
      try {
        jobQueue.cancel(job.id, { requestId });
      } catch (error) {
        logWarn(logger, {
          event: "worker_abort_skipped",
          requestId,
          jobId: job.id,
          projectId: job.projectId,
          code: error.code || "CANCEL_NOT_SUPPORTED",
        });
      }
    }
  }

  async function stop({ requestId = "worker_supervisor_stop", timeoutMs = shutdownTimeoutMs } = {}) {
    if (state === "stopped") return health();
    setState("stopping");
    clearPollTimer();
    clearRetryTimers();
    logInfo(logger, {
      event: "supervisor_stopping",
      requestId,
      activeJobs: activeJobIds().length,
      timeoutMs,
    });
    const drained = await waitForIdle({ timeoutMs });
    if (drained) {
      logInfo(logger, { event: "worker_active_jobs_drained", requestId });
    } else {
      logWarn(logger, {
        event: "worker_shutdown_timeout",
        requestId,
        activeJobs: activeJobIds().length,
        timeoutMs,
      });
      abortActiveJobs(requestId);
      await waitMs(0);
      await waitForIdle({ timeoutMs: Math.min(250, Math.max(1, timeoutMs)) });
    }
    setState("stopped");
    logInfo(logger, { event: "supervisor_stopped", requestId, activeJobs: activeJobIds().length });
    return health();
  }

  function health() {
    const counts = queueCounts();
    const workerHealth = typeof worker.health === "function" ? worker.health() : {};
    const queueHealth = jobQueue.health(nowMs());
    return {
      ready: state === "running" || state === "draining",
      state,
      drainMode: state === "draining" || state === "stopping",
      queue: {
        backend: queueHealth.backend,
        queueBackend: queueHealth.queueBackend,
        activeWorkers: queueHealth.workers.active,
        activeLeases: queueHealth.leases.active,
        expiredLeases: queueHealth.leases.expired,
        retryScheduled: queueHealth.jobs.retryScheduled,
      },
      pollIntervalMs,
      retry: {
        enabled: retryPolicy.enabled,
        initialDelayMs: retryPolicy.initialDelayMs,
        maxDelayMs: retryPolicy.maxDelayMs,
        maxAttempts: retryPolicy.maxAttempts,
        scheduled: retryTimers.size,
      },
      worker: {
        workerId: workerHealth.workerId,
        running: Number(workerHealth.running || 0),
        heartbeat: workerHealth.heartbeat || { enabled: false },
      },
      activeJobs: activeJobIds().length,
      scheduledJobs: scheduledJobIds.size,
      queuedJobs: counts.queued,
      processingJobs: counts.processing,
      failedJobs: counts.failed,
      retryScheduled: counts.retryScheduled,
      activeLeases: counts.activeLeases,
      expiredLeases: counts.expiredLeases,
    };
  }

  return {
    enqueue,
    start,
    startQueued,
    drain,
    stop,
    waitForIdle,
    health,
  };
}

module.exports = {
  DEFAULT_RETRYABLE_CODES,
  SUPERVISOR_STATES,
  createWorkerSupervisor,
  normalizeRetryPolicy,
};
