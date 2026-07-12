const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { sanitizeText, validateResourceId } = require("../../../repositories/ids.cjs");
const { contentHash } = require("../contracts.cjs");
const { normalizeAlignment } = require("../narration/alignment.cjs");

const CAPTION_PROFILE = "dark_curiosity_word_v1";
const CAPTION_RENDERER_VERSION = "ass_caption_v1";
const CAPTION_PROFILE_VERSION = "1.0.0";
const MAX_WORDS_PER_CUE = 6;
const MAX_CHARS_PER_LINE = 28;
const SAFE_ZONE = Object.freeze({ left: 0.08, right: 0.92, top: 0.58, bottom: 0.86, maxLines: 2 });

function fail(code = "CAPTION_CONTRACT_INVALID", field = "caption") {
  throw new AppError(code, SAFE_MESSAGES[code] || SAFE_MESSAGES.VALIDATION_ERROR, 409, { field });
}

function exactKeys(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CAPTION_CONTRACT_INVALID", field);
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) fail("CAPTION_CONTRACT_INVALID", `${field}.${key}`);
}

function artifactId(value, field) {
  const safe = sanitizeText(value, 100);
  if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe)) fail("CAPTION_CONTRACT_INVALID", field);
  return safe;
}

function hash(value, field) {
  const safe = sanitizeText(value, 80).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(safe)) fail("CAPTION_CONTRACT_INVALID", field);
  return safe;
}

function splitLines(words) {
  const values = words.map((word) => word.text);
  if (values.some((word) => !word || word.length > MAX_CHARS_PER_LINE)) fail("CAPTION_SAFE_ZONE_INVALID", "cues.words.text");
  const joined = values.join(" ");
  if (joined.length <= MAX_CHARS_PER_LINE) return [joined];
  let best = null;
  for (let index = 1; index < values.length; index += 1) {
    const left = values.slice(0, index).join(" ");
    const right = values.slice(index).join(" ");
    if (left.length > MAX_CHARS_PER_LINE || right.length > MAX_CHARS_PER_LINE) continue;
    const score = Math.abs(left.length - right.length);
    if (!best || score < best.score) best = { score, lines: [left, right] };
  }
  if (!best) fail("CAPTION_SAFE_ZONE_INVALID", "cues.lines");
  return best.lines;
}

function groupAlignmentWords(alignmentInput) {
  const alignment = normalizeAlignment(alignmentInput);
  const cues = [];
  for (const beat of alignment.beats) {
    const beatWords = alignment.words.slice(beat.wordStartIndex, beat.wordEndIndex);
    let cursor = 0;
    while (cursor < beatWords.length) {
      let end = Math.min(beatWords.length, cursor + MAX_WORDS_PER_CUE);
      let lines = null;
      while (end > cursor) {
        try { lines = splitLines(beatWords.slice(cursor, end)); break; } catch (error) {
          if (error.code !== "CAPTION_SAFE_ZONE_INVALID") throw error;
          end -= 1;
        }
      }
      if (!lines || end <= cursor) fail("CAPTION_SAFE_ZONE_INVALID", `beats.${beat.beatId}`);
      const slice = beatWords.slice(cursor, end);
      cues.push({
        id: `cue_${String(cues.length + 1).padStart(4, "0")}`,
        beatId: beat.beatId,
        startFrame: slice[0].startFrame,
        endFrame: slice[slice.length - 1].endFrame,
        lines,
        words: slice.map((word) => ({ wordIndex: word.index, text: word.text, startFrame: word.startFrame, endFrame: word.endFrame })),
      });
      cursor = end;
    }
  }
  return cues;
}

