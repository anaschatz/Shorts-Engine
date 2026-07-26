const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");

const { CONFIG, ensureDataDirs } = require("../server/config.cjs");
const {
  ACTION,
  PIPELINE_TYPE,
  PROFILE_IDS,
  contentHash,
  normalizeMotivationalSourceShortJobPayload,
  normalizeTranscriptManifest,
  normalizeWorkerResult,
} = require("../server/pipelines/motivational-source-short/contracts.cjs");
const {
  SECONDARY_METRICS,
  normalizeCandidateDecision,
  normalizeExperimentManifest,
} = require("../server/pipelines/motivational-source-short/growth-contracts.cjs");
const {
  DISCOVERY_ONLY_MODE,
  buildPythonWorkerArgs,
  createMotivationalSourceShortHandler,
  createPythonMotivationalWorker,
} = require("../server/pipelines/motivational-source-short/python-worker-adapter.cjs");
const {
  createPipelineRegistry,
  descriptorForJob,
  pipelineTypeForAction,
} = require("../server/pipelines/pipeline-registry.cjs");

const PROJECT_ID = "prj_11111111-1111-4111-8111-111111111111";
const RIGHTS_HASH = "b".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  ensureDataDirs();
  const sourceDir = mkdtempSync(join(CONFIG.artifactDir, "motivational-source-"));
  const outputRoot = mkdtempSync(join(CONFIG.renderDir, "motivational-output-"));
  const tempRoot = mkdtempSync(join(CONFIG.tmpDir, "motivational-control-"));
  const sourcePath = join(sourceDir, "source.mp4");
  const sourceBody = Buffer.from("approved motivational source fixture");
  writeFileSync(sourcePath, sourceBody);
  const sourceHash = sha256(sourceBody);
  const candidateDecision = normalizeCandidateDecision({
    schemaVersion: 1,
    artifactType: "CandidateDecision",
    decisionId: "cdec_nodeworker001",
    sourceManifestHash: RIGHTS_HASH,
    sourceHash,
    candidateHash: "2".repeat(64),
    selectionProfile: PROFILE_IDS.selectionProfile,
    decision: "approved",
    reviewer: "editor_operator",
    decidedAt: "2026-07-16T10:00:00.000Z",
    notes: "Exact approved candidate fixture.",
  });
  const experimentManifest = normalizeExperimentManifest({
    schemaVersion: 1,
    artifactType: "ExperimentManifest",
    manifestId: "expm_nodeworker001",
    experimentId: "exp_nodeworker001",
    cohortId: "contradiction_hook",
    treatmentId: "treatment_a",
    candidateDecisionHash: candidateDecision.contentHash,
    candidateHash: candidateDecision.candidateHash,
    hypothesis: "The approved contradiction hook improves stayed to watch.",
    primaryVariable: "hook_family",
    pillar: "discipline_work",
    durationBucket: "08_12s",
    formatProfile: PROFILE_IDS.formatProfile,
    selectionProfile: PROFILE_IDS.selectionProfile,
    renderProfile: PROFILE_IDS.renderProfile,
    language: "en",
    artificialCutLimit: 0,
    uploadCadence: "one_per_day_five_per_week",
    declaredAt: "2026-07-16T11:00:00.000Z",
    decisionDueAt: "2026-08-16T11:00:00.000Z",
    snapshotGatesHours: [1, 6, 24, 72, 168, 672],
    decisionGatesHours: [24, 72, 168, 672],
    primaryMetric: "stayed_to_watch_percentile",
    secondaryMetrics: [...SECONDARY_METRICS],
    humanDecisionRequired: true,
  }, { candidateDecision });
  const transcript = {
    duration: 30,
    segments: [{
      start: 0,
      end: 11,
      text: "You do not need more time you need a clear decision",
      words: [
        { word: "You", start: 0, end: 0.5 },
        { word: "do", start: 0.5, end: 1 },
        { word: "not", start: 1, end: 1.5 },
        { word: "need", start: 1.5, end: 2 },
        { word: "more", start: 2, end: 2.5 },
        { word: "time", start: 2.5, end: 3 },
        { word: "you", start: 3, end: 3.5 },
        { word: "need", start: 3.5, end: 4 },
        { word: "a", start: 4, end: 4.5 },
        { word: "clear", start: 4.5, end: 5 },
        { word: "decision", start: 5, end: 5.5 },
      ],
    }],
  };
  const transcriptManifest = normalizeTranscriptManifest({
    schemaVersion: 1,
    artifactType: "TranscriptManifest",
    sourceHash,
    modelId: "faster-whisper-large-v3",
    language: "en",
    durationSeconds: transcript.duration,
    transcriptHash: contentHash(transcript),
    transcript,
  });
  const payload = {
    schemaVersion: 1,
    sourcePath,
    sourceArea: "artifacts",
    sourceHash,
    rightsManifestHash: RIGHTS_HASH,
    candidateDecisionHash: candidateDecision.contentHash,
    candidateDecision,
    experimentManifestHash: experimentManifest.contentHash,
    experimentManifest,
    transcriptManifestHash: transcriptManifest.contentHash,
    transcriptManifest,
    profiles: { ...PROFILE_IDS },
    language: "en",
    downloadFormat: "720",
  };
  return {
    cleanup() {
      for (const path of [sourceDir, outputRoot, tempRoot]) {
        rmSync(path, { recursive: true, force: true });
      }
    },
    outputRoot,
    payload,
    sourceHash,
    sourcePath,
    tempRoot,
  };
}

