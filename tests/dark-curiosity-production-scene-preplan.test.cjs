"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  mkdtempSync,
  readFileSync,
  rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const DATA_DIR = mkdtempSync(join(tmpdir(), "dc-scene-preplan-"));
process.env.MATCHCUTS_DATA_DIR = DATA_DIR;
process.env.OPENAI_API_KEY = "unit-test-sentinel-never-a-real-key";

const { ensureDataDirs } = require("../server/config.cjs");
ensureDataDirs();
const { LocalArtifactAdapter } = require("../server/adapters/local-artifact-adapter.cjs");
const { InMemoryArtifactRepository } = require("../server/repositories/artifact-repository.cjs");
const { ContentArtifactRepository } = require("../server/repositories/content-artifact-repository.cjs");
const { ContentApprovalRepository } = require("../server/repositories/content-approval-repository.cjs");
const { InMemoryProjectRepository } = require("../server/repositories/project-repository.cjs");
const { JobStore } = require("../server/jobs.cjs");
const {
  normalizeNarratedJobPayload,
} = require("../server/pipelines/pipeline-registry.cjs");
const {
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  createAlignment,
  scriptWords,
} = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const {
  buildPacingPlan,
} = require("../server/pipelines/narrated-short/narration/tts/pacing-plan.cjs");
const {
  runNarratedAnimationPreplanJob,
} = require("../server/pipelines/narrated-short/animation/preplan-job.cjs");
const {
  planSemanticAnimationScenes,
} = require("../server/pipelines/narrated-short/animation/semantic-animation-scene-plan-service.cjs");
const {
  buildProductionAnimationPayloadBindings,
} = require("../server/pipelines/narrated-short/animation/payload-bindings.cjs");
const {
  compileProductionAnimation,
} = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const {
  createLocalLlmScenePlanner,
} = require("../server/pipelines/narrated-short/animation/providers/local-llm-scene-planner.cjs");
const {
  SEMANTIC_SENTENCE_PROFILE_TOKEN,
} = require("../server/pipelines/narrated-short/animation/semantic-render-profile.cjs");

const FIXTURE = resolve(
  __dirname,
  "..",
  "eval",
  "narrated",
  "dark-curiosity",
  "fixtures",
  "002_gps_week_rollover.json",
);

