const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { sanitizeText } = require("../repositories/ids.cjs");

const PIPELINE_TYPES = Object.freeze(["clip", "narrated_short"]);
const NARRATED_ACTIONS = Object.freeze(["draft_narrated_short", "align_narration", "render_narrated_short"]);
const RENDER_PROFILES = Object.freeze(["preview", "final"]);

function pipelineTypeForAction(action, explicitType = null) {
  const safeAction = sanitizeText(action || "generate", 60).toLowerCase();
  const inferred = NARRATED_ACTIONS.includes(safeAction) ? "narrated_short" : "clip";
  if (explicitType === null || explicitType === undefined || explicitType === "") return inferred;
  const safeType = sanitizeText(explicitType, 40).toLowerCase();
  if (!PIPELINE_TYPES.includes(safeType) || safeType !== inferred) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, {
      field: "pipelineType",
      action: safeAction,
    });
  }
  return safeType;
}

function normalizeArtifactId(value, field, required = true) {
  const safe = sanitizeText(value || "", 100);
  if (!safe && !required) return null;
  if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field });
  }
  return safe;
}

function normalizeHash(value, field, required = true) {
  const safe = sanitizeText(value || "", 80).toLowerCase().replace(/^sha256:/, "");
  if (!safe && !required) return null;
  if (!/^[a-f0-9]{64}$/.test(safe)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field });
  }
  return safe;
}

function normalizeNarratedJobPayload(payload = {}, action) {
  const safeAction = sanitizeText(action, 60).toLowerCase();
  if (!NARRATED_ACTIONS.includes(safeAction)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "action" });
  }
  const projectRevision = Number(payload.projectRevision);
  if (!Number.isInteger(projectRevision) || projectRevision < 1 || projectRevision > 1_000_000) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "projectRevision" });
  }
  const normalized = {
    schemaVersion: 1,
    projectRevision,
    language: sanitizeText(payload.language || "en", 12).toLowerCase(),
  };
  if (!['el', 'en'].includes(normalized.language)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "language" });
  }
  if (safeAction === "draft_narrated_short") {
    normalized.briefArtifactId = normalizeArtifactId(payload.briefArtifactId, "briefArtifactId");
    normalized.claimLedgerArtifactId = normalizeArtifactId(payload.claimLedgerArtifactId, "claimLedgerArtifactId", false);
    normalized.scriptArtifactId = normalizeArtifactId(payload.scriptArtifactId, "scriptArtifactId", false);
    normalized.storyboardArtifactId = normalizeArtifactId(payload.storyboardArtifactId, "storyboardArtifactId", false);
    normalized.providerMode = sanitizeText(payload.providerMode || "manual", 40).toLowerCase();
    if (!["manual", "structured"].includes(normalized.providerMode)) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "providerMode" });
    }
  } else if (safeAction === "align_narration") {
    normalized.approvedDraftArtifactId = normalizeArtifactId(payload.approvedDraftArtifactId, "approvedDraftArtifactId");
    normalized.approvedDraftHash = normalizeHash(payload.approvedDraftHash, "approvedDraftHash");
    normalized.narrationManifestArtifactId = normalizeArtifactId(payload.narrationManifestArtifactId, "narrationManifestArtifactId");
    normalized.narrationManifestHash = normalizeHash(payload.narrationManifestHash, "narrationManifestHash");
    normalized.audioArtifactId = normalizeArtifactId(payload.audioArtifactId, "audioArtifactId");
    normalized.audioHash = normalizeHash(payload.audioHash, "audioHash");
    normalized.scriptHash = normalizeHash(payload.scriptHash, "scriptHash");
    normalized.alignerVersion = sanitizeText(payload.alignerVersion, 80).toLowerCase();
    if (!/^local_faster_whisper_[a-f0-9]{16}$/.test(normalized.alignerVersion)) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "alignerVersion" });
    }
  } else {
    normalized.approvedDraftArtifactId = normalizeArtifactId(payload.approvedDraftArtifactId, "approvedDraftArtifactId");
    normalized.approvedDraftHash = normalizeHash(payload.approvedDraftHash, "approvedDraftHash");
    const renderProfile = sanitizeText(payload.renderProfile || "preview", 24).toLowerCase();
    if (!RENDER_PROFILES.includes(renderProfile)) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "renderProfile" });
    }
    normalized.renderProfile = renderProfile;
    normalized.narrationManifestHash = normalizeHash(payload.narrationManifestHash, "narrationManifestHash", false);
    normalized.audioHash = normalizeHash(payload.audioHash, "audioHash", false);
    normalized.alignmentHash = normalizeHash(payload.alignmentHash, "alignmentHash", false);
    normalized.captionRendererVersion = sanitizeText(payload.captionRendererVersion || "ass_caption_v1", 60).toLowerCase();
    normalized.captionProfileVersion = sanitizeText(payload.captionProfileVersion || "1.0.0", 20).toLowerCase();
    normalized.audioNormalizationProfileVersion = sanitizeText(payload.audioNormalizationProfileVersion || "1.0.0", 20).toLowerCase();
    normalized.compositorVersion = sanitizeText(payload.compositorVersion || "narrated_compositor_v2", 60).toLowerCase();
    normalized.qaProfileVersion = sanitizeText(payload.qaProfileVersion || "1.1.0", 20).toLowerCase();
    normalized.evidenceProfileVersion = sanitizeText(payload.evidenceProfileVersion || "1.0.0", 20).toLowerCase();
    const hasAnimationBindings = ["timingContextHash", "animationPlanHash", "animationIRHash", "animationProvider", "animationRuntimeVersion", "animationStyleVersion"].some((key) => payload[key] !== undefined && payload[key] !== null);
    if (hasAnimationBindings) {
      normalized.timingContextHash = normalizeHash(payload.timingContextHash, "timingContextHash");
      normalized.animationPlanHash = normalizeHash(payload.animationPlanHash, "animationPlanHash");
      normalized.animationIRHash = normalizeHash(payload.animationIRHash, "animationIRHash");
      normalized.animationProvider = sanitizeText(payload.animationProvider, 80).toLowerCase();
      normalized.animationRuntimeVersion = sanitizeText(payload.animationRuntimeVersion, 24).toLowerCase();
      normalized.animationStyleVersion = sanitizeText(payload.animationStyleVersion, 24).toLowerCase();
      if (normalized.animationProvider !== "hyperframes_local" || normalized.animationRuntimeVersion !== "0.7.55" || normalized.animationStyleVersion !== "1.5.0") throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "animationVersion" });
    }
    if (normalized.captionRendererVersion !== "ass_caption_v1" || normalized.captionProfileVersion !== "1.0.0" || normalized.audioNormalizationProfileVersion !== "1.0.0" || normalized.compositorVersion !== "narrated_compositor_v2" || normalized.qaProfileVersion !== "1.1.0" || normalized.evidenceProfileVersion !== "1.0.0") {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "renderVersion" });
    }
  }
  return normalized;
}

