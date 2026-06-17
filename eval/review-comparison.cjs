const {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { extname, join, relative, resolve, sep } = require("node:path");
const { AppError } = require("../server/errors.cjs");
const {
  captionSpecificityScore,
  framingIsSafe,
  planHasGoalLanguage,
  sanitizeReportText,
} = require("./scoring.cjs");

const REVIEW_SCHEMA_VERSION = 1;
const DEFAULT_REVIEW_THRESHOLD = 82;
const MAX_MEDIA_SIZE_BYTES = 250 * 1024 * 1024;
const SUPPORTED_VIDEO_EXTENSIONS = Object.freeze([".mp4", ".mov", ".webm"]);
const REQUIRED_MEDIA_ROLES = Object.freeze(["generated", "source"]);
const HUMAN_REVIEW_BOOLEAN_FIELDS = Object.freeze([
  "selectedMomentCorrect",
  "captionMatchesAction",
  "ballPlayerVisible",
  "textObstructsAction",
  "falseClaim",
]);

const SCORE_WEIGHTS = Object.freeze({
  momentTypeMatch: 0.14,
  noFalseGoalClaim: 0.17,
  captionActionAlignment: 0.13,
  captionSpecificity: 0.09,
  framingSafety: 0.12,
  aspectRatioCorrectness: 0.1,
  pacingScore: 0.08,
  animationCueCoverage: 0.08,
  referenceStyleSimilarity: 0.06,
  reviewerReadinessScore: 0.03,
});

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, toNumber(value)));
}

function scoreToPercent(value) {
  return Math.round(clamp01(value) * 100);
}

function normalizeRelative(value) {
  return String(value || "").split(sep).join("/");
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !resolve(rel).startsWith(".."));
}

function safeFailure(code, message, field) {
  return {
    code,
    message,
    ...(field ? { field: sanitizeReportText(field, 120) } : {}),
  };
}

function safeRelativeRef(rootDir, candidate, field = "relativePath") {
  const text = String(candidate || "").trim().replace(/\\/g, "/");
  if (
    !text ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    /^https?:\/\//i.test(text) ||
    /^file:\/\//i.test(text) ||
    text.includes("\0") ||
    text.split("/").some((part) => part === "..")
  ) {
    return {
      ok: false,
      failure: safeFailure("REVIEW_MEDIA_REF_UNSAFE", "Media references must be safe workspace-relative paths.", field),
    };
  }
  const resolvedRoot = resolve(rootDir);
  const resolvedFile = resolve(resolvedRoot, text);
  if (!isInside(resolvedRoot, resolvedFile)) {
    return {
      ok: false,
      failure: safeFailure("REVIEW_MEDIA_REF_UNSAFE", "Media references must stay inside the workspace.", field),
    };
  }
  const relativePath = normalizeRelative(relative(resolvedRoot, resolvedFile));
  if (!relativePath || relativePath.startsWith("../")) {
    return {
      ok: false,
      failure: safeFailure("REVIEW_MEDIA_REF_UNSAFE", "Media references must resolve to a safe relative path.", field),
    };
  }
  return { ok: true, relativePath, resolvedFile };
}

function validateSafeId(value, field) {
  const id = sanitizeReportText(value, 100);
  if (!/^[a-z0-9][a-z0-9_-]{2,100}$/i.test(id)) {
    throw new AppError("VALIDATION_ERROR", `${field} must be a safe id.`, 400);
  }
  return id;
}

function validateSafeToken(value, field, maxLength = 80) {
  const token = sanitizeReportText(value, maxLength);
  if (!/^[a-z0-9][a-z0-9_:-]{1,100}$/i.test(token)) {
    throw new AppError("VALIDATION_ERROR", `${field} must be a safe token.`, 400);
  }
  return token;
}

function safeArray(value, mapper, maxItems = 20) {
  return (Array.isArray(value) ? value : []).slice(0, maxItems).map(mapper).filter((item) => item !== null);
}

function validateWindow(value, field, { optional = false } = {}) {
  if ((value === undefined || value === null) && optional) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", `${field} must be an object.`, 400);
  }
  const start = toNumber(value.start, Number.NaN);
  const end = toNumber(value.end, Number.NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new AppError("VALIDATION_ERROR", `${field} has an invalid start/end range.`, 400);
  }
  return { start: round(start, 3), end: round(end, 3) };
}

function validateCaptionMustMention(value) {
  return safeArray(value, (entry, index) => {
    if (typeof entry === "string") {
      return { role: null, terms: [sanitizeReportText(entry, 80)].filter(Boolean) };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AppError("VALIDATION_ERROR", `expected.captionMustMentionAny[${index}] must be an object or string.`, 400);
    }
    const role = entry.role ? validateSafeToken(entry.role, `expected.captionMustMentionAny[${index}].role`, 40) : null;
    const terms = safeArray(entry.terms || entry.any || [], (term) => sanitizeReportText(term, 80), 10);
    if (!terms.length) {
      throw new AppError("VALIDATION_ERROR", `expected.captionMustMentionAny[${index}] needs terms.`, 400);
    }
    return { role, terms };
  }, 12);
}