test("motivational job contract fixes immutable profile IDs and hash bindings", () => {
  const state = fixture();
  try {
    assert.equal(Object.isFrozen(PROFILE_IDS), true);
    const normalized = normalizeMotivationalSourceShortJobPayload(state.payload);
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(Object.isFrozen(normalized.profiles), true);
    assert.equal(normalized.sourcePath, state.sourcePath);
    assert.equal(normalized.sourceHash, state.sourceHash);
    assert.equal(normalized.profiles.formatProfile, "bf_viral_micro_v1");

    assert.throws(
      () => normalizeMotivationalSourceShortJobPayload({
        ...state.payload,
        profiles: { ...PROFILE_IDS, renderProfile: "budget_friendly_v2" },
      }),
      (error) => error.code === "VALIDATION_ERROR",
    );
    assert.throws(
      () => normalizeMotivationalSourceShortJobPayload({ ...state.payload, unexpected: true }),
      (error) => error.code === "VALIDATION_ERROR",
    );
    assert.throws(
      () => normalizeMotivationalSourceShortJobPayload({
        ...state.payload,
        rightsManifestHash: "1".repeat(64),
      }),
      (error) => error.code === "GROWTH_LINK_MISMATCH",
    );
    assert.throws(
      () => normalizeMotivationalSourceShortJobPayload({
        ...state.payload,
        sourcePath: "/etc/passwd",
      }),
      (error) => error.code === "STORAGE_PATH_UNSAFE",
    );
  } finally {
    state.cleanup();
  }
});

