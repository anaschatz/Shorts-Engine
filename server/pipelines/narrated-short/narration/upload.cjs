const { writeFileSync, statSync } = require("node:fs");
const { extname } = require("node:path");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { ffprobeJson, sha256 } = require("../../../media.cjs");
const { sanitizeText } = require("../../../repositories/ids.cjs");
const { normalizeDraftBundle, contentHash } = require("../contracts.cjs");
const { normalizeNarrationAsset, normalizeNarrationRights, publicNarrationSummary, PCM_CODECS } = require("./contract.cjs");

const NARRATION_FILE_FIELD = "narration";
const MAX_NARRATION_BYTES = 32 * 1024 * 1024;
const MAX_NARRATION_SECONDS = 120;
const NARRATION_SAMPLE_RATE = 48000;
const ALLOWED_UPLOAD_FIELDS = Object.freeze([
  "draftArtifactId", "draftHash", "scriptHash", "projectRevision", "voiceProfileId", "language",
  "commercialUseAllowed", "ownershipBasis", "rightsHolder", "consentReference", "licenseReference",
]);

function narrationError(code, status, field = null) {
  throw new AppError(code, SAFE_MESSAGES[code] || SAFE_MESSAGES.VALIDATION_ERROR, status, field ? { field } : null);
}

function assertAllowedUploadFields(fields = {}) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) narrationError("VALIDATION_ERROR", 400, "fields");
  const allowed = new Set(ALLOWED_UPLOAD_FIELDS);
  for (const key of Object.keys(fields)) if (!allowed.has(key)) narrationError("UPLOAD_FIELD_INVALID", 400, key);
  return fields;
}

function parseCommercialUseAllowed(value) {
  if (value === true || value === "true") return true;
  narrationError("NARRATION_RIGHTS_REQUIRED", 400, "commercialUseAllowed");
}

function normalizeUploadRights(fields = {}) {
  return normalizeNarrationRights({
    commercialUseAllowed: parseCommercialUseAllowed(fields.commercialUseAllowed),
    ownershipBasis: fields.ownershipBasis,
    rightsHolder: fields.rightsHolder,
    consentReference: fields.consentReference,
    licenseReference: fields.licenseReference || null,
  });
}

function validateWavCandidate(file = {}) {
  if (!file || !Buffer.isBuffer(file.buffer)) narrationError("NARRATION_WAV_INVALID", 400, NARRATION_FILE_FIELD);
  const rawName = String(file.fileName || "");
  if (!rawName || rawName.length > 180 || /[\\/\u0000-\u001f\u007f]/.test(rawName) || extname(rawName).toLowerCase() !== ".wav") {
    narrationError("NARRATION_WAV_INVALID", 415, "fileName");
  }
  if (file.buffer.length < 44 || file.buffer.length > MAX_NARRATION_BYTES) {
    narrationError(file.buffer.length > MAX_NARRATION_BYTES ? "FILE_TOO_LARGE" : "NARRATION_WAV_INVALID", file.buffer.length > MAX_NARRATION_BYTES ? 413 : 415, NARRATION_FILE_FIELD);
  }
  if (file.buffer.subarray(0, 4).toString("ascii") !== "RIFF" || file.buffer.subarray(8, 12).toString("ascii") !== "WAVE") {
    narrationError("NARRATION_WAV_INVALID", 415, NARRATION_FILE_FIELD);
  }
  return { buffer: file.buffer, fileName: rawName, bytes: file.buffer.length };
}

