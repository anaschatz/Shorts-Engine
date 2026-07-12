const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "narrated-renderer-"));
process.env.MATCHCUTS_DATA_DIR = TEST_DATA_DIR;

const { CONFIG, ensureDataDirs } = require("../server/config.cjs");
ensureDataDirs();
const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { normalizeNarrationManifest } = require("../server/pipelines/narrated-short/narration-contract.cjs");
const { compileTimeline } = require("../server/pipelines/narrated-short/timeline-compiler.cjs");
const { renderNarratedKeyframes } = require("../server/adapters/narrated-renderer-adapter.cjs");
const { composeNarratedPreview } = require("../server/pipelines/narrated-short/video-compositor.cjs");
const { ffprobeJson } = require("../server/media.cjs");

test.after(() => rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

function buildFixture(fixturePath = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json")) {
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(fixturePath, "utf8")));
  let cursor = 0;
  const words = draft.script.beats.flatMap((beat) => beat.spokenText.split(/\s+/).filter(Boolean).map((text) => {
    const word = { text, startFrame: cursor, endFrame: cursor + 4 };
    cursor += 5;
    return word;
  }));
  const narration = normalizeNarrationManifest({
    providerMode: "uploaded",
    voiceProfileId: "voice_en_01",
    audioArtifactId: "art_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    audioHash: "d".repeat(64),
    sampleRate: 48000,
    durationFrames: cursor + 5,
    words,
    rights: { commercialUseAllowed: true, consentReference: "operator_recording_v1" },
  });
  return { draft, timeline: compileTimeline({ draftBundle: draft, narrationManifest: narration, width: 720, height: 1280 }) };
}

test("Dark Curiosity Chromium renderer creates PNG keyframes and a probed 720x1280 H.264 preview", async (t) => {
  if (process.env.RUN_NARRATED_BROWSER_TEST !== "1") {
    t.skip("Set RUN_NARRATED_BROWSER_TEST=1 to run the browser integration test");
    return;
  }
  const chromeBin = process.env.NARRATED_CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chromeBin)) {
    t.skip("A Chromium-based browser is not installed");
    return;
  }
  const { draft, timeline } = buildFixture();
  const timelinePath = join(CONFIG.artifactDir, "renderer-timeline.json");
  const draftPath = join(CONFIG.artifactDir, "renderer-draft.json");
  const outputDir = join(CONFIG.tmpDir, "narrated-keyframes");
  mkdirSync(CONFIG.artifactDir, { recursive: true });
  writeFileSync(timelinePath, JSON.stringify(timeline));
  writeFileSync(draftPath, JSON.stringify(draft));

  const manifest = await renderNarratedKeyframes({ timelinePath, draftPath, outputDir });
  assert.equal(manifest.width, 720);
  assert.equal(manifest.height, 1280);
  assert.equal(manifest.verticalId, "dark_curiosity");
  assert.equal(manifest.rendererVersion, timeline.rendererVersion);
  assert.ok(manifest.frames.length >= draft.storyboard.scenes.length);
  const png = readFileSync(manifest.frames[0].outputPath);
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 720);
  assert.equal(png.readUInt32BE(20), 1280);
  const outputPath = join(CONFIG.renderDir, "dark-curiosity-browser-integration.mp4");
  await composeNarratedPreview({ timeline, keyframeManifest: manifest, outputPath, renderProfile: "preview" });
  const probe = await ffprobeJson(outputPath);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  assert.equal(Number(video.width), 720);
  assert.equal(Number(video.height), 1280);
  assert.equal(video.codec_name, "h264");
});