function validateExpected(expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new AppError("VALIDATION_ERROR", "Review fixture expected block is required.", 400);
  }
  const momentType = validateSafeToken(expected.momentType || expected.highlightType, "expected.momentType");
  const acceptedMomentTypes = safeArray(
    expected.acceptedMomentTypes || [momentType],
    (item, index) => validateSafeToken(item, `expected.acceptedMomentTypes[${index}]`),
    12
  );
  const requiredAnimationCues = safeArray(
    expected.requiredAnimationCues || [],
    (item, index) => validateSafeToken(item, `expected.requiredAnimationCues[${index}]`),
    16
  );
  const durationRange = Array.isArray(expected.durationRange) ? expected.durationRange.map(Number) : [6, 18];
  if (
    durationRange.length !== 2 ||
    !durationRange.every(Number.isFinite) ||
    durationRange[0] <= 0 ||
    durationRange[1] < durationRange[0]
  ) {
    throw new AppError("VALIDATION_ERROR", "expected.durationRange must be [min,max].", 400);
  }
  const threshold = toNumber(expected.threshold ?? DEFAULT_REVIEW_THRESHOLD, DEFAULT_REVIEW_THRESHOLD);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new AppError("VALIDATION_ERROR", "expected.threshold must be between 0 and 100.", 400);
  }
  return {
    styleTarget: sanitizeReportText(expected.styleTarget || "vertical_9_16_reference_style", 80),
    stylePreset: sanitizeReportText(expected.stylePreset || "reference_sports_short", 80),
    momentType,
    acceptedMomentTypes,
    selectedMomentWindow: validateWindow(expected.selectedMomentWindow, "expected.selectedMomentWindow", { optional: true }),
    aspectRatio: sanitizeReportText(expected.aspectRatio || "9:16", 20),
    durationRange: [round(durationRange[0], 3), round(durationRange[1], 3)],
    requiredAnimationCues,
    captionMustMentionAny: validateCaptionMustMention(expected.captionMustMentionAny || []),
    safety: {
      noFalseGoalClaim: expected.safety && expected.safety.noFalseGoalClaim === false ? false : true,
      allowGoalClaim: Boolean(expected.safety && expected.safety.allowGoalClaim),
    },
    threshold: Math.round(threshold),
    referenceStyleFallbackAllowed: expected.referenceStyleFallbackAllowed !== false,
  };
}

function validateMediaRef(rootDir, media, role) {
  if (role === "reference" && (media === null || media === undefined)) {
    return {
      role,
      required: false,
      present: false,
      relativePath: null,
      exists: false,
      readable: false,
      sizeBytes: null,
      extension: null,
      errorCode: "REFERENCE_STYLE_RUBRIC_FALLBACK",
    };
  }
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    return {
      role,
      required: REQUIRED_MEDIA_ROLES.includes(role),
      present: false,
      relativePath: null,
      exists: false,
      readable: false,
      sizeBytes: null,
      extension: null,
      errorCode: "REVIEW_MEDIA_REF_MISSING",
      failure: safeFailure("REVIEW_MEDIA_REF_MISSING", `${role} media reference is required.`, `media.${role}`),
    };
  }
  const ref = safeRelativeRef(rootDir, media.relativePath, `media.${role}.relativePath`);
  if (!ref.ok) {
    return {
      role,
      required: REQUIRED_MEDIA_ROLES.includes(role),
      present: true,
      relativePath: null,
      exists: false,
      readable: false,
      sizeBytes: null,
      extension: null,
      errorCode: ref.failure.code,
      failure: ref.failure,
    };
  }
  const extension = extname(ref.relativePath).toLowerCase();
  if (!SUPPORTED_VIDEO_EXTENSIONS.includes(extension)) {
    return {
      role,
      required: REQUIRED_MEDIA_ROLES.includes(role),
      present: true,
      relativePath: ref.relativePath,
      exists: existsSync(ref.resolvedFile),
      readable: false,
      sizeBytes: null,
      extension,
      errorCode: "REVIEW_MEDIA_EXTENSION_UNSUPPORTED",
      failure: safeFailure("REVIEW_MEDIA_EXTENSION_UNSUPPORTED", `${role} media must be an mp4/mov/webm file.`, `media.${role}.relativePath`),
    };
  }
  if (!existsSync(ref.resolvedFile)) {
    return {
      role,
      required: REQUIRED_MEDIA_ROLES.includes(role),
      present: true,
      relativePath: ref.relativePath,
      exists: false,
      readable: false,
      sizeBytes: null,
      extension,
      errorCode: "REVIEW_MEDIA_MISSING",
      failure: safeFailure("REVIEW_MEDIA_MISSING", `${role} media does not exist.`, `media.${role}.relativePath`),
    };
  }
  const stats = statSync(ref.resolvedFile);
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_MEDIA_SIZE_BYTES) {
    return {
      role,
      required: REQUIRED_MEDIA_ROLES.includes(role),
      present: true,
      relativePath: ref.relativePath,
      exists: true,
      readable: false,
      sizeBytes: stats.size,
      extension,
      errorCode: "REVIEW_MEDIA_SIZE_INVALID",
      failure: safeFailure("REVIEW_MEDIA_SIZE_INVALID", `${role} media is empty or too large for local review.`, `media.${role}.relativePath`),
    };
  }
  return {
    role,
    required: REQUIRED_MEDIA_ROLES.includes(role),
    present: true,
    relativePath: ref.relativePath,
    exists: true,
    readable: true,
    sizeBytes: stats.size,
    extension,
    errorCode: null,
  };
}

