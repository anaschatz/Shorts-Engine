const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../../errors.cjs");
const { contentHash } = require("../../contracts.cjs");

const TTS_PROVENANCE_SCHEMA = "dark_curiosity_tts_provenance_v1";
const BUILT_IN_OPENAI_VOICES = Object.freeze(["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"]);

function fail(code, field, status = 400) {
  throw new AppError(code, SAFE_MESSAGES[code] || "AI narration validation failed.", status, field ? { field } : null);
}
function exact(value, keys, field) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("TTS_PROVENANCE_INVALID", field); const allowed = new Set(keys); for (const key of Object.keys(value)) if (!allowed.has(key)) fail("TTS_PROVENANCE_INVALID", `${field}.${key}`); }
function text(value, field, max = 240) { const safe = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max); if (!safe) fail("TTS_PROVENANCE_INVALID", field); return safe; }
function hash(value, field) { const safe = String(value || "").toLowerCase().replace(/^sha256:/, ""); if (!/^[a-f0-9]{64}$/.test(safe)) fail("TTS_PROVENANCE_INVALID", field); return safe; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function normalizeSynthesisRequest(input = {}) {
  const script = text(input.script, "script", 4096);
  const provider = text(input.provider, "provider", 40).toLowerCase();
  if (!["openai", "mock"].includes(provider)) fail("TTS_PROVIDER_UNSUPPORTED", "provider");
  const voiceId = text(input.voiceId, "voiceId", 100).toLowerCase();
  if (input.voiceCloned === true || input.impersonated === true) fail("TTS_VOICE_PROHIBITED", "voiceId", 409);
  if (provider === "openai" && !BUILT_IN_OPENAI_VOICES.includes(voiceId)) fail("TTS_VOICE_PROHIBITED", "voiceId", 409);
  const speakingRate = Number(input.speakingRate ?? 1);
  if (!Number.isFinite(speakingRate) || speakingRate < 0.25 || speakingRate > 4) fail("TTS_PROVENANCE_INVALID", "speakingRate");
  const language = text(input.language || "en", "language", 20).toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/.test(language)) fail("TTS_PROVENANCE_INVALID", "language");
  return {
    provider, model: text(input.model || (provider === "openai" ? "gpt-4o-mini-tts" : "deterministic-tone-v1"), "model", 100),
    voiceId, language, speakingRate: Number(speakingRate.toFixed(2)), script, scriptHash: sha256(script),
    voiceCloned: false, impersonated: false,
  };
}

function normalizeTtsProvenance(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("TTS_PROVENANCE_INVALID", "manifest");
  exact(input, ["schemaVersion", "projectId", "runId", "script", "provider", "model", "voiceId", "language", "speakingRate", "synthesizedAt", "providerRequestId", "license", "voiceCloned", "impersonated", "audio", "dryRun", "publishable", "blockerCodes", "contentHash"], "manifest");
  if (input.schemaVersion !== TTS_PROVENANCE_SCHEMA) fail("TTS_PROVENANCE_INVALID", "schemaVersion");
  exact(input.script, ["path", "sha256", "approvalReference", "approved"], "script"); exact(input.license, ["termsReference", "commercialUseAttested", "attestedBy"], "license"); exact(input.audio, ["path", "sha256", "container", "codec", "sampleRate", "channels", "durationSeconds", "bytes", "validated"], "audio");
  const provider = text(input.provider, "provider", 40).toLowerCase();
  if (!["openai", "mock"].includes(provider)) fail("TTS_PROVIDER_UNSUPPORTED", "provider");
  const audio = input.audio || {};
  const normalized = {
    schemaVersion: TTS_PROVENANCE_SCHEMA,
    projectId: text(input.projectId, "projectId", 120),
    runId: text(input.runId, "runId", 80),
    script: { path: text(input.script && input.script.path, "script.path", 500), sha256: hash(input.script && input.script.sha256, "script.sha256"), approvalReference: text(input.script && input.script.approvalReference, "script.approvalReference", 160), approved: input.script && input.script.approved === true },
    provider, model: text(input.model, "model", 100), voiceId: text(input.voiceId, "voiceId", 100), language: text(input.language, "language", 20).toLowerCase(), speakingRate: Number(input.speakingRate),
    synthesizedAt: text(input.synthesizedAt, "synthesizedAt", 40), providerRequestId: input.providerRequestId ? text(input.providerRequestId, "providerRequestId", 160) : null,
    license: { termsReference: text(input.license && input.license.termsReference, "license.termsReference", 500), commercialUseAttested: input.license && input.license.commercialUseAttested === true, attestedBy: text(input.license && input.license.attestedBy, "license.attestedBy", 160) },
    voiceCloned: input.voiceCloned === true, impersonated: input.impersonated === true,
    audio: { path: text(audio.path, "audio.path", 500), sha256: hash(audio.sha256, "audio.sha256"), container: text(audio.container, "audio.container", 20).toLowerCase(), codec: text(audio.codec, "audio.codec", 40).toLowerCase(), sampleRate: Number(audio.sampleRate), channels: Number(audio.channels), durationSeconds: Number(audio.durationSeconds), bytes: Number(audio.bytes), validated: audio.validated === true },
    dryRun: input.dryRun === true,
  };
  if (!Number.isFinite(Date.parse(normalized.synthesizedAt))) fail("TTS_PROVENANCE_INVALID", "synthesizedAt");
  if (normalized.script.path.startsWith("/") || normalized.script.path.split(/[\\/]/).includes("..") || normalized.audio.path !== "narration.wav") fail("TTS_PROVENANCE_INVALID", "artifact.path");
  if (!Number.isFinite(normalized.speakingRate) || normalized.speakingRate < 0.25 || normalized.speakingRate > 4) fail("TTS_PROVENANCE_INVALID", "speakingRate");
  if (normalized.audio.container !== "wav" || !["pcm_s16le", "pcm_s24le", "pcm_s32le"].includes(normalized.audio.codec) || normalized.audio.sampleRate !== 48000 || normalized.audio.channels !== 1 || !(normalized.audio.durationSeconds > 0) || !(normalized.audio.bytes > 44)) fail("TTS_AUDIO_INVALID", "audio", 415);
  const blockerCodes = [];
  if (!normalized.script.approved) blockerCodes.push("TTS_SCRIPT_NOT_APPROVED");
  if (!normalized.license.commercialUseAttested) blockerCodes.push("TTS_COMMERCIAL_ATTESTATION_REQUIRED");
  if (normalized.voiceCloned || normalized.impersonated) blockerCodes.push("TTS_VOICE_PROHIBITED");
  if (!normalized.audio.validated) blockerCodes.push("TTS_AUDIO_INVALID");
  if (provider === "mock") blockerCodes.push("TTS_MOCK_NON_PUBLISHABLE");
  if (normalized.dryRun) blockerCodes.push("TTS_DRY_RUN_NON_PUBLISHABLE");
  const publishable = blockerCodes.length === 0;
  const body = { ...normalized, publishable, blockerCodes: [...new Set(blockerCodes)].sort() };
  const calculated = contentHash(body);
  if (input.contentHash && hash(input.contentHash, "contentHash") !== calculated) fail("TTS_PROVENANCE_MISMATCH", "contentHash", 409);
  return { ...body, contentHash: calculated };
}

module.exports = { BUILT_IN_OPENAI_VOICES, TTS_PROVENANCE_SCHEMA, normalizeSynthesisRequest, normalizeTtsProvenance, sha256 };
