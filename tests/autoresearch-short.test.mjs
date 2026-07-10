import test from "node:test";
import assert from "node:assert/strict";

import {
  RESULTS_HEADER,
  compareGuardrails,
  computeQualityScore,
  decideExperiment,
  extractJsonObject,
  parseArgs,
  summarizeRun,
} from "../tools/autoresearch-short.mjs";

const passingCommands = [
  { id: "lint", ok: true },
  { id: "build", ok: true },
  { id: "eval", ok: true },
  { id: "evalReference", ok: true },
  { id: "focusedTests", ok: true },
];

function summary(overrides = {}) {
  return {
    qualityScore: 98,
    evalScore: 98,
    referenceScore: 98,
    focusedScore: 100,
    metrics: {
      eval: {
        captionActionAlignment: 1,
        framingSafety: 1,
        cropSafetyScore: 1,
        noFalseGoalFromOcrOnly: 1,
        falseGoalRate: 0,
        falseVisualGoalRate: 0,
        falseGoalCaptionRate: 0,
        matchEventTruthFalseGoalRate: 0,
        textObstructionRisk: 0,
      },
      reference: {
        noFalseGoalClaim: 1,
        captionActionAlignment: 1,
        framingSafety: 1,
      },
    },
    ...overrides,
  };
}

test("quality score uses reference, eval and focused test weights", () => {
  const score = computeQualityScore({
    evalSummary: { aggregateScore: 80 },
    referenceSummary: { aggregateScore: 90 },
    focusedTestsOk: true,
  });
  assert.equal(score.qualityScore, 87.5);
  assert.equal(score.evalScore, 80);
  assert.equal(score.referenceScore, 90);
  assert.equal(score.focusedScore, 100);
});

test("decision keeps only meaningful score gains without guardrail regressions", () => {
  const baseline = summary({ qualityScore: 97.5 });
  const current = summary({ qualityScore: 98 });
  assert.equal(decideExperiment(current, baseline, passingCommands).status, "keep");
  assert.equal(decideExperiment(summary({ qualityScore: 97.6 }), baseline, passingCommands).status, "discard");
});

test("decision fails closed when hard gates fail", () => {
  const commands = [...passingCommands, { id: "focusedTests", ok: false }];
  const decision = decideExperiment(summary(), summary(), commands);
  assert.equal(decision.status, "crash");
  assert.ok(decision.failedHardGates.includes("focusedTests"));
});

test("guardrails catch false-goal and framing regressions", () => {
  const current = summary({
    metrics: {
      eval: {
        ...summary().metrics.eval,
        falseGoalRate: 0.1,
        framingSafety: 0.9,
      },
      reference: {
        ...summary().metrics.reference,
        noFalseGoalClaim: 0.9,
      },
    },
  });
  const regressions = compareGuardrails(current, summary());
  assert.ok(regressions.some((regression) => regression.metric === "eval.falseGoalRate"));
  assert.ok(regressions.some((regression) => regression.metric === "eval.framingSafety"));
  assert.ok(regressions.some((regression) => regression.metric === "reference.noFalseGoalClaim"));
});

test("parser extracts JSON from npm-style output", () => {
  const parsed = extractJsonObject(`
> shortsengine-static-prototype@0.1.0 eval
> node eval/run-eval.mjs

{
  "passed": true,
  "aggregateScore": 98
}
`);
  assert.deepEqual(parsed, { passed: true, aggregateScore: 98 });
});

test("runner summary reads compact eval stdout summaries", () => {
  const run = summarizeRun([
    { id: "eval", ok: true, summary: { aggregateScore: 98, captionActionAlignment: 1 } },
    { id: "evalReference", ok: true, summary: { aggregateScore: 96, noFalseGoalClaim: 1 } },
    { id: "focusedTests", ok: true },
  ]);
  assert.equal(run.qualityScore, 97.1);
  assert.equal(run.metrics.eval.captionActionAlignment, 1);
  assert.equal(run.metrics.reference.noFalseGoalClaim, 1);
});

test("cli arguments support baseline and experiment descriptions", () => {
  assert.equal(RESULTS_HEADER.includes("quality_score"), true);
  const options = parseArgs(["--baseline", "--description=test", "--min-delta=0.5"]);
  assert.equal(options.baselineMode, true);
  assert.equal(options.description, "test");
  assert.equal(options.minKeepDelta, 0.5);
});