function validateConsent(consent) {
  if (!consent || typeof consent !== "object" || Array.isArray(consent)) {
    throw new AppError("VALIDATION_ERROR", "consent block is required for real-video review inputs.", 400);
  }
  return {
    rightsConfirmed: consent.rightsConfirmed === true,
    reviewPurpose: sanitizeReportText(consent.reviewPurpose || "local_quality_review", 120),
    source: sanitizeReportText(consent.source || "operator_provided", 80),
  };
}

function normalizeCaptions(plan) {
  return Array.isArray(plan && plan.captions) ? plan.captions : [];
}

function normalizeAnimationCueTypes(plan) {
  return safeArray(plan && plan.animationCues, (cue) => {
    if (typeof cue === "string") return sanitizeReportText(cue, 80);
    if (cue && typeof cue === "object") return sanitizeReportText(cue.type, 80);
    return null;
  }, 24);
}

function validateGeneratedMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new AppError("VALIDATION_ERROR", "generatedMetadata block is required.", 400);
  }
  const selected = metadata.selectedMoment && typeof metadata.selectedMoment === "object"
    ? metadata.selectedMoment
    : {};
  const editPlan = metadata.editPlan && typeof metadata.editPlan === "object" && !Array.isArray(metadata.editPlan)
    ? metadata.editPlan
    : {};
  const selectedMoment = {
    start: toNumber(selected.start ?? editPlan.sourceStart, 0),
    end: toNumber(selected.end ?? editPlan.sourceEnd, 0),
    momentType: sanitizeReportText(selected.momentType || selected.highlightType || editPlan.highlightType || "", 80),
    reasonCodes: safeArray(selected.reasonCodes || editPlan.reasonCodes, (reason) => sanitizeReportText(reason, 80), 20),
    retentionScore: toNumber(selected.retentionScore ?? editPlan.retentionScore, 0),
  };
  if (!selectedMoment.momentType) {
    throw new AppError("VALIDATION_ERROR", "generatedMetadata.selectedMoment needs a momentType/highlightType.", 400);
  }
  if (!Number.isFinite(selectedMoment.start) || !Number.isFinite(selectedMoment.end) || selectedMoment.end <= selectedMoment.start) {
    throw new AppError("VALIDATION_ERROR", "generatedMetadata selected moment needs a valid start/end range.", 400);
  }
  return {
    selectedMoment,
    editPlan,
    notes: sanitizeReportText(metadata.notes, 500),
  };
}

function validateHumanReview(review) {
  if (review === undefined || review === null) {
    return { present: false, ok: true, review: null, failedCases: [] };
  }
  const failedCases = [];
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return {
      present: true,
      ok: false,
      review: null,
      failedCases: [safeFailure("REVIEW_HUMAN_REVIEW_INVALID", "humanReview must be an object.", "humanReview")],
    };
  }
  for (const field of HUMAN_REVIEW_BOOLEAN_FIELDS) {
    if (typeof review[field] !== "boolean") {
      failedCases.push(safeFailure("REVIEW_HUMAN_REVIEW_FIELD_INVALID", `${field} must be boolean.`, `humanReview.${field}`));
    }
  }
  const animationFeelsReferenceLike = toNumber(review.animationFeelsReferenceLike, Number.NaN);
  if (!Number.isInteger(animationFeelsReferenceLike) || animationFeelsReferenceLike < 1 || animationFeelsReferenceLike > 5) {
    failedCases.push(safeFailure("REVIEW_HUMAN_REVIEW_SCORE_INVALID", "animationFeelsReferenceLike must be an integer from 1 to 5.", "humanReview.animationFeelsReferenceLike"));
  }
  const reviewedAt = sanitizeReportText(review.reviewedAt || "", 40);
  if (reviewedAt && Number.isNaN(Date.parse(reviewedAt))) {
    failedCases.push(safeFailure("REVIEW_HUMAN_REVIEW_DATE_INVALID", "humanReview.reviewedAt must be ISO-like.", "humanReview.reviewedAt"));
  }
  const reviewer = sanitizeReportText(review.reviewer || "operator", 80);
  const notes = sanitizeReportText(review.notes || "", 1000);
  const normalized = {
    reviewer,
    reviewedAt: reviewedAt || null,
    selectedMomentCorrect: Boolean(review.selectedMomentCorrect),
    captionMatchesAction: Boolean(review.captionMatchesAction),
    ballPlayerVisible: Boolean(review.ballPlayerVisible),
    textObstructsAction: Boolean(review.textObstructsAction),
    animationFeelsReferenceLike: Number.isFinite(animationFeelsReferenceLike) ? animationFeelsReferenceLike : null,
    falseClaim: Boolean(review.falseClaim),
    notes,
  };
  return {
    present: true,
    ok: failedCases.length === 0,
    review: failedCases.length ? null : normalized,
    failedCases,
  };
}

