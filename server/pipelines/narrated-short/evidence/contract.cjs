const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { sanitizeText, validateResourceId } = require("../../../repositories/ids.cjs");
const { contentHash } = require("../contracts.cjs");

const EVIDENCE_PROFILE_VERSION = "1.0.0";
const CONTACT_SHEET_PROFILE = "dark_curiosity_contact_sheet_v1";
const RIGHTS_PROFILE = "dark_curiosity_rights_v1";
const PROVENANCE_PROFILE = "dark_curiosity_provenance_v1";
const EXPORT_METADATA_PROFILE = "dark_curiosity_export_metadata_v1";
const SOURCE_CLASSES = Object.freeze(["primary", "institutional", "reputable_secondary", "other"]);
const OWNERSHIP_BASES = Object.freeze(["self_recorded", "licensed_recording", "ai_generated_licensed"]);
const VISUAL_ASSET_CLASSES = Object.freeze(["original_engine_generated"]);
const DEPENDENCY_ROLES = Object.freeze([
  "approved_draft", "content_brief", "claim_ledger", "narrative_script", "storyboard",
  "narration_manifest", "narration_audio", "narration_alignment", "caption_manifest", "caption_ass",
  "audio_normalization", "timeline_ir", "qa_report", "rights_manifest", "contact_sheet", "final_output",
  "animation_timing_context", "animation_plan", "animation_ir", "animation_render_manifest", "animation_qa_report", "visual_master",
]);
const REQUIRED_DEPENDENCY_ROLES = Object.freeze(DEPENDENCY_ROLES.filter((role) => !role.startsWith("animation_") && role !== "visual_master"));
const BINDING_KEYS = Object.freeze(["projectId", "projectRevision", "approvalId", "draftArtifactId", "draftHash", "outputHash", "qaReportArtifactId", "qaReportHash"]);
const ANIMATION_BINDING_KEYS = Object.freeze(["animationTimingContextArtifactId", "animationTimingContextHash", "animationPlanArtifactId", "animationPlanHash", "animationIRArtifactId", "animationIRHash", "animationRenderManifestArtifactId", "animationRenderManifestHash", "animationQaArtifactId", "animationQaHash", "visualMasterSha256", "animationCompositionHash", "animationProvider", "animationRuntimeVersion", "animationStyleVersion"]);

function fail(code, field) { throw new AppError(code, SAFE_MESSAGES[code], 409, field ? { field } : null); }
function exact(value, keys, field, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, field);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `${field}.${key}`);
}
function text(value, field, max, code) { const safe = sanitizeText(value, max); if (!safe) fail(code, field); return safe; }
function hash(value, field, code) { const safe = sanitizeText(value, 80).toLowerCase().replace(/^sha256:/, ""); if (!/^[a-f0-9]{64}$/.test(safe)) fail(code, field); return safe; }
function artifactId(value, field, code) { const safe = sanitizeText(value, 100); if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe)) fail(code, field); return safe; }
function approvalId(value, field, code) { const safe = sanitizeText(value, 100); if (!/^capr_[a-f0-9]{40}$/.test(safe)) fail(code, field); return safe; }
function integer(value, field, min, max, code) { const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) fail(code, field); return n; }
function number(value, field, min, max, code) { const n = Number(value); if (!Number.isFinite(n) || n < min || n > max) fail(code, field); return Number(n.toFixed(4)); }
function bool(value, field, expected, code) { if (typeof value !== "boolean" || (expected !== undefined && value !== expected)) fail(code, field); return value; }
function token(value, field, allowed, code) { const safe = text(value, field, 80, code).toLowerCase(); if (!allowed.includes(safe)) fail(code, field); return safe; }
function withHash(normalized, declared, code) { const calculated = contentHash(normalized); if (declared && hash(declared, "contentHash", code) !== calculated) fail(code, "contentHash"); return { ...normalized, contentHash: calculated }; }

function normalizeBindings(input, code) {
  exact(input, [...BINDING_KEYS, ...ANIMATION_BINDING_KEYS], "bindings", code);
  const normalized = {
    projectId: validateResourceId(input.projectId, "prj"),
    projectRevision: integer(input.projectRevision, "bindings.projectRevision", 1, 1_000_000, code),
    approvalId: approvalId(input.approvalId, "bindings.approvalId", code),
    draftArtifactId: artifactId(input.draftArtifactId, "bindings.draftArtifactId", code),
    draftHash: hash(input.draftHash, "bindings.draftHash", code),
    outputHash: hash(input.outputHash, "bindings.outputHash", code),
    qaReportArtifactId: artifactId(input.qaReportArtifactId, "bindings.qaReportArtifactId", code),
    qaReportHash: hash(input.qaReportHash, "bindings.qaReportHash", code),
  };
  const hasAnimation = ANIMATION_BINDING_KEYS.some((key) => input[key] !== undefined);
  if (hasAnimation && ANIMATION_BINDING_KEYS.some((key) => input[key] === undefined)) fail(code, "bindings.animation");
  if (hasAnimation) for (const key of ANIMATION_BINDING_KEYS) {
    if (key.endsWith("ArtifactId")) normalized[key] = artifactId(input[key], `bindings.${key}`, code);
    else if (key.endsWith("Hash") || key.endsWith("Sha256")) normalized[key] = hash(input[key], `bindings.${key}`, code);
    else normalized[key] = text(input[key], `bindings.${key}`, 80, code);
  }
  return normalized;
}

