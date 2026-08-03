const { createHash } = require("node:crypto");

const { AppError } = require("../../errors.cjs");

const SCHEMA_VERSION = 1;
const FORMAT_PROFILE = "bf_viral_micro_v1";
const SELECTION_PROFILE = "motivational_tension_micro_v1";
const RENDER_PROFILE = "bf_editorial_inset_v1";
const SNAPSHOT_GATES_HOURS = Object.freeze([1, 6, 24, 72, 168, 672]);
const DECISION_GATES_HOURS = Object.freeze([24, 72, 168, 672]);
const ANALYTICS_SOURCES = Object.freeze(["youtube_analytics_api", "studio_csv", "manual"]);
const RIGHTS_STATUSES = Object.freeze(["owned", "licensed", "permission_granted"]);
const DECISIONS = Object.freeze(["keep", "change", "retire", "continue_collecting"]);
const SECONDARY_METRICS = Object.freeze([
  "engaged_views_equal_age",
  "average_percentage_viewed",
  "shares_comments_per_1000_engaged",
  "subscribers_per_1000_engaged",
]);
const BASE_METRIC_KEYS = Object.freeze([
  "views",
  "engagedViews",
  "stayedToWatchPercent",
  "averageViewDurationSeconds",
  "averagePercentageViewed",
  "likes",
  "shares",
  "comments",
  "subscribersGained",
]);
const DERIVED_METRIC_KEYS = Object.freeze([
  "sharesPer1000Engaged",
  "commentsPer1000Engaged",
  "subscribersPer1000Engaged",
]);
const COMPLETE_METRIC_KEYS = Object.freeze([
  "engagedViews",
  "stayedToWatchPercent",
  "averagePercentageViewed",
  "shares",
  "comments",
  "subscribersGained",
]);

function fail(field, message = "Growth artifact validation failed.", code = "GROWTH_CONTRACT_INVALID") {
  throw new AppError(code, message, 409, { field });
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function contentHash(value) {
  const body = value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "contentHash"))
    : value;
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field, `${field} must be an object.`);
  return value;
}

