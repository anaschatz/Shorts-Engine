"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MOTION_INTEGRITY_SCHEMA_VERSION,
  MOTION_INTEGRITY_PROFILE_ID,
  MOTION_INTEGRITY_THRESHOLD_MODE,
  MOTION_TEMPORAL_METRIC_PROFILE_ID,
  MINIMUM_REAL_CONTENT_FIXTURES,
  MOTION_INTEGRITY_BLOCKERS,
  motionIntegrityCaseFromBenchmarkQa,
  buildMotionIntegrityCalibrationReport,
  validateMotionIntegrityCalibrationReport,
} = require("../server/pipelines/narrated-short/animation/motion-integrity-qa.cjs");
const {
  analyzeConsecutiveFrames,
} = require("../server/pipelines/narrated-short/animation/benchmark-qa.cjs");

function calibrationCase({
  caseId,
  sourceFixtureId,
  sourceKind,
  frameCount,
  boundaryCount,
  structuralPassed = true,
  acceleration = 0.02,
  accelerationP99 = 0.08,
  jerk = 0.015,
  jerkP99 = 0.07,
  peakJerk = 0.1,
  boundaryJump = 1.4,
  staticRun = 4,
}) {
  return {
    caseId,
    sourceFixtureId,
    sourceKind,
    temporalMetricProfileId: MOTION_TEMPORAL_METRIC_PROFILE_ID,
    frameCount,
    boundaryCount,
    structuralPassed,
    metrics: {
      meanAccelerationEnergy: acceleration,
      accelerationEnergyP99: accelerationP99,
      meanJerkEnergy: jerk,
      jerkEnergyP99: jerkP99,
      peakJerkEnergy: peakJerk,
      maximumBoundaryJumpRatio: boundaryCount === 0 ? 0 : boundaryJump,
      maxContiguousStasisFrames: staticRun,
    },
  };
}

