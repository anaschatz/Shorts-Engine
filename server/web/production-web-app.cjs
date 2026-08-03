const { AppError, SAFE_MESSAGES, readJsonBody, requestId, sendError, sendOk } = require("../errors.cjs");

const MAX_JSON_BYTES = 64 * 1024;
const RESULT_FIELDS = new Set([
  "analysisJobId",
  "artifactId",
  "candidateCount",
  "exportId",
  "previewJobId",
  "reviewId",
  "sourceRevision",
]);

function header(req, name) {
  const value = req && req.headers && req.headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value || "");
}

function publicJob(job) {
  if (!job) return null;
  const result = job.result && typeof job.result === "object"
    ? Object.fromEntries(
      Object.entries(job.result).filter(([key, value]) => (
        RESULT_FIELDS.has(key)
        && (
          typeof value === "string"
          || typeof value === "number"
          || typeof value === "boolean"
          || value === null
        )
      )),
    )
    : null;
  return {
    id: job.id,
    projectId: job.projectId,
    action: job.action,
    pipelineType: job.pipelineType,
    status: job.status,
    progress: job.progress,
    step: job.step,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    nextRetryAt: job.nextRetryAt,
    error: job.error,
    result,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, {
    "cache-control": "no-store",
    location,
    ...(cookies.length ? { "set-cookie": cookies } : {}),
  });
  res.end();
}

function routeId(pathname, pattern) {
  const match = pattern.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
}

async function authenticated(runtime, req, { csrf = false } = {}) {
  const auth = runtime.auth;
  if (
    !auth
    || typeof auth.sessionTokenFromCookie !== "function"
    || typeof auth.resolveSession !== "function"
  ) {
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      SAFE_MESSAGES.AUTH_CONFIG_MISSING,
      503,
    );
  }
  const cookieHeader = header(req, "cookie");
  const sessionToken = auth.sessionTokenFromCookie(cookieHeader);
  const session = await auth.resolveSession({ sessionToken });
  if (!session) {
    throw new AppError("AUTH_REQUIRED", SAFE_MESSAGES.AUTH_REQUIRED, 401);
  }
  if (csrf) {
    auth.assertCsrf({
      method: req.method,
      origin: header(req, "origin"),
      csrfToken: header(req, "x-csrf-token"),
      session,
    });
  }
  return { session, sessionToken, principal: session.principal };
}

async function publicReview(runtime, ownerId, reviewId) {
  const repository = runtime.services.footballReviews;
  const expired = await repository.expirePreviews({ ownerId, reviewId });
  const previewOptions = new Map();
  for (const candidate of expired.candidates) {
    if (
      candidate.preview.status !== "ready"
      || !candidate.preview.artifactId
    ) continue;
    const grant = await runtime.services.uploads.issueDeliveryGrant({
      ownerId,
      artifactId: candidate.preview.artifactId,
      purpose: "preview",
    });
    previewOptions.set(candidate.id, {
      previewStatus: "ready",
      previewUrl: grant.url,
      previewExpiresAt: grant.expiresAt,
      previewDurationSeconds: candidate.preview.durationSeconds,
    });
  }
  return repository.publicReview(expired, previewOptions);
}

function requireProductionServices(runtime) {
  const required = [
    "footballReviews",
    "uploads",
  ];
  if (
    !runtime
    || !runtime.services
    || required.some((name) => !runtime.services[name])
  ) {
    throw new AppError(
      "ADAPTER_CONTRACT_INVALID",
      SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
      500,
    );
  }
}

