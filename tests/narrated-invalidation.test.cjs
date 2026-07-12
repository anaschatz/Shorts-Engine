const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID, createHash } = require("node:crypto");

const DATA_DIR = mkdtempSync(join(tmpdir(), "narrated-invalidation-"));
process.env.MATCHCUTS_DATA_DIR = DATA_DIR;
const { ensureDataDirs } = require("../server/config.cjs"); ensureDataDirs();
const { LocalArtifactAdapter } = require("../server/adapters/local-artifact-adapter.cjs");
const { InMemoryArtifactRepository } = require("../server/repositories/artifact-repository.cjs");
const { ContentArtifactRepository } = require("../server/repositories/content-artifact-repository.cjs");
const { ContentApprovalRepository } = require("../server/repositories/content-approval-repository.cjs");
const { InMemoryProjectRepository } = require("../server/repositories/project-repository.cjs");
const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { normalizeNarrationAsset, publicNarrationSummary } = require("../server/pipelines/narrated-short/narration/contract.cjs");
const { createAlignment, scriptWords } = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const { normalizeInvalidationReport, reviseNarratedProject } = require("../server/pipelines/narrated-short/invalidation.cjs");

const FIXTURE = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json");
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha = (value) => createHash("sha256").update(value).digest("hex");

function setup({ aligned = true } = {}) {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const draft = normalizeDraftBundle(raw);
  const artifactStore = new LocalArtifactAdapter();
  const artifactRepository = new InMemoryArtifactRepository({ persist: false });
  const contentArtifacts = new ContentArtifactRepository({ artifactStore, artifactRepository });
  const approvalRepository = new ContentApprovalRepository({ persist: false });
  const projectRepository = new InMemoryProjectRepository();
  const projectId = `prj_${randomUUID()}`;
  const revision = 1;
  const create = (type, body, dependencyHashes = []) => contentArtifacts.createJson({ type, projectId, revision, dependencyHashes, body });
  const brief = create("content_brief", draft.brief);
  const claims = create("claim_ledger", draft.claimLedger, [brief.envelope.contentHash]);
  const script = create("narrative_script", draft.script, [brief.envelope.contentHash, claims.envelope.contentHash]);
  const storyboard = create("storyboard", draft.storyboard, [script.envelope.contentHash]);
  const bundle = create("approval_bundle", draft, [brief.envelope.contentHash, claims.envelope.contentHash, script.envelope.contentHash, storyboard.envelope.contentHash]);
  const audioBuffer = Buffer.from("immutable-narration-audio");
  const audioHash = sha(audioBuffer);
  const audioArtifact = artifactStore.writeBuffer({ id: `art_${"d".repeat(40)}`, type: "narration_audio", ownerProjectId: projectId, storageKey: `narration/${projectId}/voice.wav`, contentType: "audio/wav", checksumSha256: audioHash, buffer: audioBuffer, status: "available" });
  artifactRepository.create(audioArtifact);
  const narration = normalizeNarrationAsset({ schemaVersion: 1, status: "uploaded_unaligned", projectId, projectRevision: 1, verticalId: "dark_curiosity", draftArtifactId: bundle.artifact.id, draftHash: bundle.envelope.contentHash, scriptHash: draft.script.contentHash, audioArtifactId: audioArtifact.id, audioHash, voiceProfileId: "voice_en_01", language: "en", media: { container: "wav", codec: "pcm_s16le", sampleRate: 48000, channels: 1, durationSeconds: 32, bytes: audioBuffer.length }, rights: { commercialUseAllowed: true, ownershipBasis: "self_recorded", rightsHolder: "Operator", consentReference: "consent-001", licenseReference: null } });
  const manifest = create("narration_manifest", narration, [bundle.envelope.contentHash, audioHash]);
  let active = publicNarrationSummary({ manifest: narration, manifestArtifactId: manifest.artifact.id, manifestHash: manifest.envelope.contentHash });
  let alignment = null;
  if (aligned) {
    const words = scriptWords(draft.script).map((word, index) => ({ word: word.text, start: 0.2 + index * 0.32, end: 0.45 + index * 0.32, probability: 0.99 }));
    const body = createAlignment({ project: { id: projectId, input: { revision: 1 } }, draft, narration, narrationSummary: { manifestArtifactId: manifest.artifact.id, manifestHash: manifest.envelope.contentHash }, providerResult: { segments: [{ words }] }, provider: { model: "fixture", device: "cpu", computeType: "int8" } });
    alignment = create("narration_alignment", body, [manifest.envelope.contentHash, audioHash]);
    Object.assign(active, { status: "aligned", alignmentArtifactId: alignment.artifact.id, alignmentHash: alignment.envelope.contentHash, aligned: true, timingReady: true, renderReady: false });
  }
  const project = projectRepository.create({ id: projectId, projectType: "narrated_short", title: draft.script.title, language: "en", status: "ready", input: { type: "content_brief", revision: 1, briefArtifactId: brief.artifact.id, claimLedgerArtifactId: claims.artifact.id, scriptArtifactId: script.artifact.id, storyboardArtifactId: storyboard.artifact.id, activeNarration: active } });
  const approval = approvalRepository.approve({ projectId, projectRevision: 1, draftArtifactId: bundle.artifact.id, draftHash: bundle.envelope.contentHash, voiceProfileId: "voice_en_01", renderProfile: "final", approvedAt: "2026-01-01T00:00:00.000Z" });
  return { raw, draft, project, approval, audioArtifact, alignment, artifactStore, artifactRepository, contentArtifacts, approvalRepository, projectRepository, dependencies: { contentArtifacts, artifactRepository, projectRepository, approvalRepository } };
}

