const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { sanitizeText, validateResourceId } = require("../../../repositories/ids.cjs");
const { contentHash } = require("../contracts.cjs");

const OWNERSHIP_BASES = Object.freeze(["self_recorded", "licensed_recording"]);
const NARRATION_STATUSES = Object.freeze(["uploaded_unaligned"]);
const PCM_CODECS = Object.freeze(["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le"]);

function fail(code, message, field, status = 400) {
  throw new AppError(code, message || SAFE_MESSAGES[code] || SAFE_MESSAGES.VALIDATION_ERROR, status, field ? { field } : null);
}

function assertObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("VALIDATION_ERROR", null, field);
  return value;
}

function assertKeys(value, allowed, field) {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) fail("VALIDATION_ERROR", null, `${field}.${key}`);
}

function artifactId(value, field) {
  const safe = sanitizeText(value, 100);
  if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe)) fail("VALIDATION_ERROR", null, field);
  return safe;
}

function hash(value, field) {
  const safe = sanitizeText(value, 80).toLowerCase().replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(safe)) fail("VALIDATION_ERROR", null, field);
  return safe;
}

function requiredText(value, field, maxLength = 160) {
  const safe = sanitizeText(value, maxLength);
  if (!safe) fail("NARRATION_RIGHTS_REQUIRED", SAFE_MESSAGES.NARRATION_RIGHTS_REQUIRED, field);
  return safe;
}

function finiteNumber(value, field, min, max, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) fail("VALIDATION_ERROR", null, field);
  return Number(number.toFixed(digits));
}

function integer(value, field, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail("VALIDATION_ERROR", null, field);
  return number;
}

function normalizeNarrationRights(input = {}) {
  const rights = assertObject(input, "rights");
  assertKeys(rights, ["commercialUseAllowed", "ownershipBasis", "rightsHolder", "consentReference", "licenseReference"], "rights");
  if (rights.commercialUseAllowed !== true) fail("NARRATION_RIGHTS_REQUIRED", SAFE_MESSAGES.NARRATION_RIGHTS_REQUIRED, "rights.commercialUseAllowed");
  const ownershipBasis = sanitizeText(rights.ownershipBasis, 40).toLowerCase();
  if (!OWNERSHIP_BASES.includes(ownershipBasis)) fail("NARRATION_RIGHTS_REQUIRED", SAFE_MESSAGES.NARRATION_RIGHTS_REQUIRED, "rights.ownershipBasis");
  const licenseReference = sanitizeText(rights.licenseReference || "", 200) || null;
  if (ownershipBasis === "licensed_recording" && !licenseReference) {
    fail("NARRATION_RIGHTS_REQUIRED", SAFE_MESSAGES.NARRATION_RIGHTS_REQUIRED, "rights.licenseReference");
  }
  return {
    commercialUseAllowed: true,
    ownershipBasis,
    rightsHolder: requiredText(rights.rightsHolder, "rights.rightsHolder", 160),
    consentReference: requiredText(rights.consentReference, "rights.consentReference", 200),
    licenseReference,
  };
}

function normalizeNarrationMedia(input = {}) {
  const media = assertObject(input, "media");
  assertKeys(media, ["container", "codec", "sampleRate", "channels", "durationSeconds", "bytes"], "media");
  const container = sanitizeText(media.container, 20).toLowerCase();
  if (container !== "wav") fail("NARRATION_WAV_INVALID", SAFE_MESSAGES.NARRATION_WAV_INVALID, "media.container", 415);
  const codec = sanitizeText(media.codec, 40).toLowerCase();
  if (!PCM_CODECS.includes(codec)) fail("NARRATION_AUDIO_UNSUPPORTED", SAFE_MESSAGES.NARRATION_AUDIO_UNSUPPORTED, "media.codec", 415);
  const sampleRate = integer(media.sampleRate, "media.sampleRate", 1, 384000);
  const channels = integer(media.channels, "media.channels", 1, 2);
  const durationSeconds = finiteNumber(media.durationSeconds, "media.durationSeconds", 0.0001, 120, 4);
  const bytes = integer(media.bytes, "media.bytes", 1, 32 * 1024 * 1024);
  return { container, codec, sampleRate, channels, durationSeconds, bytes };
}

