const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { normalizeNarrationAsset } = require("../narration/contract.cjs");
const { normalizeAlignment } = require("../narration/alignment.cjs");
const { normalizeQaReport } = require("../qa/contract.cjs");
const { normalizeExportMetadata, normalizeProvenanceReport, normalizeRightsManifest } = require("../evidence/contract.cjs");
const { normalizeWarnings } = require("./contract.cjs");

const QA_WARNING_MAP = Object.freeze({ WARNING_READING_RATE: "READING_RATE_NEAR_LIMIT", WARNING_SOURCE_DIVERSITY: "SOURCE_DIVERSITY_WARNING", WARNING_VISUAL_STASIS: "VISUAL_STASIS_WARNING" });
function blocked(code, details = {}) { throw new AppError("PUBLISH_GUARD_BLOCKED", SAFE_MESSAGES.PUBLISH_GUARD_BLOCKED, 409, { blockerCodes: [code], ...details }); }
function readBound(content, id, type, project, hash = null) { let envelope; try { envelope = content.readJson(id); } catch { blocked("MISSING_EVIDENCE_ARTIFACT"); } if (envelope.artifactType !== type || envelope.projectId !== project.id || envelope.revision !== project.input.revision || (hash && envelope.contentHash !== hash)) blocked("STALE_EVIDENCE_ARTIFACT"); return envelope; }
function sameBindings(bindings, expected) { for (const [key, value] of Object.entries(expected)) if (bindings[key] !== value) blocked("EVIDENCE_HASH_MISMATCH"); }
function evaluateTtsNarrationRelease(narration, active) {
  if (narration.rights.ownershipBasis !== "ai_generated_licensed") return { applicable: false, publishable: true };
  const tts = narration.ttsProvenance;
  if (!tts) blocked("TTS_PROVENANCE_MISSING");
  if (tts.audio.sha256 !== active.audioHash || tts.script.approved !== true) blocked("TTS_PROVENANCE_MISMATCH");
  if (tts.voiceCloned || tts.impersonated) blocked("TTS_VOICE_PROHIBITED");
  if (!tts.license.commercialUseAttested) blocked("TTS_COMMERCIAL_ATTESTATION_REQUIRED");
  if (tts.provider === "mock") blocked("TTS_MOCK_NON_PUBLISHABLE");
  if (tts.publishable !== true || tts.blockerCodes.length) blocked(tts.blockerCodes[0] || "TTS_PROVENANCE_INVALID");
  return { applicable: true, publishable: true, provenanceHash: tts.contentHash };
}

