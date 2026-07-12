const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const DATA_DIR = mkdtempSync(join(tmpdir(), "publish-approval-"));
process.env.MATCHCUTS_DATA_DIR = DATA_DIR;
const { ensureDataDirs } = require("../server/config.cjs"); ensureDataDirs();
const { LocalArtifactAdapter } = require("../server/adapters/local-artifact-adapter.cjs");
const { InMemoryArtifactRepository } = require("../server/repositories/artifact-repository.cjs");
const { ContentArtifactRepository } = require("../server/repositories/content-artifact-repository.cjs");
const { PublishApprovalRepository } = require("../server/repositories/publish-approval-repository.cjs");
const { normalizePublishApproval, PUBLISH_PROFILE, PUBLISH_PROFILE_VERSION } = require("../server/pipelines/narrated-short/publish/contract.cjs");
const { createPublishApproval, verifyReleaseEligibility } = require("../server/pipelines/narrated-short/publish/service.cjs");
const { evaluatePublishGuard } = require("../server/pipelines/narrated-short/publish/publish-guard.cjs");
const { normalizeNarrationAsset } = require("../server/pipelines/narrated-short/narration/contract.cjs");
const { createAlignment, scriptWords } = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { createQaReport, gate } = require("../server/pipelines/narrated-short/qa/contract.cjs");
const { EVIDENCE_PROFILE_VERSION, RIGHTS_PROFILE, PROVENANCE_PROFILE, EXPORT_METADATA_PROFILE, REQUIRED_DEPENDENCY_ROLES, normalizeRightsManifest, normalizeProvenanceReport, normalizeExportMetadata } = require("../server/pipelines/narrated-short/evidence/contract.cjs");
const { readFileSync: readFixture } = require("node:fs");
const { resolve } = require("node:path");

test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));
const projectId = "prj_11111111-1111-4111-8111-111111111111";
const capr = `capr_${"1".repeat(40)}`;
const artifactId = (character) => `art_${character.repeat(40)}`;
const digest = (character) => character.repeat(64);
const ref = (character) => ({ artifactId: artifactId(character), hash: digest(character) });
const refs = { approvedDraft: ref("1"), narrationManifest: ref("2"), narrationAudio: ref("3"), narrationAlignment: ref("4"), renderManifest: ref("5"), finalOutput: ref("6"), qaReport: ref("7"), contactSheet: ref("8"), rightsManifest: ref("9"), provenanceReport: ref("a"), exportMetadata: ref("b") };
const project = { id: projectId, projectType: "narrated_short", input: { revision: 1 } };
const contentApproval = { approvalId: capr, projectId, projectRevision: 1, draftArtifactId: refs.approvedDraft.artifactId, draftHash: refs.approvedDraft.hash, status: "approved" };
const request = { expectedRevision: 1, finalOutputHash: refs.finalOutput.hash, qaReportArtifactId: refs.qaReport.artifactId, qaReportHash: refs.qaReport.hash, exportMetadataArtifactId: refs.exportMetadata.artifactId, exportMetadataHash: refs.exportMetadata.hash, operatorDecision: "approve", warningAcknowledgements: ["VISUAL_STASIS_WARNING"], operatorNote: "Reviewed exact technical evidence.", idempotencyKey: "publish-proof-0001" };

function setup() {
  const artifactStore = new LocalArtifactAdapter(); const artifactRepository = new InMemoryArtifactRepository({ persist: false }); const contentArtifactRepository = new ContentArtifactRepository({ artifactStore, artifactRepository });
  const repository = new PublishApprovalRepository({ filePath: join(DATA_DIR, `publish-${Math.random()}.json`) });
  const finalArtifact = artifactStore.writeBuffer({ id: refs.finalOutput.artifactId, type: "export", ownerProjectId: projectId, ownerJobId: "job_11111111-1111-4111-8111-111111111111", storageKey: "publish/final.mp4", contentType: "video/mp4", checksumSha256: refs.finalOutput.hash, buffer: Buffer.from("technical-final"), status: "available" }); artifactRepository.create(finalArtifact);
  const contentApprovalRepository = { findApproved: () => contentApproval };
  const evaluatePublishGuard = () => ({ approval: contentApproval, refs, warningAcknowledgements: ["VISUAL_STASIS_WARNING"] });
  return { artifactStore, artifactRepository, contentArtifactRepository, repository, contentApprovalRepository, evaluatePublishGuard };
}

