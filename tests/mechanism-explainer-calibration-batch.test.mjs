import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

import {
  buildMechanismExplainerCalibrationAudio,
} from "../tools/lib/mechanism-explainer-calibration-audio.mjs";
import {
  MECHANISM_CALIBRATION_HEIGHT,
  MECHANISM_CALIBRATION_SAMPLE_RATE,
  MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
  MECHANISM_CALIBRATION_STORY_IDS,
  MECHANISM_CALIBRATION_WIDTH,
  assertMechanismCalibrationMediaProbe,
  buildTimedMechanismCalibrationStory,
  createMechanismCalibrationAss,
  createMechanismCalibrationCaptionManifest,
  createMechanismCalibrationTimingFixture,
  createMechanismCalibrationVtt,
  hashMechanismCalibrationPngPixels,
  loadMechanismCalibrationStory,
  mechanismCalibrationContactFrames,
  mechanismCalibrationSampleFrames,
  parseMechanismCalibrationArguments,
  renderMechanismExplainerCalibration,
} from "../tools/render-mechanism-explainer-calibration.mjs";
import {
  MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS,
  MECHANISM_EXPLAINER_V1_GEOMETRY,
  MECHANISM_EXPLAINER_V1_HELPER_RECIPES,
  MECHANISM_EXPLAINER_V1_MIN_HOLD_FRAMES,
  MECHANISM_EXPLAINER_V1_MOTION_VOCABULARY,
  MECHANISM_EXPLAINER_V1_PROFILE,
  compileMechanismExplainerV1Html,
  mechanismExplainerV1FrameStateAt,
} from "../renderer/hyperframes/mechanism-explainer-v1.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const RENDERER_PATH = resolve(
  ROOT,
  "renderer/hyperframes/mechanism-explainer-v1.mjs",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(storyId) {
  const bundle = loadMechanismCalibrationStory(storyId);
  const audio = createMechanismCalibrationTimingFixture(bundle.storySpec);
  const story = buildTimedMechanismCalibrationStory(
    bundle.storySpec,
    audio,
  );
  return { ...bundle, audio, story };
}

function compileFixture(storyId) {
  const value = fixture(storyId);
  return {
    ...value,
    compilation: compileMechanismExplainerV1Html({
      storySpec: value.story,
    }),
  };
}

test("write gate and --story selection are exact", async () => {
  assert.throws(
    () => parseMechanismCalibrationArguments([]),
    /--confirm-write/u,
  );
  assert.throws(
    () => parseMechanismCalibrationArguments([
      "--confirm-write",
      "--story",
      "baychimo",
    ]),
    /gps, odometer, or all/u,
  );
  assert.throws(
    () => parseMechanismCalibrationArguments([
      "--confirm-write",
      "--confirm-write",
    ]),
    /Duplicate/u,
  );
  assert.deepEqual(
    parseMechanismCalibrationArguments([
      "--story",
      "gps",
      "--confirm-write",
    ]),
    {
      confirmWrite: true,
      story: "gps",
      storyIds: ["gps"],
    },
  );
  assert.deepEqual(
    parseMechanismCalibrationArguments(["--confirm-write"]).storyIds,
    ["gps", "odometer"],
  );
  await assert.rejects(
    renderMechanismExplainerCalibration({ confirmWrite: false }),
    /confirmWrite/u,
  );
});

test("both checked stories are data-only inputs to the same strict profile", () => {
  assert.deepEqual(MECHANISM_CALIBRATION_STORY_IDS, [
    "gps",
    "odometer",
  ]);
  for (const storyId of MECHANISM_CALIBRATION_STORY_IDS) {
    const bundle = loadMechanismCalibrationStory(storyId);
    assert.equal(bundle.storySpec.profile, MECHANISM_EXPLAINER_V1_PROFILE);
    assert.ok(bundle.storySpec.phrases.length > 1);
    assert.match(bundle.specFileHash, /^[a-f0-9]{64}$/u);
    assert.equal(
      JSON.stringify(bundle.storySpec).includes("http"),
      false,
    );
    assert.equal(
      JSON.stringify(bundle.storySpec).includes("<svg"),
      false,
    );
    for (const phrase of bundle.storySpec.phrases) {
      assert.ok(
        MECHANISM_EXPLAINER_V1_MOTION_VOCABULARY.includes(
          phrase.visual.action,
        ),
      );
      assert.ok(
        MECHANISM_EXPLAINER_V1_HELPER_RECIPES.includes(
          phrase.visual.helper.recipe,
        ),
      );
    }
  }
});

