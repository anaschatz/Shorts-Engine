const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DATA_DIR = mkdtempSync(join(tmpdir(), "narration-upload-"));
process.env.MATCHCUTS_DATA_DIR = DATA_DIR;

const { CONFIG, ensureDataDirs } = require("../server/config.cjs");
ensureDataDirs();
const { commandAvailable, sha256 } = require("../server/media.cjs");
const { LocalArtifactAdapter } = require("../server/adapters/local-artifact-adapter.cjs");
const { InMemoryArtifactRepository } = require("../server/repositories/artifact-repository.cjs");
const { ContentArtifactRepository } = require("../server/repositories/content-artifact-repository.cjs");
const { ContentApprovalRepository } = require("../server/repositories/content-approval-repository.cjs");
const { InMemoryProjectRepository } = require("../server/repositories/project-repository.cjs");
const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { normalizeNarrationAsset, normalizeNarrationRights } = require("../server/pipelines/narrated-short/narration/contract.cjs");
const { ingestUploadedNarration, validateWavCandidate } = require("../server/pipelines/narrated-short/narration/upload.cjs");

const FIXTURE_PATH = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json");

test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function wavCandidate(lastByte = 0) {
  const buffer = Buffer.alloc(128, 0);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer[buffer.length - 1] = lastByte;
  return { fieldName: "narration", fileName: "voice.wav", mimeType: "audio/wav", buffer };
}

function validProbe(overrides = {}) {
  return {
    streams: [{ codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "48000", channels: 1, ...overrides.stream }],
    format: { format_name: "wav", duration: "31.25", ...overrides.format },
  };
}

function validFields(overrides = {}) {
  return {
    draftArtifactId: overrides.draftArtifactId,
    draftHash: overrides.draftHash,
    projectRevision: overrides.projectRevision === undefined ? "1" : String(overrides.projectRevision),
    voiceProfileId: "operator_voice_01",
    language: "en",
    commercialUseAllowed: "true",
    ownershipBasis: "self_recorded",
    rightsHolder: "Fixture Operator",
    consentReference: "operator_recording_consent_v1",
    licenseReference: "",
    ...overrides,
  };
}

function setup(options = {}) {
  const artifactStore = new LocalArtifactAdapter();
  const artifactRepository = new InMemoryArtifactRepository({ persist: false });
  const contentArtifactRepository = new ContentArtifactRepository({ artifactStore, artifactRepository });
  const contentApprovalRepository = new ContentApprovalRepository({ persist: false });
  const projectRepository = new InMemoryProjectRepository();
  const projectId = `prj_${randomUUID()}`;
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
  const approvalBundle = contentArtifactRepository.createJson({ type: "approval_bundle", projectId, revision: 1, body: draft });
  const project = projectRepository.create({
    id: projectId,
    projectType: "narrated_short",
    title: draft.script.title,
    language: "en",
    status: "awaiting_approval",
    input: {
      type: "content_brief",
      briefArtifactId: approvalBundle.artifact.id,
      claimLedgerArtifactId: approvalBundle.artifact.id,
      scriptArtifactId: approvalBundle.artifact.id,
      storyboardArtifactId: approvalBundle.artifact.id,
      revision: 1,
    },
  });
  contentApprovalRepository.approve({
    projectId,
    projectRevision: 1,
    draftArtifactId: approvalBundle.artifact.id,
    draftHash: approvalBundle.envelope.contentHash,
    renderProfile: "preview",
  });
  const dependencies = {
    artifactStore,
    artifactRepository,
    contentArtifactRepository,
    contentApprovalRepository,
    projectRepository,
    ffprobeJson: options.ffprobeJson || (async () => validProbe()),
  };
  return {
    draft,
    project,
    approvalBundle,
    dependencies,
    fields: validFields({
      draftArtifactId: approvalBundle.artifact.id,
      draftHash: approvalBundle.envelope.contentHash,
    }),
  };
}

