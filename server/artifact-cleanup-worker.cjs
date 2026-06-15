const { randomUUID } = require("node:crypto");
const { CONFIG } = require("./config.cjs");
const { ACTIVE_JOB_STATUSES } = require("./jobs.cjs");
const { redactForLogs } = require("./errors.cjs");
const { TEMP_ARTIFACT_TYPES } = require("./storage/artifact-store.cjs");

function nowIso() {
  return new Date().toISOString();
}

function clampPositiveInteger(value, fallback, min = 1, max = 1000) {
  const raw = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(Math.floor(raw), max));
}

function safeActiveJobIds(jobs) {
  try {
    const activeJobs = jobs && typeof jobs.byStatus === "function"
      ? jobs.byStatus(ACTIVE_JOB_STATUSES)
      : jobs && typeof jobs.all === "function"
        ? jobs.all().filter((job) => ACTIVE_JOB_STATUSES.includes(job.status))
        : [];
    return new Set(activeJobs.map((job) => job.id).filter(Boolean));
  } catch {
    return new Set();
  }
}

function safeCleanupResult(result = {}) {
  return {
    dryRun: Boolean(result.dryRun),
    scanned: Number(result.scanned || 0),
    eligible: Number(result.eligible || 0),
    deleted: Number(result.deleted || 0),
    skipped: Number(result.skipped || 0),
    errors: Number(result.errors || 0),
    activeJobs: Number(result.activeJobs || 0),
    maxArtifacts: Number(result.maxArtifacts || 0),
    maxAgeSeconds: Number(result.maxAgeSeconds || 0),
    allowedTypes: Array.isArray(result.allowedTypes) ? result.allowedTypes.slice(0, 10) : [],
  };
}

function logInfo(logger, payload) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(JSON.stringify(redactForLogs({ level: "info", ...payload })));
}

function logWarn(logger, payload) {
  if (!logger || typeof logger.warn !== "function") return;
  logger.warn(JSON.stringify(redactForLogs({ level: "warn", ...payload })));
}

class ArtifactCleanupWorker {
  constructor(options = {}) {
    this.artifactRepository = options.artifactRepository || null;
    this.artifactStore = options.artifactStore || null;
    this.jobs = options.jobs || null;
    this.logger = options.logger || null;
    this.workerId = options.workerId || `cleanup_${randomUUID()}`;
    this.intervalMs = clampPositiveInteger(
      options.intervalMs,
      CONFIG.artifactCleanupIntervalMs,
      0,
      24 * 60 * 60 * 1000,
    );
    this.defaultDryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : true;
    this.maxAgeSeconds = clampPositiveInteger(
      options.maxAgeSeconds,
      CONFIG.storage.lifecycleCleanupMaxAgeSeconds,
      60,
      365 * 24 * 60 * 60,
    );
    this.maxArtifacts = clampPositiveInteger(
      options.maxArtifacts,
      CONFIG.storage.lifecycleCleanupMaxPerRun,
      1,
      1000,
    );
    this.allowedTypes = Object.freeze(TEMP_ARTIFACT_TYPES.slice());
    this.setIntervalFn = options.setIntervalFn || setInterval;
    this.clearIntervalFn = options.clearIntervalFn || clearInterval;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastResult = null;
  }

  configured() {
    return Boolean(
      this.artifactRepository &&
      this.artifactStore &&
      typeof this.artifactRepository.listCleanupCandidates === "function" &&
      typeof this.artifactStore.cleanupArtifactsByPolicy === "function",
    );
  }

  cleanupPolicy(options = {}) {
    return {
      allowedTypes: this.allowedTypes,
      dryRun: options.dryRun !== undefined ? Boolean(options.dryRun) : this.defaultDryRun,
      maxAgeSeconds: clampPositiveInteger(options.maxAgeSeconds, this.maxAgeSeconds, 60, 365 * 24 * 60 * 60),
      maxArtifacts: clampPositiveInteger(options.maxArtifacts, this.maxArtifacts, 1, 1000),
      nowMs: Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now(),
    };
  }