test("GPS and odometer compile deterministically through one geometry map", () => {
  const values = MECHANISM_CALIBRATION_STORY_IDS.map((storyId) => (
    compileFixture(storyId)
  ));
  for (const value of values) {
    const repeated = compileMechanismExplainerV1Html({
      storySpec: value.story,
    });
    assert.equal(value.compilation.html, repeated.html);
    assert.equal(
      value.compilation.compositionHash,
      repeated.compositionHash,
    );
    assert.equal(
      value.compilation.storySpecHash,
      repeated.storySpecHash,
    );
    assert.equal(
      sha256(value.compilation.html),
      value.compilation.compositionHash,
    );
    assert.equal(
      value.compilation.profileId,
      MECHANISM_EXPLAINER_V1_PROFILE,
    );
    assert.equal(value.compilation.width, 1080);
    assert.equal(value.compilation.height, 1920);
    assert.equal(value.compilation.fps, 30);
    assert.equal(value.compilation.featureGated, true);
    assert.equal(value.compilation.publishable, false);
  }
  assert.deepEqual(
    values[0].compilation.geometry,
    values[1].compilation.geometry,
  );
  assert.deepEqual(
    values[0].compilation.geometry,
    MECHANISM_EXPLAINER_V1_GEOMETRY,
  );
  assert.equal(
    values[0].compilation.primaryTransform,
    values[1].compilation.primaryTransform,
  );
  assert.notEqual(
    values[0].compilation.storySpecHash,
    values[1].compilation.storySpecHash,
  );
});

test("renderer source has no GPS or odometer layout branch", () => {
  const source = readFileSync(RENDERER_PATH, "utf8");
  assert.doesNotMatch(
    source,
    /gps_week_counter_mechanism_v1|odometer_rollover_mechanism_v1/u,
  );
  assert.doesNotMatch(
    source,
    /(?:if|switch)\s*\([^)]*(?:story|storySpec)\.id/iu,
  );
  assert.match(source, /MECHANISM_EXPLAINER_V1_GEOMETRY/u);
  assert.match(source, /data-engine-anchor="primaryDevice"/u);
});

test("every frame keeps one fixed primary and at most one helper", () => {
  for (const storyId of MECHANISM_CALIBRATION_STORY_IDS) {
    const { story } = fixture(storyId);
    const holdRuns = new Map(
      story.phrases.map((phrase) => [phrase.id, { current: 0, max: 0 }]),
    );
    for (let frame = 0; frame < story.durationFrames; frame += 1) {
      const state = mechanismExplainerV1FrameStateAt(story, frame);
      assert.equal(state.frame, frame);
      assert.equal(state.primaryObjectCount, 1);
      assert.equal(
        state.primary.transform,
        MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.primaryDevice,
      );
      assert.ok(state.activeHelperCount >= 0);
      assert.ok(state.activeHelperCount <= 1);
      assert.equal(state.captionLaneClear, true);
      assert.equal(state.progressBarPresent, false);
      assert.equal(state.cameraTransform, null);
      const run = holdRuns.get(state.phraseId);
      if (state.comprehensionHold) {
        run.current += 1;
        run.max = Math.max(run.max, run.current);
      } else {
        run.current = 0;
      }
    }
    for (const phrase of story.phrases) {
      assert.ok(
        holdRuns.get(phrase.id).max
          >= MECHANISM_EXPLAINER_V1_MIN_HOLD_FRAMES,
        `${storyId}:${phrase.id} lacks a ${MECHANISM_EXPLAINER_V1_MIN_HOLD_FRAMES}-frame hold`,
      );
    }
  }
});