test.after(() => {
  delete process.env.OPENAI_API_KEY;
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function rawFixture(generalized) {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  if (generalized) raw.script.title = `${raw.script.title} Reframed`;
  return raw;
}

function wordSegments(draft) {
  const pacingPlan = buildPacingPlan(draft.script);
  const semanticPausesBefore = new Map(
    pacingPlan.segments.slice(1).map((segment, index) => [
      segment.wordStartIndex,
      pacingPlan.segments[index].pauseAfterMs / 1000,
    ]),
  );
  let cursor = 0.08;
  const words = scriptWords(draft.script).map((word, index) => {
    cursor += semanticPausesBefore.get(index) || 0;
    const framed = {
      word: word.text,
      start: cursor,
      end: cursor + 0.31,
      probability: 0.99,
    };
    cursor += 0.415;
    return framed;
  });
  return {
    words,
    durationSeconds: Number((
      cursor + pacingPlan.segments.at(-1).pauseAfterMs / 1000
    ).toFixed(3)),
  };
}

function countedPlanner(mode = "mock") {
  const base = createLocalLlmScenePlanner({ mode, env: {} });
  let calls = 0;
  return {
    planner: Object.freeze({
      id: base.id,
      mode: base.mode,
      health: () => base.health(),
      async planScene(input) {
        calls += 1;
        return base.planScene(input);
      },
    }),
    calls: () => calls,
  };
}

function setup(generalized = true) {
  const artifactStore = new LocalArtifactAdapter();
  const artifactRepository = new InMemoryArtifactRepository({ persist: false });
  const contentArtifactRepository = new ContentArtifactRepository({
    artifactStore,
    artifactRepository,
  });
  const contentApprovalRepository = new ContentApprovalRepository({ persist: false });
  const projectRepository = new InMemoryProjectRepository();
  const projectId = `prj_${randomUUID()}`;
  const draft = normalizeDraftBundle(rawFixture(generalized));
  const bundle = contentArtifactRepository.createJson({
    type: "approval_bundle",
    projectId,
    revision: 1,
    body: draft,
  });
  let project = projectRepository.create({
    id: projectId,
    projectType: "narrated_short",
    title: draft.script.title,
    language: "en",
    status: "awaiting_approval",
    input: {
      type: "content_brief",
      revision: 1,
      briefArtifactId: bundle.artifact.id,
      claimLedgerArtifactId: bundle.artifact.id,
      scriptArtifactId: bundle.artifact.id,
      storyboardArtifactId: bundle.artifact.id,
    },
  });
  const approval = contentApprovalRepository.approve({
    projectId,
    projectRevision: 1,
    draftArtifactId: bundle.artifact.id,
    draftHash: bundle.envelope.contentHash,
    renderProfile: "preview",
  });
  const audioArtifactId = "art_scene-preplan-audio-0001";
  const audioHash = "a".repeat(64);
  const timedWords = wordSegments(draft);
  const alignment = createAlignment({
    project,
    draft,
    narration: {
      draftArtifactId: bundle.artifact.id,
      draftHash: bundle.envelope.contentHash,
      scriptHash: draft.script.contentHash,
      audioArtifactId,
      audioHash,
      language: "en",
      media: { durationSeconds: timedWords.durationSeconds },
    },
    narrationSummary: {
      manifestArtifactId: bundle.artifact.id,
      manifestHash: bundle.envelope.contentHash,
    },
    providerResult: { segments: [{ words: timedWords.words }] },
    provider: { model: "fixture", device: "cpu", computeType: "int8" },
  });
  const alignmentArtifact = contentArtifactRepository.createJson({
    type: "narration_alignment",
    projectId,
    revision: 1,
    dependencyHashes: [bundle.envelope.contentHash, audioHash],
    body: alignment,
  });
  project = projectRepository.update(projectId, {
    input: {
      ...project.input,
      activeNarration: {
        status: "aligned",
        projectRevision: 1,
        manifestArtifactId: bundle.artifact.id,
        manifestHash: bundle.envelope.contentHash,
        audioArtifactId,
        audioHash,
        draftArtifactId: bundle.artifact.id,
        draftHash: bundle.envelope.contentHash,
        scriptHash: draft.script.contentHash,
        voiceProfileId: "fixture_voice",
        language: "en",
        media: {
          container: "wav",
          codec: "pcm_s16le",
          sampleRate: 48000,
          channels: 1,
          durationSeconds: timedWords.durationSeconds,
          bytes: 1024,
        },
        rights: {
          commercialUseAllowed: true,
          ownershipBasis: "self_recorded",
          consentDeclared: true,
          licenseDeclared: true,
        },
        alignmentArtifactId: alignmentArtifact.artifact.id,
        alignmentHash: alignmentArtifact.envelope.contentHash,
      },
    },
  });
  return {
    alignment,
    alignmentArtifact,
    approval,
    artifactRepository,
    artifactStore,
    bundle,
    contentApprovalRepository,
    contentArtifactRepository,
    draft,
    project,
    projectRepository,
  };
}

function payloadFor(value, planner) {
  const health = planner.health();
  return {
    projectRevision: 1,
    language: "en",
    approvedDraftArtifactId: value.bundle.artifact.id,
    approvedDraftHash: value.bundle.envelope.contentHash,
    alignmentArtifactId: value.alignmentArtifact.artifact.id,
    alignmentHash: value.alignmentArtifact.envelope.contentHash,
    renderProfile: "preview",
    animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
    plannerMode: health.mode,
    promptProfileId: health.promptProfileId,
    plannerConfigurationHash: health.configurationHash,
  };
}

function jobFor(value, payload, idempotencyKey = randomUUID()) {
  const jobs = new JobStore({ persist: false, logger: null });
  const job = jobs.create({
    projectId: value.project.id,
    action: "plan_narrated_animation",
    pipelineType: "narrated_short",
    idempotencyKey,
    payload,
  });
  jobs.claimJob(job.id, { workerId: `wrk_${randomUUID()}` });
  return { job, jobs };
}

async function runPreplan(value, counted, options = {}) {
  const payload = payloadFor(value, counted.planner);
  const { job, jobs } = jobFor(value, payload, options.idempotencyKey);
  const result = await runNarratedAnimationPreplanJob({
    jobs,
    job,
    project: value.projectRepository.get(value.project.id),
    payload: job.payload,
    dependencies: {
      ...value,
      scenePlanner: counted.planner,
      environment: options.environment || "development",
      ...(options.dependencies || {}),
    },
  });
  return { job, jobs, payload, result };
}

test("production preplan persists one trusted aggregate and render bindings reuse it", async () => {
  const value = setup(true);
  const counted = countedPlanner("mock");
  const first = await runPreplan(value, counted);

  assert.equal(first.result.required, true);
  assert.equal(first.result.reused, false);
  assert.equal(first.job.status, "completed");
  assert.equal(counted.calls(), first.result.scenePlan.summary.sceneCount);
  assert.equal(
    first.result.artifact.envelope.contentHash,
    first.result.scenePlan.contentHash,
  );
  const persisted = value.contentArtifactRepository.readJson(
    first.result.artifact.artifact.id,
  );
  assert.equal(persisted.artifactType, "animation_scene_dsl_plan");
  assert.equal(persisted.body.contentHash, persisted.contentHash);
  assert.equal(
    persisted.dependencyHashes.includes(first.result.timingContext.contentHash),
    true,
  );
  assert.equal(
    persisted.dependencyHashes.includes(
      counted.planner.health().configurationHash,
    ),
    true,
  );

  const project = value.projectRepository.get(value.project.id);
  const active = project.input.activeAnimationScenePlan;
  assert.equal(active.planArtifactId, first.result.artifact.artifact.id);
  assert.equal(active.planHash, first.result.scenePlan.contentHash);
  assert.equal(active.fallbackSceneCount, 0);

  let compiledScenePlanHash = null;
  const bindings = buildProductionAnimationPayloadBindings({
    project,
    approval: value.contentApprovalRepository.findApproved(project.id, 1),
    renderProfile: "preview",
    animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
    contentArtifacts: value.contentArtifactRepository,
  }, {
    compileProductionAnimation(input) {
      compiledScenePlanHash = input.semanticAnimationSceneDslPlan?.contentHash;
      return compileProductionAnimation(input);
    },
    requirePersistedScenePlan: true,
  });
  assert.equal(compiledScenePlanHash, active.planHash);
  assert.equal(bindings.animationScenePlanArtifactId, active.planArtifactId);
  assert.equal(bindings.animationScenePlanHash, active.planHash);

  const normalized = normalizeNarratedJobPayload({
    projectRevision: 1,
    language: "en",
    approvedDraftArtifactId: value.bundle.artifact.id,
    approvedDraftHash: value.bundle.envelope.contentHash,
    narrationManifestHash: project.input.activeNarration.manifestHash,
    audioHash: project.input.activeNarration.audioHash,
    alignmentHash: project.input.activeNarration.alignmentHash,
    renderProfile: "preview",
    animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
    ...bindings,
  }, "render_narrated_short");
  assert.equal(normalized.animationScenePlanArtifactId, active.planArtifactId);
  assert.equal(normalized.animationScenePlanHash, active.planHash);

  const persistedText = JSON.stringify(persisted);
  assert.equal(persistedText.includes(process.env.OPENAI_API_KEY), false);
  assert.equal(persistedText.includes("/v1/chat/completions"), false);
  assert.equal(persistedText.includes("rawResponse"), false);

  const callsBeforeReplay = counted.calls();
  const replay = await runPreplan(value, counted);
  assert.equal(replay.result.reused, true);
  assert.equal(counted.calls(), callsBeforeReplay);
  assert.equal(
    replay.result.scenePlan.contentHash,
    first.result.scenePlan.contentHash,
  );
  const restoredJob = first.jobs.hydrateJob(first.jobs.serializeJob(first.job));
  assert.deepEqual(
    restoredJob.animationScenePlan,
    first.job.animationScenePlan,
  );
});

test("render binding rejects a plan from a changed planner configuration", async () => {
  const value = setup(true);
  const counted = countedPlanner("mock");
  await runPreplan(value, counted);
  const changedPlanner = createLocalLlmScenePlanner({
    mode: "mock",
    aggregateTimeoutMs: 301000,
    env: {},
  });
  assert.throws(
    () => buildProductionAnimationPayloadBindings({
      project: value.projectRepository.get(value.project.id),
      approval: value.contentApprovalRepository.findApproved(
        value.project.id,
        1,
      ),
      renderProfile: "preview",
      animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
      contentArtifacts: value.contentArtifactRepository,
    }, {
      requirePersistedScenePlan: true,
      expectedScenePlanner: changedPlanner.health(),
    }),
    (error) => error?.code === "ANIMATION_PREPLAN_REQUIRED"
      && error?.details?.reason === "planner_configuration_changed",
  );
});

test("scene-plan artifacts require the exact configuration dependency set", async () => {
  const value = setup(true);
  const counted = countedPlanner("mock");
  const planned = await runPreplan(value, counted);
  const original = value.contentArtifactRepository.readJson(
    planned.result.artifact.artifact.id,
  );
  const incomplete = value.contentArtifactRepository.createJson({
    type: "animation_scene_dsl_plan",
    projectId: value.project.id,
    revision: 1,
    dependencyHashes: original.dependencyHashes.filter(
      (hash) => hash !== counted.planner.health().configurationHash,
    ),
    body: planned.result.scenePlan,
  });
  const current = value.projectRepository.get(value.project.id);
  value.projectRepository.update(value.project.id, {
    input: {
      ...current.input,
      activeAnimationScenePlan: {
        ...current.input.activeAnimationScenePlan,
        planArtifactId: incomplete.artifact.id,
        planHash: incomplete.envelope.contentHash,
      },
    },
  });
  assert.throws(
    () => buildProductionAnimationPayloadBindings({
      project: value.projectRepository.get(value.project.id),
      approval: value.contentApprovalRepository.findApproved(
        value.project.id,
        1,
      ),
      renderProfile: "preview",
      animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
      contentArtifacts: value.contentArtifactRepository,
    }, { requirePersistedScenePlan: true }),
    (error) => error?.code === "ANIMATION_SCENE_PLAN_ARTIFACT_INVALID"
      && error?.details?.field === "artifact.dependencyHashes",
  );
});

test("live-mode binding requires the exact server-owned preplan artifact", () => {
  const value = setup(true);
  assert.throws(
    () => buildProductionAnimationPayloadBindings({
      project: value.project,
      approval: value.approval,
      renderProfile: "preview",
      animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
      contentArtifacts: value.contentArtifactRepository,
    }, { requirePersistedScenePlan: true }),
    (error) => error?.code === "ANIMATION_PREPLAN_REQUIRED",
  );

  const partial = normalizeNarratedJobPayload;
  assert.throws(
    () => partial({
      projectRevision: 1,
      language: "en",
      approvedDraftArtifactId: value.bundle.artifact.id,
      approvedDraftHash: value.bundle.envelope.contentHash,
      renderProfile: "preview",
      animationProfile: SEMANTIC_SENTENCE_PROFILE_TOKEN,
      timingContextHash: "1".repeat(64),
      animationPlanHash: "2".repeat(64),
      animationIRHash: "3".repeat(64),
      animationProvider: "hyperframes_local",
      animationRuntimeVersion: "0.7.55",
      animationStyleVersion: "3.2.0",
      animationScenePlanArtifactId: "art_partial-scene-plan-0001",
    }, "render_narrated_short"),
    (error) => error?.code === "VALIDATION_ERROR"
      && error?.details?.field === "animationScenePlan",
  );
});

test("an exact checked-profile source skips planning and persistence", async () => {
  const value = setup(false);
  const counted = countedPlanner("mock");
  const planned = await runPreplan(value, counted, {
    dependencies: {
      buildSemanticSentencePlanningContext() {
        return Object.freeze({
          semanticEventGraph: Object.freeze({
            primitivePayloadProfileId: undefined,
          }),
        });
      },
    },
  });
  assert.equal(planned.result.required, false);
  assert.equal(counted.calls(), 0);
  assert.equal(
    value.projectRepository.get(value.project.id).input.activeAnimationScenePlan,
    null,
  );
  assert.equal(planned.job.animationScenePlan.required, false);
});

test("production rejects mock planning before any scene call", async () => {
  const value = setup(true);
  const counted = countedPlanner("mock");
  await assert.rejects(
    () => runPreplan(value, counted, { environment: "production" }),
    (error) => error?.code === "ANIMATION_LOCAL_LLM_CONFIG_INVALID"
      && error?.details?.field === "mode",
  );
  assert.equal(counted.calls(), 0);
});

test("preplan fails stale without persistence when project state changes during planning", async () => {
  const value = setup(true);
  const counted = countedPlanner("mock");
  const beforeArtifacts = value.artifactRepository.all().length;
  await assert.rejects(
    () => runPreplan(value, counted, {
      dependencies: {
        async planSemanticAnimationScenes(input, dependencies) {
          const plan = await planSemanticAnimationScenes(input, dependencies);
          const current = value.projectRepository.get(value.project.id);
          value.projectRepository.update(value.project.id, {
            input: {
              ...current.input,
              activeNarration: null,
              activeAnimationScenePlan: null,
            },
          });
          return plan;
        },
      },
    }),
    (error) => error?.code === "ANIMATION_PREPLAN_STALE"
      && error?.details?.reason === "project_changed_during_planning",
  );
  assert.equal(value.artifactRepository.all().length, beforeArtifacts);
  assert.equal(
    value.projectRepository.get(value.project.id).input.activeAnimationScenePlan,
    null,
  );
});

test("preplan compare-and-swap rejects a change at the final install boundary", async () => {
  const value = setup(true);
  const counted = countedPlanner("mock");
  const payload = payloadFor(value, counted.planner);
  const { job, jobs } = jobFor(value, payload);
  let compareAndSwapCalls = 0;

  await assert.rejects(
    () => runNarratedAnimationPreplanJob({
      jobs,
      job,
      project: value.projectRepository.get(value.project.id),
      payload: job.payload,
      dependencies: {
        ...value,
        scenePlanner: counted.planner,
        environment: "development",
        persistenceAdapter: {
          compareAndSwapProject(options) {
            compareAndSwapCalls += 1;
            const current = value.projectRepository.get(value.project.id);
            value.projectRepository.update(value.project.id, {
              input: {
                ...current.input,
                activeNarration: null,
                activeAnimationScenePlan: null,
              },
            });
            return value.projectRepository.compareAndSwap(
              options.projectId,
              options.expectedProject,
              options.patch,
            );
          },
        },
      },
    }),
    (error) => error?.code === "ANIMATION_PREPLAN_STALE"
      && error?.details?.reason === "project_changed_before_install",
  );

  const current = value.projectRepository.get(value.project.id);
  assert.equal(compareAndSwapCalls, 1);
  assert.equal(current.input.activeNarration, null);
  assert.equal(current.input.activeAnimationScenePlan, null);
  assert.notEqual(job.status, "completed");
  assert.equal(job.animationScenePlan, null);
});
