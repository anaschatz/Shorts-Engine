import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

import {
  buildMechanismExplainerCalibrationAudio,
  CALIBRATION_FINAL_HOLD_FRAMES,
  CALIBRATION_FPS,
  CALIBRATION_SAMPLE_RATE,
  CALIBRATION_SAMPLES_PER_FRAME,
  tokenizeCalibrationPhrase,
} from "./lib/mechanism-explainer-calibration-audio.mjs";
import {
  MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS,
  MECHANISM_EXPLAINER_V1_GEOMETRY,
  MECHANISM_EXPLAINER_V1_HELPER_FADE_FRAMES,
  MECHANISM_EXPLAINER_V1_MIN_HOLD_FRAMES,
  MECHANISM_EXPLAINER_V1_MOTION_RECIPES,
  MECHANISM_EXPLAINER_V1_PROFILE,
  MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR,
  compileMechanismExplainerV1Html,
  mechanismExplainerV1FrameStateAt,
  validateMechanismExplainerV1StoryData,
  validateMechanismExplainerV1StorySpec,
} from "../renderer/hyperframes/mechanism-explainer-v1.mjs";

const require = createRequire(import.meta.url);
const {
  ASS_THEMES,
  HUMAN_READABLE_PURPLE_ASS_THEME,
  NON_OVERLAPPING_ASS_TIMING_MODE,
  assTime,
  captionFontConfig,
  escapeAssText,
} = require("../server/pipelines/narrated-short/captions/ass-generator.cjs");

export const MECHANISM_CALIBRATION_WIDTH = 1080;
export const MECHANISM_CALIBRATION_HEIGHT = 1920;
export const MECHANISM_CALIBRATION_FPS = CALIBRATION_FPS;
export const MECHANISM_CALIBRATION_SAMPLE_RATE = CALIBRATION_SAMPLE_RATE;
export const MECHANISM_CALIBRATION_SAMPLES_PER_FRAME =
  CALIBRATION_SAMPLES_PER_FRAME;
export const MECHANISM_CALIBRATION_PROFILE =
  "mechanism_explainer_calibration_batch_v1";
export const MECHANISM_CALIBRATION_PIXEL_HASH_PROFILE =
  "rgb24_most_significant_bit_v1";

const ROOT = resolve(import.meta.dirname, "..");
const FFMPEG_FULL_BIN = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFPROBE_FULL_BIN = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";
const FFMPEG_BIN = process.env.FFMPEG_BIN
  || (existsSync(FFMPEG_FULL_BIN) ? FFMPEG_FULL_BIN : "ffmpeg");
const FFPROBE_BIN = process.env.FFPROBE_BIN
  || (existsSync(FFPROBE_FULL_BIN) ? FFPROBE_FULL_BIN : "ffprobe");