test("pipeline registry resolves motivational source jobs without a generic upload", async () => {
  assert.equal(pipelineTypeForAction(ACTION), PIPELINE_TYPE);
  assert.equal(pipelineTypeForAction("generate"), "clip");
  assert.equal(pipelineTypeForAction("render_narrated_short"), "narrated_short");
  assert.deepEqual(descriptorForJob({ action: ACTION, pipelineType: PIPELINE_TYPE }), {
    action: ACTION,
    pipelineType: PIPELINE_TYPE,
    requiresUpload: false,
  });
  assert.equal(descriptorForJob({ action: "generate" }).requiresUpload, true);

  const unavailable = createPipelineRegistry().resolve({ action: ACTION });
  assert.equal(unavailable.pipelineType, PIPELINE_TYPE);
  await assert.rejects(unavailable.handler({}), (error) => error.code === "PIPELINE_HANDLER_UNAVAILABLE");

  const expectedHandler = async () => "ok";
  const configured = createPipelineRegistry({ motivationalSourceShortHandler: expectedHandler })
    .resolve({ action: ACTION, pipelineType: PIPELINE_TYPE });
  assert.equal(configured.handler, expectedHandler);
  assert.throws(
    () => pipelineTypeForAction(ACTION, "clip"),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("JobStore durably preserves strict motivational payloads without exposing local paths", () => {
  const { JobStore } = require("../server/jobs.cjs");
  const state = fixture();
  const jobDir = mkdtempSync(join(CONFIG.tmpDir, "motivational-jobs-"));
  try {
    const first = new JobStore({ persist: true, jobDir, logger: null });
    const job = first.create({
      projectId: PROJECT_ID,
      action: ACTION,
      pipelineType: PIPELINE_TYPE,
      idempotencyKey: "motivational-durable-payload",
      payload: state.payload,
    });
    assert.equal(job.uploadId, null);
    assert.equal(job.payload.sourceHash, state.sourceHash);
    assert.equal(job.payload.profiles.renderProfile, "bf_editorial_inset_v1");
    const publicJob = first.publicJob(job);
    assert.equal(Object.prototype.hasOwnProperty.call(publicJob.payload, "sourcePath"), false);
    assert.equal(publicJob.payload.sourceHash, state.sourceHash);
    assert.equal(publicJob.payload.transcriptManifest.transcript, undefined);
    assert.equal(
      publicJob.payload.transcriptManifest.contentHash,
      state.payload.transcriptManifestHash,
    );

    const second = new JobStore({ persist: true, jobDir, logger: null });
    assert.equal(second.recover().records, 1);
    const recovered = second.get(job.id);
    assert.equal(recovered.pipelineType, PIPELINE_TYPE);
    assert.equal(
      recovered.payload.candidateDecisionHash,
      state.payload.candidateDecisionHash,
    );
    assert.equal(recovered.payload.sourcePath, state.sourcePath);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
    state.cleanup();
  }
});

test("python adapter builds a shell-free, local-only fixed-profile command", () => {
  const state = fixture();
  try {
    const outputJsonPath = join(state.tempRoot, "result.json");
    const args = buildPythonWorkerArgs(state.payload, outputJsonPath);
    assert.equal(args[1], state.sourcePath);
    assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "local"]);
    assert.deepEqual(
      args.slice(args.indexOf("--format-profile"), args.indexOf("--format-profile") + 2),
      ["--format-profile", "bf_viral_micro_v1"],
    );
    assert.deepEqual(args.slice(args.indexOf("--num-clips"), args.indexOf("--num-clips") + 2), ["--num-clips", "1"]);
    assert.equal(args.includes("--upload-youtube"), false);
  } finally {
    state.cleanup();
  }
});

test("python adapter verifies source, worker bindings, result paths and hashes", async () => {
  const state = fixture();
  try {
    const clipPath = join(state.outputRoot, "short-1.mp4");
    const rankingPath = join(state.outputRoot, "ranking.json");
    writeFileSync(clipPath, Buffer.from("rendered short"));
    writeFileSync(rankingPath, JSON.stringify({ schema_version: 2 }));
    let observed = null;
    let spawnCalls = 0;
    let resultJsonPath = null;
    let controlInputPath = null;
    let emittedCandidateHash = state.payload.candidateDecision.candidateHash;
    const spawnImpl = (binary, args, options) => {
      spawnCalls += 1;
      resultJsonPath = args[args.indexOf("--output-json") + 1];
      controlInputPath = options.env.SHORTSENGINE_CONTROL_INPUT_PATH;
      observed = {
        args,
        binary,
        options,
        controlInput: JSON.parse(readFileSync(controlInputPath, "utf8")),
      };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => {
        writeFileSync(resultJsonPath, JSON.stringify({
          mode: "local",
          profiles: {
            content_profile: PROFILE_IDS.contentProfile,
            selection_profile: PROFILE_IDS.selectionProfile,
            render_profile: PROFILE_IDS.renderProfile,
            format_profile: PROFILE_IDS.formatProfile,
          },
          source_video_url: state.sourcePath,
          control_plane_bindings: {
            source_hash: state.sourceHash,
            rights_manifest_hash: RIGHTS_HASH,
            candidate_decision_hash: state.payload.candidateDecisionHash,
            candidate_hash: state.payload.candidateDecision.candidateHash,
            experiment_manifest_hash: state.payload.experimentManifestHash,
            transcript_manifest_hash: state.payload.transcriptManifestHash,
          },
          shorts: [{
            clip_url: clipPath,
            output_rank: 1,
            start_time: 4,
            end_time: 15,
            candidate_hash: emittedCandidateHash,
          }],
          ranking: { manifest_path: rankingPath },
        }));
        child.emit("close", 0);
      });
      return child;
    };
    const worker = createPythonMotivationalWorker({
      mode: DISCOVERY_ONLY_MODE,
      spawnImpl,
      outputRoot: state.outputRoot,
      tempRoot: state.tempRoot,
      timeoutMs: 5000,
      now: () => new Date("2026-07-16T10:00:00.000Z"),
    });
    const result = await worker(state.payload);

    assert.equal(observed.options.shell, false);
    assert.equal(observed.options.env.LOCAL_OUTPUT_DIR, state.outputRoot);
    assert.equal(observed.options.env.SHORTSENGINE_CONTROL_SOURCE_SHA256, state.sourceHash);
    assert.equal(
      observed.controlInput.candidateDecision.contentHash,
      state.payload.candidateDecisionHash,
    );
    assert.equal(
      observed.controlInput.transcriptManifest.contentHash,
      state.payload.transcriptManifestHash,
    );
    assert.equal(result.output.outputHash, sha256(readFileSync(clipPath)));
    assert.equal(result.ranking.manifestHash, sha256(readFileSync(rankingPath)));
    assert.equal(result.candidateDecisionHash, state.payload.candidateDecisionHash);
    assert.equal(result.candidateHash, state.payload.candidateDecision.candidateHash);
    assert.deepEqual(normalizeWorkerResult(result, state.payload), result);
    assert.equal(existsSync(resultJsonPath), false);
    assert.equal(existsSync(controlInputPath), false);
    emittedCandidateHash = "9".repeat(64);
    await assert.rejects(
      worker(state.payload),
      (error) => error.code === "MOTIVATIONAL_WORKER_RESULT_INVALID",
    );
    writeFileSync(state.sourcePath, "changed source after approval");
    await assert.rejects(
      worker(state.payload),
      (error) => error.code === "SOURCE_CACHE_CHECKSUM_MISMATCH",
    );
    assert.equal(spawnCalls, 2, "a stale source hash must block before Python starts");
  } finally {
    state.cleanup();
  }
});