function styleRevision(raw) {
  const next = clone(raw);
  next.storyboard.scenes[0].operations[0].text = "The signal appeared only once";
  return next;
}

test("style-only revision rebinds exact narration and timings without copying audio", () => {
  const ctx = setup({ aligned: true });
  const oldActive = clone(ctx.project.input.activeNarration);
  const audioCount = ctx.artifactRepository.listByTypeStatus({ types: ["narration_audio"] }).length;
  const result = reviseNarratedProject({ project: ctx.project, expectedRevision: 1, changeType: "style_only", bundle: styleRevision(ctx.raw), idempotencyKey: "style-revision-0001" }, ctx.dependencies);
  assert.equal(result.project.input.revision, 2);
  assert.equal(result.project.input.activeNarration.audioArtifactId, oldActive.audioArtifactId);
  assert.equal(result.project.input.activeNarration.audioHash, oldActive.audioHash);
  assert.notEqual(result.project.input.activeNarration.manifestArtifactId, oldActive.manifestArtifactId);
  assert.notEqual(result.project.input.activeNarration.alignmentArtifactId, oldActive.alignmentArtifactId);
  const oldAlignment = ctx.contentArtifacts.readJson(oldActive.alignmentArtifactId).body;
  const newAlignment = ctx.contentArtifacts.readJson(result.project.input.activeNarration.alignmentArtifactId).body;
  assert.deepEqual(newAlignment.words, oldAlignment.words);
  assert.deepEqual(newAlignment.beats, oldAlignment.beats);
  assert.equal(newAlignment.projectRevision, 2);
  assert.equal(newAlignment.draftHash, result.artifacts.approvalBundle.envelope.contentHash);
  assert.equal(ctx.artifactRepository.listByTypeStatus({ types: ["narration_audio"] }).length, audioCount);
  assert.equal(ctx.approvalRepository.findApproved(ctx.project.id, 2), null);
  assert.equal(ctx.approvalRepository.findApproved(ctx.project.id, 1).approvalId, ctx.approval.approvalId);
  assert.equal(normalizeInvalidationReport(result.reportArtifact.envelope.body).narration.status, "rebound_aligned");
  const replay = reviseNarratedProject({ project: ctx.project, expectedRevision: 1, changeType: "style_only", bundle: styleRevision(ctx.raw), idempotencyKey: "style-revision-0001" }, ctx.dependencies);
  assert.equal(replay.replayed, true);
  assert.equal(ctx.project.input.revision, 2);
});

