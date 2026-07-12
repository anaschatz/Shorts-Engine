const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readdirSync } = require("node:fs");

const { createQaReport, gate } = require("../server/pipelines/narrated-short/qa/contract.cjs");
const {
  CONTACT_SHEET_PROFILE, EVIDENCE_PROFILE_VERSION, EXPORT_METADATA_PROFILE, PROVENANCE_PROFILE, RIGHTS_PROFILE,
  REQUIRED_DEPENDENCY_ROLES, normalizeContactSheet, normalizeExportMetadata, normalizeProvenanceReport, normalizeRightsManifest,
} = require("../server/pipelines/narrated-short/evidence/contract.cjs");
const { CONFIG } = require("../server/config.cjs");
const { AppError } = require("../server/errors.cjs");
const { contactSheetFrames, assertPng, generateContactSheet } = require("../server/pipelines/narrated-short/evidence/contact-sheet.cjs");
const { validateEvidencePackage } = require("../server/pipelines/narrated-short/evidence/package-orchestrator.cjs");

const art = (letter) => `art_${letter.repeat(40)}`;
const digest = (letter) => letter.repeat(64);

function fixture() {
  const projectId = `prj_${randomUUID()}`;
  const bindings = { projectId, projectRevision: 1, approvalId: `capr_${"a".repeat(40)}`, draftArtifactId: art("a"), draftHash: digest("a"), outputHash: digest("f"), qaReportArtifactId: art("q"), qaReportHash: digest("9") };
  const qaBindings = { draftArtifactId: bindings.draftArtifactId, draftHash: bindings.draftHash, scriptHash: digest("b"), narrationManifestArtifactId: art("c"), narrationManifestHash: digest("c"), audioArtifactId: art("d"), audioHash: digest("d"), alignmentArtifactId: art("e"), alignmentHash: digest("e"), captionManifestArtifactId: art("g"), captionManifestHash: digest("1"), captionAssArtifactId: art("h"), captionAssHash: digest("2"), audioNormalizationReportArtifactId: art("i"), audioNormalizationReportHash: digest("3"), timelineArtifactId: art("j"), timelineHash: digest("4"), outputHash: bindings.outputHash };
  let qa = createQaReport({ projectId, projectRevision: 1, renderProfile: "final", bindings: qaBindings, gates: [gate("AUDIO_ALIGNMENT_EXACT", "audio", true), gate("CAPTION_ALIGNMENT_EXACT", "caption", true), gate("CONTENT_APPROVAL_EXACT", "content", true), gate("VIDEO_FILE_READABLE", "rendered_video", true), gate("RIGHTS_NARRATION_COMMERCIAL", "rights", true), gate("TIMELINE_HASH_VALID", "timeline", true)] });
  bindings.qaReportHash = qa.contentHash;
  const contactSheet = normalizeContactSheet({ schemaVersion: 1, profile: CONTACT_SHEET_PROFILE, profileVersion: EVIDENCE_PROFILE_VERSION, bindings, artifactId: art("k"), checksumSha256: digest("5"), width: 1080, height: 1280, frameCount: 6, timestampsSeconds: [1, 3, 5, 7, 9, 11], rendererVersion: "ffmpeg_contact_sheet_v1" });
  const rights = normalizeRightsManifest({ schemaVersion: 1, status: "complete", profile: RIGHTS_PROFILE, profileVersion: EVIDENCE_PROFILE_VERSION, bindings, narration: { manifestArtifactId: art("c"), manifestHash: digest("c"), audioArtifactId: art("d"), audioHash: digest("d"), commercialUseAllowed: true, ownershipBasis: "self_recorded", rightsHolder: "Operator", consentReference: "consent-001", licenseReference: null }, sources: [{ sourceId: "src_one", publisher: "Institution", sourceClass: "institutional", snapshotHash: digest("6") }], visualAssets: [{ template: "hook_scene", templateVersion: "1.0.0", rendererVersion: "2.0.0", assetClass: "original_engine_generated" }], disclosures: { illustrativeReconstructionUsed: false, aiDisclosureRequired: false, disclosureTexts: [], fontId: "Arial" } });
  const refs = Object.fromEntries(REQUIRED_DEPENDENCY_ROLES.map((role, index) => [role, { role, artifactId: role === "final_output" ? null : art(String.fromCharCode(97 + (index % 20))), hash: digest(((index % 8) + 1).toString()) }]));
  refs.approved_draft = { role: "approved_draft", artifactId: bindings.draftArtifactId, hash: bindings.draftHash };
  refs.qa_report = { role: "qa_report", artifactId: bindings.qaReportArtifactId, hash: bindings.qaReportHash };
  refs.rights_manifest = { role: "rights_manifest", artifactId: art("r"), hash: rights.contentHash };
  refs.contact_sheet = { role: "contact_sheet", artifactId: contactSheet.artifactId, hash: contactSheet.checksumSha256 };
  refs.final_output = { role: "final_output", artifactId: null, hash: bindings.outputHash };
  const provenance = normalizeProvenanceReport({ schemaVersion: 1, status: "complete", profile: PROVENANCE_PROFILE, profileVersion: EVIDENCE_PROFILE_VERSION, bindings, dependencies: Object.values(refs), versions: { renderer: "2.0.0", compositor: "narrated_compositor_v2", captionRenderer: "ass_caption_v1", audioNormalization: "1.0.0", qaProfile: "1.0.0", template: "1.0.0", font: "Arial" } });
  const metadata = normalizeExportMetadata({ schemaVersion: 1, status: "complete", profile: EXPORT_METADATA_PROFILE, profileVersion: EVIDENCE_PROFILE_VERSION, bindings, verticalId: "dark_curiosity", formatId: "documented_mystery_v1", renderProfile: "final", media: { durationSeconds: 12, width: 1080, height: 1920, fps: 30, videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p", audioSampleRate: 48000 }, qa: { profile: "dark_curiosity_technical_v1", profileVersion: "1.0.0", reportArtifactId: bindings.qaReportArtifactId, reportHash: bindings.qaReportHash }, package: { rightsManifestArtifactId: art("r"), rightsManifestHash: rights.contentHash, provenanceReportArtifactId: art("p"), provenanceReportHash: provenance.contentHash, contactSheetArtifactId: contactSheet.artifactId, contactSheetHash: contactSheet.checksumSha256 }, disclosures: { aiDisclosureRequired: false, illustrativeReconstructionUsed: false }, technicalFinal: true, qaPassed: true, publishable: false, publishApprovalRequired: true });
  const wrap = (id, body) => ({ artifact: { id }, envelope: { contentHash: body.contentHash } });
  return { bindings, qa, contactSheet, rights, provenance, metadata, rightsArtifact: wrap(art("r"), rights), provenanceArtifact: wrap(art("p"), provenance), metadataArtifact: wrap(art("m"), metadata), contactSheetArtifact: { id: contactSheet.artifactId, checksumSha256: contactSheet.checksumSha256, status: "available" } };
}

test("evidence contracts are deterministic, canonical, strict, and complete", () => {
  const value = fixture();
  assert.equal(normalizeRightsManifest(value.rights).contentHash, value.rights.contentHash);
  assert.equal(normalizeProvenanceReport({ ...value.provenance, dependencies: [...value.provenance.dependencies].reverse() }).contentHash, value.provenance.contentHash);
  assert.throws(() => normalizeRightsManifest({ ...value.rights, narration: { ...value.rights.narration, rawLicense: "/private/license" } }), { code: "RIGHTS_MANIFEST_INVALID" });
  assert.throws(() => normalizeProvenanceReport({ ...value.provenance, dependencies: value.provenance.dependencies.slice(1) }), { code: "PROVENANCE_REPORT_INVALID" });
  assert.throws(() => normalizeProvenanceReport({ ...value.provenance, dependencies: [...value.provenance.dependencies, value.provenance.dependencies[0]] }), { code: "PROVENANCE_REPORT_INVALID" });
});

test("rights manifest fails closed for snapshots, licenses, and external assets", () => {
  const value = fixture();
  assert.throws(() => normalizeRightsManifest({ ...value.rights, sources: [{ ...value.rights.sources[0], snapshotHash: "missing" }] }), { code: "RIGHTS_MANIFEST_INVALID" });
  assert.throws(() => normalizeRightsManifest({ ...value.rights, narration: { ...value.rights.narration, ownershipBasis: "licensed_recording", licenseReference: null } }), { code: "RIGHTS_MANIFEST_INVALID" });
  assert.throws(() => normalizeRightsManifest({ ...value.rights, visualAssets: [{ ...value.rights.visualAssets[0], assetClass: "borrowed_gameplay" }] }), { code: "RIGHTS_MANIFEST_INVALID" });
});

test("package validator accepts one exact package and rejects stale or altered hashes", () => {
  const value = fixture();
  assert.equal(validateEvidencePackage(value).status, "complete");
  assert.throws(() => validateEvidencePackage({ ...value, bindings: { ...value.bindings, outputHash: digest("0") } }), { code: "EVIDENCE_PACKAGE_BINDING_STALE" });
  assert.throws(() => validateEvidencePackage({ ...value, contactSheetArtifact: { ...value.contactSheetArtifact, checksumSha256: digest("0") } }), { code: "EVIDENCE_PACKAGE_HASH_MISMATCH" });
  assert.throws(() => normalizeExportMetadata({ ...value.metadata, qa: { ...value.metadata.qa, reportHash: digest("0") } }), { code: "EVIDENCE_PACKAGE_HASH_MISMATCH" });
});

test("contact sheet timestamps are deterministic and corrupt PNG data fails closed", () => {
  const first = contactSheetFrames(900, 30);
  assert.deepEqual(first, contactSheetFrames(900, 30));
  assert.equal(first.frames.length, 6);
  assert.equal(new Set(first.frames).size, 6);
  assert.ok(first.frames.at(-1) < 899);
  assert.throws(() => assertPng(Buffer.from("not-a-png")), { code: "CONTACT_SHEET_INVALID" });
});

test("contact sheet timeout and cancellation fail safely and clean temporary output", async () => {
  const value = fixture();
  const count = () => readdirSync(CONFIG.tmpDir).filter((name) => name.startsWith("contact-sheet-")).length;
  const before = count();
  const input = { outputPath: "/managed/staging/final.mp4", timeline: { totalFrames: 360, fps: 30 }, bindings: value.bindings, artifactStore: {}, artifactRepository: {}, projectId: value.bindings.projectId, jobId: `job_${randomUUID()}` };
  await assert.rejects(() => generateContactSheet(input, { ffmpegRunner: async () => { throw new Error("timeout /private/path"); } }), { code: "CONTACT_SHEET_GENERATION_FAILED" });
  await assert.rejects(() => generateContactSheet(input, { ffmpegRunner: async () => { throw new AppError("JOB_CANCELLED", "cancelled", 499); } }), { code: "JOB_CANCELLED" });
  assert.equal(count(), before);
});