function validateReviewInput(input, { rootDir = process.cwd() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("VALIDATION_ERROR", "Review input must be a JSON object.", 400);
  }
  if (input.schemaVersion !== undefined && Number(input.schemaVersion) !== REVIEW_SCHEMA_VERSION) {
    throw new AppError("VALIDATION_ERROR", "Review input schemaVersion must be 1.", 400);
  }
  const id = validateSafeId(input.id, "id");
  const title = sanitizeReportText(input.title || id, 160);
  const expected = validateExpected(input.expected);
  const consent = validateConsent(input.consent);
  const mediaInput = input.media && typeof input.media === "object" ? input.media : {};
  const media = {
    generated: validateMediaRef(rootDir, mediaInput.generated, "generated"),
    source: validateMediaRef(rootDir, mediaInput.source, "source"),
    reference: validateMediaRef(rootDir, mediaInput.reference, "reference"),
  };
  const generatedMetadata = validateGeneratedMetadata(input.generatedMetadata);
  const humanReview = validateHumanReview(input.humanReview);
  const failedCases = [];
  for (const role of Object.keys(media)) {
    if (media[role].failure) failedCases.push(media[role].failure);
  }
  if (!consent.rightsConfirmed) {
    failedCases.push(safeFailure("REVIEW_RIGHTS_NOT_CONFIRMED", "Review input must confirm rights/consent for local review.", "consent.rightsConfirmed"));
  }
  if (!media.reference.present && !expected.referenceStyleFallbackAllowed) {
    failedCases.push(safeFailure("REVIEW_REFERENCE_REQUIRED", "This review requires a reference video.", "media.reference"));
  }
  if (!humanReview.ok) failedCases.push(...humanReview.failedCases);
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    id,
    title,
    language: sanitizeReportText(input.language || "unknown", 40),
    media,
    expected,
    generatedMetadata,
    humanReview,
    consent,
    reviewerNotes: sanitizeReportText(input.reviewerNotes || "", 1000),
    failedCases,
  };
}

function loadReviewInput(filePath, options = {}) {
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  return validateReviewInput(raw, options);
}

function captionText(plan, role = null) {
  const captions = normalizeCaptions(plan);
  return captions
    .filter((caption) => !role || caption.role === role)
    .map((caption) => sanitizeReportText(caption.text, 140))
    .join(" ");
}

function containsAny(text, terms) {
  const safeText = sanitizeReportText(text, 4000).toLowerCase();
  return (terms || []).some((term) => safeText.includes(sanitizeReportText(term, 80).toLowerCase()));
}

function scoreMomentType(selectedMoment, expected, humanReview) {
  let score = expected.acceptedMomentTypes.includes(selectedMoment.momentType) ? 1 : 0;
  if (humanReview.present && humanReview.ok && humanReview.review.selectedMomentCorrect === false) {
    score = Math.min(score, 0.25);
  }
  return score;
}

function scoreNoFalseGoalClaim(editPlan, selectedMoment, expected, humanReview) {
  if (humanReview.present && humanReview.ok && humanReview.review.falseClaim) return 0;
  if (expected.safety.noFalseGoalClaim === false || expected.safety.allowGoalClaim) return 1;
  const explicitGoalEvidence =
    expected.momentType === "goal" ||
    selectedMoment.momentType === "goal" && selectedMoment.reasonCodes.includes("goal") ||
    selectedMoment.reasonCodes.includes("explicit_goal_evidence");
  if (explicitGoalEvidence) return 1;
  return planHasGoalLanguage(editPlan) ? 0 : 1;
}

function scoreCaptionActionAlignment(editPlan, expected, humanReview) {
  if (humanReview.present && humanReview.ok && humanReview.review.captionMatchesAction === false) return 0;
  if (!expected.captionMustMentionAny.length) {
    return captionSpecificityScore(editPlan) >= 0.75 ? 1 : 0.5;
  }
  let matched = 0;
  for (const group of expected.captionMustMentionAny) {
    const text = group.role ? captionText(editPlan, group.role) : captionText(editPlan);
    if (containsAny(text, group.terms)) matched += 1;
  }
  return round(matched / expected.captionMustMentionAny.length);
}

function scoreCaptionSpecificity(editPlan, captionActionAlignment) {
  return Math.max(captionSpecificityScore(editPlan), captionActionAlignment >= 0.9 ? 1 : captionActionAlignment);
}

function scoreFramingSafety(editPlan, mediaMetadata, humanReview) {
  if (humanReview.present && humanReview.ok) {
    if (humanReview.review.ballPlayerVisible === false || humanReview.review.textObstructsAction === true) return 0;
  }
  return framingIsSafe(editPlan, mediaMetadata) ? 1 : 0;
}

