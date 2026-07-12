const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "narrated-content-"));
process.env.MATCHCUTS_DATA_DIR = TEST_DATA_DIR;

const { ensureDataDirs, CONFIG } = require("../server/config.cjs");
ensureDataDirs();
const { ContentArtifactRepository } = require("../server/repositories/content-artifact-repository.cjs");
const { ContentApprovalRepository } = require("../server/repositories/content-approval-repository.cjs");
const { InMemoryArtifactRepository } = require("../server/repositories/artifact-repository.cjs");
const { LocalArtifactStore } = require("../server/storage/artifact-store.cjs");
const { normalizeContentBrief } = require("../server/pipelines/narrated-short/contracts.cjs");
const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { runNarratedDraftJob } = require("../server/pipelines/narrated-short/draft-job.cjs");
const { InMemoryProjectRepository } = require("../server/repositories/project-repository.cjs");
const { InMemoryUploadRepository } = require("../server/repositories/upload-repository.cjs");
const { InMemoryExportRepository } = require("../server/repositories/export-repository.cjs");
const { loadPersistedProjectState, persistProjectRecord } = require("../server/repositories/project-state.cjs");
const { JobStore } = require("../server/jobs.cjs");

const PROJECT_ID = "prj_11111111-1111-4111-8111-111111111111";
const JOB_ID = "job_22222222-2222-4222-8222-222222222222";
const DRAFT_HASH = "b".repeat(64);

