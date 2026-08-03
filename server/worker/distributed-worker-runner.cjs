const { AppError, SAFE_MESSAGES } = require("../errors.cjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

function cancellationError() {
  return new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
}

class DistributedWorkerRunner {
  constructor(options = {}) {
    if (!options.queue || typeof options.queue.claimNext !== "function") {
      throw new AppError(
        "ADAPTER_CONTRACT_INVALID",
        SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
        500,
      );
    }
    this.queue = options.queue;
    this.handlers = options.handlers || {};
    this.workerId = String(options.workerId || "");
    if (!this.workerId) {
      throw new AppError(
        "CONFIGURATION_INVALID",
        SAFE_MESSAGES.CONFIGURATION_INVALID,
        500,
      );
    }
    this.heartbeatMs = Math.max(1000, Number(options.heartbeatMs || 20_000));
    this.leaseMs = Math.max(10_000, Number(options.leaseMs || 60_000));
    this.pollMs = Math.max(100, Number(options.pollMs || 1000));
    this.clock = options.clock || { now: () => Date.now() };
    this.observability = options.observability || null;
    this.processingTimeouts = Object.freeze(
      Object.fromEntries(
        Object.entries(options.processingTimeouts || {}).map(([action, value]) => [
          String(action),
          Math.max(10, Number(value || 30_000)),
        ]),
      ),
    );
    this.running = false;
    this.acceptingClaims = false;
    this.inFlight = new Set();
    this.loopPromise = null;
  }

  handlerFor(job) {
    const handler = this.handlers[job.action] || this.handlers[job.pipelineType];
    if (typeof handler !== "function") {
      throw new AppError(
        "ADAPTER_CONTRACT_INVALID",
        SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
        500,
      );
    }
    return handler;
  }

  async processClaim(claim) {
    const { job, lease } = claim;
    const processingStartedAt = this.clock.now();
    let metricOutcome = "failed";
    const controller = new AbortController();
    let heartbeatTimer = null;
    let processingTimer = null;
    let heartbeatInFlight = false;
    let leaseLost = false;
    let timedOut = false;
    let completedByHandler = null;
    const processingTimeoutMs = this.processingTimeouts[job.action] || null;
    if (processingTimeoutMs) {
      processingTimer = setTimeout(() => {
        timedOut = true;
        const timeout = new AppError(
          "JOB_TIMEOUT",
          SAFE_MESSAGES.JOB_TIMEOUT || SAFE_MESSAGES.RENDER_FAILED,
          504,
        );
        timeout.retryable = true;
        controller.abort(timeout);
      }, processingTimeoutMs);
    }
    const heartbeat = async () => {
      if (heartbeatInFlight || controller.signal.aborted) return;
      heartbeatInFlight = true;
      try {
        const current = await this.queue.heartbeat(job, lease, {
          leaseMs: this.leaseMs,
        });
        if (current.cancelRequestedAt) controller.abort(cancellationError());
      } catch {
        leaseLost = true;
        controller.abort(new AppError(
          "JOB_LEASE_INVALID",
          SAFE_MESSAGES.JOB_LEASE_INVALID,
          409,
        ));
      } finally {
        heartbeatInFlight = false;
      }
    };
    heartbeatTimer = setInterval(() => {
      heartbeat().catch(() => {});
    }, this.heartbeatMs);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

    try {
      const handler = this.handlerFor(job);
      const queue = this.queue;
      const result = await handler(job, {
        signal: controller.signal,
        heartbeat,
        async update(patch) {
          return await queue.update(job, patch, lease);
        },
        async completeAtomically(completionResult, mutation) {
          if (completedByHandler) {
            throw new AppError(
              "JOB_STATE_INVALID",
              SAFE_MESSAGES.JOB_STATE_INVALID,
              409,
            );
          }
          completedByHandler = await queue.completeAtomically(
            job,
            { result: completionResult || {} },
            lease,
            mutation,
          );
          return completedByHandler;
        },
      });
      if (leaseLost) {
        metricOutcome = "lease_lost";
        return { status: "lease_lost", jobId: job.id };
      }
      if (completedByHandler) {
        metricOutcome = completedByHandler.status === "cancelled"
          ? "cancelled"
          : "completed";
        return {
          status: metricOutcome,
          jobId: job.id,
        };
      }
      if (controller.signal.aborted) {
        await this.queue.acknowledgeCancellation(job, lease);
        metricOutcome = "cancelled";
        return { status: "cancelled", jobId: job.id };
      }
      const completed = await this.queue.complete(
        job,
        { result: result || {} },
        lease,
      );
      metricOutcome = completed.status === "cancelled" ? "cancelled" : "completed";
      return {
        status: metricOutcome,
        jobId: job.id,
      };
    } catch (error) {
      if (leaseLost || error && error.code === "JOB_LEASE_INVALID") {
        metricOutcome = "lease_lost";
        return { status: "lease_lost", jobId: job.id };
      }
      if (timedOut) {
        const timeout = new AppError(
          "JOB_TIMEOUT",
          SAFE_MESSAGES.JOB_TIMEOUT || SAFE_MESSAGES.RENDER_FAILED,
          504,
        );
        timeout.retryable = true;
        const retried = await this.queue.retry(job, timeout, lease);
        metricOutcome = retried.status === "failed" ? "dead_letter" : "retry_scheduled";
        return {
          status: metricOutcome,
          jobId: job.id,
        };
      }
      if (
        controller.signal.aborted
        || error && error.code === "JOB_CANCELLED"
      ) {
        await this.queue.acknowledgeCancellation(job, lease);
        metricOutcome = "cancelled";
        return { status: "cancelled", jobId: job.id };
      }
      if (error && error.retryable === false) {
        const failed = await this.queue.fail(job, error, lease);
        metricOutcome = failed.status === "cancelled" ? "cancelled" : "failed";
        return {
          status: metricOutcome,
          jobId: job.id,
        };
      }
      const retried = await this.queue.retry(job, error, lease);
      metricOutcome = retried.status === "cancelled"
        ? "cancelled"
        : retried.status === "failed"
          ? "dead_letter"
          : "retry_scheduled";
      return {
        status: metricOutcome,
        jobId: job.id,
      };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (processingTimer) clearTimeout(processingTimer);
      await this.recordProcessingMetrics(
        job,
        metricOutcome,
        processingStartedAt,
      ).catch(() => {});
    }
  }

  async recordProcessingMetrics(job, outcome, startedAt) {
    if (!this.observability) return;
    const labels = {
      pipeline: String(job.action || job.pipelineType || "unknown").toLowerCase(),
      outcome,
    };
    this.observability.observe(
      "processing_time_ms",
      Math.max(0, this.clock.now() - startedAt),
      labels,
    );
    if (outcome === "completed") {
      this.observability.increment("render_success_total", labels);
    } else if (outcome === "retry_scheduled") {
      this.observability.increment("retry_total", labels);
    } else if (outcome === "dead_letter") {
      this.observability.increment("dead_letter_total", labels);
      this.observability.increment("render_failure_total", labels);
    } else if (outcome === "failed" || outcome === "lease_lost") {
      this.observability.increment("render_failure_total", labels);
    }
    if (
      ["completed", "failed", "dead_letter"].includes(outcome)
      && typeof this.observability.jobCost === "function"
    ) {
      const cost = await this.observability.jobCost({ jobId: job.id });
      if (
        cost
        && Number(cost.totalEvents) > 0
        && cost.totalUsd !== null
        && Number.isFinite(Number(cost.totalUsd))
      ) {
        this.observability.observe(
          outcome === "completed"
            ? "completed_video_cost_usd"
            : "failed_video_cost_usd",
          Number(cost.totalUsd),
          labels,
        );
      }
    }
  }

  async runOnce() {
    if (!this.acceptingClaims && this.running) return { claimed: false };
    const claim = await this.queue.claimNext({
      workerId: this.workerId,
      leaseMs: this.leaseMs,
    });
    if (!claim) return { claimed: false };
    const createdAtMs = Date.parse(claim.job.createdAt || "");
    if (this.observability && Number.isFinite(createdAtMs)) {
      this.observability.observe(
        "queue_wait_ms",
        Math.max(0, this.clock.now() - createdAtMs),
        {
          pipeline: String(
            claim.job.action || claim.job.pipelineType || "unknown",
          ).toLowerCase(),
        },
      );
    }
    const work = this.processClaim(claim);
    this.inFlight.add(work);
    try {
      return { claimed: true, ...(await work) };
    } finally {
      this.inFlight.delete(work);
    }
  }

  async loop() {
    while (this.acceptingClaims) {
      const result = await this.runOnce();
      if (!result.claimed && this.acceptingClaims) await delay(this.pollMs);
    }
  }

  async start() {
    if (this.running) return false;
    if (!Object.values(this.handlers).some((handler) => typeof handler === "function")) {
      throw new AppError(
        "CONFIGURATION_INVALID",
        SAFE_MESSAGES.CONFIGURATION_INVALID,
        500,
      );
    }
    this.running = true;
    this.acceptingClaims = true;
    this.loopPromise = this.loop().finally(() => {
      this.running = false;
    });
    return true;
  }

  async stop(options = {}) {
    if (!this.running && !this.inFlight.size) return false;
    this.acceptingClaims = false;
    const drainMs = Math.max(0, Number(options.drainMs ?? 30_000));
    const draining = Promise.allSettled([
      ...(this.loopPromise ? [this.loopPromise] : []),
      ...this.inFlight,
    ]);
    if (drainMs === 0) return true;
    await settleWithin(draining, drainMs);
    return true;
  }

  health() {
    return {
      ready: this.running,
      running: this.running,
      acceptingClaims: this.acceptingClaims,
      inFlight: this.inFlight.size,
      workerIdConfigured: Boolean(this.workerId),
      gracefulShutdown: true,
    };
  }
}

module.exports = {
  DistributedWorkerRunner,
  cancellationError,
};
