const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../errors.cjs");
const { sanitizeText, validateResourceId } = require("../../repositories/ids.cjs");
const { contentHash, normalizeDraftBundle } = require("./contracts.cjs");
const { normalizeNarrationAsset, publicNarrationSummary } = require("./narration/contract.cjs");
const { normalizeAlignment } = require("./narration/alignment.cjs");

const INVALIDATION_PROFILE = "dark_curiosity_invalidation_v1";
const INVALIDATION_PROFILE_VERSION = "1.0.0";
const CHANGE_TYPES = Object.freeze(["content", "style_only"]);
const COMPONENT_KEYS = Object.freeze(["brief", "claimLedger", "script", "storyboard"]);
const INVALIDATED_CLASSES = Object.freeze(["content_approval", "narration", "alignment", "captions", "audio_normalization", "timeline", "render", "technical_qa", "contact_sheet", "rights_manifest", "provenance_report", "export_metadata", "publish_approval"]);
const PRESERVED_CLASSES = Object.freeze(["historical_artifacts", "historical_exports", "narration_audio", "narration_rights", "word_alignment_timings"]);

function fail(code, field, details = {}) { throw new AppError(code, SAFE_MESSAGES[code], 409, { field, ...details }); }
function exact(value, keys, field) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALIDATION_REPORT_INVALID", field); const allowed = new Set(keys); for (const key of Object.keys(value)) if (!allowed.has(key)) fail("INVALIDATION_REPORT_INVALID", `${field}.${key}`); }
function hash(value, field) { const safe = sanitizeText(value, 80).toLowerCase(); if (!/^[a-f0-9]{64}$/.test(safe)) fail("INVALIDATION_REPORT_INVALID", field); return safe; }
function artifactId(value, field, optional = false) { if (optional && !value) return null; const safe = sanitizeText(value, 100); if (!/^art_[A-Za-z0-9-]{8,80}$/.test(safe)) fail("INVALIDATION_REPORT_INVALID", field); return safe; }
function approvalId(value, field, optional = false) { if (optional && !value) return null; const safe = sanitizeText(value, 100); if (!/^capr_[a-f0-9]{40}$/.test(safe)) fail("INVALIDATION_REPORT_INVALID", field); return safe; }
function nullableHash(value, field) { return value ? hash(value, field) : null; }
function ref(value, field) { exact(value, ["artifactId", "hash"], field); const id = artifactId(value.artifactId, `${field}.artifactId`, true); const digest = nullableHash(value.hash, `${field}.hash`); if (Boolean(id) !== Boolean(digest)) fail("INVALIDATION_REPORT_INVALID", field); return { artifactId: id, hash: digest }; }
function classList(values, field, allowed) { if (!Array.isArray(values)) fail("INVALIDATION_REPORT_INVALID", field); const result = [...new Set(values.map((value) => sanitizeText(value, 60).toLowerCase()))].sort(); if (!result.length || result.some((value) => !allowed.includes(value)) || result.length !== values.length) fail("INVALIDATION_REPORT_INVALID", field); return result; }
function componentHashes(value, field) { exact(value, COMPONENT_KEYS, field); return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, hash(value[key], `${field}.${key}`)])); }

