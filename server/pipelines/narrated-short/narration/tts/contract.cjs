const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../../errors.cjs");
const { contentHash } = require("../../contracts.cjs");
const { DARK_CURIOSITY_COMPREHENSION_PROFILE, normalizePacingPlan } = require("./pacing-plan.cjs");

const TTS_PROVENANCE_SCHEMA_V1 = "dark_curiosity_tts_provenance_v1";
const TTS_PROVENANCE_SCHEMA_V2 = "dark_curiosity_tts_provenance_v2";
const TTS_PROVENANCE_SCHEMA_V3 = "dark_curiosity_tts_provenance_v3";
const TTS_PROVENANCE_SCHEMA = TTS_PROVENANCE_SCHEMA_V3;
const BUILT_IN_OPENAI_VOICES = Object.freeze(["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"]);
const KOKORO_VOICES = Object.freeze(["af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis"]);

function fail(code, field, status = 400) {
  throw new AppError(code, SAFE_MESSAGES[code] || "AI narration validation failed.", status, field ? { field } : null);
}
function exact(value, keys, field) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("TTS_PROVENANCE_INVALID", field); const allowed = new Set(keys); for (const key of Object.keys(value)) if (!allowed.has(key)) fail("TTS_PROVENANCE_INVALID", `${field}.${key}`); }
function text(value, field, max = 240) { const safe = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max); if (!safe) fail("TTS_PROVENANCE_INVALID", field); return safe; }
function hash(value, field) { const safe = String(value || "").toLowerCase().replace(/^sha256:/, ""); if (!/^[a-f0-9]{64}$/.test(safe)) fail("TTS_PROVENANCE_INVALID", field); return safe; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function semanticBoundaries(value, segmentCount) {
  if (!Array.isArray(value) || value.length !== segmentCount - 1) fail("TTS_PROVENANCE_INVALID", "pacing.semanticBoundaryWordIndices");
  let previous = 0;
  return value.map((raw, index) => {
    const boundary = Number(raw);
    if (!Number.isInteger(boundary) || boundary <= previous || boundary > 4095) fail("TTS_PROVENANCE_INVALID", `pacing.semanticBoundaryWordIndices[${index}]`);
    previous = boundary;
    return boundary;
  });
}

function normalizeSynthesisRequest(input = {}) {
  const script = text(input.script, "script", 4096);
  const provider = text(input.provider, "provider", 40).toLowerCase();
  if (!["kokoro_local", "openai", "mock"].includes(provider)) fail("TTS_PROVIDER_UNSUPPORTED", "provider");
  const voiceId = text(input.voiceId, "voiceId", 100).toLowerCase();
  if (input.voiceCloned === true || input.impersonated === true) fail("TTS_VOICE_PROHIBITED", "voiceId", 409);
  if (provider === "openai" && !BUILT_IN_OPENAI_VOICES.includes(voiceId)) fail("TTS_VOICE_PROHIBITED", "voiceId", 409);
  if (provider === "kokoro_local" && !KOKORO_VOICES.includes(voiceId)) fail("TTS_VOICE_PROHIBITED", "voiceId", 409);
  const speakingRate = Number(input.speakingRate ?? 1);
  if (!Number.isFinite(speakingRate) || speakingRate < 0.25 || speakingRate > 4) fail("TTS_PROVENANCE_INVALID", "speakingRate");
  const language = text(input.language || "en", "language", 20).toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/.test(language)) fail("TTS_PROVENANCE_INVALID", "language");
  const pacingPlan = input.pacingPlan == null ? null : normalizePacingPlan(input.pacingPlan, { script });
  if (pacingPlan && pacingPlan.scriptSha256 !== sha256(script)) fail("TTS_PROVENANCE_INVALID", "pacingPlan.scriptSha256");
  return {
    provider, model: text(input.model || (provider === "kokoro_local" ? "kokoro-v1.0-onnx-f32" : provider === "openai" ? "gpt-4o-mini-tts" : "deterministic-tone-v1"), "model", 100),
    voiceId, language, speakingRate: Number(speakingRate.toFixed(2)), script, scriptHash: sha256(script),
    pacingPlan, pacingHash: pacingPlan ? pacingPlan.contentHash : null,
    voiceCloned: false, impersonated: false,
  };
}

