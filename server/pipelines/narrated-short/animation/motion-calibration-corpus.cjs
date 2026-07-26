"use strict";

const { AppError } = require("../../../errors.cjs");
const {
  contentHash,
  normalizeDraftBundle,
} = require("../contracts.cjs");
const {
  normalizeAlignment,
} = require("../narration/alignment.cjs");
const {
  buildProductionTimingContext,
} = require("./timing-context-builder.cjs");
const {
  compileProductionAnimation,
  SEMANTIC_SENTENCE_PROFILE_ID,
  SEMANTIC_SENTENCE_PROFILE_TOKEN,
} = require("./production-plan-compiler.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  MOTION_TEMPORAL_METRIC_PROFILE_ID,
  motionIntegrityCaseFromBenchmarkQa,
} = require("./motion-integrity-qa.cjs");
const {
  MOTION_ANALYSIS_PROFILE_ID,
  READABILITY_HOLD_POLICY_ID,
  SEGMENT_POLICY_ID,
  motionAnalysisConfigurationHash,
  motionAnalysisDimensions,
  motionAnalysisRangeHash,
  evaluateMotionQuality,
} = require("./benchmark-qa.cjs");
const {
  browserQaExpectations,
  motionSegments,
  safeSeekSequence,
} = require("./render-service.cjs");

const MOTION_CALIBRATION_CORPUS_SCHEMA_VERSION = 1;
const MOTION_CALIBRATION_CORPUS_PROFILE_ID =
  "dark_curiosity_repository_bound_motion_calibration_v1";
const MOTION_CALIBRATION_THRESHOLD_MODE =
  "shadow_repository_bound_p95_v1";
const MOTION_CALIBRATION_EVIDENCE_TRUST_LEVEL =
  "repository_integrity_only";
const MOTION_CALIBRATION_REVIEW_PROFILE_ID =
  "dark_curiosity_motion_review_v1";
const MINIMUM_ARTIFACT_BOUND_STORIES = 10;
const MINIMUM_LABEL_SUPPORT = 2;
const MAXIMUM_CORPUS_CASES = 1000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_ID_PATTERN = /^art_[a-f0-9]{40}$/;
const PROJECT_ID_PATTERN = /^prj_[A-Za-z0-9-]{8,80}$/;
const JOB_ID_PATTERN = /^job_[A-Za-z0-9-]{8,80}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const GENERATED_CASE_ID_PATTERN = /^repo_[a-f0-9]{24}$/;
const GENERATED_STORY_ID_PATTERN = /^story_[a-f0-9]{24}$/;
const MINIMUM_ANALYZED_TRANSITION_RATIO = 0.5;

const MOTION_CALIBRATION_BLOCKERS = Object.freeze({
  INSUFFICIENT_STORIES:
    "MOTION_CALIBRATION_ARTIFACT_BOUND_STORIES_INSUFFICIENT",
  INCOMPLETE_REVIEW: "MOTION_CALIBRATION_HUMAN_REVIEW_INCOMPLETE",
  LABEL_SUPPORT: "MOTION_CALIBRATION_LABEL_SUPPORT_INSUFFICIENT",
  NONSEPARABLE_LABELS: "MOTION_CALIBRATION_LABELS_NOT_SEPARABLE",
  PASS_OUTLIERS: "MOTION_CALIBRATION_PASS_LABEL_OUTLIERS_PRESENT",
  SAFETY_CEILING: "MOTION_CALIBRATION_CANDIDATE_EXCEEDS_SAFETY_CEILING",
  SHADOW_THRESHOLDS: "MOTION_CALIBRATION_SHADOW_THRESHOLDS_NOT_APPROVED",
});

const METRIC_DEFINITIONS = Object.freeze([
  Object.freeze({
    metric: "jerkEnergyP99",
    verdict: "jerkVerdict",
    maximum: 1,
    hardSafetyCeiling: 0.18,
  }),
  Object.freeze({
    metric: "peakJerkEnergy",
    verdict: "jerkVerdict",
    maximum: 1,
    hardSafetyCeiling: 0.45,
  }),
  Object.freeze({
    metric: "maximumBoundaryJumpRatio",
    verdict: "boundaryVerdict",
    maximum: 1_000_000,
    hardSafetyCeiling: 30,
  }),
]);

const REVIEW_REASON_CODES = Object.freeze([
  "boundary_discontinuity",
  "jerk_discomfort",
  "motion_stasis",
  "readability_failure",
  "semantic_mismatch",
]);

const REQUIRED_MOTION_CHECKS = Object.freeze([
  "balancedMotion",
  "captionSafeZone",
  "clipping",
  "consecutiveStasis",
  "contiguousStasis",
  "dimensions",
  "duration",
  "exactFrames",
  "focusExclusivity",
  "frameRate",
  "geometryAudit",
  "h264Yuv420p",
  "immediateHook",
  "mobileLegibility",
  "persistentContinuity",
  "primaryRoi",
  "readableNonBlack",
  "semanticMotion",
]);

const MOTION_FIELDS = Object.freeze([
  "temporalMetricProfileId",
  "temporalThresholdStatus",
  "motionAnalysisProfileId",
  "readabilityHoldPolicyId",
  "segmentPolicyId",
  "readabilityHoldRangesHash",
  "segmentRangesHash",
  "motionConfigurationHash",
  "analysisWidth",
  "analysisHeight",
  "decodedFrameSequenceHash",
  "frameCount",
  "transitionCount",
  "analyzedTransitionCount",
  "excludedReadabilityHoldTransitions",
  "semanticPixelCount",
  "motionThreshold",
  "firstMeaningfulMotionFrame",
  "consecutiveStasisRatio",
  "maxContiguousStasisFrames",
  "meanMotionEnergy",
  "motionEnergyP50",
  "motionEnergyP90",
  "motionEnergyP99",
  "peakMotionEnergy",
  "peakMotionFrame",
  "meanAccelerationEnergy",
  "analyzedAccelerationTransitionCount",
  "accelerationEnergyP90",
  "accelerationEnergyP99",
  "peakAccelerationEnergy",
  "peakAccelerationFrame",
  "meanJerkEnergy",
  "analyzedJerkTransitionCount",
  "jerkEnergyP90",
  "jerkEnergyP99",
  "peakJerkEnergy",
  "peakJerkFrame",
  "boundaryMetrics",
  "maximumBoundaryJumpRatio",
  "segmentMetrics",
  "rollingWindowFrames",
  "windowEnergyTransform",
  "maxWindowMotionShare",
  "maxWindowStartFrame",
  "maxWindowEndFrame",
  "rawMaxWindowMotionShare",
  "rawMaxWindowStartFrame",
  "rawMaxWindowEndFrame",
  "uniqueFrameRatio",
  "changedTransitionRatio",
  "meanLuma",
  "sampleCount",
  "stasisRatio",
  "motionEnergy",
]);

const BROWSER_GEOMETRY_FIELDS = Object.freeze([
  "passed",
  "semanticRoi",
  "captionSafeZone",
  "checkpointCount",
  "entityObservationCount",
  "pathFollowerObservationCount",
  "semanticRouteObservationCount",
  "persistentObservationCount",
  "labelObservationCount",
  "boundedGeometryObservationCount",
  "markedLabelIds",
  "observedLabelIds",
  "unobservedLabelCount",
  "observedPathFollowerIds",
  "unobservedPathFollowerCount",
  "observedSemanticRouteIds",
  "unobservedSemanticRouteCount",
  "persistentStateCoverage",
  "observedTransitionIds",
  "observedFocusIntervalIds",
  "unobservedFocusIntervalCount",
  "observedActionSignatures",
  "unobservedActionSignatureCount",
  "observedBoundedGeometrySentenceIndices",
  "unobservedBoundedGeometrySentenceCount",
  "actionCoverageViolationCount",
  "clippedEntityCount",
  "captionSafeZoneViolationCount",
  "pathFollowerViolationCount",
  "semanticRouteViolationCount",
  "boundedGeometryClippingViolationCount",
  "boundedGeometryCaptionSafeZoneViolationCount",
  "persistentContinuityViolationCount",
  "focusViolationCount",
  "primaryRoiViolationCount",
  "legibilityViolationCount",
  "contrastViolationCount",
]);

const VERIFIED_CASES = new WeakSet();
const VERIFIED_CASE_SEMANTIC_TOKENS = new WeakMap();

function fail(field, reason = "invalid") {
  throw new AppError(
    "ANIMATION_MOTION_CALIBRATION_INVALID",
    "The repository-bound motion calibration evidence is invalid.",
    409,
    { field, reason },
  );
}

function strictDataObject(value, field) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) fail(field, "plain_object_required");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail(`${field}.*`, "symbol_field_forbidden");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) fail(`${field}.${key}`, "plain_data_field_required");
  }
  return keys;
}

function exactKeys(value, required, field) {
  const actual = strictDataObject(value, field).sort();
  const expected = [...required].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) fail(field, "unsupported_or_missing_field");
}

function allowedKeys(value, required, optional, field) {
  const actual = strictDataObject(value, field);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !actual.includes(key))
    || actual.some((key) => !allowed.has(key))
  ) fail(field, "unsupported_or_missing_field");
}

function own(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function denseArray(value, field, minimum = 0, maximum = 1000) {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum
    || value.length > maximum
  ) fail(field, "bounded_plain_array_required");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) fail(field, "dense_array_required");
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) fail(`${field}[${index}]`, "dense_data_array_required");
    output.push(descriptor.value);
  }
  if (keys.some((key) => (
    typeof key !== "string"
    || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
  ))) fail(`${field}.*`, "unsupported_array_field");
  return output;
}

function strictJsonClone(value, field, state = null, depth = 0) {
  const context = state || { seen: new WeakSet(), nodes: 0 };
  context.nodes += 1;
  if (context.nodes > 100_000 || depth > 80) fail(field, "json_budget_exceeded");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (
      value.length > 200_000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)
    ) fail(field, "safe_json_text_required");
    return value;
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value)
      || Math.abs(value) > Number.MAX_SAFE_INTEGER
      || Object.is(value, -0)
    ) fail(field, "safe_json_number_required");
    return value;
  }
  if (!value || typeof value !== "object") fail(field, "json_value_required");
  if (context.seen.has(value)) fail(field, "cyclic_value_forbidden");
  context.seen.add(value);
  if (Array.isArray(value)) {
    const entries = denseArray(value, field, 0, 10_000);
    return entries.map((entry, index) => strictJsonClone(
      entry,
      `${field}[${index}]`,
      context,
      depth + 1,
    ));
  }
  const keys = strictDataObject(value, field);
  const output = {};
  for (const key of keys) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      fail(`${field}.${key}`, "prototype_field_forbidden");
    }
    output[key] = strictJsonClone(
      own(value, key),
      `${field}.${key}`,
      context,
      depth + 1,
    );
  }
  return output;
}

function safeText(value, field, maximum = 120, pattern = null) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)
    || (pattern && !pattern.test(value))
  ) fail(field, "bounded_safe_text_required");
  return value;
}

function hash(value, field) {
  return safeText(value, field, 64, HASH_PATTERN);
}

function artifactId(value, field) {
  return safeText(value, field, 44, ARTIFACT_ID_PATTERN);
}

function nullableArtifactId(value, field) {
  return value === null ? null : artifactId(value, field);
}

function projectId(value, field) {
  return safeText(value, field, 84, PROJECT_ID_PATTERN);
}

function jobId(value, field) {
  return safeText(value, field, 84, JOB_ID_PATTERN);
}

function token(value, field, allowed = null) {
  const normalized = safeText(value, field, 120, TOKEN_PATTERN);
  if (allowed && !allowed.includes(normalized)) fail(field, "unsupported_value");
  return normalized;
}

function generatedCaseId(value, field) {
  return safeText(value, field, 29, GENERATED_CASE_ID_PATTERN);
}

function generatedStoryId(value, field) {
  return safeText(value, field, 30, GENERATED_STORY_ID_PATTERN);
}

function integer(value, field, minimum, maximum) {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < minimum
    || value > maximum
  ) fail(field, "integer_out_of_range");
  return value;
}

function safeNumber(value, field, minimum, maximum) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || Object.is(value, -0)
    || Math.abs(value) > Number.MAX_SAFE_INTEGER
    || value < minimum
    || value > maximum
  ) fail(field, "finite_safe_number_required");
  return value;
}

