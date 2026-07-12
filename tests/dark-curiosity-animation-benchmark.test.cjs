const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const { analyzeSampleFrames } = require("../server/pipelines/narrated-short/animation/benchmark-qa.cjs");

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