function engineeringCorpus() {
  return [
    calibrationCase({
      caseId: "real_wow_signal_sentences",
      sourceFixtureId: "story_wow_signal",
      sourceKind: "real",
      frameCount: 758,
      boundaryCount: 8,
      acceleration: 0.018,
      accelerationP99: 0.071,
      jerk: 0.012,
      jerkP99: 0.059,
      peakJerk: 0.14,
      boundaryJump: 2.1,
      staticRun: 7,
    }),
    calibrationCase({
      caseId: "real_gps_anomaly_sentences",
      sourceFixtureId: "story_gps_anomaly",
      sourceKind: "real",
      frameCount: 854,
      boundaryCount: 12,
      acceleration: 0.022,
      accelerationP99: 0.083,
      jerk: 0.016,
      jerkP99: 0.068,
      peakJerk: 0.17,
      boundaryJump: 2.7,
      staticRun: 6,
    }),
    calibrationCase({
      caseId: "real_baychimo_sentences",
      sourceFixtureId: "story_baychimo",
      sourceKind: "real",
      frameCount: 822,
      boundaryCount: 9,
      acceleration: 0.02,
      accelerationP99: 0.077,
      jerk: 0.014,
      jerkP99: 0.064,
      peakJerk: 0.16,
      boundaryJump: 2.4,
      staticRun: 8,
    }),
    calibrationCase({
      caseId: "synthetic_static_run",
      sourceFixtureId: "calibration_static_run",
      sourceKind: "synthetic",
      frameCount: 300,
      boundaryCount: 3,
      acceleration: 0,
      accelerationP99: 0,
      jerk: 0,
      jerkP99: 0,
      peakJerk: 0,
      boundaryJump: 0,
      staticRun: 280,
    }),
    calibrationCase({
      caseId: "synthetic_smooth_motion",
      sourceFixtureId: "calibration_smooth_motion",
      sourceKind: "synthetic",
      frameCount: 300,
      boundaryCount: 3,
      acceleration: 0.006,
      accelerationP99: 0.019,
      jerk: 0.002,
      jerkP99: 0.008,
      peakJerk: 0.015,
      boundaryJump: 1.1,
      staticRun: 2,
    }),
    calibrationCase({
      caseId: "synthetic_boundary_cut",
      sourceFixtureId: "calibration_boundary_cut",
      sourceKind: "synthetic",
      frameCount: 300,
      boundaryCount: 3,
      acceleration: 0.09,
      accelerationP99: 0.47,
      jerk: 0.08,
      jerkP99: 0.59,
      peakJerk: 0.82,
      boundaryJump: 64,
      staticRun: 5,
    }),
    calibrationCase({
      caseId: "synthetic_single_frame_flicker",
      sourceFixtureId: "calibration_single_frame_flicker",
      sourceKind: "synthetic",
      frameCount: 300,
      boundaryCount: 3,
      acceleration: 0.13,
      accelerationP99: 0.58,
      jerk: 0.11,
      jerkP99: 0.73,
      peakJerk: 0.91,
      boundaryJump: 12,
      staticRun: 11,
    }),
    calibrationCase({
      caseId: "synthetic_motion_overload",
      sourceFixtureId: "calibration_motion_overload",
      sourceKind: "synthetic",
      frameCount: 300,
      boundaryCount: 3,
      acceleration: 0.19,
      accelerationP99: 0.64,
      jerk: 0.17,
      jerkP99: 0.69,
      peakJerk: 0.88,
      boundaryJump: 9,
      staticRun: 1,
    }),
    calibrationCase({
      caseId: "synthetic_caption_clipping",
      sourceFixtureId: "calibration_caption_clipping",
      sourceKind: "synthetic",
      frameCount: 300,
      boundaryCount: 3,
      structuralPassed: false,
      acceleration: 0.025,
      accelerationP99: 0.09,
      jerk: 0.018,
      jerkP99: 0.079,
      peakJerk: 0.18,
      boundaryJump: 1.8,
      staticRun: 4,
    }),
    calibrationCase({
      caseId: "synthetic_node_escape",
      sourceFixtureId: "calibration_node_escape",
      sourceKind: "synthetic",
      frameCount: 300,
      boundaryCount: 3,
      structuralPassed: false,
      acceleration: 0.031,
      accelerationP99: 0.12,
      jerk: 0.024,
      jerkP99: 0.11,
      peakJerk: 0.24,
      boundaryJump: 2.2,
      staticRun: 3,
    }),
  ];
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function assertInvalid(action) {
  assert.throws(action, {
    code: "ANIMATION_MOTION_INTEGRITY_REPORT_INVALID",
  });
}

function grayFrames(count, width, height) {
  const output = Buffer.alloc(count * width * height);
  for (let frame = 0; frame < count; frame += 1) {
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      output[frame * width * height + pixel] =
        35 + ((frame * 3 + pixel * 11) % 180);
    }
  }
  return output;
}

test("motion integrity compiles 3 real fixtures plus 7 synthetic cases as an honest provisional report", () => {
  const cases = engineeringCorpus();
  assert.equal(cases.filter((entry) => entry.sourceKind === "real").length, 3);
  assert.equal(
    cases.filter((entry) => entry.sourceKind === "synthetic").length,
    7,
  );

  const report = buildMotionIntegrityCalibrationReport({ cases });
  assert.equal(report.schemaVersion, MOTION_INTEGRITY_SCHEMA_VERSION);
  assert.equal(report.profileId, MOTION_INTEGRITY_PROFILE_ID);
  assert.equal(report.thresholdMode, MOTION_INTEGRITY_THRESHOLD_MODE);
  assert.equal(report.calibrationStatus, "provisional");
  assert.equal(report.realContentFixtures, 3);
  assert.equal(report.syntheticCalibrationCases, 7);
  assert.equal(report.caseCount, 10);
  assert.equal(report.productionThresholdsApproved, false);
  assert.deepEqual(report.blockers, [
    MOTION_INTEGRITY_BLOCKERS.INSUFFICIENT_REAL_FIXTURES,
    MOTION_INTEGRITY_BLOCKERS.STRUCTURAL_FAILURES,
    MOTION_INTEGRITY_BLOCKERS.SHADOW_THRESHOLDS,
  ]);
  assert.equal(
    report.aggregateTemporalMetrics.peakJerkEnergy.maximum,
    0.91,
  );
  assert.equal(
    report.aggregateTemporalMetrics.maximumBoundaryJumpRatio.maximum,
    64,
  );
  assert.equal(
    report.aggregateTemporalMetrics.maxContiguousStasisFrames.maximum,
    280,
  );
  assert.match(report.contentHash, /^[a-f0-9]{64}$/);
  assertDeepFrozen(report);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /(?:outputPath|rawFrames|sampleHashes)/);
});

