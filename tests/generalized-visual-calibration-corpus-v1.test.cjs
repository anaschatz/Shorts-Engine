"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compileGeneralizedVisualCalibrationCorpus,
} = require("../server/pipelines/narrated-short/animation/generalized-visual-calibration-corpus.cjs");

test("rights-safe calibration corpus compiles twelve cases through every canonical IR boundary", () => {
  const corpus = compileGeneralizedVisualCalibrationCorpus();
  assert.equal(corpus.manifest.caseCount, 12);
  assert.equal(corpus.manifest.sceneCount, 36);
  assert.deepEqual(corpus.manifest.semanticUncertaintyCoverage, ["disputed", "qualified", "unknown", "verified"]);
  assert.equal(new Set(corpus.cases.map((entry) => entry.corpusCase.animationIrHash)).size, 12);
  for (const entry of corpus.cases) {
    assert.equal(entry.corpusCase.rightsBasis, "operator_created_synthetic_v1");
    assert.match(entry.corpusCase.sourceDraftHash, /^[a-f0-9]{64}$/);
    assert.equal(entry.corpusCase.storyIrHash, entry.context.storyIR.contentHash);
    assert.equal(entry.corpusCase.visualProgramHash, entry.compiled.visualProgram.contentHash);
    assert.equal(entry.corpusCase.recipePlanHash, entry.compiled.visualRecipePlan.contentHash);
    assert.equal(entry.corpusCase.animationIrHash, entry.compiled.animationIR.contentHash);
    assert.equal(entry.compiled.visualRecipePlan.scenes.length, 3);
  }
  assert.ok(Object.values(corpus.manifest.recipeSceneCounts).every((count) => count >= 3));
});

test("unknown calibration semantics remain explicit metadata without widening production certainty", () => {
  const corpus = compileGeneralizedVisualCalibrationCorpus();
  const unknownCases = corpus.cases.filter((entry) => entry.corpusCase.semanticUncertainty === "unknown");
  assert.ok(unknownCases.length >= 2);
  for (const entry of unknownCases) {
    assert.ok(entry.context.storyIR.beats.every((beat) => beat.certainty === "disputed"));
    assert.ok(entry.compiled.visualRecipePlan.scenes.some((scene) => ["bounded_uncertainty", "negative_space_absence"].includes(scene.recipeId)));
  }
});
