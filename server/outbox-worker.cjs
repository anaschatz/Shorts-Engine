const { randomUUID } = require("node:crypto");
const { CONFIG } = require("./config.cjs");
const { redactForLogs } = require("./errors.cjs");
const {
  DEFAULT_STALE_LOCK_MS,
  validateOutboxWorkerId,
} = require("./repositories/approval-outbox-repository.cjs");
const {
  createNoopOutboxHandler,
  normalizeOutboxHandlerResult,
  validateOutboxHandler,
} = require("./outbox-handlers.cjs");

function clampInteger(value, fallback, min, max) {
  const raw = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(Math.floor(raw), max));
}

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function safeErrorCode(error, fallback = "OUTBOX_HANDLER_FAILED") {
  const code = String(error && error.code ? error.code : fallback).trim().toUpperCase();
  if (!/^[A-Z0-9_:-]{2,80}$/.test(code)) return fallback;
  return code;
}

function logInfo(logger, payload) {
  if (!logger || typeof logger.info !== "function") return;
  logger.info(JSON.stringify(redactForLogs({ level: "info", ...payload })));
}

function logWarn(logger, payload) {
  if (!logger || typeof logger.warn !== "function") return;
  logger.warn(JSON.stringify(redactForLogs({ level: "warn", ...payload })));
}

function outboxBackoffMs(attempt, options = {}) {
  const initialDelayMs = clampInteger(options.initialDelayMs, 1000, 0, 10 * 60 * 1000);
  const maxDelayMs = clampInteger(options.maxDelayMs, 60 * 1000, 0, 60 * 60 * 1000);
  const exponent = Math.max(0, Number(attempt || 1) - 1);
  return Math.min(initialDelayMs * (2 ** exponent), maxDelayMs);
}

class OutboxWorker {
  constructor(options = {}) {
    this.repository = options.repository || null;
    this.handler = validateOutboxHandler(options.handler || createNoopOutboxHandler());
    this.logger = options.logger || null;
    this.workerId = validateOutboxWorkerId(options.workerId || `obw_${randomUUID()}`);
    this.batchSize = clampInteger(options.batchSize, 10, 1, 100);
    this.pollIntervalMs = clampInteger(options.pollIntervalMs, 0, 0, 60 * 1000);
    this.staleLockMs = clampInteger(options.staleLockMs, DEFAULT_STALE_LOCK_MS, 1000, 60 * 60 * 1000);
    this.retryInitialDelayMs = clampInteger(options.retryInitialDelayMs, 1000, 0, 10 * 60 * 1000);
    this.retryMaxDelayMs = clampInteger(options.retryMaxDelayMs, 60 * 1000, 0, 60 * 60 * 1000);
    this.externalDeliveryEnabled = Boolean(options.externalDeliveryEnabled);
    this.setIntervalFn = options.setIntervalFn || setInterval;
    this.clearIntervalFn = options.clearIntervalFn || clearInterval;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastResult = null;
  }

  configured() {
    return Boolean(
      this.repository &&
      typeof this.repository.claimDue === "function" &&
      typeof this.repository.markDelivered === "function" &&
      typeof this.repository.markFailed === "function" &&
      typeof this.repository.markDeadLetter === "function" &&
      typeof this.repository.recoverStaleLocks === "function",
    );
  }

  safeSummary(summary = {}) {
    return {
      runId: summary.runId || null,
      startedAt: summary.startedAt || null,
      finishedAt: summary.finishedAt || null,
      claimed: Number(summary.claimed || 0),
      delivered: Number(summary.delivered || 0),
      retried: Number(summary.retried || 0),
      deadLettered: Number(summary.deadLettered || 0),
      skipped: Number(summary.skipped || 0),
      failed: Number(summary.failed || 0),
      staleRecovered: Number(summary.staleRecovered || 0),
      cancelled: Boolean(summary.cancelled),
      errors: Number(summary.errors || 0),
    };
  }

  nextRetryAt(event, nowMs) {
    return nowIso(nowMs + outboxBackoffMs(event.attempts, {
      initialDelayMs: this.retryInitialDelayMs,
      maxDelayMs: this.retryMaxDelayMs,
    }));
  }

