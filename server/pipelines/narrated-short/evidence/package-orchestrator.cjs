const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { AUDIO_PROFILE_VERSION } = require("../audio-normalization.cjs");
const { CAPTION_RENDERER_VERSION } = require("../captions/contract.cjs");
const { NARRATED_COMPOSITOR_VERSION } = require("../video-compositor.cjs");
const { RENDERER_VERSION, TEMPLATE_VERSION } = require("../scene-renderer-registry.cjs");
const { normalizeQaReport, QA_PROFILE, QA_PROFILE_VERSION } = require("../qa/contract.cjs");
const { generateContactSheet } = require("./contact-sheet.cjs");
const {
  EVIDENCE_PROFILE_VERSION, EXPORT_METADATA_PROFILE, PROVENANCE_PROFILE, RIGHTS_PROFILE,
  normalizeContactSheet, normalizeExportMetadata, normalizeProvenanceReport, normalizeRightsManifest,
} = require("./contract.cjs");

function blocked(code, field) { throw new AppError(code, SAFE_MESSAGES[code], 409, field ? { field, failedArtifactCode: field } : null); }
function sameBindings(actual, expected) {
  return Object.keys(expected).every((key) => actual[key] === expected[key]);
}
function artifactRef(role, artifactId, hash) { return { role, artifactId, hash }; }

function readBoundArtifact(contentArtifacts, artifactId, expectedType, projectId, revision, expectedHash) {
  let envelope;
  try { envelope = contentArtifacts.readJson(artifactId); } catch { blocked("EVIDENCE_PACKAGE_INCOMPLETE", expectedType); }
  if (envelope.artifactType !== expectedType || envelope.projectId !== projectId || envelope.revision !== revision) blocked("EVIDENCE_PACKAGE_BINDING_STALE", expectedType);
  if (expectedHash && envelope.contentHash !== expectedHash) blocked("EVIDENCE_PACKAGE_HASH_MISMATCH", expectedType);
  return envelope;
}

function sourceArtifacts({ project, draft, contentArtifacts }) {
  const map = [
    ["content_brief", "briefArtifactId", draft.brief.contentHash],
    ["claim_ledger", "claimLedgerArtifactId", draft.claimLedger.contentHash],
    ["narrative_script", "scriptArtifactId", draft.script.contentHash],
    ["storyboard", "storyboardArtifactId", draft.storyboard.contentHash],
  ];
  return Object.fromEntries(map.map(([type, key, expectedHash]) => {
    const envelope = readBoundArtifact(contentArtifacts, project.input[key], type, project.id, project.input.revision, expectedHash);
    return [type, { artifactId: project.input[key], envelope }];
  }));
}

function createBindings({ project, approval, draftEnvelope, outputHash, qaArtifact, qaReport = null }) {
  const bindings = {
    projectId: project.id,
    projectRevision: project.input.revision,
    approvalId: approval.approvalId,
    draftArtifactId: draftEnvelope.artifactId,
    draftHash: draftEnvelope.contentHash,
    outputHash,
    qaReportArtifactId: qaArtifact.artifact.id,
    qaReportHash: qaArtifact.envelope.contentHash,
  };
  if (qaReport && qaReport.bindings && qaReport.bindings.animationIRHash) {
    for (const key of ["animationTimingContextArtifactId", "animationTimingContextHash", "animationPlanArtifactId", "animationPlanHash", "animationIRArtifactId", "animationIRHash", "animationRenderManifestArtifactId", "animationRenderManifestHash", "animationQaArtifactId", "animationQaHash", "visualMasterSha256", "animationCompositionHash", "animationProvider", "animationRuntimeVersion", "animationStyleVersion"]) bindings[key] = qaReport.bindings[key];
  }
  return bindings;
}

