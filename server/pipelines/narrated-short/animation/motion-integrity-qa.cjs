"use strict";

const { createHash } = require("node:crypto");

const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");

const MOTION_INTEGRITY_SCHEMA_VERSION = 1;
const MOTION_INTEGRITY_PROFILE_ID =
  "dark_curiosity_motion_integrity_calibration_v1";
const MOTION_INTEGRITY_THRESHOLD_MODE = "shadow_motion_v1";
const MOTION_TEMPORAL_METRIC_PROFILE_ID =
  "dark_curiosity_luma_temporal_motion_v1";
const MINIMUM_REAL_CONTENT_FIXTURES = 10;
const MAXIMUM_CALIBRATION_CASES = 1000;
const MAXIMUM_BOUNDARY_METRICS = 1000;
const MAXIMUM_FRAME_COUNT = 100_000_000;
const MAXIMUM_BOUNDARY_JUMP_RATIO = 1_000_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z][a-z0-9_-]{1,119}$/;

const MOTION_INTEGRITY_BLOCKERS = Object.freeze({
  INSUFFICIENT_REAL_FIXTURES:
    "MOTION_CALIBRATION_REAL_FIXTURES_INSUFFICIENT",
  STRUCTURAL_FAILURES: "MOTION_CALIBRATION_STRUCTURAL_FAILURES_PRESENT",
  SHADOW_THRESHOLDS: "MOTION_CALIBRATION_SHADOW_THRESHOLDS_NOT_APPROVED",
});

const CASE_METRIC_FIELDS = Object.freeze([
  "meanAccelerationEnergy",
  "accelerationEnergyP99",
  "meanJerkEnergy",
  "jerkEnergyP99",
  "peakJerkEnergy",
  "maximumBoundaryJumpRatio",
  "maxContiguousStasisFrames",
]);

const BENCHMARK_ADAPTER_FIELDS = Object.freeze([
  "caseId",
  "sourceFixtureId",
  "sourceKind",
  "structuralPassed",
  "motion",
]);

const BOUNDARY_METRIC_FIELDS = Object.freeze([
  "frame",
  "motionEnergy",
  "accelerationEnergy",
  "jerkEnergy",
  "localBaseline",
  "jumpRatio",
]);

const CASE_FIELDS = Object.freeze([
  "caseId",
  "sourceFixtureId",
  "sourceKind",
  "temporalMetricProfileId",
  "frameCount",
  "boundaryCount",
  "structuralPassed",
  "metrics",
]);

const REPORT_FIELDS = Object.freeze([
  "schemaVersion",
  "profileId",
  "thresholdMode",
  "calibrationStatus",
  "realContentFixtures",
  "syntheticCalibrationCases",
  "caseCount",
  "productionThresholdsApproved",
  "blockers",
  "aggregateTemporalMetrics",
  "cases",
  "contentHash",
]);

const SUMMARY_FIELDS = Object.freeze(["mean", "p90", "p99", "maximum"]);

function fail(field, reason = "invalid") {
  throw new AppError(
    "ANIMATION_MOTION_INTEGRITY_REPORT_INVALID",
    "The motion-integrity calibration report is invalid or non-canonical.",
    409,
    { field, reason },
  );
}

function isStrictPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype,
  );
}

function strictDataObject(value, field) {
  if (!isStrictPlainObject(value)) fail(field, "plain_object_required");
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    fail(`${field}.*`, "symbol_field_forbidden");
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) fail(`${field}.${key}`, "plain_data_field_required");
  }
  return actual;
}

function exactDataKeys(value, required, field) {
  const expected = [...required].sort();
  const actual = strictDataObject(value, field);
  actual.sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) fail(field, "unsupported_or_missing_field");
}

function ownDataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function denseDataArray(value, field, minimum, maximum) {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum
    || value.length > maximum
  ) fail(field, "bounded_plain_array_required");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1
    || keys.some((key) => {
      if (typeof key !== "string") return true;
      if (key === "length") return false;
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return true;
      const index = Number(key);
      return !Number.isSafeInteger(index) || index < 0 || index >= value.length;
    })
  ) {
    fail(`${field}.*`, "unsupported_array_field");
  }
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) fail(`${field}[${index}]`, "dense_data_array_required");
    entries.push(descriptor.value);
  }
  return entries;
}