function trueBoolean(value, field) {
  if (value !== true) fail(field, "true_required");
  return true;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function canonicalUnique(values, field, options = {}) {
  const normalized = [...values];
  if (new Set(normalized).size !== normalized.length) {
    fail(field, "unique_values_required");
  }
  if (options.sorted !== false) {
    const ordered = [...normalized].sort(options.compare);
    if (normalized.some((value, index) => value !== ordered[index])) {
      fail(field, "canonical_order_required");
    }
  }
  return normalized;
}

function withoutDeclaredHash(body) {
  const value = { ...body };
  delete value.contentHash;
  return value;
}

function normalizeArtifactEnvelope(input, expectedType, field) {
  const envelope = strictJsonClone(input, field);
  exactKeys(envelope, [
    "schemaVersion",
    "artifactType",
    "projectId",
    "ownerJobId",
    "revision",
    "contentHash",
    "dependencyHashes",
    "createdAt",
    "body",
  ], field);
  integer(envelope.schemaVersion, `${field}.schemaVersion`, 1, 1);
  token(envelope.artifactType, `${field}.artifactType`, [expectedType]);
  projectId(envelope.projectId, `${field}.projectId`);
  if (envelope.ownerJobId !== null) jobId(envelope.ownerJobId, `${field}.ownerJobId`);
  integer(envelope.revision, `${field}.revision`, 1, 1_000_000);
  const envelopeHash = hash(envelope.contentHash, `${field}.contentHash`);
  if (!Number.isFinite(Date.parse(safeText(envelope.createdAt, `${field}.createdAt`, 80)))) {
    fail(`${field}.createdAt`, "timestamp_required");
  }
  const dependencies = denseArray(
    envelope.dependencyHashes,
    `${field}.dependencyHashes`,
    0,
    24,
  ).map((value, index) => hash(value, `${field}.dependencyHashes[${index}]`));
  canonicalUnique(dependencies, `${field}.dependencyHashes`);
  strictDataObject(envelope.body, `${field}.body`);
  const calculated = contentHash(withoutDeclaredHash(envelope.body));
  if (Object.hasOwn(envelope.body, "contentHash")) {
    if (hash(envelope.body.contentHash, `${field}.body.contentHash`) !== calculated) {
      fail(`${field}.body.contentHash`, "declared_hash_mismatch");
    }
  }
  if (calculated !== envelopeHash) fail(`${field}.contentHash`, "body_hash_mismatch");
  return { ...envelope, dependencyHashes: dependencies };
}

function repositoryArtifact(repository, requestedId, expectedType, field) {
  if (
    !repository
    || typeof repository !== "object"
    || typeof repository.readJson !== "function"
    || typeof repository.publicRecord !== "function"
  ) fail("motionCalibration.contentArtifactRepository", "repository_required");
  const normalizedId = artifactId(requestedId, `${field}.artifactId`);
  let rawEnvelope;
  let rawPublic;
  try {
    rawPublic = repository.publicRecord(normalizedId);
    rawEnvelope = repository.readJson(normalizedId);
  } catch {
    fail(field, "repository_read_failed");
  }
  const envelope = normalizeArtifactEnvelope(
    rawEnvelope,
    expectedType,
    `${field}.envelope`,
  );
  const publicRecord = strictJsonClone(rawPublic, `${field}.publicRecord`);
  exactKeys(publicRecord, [
    "artifact",
    "artifactType",
    "revision",
    "contentHash",
    "dependencyHashes",
    "createdAt",
  ], `${field}.publicRecord`);
  exactKeys(publicRecord.artifact, [
    "id",
    "type",
    "ownerProjectId",
    "ownerJobId",
    "size",
    "contentType",
    "checksumSha256",
    "source",
    "status",
    "createdAt",
    "updatedAt",
    "storageAdapterMode",
  ], `${field}.publicRecord.artifact`);
  const publicArtifact = publicRecord.artifact;
  if (
    publicArtifact.id !== normalizedId
    || publicArtifact.type !== expectedType
    || publicArtifact.status !== "available"
    || publicArtifact.ownerProjectId !== envelope.projectId
    || (publicArtifact.ownerJobId || null) !== envelope.ownerJobId
    || publicArtifact.contentType !== "application/json"
    || publicRecord.artifactType !== expectedType
    || publicRecord.revision !== envelope.revision
    || publicRecord.contentHash !== envelope.contentHash
    || publicRecord.createdAt !== envelope.createdAt
    || stableStringify(publicRecord.dependencyHashes) !== stableStringify(envelope.dependencyHashes)
  ) fail(field, "repository_record_mismatch");
  integer(publicArtifact.size, `${field}.publicRecord.artifact.size`, 2, 512 * 1024);
  hash(publicArtifact.checksumSha256, `${field}.publicRecord.artifact.checksumSha256`);
  token(publicArtifact.storageAdapterMode, `${field}.publicRecord.artifact.storageAdapterMode`);
  if (publicArtifact.source !== null) {
    safeText(publicArtifact.source, `${field}.publicRecord.artifact.source`, 120);
  }
  const identityHash = contentHash({
    artifactType: expectedType,
    projectId: envelope.projectId,
    revision: envelope.revision,
    bodyHash: envelope.contentHash,
    dependencyHashes: envelope.dependencyHashes,
  });
  if (normalizedId !== `art_${identityHash.slice(0, 40)}`) {
    fail(`${field}.artifactId`, "repository_identity_mismatch");
  }
  return { artifactId: normalizedId, envelope, publicRecord };
}

function exactDependencies(record, expected, field) {
  const normalized = canonicalUnique([...new Set(expected)].sort(), field);
  if (stableStringify(record.envelope.dependencyHashes) !== stableStringify(normalized)) {
    fail(field, "exact_dependency_set_required");
  }
}

function sameProjectRevision(records) {
  const first = records[0].envelope;
  for (const record of records.slice(1)) {
    if (
      record.envelope.projectId !== first.projectId
      || record.envelope.revision !== first.revision
    ) fail("motionCalibration.artifacts", "project_or_revision_mismatch");
  }
}

function forbidPrivateEvidence(value, field) {
  const forbidden = new Set([
    "apiKey",
    "authorization",
    "env",
    "html",
    "outputPath",
    "rawFrames",
    "sampleHashes",
    "secret",
    "stderr",
    "stdout",
    "storageKey",
    "transcript",
  ]);
  const visit = (entry, current) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${current}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      if (forbidden.has(key)) fail(`${current}.${key}`, "private_evidence_forbidden");
      visit(child, `${current}.${key}`);
    }
  };
  visit(value, field);
}

function identityText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalSourceUrl(value, field) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(field, "canonical_source_url_required");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
  ) fail(field, "canonical_source_url_required");
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid)$/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

function semanticTokenHashes(values) {
  const words = values.flatMap((value) => identityText(value).split(" "))
    .filter((value) => value.length >= 3);
  const tokens = new Set(words.map((value) => `w:${value}`));
  for (let index = 1; index < words.length; index += 1) {
    tokens.add(`b:${words[index - 1]} ${words[index]}`);
  }
  return [...tokens].sort().map((value) => contentHash({ token: value }));
}

function storyIdentities(draft) {
  const sourcesById = new Map();
  const sourceIdentities = draft.claimLedger.sources.map((source, index) => {
    hash(
      source.snapshotHash,
      `motionCalibration.draft.claimLedger.sources[${index}].snapshotHash`,
    );
    const canonical = {
      url: canonicalSourceUrl(
        source.url,
        `motionCalibration.draft.claimLedger.sources[${index}].url`,
      ),
      publisher: identityText(source.publisher),
      sourceClass: source.sourceClass,
      independenceGroup: identityText(source.independenceGroup),
    };
    const sourceIdentity = contentHash(canonical);
    sourcesById.set(source.id, sourceIdentity);
    return { ...canonical, sourceIdentity };
  }).sort((left, right) => left.sourceIdentity.localeCompare(right.sourceIdentity));
  canonicalUnique(
    sourceIdentities.map((source) => source.sourceIdentity),
    "motionCalibration.sourceIdentities",
  );
  if (
    sourceIdentities.length < 2
    || new Set(sourceIdentities.map((source) => source.independenceGroup)).size < 2
  ) fail("motionCalibration.sourceIdentities", "independent_sources_required");
  const sourceFingerprintHash = contentHash({
    verticalId: draft.verticalId,
    formatId: draft.brief.formatId,
    sources: sourceIdentities.map((source) => ({
      url: source.url,
      publisher: source.publisher,
      sourceClass: source.sourceClass,
      independenceGroup: source.independenceGroup,
    })),
  });
  const claimSignatures = new Map();
  const claims = draft.claimLedger.claims.map((claim) => {
    const normalized = {
      text: identityText(claim.text),
      kind: claim.kind,
      claimType: claim.claimType,
      verdict: claim.verdict,
      sourceLinks: claim.sourceLinks.map((link) => ({
        sourceIdentity: sourcesById.get(link.sourceId),
        support: link.support,
        evidenceExcerpt: identityText(link.evidenceExcerpt),
        pageOrTimecode: identityText(link.pageOrTimecode),
      })).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
    };
    const signature = contentHash(normalized);
    claimSignatures.set(claim.id, signature);
    return { signature, ...normalized };
  }).sort((left, right) => left.signature.localeCompare(right.signature));
  const spokenBeats = draft.script.beats.map((beat) => ({
    role: beat.role,
    spokenText: identityText(beat.spokenText),
    onScreenText: identityText(beat.onScreenText),
    claimSignatures: beat.claimIds.map((claimId) => claimSignatures.get(claimId)).sort(),
  }));
  const storyIdentityHash = contentHash({
    verticalId: draft.verticalId,
    formatId: draft.brief.formatId,
    language: draft.brief.language,
    claims,
    spokenBeats,
  });
  const storySemanticTokens = semanticTokenHashes([
    ...claims.map((claim) => claim.text),
    ...spokenBeats.flatMap((beat) => [beat.spokenText, beat.onScreenText]),
  ]);
  return { storyIdentityHash, sourceFingerprintHash, storySemanticTokens };
}

function normalizeStringArray(value, field, maximum = 100, options = {}) {
  const entries = denseArray(value, field, options.minimum || 0, maximum)
    .map((entry, index) => safeText(
      entry,
      `${field}[${index}]`,
      options.textMaximum || 240,
      options.pattern || /^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/,
    ));
  canonicalUnique(entries, field, { sorted: options.sorted !== false });
  return entries;
}

function normalizeIntegerArray(value, field, maximum, upperBound) {
  const entries = denseArray(value, field, 0, maximum).map((entry, index) => (
    integer(entry, `${field}[${index}]`, 0, upperBound)
  ));
  canonicalUnique(entries, field, { compare: (left, right) => left - right });
  return entries;
}

function normalizeRect(value, field, technical) {
  exactKeys(value, ["x", "y", "width", "height"], field);
  const rect = {
    x: safeNumber(value.x, `${field}.x`, 0, technical.width),
    y: safeNumber(value.y, `${field}.y`, 0, technical.height),
    width: safeNumber(value.width, `${field}.width`, 1, technical.width),
    height: safeNumber(value.height, `${field}.height`, 1, technical.height),
  };
  if (
    rect.x + rect.width > technical.width + 0.001
    || rect.y + rect.height > technical.height + 0.001
  ) fail(field, "rect_outside_frame");
  return rect;
}

