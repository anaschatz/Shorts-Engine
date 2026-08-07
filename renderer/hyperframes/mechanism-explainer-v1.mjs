import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const OUTFIT_BYTES = readFileSync(
  require.resolve("@fontsource/outfit/files/outfit-latin-600-normal.woff2"),
);
const SPACE_MONO_BYTES = readFileSync(
  require.resolve(
    "@fontsource/space-mono/files/space-mono-latin-700-normal.woff2",
  ),
);
const OUTFIT_BASE64 = OUTFIT_BYTES.toString("base64");
const SPACE_MONO_BASE64 = SPACE_MONO_BYTES.toString("base64");

export const MECHANISM_EXPLAINER_V1_PROFILE = "mechanism-explainer-v1";
export const MECHANISM_EXPLAINER_V1_FPS = 30;
export const MECHANISM_EXPLAINER_V1_TRANSITION_FRAMES = 8;
export const MECHANISM_EXPLAINER_V1_HELPER_FADE_FRAMES = 6;
export const MECHANISM_EXPLAINER_V1_MIN_HOLD_FRAMES = 12;
export const MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR = 0.25;
export const MECHANISM_EXPLAINER_V1_MIN_DIGITS = 2;
export const MECHANISM_EXPLAINER_V1_MAX_DIGITS = 8;

export const MECHANISM_EXPLAINER_V1_MOTION_VOCABULARY = Object.freeze([
  "enter",
  "hold",
  "update",
  "rollover",
  "resolve",
  "exit",
]);

export const MECHANISM_EXPLAINER_V1_HELPER_RECIPES = Object.freeze([
  "range",
  "interpretation",
  "carry",
  "patch",
  "time_continues",
]);

export const MECHANISM_EXPLAINER_V1_TONES = Object.freeze([
  "neutral",
  "accent",
  "warning",
  "success",
]);

export const MECHANISM_EXPLAINER_V1_MOTION_RECIPES =
  Object.freeze({
    enter: Object.freeze({
      durationFrames: MECHANISM_EXPLAINER_V1_TRANSITION_FRAMES,
      maxOffsetY: 10,
    }),
    hold: Object.freeze({
      durationFrames: 0,
      maxOffsetY: 0,
    }),
    update: Object.freeze({
      durationFrames: MECHANISM_EXPLAINER_V1_TRANSITION_FRAMES,
      maxOffsetY: 0,
    }),
    rollover: Object.freeze({
      durationFrames: 10,
      maxOffsetY: 18,
    }),
    resolve: Object.freeze({
      durationFrames: MECHANISM_EXPLAINER_V1_TRANSITION_FRAMES,
      maxOffsetY: 0,
    }),
    exit: Object.freeze({
      durationFrames: MECHANISM_EXPLAINER_V1_TRANSITION_FRAMES,
      maxOffsetY: 10,
    }),
  });

export const MECHANISM_EXPLAINER_V1_GEOMETRY =
  Object.freeze({
    canvas: Object.freeze({
      x: 0,
      y: 0,
      width: 1080,
      height: 1920,
    }),
    title: Object.freeze({
      x: 90,
      y: 54,
      width: 900,
      height: 166,
      cx: 540,
      cy: 137,
    }),
    primaryDevice: Object.freeze({
      x: 160,
      y: 320,
      width: 760,
      height: 520,
      cx: 540,
      cy: 580,
    }),
    counter: Object.freeze({
      x: 210,
      y: 470,
      width: 660,
      height: 180,
      cx: 540,
      cy: 560,
    }),
    annotation: Object.freeze({
      x: 150,
      y: 858,
      width: 780,
      height: 82,
      cx: 540,
      cy: 899,
    }),
    helperRail: Object.freeze({
      x: 150,
      y: 970,
      width: 780,
      height: 250,
      cx: 540,
      cy: 1095,
    }),
    captionLane: Object.freeze({
      x: 86,
      y: 1300,
      width: 908,
      height: 430,
      cx: 540,
      cy: 1515,
    }),
  });

export const MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS =
  Object.freeze({
    primaryDevice: "translate(540 580)",
    counter: "translate(540 560)",
    annotation: "translate(540 899)",
    helperRail: "translate(540 1095)",
  });

export const MECHANISM_EXPLAINER_V1_PROFILE_SPEC =
  Object.freeze({
    id: MECHANISM_EXPLAINER_V1_PROFILE,
    schemaVersion: 1,
    provider: "hyperframes_local",
    runtimeVersion: "1.0.0",
    styleVersion: "1.0.0",
    width: 1080,
    height: 1920,
    fps: MECHANISM_EXPLAINER_V1_FPS,
    featureGated: true,
    publishable: false,
    primaryAnchor: "primaryDevice",
    maximumPrimaryObjects: 1,
    maximumHelpers: 1,
  });