function createRightsBody({ bindings, active, narration, draft, fontId }) {
  const illustrative = draft.storyboard.scenes.some((scene) => scene.visualMode === "illustrative_reconstruction");
  const disclosureTexts = draft.storyboard.scenes.map((scene) => scene.disclosure).filter(Boolean);
  const visualAssets = [...new Set(draft.storyboard.scenes.map((scene) => scene.template))].map((template) => ({ template, templateVersion: TEMPLATE_VERSION, rendererVersion: RENDERER_VERSION, assetClass: "original_engine_generated" }));
  return normalizeRightsManifest({
    schemaVersion: 1, status: "complete", profile: RIGHTS_PROFILE, profileVersion: EVIDENCE_PROFILE_VERSION, bindings,
    narration: { manifestArtifactId: active.manifestArtifactId, manifestHash: active.manifestHash, audioArtifactId: active.audioArtifactId, audioHash: active.audioHash, ...narration.rights },
    sources: draft.claimLedger.sources.map((source) => ({ sourceId: source.id, publisher: source.publisher, sourceClass: source.sourceClass, snapshotHash: source.snapshotHash })),
    visualAssets,
    disclosures: { illustrativeReconstructionUsed: illustrative, aiDisclosureRequired: illustrative, disclosureTexts, fontId },
  });
}

function validateEvidencePackage(input = {}) {
  const rights = normalizeRightsManifest(input.rights);
  const contactSheet = normalizeContactSheet(input.contactSheet);
  const provenance = normalizeProvenanceReport(input.provenance);
  const metadata = normalizeExportMetadata(input.metadata);
  const qa = normalizeQaReport(input.qa);
  const bindings = input.bindings;
  if (!sameBindings(rights.bindings, bindings) || !sameBindings(contactSheet.bindings, bindings) || !sameBindings(provenance.bindings, bindings) || !sameBindings(metadata.bindings, bindings)) blocked("EVIDENCE_PACKAGE_BINDING_STALE", "bindings");
  if (qa.status !== "passed" || qa.contentHash !== bindings.qaReportHash || qa.bindings.outputHash !== bindings.outputHash) blocked("EVIDENCE_PACKAGE_HASH_MISMATCH", "qa_report");
  if (input.rightsArtifact.envelope.contentHash !== rights.contentHash || input.provenanceArtifact.envelope.contentHash !== provenance.contentHash || input.metadataArtifact.envelope.contentHash !== metadata.contentHash) blocked("EVIDENCE_PACKAGE_HASH_MISMATCH", "json_artifacts");
  if (input.contactSheetArtifact.id !== contactSheet.artifactId || input.contactSheetArtifact.checksumSha256 !== contactSheet.checksumSha256 || input.contactSheetArtifact.status !== "available") blocked("EVIDENCE_PACKAGE_HASH_MISMATCH", "contact_sheet");
  if (metadata.package.rightsManifestArtifactId !== input.rightsArtifact.artifact.id || metadata.package.rightsManifestHash !== rights.contentHash || metadata.package.provenanceReportArtifactId !== input.provenanceArtifact.artifact.id || metadata.package.provenanceReportHash !== provenance.contentHash || metadata.package.contactSheetArtifactId !== contactSheet.artifactId || metadata.package.contactSheetHash !== contactSheet.checksumSha256) blocked("EVIDENCE_PACKAGE_HASH_MISMATCH", "export_metadata");
  const dependency = Object.fromEntries(provenance.dependencies.map((value) => [value.role, value]));
  if (dependency.rights_manifest.artifactId !== input.rightsArtifact.artifact.id || dependency.rights_manifest.hash !== rights.contentHash || dependency.contact_sheet.artifactId !== contactSheet.artifactId || dependency.contact_sheet.hash !== contactSheet.checksumSha256) blocked("EVIDENCE_PACKAGE_HASH_MISMATCH", "provenance_report");
  return { status: "complete", technicalFinal: true, qaPassed: true, publishable: false, publishApprovalRequired: true };
}