function normalizeNarrationAsset(input = {}) {
  const asset = assertObject(input, "narration");
  assertKeys(asset, [
    "schemaVersion", "status", "projectId", "projectRevision", "verticalId", "draftArtifactId", "draftHash",
    "scriptHash", "audioArtifactId", "audioHash", "voiceProfileId", "language", "media", "rights", "contentHash",
  ], "narration");
  if (Number(asset.schemaVersion) !== 1) fail("VALIDATION_ERROR", null, "narration.schemaVersion");
  const status = sanitizeText(asset.status || "uploaded_unaligned", 40).toLowerCase();
  if (!NARRATION_STATUSES.includes(status)) fail("VALIDATION_ERROR", null, "narration.status");
  const projectRevision = integer(asset.projectRevision, "narration.projectRevision", 1, 1_000_000);
  const verticalId = sanitizeText(asset.verticalId, 60).toLowerCase();
  if (verticalId !== "dark_curiosity") fail("VALIDATION_ERROR", null, "narration.verticalId");
  const language = sanitizeText(asset.language, 12).toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/.test(language)) fail("VALIDATION_ERROR", null, "narration.language");
  const normalized = {
    schemaVersion: 1,
    status,
    projectId: validateResourceId(asset.projectId, "prj"),
    projectRevision,
    verticalId,
    draftArtifactId: artifactId(asset.draftArtifactId, "narration.draftArtifactId"),
    draftHash: hash(asset.draftHash, "narration.draftHash"),
    scriptHash: hash(asset.scriptHash, "narration.scriptHash"),
    audioArtifactId: artifactId(asset.audioArtifactId, "narration.audioArtifactId"),
    audioHash: hash(asset.audioHash, "narration.audioHash"),
    voiceProfileId: requiredText(asset.voiceProfileId, "narration.voiceProfileId", 80),
    language,
    media: normalizeNarrationMedia(asset.media),
    rights: normalizeNarrationRights(asset.rights),
  };
  const calculated = contentHash(normalized);
  if (asset.contentHash && hash(asset.contentHash, "narration.contentHash") !== calculated) {
    fail("ARTIFACT_CONTENT_INVALID", "Narration contract hash is invalid.", "narration.contentHash", 409);
  }
  return { ...normalized, contentHash: calculated };
}

function publicNarrationSummary(input = {}) {
  const manifest = normalizeNarrationAsset(input.manifest || input);
  return {
    status: manifest.status,
    projectRevision: manifest.projectRevision,
    manifestArtifactId: input.manifestArtifactId ? artifactId(input.manifestArtifactId, "manifestArtifactId") : null,
    manifestHash: input.manifestHash ? hash(input.manifestHash, "manifestHash") : null,
    audioArtifactId: manifest.audioArtifactId,
    audioHash: manifest.audioHash,
    draftArtifactId: manifest.draftArtifactId,
    draftHash: manifest.draftHash,
    scriptHash: manifest.scriptHash,
    voiceProfileId: manifest.voiceProfileId,
    language: manifest.language,
    media: manifest.media,
    rights: {
      commercialUseAllowed: true,
      ownershipBasis: manifest.rights.ownershipBasis,
      consentDeclared: Boolean(manifest.rights.consentReference),
      licenseDeclared: Boolean(manifest.rights.licenseReference),
    },
    aligned: false,
    renderReady: false,
  };
}

module.exports = {
  NARRATION_STATUSES,
  OWNERSHIP_BASES,
  PCM_CODECS,
  normalizeNarrationAsset,
  normalizeNarrationMedia,
  normalizeNarrationRights,
  publicNarrationSummary,
};