  async cleanupArtifact(candidate, policy) {
    const result = this.artifactStore.cleanupArtifactsByPolicy([candidate], policy);
    if (!policy.dryRun && result.deleted > 0 && this.artifactRepository.markDeleted) {
      try {
        this.artifactRepository.markDeleted(candidate.id);
      } catch {
        result.errors += 1;
      }
    }
    return result;
  }

  async runOnce(options = {}) {
    const runId = `cleanup_run_${randomUUID()}`;
    const startedAt = nowIso();
    const policy = this.cleanupPolicy(options);
    const activeJobIds = safeActiveJobIds(this.jobs);
    const summary = {
      runId,
      dryRun: policy.dryRun,
      startedAt,
      finishedAt: null,
      scanned: 0,
      eligible: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
      activeJobs: activeJobIds.size,
      maxArtifacts: policy.maxArtifacts,
      maxAgeSeconds: policy.maxAgeSeconds,
      allowedTypes: policy.allowedTypes,
    };

    if (!this.configured()) {
      summary.errors = 1;
      summary.finishedAt = nowIso();
      this.lastRunAt = summary.finishedAt;
      this.lastResult = safeCleanupResult(summary);
      logWarn(this.logger, { event: "artifact_cleanup_unconfigured", runId });
      return summary;
    }

    const candidates = this.artifactRepository.listCleanupCandidates({
      activeJobIds: [...activeJobIds],
      allowedTypes: policy.allowedTypes,
      limit: policy.maxArtifacts,
      maxAgeSeconds: policy.maxAgeSeconds,
      nowMs: policy.nowMs,
    });

    for (const candidate of candidates) {
      const result = await this.cleanupArtifact(candidate, {
        allowedTypes: policy.allowedTypes,
        dryRun: policy.dryRun,
        maxAgeSeconds: policy.maxAgeSeconds,
        maxArtifacts: 1,
        nowMs: policy.nowMs,
      });
      summary.scanned += result.scanned || 0;
      summary.eligible += result.eligible || 0;
      summary.deleted += result.deleted || 0;
      summary.skipped += result.skipped || 0;
      summary.errors += result.errors || 0;
    }

    if (typeof this.artifactStore.pruneSignedTokens === "function") {
      this.artifactStore.pruneSignedTokens(policy.nowMs);
    }

    summary.finishedAt = nowIso();
    this.lastRunAt = summary.finishedAt;
    this.lastResult = safeCleanupResult(summary);
    logInfo(this.logger, {
      event: "artifact_cleanup_completed",
      runId,
      deleted: summary.deleted,
      skipped: summary.skipped,
      errors: summary.errors,
      dryRun: summary.dryRun,
    });
    return summary;
  }

  start(options = {}) {
    if (this.timer || !this.configured()) return false;
    const intervalMs = clampPositiveInteger(options.intervalMs, this.intervalMs, 0, 24 * 60 * 60 * 1000);
    if (intervalMs <= 0) return false;
    this.intervalMs = intervalMs;
    this.timer = this.setIntervalFn(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce(options)
        .catch((error) => {
          this.lastResult = safeCleanupResult({ ...this.lastResult, errors: 1 });
          logWarn(this.logger, {
            event: "artifact_cleanup_failed",
            code: error && error.code ? error.code : "UNEXPECTED",
          });
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
    return true;
  }

  stop() {
    if (!this.timer) return false;
    this.clearIntervalFn(this.timer);
    this.timer = null;
    this.running = false;
    return true;
  }

  health() {
    return {
      ready: this.configured(),
      configured: this.configured(),
      running: Boolean(this.timer),
      workerId: this.workerId,
      intervalMs: this.intervalMs,
      defaultDryRun: this.defaultDryRun,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      policy: {
        allowedTypes: this.allowedTypes,
        maxAgeSeconds: this.maxAgeSeconds,
        maxArtifacts: this.maxArtifacts,
      },
    };
  }
}

function createArtifactCleanupWorker(options = {}) {
  return new ArtifactCleanupWorker(options);
}

module.exports = {
  ArtifactCleanupWorker,
  createArtifactCleanupWorker,
  safeCleanupResult,
};