function normalizeBrowserProof(input, technical) {
  const field = "motionCalibration.qa.browser";
  exactKeys(input, [
    "seekSequence",
    "cacheWarmupFrames",
    "captures",
    "repeatedFrames",
    "loadedOnce",
    "pageLoadCount",
    "stateIsolation",
    "externalRequestCount",
    "blockedExternalRequestCount",
    "resourceClasses",
    "geometryAudit",
    "passed",
  ], field);
  trueBoolean(input.passed, `${field}.passed`);
  trueBoolean(input.loadedOnce, `${field}.loadedOnce`);
  integer(input.pageLoadCount, `${field}.pageLoadCount`, 1, 1);
  integer(input.externalRequestCount, `${field}.externalRequestCount`, 0, 0);
  integer(input.blockedExternalRequestCount, `${field}.blockedExternalRequestCount`, 0, 0);
  denseArray(input.resourceClasses, `${field}.resourceClasses`, 0, 0);
  exactKeys(input.stateIsolation, [
    "valid",
    "wallClockIndependent",
    "seededRandomOnly",
    "autoplayFree",
    "frameAccumulationFree",
  ], `${field}.stateIsolation`);
  for (const key of Object.keys(input.stateIsolation)) {
    trueBoolean(input.stateIsolation[key], `${field}.stateIsolation.${key}`);
  }
  const seekSequence = denseArray(
    input.seekSequence,
    `${field}.seekSequence`,
    2,
    60,
  ).map((frame, index) => integer(
    frame,
    `${field}.seekSequence[${index}]`,
    0,
    technical.frameCount - 1,
  ));
  const cacheWarmupFrames = denseArray(
    input.cacheWarmupFrames,
    `${field}.cacheWarmupFrames`,
    0,
    20,
  ).map((frame, index) => integer(
    frame,
    `${field}.cacheWarmupFrames[${index}]`,
    0,
    technical.frameCount - 1,
  ));
  canonicalUnique(cacheWarmupFrames, `${field}.cacheWarmupFrames`, { sorted: false });
  if (cacheWarmupFrames.some((frame) => !seekSequence.includes(frame))) {
    fail(`${field}.cacheWarmupFrames`, "warmup_frame_not_sought");
  }
  const captures = denseArray(
    input.captures,
    `${field}.captures`,
    seekSequence.length,
    seekSequence.length,
  ).map((capture, index) => {
    exactKeys(capture, ["sequenceIndex", "frame", "sha256"], `${field}.captures[${index}]`);
    if (capture.sequenceIndex !== index || capture.frame !== seekSequence[index]) {
      fail(`${field}.captures[${index}]`, "seek_capture_mismatch");
    }
    return {
      sequenceIndex: index,
      frame: capture.frame,
      sha256: hash(capture.sha256, `${field}.captures[${index}].sha256`),
    };
  });
  const repeatedFrames = denseArray(
    input.repeatedFrames,
    `${field}.repeatedFrames`,
    1,
    30,
  ).map((entry, index) => {
    const entryField = `${field}.repeatedFrames[${index}]`;
    exactKeys(entry, ["frame", "occurrences", "sha256", "equal"], entryField);
    const frame = integer(entry.frame, `${entryField}.frame`, 0, technical.frameCount - 1);
    const matches = captures.filter((capture) => capture.frame === frame);
    const occurrences = integer(entry.occurrences, `${entryField}.occurrences`, 2, 60);
    const sha256 = hash(entry.sha256, `${entryField}.sha256`);
    trueBoolean(entry.equal, `${entryField}.equal`);
    if (
      matches.length !== occurrences
      || matches.some((capture) => capture.sha256 !== sha256)
    ) fail(entryField, "repeated_seek_hash_mismatch");
    return { frame, occurrences, sha256, equal: true };
  });
  canonicalUnique(
    repeatedFrames.map((entry) => entry.frame),
    `${field}.repeatedFrames.frame`,
    { compare: (left, right) => left - right },
  );
  const expectedRepeated = [...new Set(seekSequence)]
    .filter((frame) => seekSequence.filter((entry) => entry === frame).length > 1)
    .sort((left, right) => left - right);
  if (stableStringify(repeatedFrames.map((entry) => entry.frame)) !== stableStringify(expectedRepeated)) {
    fail(`${field}.repeatedFrames`, "repeated_seek_coverage_mismatch");
  }

  const geometry = input.geometryAudit;
  exactKeys(geometry, BROWSER_GEOMETRY_FIELDS, `${field}.geometryAudit`);
  trueBoolean(geometry.passed, `${field}.geometryAudit.passed`);
  const semanticRoi = normalizeRect(
    geometry.semanticRoi,
    `${field}.geometryAudit.semanticRoi`,
    technical,
  );
  const captionSafeZone = normalizeRect(
    geometry.captionSafeZone,
    `${field}.geometryAudit.captionSafeZone`,
    technical,
  );
  integer(
    geometry.checkpointCount,
    `${field}.geometryAudit.checkpointCount`,
    seekSequence.length,
    seekSequence.length,
  );
  integer(geometry.entityObservationCount, `${field}.geometryAudit.entityObservationCount`, 1, 1_000_000);
  integer(geometry.pathFollowerObservationCount, `${field}.geometryAudit.pathFollowerObservationCount`, 0, 1_000_000);
  integer(geometry.semanticRouteObservationCount, `${field}.geometryAudit.semanticRouteObservationCount`, 0, 1_000_000);
  integer(geometry.persistentObservationCount, `${field}.geometryAudit.persistentObservationCount`, 0, 1_000_000);
  integer(geometry.labelObservationCount, `${field}.geometryAudit.labelObservationCount`, 1, 1_000_000);
  integer(geometry.boundedGeometryObservationCount, `${field}.geometryAudit.boundedGeometryObservationCount`, 0, 1_000_000);
  const markedLabels = normalizeStringArray(
    geometry.markedLabelIds,
    `${field}.geometryAudit.markedLabelIds`,
    200,
    { minimum: 1 },
  );
  const observedLabels = normalizeStringArray(
    geometry.observedLabelIds,
    `${field}.geometryAudit.observedLabelIds`,
    200,
    { minimum: 1 },
  );
  if (stableStringify(markedLabels) !== stableStringify(observedLabels)) {
    fail(`${field}.geometryAudit.observedLabelIds`, "label_coverage_mismatch");
  }
  const observedPathFollowerIds = normalizeStringArray(
    geometry.observedPathFollowerIds,
    `${field}.geometryAudit.observedPathFollowerIds`,
    200,
  );
  const observedSemanticRouteIds = normalizeStringArray(
    geometry.observedSemanticRouteIds,
    `${field}.geometryAudit.observedSemanticRouteIds`,
    200,
  );
  const observedTransitionIds = normalizeStringArray(
    geometry.observedTransitionIds,
    `${field}.geometryAudit.observedTransitionIds`,
    200,
  );
  const observedFocusIntervalIds = normalizeStringArray(
    geometry.observedFocusIntervalIds,
    `${field}.geometryAudit.observedFocusIntervalIds`,
    200,
  );
  const observedActionSignatures = normalizeStringArray(
    geometry.observedActionSignatures,
    `${field}.geometryAudit.observedActionSignatures`,
    200,
  );
  const observedBoundedGeometrySentenceIndices = normalizeIntegerArray(
    geometry.observedBoundedGeometrySentenceIndices,
    `${field}.geometryAudit.observedBoundedGeometrySentenceIndices`,
    100,
    10_000,
  );
  exactKeys(
    geometry.persistentStateCoverage,
    Object.keys(geometry.persistentStateCoverage),
    `${field}.geometryAudit.persistentStateCoverage`,
  );
  const coverageKeys = Object.keys(geometry.persistentStateCoverage);
  if (coverageKeys.length > 40) fail(`${field}.geometryAudit.persistentStateCoverage`, "coverage_budget_exceeded");
  canonicalUnique([...coverageKeys].sort(), `${field}.geometryAudit.persistentStateCoverage.keys`);
  const persistentStateCoverage = {};
  for (const key of coverageKeys) {
    safeText(key, `${field}.geometryAudit.persistentStateCoverage.${key}`, 120, TOKEN_PATTERN);
    persistentStateCoverage[key] = normalizeStringArray(
      geometry.persistentStateCoverage[key],
      `${field}.geometryAudit.persistentStateCoverage.${key}`,
      100,
    );
  }
  for (const name of [
    "unobservedLabelCount",
    "unobservedPathFollowerCount",
    "unobservedSemanticRouteCount",
    "unobservedFocusIntervalCount",
    "unobservedActionSignatureCount",
    "unobservedBoundedGeometrySentenceCount",
    "actionCoverageViolationCount",
    "clippedEntityCount",
    "captionSafeZoneViolationCount",
    "pathFollowerViolationCount",
    "semanticRouteViolationCount",
    "boundedGeometryClippingViolationCount",
    "boundedGeometryCaptionSafeZoneViolationCount",
    "persistentContinuityViolationCount",
    "focusViolationCount",
    "primaryRoiViolationCount",
    "legibilityViolationCount",
    "contrastViolationCount",
  ]) integer(geometry[name], `${field}.geometryAudit.${name}`, 0, 0);
  return {
    semanticRoi,
    captionSafeZone,
    seekSequence,
    cacheWarmupFrames,
    captures,
    repeatedFrames,
    geometry: {
      pathFollowerObservationCount: geometry.pathFollowerObservationCount,
      semanticRouteObservationCount: geometry.semanticRouteObservationCount,
      persistentObservationCount: geometry.persistentObservationCount,
      boundedGeometryObservationCount: geometry.boundedGeometryObservationCount,
      observedPathFollowerIds,
      observedSemanticRouteIds,
      markedLabelIds: markedLabels,
      observedTransitionIds,
      observedFocusIntervalIds,
      observedActionSignatures,
      observedBoundedGeometrySentenceIndices,
      persistentStateCoverage,
    },
  };
}

function canonicalExpectedStrings(values, field) {
  if (!Array.isArray(values) || values.length > 200) {
    fail(field, "trusted_browser_expectation_invalid");
  }
  const output = values.map((value, index) => safeText(
    value,
    `${field}[${index}]`,
    240,
    /^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/,
  )).sort();
  if (new Set(output).size !== output.length) {
    fail(field, "trusted_browser_expectation_invalid");
  }
  return output;
}

function assertBrowserExpectationBinding(
  evidence,
  animationIR,
  actionQa,
  compositionQaPolicy,
) {
  let expectedSeekSequence;
  let expected;
  try {
    expectedSeekSequence = safeSeekSequence(animationIR, actionQa);
    expected = browserQaExpectations(
      animationIR,
      expectedSeekSequence,
      actionQa,
      compositionQaPolicy,
    );
  } catch {
    fail(
      "motionCalibration.qa.browser",
      "trusted_browser_expectation_derivation_failed",
    );
  }
  if (
    stableStringify(evidence.seekSequence)
      !== stableStringify(expectedSeekSequence)
  ) fail("motionCalibration.qa.browser.seekSequence", "trusted_seek_sequence_mismatch");
  if (
    stableStringify(evidence.cacheWarmupFrames)
      !== stableStringify(expected.cacheWarmupFrames)
  ) fail("motionCalibration.qa.browser.cacheWarmupFrames", "trusted_warmup_sequence_mismatch");
  if (
    stableStringify(evidence.semanticRoi)
      !== stableStringify(expected.semanticRoi)
    || stableStringify(evidence.captionSafeZone)
      !== stableStringify(expected.captionSafeZone)
  ) fail(
    "motionCalibration.qa.browser.geometryAudit",
    "trusted_composition_geometry_mismatch",
  );

  const geometry = evidence.geometry;
  const expectedPathFollowerIds = canonicalExpectedStrings(
    expected.pathFollowerIds,
    "motionCalibration.expectedBrowser.pathFollowerIds",
  );
  const expectedTransitionIds = canonicalExpectedStrings(
    expected.transitionIds,
    "motionCalibration.expectedBrowser.transitionIds",
  );
  const expectedFocusIntervalIds = canonicalExpectedStrings(
    expected.focusIntervalIds,
    "motionCalibration.expectedBrowser.focusIntervalIds",
  );
  const expectedActionSignatures = canonicalExpectedStrings(
    expected.actionSignatures || [],
    "motionCalibration.expectedBrowser.actionSignatures",
  );
  const expectedSemanticRouteIds = canonicalExpectedStrings(
    expected.semanticRouteIds || [],
    "motionCalibration.expectedBrowser.semanticRouteIds",
  );
  const expectedLabelIds = canonicalExpectedStrings(
    expected.labelIds || [],
    "motionCalibration.expectedBrowser.labelIds",
  );
  const expectedBoundedGeometrySentenceIndices = [
    ...(expected.boundedGeometrySentenceIndices || []),
  ].sort((left, right) => left - right);
  if (
    new Set(expectedBoundedGeometrySentenceIndices).size
      !== expectedBoundedGeometrySentenceIndices.length
    || expectedBoundedGeometrySentenceIndices.some((value) => (
      !Number.isSafeInteger(value) || value < 0 || value > 10_000
    ))
  ) fail(
    "motionCalibration.expectedBrowser.boundedGeometrySentenceIndices",
    "trusted_browser_expectation_invalid",
  );
  for (const [name, actual, expectedValues] of [
    ["observedPathFollowerIds", geometry.observedPathFollowerIds, expectedPathFollowerIds],
    ["observedTransitionIds", geometry.observedTransitionIds, expectedTransitionIds],
    ["observedFocusIntervalIds", geometry.observedFocusIntervalIds, expectedFocusIntervalIds],
    ["observedActionSignatures", geometry.observedActionSignatures, expectedActionSignatures],
    ["observedSemanticRouteIds", geometry.observedSemanticRouteIds, expectedSemanticRouteIds],
    ["markedLabelIds", geometry.markedLabelIds, expectedLabelIds],
    [
      "observedBoundedGeometrySentenceIndices",
      geometry.observedBoundedGeometrySentenceIndices,
      expectedBoundedGeometrySentenceIndices,
    ],
  ]) {
    if (stableStringify(actual) !== stableStringify(expectedValues)) {
      fail(`motionCalibration.qa.browser.geometryAudit.${name}`, "trusted_browser_coverage_mismatch");
    }
  }
  if (
    expectedPathFollowerIds.length > 0
    && geometry.pathFollowerObservationCount <= 0
  ) fail(
    "motionCalibration.qa.browser.geometryAudit.pathFollowerObservationCount",
    "trusted_browser_coverage_missing",
  );
  if (
    expectedSemanticRouteIds.length > 0
    && geometry.semanticRouteObservationCount <= 0
  ) fail(
    "motionCalibration.qa.browser.geometryAudit.semanticRouteObservationCount",
    "trusted_browser_coverage_missing",
  );
  const expectedPersistentEntityIds = canonicalExpectedStrings(
    expected.persistentEntityIds,
    "motionCalibration.expectedBrowser.persistentEntityIds",
  );
  const expectedVisualStateIds = canonicalExpectedStrings(
    expected.visualStateIds,
    "motionCalibration.expectedBrowser.visualStateIds",
  );
  if (
    expectedPersistentEntityIds.length > 0
    && geometry.persistentObservationCount <= 0
  ) fail(
    "motionCalibration.qa.browser.geometryAudit.persistentObservationCount",
    "trusted_browser_coverage_missing",
  );
  if (
    expectedBoundedGeometrySentenceIndices.length > 0
    && geometry.boundedGeometryObservationCount <= 0
  ) fail(
    "motionCalibration.qa.browser.geometryAudit.boundedGeometryObservationCount",
    "trusted_browser_coverage_missing",
  );
  const expectedCoverage = Object.fromEntries(
    expectedPersistentEntityIds.map((entityId) => [
      entityId,
      expectedVisualStateIds,
    ]),
  );
  const actualCoverage = Object.fromEntries(
    Object.keys(geometry.persistentStateCoverage).sort().map((entityId) => [
      entityId,
      geometry.persistentStateCoverage[entityId],
    ]),
  );
  if (stableStringify(actualCoverage) !== stableStringify(expectedCoverage)) {
    fail(
      "motionCalibration.qa.browser.geometryAudit.persistentStateCoverage",
      "trusted_browser_coverage_mismatch",
    );
  }
}

function expectedMotionGeometry(semanticRoi, technical) {
  try {
    const value = motionAnalysisDimensions(semanticRoi, technical);
    return {
      semanticRoi: { ...value.semanticRoi },
      analysisWidth: value.width,
      analysisHeight: value.height,
    };
  } catch {
    fail("motionCalibration.motion.semanticRoi", "semantic_roi_invalid");
  }
}