function normalizeInvalidationReport(input = {}) {
  exact(input, ["schemaVersion", "status", "profile", "profileVersion", "projectId", "fromRevision", "toRevision", "changeType", "requestHash", "idempotencyKeyHash", "previousComponents", "currentComponents", "previousDraft", "currentDraft", "previousApprovalId", "preservedClasses", "invalidatedClasses", "narration", "contentHash"], "invalidation");
  const fromRevision = Number(input.fromRevision); const toRevision = Number(input.toRevision);
  if (Number(input.schemaVersion) !== 1 || input.status !== "complete" || input.profile !== INVALIDATION_PROFILE || input.profileVersion !== INVALIDATION_PROFILE_VERSION || !Number.isInteger(fromRevision) || toRevision !== fromRevision + 1 || fromRevision < 1 || !CHANGE_TYPES.includes(input.changeType)) fail("INVALIDATION_REPORT_INVALID", "invalidation");
  exact(input.narration, ["status", "reused", "previousManifest", "currentManifest", "previousAlignment", "currentAlignment", "audio"], "narration");
  const narrationStatus = sanitizeText(input.narration.status, 40).toLowerCase();
  if (!["invalidated", "not_present", "rebound_unaligned", "rebound_aligned"].includes(narrationStatus) || typeof input.narration.reused !== "boolean") fail("INVALIDATION_REPORT_INVALID", "narration.status");
  const narration = { status: narrationStatus, reused: input.narration.reused, previousManifest: ref(input.narration.previousManifest, "narration.previousManifest"), currentManifest: ref(input.narration.currentManifest, "narration.currentManifest"), previousAlignment: ref(input.narration.previousAlignment, "narration.previousAlignment"), currentAlignment: ref(input.narration.currentAlignment, "narration.currentAlignment"), audio: ref(input.narration.audio, "narration.audio") };
  if ((input.changeType === "content" && narration.reused) || (narration.reused && (!narration.audio.artifactId || !narration.currentManifest.artifactId))) fail("INVALIDATION_REPORT_INVALID", "narration.reused");
  const normalized = { schemaVersion: 1, status: "complete", profile: INVALIDATION_PROFILE, profileVersion: INVALIDATION_PROFILE_VERSION, projectId: validateResourceId(input.projectId, "prj"), fromRevision, toRevision, changeType: input.changeType, requestHash: hash(input.requestHash, "requestHash"), idempotencyKeyHash: input.idempotencyKeyHash ? hash(input.idempotencyKeyHash, "idempotencyKeyHash") : null, previousComponents: componentHashes(input.previousComponents, "previousComponents"), currentComponents: componentHashes(input.currentComponents, "currentComponents"), previousDraft: ref(input.previousDraft, "previousDraft"), currentDraft: ref(input.currentDraft, "currentDraft"), previousApprovalId: approvalId(input.previousApprovalId, "previousApprovalId", true), preservedClasses: classList(input.preservedClasses, "preservedClasses", PRESERVED_CLASSES), invalidatedClasses: classList(input.invalidatedClasses, "invalidatedClasses", INVALIDATED_CLASSES), narration };
  const calculated = contentHash(normalized); if (input.contentHash && input.contentHash !== calculated) fail("INVALIDATION_REPORT_INVALID", "contentHash"); return { ...normalized, contentHash: calculated };
}

function requestIdentity({ projectId, expectedRevision, changeType, bundle }) { return contentHash({ projectId, expectedRevision, changeType, bundleHash: bundle.contentHash }); }
function keyHash(value) { const safe = sanitizeText(value || "", 160); return safe ? createHash("sha256").update(safe).digest("hex") : null; }
function bundleHashes(bundle) { return { brief: bundle.brief.contentHash, claimLedger: bundle.claimLedger.contentHash, script: bundle.script.contentHash, storyboard: bundle.storyboard.contentHash }; }

function readCurrentBundle(project, contentArtifacts) {
  const defs = [["brief", "briefArtifactId", "content_brief"], ["claimLedger", "claimLedgerArtifactId", "claim_ledger"], ["script", "scriptArtifactId", "narrative_script"], ["storyboard", "storyboardArtifactId", "storyboard"]];
  const bodies = {};
  for (const [key, pointer, type] of defs) { const envelope = contentArtifacts.readJson(project.input[pointer]); if (envelope.artifactType !== type || envelope.projectId !== project.id || envelope.revision !== project.input.revision) fail("INVALIDATION_STATE_INVALID", pointer); bodies[key] = envelope.body; }
  return normalizeDraftBundle(bodies);
}

function createRevisionArtifacts({ project, revision, bundle, contentArtifacts }) {
  const create = (type, body, deps = []) => contentArtifacts.createJson({ type, projectId: project.id, revision, dependencyHashes: deps, body });
  const brief = create("content_brief", bundle.brief);
  const claimLedger = create("claim_ledger", bundle.claimLedger, [brief.envelope.contentHash]);
  const script = create("narrative_script", bundle.script, [brief.envelope.contentHash, claimLedger.envelope.contentHash]);
  const storyboard = create("storyboard", bundle.storyboard, [script.envelope.contentHash]);
  const approvalBundle = create("approval_bundle", bundle, [brief.envelope.contentHash, claimLedger.envelope.contentHash, script.envelope.contentHash, storyboard.envelope.contentHash]);
  return { brief, claimLedger, script, storyboard, approvalBundle };
}

