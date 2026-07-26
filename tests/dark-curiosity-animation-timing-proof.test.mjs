import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { runTimingCli } from "../tools/dark-curiosity-animation-timing.mjs";

const require = createRequire(import.meta.url);
const { normalizeAnimationTimingContext } = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const { compileTimingBoundAnimationIR } = require("../server/pipelines/narrated-short/animation/compiler.cjs");
const { buildTimingTrace, validateTimingTrace } = require("../server/pipelines/narrated-short/animation/timing-proof.cjs");
const fixtureDir = join(import.meta.dirname, "../eval/narrated/dark-curiosity/animation");
const json = (name) => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
const compiled = () => compileTimingBoundAnimationIR(json("002_wow_signal_semantic_plan.json"), normalizeAnimationTimingContext(json("002_wow_signal_timing_context.json")));

test("timing trace is safe, hash-bound and contains resolved checkpoints", () => {
  const ir = compiled(), trace = buildTimingTrace(ir);
  assert.equal(trace.resolvedOperationCount, 12);
  assert.equal(trace.morphPointCount, 128);
  assert.deepEqual(trace.checkpoints.map((item) => item.id), ["before_waveform", "waveform_midpoint", "signal_pulse", "beam_crossing", "morph_midpoint", "payoff_start", "readability_hold"]);
  assert.doesNotMatch(JSON.stringify(trace), /\b(?:In|radio|signal|vanished|proof)\b|\/Users|audio/i);
  assert.equal(validateTimingTrace(trace, ir).contentHash, trace.contentHash);
  const tampered = structuredClone(trace); tampered.operations[0].startFrame += 1;
  assert.throws(() => validateTimingTrace(tampered, ir), { code: "ANIMATION_TIMING_PROOF_INVALID" });
});

test("timing proof CLI defaults to deterministic no-mutation dry run", async () => {
  const report = await runTimingCli(["proof", "--dry-run"]);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.mutated, false);
  assert.equal(report.deterministicCompilation, true);
  assert.equal(report.backwardSeekProof.passed, true);
  assert.equal(report.alignmentSensitivity.changed, true);
  assert.deepEqual(report.alignmentSensitivity.dependentCheckpoint, { baselineFrame: 28, changedFrame: 30 });
});

test("timing proof CLI rejects unsafe fixture selection and partial confirmation", async () => {
  await assert.rejects(runTimingCli(["proof", "--fixture", "../../secret"]), /allowlisted/);
  await assert.rejects(runTimingCli(["proof", "--render"]), /requires both --render and --yes/);
});

test("timing proof dry-run process does not create managed output", () => {
  const isolated = mkdtempSync(join(tmpdir(), "timing-cli-test-"));
  const target = join(isolated, "data/benchmarks/dark-curiosity-animation/wow-signal-timing");
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../tools/dark-curiosity-animation-timing.mjs"), "proof", "--dry-run"], { cwd: isolated, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(target), false);
});