function normalizeContactSheet(input = {}) {
  const code = "CONTACT_SHEET_INVALID";
  exact(input, ["schemaVersion", "profile", "profileVersion", "bindings", "artifactId", "checksumSha256", "width", "height", "frameCount", "timestampsSeconds", "rendererVersion", "contentHash"], "contactSheet", code);
  const bindings = normalizeBindings(input.bindings, code);
  if (!Array.isArray(input.timestampsSeconds) || input.timestampsSeconds.length !== 6) fail(code, "timestampsSeconds");
  const timestampsSeconds = input.timestampsSeconds.map((value, index) => number(value, `timestampsSeconds[${index}]`, 0, 120, code));
  if (new Set(timestampsSeconds).size !== 6 || timestampsSeconds.some((value, index) => index && value <= timestampsSeconds[index - 1])) fail(code, "timestampsSeconds");
  const normalized = { schemaVersion: 1, profile: token(input.profile, "profile", [CONTACT_SHEET_PROFILE], code), profileVersion: token(input.profileVersion, "profileVersion", [EVIDENCE_PROFILE_VERSION], code), bindings, artifactId: artifactId(input.artifactId, "artifactId", code), checksumSha256: hash(input.checksumSha256, "checksumSha256", code), width: integer(input.width, "width", 64, 4096, code), height: integer(input.height, "height", 64, 4096, code), frameCount: integer(input.frameCount, "frameCount", 6, 6, code), timestampsSeconds, rendererVersion: text(input.rendererVersion, "rendererVersion", 80, code) };
  return withHash(normalized, input.contentHash, code);
}

function normalizeRightsManifest(input = {}) {
  const code = "RIGHTS_MANIFEST_INVALID";
  exact(input, ["schemaVersion", "status", "profile", "profileVersion", "bindings", "narration", "sources", "visualAssets", "disclosures", "contentHash"], "rightsManifest", code);
  const bindings = normalizeBindings(input.bindings, code);
  exact(input.narration, ["manifestArtifactId", "manifestHash", "audioArtifactId", "audioHash", "commercialUseAllowed", "ownershipBasis", "rightsHolder", "consentReference", "licenseReference"], "narration", code);
  const ownershipBasis = token(input.narration.ownershipBasis, "narration.ownershipBasis", OWNERSHIP_BASES, code);
  const licenseReference = sanitizeText(input.narration.licenseReference || "", 200) || null;
  if (["licensed_recording", "ai_generated_licensed"].includes(ownershipBasis) && !licenseReference) fail(code, "narration.licenseReference");
  const narration = { manifestArtifactId: artifactId(input.narration.manifestArtifactId, "narration.manifestArtifactId", code), manifestHash: hash(input.narration.manifestHash, "narration.manifestHash", code), audioArtifactId: artifactId(input.narration.audioArtifactId, "narration.audioArtifactId", code), audioHash: hash(input.narration.audioHash, "narration.audioHash", code), commercialUseAllowed: bool(input.narration.commercialUseAllowed, "narration.commercialUseAllowed", true, code), ownershipBasis, rightsHolder: text(input.narration.rightsHolder, "narration.rightsHolder", 160, code), consentReference: text(input.narration.consentReference, "narration.consentReference", 200, code), licenseReference };
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 12) fail(code, "sources");
  const sources = input.sources.map((source, index) => { exact(source, ["sourceId", "publisher", "sourceClass", "snapshotHash"], `sources[${index}]`, code); return { sourceId: text(source.sourceId, `sources[${index}].sourceId`, 80, code), publisher: text(source.publisher, `sources[${index}].publisher`, 160, code), sourceClass: token(source.sourceClass, `sources[${index}].sourceClass`, SOURCE_CLASSES, code), snapshotHash: hash(source.snapshotHash, `sources[${index}].snapshotHash`, code) }; }).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) fail(code, "sources.duplicate");
  if (!Array.isArray(input.visualAssets) || input.visualAssets.length < 1 || input.visualAssets.length > 10) fail(code, "visualAssets");
  const visualAssets = input.visualAssets.map((asset, index) => { exact(asset, ["template", "templateVersion", "rendererVersion", "assetClass"], `visualAssets[${index}]`, code); return { template: text(asset.template, `visualAssets[${index}].template`, 80, code), templateVersion: text(asset.templateVersion, `visualAssets[${index}].templateVersion`, 24, code), rendererVersion: text(asset.rendererVersion, `visualAssets[${index}].rendererVersion`, 24, code), assetClass: token(asset.assetClass, `visualAssets[${index}].assetClass`, VISUAL_ASSET_CLASSES, code) }; }).sort((a, b) => a.template.localeCompare(b.template));
  if (new Set(visualAssets.map((asset) => asset.template)).size !== visualAssets.length) fail(code, "visualAssets.duplicate");
  exact(input.disclosures, ["illustrativeReconstructionUsed", "aiDisclosureRequired", "disclosureTexts", "fontId"], "disclosures", code);
  const disclosureTexts = Array.isArray(input.disclosures.disclosureTexts) ? [...new Set(input.disclosures.disclosureTexts.map((value, index) => text(value, `disclosures.disclosureTexts[${index}]`, 120, code)))].sort() : fail(code, "disclosures.disclosureTexts");
  const disclosures = { illustrativeReconstructionUsed: bool(input.disclosures.illustrativeReconstructionUsed, "disclosures.illustrativeReconstructionUsed", undefined, code), aiDisclosureRequired: bool(input.disclosures.aiDisclosureRequired, "disclosures.aiDisclosureRequired", undefined, code), disclosureTexts, fontId: text(input.disclosures.fontId, "disclosures.fontId", 80, code) };
  const normalized = { schemaVersion: 1, status: token(input.status, "status", ["complete"], code), profile: token(input.profile, "profile", [RIGHTS_PROFILE], code), profileVersion: token(input.profileVersion, "profileVersion", [EVIDENCE_PROFILE_VERSION], code), bindings, narration, sources, visualAssets, disclosures };
  return withHash(normalized, input.contentHash, code);
}

