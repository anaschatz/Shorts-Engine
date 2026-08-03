import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { compileGeneralizedVisualProgramAdapterToHtml } from "../renderer/hyperframes/animation-ir-adapter.mjs";

const require = createRequire(import.meta.url);
const { compileGeneralizedVisualCalibrationCorpus } = require("../server/pipelines/narrated-short/animation/generalized-visual-calibration-corpus.cjs");

function renderedCorpus() {
  return compileGeneralizedVisualCalibrationCorpus().cases.map((entry) => ({
    entry,
    html: compileGeneralizedVisualProgramAdapterToHtml(entry.compiled, entry.context).html,
  }));
}

test("comparison renders distinct before and after states instead of a dot baseline", () => {
  const comparisons = renderedCorpus().filter(({ entry }) => entry.compiled.visualRecipePlan.scenes.some((scene) => scene.recipeId === "comparison"));
  assert.ok(comparisons.length >= 3);
  for (const { html } of comparisons) {
    assert.match(html, /data-semantic-role="paired_state_comparison"/);
    assert.match(html, /data-semantic-role="reference_state"/);
    assert.match(html, /data-semantic-role="result_state"/);
    assert.match(html, />BEFORE<|>BEFORE<\/tspan>/);
    assert.match(html, />AFTER<|>AFTER<\/tspan>/);
    assert.match(html, />STATE<\/tspan>/);
    assert.match(html, />CHANGE<\/tspan>/);
    assert.doesNotMatch(html, /COMMON BASELINE/);
  }
});

test("chronology renders bounded start turn and active-now events", () => {
  const chronologies = renderedCorpus().filter(({ entry }) => entry.compiled.visualRecipePlan.scenes.some((scene) => scene.recipeId === "chronology"));
  assert.ok(chronologies.length >= 3);
  for (const { html } of chronologies) {
    assert.match(html, /chronology_event_1/);
    assert.match(html, /chronology_event_2/);
    assert.match(html, /chronology_event_3/);
    assert.match(html, />START<|>START<\/tspan>/);
    assert.match(html, />TURN<|>TURN<\/tspan>/);
    assert.match(html, />NOW<|>NOW<\/tspan>/);
    assert.match(html, /active-chronology/);
  }
});

test("helper typography is bounded at a mobile-readable request size and remains secondary", () => {
  const helpers = renderedCorpus().filter(({ entry }) => entry.compiled.visualRecipePlan.scenes.some((scene) => scene.layout.helper));
  assert.ok(helpers.length >= 8);
  for (const { html } of helpers) {
    assert.match(html, /data-single-helper="true"/);
    assert.match(html, /class="helper-copy"[^>]*data-text-fit="(?:1|2)" data-requested-font-size="30"/);
  }
});