function normalizeCaptionManifest(input = {}, options = {}) {
  exactKeys(input, ["schemaVersion", "status", "projectId", "projectRevision", "verticalId", "draftArtifactId", "draftHash", "scriptHash", "narrationManifestArtifactId", "narrationManifestHash", "audioArtifactId", "audioHash", "alignmentArtifactId", "alignmentHash", "fps", "durationFrames", "captionProfile", "profileVersion", "rendererVersion", "cues", "safeZone", "contentHash"], "caption");
  if (Number(input.schemaVersion) !== 1 || input.status !== "ready" || input.verticalId !== "dark_curiosity" || Number(input.fps) !== 30 || input.captionProfile !== CAPTION_PROFILE || input.profileVersion !== CAPTION_PROFILE_VERSION || input.rendererVersion !== CAPTION_RENDERER_VERSION) fail();
  if (!Array.isArray(input.cues) || !input.cues.length) fail("CAPTION_CONTRACT_INVALID", "cues");
  exactKeys(input.safeZone, ["left", "right", "top", "bottom", "maxLines"], "caption.safeZone");
  const normalized = {
    schemaVersion: 1,
    status: "ready",
    projectId: validateResourceId(input.projectId, "prj"),
    projectRevision: Number(input.projectRevision),
    verticalId: "dark_curiosity",
    draftArtifactId: artifactId(input.draftArtifactId, "draftArtifactId"),
    draftHash: hash(input.draftHash, "draftHash"),
    scriptHash: hash(input.scriptHash, "scriptHash"),
    narrationManifestArtifactId: artifactId(input.narrationManifestArtifactId, "narrationManifestArtifactId"),
    narrationManifestHash: hash(input.narrationManifestHash, "narrationManifestHash"),
    audioArtifactId: artifactId(input.audioArtifactId, "audioArtifactId"),
    audioHash: hash(input.audioHash, "audioHash"),
    alignmentArtifactId: artifactId(input.alignmentArtifactId, "alignmentArtifactId"),
    alignmentHash: hash(input.alignmentHash, "alignmentHash"),
    fps: 30,
    durationFrames: Number(input.durationFrames),
    captionProfile: CAPTION_PROFILE,
    profileVersion: CAPTION_PROFILE_VERSION,
    rendererVersion: CAPTION_RENDERER_VERSION,
    cues: input.cues.map((cue, cueIndex) => {
      exactKeys(cue, ["id", "beatId", "startFrame", "endFrame", "lines", "words"], `caption.cues[${cueIndex}]`);
      if (!Array.isArray(cue.lines) || !Array.isArray(cue.words)) fail("CAPTION_CONTRACT_INVALID", `cues[${cueIndex}]`);
      cue.words.forEach((word, wordIndex) => exactKeys(word, ["wordIndex", "text", "startFrame", "endFrame"], `caption.cues[${cueIndex}].words[${wordIndex}]`));
      return {
        id: sanitizeText(cue.id, 40), beatId: sanitizeText(cue.beatId, 80), startFrame: Number(cue.startFrame), endFrame: Number(cue.endFrame),
        lines: cue.lines.map((line) => sanitizeText(line, MAX_CHARS_PER_LINE)),
        words: cue.words.map((word) => ({ wordIndex: Number(word.wordIndex), text: sanitizeText(word.text, 80), startFrame: Number(word.startFrame), endFrame: Number(word.endFrame) })),
      };
    }),
    safeZone: { left: Number(input.safeZone.left), right: Number(input.safeZone.right), top: Number(input.safeZone.top), bottom: Number(input.safeZone.bottom), maxLines: Number(input.safeZone.maxLines) },
  };
  if (!Number.isInteger(normalized.projectRevision) || normalized.projectRevision < 1 || !Number.isInteger(normalized.durationFrames) || normalized.durationFrames < 30 || JSON.stringify(normalized.safeZone) !== JSON.stringify(SAFE_ZONE)) fail("CAPTION_SAFE_ZONE_INVALID", "safeZone");
  let wordCursor = 0;
  let previousCueEnd = 0;
  const beatOrder = [];
  normalized.cues.forEach((cue, cueIndex) => {
    if (cue.id !== `cue_${String(cueIndex + 1).padStart(4, "0")}` || !cue.beatId || !cue.words.length || cue.words.length > MAX_WORDS_PER_CUE || !cue.lines.length || cue.lines.length > SAFE_ZONE.maxLines || cue.lines.some((line) => !line || line.length > MAX_CHARS_PER_LINE) || !Number.isInteger(cue.startFrame) || !Number.isInteger(cue.endFrame) || cue.startFrame < previousCueEnd || cue.endFrame <= cue.startFrame || cue.endFrame > normalized.durationFrames) fail("CAPTION_CONTRACT_INVALID", `cues[${cueIndex}]`);
    if (cue.lines.join(" ") !== cue.words.map((word) => word.text).join(" ")) fail("CAPTION_CONTRACT_INVALID", `cues[${cueIndex}].lines`);
    cue.words.forEach((word, index) => {
      if (word.wordIndex !== wordCursor || !word.text || !Number.isInteger(word.startFrame) || !Number.isInteger(word.endFrame) || word.endFrame <= word.startFrame || (index && word.startFrame < cue.words[index - 1].endFrame)) fail("CAPTION_CONTRACT_INVALID", `cues[${cueIndex}].words[${index}]`);
      wordCursor += 1;
    });
    if (cue.startFrame !== cue.words[0].startFrame || cue.endFrame !== cue.words[cue.words.length - 1].endFrame) fail("CAPTION_CONTRACT_INVALID", `cues[${cueIndex}]`);
    if (beatOrder[beatOrder.length - 1] !== cue.beatId) beatOrder.push(cue.beatId);
    previousCueEnd = cue.endFrame;
  });
  if (options.alignment) {
    const alignment = normalizeAlignment(options.alignment);
    const cueWords = normalized.cues.flatMap((cue) => cue.words);
    if (alignment.durationFrames !== normalized.durationFrames || cueWords.length !== alignment.words.length || alignment.beats.map((beat) => beat.beatId).join("|") !== beatOrder.join("|")) fail("CAPTION_ALIGNMENT_REQUIRED", "alignment");
    cueWords.forEach((word, index) => {
      const aligned = alignment.words[index];
      const beat = alignment.beats.find((item) => index >= item.wordStartIndex && index < item.wordEndIndex);
      const cue = normalized.cues.find((item) => item.words.some((value) => value.wordIndex === index));
      if (!aligned || word.text !== aligned.text || word.startFrame !== aligned.startFrame || word.endFrame !== aligned.endFrame || !beat || !cue || cue.beatId !== beat.beatId) fail("CAPTION_ALIGNMENT_REQUIRED", `words[${index}]`);
    });
  }
  const calculated = contentHash(normalized);
  if (input.contentHash && input.contentHash !== calculated) fail("CAPTION_CONTRACT_INVALID", "contentHash");
  return { ...normalized, contentHash: calculated };
}

