const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeNarratedJobPayload } = require("../server/pipelines/pipeline-registry.cjs");
const { SEMANTIC_SENTENCE_PROFILE_TOKEN } = require("../server/pipelines/narrated-short/animation/semantic-render-profile.cjs");

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

test("render payload binds style 3.2.0 only to the exact semantic-v3 profile", () => {
  const semantic = normalizeNarratedJobPayload({
    ...base,
    animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
    animationStyleVersion: "3.2.0",
  }, "render_narrated_short");
  assert.equal(semantic.animationProfile, "semantic-v3");
  assert.equal(semantic.animationStyleVersion, "3.2.0");

  for (const invalid of [
    { ...base, animationStyleVersion: "3.2.0" },
    { ...base, animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN, animationStyleVersion: "2.0.0" },
    { ...base, animationProfile: "dark_curiosity_semantic_sentences_v3", animationStyleVersion: "3.2.0" },
    { ...base, animationProfile: "SEMANTIC-V3", animationStyleVersion: "3.2.0" },
  ]) {
    assert.throws(
      () => normalizeNarratedJobPayload(invalid, "render_narrated_short"),
      (error) => error?.code === "VALIDATION_ERROR" && ["animationProfile", "animationVersion"].includes(error?.details?.field),
    );
  }

  const noBindings = {
    projectRevision: 1,
    language: "en",
    approvedDraftArtifactId: "art_aaaaaaaa",
    approvedDraftHash: hash("a"),
    renderProfile: "preview",
    animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
  };
  assert.throws(
    () => normalizeNarratedJobPayload(noBindings, "render_narrated_short"),
    (error) => error?.code === "VALIDATION_ERROR" && error?.details?.field === "animationProfile",
  );
});

test("omitting animationProfile preserves the normalized v2 payload shape", () => {
  const normalized = normalizeNarratedJobPayload({ ...base, animationStyleVersion: "2.0.0" }, "render_narrated_short");
  assert.equal(Object.hasOwn(normalized, "animationProfile"), false);
  assert.deepEqual(Object.keys(normalized), [
    "schemaVersion",
    "projectRevision",
    "language",
    "approvedDraftArtifactId",
    "approvedDraftHash",
    "renderProfile",
    "narrationManifestHash",
    "audioHash",
    "alignmentHash",
    "captionRendererVersion",
    "captionProfileVersion",
    "audioNormalizationProfileVersion",
    "compositorVersion",
    "qaProfileVersion",
    "evidenceProfileVersion",
    "timingContextHash",
    "animationPlanHash",
    "animationIRHash",
    "animationProvider",
    "animationRuntimeVersion",
    "animationStyleVersion",
  ]);
});