test.after(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function brief() {
  return normalizeContentBrief({
    formatId: "tactical_cause_effect_v1",
    language: "en",
    audience: "casual football fans",
    topic: "How an overload creates the free runner",
    thesis: "The useful movement happens away from the ball.",
    targetSeconds: 30,
    tone: "clear_direct",
    sourceRefs: ["src_01"],
    operatorNotes: "generic example",
  });
}

test("content artifacts are immutable content-addressed JSON envelopes", () => {
  const artifactStore = new LocalArtifactStore();
  const artifactIndex = new InMemoryArtifactRepository({ persist: false });
  const repository = new ContentArtifactRepository({ artifactStore, artifactRepository: artifactIndex });
  const first = repository.createJson({
    type: "content_brief",
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    revision: 1,
    body: brief(),
  });
  const second = repository.createJson({
    type: "content_brief",
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    revision: 1,
    body: brief(),
  });

  assert.equal(first.artifact.id, second.artifact.id);
  assert.equal(first.envelope.contentHash, brief().contentHash);
  assert.equal(repository.readJson(first.artifact.id).body.topic, brief().topic);
  assert.doesNotMatch(JSON.stringify(repository.publicRecord(first.artifact.id)), /storageKey|path|\/private|\/Users/);
  assert.equal(readFileSync(artifactStore.resolve(first.artifact), "utf8").includes("content_brief"), true);
});

test("content approvals persist exact revision and draft hash and can be revoked", () => {
  const first = new ContentApprovalRepository({ dir: CONFIG.contentApprovalDir });
  const approved = first.approve({
    projectId: PROJECT_ID,
    projectRevision: 2,
    draftArtifactId: "art_33333333-3333-4333-8333-333333333333",
    draftHash: DRAFT_HASH,
    voiceProfileId: "voice_en_01",
    renderProfile: "preview",
    operatorNote: "approved fixture",
  });
  assert.equal(first.findApproved(PROJECT_ID, 2).approvalId, approved.approvalId);

  const recovered = new ContentApprovalRepository({ dir: CONFIG.contentApprovalDir });
  assert.deepEqual(recovered.recover(), { records: 1, ignored: 0 });
  assert.equal(recovered.get(approved.approvalId).draftHash, DRAFT_HASH);
  recovered.revoke(approved.approvalId);
  assert.equal(recovered.findApproved(PROJECT_ID, 2), null);
});

test("content artifact and approval inputs fail closed", () => {
  const repository = new ContentArtifactRepository({
    artifactStore: new LocalArtifactStore(),
    artifactRepository: new InMemoryArtifactRepository({ persist: false }),
  });
  assert.throws(
    () => repository.createJson({ type: "unknown", projectId: PROJECT_ID, revision: 1, body: brief() }),
    (error) => error.code === "ARTIFACT_TYPE_INVALID",
  );
  const approvals = new ContentApprovalRepository({ persist: false });
  assert.throws(
    () => approvals.approve({ projectId: PROJECT_ID, projectRevision: 1, draftArtifactId: "bad", draftHash: DRAFT_HASH }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("manual narrated draft job validates four inputs and writes an approval bundle", async () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, "..", "eval", "narrated", "fixtures", "001_overload_explainer.json"), "utf8"));
  const bundle = normalizeDraftBundle(fixture);
  const artifactStore = new LocalArtifactStore();
  const artifactIndex = new InMemoryArtifactRepository({ persist: false });
  const contentArtifacts = new ContentArtifactRepository({ artifactStore, artifactRepository: artifactIndex });
  const create = (type, body) => contentArtifacts.createJson({
    type,
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    revision: 1,
    body,
  }).artifact.id;
  const briefArtifactId = create("content_brief", bundle.brief);
  const claimLedgerArtifactId = create("claim_ledger", bundle.claimLedger);
  const scriptArtifactId = create("narrative_script", bundle.script);
  const storyboardArtifactId = create("storyboard", bundle.storyboard);
  const projects = new InMemoryProjectRepository();
  const project = projects.create({
    id: PROJECT_ID,
    projectType: "narrated_short",
    language: "en",
    title: "Overload explainer",
    input: { type: "content_brief", briefArtifactId, revision: 1 },
  });
  const jobs = new JobStore();
  const job = jobs.create({
    projectId: PROJECT_ID,
    action: "draft_narrated_short",
    pipelineType: "narrated_short",
    idempotencyKey: "manual-narrated-draft-job",
    payload: {
      projectRevision: 1,
      language: "en",
      providerMode: "manual",
      briefArtifactId,
      claimLedgerArtifactId,
      scriptArtifactId,
      storyboardArtifactId,
    },
  });
  jobs.update(job, { status: "processing", progress: 1, step: "queued" });

  await runNarratedDraftJob({
    jobs,
    job,
    project,
    payload: job.payload,
    dependencies: { contentArtifactRepository: contentArtifacts, projectRepository: projects },
  });

  assert.equal(job.status, "completed");
  assert.equal(job.step, "draft_ready_for_approval");
  assert.equal(project.status, "awaiting_approval");
  assert.equal(job.contentDraft.approvalRequired, true);
  assert.equal(contentArtifacts.readJson(job.contentDraft.artifactId).artifactType, "approval_bundle");
});

test("local project recovery preserves bounded revision invalidation state", () => {
  const artifactId = (character) => `art_${character.repeat(40)}`;
  const digest = (character) => character.repeat(64);
  const projects = new InMemoryProjectRepository();
  const project = projects.create({
    id: "prj_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectType: "narrated_short",
    language: "en",
    title: "Recovered revision",
    status: "awaiting_approval",
    input: {
      type: "content_brief",
      revision: 2,
      briefArtifactId: artifactId("a"),
      claimLedgerArtifactId: artifactId("b"),
      scriptArtifactId: artifactId("c"),
      storyboardArtifactId: artifactId("d"),
      activeNarration: null,
      lastInvalidation: {
        artifactId: artifactId("e"), contentHash: digest("1"), requestHash: digest("2"), idempotencyKeyHash: null,
        fromRevision: 1, toRevision: 2, changeType: "content", narrationReused: false, approvalRequired: true,
      },
    },
  });
  persistProjectRecord({ project });
  const restoredProjects = new InMemoryProjectRepository();
  loadPersistedProjectState({
    projectRepository: restoredProjects,
    uploadRepository: new InMemoryUploadRepository({ artifactStore: new LocalArtifactStore() }),
    exportRepository: new InMemoryExportRepository({ artifactStore: new LocalArtifactStore() }),
    artifactStore: new LocalArtifactStore(),
  });
  const restored = restoredProjects.get(project.id);
  assert.equal(restored.input.revision, 2);
  assert.equal(restored.input.lastInvalidation.artifactId, artifactId("e"));
  assert.equal(restored.input.lastInvalidation.changeType, "content");
  assert.doesNotMatch(JSON.stringify(restoredProjects.publicProject(restored)), /storageKey|\/Users|\/private/);
});