test("style-only revision keeps unaligned narration unaligned and reuses exact audio", () => {
  const ctx = setup({ aligned: false });
  const oldActive = clone(ctx.project.input.activeNarration);
  const audioCount = ctx.artifactRepository.listByTypeStatus({ types: ["narration_audio"] }).length;
  const result = reviseNarratedProject({ project: ctx.project, expectedRevision: 1, changeType: "style_only", bundle: styleRevision(ctx.raw), idempotencyKey: "style-unaligned-0001" }, ctx.dependencies);
  const active = result.project.input.activeNarration;
  assert.equal(active.status, "uploaded_unaligned");
  assert.equal(active.projectRevision, 2);
  assert.equal(active.audioArtifactId, oldActive.audioArtifactId);
  assert.equal(active.audioHash, oldActive.audioHash);
  assert.notEqual(active.manifestArtifactId, oldActive.manifestArtifactId);
  assert.equal(active.alignmentArtifactId, null);
  assert.equal(active.aligned, false);
  assert.equal(active.timingReady, false);
  assert.equal(ctx.artifactRepository.listByTypeStatus({ types: ["narration_audio"] }).length, audioCount);
  const report = normalizeInvalidationReport(result.reportArtifact.envelope.body);
  assert.equal(report.narration.status, "rebound_unaligned");
  assert.deepEqual(report.narration.currentAlignment, { artifactId: null, hash: null });
});

test("content revision clears narration while keeping immutable historical artifacts", () => {
  const ctx = setup({ aligned: true });
  let revoked = null;
  ctx.dependencies.publishApprovalRepository = { snapshotState: () => new Map(), revokeRevision: (projectId, revision, reason) => { revoked = { projectId, revision, reason }; }, restoreState: () => {} };
  const oldManifestId = ctx.project.input.activeNarration.manifestArtifactId;
  const next = clone(ctx.raw); next.brief.operatorNotes = "Re-research every factual dependency before approval.";
  const result = reviseNarratedProject({ project: ctx.project, expectedRevision: 1, changeType: "content", bundle: next, idempotencyKey: "content-revision-01" }, ctx.dependencies);
  assert.equal(result.project.input.revision, 2);
  assert.equal(result.project.input.activeNarration, null);
  assert.equal(ctx.artifactRepository.get(oldManifestId).status, "available");
  assert.equal(result.reportArtifact.envelope.body.narration.status, "invalidated");
  assert.equal(ctx.approvalRepository.findApproved(ctx.project.id, 2), null);
  assert.deepEqual(revoked, { projectId: ctx.project.id, revision: 1, reason: "revision_invalidated" });
});

test("failed publish-token revocation rolls the revision mutation back", () => {
  const ctx = setup({ aligned: false }); const oldInput = clone(ctx.project.input);
  ctx.dependencies.publishApprovalRepository = { snapshotState: () => new Map([["active", { value: true }]]), revokeRevision: () => { throw new Error("persistence failure"); }, restoreState: () => {} };
  assert.throws(() => reviseNarratedProject({ project: ctx.project, expectedRevision: 1, changeType: "style_only", bundle: styleRevision(ctx.raw), idempotencyKey: "rollback-publish-token" }, ctx.dependencies));
  assert.equal(ctx.projectRepository.get(ctx.project.id).input.revision, 1);
  assert.equal(ctx.project.input.revision, 1); assert.deepEqual(ctx.project.input, oldInput);
});

