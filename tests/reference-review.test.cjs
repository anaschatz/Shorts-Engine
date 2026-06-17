const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  buildReferenceReviewReport,
  loadReferenceFixtures,
  runReferenceReview,
  scoreReferencePlan,
  validateReferenceFixture,
} = require("../eval/reference-rubric.cjs");

const fixturesDir = join(__dirname, "..", "eval", "reference-fixtures");

function baseFixture(overrides = {}) {
  return {
    id: "reference_unit_chance",
    title: "Reference unit chance",
    language: "English",
    durationSeconds: 20,
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 5, end: 6, text: "The big chance opens" }],
    },
    mediaSignals: {
      durationSeconds: 20,
      width: 1920,
      height: 1080,
      hasAudio: true,
      audioPeaks: [{ time: 6, energyScore: 0.9, source: "fixture" }],
      sceneChanges: [],
      highMotionCandidates: [],
    },
    expected: {
      highlights: [{ start: 4, end: 10 }],
      reasonCodes: ["big_chance", "audio_energy_spike", "visual_shot_like_motion"],
      highlightType: "big_chance",
      captionRoles: ["opening_hook", "context", "action_callout", "reaction", "closing_punch"],
      captionMustMentionAny: [
        { role: "opening_hook", terms: ["chance"] },
        { role: "action_callout", terms: ["almost"] },
        { role: "closing_punch", terms: ["replay"] },
      ],
      forbiddenClaims: ["goal", "scored"],
      requiredAnimationCues: ["intro_hook", "kinetic_caption", "end_replay_prompt", "punch_zoom", "impact_flash"],
      aspectRatio: "9:16",
      stylePreset: "punchy_highlight",
      safeFraming: { preserveFullFrame: true },
      durationRange: [6, 16],
      minQualityScore: 84,
    },
    ...overrides,
  };
}

function validPlan(overrides = {}) {
  const captions = [
    { start: 0, end: 1.4, text: "THE BIG CHANCE OPENS", role: "opening_hook", layout: "center", style: { maxLines: 2 } },
    { start: 1.5, end: 3, text: "The danger builds quickly", role: "context", layout: "top", style: { maxLines: 1 } },
    { start: 3.1, end: 5, text: "Almost punished them", role: "action_callout", layout: "bottom", style: { maxLines: 2 } },
    { start: 5.1, end: 6.7, text: "The crowd felt that", role: "reaction", layout: "bottom", style: { maxLines: 2 } },
    { start: 6.8, end: 8.5, text: "Replay the timing", role: "closing_punch", layout: "bottom", style: { maxLines: 2 } },
  ];
  return {
    sourceStart: 4,
    sourceEnd: 12,
    aspectRatio: "9:16",
    stylePreset: "punchy_highlight",
    highlightType: "big_chance",
    hook: "THE BIG CHANCE OPENS",
    captions,
    animationCues: [
      { type: "intro_hook", start: 0, end: 1 },
      { type: "kinetic_caption", start: 0.2, end: 1.8 },
      { type: "punch_zoom", start: 2, end: 3 },
      { type: "impact_flash", start: 3, end: 3.12 },
      { type: "end_replay_prompt", start: 6.9, end: 8 },
    ],
    unsupportedAnimationCues: [],
    reasonCodes: ["big_chance", "audio_energy_spike", "visual_shot_like_motion"],
    framingMode: "wide_safe_vertical",
    cropStrategy: {
      type: "wide_safe_contain",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      zoom: 1,
      preserveFullFrame: true,
      maxCropPercent: 0,
    },
    visualEvidenceSummary: {
      providerMode: "fixture",
      fallbackUsed: false,
      windowCount: 1,
      topTypes: ["shot_like_motion"],
      reasonCodes: ["visual_shot_like_motion"],
      actionFocusConfidence: 0.86,
      goalClaimAllowed: false,
    },
    ...overrides,
  };
}

function validMoment(overrides = {}) {
  return {
    start: 4.5,
    end: 11,
    highlightType: "big_chance",
    reasonCodes: ["big_chance", "audio_energy_spike", "visual_shot_like_motion"],
    retentionScore: 88,
    source: "analysis",
    ...overrides,
  };
}

test("reference fixtures pass schema validation", () => {
  const fixtures = loadReferenceFixtures(fixturesDir);
  assert.equal(fixtures.length >= 8, true);
  fixtures.forEach((fixture) => assert.equal(validateReferenceFixture(fixture), true));
});