function normalizeBoundaryMetric(input, index, frameCount, motionThreshold) {
  const field = `motionCalibration.qa.motion.motion.boundaryMetrics[${index}]`;
  exactKeys(input, [
    "frame",
    "motionEnergy",
    "accelerationEnergy",
    "jerkEnergy",
    "localBaseline",
    "jumpRatio",
  ], field);
  const value = {
    frame: integer(input.frame, `${field}.frame`, 1, frameCount - 1),
    motionEnergy: safeNumber(input.motionEnergy, `${field}.motionEnergy`, 0, 1),
    accelerationEnergy: safeNumber(input.accelerationEnergy, `${field}.accelerationEnergy`, 0, 1),
    jerkEnergy: safeNumber(input.jerkEnergy, `${field}.jerkEnergy`, 0, 1),
    localBaseline: safeNumber(input.localBaseline, `${field}.localBaseline`, 0, 1),
    jumpRatio: safeNumber(input.jumpRatio, `${field}.jumpRatio`, 0, 1_000_000),
  };
  const expectedJumpRatio = value.motionEnergy
    / Math.max(motionThreshold, value.localBaseline);
  const tolerance = 1e-12 * Math.max(1, Math.abs(expectedJumpRatio));
  if (Math.abs(value.jumpRatio - expectedJumpRatio) > tolerance) {
    fail(`${field}.jumpRatio`, "boundary_jump_formula_mismatch");
  }
  return value;
}

function normalizeSegmentMetric(input, index, frameCount) {
  const field = `motionCalibration.qa.motion.motion.segmentMetrics[${index}]`;
  exactKeys(input, [
    "id",
    "startFrame",
    "endFrame",
    "transitionCount",
    "totalMotionEnergy",
    "meanMotionEnergy",
    "stasisRatio",
    "meanAccelerationEnergy",
    "accelerationEnergyP99",
    "meanJerkEnergy",
    "jerkEnergyP99",
    "peakJerkEnergy",
  ], field);
  const value = {
    id: safeText(input.id, `${field}.id`, 120, TOKEN_PATTERN),
    startFrame: integer(input.startFrame, `${field}.startFrame`, 0, frameCount - 1),
    endFrame: integer(input.endFrame, `${field}.endFrame`, 1, frameCount),
    transitionCount: integer(input.transitionCount, `${field}.transitionCount`, 0, frameCount - 1),
    totalMotionEnergy: safeNumber(input.totalMotionEnergy, `${field}.totalMotionEnergy`, 0, frameCount),
    meanMotionEnergy: safeNumber(input.meanMotionEnergy, `${field}.meanMotionEnergy`, 0, 1),
    stasisRatio: safeNumber(input.stasisRatio, `${field}.stasisRatio`, 0, 1),
    meanAccelerationEnergy: safeNumber(input.meanAccelerationEnergy, `${field}.meanAccelerationEnergy`, 0, 1),
    accelerationEnergyP99: safeNumber(input.accelerationEnergyP99, `${field}.accelerationEnergyP99`, 0, 1),
    meanJerkEnergy: safeNumber(input.meanJerkEnergy, `${field}.meanJerkEnergy`, 0, 1),
    jerkEnergyP99: safeNumber(input.jerkEnergyP99, `${field}.jerkEnergyP99`, 0, 1),
    peakJerkEnergy: safeNumber(input.peakJerkEnergy, `${field}.peakJerkEnergy`, 0, 1),
  };
  if (value.endFrame <= value.startFrame || value.jerkEnergyP99 > value.peakJerkEnergy + 1e-12) {
    fail(field, "segment_metric_inconsistent");
  }
  return value;
}

function normalizeMotionProof(input, technical, browserGeometry) {
  const field = "motionCalibration.qa.motion";
  exactKeys(input, [
    "passed",
    "checks",
    "technical",
    "motion",
    "clippedEntities",
    "captionSafeZoneViolations",
  ], field);
  trueBoolean(input.passed, `${field}.passed`);
  integer(input.clippedEntities, `${field}.clippedEntities`, 0, 0);
  integer(input.captionSafeZoneViolations, `${field}.captionSafeZoneViolations`, 0, 0);
  exactKeys(input.checks, REQUIRED_MOTION_CHECKS, `${field}.checks`);
  for (const key of REQUIRED_MOTION_CHECKS) trueBoolean(input.checks[key], `${field}.checks.${key}`);
  if (stableStringify(input.technical) !== stableStringify(technical)) {
    fail(`${field}.technical`, "technical_metadata_mismatch");
  }
  const motion = input.motion;
  exactKeys(motion, MOTION_FIELDS, `${field}.motion`);
  token(motion.temporalMetricProfileId, `${field}.motion.temporalMetricProfileId`, [MOTION_TEMPORAL_METRIC_PROFILE_ID]);
  token(motion.temporalThresholdStatus, `${field}.motion.temporalThresholdStatus`, ["provisional"]);
  const motionAnalysisProfileId = token(
    motion.motionAnalysisProfileId,
    `${field}.motion.motionAnalysisProfileId`,
    [MOTION_ANALYSIS_PROFILE_ID],
  );
  const readabilityHoldPolicyId = token(
    motion.readabilityHoldPolicyId,
    `${field}.motion.readabilityHoldPolicyId`,
    [READABILITY_HOLD_POLICY_ID],
  );
  const segmentPolicyId = token(
    motion.segmentPolicyId,
    `${field}.motion.segmentPolicyId`,
    [SEGMENT_POLICY_ID],
  );
  const readabilityHoldRangesHash = hash(motion.readabilityHoldRangesHash, `${field}.motion.readabilityHoldRangesHash`);
  const segmentRangesHash = hash(motion.segmentRangesHash, `${field}.motion.segmentRangesHash`);
  const motionConfigurationHash = hash(motion.motionConfigurationHash, `${field}.motion.motionConfigurationHash`);
  const expectedGeometry = expectedMotionGeometry(browserGeometry.semanticRoi, technical);
  const analysisWidth = integer(motion.analysisWidth, `${field}.motion.analysisWidth`, 1, technical.width);
  const analysisHeight = integer(motion.analysisHeight, `${field}.motion.analysisHeight`, 1, technical.height);
  if (
    analysisWidth !== expectedGeometry.analysisWidth
    || analysisHeight !== expectedGeometry.analysisHeight
  ) fail(`${field}.motion.analysisDimensions`, "semantic_roi_scale_mismatch");
  const decodedFrameSequenceHash = hash(
    motion.decodedFrameSequenceHash,
    `${field}.motion.decodedFrameSequenceHash`,
  );
  const frameCount = integer(motion.frameCount, `${field}.motion.frameCount`, 30, 100_000_000);
  if (frameCount !== technical.frameCount) fail(`${field}.motion.frameCount`, "frame_count_mismatch");
  const transitionCount = integer(motion.transitionCount, `${field}.motion.transitionCount`, 1, frameCount - 1);
  if (transitionCount !== frameCount - 1) fail(`${field}.motion.transitionCount`, "consecutive_transition_count_required");
  const analyzedTransitionCount = integer(motion.analyzedTransitionCount, `${field}.motion.analyzedTransitionCount`, 1, transitionCount);
  const excludedReadabilityHoldTransitions = integer(
    motion.excludedReadabilityHoldTransitions,
    `${field}.motion.excludedReadabilityHoldTransitions`,
    0,
    transitionCount - 1,
  );
  if (
    analyzedTransitionCount + excludedReadabilityHoldTransitions !== transitionCount
    || analyzedTransitionCount / transitionCount < MINIMUM_ANALYZED_TRANSITION_RATIO
  ) fail(`${field}.motion.analyzedTransitionCount`, "insufficient_motion_coverage");
  integer(motion.semanticPixelCount, `${field}.motion.semanticPixelCount`, analysisWidth * analysisHeight, analysisWidth * analysisHeight);
  const motionThreshold = safeNumber(motion.motionThreshold, `${field}.motion.motionThreshold`, Number.EPSILON, 1 - Number.EPSILON);
  integer(motion.firstMeaningfulMotionFrame, `${field}.motion.firstMeaningfulMotionFrame`, 1, frameCount - 1);
  const ratioFields = [
    "consecutiveStasisRatio",
    "meanMotionEnergy",
    "motionEnergyP50",
    "motionEnergyP90",
    "motionEnergyP99",
    "peakMotionEnergy",
    "meanAccelerationEnergy",
    "accelerationEnergyP90",
    "accelerationEnergyP99",
    "peakAccelerationEnergy",
    "meanJerkEnergy",
    "jerkEnergyP90",
    "jerkEnergyP99",
    "peakJerkEnergy",
    "maxWindowMotionShare",
    "rawMaxWindowMotionShare",
    "uniqueFrameRatio",
    "changedTransitionRatio",
    "stasisRatio",
    "motionEnergy",
  ];
  for (const name of ratioFields) safeNumber(motion[name], `${field}.motion.${name}`, 0, 1);
  integer(motion.maxContiguousStasisFrames, `${field}.motion.maxContiguousStasisFrames`, 0, frameCount - 1);
  integer(motion.analyzedAccelerationTransitionCount, `${field}.motion.analyzedAccelerationTransitionCount`, 1, frameCount - 2);
  integer(motion.analyzedJerkTransitionCount, `${field}.motion.analyzedJerkTransitionCount`, 1, frameCount - 3);
  integer(motion.peakMotionFrame, `${field}.motion.peakMotionFrame`, 1, frameCount - 1);
  integer(motion.peakAccelerationFrame, `${field}.motion.peakAccelerationFrame`, 2, frameCount - 1);
  integer(motion.peakJerkFrame, `${field}.motion.peakJerkFrame`, 3, frameCount - 1);
  integer(motion.rollingWindowFrames, `${field}.motion.rollingWindowFrames`, 2, transitionCount);
  token(motion.windowEnergyTransform, `${field}.motion.windowEnergyTransform`, ["sqrt"]);
  integer(motion.maxWindowStartFrame, `${field}.motion.maxWindowStartFrame`, 0, frameCount - 1);
  integer(motion.maxWindowEndFrame, `${field}.motion.maxWindowEndFrame`, motion.maxWindowStartFrame, frameCount - 1);
  integer(motion.rawMaxWindowStartFrame, `${field}.motion.rawMaxWindowStartFrame`, 0, frameCount - 1);
  integer(motion.rawMaxWindowEndFrame, `${field}.motion.rawMaxWindowEndFrame`, motion.rawMaxWindowStartFrame, frameCount - 1);
  safeNumber(motion.meanLuma, `${field}.motion.meanLuma`, 0, 255);
  integer(motion.sampleCount, `${field}.motion.sampleCount`, frameCount, frameCount);
  let derivedStructuralChecks;
  try {
    derivedStructuralChecks = evaluateMotionQuality(motion);
  } catch {
    fail(`${field}.motion`, "structural_motion_policy_invalid");
  }
  for (const [name, passed] of Object.entries(derivedStructuralChecks)) {
    if (passed !== true || input.checks[name] !== passed) {
      fail(`${field}.checks.${name}`, "structural_motion_check_mismatch");
    }
  }
  if (
    (motion.meanLuma > 4) !== input.checks.readableNonBlack
    || input.checks.readableNonBlack !== true
  ) fail(`${field}.checks.readableNonBlack`, "structural_motion_check_mismatch");
  if (
    motion.motionEnergyP50 > motion.motionEnergyP90 + 1e-12
    || motion.motionEnergyP90 > motion.motionEnergyP99 + 1e-12
    || motion.motionEnergyP99 > motion.peakMotionEnergy + 1e-12
    || motion.accelerationEnergyP90 > motion.accelerationEnergyP99 + 1e-12
    || motion.accelerationEnergyP99 > motion.peakAccelerationEnergy + 1e-12
    || motion.jerkEnergyP90 > motion.jerkEnergyP99 + 1e-12
    || motion.jerkEnergyP99 > motion.peakJerkEnergy + 1e-12
    || Math.abs(motion.stasisRatio - motion.consecutiveStasisRatio) > 1e-12
    || Math.abs(motion.motionEnergy - motion.meanMotionEnergy) > 1e-12
  ) fail(`${field}.motion`, "aggregate_metric_inconsistent");
  const segmentMetrics = denseArray(
    motion.segmentMetrics,
    `${field}.motion.segmentMetrics`,
    2,
    200,
  ).map((entry, index) => normalizeSegmentMetric(entry, index, frameCount));
  canonicalUnique(
    segmentMetrics.map((entry) => entry.id),
    `${field}.motion.segmentMetrics.id`,
    { sorted: false },
  );
  for (let index = 1; index < segmentMetrics.length; index += 1) {
    if (segmentMetrics[index].startFrame < segmentMetrics[index - 1].endFrame) {
      fail(`${field}.motion.segmentMetrics[${index}]`, "overlapping_segments_forbidden");
    }
  }
  const boundaryMetrics = denseArray(
    motion.boundaryMetrics,
    `${field}.motion.boundaryMetrics`,
    segmentMetrics.length - 1,
    segmentMetrics.length - 1,
  ).map((entry, index) => normalizeBoundaryMetric(
    entry,
    index,
    frameCount,
    motionThreshold,
  ));
  for (let index = 0; index < boundaryMetrics.length; index += 1) {
    if (boundaryMetrics[index].frame !== segmentMetrics[index + 1].startFrame) {
      fail(`${field}.motion.boundaryMetrics[${index}].frame`, "segment_boundary_mismatch");
    }
  }
  const maximumBoundaryJumpRatio = safeNumber(
    motion.maximumBoundaryJumpRatio,
    `${field}.motion.maximumBoundaryJumpRatio`,
    0,
    1_000_000,
  );
  const derivedBoundaryMaximum = Math.max(...boundaryMetrics.map((entry) => entry.jumpRatio));
  if (Math.abs(maximumBoundaryJumpRatio - derivedBoundaryMaximum) > 1e-12) {
    fail(`${field}.motion.maximumBoundaryJumpRatio`, "boundary_maximum_mismatch");
  }
  let expectedConfigurationHash;
  try {
    expectedConfigurationHash = motionAnalysisConfigurationHash({
      motionAnalysisProfileId,
      readabilityHoldPolicyId,
      segmentPolicyId,
      readabilityHoldRangesHash,
      segmentRangesHash,
      motionThreshold,
      analysisWidth,
      analysisHeight,
    });
  } catch {
    fail(`${field}.motion.motionConfigurationHash`, "configuration_invalid");
  }
  if (motionConfigurationHash !== expectedConfigurationHash) {
    fail(`${field}.motion.motionConfigurationHash`, "configuration_hash_mismatch");
  }
  return {
    rawMotion: motion,
    expectedGeometry,
    decodedFrameSequenceHash,
    motionAnalysisProfileId,
    readabilityHoldPolicyId,
    segmentPolicyId,
    readabilityHoldRangesHash,
    segmentRangesHash,
    motionThreshold,
    analysisWidth,
    analysisHeight,
    maximumBoundaryJumpRatio,
    segmentMetrics,
  };
}

