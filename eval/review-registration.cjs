const {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { basename, dirname, extname, join, relative, resolve, sep } = require("node:path");
const { AppError, SAFE_MESSAGES } = require("../server/errors.cjs");
const { nowIso, sanitizeText, validateResourceId } = require("../server/repositories/ids.cjs");
const {
  buildReviewComparisonReport,
  findReviewSensitiveLeak,
  validateReviewInput,
} = require("./review-comparison.cjs");

const REVIEW_DRAFT_SCHEMA_VERSION = 1;
const DEFAULT_DRAFTS_DIR = "eval/review-drafts";
const DEFAULT_PROJECTS_DIR = "data/projects";
const MAX_STATE_FILE_BYTES = 1024 * 1024;
const SUPPORTED_MEDIA_EXTENSIONS = Object.freeze([".mp4", ".mov", ".webm"]);
const SAFE_TOKEN_RE = /^[a-z0-9][a-z0-9_:-]{1,100}$/i;

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
}

function normalizeRelative(value) {
  return String(value || "").split(sep).join("/");
}

function pathIsInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !resolve(rel).startsWith(".."));
}

function canonicalExistingPath(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

function safeFailure(code, message, field = null) {
  return new AppError(code, message || SAFE_MESSAGES[code] || SAFE_MESSAGES.VALIDATION_ERROR, 400, field ? { field } : null);
}

function safeRelativeRef(rootDir, candidate, field = "relativePath", { mustExist = false } = {}) {
  const text = String(candidate || "").trim().replace(/\\/g, "/");
  if (
    !text ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    /^https?:\/\//i.test(text) ||
    /^file:\/\//i.test(text) ||
    text.includes("\0") ||
    text.split("/").some((part) => part === "..")
  ) {
    throw safeFailure("VALIDATION_ERROR", `${field} must be a safe workspace-relative path.`, field);
  }
  const resolvedRoot = canonicalExistingPath(resolve(rootDir));
  const resolvedFile = resolve(resolvedRoot, text);
  const comparisonFile = existsSync(resolvedFile) ? canonicalExistingPath(resolvedFile) : resolvedFile;
  if (!pathIsInside(resolvedRoot, comparisonFile)) {
    throw safeFailure("VALIDATION_ERROR", `${field} must stay inside the workspace.`, field);
  }
  if (mustExist && !existsSync(resolvedFile)) {
    throw safeFailure("ARTIFACT_NOT_FOUND", "The requested review artifact was not found.", field);
  }
  return {
    relativePath: normalizeRelative(relative(resolvedRoot, resolvedFile)),
    resolvedFile: comparisonFile,
  };
}

function safeRelativeFromAbsolute(rootDir, absoluteCandidate, field) {
  const text = String(absoluteCandidate || "").trim();
  if (
    !text ||
    /^https?:\/\//i.test(text) ||
    /^file:\/\//i.test(text) ||
    text.includes("\0")
  ) {
    throw safeFailure("VALIDATION_ERROR", `${field} must be a local artifact path.`, field);
  }
  const resolvedRoot = canonicalExistingPath(resolve(rootDir));
  const resolvedFile = existsSync(text) ? canonicalExistingPath(text) : resolve(text);
  if (!pathIsInside(resolvedRoot, resolvedFile)) {
    throw safeFailure("STORAGE_PATH_UNSAFE", "Review artifacts must resolve inside the workspace.", field);
  }
  const relativePath = normalizeRelative(relative(resolvedRoot, resolvedFile));
  if (!relativePath || relativePath.startsWith("../")) {
    throw safeFailure("STORAGE_PATH_UNSAFE", "Review artifact references must be workspace-relative.", field);
  }
  return { relativePath, resolvedFile };
}

function readJsonSafe(rootDir, relativePath, field) {
  const ref = safeRelativeRef(rootDir, relativePath, field, { mustExist: true });
  const stats = statSync(ref.resolvedFile);
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_STATE_FILE_BYTES) {
    throw safeFailure("VALIDATION_ERROR", `${field} is empty, too large, or not a file.`, field);
  }
  try {
    return JSON.parse(readFileSync(ref.resolvedFile, "utf8"));
  } catch {
    throw safeFailure("VALIDATION_ERROR", `${field} must contain valid JSON.`, field);
  }
}