test("reference review produces safe expected-vs-actual report", () => {
  const report = runReferenceReview({ fixturesDir, minAggregateScore: 80 });
  assert.equal(report.passed, true);
  assert.equal(report.aggregate.fixtureCount >= 8, true);
  assert.equal(report.aggregate.metrics.noFalseGoalClaim, 1);
  assert.equal(report.aggregate.metrics.framingSafety, 1);
  assert.equal(report.fixtures[0].expected.captionRoles.includes("opening_hook"), true);
  assert.equal(Array.isArray(report.fixtures[0].actual.editPlan.captionTexts), true);
  assert.doesNotMatch(JSON.stringify(report), /\/Users\//);
  assert.doesNotMatch(JSON.stringify(report), /OPENAI_API_KEY|Bearer\s+[A-Za-z0-9._-]+/);
});

test("rubric penalizes false goal claims in no-goal fixtures", () => {
  const result = scoreReferencePlan(baseFixture(), {
    topMoment: validMoment(),
    topPlan: validPlan({
      hook: "WHAT A GOAL",
      captions: validPlan().captions.map((caption, index) => (
        index === 0 ? { ...caption, text: "WHAT A GOAL" } : caption
      )),
    }),
  });
  assert.equal(result.passed, false);
  assert.equal(result.metrics.noFalseGoalClaim, 0);
  assert.match(result.notes.join(" "), /unsupported goal|forbidden/i);
});

test("rubric penalizes caption/action mismatch and missing hook roles", () => {
  const mismatch = scoreReferencePlan(baseFixture(), {
    topMoment: validMoment(),
    topPlan: validPlan({
      captions: validPlan().captions.map((caption) => (
        caption.role === "action_callout" ? { ...caption, text: "Generic pressure" } : caption
      )),
    }),
  });
  assert.equal(mismatch.metrics.captionActionAlignment < 1, true);

  const missingHook = scoreReferencePlan(baseFixture(), {
    topMoment: validMoment(),
    topPlan: validPlan({
      captions: validPlan().captions.map((caption, index) => (
        index === 0 ? { ...caption, role: "context", text: "The danger builds" } : caption
      )),
    }),
  });
  assert.equal(missingHook.metrics.captionRoleSequence < 1, true);
  assert.equal(missingHook.metrics.hookStrength < 1, true);
});

test("rubric penalizes unsupported cues and aspect ratio mismatch", () => {
  const cueResult = scoreReferencePlan(baseFixture(), {
    topMoment: validMoment(),
    topPlan: validPlan({
      unsupportedAnimationCues: [{ type: "orbital_spin" }],
      animationCues: validPlan().animationCues.filter((cue) => cue.type !== "impact_flash"),
    }),
  });
  assert.equal(cueResult.metrics.animationCueRelevance < 1, true);

  const aspectResult = scoreReferencePlan(baseFixture(), {
    topMoment: validMoment(),
    topPlan: validPlan({ aspectRatio: "1:1" }),
  });
  assert.equal(aspectResult.passed, false);
  assert.equal(aspectResult.metrics.aspectRatioCorrectness, 0);
});

test("reference report shape is deterministic for fixed inputs", () => {
  const fixtures = loadReferenceFixtures(fixturesDir).slice(0, 2);
  const results = fixtures.map((fixture) => scoreReferencePlan(fixture, {
    topMoment: validMoment({ highlightType: fixture.expected.highlightType, reasonCodes: fixture.expected.reasonCodes || [] }),
    topPlan: validPlan({
      highlightType: fixture.expected.highlightType,
      stylePreset: fixture.expected.stylePreset,
      reasonCodes: fixture.expected.reasonCodes || [],
      aspectRatio: fixture.expected.aspectRatio || "9:16",
    }),
  }));
  const first = buildReferenceReviewReport({ fixtures, results, minAggregateScore: 70, timestamp: "2026-06-17T00:00:00.000Z" });
  const second = buildReferenceReviewReport({ fixtures, results, minAggregateScore: 70, timestamp: "2026-06-17T00:00:00.000Z" });
  first.metadata.workspace = {};
  second.metadata.workspace = {};
  assert.deepEqual(first, second);
});

test("eval:reference runner writes a JSON report and fails thresholds", () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "shortsengine-reference-review-"));
  const pass = spawnSync("node", ["eval/run-reference-review.mjs", `--results=${resultsDir}`, "--threshold=80"], {
    cwd: join(__dirname, ".."),
    encoding: "utf8",
  });
  assert.equal(pass.status, 0, pass.stderr);
  const summary = JSON.parse(pass.stdout);
  assert.equal(summary.passed, true);
  assert.equal(summary.fixtureCount >= 8, true);
  const latest = JSON.parse(readFileSync(join(resultsDir, "reference-latest.json"), "utf8"));
  assert.equal(latest.aggregate.fixtureCount >= 8, true);

  const fail = spawnSync("node", ["eval/run-reference-review.mjs", `--results=${resultsDir}`, "--threshold=101"], {
    cwd: join(__dirname, ".."),
    encoding: "utf8",
  });
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).passed, false);
});