function normalizeTechnical(input, field) {
  exactKeys(input, [
    "codec",
    "pixelFormat",
    "width",
    "height",
    "fps",
    "frameCount",
    "durationSeconds",
  ], field);
  const technical = {
    codec: token(input.codec, `${field}.codec`, ["h264"]),
    pixelFormat: token(input.pixelFormat, `${field}.pixelFormat`, ["yuv420p"]),
    width: integer(input.width, `${field}.width`, 360, 7680),
    height: integer(input.height, `${field}.height`, 640, 7680),
    fps: safeNumber(input.fps, `${field}.fps`, 24, 60),
    frameCount: integer(input.frameCount, `${field}.frameCount`, 30, 100_000_000),
    durationSeconds: safeNumber(input.durationSeconds, `${field}.durationSeconds`, 0.01, 86_400),
  };
  if (Math.abs(technical.durationSeconds - technical.frameCount / technical.fps) >= 0.04) {
    fail(field, "duration_frame_rate_mismatch");
  }
  return technical;
}

function normalizeReview(record, expected) {
  if (record === null) return null;
  const body = record.envelope.body;
  exactKeys(body, [
    "schemaVersion",
    "profileId",
    "draftHash",
    "storyIdentityHash",
    "sourceFingerprintHash",
    "animationQaArtifactId",
    "animationQaHash",
    "renderManifestArtifactId",
    "renderManifestHash",
    "visualMasterSha256",
    "reviewerIdHash",
    "jerkVerdict",
    "boundaryVerdict",
    "reasonCodes",
  ], "motionCalibration.reviewArtifact.envelope.body");
  integer(body.schemaVersion, "motionCalibration.review.schemaVersion", 1, 1);
  token(body.profileId, "motionCalibration.review.profileId", [
    MOTION_CALIBRATION_REVIEW_PROFILE_ID,
  ]);
  const bindings = {
    draftHash: hash(body.draftHash, "motionCalibration.review.draftHash"),
    storyIdentityHash: hash(body.storyIdentityHash, "motionCalibration.review.storyIdentityHash"),
    sourceFingerprintHash: hash(body.sourceFingerprintHash, "motionCalibration.review.sourceFingerprintHash"),
    animationQaArtifactId: artifactId(body.animationQaArtifactId, "motionCalibration.review.animationQaArtifactId"),
    animationQaHash: hash(body.animationQaHash, "motionCalibration.review.animationQaHash"),
    renderManifestArtifactId: artifactId(body.renderManifestArtifactId, "motionCalibration.review.renderManifestArtifactId"),
    renderManifestHash: hash(body.renderManifestHash, "motionCalibration.review.renderManifestHash"),
    visualMasterSha256: hash(body.visualMasterSha256, "motionCalibration.review.visualMasterSha256"),
  };
  for (const [key, value] of Object.entries(bindings)) {
    if (value !== expected[key]) fail(`motionCalibration.review.${key}`, "binding_mismatch");
  }
  const reviewerIdHash = hash(body.reviewerIdHash, "motionCalibration.review.reviewerIdHash");
  const jerkVerdict = token(body.jerkVerdict, "motionCalibration.review.jerkVerdict", ["pass", "fail"]);
  const boundaryVerdict = token(body.boundaryVerdict, "motionCalibration.review.boundaryVerdict", ["pass", "fail"]);
  const reasonCodes = denseArray(
    body.reasonCodes,
    "motionCalibration.review.reasonCodes",
    0,
    REVIEW_REASON_CODES.length,
  ).map((value, index) => token(
    value,
    `motionCalibration.review.reasonCodes[${index}]`,
    REVIEW_REASON_CODES,
  ));
  canonicalUnique(reasonCodes, "motionCalibration.review.reasonCodes");
  if (
    (jerkVerdict === "fail") !== reasonCodes.includes("jerk_discomfort")
    || (boundaryVerdict === "fail") !== reasonCodes.includes("boundary_discontinuity")
    || (jerkVerdict === "pass" && boundaryVerdict === "pass" && reasonCodes.length !== 0)
  ) fail("motionCalibration.review.reasonCodes", "review_reasons_inconsistent");
  exactDependencies(record, [
    expected.draftHash,
    expected.storyIdentityHash,
    expected.sourceFingerprintHash,
    expected.animationQaHash,
    expected.renderManifestHash,
    expected.visualMasterSha256,
  ], "motionCalibration.reviewArtifact.envelope.dependencyHashes");
  return {
    reviewArtifactId: record.artifactId,
    reviewArtifactHash: record.envelope.contentHash,
    reviewerIdHash,
    jerkVerdict,
    boundaryVerdict,
    reasonCodes,
  };
}

function optionalScenePlanDependencies(record, expected) {
  const body = record.envelope.body;
  const bindings = body.bindings;
  strictDataObject(bindings, "motionCalibration.scenePlanArtifact.envelope.body.bindings");
  const required = [
    expected.draftHash,
    expected.alignmentHash,
    expected.timingHash,
    hash(bindings.semanticEventGraphHash, "motionCalibration.scenePlan.bindings.semanticEventGraphHash"),
    hash(bindings.semanticVisualSentencePlanHash, "motionCalibration.scenePlan.bindings.semanticVisualSentencePlanHash"),
  ];
  const dependencies = record.envelope.dependencyHashes;
  if (
    dependencies.length !== 6
    || required.some((value) => !dependencies.includes(value))
  ) fail("motionCalibration.scenePlanArtifact.envelope.dependencyHashes", "scene_plan_dependency_mismatch");
  return dependencies.find((value) => !required.includes(value));
}

