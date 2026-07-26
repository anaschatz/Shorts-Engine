const { createHash } = require("node:crypto");
const { realpathSync, statSync } = require("node:fs");
const { extname, isAbsolute } = require("node:path");

const { AppError, SAFE_MESSAGES } = require("../../errors.cjs");
const { assertStoragePath } = require("../../storage.cjs");
const {
  normalizeCandidateDecision,
  normalizeExperimentManifest,
} = require("./growth-contracts.cjs");

const PIPELINE_TYPE = "motivational_source_short";
const ACTION = "render_motivational_source_short";
const JOB_SCHEMA_VERSION = 1;
const WORKER_RESULT_SCHEMA_VERSION = 1;

const PROFILE_IDS = deepFreeze({
  contentProfile: "motivational_podcast",
  selectionProfile: "motivational_tension_micro_v1",
  renderProfile: "bf_editorial_inset_v1",
  formatProfile: "bf_viral_micro_v1",
});

const SOURCE_AREAS = Object.freeze(["artifacts", "uploads"]);
const SOURCE_EXTENSIONS = Object.freeze([".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
const DOWNLOAD_FORMATS = Object.freeze(["360", "480", "720", "1080"]);
const JOB_FIELDS = Object.freeze([
  "schemaVersion",
  "sourcePath",
  "sourceArea",
  "sourceHash",
  "rightsManifestHash",
  "candidateDecisionHash",
  "candidateDecision",
  "experimentManifestHash",
  "experimentManifest",
  "transcriptManifestHash",
  "transcriptManifest",
  "profiles",
  "language",
  "downloadFormat",
]);
const REQUIRED_JOB_FIELDS = Object.freeze([
  "schemaVersion",
  "sourcePath",
  "sourceArea",
  "sourceHash",
  "rightsManifestHash",
  "candidateDecisionHash",
  "candidateDecision",
  "experimentManifestHash",
  "experimentManifest",
  "transcriptManifestHash",
  "transcriptManifest",
  "profiles",
]);
const PROFILE_FIELDS = Object.freeze(Object.keys(PROFILE_IDS));
const RESULT_FIELDS = Object.freeze([
  "schemaVersion",
  "pipelineType",
  "action",
  "status",
  "profiles",
  "sourceHash",
  "rightsManifestHash",
  "candidateDecisionHash",
  "candidateHash",
  "experimentManifestHash",
  "transcriptManifestHash",
  "output",
  "ranking",
  "completedAt",
  "contentHash",
]);
const OUTPUT_FIELDS = Object.freeze([
  "localPath",
  "outputHash",
  "sizeBytes",
  "outputRank",
  "durationSeconds",
]);
const RANKING_FIELDS = Object.freeze(["manifestPath", "manifestHash"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function invalid(field, code = "VALIDATION_ERROR", status = null) {
  const message = SAFE_MESSAGES[code] || SAFE_MESSAGES.VALIDATION_ERROR;
  const resolvedStatus = status === null
    ? code === "VALIDATION_ERROR"
      ? 400
      : code === "STORAGE_PATH_UNSAFE"
        ? 403
        : 500
    : status;
  throw new AppError(code, message, resolvedStatus, { field });
}

function exactObject(value, allowedFields, requiredFields, field, code = "VALIDATION_ERROR") {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field, code);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowedFields.includes(key))) invalid(field, code);
  if (requiredFields.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) invalid(field, code);
  return value;
}

function normalizeHash(value, field, code = "VALIDATION_ERROR") {
  const safe = String(value || "").trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(safe)) invalid(field, code);
  return safe;
}

function normalizeProfiles(value, code = "VALIDATION_ERROR") {
  exactObject(value, PROFILE_FIELDS, PROFILE_FIELDS, "profiles", code);
  const normalized = {};
  for (const field of PROFILE_FIELDS) {
    const actual = String(value[field] || "").trim().toLowerCase();
    if (actual !== PROFILE_IDS[field]) invalid(`profiles.${field}`, code);
    normalized[field] = actual;
  }
  return deepFreeze(normalized);
}