function scoreAspectRatio(editPlan, expected) {
  return sanitizeReportText(editPlan.aspectRatio || "", 20) === expected.aspectRatio ? 1 : 0;
}

function scorePacing(editPlan, expected) {
  const duration = toNumber(editPlan.sourceEnd) - toNumber(editPlan.sourceStart);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const [minDuration, maxDuration] = expected.durationRange;
  if (duration >= minDuration && duration <= maxDuration) return 1;
  const distance = duration < minDuration ? minDuration - duration : duration - maxDuration;
  return round(Math.max(0, 1 - distance / Math.max(1, maxDuration - minDuration)));
}

function scoreAnimationCueCoverage(editPlan, expected) {
  const required = expected.requiredAnimationCues;
  if (!required.length) return 1;
  const actual = new Set(normalizeAnimationCueTypes(editPlan));
  return round(required.filter((cue) => actual.has(cue)).length / required.length);
}

function scoreReferenceStyleSimilarity(metrics, humanReview, referencePresent) {
  let score =
    metrics.aspectRatioCorrectness * 0.2 +
    metrics.animationCueCoverage * 0.25 +
    metrics.pacingScore * 0.2 +
    metrics.captionActionAlignment * 0.2 +
    metrics.framingSafety * 0.15;
  if (humanReview.present && humanReview.ok) {
    score = score * 0.7 + (humanReview.review.animationFeelsReferenceLike / 5) * 0.3;
  }
  if (!referencePresent) {
    score = Math.min(1, score * 0.95 + 0.05);
  }
  return round(score);
}

function scoreReviewerReadiness(input) {
  if (input.humanReview.present && input.humanReview.ok) return 1;
  const hasRequiredMedia = input.media.generated.readable && input.media.source.readable;
  const hasGeneratedPlan = Boolean(input.generatedMetadata.editPlan && Object.keys(input.generatedMetadata.editPlan).length);
  const hasExpectedRubric = Boolean(input.expected.momentType && input.expected.aspectRatio);
  return hasRequiredMedia && hasGeneratedPlan && hasExpectedRubric ? 0.8 : 0.3;
}

function publicMediaSummary(media) {
  return {
    role: media.role,
    required: media.required,
    present: media.present,
    relativePath: media.relativePath,
    exists: media.exists,
    readable: media.readable,
    sizeBytes: media.sizeBytes,
    extension: media.extension,
    errorCode: media.errorCode,
  };
}

