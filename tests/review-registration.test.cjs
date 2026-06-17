const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  registerReviewDraft,
  safeRelativeRef,
  validateRegistrationInput,
} = require("../eval/review-registration.cjs");
const {
  findReviewSensitiveLeak,
  runReviewComparison,
  validateReviewInput,
} = require("../eval/review-comparison.cjs");

const PROJECT_ID = "prj_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const UPLOAD_ID = "upl_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const JOB_ID = "job_cccccccc-cccc-4ccc-cccc-cccccccccccc";
const EXPORT_ID = "exp_dddddddd-dddd-4ddd-dddd-dddddddddddd";

function createWorkspace() {
  const rootDir = mkdtempSync(join(tmpdir(), "shortsengine-register-"));
  mkdirSync(join(rootDir, "data", "projects"), { recursive: true });
  mkdirSync(join(rootDir, "data", "uploads"), { recursive: true });
  mkdirSync(join(rootDir, "data", "renders"), { recursive: true });
  writeFileSync(join(rootDir, "data", "uploads", "source.mp4"), Buffer.from("source-video"));
  writeFileSync(join(rootDir, "data", "renders", "generated.mp4"), Buffer.from("generated-short"));
  return rootDir;
}

function editPlan(overrides = {}) {
  return {
    sourceStart: 4,
    sourceEnd: 12,
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceDurationSeconds: 24,
    aspectRatio: "9:16",
    stylePreset: "social_sports_v1",
    styleTarget: "vertical_9_16_reference_style",
    highlightType: "big_chance",
    reasonCodes: ["big_chance", "audio_energy_spike", "crowd_reaction"],
    framingMode: "wide_safe_vertical",
    cropStrategy: {
      type: "wide_safe_contain",
      zoom: 1,
      preserveFullFrame: true,
      maxCropPercent: 0,
    },
    captions: [
      { start: 0, end: 1.1, role: "opening_hook", text: "THE CHANCE OPENS" },
      { start: 1.2, end: 3.2, role: "context", text: "Pressure builds around the box" },
      { start: 3.3, end: 5.5, role: "action_callout", text: "Almost punished in one touch" },
      { start: 5.6, end: 7.8, role: "closing_punch", text: "Replay the timing" },
    ],
    animationCues: [
      { type: "intro_hook", start: 0, end: 1 },
      { type: "kinetic_caption", start: 1, end: 5 },
      { type: "punch_zoom", start: 4, end: 5 },
    ],
    ...overrides,
  };
}

function writeRecords(rootDir, overrides = {}) {
  const projectRecord = {
    project: {
      id: PROJECT_ID,
      uploadId: UPLOAD_ID,
      title: "Registered review sample",
      status: "ready",
    },
    upload: {
      id: UPLOAD_ID,
      projectId: PROJECT_ID,
      path: join(rootDir, "data", "uploads", "source.mp4"),
      metadata: { durationSeconds: 24, width: 1920, height: 1080 },
      byteSize: 12,
      extension: "mp4",
      artifact: {
        id: UPLOAD_ID,
        type: "upload",
        ownerProjectId: PROJECT_ID,
        status: "available",
        size: 12,
        contentType: "video/mp4",
      },
    },
    ...(overrides.projectRecord || {}),
  };
  const renderRecord = {
    project: {
      id: PROJECT_ID,
      uploadId: UPLOAD_ID,
      title: "Registered review sample",
      status: "ready",
    },
    job: {
      id: JOB_ID,
      projectId: PROJECT_ID,
      uploadId: UPLOAD_ID,
      status: "completed",
      exportId: EXPORT_ID,
      payload: {
        language: "English",
        stylePreset: "social_sports_v1",
        styleTarget: "vertical_9_16_reference_style",
      },
    },
    exportId: EXPORT_ID,
    exportRecord: {
      id: EXPORT_ID,
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      outputPath: join(rootDir, "data", "renders", "generated.mp4"),
      fileName: `${PROJECT_ID}-short.mp4`,
      artifact: {
        id: EXPORT_ID,
        type: "export",
        ownerProjectId: PROJECT_ID,
        ownerJobId: JOB_ID,
        status: "available",
        size: 15,
        contentType: "video/mp4",
      },
    },
    highlights: [{
      start: 4,
      end: 12,
      highlightType: "big_chance",
      reasonCodes: ["big_chance", "audio_energy_spike", "crowd_reaction"],
      retentionScore: 88,
    }],
    editPlan: editPlan(overrides.editPlan || {}),
    ...(overrides.renderRecord || {}),
  };
  writeFileSync(join(rootDir, "data", "projects", `${PROJECT_ID}.json`), `${JSON.stringify(projectRecord, null, 2)}\n`);
  writeFileSync(join(rootDir, "data", "projects", `${PROJECT_ID}.render.json`), `${JSON.stringify(renderRecord, null, 2)}\n`);
  return { projectRecord, renderRecord };
}

function register(rootDir, overrides = {}) {
  return registerReviewDraft({
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    rightsConfirmed: true,
    rootDir,
    timestamp: "2026-06-17T13:00:00.000Z",
    ...overrides,
  });
}