async function generateEvidencePackage(input = {}, dependencies = {}) {
  const { project, approval, draftEnvelope, draft, active, narration, alignmentArtifact, captionManifestArtifact, captionAssArtifact, normalizationArtifact, timelineArtifact, animation, qaArtifact, qaReport, qaAnalysis, outputHash, outputPath, timeline, artifactStore, artifactRepository, contentArtifacts, jobId, fontId = "managed_caption_font" } = input;
  if (!project || !approval || !draftEnvelope || !draft || !active || !qaArtifact || !contentArtifacts) blocked("EVIDENCE_PACKAGE_INCOMPLETE", "inputs");
  const qa = normalizeQaReport(qaReport);
  if (qa.status !== "passed") blocked("TECHNICAL_EXPORT_BLOCKED", "qa_report");
  const bindings = createBindings({ project, approval, draftEnvelope, outputHash, qaArtifact, qaReport: qa });
  if (qa.contentHash !== bindings.qaReportHash || qa.bindings.outputHash !== outputHash) blocked("EVIDENCE_PACKAGE_HASH_MISMATCH", "qa_report");
  const sources = sourceArtifacts({ project, draft, contentArtifacts });
  const contactGenerator = dependencies.generateContactSheet || generateContactSheet;
  const contact = await contactGenerator({ outputPath, timeline, bindings, artifactStore, artifactRepository, projectId: project.id, jobId, signal: input.signal }, { ffmpegRunner: dependencies.ffmpegRunner, ffprobeJson: dependencies.ffprobeJson });
  const contactSheet = normalizeContactSheet(contact.descriptor);
  const rights = createRightsBody({ bindings, active, narration, draft, fontId });
  const rightsArtifact = contentArtifacts.createJson({ type: "rights_manifest", projectId: project.id, jobId, revision: project.input.revision, dependencyHashes: [draftEnvelope.contentHash, active.manifestHash, active.audioHash, outputHash, qaArtifact.envelope.contentHash], body: rights });
  const dependenciesList = [
    artifactRef("approved_draft", draftEnvelope.artifactId, draftEnvelope.contentHash),
    artifactRef("content_brief", sources.content_brief.artifactId, sources.content_brief.envelope.contentHash),
    artifactRef("claim_ledger", sources.claim_ledger.artifactId, sources.claim_ledger.envelope.contentHash),
    artifactRef("narrative_script", sources.narrative_script.artifactId, sources.narrative_script.envelope.contentHash),
    artifactRef("storyboard", sources.storyboard.artifactId, sources.storyboard.envelope.contentHash),
    artifactRef("narration_manifest", active.manifestArtifactId, active.manifestHash),
    artifactRef("narration_audio", active.audioArtifactId, active.audioHash),
    artifactRef("narration_alignment", active.alignmentArtifactId, active.alignmentHash),
    artifactRef("caption_manifest", captionManifestArtifact.artifact.id, captionManifestArtifact.envelope.contentHash),
    artifactRef("caption_ass", captionAssArtifact.id, captionAssArtifact.checksumSha256),
    artifactRef("audio_normalization", normalizationArtifact.artifact.id, normalizationArtifact.envelope.contentHash),
    artifactRef("timeline_ir", timelineArtifact.artifact.id, timelineArtifact.envelope.contentHash),
    artifactRef("qa_report", qaArtifact.artifact.id, qaArtifact.envelope.contentHash),
    artifactRef("rights_manifest", rightsArtifact.artifact.id, rightsArtifact.envelope.contentHash),
    artifactRef("contact_sheet", contact.artifact.id, contact.artifact.checksumSha256),
    artifactRef("final_output", null, outputHash),
  ];
  if (bindings.animationIRHash) {
    if (!animation || animation.manifest.animationIRHash !== bindings.animationIRHash || animation.visualMasterSha256 !== bindings.visualMasterSha256) blocked("EVIDENCE_PACKAGE_BINDING_STALE", "animation");
    dependenciesList.push(
      artifactRef("animation_timing_context", animation.timingArtifact.artifact.id, animation.timingArtifact.envelope.contentHash),
      artifactRef("animation_plan", animation.planArtifact.artifact.id, animation.planArtifact.envelope.contentHash),
      artifactRef("animation_ir", animation.irArtifact.artifact.id, animation.irArtifact.envelope.contentHash),
      artifactRef("animation_render_manifest", animation.renderManifestArtifact.artifact.id, animation.renderManifestArtifact.envelope.contentHash),
      artifactRef("animation_qa_report", animation.qaArtifact.artifact.id, animation.qaArtifact.envelope.contentHash),
      artifactRef("visual_master", null, animation.visualMasterSha256),
    );
  }
  const provenanceVersions = { renderer: RENDERER_VERSION, compositor: NARRATED_COMPOSITOR_VERSION, captionRenderer: CAPTION_RENDERER_VERSION, audioNormalization: AUDIO_PROFILE_VERSION, qaProfile: QA_PROFILE_VERSION, template: TEMPLATE_VERSION, font: fontId };
  if (bindings.animationIRHash) Object.assign(provenanceVersions, { animationProvider: bindings.animationProvider, animationRuntime: bindings.animationRuntimeVersion, animationStyle: bindings.animationStyleVersion });
  const provenance = normalizeProvenanceReport({ schemaVersion: 1, status: "complete", profile: PROVENANCE_PROFILE, profileVersion: EVIDENCE_PROFILE_VERSION, bindings, dependencies: dependenciesList, versions: provenanceVersions });
  const provenanceArtifact = contentArtifacts.createJson({ type: "provenance_report", projectId: project.id, jobId, revision: project.input.revision, dependencyHashes: dependenciesList.map((value) => value.hash), body: provenance });
  const illustrative = rights.disclosures.illustrativeReconstructionUsed;
  const metadata = normalizeExportMetadata({ schemaVersion: 1, status: "complete", profile: EXPORT_METADATA_PROFILE, profileVersion: EVIDENCE_PROFILE_VERSION, bindings, verticalId: "dark_curiosity", formatId: draft.brief.formatId, renderProfile: "final", media: { durationSeconds: qaAnalysis.durationSeconds, width: qaAnalysis.width, height: qaAnalysis.height, fps: qaAnalysis.fps, videoCodec: qaAnalysis.videoCodec, audioCodec: qaAnalysis.audioCodec, pixelFormat: qaAnalysis.pixelFormat, audioSampleRate: qaAnalysis.audioSampleRate }, qa: { profile: QA_PROFILE, profileVersion: QA_PROFILE_VERSION, reportArtifactId: qaArtifact.artifact.id, reportHash: qaArtifact.envelope.contentHash }, package: { rightsManifestArtifactId: rightsArtifact.artifact.id, rightsManifestHash: rightsArtifact.envelope.contentHash, provenanceReportArtifactId: provenanceArtifact.artifact.id, provenanceReportHash: provenanceArtifact.envelope.contentHash, contactSheetArtifactId: contact.artifact.id, contactSheetHash: contact.artifact.checksumSha256 }, disclosures: { aiDisclosureRequired: illustrative, illustrativeReconstructionUsed: illustrative }, technicalFinal: true, qaPassed: true, publishable: false, publishApprovalRequired: true });
  const metadataArtifact = contentArtifacts.createJson({ type: "export_metadata", projectId: project.id, jobId, revision: project.input.revision, dependencyHashes: [outputHash, qaArtifact.envelope.contentHash, rightsArtifact.envelope.contentHash, provenanceArtifact.envelope.contentHash, contact.artifact.checksumSha256], body: metadata });
  const validation = validateEvidencePackage({ bindings, qa, rights, contactSheet, provenance, metadata, rightsArtifact, provenanceArtifact, metadataArtifact, contactSheetArtifact: contact.artifact });
  return { ...validation, bindings, contactSheet, contactSheetArtifact: contact.artifact, rights, rightsArtifact, provenance, provenanceArtifact, metadata, metadataArtifact };
}

function publicEvidenceSummary(result) {
  if (!result) return null;
  return { packageStatus: result.status, contactSheetArtifactId: result.contactSheetArtifact.id, contactSheetHash: result.contactSheetArtifact.checksumSha256, rightsManifestArtifactId: result.rightsArtifact.artifact.id, rightsManifestHash: result.rightsArtifact.envelope.contentHash, provenanceReportArtifactId: result.provenanceArtifact.artifact.id, provenanceReportHash: result.provenanceArtifact.envelope.contentHash, exportMetadataArtifactId: result.metadataArtifact.artifact.id, exportMetadataHash: result.metadataArtifact.envelope.contentHash, outputHash: result.bindings.outputHash, technicalFinal: true, qaPassed: true, publishable: false, publishApprovalRequired: true, failedArtifactCode: null };
}

module.exports = { createBindings, generateEvidencePackage, publicEvidenceSummary, validateEvidencePackage };