function createProductionWebApp(options = {}) {
  const runtime = options.runtime;
  requireProductionServices(runtime);
  return async function productionWebHandler(req, res) {
    const currentRequestId = requestId();
    try {
      const url = new URL(
        req.url || "/",
        runtime.config.oidc && runtime.config.oidc.publicBaseUrl
          || "https://shortsengine.invalid/",
      );
      const pathname = url.pathname;
      const method = String(req.method || "GET").toUpperCase();

      if (method === "GET" && pathname === "/healthz") {
        sendOk(res, { status: "ok", role: runtime.role });
        return;
      }
      if (method === "GET" && (pathname === "/readyz" || pathname === "/health")) {
        const readiness = await runtime.readiness();
        sendOk(res, readiness, readiness.ready ? 200 : 503);
        return;
      }
      if (method === "GET" && pathname === "/auth/login") {
        const login = await runtime.auth.beginLogin({
          returnTo: url.searchParams.get("returnTo") || "/",
        });
        redirect(res, login.authorizationUrl, [login.setCookie]);
        return;
      }
      if (method === "GET" && pathname === "/auth/callback") {
        const completed = await runtime.auth.completeLogin({
          params: Object.fromEntries(url.searchParams.entries()),
          transactionCookie: runtime.auth.loginTransactionFromCookie(
            header(req, "cookie"),
          ),
        });
        redirect(res, completed.returnTo, completed.setCookies);
        return;
      }

      if (method === "GET" && pathname === "/api/session") {
        const authn = await authenticated(runtime, req);
        const csrfToken = runtime.auth.csrfTokenFromCookie(
          header(req, "cookie"),
        );
        runtime.auth.assertCsrf({
          method: "POST",
          origin: runtime.auth.allowedOrigin,
          csrfToken,
          session: authn.session,
        });
        sendOk(res, {
          authenticated: true,
          principal: {
            id: authn.principal.id,
            authMode: authn.principal.authMode,
          },
          csrfToken,
          publicConfig: runtime.publicConfig,
        });
        return;
      }
      if (method === "POST" && pathname === "/auth/logout") {
        const authn = await authenticated(runtime, req, { csrf: true });
        const loggedOut = await runtime.auth.logout({
          sessionToken: authn.sessionToken,
          userId: authn.principal.id,
        });
        sendOk(res, { authenticated: false }, 200, {
          "set-cookie": loggedOut.setCookies || [loggedOut.setCookie],
        });
        return;
      }
      if (method === "POST" && pathname === "/api/uploads/multipart") {
        const authn = await authenticated(runtime, req, { csrf: true });
        const body = await readJsonBody(req, MAX_JSON_BYTES);
        const created = await runtime.services.uploads.createUpload({
          ...body,
          ownerId: authn.principal.id,
        });
        sendOk(res, created, 201);
        return;
      }

      const completeUploadId = routeId(
        pathname,
        /^\/api\/uploads\/([^/]+)\/complete$/,
      );
      if (method === "POST" && completeUploadId) {
        const authn = await authenticated(runtime, req, { csrf: true });
        const body = await readJsonBody(req, MAX_JSON_BYTES);
        const completed = await runtime.services.uploads.completeUpload({
          ownerId: authn.principal.id,
          uploadId: completeUploadId,
          parts: body.parts,
        });
        sendOk(res, completed, 202);
        return;
      }

      const jobId = routeId(pathname, /^\/api\/jobs\/([^/]+)$/);
      if (method === "GET" && jobId) {
        const authn = await authenticated(runtime, req);
        const job = await runtime.queue.get(jobId, authn.principal.id);
        if (!job) {
          throw new AppError("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, 404);
        }
        sendOk(res, publicJob(job));
        return;
      }

      const jobDeliveryId = routeId(
        pathname,
        /^\/api\/jobs\/([^/]+)\/delivery$/,
      );
      if (method === "POST" && jobDeliveryId) {
        const authn = await authenticated(runtime, req, { csrf: true });
        const job = await runtime.queue.get(jobDeliveryId, authn.principal.id);
        const artifactId = job
          && job.status === "completed"
          && job.result
          && job.result.artifactId;
        if (!artifactId) {
          throw new AppError(
            "EXPORT_NOT_FOUND",
            SAFE_MESSAGES.EXPORT_NOT_FOUND,
            404,
          );
        }
        const grant = await runtime.services.uploads.issueDeliveryGrant({
          ownerId: authn.principal.id,
          artifactId,
          purpose: "export",
        });
        sendOk(res, grant, 201);
        return;
      }

      const reviewId = routeId(
        pathname,
        /^\/api\/football\/reviews\/([^/]+)$/,
      );
      if (method === "GET" && reviewId) {
        const authn = await authenticated(runtime, req);
        sendOk(res, await publicReview(runtime, authn.principal.id, reviewId));
        return;
      }

      const decisionReviewId = routeId(
        pathname,
        /^\/api\/football\/reviews\/([^/]+)\/decision$/,
      );
      if (method === "POST" && decisionReviewId) {
        const authn = await authenticated(runtime, req, { csrf: true });
        const body = await readJsonBody(req, MAX_JSON_BYTES);
        const decided = await runtime.services.footballReviews
          .decideAndEnqueueReview({
            ownerId: authn.principal.id,
            reviewId: decisionReviewId,
            expectedVersion: body.expectedVersion,
            expectedSourceRevision: body.expectedSourceRevision,
            action: body.action,
            candidateId: body.candidateId,
            reviewerNote: body.reviewerNote,
            idempotencyKey: header(req, "idempotency-key"),
            traceparent: header(req, "traceparent") || null,
          });
        sendOk(res, {
          review: runtime.services.footballReviews.publicReview(decided.review),
          job: publicJob(decided.job),
          replayed: decided.replayed,
        }, decided.replayed ? 200 : 202);
        return;
      }

      const deliveryToken = routeId(pathname, /^\/api\/delivery\/([^/]+)$/);
      if ((method === "GET" || method === "HEAD") && deliveryToken) {
        const authn = await authenticated(runtime, req);
        const delivery = await runtime.services.uploads.openDelivery({
          ownerId: authn.principal.id,
          token: deliveryToken,
          rangeHeader: header(req, "range") || null,
        });
        res.writeHead(delivery.status, delivery.headers);
        if (method === "HEAD") {
          res.end();
        } else {
          delivery.body.on("error", () => res.destroy());
          delivery.body.pipe(res);
        }
        return;
      }

      throw new AppError("ROUTE_NOT_FOUND", SAFE_MESSAGES.ROUTE_NOT_FOUND, 404);
    } catch (error) {
      sendError(res, error, { requestId: currentRequestId });
    }
  };
}

module.exports = {
  createProductionWebApp,
  publicJob,
};
