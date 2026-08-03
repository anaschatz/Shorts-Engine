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
  compileProductionAnimation,
} = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const {
  EDUCATIONAL_EXPLAINER_PROFILE_TOKEN,
  EDUCATIONAL_EXPLAINER_PROFILE_VERSION,
  EDUCATIONAL_EXPLAINER_STYLE_VERSION,
  REFERENCE_STYLE_SPEC_ID,
} = require("../server/pipelines/narrated-short/animation/educational-explainer-profile.cjs");
const {
  runEducationalPerceptualQa,
} = require("../server/pipelines/narrated-short/animation/perceptual-qa.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const {
  normalizeNarratedJobPayload,
} = require("../server/pipelines/pipeline-registry.cjs");
const {
  deterministicAudioGraph,
} = require("../server/pipelines/narrated-short/video-compositor.cjs");

const ROOT = resolve(__dirname, "..");

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fixture(id = "002_gps_week_rollover") {
  const manifest = json(resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "semantic-events",
    `${id}.json`,
  ));
  return {
    draft: normalizeDraftBundle(json(resolve(ROOT, manifest.sourceBindings.fixturePath))),
    timingContext: normalizeAnimationTimingContext(json(resolve(
      ROOT,
      "eval",
      "narrated",
      "dark-curiosity",
      "semantic-events",
      "timing",
      `${id}.timing.json`,
    ))),
  };
}

function compile(id = "002_gps_week_rollover") {
  const source = fixture(id);
  return compileProductionAnimation({
    ...source,
    projectId: `prj_educational_${id}`,
    projectRevision: 1,
    renderProfile: "preview",
    animationProfile: EDUCATIONAL_EXPLAINER_PROFILE_TOKEN,
  });
}

test("educational explainer compiles deterministic bound contracts into AnimationIR v4", () => {
  const first = compile();
  const second = compile();
  assert.deepEqual(second, first);
  assert.equal(first.animationIR.schemaVersion, 4);
  assert.equal(first.animationIR.profileVersion, EDUCATIONAL_EXPLAINER_PROFILE_VERSION);
  assert.equal(first.animationIR.renderer.styleVersion, EDUCATIONAL_EXPLAINER_STYLE_VERSION);
  assert.equal(first.referenceStyleSpec.id, REFERENCE_STYLE_SPEC_ID);
  assert.equal(first.narrativeBeatGraph.sections.length, 5);
  assert.ok(first.narrativeBeatGraph.microbeats.length >= 5);
  assert.ok(first.directorPlan.visualEvents.length >= first.narrativeBeatGraph.microbeats.length);
  assert.equal(first.audioIR.tracks.find((track) => track.type === "music_bed").enabled, false);
  assert.ok(first.assetManifest.assets.every((asset) => asset.commercialUseAllowed));
  const microbeatStarts = new Set(
    first.narrativeBeatGraph.microbeats.map((microbeat) => microbeat.startFrame),
  );
  assert.ok(
    first.audioIR.tracks.find((track) => track.type === "sound_effects")
      .clips.every((clip) => microbeatStarts.has(clip.startFrame)),
  );
  assert.ok(first.animationIR.scenes.every((scene) => (
    scene.entityIds.includes("promise_header")
    && scene.entityIds.includes("story_thread")
  )));
  assert.equal(first.animationIR.assetManifestHash, first.assetManifest.contentHash);
  assert.equal(
    contentHash(first.plan),
    contentHash(second.plan),
  );
});

test("educational explainer perceptual gates cover cadence, contrast, continuity and provenance", () => {
  const qa = runEducationalPerceptualQa(compile());
  assert.equal(qa.status, "passed");
  assert.ok(Object.values(qa.checks).every(Boolean));
  assert.ok(qa.metrics.maximumVisualEventGapSeconds <= 3);
  assert.ok(qa.metrics.primaryTextContrast >= 4.5);
  assert.ok(qa.metrics.accentContrast >= 3);
});

