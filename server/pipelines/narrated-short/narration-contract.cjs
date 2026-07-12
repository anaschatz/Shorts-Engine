const { AppError, SAFE_MESSAGES } = require("../../errors.cjs");
const { contentHash } = require("./contracts.cjs");
const { sanitizeText } = require("../../repositories/ids.cjs");

function fail(field, message = SAFE_MESSAGES.VALIDATION_ERROR) {
  throw new AppError("VALIDATION_ERROR", message, 400, { field });
}

function integer(value, field, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail(field);
  return number;
}

function normalizeNarrationManifest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("narrationManifest");
  const audioArtifactId = sanitizeText(input.audioArtifactId, 100);
  if (!/^art_[A-Za-z0-9-]{8,80}$/.test(audioArtifactId)) fail("audioArtifactId");
  const audioHash = sanitizeText(input.audioHash, 80).toLowerCase().replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(audioHash)) fail("audioHash");
  const durationFrames = integer(input.durationFrames, "durationFrames", 30, 30 * 180);
  const words = (Array.isArray(input.words) ? input.words : []).map((word, index) => {
    const text = sanitizeText(word && word.text, 48);
    if (!text) fail(`words[${index}].text`);
    const startFrame = integer(word.startFrame, `words[${index}].startFrame`, 0, durationFrames - 1);
    const endFrame = integer(word.endFrame, `words[${index}].endFrame`, 1, durationFrames);
    if (endFrame <= startFrame) fail(`words[${index}]`);
    return { text, startFrame, endFrame };
  });
  if (!words.length || words.length > 400) fail("words");
  for (let index = 1; index < words.length; index += 1) {
    if (words[index].startFrame < words[index - 1].endFrame) fail(`words[${index}].startFrame`, "Narration words must not overlap.");
  }
  if (words[words.length - 1].endFrame > durationFrames) fail("words");
  const normalized = {
    schemaVersion: 1,
    providerMode: sanitizeText(input.providerMode || "uploaded", 40).toLowerCase(),
    voiceProfileId: sanitizeText(input.voiceProfileId || "voice_default", 80),
    audioArtifactId,
    audioHash,
    sampleRate: integer(input.sampleRate || 48000, "sampleRate", 8000, 192000),
    durationFrames,
    words,
    rights: {
      commercialUseAllowed: input.rights && input.rights.commercialUseAllowed === true,
      consentReference: sanitizeText(input.rights && input.rights.consentReference || "", 120),
    },
  };
  if (!normalized.rights.commercialUseAllowed || !normalized.rights.consentReference) fail("rights", "Narration commercial-use rights are required.");
  return { ...normalized, contentHash: contentHash(normalized) };
}

module.exports = {
  normalizeNarrationManifest,
};
