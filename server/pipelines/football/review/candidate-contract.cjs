const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const {
  jsonClone,
  sanitizeText,
  validateResourceId,
} = require("../../../repositories/ids.cjs");

const FOOTBALL_REVIEW_CANDIDATE_SCHEMA_VERSION = 2;
const MIN_CANDIDATES = 2;
const MAX_CANDIDATES = 4;
const MAX_CANDIDATE_DURATION_SECONDS = 90;
const CANDIDATE_ID_RE = /^fcand_[a-f0-9]{32}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const PURPOSE_CODES = new Set([
  "buildup_focused",
  "finish_focused",
  "context_decision",
  "tracked_action",
  "wide_safe",
]);
const PREVIEW_STATUSES = new Set([
  "queued",
  "rendering",
  "ready",
  "failed",
  "expired",
]);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(",")}}`;
}

function hashValue(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function candidateIdFor(input) {
  return `fcand_${hashValue(input).slice(0, 32)}`;
}

function validateCandidateId(value) {
  const safe = sanitizeText(value, 80);
  if (!CANDIDATE_ID_RE.test(safe)) {
    throw new AppError(
      "RESOURCE_ID_INVALID",
      SAFE_MESSAGES.RESOURCE_ID_INVALID,
      400,
    );
  }
  return safe;
}

function boundedNumber(value, min, max, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new AppError(
      "FOOTBALL_REVIEW_CANDIDATE_INVALID",
      SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID,
      400,
      { field },
    );
  }
  return Number(number.toFixed(3));
}

function safeCode(value, fallback, allowed = null) {
  const code = sanitizeText(value || fallback, 80).toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9_-]{1,79}$/.test(code)
    || allowed && !allowed.has(code)
  ) {
    throw new AppError(
      "FOOTBALL_REVIEW_CANDIDATE_INVALID",
      SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID,
      400,
    );
  }
  return code;
}

function safeReasonCodes(values, fallback = []) {
  return [...new Set([...(Array.isArray(values) ? values : []), ...fallback]
    .map((value) => sanitizeText(value, 80).toLowerCase())
    .filter((value) => /^[a-z0-9][a-z0-9_-]{1,79}$/.test(value)))]
    .slice(0, 12);
}

function evidenceSummary(plan = {}, fallbackReasonCodes = []) {
  const review = plan.reviewMetadata && typeof plan.reviewMetadata === "object"
    ? plan.reviewMetadata
    : {};
  const visual = review.visualEvidenceSummary
    && typeof review.visualEvidenceSummary === "object"
    ? review.visualEvidenceSummary
    : plan.visualEvidenceSummary && typeof plan.visualEvidenceSummary === "object"
      ? plan.visualEvidenceSummary
      : {};
  const audio = review.audioEvidenceSummary
    && typeof review.audioEvidenceSummary === "object"
    ? review.audioEvidenceSummary
    : {};
  const outcome = plan.goalOutcome && typeof plan.goalOutcome === "object"
    ? plan.goalOutcome
    : review.goalOutcome && typeof review.goalOutcome === "object"
      ? review.goalOutcome
      : {};
  return {
    highlightType: sanitizeText(plan.highlightType || "uncertain_moment", 80),
    goalOutcome: sanitizeText(outcome.outcome || "unknown_decision", 48),
    visualWindowCount: Math.max(
      0,
      Math.min(100, Math.floor(Number(visual.windowCount || 0))),
    ),
    visualConfidence: Number(Math.max(
      0,
      Math.min(
        1,
        Number(visual.actionFocusConfidence || plan.actionFocusConfidence || 0),
      ),
    ).toFixed(2)),
    audioPeakCount: Math.max(
      0,
      Math.min(100, Math.floor(Number(audio.audioPeakCount || 0))),
    ),
    reasonCodes: safeReasonCodes(plan.reasonCodes, fallbackReasonCodes),
  };
}

function normalizePurpose(value = {}) {
  const source = typeof value === "string" ? { code: value } : value;
  const code = safeCode(source.code, "wide_safe", PURPOSE_CODES);
  const labels = {
    buildup_focused: "Build-up and action",
    finish_focused: "Finish and payoff",
    context_decision: "Context and decision",
    tracked_action: "Tracked action",
    wide_safe: "Wide safe context",
  };
  return {
    code,
    label: labels[code],
    hook: safeCode(source.hook, `${code}_hook`),
    payoff: safeCode(source.payoff, `${code}_payoff`),
  };
}

function framingSummary(value = {}, plan = {}) {
  const crop = plan.cropPlan && typeof plan.cropPlan === "object"
    ? plan.cropPlan
    : {};
  const mode = safeCode(value.mode || crop.mode || plan.framingMode, "wide_safe");
  const confidence = Number(Math.max(
    0,
    Math.min(
      1,
      Number(
        value.confidence
        ?? crop.confidence
        ?? crop.trackingConfidence
        ?? plan.actionFocusConfidence
        ?? 0
      ),
    ),
  ).toFixed(2));
  const fallbackUsed = value.fallbackUsed === undefined
    ? crop.fallbackUsed !== false
    : value.fallbackUsed === true;
  return {
    status: fallbackUsed
      ? "safe_fallback"
      : confidence >= 0.82
        ? "tracked"
        : "low_confidence",
    mode,
    confidence,
    fallbackUsed,
    reasonCodes: safeReasonCodes(
      value.reasonCodes || crop.reasonCodes,
      fallbackUsed ? ["wide_safe_fallback"] : [],
    ),
  };
}

function normalizeCaptions(value = {}) {
  return {
    strategy: safeCode(value.strategy, "evidence_first"),
    emphasis: safeCode(value.emphasis, "balanced"),
    maxLines: Math.max(1, Math.min(3, Math.floor(Number(value.maxLines || 2)))),
    safeArea: value.safeArea === "upper" ? "upper" : "lower",
  };
}

function normalizePacing(value = {}) {
  return {
    rhythm: safeCode(value.rhythm, "balanced"),
    hookSeconds: boundedNumber(value.hookSeconds ?? 1.5, 0.5, 5, "pacing.hookSeconds"),
    payoffHoldSeconds: boundedNumber(
      value.payoffHoldSeconds ?? 1.25,
      0.5,
      5,
      "pacing.payoffHoldSeconds",
    ),
    playbackRate: boundedNumber(
      value.playbackRate ?? 1,
      0.85,
      1.15,
      "pacing.playbackRate",
    ),
  };
}

function normalizeUncertainty(value = {}, evidence, framing) {
  const level = ["low", "medium", "high"].includes(value.level)
    ? value.level
    : evidence.goalOutcome === "confirmed_goal" && framing.confidence >= 0.82
      ? "low"
      : framing.confidence >= 0.65
        ? "medium"
        : "high";
  return {
    level,
    requiresReview: value.requiresReview !== false,
    reasonCodes: safeReasonCodes(
      value.reasonCodes,
      evidence.reasonCodes.length
        ? evidence.reasonCodes
        : ["insufficient_event_certainty"],
    ),
  };
}

function qualityWarningsFor(record, framing, uncertainty) {
  return safeReasonCodes(record.qualityWarnings, [
    ...(framing.fallbackUsed ? ["wide_safe_framing"] : []),
    ...(framing.confidence < 0.65 ? ["low_tracking_confidence"] : []),
    ...(uncertainty.level === "high" ? ["high_event_uncertainty"] : []),
  ]).slice(0, 8);
}

function normalizePreview(record = {}) {
  const status = PREVIEW_STATUSES.has(record.status) ? record.status : "queued";
  const checksum = sanitizeText(record.checksumSha256 || "", 64).toLowerCase();
  return {
    status,
    artifactId: record.artifactId
      ? validateResourceId(record.artifactId, "art")
      : null,
    checksumSha256: checksum && HASH_RE.test(checksum) ? checksum : null,
    expiresAt: record.expiresAt ? sanitizeText(record.expiresAt, 48) : null,
    durationSeconds: record.durationSeconds === null
      || record.durationSeconds === undefined
      ? null
      : boundedNumber(
        record.durationSeconds,
        0.25,
        MAX_CANDIDATE_DURATION_SECONDS,
        "preview.durationSeconds",
      ),
  };
}

function normalizeCandidate(record = {}, options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new AppError(
      "FOOTBALL_REVIEW_CANDIDATE_INVALID",
      SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID,
      400,
    );
  }
  const projectId = validateResourceId(
    record.projectId || options.projectId,
    "prj",
  );
  const sourceJobId = validateResourceId(
    record.sourceJobId || options.sourceJobId,
    "job",
  );
  const sourceRevision = sanitizeText(
    options.sourceRevision || record.sourceRevision,
    80,
  ).toLowerCase();
  if (!HASH_RE.test(sourceRevision)) {
    throw new AppError(
      "FOOTBALL_REVIEW_CANDIDATE_INVALID",
      SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID,
      400,
      { field: "sourceRevision" },
    );
  }
  const sourceDurationSeconds = Number(
    options.sourceDurationSeconds || 24 * 60 * 60,
  );
  const sourceStart = boundedNumber(
    record.sourceStart,
    0,
    sourceDurationSeconds,
    "sourceStart",
  );
  const sourceEnd = boundedNumber(
    record.sourceEnd,
    sourceStart + 0.25,
    sourceDurationSeconds,
    "sourceEnd",
  );
  if (sourceEnd - sourceStart > MAX_CANDIDATE_DURATION_SECONDS) {
    throw new AppError(
      "FOOTBALL_REVIEW_CANDIDATE_INVALID",
      SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID,
      400,
      { field: "duration" },
    );
  }
  const editPlan = record.editPlan
    && typeof record.editPlan === "object"
    && !Array.isArray(record.editPlan)
    ? jsonClone(record.editPlan)
    : null;
  if (!editPlan) {
    throw new AppError(
      "FOOTBALL_REVIEW_CANDIDATE_INVALID",
      SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID,
      400,
      { field: "editPlan" },
    );
  }
  const confidence = Number(Math.max(
    0,
    Math.min(1, Number(record.confidence ?? editPlan.confidence ?? 0)),
  ).toFixed(2));
  const purpose = normalizePurpose(
    record.purpose || editPlan.reviewEditorial && editPlan.reviewEditorial.purpose,
  );
  const phaseWindow = {
    phase: safeCode(
      record.phaseWindow && record.phaseWindow.phase,
      purpose.code,
    ),
    sourceStart,
    sourceEnd,
  };
  const evidence = evidenceSummary(editPlan, options.reviewReasonCodes);
  const framing = framingSummary(record.framing || {}, editPlan);
  const captions = normalizeCaptions(record.captions || {});
  const pacing = normalizePacing(record.pacing || {});
  const uncertainty = normalizeUncertainty(
    record.uncertainty || {},
    evidence,
    framing,
  );
  const qualityWarnings = qualityWarningsFor(record, framing, uncertainty);
  const editorialSignature = hashValue({
    purpose,
    phaseWindow,
    framing,
    captions,
    pacing,
  });
  if (
    record.editorialSignature
    && record.editorialSignature !== editorialSignature
  ) {
    throw new AppError(
      "FOOTBALL_REVIEW_CANDIDATE_INVALID",
      SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID,
      400,
      { field: "editorialSignature" },
    );
  }
  const planHash = hashValue({
    sourceRevision,
    editorialSignature,
    editPlan,
  });
  if (record.planHash && record.planHash !== planHash) {
    throw new AppError(
      "FOOTBALL_REVIEW_CANDIDATE_INVALID",
      SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID,
      400,
      { field: "planHash" },
    );
  }
  const id = record.id
    ? validateCandidateId(record.id)
    : candidateIdFor({
      projectId,
      sourceJobId,
      sourceRevision,
      editorialSignature,
      planHash,
    });
  return {
    schemaVersion: FOOTBALL_REVIEW_CANDIDATE_SCHEMA_VERSION,
    id,
    projectId,
    sourceJobId,
    sourceRevision,
    sourceStart,
    sourceEnd,
    durationSeconds: Number((sourceEnd - sourceStart).toFixed(3)),
    confidence,
    purpose,
    phaseWindow,
    reasonCodes: evidence.reasonCodes,
    evidence,
    uncertainty,
    framing,
    captions,
    pacing,
    qualityWarnings,
    editorialSignature,
    planHash,
    preview: normalizePreview(record.preview || {}),
    editPlan,
  };
}

function assertCandidateSet(candidates) {
  if (
    !Array.isArray(candidates)
    || candidates.length < MIN_CANDIDATES
    || candidates.length > MAX_CANDIDATES
  ) {
    throw new AppError(
      "FOOTBALL_REVIEW_CANDIDATE_INVALID",
      SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID,
      400,
      { candidateCount: Array.isArray(candidates) ? candidates.length : 0 },
    );
  }
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new AppError(
      "FOOTBALL_REVIEW_CANDIDATE_INVALID",
      SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID,
      400,
      { field: "candidateIds" },
    );
  }
  if (
    new Set(candidates.map((candidate) => candidate.editorialSignature)).size
    !== candidates.length
  ) {
    throw new AppError(
      "FOOTBALL_REVIEW_CANDIDATE_INVALID",
      SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID,
      400,
      { field: "editorialSignatures" },
    );
  }
  return candidates;
}

function publicCandidate(candidate, options = {}) {
  const safe = normalizeCandidate(candidate, {
    projectId: candidate.projectId,
    sourceJobId: candidate.sourceJobId,
    sourceRevision: candidate.sourceRevision,
    sourceDurationSeconds: Math.max(candidate.sourceEnd + 1, 1),
  });
  const previewStatus = PREVIEW_STATUSES.has(options.previewStatus)
    ? options.previewStatus
    : safe.preview.status;
  const previewReady = previewStatus === "ready" && Boolean(options.previewUrl);
  return {
    schemaVersion: safe.schemaVersion,
    id: safe.id,
    sourceStart: safe.sourceStart,
    sourceEnd: safe.sourceEnd,
    purpose: safe.purpose,
    durationSeconds: safe.durationSeconds,
    evidence: safe.evidence,
    uncertainty: safe.uncertainty,
    framing: safe.framing,
    captions: safe.captions,
    qualityWarnings: safe.qualityWarnings,
    preview: {
      status: previewStatus,
      url: previewReady ? String(options.previewUrl) : null,
      expiresAt: previewReady
        ? sanitizeText(options.previewExpiresAt || safe.preview.expiresAt || "", 48)
          || null
        : null,
      durationSeconds: options.previewDurationSeconds === undefined
        ? safe.preview.durationSeconds
        : boundedNumber(
          options.previewDurationSeconds,
          0.25,
          MAX_CANDIDATE_DURATION_SECONDS,
          "preview.durationSeconds",
        ),
    },
  };
}

module.exports = {
  FOOTBALL_REVIEW_CANDIDATE_SCHEMA_VERSION,
  MAX_CANDIDATES,
  MAX_CANDIDATE_DURATION_SECONDS,
  MIN_CANDIDATES,
  PREVIEW_STATUSES,
  PURPOSE_CODES,
  assertCandidateSet,
  candidateIdFor,
  hashValue,
  normalizeCandidate,
  publicCandidate,
  stableStringify,
  validateCandidateId,
};
