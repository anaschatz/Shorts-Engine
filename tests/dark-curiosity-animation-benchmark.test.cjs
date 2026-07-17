const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const { analyzeConsecutiveFrames, analyzeSampleFrames, evaluateGeometryQuality, evaluateMotionQuality } = require("../server/pipelines/narrated-short/animation/benchmark-qa.cjs");

function frames(count, width, height, valueAt) {
  const output = Buffer.alloc(count * width * height);
  for (let frame = 0; frame < count; frame += 1) for (let pixel = 0; pixel < width * height; pixel += 1) output[frame * width * height + pixel] = valueAt(frame, pixel);
  return output;
}

test("benchmark sample metrics detect diversity, stasis and black frames", () => {
  const moving = Buffer.from([10, 10, 10, 10, 20, 10, 10, 10, 20, 20, 10, 10]);
  const metrics = analyzeSampleFrames(moving, 2, 2);
  assert.equal(metrics.sampleCount, 3);
  assert.equal(metrics.uniqueFrameRatio, 1);
  assert.ok(metrics.motionEnergy > 0);
  const staticFrames = analyzeSampleFrames(Buffer.alloc(12, 20), 2, 2);
  assert.equal(staticFrames.stasisRatio, 1);
  assert.equal(staticFrames.uniqueFrameRatio, 1 / 3);
});

test("consecutive motion QA rejects static and ambient-only changes", () => {
  const staticMetrics = analyzeConsecutiveFrames(Buffer.alloc(300 * 4, 20), 2, 2);
  assert.equal(evaluateMotionQuality(staticMetrics).semanticMotion, false);
  const ambient = frames(300, 2, 2, (frame, pixel) => pixel < 2 ? 20 : (20 + frame) % 255);
  const semanticMask = Buffer.from([1, 1, 0, 0]);
  const ambientMetrics = analyzeConsecutiveFrames(ambient, 2, 2, { mask: semanticMask });
  assert.equal(evaluateMotionQuality(ambientMetrics).semanticMotion, false);
  assert.equal(ambientMetrics.consecutiveStasisRatio, 1);
});

test("consecutive motion QA recognizes balanced semantic motion deterministically", () => {
  const moving = frames(300, 2, 2, (frame, pixel) => 40 + (frame % 100 < 50 ? frame % 50 : 50 - frame % 50) + pixel * 3);
  const first = analyzeConsecutiveFrames(moving, 2, 2, { readabilityHolds: [{ startFrame: 284, endFrame: 300 }] });
  const second = analyzeConsecutiveFrames(moving, 2, 2, { readabilityHolds: [{ startFrame: 284, endFrame: 300 }] });
  assert.deepEqual(first, second);
  assert.equal(evaluateMotionQuality(first).semanticMotion, true);
  assert.equal(first.firstMeaningfulMotionFrame, 1);
  assert.ok(first.maxWindowMotionShare < 0.4);
});

test("consecutive motion QA detects late hooks, long stasis and concentrated energy", () => {
  const delayed = frames(300, 2, 2, (frame) => frame < 10 ? 20 : (20 + frame) % 220);
  assert.equal(evaluateMotionQuality(analyzeConsecutiveFrames(delayed, 2, 2)).immediateHook, false);
  const stalled = frames(300, 2, 2, (frame) => frame < 40 ? 20 + frame : frame < 70 ? 60 : (20 + frame) % 220);
  assert.equal(evaluateMotionQuality(analyzeConsecutiveFrames(stalled, 2, 2)).contiguousStasis, false);
  const overloaded = frames(300, 2, 2, (frame) => frame < 51 ? (frame % 2 ? 240 : 10) : 10);
  assert.equal(evaluateMotionQuality(analyzeConsecutiveFrames(overloaded, 2, 2)).balancedMotion, false);
});

test("semantic geometry QA fails closed on missing continuity, focus, ROI, or legibility proof", () => {
  const base = { passed: true, captionSafeZoneViolations: [], clippedEntities: [] };
  const missing = evaluateGeometryQuality(base, true);
  assert.equal(missing.geometryAudit, true);
  assert.equal(missing.persistentContinuity, false);
  assert.equal(missing.focusExclusivity, false);
  assert.equal(missing.primaryRoi, false);
  assert.equal(missing.mobileLegibility, false);

  const complete = evaluateGeometryQuality({ ...base, persistentContinuityViolations: [], persistentObservationCount: 5, observedTransitionIds: ["transition"], focusViolations: [], observedFocusIntervalIds: ["focus"], primaryRoiViolations: [], legibilityViolations: [], contrastViolations: [], labelObservationCount: 5, markedLabelIds: ["proof_label"], observedLabelIds: ["proof_label"], unobservedLabelIds: [] }, true);
  assert.ok(Object.values(complete).every(Boolean));

  const hiddenMarkedLabel = evaluateGeometryQuality({ ...base, persistentContinuityViolations: [], persistentObservationCount: 5, observedTransitionIds: ["transition"], focusViolations: [], observedFocusIntervalIds: ["focus"], primaryRoiViolations: [], legibilityViolations: [], contrastViolations: [], labelObservationCount: 4, markedLabelIds: ["hidden_label", "proof_label"], observedLabelIds: ["proof_label"], unobservedLabelIds: ["hidden_label"] }, true);
  assert.equal(hiddenMarkedLabel.mobileLegibility, false);
});

test("semantic geometry QA supports transitionless generic scenes without weakening Wow proof", () => {
  const geometry = {
    passed: true,
    captionSafeZoneViolations: [],
    clippedEntities: [],
    persistentContinuityViolations: [],
    persistentObservationCount: 12,
    observedTransitionIds: [],
    focusViolations: [],
    observedFocusIntervalIds: [],
    primaryRoiViolations: [],
    legibilityViolations: [],
    contrastViolations: [],
    labelObservationCount: 12,
    markedLabelIds: ["primary_label", "secondary_label"],
    observedLabelIds: ["primary_label", "secondary_label"],
    unobservedLabelIds: [],
  };
  const generic = evaluateGeometryQuality(geometry, {
    persistentContinuity: true,
    transitionContinuity: false,
    focusExclusivity: false,
    primaryRoi: true,
    mobileLegibility: true,
  });
  assert.ok(Object.values(generic).every(Boolean));

  const wow = evaluateGeometryQuality(geometry, true);
  assert.equal(wow.persistentContinuity, false);
  assert.equal(wow.focusExclusivity, false);
});

test("benchmark CLI defaults to no-mutation dry run", () => {
  const output = mkdtempSync(join(tmpdir(), "hf-cli-dry-"));
  const target = join(output, "must-not-exist");
  const result = spawnSync(process.execPath, [join(__dirname, "../tools/dark-curiosity-animation.mjs"), "benchmark", "--dry-run", "--width", "720", "--output", target], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.mutated, false);
  assert.equal(existsSync(target), false);
});

test("benchmark CLI refuses partial render confirmation", () => {
  const result = spawnSync(process.execPath, [join(__dirname, "../tools/dark-curiosity-animation.mjs"), "benchmark", "--render", "--width", "720"], { encoding: "utf8", timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires both --render and --yes/);
});