test("narration contract is deterministic, strict, and requires commercial rights", () => {
  const context = setup();
  const base = {
    schemaVersion: 1,
    status: "uploaded_unaligned",
    projectId: context.project.id,
    projectRevision: 1,
    verticalId: "dark_curiosity",
    draftArtifactId: context.approvalBundle.artifact.id,
    draftHash: context.approvalBundle.envelope.contentHash,
    scriptHash: context.draft.script.contentHash,
    audioArtifactId: `art_${"a".repeat(40)}`,
    audioHash: "b".repeat(64),
    voiceProfileId: "operator_voice_01",
    language: "en",
    media: { container: "wav", codec: "pcm_s16le", sampleRate: 48000, channels: 1, durationSeconds: 30, bytes: 1000 },
    rights: {
      commercialUseAllowed: true,
      ownershipBasis: "self_recorded",
      rightsHolder: "Operator",
      consentReference: "consent_v1",
      licenseReference: null,
    },
  };
  assert.equal(normalizeNarrationAsset(base).contentHash, normalizeNarrationAsset(structuredClone(base)).contentHash);
  assert.throws(() => normalizeNarrationAsset({ ...base, unexpected: true }), (error) => error.code === "VALIDATION_ERROR");
  assert.throws(
    () => normalizeNarrationAsset({ ...base, scriptHash: "c".repeat(63) }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () => normalizeNarrationRights({ ...base.rights, commercialUseAllowed: false }),
    (error) => error.code === "NARRATION_RIGHTS_REQUIRED",
  );
  assert.throws(
    () => normalizeNarrationRights({ ...base.rights, consentReference: "" }),
    (error) => error.code === "NARRATION_RIGHTS_REQUIRED",
  );
});

test("licensed narration requires and records a license reference", async () => {
  const context = setup();
  context.fields.ownershipBasis = "licensed_recording";
  assert.rejects(
    () => ingestUploadedNarration({ project: context.project, fields: context.fields, file: wavCandidate() }, context.dependencies),
    (error) => error.code === "NARRATION_RIGHTS_REQUIRED",
  );
  context.fields.licenseReference = "commercial_voice_license_2026";
  const result = await ingestUploadedNarration({ project: context.project, fields: context.fields, file: wavCandidate() }, context.dependencies);
  assert.equal(result.manifest.rights.ownershipBasis, "licensed_recording");
  assert.equal(result.manifest.rights.licenseReference, "commercial_voice_license_2026");
});

test("WAV signature, stream, codec, sample rate, and duration fail closed", async () => {
  assert.throws(
    () => validateWavCandidate({ fileName: "fake.wav", buffer: Buffer.alloc(128) }),
    (error) => error.code === "NARRATION_WAV_INVALID",
  );
  const cases = [
    [{ streams: [], format: { format_name: "wav", duration: "10" } }, "NARRATION_AUDIO_UNSUPPORTED"],
    [validProbe({ stream: { codec_name: "mp3" } }), "NARRATION_AUDIO_UNSUPPORTED"],
    [validProbe({ stream: { sample_rate: "44100" } }), "NARRATION_AUDIO_UNSUPPORTED"],
    [validProbe({ format: { duration: "1" } }), "NARRATION_DURATION_INVALID"],
    [validProbe({ format: { duration: "121" } }), "NARRATION_DURATION_INVALID"],
  ];
  for (const [probe, code] of cases) {
    const context = setup({ ffprobeJson: async () => probe });
    await assert.rejects(
      () => ingestUploadedNarration({ project: context.project, fields: context.fields, file: wavCandidate() }, context.dependencies),
      (error) => error.code === code,
    );
  }
});

test("upload binds to exact approval, revision, project, and script hash", async () => {
  for (const mutation of [
    (context) => { context.fields.draftHash = "f".repeat(64); },
    (context) => { context.fields.projectRevision = "2"; },
    (context) => { context.fields.scriptHash = "e".repeat(64); },
  ]) {
    const context = setup();
    mutation(context);
    await assert.rejects(
      () => ingestUploadedNarration({ project: context.project, fields: context.fields, file: wavCandidate() }, context.dependencies),
      (error) => ["NARRATION_APPROVAL_MISMATCH", "NARRATION_REVISION_STALE"].includes(error.code),
    );
  }

  const context = setup();
  const foreign = setup();
  context.dependencies.contentApprovalRepository = new ContentApprovalRepository({ persist: false });
  context.dependencies.contentApprovalRepository.approve({
    projectId: context.project.id,
    projectRevision: 1,
    draftArtifactId: foreign.approvalBundle.artifact.id,
    draftHash: foreign.approvalBundle.envelope.contentHash,
    renderProfile: "preview",
  });
  context.dependencies.contentArtifactRepository = foreign.dependencies.contentArtifactRepository;
  context.fields.draftArtifactId = foreign.approvalBundle.artifact.id;
  context.fields.draftHash = foreign.approvalBundle.envelope.contentHash;
  await assert.rejects(
    () => ingestUploadedNarration({ project: context.project, fields: context.fields, file: wavCandidate() }, context.dependencies),
    (error) => error.code === "NARRATION_APPROVAL_MISMATCH",
  );
});

test("failed probing removes staging audio and creates no artifact records", async () => {
  const context = setup({ ffprobeJson: async () => { throw new Error("raw probe failure"); } });
  const before = readdirSync(CONFIG.audioDir);
  await assert.rejects(
    () => ingestUploadedNarration({ project: context.project, fields: context.fields, file: wavCandidate() }, context.dependencies),
    (error) => error.code === "NARRATION_WAV_INVALID" && !JSON.stringify(error).includes("raw probe failure"),
  );
  assert.deepEqual(readdirSync(CONFIG.audioDir), before);
  assert.equal(context.dependencies.artifactRepository.all().filter((artifact) => artifact.type === "narration_audio").length, 0);
});

test("replacement keeps immutable audio artifacts and updates the safe active narration pointer", async () => {
  const context = setup();
  const first = await ingestUploadedNarration({ project: context.project, fields: context.fields, file: wavCandidate(1) }, context.dependencies);
  const second = await ingestUploadedNarration({ project: context.project, fields: context.fields, file: wavCandidate(2) }, context.dependencies);
  assert.notEqual(first.audioArtifact.id, second.audioArtifact.id);
  assert.notEqual(first.manifestArtifact.artifact.id, second.manifestArtifact.artifact.id);
  assert.ok(context.dependencies.artifactRepository.get(first.audioArtifact.id));
  const active = context.dependencies.projectRepository.get(context.project.id).input.activeNarration;
  assert.equal(active.audioArtifactId, second.audioArtifact.id);
  assert.equal(active.status, "uploaded_unaligned");
  assert.equal(active.renderReady, false);
  const publicAudio = context.dependencies.artifactRepository.publicArtifact(second.audioArtifact);
  assert.equal(publicAudio.path, undefined);
  assert.equal(publicAudio.storageKey, undefined);
  assert.doesNotMatch(JSON.stringify(active), /(?:path|storageKey|stderr)/i);
});

test("real ffprobe ingestion records deterministic PCM WAV metadata and checksum", async (t) => {
  if (!commandAvailable(CONFIG.ffmpegBin) || !commandAvailable(CONFIG.ffprobeBin)) {
    t.skip("FFmpeg and ffprobe are required for the real WAV integration test");
    return;
  }
  const fixtureDir = mkdtempSync(join(tmpdir(), "narration-wav-fixture-"));
  const wavPath = join(fixtureDir, "narration.wav");
  try {
    const generated = spawnSync(CONFIG.ffmpegBin, [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.25",
      "-ac", "1", "-c:a", "pcm_s16le", wavPath,
    ], { stdio: "ignore" });
    assert.equal(generated.status, 0);
    assert.equal(existsSync(wavPath), true);
    const buffer = readFileSync(wavPath);
    const context = setup();
    delete context.dependencies.ffprobeJson;
    const result = await ingestUploadedNarration({
      project: context.project,
      fields: context.fields,
      file: { fieldName: "narration", fileName: "narration.wav", mimeType: "application/octet-stream", buffer },
    }, context.dependencies);
    assert.equal(result.manifest.audioHash, sha256(buffer));
    assert.equal(result.manifest.media.container, "wav");
    assert.equal(result.manifest.media.codec, "pcm_s16le");
    assert.equal(result.manifest.media.sampleRate, 48000);
    assert.equal(result.manifest.media.channels, 1);
    assert.ok(result.manifest.media.durationSeconds > 1);
    assert.equal(result.audioArtifact.checksumSha256, sha256(buffer));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