function exact(value, keys, field) {
  object(value, field);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${field}.${key}`, `${field} contains an unsupported field.`);
  }
}

function text(value, field, maxLength, options = {}) {
  if (typeof value !== "string" && value !== null && value !== undefined) fail(field, `${field} must be text.`);
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized && options.required !== false) fail(field, `${field} is required.`);
  if (normalized.length > maxLength) fail(field, `${field} is too long.`);
  if (options.pattern && normalized && !options.pattern.test(normalized)) fail(field, `${field} is invalid.`);
  return normalized || (options.nullable ? null : "");
}

function token(value, field, allowed = null) {
  const normalized = text(value, field, 100, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }).toLowerCase();
  if (allowed && !allowed.includes(normalized)) fail(field, `${field} is unsupported.`);
  return normalized;
}

function id(value, field, prefix) {
  return text(value, field, 100, { pattern: new RegExp(`^${prefix}_[A-Za-z0-9-]{4,88}$`) });
}

function hash(value, field) {
  const normalized = text(value, field, 80).toLowerCase().replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(normalized) || normalized === "0".repeat(64)) fail(field, `${field} must be a non-placeholder sha256 hash.`);
  return normalized;
}

function iso(value, field, options = {}) {
  if ((value === null || value === undefined || value === "") && options.nullable) return null;
  const normalized = text(value, field, 40);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) fail(field, `${field} must be an ISO timestamp.`);
  return new Date(milliseconds).toISOString();
}

function number(value, field, min, max, options = {}) {
  if ((value === null || value === undefined || value === "") && options.nullable) return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < min || normalized > max) fail(field, `${field} is out of range.`);
  if (options.integer && !Number.isInteger(normalized)) fail(field, `${field} must be an integer.`);
  return options.integer ? normalized : Number(normalized.toFixed(options.decimals ?? 4));
}

function boolean(value, field) {
  if (typeof value !== "boolean") fail(field, `${field} must be boolean.`);
  return value;
}

function list(value, field, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(field, `${field} has an invalid item count.`);
  return value;
}

function uniqueTextList(value, field, min, max, allowed = null) {
  const normalized = list(value, field, min, max).map((entry, index) => {
    const result = token(entry, `${field}[${index}]`);
    if (allowed && !allowed.includes(result)) fail(`${field}[${index}]`, `${field} contains an unsupported value.`);
    return result;
  });
  if (new Set(normalized).size !== normalized.length) fail(field, `${field} contains duplicates.`);
  return [...normalized].sort();
}

function httpUrl(value, field) {
  const raw = text(value, field, 2048);
  let parsed;
  try { parsed = new URL(raw); } catch { fail(field, `${field} must be a valid URL.`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) fail(field, `${field} must be a public HTTP(S) URL.`);
  parsed.hash = "";
  return parsed.toString();
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function seal(input, normalized, field) {
  const calculated = contentHash(normalized);
  if (input.contentHash !== undefined && hash(input.contentHash, `${field}.contentHash`) !== calculated) {
    fail(`${field}.contentHash`, `${field} seal does not match its body.`, "GROWTH_HASH_MISMATCH");
  }
  return deepFreeze({ ...normalized, contentHash: calculated });
}

function artifactHeader(input, artifactType, field, keys) {
  exact(input, ["schemaVersion", "artifactType", ...keys, "contentHash"], field);
  if (Number(input.schemaVersion) !== SCHEMA_VERSION) fail(`${field}.schemaVersion`);
  if (input.artifactType !== artifactType) fail(`${field}.artifactType`);
}

function assertArtifactLink(declared, artifact, artifactType, field) {
  object(artifact, field);
  if (artifact.artifactType !== artifactType) fail(field, `${field} has the wrong artifact type.`, "GROWTH_LINK_MISMATCH");
  const actual = contentHash(artifact);
  if (hash(artifact.contentHash, `${field}.contentHash`) !== actual || declared !== actual) {
    fail(field, `${field} is stale or does not match the declared hash.`, "GROWTH_LINK_MISMATCH");
  }
}

function durationBucket(seconds) {
  const value = number(seconds, "durationSeconds", 8, 22.5);
  if (value < 13) return "08_12s";
  if (value < 17) return "13_16s";
  return "17_22s";
}

function normalizeSourceAssetManifest(input = {}) {
  artifactHeader(input, "SourceAssetManifest", "sourceAssetManifest", [
    "sourceId", "canonicalUrl", "sourceHash", "speaker", "owner", "rightsStatus",
    "licenseEvidence", "allowedPlatforms", "allowedTransformations", "attributionText",
    "reviewedBy", "reviewedAt", "expiresAt",
  ]);
  const reviewedAt = iso(input.reviewedAt, "sourceAssetManifest.reviewedAt");
  const expiresAt = iso(input.expiresAt, "sourceAssetManifest.expiresAt", { nullable: true });
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(reviewedAt)) fail("sourceAssetManifest.expiresAt");
  const allowedPlatforms = uniqueTextList(input.allowedPlatforms, "sourceAssetManifest.allowedPlatforms", 1, 6);
  if (!allowedPlatforms.includes("youtube")) fail("sourceAssetManifest.allowedPlatforms", "Source rights must include YouTube.");
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "SourceAssetManifest",
    sourceId: id(input.sourceId, "sourceAssetManifest.sourceId", "src"),
    canonicalUrl: httpUrl(input.canonicalUrl, "sourceAssetManifest.canonicalUrl"),
    sourceHash: hash(input.sourceHash, "sourceAssetManifest.sourceHash"),
    speaker: text(input.speaker, "sourceAssetManifest.speaker", 160),
    owner: text(input.owner, "sourceAssetManifest.owner", 160),
    rightsStatus: token(input.rightsStatus, "sourceAssetManifest.rightsStatus", RIGHTS_STATUSES),
    licenseEvidence: text(input.licenseEvidence, "sourceAssetManifest.licenseEvidence", 500),
    allowedPlatforms,
    allowedTransformations: uniqueTextList(input.allowedTransformations, "sourceAssetManifest.allowedTransformations", 1, 12),
    attributionText: text(input.attributionText, "sourceAssetManifest.attributionText", 500),
    reviewedBy: text(input.reviewedBy, "sourceAssetManifest.reviewedBy", 120),
    reviewedAt,
    expiresAt,
  };
  return seal(input, normalized, "sourceAssetManifest");
}

function normalizeCandidateDecision(input = {}, options = {}) {
  artifactHeader(input, "CandidateDecision", "candidateDecision", [
    "decisionId", "sourceManifestHash", "sourceHash", "candidateHash", "selectionProfile",
    "decision", "reviewer", "decidedAt", "notes",
  ]);
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "CandidateDecision",
    decisionId: id(input.decisionId, "candidateDecision.decisionId", "cdec"),
    sourceManifestHash: hash(input.sourceManifestHash, "candidateDecision.sourceManifestHash"),
    sourceHash: hash(input.sourceHash, "candidateDecision.sourceHash"),
    candidateHash: hash(input.candidateHash, "candidateDecision.candidateHash"),
    selectionProfile: token(input.selectionProfile, "candidateDecision.selectionProfile", [SELECTION_PROFILE]),
    decision: token(input.decision, "candidateDecision.decision", ["approved", "rejected"]),
    reviewer: text(input.reviewer, "candidateDecision.reviewer", 120),
    decidedAt: iso(input.decidedAt, "candidateDecision.decidedAt"),
    notes: text(input.notes || "", "candidateDecision.notes", 1000, { required: false }),
  };
  if (options.sourceAssetManifest) {
    const source = normalizeSourceAssetManifest(options.sourceAssetManifest);
    assertArtifactLink(normalized.sourceManifestHash, source, "SourceAssetManifest", "candidateDecision.sourceManifestHash");
    if (normalized.sourceHash !== source.sourceHash) fail("candidateDecision.sourceHash", "Candidate source hash does not match source manifest.", "GROWTH_LINK_MISMATCH");
  }
  return seal(input, normalized, "candidateDecision");
}

function normalizeExperimentManifest(input = {}, options = {}) {
  artifactHeader(input, "ExperimentManifest", "experimentManifest", [
    "manifestId", "experimentId", "cohortId", "treatmentId", "candidateDecisionHash",
    "candidateHash", "hypothesis", "primaryVariable", "pillar", "durationBucket",
    "formatProfile", "selectionProfile", "renderProfile", "language", "artificialCutLimit",
    "uploadCadence", "declaredAt", "decisionDueAt", "snapshotGatesHours",
    "decisionGatesHours", "primaryMetric", "secondaryMetrics", "humanDecisionRequired",
  ]);
  const snapshotGates = list(input.snapshotGatesHours, "experimentManifest.snapshotGatesHours", 6, 6)
    .map((value, index) => number(value, `experimentManifest.snapshotGatesHours[${index}]`, 1, 672, { integer: true }));
  const decisionGates = list(input.decisionGatesHours, "experimentManifest.decisionGatesHours", 4, 4)
    .map((value, index) => number(value, `experimentManifest.decisionGatesHours[${index}]`, 24, 672, { integer: true }));
  if (stableStringify(snapshotGates) !== stableStringify(SNAPSHOT_GATES_HOURS)) fail("experimentManifest.snapshotGatesHours");
  if (stableStringify(decisionGates) !== stableStringify(DECISION_GATES_HOURS)) fail("experimentManifest.decisionGatesHours");
  const declaredAt = iso(input.declaredAt, "experimentManifest.declaredAt");
  const decisionDueAt = iso(input.decisionDueAt, "experimentManifest.decisionDueAt");
  if (Date.parse(decisionDueAt) <= Date.parse(declaredAt)) fail("experimentManifest.decisionDueAt");
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "ExperimentManifest",
    manifestId: id(input.manifestId, "experimentManifest.manifestId", "expm"),
    experimentId: id(input.experimentId, "experimentManifest.experimentId", "exp"),
    cohortId: token(input.cohortId, "experimentManifest.cohortId"),
    treatmentId: token(input.treatmentId, "experimentManifest.treatmentId"),
    candidateDecisionHash: hash(input.candidateDecisionHash, "experimentManifest.candidateDecisionHash"),
    candidateHash: hash(input.candidateHash, "experimentManifest.candidateHash"),
    hypothesis: text(input.hypothesis, "experimentManifest.hypothesis", 500),
    primaryVariable: token(input.primaryVariable, "experimentManifest.primaryVariable"),
    pillar: token(input.pillar, "experimentManifest.pillar"),
    durationBucket: token(input.durationBucket, "experimentManifest.durationBucket", ["08_12s", "13_16s", "17_22s"]),
    formatProfile: token(input.formatProfile, "experimentManifest.formatProfile", [FORMAT_PROFILE]),
    selectionProfile: token(input.selectionProfile, "experimentManifest.selectionProfile", [SELECTION_PROFILE]),
    renderProfile: token(input.renderProfile, "experimentManifest.renderProfile", [RENDER_PROFILE]),
    language: token(input.language, "experimentManifest.language", ["en"]),
    artificialCutLimit: number(input.artificialCutLimit, "experimentManifest.artificialCutLimit", 0, 0, { integer: true }),
    uploadCadence: token(input.uploadCadence, "experimentManifest.uploadCadence", ["one_per_day_five_per_week"]),
    declaredAt,
    decisionDueAt,
    snapshotGatesHours: [...SNAPSHOT_GATES_HOURS],
    decisionGatesHours: [...DECISION_GATES_HOURS],
    primaryMetric: token(input.primaryMetric, "experimentManifest.primaryMetric", ["stayed_to_watch_percentile"]),
    secondaryMetrics: list(input.secondaryMetrics, "experimentManifest.secondaryMetrics", SECONDARY_METRICS.length, SECONDARY_METRICS.length)
      .map((value, index) => token(value, `experimentManifest.secondaryMetrics[${index}]`, SECONDARY_METRICS)),
    humanDecisionRequired: boolean(input.humanDecisionRequired, "experimentManifest.humanDecisionRequired"),
  };
  if (!normalized.humanDecisionRequired) fail("experimentManifest.humanDecisionRequired");
  if (new Set(normalized.secondaryMetrics).size !== SECONDARY_METRICS.length) fail("experimentManifest.secondaryMetrics");
  if (options.candidateDecision) {
    const decision = normalizeCandidateDecision(options.candidateDecision, options);
    assertArtifactLink(normalized.candidateDecisionHash, decision, "CandidateDecision", "experimentManifest.candidateDecisionHash");
    if (decision.decision !== "approved") fail("experimentManifest.candidateDecisionHash", "Experiment candidate must be approved.");
    if (normalized.candidateHash !== decision.candidateHash) fail("experimentManifest.candidateHash", "Experiment candidate hash is stale.", "GROWTH_LINK_MISMATCH");
    if (Date.parse(normalized.declaredAt) < Date.parse(decision.decidedAt)) fail("experimentManifest.declaredAt", "Experiment was declared before candidate approval.");
  }
  return seal(input, normalized, "experimentManifest");
}

function normalizeRenderManifest(input = {}, options = {}) {
  artifactHeader(input, "RenderManifest", "renderManifest", [
    "renderId", "sourceManifestHash", "sourceHash", "candidateDecisionHash", "candidateHash",
    "experimentManifestHash", "editPlanHash", "formatProfile", "selectionProfile", "renderProfile",
    "rendererVersion", "outputHash", "durationSeconds", "delivery", "cuts", "brandTail", "renderedAt",
  ]);
  exact(input.delivery, ["width", "height", "fps", "videoCodec", "audioCodec"], "renderManifest.delivery");
  exact(input.cuts, ["sourceCutCount", "artificialCutCount"], "renderManifest.cuts");
  exact(input.brandTail, ["profile", "durationSeconds"], "renderManifest.brandTail");
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "RenderManifest",
    renderId: id(input.renderId, "renderManifest.renderId", "render"),
    sourceManifestHash: hash(input.sourceManifestHash, "renderManifest.sourceManifestHash"),
    sourceHash: hash(input.sourceHash, "renderManifest.sourceHash"),
    candidateDecisionHash: hash(input.candidateDecisionHash, "renderManifest.candidateDecisionHash"),
    candidateHash: hash(input.candidateHash, "renderManifest.candidateHash"),
    experimentManifestHash: hash(input.experimentManifestHash, "renderManifest.experimentManifestHash"),
    editPlanHash: hash(input.editPlanHash, "renderManifest.editPlanHash"),
    formatProfile: token(input.formatProfile, "renderManifest.formatProfile", [FORMAT_PROFILE]),
    selectionProfile: token(input.selectionProfile, "renderManifest.selectionProfile", [SELECTION_PROFILE]),
    renderProfile: token(input.renderProfile, "renderManifest.renderProfile", [RENDER_PROFILE]),
    rendererVersion: token(input.rendererVersion, "renderManifest.rendererVersion"),
    outputHash: hash(input.outputHash, "renderManifest.outputHash"),
    durationSeconds: number(input.durationSeconds, "renderManifest.durationSeconds", 8, 22.5, { decimals: 3 }),
    delivery: {
      width: number(input.delivery.width, "renderManifest.delivery.width", 1080, 1080, { integer: true }),
      height: number(input.delivery.height, "renderManifest.delivery.height", 1920, 1920, { integer: true }),
      fps: number(input.delivery.fps, "renderManifest.delivery.fps", 30, 30, { decimals: 3 }),
      videoCodec: token(input.delivery.videoCodec, "renderManifest.delivery.videoCodec", ["h264"]),
      audioCodec: token(input.delivery.audioCodec, "renderManifest.delivery.audioCodec", ["aac"]),
    },
    cuts: {
      sourceCutCount: number(input.cuts.sourceCutCount, "renderManifest.cuts.sourceCutCount", 0, 2, { integer: true }),
      artificialCutCount: number(input.cuts.artificialCutCount, "renderManifest.cuts.artificialCutCount", 0, 0, { integer: true }),
    },
    brandTail: {
      profile: token(input.brandTail.profile, "renderManifest.brandTail.profile", ["bf_youtube_tail_v1"]),
      durationSeconds: number(input.brandTail.durationSeconds, "renderManifest.brandTail.durationSeconds", 0.2, 0.4, { decimals: 3 }),
    },
    renderedAt: iso(input.renderedAt, "renderManifest.renderedAt"),
  };
  if (options.sourceAssetManifest) {
    const source = normalizeSourceAssetManifest(options.sourceAssetManifest);
    assertArtifactLink(normalized.sourceManifestHash, source, "SourceAssetManifest", "renderManifest.sourceManifestHash");
    if (normalized.sourceHash !== source.sourceHash) fail("renderManifest.sourceHash", "Render source hash is stale.", "GROWTH_LINK_MISMATCH");
  }
  if (options.candidateDecision) {
    const decision = normalizeCandidateDecision(options.candidateDecision, options);
    assertArtifactLink(normalized.candidateDecisionHash, decision, "CandidateDecision", "renderManifest.candidateDecisionHash");
    if (decision.decision !== "approved" || normalized.candidateHash !== decision.candidateHash) fail("renderManifest.candidateHash", "Render candidate is not the approved candidate.", "GROWTH_LINK_MISMATCH");
  }
  if (options.experimentManifest) {
    const experiment = normalizeExperimentManifest(options.experimentManifest, options);
    assertArtifactLink(normalized.experimentManifestHash, experiment, "ExperimentManifest", "renderManifest.experimentManifestHash");
    for (const key of ["candidateHash", "formatProfile", "selectionProfile", "renderProfile"]) {
      if (normalized[key] !== experiment[key]) fail(`renderManifest.${key}`, `Render ${key} does not match experiment.`, "GROWTH_LINK_MISMATCH");
    }
    if (durationBucket(normalized.durationSeconds) !== experiment.durationBucket) fail("renderManifest.durationSeconds", "Render duration bucket does not match experiment.", "GROWTH_LINK_MISMATCH");
    if (Date.parse(normalized.renderedAt) < Date.parse(experiment.declaredAt)) fail("renderManifest.renderedAt", "Render predates experiment declaration.");
  }
  return seal(input, normalized, "renderManifest");
}

function normalizeCreativeQa(input = {}, options = {}) {
  artifactHeader(input, "CreativeQa", "creativeQa", [
    "qaId", "renderManifestHash", "sourceManifestHash", "candidateHash", "hookLatencySeconds",
    "semanticClosurePassed", "titleAlignmentScore", "similarityScore", "similarityThreshold",
    "originalityPassed", "rightsPassed", "policyPassed", "technicalPassed", "artificialCutCount",
    "passed", "failedGates", "reviewer", "checkedAt",
  ]);
  const failedGates = list(input.failedGates, "creativeQa.failedGates", 0, 20)
    .map((entry, index) => token(entry, `creativeQa.failedGates[${index}]`));
  if (new Set(failedGates).size !== failedGates.length) fail("creativeQa.failedGates");
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "CreativeQa",
    qaId: id(input.qaId, "creativeQa.qaId", "cqa"),
    renderManifestHash: hash(input.renderManifestHash, "creativeQa.renderManifestHash"),
    sourceManifestHash: hash(input.sourceManifestHash, "creativeQa.sourceManifestHash"),
    candidateHash: hash(input.candidateHash, "creativeQa.candidateHash"),
    hookLatencySeconds: number(input.hookLatencySeconds, "creativeQa.hookLatencySeconds", 0, 60, { decimals: 3 }),
    semanticClosurePassed: boolean(input.semanticClosurePassed, "creativeQa.semanticClosurePassed"),
    titleAlignmentScore: number(input.titleAlignmentScore, "creativeQa.titleAlignmentScore", 0, 100),
    similarityScore: number(input.similarityScore, "creativeQa.similarityScore", 0, 1),
    similarityThreshold: number(input.similarityThreshold, "creativeQa.similarityThreshold", 0, 1),
    originalityPassed: boolean(input.originalityPassed, "creativeQa.originalityPassed"),
    rightsPassed: boolean(input.rightsPassed, "creativeQa.rightsPassed"),
    policyPassed: boolean(input.policyPassed, "creativeQa.policyPassed"),
    technicalPassed: boolean(input.technicalPassed, "creativeQa.technicalPassed"),
    artificialCutCount: number(input.artificialCutCount, "creativeQa.artificialCutCount", 0, 100, { integer: true }),
    passed: boolean(input.passed, "creativeQa.passed"),
    failedGates: [...failedGates].sort(),
    reviewer: text(input.reviewer, "creativeQa.reviewer", 120),
    checkedAt: iso(input.checkedAt, "creativeQa.checkedAt"),
  };
  const calculatedPass = normalized.hookLatencySeconds <= 0.25
    && normalized.semanticClosurePassed
    && normalized.titleAlignmentScore >= 80
    && normalized.similarityScore <= normalized.similarityThreshold
    && normalized.originalityPassed
    && normalized.rightsPassed
    && normalized.policyPassed
    && normalized.technicalPassed
    && normalized.artificialCutCount === 0;
  if (normalized.passed !== calculatedPass) fail("creativeQa.passed", "Creative QA pass state does not match its gates.");
  if (calculatedPass && normalized.failedGates.length) fail("creativeQa.failedGates");
  if (!calculatedPass && !normalized.failedGates.length) fail("creativeQa.failedGates", "Failed creative QA requires failure codes.");
  if (options.renderManifest) {
    const render = normalizeRenderManifest(options.renderManifest, options);
    assertArtifactLink(normalized.renderManifestHash, render, "RenderManifest", "creativeQa.renderManifestHash");
    if (normalized.candidateHash !== render.candidateHash || normalized.sourceManifestHash !== render.sourceManifestHash) fail("creativeQa.candidateHash", "Creative QA is not bound to this render.", "GROWTH_LINK_MISMATCH");
    if (Date.parse(normalized.checkedAt) < Date.parse(render.renderedAt)) fail("creativeQa.checkedAt", "Creative QA predates the render.");
  }
  return seal(input, normalized, "creativeQa");
}

function normalizePublishMetadata(input) {
  exact(input, ["title", "description", "tags", "aiGeneratedDisclosure", "relatedVideoId", "relatedVideoWaiverReason"], "publishManifest.metadata");
  const relatedVideoId = text(input.relatedVideoId || "", "publishManifest.metadata.relatedVideoId", 40, { required: false, nullable: true });
  const waiver = text(input.relatedVideoWaiverReason || "", "publishManifest.metadata.relatedVideoWaiverReason", 300, { required: false, nullable: true });
  if (!relatedVideoId && !waiver) fail("publishManifest.metadata.relatedVideoId", "A related video or documented waiver is required.");
  return {
    title: text(input.title, "publishManifest.metadata.title", 100),
    description: text(input.description, "publishManifest.metadata.description", 5000),
    tags: list(input.tags, "publishManifest.metadata.tags", 0, 15).map((entry, index) => text(entry, `publishManifest.metadata.tags[${index}]`, 60)),
    aiGeneratedDisclosure: boolean(input.aiGeneratedDisclosure, "publishManifest.metadata.aiGeneratedDisclosure"),
    relatedVideoId,
    relatedVideoWaiverReason: waiver,
  };
}

function normalizePublishManifest(input = {}, options = {}) {
  artifactHeader(input, "PublishManifest", "publishManifest", [
    "publishId", "sourceManifestHash", "sourceHash", "candidateDecisionHash", "candidateHash",
    "experimentManifestHash", "renderManifestHash", "creativeQaHash", "outputHash",
    "expectedChannelId", "expectedChannelHandle", "metadata", "privacyStatus",
    "idempotencyKeyHash", "approvedBy", "approvedAt", "requestedAt",
  ]);
  const expectedChannelId = text(input.expectedChannelId || "", "publishManifest.expectedChannelId", 80, { required: false, nullable: true });
  const expectedChannelHandle = text(input.expectedChannelHandle || "", "publishManifest.expectedChannelHandle", 80, { required: false, nullable: true });
  if (!expectedChannelId && !expectedChannelHandle) fail("publishManifest.expectedChannelId", "An expected YouTube channel is required.");
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "PublishManifest",
    publishId: id(input.publishId, "publishManifest.publishId", "pubm"),
    sourceManifestHash: hash(input.sourceManifestHash, "publishManifest.sourceManifestHash"),
    sourceHash: hash(input.sourceHash, "publishManifest.sourceHash"),
    candidateDecisionHash: hash(input.candidateDecisionHash, "publishManifest.candidateDecisionHash"),
    candidateHash: hash(input.candidateHash, "publishManifest.candidateHash"),
    experimentManifestHash: hash(input.experimentManifestHash, "publishManifest.experimentManifestHash"),
    renderManifestHash: hash(input.renderManifestHash, "publishManifest.renderManifestHash"),
    creativeQaHash: hash(input.creativeQaHash, "publishManifest.creativeQaHash"),
    outputHash: hash(input.outputHash, "publishManifest.outputHash"),
    expectedChannelId,
    expectedChannelHandle,
    metadata: normalizePublishMetadata(input.metadata),
    privacyStatus: token(input.privacyStatus, "publishManifest.privacyStatus", ["private", "unlisted", "public"]),
    idempotencyKeyHash: hash(input.idempotencyKeyHash, "publishManifest.idempotencyKeyHash"),
    approvedBy: text(input.approvedBy, "publishManifest.approvedBy", 120),
    approvedAt: iso(input.approvedAt, "publishManifest.approvedAt"),
    requestedAt: iso(input.requestedAt, "publishManifest.requestedAt"),
  };
  if (Date.parse(normalized.requestedAt) < Date.parse(normalized.approvedAt)) fail("publishManifest.requestedAt");
  let source;
  let decision;
  let experiment;
  let render;
  let qa;
  if (options.sourceAssetManifest) {
    source = normalizeSourceAssetManifest(options.sourceAssetManifest);
    assertArtifactLink(normalized.sourceManifestHash, source, "SourceAssetManifest", "publishManifest.sourceManifestHash");
    if (normalized.sourceHash !== source.sourceHash) fail("publishManifest.sourceHash", "Publish source hash does not match source rights.", "GROWTH_LINK_MISMATCH");
    if (!source.allowedPlatforms.includes("youtube")) fail("publishManifest.sourceManifestHash");
    if (Date.parse(source.reviewedAt) > Date.parse(normalized.requestedAt)) fail("publishManifest.sourceManifestHash", "Source rights review is newer than the publish request.");
    if (source.expiresAt && Date.parse(source.expiresAt) <= Date.parse(normalized.requestedAt)) fail("publishManifest.sourceManifestHash", "Source rights have expired.");
  }
  if (options.candidateDecision) {
    decision = normalizeCandidateDecision(options.candidateDecision, options);
    assertArtifactLink(normalized.candidateDecisionHash, decision, "CandidateDecision", "publishManifest.candidateDecisionHash");
    if (decision.decision !== "approved" || normalized.candidateHash !== decision.candidateHash) fail("publishManifest.candidateHash", "Publish candidate is not approved.", "GROWTH_LINK_MISMATCH");
  }
  if (options.experimentManifest) {
    experiment = normalizeExperimentManifest(options.experimentManifest, options);
    assertArtifactLink(normalized.experimentManifestHash, experiment, "ExperimentManifest", "publishManifest.experimentManifestHash");
    if (normalized.candidateHash !== experiment.candidateHash) fail("publishManifest.candidateHash", "Publish experiment candidate is stale.", "GROWTH_LINK_MISMATCH");
  }
  if (options.renderManifest) {
    render = normalizeRenderManifest(options.renderManifest, options);
    assertArtifactLink(normalized.renderManifestHash, render, "RenderManifest", "publishManifest.renderManifestHash");
    for (const key of ["sourceManifestHash", "sourceHash", "candidateDecisionHash", "candidateHash", "experimentManifestHash", "outputHash"]) {
      if (normalized[key] !== render[key]) fail(`publishManifest.${key}`, `Publish ${key} does not match render.`, "GROWTH_LINK_MISMATCH");
    }
  }
  if (options.creativeQa) {
    qa = normalizeCreativeQa(options.creativeQa, options);
    assertArtifactLink(normalized.creativeQaHash, qa, "CreativeQa", "publishManifest.creativeQaHash");
    if (!qa.passed || (render && qa.renderManifestHash !== render.contentHash)) fail("publishManifest.creativeQaHash", "Publishing requires passing QA bound to the render.");
    if (Date.parse(normalized.approvedAt) < Date.parse(qa.checkedAt)) fail("publishManifest.approvedAt", "Publish approval predates creative QA.");
  }
  return seal(input, normalized, "publishManifest");
}

function normalizePublishReceipt(input = {}, options = {}) {
  artifactHeader(input, "PublishReceipt", "publishReceipt", [
    "receiptId", "publishManifestHash", "sourceManifestHash", "sourceHash", "candidateHash",
    "experimentManifestHash", "renderManifestHash", "outputHash", "idempotencyKeyHash",
    "youtubeVideoId", "channelId", "channelHandle", "privacyStatus", "responseState", "publishedAt",
  ]);
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "PublishReceipt",
    receiptId: id(input.receiptId, "publishReceipt.receiptId", "receipt"),
    publishManifestHash: hash(input.publishManifestHash, "publishReceipt.publishManifestHash"),
    sourceManifestHash: hash(input.sourceManifestHash, "publishReceipt.sourceManifestHash"),
    sourceHash: hash(input.sourceHash, "publishReceipt.sourceHash"),
    candidateHash: hash(input.candidateHash, "publishReceipt.candidateHash"),
    experimentManifestHash: hash(input.experimentManifestHash, "publishReceipt.experimentManifestHash"),
    renderManifestHash: hash(input.renderManifestHash, "publishReceipt.renderManifestHash"),
    outputHash: hash(input.outputHash, "publishReceipt.outputHash"),
    idempotencyKeyHash: hash(input.idempotencyKeyHash, "publishReceipt.idempotencyKeyHash"),
    youtubeVideoId: text(input.youtubeVideoId, "publishReceipt.youtubeVideoId", 32, { pattern: /^[A-Za-z0-9_-]{6,32}$/ }),
    channelId: text(input.channelId, "publishReceipt.channelId", 80),
    channelHandle: text(input.channelHandle || "", "publishReceipt.channelHandle", 80, { required: false, nullable: true }),
    privacyStatus: token(input.privacyStatus, "publishReceipt.privacyStatus", ["private", "unlisted", "public"]),
    responseState: token(input.responseState, "publishReceipt.responseState", ["uploaded", "scheduled", "published"]),
    publishedAt: iso(input.publishedAt, "publishReceipt.publishedAt"),
  };
  if (options.publishManifest) {
    const manifest = normalizePublishManifest(options.publishManifest, options);
    assertArtifactLink(normalized.publishManifestHash, manifest, "PublishManifest", "publishReceipt.publishManifestHash");
    for (const key of ["sourceManifestHash", "sourceHash", "candidateHash", "experimentManifestHash", "renderManifestHash", "outputHash", "idempotencyKeyHash", "privacyStatus"]) {
      if (normalized[key] !== manifest[key]) fail(`publishReceipt.${key}`, `Publish receipt ${key} does not match request.`, "GROWTH_LINK_MISMATCH");
    }
    if (manifest.expectedChannelId && normalized.channelId !== manifest.expectedChannelId) fail("publishReceipt.channelId", "Publisher authenticated the wrong channel.", "GROWTH_LINK_MISMATCH");
    if (manifest.expectedChannelHandle && normalized.channelHandle !== manifest.expectedChannelHandle) fail("publishReceipt.channelHandle", "Publisher authenticated the wrong handle.", "GROWTH_LINK_MISMATCH");
    if (Date.parse(normalized.publishedAt) < Date.parse(manifest.requestedAt)) fail("publishReceipt.publishedAt", "Publish receipt predates its request.");
  }
  return seal(input, normalized, "publishReceipt");
}

function nearestSnapshotGate(ageHours) {
  const age = number(ageHours, "videoAgeHours", 0, 10000);
  const matches = SNAPSHOT_GATES_HOURS.filter((gate) => Math.abs(age - gate) <= Math.max(0.5, gate * 0.2));
  if (!matches.length) return null;
  return matches.sort((left, right) => Math.abs(age - left) - Math.abs(age - right))[0];
}

function normalizeMetrics(input) {
  exact(input, [...BASE_METRIC_KEYS, ...DERIVED_METRIC_KEYS], "analyticsSnapshot.metrics");
  const integerKeys = new Set(["views", "engagedViews", "likes", "shares", "comments", "subscribersGained"]);
  const normalized = {};
  for (const key of BASE_METRIC_KEYS) {
    const max = key === "stayedToWatchPercent" ? 100 : key === "averagePercentageViewed" ? 500 : Number.MAX_SAFE_INTEGER;
    normalized[key] = number(input[key], `analyticsSnapshot.metrics.${key}`, 0, max, {
      integer: integerKeys.has(key),
      nullable: true,
      decimals: 6,
    });
  }
  if (!BASE_METRIC_KEYS.some((key) => normalized[key] !== null)) fail("analyticsSnapshot.metrics", "At least one analytics metric is required.");
  const engaged = normalized.engagedViews;
  const rate = (key) => engaged === null || normalized[key] === null
    ? null
    : Number((normalized[key] * 1000 / Math.max(1, engaged)).toFixed(6));
  const derived = {
    sharesPer1000Engaged: rate("shares"),
    commentsPer1000Engaged: rate("comments"),
    subscribersPer1000Engaged: rate("subscribersGained"),
  };
  for (const key of DERIVED_METRIC_KEYS) {
    if (input[key] !== undefined && input[key] !== null && Number(input[key]) !== derived[key]) fail(`analyticsSnapshot.metrics.${key}`, "Derived analytics rate is inconsistent.");
  }
  return { ...normalized, ...derived };
}

function normalizeAnalyticsSnapshot(input = {}, options = {}) {
  artifactHeader(input, "AnalyticsSnapshot", "analyticsSnapshot", [
    "snapshotId", "publishReceiptHash", "publishManifestHash", "experimentManifestHash",
    "videoId", "publishedAt", "observedAt", "videoAgeHours", "snapshotGateHours",
    "decisionEligible", "source", "experimentId", "cohortId", "treatmentId", "pillar",
    "formatProfile", "selectionProfile", "renderProfile", "durationSeconds", "durationBucket",
    "metrics", "completeness", "completeForPrimaryDecision",
  ]);
  const publishedAt = iso(input.publishedAt, "analyticsSnapshot.publishedAt");
  const observedAt = iso(input.observedAt, "analyticsSnapshot.observedAt");
  const ageHours = Number(((Date.parse(observedAt) - Date.parse(publishedAt)) / 3600000).toFixed(4));
  if (ageHours < 0) fail("analyticsSnapshot.observedAt", "Snapshot predates publication.");
  const gate = nearestSnapshotGate(ageHours);
  if (gate === null) fail("analyticsSnapshot.snapshotGateHours", "Snapshot is outside every declared equal-age gate.");
  if (Number(input.snapshotGateHours) !== gate) fail("analyticsSnapshot.snapshotGateHours", "Snapshot gate does not match observed video age.");
  if (input.videoAgeHours !== undefined && Number(input.videoAgeHours) !== ageHours) fail("analyticsSnapshot.videoAgeHours");
  const metrics = normalizeMetrics(input.metrics);
  exact(input.completeness, BASE_METRIC_KEYS, "analyticsSnapshot.completeness");
  const completeness = Object.fromEntries(BASE_METRIC_KEYS.map((key) => [key, metrics[key] !== null]));
  for (const key of BASE_METRIC_KEYS) {
    if (input.completeness[key] !== completeness[key]) fail(`analyticsSnapshot.completeness.${key}`);
  }
  const completeForPrimaryDecision = COMPLETE_METRIC_KEYS.every((key) => completeness[key]);
  if (input.completeForPrimaryDecision !== completeForPrimaryDecision) fail("analyticsSnapshot.completeForPrimaryDecision");
  const durationSeconds = number(input.durationSeconds, "analyticsSnapshot.durationSeconds", 8, 22.5, { decimals: 3 });
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "AnalyticsSnapshot",
    snapshotId: id(input.snapshotId, "analyticsSnapshot.snapshotId", "snap"),
    publishReceiptHash: hash(input.publishReceiptHash, "analyticsSnapshot.publishReceiptHash"),
    publishManifestHash: hash(input.publishManifestHash, "analyticsSnapshot.publishManifestHash"),
    experimentManifestHash: hash(input.experimentManifestHash, "analyticsSnapshot.experimentManifestHash"),
    videoId: text(input.videoId, "analyticsSnapshot.videoId", 32, { pattern: /^[A-Za-z0-9_-]{6,32}$/ }),
    publishedAt,
    observedAt,
    videoAgeHours: ageHours,
    snapshotGateHours: gate,
    decisionEligible: DECISION_GATES_HOURS.includes(gate),
    source: token(input.source, "analyticsSnapshot.source", ANALYTICS_SOURCES),
    experimentId: id(input.experimentId, "analyticsSnapshot.experimentId", "exp"),
    cohortId: token(input.cohortId, "analyticsSnapshot.cohortId"),
    treatmentId: token(input.treatmentId, "analyticsSnapshot.treatmentId"),
    pillar: token(input.pillar, "analyticsSnapshot.pillar"),
    formatProfile: token(input.formatProfile, "analyticsSnapshot.formatProfile", [FORMAT_PROFILE]),
    selectionProfile: token(input.selectionProfile, "analyticsSnapshot.selectionProfile", [SELECTION_PROFILE]),
    renderProfile: token(input.renderProfile, "analyticsSnapshot.renderProfile", [RENDER_PROFILE]),
    durationSeconds,
    durationBucket: durationBucket(durationSeconds),
    metrics,
    completeness,
    completeForPrimaryDecision,
  };
  if (input.decisionEligible !== normalized.decisionEligible) fail("analyticsSnapshot.decisionEligible");
  if (input.durationBucket !== normalized.durationBucket) fail("analyticsSnapshot.durationBucket");
  if (options.publishReceipt) {
    const receipt = normalizePublishReceipt(options.publishReceipt, options);
    assertArtifactLink(normalized.publishReceiptHash, receipt, "PublishReceipt", "analyticsSnapshot.publishReceiptHash");
    if (normalized.videoId !== receipt.youtubeVideoId || normalized.publishManifestHash !== receipt.publishManifestHash || normalized.experimentManifestHash !== receipt.experimentManifestHash || normalized.publishedAt !== receipt.publishedAt) {
      fail("analyticsSnapshot.publishReceiptHash", "Analytics snapshot is not bound to the publish receipt.", "GROWTH_LINK_MISMATCH");
    }
  }
  if (options.experimentManifest) {
    const experiment = normalizeExperimentManifest(options.experimentManifest, options);
    assertArtifactLink(normalized.experimentManifestHash, experiment, "ExperimentManifest", "analyticsSnapshot.experimentManifestHash");
    for (const key of ["experimentId", "cohortId", "treatmentId", "pillar", "durationBucket", "formatProfile", "selectionProfile", "renderProfile"]) {
      if (normalized[key] !== experiment[key]) fail(`analyticsSnapshot.${key}`, `Analytics ${key} does not match experiment.`, "GROWTH_LINK_MISMATCH");
    }
  }
  return seal(input, normalized, "analyticsSnapshot");
}

function normalizeExperimentDecision(input = {}, options = {}) {
  artifactHeader(input, "ExperimentDecision", "experimentDecision", [
    "decisionId", "experimentId", "experimentManifestHashes", "evaluationHash",
    "snapshotGateHours", "equalAgeComparison", "metricRule", "decision", "winnerCohortId",
    "humanApproved", "approver", "approvedAt", "notes", "profileMutationApplied",
  ]);
  const experimentManifestHashes = list(input.experimentManifestHashes, "experimentDecision.experimentManifestHashes", 1, 100)
    .map((value, index) => hash(value, `experimentDecision.experimentManifestHashes[${index}]`));
  if (new Set(experimentManifestHashes).size !== experimentManifestHashes.length) fail("experimentDecision.experimentManifestHashes");
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    artifactType: "ExperimentDecision",
    decisionId: id(input.decisionId, "experimentDecision.decisionId", "exd"),
    experimentId: id(input.experimentId, "experimentDecision.experimentId", "exp"),
    experimentManifestHashes: [...experimentManifestHashes].sort(),
    evaluationHash: hash(input.evaluationHash, "experimentDecision.evaluationHash"),
    snapshotGateHours: number(input.snapshotGateHours, "experimentDecision.snapshotGateHours", 24, 672, { integer: true }),
    equalAgeComparison: boolean(input.equalAgeComparison, "experimentDecision.equalAgeComparison"),
    metricRule: token(input.metricRule, "experimentDecision.metricRule", ["median"]),
    decision: token(input.decision, "experimentDecision.decision", DECISIONS),
    winnerCohortId: text(input.winnerCohortId || "", "experimentDecision.winnerCohortId", 100, { required: false, nullable: true }),
    humanApproved: boolean(input.humanApproved, "experimentDecision.humanApproved"),
    approver: text(input.approver, "experimentDecision.approver", 120),
    approvedAt: iso(input.approvedAt, "experimentDecision.approvedAt"),
    notes: text(input.notes || "", "experimentDecision.notes", 1000, { required: false }),
    profileMutationApplied: boolean(input.profileMutationApplied, "experimentDecision.profileMutationApplied"),
  };
  if (!DECISION_GATES_HOURS.includes(normalized.snapshotGateHours)) fail("experimentDecision.snapshotGateHours");
  if (!normalized.equalAgeComparison || !normalized.humanApproved || normalized.profileMutationApplied) fail("experimentDecision.humanApproved", "Decisions require human approval and cannot mutate profiles online.");
  if (normalized.decision === "keep" && !normalized.winnerCohortId) fail("experimentDecision.winnerCohortId");
  if (options.evaluation) {
    assertArtifactLink(normalized.evaluationHash, options.evaluation, "CohortEvaluation", "experimentDecision.evaluationHash");
    if (normalized.experimentId !== options.evaluation.experimentId || normalized.snapshotGateHours !== options.evaluation.snapshotGateHours) fail("experimentDecision.experimentId", "Decision does not match cohort evaluation.", "GROWTH_LINK_MISMATCH");
    if (stableStringify(normalized.experimentManifestHashes) !== stableStringify([...options.evaluation.experimentManifestHashes].sort())) fail("experimentDecision.experimentManifestHashes", "Decision experiment set is stale.", "GROWTH_LINK_MISMATCH");
    if (normalized.decision === "keep" && normalized.winnerCohortId !== options.evaluation.winnerCohortId) fail("experimentDecision.winnerCohortId", "Human decision names a different winner.", "GROWTH_LINK_MISMATCH");
    if (normalized.decision !== "continue_collecting" && options.evaluation.recommendation !== "human_review_winner") fail("experimentDecision.decision", "Evaluation is not decision-ready.");
  }
  if (options.experimentManifests) {
    const actual = options.experimentManifests.map((entry) => normalizeExperimentManifest(entry).contentHash).sort();
    if (stableStringify(normalized.experimentManifestHashes) !== stableStringify(actual)) fail("experimentDecision.experimentManifestHashes", "Decision does not include the exact experiment manifests.", "GROWTH_LINK_MISMATCH");
  }
  return seal(input, normalized, "experimentDecision");
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  const result = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Number(result.toFixed(6));
}

function percentile(values, value) {
  if (!values.length) return 0;
  const below = values.filter((entry) => entry < value).length;
  const equal = values.filter((entry) => entry === value).length;
  return Number((100 * (below + equal * 0.5) / values.length).toFixed(4));
}

function evaluationArtifact(body) {
  return seal({}, { schemaVersion: SCHEMA_VERSION, artifactType: "CohortEvaluation", ...body }, "cohortEvaluation");
}

function evaluateEqualAgeCohorts(snapshots, options = {}) {
  if (!Array.isArray(snapshots)) fail("snapshots");
  const gate = number(options.gateHours ?? 168, "gateHours", 1, 672, { integer: true });
  if (!SNAPSHOT_GATES_HOURS.includes(gate)) fail("gateHours");
  const minimumPerCohort = number(options.minimumPerCohort ?? 3, "minimumPerCohort", 2, 100, { integer: true });
  const normalizedSnapshots = snapshots.map((entry) => normalizeAnalyticsSnapshot(entry));
  const experimentId = options.experimentId
    ? id(options.experimentId, "experimentId", "exp")
    : normalizedSnapshots[0]?.experimentId;
  if (!experimentId) fail("experimentId");
  const eligible = normalizedSnapshots.filter((entry) => entry.experimentId === experimentId
    && entry.snapshotGateHours === gate
    && entry.completeForPrimaryDecision);
  const seenVideos = new Set();
  for (const snapshot of eligible) {
    if (seenVideos.has(snapshot.videoId)) fail("snapshots", "Duplicate video at the same equal-age gate.");
    seenVideos.add(snapshot.videoId);
  }
  const groupKeys = new Set(eligible.map((entry) => [entry.pillar, entry.durationBucket, entry.formatProfile, entry.selectionProfile, entry.renderProfile].join(":")));
  if (groupKeys.size > 1) fail("snapshots", "Cohort evaluation cannot mix pillar, duration, or production profiles.");
  const groups = new Map();
  for (const snapshot of eligible) {
    if (!groups.has(snapshot.cohortId)) groups.set(snapshot.cohortId, []);
    groups.get(snapshot.cohortId).push(snapshot);
  }
  const metricKeys = [
    "stayedToWatchPercent", "averagePercentageViewed", "engagedViews",
    "sharesPer1000Engaged", "commentsPer1000Engaged", "subscribersPer1000Engaged",
  ];
  const allValues = Object.fromEntries(metricKeys.map((key) => [key, eligible.map((entry) => entry.metrics[key])]));
  const cohorts = [...groups.entries()].map(([cohortId, entries]) => {
    const medians = Object.fromEntries(metricKeys.map((key) => [key, median(entries.map((entry) => entry.metrics[key]))]));
    const percentiles = Object.fromEntries(metricKeys.map((key) => [key, percentile(allValues[key], medians[key])]));
    const satisfactionPercentile = median([
      percentiles.sharesPer1000Engaged,
      percentiles.commentsPer1000Engaged,
    ]);
    const growthScore = Number((
      0.30 * percentiles.stayedToWatchPercent
      + 0.25 * percentiles.averagePercentageViewed
      + 0.20 * percentiles.engagedViews
      + 0.15 * satisfactionPercentile
      + 0.10 * percentiles.subscribersPer1000Engaged
    ).toFixed(4));
    return {
      cohortId,
      sampleSize: entries.length,
      sufficientSample: entries.length >= minimumPerCohort,
      medians,
      percentiles,
      growthScore,
      videoIds: entries.map((entry) => entry.videoId).sort(),
    };
  }).sort((left, right) => right.growthScore - left.growthScore || left.cohortId.localeCompare(right.cohortId));
  const sufficient = cohorts.filter((entry) => entry.sufficientSample);
  let winner = sufficient[0] || null;
  if (winner && sufficient.length >= 2) {
    const dominates = sufficient.slice(1).every((other) => (
      winner.medians.stayedToWatchPercent > other.medians.stayedToWatchPercent
      && winner.medians.averagePercentageViewed > other.medians.averagePercentageViewed
      && winner.medians.engagedViews > other.medians.engagedViews
      && ["sharesPer1000Engaged", "commentsPer1000Engaged", "subscribersPer1000Engaged"]
        .some((key) => winner.medians[key] > other.medians[key])
    ));
    if (!dominates) winner = null;
  } else {
    winner = null;
  }
  const earlyObservation = !DECISION_GATES_HOURS.includes(gate);
  const recommendation = earlyObservation ? "observational_only" : winner ? "human_review_winner" : "keep_collecting";
  const first = eligible[0] || null;
  const evaluation = evaluationArtifact({
    experimentId,
    experimentManifestHashes: [...new Set(eligible.map((entry) => entry.experimentManifestHash))].sort(),
    snapshotGateHours: gate,
    equalAgeComparison: true,
    metricRule: "median",
    minimumPerCohort,
    eligibleSnapshotCount: eligible.length,
    comparableGroup: first ? {
      pillar: first.pillar,
      durationBucket: first.durationBucket,
      formatProfile: first.formatProfile,
      selectionProfile: first.selectionProfile,
      renderProfile: first.renderProfile,
    } : null,
    cohorts,
    recommendation,
    winnerCohortId: winner?.cohortId || null,
    humanApprovalRequired: !earlyObservation,
  });
  let experimentDecision = null;
  if (options.humanApproval) {
    if (earlyObservation) fail("humanApproval", "The 1h and 6h gates are observational only.");
    const approval = object(options.humanApproval, "humanApproval");
    exact(approval, ["decisionId", "decision", "winnerCohortId", "approver", "approvedAt", "notes"], "humanApproval");
    experimentDecision = normalizeExperimentDecision({
      schemaVersion: SCHEMA_VERSION,
      artifactType: "ExperimentDecision",
      decisionId: approval.decisionId,
      experimentId,
      experimentManifestHashes: evaluation.experimentManifestHashes,
      evaluationHash: evaluation.contentHash,
      snapshotGateHours: gate,
      equalAgeComparison: true,
      metricRule: "median",
      decision: approval.decision,
      winnerCohortId: approval.winnerCohortId || null,
      humanApproved: true,
      approver: approval.approver,
      approvedAt: approval.approvedAt,
      notes: approval.notes || "",
      profileMutationApplied: false,
    }, { evaluation });
  }
  return deepFreeze({ evaluation, experimentDecision });
}

module.exports = {
  ANALYTICS_SOURCES,
  DECISION_GATES_HOURS,
  FORMAT_PROFILE,
  RENDER_PROFILE,
  SCHEMA_VERSION,
  SECONDARY_METRICS,
  SELECTION_PROFILE,
  SNAPSHOT_GATES_HOURS,
  contentHash,
  durationBucket,
  evaluateEqualAgeCohorts,
  nearestSnapshotGate,
  normalizeAnalyticsSnapshot,
  normalizeCandidateDecision,
  normalizeCreativeQa,
  normalizeExperimentDecision,
  normalizeExperimentManifest,
  normalizePublishManifest,
  normalizePublishReceipt,
  normalizeRenderManifest,
  normalizeSourceAssetManifest,
  stableStringify,
};