const CALIBRATION_ROOT = resolve(
  ROOT,
  "eval/narrated/dark-curiosity/calibration",
);
const OUTPUT_ROOT = resolve(ROOT, "showcase/assets");
const EVIDENCE_ROOT = resolve(ROOT, "showcase/evidence");
const RENDERER_PATH = resolve(
  ROOT,
  "renderer/hyperframes/mechanism-explainer-v1.mjs",
);
const AUDIO_HELPER_PATH = resolve(
  ROOT,
  "tools/lib/mechanism-explainer-calibration-audio.mjs",
);
const REMOTE_OR_EXECUTABLE =
  /(?:\b(?:https?|ftp):\/\/|javascript:|data:text\/html|<\s*\/?\s*(?:script|style|svg|iframe)\b|on[a-z]+\s*=|url\s*\()/iu;
const REMOTE_ASSET_PATTERN =
  /\b(?:https?|ftp):\/\/|(?:src|href)\s*=\s*["']\/\//iu;
const FORBIDDEN_STORY_KEY =
  /^(?:x|y|cx|cy|width|height|anchor|transform|svg|css|html|javascript|script|code|markup|path|viewBox|style|asset|url|src|href|camera)$/iu;
const ALLOWED_BROWSER_URL = /^(?:file|data|blob|about):/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const STORY_CHOICES = new Set(["gps", "odometer", "all"]);

export const MECHANISM_CALIBRATION_STORIES = Object.freeze({
  gps: Object.freeze({
    id: "gps",
    specFile: "gps-week-counter-mechanism-v1.json",
    stem: "mechanism-explainer-gps-calibration-v1",
  }),
  odometer: Object.freeze({
    id: "odometer",
    specFile: "odometer-rollover-mechanism-v1.json",
    stem: "mechanism-explainer-odometer-calibration-v1",
  }),
});

export const MECHANISM_CALIBRATION_STORY_IDS = Object.freeze(
  Object.keys(MECHANISM_CALIBRATION_STORIES),
);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

export function hashMechanismCalibrationPngPixels(png) {
  const buffer = Buffer.isBuffer(png) ? png : readFileSync(resolve(png));
  const decoded = spawnSync(FFMPEG_BIN, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-f", "rawvideo",
    "-pix_fmt", "rgb24",
    "pipe:1",
  ], {
    cwd: ROOT,
    input: buffer,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (
    decoded.error
    || decoded.status !== 0
    || !Buffer.isBuffer(decoded.stdout)
    || decoded.stdout.length
      !== MECHANISM_CALIBRATION_WIDTH
        * MECHANISM_CALIBRATION_HEIGHT
        * 3
  ) {
    throw new Error("Could not decode a native calibration PNG for pixel hashing");
  }
  const canonicalPixels = Buffer.from(decoded.stdout);
  for (let index = 0; index < canonicalPixels.length; index += 1) {
    canonicalPixels[index] &= 0x80;
  }
  return sha256(canonicalPixels);
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

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function relativePath(path) {
  return relative(ROOT, resolve(path)).replaceAll("\\", "/");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = String(
      result.stderr || result.stdout || result.error || "",
    ).trim().slice(-5000);
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function assertDataOnlyValue(value, path = "story") {
  if (typeof value === "string") {
    invariant(
      !REMOTE_OR_EXECUTABLE.test(value),
      `${path} contains remote or executable content`,
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => (
      assertDataOnlyValue(entry, `${path}[${index}]`)
    ));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    invariant(
      !FORBIDDEN_STORY_KEY.test(key),
      `${path}.${key} contains story-owned geometry or executable content`,
    );
    assertDataOnlyValue(entry, `${path}.${key}`);
  }
}

export function parseMechanismCalibrationArguments(argv = []) {
  let story = "all";
  let confirmWrite = false;
  let sawStory = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-write") {
      invariant(!confirmWrite, "Duplicate --confirm-write");
      confirmWrite = true;
      continue;
    }
    if (argument === "--story") {
      invariant(!sawStory, "Duplicate --story");
      const value = argv[index + 1];
      invariant(
        value && STORY_CHOICES.has(value),
        "--story must be gps, odometer, or all",
      );
      story = value;
      sawStory = true;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  invariant(
    confirmWrite,
    "Pass --confirm-write before writing mechanism calibration artifacts.",
  );
  return Object.freeze({
    confirmWrite: true,
    story,
    storyIds: story === "all"
      ? [...MECHANISM_CALIBRATION_STORY_IDS]
      : [story],
  });
}

export function loadMechanismCalibrationStory(storyId) {
  const config = MECHANISM_CALIBRATION_STORIES[storyId];
  invariant(config, `Unknown mechanism calibration story: ${storyId}`);
  const specPath = resolve(CALIBRATION_ROOT, config.specFile);
  invariant(
    existsSync(specPath),
    `${storyId} calibration story is missing: ${relativePath(specPath)}`,
  );
  const rawStorySpec = readJson(specPath);
  assertDataOnlyValue(rawStorySpec);
  const storySpec = validateMechanismExplainerV1StoryData(rawStorySpec);
  return Object.freeze({
    config,
    specPath,
    specFileHash: sha256File(specPath),
    storySpec,
  });
}

function validateWordSequence(story, audio) {
  const expected = story.phrases.flatMap((phrase) => (
    tokenizeCalibrationPhrase(phrase.text).map((text) => ({
      phraseId: phrase.id,
      text,
    }))
  ));
  invariant(
    Array.isArray(audio.words) && audio.words.length === expected.length,
    `${story.id}: audio word coverage mismatch`,
  );
  let previousEndFrame = 0;
  audio.words.forEach((word, index) => {
    invariant(
      word.globalIndex === index
        && word.phraseId === expected[index].phraseId
        && word.text === expected[index].text,
      `${story.id}: audio word ${index} differs from narration`,
    );
    invariant(
      Number.isInteger(word.startFrame)
        && Number.isInteger(word.endFrame)
        && word.startFrame >= previousEndFrame
        && word.endFrame > word.startFrame
        && word.endFrame <= audio.durationFrames,
      `${story.id}: invalid word frame range at ${index}`,
    );
    previousEndFrame = word.endFrame;
  });
}

export function buildTimedMechanismCalibrationStory(storyInput, audio) {
  const story = validateMechanismExplainerV1StoryData(storyInput);
  invariant(
    audio
      && audio.id === story.id
      && audio.fps === MECHANISM_CALIBRATION_FPS
      && audio.sampleRate === MECHANISM_CALIBRATION_SAMPLE_RATE
      && audio.samplesPerFrame === MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
    `${story.id}: audio profile does not match the mechanism frame clock`,
  );
  invariant(
    Number.isInteger(audio.durationFrames)
      && Number.isInteger(audio.durationSamples)
      && audio.durationSamples
        === audio.durationFrames * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
    `${story.id}: audio does not have an exact frame/sample clock`,
  );
  invariant(
    audio.publishable === false
      && audio.calibration === true
      && audio.commercialUseAttested === false
      && audio.provenance?.commercialUseAttested === false,
    `${story.id}: calibration audio must not assert production rights`,
  );
  invariant(
    Array.isArray(audio.phrases)
      && audio.phrases.length === story.phrases.length,
    `${story.id}: phrase timing coverage mismatch`,
  );
  validateWordSequence(story, audio);
  let cursor = 0;
  const phrases = story.phrases.map((phrase, index) => {
    const timed = audio.phrases[index];
    invariant(
      timed.id === phrase.id
        && timed.text === phrase.text
        && canonicalJson(timed.visual) === canonicalJson(phrase.visual),
      `${story.id}: phrase ${phrase.id} timing is bound to different content`,
    );
    invariant(
      timed.startFrame === cursor
        && Number.isInteger(timed.endFrame)
        && timed.endFrame > timed.startFrame
        && Number.isInteger(timed.triggerFrame)
        && timed.triggerFrame >= timed.startFrame
        && timed.triggerFrame < timed.endFrame,
      `${story.id}: phrase ${phrase.id} has invalid frame bounds`,
    );
    cursor = timed.endFrame;
    return {
      ...phrase,
      startFrame: timed.startFrame,
      endFrame: timed.endFrame,
      triggerFrame: timed.triggerFrame,
    };
  });
  invariant(
    cursor === audio.durationFrames,
    `${story.id}: phrase timing does not cover the complete frame clock`,
  );
  invariant(
    audio.frameClock?.finalHold?.frameCount
      === CALIBRATION_FINAL_HOLD_FRAMES
      && audio.frameClock.finalHold.endFrame === audio.durationFrames,
    `${story.id}: readable final hold is missing`,
  );
  return validateMechanismExplainerV1StorySpec({
    ...story,
    durationFrames: audio.durationFrames,
    phrases,
  });
}

function fixtureWordRanges(startFrame, endFrame, phraseId, text, globalStart) {
  const tokens = tokenizeCalibrationPhrase(text);
  const total = endFrame - startFrame;
  invariant(total >= tokens.length, `${phraseId}: fixture speech is too short`);
  return tokens.map((token, index) => {
    const start = startFrame + Math.floor(total * index / tokens.length);
    const end = index === tokens.length - 1
      ? endFrame
      : startFrame + Math.floor(total * (index + 1) / tokens.length);
    return {
      phraseId,
      localIndex: index,
      globalIndex: globalStart + index,
      text: token,
      startSample: start * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
      endSample: end * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
      startFrame: start,
      endFrame: end,
    };
  });
}

function comparableToken(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function fixtureTriggerFrame(phrase, words) {
  if (phrase.visual.triggerToken === null) return phrase.startFrame;
  const wanted = tokenizeCalibrationPhrase(phrase.visual.triggerToken)
    .map(comparableToken);
  const available = words.map((word) => comparableToken(word.text));
  for (let index = 0; index <= available.length - wanted.length; index += 1) {
    if (wanted.every((token, offset) => token === available[index + offset])) {
      return words[index].startFrame;
    }
  }
  throw new Error(`${phrase.id}: fixture trigger token is absent`);
}

export function createMechanismCalibrationTimingFixture(storyInput) {
  const story = validateMechanismExplainerV1StoryData(storyInput);
  let frameCursor = 0;
  let globalWordIndex = 0;
  const words = [];
  const phrases = story.phrases.map((source, index) => {
    const tokenCount = tokenizeCalibrationPhrase(source.text).length;
    const startFrame = frameCursor;
    const audioFrames = Math.max(
      tokenCount * 6,
      MECHANISM_EXPLAINER_V1_MOTION_RECIPES[source.visual.action]
        .durationFrames + MECHANISM_EXPLAINER_V1_MIN_HOLD_FRAMES + 12,
    );
    const audioEndFrame = startFrame + audioFrames;
    const phraseWords = fixtureWordRanges(
      startFrame,
      audioEndFrame,
      source.id,
      source.text,
      globalWordIndex,
    );
    const triggerFrame = fixtureTriggerFrame(
      { ...source, startFrame },
      phraseWords,
    );
    const pauseFrames = Math.max(
      Math.round(source.pauseAfterMs * MECHANISM_CALIBRATION_FPS / 1000),
      MECHANISM_EXPLAINER_V1_MOTION_RECIPES[source.visual.action]
        .durationFrames
        + MECHANISM_EXPLAINER_V1_MIN_HOLD_FRAMES
        + (source.visual.helper
          ? MECHANISM_EXPLAINER_V1_HELPER_FADE_FRAMES
          : 0),
    );
    const finalHold = index === story.phrases.length - 1
      ? CALIBRATION_FINAL_HOLD_FRAMES
      : 0;
    const endFrame = audioEndFrame + pauseFrames + finalHold;
    const timed = {
      index,
      id: source.id,
      text: source.text,
      visual: source.visual,
      startSample: startFrame * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
      startFrame,
      endSample: endFrame * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
      endFrame,
      triggerFrame,
      audio: {
        startSample: startFrame * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
        endSample: audioEndFrame * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
        sampleCount:
          audioFrames * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
        startFrame,
        endFrame: audioEndFrame,
        sha256: sha256(`${story.id}:${source.id}:fixture-pcm`),
      },
      pause: {
        requestedMs: source.pauseAfterMs,
        startSample: audioEndFrame
          * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
        endSample: (audioEndFrame + pauseFrames)
          * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
        sampleCount: pauseFrames * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
        startFrame: audioEndFrame,
        endFrame: audioEndFrame + pauseFrames,
      },
      alignmentPaddingSamples: 0,
      words: phraseWords,
      ...(finalHold
        ? {
          finalHold: {
            startFrame: endFrame - finalHold,
            endFrame,
            frameCount: finalHold,
            startSample: (endFrame - finalHold)
              * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
            endSample: endFrame * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
            sampleCount:
              finalHold * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
          },
        }
        : {}),
    };
    words.push(...phraseWords);
    globalWordIndex += phraseWords.length;
    frameCursor = endFrame;
    return timed;
  });
  const durationSamples =
    frameCursor * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME;
  const last = phrases.at(-1);
  const finalHold = last.finalHold;
  return {
    schemaVersion: 1,
    id: story.id,
    profile: "mechanism_explainer_calibration_audio_fixture_v1",
    normalizedAudioPath: null,
    normalizedAudioPathTemporary: false,
    durationFrames: frameCursor,
    durationSamples,
    durationSeconds: frameCursor / MECHANISM_CALIBRATION_FPS,
    speechEndFrame: last.audio.endFrame,
    speechEndSample: last.audio.endSample,
    sampleRate: MECHANISM_CALIBRATION_SAMPLE_RATE,
    channels: 1,
    fps: MECHANISM_CALIBRATION_FPS,
    samplesPerFrame: MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
    audioSha256: sha256(`${story.id}:fixture-audio`),
    phrases,
    words,
    frameClock: {
      fps: MECHANISM_CALIBRATION_FPS,
      sampleRate: MECHANISM_CALIBRATION_SAMPLE_RATE,
      samplesPerFrame: MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
      durationFrames: frameCursor,
      durationSamples,
      speechEndFrame: last.audio.endFrame,
      speechEndSample: last.audio.endSample,
      finalHold,
    },
    provenance: {
      profile: "mechanism_explainer_calibration_audio_fixture_v1",
      calibration: true,
      publishable: false,
      commercialUseAttested: false,
      provider: "deterministic_test_fixture",
    },
    calibration: true,
    publishable: false,
    commercialUseAttested: false,
    commercialUseAttestation: null,
    releaseBlockers: ["CALIBRATION_ONLY"],
  };
}

function balancedCaptionLines(words) {
  const text = words.map((word) => word.text);
  const joined = text.join(" ");
  if (joined.length <= 28) return [joined];
  let best = null;
  for (let index = 1; index < text.length; index += 1) {
    const left = text.slice(0, index).join(" ");
    const right = text.slice(index).join(" ");
    if (left.length > 28 || right.length > 28) continue;
    const score = Math.abs(left.length - right.length);
    if (!best || score < best.score) best = { score, lines: [left, right] };
  }
  return best?.lines || null;
}

function captionGroups(words) {
  const groups = [];
  let cursor = 0;
  while (cursor < words.length) {
    let selected = null;
    const maximum = words.length - cursor;
    for (let size = maximum; size >= 1; size -= 1) {
      const remaining = words.length - cursor - size;
      if (remaining === 1 && size > 1) continue;
      const slice = words.slice(cursor, cursor + size);
      const lines = balancedCaptionLines(slice);
      if (lines) {
        selected = { words: slice, lines };
        break;
      }
    }
    invariant(selected, "Narration cannot fit the calibration caption lane");
    groups.push(selected);
    cursor += selected.words.length;
  }
  return groups;
}

export function createMechanismCalibrationCaptionManifest(
  storyInput,
  audio,
) {
  const story = validateMechanismExplainerV1StoryData(storyInput);
  validateWordSequence(story, audio);
  const wordsByPhrase = new Map();
  for (const word of audio.words) {
    const values = wordsByPhrase.get(word.phraseId) || [];
    values.push(word);
    wordsByPhrase.set(word.phraseId, values);
  }
  const cues = [];
  for (const phrase of story.phrases) {
    const phraseWords = wordsByPhrase.get(phrase.id) || [];
    invariant(phraseWords.length > 0, `${phrase.id}: caption words missing`);
    for (const group of captionGroups(phraseWords)) {
      cues.push({
        id: `cue_${String(cues.length + 1).padStart(4, "0")}`,
        phraseId: phrase.id,
        startFrame: group.words[0].startFrame,
        endFrame: group.words.at(-1).endFrame,
        lines: group.lines,
        words: group.words.map((word) => ({
          wordIndex: word.globalIndex,
          text: word.text,
          startFrame: word.startFrame,
          endFrame: word.endFrame,
        })),
      });
    }
  }
  const body = {
    schemaVersion: 1,
    profile: "mechanism_explainer_calibration_captions_v1",
    status: "ready",
    calibration: true,
    publishable: false,
    storyId: story.id,
    fps: MECHANISM_CALIBRATION_FPS,
    durationFrames: audio.durationFrames,
    narrationText: story.phrases.map((phrase) => phrase.text).join(" "),
    wordCount: audio.words.length,
    themeId: HUMAN_READABLE_PURPLE_ASS_THEME,
    timingMode: NON_OVERLAPPING_ASS_TIMING_MODE,
    safeZone: {
      left: 0.08,
      right: 0.92,
      top: 0.68,
      bottom: 0.86,
      maxLines: 2,
    },
    cues,
  };
  const manifest = { ...body, contentHash: sha256(canonicalJson(body)) };
  return validateMechanismCalibrationCaptionManifest(manifest, audio);
}

export function validateMechanismCalibrationCaptionManifest(input, audio) {
  invariant(
    input?.schemaVersion === 1
      && input.profile === "mechanism_explainer_calibration_captions_v1"
      && input.status === "ready"
      && input.calibration === true
      && input.publishable === false
      && input.fps === MECHANISM_CALIBRATION_FPS
      && input.durationFrames === audio.durationFrames,
    "Calibration caption manifest profile is invalid",
  );
  invariant(
    Array.isArray(input.cues) && input.cues.length > 0,
    "Calibration caption cues are missing",
  );
  const flattened = [];
  let previousCueEnd = 0;
  input.cues.forEach((cue, cueIndex) => {
    invariant(
      cue.id === `cue_${String(cueIndex + 1).padStart(4, "0")}`
        && cue.startFrame >= previousCueEnd
        && cue.endFrame > cue.startFrame
        && cue.endFrame <= input.durationFrames
        && cue.lines.length >= 1
        && cue.lines.length <= 2
        && cue.lines.every((line) => line.length <= 28),
      `Calibration caption cue ${cueIndex} is invalid`,
    );
    cue.words.forEach((word) => flattened.push(word));
    previousCueEnd = cue.endFrame;
  });
  invariant(
    flattened.length === audio.words.length
      && flattened.every((word, index) => (
        word.wordIndex === index
        && word.text === audio.words[index].text
        && word.startFrame === audio.words[index].startFrame
        && word.endFrame === audio.words[index].endFrame
      )),
    "Calibration captions do not cover the complete narration",
  );
  const copy = structuredClone(input);
  delete copy.contentHash;
  invariant(
    input.contentHash === sha256(canonicalJson(copy)),
    "Calibration caption manifest hash mismatch",
  );
  return Object.freeze(structuredClone(input));
}

function vttTimestamp(frame) {
  const milliseconds = Math.round(
    frame * 1000 / MECHANISM_CALIBRATION_FPS,
  );
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

export function createMechanismCalibrationVtt(manifest) {
  const lines = ["WEBVTT", ""];
  for (const cue of manifest.cues) {
    lines.push(
      `${vttTimestamp(cue.startFrame)} --> ${vttTimestamp(cue.endFrame)}`,
      ...cue.lines,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function createMechanismCalibrationAss(
  manifest,
  env = process.env,
) {
  const font = captionFontConfig(env);
  invariant(font.available, "A checked local caption font is required");
  const theme = ASS_THEMES[HUMAN_READABLE_PURPLE_ASS_THEME];
  invariant(theme, "The human-readable purple ASS theme is unavailable");
  const marginV = Math.round(
    MECHANISM_CALIBRATION_HEIGHT * (1 - manifest.safeZone.bottom),
  );
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${MECHANISM_CALIBRATION_WIDTH}`,
    `PlayResY: ${MECHANISM_CALIBRATION_HEIGHT}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Narration,${font.name},76,${theme.primaryColour},${theme.secondaryColour},${theme.outlineColour},${theme.backColour},-1,0,0,0,100,100,0,0,1,${theme.outline},${theme.shadow},2,86,86,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...manifest.cues.map((cue) => (
      `Dialogue: 0,${assTime(cue.startFrame, "start", NON_OVERLAPPING_ASS_TIMING_MODE)},${assTime(cue.endFrame, "end", NON_OVERLAPPING_ASS_TIMING_MODE)},Narration,,0,0,0,,${cue.lines.map(escapeAssText).join("\\N")}`
    )),
    "",
  ];
  return Object.freeze({
    buffer: Buffer.from(lines.join("\n"), "utf8"),
    font: {
      name: font.name,
      filePath: font.filePath,
      fontsDir: font.fontsDir,
    },
    themeId: HUMAN_READABLE_PURPLE_ASS_THEME,
    timingMode: NON_OVERLAPPING_ASS_TIMING_MODE,
  });
}

export function mechanismCalibrationContactFrames(durationFrames) {
  invariant(
    Number.isInteger(durationFrames) && durationFrames > 1,
    "durationFrames must be greater than one",
  );
  return [...new Set(Array.from({ length: 8 }, (_, index) => (
    Math.round((durationFrames - 1) * index / 7)
  )))];
}

export function mechanismCalibrationSampleFrames(story) {
  const values = new Set(mechanismCalibrationContactFrames(
    story.durationFrames,
  ));
  values.add(0);
  values.add(story.durationFrames - 1);
  for (const phrase of story.phrases) {
    const motionFrames = MECHANISM_EXPLAINER_V1_MOTION_RECIPES[
      phrase.visual.action
    ].durationFrames;
    values.add(phrase.startFrame);
    values.add(phrase.triggerFrame);
    values.add(Math.min(
      phrase.endFrame - 1,
      phrase.triggerFrame + Math.floor(motionFrames / 2),
    ));
    values.add(Math.min(
      phrase.endFrame - 1,
      phrase.triggerFrame + motionFrames,
    ));
    values.add(Math.max(phrase.startFrame, phrase.endFrame - 1));
  }
  return [...values]
    .filter((frame) => frame >= 0 && frame < story.durationFrames)
    .sort((left, right) => left - right);
}

function randomAccessOrder(frames, seed) {
  return [...frames].sort((left, right) => (
    sha256(`${seed}:${left}`).localeCompare(sha256(`${seed}:${right}`))
  ));
}

async function preparePage(browser, htmlUrl, requestedUrls) {
  const context = await browser.newContext({
    viewport: {
      width: MECHANISM_CALIBRATION_WIDTH,
      height: MECHANISM_CALIBRATION_HEIGHT,
    },
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  page.on("request", (request) => requestedUrls.add(request.url()));
  await page.route("**/*", async (route) => {
    if (ALLOWED_BROWSER_URL.test(route.request().url())) {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
  await page.goto(htmlUrl, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const seek = async (frame) => {
    await page.evaluate(({ frame: nextFrame, fps, profileId }) => {
      const timeline = window.__timelines?.[profileId];
      if (!timeline || typeof timeline.seek !== "function") {
        throw new Error(`Missing seekable timeline for ${profileId}`);
      }
      timeline.seek(nextFrame / fps);
    }, {
      frame,
      fps: MECHANISM_CALIBRATION_FPS,
      profileId: MECHANISM_EXPLAINER_V1_PROFILE,
    });
    await page.evaluate(() => new Promise((done) => (
      requestAnimationFrame(() => requestAnimationFrame(done))
    )));
  };
  return { context, page, seek };
}

async function runtimeSnapshot(page) {
  return page.evaluate(() => {
    const state = structuredClone(
      window.__mechanismExplainerV1State || null,
    );
    const primary = document.querySelector("[data-mechanism-primary=true]");
    const helper = document.querySelector("[data-mechanism-helper=true]");
    const helperOpacity = Number(helper?.getAttribute("opacity") || 0);
    const counterFromOpacity = Number(document.querySelector(
      '[data-digit-layer="from"]',
    )?.getAttribute("opacity") || 0);
    const counterToOpacity = Number(document.querySelector(
      '[data-digit-layer="to"]',
    )?.getAttribute("opacity") || 0);
    return {
      frame: window.__mechanismExplainerV1Frame,
      state,
      dom: {
        primaryCount:
          document.querySelectorAll("[data-mechanism-primary=true]").length,
        primaryTransform: primary?.getAttribute("transform") || null,
        helperSlotCount:
          document.querySelectorAll("[data-mechanism-helper=true]").length,
        visibleHelperCount: helperOpacity > 1e-9 ? 1 : 0,
        counterOpacitySum: counterFromOpacity + counterToOpacity,
      },
    };
  });
}

function assertRuntimeSnapshot(snapshot, frame, compilation, storyId) {
  invariant(
    snapshot.frame === frame
      && snapshot.state?.frame === frame
      && snapshot.state.primaryObjectCount === 1
      && snapshot.dom.primaryCount === 1,
    `${storyId}: primary runtime state is invalid at frame ${frame}`,
  );
  invariant(
    snapshot.state.primary.transform === compilation.primaryTransform
      && snapshot.dom.primaryTransform === compilation.primaryTransform,
    `${storyId}: primary transform changed at frame ${frame}`,
  );
  invariant(
    snapshot.state.activeHelperCount <= 1
      && snapshot.dom.visibleHelperCount <= 1
      && snapshot.state.activeHelperCount
        === snapshot.dom.visibleHelperCount,
    `${storyId}: helper budget exceeded at frame ${frame}`,
  );
  const stateCounterOpacitySum = (
    snapshot.state.counter.fromOpacity
    + snapshot.state.counter.toOpacity
  );
  invariant(
    stateCounterOpacitySum
      >= MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR
      && stateCounterOpacitySum <= 1 + 1e-9
      && snapshot.dom.counterOpacitySum
        >= MECHANISM_EXPLAINER_V1_TRANSITION_VISIBILITY_FLOOR
      && snapshot.dom.counterOpacitySum <= 1 + 1e-9,
    `${storyId}: counter blanked or ghosted at frame ${frame}`,
  );
  invariant(
    snapshot.state.captionLaneClear === true
      && snapshot.state.progressBarPresent === false
      && snapshot.state.cameraTransform === null,
    `${storyId}: forbidden runtime presentation state at frame ${frame}`,
  );
}

async function renderNativeFrames({
  storyId,
  story,
  compilation,
  htmlPath,
  frameDirectory,
  chromiumImpl = chromium,
}) {
  const requestedUrls = new Set();
  const sampleFrames = mechanismCalibrationSampleFrames(story);
  const contactFrames = mechanismCalibrationContactFrames(
    story.durationFrames,
  );
  const hashes = {};
  const states = {};
  const holdFramesByPhrase = Object.fromEntries(
    story.phrases.map((phrase) => [phrase.id, []]),
  );
  const browser = await chromiumImpl.launch({ headless: true });
  try {
    const primary = await preparePage(
      browser,
      pathToFileURL(htmlPath).href,
      requestedUrls,
    );
    try {
      for (let frame = 0; frame < story.durationFrames; frame += 1) {
        await primary.seek(frame);
        const snapshot = await runtimeSnapshot(primary.page);
        assertRuntimeSnapshot(snapshot, frame, compilation, storyId);
        if (snapshot.state.comprehensionHold) {
          holdFramesByPhrase[snapshot.state.phraseId].push(frame);
        }
        const framePath = resolve(
          frameDirectory,
          `frame-${String(frame).padStart(6, "0")}.png`,
        );
        await primary.page.screenshot({
          path: framePath,
          type: "png",
          animations: "disabled",
        });
        if (sampleFrames.includes(frame)) {
          hashes[frame] = hashMechanismCalibrationPngPixels(framePath);
          states[frame] = snapshot;
        }
        if (frame % 150 === 0 || frame === story.durationFrames - 1) {
          process.stdout.write(
            `[${storyId}] rendered ${frame + 1}/${story.durationFrames}\n`,
          );
        }
      }
    } finally {
      await primary.context.close();
    }

    const verification = await preparePage(
      browser,
      pathToFileURL(htmlPath).href,
      requestedUrls,
    );
    try {
      for (const frame of randomAccessOrder(
        sampleFrames,
        compilation.compositionHash,
      )) {
        await verification.seek(frame);
        const snapshot = await runtimeSnapshot(verification.page);
        assertRuntimeSnapshot(snapshot, frame, compilation, storyId);
        const image = await verification.page.screenshot({
          type: "png",
          animations: "disabled",
        });
        invariant(
          hashMechanismCalibrationPngPixels(image) === hashes[frame]
            && canonicalJson(snapshot) === canonicalJson(states[frame]),
          `${storyId}: random-access frame ${frame} is nondeterministic`,
        );
      }
    } finally {
      await verification.context.close();
    }
  } finally {
    await browser.close();
  }
  const remoteRequests = [...requestedUrls]
    .filter((url) => !ALLOWED_BROWSER_URL.test(url))
    .sort();
  invariant(
    remoteRequests.length === 0,
    `${storyId}: browser attempted a remote request`,
  );
  for (const phrase of story.phrases) {
    invariant(
      holdFramesByPhrase[phrase.id].length
        >= MECHANISM_EXPLAINER_V1_MIN_HOLD_FRAMES,
      `${storyId}: ${phrase.id} lacks a comprehension hold`,
    );
  }
  return {
    sampleFrames,
    contactFrames,
    hashes,
    states,
    holdFramesByPhrase,
    requestedUrls: [...requestedUrls].sort(),
    remoteRequests,
    primaryTransform: compilation.primaryTransform,
    maximumVisibleHelpers: Math.max(
      0,
      ...Object.values(states).map(
        (snapshot) => snapshot.state.activeHelperCount,
      ),
    ),
  };
}

export function probeMechanismCalibrationMedia(path) {
  const value = JSON.parse(run(FFPROBE_BIN, [
    "-v", "error",
    "-count_frames",
    "-show_streams",
    "-show_format",
    "-of", "json",
    resolve(path),
  ], `ffprobe ${basename(path)}`).stdout);
  const videos = value.streams.filter(
    (stream) => stream.codec_type === "video",
  );
  const audios = value.streams.filter(
    (stream) => stream.codec_type === "audio",
  );
  const video = videos[0];
  const audio = audios[0];
  const [numerator, denominator] = String(
    video?.avg_frame_rate || video?.r_frame_rate || "0/1",
  ).split("/").map(Number);
  return {
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    fps: denominator ? numerator / denominator : 0,
    frameCount: Number(video?.nb_read_frames || video?.nb_frames || 0),
    durationSeconds: Number(value.format?.duration || 0),
    videoStreamCount: videos.length,
    videoCodec: video?.codec_name || null,
    pixelFormat: video?.pix_fmt || null,
    audioStreamCount: audios.length,
    audioCodec: audio?.codec_name || null,
    audioSampleRate: Number(audio?.sample_rate || 0),
    audioDurationSeconds: Number(audio?.duration || 0),
    formatName: value.format?.format_name || null,
  };
}

export function assertMechanismCalibrationMediaProbe(
  probe,
  durationFrames,
) {
  const durationSeconds =
    durationFrames / MECHANISM_CALIBRATION_FPS;
  const gates = {
    oneVideoStream: probe.videoStreamCount === 1,
    oneAudioStream: probe.audioStreamCount === 1,
    dimensions:
      probe.width === MECHANISM_CALIBRATION_WIDTH
      && probe.height === MECHANISM_CALIBRATION_HEIGHT,
    frameRate:
      Math.abs(probe.fps - MECHANISM_CALIBRATION_FPS) < 0.001,
    exactFrameCount: probe.frameCount === durationFrames,
    exactDuration:
      Math.abs(probe.durationSeconds - durationSeconds)
        <= 1 / MECHANISM_CALIBRATION_FPS,
    videoCodec: probe.videoCodec === "h264",
    pixelFormat: probe.pixelFormat === "yuv420p",
    audioCodec: probe.audioCodec === "aac",
    audioSampleRate:
      probe.audioSampleRate === MECHANISM_CALIBRATION_SAMPLE_RATE,
  };
  invariant(
    Object.values(gates).every(Boolean),
    `Mechanism calibration media QA failed: ${JSON.stringify(gates)}`,
  );
  return Object.freeze(gates);
}

function ffmpegFilterPath(path) {
  return resolve(path)
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll(",", "\\,")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function createContactSheet(videoPath, outputPath, frames) {
  const selection = frames.map((frame) => `eq(n\\,${frame})`).join("+");
  run(FFMPEG_BIN, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath,
    "-vf",
    `select=${selection},scale=270:480:flags=lanczos,tile=4x2`,
    "-frames:v", "1",
    "-fps_mode", "vfr",
    outputPath,
  ], "mechanism calibration contact sheet");
}

function artifactPaths(config) {
  const evidenceDir = resolve(EVIDENCE_ROOT, config.stem);
  return {
    evidenceDir,
    output: resolve(OUTPUT_ROOT, `${config.stem}.mp4`),
    vtt: resolve(OUTPUT_ROOT, `${config.stem}.vtt`),
    contactSheet: resolve(
      OUTPUT_ROOT,
      `${config.stem}-contact-sheet.png`,
    ),
    evidenceContactSheet: resolve(evidenceDir, "contact-sheet.png"),
    captionManifest: resolve(evidenceDir, "caption-manifest.json"),
    ass: resolve(evidenceDir, "caption-preview.ass"),
    audioManifest: resolve(evidenceDir, "audio-manifest.json"),
    sampledHashes: resolve(evidenceDir, "sampled-frame-hashes.json"),
    manifest: resolve(evidenceDir, "calibration-manifest.json"),
    renderReport: resolve(evidenceDir, "render-report.json"),
    qaReport: resolve(evidenceDir, "qa-report.json"),
    humanReview: resolve(evidenceDir, "human-review-checklist.md"),
  };
}

function buildHumanReviewChecklist(bundle) {
  return [
    `# Human review — ${bundle.config.stem}`,
    "",
    "Status: human_review_pending",
    "",
    "This is a feature-gated quality calibration. It is not approved or",
    "publishable, and no commercial-use attestation is asserted.",
    "",
    "- [ ] One persistent device remains visually fixed for the whole video.",
    "- [ ] Every helper explains the narration at that exact phrase.",
    "- [ ] No frame feels clustered or contains more than one helper.",
    "- [ ] Counter updates and rollovers begin on the spoken trigger.",
    "- [ ] Crossfades and holds make each state readable before replacement.",
    "- [ ] Purple subtitles are readable and do not cover the device or helper.",
    "- [ ] The final phrase remains on screen long enough to resolve the idea.",
    "- [ ] Clarity, pacing, timing, polish, and originality each score at least 4/5.",
    "",
    "Publishable: false",
    "",
  ].join("\n");
}

function buildEvidence({
  bundle,
  story,
  audio,
  compilation,
  captions,
  paths,
  browserProof,
  mediaProbe,
  mediaGates,
}) {
  const generatedAt = new Date().toISOString();
  const artifacts = {
    video: {
      path: relativePath(paths.output),
      sha256: sha256File(paths.output),
      bytes: statSync(paths.output).size,
    },
    vtt: {
      path: relativePath(paths.vtt),
      sha256: sha256File(paths.vtt),
      bytes: statSync(paths.vtt).size,
    },
    contactSheet: {
      path: relativePath(paths.contactSheet),
      sha256: sha256File(paths.contactSheet),
      bytes: statSync(paths.contactSheet).size,
    },
    ass: {
      path: relativePath(paths.ass),
      sha256: sha256File(paths.ass),
      bytes: statSync(paths.ass).size,
    },
  };
  const manifest = {
    schemaVersion: 1,
    profile: MECHANISM_CALIBRATION_PROFILE,
    status: "human_review_pending",
    featureGated: true,
    calibration: true,
    publishable: false,
    generatedAt,
    storyId: bundle.config.id,
    storySpecId: story.id,
    sources: {
      storySpec: {
        path: relativePath(bundle.specPath),
        fileHash: bundle.specFileHash,
      },
      renderer: {
        path: relativePath(RENDERER_PATH),
        fileHash: sha256File(RENDERER_PATH),
        profileId: compilation.profileId,
        compositionHash: compilation.compositionHash,
        storySpecHash: compilation.storySpecHash,
      },
      audioHelper: {
        path: relativePath(AUDIO_HELPER_PATH),
        fileHash: sha256File(AUDIO_HELPER_PATH),
      },
    },
    timeline: {
      width: MECHANISM_CALIBRATION_WIDTH,
      height: MECHANISM_CALIBRATION_HEIGHT,
      fps: MECHANISM_CALIBRATION_FPS,
      durationFrames: story.durationFrames,
      durationSamples: audio.durationSamples,
      samplesPerFrame: MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
      finalHoldFrames: audio.frameClock.finalHold.frameCount,
    },
    narration: {
      audioSha256: audio.audioSha256,
      provider: audio.provenance.provider,
      purpose: audio.provenance.purpose,
      commercialUseAttested: false,
      productionRightsAsserted: false,
      publishable: false,
    },
    captions: {
      manifestHash: captions.contentHash,
      cueCount: captions.cues.length,
      wordCount: captions.wordCount,
      themeId: captions.themeId,
      timingMode: captions.timingMode,
      burnedIn: true,
      sidecarVtt: true,
    },
    assets: {
      localOnly: true,
      remoteRequestCount: browserProof.remoteRequests.length,
      browserRequests: browserProof.requestedUrls,
      storyProvidedGeometry: false,
      storyProvidedExecutableContent: false,
    },
    artifacts,
    blockers: [
      "CALIBRATION_ONLY",
      "COMMERCIAL_USE_ATTESTATION_REQUIRED",
      "HUMAN_CREATIVE_REVIEW_REQUIRED",
    ],
  };
  const renderReport = {
    schemaVersion: 1,
    profile: "mechanism_explainer_calibration_render_report_v1",
    status: "human_review_pending",
    publishable: false,
    generatedAt,
    storyId: bundle.config.id,
    output: artifacts.video,
    contactSheet: artifacts.contactSheet,
    compilation: {
      profileId: compilation.profileId,
      compositionHash: compilation.compositionHash,
      storySpecHash: compilation.storySpecHash,
      deterministicCompile: true,
      fixedGeometryHash: sha256(canonicalJson(compilation.geometry)),
      primaryTransform: compilation.primaryTransform,
    },
    audio: {
      audioSha256: audio.audioSha256,
      durationSamples: audio.durationSamples,
      expectedSamples:
        story.durationFrames * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME,
      sampleRate: audio.sampleRate,
      exactFrameClock: true,
      commercialUseAttested: false,
    },
    captions: manifest.captions,
    technicalProbe: mediaProbe,
    blockers: manifest.blockers,
  };
  const qaReport = {
    schemaVersion: 1,
    profile: "mechanism_explainer_calibration_qa_v1",
    status: "human_review_pending",
    publishable: false,
    generatedAt,
    storyId: bundle.config.id,
    technicalGatesPassed: Object.values(mediaGates).every(Boolean),
    technicalGates: mediaGates,
    deterministicCompilation: true,
    deterministicRandomAccessFrames: true,
    sampledFrameHashProfile: MECHANISM_CALIBRATION_PIXEL_HASH_PROFILE,
    sampleFrames: browserProof.sampleFrames,
    sampledFrameHashes: browserProof.hashes,
    runtime: {
      primaryTransformConstant:
        browserProof.primaryTransform
          === MECHANISM_EXPLAINER_V1_FIXED_TRANSFORMS.primaryDevice,
      primaryTransform: browserProof.primaryTransform,
      maximumPrimaryObjects: 1,
      maximumVisibleHelpers: browserProof.maximumVisibleHelpers,
      comprehensionHoldFramesByPhrase:
        browserProof.holdFramesByPhrase,
      cameraMoves: 0,
      progressBarPresent: false,
    },
    captions: {
      completeNarrationCoverage: true,
      nonOverlapping: true,
      cueCount: captions.cues.length,
      wordCount: captions.wordCount,
      themeId: captions.themeId,
    },
    offline: {
      passed: browserProof.remoteRequests.length === 0,
      remoteRequests: browserProof.remoteRequests,
    },
    humanReview: {
      required: true,
      status: "pending",
    },
  };
  return { manifest, renderReport, qaReport };
}

async function renderOneStory(storyId, dependencies = {}) {
  const bundle = loadMechanismCalibrationStory(storyId);
  const paths = artifactPaths(bundle.config);
  const staging = mkdtempSync(join(
    tmpdir(),
    `${bundle.config.stem}-`,
  ));
  const frameDirectory = resolve(staging, "frames");
  const audioPath = resolve(staging, "narration.wav");
  const htmlPath = resolve(staging, "composition.html");
  const assPath = resolve(staging, "captions.ass");
  const visualPath = resolve(staging, "visual-master.mp4");
  const finalPath = resolve(staging, "final.mp4");
  const contactPath = resolve(staging, "contact-sheet.png");
  try {
    mkdirSync(frameDirectory);
    const buildAudio = dependencies.buildAudio
      || buildMechanismExplainerCalibrationAudio;
    const audio = await buildAudio(
      {
        id: bundle.storySpec.id,
        phrases: bundle.storySpec.phrases.map((phrase) => ({
          id: phrase.id,
          text: phrase.text,
          pauseAfterMs: phrase.pauseAfterMs,
          visual: phrase.visual,
        })),
      },
      {
        outputPath: audioPath,
        ffmpegPath: FFMPEG_BIN,
        speakingRate: 1.08,
        ...(dependencies.audioOptions || {}),
      },
      dependencies.audioDependencies || {},
    );
    invariant(
      existsSync(audio.normalizedAudioPath)
        && sha256File(audio.normalizedAudioPath) === audio.audioSha256,
      `${storyId}: normalized calibration audio is missing or stale`,
    );
    const story = buildTimedMechanismCalibrationStory(
      bundle.storySpec,
      audio,
    );
    const first = compileMechanismExplainerV1Html({ storySpec: story });
    const second = compileMechanismExplainerV1Html({ storySpec: story });
    invariant(
      first.html === second.html
        && first.compositionHash === second.compositionHash
        && first.storySpecHash === second.storySpecHash,
      `${storyId}: renderer compilation is nondeterministic`,
    );
    invariant(
      first.width === MECHANISM_CALIBRATION_WIDTH
        && first.height === MECHANISM_CALIBRATION_HEIGHT
        && first.fps === MECHANISM_CALIBRATION_FPS
        && first.durationFrames === story.durationFrames
        && first.featureGated === true
        && first.publishable === false
        && !REMOTE_ASSET_PATTERN.test(first.html),
      `${storyId}: renderer profile is invalid`,
    );
    const captions = createMechanismCalibrationCaptionManifest(
      bundle.storySpec,
      audio,
    );
    const ass = createMechanismCalibrationAss(
      captions,
      dependencies.env || process.env,
    );
    writeFileSync(htmlPath, first.html, "utf8");
    writeFileSync(assPath, ass.buffer);
    const browserProof = await renderNativeFrames({
      storyId,
      story,
      compilation: first,
      htmlPath,
      frameDirectory,
      chromiumImpl: dependencies.chromium || chromium,
    });

    run(FFMPEG_BIN, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-framerate", String(MECHANISM_CALIBRATION_FPS),
      "-start_number", "0",
      "-i", resolve(frameDirectory, "frame-%06d.png"),
      "-frames:v", String(story.durationFrames),
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "17",
      "-pix_fmt", "yuv420p",
      "-r", String(MECHANISM_CALIBRATION_FPS),
      "-an",
      visualPath,
    ], `${storyId} visual master`);

    const subtitleFilter = [
      `subtitles=filename='${ffmpegFilterPath(assPath)}'`,
      `fontsdir='${ffmpegFilterPath(ass.font.fontsDir)}'`,
    ].join(":");
    const expectedSamples =
      story.durationFrames * MECHANISM_CALIBRATION_SAMPLES_PER_FRAME;
    run(FFMPEG_BIN, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", visualPath,
      "-i", audio.normalizedAudioPath,
      "-vf", subtitleFilter,
      "-af",
      `apad=whole_len=${expectedSamples},atrim=end_sample=${expectedSamples},asetpts=N/SR/TB`,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-frames:v", String(story.durationFrames),
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "17",
      "-pix_fmt", "yuv420p",
      "-r", String(MECHANISM_CALIBRATION_FPS),
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", String(MECHANISM_CALIBRATION_SAMPLE_RATE),
      "-ac", "1",
      "-movflags", "+faststart",
      finalPath,
    ], `${storyId} final calibration render`);
    const mediaProbe = probeMechanismCalibrationMedia(finalPath);
    const mediaGates = assertMechanismCalibrationMediaProbe(
      mediaProbe,
      story.durationFrames,
    );
    createContactSheet(
      finalPath,
      contactPath,
      browserProof.contactFrames,
    );

    mkdirSync(OUTPUT_ROOT, { recursive: true });
    mkdirSync(paths.evidenceDir, { recursive: true });
    copyFileSync(finalPath, paths.output);
    copyFileSync(contactPath, paths.contactSheet);
    copyFileSync(contactPath, paths.evidenceContactSheet);
    writeFileSync(
      paths.vtt,
      createMechanismCalibrationVtt(captions),
      "utf8",
    );
    writeFileSync(paths.ass, ass.buffer);
    writeJson(paths.captionManifest, captions);
    writeJson(paths.audioManifest, {
      schemaVersion: audio.schemaVersion,
      id: audio.id,
      profile: audio.profile,
      durationFrames: audio.durationFrames,
      durationSamples: audio.durationSamples,
      durationSeconds: audio.durationSeconds,
      speechEndFrame: audio.speechEndFrame,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      fps: audio.fps,
      samplesPerFrame: audio.samplesPerFrame,
      audioSha256: audio.audioSha256,
      phrases: audio.phrases,
      words: audio.words,
      frameClock: audio.frameClock,
      provenance: audio.provenance,
      calibration: true,
      publishable: false,
      commercialUseAttested: false,
      releaseBlockers: audio.releaseBlockers,
      normalizedAudioPersisted: false,
    });
    writeJson(paths.sampledHashes, {
      schemaVersion: 1,
      profile:
        "mechanism_explainer_calibration_sampled_frames_v1",
      storyId,
      compositionHash: first.compositionHash,
      storySpecHash: first.storySpecHash,
      pixelHashProfile: MECHANISM_CALIBRATION_PIXEL_HASH_PROFILE,
      sampleFrames: browserProof.sampleFrames,
      rendererHashes: browserProof.hashes,
      runtimeStates: browserProof.states,
      freshContextRandomAccessVerification: true,
    });
    const evidence = buildEvidence({
      bundle,
      story,
      audio,
      compilation: first,
      captions,
      paths,
      browserProof,
      mediaProbe,
      mediaGates,
    });
    writeJson(paths.manifest, evidence.manifest);
    writeJson(paths.renderReport, evidence.renderReport);
    writeJson(paths.qaReport, evidence.qaReport);
    writeFileSync(
      paths.humanReview,
      buildHumanReviewChecklist(bundle),
      "utf8",
    );
    return Object.freeze({
      storyId,
      storySpecId: story.id,
      stem: bundle.config.stem,
      status: "human_review_pending",
      featureGated: true,
      calibration: true,
      publishable: false,
      outputPath: paths.output,
      outputHash: sha256File(paths.output),
      vttPath: paths.vtt,
      contactSheetPath: paths.contactSheet,
      evidenceDir: paths.evidenceDir,
      compositionHash: first.compositionHash,
      storySpecHash: first.storySpecHash,
      geometryHash: sha256(canonicalJson(first.geometry)),
      primaryTransform: first.primaryTransform,
      mediaProbe,
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function writeReuseComparison(results) {
  const path = resolve(
    EVIDENCE_ROOT,
    "mechanism-explainer-calibration-v1-reuse-comparison.md",
  );
  const both = results.length === 2;
  const sameGeometry = both
    && results[0].geometryHash === results[1].geometryHash;
  const samePrimaryTransform = both
    && results[0].primaryTransform === results[1].primaryTransform;
  writeFileSync(path, [
    "# mechanism-explainer-v1 reuse comparison",
    "",
    "Status: human_review_pending",
    "",
    "| Story | Composition | Story spec | Technical status |",
    "|---|---|---|---|",
    ...results.map((result) => (
      `| ${result.storyId} | \`${result.compositionHash}\` | \`${result.storySpecHash}\` | passed |`
    )),
    "",
    `- Same renderer profile: ${both ? "yes" : "pending second render"}`,
    `- Same engine-owned geometry: ${both ? (sameGeometry ? "yes" : "no") : "pending second render"}`,
    `- Same primary transform: ${both ? (samePrimaryTransform ? "yes" : "no") : "pending second render"}`,
    "- Story-owned coordinates or executable geometry: none",
    "- Publishable: false",
    "",
    "The technical reuse proof does not establish creative quality. A human",
    "must compare clarity, pacing, semantic timing, and polish before rollout.",
    "",
  ].join("\n"), "utf8");
  return path;
}

export async function renderMechanismExplainerCalibration(
  options = {},
  dependencies = {},
) {
  invariant(
    options.confirmWrite === true,
    "Mechanism calibration rendering requires confirmWrite: true",
  );
  const storyIds = options.storyIds || (
    !options.story || options.story === "all"
      ? [...MECHANISM_CALIBRATION_STORY_IDS]
      : [options.story]
  );
  invariant(
    storyIds.length > 0
      && storyIds.every((storyId) => (
        MECHANISM_CALIBRATION_STORIES[storyId]
      )),
    "Invalid mechanism calibration story selection",
  );
  const results = [];
  for (const storyId of storyIds) {
    results.push(await renderOneStory(storyId, dependencies));
  }
  mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const reuseComparisonPath = writeReuseComparison(results);
  return Object.freeze({
    status: "human_review_pending",
    featureGated: true,
    calibration: true,
    publishable: false,
    renders: results,
    reuseComparisonPath,
  });
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const options = parseMechanismCalibrationArguments(
      process.argv.slice(2),
    );
    const result = await renderMechanismExplainerCalibration(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