test("publish approval contract is strict, deterministic, and never accepts plaintext token fields", () => {
  const body = normalizePublishApproval({ schemaVersion: 1, profile: PUBLISH_PROFILE, profileVersion: PUBLISH_PROFILE_VERSION, approvalId: `papr_${"2".repeat(40)}`, projectId, projectRevision: 1, contentApprovalId: capr, ...refs, warningAcknowledgements: [], operatorIdentityHash: digest("c"), operatorNote: "reviewed", decision: "approve", issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:15:00.000Z", releaseTokenHash: digest("d"), requestHash: digest("e"), idempotencyKeyHash: digest("f"), status: "active" });
  assert.equal(normalizePublishApproval(body).contentHash, body.contentHash);
  assert.throws(() => normalizePublishApproval({ ...body, releaseToken: "raw" }), { code: "PUBLISH_APPROVAL_INVALID" });
  assert.throws(() => normalizePublishApproval({ ...body, warningAcknowledgements: ["UNKNOWN_WARNING"] }), { code: "PUBLISH_WARNING_INVALID" });
  assert.throws(() => normalizePublishApproval({ ...body, warningAcknowledgements: ["VISUAL_STASIS_WARNING", "VISUAL_STASIS_WARNING"] }), { code: "PUBLISH_WARNING_INVALID" });
});

test("service creates one hashed short-lived token, replays safely, verifies, expires, and revokes", () => {
  const ctx = setup(); const now = new Date("2026-01-01T00:00:00.000Z");
  const dependencies = { publishApprovalRepository: ctx.repository, contentArtifactRepository: ctx.contentArtifactRepository, contentApprovalRepository: ctx.contentApprovalRepository, artifactRepository: ctx.artifactRepository, exportRepository: {}, evaluatePublishGuard: ctx.evaluatePublishGuard, now: () => now };
  const created = createPublishApproval({ project, operatorId: "local_operator", request }, dependencies);
  assert.match(created.releaseToken, /^[A-Za-z0-9_-]{40,100}$/); assert.equal(Buffer.from(created.releaseToken, "base64url").length, 32); assert.equal(created.approval.status, "active");
  const serialized = JSON.stringify([...ctx.repository.records.values()]); assert.equal(serialized.includes(created.releaseToken), false); assert.doesNotMatch(serialized, /\/Users|storageKey/);
  const artifactBody = ctx.contentArtifactRepository.readJson(created.record.approvalArtifactId).body; assert.equal(Object.hasOwn(artifactBody, "releaseToken"), false); assert.equal(artifactBody.releaseTokenHash.length, 64);
  const verified = verifyReleaseEligibility({ project, request: { releaseToken: created.releaseToken, outputHash: refs.finalOutput.hash } }, dependencies); assert.equal(verified.eligible, true); assert.equal(verified.expiresAt, "2026-01-01T00:15:00.000Z");
  const replay = createPublishApproval({ project, operatorId: "local_operator", request }, dependencies); assert.equal(replay.replayed, true); assert.equal(replay.releaseToken, null); assert.equal(ctx.repository.records.size, 1);
  assert.throws(() => verifyReleaseEligibility({ project, request: { releaseToken: created.releaseToken, outputHash: digest("d") } }, dependencies), { code: "RELEASE_TOKEN_OUTPUT_MISMATCH" });
  assert.throws(() => ctx.repository.verifyToken({ projectId, revision: 1, outputHash: refs.finalOutput.hash, token: created.releaseToken, now: new Date("2026-01-01T00:16:00.000Z") }), { code: "RELEASE_TOKEN_EXPIRED" });
  ctx.repository.revokeRevision(projectId, 1); assert.throws(() => verifyReleaseEligibility({ project, request: { releaseToken: created.releaseToken, outputHash: refs.finalOutput.hash } }, dependencies), { code: "RELEASE_TOKEN_REVOKED" });
});

test("same idempotency key with a different request conflicts and persisted recovery keeps no raw token", () => {
  const ctx = setup(); const dependencies = { publishApprovalRepository: ctx.repository, contentArtifactRepository: ctx.contentArtifactRepository, contentApprovalRepository: ctx.contentApprovalRepository, artifactRepository: ctx.artifactRepository, exportRepository: {}, evaluatePublishGuard: ctx.evaluatePublishGuard, now: () => new Date("2026-01-01T00:00:00.000Z") };
  const created = createPublishApproval({ project, operatorId: "local_operator", request }, dependencies);
  assert.throws(() => createPublishApproval({ project, operatorId: "local_operator", request: { ...request, operatorNote: "different reviewed note" } }, dependencies), { code: "PUBLISH_APPROVAL_CONFLICT" });
  const recovered = new PublishApprovalRepository({ filePath: ctx.repository.filePath }); assert.deepEqual(recovered.recover(), { records: 1, ignored: 0 }); assert.equal(recovered.findActive(projectId, 1).body.approvalId, created.record.body.approvalId); assert.equal(readFileSync(ctx.repository.filePath, "utf8").includes(created.releaseToken), false);
});

function guardedFixture() {
  const draft = normalizeDraftBundle(JSON.parse(readFixture(resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json"), "utf8")));
  const ids = { draft: artifactId("1"), narration: artifactId("2"), audio: artifactId("3"), alignment: artifactId("4"), caption: artifactId("5"), ass: artifactId("6"), normalization: artifactId("7"), timeline: artifactId("8"), qa: artifactId("9"), rights: artifactId("a"), contact: artifactId("b"), provenance: artifactId("c"), metadata: artifactId("d"), render: artifactId("e"), output: `exp_${"f".repeat(40)}` };
  const outputHash = digest("f");
  const narration = normalizeNarrationAsset({ schemaVersion: 1, status: "uploaded_unaligned", projectId, projectRevision: 1, verticalId: "dark_curiosity", draftArtifactId: ids.draft, draftHash: digest("1"), scriptHash: draft.script.contentHash, audioArtifactId: ids.audio, audioHash: digest("3"), voiceProfileId: "voice_01", language: "en", media: { container: "wav", codec: "pcm_s16le", sampleRate: 48000, channels: 1, durationSeconds: 60, bytes: 1000 }, rights: { commercialUseAllowed: true, ownershipBasis: "self_recorded", rightsHolder: "Operator", consentReference: "consent-1", licenseReference: null } });
  const words = scriptWords(draft.script).map((word, index) => ({ word: word.text, start: 0.1 + index * 0.25, end: 0.3 + index * 0.25, probability: 0.99 }));
  const alignment = createAlignment({ project: { id: projectId, input: { revision: 1 } }, draft, narration, narrationSummary: { manifestArtifactId: ids.narration, manifestHash: digest("2") }, providerResult: { segments: [{ words }] }, provider: { model: "fixture", device: "cpu", computeType: "int8" } });
  const approval = { ...contentApproval, draftArtifactId: ids.draft, draftHash: digest("1") };
  const qaBindings = { draftArtifactId: ids.draft, draftHash: digest("1"), scriptHash: draft.script.contentHash, narrationManifestArtifactId: ids.narration, narrationManifestHash: digest("2"), audioArtifactId: ids.audio, audioHash: digest("3"), alignmentArtifactId: ids.alignment, alignmentHash: digest("4"), captionManifestArtifactId: ids.caption, captionManifestHash: digest("5"), captionAssArtifactId: ids.ass, captionAssHash: digest("6"), audioNormalizationReportArtifactId: ids.normalization, audioNormalizationReportHash: digest("7"), timelineArtifactId: ids.timeline, timelineHash: digest("8"), outputHash };
  const qa = createQaReport({ projectId, projectRevision: 1, renderProfile: "final", bindings: qaBindings, gates: [gate("AUDIO_ALIGNMENT_EXACT", "audio", true), gate("CAPTION_ALIGNMENT_EXACT", "caption", true), gate("CONTENT_APPROVAL_EXACT", "content", true), gate("VIDEO_FILE_READABLE", "rendered_video", true), gate("RIGHTS_NARRATION_COMMERCIAL", "rights", true), gate("TIMELINE_HASH_VALID", "timeline", true), { code: "WARNING_VISUAL_STASIS", category: "warning", severity: "warning", passed: false, details: {} }] });
  const bindings = { projectId, projectRevision: 1, approvalId: capr, draftArtifactId: ids.draft, draftHash: digest("1"), outputHash, qaReportArtifactId: ids.qa, qaReportHash: qa.contentHash };
  const rights = normalizeRightsManifest({ schemaVersion: 1, status: "complete", profile: RIGHTS_PROFILE, profileVersion: EVIDENCE_PROFILE_VERSION, bindings, narration: { manifestArtifactId: ids.narration, manifestHash: digest("2"), audioArtifactId: ids.audio, audioHash: digest("3"), commercialUseAllowed: true, ownershipBasis: "self_recorded", rightsHolder: "Operator", consentReference: "consent-1", licenseReference: null }, sources: [{ sourceId: "src_01", publisher: "Institution", sourceClass: "institutional", snapshotHash: digest("a") }], visualAssets: [{ template: "hook_scene", templateVersion: "1.0.0", rendererVersion: "1.0.0", assetClass: "original_engine_generated" }], disclosures: { illustrativeReconstructionUsed: true, aiDisclosureRequired: true, disclosureTexts: ["Illustrative reconstruction"], fontId: "managed_font" } });
  const dependencies = REQUIRED_DEPENDENCY_ROLES.map((role, index) => ({ role, artifactId: role === "final_output" ? null : artifactId(((index + 1) % 15).toString(16)), hash: digest(((index + 1) % 15).toString(16)) }));
  const byRole = Object.fromEntries(dependencies.map((value) => [value.role, value])); Object.assign(byRole.approved_draft, { artifactId: ids.draft, hash: digest("1") }); Object.assign(byRole.qa_report, { artifactId: ids.qa, hash: qa.contentHash }); Object.assign(byRole.final_output, { artifactId: null, hash: outputHash }); Object.assign(byRole.rights_manifest, { artifactId: ids.rights, hash: rights.contentHash }); Object.assign(byRole.contact_sheet, { artifactId: ids.contact, hash: digest("b") });
  const provenance = normalizeProvenanceReport({ schemaVersion: 1, status: "complete", profile: PROVENANCE_PROFILE, profileVersion: EVIDENCE_PROFILE_VERSION, bindings, dependencies, versions: { renderer: "r1", compositor: "c1", captionRenderer: "cap1", audioNormalization: "a1", qaProfile: "q1", template: "t1", font: "f1" } });
  const metadata = normalizeExportMetadata({ schemaVersion: 1, status: "complete", profile: EXPORT_METADATA_PROFILE, profileVersion: EVIDENCE_PROFILE_VERSION, bindings, verticalId: "dark_curiosity", formatId: draft.brief.formatId, renderProfile: "final", media: { durationSeconds: 30, width: 1080, height: 1920, fps: 30, videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p", audioSampleRate: 48000 }, qa: { profile: "dark_curiosity_technical_v1", profileVersion: "1.0.0", reportArtifactId: ids.qa, reportHash: qa.contentHash }, package: { rightsManifestArtifactId: ids.rights, rightsManifestHash: rights.contentHash, provenanceReportArtifactId: ids.provenance, provenanceReportHash: provenance.contentHash, contactSheetArtifactId: ids.contact, contactSheetHash: digest("b") }, disclosures: { aiDisclosureRequired: true, illustrativeReconstructionUsed: true }, technicalFinal: true, qaPassed: true, publishable: false, publishApprovalRequired: true });
  const envelopes = new Map([[ids.narration, { artifactType: "narration_manifest", projectId, revision: 1, contentHash: digest("2"), body: narration }], [ids.alignment, { artifactType: "narration_alignment", projectId, revision: 1, contentHash: digest("4"), body: alignment }], [ids.qa, { artifactType: "qa_report", projectId, revision: 1, contentHash: qa.contentHash, body: qa }], [ids.rights, { artifactType: "rights_manifest", projectId, revision: 1, contentHash: rights.contentHash, body: rights }], [ids.provenance, { artifactType: "provenance_report", projectId, revision: 1, contentHash: provenance.contentHash, body: provenance }], [ids.metadata, { artifactType: "export_metadata", projectId, revision: 1, contentHash: metadata.contentHash, body: metadata }]]);
  const renderBody = { technicalFinal: true, renderProfile: "final", outputSha256: outputHash, qaReportHash: qa.contentHash, exportMetadataHash: metadata.contentHash, publishable: false, publishApprovalRequired: true, qaPassed: true, packageStatus: "complete", silentPreview: false, narrationUsed: true, captionsBurned: true, audioNormalized: true, exportArtifactId: ids.output };
  envelopes.set(ids.render, { artifactType: "render_manifest", projectId, revision: 1, contentHash: digest("e"), body: renderBody });
  const records = new Map([[ids.audio, { id: ids.audio, type: "narration_audio", status: "available", ownerProjectId: projectId, checksumSha256: digest("3") }], [ids.contact, { id: ids.contact, type: "contact_sheet", status: "available", ownerProjectId: projectId, checksumSha256: digest("b") }], [ids.render, { id: ids.render, type: "render_manifest", status: "available", ownerProjectId: projectId }], [ids.output, { id: ids.output, type: "export", status: "available", ownerProjectId: projectId, checksumSha256: outputHash }]]);
  const active = { status: "aligned", aligned: true, timingReady: true, projectRevision: 1, draftArtifactId: ids.draft, draftHash: digest("1"), manifestArtifactId: ids.narration, manifestHash: digest("2"), audioArtifactId: ids.audio, audioHash: digest("3"), alignmentArtifactId: ids.alignment, alignmentHash: digest("4") };
  const guardedProject = { id: projectId, projectType: "narrated_short", input: { revision: 1, activeNarration: active } };
  return { ids, outputHash, qa, metadata, project: guardedProject, dependencies: { contentArtifacts: { readJson: (id) => { if (!envelopes.has(id)) throw new Error("missing"); return envelopes.get(id); } }, contentApprovalRepository: { findApproved: () => approval }, artifactRepository: { get: (id) => records.get(id) || null, listByOwner: () => [...records.values()] }, exportRepository: { all: () => [{ projectId, status: "completed", artifact: records.get(ids.output) }] } }, input: { project: guardedProject, expectedRevision: 1, finalOutputHash: outputHash, qaReportArtifactId: ids.qa, qaReportHash: qa.contentHash, exportMetadataArtifactId: ids.metadata, exportMetadataHash: metadata.contentHash, warningAcknowledgements: ["VISUAL_STASIS_WARNING"] } };
}

test("PublishGuard accepts one exact final evidence graph and rejects stale output, warnings, and alignment", () => {
  const ctx = guardedFixture(); const passed = evaluatePublishGuard(ctx.input, ctx.dependencies); assert.equal(passed.output.checksumSha256, ctx.outputHash); assert.deepEqual(passed.warningAcknowledgements, ["VISUAL_STASIS_WARNING"]); assert.equal(passed.refs.exportMetadata.hash, ctx.metadata.contentHash);
  assert.throws(() => evaluatePublishGuard({ ...ctx.input, finalOutputHash: digest("d") }, ctx.dependencies), { code: "PUBLISH_GUARD_BLOCKED" });
  assert.throws(() => evaluatePublishGuard({ ...ctx.input, warningAcknowledgements: ["SOURCE_DIVERSITY_WARNING"] }, ctx.dependencies), { code: "PUBLISH_WARNING_INVALID" });
  const stale = { ...ctx.project, input: { ...ctx.project.input, activeNarration: { ...ctx.project.input.activeNarration, status: "uploaded_unaligned", aligned: false } } };
  assert.throws(() => evaluatePublishGuard({ ...ctx.input, project: stale }, ctx.dependencies), { code: "PUBLISH_GUARD_BLOCKED" });
});