function normalizeDependency(input, index, code) {
  exact(input, ["role", "artifactId", "hash"], `dependencies[${index}]`, code);
  const role = token(input.role, `dependencies[${index}].role`, DEPENDENCY_ROLES, code);
  const hashOnly = role === "final_output" || role === "visual_master";
  const artifact = hashOnly ? null : artifactId(input.artifactId, `dependencies[${index}].artifactId`, code);
  if (hashOnly && input.artifactId !== null) fail(code, `dependencies[${index}].artifactId`);
  return { role, artifactId: artifact, hash: hash(input.hash, `dependencies[${index}].hash`, code) };
}

function normalizeProvenanceReport(input = {}) {
  const code = "PROVENANCE_REPORT_INVALID";
  exact(input, ["schemaVersion", "status", "profile", "profileVersion", "bindings", "dependencies", "versions", "contentHash"], "provenanceReport", code);
  const bindings = normalizeBindings(input.bindings, code);
  const animationRoles = ["animation_timing_context", "animation_plan", "animation_ir", "animation_render_manifest", "animation_qa_report", "visual_master"];
  const requiredRoles = bindings.animationIRHash ? [...REQUIRED_DEPENDENCY_ROLES, ...animationRoles] : REQUIRED_DEPENDENCY_ROLES;
  if (!Array.isArray(input.dependencies) || input.dependencies.length !== requiredRoles.length) fail(code, "dependencies");
  const dependencies = input.dependencies.map((value, index) => normalizeDependency(value, index, code)).sort((a, b) => a.role.localeCompare(b.role));
  if (new Set(dependencies.map((value) => value.role)).size !== dependencies.length || requiredRoles.some((role) => !dependencies.some((value) => value.role === role))) fail(code, "dependencies");
  const byRole = Object.fromEntries(dependencies.map((value) => [value.role, value]));
  if (byRole.approved_draft.artifactId !== bindings.draftArtifactId || byRole.approved_draft.hash !== bindings.draftHash || byRole.qa_report.artifactId !== bindings.qaReportArtifactId || byRole.qa_report.hash !== bindings.qaReportHash || byRole.final_output.hash !== bindings.outputHash) fail("EVIDENCE_PACKAGE_HASH_MISMATCH", "dependencies");
  const baseVersionKeys = ["renderer", "compositor", "captionRenderer", "audioNormalization", "qaProfile", "template", "font"];
  const animationVersionKeys = ["animationProvider", "animationRuntime", "animationStyle"];
  exact(input.versions, [...baseVersionKeys, ...animationVersionKeys], "versions", code);
  if (bindings.animationIRHash && animationVersionKeys.some((key) => !input.versions[key])) fail(code, "versions.animation");
  const versions = Object.fromEntries(Object.keys(input.versions).sort().map((key) => [key, text(input.versions[key], `versions.${key}`, 80, code)]));
  const normalized = { schemaVersion: 1, status: token(input.status, "status", ["complete"], code), profile: token(input.profile, "profile", [PROVENANCE_PROFILE], code), profileVersion: token(input.profileVersion, "profileVersion", [EVIDENCE_PROFILE_VERSION], code), bindings, dependencies, versions };
  return withHash(normalized, input.contentHash, code);
}

