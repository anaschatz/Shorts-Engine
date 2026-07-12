const { AppError, SAFE_MESSAGES } = require("../../errors.cjs");
const { sanitizeText, validateResourceId } = require("../../repositories/ids.cjs");
const { contentHash } = require("./contracts.cjs");

const AUDIO_PROFILE = "dark_curiosity_speech_v1";
const AUDIO_PROFILE_VERSION = "1.0.0";
const AUDIO_TARGET = Object.freeze({ integratedLoudness: -16, truePeak: -1.5, loudnessRange: 11 });

function fail(field = "audioNormalization") {
  throw new AppError("AUDIO_NORMALIZATION_FAILED", SAFE_MESSAGES.AUDIO_NORMALIZATION_FAILED, 409, { field });
}

function exactKeys(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) fail(`${field}.${key}`);
}

function finite(value, field, min = -120, max = 120) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) fail(field);
  return Number(number.toFixed(2));
}

function artifactId(value, field) {
  const safe = sanitizeText(value, 100);
  if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe)) fail(field);
  return safe;
}

function hash(value, field) {
  const safe = sanitizeText(value, 80).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(safe)) fail(field);
  return safe;
}

function measurement(input, field, includeThreshold = false) {
  exactKeys(input, includeThreshold ? ["integratedLoudness", "truePeak", "loudnessRange", "threshold"] : ["integratedLoudness", "truePeak", "loudnessRange"], field);
  const value = {
    integratedLoudness: finite(input.integratedLoudness, `${field}.integratedLoudness`),
    truePeak: finite(input.truePeak, `${field}.truePeak`),
    loudnessRange: finite(input.loudnessRange, `${field}.loudnessRange`, 0, 120),
  };
  if (includeThreshold) value.threshold = finite(input.threshold, `${field}.threshold`);
  return value;
}

function parseLoudnormMeasurement(stderr) {
  const text = String(stderr || "").slice(-64 * 1024);
  const objects = [...text.matchAll(/\{[^{}]*"input_i"[^{}]*\}/gs)].map((match) => match[0]);
  for (const candidate of objects.reverse()) {
    try {
      const value = JSON.parse(candidate);
      const parsed = {
        input: measurement({ integratedLoudness: value.input_i, truePeak: value.input_tp, loudnessRange: value.input_lra, threshold: value.input_thresh }, "input", true),
        output: measurement({ integratedLoudness: value.output_i, truePeak: value.output_tp, loudnessRange: value.output_lra }, "output"),
        offset: finite(value.target_offset, "target_offset", -99, 99),
      };
      return parsed;
    } catch {
      // Continue to any earlier bounded loudnorm object.
    }
  }
  fail("loudnorm");
}

function normalizeAudioNormalizationReport(input = {}) {
  exactKeys(input, ["schemaVersion", "status", "projectId", "projectRevision", "audioArtifactId", "audioHash", "alignmentArtifactId", "alignmentHash", "profile", "profileVersion", "input", "target", "output", "contentHash"], "report");
  if (Number(input.schemaVersion) !== 1 || input.status !== "normalized" || input.profile !== AUDIO_PROFILE || input.profileVersion !== AUDIO_PROFILE_VERSION) fail("report");
  exactKeys(input.target, ["integratedLoudness", "truePeak", "loudnessRange"], "target");
  const normalized = {
    schemaVersion: 1, status: "normalized", projectId: validateResourceId(input.projectId, "prj"), projectRevision: Number(input.projectRevision),
    audioArtifactId: artifactId(input.audioArtifactId, "audioArtifactId"), audioHash: hash(input.audioHash, "audioHash"),
    alignmentArtifactId: artifactId(input.alignmentArtifactId, "alignmentArtifactId"), alignmentHash: hash(input.alignmentHash, "alignmentHash"),
    profile: AUDIO_PROFILE, profileVersion: AUDIO_PROFILE_VERSION,
    input: measurement(input.input, "input", true),
    target: measurement(input.target, "target"),
    output: measurement(input.output, "output"),
  };
  if (!Number.isInteger(normalized.projectRevision) || normalized.projectRevision < 1 || JSON.stringify(normalized.target) !== JSON.stringify(AUDIO_TARGET)) fail("target");
  const calculated = contentHash(normalized);
  if (input.contentHash && input.contentHash !== calculated) fail("contentHash");
  return { ...normalized, contentHash: calculated };
}

function createAudioNormalizationReport({ projectId, projectRevision, audioArtifactId, audioHash, alignmentArtifactId, alignmentHash, loudness }) {
  return normalizeAudioNormalizationReport({ schemaVersion: 1, status: "normalized", projectId, projectRevision, audioArtifactId, audioHash, alignmentArtifactId, alignmentHash, profile: AUDIO_PROFILE, profileVersion: AUDIO_PROFILE_VERSION, input: loudness.input, target: AUDIO_TARGET, output: loudness.output });
}

function firstPassFilter() {
  return `loudnorm=I=${AUDIO_TARGET.integratedLoudness}:TP=${AUDIO_TARGET.truePeak}:LRA=${AUDIO_TARGET.loudnessRange}:print_format=json`;
}

function secondPassFilter(loudness) {
  return `loudnorm=I=${AUDIO_TARGET.integratedLoudness}:TP=${AUDIO_TARGET.truePeak}:LRA=${AUDIO_TARGET.loudnessRange}:measured_I=${loudness.input.integratedLoudness}:measured_TP=${loudness.input.truePeak}:measured_LRA=${loudness.input.loudnessRange}:measured_thresh=${loudness.input.threshold}:offset=${loudness.offset}:linear=true:print_format=summary`;
}

module.exports = { AUDIO_PROFILE, AUDIO_PROFILE_VERSION, AUDIO_TARGET, createAudioNormalizationReport, firstPassFilter, normalizeAudioNormalizationReport, parseLoudnormMeasurement, secondPassFilter };