function assertMediaFile(ref, role) {
  const extension = extname(ref.relativePath).toLowerCase();
  if (!SUPPORTED_MEDIA_EXTENSIONS.includes(extension)) {
    throw safeFailure("VALIDATION_ERROR", `${role} media must be mp4, mov, or webm.`, `media.${role}`);
  }
  if (!existsSync(ref.resolvedFile)) {
    throw safeFailure("ARTIFACT_NOT_FOUND", `${role} media artifact is missing.`, `media.${role}`);
  }
  const stats = statSync(ref.resolvedFile);
  if (!stats.isFile() || stats.size <= 0) {
    throw safeFailure("ARTIFACT_NOT_FOUND", `${role} media artifact is empty or unreadable.`, `media.${role}`);
  }
  return {
    relativePath: ref.relativePath,
    sizeBytes: stats.size,
    extension,
  };
}

function validateRegistrationInput(input = {}) {
  const projectId = validateResourceId(input.projectId || input.project, "prj");
  const jobId = validateResourceId(input.jobId || input.job, "job");
  const exportId = input.exportId || input.export ? validateResourceId(input.exportId || input.export, "exp") : null;
  const rightsConfirmed = input.rightsConfirmed === true || input.rightsConfirmed === "true" || input.rightsConfirmed === "1";
  if (!rightsConfirmed) {
    throw safeFailure("VALIDATION_ERROR", "rightsConfirmed must be true before registering a generated review draft.", "rightsConfirmed");
  }
  return {
    projectId,
    jobId,
    exportId,
    rightsConfirmed,
    reference: input.reference ? sanitizeText(input.reference, 300) : null,
    renderRecord: input.renderRecord ? sanitizeText(input.renderRecord, 300) : null,
    projectRecord: input.projectRecord ? sanitizeText(input.projectRecord, 300) : null,
    outputDir: sanitizeText(input.outputDir || DEFAULT_DRAFTS_DIR, 300),
    reviewerNotes: sanitizeText(input.reviewerNotes || "", 1000),
    title: input.title ? sanitizeText(input.title, 160) : null,
    timestamp: input.timestamp || nowIso(),
  };
}

function safeToken(value, fallback, maxLength = 100) {
  const token = sanitizeText(value || fallback || "", maxLength).toLowerCase();
  return SAFE_TOKEN_RE.test(token) ? token : sanitizeText(fallback || "unknown", maxLength).toLowerCase();
}

function safeArray(value, mapper, maxItems = 24) {
  return (Array.isArray(value) ? value : []).slice(0, maxItems).map(mapper).filter((item) => item !== null && item !== undefined);
}

function validWindow(start, end) {
  const safeStart = toNumber(start, Number.NaN);
  const safeEnd = toNumber(end, Number.NaN);
  if (!Number.isFinite(safeStart) || !Number.isFinite(safeEnd) || safeStart < 0 || safeEnd <= safeStart) {
    return null;
  }
  return { start: round(safeStart), end: round(safeEnd) };
}

function selectedMomentFromRecord(renderRecord) {
  const editPlan = renderRecord.editPlan || {};
  const highlights = Array.isArray(renderRecord.highlights) ? renderRecord.highlights : [];
  const primary = highlights[0] || {};
  const window = validWindow(
    primary.start ?? editPlan.sourceStart,
    primary.end ?? editPlan.sourceEnd,
  );
  if (!window) {
    throw safeFailure("AI_OUTPUT_INVALID", "Rendered review registration needs a valid selected moment window.", "selectedMoment");
  }
  const momentType = safeToken(primary.highlightType || primary.momentType || editPlan.highlightType, "generic_highlight", 80);
  return {
    ...window,
    momentType,
    reasonCodes: safeArray(primary.reasonCodes || editPlan.reasonCodes, (reason) => safeToken(reason, null, 80), 20),
    retentionScore: toNumber(primary.retentionScore ?? editPlan.retentionScore, 0),
  };
}

function sanitizeCaption(caption) {
  if (!caption || typeof caption !== "object") return null;
  const window = validWindow(caption.start, caption.end);
  const text = sanitizeText(caption.text, 160);
  if (!window || !text) return null;
  return {
    ...window,
    role: safeToken(caption.role, "caption", 60),
    text,
  };
}