test("review registration writes a compare-ready draft from completed render records", () => {
  const rootDir = createWorkspace();
  writeRecords(rootDir);

  const result = register(rootDir);

  assert.equal(result.output.latestPath, "eval/review-drafts/review-draft-latest.json");
  assert.match(result.output.draftPath, /eval\/review-drafts\/review-draft-prj_/);
  assert.equal(existsSync(join(rootDir, result.output.latestPath)), true);
  assert.equal(result.draft.media.generated.relativePath, "data/renders/generated.mp4");
  assert.equal(result.draft.media.source.relativePath, "data/uploads/source.mp4");
  assert.equal(result.draft.generatedMetadata.registration.projectId, PROJECT_ID);
  assert.equal(result.comparisonPreview.passed, true);
  assert.deepEqual(result.comparisonPreview.suggestions, []);
  assert.equal(result.comparisonPreview.suggestionSummary.suggestionCount, 0);
  assert.equal(result.comparisonPreview.regenerationAvailable, false);
  assert.equal(result.comparisonPreview.regenerationPlan, null);

  const input = validateReviewInput(result.draft, { rootDir });
  assert.equal(input.failedCases.length, 0);
  const comparison = runReviewComparison({
    rootDir,
    inputPath: result.output.latestPath,
    resultsDir: "eval/review-results",
    write: false,
  });
  assert.equal(comparison.report.passed, true);
});

test("review registration produces safe fix suggestions for failed generated output", () => {
  const rootDir = createWorkspace();
  writeRecords(rootDir, {
    editPlan: {
      captions: [
        { start: 0, end: 1.1, role: "opening_hook", text: "GOAL FROM NOTHING" },
        { start: 1.2, end: 3.2, role: "context", text: "Pressure builds around the box" },
        { start: 3.3, end: 5.5, role: "action_callout", text: "Almost punished in one touch" },
        { start: 5.6, end: 7.8, role: "closing_punch", text: "Replay the timing" },
      ],
    },
  });

  const result = register(rootDir);
  const suggestions = result.comparisonPreview.suggestions;
  assert.equal(result.comparisonPreview.passed, false);
  assert.equal(suggestions.some((item) => item.type === "false_goal_guard" && item.severity === "blocking"), true);
  assert.equal(result.comparisonPreview.suggestionSummary.blockingSuggestionCount, 1);
  assert.equal(result.comparisonPreview.regenerationAvailable, true);
  assert.equal(result.comparisonPreview.regenerationPlan, null);
  assert.equal(findReviewSensitiveLeak(result.comparisonPreview), null);
});

test("review registration fails closed unless rights are confirmed", () => {
  assert.throws(
    () => validateRegistrationInput({ projectId: PROJECT_ID, jobId: JOB_ID }),
    /rightsConfirmed/,
  );
});

test("review registration rejects non-completed jobs and missing exports", () => {
  const failedRoot = createWorkspace();
  writeRecords(failedRoot, { renderRecord: { job: { id: JOB_ID, projectId: PROJECT_ID, status: "failed", exportId: EXPORT_ID } } });
  assert.throws(
    () => register(failedRoot),
    (error) => error.code === "JOB_STATE_INVALID",
  );

  const missingExportRoot = createWorkspace();
  writeRecords(missingExportRoot, { renderRecord: { exportRecord: { id: "exp_eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee" } } });
  assert.throws(
    () => register(missingExportRoot),
    (error) => error.code === "EXPORT_NOT_FOUND",
  );
});

test("review registration rejects unsafe source or generated artifact refs", () => {
  const rootDir = createWorkspace();
  writeRecords(rootDir, {
    projectRecord: {
      upload: {
        id: UPLOAD_ID,
        projectId: PROJECT_ID,
        path: "/etc/passwd",
        metadata: { durationSeconds: 24 },
      },
    },
  });

  assert.throws(
    () => register(rootDir),
    (error) => error.code === "STORAGE_PATH_UNSAFE",
  );

  assert.throws(
    () => safeRelativeRef(rootDir, "../outside.mp4", "media.generated"),
    /workspace-relative/,
  );
});

test("review registration does not leak local paths or storage keys in drafts", () => {
  const rootDir = createWorkspace();
  writeRecords(rootDir, {
    renderRecord: {
      exportRecord: {
        id: EXPORT_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        outputPath: join(rootDir, "data", "renders", "generated.mp4"),
        artifact: {
          id: EXPORT_ID,
          type: "export",
          ownerProjectId: PROJECT_ID,
          ownerJobId: JOB_ID,
          status: "available",
          storageKey: "job_secretish.mp4",
        },
      },
    },
  });

  const result = register(rootDir);
  const payload = readFileSync(join(rootDir, result.output.latestPath), "utf8");
  assert.equal(findReviewSensitiveLeak(JSON.parse(payload)), null);
  assert.doesNotMatch(payload, /\/Users\/|\/private\/|storageKey|outputPath|secret|token/i);
});

test("review registration CLI writes safe JSON output", () => {
  const rootDir = createWorkspace();
  writeRecords(rootDir);
  const script = join(__dirname, "..", "eval", "run-review-registration.mjs");

  const run = spawnSync("node", [
    script,
    `--project=${PROJECT_ID}`,
    `--job=${JOB_ID}`,
    "--rights-confirmed=1",
  ], {
    cwd: rootDir,
    encoding: "utf8",
  });

  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.latest, "eval/review-drafts/review-draft-latest.json");
  assert.equal(existsSync(join(rootDir, summary.latest)), true);
  assert.doesNotMatch(run.stdout, /\/Users\/|\/private\/|storageKey|outputPath|token/i);
});