test("discovery adapter cannot be promoted into a production job handler", async () => {
  const unavailable = createMotivationalSourceShortHandler();
  await assert.rejects(unavailable({}), (error) => error.code === "PIPELINE_HANDLER_UNAVAILABLE");
  let workerCalls = 0;
  const ignoredDiscoveryWorker = createMotivationalSourceShortHandler({
    worker: async () => { workerCalls += 1; },
  });
  await assert.rejects(
    ignoredDiscoveryWorker({}),
    (error) => error.code === "PIPELINE_HANDLER_UNAVAILABLE",
  );
  assert.equal(workerCalls, 0);
  assert.throws(
    () => createPythonMotivationalWorker(),
    (error) => error.code === "PIPELINE_HANDLER_UNAVAILABLE",
  );
});

test("local job worker requires an explicit production handler and recovers its result", async () => {
  const { createLocalJobWorker } = require("../server/job-worker.cjs");
  const { JobStore } = require("../server/jobs.cjs");
  const state = fixture();
  const jobDir = mkdtempSync(join(CONFIG.tmpDir, "motivational-live-jobs-"));
  try {
    const outputPath = join(state.outputRoot, "live-short.mp4");
    const rankingPath = join(state.outputRoot, "live-ranking.json");
    writeFileSync(outputPath, "live render");
    writeFileSync(rankingPath, "live ranking");
    const { createMotivationalWorkerResult } = require(
      "../server/pipelines/motivational-source-short/contracts.cjs"
    );
    const workerResult = createMotivationalWorkerResult({
      ...state.payload,
      candidateHash: state.payload.candidateDecision.candidateHash,
      output: {
        localPath: outputPath,
        outputHash: sha256("live render"),
        sizeBytes: 11,
        outputRank: 1,
        durationSeconds: 11,
      },
      ranking: {
        manifestPath: rankingPath,
        manifestHash: sha256("live ranking"),
      },
      completedAt: "2026-07-17T10:00:00.000Z",
    });
    const jobs = new JobStore({ persist: true, jobDir, logger: null });
    const job = jobs.create({
      projectId: PROJECT_ID,
      action: ACTION,
      pipelineType: PIPELINE_TYPE,
      idempotencyKey: "motivational-live-dispatch",
      payload: state.payload,
    });
    let uploadLookups = 0;
    let observedPayload = null;
    const worker = createLocalJobWorker({
      jobs,
      projects: new Map([[PROJECT_ID, { id: PROJECT_ID, title: "Motivational source" }]]),
      uploads: new Map(),
      uploadRepository: {
        get() {
          uploadLookups += 1;
          throw new Error("generic upload lookup must not run");
        },
      },
      dependencies: {
        logger: null,
        heartbeatIntervalMs: 0,
        async runMotivationalSourceShortJob(context) {
          observedPayload = context.payload;
          context.jobs.complete(context.job, {
            step: "motivational_render_complete",
            outputPath,
            motivationalRender: workerResult,
          });
          return workerResult;
        },
      },
    });

    await worker.process(job, { requestId: "motivational_live_test" });

    assert.equal(job.status, "completed");
    assert.equal(job.step, "motivational_render_complete");
    assert.equal(uploadLookups, 0);
    assert.equal(observedPayload.sourceHash, state.sourceHash);
    assert.equal(job.motivationalRender.contentHash, workerResult.contentHash);
    const publicJob = jobs.publicJob(job);
    assert.equal(publicJob.motivationalRender.output.localPath, undefined);
    assert.equal(publicJob.motivationalRender.output.outputHash, workerResult.output.outputHash);

    const blockedJob = jobs.create({
      projectId: PROJECT_ID,
      action: ACTION,
      pipelineType: PIPELINE_TYPE,
      idempotencyKey: "motivational-discovery-must-not-dispatch",
      payload: state.payload,
    });
    let discoveryFactoryCalls = 0;
    const failClosedWorker = createLocalJobWorker({
      jobs,
      projects: new Map([[PROJECT_ID, { id: PROJECT_ID, title: "Motivational source" }]]),
      uploads: new Map(),
      dependencies: {
        logger: null,
        heartbeatIntervalMs: 0,
        createMotivationalSourceShortWorker() {
          discoveryFactoryCalls += 1;
          return async () => workerResult;
        },
      },
    });
    await failClosedWorker.process(blockedJob, { requestId: "motivational_fail_closed_test" });
    assert.equal(blockedJob.status, "failed");
    assert.equal(blockedJob.error.code, "PIPELINE_HANDLER_UNAVAILABLE");
    assert.equal(discoveryFactoryCalls, 0);

    const recoveredStore = new JobStore({ persist: true, jobDir, logger: null });
    assert.equal(recoveredStore.recover().records, 2);
    const recovered = recoveredStore.get(job.id);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.motivationalRender.contentHash, workerResult.contentHash);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
    state.cleanup();
  }
});