async function motionCalibrationCaseFromArtifacts(input) {
  exactKeys(input, [
    "contentArtifactRepository",
    "draftArtifactId",
    "alignmentArtifactId",
    "timingArtifactId",
    "scenePlanArtifactId",
    "planArtifactId",
    "irArtifactId",
    "qaArtifactId",
    "renderManifestArtifactId",
    "reviewArtifactId",
  ], "motionCalibrationArtifactInput");
  const repository = own(input, "contentArtifactRepository");
  const draft = repositoryArtifact(repository, own(input, "draftArtifactId"), "approval_bundle", "motionCalibration.draftArtifact");
  const alignment = repositoryArtifact(repository, own(input, "alignmentArtifactId"), "narration_alignment", "motionCalibration.alignmentArtifact");
  const timing = repositoryArtifact(repository, own(input, "timingArtifactId"), "animation_timing_context", "motionCalibration.timingArtifact");
  const scenePlanId = nullableArtifactId(own(input, "scenePlanArtifactId"), "motionCalibration.scenePlanArtifactId");
  const scenePlan = scenePlanId === null ? null : repositoryArtifact(repository, scenePlanId, "animation_scene_dsl_plan", "motionCalibration.scenePlanArtifact");
  const plan = repositoryArtifact(repository, own(input, "planArtifactId"), "animation_plan", "motionCalibration.planArtifact");
  const ir = repositoryArtifact(repository, own(input, "irArtifactId"), "animation_ir", "motionCalibration.irArtifact");
  const qa = repositoryArtifact(repository, own(input, "qaArtifactId"), "animation_qa_report", "motionCalibration.qaArtifact");
  const manifest = repositoryArtifact(repository, own(input, "renderManifestArtifactId"), "animation_render_manifest", "motionCalibration.renderManifestArtifact");
  const reviewId = nullableArtifactId(own(input, "reviewArtifactId"), "motionCalibration.reviewArtifactId");
  const reviewRecord = reviewId === null ? null : repositoryArtifact(repository, reviewId, "animation_motion_review", "motionCalibration.reviewArtifact");
  sameProjectRevision([
    draft,
    alignment,
    timing,
    ...(scenePlan ? [scenePlan] : []),
    plan,
    ir,
    qa,
    manifest,
    ...(reviewRecord ? [reviewRecord] : []),
  ]);

  const draftHash = draft.envelope.contentHash;
  let normalizedDraft;
  try {
    normalizedDraft = normalizeDraftBundle(draft.envelope.body);
  } catch {
    fail("motionCalibration.draftArtifact.envelope.body", "approved_draft_invalid");
  }
  if (normalizedDraft.contentHash !== draftHash) {
    fail("motionCalibration.draftArtifact.envelope.contentHash", "approved_draft_hash_mismatch");
  }
  exactDependencies(draft, [
    normalizedDraft.brief.contentHash,
    normalizedDraft.claimLedger.contentHash,
    normalizedDraft.script.contentHash,
    normalizedDraft.storyboard.contentHash,
  ], "motionCalibration.draftArtifact.envelope.dependencyHashes");
  const {
    storyIdentityHash,
    sourceFingerprintHash,
    storySemanticTokens,
  } = storyIdentities(normalizedDraft);

  let normalizedAlignment;
  try {
    normalizedAlignment = normalizeAlignment(alignment.envelope.body);
  } catch {
    fail("motionCalibration.alignmentArtifact.envelope.body", "alignment_invalid");
  }
  const alignmentHash = alignment.envelope.contentHash;
  if (
    normalizedAlignment.contentHash !== alignmentHash
    || normalizedAlignment.projectId !== draft.envelope.projectId
    || normalizedAlignment.projectRevision !== draft.envelope.revision
    || normalizedAlignment.draftArtifactId !== draft.artifactId
    || normalizedAlignment.draftHash !== draftHash
    || normalizedAlignment.scriptHash !== normalizedDraft.script.contentHash
  ) fail("motionCalibration.alignmentArtifact", "alignment_binding_mismatch");
  exactDependencies(alignment, [
    draftHash,
    normalizedDraft.script.contentHash,
    normalizedAlignment.narrationManifestHash,
    normalizedAlignment.audioHash,
  ], "motionCalibration.alignmentArtifact.envelope.dependencyHashes");

  let expectedTiming;
  try {
    expectedTiming = buildProductionTimingContext({
      draft: normalizedDraft,
      alignment: normalizedAlignment,
      projectId: draft.envelope.projectId,
      projectRevision: draft.envelope.revision,
      draftArtifactId: draft.artifactId,
      draftHash,
      alignmentHash,
    });
  } catch {
    fail("motionCalibration.timingArtifact", "timing_source_binding_invalid");
  }
  const timingHash = timing.envelope.contentHash;
  if (
    expectedTiming.contentHash !== timingHash
    || stableStringify(expectedTiming) !== stableStringify(timing.envelope.body)
  ) fail("motionCalibration.timingArtifact", "timing_recompile_mismatch");
  exactDependencies(timing, [draftHash, alignmentHash], "motionCalibration.timingArtifact.envelope.dependencyHashes");

  const qaBody = qa.envelope.body;
  const qaRequired = [
    "schemaVersion",
    "status",
    "draftArtifactId",
    "draftHash",
    "alignmentArtifactId",
    "alignmentHash",
    "timingContextArtifactId",
    "timingContextHash",
    "animationPlanArtifactId",
    "animationPlanHash",
    "animationIRArtifactId",
    "animationIRHash",
    "renderProfile",
    "renderQuality",
    "semanticProfileId",
    "provider",
    "runtimeVersion",
    "styleVersion",
    "compositionHash",
    "visualMasterSha256",
    "browserProofHash",
    "motionProofHash",
    "browser",
    "motion",
  ];
  const qaOptional = ["animationScenePlanArtifactId", "animationScenePlanHash"];
  allowedKeys(qaBody, qaRequired, qaOptional, "motionCalibration.qaArtifact.envelope.body");
  integer(qaBody.schemaVersion, "motionCalibration.qa.schemaVersion", 1, 1);
  token(qaBody.status, "motionCalibration.qa.status", ["passed"]);
  const planHash = plan.envelope.contentHash;
  const irHash = ir.envelope.contentHash;
  const qaBindings = {
    draftArtifactId: draft.artifactId,
    draftHash,
    alignmentArtifactId: alignment.artifactId,
    alignmentHash,
    timingContextArtifactId: timing.artifactId,
    timingContextHash: timingHash,
    animationPlanArtifactId: plan.artifactId,
    animationPlanHash: planHash,
    animationIRArtifactId: ir.artifactId,
    animationIRHash: irHash,
  };
  for (const [key, expected] of Object.entries(qaBindings)) {
    if (qaBody[key] !== expected) fail(`motionCalibration.qa.${key}`, "binding_mismatch");
  }
  const hasScenePlanBinding = Object.hasOwn(qaBody, "animationScenePlanArtifactId")
    || Object.hasOwn(qaBody, "animationScenePlanHash");
  if (
    hasScenePlanBinding !== Boolean(scenePlan)
    || (scenePlan && (
      qaBody.animationScenePlanArtifactId !== scenePlan.artifactId
      || qaBody.animationScenePlanHash !== scenePlan.envelope.contentHash
    ))
  ) fail("motionCalibration.qa.animationScenePlan", "scene_plan_binding_mismatch");
  const renderProfile = token(qaBody.renderProfile, "motionCalibration.qa.renderProfile", ["preview", "final"]);
  const renderQuality = token(qaBody.renderQuality, "motionCalibration.qa.renderQuality", ["standard", "high"]);
  if ((renderProfile === "final" ? "high" : "standard") !== renderQuality) {
    fail("motionCalibration.qa.renderQuality", "render_quality_profile_mismatch");
  }
  const semanticProfileId = token(qaBody.semanticProfileId, "motionCalibration.qa.semanticProfileId");
  const provider = token(qaBody.provider, "motionCalibration.qa.provider");
  const runtimeVersion = token(qaBody.runtimeVersion, "motionCalibration.qa.runtimeVersion");
  const styleVersion = token(qaBody.styleVersion, "motionCalibration.qa.styleVersion");
  const compositionHash = hash(qaBody.compositionHash, "motionCalibration.qa.compositionHash");
  const visualMasterSha256 = hash(qaBody.visualMasterSha256, "motionCalibration.qa.visualMasterSha256");
  const browserProofHash = hash(qaBody.browserProofHash, "motionCalibration.qa.browserProofHash");
  const motionProofHash = hash(qaBody.motionProofHash, "motionCalibration.qa.motionProofHash");
  if (
    contentHash(qaBody.browser) !== browserProofHash
    || contentHash(qaBody.motion) !== motionProofHash
  ) fail("motionCalibration.qa", "proof_hash_mismatch");
  forbidPrivateEvidence(qaBody, "motionCalibration.qa");

  const technical = normalizeTechnical(
    qaBody.motion.technical,
    "motionCalibration.qa.motion.technical",
  );
  const browserEvidence = normalizeBrowserProof(qaBody.browser, technical);
  const motionEvidence = normalizeMotionProof(
    qaBody.motion,
    technical,
    browserEvidence,
  );

  let expectedCompiled;
  try {
    expectedCompiled = compileProductionAnimation({
      draft: normalizedDraft,
      timingContext: expectedTiming,
      projectId: draft.envelope.projectId,
      projectRevision: draft.envelope.revision,
      renderProfile,
      ...(semanticProfileId === SEMANTIC_SENTENCE_PROFILE_ID
        ? { animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN }
        : {}),
      ...(scenePlan
        ? { semanticAnimationSceneDslPlan: scenePlan.envelope.body }
        : {}),
    });
  } catch {
    fail("motionCalibration.animationCompilation", "trusted_recompile_failed");
  }
  if (
    stableStringify(expectedCompiled.plan) !== stableStringify(plan.envelope.body)
    || stableStringify(expectedCompiled.animationIR) !== stableStringify(ir.envelope.body)
  ) fail("motionCalibration.animationCompilation", "trusted_recompile_mismatch");
  if (
    expectedCompiled.animationIR.contentHash !== irHash
    || expectedCompiled.animationIR.width !== technical.width
    || expectedCompiled.animationIR.height !== technical.height
    || expectedCompiled.animationIR.fps !== technical.fps
    || expectedCompiled.animationIR.durationFrames !== technical.frameCount
    || expectedCompiled.animationIR.renderer.provider !== provider
    || expectedCompiled.animationIR.renderer.runtimeVersion !== runtimeVersion
    || expectedCompiled.animationIR.renderer.styleVersion !== styleVersion
    || expectedCompiled.animationIR.content?.semantic?.profileId !== semanticProfileId
  ) fail("motionCalibration.irArtifact", "render_profile_binding_mismatch");
  let trustedComposition;
  try {
    const { compileAnimationIRToHtml } = await import(
      "../../../../renderer/hyperframes/animation-ir-adapter.mjs"
    );
    trustedComposition = compileAnimationIRToHtml(expectedCompiled.animationIR, {
      semanticSourceContext: {
        draft: normalizedDraft,
        timingContext: expectedTiming,
      },
    });
  } catch {
    fail(
      "motionCalibration.animationComposition",
      "trusted_composition_recompile_failed",
    );
  }
  if (trustedComposition.compositionHash !== compositionHash) {
    fail(
      "motionCalibration.qa.compositionHash",
      "trusted_composition_hash_mismatch",
    );
  }
  assertBrowserExpectationBinding(
    browserEvidence,
    expectedCompiled.animationIR,
    trustedComposition.actionQa || null,
    trustedComposition.qaPolicy,
  );
  const expectedSegments = motionSegments(expectedCompiled.animationIR);
  const expectedReadabilityHolds = expectedCompiled.animationIR.scenes.flatMap(
    (scene) => scene.readabilityHolds.map((hold, index) => ({
      id: `${scene.id}_hold_${index}`,
      startFrame: hold.startFrame,
      endFrame: hold.endFrame,
    })),
  );
  let expectedSegmentRangesHash;
  let expectedReadabilityHoldRangesHash;
  try {
    expectedSegmentRangesHash = motionAnalysisRangeHash(
      SEGMENT_POLICY_ID,
      expectedSegments,
    );
    expectedReadabilityHoldRangesHash = motionAnalysisRangeHash(
      READABILITY_HOLD_POLICY_ID,
      expectedReadabilityHolds,
    );
  } catch {
    fail("motionCalibration.motionRanges", "trusted_range_derivation_failed");
  }
  if (
    motionEvidence.segmentRangesHash !== expectedSegmentRangesHash
    || motionEvidence.readabilityHoldRangesHash !== expectedReadabilityHoldRangesHash
    || stableStringify(motionEvidence.segmentMetrics.map((entry) => ({
      id: entry.id,
      startFrame: entry.startFrame,
      endFrame: entry.endFrame,
    }))) !== stableStringify(expectedSegments)
  ) fail("motionCalibration.motionRanges", "animation_ir_range_binding_mismatch");
  const heldTransitionCount = (firstFrame) => {
    let count = 0;
    for (let frame = firstFrame; frame < technical.frameCount; frame += 1) {
      if (expectedReadabilityHolds.some((range) => (
        frame >= range.startFrame && frame < range.endFrame
      ))) count += 1;
    }
    return count;
  };
  if (
    motionEvidence.rawMotion.excludedReadabilityHoldTransitions
      !== heldTransitionCount(1)
    || motionEvidence.rawMotion.analyzedAccelerationTransitionCount
      !== technical.frameCount - 2 - heldTransitionCount(2)
    || motionEvidence.rawMotion.analyzedJerkTransitionCount
      !== technical.frameCount - 3 - heldTransitionCount(3)
  ) fail("motionCalibration.motionRanges", "readability_hold_coverage_mismatch");
  exactDependencies(plan, [
    draftHash,
    alignmentHash,
    timingHash,
    ...(scenePlan ? [scenePlan.envelope.contentHash] : []),
  ], "motionCalibration.planArtifact.envelope.dependencyHashes");
  exactDependencies(ir, [timingHash, planHash], "motionCalibration.irArtifact.envelope.dependencyHashes");
  let scenePlannerConfigurationHash = null;
  if (scenePlan) {
    scenePlannerConfigurationHash = optionalScenePlanDependencies(scenePlan, {
      draftHash,
      alignmentHash,
      timingHash,
    });
  }
  exactDependencies(qa, [
    draftHash,
    alignmentHash,
    timingHash,
    planHash,
    irHash,
    visualMasterSha256,
    browserProofHash,
    motionProofHash,
    ...(scenePlan ? [scenePlan.envelope.contentHash] : []),
  ], "motionCalibration.qaArtifact.envelope.dependencyHashes");

  const manifestBody = manifest.envelope.body;
  const manifestRequired = [
    "schemaVersion",
    "draftArtifactId",
    "draftHash",
    "alignmentArtifactId",
    "alignmentHash",
    "timingContextArtifactId",
    "timingContextHash",
    "animationPlanArtifactId",
    "animationPlanHash",
    "animationIRArtifactId",
    "animationIRHash",
    "renderProfile",
    "renderQuality",
    "semanticProfileId",
    "provider",
    "runtimeVersion",
    "styleVersion",
    "compositionHash",
    "visualMasterSha256",
    "browserProofHash",
    "motionProofHash",
    "animationQaArtifactId",
    "animationQaHash",
    "estimate",
  ];
  const manifestOptional = ["animationScenePlanArtifactId", "animationScenePlanHash"];
  allowedKeys(manifestBody, manifestRequired, manifestOptional, "motionCalibration.renderManifestArtifact.envelope.body");
  integer(manifestBody.schemaVersion, "motionCalibration.manifest.schemaVersion", 1, 1);
  const manifestHash = manifest.envelope.contentHash;
  const manifestBindings = {
    ...qaBindings,
    renderProfile,
    renderQuality,
    semanticProfileId,
    provider,
    runtimeVersion,
    styleVersion,
    compositionHash,
    visualMasterSha256,
    browserProofHash,
    motionProofHash,
    animationQaArtifactId: qa.artifactId,
    animationQaHash: qa.envelope.contentHash,
  };
  for (const [key, expected] of Object.entries(manifestBindings)) {
    if (manifestBody[key] !== expected) fail(`motionCalibration.manifest.${key}`, "binding_mismatch");
  }
  const manifestHasScenePlan = Object.hasOwn(manifestBody, "animationScenePlanArtifactId")
    || Object.hasOwn(manifestBody, "animationScenePlanHash");
  if (
    manifestHasScenePlan !== Boolean(scenePlan)
    || (scenePlan && (
      manifestBody.animationScenePlanArtifactId !== scenePlan.artifactId
      || manifestBody.animationScenePlanHash !== scenePlan.envelope.contentHash
    ))
  ) fail("motionCalibration.manifest.animationScenePlan", "scene_plan_binding_mismatch");
  exactKeys(manifestBody.estimate, [
    "frames",
    "durationSeconds",
    "complexityCost",
    "estimatedMemoryMb",
    "expectedDurationSeconds",
  ], "motionCalibration.manifest.estimate");
  integer(
    manifestBody.estimate.frames,
    "motionCalibration.manifest.estimate.frames",
    technical.frameCount,
    technical.frameCount,
  );
  if (
    Math.abs(
      safeNumber(
        manifestBody.estimate.durationSeconds,
        "motionCalibration.manifest.estimate.durationSeconds",
        0.01,
        86_400,
      ) - technical.frameCount / technical.fps
    ) > 1e-12
  ) fail("motionCalibration.manifest.estimate.durationSeconds", "estimate_binding_mismatch");
  safeNumber(manifestBody.estimate.complexityCost, "motionCalibration.manifest.estimate.complexityCost", 0, 1_000_000);
  safeNumber(manifestBody.estimate.estimatedMemoryMb, "motionCalibration.manifest.estimate.estimatedMemoryMb", 0, 1_000_000);
  safeNumber(manifestBody.estimate.expectedDurationSeconds, "motionCalibration.manifest.estimate.expectedDurationSeconds", 0, 86_400);
  exactDependencies(manifest, [
    draftHash,
    alignmentHash,
    timingHash,
    planHash,
    irHash,
    qa.envelope.contentHash,
    visualMasterSha256,
    browserProofHash,
    motionProofHash,
    ...(scenePlan ? [scenePlan.envelope.contentHash] : []),
  ], "motionCalibration.renderManifestArtifact.envelope.dependencyHashes");

  const adapted = motionIntegrityCaseFromBenchmarkQa({
    // `sourceKind` is required by the legacy metric adapter. It is not an
    // execution or source attestation; this corpus remains shadow-only.
    caseId: `repo_${qa.envelope.contentHash.slice(0, 24)}`,
    sourceFixtureId: `story_${storyIdentityHash.slice(0, 24)}`,
    sourceKind: "real",
    structuralPassed: true,
    motion: motionEvidence.rawMotion,
  });
  if (
    adapted.metrics.jerkEnergyP99 > adapted.metrics.peakJerkEnergy + 1e-12
    || adapted.metrics.maximumBoundaryJumpRatio !== motionEvidence.maximumBoundaryJumpRatio
  ) fail("motionCalibration.metrics", "derived_metric_inconsistent");
  const review = normalizeReview(reviewRecord, {
    draftHash,
    storyIdentityHash,
    sourceFingerprintHash,
    animationQaArtifactId: qa.artifactId,
    animationQaHash: qa.envelope.contentHash,
    renderManifestArtifactId: manifest.artifactId,
    renderManifestHash: manifestHash,
    visualMasterSha256,
  });
  const stratum = {
    temporalMetricProfileId: MOTION_TEMPORAL_METRIC_PROFILE_ID,
    motionAnalysisProfileId: motionEvidence.motionAnalysisProfileId,
    readabilityHoldPolicyId: motionEvidence.readabilityHoldPolicyId,
    segmentPolicyId: motionEvidence.segmentPolicyId,
    motionThreshold: motionEvidence.motionThreshold,
    semanticProfileId,
    provider,
    runtimeVersion,
    styleVersion,
    renderProfile,
    renderQuality,
    analysisWidth: motionEvidence.analysisWidth,
    analysisHeight: motionEvidence.analysisHeight,
    semanticRoi: motionEvidence.expectedGeometry.semanticRoi,
    width: technical.width,
    height: technical.height,
    fps: technical.fps,
    codec: technical.codec,
    pixelFormat: technical.pixelFormat,
  };
  const output = deepFreeze({
    schemaVersion: 1,
    caseId: adapted.caseId,
    sourceFixtureId: adapted.sourceFixtureId,
    projectId: draft.envelope.projectId,
    projectRevision: draft.envelope.revision,
    storyIdentityHash,
    sourceFingerprintHash,
    draftHash,
    draftArtifactId: draft.artifactId,
    alignmentArtifactId: alignment.artifactId,
    timingArtifactId: timing.artifactId,
    timingArtifactHash: timingHash,
    scenePlanArtifactId: scenePlan?.artifactId || null,
    scenePlanArtifactHash: scenePlan?.envelope.contentHash || null,
    scenePlannerConfigurationHash,
    animationPlanArtifactId: plan.artifactId,
    animationPlanArtifactHash: planHash,
    animationIRArtifactId: ir.artifactId,
    animationIRArtifactHash: irHash,
    qaArtifactId: qa.artifactId,
    qaArtifactHash: qa.envelope.contentHash,
    renderManifestArtifactId: manifest.artifactId,
    renderManifestArtifactHash: manifestHash,
    visualMasterSha256,
    decodedFrameSequenceHash: motionEvidence.decodedFrameSequenceHash,
    browserProofHash,
    motionProofHash,
    compositionHash,
    stratum,
    metrics: { ...adapted.metrics },
    review,
  });
  VERIFIED_CASES.add(output);
  VERIFIED_CASE_SEMANTIC_TOKENS.set(output, storySemanticTokens);
  return output;
}

