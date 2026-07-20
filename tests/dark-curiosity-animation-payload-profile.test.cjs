"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const {
  contentHash,
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  createAlignment,
  scriptWords,
} = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const {
  buildProductionAnimationPayloadBindings,
} = require("../server/pipelines/narrated-short/animation/payload-bindings.cjs");
const {
  SEMANTIC_SENTENCE_PROFILE_TOKEN,
} = require("../server/pipelines/narrated-short/animation/semantic-render-profile.cjs");

function fixture() {
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(resolve(
    __dirname,
    "..",
    "eval",
    "narrated",
    "dark-curiosity",
    "fixtures",
    "001_wow_signal_mystery.json",
  ), "utf8")));
  const projectId = "prj_animation-profile-binding";
  const draftArtifactId = "art_animation-profile-draft";
  const narrationManifestArtifactId = "art_animation-profile-narration";
  const audioArtifactId = "art_animation-profile-audio";
  const audioHash = "a".repeat(64);
  let cursor = 0.2;
  const words = scriptWords(draft.script).map((word) => {
    const framed = { word: word.text, start: cursor, end: cursor + 0.2, probability: 0.99 };
    cursor += 0.25;
    return framed;
  });
  const alignment = createAlignment({
    project: { id: projectId, input: { revision: 1 } },
    draft,
    narration: {
      draftArtifactId,
      draftHash: draft.contentHash,
      scriptHash: draft.script.contentHash,
      audioArtifactId,
      audioHash,
      language: "en",
      media: { durationSeconds: 32 },
    },
    narrationSummary: {
      manifestArtifactId: narrationManifestArtifactId,
      manifestHash: "b".repeat(64),
    },
    providerResult: { segments: [{ words }] },
    provider: { model: "fixture", device: "cpu", computeType: "int8" },
  });
  const alignmentArtifactId = "art_animation-profile-alignment";
  const project = {
    id: projectId,
    input: {
      revision: 1,
      activeNarration: {
        alignmentArtifactId,
        alignmentHash: alignment.contentHash,
      },
    },
  };
  const approval = { draftArtifactId, draftHash: draft.contentHash };
  const contentArtifacts = {
    readJson(artifactId) {
      if (artifactId === draftArtifactId) return { body: draft };
      if (artifactId === alignmentArtifactId) return { body: alignment };
      throw new TypeError("Unknown test artifact.");
    },
  };
  return { alignment, approval, contentArtifacts, draft, project };
}

function dependencies(seen) {
  return {
    buildProductionTimingContext(input) {
      seen.timing = input;
      return { contentHash: "c".repeat(64) };
    },
    buildSemanticSentencePlanningContext() {
      return {
        semanticEventGraph: {
          primitivePayloadProfileId: "test_generalized_profile",
        },
      };
    },
    compileProductionAnimation(input) {
      seen.compile = input;
      const semantic = input.animationProfile === SEMANTIC_SENTENCE_PROFILE_TOKEN;
      return {
        plan: { schemaVersion: semantic ? 3 : 2, profile: semantic ? "semantic" : "v2" },
        animationIR: {
          contentHash: (semantic ? "d" : "e").repeat(64),
          renderer: { styleVersion: semantic ? "3.0.0" : "2.0.0" },
        },
      };
    },
  };
}

test("payload bindings pass the exact semantic-v3 token into compilation and persist it", () => {
  const value = fixture();
  const seen = {};
  const bindings = buildProductionAnimationPayloadBindings({
    ...value,
    renderProfile: "preview",
    animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
  }, dependencies(seen));

  assert.equal(seen.compile.animationProfile, "semantic-v3");
  assert.equal(bindings.animationProfile, "semantic-v3");
  assert.equal(bindings.animationStyleVersion, "3.0.0");
  assert.equal(bindings.animationPlanHash, contentHash({ schemaVersion: 3, profile: "semantic" }));
  assert.equal(Object.isFrozen(bindings), true);
});

test("payload bindings omit animationProfile entirely on the unchanged v2 path", () => {
  const value = fixture();
  const seen = {};
  const bindings = buildProductionAnimationPayloadBindings({
    ...value,
    renderProfile: "preview",
  }, dependencies(seen));

  assert.equal(Object.hasOwn(seen.compile, "animationProfile"), false);
  assert.equal(Object.hasOwn(bindings, "animationProfile"), false);
  assert.deepEqual(Object.keys(bindings), [
    "timingContextHash",
    "animationPlanHash",
    "animationIRHash",
    "animationProvider",
    "animationRuntimeVersion",
    "animationStyleVersion",
  ]);
  assert.equal(bindings.animationStyleVersion, "2.0.0");
});

test("payload bindings reject unknown animation profiles before reading artifacts", () => {
  assert.throws(
    () => buildProductionAnimationPayloadBindings({
      project: null,
      approval: null,
      renderProfile: "preview",
      animationProfile: "semantic-v4",
      contentArtifacts: null,
    }),
    (error) => error?.code === "ANIMATION_PROFILE_INVALID" && error?.details?.field === "animationProfile",
  );
});
