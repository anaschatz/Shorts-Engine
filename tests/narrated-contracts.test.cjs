const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const {
  contentHash,
  normalizeClaimLedger,
  normalizeContentBrief,
  normalizeDraftBundle,
  normalizeNarrativeScript,
  normalizeStoryboard,
} = require("../server/pipelines/narrated-short/contracts.cjs");

const FIXTURE_PATH = resolve(__dirname, "..", "eval", "narrated", "fixtures", "001_overload_explainer.json");

function fixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

test("narrated draft fixture validates with stable content hashes", () => {
  const first = normalizeDraftBundle(fixture());
  const second = normalizeDraftBundle(fixture());

  assert.equal(first.contentHash, second.contentHash);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(first.brief.formatId, "tactical_cause_effect_v1");
  assert.equal(first.storyboard.fps, 30);
  assert.equal(first.storyboard.scenes[1].reconstructionMode, "illustrative");
  assert.equal(contentHash({ b: 2, a: 1 }), contentHash({ a: 1, b: 2 }));
});

test("brief rejects unsupported formats and invalid duration", () => {
  const input = fixture().brief;
  assert.throws(() => normalizeContentBrief({ ...input, formatId: "generic_spam_v1" }), (error) => error.code === "VALIDATION_ERROR");
  assert.throws(() => normalizeContentBrief({ ...input, targetSeconds: 90 }), (error) => error.code === "VALIDATION_ERROR");
});

test("claim ledger fails closed for unsupported facts and unknown sources", () => {
  const input = fixture();
  const unsupported = structuredClone(input.claimLedger);
  unsupported.claims[0].sourceIds = [];
  assert.throws(() => normalizeClaimLedger(unsupported, { brief: input.brief }), (error) => error.code === "VALIDATION_ERROR");

  const unknown = structuredClone(input.claimLedger);
  unknown.claims[0].sourceIds = ["src_missing"];
  assert.throws(() => normalizeClaimLedger(unknown, { brief: input.brief }), (error) => error.code === "VALIDATION_ERROR");
});

test("script enforces narrative order claim references and reading speed", () => {
  const input = fixture();
  const wrongOrder = structuredClone(input.script);
  wrongOrder.beats[0].role = "setup";
  assert.throws(
    () => normalizeNarrativeScript(wrongOrder, { brief: input.brief, claimLedger: input.claimLedger }),
    (error) => error.code === "VALIDATION_ERROR",
  );

  const unknownClaim = structuredClone(input.script);
  unknownClaim.beats[1].claimIds = ["claim_missing"];
  assert.throws(
    () => normalizeNarrativeScript(unknownClaim, { brief: input.brief, claimLedger: input.claimLedger }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("storyboard enforces beat coverage pitch bounds and required endpoints", () => {
  const input = fixture();
  const outOfBounds = structuredClone(input.storyboard);
  outOfBounds.scenes[1].operations[0].x = 1.5;
  assert.throws(
    () => normalizeStoryboard(outOfBounds, { brief: input.brief, claimLedger: input.claimLedger, script: input.script }),
    (error) => error.code === "VALIDATION_ERROR",
  );

  const missingBeat = structuredClone(input.storyboard);
  missingBeat.scenes = missingBeat.scenes.filter((scene) => !scene.beatIds.includes("beat_03"));
  assert.throws(
    () => normalizeStoryboard(missingBeat, { brief: input.brief, claimLedger: input.claimLedger, script: input.script }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});