  async processEvent(event, summary, options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    try {
      const result = normalizeOutboxHandlerResult(await this.handler.handle(event, {
        workerId: this.workerId,
        requestId: options.requestId || null,
      }));
      if (result.status === "delivered") {
        this.repository.markDelivered(event.id, { workerId: this.workerId, updatedAt: nowIso(nowMs) });
        summary.delivered += 1;
        return;
      }
      if (result.status === "skipped") {
        this.repository.markDelivered(event.id, { workerId: this.workerId, updatedAt: nowIso(nowMs) });
        summary.skipped += 1;
        return;
      }
      if (result.status === "dead_letter") {
        this.repository.markDeadLetter(event.id, {
          workerId: this.workerId,
          errorCode: result.errorCode || "OUTBOX_HANDLER_DEAD_LETTER",
          updatedAt: nowIso(nowMs),
        });
        summary.deadLettered += 1;
        return;
      }
      const updated = this.repository.markFailed(event.id, {
        workerId: this.workerId,
        errorCode: result.errorCode || "OUTBOX_HANDLER_RETRY",
        nextAttemptAt: this.nextRetryAt(event, nowMs),
        updatedAt: nowIso(nowMs),
      });
      if (updated && updated.status === "dead_letter") summary.deadLettered += 1;
      else summary.retried += 1;
    } catch (error) {
      const code = safeErrorCode(error);
      try {
        const updated = this.repository.markFailed(event.id, {
          workerId: this.workerId,
          errorCode: code,
          nextAttemptAt: this.nextRetryAt(event, nowMs),
          updatedAt: nowIso(nowMs),
        });
        if (updated && updated.status === "dead_letter") summary.deadLettered += 1;
        else summary.retried += 1;
      } catch {
        summary.failed += 1;
      }
      summary.errors += 1;
      logWarn(this.logger, {
        event: "outbox_event_failed",
        workerId: this.workerId,
        eventId: event.id,
        eventType: event.eventType,
        approvalId: event.approvalId,
        jobId: event.payload && event.payload.newRenderJobId,
        projectId: event.payload && event.payload.projectId,
        attempt: event.attempts,
        code,
      });
    }
  }

  async runOnce(options = {}) {
    const runId = `outbox_run_${randomUUID()}`;
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const summary = {
      runId,
      startedAt: nowIso(nowMs),
      finishedAt: null,
      claimed: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      skipped: 0,
      failed: 0,
      staleRecovered: 0,
      cancelled: false,
      errors: 0,
    };

    if (!this.configured()) {
      summary.errors = 1;
      summary.finishedAt = nowIso(nowMs);
      this.lastRunAt = summary.finishedAt;
      this.lastResult = this.safeSummary(summary);
      logWarn(this.logger, { event: "outbox_worker_unconfigured", workerId: this.workerId });
      return summary;
    }

    const stale = this.repository.recoverStaleLocks({ nowMs, staleLockMs: this.staleLockMs });
    summary.staleRecovered = stale.length;
    const claimed = this.repository.claimDue({
      workerId: this.workerId,
      limit: options.limit || this.batchSize,
      nowMs,
    });
    summary.claimed = claimed.length;

    for (const event of claimed) {
      if (options.signal && options.signal.aborted) {
        summary.cancelled = true;
        this.repository.markFailed(event.id, {
          workerId: this.workerId,
          errorCode: "OUTBOX_WORKER_CANCELLED",
          nextAttemptAt: nowIso(nowMs),
          updatedAt: nowIso(nowMs),
        });
        summary.retried += 1;
        break;
      }
      await this.processEvent(event, summary, {
        nowMs,
        requestId: options.requestId || null,
      });
    }

    summary.finishedAt = nowIso(Date.now());
    this.lastRunAt = summary.finishedAt;
    this.lastResult = this.safeSummary(summary);
    logInfo(this.logger, {
      event: "outbox_worker_run_completed",
      workerId: this.workerId,
      runId,
      claimed: summary.claimed,
      delivered: summary.delivered,
      retried: summary.retried,
      deadLettered: summary.deadLettered,
      staleRecovered: summary.staleRecovered,
      errors: summary.errors,
    });
    return summary;
  }

  start(options = {}) {
    if (this.timer || !this.configured()) return false;
    const intervalMs = clampInteger(options.pollIntervalMs, this.pollIntervalMs, 0, 60 * 1000);
    if (intervalMs <= 0) return false;
    this.pollIntervalMs = intervalMs;
    this.timer = this.setIntervalFn(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce({ requestId: options.requestId || "outbox_poll" })
        .catch((error) => {
          this.lastResult = this.safeSummary({ ...this.lastResult, errors: 1, finishedAt: nowIso() });
          logWarn(this.logger, {
            event: "outbox_worker_run_failed",
            workerId: this.workerId,
            code: safeErrorCode(error, "OUTBOX_WORKER_FAILED"),
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
    const repositoryHealth = this.repository && typeof this.repository.health === "function" ? this.repository.health() : null;
    const statuses = repositoryHealth && repositoryHealth.statuses ? repositoryHealth.statuses : {};
    return {
      ready: this.configured(),
      configured: this.configured(),
      running: Boolean(this.timer),
      workerId: this.workerId,
      handler: this.handler.name || "custom",
      externalDeliveryEnabled: this.externalDeliveryEnabled,
      batchSize: this.batchSize,
      pollIntervalMs: this.pollIntervalMs,
      staleLockMs: this.staleLockMs,
      pending: Number(statuses.pending || 0),
      processing: Number(statuses.processing || 0),
      failed: Number(statuses.failed || 0),
      deadLetter: Number(statuses.dead_letter || 0),
      oldestPendingAgeMs: Number(repositoryHealth && repositoryHealth.oldestPendingAgeMs || 0),
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
    };
  }
}

function createOutboxWorker(options = {}) {
  return new OutboxWorker(options);
}

module.exports = {
  OutboxWorker,
  createOutboxWorker,
  outboxBackoffMs,
};