test("timing fixtures and captions bind the exact frame/audio clock", () => {
  for (const storyId of MECHANISM_CALIBRATION_STORY_IDS) {
    const { storySpec, story, audio } = fixture(storyId);
    assert.equal(
      audio.durationSamples,
      audio.durationFrames * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
    );
    assert.equal(audio.sampleRate, MECHANISM_CALIBRATION_SAMPLE_RATE);
    assert.equal(audio.frameClock.finalHold.frameCount, 30);
    assert.equal(story.durationFrames, audio.durationFrames);
    assert.equal(story.phrases[0].startFrame, 0);
    assert.equal(
      story.phrases.at(-1).endFrame,
      story.durationFrames,
    );
    story.phrases.forEach((phrase, index) => {
      assert.equal(
        phrase.startFrame,
        index === 0 ? 0 : story.phrases[index - 1].endFrame,
      );
      assert.ok(phrase.triggerFrame >= phrase.startFrame);
      assert.ok(phrase.triggerFrame < phrase.endFrame);
    });

    const captions = createMechanismCalibrationCaptionManifest(
      storySpec,
      audio,
    );
    assert.equal(captions.cues.length, storySpec.phrases.length);
    assert.deepEqual(
      captions.cues.map((cue) => cue.phraseId),
      storySpec.phrases.map((phrase) => phrase.id),
    );
    const captionWords = captions.cues.flatMap((cue) => cue.words);
    assert.equal(captionWords.length, audio.words.length);
    assert.deepEqual(
      captionWords.map((word) => word.text),
      audio.words.map((word) => word.text),
    );
    captions.cues.forEach((cue, index) => {
      assert.ok(cue.endFrame > cue.startFrame);
      assert.ok(cue.lines.length <= 2);
      assert.ok(cue.lines.every((line) => line.length <= 28));
      if (index > 0) {
        assert.ok(cue.startFrame >= captions.cues[index - 1].endFrame);
      }
    });
    const vtt = createMechanismCalibrationVtt(captions);
    assert.match(vtt, /^WEBVTT\n\n/u);
    assert.equal(
      [...vtt.matchAll(/ --> /gu)].length,
      captions.cues.length,
    );
    const ass = createMechanismCalibrationAss(captions);
    assert.equal(ass.themeId, "human_readable_purple_v1");
    assert.equal(ass.timingMode, "frame_boundary_floor_v1");
    assert.match(ass.buffer.toString("utf8"), /&H00FA8BA7/u);
    assert.equal(
      [...ass.buffer.toString("utf8").matchAll(/^Dialogue:/gmu)].length,
      captions.cues.length,
    );
  }
});