test("HyperFrames compiles the exact v4 tuple with integrated semantic typography", async () => {
  const compiled = compile();
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const first = compileAnimationIRToHtml(compiled.animationIR);
  const second = compileAnimationIRToHtml(compiled.animationIR);
  assert.equal(second.compositionHash, first.compositionHash);
  assert.match(first.html, /data-entity-id="promise_header"/);
  assert.match(first.html, /data-entity-id="story_thread"/);
  assert.match(first.html, /data-legibility-role="semantic_phrase"/);
  assert.match(first.html, /<tspan x="360" dy="38">/);
  assert.match(first.html, /data-reference-style-spec-hash=/);
  assert.match(first.html, /activeVisualEventId/);
  assert.match(first.html, /previous=index===cueIndex-1/);
  assert.equal(first.qaPolicy.semanticRoi.width, 648);
  assert.ok(first.qaPolicy.labelIds.length >= compiled.narrativeBeatGraph.microbeats.length * 2);
});

test("AudioIR compiles to a deterministic local FFmpeg narration and sparse-SFX graph", () => {
  const compiled = compile();
  const measurement = {
    input: {
      integratedLoudness: -22.1,
      truePeak: -4.2,
      loudnessRange: 3.1,
      threshold: -32.2,
    },
    offset: 0.02,
  };
  const first = deterministicAudioGraph(compiled.audioIR, measurement);
  const second = deterministicAudioGraph(compiled.audioIR, measurement);
  assert.equal(second, first);
  assert.match(first, /^\[1:a:0\]loudnorm=/);
  assert.match(first, /sine=frequency=880/);
  assert.match(first, /anoisesrc=color=pink/);
  assert.match(first, /amix=inputs=3/);
  assert.doesNotMatch(first, /https?:|file=|movie=/);
});

test("API payload contract keeps semantic-v3 compatible and feature-gates the educational profile", () => {
  const hash = "a".repeat(64);
  const common = {
    projectRevision: 1,
    language: "en",
    approvedDraftArtifactId: "art_12345678",
    approvedDraftHash: hash,
    renderProfile: "preview",
    narrationManifestHash: hash,
    audioHash: hash,
    alignmentHash: hash,
    captionRendererVersion: "ass_caption_v1",
    captionProfileVersion: "1.1.0",
    audioNormalizationProfileVersion: "1.0.0",
    compositorVersion: "narrated_compositor_v2",
    qaProfileVersion: "1.1.0",
    evidenceProfileVersion: "1.0.0",
    timingContextHash: hash,
    animationPlanHash: hash,
    animationIRHash: hash,
    animationProvider: "hyperframes_local",
    animationRuntimeVersion: "0.7.55",
  };
  const semantic = normalizeNarratedJobPayload({
    ...common,
    animationProfile: "semantic-v3",
    animationStyleVersion: "3.0.0",
  }, "render_narrated_short");
  assert.equal(semantic.animationProfile, "semantic-v3");

  const educational = normalizeNarratedJobPayload({
    ...common,
    animationProfile: EDUCATIONAL_EXPLAINER_PROFILE_TOKEN,
    animationStyleVersion: EDUCATIONAL_EXPLAINER_STYLE_VERSION,
    styleSpecId: REFERENCE_STYLE_SPEC_ID,
    referenceStyleSpecHash: hash,
    narrativeBeatGraphHash: hash,
    directorPlanHash: hash,
    audioIRHash: hash,
    assetManifestV2Hash: hash,
  }, "render_narrated_short");
  assert.equal(educational.animationProfile, EDUCATIONAL_EXPLAINER_PROFILE_TOKEN);
  assert.equal(educational.styleSpecId, REFERENCE_STYLE_SPEC_ID);
  assert.throws(
    () => normalizeNarratedJobPayload({
      ...common,
      animationProfile: EDUCATIONAL_EXPLAINER_PROFILE_TOKEN,
      animationStyleVersion: EDUCATIONAL_EXPLAINER_STYLE_VERSION,
      styleSpecId: "untrusted_remote_style",
    }, "render_narrated_short"),
    { code: "VALIDATION_ERROR" },
  );
});

test("legacy semantic-v3 compilation remains byte-exact", () => {
  const source = fixture();
  const legacy = compileProductionAnimation({
    ...source,
    projectId: "prj_002_gps_week_rollover",
    projectRevision: 1,
    renderProfile: "preview",
    animationProfile: "semantic-v3",
  });
  assert.equal(
    contentHash(legacy.plan),
    "361ef45cb3178a41804e1a9c75600e57982548d4a1048f64bf3d905251389759",
  );
  assert.equal(
    legacy.animationIR.contentHash,
    "9613fe7c2b09c6707eab4b060393d7da9519a1849a454a241c94f48523848ea4",
  );
});