const STORY_KEYS = Object.freeze([
  "schemaVersion",
  "profile",
  "id",
  "title",
  "device",
  "phrases",
]);
const TIMED_STORY_KEYS = Object.freeze([
  ...STORY_KEYS,
  "durationFrames",
]);
const DEVICE_KEYS = Object.freeze([
  "label",
  "digitCount",
  "unit",
]);
const PHRASE_KEYS = Object.freeze([
  "id",
  "text",
  "pauseAfterMs",
  "visual",
]);
const TIMED_PHRASE_KEYS = Object.freeze([
  ...PHRASE_KEYS,
  "startFrame",
  "endFrame",
  "triggerFrame",
]);
const VISUAL_KEYS = Object.freeze([
  "action",
  "triggerToken",
  "displayFrom",
  "displayTo",
  "status",
  "tone",
  "helper",
]);
const HELPER_KEYS = Object.freeze([
  "recipe",
  "title",
  "primary",
  "secondary",
]);
const FORBIDDEN_DATA_KEYS = /^(?:x|y|cx|cy|width|height|anchor|transform|svg|css|html|javascript|script|code|markup|path|viewBox|style|asset|url)$/iu;
const REMOTE_OR_EXECUTABLE_PATTERN =
  /(?:\b(?:https?|ftp):\/\/|javascript:|data:text\/html|<\s*\/?\s*(?:script|style|svg|iframe)\b|on[a-z]+\s*=|url\s*\()/iu;
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;
const DISPLAY_PATTERN = /^\d+$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const MOTION_SET = new Set(MECHANISM_EXPLAINER_V1_MOTION_VOCABULARY);
const HELPER_SET = new Set(MECHANISM_EXPLAINER_V1_HELPER_RECIPES);
const TONE_SET = new Set(MECHANISM_EXPLAINER_V1_TONES);

function fail(path, message) {
  throw new TypeError(
    `mechanism-explainer-v1 invalid ${path}: ${message}`,
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function safeJson(value) {
  return JSON.stringify(canonicalize(value))
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function assertPlainObject(value, path) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(path, "must be a plain object");
  }
}

function assertExactKeys(value, allowedKeys, path) {
  assertPlainObject(value, path);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_DATA_KEYS.test(key)) {
      fail(path, `story-owned geometry or executable key "${key}"`);
    }
    if (!allowed.has(key)) fail(path, `unknown key "${key}"`);
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) fail(path, `missing key "${key}"`);
  }
}

function safeText(value, path, {
  maxLength,
  allowEmpty = false,
} = {}) {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value !== value.trim()) fail(path, "must not have surrounding space");
  if (!allowEmpty && value.length === 0) fail(path, "must not be empty");
  if (value.length > maxLength) {
    fail(path, `must be at most ${maxLength} characters`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    fail(path, "must not contain control characters");
  }
  if (REMOTE_OR_EXECUTABLE_PATTERN.test(value)) {
    fail(path, "must not contain remote or executable content");
  }
  return value;
}

function safeId(value, path) {
  const id = safeText(value, path, { maxLength: 64 });
  if (!ID_PATTERN.test(id)) {
    fail(path, "must be a lowercase data identifier");
  }
  return id;
}