test("motion integrity ordering, aggregate metrics, and content hash are deterministic", () => {
  const forward = buildMotionIntegrityCalibrationReport({
    cases: engineeringCorpus(),
  });
  const reversed = buildMotionIntegrityCalibrationReport({
    cases: engineeringCorpus().reverse(),
  });
  assert.deepEqual(reversed, forward);
  assert.equal(reversed.contentHash, forward.contentHash);
  assert.deepEqual(
    forward.cases.map((entry) => entry.caseId),
    [...forward.cases.map((entry) => entry.caseId)].sort(),
  );

  const changedCases = engineeringCorpus();
  changedCases[0].metrics.meanJerkEnergy += 0.001;
  const changed = buildMotionIntegrityCalibrationReport({
    cases: changedCases,
  });
  assert.notEqual(changed.contentHash, forward.contentHash);
  assert.deepEqual(
    validateMotionIntegrityCalibrationReport(structuredClone(forward)),
    forward,
  );
});

test("benchmark adapter derives a frozen allowlisted case from consecutive frame analysis", () => {
  const motion = analyzeConsecutiveFrames(grayFrames(48, 3, 2), 3, 2, {
    rollingWindowFrames: 6,
    segments: [
      { id: "sentence_a", startFrame: 0, endFrame: 16 },
      { id: "sentence_b", startFrame: 16, endFrame: 32 },
      { id: "sentence_c", startFrame: 32, endFrame: 48 },
    ],
  });
  assert.ok(motion.sampleHashes.length > 0);

  const adapted = motionIntegrityCaseFromBenchmarkQa({
    caseId: "synthetic_benchmark_adapter",
    sourceFixtureId: "calibration_benchmark_adapter",
    sourceKind: "synthetic",
    structuralPassed: true,
    motion,
  });
  assert.equal(adapted.frameCount, motion.frameCount);
  assert.equal(adapted.boundaryCount, motion.boundaryMetrics.length);
  assert.deepEqual(adapted.metrics, {
    meanAccelerationEnergy: motion.meanAccelerationEnergy,
    accelerationEnergyP99: motion.accelerationEnergyP99,
    meanJerkEnergy: motion.meanJerkEnergy,
    jerkEnergyP99: motion.jerkEnergyP99,
    peakJerkEnergy: motion.peakJerkEnergy,
    maximumBoundaryJumpRatio: motion.maximumBoundaryJumpRatio,
    maxContiguousStasisFrames: motion.maxContiguousStasisFrames,
  });
  assert.equal(adapted.temporalMetricProfileId, MOTION_TEMPORAL_METRIC_PROFILE_ID);
  assert.equal(Object.hasOwn(adapted, "sampleHashes"), false);
  assert.equal(Object.hasOwn(adapted, "outputPath"), false);
  assert.equal(Object.hasOwn(adapted.metrics, "rawFrames"), false);
  assertDeepFrozen(adapted);

  const report = buildMotionIntegrityCalibrationReport({ cases: [adapted] });
  assert.equal(report.calibrationStatus, "provisional");
  assert.equal(report.productionThresholdsApproved, false);
});

