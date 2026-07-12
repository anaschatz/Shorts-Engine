const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { normalizeNarrationManifest } = require("../server/pipelines/narrated-short/narration-contract.cjs");
const { compileTimeline, timelineTrack } = require("../server/pipelines/narrated-short/timeline-compiler.cjs");
const { planSceneKeyframes, renderSceneSvg } = require("../server/pipelines/narrated-short/football/scene-svg.cjs");

const FIXTURE_PATH = resolve(__dirname, "..", "eval", "narrated", "fixtures", "001_overload_explainer.json");

function bundle() {
  return normalizeDraftBundle(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
}

function narrationFor(draft) {
  let cursor = 3;
  const words = [];
  for (const beat of draft.script.beats) {
    for (const text of beat.spokenText.split(/\s+/).filter(Boolean)) {
      words.push({ text, startFrame: cursor, endFrame: cursor + 5 });
      cursor += 6;
    }
  }
  return normalizeNarrationManifest({
    providerMode: "uploaded",
    voiceProfileId: "voice_en_01",
    audioArtifactId: "art_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    audioHash: "c".repeat(64),
    sampleRate: 48000,
    durationFrames: cursor + 6,
    words,
    rights: {
      commercialUseAllowed: true,
      consentReference: "operator_recording_consent_v1",
    },
  });
}

test("narration contract and timeline compiler produce deterministic frame tracks", () => {
  const draft = bundle();
  const narration = narrationFor(draft);
  const first = compileTimeline({ draftBundle: draft, narrationManifest: narration, width: 1080, height: 1920 });
  const second = compileTimeline({ draftBundle: draft, narrationManifest: narration, width: 1080, height: 1920 });

  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.totalFrames, narration.durationFrames);
  assert.equal(timelineTrack(first, "football_visual").clips.length, draft.storyboard.scenes.length);
  assert.equal(timelineTrack(first, "caption").clips.length, draft.script.beats.length);
  assert.equal(timelineTrack(first, "narration").clips[0].audioArtifactId, narration.audioArtifactId);
  assert.equal(first.beatTimings[0].startFrame, narration.words[0].startFrame);
});

test("timeline compiler fails when narration differs from the approved script", () => {
  const draft = bundle();
  const narration = narrationFor(draft);
  const invalid = structuredClone(narration);
  invalid.words[2].text = "different";
  delete invalid.contentHash;

  assert.throws(
    () => compileTimeline({ draftBundle: draft, narrationManifest: invalid }),
    (error) => error.code === "NARRATION_ALIGNMENT_FAILED",
  );
});

test("SVG scene renderer emits original pitch primitives and illustration disclosure", () => {
  const draft = bundle();
  const scene = draft.storyboard.scenes[2];
  const svg = renderSceneSvg(scene, {
    width: 1080,
    height: 1920,
    frame: 100,
    title: "Football explained",
    text: "Attack the half-space",
  });

  assert.match(svg, /^<svg/);
  assert.match(svg, /ILLUSTRATIVE TACTICAL DIAGRAM/);
  assert.match(svg, /marker-end="url\(#arrow\)"/);
  assert.match(svg, /#0f5132/);
  assert.deepEqual(planSceneKeyframes({ ...scene, startFrame: 0, endFrame: 300 }), [0, 60, 299]);
});

test("SVG renderer escapes operator text", () => {
  const draft = bundle();
  const svg = renderSceneSvg(draft.storyboard.scenes[0], {
    width: 720,
    height: 1280,
    text: "<script>alert('x')</script>",
  });
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
});