function rounded(value) {
  const output = Number(value.toFixed(12));
  return Object.is(output, -0) ? 0 : output;
}

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * ratio) - 1);
  return ordered[index];
}

function normalizeStratum(input, field = "motionCalibration.stratum") {
  exactKeys(input, [
    "temporalMetricProfileId",
    "motionAnalysisProfileId",
    "readabilityHoldPolicyId",
    "segmentPolicyId",
    "motionThreshold",
    "semanticProfileId",
    "provider",
    "runtimeVersion",
    "styleVersion",
    "renderProfile",
    "renderQuality",
    "analysisWidth",
    "analysisHeight",
    "semanticRoi",
    "width",
    "height",
    "fps",
    "codec",
    "pixelFormat",
  ], field);
  const width = integer(input.width, `${field}.width`, 360, 7680);
  const height = integer(input.height, `${field}.height`, 640, 7680);
  const technical = { width, height };
  return {
    temporalMetricProfileId: token(input.temporalMetricProfileId, `${field}.temporalMetricProfileId`, [MOTION_TEMPORAL_METRIC_PROFILE_ID]),
    motionAnalysisProfileId: token(input.motionAnalysisProfileId, `${field}.motionAnalysisProfileId`),
    readabilityHoldPolicyId: token(input.readabilityHoldPolicyId, `${field}.readabilityHoldPolicyId`),
    segmentPolicyId: token(input.segmentPolicyId, `${field}.segmentPolicyId`),
    motionThreshold: safeNumber(input.motionThreshold, `${field}.motionThreshold`, Number.EPSILON, 1 - Number.EPSILON),
    semanticProfileId: token(input.semanticProfileId, `${field}.semanticProfileId`),
    provider: token(input.provider, `${field}.provider`),
    runtimeVersion: token(input.runtimeVersion, `${field}.runtimeVersion`),
    styleVersion: token(input.styleVersion, `${field}.styleVersion`),
    renderProfile: token(input.renderProfile, `${field}.renderProfile`, ["preview", "final"]),
    renderQuality: token(input.renderQuality, `${field}.renderQuality`, ["standard", "high"]),
    analysisWidth: integer(input.analysisWidth, `${field}.analysisWidth`, 1, 7680),
    analysisHeight: integer(input.analysisHeight, `${field}.analysisHeight`, 1, 7680),
    semanticRoi: normalizeRect(input.semanticRoi, `${field}.semanticRoi`, technical),
    width,
    height,
    fps: safeNumber(input.fps, `${field}.fps`, 24, 60),
    codec: token(input.codec, `${field}.codec`, ["h264"]),
    pixelFormat: token(input.pixelFormat, `${field}.pixelFormat`, ["yuv420p"]),
  };
}

function publicCase(value, stratumHash) {
  return {
    caseId: value.caseId,
    sourceFixtureId: value.sourceFixtureId,
    projectId: value.projectId,
    projectRevision: value.projectRevision,
    storyIdentityHash: value.storyIdentityHash,
    sourceFingerprintHash: value.sourceFingerprintHash,
    draftHash: value.draftHash,
    draftArtifactId: value.draftArtifactId,
    alignmentArtifactId: value.alignmentArtifactId,
    timingArtifactId: value.timingArtifactId,
    scenePlanArtifactId: value.scenePlanArtifactId,
    planArtifactId: value.animationPlanArtifactId,
    irArtifactId: value.animationIRArtifactId,
    qaArtifactId: value.qaArtifactId,
    qaArtifactHash: value.qaArtifactHash,
    renderManifestArtifactId: value.renderManifestArtifactId,
    renderManifestArtifactHash: value.renderManifestArtifactHash,
    visualMasterSha256: value.visualMasterSha256,
    decodedFrameSequenceHash: value.decodedFrameSequenceHash,
    browserProofHash: value.browserProofHash,
    motionProofHash: value.motionProofHash,
    compositionHash: value.compositionHash,
    stratumHash,
    metrics: {
      jerkEnergyP99: value.metrics.jerkEnergyP99,
      peakJerkEnergy: value.metrics.peakJerkEnergy,
      maximumBoundaryJumpRatio: value.metrics.maximumBoundaryJumpRatio,
    },
    review: value.review ? {
      reviewArtifactId: value.review.reviewArtifactId,
      reviewArtifactHash: value.review.reviewArtifactHash,
      reviewerIdHash: value.review.reviewerIdHash,
      jerkVerdict: value.review.jerkVerdict,
      boundaryVerdict: value.review.boundaryVerdict,
      reasonCodes: [...value.review.reasonCodes],
    } : null,
  };
}

function normalizePublicReview(input, field) {
  if (input === null) return null;
  exactKeys(input, [
    "reviewArtifactId",
    "reviewArtifactHash",
    "reviewerIdHash",
    "jerkVerdict",
    "boundaryVerdict",
    "reasonCodes",
  ], field);
  const jerkVerdict = token(input.jerkVerdict, `${field}.jerkVerdict`, ["pass", "fail"]);
  const boundaryVerdict = token(input.boundaryVerdict, `${field}.boundaryVerdict`, ["pass", "fail"]);
  const reasonCodes = denseArray(input.reasonCodes, `${field}.reasonCodes`, 0, REVIEW_REASON_CODES.length)
    .map((value, index) => token(value, `${field}.reasonCodes[${index}]`, REVIEW_REASON_CODES));
  canonicalUnique(reasonCodes, `${field}.reasonCodes`);
  if (
    (jerkVerdict === "fail") !== reasonCodes.includes("jerk_discomfort")
    || (boundaryVerdict === "fail") !== reasonCodes.includes("boundary_discontinuity")
    || (jerkVerdict === "pass" && boundaryVerdict === "pass" && reasonCodes.length !== 0)
  ) fail(`${field}.reasonCodes`, "review_reasons_inconsistent");
  return {
    reviewArtifactId: artifactId(input.reviewArtifactId, `${field}.reviewArtifactId`),
    reviewArtifactHash: hash(input.reviewArtifactHash, `${field}.reviewArtifactHash`),
    reviewerIdHash: hash(input.reviewerIdHash, `${field}.reviewerIdHash`),
    jerkVerdict,
    boundaryVerdict,
    reasonCodes,
  };
}

function normalizePublicCase(input, index, expectedStratumHash) {
  const field = `motionCalibration.cases[${index}]`;
  exactKeys(input, [
    "caseId",
    "sourceFixtureId",
    "projectId",
    "projectRevision",
    "storyIdentityHash",
    "sourceFingerprintHash",
    "draftHash",
    "draftArtifactId",
    "alignmentArtifactId",
    "timingArtifactId",
    "scenePlanArtifactId",
    "planArtifactId",
    "irArtifactId",
    "qaArtifactId",
    "qaArtifactHash",
    "renderManifestArtifactId",
    "renderManifestArtifactHash",
    "visualMasterSha256",
    "decodedFrameSequenceHash",
    "browserProofHash",
    "motionProofHash",
    "compositionHash",
    "stratumHash",
    "metrics",
    "review",
  ], field);
  exactKeys(input.metrics, METRIC_DEFINITIONS.map((entry) => entry.metric), `${field}.metrics`);
  const metrics = Object.fromEntries(METRIC_DEFINITIONS.map((entry) => [
    entry.metric,
    safeNumber(input.metrics[entry.metric], `${field}.metrics.${entry.metric}`, 0, entry.maximum),
  ]));
  if (metrics.jerkEnergyP99 > metrics.peakJerkEnergy + 1e-12) {
    fail(`${field}.metrics`, "metric_order_inconsistent");
  }
  const stratumHash = hash(input.stratumHash, `${field}.stratumHash`);
  if (stratumHash !== expectedStratumHash) fail(`${field}.stratumHash`, "stratum_mismatch");
  return {
    caseId: generatedCaseId(input.caseId, `${field}.caseId`),
    sourceFixtureId: generatedStoryId(input.sourceFixtureId, `${field}.sourceFixtureId`),
    projectId: projectId(input.projectId, `${field}.projectId`),
    projectRevision: integer(input.projectRevision, `${field}.projectRevision`, 1, 1_000_000),
    storyIdentityHash: hash(input.storyIdentityHash, `${field}.storyIdentityHash`),
    sourceFingerprintHash: hash(input.sourceFingerprintHash, `${field}.sourceFingerprintHash`),
    draftHash: hash(input.draftHash, `${field}.draftHash`),
    draftArtifactId: artifactId(input.draftArtifactId, `${field}.draftArtifactId`),
    alignmentArtifactId: artifactId(input.alignmentArtifactId, `${field}.alignmentArtifactId`),
    timingArtifactId: artifactId(input.timingArtifactId, `${field}.timingArtifactId`),
    scenePlanArtifactId: nullableArtifactId(input.scenePlanArtifactId, `${field}.scenePlanArtifactId`),
    planArtifactId: artifactId(input.planArtifactId, `${field}.planArtifactId`),
    irArtifactId: artifactId(input.irArtifactId, `${field}.irArtifactId`),
    qaArtifactId: artifactId(input.qaArtifactId, `${field}.qaArtifactId`),
    qaArtifactHash: hash(input.qaArtifactHash, `${field}.qaArtifactHash`),
    renderManifestArtifactId: artifactId(input.renderManifestArtifactId, `${field}.renderManifestArtifactId`),
    renderManifestArtifactHash: hash(input.renderManifestArtifactHash, `${field}.renderManifestArtifactHash`),
    visualMasterSha256: hash(input.visualMasterSha256, `${field}.visualMasterSha256`),
    decodedFrameSequenceHash: hash(input.decodedFrameSequenceHash, `${field}.decodedFrameSequenceHash`),
    browserProofHash: hash(input.browserProofHash, `${field}.browserProofHash`),
    motionProofHash: hash(input.motionProofHash, `${field}.motionProofHash`),
    compositionHash: hash(input.compositionHash, `${field}.compositionHash`),
    stratumHash,
    metrics,
    review: normalizePublicReview(input.review, `${field}.review`),
  };
}

function assertUniqueCases(cases) {
  for (const field of [
    "caseId",
    "sourceFixtureId",
    "storyIdentityHash",
    "sourceFingerprintHash",
    "draftHash",
    "draftArtifactId",
    "alignmentArtifactId",
    "timingArtifactId",
    "planArtifactId",
    "irArtifactId",
    "qaArtifactId",
    "qaArtifactHash",
    "renderManifestArtifactId",
    "renderManifestArtifactHash",
    "visualMasterSha256",
    "decodedFrameSequenceHash",
    "browserProofHash",
    "motionProofHash",
    "compositionHash",
  ]) {
    const values = cases.map((entry) => entry[field]);
    if (new Set(values).size !== values.length) {
      fail(`motionCalibration.cases.${field}`, "duplicate_evidence_forbidden");
    }
  }
  const reviewHashes = cases
    .map((entry) => entry.review?.reviewArtifactHash)
    .filter(Boolean);
  if (new Set(reviewHashes).size !== reviewHashes.length) {
    fail("motionCalibration.cases.reviewArtifactHash", "duplicate_evidence_forbidden");
  }
}

