const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeNarratedJobPayload } = require("../server/pipelines/pipeline-registry.cjs");

const hash = (letter) => letter.repeat(64);
const base = {
  projectRevision: 1,
  language: "en",
  approvedDraftArtifactId: "art_aaaaaaaa",
  approvedDraftHash: hash("a"),
  narrationManifestHash: hash("b"),
  audioHash: hash("c"),
  alignmentHash: hash("d"),
  renderProfile: "preview",
  timingContextHash: hash("e"),
  animationPlanHash: hash("f"),
  animationIRHash: hash("1"),
  animationProvider: "hyperframes_local",
  animationRuntimeVersion: "0.7.55",
  animationStyleVersion: "1.9.0",
};

test("render payload accepts complete Hyperframes bindings for legacy and generic semantic styles", () => {
  const normalized = normalizeNarratedJobPayload(base, "render_narrated_short");
  assert.equal(normalized.animationProvider, "hyperframes_local");
  assert.equal(normalized.animationRuntimeVersion, "0.7.55");
  assert.equal(normalized.animationStyleVersion, "1.9.0");
  assert.equal(
    normalizeNarratedJobPayload({ ...base, animationStyleVersion: "2.0.0" }, "render_narrated_short").animationStyleVersion,
    "2.0.0",
  );

  assert.throws(() => normalizeNarratedJobPayload({ ...base, animationStyleVersion: "1.8.0" }, "render_narrated_short"), (error) => error?.code === "VALIDATION_ERROR" && error?.details?.field === "animationVersion");
  const partial = { ...base };
  delete partial.animationIRHash;
  assert.throws(() => normalizeNarratedJobPayload(partial, "render_narrated_short"), (error) => error?.code === "VALIDATION_ERROR" && error?.details?.field === "animationVersion");
});