function buildReviewComparisonReport(input, {
  minOverallScore = input.expected.threshold,
  timestamp = new Date().toISOString(),
} = {}) {
  const editPlan = input.generatedMetadata.editPlan;
  const selectedMoment = input.generatedMetadata.selectedMoment;
  const mediaMetadata = {
    width: toNumber(editPlan.sourceWidth || editPlan.width, 1920),
    height: toNumber(editPlan.sourceHeight || editPlan.height, 1080),
    durationSeconds: toNumber(editPlan.sourceDurationSeconds, selectedMoment.end),
  };
  const metrics = {};
  metrics.momentTypeMatch = scoreMomentType(selectedMoment, input.expected, input.humanReview);
  metrics.noFalseGoalClaim = scoreNoFalseGoalClaim(editPlan, selectedMoment, input.expected, input.humanReview);
  metrics.captionActionAlignment = scoreCaptionActionAlignment(editPlan, input.expected, input.humanReview);
  metrics.captionSpecificity = scoreCaptionSpecificity(editPlan, metrics.captionActionAlignment);
  metrics.framingSafety = scoreFramingSafety(editPlan, mediaMetadata, input.humanReview);
  metrics.aspectRatioCorrectness = scoreAspectRatio(editPlan, input.expected);
  metrics.pacingScore = scorePacing(editPlan, input.expected);
  metrics.animationCueCoverage = scoreAnimationCueCoverage(editPlan, input.expected);
  metrics.referenceStyleSimilarity = scoreReferenceStyleSimilarity(metrics, input.humanReview, input.media.reference.present);
  metrics.reviewerReadinessScore = scoreReviewerReadiness(input);

  const overallScore = Math.round(Object.entries(SCORE_WEIGHTS).reduce((sum, [key, weight]) => (
    sum + scoreToPercent(metrics[key]) * weight
  ), 0));
  const failedCriteria = Object.entries(metrics)
    .filter(([key, value]) => value < minimumForMetric(key))
    .map(([key, value]) => ({
      metric: key,
      score: round(value),
      min: minimumForMetric(key),
      note: metricDebugNote(key),
    }));
  const failedCases = [...input.failedCases];
  if (overallScore < minOverallScore) {
    failedCases.push(safeFailure("REVIEW_SCORE_BELOW_THRESHOLD", "Review comparison score is below threshold.", "overallScore"));
  }
  for (const criterion of failedCriteria) {
    if (["noFalseGoalClaim", "framingSafety", "aspectRatioCorrectness"].includes(criterion.metric)) {
      failedCases.push(safeFailure("REVIEW_CRITICAL_METRIC_FAILED", `${criterion.metric} failed its minimum.`, criterion.metric));
    }
  }
  const passed = failedCases.length === 0 && failedCriteria.length === 0 && overallScore >= minOverallScore;
  const report = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    generatedAt: timestamp,
    command: "npm run review:compare",
    phase: "real_video_review_comparison",
    status: passed ? "passed" : "failed",
    passed,
    skipped: false,
    threshold: minOverallScore,
    input: {
      id: input.id,
      title: input.title,
      language: input.language,
      consent: {
        rightsConfirmed: input.consent.rightsConfirmed,
        reviewPurpose: input.consent.reviewPurpose,
        source: input.consent.source,
      },
      media: {
        generated: publicMediaSummary(input.media.generated),
        source: publicMediaSummary(input.media.source),
        reference: publicMediaSummary(input.media.reference),
      },
      referenceMode: input.media.reference.present ? "reference_video" : "reference_style_rubric",
    },
    expected: {
      styleTarget: input.expected.styleTarget,
      stylePreset: input.expected.stylePreset,
      momentType: input.expected.momentType,
      acceptedMomentTypes: input.expected.acceptedMomentTypes,
      selectedMomentWindow: input.expected.selectedMomentWindow,
      aspectRatio: input.expected.aspectRatio,
      durationRange: input.expected.durationRange,
      requiredAnimationCues: input.expected.requiredAnimationCues,
      captionMustMentionAny: input.expected.captionMustMentionAny,
      safety: input.expected.safety,
    },
    actual: {
      selectedMoment: {
        start: selectedMoment.start,
        end: selectedMoment.end,
        momentType: selectedMoment.momentType,
        reasonCodes: selectedMoment.reasonCodes,
        retentionScore: selectedMoment.retentionScore,
      },
      editPlan: {
        sourceStart: editPlan.sourceStart,
        sourceEnd: editPlan.sourceEnd,
        aspectRatio: editPlan.aspectRatio,
        stylePreset: sanitizeReportText(editPlan.stylePreset, 80),
        styleTarget: sanitizeReportText(editPlan.styleTarget, 80),
        highlightType: sanitizeReportText(editPlan.highlightType, 80),
        framingMode: sanitizeReportText(editPlan.framingMode, 80),
        captionCount: normalizeCaptions(editPlan).length,
        captionRoles: normalizeCaptions(editPlan).map((caption) => sanitizeReportText(caption.role, 80)),
        captionTexts: normalizeCaptions(editPlan).map((caption) => sanitizeReportText(caption.text, 120)),
        animationCueTypes: normalizeAnimationCueTypes(editPlan),
      },
    },
    metrics: {
      ...metrics,
      overallScore,
    },
    humanReview: input.humanReview.present && input.humanReview.ok
      ? {
          present: true,
          reviewer: input.humanReview.review.reviewer,
          reviewedAt: input.humanReview.review.reviewedAt,
          selectedMomentCorrect: input.humanReview.review.selectedMomentCorrect,
          captionMatchesAction: input.humanReview.review.captionMatchesAction,
          ballPlayerVisible: input.humanReview.review.ballPlayerVisible,
          textObstructsAction: input.humanReview.review.textObstructsAction,
          animationFeelsReferenceLike: input.humanReview.review.animationFeelsReferenceLike,
          falseClaim: input.humanReview.review.falseClaim,
          notes: input.humanReview.review.notes,
        }
      : {
          present: input.humanReview.present,
          status: input.humanReview.present ? "invalid" : "pending_human_review",
        },
    failedCriteria,
    failedCases,
    debuggingNotes: debuggingNotes(metrics, failedCriteria, input),
    artifacts: {
      logsDownloaded: false,
      artifactsDownloaded: false,
      rawProviderOutputIncluded: false,
      trainingDataMutation: false,
    },
    nextAction: passed
      ? "Use this review sample as product-quality evidence, then keep comparing against real operator references."
      : "Inspect failed criteria, fix forward, and rerun npm run review:compare.",
  };
  const leak = findReviewSensitiveLeak(report);
  if (leak) {
    report.status = "failed";
    report.passed = false;
    report.failedCases.push({
      code: "REVIEW_REPORT_LEAK_GUARD",
      message: "Review comparison report contained unsafe data.",
      leakCode: leak.code,
      leakPath: leak.path,
    });
    report.nextAction = "Remove unsafe report data and rerun npm run review:compare.";
  }
  return report;
}

function minimumForMetric(key) {
  const thresholds = {
    momentTypeMatch: 1,
    noFalseGoalClaim: 1,
    captionActionAlignment: 0.8,
    captionSpecificity: 0.75,
    framingSafety: 1,
    aspectRatioCorrectness: 1,
    pacingScore: 0.75,
    animationCueCoverage: 0.75,
    referenceStyleSimilarity: 0.78,
    reviewerReadinessScore: 0.75,
  };
  return thresholds[key] ?? 0.75;
}