test("actual audio-helper output satisfies the timed renderer contract", async () => {
  const directory = mkdtempSync(join(
    tmpdir(),
    "mechanism-calibration-batch-test-",
  ));
  try {
    for (const storyId of MECHANISM_CALIBRATION_STORY_IDS) {
      const bundle = loadMechanismCalibrationStory(storyId);
      const audio = await buildMechanismExplainerCalibrationAudio(
        {
          id: bundle.storySpec.id,
          phrases: bundle.storySpec.phrases,
        },
        {
          outputPath: resolve(directory, `${storyId}.wav`),
        },
        {
          renderPhrasePcm: async () => Buffer.alloc(48_000 * 2),
        },
      );
      const story = buildTimedMechanismCalibrationStory(
        bundle.storySpec,
        audio,
      );
      const compilation = compileMechanismExplainerV1Html({
        storySpec: story,
      });
      assert.equal(compilation.durationFrames, audio.durationFrames);
      assert.equal(
        audio.durationSamples,
        audio.durationFrames * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
      );
      assert.equal(audio.publishable, false);
      assert.equal(audio.commercialUseAttested, false);
      assert.equal(
        audio.provenance.provider,
        "dependency_injected_pcm",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sample and media contracts enforce native technical output", () => {
  for (const storyId of MECHANISM_CALIBRATION_STORY_IDS) {
    const { story } = fixture(storyId);
    const contacts = mechanismCalibrationContactFrames(
      story.durationFrames,
    );
    const samples = mechanismCalibrationSampleFrames(story);
    assert.equal(contacts.length, 8);
    assert.equal(contacts[0], 0);
    assert.equal(contacts.at(-1), story.durationFrames - 1);
    assert.ok(contacts.every((frame) => samples.includes(frame)));
    assert.ok(story.phrases.every((phrase) => (
      samples.includes(phrase.startFrame)
      && samples.includes(phrase.triggerFrame)
    )));
  }

  const frames = 900;
  const gates = assertMechanismCalibrationMediaProbe({
    width: MECHANISM_CALIBRATION_WIDTH,
    height: MECHANISM_CALIBRATION_HEIGHT,
    fps: 30,
    frameCount: frames,
    durationSeconds: frames / 30,
    videoStreamCount: 1,
    videoCodec: "h264",
    pixelFormat: "yuv420p",
    audioStreamCount: 1,
    audioCodec: "aac",
    audioSampleRate: 48_000,
  }, frames);
  assert.equal(Object.values(gates).every(Boolean), true);
  assert.throws(
    () => assertMechanismCalibrationMediaProbe({
      width: 720,
      height: 1280,
      fps: 30,
      frameCount: frames,
      durationSeconds: frames / 30,
      videoStreamCount: 1,
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      audioStreamCount: 1,
      audioCodec: "aac",
      audioSampleRate: 48_000,
    }, frames),
    /media QA failed/u,
  );
});

async function sampledBrowserProof(compilation, story) {
  const browser = await chromium.launch({ headless: true });
  const frames = [
    0,
    story.phrases[0].triggerFrame,
    story.phrases[Math.floor(story.phrases.length / 2)].triggerFrame,
    story.phrases.at(-1).triggerFrame,
    story.durationFrames - 1,
  ];
  const requested = new Set();
  const runContext = async (order) => {
    const context = await browser.newContext({
      viewport: {
        width: MECHANISM_CALIBRATION_WIDTH,
        height: MECHANISM_CALIBRATION_HEIGHT,
      },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on("request", (request) => requested.add(request.url()));
    await page.setContent(compilation.html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const values = {};
    for (const frame of order) {
      await page.evaluate(({ frame: next, fps, profile }) => {
        window.__timelines[profile].seek(next / fps);
      }, {
        frame,
        fps: 30,
        profile: MECHANISM_EXPLAINER_V1_PROFILE,
      });
      await page.evaluate(() => new Promise((done) => (
        requestAnimationFrame(() => requestAnimationFrame(done))
      )));
      const state = await page.evaluate(() => ({
        frame: window.__mechanismExplainerV1Frame,
        state: window.__mechanismExplainerV1State,
        primaryTransform: document
          .querySelector("[data-mechanism-primary=true]")
          .getAttribute("transform"),
      }));
      const image = await page.screenshot({
        type: "png",
        animations: "disabled",
      });
      values[frame] = {
        hash: hashMechanismCalibrationPngPixels(image),
        state,
      };
    }
    await context.close();
    return values;
  };
  try {
    const first = await runContext(frames);
    const second = await runContext([...frames].reverse());
    return { frames, first, second, requested: [...requested] };
  } finally {
    await browser.close();
  }
}

test("sampled browser frames are random-access deterministic", async (t) => {
  let available = true;
  let probe;
  try {
    probe = await chromium.launch({ headless: true });
    await probe.close();
  } catch {
    available = false;
  }
  if (!available) {
    t.skip("Playwright Chromium is unavailable in this environment");
    return;
  }
  for (const storyId of MECHANISM_CALIBRATION_STORY_IDS) {
    const { story, compilation } = compileFixture(storyId);
    const proof = await sampledBrowserProof(compilation, story);
    for (const frame of proof.frames) {
      assert.equal(
        proof.first[frame].hash,
        proof.second[frame].hash,
        `${storyId} frame ${frame} pixel hash must be random-access deterministic`,
      );
      assert.deepEqual(
        proof.first[frame].state,
        proof.second[frame].state,
      );
      assert.equal(proof.first[frame].state.frame, frame);
      assert.equal(
        proof.first[frame].state.state.primary.transform,
        MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.primaryDevice,
      );
      assert.ok(
        proof.first[frame].state.state.activeHelperCount <= 1,
      );
    }
    assert.deepEqual(proof.requested, []);
  }
});
