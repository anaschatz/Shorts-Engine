import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import {
  MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS,
  MECHANISM_EXPLAINER_V1_FPS,
  MECHANISM_EXPLAINER_V1_GEOMETRY,
  MECHANISM_EXPLAINER_V1_HELPER_FADE_FRAMES,
  MECHANISM_EXPLAINER_V1_HELPER_RECIPES,
  MECHANISM_EXPLAINER_V1_MAX_DIGITS,
  MECHANISM_EXPLAINER_V1_MIN_DIGITS,
  MECHANISM_EXPLAINER_V1_MIN_HOLD_FRAMES,
  MECHANISM_EXPLAINER_V1_MOTION_RECIPES,
  MECHANISM_EXPLAINER_V1_MOTION_VOCABULARY,
  MECHANISM_EXPLAINER_V1_PROFILE,
  MECHANISM_EXPLAINER_V1_PROFILE_SPEC,
  MECHANISM_EXPLAINER_V1_TRANSITION_FRAMES,
  MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR,
  compileMechanismExplainerV1Html,
  mechanismExplainerV1FrameStateAt,
  validateMechanismExplainerStorySpec,
  validateMechanismExplainerV1StoryData,
  validateMechanismExplainerV1StorySpec,
} from "../renderer/hyperframes/mechanism-explainer-v1.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const RENDERER_PATH = resolve(
  ROOT,
  "renderer/hyperframes/mechanism-explainer-v1.mjs",
);
const GPS_PATH = resolve(
  ROOT,
  "eval/narrated/dark-curiosity/calibration/gps-week-counter-mechanism-v1.json",
);
const ODOMETER_PATH = resolve(
  ROOT,
  "eval/narrated/dark-curiosity/calibration/odometer-rollover-mechanism-v1.json",
);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function timingEnriched(rawStory, phraseFrames = 60) {
  const value = structuredClone(rawStory);
  value.durationFrames = value.phrases.length * phraseFrames;
  value.phrases.forEach((phrase, index) => {
    phrase.startFrame = index * phraseFrames;
    phrase.endFrame = phrase.startFrame + phraseFrames;
    phrase.triggerFrame = phrase.startFrame + 8;
  });
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rectanglesIntersect(left, right) {
  return (
    left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
  );
}

const RAW_GPS = json(GPS_PATH);
const RAW_ODOMETER = json(ODOMETER_PATH);
const GPS = timingEnriched(RAW_GPS);
const ODOMETER = timingEnriched(RAW_ODOMETER);

test("profile owns one fixed device, annotation, helper rail, and caption-safe geometry", () => {
  assert.equal(MECHANISM_EXPLAINER_V1_PROFILE, "mechanism-explainer-v1");
  assert.equal(MECHANISM_EXPLAINER_V1_FPS, 30);
  assert.deepEqual(MECHANISM_EXPLAINER_V1_PROFILE_SPEC, {
    id: "mechanism-explainer-v1",
    schemaVersion: 1,
    provider: "hyperframes_local",
    runtimeVersion: "1.0.0",
    styleVersion: "1.0.0",
    width: 1080,
    height: 1920,
    fps: 30,
    featureGated: true,
    publishable: false,
    primaryAnchor: "primaryDevice",
    maximumPrimaryObjects: 1,
    maximumHelpers: 1,
  });
  assert.deepEqual(MECHANISM_EXPLAINER_V1_MOTION_VOCABULARY, [
    "enter",
    "hold",
    "update",
    "rollover",
    "resolve",
    "exit",
  ]);
  assert.deepEqual(MECHANISM_EXPLAINER_V1_HELPER_RECIPES, [
    "range",
    "interpretation",
    "carry",
    "patch",
    "time_continues",
  ]);
  assert.equal(MECHANISM_EXPLAINER_V1_TRANSITION_FRAMES, 8);
  assert.equal(MECHANISM_EXPLAINER_V1_HELPER_FADE_FRAMES, 6);
  assert.equal(MECHANISM_EXPLAINER_V1_MIN_HOLD_FRAMES, 12);
  assert.equal(MECHANISM_EXPLAINER_V1_MIN_DIGITS, 2);
  assert.equal(MECHANISM_EXPLAINER_V1_MAX_DIGITS, 8);

  const {
    title,
    primaryDevice,
    counter,
    annotation,
    helperRail,
    captionLane,
  } = MECHANISM_EXPLAINER_V1_GEOMETRY;
  assert.equal(title.cx, 540);
  assert.equal(primaryDevice.cx, 540);
  assert.equal(counter.cx, 540);
  assert.equal(annotation.cx, 540);
  assert.equal(helperRail.cx, 540);
  assert.equal(captionLane.cx, 540);
  assert.equal(
    rectanglesIntersect(primaryDevice, helperRail),
    false,
  );
  assert.equal(rectanglesIntersect(helperRail, captionLane), false);
  assert.deepEqual(MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS, {
    primaryDevice: "translate(540 580)",
    counter: "translate(540 560)",
    annotation: "translate(540 899)",
    helperRail: "translate(540 1095)",
  });
});

test("checked GPS and odometer inputs are data-only and validate through one contract", () => {
  const gps = validateMechanismExplainerV1StoryData(RAW_GPS);
  const odometer = validateMechanismExplainerV1StoryData(RAW_ODOMETER);
  assert.equal(gps.device.digitCount, 4);
  assert.equal(odometer.device.digitCount, 6);
  assert.equal(gps.profile, MECHANISM_EXPLAINER_V1_PROFILE);
  assert.equal(odometer.profile, MECHANISM_EXPLAINER_V1_PROFILE);
  assert.ok(Object.isFrozen(gps));
  assert.ok(Object.isFrozen(gps.phrases[0].visual.helper));
  assert.doesNotThrow(() => validateMechanismExplainerV1StorySpec(GPS));
  assert.doesNotThrow(() => validateMechanismExplainerStorySpec(ODOMETER));
});

test("the strict validator rejects geometry, executable data, unknown recipes, unsafe text, and bad clocks", () => {
  const geometry = structuredClone(RAW_GPS);
  geometry.x = 120;
  assert.throws(
    () => validateMechanismExplainerV1StoryData(geometry),
    /story-owned geometry or executable key "x"/u,
  );

  const anchor = structuredClone(RAW_GPS);
  anchor.device.anchor = "somewhere_else";
  assert.throws(
    () => validateMechanismExplainerV1StoryData(anchor),
    /story-owned geometry or executable key "anchor"/u,
  );

  const executable = structuredClone(RAW_GPS);
  executable.phrases[0].visual.html = "<svg></svg>";
  assert.throws(
    () => validateMechanismExplainerV1StoryData(executable),
    /story-owned geometry or executable key "html"/u,
  );

  const remote = structuredClone(RAW_GPS);
  remote.phrases[0].text = "Load https://example.com/asset.svg";
  assert.throws(
    () => validateMechanismExplainerV1StoryData(remote),
    /remote or executable content/u,
  );

  const helper = structuredClone(RAW_GPS);
  helper.phrases[0].visual.helper.recipe = "diagram";
  assert.throws(
    () => validateMechanismExplainerV1StoryData(helper),
    /range, interpretation, carry, patch, time_continues/u,
  );

  const twoHelpers = structuredClone(RAW_GPS);
  twoHelpers.phrases[0].visual.helper = [
    RAW_GPS.phrases[0].visual.helper,
    RAW_GPS.phrases[0].visual.helper,
  ];
  assert.throws(
    () => validateMechanismExplainerV1StoryData(twoHelpers),
    /must be a plain object/u,
  );

  const motion = structuredClone(RAW_GPS);
  motion.phrases[0].visual.action = "zoom";
  assert.throws(
    () => validateMechanismExplainerV1StoryData(motion),
    /enter, hold, update, rollover, resolve, exit/u,
  );

  const tooManyDigits = structuredClone(RAW_ODOMETER);
  tooManyDigits.device.digitCount = 9;
  assert.throws(
    () => validateMechanismExplainerV1StoryData(tooManyDigits),
    /2 through 8/u,
  );

  const wrongDisplayWidth = structuredClone(RAW_GPS);
  wrongDisplayWidth.phrases[0].visual.displayTo = "000000";
  assert.throws(
    () => validateMechanismExplainerV1StoryData(wrongDisplayWidth),
    /exactly 4 digits/u,
  );

  const missingToken = structuredClone(RAW_GPS);
  missingToken.phrases[1].visual.triggerToken = "satellite";
  assert.throws(
    () => validateMechanismExplainerV1StoryData(missingToken),
    /must occur in the narration phrase/u,
  );

  const gap = structuredClone(GPS);
  gap.phrases[2].startFrame += 1;
  assert.throws(
    () => validateMechanismExplainerV1StorySpec(gap),
    /contiguous, ordered/u,
  );

  const overlap = structuredClone(GPS);
  overlap.phrases[2].startFrame -= 1;
  assert.throws(
    () => validateMechanismExplainerV1StorySpec(overlap),
    /contiguous, ordered/u,
  );

  const incomplete = structuredClone(GPS);
  incomplete.durationFrames += 1;
  assert.throws(
    () => validateMechanismExplainerV1StorySpec(incomplete),
    /cover the complete frame clock/u,
  );

  const noHold = structuredClone(GPS);
  noHold.phrases[0].triggerFrame =
    noHold.phrases[0].endFrame - 2;
  assert.throws(
    () => validateMechanismExplainerV1StorySpec(noHold),
    /bounded motion and comprehension hold/u,
  );
});

test("GPS and odometer compile with one compiler and identical engine-owned layout", () => {
  const gpsFirst = compileMechanismExplainerV1Html(GPS);
  const gpsSecond = compileMechanismExplainerV1Html({
    storySpec: structuredClone(GPS),
  });
  const odometer = compileMechanismExplainerV1Html(ODOMETER);

  assert.equal(gpsSecond.html, gpsFirst.html);
  assert.equal(gpsSecond.compositionHash, gpsFirst.compositionHash);
  assert.match(gpsFirst.compositionHash, HASH_PATTERN);
  assert.match(gpsFirst.storySpecHash, HASH_PATTERN);
  assert.match(odometer.compositionHash, HASH_PATTERN);
  assert.notEqual(odometer.compositionHash, gpsFirst.compositionHash);
  assert.equal(gpsFirst.profileId, MECHANISM_EXPLAINER_V1_PROFILE);
  assert.equal(odometer.profileId, MECHANISM_EXPLAINER_V1_PROFILE);
  assert.deepEqual(gpsFirst.profile, odometer.profile);
  assert.deepEqual(gpsFirst.geometry, odometer.geometry);
  assert.equal(gpsFirst.primaryTransform, odometer.primaryTransform);
  assert.equal(gpsFirst.width, 1080);
  assert.equal(gpsFirst.height, 1920);
  assert.equal(gpsFirst.fps, 30);
  assert.equal(gpsFirst.featureGated, true);
  assert.equal(gpsFirst.publishable, false);
  assert.equal(
    (gpsFirst.html.match(/data-digit-cell="/gu) || []).length,
    4,
  );
  assert.equal(
    (odometer.html.match(/data-digit-cell="/gu) || []).length,
    6,
  );
  for (const value of [gpsFirst, odometer]) {
    assert.match(value.html, /viewBox="0 0 1080 1920"/u);
    assert.match(
      value.html,
      /data-mechanism-primary="true"[^>]+transform="translate\(540 580\)"/u,
    );
    assert.match(
      value.html,
      /data-mechanism-helper="true"[^>]+transform="translate\(540 1095\)"/u,
    );
    assert.match(value.html, /data-caption-exclusion-region="true"/u);
    assert.match(value.html, /data-feature-gated="true"/u);
    assert.match(value.html, /data-publishable="false"/u);
    assert.doesNotMatch(
      value.html,
      /\b(?:https?|ftp):\/\/|Math\.random|Date\.now|performance\.now/iu,
    );
    assert.doesNotMatch(
      value.html,
      /(?:id|class|data-[a-z-]+)=["'][^"']*(?:progress[-_ ]?bar|camera[-_ ]?move)[^"']*["']/iu,
    );
  }
});

test("canonical validation makes compilation independent of input key order", () => {
  const reversed = Object.fromEntries(
    Object.entries(structuredClone(GPS)).reverse(),
  );
  reversed.device = Object.fromEntries(
    Object.entries(reversed.device).reverse(),
  );
  reversed.phrases = reversed.phrases.map((phrase) => ({
    ...Object.fromEntries(Object.entries(phrase).reverse()),
    visual: Object.fromEntries(Object.entries(phrase.visual).reverse()),
  }));
  const normal = compileMechanismExplainerV1Html(GPS);
  const reordered = compileMechanismExplainerV1Html(reversed);
  assert.equal(reordered.storySpecHash, normal.storySpecHash);
  assert.equal(reordered.compositionHash, normal.compositionHash);
  assert.equal(reordered.html, normal.html);
});

test("every frame keeps the primary transform constant and shows at most one bounded helper", () => {
  for (const story of [GPS, ODOMETER]) {
    const heldPhraseIds = new Set();
    let priorPrimaryTransform = null;
    for (let frame = 0; frame < story.durationFrames; frame += 1) {
      const state = mechanismExplainerV1FrameStateAt(story, frame);
      assert.equal(state.primaryObjectCount, 1, `frame ${frame}`);
      assert.equal(state.primary.opacity, 1, `frame ${frame}`);
      assert.equal(state.primary.anchor, "primaryDevice");
      assert.equal(
        state.primary.transform,
        MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.primaryDevice,
      );
      if (priorPrimaryTransform !== null) {
        assert.equal(state.primary.transform, priorPrimaryTransform);
      }
      priorPrimaryTransform = state.primary.transform;
      assert.ok(
        state.activeHelperCount === 0
          || state.activeHelperCount === 1,
        `frame ${frame}`,
      );
      if (state.helper) {
        assert.ok(
          MECHANISM_EXPLAINER_V1_HELPER_RECIPES.includes(
            state.helper.recipe,
          ),
        );
        assert.equal(state.helper.anchor, "helperRail");
        assert.equal(
          state.helper.transform,
          MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.helperRail,
        );
        assert.ok(state.helper.opacity >= 0 && state.helper.opacity <= 1);
      }
      assert.ok(
        MECHANISM_EXPLAINER_V1_MOTION_VOCABULARY.includes(
          state.action,
        ),
      );
      const maxOffset =
        MECHANISM_EXPLAINER_V1_MOTION_RECIPES[
          state.action
        ].maxOffsetY;
      assert.ok(Math.abs(state.counter.fromOffsetY) <= maxOffset);
      assert.ok(Math.abs(state.counter.toOffsetY) <= maxOffset);
      assert.ok(
        state.counter.fromOpacity + state.counter.toOpacity <= 1 + 1e-9,
        `frame ${frame} must not ghost overlapping counter states`,
      );
      assert.ok(
        state.counter.fromOpacity + state.counter.toOpacity
          >= MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR,
        `frame ${frame} must not blank the counter during replacement`,
      );
      if (
        state.counter.displayFrom === state.counter.displayTo
        || state.action === "rollover"
      ) {
        assert.equal(
          Number(
            (
              state.counter.fromOpacity
              + state.counter.toOpacity
            ).toFixed(9),
          ),
          1,
        );
      }
      assert.equal(state.captionLaneClear, true);
      assert.equal(state.progressBarPresent, false);
      assert.equal(state.cameraTransform, null);
      if (state.comprehensionHold) heldPhraseIds.add(state.phraseId);
    }
    assert.deepEqual(
      [...heldPhraseIds],
      story.phrases.map(({ id }) => id),
    );
    for (const phrase of story.phrases) {
      const motionFrames =
        MECHANISM_EXPLAINER_V1_MOTION_RECIPES[
          phrase.visual.action
        ].durationFrames;
      const holdStart = phrase.triggerFrame + motionFrames;
      const holdEnd = phrase.endFrame
        - (
          phrase.visual.helper
            ? MECHANISM_EXPLAINER_V1_HELPER_FADE_FRAMES
            : 0
        );
      assert.ok(
        holdEnd - holdStart >= MECHANISM_EXPLAINER_V1_MIN_HOLD_FRAMES,
        phrase.id,
      );
    }
  }
});

test("caption cues cover every narration phrase once without overlaps", () => {
  for (const story of [GPS, ODOMETER]) {
    const compiled = compileMechanismExplainerV1Html(story);
    assert.equal(compiled.captionCues.length, story.phrases.length);
    let cursor = 0;
    compiled.captionCues.forEach((cue, index) => {
      const phrase = story.phrases[index];
      assert.equal(cue.startFrame, cursor);
      assert.equal(cue.startFrame, phrase.startFrame);
      assert.equal(cue.endFrame, phrase.endFrame);
      assert.equal(cue.text, phrase.text);
      cursor = cue.endFrame;
    });
    assert.equal(cursor, story.durationFrames);
    assert.equal(
      compiled.narrationText,
      story.phrases.map(({ text }) => text).join(" "),
    );
  }
});

test("renderer source contains no story-id SVG or layout branch", () => {
  const source = readFileSync(RENDERER_PATH, "utf8");
  assert.doesNotMatch(
    source,
    /\b(?:if|switch)\s*\([^)]*(?:story|spec)(?:\?|\.)?\.?id\b/iu,
  );
  assert.doesNotMatch(
    source,
    /\b(?:gps|odometer)[-_ ](?:layout|geometry|svg|markup)\b/iu,
  );
  assert.doesNotMatch(
    source,
    /input\.(?:x|y|transform|svg|css|html|markup|anchor)\b/iu,
  );
});

test("sampled browser seeks are deterministic, offline, and match fixed runtime state", async (context) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (
      /MachPortRendezvousServer|bootstrap_check_in|Permission denied/iu
        .test(String(error?.message || error))
    ) {
      context.skip("Chromium launch is blocked by the workspace sandbox");
      return;
    }
    throw error;
  }
  try {
    const page = await browser.newPage({
      viewport: { width: 1080, height: 1920 },
    });
    const remoteRequests = [];
    page.on("request", (request) => {
      if (/^https?:/iu.test(request.url())) {
        remoteRequests.push(request.url());
      }
    });

    for (const story of [GPS, ODOMETER]) {
      const compiled = compileMechanismExplainerV1Html(story);
      await page.setContent(compiled.html, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const rollover = story.phrases.find(
        ({ visual }) => visual.action === "rollover",
      );
      const sampleFrames = [
        0,
        rollover.triggerFrame + 5,
        rollover.triggerFrame
          + MECHANISM_EXPLAINER_V1_MOTION_RECIPES.rollover.durationFrames,
        story.durationFrames - 1,
      ];
      const firstPass = [];
      for (const frame of sampleFrames) {
        const state = await page.evaluate(({ profileId, frameValue }) => {
          window.__timelines[profileId].seek(frameValue / 30);
          const primary = document.querySelector(
            "[data-mechanism-primary]",
          );
          const helpers = [...document.querySelectorAll(
            "[data-mechanism-helper]",
          )].filter((node) => Number(node.getAttribute("opacity")) > 1e-9);
          return {
            runtime: window.__mechanismExplainerV1State,
            renderedFrame: window.__mechanismExplainerV1Frame,
            primaryTransform: primary.getAttribute("transform"),
            visibleHelperElements: helpers.length,
          };
        }, {
          profileId: MECHANISM_EXPLAINER_V1_PROFILE,
          frameValue: frame,
        });
        await page.evaluate(() => new Promise((resolveFrame) => {
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
        }));
        const domHash = sha256(
          await page.locator("svg").evaluate((node) => node.outerHTML),
        );
        const stablePixels = (
          state.runtime.counter.motionProgress === 0
          || state.runtime.counter.motionProgress === 1
        );
        const imageHash = stablePixels
          ? sha256(await page.screenshot({
            type: "png",
            animations: "disabled",
          }))
          : null;
        firstPass.push({ frame, state, domHash, imageHash });
        assert.equal(state.renderedFrame, frame);
        assert.equal(
          state.primaryTransform,
          MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.primaryDevice,
        );
        assert.equal(state.runtime.primaryObjectCount, 1);
        assert.equal(state.runtime.primary.opacity, 1);
        assert.equal(state.runtime.primary.transform, state.primaryTransform);
        assert.ok(state.runtime.activeHelperCount <= 1);
        assert.ok(state.visibleHelperElements <= 1);
      }

      await page.setContent(compiled.html, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const secondPass = [];
      for (const frame of sampleFrames) {
        const state = await page.evaluate(({ profileId, frameValue }) => {
          window.__timelines[profileId].seek(frameValue / 30);
          return {
            runtime: window.__mechanismExplainerV1State,
            renderedFrame: window.__mechanismExplainerV1Frame,
            primaryTransform: document.querySelector(
              "[data-mechanism-primary]",
            ).getAttribute("transform"),
          };
        }, {
          profileId: MECHANISM_EXPLAINER_V1_PROFILE,
          frameValue: frame,
        });
        await page.evaluate(() => new Promise((resolveFrame) => {
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
        }));
        const domHash = sha256(
          await page.locator("svg").evaluate((node) => node.outerHTML),
        );
        const stablePixels = (
          state.runtime.counter.motionProgress === 0
          || state.runtime.counter.motionProgress === 1
        );
        secondPass.push({
          frame,
          state,
          domHash,
          imageHash: stablePixels
            ? sha256(await page.screenshot({
              type: "png",
              animations: "disabled",
            }))
            : null,
        });
      }
      assert.deepEqual(
        secondPass.map(({ frame, state, domHash, imageHash }) => ({
          frame,
          runtime: state.runtime,
          renderedFrame: state.renderedFrame,
          primaryTransform: state.primaryTransform,
          domHash,
          imageHash,
        })),
        firstPass.map(({ frame, state, domHash, imageHash }) => ({
          frame,
          runtime: state.runtime,
          renderedFrame: state.renderedFrame,
          primaryTransform: state.primaryTransform,
          domHash,
          imageHash,
        })),
      );
    }
    assert.deepEqual(remoteRequests, []);
  } finally {
    await browser.close();
  }
});
