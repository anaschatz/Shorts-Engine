const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { normalizeNarrationManifest } = require("../narration-contract.cjs");
const { stableStringify } = require("./contract.cjs");

const TIMING_CONTEXT_SCHEMA_VERSION = 1;
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{2,79}$/;

function fail(field, message = SAFE_MESSAGES.VALIDATION_ERROR) {
  throw new AppError("ANIMATION_TIMING_INVALID", message, 400, { field });
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field, `${field} must be an object.`);
  return value;
}

function exactKeys(value, allowed, field) {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) fail(`${field}.${key}`, `${field} contains an unsupported field.`);
}

function integer(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(field, `${field} is out of range.`);
  return value;
}

function text(value, field, max, pattern = null) {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/.test(value) || (pattern && !pattern.test(value))) fail(field, `${field} is invalid.`);
  return value;
}

function timingContentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function normalizeAnimationTimingContext(input = {}) {
  const context = structuredClone(object(input, "timingContext"));
  exactKeys(context, ["schemaVersion", "fps", "durationFrames", "alignmentHash", "draftHash", "words", "beats", "contentHash"], "timingContext");
  if (context.schemaVersion !== TIMING_CONTEXT_SCHEMA_VERSION) fail("schemaVersion", "Animation timing schema version is unsupported.");
  const fps = integer(context.fps, "fps", 30, 30);
  const durationFrames = integer(context.durationFrames, "durationFrames", fps, fps * 180);
  const alignmentHash = text(context.alignmentHash, "alignmentHash", 64, HASH_RE);
  const draftHash = text(context.draftHash, "draftHash", 64, HASH_RE);
  if (!Array.isArray(context.words) || !context.words.length || context.words.length > 400) fail("words");
  const words = context.words.map((word, index) => {
    object(word, `words[${index}]`);
    exactKeys(word, ["index", "text", "startFrame", "endFrame"], `words[${index}]`);
    if (word.index !== index) fail(`words[${index}].index`);
    return { index, text: text(word.text, `words[${index}].text`, 48), startFrame: integer(word.startFrame, `words[${index}].startFrame`, 0, durationFrames - 1), endFrame: integer(word.endFrame, `words[${index}].endFrame`, 1, durationFrames) };
  });
  normalizeNarrationManifest({ providerMode: "timing_fixture", voiceProfileId: "timing_voice", audioArtifactId: "art_timing-context-proof", audioHash: "0".repeat(64), sampleRate: 48000, durationFrames, words, rights: { commercialUseAllowed: true, consentReference: "timing_context_contract_validation" } });
  if (!Array.isArray(context.beats) || !context.beats.length || context.beats.length > 40) fail("beats");
  let coveredWords = 0;
  const beatIds = new Set();
  const beats = context.beats.map((beat, index) => {
    object(beat, `beats[${index}]`);
    exactKeys(beat, ["beatId", "wordStartIndex", "wordEndIndex", "startFrame", "endFrame"], `beats[${index}]`);
    const beatId = text(beat.beatId, `beats[${index}].beatId`, 80, ID_RE);
    if (beatIds.has(beatId) || beat.wordStartIndex !== coveredWords) fail(`beats[${index}]`);
    const wordEndIndex = integer(beat.wordEndIndex, `beats[${index}].wordEndIndex`, coveredWords + 1, words.length);
    const first = words[coveredWords];
    const last = words[wordEndIndex - 1];
    if (beat.startFrame !== first.startFrame || beat.endFrame !== last.endFrame) fail(`beats[${index}]`, "Beat timing does not match its words.");
    const normalized = { beatId, wordStartIndex: coveredWords, wordEndIndex, startFrame: beat.startFrame, endFrame: beat.endFrame };
    beatIds.add(beatId);
    coveredWords = wordEndIndex;
    return normalized;
  });
  if (coveredWords !== words.length) fail("beats", "Timing beats must cover every word exactly once.");
  const normalized = { schemaVersion: 1, fps, durationFrames, alignmentHash, draftHash, words, beats };
  const contentHash = timingContentHash(normalized);
  if (context.contentHash !== undefined && (!HASH_RE.test(context.contentHash) || context.contentHash !== contentHash)) fail("contentHash", "Timing context hash does not match.");
  return Object.freeze({ ...normalized, contentHash });
}

function timingBindingFromContext(input) {
  const context = normalizeAnimationTimingContext(input);
  return Object.freeze({ schemaVersion: 1, timingContextHash: context.contentHash, words: context.words.map(({ index, startFrame, endFrame }) => ({ index, startFrame, endFrame })), beats: context.beats.map(({ beatId, wordStartIndex, wordEndIndex, startFrame, endFrame }) => ({ beatId, wordStartIndex, wordEndIndex, startFrame, endFrame })) });
}

module.exports = { TIMING_CONTEXT_SCHEMA_VERSION, normalizeAnimationTimingContext, timingBindingFromContext, timingContentHash };
