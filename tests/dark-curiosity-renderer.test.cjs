const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { createPreviewTimingManifest } = require("../server/pipelines/narrated-short/preview-timing.cjs");
const { compileTimeline, timelineTrack } = require("../server/pipelines/narrated-short/timeline-compiler.cjs");
const { resolveSceneRenderer, RENDERER_VERSION } = require("../server/pipelines/narrated-short/scene-renderer-registry.cjs");

const DARK_FIXTURE = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json");
const FOOTBALL_FIXTURE = resolve(__dirname, "..", "eval", "narrated", "fixtures", "001_overload_explainer.json");

function loadDraft(path) {
  return normalizeDraftBundle(JSON.parse(readFileSync(path, "utf8")));
}

test("scene renderer registry dispatches by vertical, template and exact version", () => {
  const dark = resolveSceneRenderer({
    verticalId: "dark_curiosity",
    formatId: "documented_mystery_v1",
    template: "hook_scene",
    templateVersion: "1.0.0",
  });
  const football = resolveSceneRenderer({
    verticalId: "football_explainer",
    formatId: "tactical_cause_effect_v1",
    template: "hook_text",
    templateVersion: "1.0.0",
  });

  assert.equal(dark.verticalId, "dark_curiosity");
  assert.equal(football.verticalId, "football_explainer");
  assert.equal(dark.rendererVersion, RENDERER_VERSION);
  assert.notEqual(dark.render, football.render);
  assert.throws(
    () => resolveSceneRenderer({ verticalId: "dark_curiosity", formatId: "documented_mystery_v1", template: "hook_text" }),
    (error) => error.code === "SCENE_TEMPLATE_MISMATCH",
  );
  assert.throws(
    () => resolveSceneRenderer({ verticalId: "dark_curiosity", formatId: "documented_mystery_v1", template: "hook_scene", templateVersion: "1.1.0" }),
    (error) => error.code === "TEMPLATE_VERSION_UNSUPPORTED",
  );
});

test("five Dark Curiosity scene families emit distinct deterministic original SVG", () => {
  const draft = loadDraft(DARK_FIXTURE);
  const expectedFamilies = ["hook", "evidence", "system-scale", "map-timeline", "payoff"];
  const svgs = draft.storyboard.scenes.map((scene) => {
    const renderer = resolveSceneRenderer({
      verticalId: draft.verticalId,
      formatId: draft.brief.formatId,
      template: scene.template,
      templateVersion: "1.0.0",
    });
    const options = { width: 720, height: 1280, frame: 60, text: "Approved <evidence> & context", draftBundle: draft };
    const first = renderer.render(scene, options);
    const second = renderer.render(scene, options);
    assert.equal(first, second);
    assert.match(first, /^<svg/);
    assert.match(first, /data-vertical="dark_curiosity"/);
    assert.doesNotMatch(first, /(?:href|src)=["']https?:\/\//);
    return first;
  });

  expectedFamilies.forEach((family, index) => assert.match(svgs[index], new RegExp(`data-family="${family}"`)));
  assert.equal(new Set(svgs).size, 5);
  assert.match(svgs[1], /data-op="show_evidence"/);
  assert.match(svgs[1], /data-op="show_source_badge"/);
  assert.match(svgs[2], /data-op="connect_nodes"/);
  assert.match(svgs[3], /data-op="advance_timeline"/);
  assert.match(svgs[4], /data-op="show_uncertainty"/);
  assert.match(svgs[2], /ILLUSTRATIVE SIGNAL-STRENGTH RECONSTRUCTION/);
});

test("Dark renderer escapes operator-controlled text", () => {
  const draft = loadDraft(DARK_FIXTURE);
  const scene = structuredClone(draft.storyboard.scenes[0]);
  scene.operations[0].text = "<script>alert('x') & escape</script>";
  const renderer = resolveSceneRenderer({ verticalId: draft.verticalId, formatId: draft.brief.formatId, template: scene.template });
  const svg = renderer.render(scene, { width: 720, height: 1280, frame: 60, draftBundle: draft });
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&amp;/);
  assert.match(svg, /escape&lt;\/script&gt;/);
});

test("TimelineIR selects its visual track and version metadata from the vertical registry", () => {
  const dark = loadDraft(DARK_FIXTURE);
  const darkTimeline = compileTimeline({
    draftBundle: dark,
    narrationManifest: createPreviewTimingManifest(dark),
    width: 720,
    height: 1280,
  });
  assert.equal(darkTimeline.verticalId, "dark_curiosity");
  assert.equal(darkTimeline.rendererVersion, RENDERER_VERSION);
  assert.equal(timelineTrack(darkTimeline, "football_visual"), null);
  assert.equal(timelineTrack(darkTimeline, "visual_scene").clips.length, dark.storyboard.scenes.length);
  assert.deepEqual(new Set(Object.values(darkTimeline.templateVersions)), new Set(["1.0.0"]));

  const football = loadDraft(FOOTBALL_FIXTURE);
  const footballTimeline = compileTimeline({
    draftBundle: football,
    narrationManifest: createPreviewTimingManifest(football),
    width: 720,
    height: 1280,
  });
  assert.equal(timelineTrack(footballTimeline, "visual_scene"), null);
  assert.equal(timelineTrack(footballTimeline, "football_visual").clips.length, football.storyboard.scenes.length);
});
