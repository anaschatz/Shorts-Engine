const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { jsonClone, sanitizeText, validateResourceId } = require("../../../repositories/ids.cjs");

const FOOTBALL_REVIEW_CANDIDATE_SCHEMA_VERSION = 1;
const MIN_CANDIDATES = 2;
const MAX_CANDIDATES = 4;
const MAX_CANDIDATE_DURATION_SECONDS = 90;
const CANDIDATE_ID_RE = /^fcand_[a-f0-9]{32}$/;

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function candidateIdFor(input) {
  return `fcand_${createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 32)}`;
}

function validateCandidateId(value) {
  const safe = sanitizeText(value, 80);
  if (!CANDIDATE_ID_RE.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function boundedNumber(value, min, max, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new AppError("FOOTBALL_REVIEW_CANDIDATE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID, 400, { field });
  }
  return Number(number.toFixed(3));
}

function safeReasonCodes(values, fallback = []) {
  return [...new Set([...(Array.isArray(values) ? values : []), ...fallback]
    .map((value) => sanitizeText(value, 80).toLowerCase())
    .filter((value) => /^[a-z0-9][a-z0-9_-]{1,79}$/.test(value)))]
    .slice(0, 12);
}

function evidenceSummary(plan = {}, fallbackReasonCodes = []) {
  const review = plan.reviewMetadata && typeof plan.reviewMetadata === "object" ? plan.reviewMetadata : {};
  const visual = review.visualEvidenceSummary && typeof review.visualEvidenceSummary === "object"
    ? review.visualEvidenceSummary
    : plan.visualEvidenceSummary && typeof plan.visualEvidenceSummary === "object"
      ? plan.visualEvidenceSummary
      : {};
  const audio = review.audioEvidenceSummary && typeof review.audioEvidenceSummary === "object"
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
    visualWindowCount: Math.max(0, Math.min(100, Math.floor(Number(visual.windowCount || 0)))),
    visualConfidence: Number(Math.max(0, Math.min(1, Number(visual.actionFocusConfidence || plan.actionFocusConfidence || 0))).toFixed(2)),
    audioPeakCount: Math.max(0, Math.min(100, Math.floor(Number(audio.audioPeakCount || 0)))),
    reasonCodes: safeReasonCodes(plan.reasonCodes, fallbackReasonCodes),
  };
}

function framingSummary(plan = {}) {
  const crop = plan.cropPlan && typeof plan.cropPlan === "object" ? plan.cropPlan : {};
  const mode = sanitizeText(crop.mode || plan.framingMode || "wide_safe", 60);
  const confidence = Number(Math.max(0, Math.min(1, Number(crop.confidence ?? crop.trackingConfidence ?? plan.actionFocusConfidence ?? 0))).toFixed(2));
  const fallbackUsed = crop.fallbackUsed !== false;
  return {
    status: fallbackUsed ? "safe_fallback" : confidence >= 0.82 ? "tracked" : "low_confidence",
    mode,
    confidence,
    fallbackUsed,
    reasonCodes: safeReasonCodes(crop.reasonCodes, fallbackUsed ? ["wide_safe_fallback"] : []),
  };
}

function normalizeCandidate(record = {}, options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new AppError("FOOTBALL_REVIEW_CANDIDATE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID, 400);
  }
  const projectId = validateResourceId(record.projectId || options.projectId, "prj");
  const sourceJobId = validateResourceId(record.sourceJobId || options.sourceJobId, "job");
  const sourceStart = boundedNumber(record.sourceStart, 0, Number(options.sourceDurationSeconds || 24 * 60 * 60), "sourceStart");
  const sourceEnd = boundedNumber(record.sourceEnd, sourceStart + 0.25, Number(options.sourceDurationSeconds || 24 * 60 * 60), "sourceEnd");
  if (sourceEnd - sourceStart > MAX_CANDIDATE_DURATION_SECONDS) {
    throw new AppError("FOOTBALL_REVIEW_CANDIDATE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID, 400, { field: "duration" });
  }
  const editPlan = record.editPlan && typeof record.editPlan === "object" && !Array.isArray(record.editPlan)
    ? jsonClone(record.editPlan)
    : null;
  if (!editPlan) {
    throw new AppError("FOOTBALL_REVIEW_CANDIDATE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID, 400, { field: "editPlan" });
  }
  const confidence = Number(Math.max(0, Math.min(1, Number(record.confidence ?? editPlan.confidence ?? 0))).toFixed(2));
  const evidence = evidenceSummary(editPlan, options.reviewReasonCodes);
  const framing = framingSummary(editPlan);
  const id = record.id
    ? validateCandidateId(record.id)
    : candidateIdFor({
        projectId,
        sourceJobId,
        sourceRevision: options.sourceRevision,
        sourceStart,
        sourceEnd,
        highlightType: evidence.highlightType,
        framingMode: framing.mode,
      });
  return {
    schemaVersion: FOOTBALL_REVIEW_CANDIDATE_SCHEMA_VERSION,
    id,
    projectId,
    sourceJobId,
    sourceRevision: sanitizeText(options.sourceRevision || record.sourceRevision, 80),
    sourceStart,
    sourceEnd,
    durationSeconds: Number((sourceEnd - sourceStart).toFixed(3)),
    confidence,
    reasonCodes: evidence.reasonCodes,
    evidence,
    framing,
    editPlan,
  };
}

function assertCandidateSet(candidates) {
  if (!Array.isArray(candidates) || candidates.length < MIN_CANDIDATES || candidates.length > MAX_CANDIDATES) {
    throw new AppError("FOOTBALL_REVIEW_CANDIDATE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID, 400, {
      candidateCount: Array.isArray(candidates) ? candidates.length : 0,
    });
  }
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new AppError("FOOTBALL_REVIEW_CANDIDATE_INVALID", SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID, 400, { field: "candidateIds" });
  }
  return candidates;
}

function publicCandidate(candidate, options = {}) {
  const safe = normalizeCandidate(candidate, {
    projectId: candidate.projectId,
    sourceJobId: candidate.sourceJobId,
    sourceRevision: candidate.sourceRevision,
    sourceDurationSeconds: Math.max(candidate.sourceEnd, candidate.sourceEnd + 1),
  });
  return {
    schemaVersion: safe.schemaVersion,
    id: safe.id,
    sourceStart: safe.sourceStart,
    sourceEnd: safe.sourceEnd,
    durationSeconds: safe.durationSeconds,
    confidence: safe.confidence,
    reasonCodes: safe.reasonCodes,
    evidence: safe.evidence,
    framing: safe.framing,
    preview: options.previewUrl
      ? {
          url: String(options.previewUrl),
          expiresAt: sanitizeText(options.previewExpiresAt || "", 48) || null,
        }
      : null,
  };
}

module.exports = {
  FOOTBALL_REVIEW_CANDIDATE_SCHEMA_VERSION,
  MAX_CANDIDATES,
  MAX_CANDIDATE_DURATION_SECONDS,
  MIN_CANDIDATES,
  assertCandidateSet,
  candidateIdFor,
  normalizeCandidate,
  publicCandidate,
  validateCandidateId,
};
