const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { sanitizeText, validateResourceId } = require("../../../repositories/ids.cjs");
const { contentHash } = require("../contracts.cjs");
const { normalizeAlignment } = require("../narration/alignment.cjs");
const { TTS_PROVENANCE_SCHEMA_V3 } = require("../narration/tts/contract.cjs");
const { DARK_CURIOSITY_COMPREHENSION_PROFILE } = require("../narration/tts/pacing-plan.cjs");

const CAPTION_PROFILE = "dark_curiosity_word_v1";
const CAPTION_RENDERER_VERSION = "ass_caption_v1";
const CAPTION_PROFILE_VERSION = "1.1.0";
const LEGACY_CAPTION_PROFILE_VERSION = "1.0.0";
const MAX_WORDS_PER_CUE = 6;
const TARGET_MIN_WORDS_PER_CUE = 3;
const TARGET_MAX_WORDS_PER_CUE = 5;
const ACOUSTIC_GAP_FRAMES = 9;
const MAX_CHARS_PER_LINE = 28;
const SAFE_ZONE = Object.freeze({ left: 0.08, right: 0.92, top: 0.58, bottom: 0.86, maxLines: 2 });
const WEAK_CUE_ENDINGS = new Set(["a", "an", "the", "and", "as", "but", "for", "nor", "or", "so", "that", "yet"]);

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