function boundedInteger(value, path, minimum, maximum) {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    fail(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function normalizeDevice(value) {
  assertExactKeys(value, DEVICE_KEYS, "device");
  return {
    label: safeText(value.label, "device.label", { maxLength: 36 }),
    digitCount: boundedInteger(
      value.digitCount,
      "device.digitCount",
      MECHANISM_EXPLAINER_V1_MIN_DIGITS,
      MECHANISM_EXPLAINER_V1_MAX_DIGITS,
    ),
    unit: safeText(value.unit, "device.unit", {
      maxLength: 20,
      allowEmpty: true,
    }),
  };
}

function normalizeHelper(value, path) {
  if (value === null) return null;
  assertExactKeys(value, HELPER_KEYS, path);
  if (!HELPER_SET.has(value.recipe)) {
    fail(
      `${path}.recipe`,
      `must be one of ${MECHANISM_EXPLAINER_V1_HELPER_RECIPES.join(", ")}`,
    );
  }
  return {
    recipe: value.recipe,
    title: safeText(value.title, `${path}.title`, { maxLength: 34 }),
    primary: safeText(value.primary, `${path}.primary`, {
      maxLength: 40,
    }),
    secondary: safeText(value.secondary, `${path}.secondary`, {
      maxLength: 54,
      allowEmpty: true,
    }),
  };
}

function normalizeVisual(value, path, digitCount) {
  assertExactKeys(value, VISUAL_KEYS, path);
  if (!MOTION_SET.has(value.action)) {
    fail(
      `${path}.action`,
      `must be one of ${MECHANISM_EXPLAINER_V1_MOTION_VOCABULARY.join(", ")}`,
    );
  }
  if (value.triggerToken !== null) {
    safeText(value.triggerToken, `${path}.triggerToken`, {
      maxLength: 32,
    });
  }
  const displayFrom = safeText(value.displayFrom, `${path}.displayFrom`, {
    maxLength: MECHANISM_EXPLAINER_V1_MAX_DIGITS,
  });
  const displayTo = safeText(value.displayTo, `${path}.displayTo`, {
    maxLength: MECHANISM_EXPLAINER_V1_MAX_DIGITS,
  });
  for (const [key, display] of [
    ["displayFrom", displayFrom],
    ["displayTo", displayTo],
  ]) {
    if (!DISPLAY_PATTERN.test(display) || display.length !== digitCount) {
      fail(
        `${path}.${key}`,
        `must contain exactly ${digitCount} digits`,
      );
    }
  }
  if (!TONE_SET.has(value.tone)) {
    fail(
      `${path}.tone`,
      `must be one of ${MECHANISM_EXPLAINER_V1_TONES.join(", ")}`,
    );
  }
  return {
    action: value.action,
    triggerToken: value.triggerToken,
    displayFrom,
    displayTo,
    status: safeText(value.status, `${path}.status`, { maxLength: 44 }),
    tone: value.tone,
    helper: normalizeHelper(value.helper, `${path}.helper`),
  };
}

function normalizeStory(input, { requireTiming }) {
  assertExactKeys(
    input,
    requireTiming ? TIMED_STORY_KEYS : STORY_KEYS,
    "story",
  );
  if (input.schemaVersion !== 1) {
    fail("story.schemaVersion", "must equal 1");
  }
  if (input.profile !== MECHANISM_EXPLAINER_V1_PROFILE) {
    fail(
      "story.profile",
      `must equal "${MECHANISM_EXPLAINER_V1_PROFILE}"`,
    );
  }
  const device = normalizeDevice(input.device);
  if (!Array.isArray(input.phrases) || input.phrases.length < 1) {
    fail("story.phrases", "must be a non-empty array");
  }
  if (input.phrases.length > 32) {
    fail("story.phrases", "must contain at most 32 phrases");
  }
  const phraseIds = new Set();
  const phrases = input.phrases.map((phrase, index) => {
    const path = `story.phrases[${index}]`;
    assertExactKeys(
      phrase,
      requireTiming ? TIMED_PHRASE_KEYS : PHRASE_KEYS,
      path,
    );
    const id = safeId(phrase.id, `${path}.id`);
    if (phraseIds.has(id)) fail(`${path}.id`, "must be unique");
    phraseIds.add(id);
    const text = safeText(phrase.text, `${path}.text`, {
      maxLength: 220,
    });
    const visual = normalizeVisual(phrase.visual, `${path}.visual`, device.digitCount);
    if (
      visual.triggerToken !== null
      && !text.toLocaleLowerCase("en-US").includes(
        visual.triggerToken.toLocaleLowerCase("en-US"),
      )
    ) {
      fail(
        `${path}.visual.triggerToken`,
        "must occur in the narration phrase",
      );
    }
    const normalized = {
      id,
      text,
      pauseAfterMs: boundedInteger(
        phrase.pauseAfterMs,
        `${path}.pauseAfterMs`,
        0,
        5_000,
      ),
      visual,
    };
    if (requireTiming) {
      normalized.startFrame = boundedInteger(
        phrase.startFrame,
        `${path}.startFrame`,
        0,
        input.durationFrames,
      );
      normalized.endFrame = boundedInteger(
        phrase.endFrame,
        `${path}.endFrame`,
        1,
        input.durationFrames,
      );
      normalized.triggerFrame = boundedInteger(
        phrase.triggerFrame,
        `${path}.triggerFrame`,
        normalized.startFrame,
        normalized.endFrame - 1,
      );
    }
    return normalized;
  });

  const normalized = {
    schemaVersion: 1,
    profile: MECHANISM_EXPLAINER_V1_PROFILE,
    id: safeId(input.id, "story.id"),
    title: safeText(input.title, "story.title", { maxLength: 72 }),
    device,
    phrases,
  };

  if (requireTiming) {
    normalized.durationFrames = boundedInteger(
      input.durationFrames,
      "story.durationFrames",
      1,
      54_000,
    );
    let cursor = 0;
    phrases.forEach((phrase, index) => {
      const path = `story.phrases[${index}]`;
      if (phrase.startFrame !== cursor) {
        fail(
          `${path}.startFrame`,
          "phrases must be contiguous, ordered, and start at frame zero",
        );
      }
      if (phrase.endFrame <= phrase.startFrame) {
        fail(`${path}.endFrame`, "must be after startFrame");
      }
      const motionFrames =
        MECHANISM_EXPLAINER_V1_MOTION_RECIPES[
          phrase.visual.action
        ].durationFrames;
      const helperExitFrames = phrase.visual.helper
        ? MECHANISM_EXPLAINER_V1_HELPER_FADE_FRAMES
        : 0;
      const requiredFrames = motionFrames
        + MECHANISM_EXPLAINER_V1_MIN_HOLD_FRAMES
        + helperExitFrames;
      if (phrase.endFrame - phrase.triggerFrame < requiredFrames) {
        fail(
          `${path}.triggerFrame`,
          `must leave ${requiredFrames} frames for bounded motion and comprehension hold`,
        );
      }
      cursor = phrase.endFrame;
    });
    if (cursor !== normalized.durationFrames) {
      fail(
        "story.durationFrames",
        "phrase ranges must cover the complete frame clock",
      );
    }
  }

  return deepFreeze(normalized);
}

export function validateMechanismExplainerV1StoryData(input) {
  return normalizeStory(input, { requireTiming: false });
}

export function validateMechanismExplainerV1StorySpec(input) {
  return normalizeStory(input, { requireTiming: true });
}

export const validateMechanismExplainerStorySpec =
  validateMechanismExplainerV1StorySpec;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value) {
  const x = clamp01(value);
  return x * x * (3 - (2 * x));
}

function progress(frame, startFrame, endFrame) {
  if (endFrame <= startFrame) return frame >= startFrame ? 1 : 0;
  return smoothstep((frame - startFrame) / (endFrame - startFrame));
}

function assertFrame(frame, durationFrames) {
  if (
    !Number.isInteger(frame)
    || frame < 0
    || frame >= durationFrames
  ) {
    fail(
      "frame",
      `must be an integer from 0 through ${durationFrames - 1}`,
    );
  }
}

function stateFromValidatedStory(story, frame) {
  assertFrame(frame, story.durationFrames);
  const phraseIndex = story.phrases.findIndex(
    ({ startFrame, endFrame }) => (
      frame >= startFrame && frame < endFrame
    ),
  );
  const phrase = story.phrases[phraseIndex];
  const priorPhrase = story.phrases[Math.max(0, phraseIndex - 1)];
  const recipe =
    MECHANISM_EXPLAINER_V1_MOTION_RECIPES[phrase.visual.action];
  const motionProgress = phrase.visual.action === "hold"
    ? (frame >= phrase.triggerFrame ? 1 : 0)
    : progress(
      frame,
      phrase.triggerFrame,
      phrase.triggerFrame + recipe.durationFrames,
    );
  const annotationMidFrame = phrase.triggerFrame
    + Math.floor(MECHANISM_EXPLAINER_V1_TRANSITION_FRAMES / 2);
  const annotationFromOpacity = phraseIndex === 0
    ? 0
    : frame < annotationMidFrame
      ? 1 - (
        (1 - MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR)
        * progress(frame, phrase.triggerFrame, annotationMidFrame)
      )
      : 0;
  const annotationToOpacity = phraseIndex === 0
    ? 1
    : frame < annotationMidFrame
      ? 0
      : MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR
        + (
          (1 - MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR)
          * progress(
            frame,
            annotationMidFrame,
            phrase.triggerFrame + MECHANISM_EXPLAINER_V1_TRANSITION_FRAMES,
          )
        );
  const helper = phrase.visual.helper;
  let helperOpacity = 0;
  if (helper && frame >= phrase.startFrame) {
    const enterOpacity = progress(
      frame,
      phrase.startFrame,
      phrase.startFrame + MECHANISM_EXPLAINER_V1_HELPER_FADE_FRAMES,
    );
    const fadeStart = phrase.endFrame
      - MECHANISM_EXPLAINER_V1_HELPER_FADE_FRAMES;
    const exitOpacity = 1 - progress(
      frame,
      fadeStart,
      phrase.endFrame - 1,
    );
    helperOpacity = Math.min(enterOpacity, exitOpacity);
  }
  const rolloverOffset = phrase.visual.action === "rollover"
    ? recipe.maxOffsetY
    : 0;
  const displayChanges = (
    phrase.visual.displayFrom !== phrase.visual.displayTo
  );
  const fromOpacity = !displayChanges
    ? 1
    : phrase.visual.action === "rollover"
      ? 1 - motionProgress
      : motionProgress < 0.5
        ? 1 - (
          (1 - MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR)
          * (motionProgress * 2)
        )
        : 0;
  const toOpacity = !displayChanges
    ? 0
    : phrase.visual.action === "rollover"
      ? motionProgress
      : motionProgress < 0.5
        ? 0
        : MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR
          + (
            (1 - MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR)
            * ((motionProgress - 0.5) * 2)
          );
  return deepFreeze({
    frame,
    phraseIndex,
    phraseId: phrase.id,
    phraseRange: [phrase.startFrame, phrase.endFrame],
    triggerFrame: phrase.triggerFrame,
    action: phrase.visual.action,
    tone: phrase.visual.tone,
    primaryObjectCount: 1,
    primary: {
      id: "primary_device",
      opacity: 1,
      anchor: "primaryDevice",
      transform:
        MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.primaryDevice,
    },
    counter: {
      anchor: "counter",
      transform: MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.counter,
      displayFrom: phrase.visual.displayFrom,
      displayTo: phrase.visual.displayTo,
      displayedValue: motionProgress < 0.5
        ? phrase.visual.displayFrom
        : phrase.visual.displayTo,
      fromOpacity,
      toOpacity,
      fromOffsetY: -rolloverOffset * motionProgress,
      toOffsetY: rolloverOffset * (1 - motionProgress),
      motionProgress,
    },
    annotation: {
      anchor: "annotation",
      transform: MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.annotation,
      fromText: priorPhrase.visual.status,
      toText: phrase.visual.status,
      fromOpacity: annotationFromOpacity,
      toOpacity: annotationToOpacity,
    },
    helper: helper
      ? {
        ...helper,
        anchor: "helperRail",
        transform:
          MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.helperRail,
        opacity: helperOpacity,
        visible: helperOpacity > 1e-9,
      }
      : null,
    activeHelperCount: helperOpacity > 1e-9 ? 1 : 0,
    comprehensionHold: (
      frame >= phrase.triggerFrame + recipe.durationFrames
      && (
        !helper
        || frame < (
          phrase.endFrame
          - MECHANISM_EXPLAINER_V1_HELPER_FADE_FRAMES
        )
      )
    ),
    captionLaneClear: true,
    progressBarPresent: false,
    cameraTransform: null,
  });
}

export function mechanismExplainerV1FrameStateAt(input, frame) {
  const story = validateMechanismExplainerV1StorySpec(input);
  return stateFromValidatedStory(story, frame);
}

function digitCellsMarkup(digitCount) {
  const gap = 12;
  const availableWidth = 640;
  const cellWidth = Math.min(
    104,
    Math.floor(
      (availableWidth - (gap * (digitCount - 1))) / digitCount,
    ),
  );
  const totalWidth =
    (cellWidth * digitCount) + (gap * (digitCount - 1));
  const firstX = -totalWidth / 2;
  const fontSize = Math.min(82, Math.floor(cellWidth * 0.72));
  return Array.from({ length: digitCount }, (_, index) => {
    const x = firstX + (index * (cellWidth + gap));
    const textX = x + (cellWidth / 2);
    return `<g data-digit-cell="${index}"><rect x="${x}" y="-79" width="${cellWidth}" height="158" rx="16" class="digit-cell"/><path d="M${x + 10} 0H${x + cellWidth - 10}" class="digit-seam"/><text data-digit-layer="from" data-digit-index="${index}" x="${textX}" y="29" text-anchor="middle" font-size="${fontSize}">0</text><text data-digit-layer="to" data-digit-index="${index}" x="${textX}" y="29" text-anchor="middle" font-size="${fontSize}" opacity="0">0</text></g>`;
  }).join("");
}

function helperRecipeMarkup() {
  return `
    <g data-helper-recipe="range">
      <circle cx="-310" cy="34" r="11" class="helper-accent"/>
      <circle cx="-175" cy="34" r="11" class="helper-accent"/>
      <path d="M-299 34H-186" class="helper-line"/>
      <path d="M-299 18V50M-186 18V50" class="helper-line"/>
    </g>
    <g data-helper-recipe="interpretation">
      <rect x="-342" y="5" width="68" height="58" rx="11" class="helper-box"/>
      <rect x="-205" y="5" width="68" height="58" rx="11" class="helper-box"/>
      <path d="M-263 34H-218M-218 34L-234 20M-218 34L-234 48" class="helper-line"/>
    </g>
    <g data-helper-recipe="carry">
      <text x="-307" y="54" text-anchor="middle" class="helper-glyph" font-size="52">09</text>
      <path d="M-270 34H-209M-209 34L-225 20M-209 34L-225 48" class="helper-line"/>
      <text x="-171" y="54" text-anchor="middle" class="helper-glyph" font-size="52">10</text>
    </g>
    <g data-helper-recipe="patch">
      <path d="M-328 0L-276 52M-300-28L-248 24" class="helper-line"/>
      <circle cx="-313" cy="-13" r="26" class="helper-box"/>
      <path d="M-220 34L-196 57L-148 3" class="helper-line"/>
    </g>
    <g data-helper-recipe="time_continues">
      <circle cx="-292" cy="34" r="50" class="helper-box"/>
      <path d="M-292 34V4M-292 34L-266 48M-220 34H-145M-145 34L-163 17M-145 34L-163 51" class="helper-line"/>
    </g>`;
}

function extractCompilerStory(input) {
  if (
    input
    && typeof input === "object"
    && !Array.isArray(input)
    && Object.hasOwn(input, "storySpec")
  ) {
    assertExactKeys(input, ["storySpec"], "compiler input");
    return input.storySpec;
  }
  return input;
}

export function compileMechanismExplainerV1Html(input) {
  const story = validateMechanismExplainerV1StorySpec(
    extractCompilerStory(input),
  );
  const runtime = safeJson({
    profileId: MECHANISM_EXPLAINER_V1_PROFILE,
    fps: MECHANISM_EXPLAINER_V1_FPS,
    durationFrames: story.durationFrames,
    geometry: MECHANISM_EXPLAINER_V1_GEOMETRY,
    transforms: MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS,
    motionRecipes: MECHANISM_EXPLAINER_V1_MOTION_RECIPES,
    transitionFrames: MECHANISM_EXPLAINER_V1_TRANSITION_FRAMES,
    helperFadeFrames: MECHANISM_EXPLAINER_V1_HELPER_FADE_FRAMES,
    transitionVisibilityFloor:
      MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR,
    story,
  });
  const initial = stateFromValidatedStory(story, 0);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; img-src data:; media-src 'none'; object-src 'none'; frame-src 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta data-render-profile="${MECHANISM_EXPLAINER_V1_PROFILE}" data-feature-gated="true" data-publishable="false">
<style>
@font-face{font-family:Outfit;src:url(data:font/woff2;base64,${OUTFIT_BASE64}) format("woff2");font-style:normal;font-weight:600;font-display:block}
@font-face{font-family:SpaceMono;src:url(data:font/woff2;base64,${SPACE_MONO_BASE64}) format("woff2");font-style:normal;font-weight:700;font-display:block}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#030303}
body{font-family:Outfit,sans-serif}
svg{display:block;width:100%;height:100%;font-family:Outfit,sans-serif}
.paper{fill:#f5f1e8}.muted{fill:#777d8a}.accent{fill:#a78bfa}.warning{fill:#ef4444}.success{fill:#67e8a5}
.panel{fill:#0b0d12;stroke:#f5f1e8;stroke-width:6}
.inner-panel{fill:#07090d;stroke:#5e6470;stroke-width:4}
.accent-line{fill:none;stroke:#a78bfa;stroke-width:8;stroke-linecap:round;stroke-linejoin:round}
.digit-cell{fill:#050609;stroke:#555d6a;stroke-width:4}
.digit-seam{fill:none;stroke:#292e37;stroke-width:3}
[data-digit-layer]{fill:#f5f1e8;font-family:SpaceMono,monospace}
.annotation-copy{font-size:43px;letter-spacing:1.5px}
#annotationAnchor[data-tone="accent"] .annotation-copy{fill:#a78bfa}
#annotationAnchor[data-tone="warning"] .annotation-copy{fill:#fb7185}
#annotationAnchor[data-tone="success"] .annotation-copy{fill:#67e8a5}
.helper-line{fill:none;stroke:#a78bfa;stroke-width:7;stroke-linecap:round;stroke-linejoin:round}
.helper-box{fill:#11131a;stroke:#a78bfa;stroke-width:5}
.helper-accent{fill:#a78bfa}
.helper-glyph{fill:#f5f1e8;font-family:SpaceMono,monospace;font-size:66px}
[data-helper-recipe="carry"] .helper-glyph{font-size:52px}
.helper-title{fill:#a78bfa;font-size:28px;letter-spacing:2px}
.helper-primary{fill:#f5f1e8;font-size:42px}
.helper-secondary{fill:#8a91a0;font-size:27px}
</style>
</head>
<body>
<svg viewBox="0 0 1080 1920" role="img" aria-label="${escapeXml(story.title)}">
  <rect width="1080" height="1920" fill="#030303"/>

  <g id="titleAnchor" data-engine-anchor="title">
    <text x="540" y="112" text-anchor="middle" class="paper" font-size="48">${escapeXml(story.title)}</text>
    <path d="M270 206H810" class="accent-line" stroke-width="5"/>
  </g>

  <g id="primaryDevice" data-primary-object="true" data-mechanism-primary="true" data-engine-anchor="primaryDevice" transform="${MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.primaryDevice}">
    <rect x="-380" y="-260" width="760" height="520" rx="42" class="panel"/>
    <circle cx="-314" cy="-202" r="13" class="accent"/>
    <circle cx="-274" cy="-202" r="13" class="muted"/>
    <text x="0" y="-184" text-anchor="middle" class="paper" font-size="38">${escapeXml(story.device.label)}</text>
    <rect x="-346" y="-118" width="692" height="236" rx="28" class="inner-panel"/>
    <g id="counterAnchor" data-engine-anchor="counter" transform="translate(0 0)">
      ${digitCellsMarkup(story.device.digitCount)}
    </g>
    <text x="0" y="196" text-anchor="middle" class="muted" font-size="28">${escapeXml(story.device.unit)}</text>
  </g>

  <g id="annotationAnchor" data-engine-anchor="annotation" transform="${MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.annotation}">
    <text id="annotationFrom" x="0" y="14" text-anchor="middle" class="paper annotation-copy">${escapeXml(initial.annotation.fromText)}</text>
    <text id="annotationTo" x="0" y="14" text-anchor="middle" class="paper annotation-copy">${escapeXml(initial.annotation.toText)}</text>
  </g>

  <g id="helperRail" data-helper-slot="true" data-mechanism-helper="true" data-engine-anchor="helperRail" transform="${MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.helperRail}" opacity="0">
    <rect x="-390" y="-125" width="780" height="250" rx="34" class="inner-panel"/>
    ${helperRecipeMarkup()}
    <text id="helperTitle" x="-95" y="-65" class="helper-title"></text>
    <text id="helperPrimary" x="-95" y="5" class="helper-primary"></text>
    <text id="helperSecondary" x="-95" y="64" class="helper-secondary"></text>
  </g>

  <rect x="86" y="1300" width="908" height="430" fill="none" opacity="0" data-caption-exclusion-region="true"/>
</svg>
<script>
"use strict";
const DATA=${runtime};
const byId=(id)=>document.getElementById(id);
const clamp=(value)=>Math.max(0,Math.min(1,value));
const ease=(value)=>{const x=clamp(value);return x*x*(3-(2*x))};
const progress=(frame,start,end)=>end<=start?(frame>=start?1:0):ease((frame-start)/(end-start));
const setOpacity=(node,value)=>{
  const next=String(clamp(value));
  if(node.getAttribute("opacity")!==next)node.setAttribute("opacity",next);
};
const setText=(node,value)=>{
  const next=String(value);
  if(node.textContent!==next)node.textContent=next;
};
const setDigits=(layer,value)=>{
  document.querySelectorAll(\`[data-digit-layer="\${layer}"]\`).forEach((node,index)=>{
    setText(node,value[index]);
  });
};
const phraseAt=(frame)=>{
  const index=DATA.story.phrases.findIndex(({startFrame,endFrame})=>frame>=startFrame&&frame<endFrame);
  return {index,phrase:DATA.story.phrases[index]};
};
function renderFrame(rawFrame){
  const frame=Math.max(0,Math.min(DATA.durationFrames-1,Math.floor(rawFrame+1e-7)));
  const {index:phraseIndex,phrase}=phraseAt(frame);
  const previous=DATA.story.phrases[Math.max(0,phraseIndex-1)];
  const recipe=DATA.motionRecipes[phrase.visual.action];
  const motionProgress=phrase.visual.action==="hold"
    ?(frame>=phrase.triggerFrame?1:0)
    :progress(frame,phrase.triggerFrame,phrase.triggerFrame+recipe.durationFrames);
  const rolloverOffset=phrase.visual.action==="rollover"?recipe.maxOffsetY:0;
  const displayChanges=phrase.visual.displayFrom!==phrase.visual.displayTo;
  const fromOpacity=!displayChanges
    ?1
    :phrase.visual.action==="rollover"
      ?1-motionProgress
      :motionProgress<.5
        ?1-((1-DATA.transitionVisibilityFloor)*(motionProgress*2))
        :0;
  const toOpacity=!displayChanges
    ?0
    :phrase.visual.action==="rollover"
      ?motionProgress
      :motionProgress<.5
        ?0
        :DATA.transitionVisibilityFloor
          +((1-DATA.transitionVisibilityFloor)*((motionProgress-.5)*2));
  setDigits("from",phrase.visual.displayFrom);
  setDigits("to",phrase.visual.displayTo);
  document.querySelectorAll('[data-digit-layer="from"]').forEach((node)=>{
    setOpacity(node,fromOpacity);
    node.setAttribute("transform",\`translate(0 \${(-rolloverOffset*motionProgress).toFixed(3)})\`);
  });
  document.querySelectorAll('[data-digit-layer="to"]').forEach((node)=>{
    setOpacity(node,toOpacity);
    node.setAttribute("transform",\`translate(0 \${(rolloverOffset*(1-motionProgress)).toFixed(3)})\`);
  });

  const annotationMidFrame=phrase.triggerFrame+Math.floor(DATA.transitionFrames/2);
  const annotationFromOpacity=phraseIndex===0
    ?0
    :frame<annotationMidFrame
      ?1-((1-DATA.transitionVisibilityFloor)*progress(
        frame,
        phrase.triggerFrame,
        annotationMidFrame,
      ))
      :0;
  const annotationToOpacity=phraseIndex===0
    ?1
    :frame<annotationMidFrame
      ?0
      :DATA.transitionVisibilityFloor
        +((1-DATA.transitionVisibilityFloor)*progress(
          frame,
          annotationMidFrame,
          phrase.triggerFrame+DATA.transitionFrames,
        ));
  setText(byId("annotationFrom"),previous.visual.status);
  setText(byId("annotationTo"),phrase.visual.status);
  setOpacity(byId("annotationFrom"),annotationFromOpacity);
  setOpacity(byId("annotationTo"),annotationToOpacity);
  byId("annotationAnchor").setAttribute(
    "data-tone",
    phraseIndex>0&&frame<annotationMidFrame
      ?previous.visual.tone
      :phrase.visual.tone,
  );

  const helper=phrase.visual.helper;
  let helperOpacity=0;
  if(helper&&frame>=phrase.startFrame){
    const enter=progress(
      frame,
      phrase.startFrame,
      phrase.startFrame+DATA.helperFadeFrames,
    );
    const fadeStart=phrase.endFrame-DATA.helperFadeFrames;
    const exit=1-progress(frame,fadeStart,phrase.endFrame-1);
    helperOpacity=Math.min(enter,exit);
  }
  setOpacity(byId("helperRail"),helperOpacity);
  document.querySelectorAll("[data-helper-recipe]").forEach((node)=>{
    node.setAttribute("display",helper&&node.getAttribute("data-helper-recipe")===helper.recipe?"inline":"none");
  });
  setText(byId("helperTitle"),helper?.title||"");
  setText(byId("helperPrimary"),helper?.primary||"");
  setText(byId("helperSecondary"),helper?.secondary||"");

  window.__mechanismExplainerV1Frame=frame;
  window.__mechanismExplainerV1State={
    frame,
    storyId:DATA.story.id,
    phraseIndex,
    phraseId:phrase.id,
    action:phrase.visual.action,
    triggerFrame:phrase.triggerFrame,
    primaryObjectCount:1,
    primary:{
      id:"primary_device",
      opacity:1,
      anchor:"primaryDevice",
      transform:DATA.transforms.primaryDevice,
    },
    counter:{
      anchor:"counter",
      transform:DATA.transforms.counter,
      displayedValue:motionProgress<.5?phrase.visual.displayFrom:phrase.visual.displayTo,
      fromOpacity:Number(fromOpacity.toFixed(6)),
      toOpacity:Number(toOpacity.toFixed(6)),
      motionProgress:Number(motionProgress.toFixed(6)),
    },
    helper:helper?{
      recipe:helper.recipe,
      anchor:"helperRail",
      transform:DATA.transforms.helperRail,
      opacity:Number(helperOpacity.toFixed(6)),
      visible:helperOpacity>1e-9,
    }:null,
    activeHelperCount:helperOpacity>1e-9?1:0,
    comprehensionHold:
      frame>=phrase.triggerFrame+recipe.durationFrames
      &&(!helper||frame<phrase.endFrame-DATA.helperFadeFrames),
    captionLaneClear:true,
    progressBarPresent:false,
    cameraTransform:null,
  };
}
window.__timelines={
  [DATA.profileId]:{
    duration:DATA.durationFrames/DATA.fps,
    fps:DATA.fps,
    seek:(seconds)=>renderFrame(seconds*DATA.fps),
  },
};
renderFrame(0);
</script>
</body>
</html>`;

  const captionCues = story.phrases.map((phrase) => deepFreeze({
    id: `caption_${phrase.id}`,
    startFrame: phrase.startFrame,
    endFrame: phrase.endFrame,
    text: phrase.text,
  }));
  const storySpecHash = sha256(JSON.stringify(canonicalize(story)));
  return deepFreeze({
    html,
    compositionHash: sha256(html),
    storySpecHash,
    profile: MECHANISM_EXPLAINER_V1_PROFILE_SPEC,
    profileId: MECHANISM_EXPLAINER_V1_PROFILE,
    featureGated: true,
    publishable: false,
    storyId: story.id,
    durationFrames: story.durationFrames,
    fps: MECHANISM_EXPLAINER_V1_FPS,
    width: 1080,
    height: 1920,
    primaryTransform:
      MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.primaryDevice,
    geometry: MECHANISM_EXPLAINER_V1_GEOMETRY,
    captionCues,
    narrationText: story.phrases.map(({ text }) => text).join(" "),
  });
}
