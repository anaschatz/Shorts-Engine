const SCHEMA_VERSION = 1;
const CONTENT_TYPES = new Set(["football", "motivational", "narrated_animation"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class WorkerContractError extends Error {
  constructor(code, field) {
    super(`${code}: invalid ${field}`);
    this.name = "WorkerContractError";
    this.code = code;
    this.field = field;
  }
}

function object(value, required, optional, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerContractError("CONTRACT_SHAPE_INVALID", field);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new WorkerContractError("CONTRACT_SHAPE_INVALID", field);
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new WorkerContractError("CONTRACT_FIELD_REQUIRED", field);
  }
  return value;
}

function version(value, field = "schemaVersion") {
  if (value !== SCHEMA_VERSION) {
    throw new WorkerContractError("CONTRACT_VERSION_UNSUPPORTED", field);
  }
  return value;
}

function identifier(value, field) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", field);
  }
  return value;
}

function hash(value, field) {
  const normalized = String(value || "").toLowerCase().replace(/^sha256:/, "");
  if (!HASH_PATTERN.test(normalized)) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", field);
  }
  return normalized;
}

function number(value, field, { minimum = 0, maximum = null, integer = false } = {}) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || (integer && !Number.isInteger(value))
    || value < minimum
    || (maximum !== null && value > maximum)
  ) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", field);
  }
  return value;
}

function validateArtifactManifest(value) {
  const item = object(
    value,
    ["schemaVersion", "artifactId", "kind", "sha256", "sizeBytes"],
    ["media", "extensions"],
    "artifactManifest",
  );
  version(item.schemaVersion);
  identifier(item.artifactId, "artifactId");
  if (!["source", "transcript", "analysis", "preview", "render", "qa"].includes(item.kind)) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "kind");
  }
  hash(item.sha256, "sha256");
  number(item.sizeBytes, "sizeBytes", { minimum: 1, integer: true });
  if (item.media) {
    const media = object(
      item.media,
      ["mimeType"],
      ["durationMs", "width", "height"],
      "media",
    );
    if (
      typeof media.mimeType !== "string"
      || !/^(?:video|audio|application)\/[a-z0-9.+-]{1,64}$/.test(media.mimeType)
    ) {
      throw new WorkerContractError("CONTRACT_VALUE_INVALID", "media.mimeType");
    }
    for (const field of ["durationMs", "width", "height"]) {
      if (Object.hasOwn(media, field)) {
        number(media[field], `media.${field}`, { minimum: 1, integer: true });
      }
    }
  }
  return structuredClone(item);
}

function validateCandidate(value) {
  const item = object(
    value,
    [
      "schemaVersion",
      "candidateId",
      "sourceArtifactId",
      "startMs",
      "endMs",
      "contentType",
      "rankingScore",
      "evidence",
    ],
    ["extensions"],
    "candidate",
  );
  version(item.schemaVersion);
  identifier(item.candidateId, "candidateId");
  identifier(item.sourceArtifactId, "sourceArtifactId");
  number(item.startMs, "startMs", { integer: true });
  number(item.endMs, "endMs", { minimum: 1, integer: true });
  if (item.endMs <= item.startMs) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "endMs");
  }
  if (!CONTENT_TYPES.has(item.contentType)) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "contentType");
  }
  number(item.rankingScore, "rankingScore", { maximum: 100 });
  if (
    !Array.isArray(item.evidence)
    || item.evidence.length < 1
    || item.evidence.length > 32
    || item.evidence.some((code) => typeof code !== "string" || !CODE_PATTERN.test(code))
  ) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "evidence");
  }
  return structuredClone(item);
}

function validateHookGateDecision(value) {
  const item = object(
    value,
    ["schemaVersion", "candidateId", "gateVersion", "decision", "reasonCodes", "metrics"],
    ["extensions"],
    "hookGateDecision",
  );
  version(item.schemaVersion);
  identifier(item.candidateId, "candidateId");
  if (!["hook-gate-v2", "hook-gate-v3"].includes(item.gateVersion)) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "gateVersion");
  }
  if (!["pass", "reject", "human_review"].includes(item.decision)) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "decision");
  }
  if (
    !Array.isArray(item.reasonCodes)
    || item.reasonCodes.length > 32
    || item.reasonCodes.some((code) => typeof code !== "string" || !CODE_PATTERN.test(code))
  ) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "reasonCodes");
  }
  const metrics = object(
    item.metrics,
    ["boundaryCompleteness", "captionReadability", "visualSubjectCoverage"],
    ["latencyMs", "estimatedCostUsd"],
    "metrics",
  );
  for (const field of ["boundaryCompleteness", "captionReadability", "visualSubjectCoverage"]) {
    number(metrics[field], `metrics.${field}`, { maximum: 100 });
  }
  if (Object.hasOwn(metrics, "latencyMs")) {
    number(metrics.latencyMs, "metrics.latencyMs", { integer: true });
  }
  if (Object.hasOwn(metrics, "estimatedCostUsd")) {
    number(metrics.estimatedCostUsd, "metrics.estimatedCostUsd");
  }
  return structuredClone(item);
}

function sourceReference(value) {
  const source = object(value, ["artifactId", "sha256"], [], "source");
  identifier(source.artifactId, "source.artifactId");
  hash(source.sha256, "source.sha256");
  return source;
}