function metricDebugNote(key) {
  const notes = {
    momentTypeMatch: "Generated moment type does not match the expected football action.",
    noFalseGoalClaim: "The output includes a goal claim without explicit goal evidence.",
    captionActionAlignment: "Captions do not mention the expected visible action.",
    captionSpecificity: "Captions are too generic for the selected moment.",
    framingSafety: "Framing metadata or human review indicates ball/player visibility risk.",
    aspectRatioCorrectness: "The output is not using the expected review aspect ratio.",
    pacingScore: "Selected duration is outside the expected short-form pacing range.",
    animationCueCoverage: "Reference-style animation cue coverage is incomplete.",
    referenceStyleSimilarity: "The generated result is not close enough to the target style.",
    reviewerReadinessScore: "The sample is missing enough metadata or human review readiness.",
  };
  return notes[key] || "Metric is below the review threshold.";
}

function debuggingNotes(metrics, failedCriteria, input) {
  if (!failedCriteria.length && input.failedCases.length === 0) {
    return ["Review comparison passed. Keep collecting real generated/reference samples."];
  }
  return [...new Set(failedCriteria.map((item) => item.note).concat(input.failedCases.map((item) => item.message)))].slice(0, 12);
}

function findReviewSensitiveLeak(value, state = {}) {
  const path = state.path || "$";
  const depth = state.depth || 0;
  const seen = state.seen || new WeakSet();
  if (value === null || value === undefined || depth > 12) return null;
  if (typeof value === "string") {
    if (/\/Users\/|\/private\/|file:\/\/|Bearer\s+|gh[pousr]_|github_pat_|OPENAI_API_KEY|storageKey/i.test(value)) {
      return { code: "SENSITIVE_VALUE", path };
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const leak = findReviewSensitiveLeak(value[index], { path: `${path}[${index}]`, depth: depth + 1, seen });
      if (leak) return leak;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["path", "absolutepath", "localpath", "storagekey", "token", "secret", "rawlogs", "rawerror", "stdout", "stderr"].includes(normalized)) {
      return { code: "UNSAFE_KEY", path: `${path}.${key}` };
    }
    const leak = findReviewSensitiveLeak(item, { path: `${path}.${key}`, depth: depth + 1, seen });
    if (leak) return leak;
  }
  return null;
}

function safeTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function safeWriteReportFile(filePath, payload) {
  if (existsSync(filePath)) {
    try {
      renameSync(filePath, `${filePath}.previous-${Date.now()}`);
    } catch {
      // The write below will surface the real filesystem failure.
    }
  }
  writeFileSync(filePath, payload, "utf8");
}

function writeReviewComparisonReport(report, resultsDir, rootDir = process.cwd()) {
  const outputRef = safeRelativeRef(rootDir, resultsDir, "resultsDir");
  if (!outputRef.ok) {
    throw new AppError("VALIDATION_ERROR", "Review results directory is unsafe.", 400);
  }
  mkdirSync(outputRef.resolvedFile, { recursive: true });
  const latestRef = safeRelativeRef(rootDir, join(resultsDir, "review-latest.json"), "resultsDir.latest");
  const timestampedRef = safeRelativeRef(rootDir, join(resultsDir, `review-comparison-${safeTimestamp(report.generatedAt)}.json`), "resultsDir.timestamped");
  if (!latestRef.ok || !timestampedRef.ok) {
    throw new AppError("VALIDATION_ERROR", "Review report path is unsafe.", 400);
  }
  const leak = findReviewSensitiveLeak(report);
  const payloadReport = leak
    ? {
        schemaVersion: REVIEW_SCHEMA_VERSION,
        generatedAt: report.generatedAt || new Date().toISOString(),
        command: "npm run review:compare",
        phase: "real_video_review_comparison",
        status: "failed",
        passed: false,
        skipped: false,
        failedCases: [{
          code: "REVIEW_REPORT_LEAK_GUARD",
          message: "Review comparison report contained unsafe data and was not written.",
          leakCode: leak.code,
          leakPath: leak.path,
        }],
      }
    : report;
  const payload = `${JSON.stringify(payloadReport, null, 2)}\n`;
  safeWriteReportFile(latestRef.resolvedFile, payload);
  safeWriteReportFile(timestampedRef.resolvedFile, payload);
  return {
    latestPath: latestRef.relativePath,
    reportPath: timestampedRef.relativePath,
    report: payloadReport,
  };
}

function runReviewComparison({
  inputPath,
  rootDir = process.cwd(),
  resultsDir = "eval/review-results",
  minOverallScore,
  timestamp,
  write = true,
} = {}) {
  if (!inputPath) throw new AppError("VALIDATION_ERROR", "Review comparison input path is required.", 400);
  const inputRef = safeRelativeRef(rootDir, inputPath, "inputPath");
  if (!inputRef.ok) throw new AppError("VALIDATION_ERROR", inputRef.failure.message, 400);
  const input = loadReviewInput(inputRef.resolvedFile, { rootDir });
  const report = buildReviewComparisonReport(input, {
    minOverallScore: minOverallScore === undefined ? input.expected.threshold : Number(minOverallScore),
    timestamp,
  });
  const output = write ? writeReviewComparisonReport(report, resultsDir, rootDir) : null;
  return { input, report, output };
}