test("revision workflow rejects no-ops, stale expectations, mismatched style changes, and request conflicts", () => {
  const noop = setup({ aligned: false });
  assert.throws(() => reviseNarratedProject({ project: noop.project, expectedRevision: 1, changeType: "content", bundle: noop.raw }, noop.dependencies), { code: "REVISION_NO_CHANGES" });
  const mismatch = setup({ aligned: false });
  const changedScript = clone(mismatch.raw); changedScript.script.title = "A changed narration title";
  assert.throws(() => reviseNarratedProject({ project: mismatch.project, expectedRevision: 1, changeType: "style_only", bundle: changedScript }, mismatch.dependencies), { code: "REVISION_CHANGE_TYPE_MISMATCH" });
  const stale = setup({ aligned: false });
  const first = reviseNarratedProject({ project: stale.project, expectedRevision: 1, changeType: "style_only", bundle: styleRevision(stale.raw), idempotencyKey: "same-key-0001" }, stale.dependencies);
  assert.equal(first.project.input.revision, 2);
  const other = clone(styleRevision(stale.raw)); other.storyboard.scenes[0].operations[0].text = "A different style mutation";
  assert.throws(() => reviseNarratedProject({ project: stale.project, expectedRevision: 1, changeType: "style_only", bundle: other, idempotencyKey: "same-key-0001" }, stale.dependencies), { code: "REVISION_REQUEST_CONFLICT" });
  assert.throws(() => reviseNarratedProject({ project: stale.project, expectedRevision: 1, changeType: "style_only", bundle: other, idempotencyKey: "other-key-0001" }, stale.dependencies), { code: "REVISION_EXPECTATION_STALE" });
  assert.throws(() => normalizeInvalidationReport({ ...first.reportArtifact.envelope.body, narration: { ...first.reportArtifact.envelope.body.narration, storageKey: "secret" } }), { code: "INVALIDATION_REPORT_INVALID" });
});

test("approval repository keeps exactly one active approval per revision", () => {
  const ctx = setup({ aligned: false });
  const replay = ctx.approvalRepository.approve({ ...ctx.approval });
  assert.equal(replay.approvalId, ctx.approval.approvalId);
  assert.throws(() => ctx.approvalRepository.approve({ ...ctx.approval, approvalId: undefined, renderProfile: "preview" }), { code: "CONTENT_APPROVAL_CONFLICT" });
  const replacement = ctx.contentArtifacts.createJson({ type: "approval_bundle", projectId: ctx.project.id, revision: 1, body: { replacement: true } });
  const next = ctx.approvalRepository.approve({ projectId: ctx.project.id, projectRevision: 1, draftArtifactId: replacement.artifact.id, draftHash: replacement.envelope.contentHash, voiceProfileId: "voice_en_01", renderProfile: "final", approvedAt: "2026-01-02T00:00:00.000Z" });
  assert.equal(ctx.approvalRepository.findApproved(ctx.project.id, 1).approvalId, next.approvalId);
  assert.equal(ctx.approvalRepository.get(ctx.approval.approvalId).status, "revoked");
  assert.equal(ctx.approvalRepository.get(ctx.approval.approvalId).replacementApprovalId, next.approvalId);
});

test("approval lookup fails closed on duplicate active state and recovery keeps the deterministic newest record", () => {
  const ctx = setup({ aligned: false });
  const records = new Map();
  const repository = new ContentApprovalRepository({ records, persist: false });
  const older = repository.save({ ...ctx.approval, approvalId: undefined, approvedAt: "2026-01-01T00:00:00.000Z" });
  const replacement = ctx.contentArtifacts.createJson({ type: "approval_bundle", projectId: ctx.project.id, revision: 1, body: { recovery: true } });
  const newer = repository.save({ projectId: ctx.project.id, projectRevision: 1, draftArtifactId: replacement.artifact.id, draftHash: replacement.envelope.contentHash, voiceProfileId: "voice_en_01", renderProfile: "final", approvedAt: "2026-01-03T00:00:00.000Z" });
  assert.throws(() => repository.findApproved(ctx.project.id, 1), { code: "CONTENT_APPROVAL_STATE_INVALID" });

  repository.persist = true;
  repository.dir = DATA_DIR;
  repository.save(older);
  repository.save(newer);
  const recovered = new ContentApprovalRepository({ persist: true });
  recovered.recover();
  assert.equal(recovered.findApproved(ctx.project.id, 1).approvalId, newer.approvalId);
  assert.equal(recovered.get(older.approvalId).status, "revoked");
  assert.equal(recovered.get(older.approvalId).revokedReason, "recovery_duplicate");
  assert.equal(recovered.get(older.approvalId).replacementApprovalId, newer.approvalId);
});