function validateAnalysisRequest(value) {
  const item = object(
    value,
    ["schemaVersion", "requestId", "operation", "source", "options"],
    ["extensions"],
    "analysisRequest",
  );
  version(item.schemaVersion);
  identifier(item.requestId, "requestId");
  if (item.operation !== "analysis") {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "operation");
  }
  sourceReference(item.source);
  const options = object(
    item.options,
    ["contentType", "language", "maxCandidates"],
    [],
    "options",
  );
  if (!CONTENT_TYPES.has(options.contentType)) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "options.contentType");
  }
  if (
    typeof options.language !== "string"
    || !/^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/.test(options.language)
  ) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "options.language");
  }
  number(options.maxCandidates, "options.maxCandidates", {
    minimum: 1,
    maximum: 100,
    integer: true,
  });
  return structuredClone(item);
}

function validateAnalysisResult(value) {
  const item = object(
    value,
    ["schemaVersion", "requestId", "operation", "status", "candidates", "hookGate"],
    ["artifact", "extensions"],
    "analysisResult",
  );
  version(item.schemaVersion);
  identifier(item.requestId, "requestId");
  if (item.operation !== "analysis" || item.status !== "succeeded") {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "status");
  }
  if (!Array.isArray(item.candidates) || item.candidates.length < 1 || item.candidates.length > 100) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "candidates");
  }
  const candidates = item.candidates.map(validateCandidate);
  if (!Array.isArray(item.hookGate) || item.hookGate.length !== candidates.length) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "hookGate");
  }
  const decisions = item.hookGate.map(validateHookGateDecision);
  const candidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
  if (
    decisions.some((decision) => !candidateIds.has(decision.candidateId))
    || new Set(decisions.map((decision) => decision.candidateId)).size !== candidateIds.size
  ) {
    throw new WorkerContractError("CONTRACT_LINK_INVALID", "hookGate");
  }
  if (item.artifact) validateArtifactManifest(item.artifact);
  return structuredClone(item);
}

function validateRenderRequest(value) {
  const item = object(
    value,
    ["schemaVersion", "requestId", "operation", "source", "candidate", "hookGate", "profile"],
    ["extensions"],
    "renderRequest",
  );
  version(item.schemaVersion);
  identifier(item.requestId, "requestId");
  if (item.operation !== "render") {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "operation");
  }
  const source = sourceReference(item.source);
  const candidate = validateCandidate(item.candidate);
  const decision = validateHookGateDecision(item.hookGate);
  if (
    candidate.sourceArtifactId !== source.artifactId
    || decision.candidateId !== candidate.candidateId
    || decision.decision !== "pass"
  ) {
    throw new WorkerContractError("CONTRACT_LINK_INVALID", "candidate");
  }
  const profile = object(
    item.profile,
    ["formatProfile", "selectionProfile", "renderProfile"],
    [],
    "profile",
  );
  for (const [field, value] of Object.entries(profile)) identifier(value, `profile.${field}`);
  return structuredClone(item);
}

function validateRenderResult(value) {
  const item = object(
    value,
    ["schemaVersion", "requestId", "operation", "status", "artifact", "qa"],
    ["extensions"],
    "renderResult",
  );
  version(item.schemaVersion);
  identifier(item.requestId, "requestId");
  if (item.operation !== "render" || item.status !== "succeeded") {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "status");
  }
  const artifact = validateArtifactManifest(item.artifact);
  if (artifact.kind !== "render") {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "artifact.kind");
  }
  const qa = object(item.qa, ["passed", "codes"], [], "qa");
  if (
    typeof qa.passed !== "boolean"
    || !Array.isArray(qa.codes)
    || qa.codes.some((code) => typeof code !== "string" || !CODE_PATTERN.test(code))
  ) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "qa");
  }
  if (!qa.passed) throw new WorkerContractError("CONTRACT_LINK_INVALID", "qa.passed");
  return structuredClone(item);
}

function validateErrorResponse(value) {
  const item = object(
    value,
    ["schemaVersion", "requestId", "status", "error"],
    ["extensions"],
    "errorResponse",
  );
  version(item.schemaVersion);
  identifier(item.requestId, "requestId");
  if (item.status !== "error") {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "status");
  }
  const error = object(item.error, ["code", "message", "retryable"], ["field"], "error");
  if (typeof error.code !== "string" || !CODE_PATTERN.test(error.code)) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "error.code");
  }
  if (typeof error.message !== "string" || error.message.length < 1 || error.message.length > 240) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "error.message");
  }
  if (typeof error.retryable !== "boolean") {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "error.retryable");
  }
  if (error.field !== undefined && (typeof error.field !== "string" || !ID_PATTERN.test(error.field))) {
    throw new WorkerContractError("CONTRACT_VALUE_INVALID", "error.field");
  }
  return structuredClone(item);
}

const VALIDATORS = Object.freeze({
  analysisRequest: validateAnalysisRequest,
  analysisResult: validateAnalysisResult,
  renderRequest: validateRenderRequest,
  renderResult: validateRenderResult,
  candidate: validateCandidate,
  hookGateDecision: validateHookGateDecision,
  artifactManifest: validateArtifactManifest,
  errorResponse: validateErrorResponse,
});

function validateFixture(payload) {
  object(payload, Object.keys(VALIDATORS), [], "fixture");
  for (const [name, validator] of Object.entries(VALIDATORS)) validator(payload[name]);
}

module.exports = {
  SCHEMA_VERSION,
  VALIDATORS,
  WorkerContractError,
  validateAnalysisRequest,
  validateAnalysisResult,
  validateRenderRequest,
  validateRenderResult,
  validateCandidate,
  validateHookGateDecision,
  validateArtifactManifest,
  validateErrorResponse,
  validateFixture,
};