function sanitizeAnimationCue(cue) {
  if (typeof cue === "string") {
    const type = safeToken(cue, null, 80);
    return type ? { type } : null;
  }
  if (!cue || typeof cue !== "object") return null;
  const type = safeToken(cue.type, null, 80);
  if (!type) return null;
  const start = toNumber(cue.start, Number.NaN);
  const end = toNumber(cue.end, Number.NaN);
  return {
    type,
    ...(Number.isFinite(start) ? { start: round(start) } : {}),
    ...(Number.isFinite(end) && (!Number.isFinite(start) || end > start) ? { end: round(end) } : {}),
  };
}

function sanitizeCropStrategy(strategy) {
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) return null;
  return {
    type: safeToken(strategy.type, "wide_safe_contain", 80),
    zoom: toNumber(strategy.zoom, 1),
    preserveFullFrame: strategy.preserveFullFrame !== false,
    maxCropPercent: toNumber(strategy.maxCropPercent, 0),
  };
}

function sanitizeEditPlan(editPlan = {}, selectedMoment = null) {
  if (!editPlan || typeof editPlan !== "object" || Array.isArray(editPlan)) {
    throw safeFailure("AI_OUTPUT_INVALID", "Rendered review registration needs an edit plan.", "editPlan");
  }
  const window = validWindow(editPlan.sourceStart, editPlan.sourceEnd) || selectedMoment;
  if (!window) {
    throw safeFailure("AI_OUTPUT_INVALID", "Edit plan must include valid sourceStart/sourceEnd.", "editPlan");
  }
  const sanitized = {
    sourceStart: window.start,
    sourceEnd: window.end,
    sourceWidth: toNumber(editPlan.sourceWidth || editPlan.width, 1920),
    sourceHeight: toNumber(editPlan.sourceHeight || editPlan.height, 1080),
    sourceDurationSeconds: toNumber(editPlan.sourceDurationSeconds, window.end),
    aspectRatio: sanitizeText(editPlan.aspectRatio || "9:16", 20),
    stylePreset: safeToken(editPlan.stylePreset, "social_sports_v1", 80),
    styleTarget: safeToken(editPlan.styleTarget, "vertical_9_16_reference_style", 80),
    highlightType: safeToken(editPlan.highlightType || (selectedMoment && selectedMoment.momentType), "generic_highlight", 80),
    reasonCodes: safeArray(editPlan.reasonCodes || (selectedMoment && selectedMoment.reasonCodes), (reason) => safeToken(reason, null, 80), 20),
    framingMode: safeToken(editPlan.framingMode, "wide_safe_vertical", 80),
    captions: safeArray(editPlan.captions, sanitizeCaption, 20),
    animationCues: safeArray(editPlan.animationCues, sanitizeAnimationCue, 24),
  };
  const cropStrategy = sanitizeCropStrategy(editPlan.cropStrategy);
  if (cropStrategy) sanitized.cropStrategy = cropStrategy;
  if (!sanitized.captions.length) {
    throw safeFailure("AI_OUTPUT_INVALID", "Edit plan needs captions before review registration.", "editPlan.captions");
  }
  return sanitized;
}

function expectedFromPlan(editPlan, selectedMoment) {
  const duration = Math.max(1, round(editPlan.sourceEnd - editPlan.sourceStart));
  const requiredAnimationCues = [...new Set(editPlan.animationCues.map((cue) => cue.type).filter(Boolean))].slice(0, 12);
  const explicitGoalEvidence =
    selectedMoment.momentType === "goal" &&
    selectedMoment.reasonCodes.some((reason) => ["goal", "explicit_goal_evidence", "scoreboard_goal_evidence"].includes(reason));
  return {
    styleTarget: editPlan.styleTarget,
    stylePreset: editPlan.stylePreset,
    momentType: selectedMoment.momentType,
    acceptedMomentTypes: [selectedMoment.momentType],
    selectedMomentWindow: { start: editPlan.sourceStart, end: editPlan.sourceEnd },
    aspectRatio: editPlan.aspectRatio,
    durationRange: [Math.max(1, round(duration - 1)), round(duration + 1)],
    requiredAnimationCues,
    captionMustMentionAny: [],
    safety: {
      noFalseGoalClaim: !explicitGoalEvidence,
      allowGoalClaim: explicitGoalEvidence,
    },
    threshold: 82,
    referenceStyleFallbackAllowed: true,
  };
}