function normalizeExportMetadata(input = {}) {
  const code = "EXPORT_METADATA_INVALID";
  exact(input, ["schemaVersion", "status", "profile", "profileVersion", "bindings", "verticalId", "formatId", "renderProfile", "media", "qa", "package", "disclosures", "technicalFinal", "qaPassed", "publishable", "publishApprovalRequired", "contentHash"], "exportMetadata", code);
  const bindings = normalizeBindings(input.bindings, code);
  if (input.verticalId !== "dark_curiosity" || input.renderProfile !== "final") fail(code, "renderProfile");
  exact(input.media, ["durationSeconds", "width", "height", "fps", "videoCodec", "audioCodec", "pixelFormat", "audioSampleRate"], "media", code);
  const media = { durationSeconds: number(input.media.durationSeconds, "media.durationSeconds", 0.1, 120, code), width: integer(input.media.width, "media.width", 1080, 1080, code), height: integer(input.media.height, "media.height", 1920, 1920, code), fps: number(input.media.fps, "media.fps", 29.99, 30.01, code), videoCodec: token(input.media.videoCodec, "media.videoCodec", ["h264"], code), audioCodec: token(input.media.audioCodec, "media.audioCodec", ["aac"], code), pixelFormat: token(input.media.pixelFormat, "media.pixelFormat", ["yuv420p"], code), audioSampleRate: integer(input.media.audioSampleRate, "media.audioSampleRate", 48000, 48000, code) };
  exact(input.qa, ["profile", "profileVersion", "reportArtifactId", "reportHash"], "qa", code);
  const qa = { profile: text(input.qa.profile, "qa.profile", 80, code), profileVersion: text(input.qa.profileVersion, "qa.profileVersion", 24, code), reportArtifactId: artifactId(input.qa.reportArtifactId, "qa.reportArtifactId", code), reportHash: hash(input.qa.reportHash, "qa.reportHash", code) };
  if (qa.reportArtifactId !== bindings.qaReportArtifactId || qa.reportHash !== bindings.qaReportHash) fail("EVIDENCE_PACKAGE_HASH_MISMATCH", "qa");
  exact(input.package, ["rightsManifestArtifactId", "rightsManifestHash", "provenanceReportArtifactId", "provenanceReportHash", "contactSheetArtifactId", "contactSheetHash"], "package", code);
  const packageRefs = Object.fromEntries(Object.entries(input.package).map(([key, value]) => [key, key.endsWith("ArtifactId") ? artifactId(value, `package.${key}`, code) : hash(value, `package.${key}`, code)]));
  exact(input.disclosures, ["aiDisclosureRequired", "illustrativeReconstructionUsed"], "disclosures", code);
  const disclosures = { aiDisclosureRequired: bool(input.disclosures.aiDisclosureRequired, "disclosures.aiDisclosureRequired", undefined, code), illustrativeReconstructionUsed: bool(input.disclosures.illustrativeReconstructionUsed, "disclosures.illustrativeReconstructionUsed", undefined, code) };
  bool(input.technicalFinal, "technicalFinal", true, code); bool(input.qaPassed, "qaPassed", true, code); bool(input.publishable, "publishable", false, code); bool(input.publishApprovalRequired, "publishApprovalRequired", true, code);
  const normalized = { schemaVersion: 1, status: token(input.status, "status", ["complete"], code), profile: token(input.profile, "profile", [EXPORT_METADATA_PROFILE], code), profileVersion: token(input.profileVersion, "profileVersion", [EVIDENCE_PROFILE_VERSION], code), bindings, verticalId: "dark_curiosity", formatId: text(input.formatId, "formatId", 80, code), renderProfile: "final", media, qa, package: packageRefs, disclosures, technicalFinal: true, qaPassed: true, publishable: false, publishApprovalRequired: true };
  return withHash(normalized, input.contentHash, code);
}

module.exports = { ANIMATION_BINDING_KEYS, CONTACT_SHEET_PROFILE, EVIDENCE_PROFILE_VERSION, EXPORT_METADATA_PROFILE, PROVENANCE_PROFILE, RIGHTS_PROFILE, REQUIRED_DEPENDENCY_ROLES, normalizeBindings, normalizeContactSheet, normalizeExportMetadata, normalizeProvenanceReport, normalizeRightsManifest };