function normalizedBoundaryToken(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

function endsSentence(value) {
  return /[.!?](?:["'’”\)\]]*)$/u.test(String(value || "").trim());
}

function endsClause(value) {
  return /[,;:](?:["'’”\)\]]*)$/u.test(String(value || "").trim());
}

function isForcedBoundary(left, right, semanticBoundarySet = new Set()) {
  const rightWordIndex = right && Number.isInteger(right.index) ? right.index : right && right.wordIndex;
  return !right || semanticBoundarySet.has(rightWordIndex) || endsSentence(left.text) || right.startFrame - left.endFrame >= ACOUSTIC_GAP_FRAMES;
}

function semanticBoundarySet(values, wordCount, field = "semanticBoundaryWordIndices") {
  if (!Array.isArray(values)) fail("CAPTION_CONTRACT_INVALID", field);
  const result = new Set();
  let previous = 0;
  values.forEach((raw, index) => {
    const boundary = Number(raw);
    if (!Number.isInteger(boundary) || boundary <= previous || boundary >= wordCount) fail("CAPTION_CONTRACT_INVALID", `${field}[${index}]`);
    result.add(boundary);
    previous = boundary;
  });
  return result;
}

function captionPacingFromNarration(narration) {
  const provenance = narration && narration.ttsProvenance;
  if (!provenance || provenance.schemaVersion !== TTS_PROVENANCE_SCHEMA_V3 || !provenance.pacing) return null;
  return {
    profile: provenance.pacing.profile,
    planHash: provenance.pacing.planHash,
    semanticBoundaryWordIndices: [...provenance.pacing.semanticBoundaryWordIndices],
  };
}

function cueSizePenalty(size) {
  if (size === 1) return 100;
  if (size === 2) return 18;
  if (size === 3) return 2;
  if (size === 4) return 0;
  if (size === 5) return 1;
  return 8;
}

function betterGrouping(candidate, current) {
  if (!current || candidate.score !== current.score) return !current || candidate.score < current.score;
  if (candidate.slices.length !== current.slices.length) return candidate.slices.length < current.slices.length;
  for (let index = 0; index < candidate.slices.length; index += 1) {
    if (candidate.slices[index].length !== current.slices[index].length) return candidate.slices[index].length > current.slices[index].length;
  }
  return false;
}

function groupBoundedWords(words, beatId) {
  const best = new Array(words.length + 1).fill(null);
  best[words.length] = { score: 0, slices: [] };
  for (let cursor = words.length - 1; cursor >= 0; cursor -= 1) {
    for (let size = 1; size <= MAX_WORDS_PER_CUE && cursor + size <= words.length; size += 1) {
      const end = cursor + size;
      if (!best[end]) continue;
      const slice = words.slice(cursor, end);
      let lines;
      try { lines = splitLines(slice); } catch (error) {
        if (error.code === "CAPTION_SAFE_ZONE_INVALID") continue;
        throw error;
      }
      const weakEnding = WEAK_CUE_ENDINGS.has(normalizedBoundaryToken(slice.at(-1).text));
      const weakStarting = cursor > 0 && !endsClause(words[cursor - 1].text) && WEAK_CUE_ENDINGS.has(normalizedBoundaryToken(slice[0].text));
      const internalClauseBreak = slice.slice(0, -1).some((word) => endsClause(word.text));
      const candidate = {
        score: best[end].score + 2 + cueSizePenalty(size) + (weakEnding ? 30 : 0) + (weakStarting ? 12 : 0) + (internalClauseBreak ? 18 : 0),
        slices: [{ words: slice, lines, length: size }, ...best[end].slices],
      };
      if (betterGrouping(candidate, best[cursor])) best[cursor] = candidate;
    }
  }
  if (!best[0]) fail("CAPTION_SAFE_ZONE_INVALID", `beats.${beatId}`);
  return best[0].slices;
}

function boundedSegments(words, semanticBoundaries) {
  const segments = [];
  let start = 0;
  for (let index = 0; index < words.length; index += 1) {
    if (!isForcedBoundary(words[index], words[index + 1], semanticBoundaries)) continue;
    segments.push(words.slice(start, index + 1));
    start = index + 1;
  }
  return segments;
}

function groupAlignmentWords(alignmentInput, options = {}) {
  const alignment = normalizeAlignment(alignmentInput);
  const semanticBoundaries = semanticBoundarySet(options.semanticBoundaryWordIndices || [], alignment.words.length);
  const cues = [];
  for (const beat of alignment.beats) {
    const beatWords = alignment.words.slice(beat.wordStartIndex, beat.wordEndIndex);
    const grouped = boundedSegments(beatWords, semanticBoundaries).flatMap((segment) => groupBoundedWords(segment, beat.beatId));
    for (const group of grouped) {
      const slice = group.words;
      cues.push({
        id: `cue_${String(cues.length + 1).padStart(4, "0")}`,
        beatId: beat.beatId,
        startFrame: slice[0].startFrame,
        endFrame: slice[slice.length - 1].endFrame,
        lines: group.lines,
        words: slice.map((word) => ({ wordIndex: word.index, text: word.text, startFrame: word.startFrame, endFrame: word.endFrame })),
      });
    }
  }
  return cues;
}

function normalizeCaptionManifestV1_1(input = {}, options = {}, compatibility = {}) {
  exactKeys(input, ["schemaVersion", "status", "projectId", "projectRevision", "verticalId", "draftArtifactId", "draftHash", "scriptHash", "narrationManifestArtifactId", "narrationManifestHash", "audioArtifactId", "audioHash", "alignmentArtifactId", "alignmentHash", "fps", "durationFrames", "captionProfile", "profileVersion", "rendererVersion", "pacingProfile", "pacingPlanHash", "semanticBoundaryWordIndices", "cues", "safeZone", "contentHash"], "caption");
  if (Number(input.schemaVersion) !== 1 || input.status !== "ready" || input.verticalId !== "dark_curiosity" || Number(input.fps) !== 30 || input.captionProfile !== CAPTION_PROFILE || input.profileVersion !== CAPTION_PROFILE_VERSION || input.rendererVersion !== CAPTION_RENDERER_VERSION) fail();
  if (!Array.isArray(input.cues) || !input.cues.length) fail("CAPTION_CONTRACT_INVALID", "cues");
  exactKeys(input.safeZone, ["left", "right", "top", "bottom", "maxLines"], "caption.safeZone");
  const pacingProfile = input.pacingProfile == null ? null : sanitizeText(input.pacingProfile, 80).toLowerCase();
  const pacingPlanHash = input.pacingPlanHash == null ? null : hash(input.pacingPlanHash, "pacingPlanHash");
  const rawSemanticBoundaries = input.semanticBoundaryWordIndices;
  if ((pacingProfile === null) !== (pacingPlanHash === null) || (!pacingProfile && Array.isArray(rawSemanticBoundaries) && rawSemanticBoundaries.length) || (pacingProfile && pacingProfile !== DARK_CURIOSITY_COMPREHENSION_PROFILE)) fail("CAPTION_CONTRACT_INVALID", "semanticPacing");
  if (!Array.isArray(rawSemanticBoundaries)) fail("CAPTION_CONTRACT_INVALID", "semanticBoundaryWordIndices");
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
    pacingProfile,
    pacingPlanHash,
    semanticBoundaryWordIndices: rawSemanticBoundaries.map(Number),
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
  const totalCaptionWords = normalized.cues.reduce((sum, cue) => sum + cue.words.length, 0);
  const semanticBoundaries = semanticBoundarySet(normalized.semanticBoundaryWordIndices, totalCaptionWords);
  if ((pacingProfile === null) !== (semanticBoundaries.size === 0)) fail("CAPTION_CONTRACT_INVALID", "semanticPacing");
  normalized.cues.forEach((cue, cueIndex) => {
    if (cue.id !== `cue_${String(cueIndex + 1).padStart(4, "0")}` || !cue.beatId || !cue.words.length || cue.words.length > MAX_WORDS_PER_CUE || !cue.lines.length || cue.lines.length > SAFE_ZONE.maxLines || cue.lines.some((line) => !line || line.length > MAX_CHARS_PER_LINE) || !Number.isInteger(cue.startFrame) || !Number.isInteger(cue.endFrame) || cue.startFrame < previousCueEnd || cue.endFrame <= cue.startFrame || cue.endFrame > normalized.durationFrames) fail("CAPTION_CONTRACT_INVALID", `cues[${cueIndex}]`);
    if (cue.lines.join(" ") !== cue.words.map((word) => word.text).join(" ")) fail("CAPTION_CONTRACT_INVALID", `cues[${cueIndex}].lines`);
    cue.words.forEach((word, index) => {
      const previousWord = cue.words[index - 1];
      if (word.wordIndex !== wordCursor || !word.text || !Number.isInteger(word.startFrame) || !Number.isInteger(word.endFrame) || word.endFrame <= word.startFrame || (index && word.startFrame < previousWord.endFrame) || (index && compatibility.enforceNaturalBoundaries !== false && isForcedBoundary(previousWord, word, semanticBoundaries))) fail("CAPTION_CONTRACT_INVALID", `cues[${cueIndex}].words[${index}]`);
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
  if (Object.prototype.hasOwnProperty.call(options, "narration")) {
    const expectedPacing = captionPacingFromNarration(options.narration);
    const expectedProfile = expectedPacing ? expectedPacing.profile : null;
    const expectedHash = expectedPacing ? expectedPacing.planHash : null;
    const expectedBoundaries = expectedPacing ? expectedPacing.semanticBoundaryWordIndices : [];
    if (normalized.pacingProfile !== expectedProfile || normalized.pacingPlanHash !== expectedHash || normalized.semanticBoundaryWordIndices.length !== expectedBoundaries.length || normalized.semanticBoundaryWordIndices.some((value, index) => value !== expectedBoundaries[index])) fail("CAPTION_CONTRACT_INVALID", "semanticPacing");
  }
  const calculated = contentHash(normalized);
  if (input.contentHash && input.contentHash !== calculated) fail("CAPTION_CONTRACT_INVALID", "contentHash");
  return { ...normalized, contentHash: calculated };
}

function normalizeCaptionManifest(input = {}, options = {}) {
  return normalizeCaptionManifestV1_1(input, options);
}

function normalizeLegacyCaptionManifest(input = {}, options = {}) {
  exactKeys(input, ["schemaVersion", "status", "projectId", "projectRevision", "verticalId", "draftArtifactId", "draftHash", "scriptHash", "narrationManifestArtifactId", "narrationManifestHash", "audioArtifactId", "audioHash", "alignmentArtifactId", "alignmentHash", "fps", "durationFrames", "captionProfile", "profileVersion", "rendererVersion", "cues", "safeZone", "contentHash"], "caption");
  if (input.profileVersion !== LEGACY_CAPTION_PROFILE_VERSION) fail("CAPTION_CONTRACT_INVALID", "profileVersion");
  if (Object.prototype.hasOwnProperty.call(options, "narration")) fail("CAPTION_CONTRACT_INVALID", "semanticPacing");
  const adapted = {
    ...input,
    profileVersion: CAPTION_PROFILE_VERSION,
    pacingProfile: null,
    pacingPlanHash: null,
    semanticBoundaryWordIndices: [],
    contentHash: undefined,
  };
  const current = normalizeCaptionManifestV1_1(adapted, options, { enforceNaturalBoundaries: false });
  const {
    pacingProfile: _pacingProfile,
    pacingPlanHash: _pacingPlanHash,
    semanticBoundaryWordIndices: _semanticBoundaryWordIndices,
    contentHash: _currentContentHash,
    ...normalized
  } = current;
  normalized.profileVersion = LEGACY_CAPTION_PROFILE_VERSION;
  const calculated = contentHash(normalized);
  if (input.contentHash && input.contentHash !== calculated) fail("CAPTION_CONTRACT_INVALID", "contentHash");
  return { ...normalized, contentHash: calculated };
}

function normalizeCaptionManifestForRead(input = {}, options = {}) {
  if (input && input.profileVersion === LEGACY_CAPTION_PROFILE_VERSION) return normalizeLegacyCaptionManifest(input, options);
  return normalizeCaptionManifest(input, options);
}

function createCaptionManifest({ alignment: rawAlignment, alignmentArtifactId, alignmentHash, narration = null }) {
  const alignment = normalizeAlignment(rawAlignment);
  const pacing = captionPacingFromNarration(narration);
  const semanticBoundaryWordIndices = pacing ? pacing.semanticBoundaryWordIndices : [];
  return normalizeCaptionManifest({
    schemaVersion: 1, status: "ready", projectId: alignment.projectId, projectRevision: alignment.projectRevision, verticalId: alignment.verticalId,
    draftArtifactId: alignment.draftArtifactId, draftHash: alignment.draftHash, scriptHash: alignment.scriptHash,
    narrationManifestArtifactId: alignment.narrationManifestArtifactId, narrationManifestHash: alignment.narrationManifestHash,
    audioArtifactId: alignment.audioArtifactId, audioHash: alignment.audioHash, alignmentArtifactId, alignmentHash,
    fps: 30, durationFrames: alignment.durationFrames, captionProfile: CAPTION_PROFILE, profileVersion: CAPTION_PROFILE_VERSION, rendererVersion: CAPTION_RENDERER_VERSION,
    pacingProfile: pacing ? pacing.profile : null, pacingPlanHash: pacing ? pacing.planHash : null, semanticBoundaryWordIndices,
    cues: groupAlignmentWords(alignment, { semanticBoundaryWordIndices }), safeZone: SAFE_ZONE,
  }, { alignment, narration });
}

module.exports = { ACOUSTIC_GAP_FRAMES, CAPTION_PROFILE, CAPTION_PROFILE_VERSION, CAPTION_RENDERER_VERSION, LEGACY_CAPTION_PROFILE_VERSION, MAX_CHARS_PER_LINE, MAX_WORDS_PER_CUE, SAFE_ZONE, TARGET_MAX_WORDS_PER_CUE, TARGET_MIN_WORDS_PER_CUE, captionPacingFromNarration, createCaptionManifest, groupAlignmentWords, normalizeCaptionManifest, normalizeCaptionManifestForRead, splitLines };