function evaluatePublishGuard(input = {}, dependencies = {}) {
  const { project, expectedRevision, finalOutputHash, qaReportArtifactId, qaReportHash, exportMetadataArtifactId, exportMetadataHash, warningAcknowledgements = [] } = input;
  const { contentArtifacts: content, contentApprovalRepository: approvals, artifactRepository: artifacts, exportRepository } = dependencies;
  if (!project || !content || !approvals || !artifacts || !exportRepository) blocked("PUBLISH_DEPENDENCIES_UNAVAILABLE");
  if (project.projectType !== "narrated_short" || project.input.revision !== Number(expectedRevision)) blocked("STALE_PROJECT_REVISION", { currentRevision: project.input.revision, expectedRevision: Number(expectedRevision) });
  if (project.input.lastInvalidation && project.input.lastInvalidation.toRevision !== project.input.revision) blocked("STALE_INVALIDATION_STATE");
  const approval = approvals.findApproved(project.id, project.input.revision); if (!approval) blocked("ACTIVE_CONTENT_APPROVAL_REQUIRED");
  const active = project.input.activeNarration; if (!active || active.status !== "aligned" || active.aligned !== true || active.timingReady !== true) blocked("EXACT_ALIGNMENT_REQUIRED");
  if (active.projectRevision !== project.input.revision || active.draftArtifactId !== approval.draftArtifactId || active.draftHash !== approval.draftHash) blocked("STALE_NARRATION_BINDING");
  const narrationEnvelope = readBound(content, active.manifestArtifactId, "narration_manifest", project, active.manifestHash); const narration = normalizeNarrationAsset(narrationEnvelope.body);
  const alignmentEnvelope = readBound(content, active.alignmentArtifactId, "narration_alignment", project, active.alignmentHash); const alignment = normalizeAlignment(alignmentEnvelope.body);
  const audio = artifacts.get(active.audioArtifactId); if (!audio || audio.type !== "narration_audio" || audio.status !== "available" || audio.ownerProjectId !== project.id || audio.checksumSha256 !== active.audioHash) blocked("NARRATION_RIGHTS_INVALID");
  if (!narration.rights.commercialUseAllowed || !narration.rights.consentReference || narration.projectRevision !== project.input.revision || narration.draftHash !== approval.draftHash || alignment.projectRevision !== project.input.revision || alignment.draftHash !== approval.draftHash || alignment.narrationManifestHash !== active.manifestHash || alignment.audioHash !== active.audioHash) blocked("STALE_NARRATION_BINDING");
  evaluateTtsNarrationRelease(narration, active);

  const metadataEnvelope = readBound(content, exportMetadataArtifactId, "export_metadata", project, exportMetadataHash); const metadata = normalizeExportMetadata(metadataEnvelope.body);
  const expectedBindings = { projectId: project.id, projectRevision: project.input.revision, approvalId: approval.approvalId, draftArtifactId: approval.draftArtifactId, draftHash: approval.draftHash, outputHash: finalOutputHash, qaReportArtifactId, qaReportHash };
  sameBindings(metadata.bindings, expectedBindings); if (metadata.renderProfile !== "final" || !metadata.technicalFinal || !metadata.qaPassed || metadata.publishable !== false || metadata.publishApprovalRequired !== true) blocked("NON_FINAL_OUTPUT");
  const qaEnvelope = readBound(content, qaReportArtifactId, "qa_report", project, qaReportHash); const qa = normalizeQaReport(qaEnvelope.body); if (qa.status !== "passed" || qa.renderProfile !== "final" || qa.summary.blockingFailedCount !== 0) blocked("QA_NOT_PASSED");
  if (qa.bindings.outputHash !== finalOutputHash || qa.bindings.draftArtifactId !== approval.draftArtifactId || qa.bindings.draftHash !== approval.draftHash || qa.bindings.narrationManifestHash !== active.manifestHash || qa.bindings.audioHash !== active.audioHash || qa.bindings.alignmentHash !== active.alignmentHash) blocked("STALE_QA_BINDING");

  const rightsEnvelope = readBound(content, metadata.package.rightsManifestArtifactId, "rights_manifest", project, metadata.package.rightsManifestHash); const rights = normalizeRightsManifest(rightsEnvelope.body);
  const provenanceEnvelope = readBound(content, metadata.package.provenanceReportArtifactId, "provenance_report", project, metadata.package.provenanceReportHash); const provenance = normalizeProvenanceReport(provenanceEnvelope.body);
  sameBindings(rights.bindings, expectedBindings); sameBindings(provenance.bindings, expectedBindings);
  if (!rights.narration.commercialUseAllowed || rights.narration.manifestHash !== active.manifestHash || rights.narration.audioHash !== active.audioHash || (rights.disclosures.illustrativeReconstructionUsed && !rights.disclosures.disclosureTexts.length)) blocked("RIGHTS_OR_DISCLOSURE_INVALID");
  const contact = artifacts.get(metadata.package.contactSheetArtifactId); if (!contact || contact.type !== "contact_sheet" || contact.status !== "available" || contact.ownerProjectId !== project.id || contact.checksumSha256 !== metadata.package.contactSheetHash) blocked("CONTACT_SHEET_INVALID");
  const finalDependency = provenance.dependencies.find((value) => value.role === "final_output"); if (!finalDependency || finalDependency.hash !== finalOutputHash) blocked("EVIDENCE_HASH_MISMATCH");

  const renderCandidates = artifacts.listByOwner({ projectId: project.id }).filter((record) => record.type === "render_manifest" && record.status === "available"); let renderEnvelope = null;
  let renderArtifactId = null;
  for (const candidate of renderCandidates) { try { const envelope = content.readJson(candidate.id); const body = envelope.body; if (envelope.revision === project.input.revision && body.technicalFinal === true && body.renderProfile === "final" && body.outputSha256 === finalOutputHash && body.qaReportHash === qaReportHash && body.exportMetadataHash === exportMetadataHash) { renderEnvelope = envelope; renderArtifactId = candidate.id; break; } } catch { /* ignore non-current candidate */ } }
  if (!renderEnvelope) blocked("CURRENT_RENDER_MANIFEST_REQUIRED"); const render = renderEnvelope.body;
  if (render.publishable !== false || render.publishApprovalRequired !== true || render.qaPassed !== true || render.packageStatus !== "complete" || render.silentPreview || !render.narrationUsed || !render.captionsBurned || !render.audioNormalized) blocked("NON_FINAL_OUTPUT");
  const output = artifacts.get(render.exportArtifactId); if (!output || output.type !== "export" || output.status !== "available" || output.ownerProjectId !== project.id || output.checksumSha256 !== finalOutputHash) blocked("OUTPUT_HASH_MISMATCH");
  const exportRecord = exportRepository.all().find((value) => value.projectId === project.id && value.artifact && value.artifact.id === output.id && value.status === "completed"); if (!exportRecord) blocked("CURRENT_EXPORT_REQUIRED");

  const availableWarnings = qa.gates.filter((gate) => gate.severity === "warning" && !gate.passed && QA_WARNING_MAP[gate.code]).map((gate) => QA_WARNING_MAP[gate.code]).sort();
  if (metadata.disclosures.aiDisclosureRequired) availableWarnings.push("DISCLOSURE_REVIEW_REQUIRED");
  const acknowledged = normalizeWarnings(warningAcknowledgements); if (acknowledged.some((code) => !availableWarnings.includes(code))) throw new AppError("PUBLISH_WARNING_INVALID", SAFE_MESSAGES.PUBLISH_WARNING_INVALID, 409, { warningCodes: acknowledged });
  return { project, approval, active, narration, alignment, qa, metadata, rights, provenance, render, exportRecord, output, availableWarnings: [...new Set(availableWarnings)].sort(), warningAcknowledgements: acknowledged, refs: { approvedDraft: { artifactId: approval.draftArtifactId, hash: approval.draftHash }, narrationManifest: { artifactId: active.manifestArtifactId, hash: active.manifestHash }, narrationAudio: { artifactId: active.audioArtifactId, hash: active.audioHash }, narrationAlignment: { artifactId: active.alignmentArtifactId, hash: active.alignmentHash }, renderManifest: { artifactId: renderArtifactId, hash: renderEnvelope.contentHash }, finalOutput: { artifactId: output.id, hash: output.checksumSha256 }, qaReport: { artifactId: qaReportArtifactId, hash: qaReportHash }, contactSheet: { artifactId: contact.id, hash: contact.checksumSha256 }, rightsManifest: { artifactId: metadata.package.rightsManifestArtifactId, hash: rightsEnvelope.contentHash }, provenanceReport: { artifactId: metadata.package.provenanceReportArtifactId, hash: provenanceEnvelope.contentHash }, exportMetadata: { artifactId: exportMetadataArtifactId, hash: metadataEnvelope.contentHash } } };
}

module.exports = { QA_WARNING_MAP, evaluatePublishGuard, evaluateTtsNarrationRelease };