function descriptorForJob(job = {}) {
  const action = sanitizeText(job.action || "generate", 60).toLowerCase();
  const pipelineType = pipelineTypeForAction(action, job.pipelineType);
  return {
    action,
    pipelineType,
    requiresUpload: pipelineType === "clip",
  };
}

function unavailableHandler(action) {
  return async function pipelineHandlerUnavailable() {
    throw new AppError("PIPELINE_HANDLER_UNAVAILABLE", "The requested pipeline is not available.", 503, { action });
  };
}

function createPipelineRegistry(options = {}) {
  const handlers = new Map([
    ["clip", options.clipHandler || unavailableHandler("clip")],
    ["draft_narrated_short", options.narratedDraftHandler || unavailableHandler("draft_narrated_short")],
    ["align_narration", options.narrationAlignHandler || unavailableHandler("align_narration")],
    ["render_narrated_short", options.narratedRenderHandler || unavailableHandler("render_narrated_short")],
  ]);
  return {
    descriptorForJob,
    resolve(job) {
      const descriptor = descriptorForJob(job);
      const key = descriptor.pipelineType === "clip" ? "clip" : descriptor.action;
      const handler = handlers.get(key);
      if (typeof handler !== "function") return { ...descriptor, handler: unavailableHandler(key) };
      return { ...descriptor, handler };
    },
  };
}

module.exports = {
  NARRATED_ACTIONS,
  PIPELINE_TYPES,
  RENDER_PROFILES,
  createPipelineRegistry,
  descriptorForJob,
  normalizeNarratedJobPayload,
  pipelineTypeForAction,
};