function carryNarration({ project, toRevision, draftArtifact, bundle, contentArtifacts, artifactRepository }) {
  const active = project.input.activeNarration;
  if (!active) return { activeNarration: null, report: { status: "not_present", reused: false, previousManifest: { artifactId: null, hash: null }, currentManifest: { artifactId: null, hash: null }, previousAlignment: { artifactId: null, hash: null }, currentAlignment: { artifactId: null, hash: null }, audio: { artifactId: null, hash: null } } };
  const audio = artifactRepository.get(active.audioArtifactId);
  if (!audio || audio.type !== "narration_audio" || audio.status !== "available" || audio.ownerProjectId !== project.id || audio.checksumSha256 !== active.audioHash) fail("NARRATION_REUSE_NOT_ALLOWED", "narration_audio");
  try {
    const oldManifestEnvelope = contentArtifacts.readJson(active.manifestArtifactId);
    const oldManifest = normalizeNarrationAsset(oldManifestEnvelope.body);
    if (oldManifestEnvelope.projectId !== project.id || oldManifestEnvelope.revision !== project.input.revision || oldManifestEnvelope.contentHash !== active.manifestHash || oldManifest.scriptHash !== bundle.script.contentHash) fail("NARRATION_REUSE_NOT_ALLOWED", "narration_manifest");
    const reboundManifest = normalizeNarrationAsset({ ...oldManifest, projectRevision: toRevision, draftArtifactId: draftArtifact.artifact.id, draftHash: draftArtifact.envelope.contentHash, contentHash: undefined });
    const manifestArtifact = contentArtifacts.createJson({ type: "narration_manifest", projectId: project.id, revision: toRevision, dependencyHashes: [oldManifestEnvelope.contentHash, draftArtifact.envelope.contentHash, active.audioHash], body: reboundManifest });
    const summary = publicNarrationSummary({ manifest: reboundManifest, manifestArtifactId: manifestArtifact.artifact.id, manifestHash: manifestArtifact.envelope.contentHash });
    let alignmentArtifact = null;
    if (active.status === "aligned") {
      const oldAlignmentEnvelope = contentArtifacts.readJson(active.alignmentArtifactId);
      const oldAlignment = normalizeAlignment(oldAlignmentEnvelope.body);
      if (oldAlignmentEnvelope.projectId !== project.id || oldAlignmentEnvelope.revision !== project.input.revision || oldAlignmentEnvelope.contentHash !== active.alignmentHash) fail("NARRATION_REUSE_NOT_ALLOWED", "narration_alignment");
      const reboundAlignment = normalizeAlignment({ ...oldAlignment, projectRevision: toRevision, draftArtifactId: draftArtifact.artifact.id, draftHash: draftArtifact.envelope.contentHash, narrationManifestArtifactId: manifestArtifact.artifact.id, narrationManifestHash: manifestArtifact.envelope.contentHash, contentHash: undefined });
      alignmentArtifact = contentArtifacts.createJson({ type: "narration_alignment", projectId: project.id, revision: toRevision, dependencyHashes: [oldAlignmentEnvelope.contentHash, manifestArtifact.envelope.contentHash, active.audioHash, draftArtifact.envelope.contentHash], body: reboundAlignment });
      Object.assign(summary, { status: "aligned", alignmentArtifactId: alignmentArtifact.artifact.id, alignmentHash: alignmentArtifact.envelope.contentHash, aligned: true, timingReady: true, renderReady: false });
    }
    return { activeNarration: summary, report: { status: alignmentArtifact ? "rebound_aligned" : "rebound_unaligned", reused: true, previousManifest: { artifactId: active.manifestArtifactId, hash: active.manifestHash }, currentManifest: { artifactId: manifestArtifact.artifact.id, hash: manifestArtifact.envelope.contentHash }, previousAlignment: { artifactId: active.alignmentArtifactId || null, hash: active.alignmentHash || null }, currentAlignment: { artifactId: alignmentArtifact && alignmentArtifact.artifact.id || null, hash: alignmentArtifact && alignmentArtifact.envelope.contentHash || null }, audio: { artifactId: active.audioArtifactId, hash: active.audioHash } } };
  } catch (error) { if (["NARRATION_REUSE_NOT_ALLOWED", "NARRATION_REBIND_FAILED"].includes(error && error.code)) throw error; throw new AppError("NARRATION_REBIND_FAILED", SAFE_MESSAGES.NARRATION_REBIND_FAILED, 409); }
}