function normalizeLocalSourcePath(value, sourceArea) {
  const path = String(value || "").trim();
  const area = String(sourceArea || "").trim().toLowerCase();
  if (!SOURCE_AREAS.includes(area)) invalid("sourceArea");
  if (!path || path.length > 4096 || path.includes("\0") || !isAbsolute(path)) {
    invalid("sourcePath", "STORAGE_PATH_UNSAFE", 403);
  }
  let lexicalPath;
  let realPath;
  try {
    lexicalPath = assertStoragePath(path, area);
    realPath = realpathSync(lexicalPath);
    assertStoragePath(realPath, area);
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid("sourcePath", "STORAGE_PATH_UNSAFE", 403);
  }
  let stats;
  try {
    stats = statSync(realPath);
  } catch {
    invalid("sourcePath", "STORAGE_PATH_UNSAFE", 403);
  }
  if (!stats.isFile() || stats.size <= 0 || !SOURCE_EXTENSIONS.includes(extname(realPath).toLowerCase())) {
    invalid("sourcePath");
  }
  return realPath;
}

function normalizeLanguage(value) {
  const safe = String(value || "auto").trim().toLowerCase();
  if (!/^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/.test(safe)) invalid("language");
  return safe;
}

function normalizeDownloadFormat(value) {
  const safe = String(value || "720").trim();
  if (!DOWNLOAD_FORMATS.includes(safe)) invalid("downloadFormat");
  return safe;
}

function normalizeMotivationalSourceShortJobPayload(payload = {}) {
  exactObject(payload, JOB_FIELDS, REQUIRED_JOB_FIELDS, "payload");
  if (Number(payload.schemaVersion) !== JOB_SCHEMA_VERSION) invalid("schemaVersion");
  const sourceArea = String(payload.sourceArea || "").trim().toLowerCase();
  const sourceHash = normalizeHash(payload.sourceHash, "sourceHash");
  const rightsManifestHash = normalizeHash(
    payload.rightsManifestHash,
    "rightsManifestHash",
  );
  const candidateDecisionHash = normalizeHash(
    payload.candidateDecisionHash,
    "candidateDecisionHash",
  );
  const candidateDecision = normalizeCandidateDecision(payload.candidateDecision);
  if (
    candidateDecision.contentHash !== candidateDecisionHash
    || candidateDecision.sourceHash !== sourceHash
    || candidateDecision.sourceManifestHash !== rightsManifestHash
    || candidateDecision.selectionProfile !== PROFILE_IDS.selectionProfile
    || candidateDecision.decision !== "approved"
  ) {
    invalid("candidateDecision", "GROWTH_LINK_MISMATCH", 409);
  }
  const experimentManifestHash = normalizeHash(
    payload.experimentManifestHash,
    "experimentManifestHash",
  );
  const experimentManifest = normalizeExperimentManifest(payload.experimentManifest, {
    candidateDecision,
  });
  if (
    experimentManifest.contentHash !== experimentManifestHash
    || experimentManifest.candidateDecisionHash !== candidateDecisionHash
    || experimentManifest.candidateHash !== candidateDecision.candidateHash
    || experimentManifest.formatProfile !== PROFILE_IDS.formatProfile
    || experimentManifest.selectionProfile !== PROFILE_IDS.selectionProfile
    || experimentManifest.renderProfile !== PROFILE_IDS.renderProfile
  ) {
    invalid("experimentManifest", "GROWTH_LINK_MISMATCH", 409);
  }
  const transcriptManifestHash = normalizeHash(
    payload.transcriptManifestHash,
    "transcriptManifestHash",
  );
  const transcriptManifest = normalizeTranscriptManifest(payload.transcriptManifest);
  if (
    transcriptManifest.contentHash !== transcriptManifestHash
    || transcriptManifest.sourceHash !== sourceHash
  ) {
    invalid("transcriptManifest", "GROWTH_LINK_MISMATCH", 409);
  }
  return deepFreeze({
    schemaVersion: JOB_SCHEMA_VERSION,
    sourcePath: normalizeLocalSourcePath(payload.sourcePath, sourceArea),
    sourceArea,
    sourceHash,
    rightsManifestHash,
    candidateDecisionHash,
    candidateDecision,
    experimentManifestHash,
    experimentManifest,
    transcriptManifestHash,
    transcriptManifest,
    profiles: normalizeProfiles(payload.profiles),
    language: normalizeLanguage(payload.language),
    downloadFormat: normalizeDownloadFormat(payload.downloadFormat),
  });
}