function createCaptionManifest({ alignment: rawAlignment, alignmentArtifactId, alignmentHash }) {
  const alignment = normalizeAlignment(rawAlignment);
  return normalizeCaptionManifest({
    schemaVersion: 1, status: "ready", projectId: alignment.projectId, projectRevision: alignment.projectRevision, verticalId: alignment.verticalId,
    draftArtifactId: alignment.draftArtifactId, draftHash: alignment.draftHash, scriptHash: alignment.scriptHash,
    narrationManifestArtifactId: alignment.narrationManifestArtifactId, narrationManifestHash: alignment.narrationManifestHash,
    audioArtifactId: alignment.audioArtifactId, audioHash: alignment.audioHash, alignmentArtifactId, alignmentHash,
    fps: 30, durationFrames: alignment.durationFrames, captionProfile: CAPTION_PROFILE, profileVersion: CAPTION_PROFILE_VERSION, rendererVersion: CAPTION_RENDERER_VERSION,
    cues: groupAlignmentWords(alignment), safeZone: SAFE_ZONE,
  }, { alignment });
}

module.exports = { CAPTION_PROFILE, CAPTION_PROFILE_VERSION, CAPTION_RENDERER_VERSION, MAX_CHARS_PER_LINE, MAX_WORDS_PER_CUE, SAFE_ZONE, createCaptionManifest, groupAlignmentWords, normalizeCaptionManifest, splitLines };
