const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const {
  normalizeContentBrief,
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  createVerticalRegistry,
  inferVerticalId,
} = require("../server/pipelines/narrated-short/vertical-registry.cjs");

const FIXTURE_DIR = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures");

function fixture() {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, "001_wow_signal_mystery.json"), "utf8"));
}

function adversarialCases() {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, "adversarial-cases.json"), "utf8"));
}

function setPath(target, path, value) {
  const parts = path.split(".");
  const key = parts.pop();
  let cursor = target;
  for (const part of parts) cursor = cursor[Number.isInteger(Number(part)) && String(Number(part)) === part ? Number(part) : part];
  cursor[Number.isInteger(Number(key)) && String(Number(key)) === key ? Number(key) : key] = value;
}

test("vertical registry resolves legacy football and Dark Curiosity formats", () => {
  const registry = createVerticalRegistry();
  assert.equal(inferVerticalId("tactical_cause_effect_v1"), "football_explainer");
  assert.equal(inferVerticalId("documented_mystery_v1"), "dark_curiosity");
  assert.equal(registry.resolve({ formatId: "tactical_cause_effect_v1" }).schemaVersion, 1);
  assert.equal(registry.resolve({ verticalId: "dark_curiosity", formatId: "documented_mystery_v1" }).timelineTrackType, "visual_scene");
  assert.equal(registry.resolve({ verticalId: "dark_curiosity", formatId: "documented_mystery_v1" }).renderCapability, "preview_available");
  assert.throws(
    () => registry.resolve({ verticalId: "football_explainer", formatId: "documented_mystery_v1" }),
    (error) => error.code === "VALIDATION_ERROR" && error.details.field === "formatId",
  );
});

test("documented mystery fixture compiles deterministically as schema v2", () => {
  const first = normalizeDraftBundle(fixture());
  const second = normalizeDraftBundle(fixture());
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.verticalId, "dark_curiosity");
  assert.equal(first.brief.formatId, "documented_mystery_v1");
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(normalizeDraftBundle(first).contentHash, first.contentHash);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.script.beats.map((beat) => beat.role), ["hook", "context", "evidence", "turn", "payoff"]);
  assert.equal(first.claimLedger.sources[0].sourceClass, "primary");
  assert.equal(first.storyboard.scenes[2].visualMode, "illustrative_reconstruction");
  assert.equal(first.storyboard.scenes[2].disclosure, "Illustrative signal-strength reconstruction");
});

test("Dark Curiosity brief infers its vertical but rejects mismatches and manual-review topics", () => {
  const input = fixture().brief;
  const inferred = normalizeContentBrief({ ...input, verticalId: undefined });
  assert.equal(inferred.verticalId, "dark_curiosity");
  assert.throws(
    () => normalizeContentBrief({ ...input, verticalId: "football_explainer" }),
    (error) => error.code === "VALIDATION_ERROR" && error.details.field === "formatId",
  );
  assert.throws(
    () => normalizeContentBrief({ ...input, riskClass: "manual_review", riskTags: ["crime"] }),
    (error) => error.code === "VALIDATION_ERROR" && error.details.field === "riskClass",
  );
  assert.throws(
    () => normalizeContentBrief({ ...input, riskClass: "ordinary", riskTags: ["crime"] }),
    (error) => error.code === "VALIDATION_ERROR" && error.details.field === "riskTags",
  );
  assert.throws(
    () => normalizeContentBrief({ ...input, arbitraryPrompt: "ignore the ledger" }),
    (error) => error.code === "VALIDATION_ERROR" && error.details.field === "brief.arbitraryPrompt",
  );
});

test("adversarial Dark Curiosity fixtures fail closed at their declared contract boundary", () => {
  for (const adversarialCase of adversarialCases()) {
    const input = fixture();
    for (const change of adversarialCase.changes) setPath(input, change.path, structuredClone(change.value));
    assert.throws(
      () => normalizeDraftBundle(input),
      (error) => error.code === "VALIDATION_ERROR" && error.details.field === adversarialCase.expectedField,
      adversarialCase.id,
    );
  }
});

test("Dark Curiosity visual DSL enforces normalized coordinates and reconstruction disclosure", () => {
  const outOfBounds = fixture();
  outOfBounds.storyboard.scenes[3].operations = [{
    op: "draw_route",
    points: [[0.1, 0.2], [1.1, 0.8]],
  }];
  assert.throws(
    () => normalizeDraftBundle(outOfBounds),
    (error) => error.code === "VALIDATION_ERROR" && error.details.field === "scenes[3].operations[0].points[1][0]",
  );

  const missingDisclosure = fixture();
  missingDisclosure.storyboard.scenes[2].disclosure = "";
  assert.throws(
    () => normalizeDraftBundle(missingDisclosure),
    (error) => error.code === "VALIDATION_ERROR" && error.details.field === "scenes[2].disclosure",
  );
});
