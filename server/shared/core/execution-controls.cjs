const ACTIVE_STATUSES = new Set(["queued", "processing"]);
const RENDER_ACTIONS = new Set(["generate", "regeneration_render", "narrated_render"]);
const CONTROL_MESSAGES = Object.freeze({
  AUTH_REQUIRED: "Authentication is required for this operation.",
  RENDER_CONCURRENCY_EXCEEDED: "The render concurrency limit has been reached. Try again after an active render finishes.",
  RENDER_QUOTA_EXCEEDED: "The daily render quota has been reached.",
});

function positiveInteger(value, fallback, max = 100_000) {
  const number = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new Error("Invalid execution control configuration.");
  }
  return number;
}

function utcDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function defaultErrorFactory(code, status, details) {
  const error = new Error(CONTROL_MESSAGES[code] || "The render request was rejected.");
  error.name = "AppError";
  error.code = code;
  error.status = status;
  error.userMessage = error.message;
  error.details = details || null;
  return error;
}

function normalizedOwnerId(value, errorFactory) {
  const ownerId = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,79}$/.test(ownerId)) {
    throw errorFactory("AUTH_REQUIRED", 401);
  }
  return ownerId;
}

function createExecutionControls(options = {}) {
  const perUserDailyQuota = positiveInteger(options.perUserDailyQuota, 20);
  const perUserConcurrency = positiveInteger(options.perUserConcurrency, 2, 1000);
  const globalConcurrency = positiveInteger(options.globalConcurrency, 4, 10_000);
  const jobsProvider = typeof options.jobsProvider === "function" ? options.jobsProvider : () => [];
  const errorFactory = typeof options.errorFactory === "function" ? options.errorFactory : defaultErrorFactory;

  function relevantJobs() {
    const jobs = jobsProvider();
    return Array.isArray(jobs) ? jobs.filter((job) => job && RENDER_ACTIONS.has(job.action || "generate")) : [];
  }

  function assertCanEnqueue(input = {}) {
    const ownerId = normalizedOwnerId(input.ownerId, errorFactory);
    const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
    const existing = input.idempotencyKey
      ? relevantJobs().find((job) => job.idempotencyKey === input.idempotencyKey)
      : null;
    if (existing) return { allowed: true, replayed: true, existingJobId: existing.id };
    const jobs = relevantJobs();
    const active = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
    const activeForOwner = active.filter((job) => job.ownerId === ownerId);
    if (active.length >= globalConcurrency) {
      throw errorFactory("RENDER_CONCURRENCY_EXCEEDED", 429, {
        scope: "global",
        limit: globalConcurrency,
      });
    }
    if (activeForOwner.length >= perUserConcurrency) {
      throw errorFactory("RENDER_CONCURRENCY_EXCEEDED", 429, {
        scope: "user",
        limit: perUserConcurrency,
      });
    }
    const day = utcDay(nowMs);
    const dailyForOwner = jobs.filter((job) => (
      job.ownerId === ownerId &&
      utcDay(job.createdAt) === day &&
      job.status !== "cancelled"
    ));
    if (dailyForOwner.length >= perUserDailyQuota) {
      throw errorFactory("RENDER_QUOTA_EXCEEDED", 429, {
        scope: "user",
        limit: perUserDailyQuota,
      });
    }
    return {
      allowed: true,
      replayed: false,
      limits: {
        perUserDailyQuota,
        perUserConcurrency,
        globalConcurrency,
      },
      usage: {
        userDaily: dailyForOwner.length,
        userActive: activeForOwner.length,
        globalActive: active.length,
      },
    };
  }

  function health() {
    const jobs = relevantJobs();
    const active = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
    return {
      ready: true,
      bounded: true,
      perUserDailyQuota,
      perUserConcurrency,
      globalConcurrency,
      active: active.length,
    };
  }

  return {
    assertCanEnqueue,
    health,
  };
}

module.exports = {
  createExecutionControls,
  utcDay,
};