function reviseNarratedProject(input = {}, dependencies = {}) {
  const { project, expectedRevision, changeType, idempotencyKey } = input;
  const { contentArtifacts, artifactRepository, projectRepository, approvalRepository, persistenceAdapter, publishApprovalRepository } = dependencies;
  if (!project || !contentArtifacts || !artifactRepository || !projectRepository || !approvalRepository) fail("INVALIDATION_STATE_INVALID", "dependencies");
  const type = sanitizeText(changeType, 24).toLowerCase(); if (!CHANGE_TYPES.includes(type)) fail("REVISION_CHANGE_TYPE_MISMATCH", "changeType", { changeType: type });
  const proposed = normalizeDraftBundle(input.bundle);
  const requestHash = requestIdentity({ projectId: project.id, expectedRevision: Number(expectedRevision), changeType: type, bundle: proposed });
  const idempotencyKeyHash = keyHash(idempotencyKey);
  const last = project.input.lastInvalidation;
  if (last && last.fromRevision === Number(expectedRevision)) {
    if (last.idempotencyKeyHash && idempotencyKeyHash === last.idempotencyKeyHash && last.requestHash !== requestHash) fail("REVISION_REQUEST_CONFLICT", "idempotencyKey", { currentRevision: project.input.revision, expectedRevision: Number(expectedRevision) });
    if (last.requestHash === requestHash && last.idempotencyKeyHash === idempotencyKeyHash) return { project, reportArtifact: { artifact: artifactRepository.get(last.artifactId), envelope: contentArtifacts.readJson(last.artifactId) }, replayed: true };
  }
  if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) !== project.input.revision) fail("REVISION_EXPECTATION_STALE", "expectedRevision", { expectedRevision: Number(expectedRevision), currentRevision: project.input.revision });
  const previous = readCurrentBundle(project, contentArtifacts); const before = bundleHashes(previous); const after = bundleHashes(proposed);
  const changed = COMPONENT_KEYS.filter((key) => before[key] !== after[key]); if (!changed.length) fail("REVISION_NO_CHANGES", "bundle");
  if (type === "style_only" && (changed.length !== 1 || changed[0] !== "storyboard")) fail("REVISION_CHANGE_TYPE_MISMATCH", "bundle", { changeType: type, failedDependencyClass: changed.find((key) => key !== "storyboard") || "storyboard" });
  const toRevision = project.input.revision + 1; const artifacts = createRevisionArtifacts({ project, revision: toRevision, bundle: proposed, contentArtifacts });
  const previousApproval = approvalRepository.findApproved(project.id, project.input.revision);
  const carried = type === "style_only" ? carryNarration({ project, toRevision, draftArtifact: artifacts.approvalBundle, bundle: proposed, contentArtifacts, artifactRepository }) : { activeNarration: null, report: { status: project.input.activeNarration ? "invalidated" : "not_present", reused: false, previousManifest: { artifactId: project.input.activeNarration && project.input.activeNarration.manifestArtifactId || null, hash: project.input.activeNarration && project.input.activeNarration.manifestHash || null }, currentManifest: { artifactId: null, hash: null }, previousAlignment: { artifactId: project.input.activeNarration && project.input.activeNarration.alignmentArtifactId || null, hash: project.input.activeNarration && project.input.activeNarration.alignmentHash || null }, currentAlignment: { artifactId: null, hash: null }, audio: { artifactId: null, hash: null } } };
  const preservedClasses = type === "style_only" && carried.report.reused ? ["historical_artifacts", "historical_exports", "narration_audio", "narration_rights", ...(carried.report.status === "rebound_aligned" ? ["word_alignment_timings"] : [])] : ["historical_artifacts", "historical_exports"];
  const report = normalizeInvalidationReport({ schemaVersion: 1, status: "complete", profile: INVALIDATION_PROFILE, profileVersion: INVALIDATION_PROFILE_VERSION, projectId: project.id, fromRevision: project.input.revision, toRevision, changeType: type, requestHash, idempotencyKeyHash, previousComponents: before, currentComponents: after, previousDraft: { artifactId: previousApproval && previousApproval.draftArtifactId || null, hash: previousApproval && previousApproval.draftHash || null }, currentDraft: { artifactId: artifacts.approvalBundle.artifact.id, hash: artifacts.approvalBundle.envelope.contentHash }, previousApprovalId: previousApproval && previousApproval.approvalId || null, preservedClasses, invalidatedClasses: INVALIDATED_CLASSES, narration: carried.report });
  const reportArtifact = contentArtifacts.createJson({ type: "invalidation_report", projectId: project.id, revision: toRevision, dependencyHashes: [...Object.values(before), ...Object.values(after), artifacts.approvalBundle.envelope.contentHash, ...(carried.report.reused ? [carried.report.audio.hash, carried.report.currentManifest.hash, carried.report.currentAlignment.hash].filter(Boolean) : [])], body: report });
  const oldInput = project.input; const oldStatus = project.status; const oldTitle = project.title; const oldLanguage = project.language;
  const nextInput = { type: "content_brief", revision: toRevision, briefArtifactId: artifacts.brief.artifact.id, claimLedgerArtifactId: artifacts.claimLedger.artifact.id, scriptArtifactId: artifacts.script.artifact.id, storyboardArtifactId: artifacts.storyboard.artifact.id, activeNarration: carried.activeNarration, lastInvalidation: { artifactId: reportArtifact.artifact.id, contentHash: reportArtifact.envelope.contentHash, requestHash, idempotencyKeyHash, fromRevision: project.input.revision, toRevision, changeType: type, narrationReused: carried.report.reused, approvalRequired: true } };
  const publishSnapshot = publishApprovalRepository && publishApprovalRepository.snapshotState ? publishApprovalRepository.snapshotState() : null;
  try { const updated = projectRepository.update(project.id, { input: nextInput, title: proposed.script.title, language: proposed.brief.language, status: "awaiting_approval" }); if (persistenceAdapter && typeof persistenceAdapter.persistProject === "function") persistenceAdapter.persistProject({ project: updated }); if (publishApprovalRepository) publishApprovalRepository.revokeRevision(project.id, oldInput.revision, "revision_invalidated"); return { project: updated, reportArtifact, artifacts, replayed: false }; }
  catch (error) {
    let rolledBack = project;
    try { rolledBack = projectRepository.update(project.id, { input: oldInput, status: oldStatus, title: oldTitle, language: oldLanguage }); } catch { Object.assign(project, { input: oldInput, status: oldStatus, title: oldTitle, language: oldLanguage }); if (projectRepository.records) projectRepository.records.set(project.id, project); }
    Object.assign(project, { input: oldInput, status: oldStatus, title: oldTitle, language: oldLanguage });
    try { if (persistenceAdapter && typeof persistenceAdapter.persistProject === "function") persistenceAdapter.persistProject({ project: rolledBack }); } catch { /* preserve original failure */ }
    try { if (publishSnapshot) publishApprovalRepository.restoreState(publishSnapshot); } catch { /* preserve original failure */ }
    throw error;
  }
}

function publicInvalidationSummary(project) { const value = project && project.input && project.input.lastInvalidation; return value ? { currentRevision: project.input.revision, invalidationArtifactId: value.artifactId, invalidationHash: value.contentHash, changeType: value.changeType, narrationReused: value.narrationReused, approvalRequired: true } : null; }

module.exports = { CHANGE_TYPES, INVALIDATED_CLASSES, INVALIDATION_PROFILE, INVALIDATION_PROFILE_VERSION, PRESERVED_CLASSES, normalizeInvalidationReport, publicInvalidationSummary, requestIdentity, reviseNarratedProject };
