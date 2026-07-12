const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { sanitizeText, validateResourceId } = require("../../../repositories/ids.cjs");
const { contentHash } = require("../contracts.cjs");
const { normalizeNarrationManifest } = require("../narration-contract.cjs");

const FPS = 30;

function fail(code, field, details = {}) {
  throw new AppError(code, SAFE_MESSAGES[code] || SAFE_MESSAGES.VALIDATION_ERROR, 409, { field, ...details });
}

function exactKeys(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("NARRATION_ALIGNMENT_FAILED", field);
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) fail("NARRATION_ALIGNMENT_FAILED", `${field}.${key}`);
}

function normalizeSpeechToken(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[’‘`´'-]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function scriptWords(script) {
  return script.beats.flatMap((beat) => String(beat.spokenText || "").split(/\s+/).filter(Boolean).map((text) => ({ beatId: beat.id, text, token: normalizeSpeechToken(text) })));
}

function providerWords(result = {}) {
  return (Array.isArray(result.segments) ? result.segments : []).flatMap((segment) => (
    Array.isArray(segment.words) ? segment.words : []
  )).map((word) => ({
    text: sanitizeText(word.word, 80),
    token: normalizeSpeechToken(word.word),
    start: Number(word.start),
    end: Number(word.end),
    confidence: Number.isFinite(Number(word.probability)) ? Math.max(0, Math.min(1, Number(word.probability))) : 0,
  })).filter((word) => word.text && word.token);
}

function mismatchCategory(expected, actual, index) {
  if (actual.length < expected.length) return "missing_word";
  if (actual.length > expected.length) return "extra_word";
  if (expected.includes(actual[index]) && actual.includes(expected[index])) return "reordered_word";
  return "changed_word";
}

function assertExactScript(expected, actual) {
  const firstMismatchIndex = expected.findIndex((word, index) => !actual[index] || word.token !== actual[index].token);
  if (firstMismatchIndex !== -1 || expected.length !== actual.length) {
    const index = firstMismatchIndex === -1 ? Math.min(expected.length, actual.length) : firstMismatchIndex;
    fail("NARRATION_SCRIPT_MISMATCH", "words", {
      expectedWordCount: expected.length,
      actualWordCount: actual.length,
      firstMismatchIndex: index,
      mismatchCategory: mismatchCategory(expected.map((word) => word.token), actual.map((word) => word.token), index),
    });
  }
}

function frameWords(expected, actual, durationSeconds) {
  const durationFrames = Math.ceil(Number(durationSeconds) * FPS);
  if (!Number.isFinite(durationFrames) || durationFrames < FPS || durationFrames > FPS * 120) fail("NARRATION_TIMING_INVALID", "durationFrames");
  let previousSecondsEnd = -1;
  let previousFrameEnd = 0;
  const words = actual.map((word, index) => {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start || word.start < previousSecondsEnd || word.end > Number(durationSeconds) + 0.0001) {
      fail("NARRATION_TIMING_INVALID", `words[${index}]`);
    }
    let startFrame = Math.floor(word.start * FPS);
    const endFrame = Math.ceil(word.end * FPS);
    if (startFrame < previousFrameEnd) startFrame = previousFrameEnd;
    if (endFrame <= startFrame || endFrame > durationFrames) fail("NARRATION_TIMING_INVALID", `words[${index}]`);
    previousSecondsEnd = word.end;
    previousFrameEnd = endFrame;
    return { index, text: expected[index].text, startFrame, endFrame, confidence: Number(word.confidence.toFixed(4)) };
  });
  return { durationFrames, words };
}

function beatTimings(script, expected, words) {
  let cursor = 0;
  return script.beats.map((beat) => {
    const count = expected.filter((word) => word.beatId === beat.id).length;
    if (!count) fail("NARRATION_ALIGNMENT_FAILED", `beats.${beat.id}`);
    const slice = words.slice(cursor, cursor + count);
    const timing = { beatId: beat.id, wordStartIndex: cursor, wordEndIndex: cursor + count, startFrame: slice[0].startFrame, endFrame: slice[slice.length - 1].endFrame };
    cursor += count;
    return timing;
  });
}

function normalizeAlignment(input = {}) {
  exactKeys(input, ["schemaVersion", "status", "projectId", "projectRevision", "verticalId", "draftArtifactId", "draftHash", "scriptHash", "narrationManifestArtifactId", "narrationManifestHash", "audioArtifactId", "audioHash", "language", "fps", "durationFrames", "words", "beats", "coverage", "provider", "contentHash"], "alignment");
  const id = (value, field, prefix = "art") => {
    const safe = sanitizeText(value, 100);
    if (prefix === "prj") return validateResourceId(safe, "prj");
    if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe)) fail("NARRATION_ALIGNMENT_FAILED", field);
    return safe;
  };
  const hash = (value, field) => {
    const safe = sanitizeText(value, 80).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(safe)) fail("NARRATION_ALIGNMENT_FAILED", field);
    return safe;
  };
  if (Number(input.schemaVersion) !== 1 || input.status !== "aligned" || input.verticalId !== "dark_curiosity" || Number(input.fps) !== FPS) fail("NARRATION_ALIGNMENT_FAILED", "alignment");
  if (!Array.isArray(input.words) || !Array.isArray(input.beats) || !input.words.length || !input.beats.length) fail("NARRATION_ALIGNMENT_FAILED", "words");
  input.words.forEach((word, index) => exactKeys(word, ["index", "text", "startFrame", "endFrame", "confidence"], `alignment.words[${index}]`));
  input.beats.forEach((beat, index) => exactKeys(beat, ["beatId", "wordStartIndex", "wordEndIndex", "startFrame", "endFrame"], `alignment.beats[${index}]`));
  exactKeys(input.coverage, ["expectedWords", "alignedWords", "exactSequenceMatch", "coverageRatio"], "alignment.coverage");
  exactKeys(input.provider, ["mode", "model", "device", "computeType", "promptVersion"], "alignment.provider");
  const normalized = {
    schemaVersion: 1, status: "aligned", projectId: id(input.projectId, "projectId", "prj"), projectRevision: Number(input.projectRevision), verticalId: "dark_curiosity",
    draftArtifactId: id(input.draftArtifactId, "draftArtifactId"), draftHash: hash(input.draftHash, "draftHash"), scriptHash: hash(input.scriptHash, "scriptHash"),
    narrationManifestArtifactId: id(input.narrationManifestArtifactId, "narrationManifestArtifactId"), narrationManifestHash: hash(input.narrationManifestHash, "narrationManifestHash"),
    audioArtifactId: id(input.audioArtifactId, "audioArtifactId"), audioHash: hash(input.audioHash, "audioHash"), language: sanitizeText(input.language, 12).toLowerCase(), fps: FPS,
    durationFrames: Number(input.durationFrames), words: input.words.map((word) => ({ index: Number(word.index), text: sanitizeText(word.text, 80), startFrame: Number(word.startFrame), endFrame: Number(word.endFrame), confidence: Number(word.confidence) })),
    beats: input.beats.map((beat) => ({ beatId: sanitizeText(beat.beatId, 80), wordStartIndex: Number(beat.wordStartIndex), wordEndIndex: Number(beat.wordEndIndex), startFrame: Number(beat.startFrame), endFrame: Number(beat.endFrame) })),
    coverage: { expectedWords: Number(input.coverage && input.coverage.expectedWords), alignedWords: Number(input.coverage && input.coverage.alignedWords), exactSequenceMatch: input.coverage && input.coverage.exactSequenceMatch === true, coverageRatio: Number(input.coverage && input.coverage.coverageRatio) },
    provider: { mode: sanitizeText(input.provider && input.provider.mode, 60), model: sanitizeText(input.provider && input.provider.model, 80), device: sanitizeText(input.provider && input.provider.device, 40), computeType: sanitizeText(input.provider && input.provider.computeType, 40), promptVersion: sanitizeText(input.provider && input.provider.promptVersion, 80) },
  };
  if (!Number.isInteger(normalized.projectRevision) || normalized.projectRevision < 1 || !Number.isInteger(normalized.durationFrames) || normalized.durationFrames < FPS || normalized.coverage.expectedWords !== normalized.words.length || normalized.coverage.alignedWords !== normalized.words.length || !normalized.coverage.exactSequenceMatch || normalized.coverage.coverageRatio !== 1) fail("NARRATION_ALIGNMENT_FAILED", "coverage");
  if (!normalized.language || normalized.provider.mode !== "local_faster_whisper" || !normalized.provider.model || !normalized.provider.device || !normalized.provider.computeType || normalized.provider.promptVersion !== "narration_alignment_v1") fail("NARRATION_ALIGNMENT_FAILED", "provider");
  let previousWordEnd = 0;
  normalized.words.forEach((word, index) => {
    if (word.index !== index || !word.text || !Number.isInteger(word.startFrame) || !Number.isInteger(word.endFrame) || word.startFrame < previousWordEnd || word.endFrame <= word.startFrame || word.endFrame > normalized.durationFrames || !Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 1) fail("NARRATION_ALIGNMENT_FAILED", `words[${index}]`);
    previousWordEnd = word.endFrame;
  });
  let coveredWords = 0;
  const beatIds = new Set();
  normalized.beats.forEach((beat, index) => {
    if (!beat.beatId || beatIds.has(beat.beatId) || beat.wordStartIndex !== coveredWords || !Number.isInteger(beat.wordEndIndex) || beat.wordEndIndex <= beat.wordStartIndex || beat.wordEndIndex > normalized.words.length) fail("NARRATION_ALIGNMENT_FAILED", `beats[${index}]`);
    const firstWord = normalized.words[beat.wordStartIndex];
    const lastWord = normalized.words[beat.wordEndIndex - 1];
    if (beat.startFrame !== firstWord.startFrame || beat.endFrame !== lastWord.endFrame) fail("NARRATION_ALIGNMENT_FAILED", `beats[${index}]`);
    beatIds.add(beat.beatId);
    coveredWords = beat.wordEndIndex;
  });
  if (coveredWords !== normalized.words.length) fail("NARRATION_ALIGNMENT_FAILED", "beats");
  normalizeNarrationManifest({ providerMode: "uploaded_aligned", voiceProfileId: "aligned_voice", audioArtifactId: normalized.audioArtifactId, audioHash: normalized.audioHash, sampleRate: 48000, durationFrames: normalized.durationFrames, words: normalized.words, rights: { commercialUseAllowed: true, consentReference: "rights_bound_by_narration_manifest" } });
  const calculated = contentHash(normalized);
  if (input.contentHash && input.contentHash !== calculated) fail("NARRATION_ALIGNMENT_FAILED", "contentHash");
  return { ...normalized, contentHash: calculated };
}

function createAlignment({ project, draft, narration, narrationSummary, providerResult, provider }) {
  const expected = scriptWords(draft.script);
  const actual = providerWords(providerResult);
  assertExactScript(expected, actual);
  const framed = frameWords(expected, actual, narration.media.durationSeconds);
  return normalizeAlignment({
    schemaVersion: 1, status: "aligned", projectId: project.id, projectRevision: project.input.revision, verticalId: draft.verticalId,
    draftArtifactId: narration.draftArtifactId, draftHash: narration.draftHash, scriptHash: narration.scriptHash,
    narrationManifestArtifactId: narrationSummary.manifestArtifactId, narrationManifestHash: narrationSummary.manifestHash,
    audioArtifactId: narration.audioArtifactId, audioHash: narration.audioHash, language: narration.language, fps: FPS,
    durationFrames: framed.durationFrames, words: framed.words, beats: beatTimings(draft.script, expected, framed.words),
    coverage: { expectedWords: expected.length, alignedWords: framed.words.length, exactSequenceMatch: true, coverageRatio: 1 },
    provider: { mode: "local_faster_whisper", model: provider.model, device: provider.device, computeType: provider.computeType, promptVersion: "narration_alignment_v1" },
  });
}

function alignmentToNarrationManifest(alignment, narration) {
  const value = normalizeAlignment(alignment);
  return normalizeNarrationManifest({ providerMode: "uploaded_aligned", voiceProfileId: narration.voiceProfileId, audioArtifactId: value.audioArtifactId, audioHash: value.audioHash, sampleRate: narration.media.sampleRate, durationFrames: value.durationFrames, words: value.words, rights: { commercialUseAllowed: narration.rights.commercialUseAllowed, consentReference: narration.rights.consentReference } });
}

module.exports = { FPS, alignmentToNarrationManifest, assertExactScript, createAlignment, normalizeAlignment, normalizeSpeechToken, providerWords, scriptWords };