function normalizeTtsProvenance(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("TTS_PROVENANCE_INVALID", "manifest");
  const schemaVersion = String(input.schemaVersion || "");
  if (![TTS_PROVENANCE_SCHEMA_V1, TTS_PROVENANCE_SCHEMA_V2, TTS_PROVENANCE_SCHEMA_V3].includes(schemaVersion)) fail("TTS_PROVENANCE_INVALID", "schemaVersion");
  const keys = ["schemaVersion", "projectId", "runId", "script", "provider", "model", "voiceId", "language", "speakingRate", "synthesizedAt", "providerRequestId", "license", "voiceCloned", "impersonated", "audio", "dryRun", "publishable", "blockerCodes", "contentHash"];
  if ([TTS_PROVENANCE_SCHEMA_V2, TTS_PROVENANCE_SCHEMA_V3].includes(schemaVersion)) keys.splice(10, 0, "pacing");
  exact(input, keys, "manifest");
  if ([TTS_PROVENANCE_SCHEMA_V2, TTS_PROVENANCE_SCHEMA_V3].includes(schemaVersion) && !("pacing" in input)) fail("TTS_PROVENANCE_INVALID", "pacing");
  exact(input.script, ["path", "sha256", "approvalReference", "approved"], "script"); exact(input.license, ["termsReference", "commercialUseAttested", "attestedBy"], "license"); exact(input.audio, ["path", "sha256", "container", "codec", "sampleRate", "channels", "durationSeconds", "bytes", "validated"], "audio");
  const provider = text(input.provider, "provider", 40).toLowerCase();
  if (!["kokoro_local", "openai", "mock"].includes(provider)) fail("TTS_PROVIDER_UNSUPPORTED", "provider");
  const audio = input.audio || {};
  let pacing = null;
  if ([TTS_PROVENANCE_SCHEMA_V2, TTS_PROVENANCE_SCHEMA_V3].includes(schemaVersion) && input.pacing !== null) {
    exact(input.pacing, schemaVersion === TTS_PROVENANCE_SCHEMA_V3
      ? ["profile", "planHash", "segmentCount", "totalPauseMs", "semanticBoundaryWordIndices"]
      : ["profile", "planHash", "segmentCount", "totalPauseMs"], "pacing");
    pacing = {
      profile: text(input.pacing.profile, "pacing.profile", 80),
      planHash: hash(input.pacing.planHash, "pacing.planHash"),
      segmentCount: Number(input.pacing.segmentCount),
      totalPauseMs: Number(input.pacing.totalPauseMs),
    };
    if (pacing.profile !== DARK_CURIOSITY_COMPREHENSION_PROFILE || !Number.isInteger(pacing.segmentCount) || pacing.segmentCount < 1 || pacing.segmentCount > 16 || !Number.isInteger(pacing.totalPauseMs) || pacing.totalPauseMs < 0 || pacing.totalPauseMs > 20000) fail("TTS_PROVENANCE_INVALID", "pacing");
    if (schemaVersion === TTS_PROVENANCE_SCHEMA_V3) pacing.semanticBoundaryWordIndices = semanticBoundaries(input.pacing.semanticBoundaryWordIndices, pacing.segmentCount);
  }
  const normalized = {
    schemaVersion,
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
  if ([TTS_PROVENANCE_SCHEMA_V2, TTS_PROVENANCE_SCHEMA_V3].includes(schemaVersion)) normalized.pacing = pacing;
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

module.exports = { BUILT_IN_OPENAI_VOICES, KOKORO_VOICES, TTS_PROVENANCE_SCHEMA, TTS_PROVENANCE_SCHEMA_V1, TTS_PROVENANCE_SCHEMA_V2, TTS_PROVENANCE_SCHEMA_V3, normalizeSynthesisRequest, normalizeTtsProvenance, sha256 };