test("benchmark adapter rejects malformed or accessor evidence without invoking getters", () => {
  const motion = analyzeConsecutiveFrames(grayFrames(24, 2, 2), 2, 2, {
    rollingWindowFrames: 4,
    segments: [
      { id: "sentence_a", startFrame: 0, endFrame: 12 },
      { id: "sentence_b", startFrame: 12, endFrame: 24 },
    ],
  });
  const inputFor = (candidate) => ({
    caseId: "synthetic_adapter_rejection",
    sourceFixtureId: "calibration_adapter_rejection",
    sourceKind: "synthetic",
    structuralPassed: true,
    motion: candidate,
  });

  let invoked = false;
  const accessorMotion = { ...motion };
  Object.defineProperty(accessorMotion, "jerkEnergyP99", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("getter must not execute");
    },
  });
  assertInvalid(() => motionIntegrityCaseFromBenchmarkQa(
    inputFor(accessorMotion),
  ));
  assert.equal(invoked, false);

  const boundaryAccessorMotion = {
    ...motion,
    boundaryMetrics: motion.boundaryMetrics.map((entry) => ({ ...entry })),
  };
  Object.defineProperty(boundaryAccessorMotion.boundaryMetrics[0], "jumpRatio", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("nested getter must not execute");
    },
  });
  assertInvalid(() => motionIntegrityCaseFromBenchmarkQa(
    inputFor(boundaryAccessorMotion),
  ));
  assert.equal(invoked, false);

  assertInvalid(() => motionIntegrityCaseFromBenchmarkQa(inputFor({
    ...motion,
    temporalMetricProfileId: "untrusted_temporal_profile_v1",
  })));
  assertInvalid(() => motionIntegrityCaseFromBenchmarkQa(inputFor({
    ...motion,
    boundaryMetrics: new Array(1),
  })));
  assertInvalid(() => motionIntegrityCaseFromBenchmarkQa(inputFor({
    ...motion,
    boundaryMetrics: new Array(1001),
  })));
  assertInvalid(() => motionIntegrityCaseFromBenchmarkQa({
    ...inputFor(motion),
    rawFrames: Buffer.alloc(4),
  }));
});

test("shadow profile never self-approves production thresholds even with ten real fixtures", () => {
  const cases = Array.from(
    { length: MINIMUM_REAL_CONTENT_FIXTURES },
    (_, index) => calibrationCase({
      caseId: `real_threshold_fixture_${index}`,
      sourceFixtureId: `story_threshold_fixture_${index}`,
      sourceKind: "real",
      frameCount: 300,
      boundaryCount: 3,
    }),
  );
  const report = buildMotionIntegrityCalibrationReport({ cases });
  assert.equal(report.realContentFixtures, MINIMUM_REAL_CONTENT_FIXTURES);
  assert.equal(report.productionThresholdsApproved, false);
  assert.equal(
    report.blockers.includes(
      MOTION_INTEGRITY_BLOCKERS.INSUFFICIENT_REAL_FIXTURES,
    ),
    false,
  );
  assert.deepEqual(report.blockers, [
    MOTION_INTEGRITY_BLOCKERS.SHADOW_THRESHOLDS,
  ]);
});

test("motion integrity rejects duplicate identities and untrusted payload fields", () => {
  const duplicates = engineeringCorpus();
  duplicates[1].caseId = duplicates[0].caseId;
  assertInvalid(() => buildMotionIntegrityCalibrationReport({
    cases: duplicates,
  }));

  for (const forbiddenField of ["outputPath", "rawFrames", "sampleHashes"]) {
    const cases = engineeringCorpus();
    cases[0][forbiddenField] = forbiddenField;
    assertInvalid(() => buildMotionIntegrityCalibrationReport({ cases }));
  }

  assertInvalid(() => buildMotionIntegrityCalibrationReport({
    cases: engineeringCorpus(),
    productionThresholdsApproved: true,
  }));

  const sourceConflict = engineeringCorpus();
  sourceConflict[3].sourceFixtureId = sourceConflict[0].sourceFixtureId;
  assertInvalid(() => buildMotionIntegrityCalibrationReport({
    cases: sourceConflict,
  }));
});