function normalizeProbedMedia(info = {}, bytes) {
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const audioStreams = streams.filter((stream) => stream && stream.codec_type === "audio");
  if (audioStreams.length !== 1 || streams.some((stream) => stream && stream.codec_type === "video")) {
    narrationError("NARRATION_AUDIO_UNSUPPORTED", 415, "media.streams");
  }
  const stream = audioStreams[0];
  const formatName = sanitizeText(info.format && info.format.format_name, 80).toLowerCase();
  if (!formatName.split(",").includes("wav")) narrationError("NARRATION_WAV_INVALID", 415, "media.container");
  const codec = sanitizeText(stream.codec_name, 40).toLowerCase();
  if (!PCM_CODECS.includes(codec)) narrationError("NARRATION_AUDIO_UNSUPPORTED", 415, "media.codec");
  const sampleRate = Number(stream.sample_rate);
  if (sampleRate !== NARRATION_SAMPLE_RATE) narrationError("NARRATION_AUDIO_UNSUPPORTED", 415, "media.sampleRate");
  const channels = Number(stream.channels);
  if (![1, 2].includes(channels)) narrationError("NARRATION_AUDIO_UNSUPPORTED", 415, "media.channels");
  const durationSeconds = Number((info.format && info.format.duration) || stream.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 1 || durationSeconds > MAX_NARRATION_SECONDS) {
    narrationError("NARRATION_DURATION_INVALID", 400, "media.durationSeconds");
  }
  return {
    container: "wav",
    codec,
    sampleRate,
    channels,
    durationSeconds: Number(durationSeconds.toFixed(4)),
    bytes,
  };
}

function ensureDependencies(dependencies = {}) {
  const required = ["artifactStore", "artifactRepository", "contentArtifactRepository", "contentApprovalRepository", "projectRepository"];
  for (const key of required) if (!dependencies[key]) throw new AppError("PIPELINE_HANDLER_UNAVAILABLE", "Narration upload dependencies are unavailable.", 503);
  return dependencies;
}

function approvalAndDraft({ project, fields, contentApprovalRepository, contentArtifactRepository }) {
  if (!project || project.projectType !== "narrated_short") narrationError("VALIDATION_ERROR", 400, "project");
  const suppliedRevision = fields.projectRevision === undefined || fields.projectRevision === ""
    ? project.input.revision
    : Number(fields.projectRevision);
  if (!Number.isInteger(suppliedRevision) || suppliedRevision !== project.input.revision) {
    narrationError("NARRATION_REVISION_STALE", 409, "projectRevision");
  }
  const approval = contentApprovalRepository.findApproved(project.id, project.input.revision);
  if (!approval) narrationError("NARRATION_APPROVAL_MISMATCH", 409, "approval");
  const draftArtifactId = sanitizeText(fields.draftArtifactId, 100);
  const draftHash = sanitizeText(fields.draftHash, 80).toLowerCase().replace(/^sha256:/, "");
  if (draftArtifactId !== approval.draftArtifactId || draftHash !== approval.draftHash) {
    narrationError("NARRATION_APPROVAL_MISMATCH", 409, "draftHash");
  }
  let envelope;
  try {
    envelope = contentArtifactRepository.readJson(draftArtifactId);
  } catch {
    narrationError("NARRATION_APPROVAL_MISMATCH", 409, "draftArtifactId");
  }
  if (envelope.artifactType !== "approval_bundle" || envelope.projectId !== project.id || envelope.revision !== project.input.revision || envelope.contentHash !== approval.draftHash) {
    narrationError("NARRATION_APPROVAL_MISMATCH", 409, "draftArtifactId");
  }
  const draft = normalizeDraftBundle(envelope.body);
  if (draft.verticalId !== "dark_curiosity") narrationError("VALIDATION_ERROR", 400, "verticalId");
  if (fields.scriptHash && sanitizeText(fields.scriptHash, 80).toLowerCase().replace(/^sha256:/, "") !== draft.script.contentHash) {
    narrationError("NARRATION_APPROVAL_MISMATCH", 409, "scriptHash");
  }
  return { approval, envelope, draft };
}