function normalizeAbsoluteResultPath(value, field, code = "MOTIVATIONAL_WORKER_RESULT_INVALID") {
  const path = String(value || "").trim();
  if (!path || path.length > 4096 || path.includes("\0") || !isAbsolute(path)) invalid(field, code, 500);
  return path;
}

function normalizePositiveNumber(value, field, { integer = false, minimum = 0 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || (integer && !Number.isInteger(number))) {
    invalid(field, "MOTIVATIONAL_WORKER_RESULT_INVALID", 500);
  }
  return number;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function contentHash(value) {
  const body = { ...value };
  delete body.contentHash;
  return createHash("sha256").update(JSON.stringify(canonicalize(body))).digest("hex");
}

function normalizeTranscriptManifest(input = {}) {
  const fields = [
    "schemaVersion",
    "artifactType",
    "sourceHash",
    "modelId",
    "language",
    "durationSeconds",
    "transcriptHash",
    "transcript",
    "contentHash",
  ];
  exactObject(
    input,
    fields,
    fields.filter((field) => field !== "contentHash"),
    "transcriptManifest",
  );
  if (Number(input.schemaVersion) !== 1 || input.artifactType !== "TranscriptManifest") {
    invalid("transcriptManifest");
  }
  const sourceHash = normalizeHash(input.sourceHash, "transcriptManifest.sourceHash");
  const modelId = String(input.modelId || "").trim().toLowerCase();
  const language = String(input.language || "").trim().toLowerCase();
  const durationSeconds = Number(input.durationSeconds);
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(modelId)) invalid("transcriptManifest.modelId");
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(language)) invalid("transcriptManifest.language");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 6 * 60 * 60) {
    invalid("transcriptManifest.durationSeconds");
  }
  exactObject(input.transcript, ["duration", "segments"], ["duration", "segments"], "transcriptManifest.transcript");
  const transcriptDuration = Number(input.transcript.duration);
  if (!Number.isFinite(transcriptDuration) || Math.abs(transcriptDuration - durationSeconds) > 0.01) {
    invalid("transcriptManifest.transcript.duration");
  }
  if (!Array.isArray(input.transcript.segments) || input.transcript.segments.length < 1 || input.transcript.segments.length > 10000) {
    invalid("transcriptManifest.transcript.segments");
  }
  let previousSegmentEnd = 0;
  let totalWords = 0;
  const segments = input.transcript.segments.map((segment, segmentIndex) => {
    const field = `transcriptManifest.transcript.segments[${segmentIndex}]`;
    exactObject(segment, ["start", "end", "text", "words"], ["start", "end", "text", "words"], field);
    const start = Number(segment.start);
    const end = Number(segment.end);
    const text = String(segment.text || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (
      !Number.isFinite(start)
      || !Number.isFinite(end)
      || start < 0
      || end <= start
      || end > durationSeconds + 0.05
      || start + 0.05 < previousSegmentEnd
      || !text
      || text.length > 5000
      || !Array.isArray(segment.words)
      || segment.words.length < 1
      || segment.words.length > 5000
    ) {
      invalid(field);
    }
    let previousWordEnd = start;
    const words = segment.words.map((word, wordIndex) => {
      const wordField = `${field}.words[${wordIndex}]`;
      exactObject(word, ["word", "start", "end"], ["word", "start", "end"], wordField);
      const wordText = String(word.word || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
      const wordStart = Number(word.start);
      const wordEnd = Number(word.end);
      if (
        !wordText
        || wordText.length > 200
        || !Number.isFinite(wordStart)
        || !Number.isFinite(wordEnd)
        || wordStart + 0.05 < start
        || wordEnd > end + 0.05
        || wordEnd <= wordStart
        || wordStart + 0.05 < previousWordEnd
      ) {
        invalid(wordField);
      }
      previousWordEnd = wordEnd;
      totalWords += 1;
      if (totalWords > 250000) invalid("transcriptManifest.transcript.words");
      return {
        word: wordText,
        start: Number(wordStart.toFixed(3)),
        end: Number(wordEnd.toFixed(3)),
      };
    });
    previousSegmentEnd = end;
    return {
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      text,
      words,
    };
  });
  const transcript = {
    duration: Number(transcriptDuration.toFixed(3)),
    segments,
  };
  const transcriptHash = normalizeHash(input.transcriptHash, "transcriptManifest.transcriptHash");
  if (transcriptHash !== contentHash(transcript)) {
    invalid("transcriptManifest.transcriptHash", "GROWTH_HASH_MISMATCH", 409);
  }
  const base = {
    schemaVersion: 1,
    artifactType: "TranscriptManifest",
    sourceHash,
    modelId,
    language,
    durationSeconds: Number(durationSeconds.toFixed(3)),
    transcriptHash,
    transcript,
  };
  const calculated = contentHash(base);
  if (input.contentHash !== undefined && normalizeHash(input.contentHash, "transcriptManifest.contentHash") !== calculated) {
    invalid("transcriptManifest.contentHash", "GROWTH_HASH_MISMATCH", 409);
  }
  return deepFreeze({ ...base, contentHash: calculated });
}

function normalizeWorkerResult(result = {}, expectedJob = null) {
  exactObject(
    result,
    RESULT_FIELDS,
    RESULT_FIELDS,
    "workerResult",
    "MOTIVATIONAL_WORKER_RESULT_INVALID",
  );
  if (Number(result.schemaVersion) !== WORKER_RESULT_SCHEMA_VERSION) {
    invalid("workerResult.schemaVersion", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500);
  }
  if (result.pipelineType !== PIPELINE_TYPE) {
    invalid("workerResult.pipelineType", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500);
  }
  if (result.action !== ACTION) invalid("workerResult.action", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500);
  if (result.status !== "completed") invalid("workerResult.status", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500);
  const profiles = normalizeProfiles(result.profiles, "MOTIVATIONAL_WORKER_RESULT_INVALID");
  const sourceHash = normalizeHash(result.sourceHash, "workerResult.sourceHash", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  const rightsManifestHash = normalizeHash(
    result.rightsManifestHash,
    "workerResult.rightsManifestHash",
    "MOTIVATIONAL_WORKER_RESULT_INVALID",
  );
  const candidateDecisionHash = normalizeHash(
    result.candidateDecisionHash,
    "workerResult.candidateDecisionHash",
    "MOTIVATIONAL_WORKER_RESULT_INVALID",
  );
  const candidateHash = normalizeHash(
    result.candidateHash,
    "workerResult.candidateHash",
    "MOTIVATIONAL_WORKER_RESULT_INVALID",
  );
  const experimentManifestHash = normalizeHash(
    result.experimentManifestHash,
    "workerResult.experimentManifestHash",
    "MOTIVATIONAL_WORKER_RESULT_INVALID",
  );
  const transcriptManifestHash = normalizeHash(
    result.transcriptManifestHash,
    "workerResult.transcriptManifestHash",
    "MOTIVATIONAL_WORKER_RESULT_INVALID",
  );
  exactObject(
    result.output,
    OUTPUT_FIELDS,
    OUTPUT_FIELDS,
    "workerResult.output",
    "MOTIVATIONAL_WORKER_RESULT_INVALID",
  );
  const output = {
    localPath: normalizeAbsoluteResultPath(result.output.localPath, "workerResult.output.localPath"),
    outputHash: normalizeHash(
      result.output.outputHash,
      "workerResult.output.outputHash",
      "MOTIVATIONAL_WORKER_RESULT_INVALID",
    ),
    sizeBytes: normalizePositiveNumber(result.output.sizeBytes, "workerResult.output.sizeBytes", {
      integer: true,
      minimum: 1,
    }),
    outputRank: normalizePositiveNumber(result.output.outputRank, "workerResult.output.outputRank", {
      integer: true,
      minimum: 1,
    }),
    durationSeconds: normalizePositiveNumber(
      result.output.durationSeconds,
      "workerResult.output.durationSeconds",
      { minimum: 0.001 },
    ),
  };
  if (output.outputRank !== 1 || output.durationSeconds < 8 || output.durationSeconds > 22.5) {
    invalid("workerResult.output", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500);
  }
  exactObject(
    result.ranking,
    RANKING_FIELDS,
    RANKING_FIELDS,
    "workerResult.ranking",
    "MOTIVATIONAL_WORKER_RESULT_INVALID",
  );
  const ranking = {
    manifestPath: normalizeAbsoluteResultPath(
      result.ranking.manifestPath,
      "workerResult.ranking.manifestPath",
    ),
    manifestHash: normalizeHash(
      result.ranking.manifestHash,
      "workerResult.ranking.manifestHash",
      "MOTIVATIONAL_WORKER_RESULT_INVALID",
    ),
  };
  const completedAt = String(result.completedAt || "").trim();
  if (!completedAt || !Number.isFinite(Date.parse(completedAt))) {
    invalid("workerResult.completedAt", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500);
  }
  const declaredContentHash = normalizeHash(
    result.contentHash,
    "workerResult.contentHash",
    "MOTIVATIONAL_WORKER_RESULT_INVALID",
  );
  const normalized = {
    schemaVersion: WORKER_RESULT_SCHEMA_VERSION,
    pipelineType: PIPELINE_TYPE,
    action: ACTION,
    status: "completed",
    profiles,
    sourceHash,
    rightsManifestHash,
    candidateDecisionHash,
    candidateHash,
    experimentManifestHash,
    transcriptManifestHash,
    output,
    ranking,
    completedAt,
  };
  if (declaredContentHash !== contentHash(normalized)) {
    invalid("workerResult.contentHash", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500);
  }
  if (expectedJob) {
    const expected = normalizeMotivationalSourceShortJobPayload(expectedJob);
    if (
      sourceHash !== expected.sourceHash
      || rightsManifestHash !== expected.rightsManifestHash
      || candidateDecisionHash !== expected.candidateDecisionHash
      || candidateHash !== expected.candidateDecision.candidateHash
      || experimentManifestHash !== expected.experimentManifestHash
      || transcriptManifestHash !== expected.transcriptManifestHash
      || PROFILE_FIELDS.some((field) => profiles[field] !== expected.profiles[field])
    ) {
      invalid("workerResult.bindings", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500);
    }
  }
  return deepFreeze({ ...normalized, contentHash: declaredContentHash });
}

function createMotivationalWorkerResult(input = {}) {
  const base = {
    schemaVersion: WORKER_RESULT_SCHEMA_VERSION,
    pipelineType: PIPELINE_TYPE,
    action: ACTION,
    status: "completed",
    profiles: normalizeProfiles(input.profiles, "MOTIVATIONAL_WORKER_RESULT_INVALID"),
    sourceHash: normalizeHash(input.sourceHash, "sourceHash", "MOTIVATIONAL_WORKER_RESULT_INVALID"),
    rightsManifestHash: normalizeHash(
      input.rightsManifestHash,
      "rightsManifestHash",
      "MOTIVATIONAL_WORKER_RESULT_INVALID",
    ),
    candidateDecisionHash: normalizeHash(
      input.candidateDecisionHash,
      "candidateDecisionHash",
      "MOTIVATIONAL_WORKER_RESULT_INVALID",
    ),
    candidateHash: normalizeHash(
      input.candidateHash,
      "candidateHash",
      "MOTIVATIONAL_WORKER_RESULT_INVALID",
    ),
    experimentManifestHash: normalizeHash(
      input.experimentManifestHash,
      "experimentManifestHash",
      "MOTIVATIONAL_WORKER_RESULT_INVALID",
    ),
    transcriptManifestHash: normalizeHash(
      input.transcriptManifestHash,
      "transcriptManifestHash",
      "MOTIVATIONAL_WORKER_RESULT_INVALID",
    ),
    output: input.output,
    ranking: input.ranking,
    completedAt: String(input.completedAt || new Date().toISOString()),
  };
  return normalizeWorkerResult({ ...base, contentHash: contentHash(base) });
}

module.exports = {
  ACTION,
  DOWNLOAD_FORMATS,
  JOB_SCHEMA_VERSION,
  PIPELINE_TYPE,
  PROFILE_IDS,
  SOURCE_AREAS,
  SOURCE_EXTENSIONS,
  WORKER_RESULT_SCHEMA_VERSION,
  contentHash,
  createMotivationalWorkerResult,
  normalizeHash,
  normalizeLocalSourcePath,
  normalizeMotivationalSourceShortJobPayload,
  normalizeProfiles,
  normalizeTranscriptManifest,
  normalizeWorkerResult,
};