function text(value, field, options = {}) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > (options.maximum || 120)
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)
    || (options.pattern && !options.pattern.test(value))
  ) fail(field, "bounded_safe_text_required");
  return value;
}

function token(value, field, allowed) {
  const normalized = text(value, field, { maximum: 120 });
  if (!allowed.includes(normalized)) fail(field, "unsupported_value");
  return normalized;
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

function boolean(value, field) {
  if (typeof value !== "boolean") fail(field, "boolean_required");
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function canonicalHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
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

function summarize(values) {
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    mean: rounded(sum / values.length),
    p90: rounded(percentile(values, 0.9)),
    p99: rounded(percentile(values, 0.99)),
    maximum: rounded(Math.max(...values)),
  };
}

function normalizeCaseMetrics(input, field, frameCount, boundaryCount) {
  exactDataKeys(input, CASE_METRIC_FIELDS, field);
  const normalized = {
    meanAccelerationEnergy: safeNumber(
      ownDataValue(input, "meanAccelerationEnergy"),
      `${field}.meanAccelerationEnergy`,
      0,
      1,
    ),
    accelerationEnergyP99: safeNumber(
      ownDataValue(input, "accelerationEnergyP99"),
      `${field}.accelerationEnergyP99`,
      0,
      1,
    ),
    meanJerkEnergy: safeNumber(
      ownDataValue(input, "meanJerkEnergy"),
      `${field}.meanJerkEnergy`,
      0,
      1,
    ),
    jerkEnergyP99: safeNumber(
      ownDataValue(input, "jerkEnergyP99"),
      `${field}.jerkEnergyP99`,
      0,
      1,
    ),
    peakJerkEnergy: safeNumber(
      ownDataValue(input, "peakJerkEnergy"),
      `${field}.peakJerkEnergy`,
      0,
      1,
    ),
    maximumBoundaryJumpRatio: safeNumber(
      ownDataValue(input, "maximumBoundaryJumpRatio"),
      `${field}.maximumBoundaryJumpRatio`,
      0,
      MAXIMUM_BOUNDARY_JUMP_RATIO,
    ),
    maxContiguousStasisFrames: integer(
      ownDataValue(input, "maxContiguousStasisFrames"),
      `${field}.maxContiguousStasisFrames`,
      0,
      frameCount,
    ),
  };
  if (
    normalized.meanJerkEnergy > normalized.peakJerkEnergy
    || normalized.jerkEnergyP99 > normalized.peakJerkEnergy
  ) fail(field, "jerk_summary_inconsistent");
  if (boundaryCount === 0 && normalized.maximumBoundaryJumpRatio !== 0) {
    fail(`${field}.maximumBoundaryJumpRatio`, "boundary_evidence_missing");
  }
  return normalized;
}

function normalizeCalibrationCase(input, index) {
  const field = `motionIntegrity.cases[${index}]`;
  exactDataKeys(input, CASE_FIELDS, field);
  const frameCount = integer(
    ownDataValue(input, "frameCount"),
    `${field}.frameCount`,
    4,
    MAXIMUM_FRAME_COUNT,
  );
  const boundaryCount = integer(
    ownDataValue(input, "boundaryCount"),
    `${field}.boundaryCount`,
    0,
    frameCount - 1,
  );
  return {
    caseId: text(ownDataValue(input, "caseId"), `${field}.caseId`, {
      pattern: ID_PATTERN,
    }),
    sourceFixtureId: text(
      ownDataValue(input, "sourceFixtureId"),
      `${field}.sourceFixtureId`,
      { pattern: ID_PATTERN },
    ),
    sourceKind: token(
      ownDataValue(input, "sourceKind"),
      `${field}.sourceKind`,
      ["real", "synthetic"],
    ),
    temporalMetricProfileId: token(
      ownDataValue(input, "temporalMetricProfileId"),
      `${field}.temporalMetricProfileId`,
      [MOTION_TEMPORAL_METRIC_PROFILE_ID],
    ),
    frameCount,
    boundaryCount,
    structuralPassed: boolean(
      ownDataValue(input, "structuralPassed"),
      `${field}.structuralPassed`,
    ),
    metrics: normalizeCaseMetrics(
      ownDataValue(input, "metrics"),
      `${field}.metrics`,
      frameCount,
      boundaryCount,
    ),
  };
}

function normalizeCases(value) {
  const inputs = denseDataArray(
    value,
    "motionIntegrity.cases",
    1,
    MAXIMUM_CALIBRATION_CASES,
  );
  const cases = inputs.map(normalizeCalibrationCase);
  const caseIds = new Set();
  const sourceKinds = new Map();
  for (const entry of cases) {
    if (caseIds.has(entry.caseId)) {
      fail("motionIntegrity.cases", "duplicate_case_id");
    }
    caseIds.add(entry.caseId);
    const previousKind = sourceKinds.get(entry.sourceFixtureId);
    if (previousKind && previousKind !== entry.sourceKind) {
      fail("motionIntegrity.cases", "source_fixture_kind_conflict");
    }
    sourceKinds.set(entry.sourceFixtureId, entry.sourceKind);
  }
  return cases.sort((left, right) => {
    if (left.caseId < right.caseId) return -1;
    if (left.caseId > right.caseId) return 1;
    return 0;
  });
}

function aggregateTemporalMetrics(cases) {
  return Object.fromEntries(CASE_METRIC_FIELDS.map((metric) => [
    metric,
    summarize(cases.map((entry) => entry.metrics[metric])),
  ]));
}

function buildBlockers(cases, realContentFixtures) {
  const blockers = [];
  if (realContentFixtures < MINIMUM_REAL_CONTENT_FIXTURES) {
    blockers.push(MOTION_INTEGRITY_BLOCKERS.INSUFFICIENT_REAL_FIXTURES);
  }
  if (cases.some((entry) => !entry.structuralPassed)) {
    blockers.push(MOTION_INTEGRITY_BLOCKERS.STRUCTURAL_FAILURES);
  }
  blockers.push(MOTION_INTEGRITY_BLOCKERS.SHADOW_THRESHOLDS);
  return blockers;
}

function compileReport(cases) {
  const realFixtureIds = new Set(
    cases
      .filter((entry) => entry.sourceKind === "real")
      .map((entry) => entry.sourceFixtureId),
  );
  const realContentFixtures = realFixtureIds.size;
  const syntheticCalibrationCases = cases.filter(
    (entry) => entry.sourceKind === "synthetic",
  ).length;
  const report = {
    schemaVersion: MOTION_INTEGRITY_SCHEMA_VERSION,
    profileId: MOTION_INTEGRITY_PROFILE_ID,
    thresholdMode: MOTION_INTEGRITY_THRESHOLD_MODE,
    calibrationStatus: "provisional",
    realContentFixtures,
    syntheticCalibrationCases,
    caseCount: cases.length,
    productionThresholdsApproved: false,
    blockers: buildBlockers(cases, realContentFixtures),
    aggregateTemporalMetrics: aggregateTemporalMetrics(cases),
    cases,
  };
  return deepFreeze({ ...report, contentHash: canonicalHash(report) });
}

function buildMotionIntegrityCalibrationReport(input) {
  exactDataKeys(input, ["cases"], "motionIntegrityInput");
  return compileReport(normalizeCases(ownDataValue(input, "cases")));
}

function normalizeBenchmarkBoundaryMetrics(value, frameCount) {
  const entries = denseDataArray(
    value,
    "motionIntegrityBenchmark.motion.boundaryMetrics",
    0,
    Math.min(MAXIMUM_BOUNDARY_METRICS, frameCount - 1),
  );
  let previousFrame = 0;
  return entries.map((input, index) => {
    const field = `motionIntegrityBenchmark.motion.boundaryMetrics[${index}]`;
    exactDataKeys(input, BOUNDARY_METRIC_FIELDS, field);
    const frame = integer(
      ownDataValue(input, "frame"),
      `${field}.frame`,
      1,
      frameCount - 1,
    );
    if (frame <= previousFrame) fail(`${field}.frame`, "strict_order_required");
    previousFrame = frame;
    return {
      frame,
      motionEnergy: safeNumber(
        ownDataValue(input, "motionEnergy"),
        `${field}.motionEnergy`,
        0,
        1,
      ),
      accelerationEnergy: safeNumber(
        ownDataValue(input, "accelerationEnergy"),
        `${field}.accelerationEnergy`,
        0,
        1,
      ),
      jerkEnergy: safeNumber(
        ownDataValue(input, "jerkEnergy"),
        `${field}.jerkEnergy`,
        0,
        1,
      ),
      localBaseline: safeNumber(
        ownDataValue(input, "localBaseline"),
        `${field}.localBaseline`,
        0,
        1,
      ),
      jumpRatio: safeNumber(
        ownDataValue(input, "jumpRatio"),
        `${field}.jumpRatio`,
        0,
        MAXIMUM_BOUNDARY_JUMP_RATIO,
      ),
    };
  });
}

function motionIntegrityCaseFromBenchmarkQa(input) {
  exactDataKeys(
    input,
    BENCHMARK_ADAPTER_FIELDS,
    "motionIntegrityBenchmark",
  );
  const motion = ownDataValue(input, "motion");
  strictDataObject(motion, "motionIntegrityBenchmark.motion");
  const frameCount = integer(
    ownDataValue(motion, "frameCount"),
    "motionIntegrityBenchmark.motion.frameCount",
    4,
    MAXIMUM_FRAME_COUNT,
  );
  const boundaryMetrics = normalizeBenchmarkBoundaryMetrics(
    ownDataValue(motion, "boundaryMetrics"),
    frameCount,
  );
  const maximumBoundaryJumpRatio = safeNumber(
    ownDataValue(motion, "maximumBoundaryJumpRatio"),
    "motionIntegrityBenchmark.motion.maximumBoundaryJumpRatio",
    0,
    MAXIMUM_BOUNDARY_JUMP_RATIO,
  );
  const derivedMaximumBoundaryJumpRatio = boundaryMetrics.length
    ? Math.max(...boundaryMetrics.map((entry) => entry.jumpRatio))
    : 0;
  if (maximumBoundaryJumpRatio !== derivedMaximumBoundaryJumpRatio) {
    fail(
      "motionIntegrityBenchmark.motion.maximumBoundaryJumpRatio",
      "boundary_summary_mismatch",
    );
  }
  const temporalMetricProfileId = token(
    ownDataValue(motion, "temporalMetricProfileId"),
    "motionIntegrityBenchmark.motion.temporalMetricProfileId",
    [MOTION_TEMPORAL_METRIC_PROFILE_ID],
  );
  const candidate = {
    caseId: ownDataValue(input, "caseId"),
    sourceFixtureId: ownDataValue(input, "sourceFixtureId"),
    sourceKind: ownDataValue(input, "sourceKind"),
    temporalMetricProfileId,
    frameCount,
    boundaryCount: boundaryMetrics.length,
    structuralPassed: ownDataValue(input, "structuralPassed"),
    metrics: {
      meanAccelerationEnergy: ownDataValue(motion, "meanAccelerationEnergy"),
      accelerationEnergyP99: ownDataValue(motion, "accelerationEnergyP99"),
      meanJerkEnergy: ownDataValue(motion, "meanJerkEnergy"),
      jerkEnergyP99: ownDataValue(motion, "jerkEnergyP99"),
      peakJerkEnergy: ownDataValue(motion, "peakJerkEnergy"),
      maximumBoundaryJumpRatio,
      maxContiguousStasisFrames: ownDataValue(
        motion,
        "maxContiguousStasisFrames",
      ),
    },
  };
  return deepFreeze(normalizeCalibrationCase(candidate, 0));
}

function validateAggregateTemporalMetrics(input) {
  exactDataKeys(
    input,
    CASE_METRIC_FIELDS,
    "motionIntegrity.aggregateTemporalMetrics",
  );
  for (const metric of CASE_METRIC_FIELDS) {
    const field = `motionIntegrity.aggregateTemporalMetrics.${metric}`;
    const summary = ownDataValue(input, metric);
    exactDataKeys(summary, SUMMARY_FIELDS, field);
    const maximum = metric === "maximumBoundaryJumpRatio"
      ? MAXIMUM_BOUNDARY_JUMP_RATIO
      : metric === "maxContiguousStasisFrames"
        ? MAXIMUM_FRAME_COUNT
        : 1;
    const values = Object.fromEntries(SUMMARY_FIELDS.map((name) => [
      name,
      safeNumber(ownDataValue(summary, name), `${field}.${name}`, 0, maximum),
    ]));
    if (
      values.mean > values.maximum
      || values.p90 > values.p99
      || values.p99 > values.maximum
    ) fail(field, "aggregate_order_invalid");
  }
}

function validateBlockers(input) {
  const allowed = Object.values(MOTION_INTEGRITY_BLOCKERS);
  const blockers = denseDataArray(
    input,
    "motionIntegrity.blockers",
    1,
    allowed.length,
  );
  const seen = new Set();
  for (let index = 0; index < blockers.length; index += 1) {
    const blocker = token(
      blockers[index],
      `motionIntegrity.blockers[${index}]`,
      allowed,
    );
    if (seen.has(blocker)) fail("motionIntegrity.blockers", "duplicate_blocker");
    seen.add(blocker);
  }
}

function validateMotionIntegrityCalibrationReport(input) {
  exactDataKeys(input, REPORT_FIELDS, "motionIntegrity");
  integer(
    ownDataValue(input, "schemaVersion"),
    "motionIntegrity.schemaVersion",
    MOTION_INTEGRITY_SCHEMA_VERSION,
    MOTION_INTEGRITY_SCHEMA_VERSION,
  );
  token(
    ownDataValue(input, "profileId"),
    "motionIntegrity.profileId",
    [MOTION_INTEGRITY_PROFILE_ID],
  );
  token(
    ownDataValue(input, "thresholdMode"),
    "motionIntegrity.thresholdMode",
    [MOTION_INTEGRITY_THRESHOLD_MODE],
  );
  token(
    ownDataValue(input, "calibrationStatus"),
    "motionIntegrity.calibrationStatus",
    ["provisional"],
  );
  integer(
    ownDataValue(input, "realContentFixtures"),
    "motionIntegrity.realContentFixtures",
    0,
    MAXIMUM_CALIBRATION_CASES,
  );
  integer(
    ownDataValue(input, "syntheticCalibrationCases"),
    "motionIntegrity.syntheticCalibrationCases",
    0,
    MAXIMUM_CALIBRATION_CASES,
  );
  integer(
    ownDataValue(input, "caseCount"),
    "motionIntegrity.caseCount",
    1,
    MAXIMUM_CALIBRATION_CASES,
  );
  if (ownDataValue(input, "productionThresholdsApproved") !== false) {
    fail(
      "motionIntegrity.productionThresholdsApproved",
      "shadow_profile_cannot_approve_production_thresholds",
    );
  }
  validateBlockers(ownDataValue(input, "blockers"));
  validateAggregateTemporalMetrics(
    ownDataValue(input, "aggregateTemporalMetrics"),
  );
  const cases = normalizeCases(ownDataValue(input, "cases"));
  text(ownDataValue(input, "contentHash"), "motionIntegrity.contentHash", {
    maximum: 64,
    pattern: HASH_PATTERN,
  });
  const expected = compileReport(cases);
  if (stableStringify(input) !== stableStringify(expected)) {
    fail("motionIntegrity", "canonical_report_mismatch");
  }
  return expected;
}

module.exports = {
  MOTION_INTEGRITY_SCHEMA_VERSION,
  MOTION_INTEGRITY_PROFILE_ID,
  MOTION_INTEGRITY_THRESHOLD_MODE,
  MOTION_TEMPORAL_METRIC_PROFILE_ID,
  MINIMUM_REAL_CONTENT_FIXTURES,
  MOTION_INTEGRITY_BLOCKERS,
  motionIntegrityCaseFromBenchmarkQa,
  buildMotionIntegrityCalibrationReport,
  validateMotionIntegrityCalibrationReport,
};