function thresholdCandidates(cases) {
  const candidates = [];
  for (const definition of METRIC_DEFINITIONS) {
    const reviewed = cases.filter((entry) => entry.review !== null);
    const passing = reviewed.filter((entry) => entry.review[definition.verdict] === "pass");
    const failing = reviewed.filter((entry) => entry.review[definition.verdict] === "fail");
    if (
      cases.length < MINIMUM_ARTIFACT_BOUND_STORIES
      || reviewed.length !== cases.length
      || passing.length < MINIMUM_LABEL_SUPPORT
      || failing.length < MINIMUM_LABEL_SUPPORT
    ) continue;
    const passingValues = passing.map((entry) => entry.metrics[definition.metric]);
    const limit = rounded(percentile(passingValues, 0.95));
    const q1 = percentile(passingValues, 0.25);
    const q3 = percentile(passingValues, 0.75);
    const outlierFence = q3 + 1.5 * (q3 - q1);
    const passingOutlierCount = passingValues.filter((value) => value > outlierFence + 1e-12).length;
    const falseRejectCount = passingValues.filter((value) => value > limit).length;
    const falseAcceptCount = failing.filter((entry) => entry.metrics[definition.metric] <= limit).length;
    const falseRejectRate = falseRejectCount / passingValues.length;
    candidates.push({
      metric: definition.metric,
      percentile: 0.95,
      limit,
      hardSafetyCeiling: definition.hardSafetyCeiling,
      maximumPassingValue: Math.max(...passingValues),
      passingOutlierCount,
      passSupport: passing.length,
      failSupport: failing.length,
      falseAcceptCount,
      falseRejectCount,
      separable: falseAcceptCount === 0 && falseRejectRate <= 0.05 + 1e-12,
      withinSafetyCeiling: limit <= definition.hardSafetyCeiling,
      outlierStable: passingOutlierCount === 0,
    });
  }
  return candidates;
}

function compileCorpusReport(cases, stratum) {
  const candidates = thresholdCandidates(cases);
  const blockers = [];
  if (cases.length < MINIMUM_ARTIFACT_BOUND_STORIES) blockers.push(MOTION_CALIBRATION_BLOCKERS.INSUFFICIENT_STORIES);
  if (cases.some((entry) => entry.review === null)) blockers.push(MOTION_CALIBRATION_BLOCKERS.INCOMPLETE_REVIEW);
  const fullySupported = METRIC_DEFINITIONS.every((definition) => {
    const reviewed = cases.filter((entry) => entry.review !== null);
    const pass = reviewed.filter((entry) => entry.review[definition.verdict] === "pass").length;
    const failCount = reviewed.filter((entry) => entry.review[definition.verdict] === "fail").length;
    return pass >= MINIMUM_LABEL_SUPPORT && failCount >= MINIMUM_LABEL_SUPPORT;
  });
  if (!fullySupported) blockers.push(MOTION_CALIBRATION_BLOCKERS.LABEL_SUPPORT);
  if (candidates.some((candidate) => !candidate.separable)) blockers.push(MOTION_CALIBRATION_BLOCKERS.NONSEPARABLE_LABELS);
  if (candidates.some((candidate) => !candidate.outlierStable)) blockers.push(MOTION_CALIBRATION_BLOCKERS.PASS_OUTLIERS);
  if (candidates.some((candidate) => !candidate.withinSafetyCeiling)) blockers.push(MOTION_CALIBRATION_BLOCKERS.SAFETY_CEILING);
  blockers.push(MOTION_CALIBRATION_BLOCKERS.SHADOW_THRESHOLDS);
  const report = {
    schemaVersion: MOTION_CALIBRATION_CORPUS_SCHEMA_VERSION,
    profileId: MOTION_CALIBRATION_CORPUS_PROFILE_ID,
    thresholdMode: MOTION_CALIBRATION_THRESHOLD_MODE,
    evidenceTrustLevel: MOTION_CALIBRATION_EVIDENCE_TRUST_LEVEL,
    calibrationStatus:
      blockers.length === 1 && candidates.length === METRIC_DEFINITIONS.length
        ? "candidate_ready"
        : "blocked",
    productionThresholdsApproved: false,
    evidenceCount: cases.length,
    distinctStoryCount: cases.length,
    reviewedCaseCount: cases.filter((entry) => entry.review !== null).length,
    blockers,
    stratum,
    thresholdCandidates: candidates,
    cases,
  };
  return deepFreeze({ ...report, contentHash: contentHash(report) });
}

function verifiedCases(input, field) {
  const cases = denseArray(input, field, 1, MAXIMUM_CORPUS_CASES);
  if (cases.some((entry) => !VERIFIED_CASES.has(entry))) {
    fail(field, "repository_verified_case_required");
  }
  return cases;
}

function assertSemanticStoryDistinctness(cases) {
  for (let leftIndex = 0; leftIndex < cases.length; leftIndex += 1) {
    const left = VERIFIED_CASE_SEMANTIC_TOKENS.get(cases[leftIndex]);
    if (!Array.isArray(left) || left.length < 1) {
      fail("motionCalibrationCorpusInput.cases", "story_similarity_evidence_missing");
    }
    const leftSet = new Set(left);
    for (let rightIndex = leftIndex + 1; rightIndex < cases.length; rightIndex += 1) {
      const right = VERIFIED_CASE_SEMANTIC_TOKENS.get(cases[rightIndex]);
      if (!Array.isArray(right) || right.length < 1) {
        fail("motionCalibrationCorpusInput.cases", "story_similarity_evidence_missing");
      }
      const rightSet = new Set(right);
      let intersection = 0;
      for (const tokenHash of leftSet) {
        if (rightSet.has(tokenHash)) intersection += 1;
      }
      const union = leftSet.size + rightSet.size - intersection;
      if (union > 0 && intersection / union >= 0.82) {
        fail(
          "motionCalibrationCorpusInput.cases",
          "near_duplicate_story_evidence_forbidden",
        );
      }
    }
  }
}

function buildMotionCalibrationCorpusReport(input) {
  exactKeys(input, ["cases"], "motionCalibrationCorpusInput");
  const cases = verifiedCases(own(input, "cases"), "motionCalibrationCorpusInput.cases");
  assertSemanticStoryDistinctness(cases);
  const stratum = normalizeStratum(cases[0].stratum);
  const canonicalStratum = stableStringify(stratum);
  if (cases.some((entry) => stableStringify(entry.stratum) !== canonicalStratum)) {
    fail("motionCalibrationCorpusInput.cases", "mixed_calibration_stratum");
  }
  const stratumHash = contentHash(stratum);
  const publicCases = cases.map((entry) => publicCase(entry, stratumHash))
    .sort((left, right) => left.storyIdentityHash.localeCompare(right.storyIdentityHash));
  assertUniqueCases(publicCases);
  return compileCorpusReport(publicCases, stratum);
}

function normalizeBlockers(input) {
  const allowed = Object.values(MOTION_CALIBRATION_BLOCKERS);
  const blockers = denseArray(input, "motionCalibration.blockers", 1, allowed.length)
    .map((value, index) => token(value, `motionCalibration.blockers[${index}]`, allowed));
  canonicalUnique(blockers, "motionCalibration.blockers", { sorted: false });
  return blockers;
}

function normalizeThresholdCandidates(input) {
  const candidates = denseArray(
    input,
    "motionCalibration.thresholdCandidates",
    0,
    METRIC_DEFINITIONS.length,
  ).map((entry, index) => {
    const field = `motionCalibration.thresholdCandidates[${index}]`;
    exactKeys(entry, [
      "metric",
      "percentile",
      "limit",
      "hardSafetyCeiling",
      "maximumPassingValue",
      "passingOutlierCount",
      "passSupport",
      "failSupport",
      "falseAcceptCount",
      "falseRejectCount",
      "separable",
      "withinSafetyCeiling",
      "outlierStable",
    ], field);
    const definition = METRIC_DEFINITIONS[index];
    if (!definition || entry.metric !== definition.metric) fail(`${field}.metric`, "canonical_metric_order_required");
    const percentileValue = safeNumber(entry.percentile, `${field}.percentile`, 0, 1);
    if (percentileValue !== 0.95) fail(`${field}.percentile`, "unsupported_percentile");
    const candidate = {
      metric: definition.metric,
      percentile: 0.95,
      limit: safeNumber(entry.limit, `${field}.limit`, 0, definition.maximum),
      hardSafetyCeiling: safeNumber(entry.hardSafetyCeiling, `${field}.hardSafetyCeiling`, 0, definition.maximum),
      maximumPassingValue: safeNumber(entry.maximumPassingValue, `${field}.maximumPassingValue`, 0, definition.maximum),
      passingOutlierCount: integer(entry.passingOutlierCount, `${field}.passingOutlierCount`, 0, MAXIMUM_CORPUS_CASES),
      passSupport: integer(entry.passSupport, `${field}.passSupport`, MINIMUM_LABEL_SUPPORT, MAXIMUM_CORPUS_CASES),
      failSupport: integer(entry.failSupport, `${field}.failSupport`, MINIMUM_LABEL_SUPPORT, MAXIMUM_CORPUS_CASES),
      falseAcceptCount: integer(entry.falseAcceptCount, `${field}.falseAcceptCount`, 0, MAXIMUM_CORPUS_CASES),
      falseRejectCount: integer(entry.falseRejectCount, `${field}.falseRejectCount`, 0, MAXIMUM_CORPUS_CASES),
      separable: entry.separable,
      withinSafetyCeiling: entry.withinSafetyCeiling,
      outlierStable: entry.outlierStable,
    };
    for (const name of ["separable", "withinSafetyCeiling", "outlierStable"]) {
      if (typeof candidate[name] !== "boolean") fail(`${field}.${name}`, "boolean_required");
    }
    if (candidate.hardSafetyCeiling !== definition.hardSafetyCeiling) {
      fail(`${field}.hardSafetyCeiling`, "safety_ceiling_mismatch");
    }
    return candidate;
  });
  return candidates;
}

function normalizeSerializedReport(input) {
  const safe = strictJsonClone(input, "motionCalibration");
  forbidPrivateEvidence(safe, "motionCalibration");
  exactKeys(safe, [
    "schemaVersion",
    "profileId",
    "thresholdMode",
    "evidenceTrustLevel",
    "calibrationStatus",
    "productionThresholdsApproved",
    "evidenceCount",
    "distinctStoryCount",
    "reviewedCaseCount",
    "blockers",
    "stratum",
    "thresholdCandidates",
    "cases",
    "contentHash",
  ], "motionCalibration");
  const stratum = normalizeStratum(safe.stratum);
  const stratumHash = contentHash(stratum);
  const cases = denseArray(safe.cases, "motionCalibration.cases", 1, MAXIMUM_CORPUS_CASES)
    .map((entry, index) => normalizePublicCase(entry, index, stratumHash));
  assertUniqueCases(cases);
  if (typeof safe.productionThresholdsApproved !== "boolean") {
    fail("motionCalibration.productionThresholdsApproved", "boolean_required");
  }
  return {
    schemaVersion: integer(safe.schemaVersion, "motionCalibration.schemaVersion", 1, 1),
    profileId: token(safe.profileId, "motionCalibration.profileId", [MOTION_CALIBRATION_CORPUS_PROFILE_ID]),
    thresholdMode: token(safe.thresholdMode, "motionCalibration.thresholdMode", [MOTION_CALIBRATION_THRESHOLD_MODE]),
    evidenceTrustLevel: token(
      safe.evidenceTrustLevel,
      "motionCalibration.evidenceTrustLevel",
      [MOTION_CALIBRATION_EVIDENCE_TRUST_LEVEL],
    ),
    calibrationStatus: token(safe.calibrationStatus, "motionCalibration.calibrationStatus", ["blocked", "candidate_ready"]),
    productionThresholdsApproved: safe.productionThresholdsApproved,
    evidenceCount: integer(safe.evidenceCount, "motionCalibration.evidenceCount", 1, MAXIMUM_CORPUS_CASES),
    distinctStoryCount: integer(safe.distinctStoryCount, "motionCalibration.distinctStoryCount", 1, MAXIMUM_CORPUS_CASES),
    reviewedCaseCount: integer(safe.reviewedCaseCount, "motionCalibration.reviewedCaseCount", 0, MAXIMUM_CORPUS_CASES),
    blockers: normalizeBlockers(safe.blockers),
    stratum,
    thresholdCandidates: normalizeThresholdCandidates(safe.thresholdCandidates),
    cases,
    contentHash: hash(safe.contentHash, "motionCalibration.contentHash"),
  };
}

function validateMotionCalibrationCorpusReport(input, verification) {
  const normalized = normalizeSerializedReport(input);
  if (normalized.productionThresholdsApproved !== false) {
    fail("motionCalibration.productionThresholdsApproved", "shadow_profile_cannot_approve");
  }
  exactKeys(verification, ["cases"], "motionCalibrationVerification");
  const expected = buildMotionCalibrationCorpusReport({
    cases: verifiedCases(
      own(verification, "cases"),
      "motionCalibrationVerification.cases",
    ),
  });
  if (stableStringify(normalized) !== stableStringify(expected)) {
    fail("motionCalibration", "repository_evidence_report_mismatch");
  }
  return expected;
}

module.exports = {
  MOTION_CALIBRATION_CORPUS_SCHEMA_VERSION,
  MOTION_CALIBRATION_CORPUS_PROFILE_ID,
  MOTION_CALIBRATION_THRESHOLD_MODE,
  MOTION_CALIBRATION_EVIDENCE_TRUST_LEVEL,
  MOTION_CALIBRATION_REVIEW_PROFILE_ID,
  MINIMUM_ARTIFACT_BOUND_STORIES,
  MINIMUM_LABEL_SUPPORT,
  MOTION_CALIBRATION_BLOCKERS,
  motionCalibrationCaseFromArtifacts,
  buildMotionCalibrationCorpusReport,
  validateMotionCalibrationCorpusReport,
};
