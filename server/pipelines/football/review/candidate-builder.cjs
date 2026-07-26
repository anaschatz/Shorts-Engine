const { createHash } = require("node:crypto");
const {
  MAX_CANDIDATES,
  MIN_CANDIDATES,
  assertCandidateSet,
  normalizeCandidate,
} = require("./candidate-contract.cjs");

function sourceRevisionFor(upload, projectRevision = 1) {
  const checksum = String(upload && (upload.checksumSha256 || upload.artifact && upload.artifact.checksumSha256) || "");
  return createHash("sha256")
    .update(`${checksum || "checksum-missing"}:${Math.max(1, Math.floor(Number(projectRevision || 1)))}`)
    .digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function windowVariant(plan, durationSeconds, variant) {
  const sourceStart = Math.max(0, Number(plan.sourceStart || 0));
  const sourceEnd = Math.min(durationSeconds, Number(plan.sourceEnd || sourceStart + 1));
  const center = (sourceStart + sourceEnd) / 2;
  const originalDuration = Math.max(1, sourceEnd - sourceStart);
  const targetDuration = Math.min(
    90,
    durationSeconds,
    variant === "tight" ? Math.max(6, originalDuration * 0.72)
      : variant === "context" ? Math.min(60, originalDuration + 8)
        : Math.min(72, originalDuration + 16),
  );
  const beforeRatio = variant === "decision" ? 0.68 : 0.5;
  const nextStart = Math.max(0, Math.min(durationSeconds - targetDuration, center - targetDuration * beforeRatio));
  const nextEnd = Math.min(durationSeconds, nextStart + targetDuration);
  return {
    ...clone(plan),
    sourceStart: Number(nextStart.toFixed(3)),
    sourceEnd: Number(nextEnd.toFixed(3)),
    reviewVariant: variant,
  };
}

function candidateKey(plan) {
  return [
    Number(plan.sourceStart || 0).toFixed(3),
    Number(plan.sourceEnd || 0).toFixed(3),
    String(plan.highlightType || ""),
    String(plan.framingMode || ""),
  ].join("|");
}

function buildFootballReviewCandidates(input = {}) {
  const plans = Array.isArray(input.candidatePlans) ? input.candidatePlans.filter(Boolean) : [];
  const fallbackPlan = input.editPlan && typeof input.editPlan === "object" ? input.editPlan : plans[0];
  if (!fallbackPlan) return [];
  const durationSeconds = Math.max(1, Number(input.sourceDurationSeconds || fallbackPlan.sourceEnd || 1));
  const raw = [];
  const seen = new Set();
  for (const plan of plans) {
    if (raw.length >= MAX_CANDIDATES) break;
    const key = candidateKey(plan);
    if (seen.has(key)) continue;
    seen.add(key);
    raw.push(plan);
  }
  for (const variant of ["tight", "context", "decision"]) {
    if (raw.length >= MIN_CANDIDATES && raw.length >= MAX_CANDIDATES) break;
    const plan = windowVariant(fallbackPlan, durationSeconds, variant);
    const key = candidateKey(plan);
    if (seen.has(key)) continue;
    seen.add(key);
    raw.push(plan);
    if (raw.length >= MAX_CANDIDATES) break;
  }
  while (raw.length < MIN_CANDIDATES) {
    const plan = windowVariant(fallbackPlan, durationSeconds, raw.length ? "context" : "tight");
    plan.sourceStart = Number(Math.max(0, plan.sourceStart - raw.length * 0.25).toFixed(3));
    plan.sourceEnd = Number(Math.min(durationSeconds, plan.sourceEnd + raw.length * 0.25).toFixed(3));
    raw.push(plan);
  }
  const candidates = raw.slice(0, MAX_CANDIDATES).map((plan) => normalizeCandidate({
    projectId: input.projectId,
    sourceJobId: input.sourceJobId,
    sourceRevision: input.sourceRevision,
    sourceStart: plan.sourceStart,
    sourceEnd: plan.sourceEnd,
    confidence: plan.confidence,
    editPlan: plan,
  }, {
    projectId: input.projectId,
    sourceJobId: input.sourceJobId,
    sourceRevision: input.sourceRevision,
    sourceDurationSeconds: durationSeconds,
    reviewReasonCodes: input.reviewReasonCodes,
  }));
  return assertCandidateSet(candidates);
}

module.exports = {
  buildFootballReviewCandidates,
  sourceRevisionFor,
};