function loadReviewReports(resultsDir) {
  if (!resultsDir || !existsSync(resultsDir)) return [];
  return readdirSync(resultsDir)
    .filter((file) => /^review-comparison-.*\.json$/.test(file) || file === "review-latest.json")
    .sort()
    .map((file) => JSON.parse(readFileSync(join(resultsDir, file), "utf8")));
}

function buildReviewSummaryReport({ reports, timestamp = new Date().toISOString() } = {}) {
  const safeReports = (Array.isArray(reports) ? reports : []).filter((report) => report && report.phase === "real_video_review_comparison");
  const uniqueById = new Map();
  for (const report of safeReports) {
    uniqueById.set(report.input && report.input.id || report.generatedAt, report);
  }
  const items = [...uniqueById.values()];
  const count = items.length || 1;
  const avg = (selector) => round(items.reduce((sum, item) => sum + selector(item), 0) / count);
  const failedCases = items
    .filter((item) => !item.passed)
    .map((item) => ({
      id: item.input && item.input.id,
      overallScore: item.metrics && item.metrics.overallScore,
      failedCriteria: item.failedCriteria || [],
    }));
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    generatedAt: timestamp,
    command: "npm run review:summary",
    phase: "real_video_review_summary",
    status: failedCases.length ? "failed" : "passed",
    passed: failedCases.length === 0,
    skipped: false,
    aggregate: {
      sampleCount: items.length,
      passRate: avg((item) => (item.passed ? 1 : 0)),
      overallScore: Math.round(items.reduce((sum, item) => sum + toNumber(item.metrics && item.metrics.overallScore, 0), 0) / count),
      momentTypeMatch: avg((item) => toNumber(item.metrics && item.metrics.momentTypeMatch, 0)),
      noFalseGoalClaim: avg((item) => toNumber(item.metrics && item.metrics.noFalseGoalClaim, 0)),
      captionActionAlignment: avg((item) => toNumber(item.metrics && item.metrics.captionActionAlignment, 0)),
      framingSafety: avg((item) => toNumber(item.metrics && item.metrics.framingSafety, 0)),
      referenceStyleSimilarity: avg((item) => toNumber(item.metrics && item.metrics.referenceStyleSimilarity, 0)),
    },
    failedCases,
    suggestedDebuggingNotes: failedCases.length
      ? [...new Set(failedCases.flatMap((item) => item.failedCriteria.map((criterion) => criterion.note)))].slice(0, 12)
      : ["Review summary is clean. Add more real generated/reference samples before turning it into a release gate."],
  };
}

function writeReviewSummaryReport(report, resultsDir, rootDir = process.cwd()) {
  const outputRef = safeRelativeRef(rootDir, resultsDir, "resultsDir");
  if (!outputRef.ok) throw new AppError("VALIDATION_ERROR", "Review summary results directory is unsafe.", 400);
  mkdirSync(outputRef.resolvedFile, { recursive: true });
  const latestRef = safeRelativeRef(rootDir, join(resultsDir, "review-summary-latest.json"), "resultsDir.latest");
  const timestampedRef = safeRelativeRef(rootDir, join(resultsDir, `review-summary-${safeTimestamp(report.generatedAt)}.json`), "resultsDir.timestamped");
  if (!latestRef.ok || !timestampedRef.ok) throw new AppError("VALIDATION_ERROR", "Review summary report path is unsafe.", 400);
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  safeWriteReportFile(latestRef.resolvedFile, payload);
  safeWriteReportFile(timestampedRef.resolvedFile, payload);
  return {
    latestPath: latestRef.relativePath,
    reportPath: timestampedRef.relativePath,
    report,
  };
}

function runReviewSummary({
  rootDir = process.cwd(),
  resultsDir = "eval/review-results",
  timestamp,
  write = true,
} = {}) {
  const resultsRef = safeRelativeRef(rootDir, resultsDir, "resultsDir");
  if (!resultsRef.ok) throw new AppError("VALIDATION_ERROR", "Review results directory is unsafe.", 400);
  const reports = loadReviewReports(resultsRef.resolvedFile);
  const report = buildReviewSummaryReport({ reports, timestamp });
  const output = write ? writeReviewSummaryReport(report, resultsDir, rootDir) : null;
  return { report, output };
}

module.exports = {
  DEFAULT_REVIEW_THRESHOLD,
  REVIEW_SCHEMA_VERSION,
  buildReviewComparisonReport,
  buildReviewSummaryReport,
  findReviewSensitiveLeak,
  loadReviewInput,
  loadReviewReports,
  runReviewComparison,
  runReviewSummary,
  safeRelativeRef,
  validateHumanReview,
  validateReviewInput,
  writeReviewComparisonReport,
  writeReviewSummaryReport,
};