function defaultRenderRecordPath(projectId) {
  return join(DEFAULT_PROJECTS_DIR, `${projectId}.render.json`);
}

function defaultProjectRecordPath(projectId) {
  return join(DEFAULT_PROJECTS_DIR, `${projectId}.json`);
}

function loadRegistrationRecords(rootDir, input) {
  const renderRecord = readJsonSafe(rootDir, input.renderRecord || defaultRenderRecordPath(input.projectId), "renderRecord");
  const projectRecord = readJsonSafe(rootDir, input.projectRecord || defaultProjectRecordPath(input.projectId), "projectRecord");
  return { renderRecord, projectRecord };
}

function assertCompletedRenderRecord(renderRecord, input) {
  const project = renderRecord.project || {};
  const job = renderRecord.job || {};
  const exportRecord = renderRecord.exportRecord || {};
  if (project.id !== input.projectId || job.projectId && job.projectId !== input.projectId) {
    throw safeFailure("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, "projectId");
  }
  if (job.id !== input.jobId) {
    throw safeFailure("JOB_NOT_FOUND", SAFE_MESSAGES.JOB_NOT_FOUND, "jobId");
  }
  if (job.status !== "completed") {
    throw safeFailure("JOB_STATE_INVALID", "Only completed render jobs can be registered for review.", "job.status");
  }
  const exportId = input.exportId || renderRecord.exportId || job.exportId || exportRecord.id;
  if (!exportId || exportRecord.id !== exportId || renderRecord.exportId && renderRecord.exportId !== exportId) {
    throw safeFailure("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, "exportId");
  }
  if (exportRecord.projectId !== input.projectId || exportRecord.jobId !== input.jobId) {
    throw safeFailure("EXPORT_NOT_FOUND", SAFE_MESSAGES.EXPORT_NOT_FOUND, "exportRecord");
  }
  return { project, job, exportRecord, exportId };
}

function mediaRefFromLocalCandidate(rootDir, candidate, field, role) {
  if (!candidate) {
    throw safeFailure("ARTIFACT_NOT_FOUND", `${role} artifact reference is missing.`, field);
  }
  const ref = String(candidate).startsWith("/") || /^[A-Za-z]:\//.test(String(candidate))
    ? safeRelativeFromAbsolute(rootDir, candidate, field)
    : safeRelativeRef(rootDir, candidate, field);
  return assertMediaFile(ref, role);
}

function resolveGeneratedMedia(rootDir, renderRecord, exportRecord) {
  return mediaRefFromLocalCandidate(
    rootDir,
    exportRecord.localRelativePath ||
      exportRecord.relativePath ||
      exportRecord.mediaRef ||
      exportRecord.outputPath ||
      (renderRecord.job && renderRecord.job.outputPath),
    "exportRecord",
    "generated",
  );
}

function resolveSourceMedia(rootDir, projectRecord, renderRecord) {
  const upload = projectRecord.upload || renderRecord.upload || {};
  return mediaRefFromLocalCandidate(
    rootDir,
    upload.localRelativePath ||
      upload.relativePath ||
      upload.mediaRef ||
      upload.path,
    "upload",
    "source",
  );
}

function buildReviewDraft({ renderRecord, projectRecord, input, rootDir }) {
  const { project, job, exportRecord, exportId } = assertCompletedRenderRecord(renderRecord, input);
  const generated = resolveGeneratedMedia(rootDir, renderRecord, exportRecord);
  const source = resolveSourceMedia(rootDir, projectRecord, renderRecord);
  const selectedMoment = selectedMomentFromRecord(renderRecord);
  const editPlan = sanitizeEditPlan(renderRecord.editPlan, selectedMoment);
  const expected = expectedFromPlan(editPlan, selectedMoment);
  const reference = input.reference
    ? { relativePath: assertMediaFile(safeRelativeRef(rootDir, input.reference, "reference"), "reference").relativePath }
    : null;
  const upload = projectRecord.upload || renderRecord.upload || {};
  const draft = {
    schemaVersion: REVIEW_DRAFT_SCHEMA_VERSION,
    id: safeToken(`review_${project.id.replace(/^prj_/, "")}_${job.id.replace(/^job_/, "")}`, "review_generated_output", 100),
    title: input.title || sanitizeText(project.title || job.payload && job.payload.title || "Registered generated short", 160),
    language: sanitizeText(job.payload && job.payload.language || editPlan.language || "auto", 40),
    media: {
      generated: { relativePath: generated.relativePath },
      source: { relativePath: source.relativePath },
      reference,
    },
    expected,
    generatedMetadata: {
      selectedMoment,
      editPlan,
      registration: {
        projectId: project.id,
        jobId: job.id,
        exportId,
        uploadId: sanitizeText(upload.id || project.uploadId || job.uploadId || "", 120),
        sourceArtifactId: sanitizeText(upload.artifact && upload.artifact.id || upload.id || "", 120),
        generatedArtifactId: sanitizeText(exportRecord.artifact && exportRecord.artifact.id || exportId, 120),
        styleTarget: editPlan.styleTarget,
        stylePreset: editPlan.stylePreset,
        momentType: selectedMoment.momentType,
        noFalseGoalExpected: expected.safety.noFalseGoalClaim,
        registeredAt: input.timestamp,
      },
    },
    consent: {
      rightsConfirmed: input.rightsConfirmed,
      reviewPurpose: "local_generated_output_review",
      source: "review_registration",
    },
    reviewerNotes: input.reviewerNotes,
  };
  const validated = validateReviewInput(draft, { rootDir });
  const report = buildReviewComparisonReport(validated, { timestamp: input.timestamp });
  const leak = findReviewSensitiveLeak(draft) || findReviewSensitiveLeak(report);
  if (leak) {
    throw safeFailure("VALIDATION_ERROR", "Review registration produced unsafe draft content.", leak.path);
  }
  return { draft, validation: validated, comparisonPreview: report };
}

function safeTimestamp(value) {
  return String(value || nowIso()).replace(/[:.]/g, "-");
}

function safeWriteJson(filePath, payload) {
  if (existsSync(filePath)) {
    renameSync(filePath, `${filePath}.previous-${Date.now()}`);
  }
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeReviewDraft({ draft, outputDir, rootDir, timestamp }) {
  const outputRef = safeRelativeRef(rootDir, outputDir, "outputDir");
  mkdirSync(outputRef.resolvedFile, { recursive: true });
  const fileName = `review-draft-${draft.generatedMetadata.registration.projectId}-${draft.generatedMetadata.registration.jobId}-${safeTimestamp(timestamp)}.json`;
  const latestRef = safeRelativeRef(rootDir, join(outputDir, "review-draft-latest.json"), "outputDir.latest");
  const timestampedRef = safeRelativeRef(rootDir, join(outputDir, basename(fileName)), "outputDir.timestamped");
  const leak = findReviewSensitiveLeak(draft);
  if (leak) {
    throw safeFailure("VALIDATION_ERROR", "Review draft contained unsafe data and was not written.", leak.path);
  }
  mkdirSync(dirname(timestampedRef.resolvedFile), { recursive: true });
  safeWriteJson(latestRef.resolvedFile, draft);
  safeWriteJson(timestampedRef.resolvedFile, draft);
  return {
    latestPath: latestRef.relativePath,
    draftPath: timestampedRef.relativePath,
  };
}

function registerReviewDraft(options = {}) {
  const rootDir = resolve(options.rootDir || process.cwd());
  const input = validateRegistrationInput(options);
  const { renderRecord, projectRecord } = loadRegistrationRecords(rootDir, input);
  const built = buildReviewDraft({ renderRecord, projectRecord, input, rootDir });
  const output = options.write === false
    ? null
    : writeReviewDraft({
        draft: built.draft,
        outputDir: input.outputDir,
        rootDir,
        timestamp: input.timestamp,
      });
  return {
    ...built,
    output,
    compareCommand: output ? `npm run review:compare -- --input=${output.latestPath}` : null,
  };
}

module.exports = {
  DEFAULT_DRAFTS_DIR,
  REVIEW_DRAFT_SCHEMA_VERSION,
  buildReviewDraft,
  registerReviewDraft,
  safeRelativeRef,
  validateRegistrationInput,
  writeReviewDraft,
};