test("motion integrity rejects accessors, symbols, sparse arrays, and polluted prototypes without invoking getters", () => {
  const accessorCases = engineeringCorpus();
  let invoked = false;
  Object.defineProperty(accessorCases[0].metrics, "meanJerkEnergy", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("getter must not execute");
    },
  });
  assertInvalid(() => buildMotionIntegrityCalibrationReport({
    cases: accessorCases,
  }));
  assert.equal(invoked, false);

  const symbolCases = engineeringCorpus();
  symbolCases[0].metrics[Symbol("hidden")] = 1;
  assertInvalid(() => buildMotionIntegrityCalibrationReport({
    cases: symbolCases,
  }));

  const sparseCases = new Array(10);
  sparseCases[0] = engineeringCorpus()[0];
  assertInvalid(() => buildMotionIntegrityCalibrationReport({
    cases: sparseCases,
  }));

  const pollutedCases = engineeringCorpus();
  Object.setPrototypeOf(pollutedCases[0].metrics, { rawFrames: [] });
  assertInvalid(() => buildMotionIntegrityCalibrationReport({
    cases: pollutedCases,
  }));

  const customArrayPrototype = engineeringCorpus();
  Object.setPrototypeOf(customArrayPrototype, []);
  assertInvalid(() => buildMotionIntegrityCalibrationReport({
    cases: customArrayPrototype,
  }));
});

test("motion integrity rejects unsafe numeric evidence and inconsistent summaries", () => {
  for (const unsafe of [Number.NaN, Number.POSITIVE_INFINITY, -0, -0.01, 1.01]) {
    const cases = engineeringCorpus();
    cases[0].metrics.meanAccelerationEnergy = unsafe;
    assertInvalid(() => buildMotionIntegrityCalibrationReport({ cases }));
  }

  const impossibleJerk = engineeringCorpus();
  impossibleJerk[0].metrics.jerkEnergyP99 = 0.2;
  impossibleJerk[0].metrics.peakJerkEnergy = 0.1;
  assertInvalid(() => buildMotionIntegrityCalibrationReport({
    cases: impossibleJerk,
  }));

  const missingBoundaryEvidence = engineeringCorpus();
  missingBoundaryEvidence[0].boundaryCount = 0;
  assertInvalid(() => buildMotionIntegrityCalibrationReport({
    cases: missingBoundaryEvidence,
  }));
});

test("motion integrity validator rejects tampered derived fields, hashes, and nested descriptors", () => {
  const original = buildMotionIntegrityCalibrationReport({
    cases: engineeringCorpus(),
  });

  const approved = structuredClone(original);
  approved.productionThresholdsApproved = true;
  assertInvalid(() => validateMotionIntegrityCalibrationReport(approved));

  const wrongCount = structuredClone(original);
  wrongCount.realContentFixtures = 10;
  assertInvalid(() => validateMotionIntegrityCalibrationReport(wrongCount));

  const wrongHash = structuredClone(original);
  wrongHash.contentHash = "0".repeat(64);
  assertInvalid(() => validateMotionIntegrityCalibrationReport(wrongHash));

  const reportAccessor = structuredClone(original);
  let invoked = false;
  Object.defineProperty(
    reportAccessor.aggregateTemporalMetrics.peakJerkEnergy,
    "maximum",
    {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("getter must not execute");
      },
    },
  );
  assertInvalid(() => validateMotionIntegrityCalibrationReport(reportAccessor));
  assert.equal(invoked, false);

  const reportSymbol = structuredClone(original);
  reportSymbol[Symbol("secret")] = true;
  assertInvalid(() => validateMotionIntegrityCalibrationReport(reportSymbol));

  const pollutedReport = structuredClone(original);
  Object.setPrototypeOf(pollutedReport, { productionThresholdsApproved: true });
  assertInvalid(() => validateMotionIntegrityCalibrationReport(pollutedReport));
});