async function ingestUploadedNarration(input = {}, dependencyInput = {}) {
  const dependencies = ensureDependencies(dependencyInput);
  const fields = assertAllowedUploadFields(input.fields || {});
  const rights = normalizeUploadRights(fields);
  const candidate = validateWavCandidate(input.file);
  const { project } = input;
  const { approval, draft } = approvalAndDraft({
    project,
    fields,
    contentApprovalRepository: dependencies.contentApprovalRepository,
    contentArtifactRepository: dependencies.contentArtifactRepository,
  });
  const voiceProfileId = sanitizeText(fields.voiceProfileId, 80);
  const language = sanitizeText(fields.language, 12).toLowerCase();
  if (!voiceProfileId) narrationError("VALIDATION_ERROR", 400, "voiceProfileId");
  if (language !== project.language || language !== draft.brief.language) narrationError("NARRATION_APPROVAL_MISMATCH", 409, "language");
  const audioHash = sha256(candidate.buffer);
  const identityHash = contentHash({ projectId: project.id, revision: project.input.revision, draftHash: approval.draftHash, audioHash });
  const audioArtifactId = `art_${identityHash.slice(0, 40)}`;
  const existingAudio = dependencies.artifactRepository.get(audioArtifactId);
  if (existingAudio && (
    existingAudio.type !== "narration_audio" ||
    existingAudio.ownerProjectId !== project.id ||
    existingAudio.checksumSha256 !== audioHash ||
    existingAudio.status !== "available"
  )) {
    throw new AppError("ARTIFACT_CONTENT_INVALID", "Narration audio artifact identity is inconsistent.", 409);
  }
  const stage = existingAudio
    ? dependencies.artifactStore.stageInputForProcessing(existingAudio, { step: "probe_narration" })
    : dependencies.artifactStore.createOutputStage("narration_audio", {
        id: audioArtifactId,
        ownerProjectId: project.id,
        storageKey: `narration/${project.id}/${identityHash}.wav`,
        contentType: "audio/wav",
      });
  let committed = false;
  try {
    if (!existingAudio) writeFileSync(stage.localPath, candidate.buffer);
    let probe;
    try {
      probe = await (dependencies.ffprobeJson || ffprobeJson)(stage.localPath);
    } catch (error) {
      if (error && error.code === "FFPROBE_MISSING") throw error;
      narrationError("NARRATION_WAV_INVALID", 415, "media");
    }
    const media = normalizeProbedMedia(probe, statSync(stage.localPath).size);
    const manifest = normalizeNarrationAsset({
      schemaVersion: 1,
      status: "uploaded_unaligned",
      projectId: project.id,
      projectRevision: project.input.revision,
      verticalId: draft.verticalId,
      draftArtifactId: approval.draftArtifactId,
      draftHash: approval.draftHash,
      scriptHash: draft.script.contentHash,
      audioArtifactId,
      audioHash,
      voiceProfileId,
      language,
      media,
      rights,
    });
    const audioArtifact = existingAudio || dependencies.artifactStore.commitOutputStage(stage, { checksumSha256: audioHash, size: candidate.bytes });
    committed = Boolean(!existingAudio);
    if (!existingAudio) dependencies.artifactRepository.create(audioArtifact);
    const manifestArtifact = dependencies.contentArtifactRepository.createJson({
      type: "narration_manifest",
      projectId: project.id,
      revision: project.input.revision,
      dependencyHashes: [approval.draftHash, draft.script.contentHash, audioHash],
      body: manifest,
    });
    const summary = publicNarrationSummary({
      manifest,
      manifestArtifactId: manifestArtifact.artifact.id,
      manifestHash: manifestArtifact.envelope.contentHash,
    });
    const updatedProject = dependencies.projectRepository.update(project.id, {
      input: { ...project.input, activeNarration: summary },
    });
    if (dependencies.persistenceAdapter && typeof dependencies.persistenceAdapter.persistProject === "function") {
      dependencies.persistenceAdapter.persistProject({ project: updatedProject });
    }
    return { audioArtifact, manifestArtifact, manifest, narration: summary, project: updatedProject };
  } catch (error) {
    if (!existingAudio && !committed) dependencies.artifactStore.deleteStagingArtifact(stage.artifact);
    throw error;
  } finally {
    if (existingAudio && stage.cleanupRequired) dependencies.artifactStore.cleanupStage(stage);
  }
}

module.exports = {
  ALLOWED_UPLOAD_FIELDS,
  MAX_NARRATION_BYTES,
  MAX_NARRATION_SECONDS,
  NARRATION_FILE_FIELD,
  NARRATION_SAMPLE_RATE,
  assertAllowedUploadFields,
  ingestUploadedNarration,
  normalizeProbedMedia,
  normalizeUploadRights,
  validateWavCandidate,
};
