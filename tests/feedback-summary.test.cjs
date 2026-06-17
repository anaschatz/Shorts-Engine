const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  buildFeedbackSummaryReport,
  loadFeedbackItems,
  runFeedbackSummary,
  validateFeedbackItem,
} = require("../eval/feedback-summary.cjs");

function validFeedback(overrides = {}) {
  return {
    fixtureId: "017_action_beats_crowd_reaction_no_goal",
    generatedShortRef: "eval/reference/017_action_beats_crowd_reaction_no_goal",
    selectedMomentCorrect: true,
    captionAlignmentScore: 5,
    captionSpecificityScore: 5,
    falseClaimFlags: [],
    notes: "Chance evidence is primary and crowd is support.",
    preferredCaptionExamples: ["The big chance opens"],
    reviewer: "operator",
    createdAt: "2026-06-17T00:00:00.000Z",
    ...overrides,
  };
}

test("feedback item validation accepts safe review records", () => {
  const item = validateFeedbackItem(validFeedback());
  assert.equal(item.fixtureId, "017_action_beats_crowd_reaction_no_goal");
  assert.equal(item.captionAlignmentScore, 5);
  assert.equal(item.falseClaimFlags.length, 0);
});

test("feedback item validation rejects unsafe refs and unsupported flags", () => {
  assert.throws(() => validateFeedbackItem(validFeedback({
    generatedShortRef: "/Users/example/storage/output.mp4",
  })), /Feedback generatedShortRef is unsafe/);
  assert.throws(() => validateFeedbackItem(validFeedback({
    generatedShortRef: "../storage/output.mp4",
  })), /Feedback generatedShortRef is unsafe/);
  assert.throws(() => validateFeedbackItem(validFeedback({
    falseClaimFlags: ["raw_provider_error"],
  })), /unsupported value/);
});

test("feedback summary aggregates safe reports without path leakage", () => {
  const report = buildFeedbackSummaryReport({
    timestamp: "2026-06-17T00:00:00.000Z",
    items: [
      validFeedback(),
      validFeedback({
        fixtureId: "012_visual_save_no_goal",
        generatedShortRef: "eval/reference/012_visual_save_no_goal",
        selectedMomentCorrect: false,
        captionAlignmentScore: 2,
        captionSpecificityScore: 2,
        falseClaimFlags: ["wrong_action_claim"],
        notes: "/Users/example should be redacted",
      }),
    ],
  });

  assert.equal(report.aggregate.itemCount, 2);
  assert.equal(report.aggregate.selectedMomentAccuracy, 0.5);
  assert.equal(report.aggregate.falseClaimRate, 0.5);
  assert.equal(report.failedCases.length, 1);
  assert.doesNotMatch(JSON.stringify(report), /\/Users\//);
  assert.doesNotMatch(JSON.stringify(report), /OPENAI_API_KEY|Bearer\s+[A-Za-z0-9._-]+/);
});

test("feedback summary runner loads local JSON and writes safe report", () => {
  const root = mkdtempSync(join(tmpdir(), "shortsengine-feedback-"));
  const feedbackDir = join(root, "feedback");
  const resultsDir = join(root, "results");
  mkdirSync(feedbackDir, { recursive: true });
  writeFileSync(join(feedbackDir, "feedback.json"), `${JSON.stringify([validFeedback()], null, 2)}\n`, "utf8");

  const items = loadFeedbackItems(feedbackDir);
  assert.equal(items.length, 1);
  const { report, output } = runFeedbackSummary({ feedbackDir, resultsDir, timestamp: "2026-06-17T00:00:00.000Z" });
  assert.equal(report.aggregate.itemCount, 1);
  assert.equal(output.latest, "feedback-latest.json");
  const latest = JSON.parse(readFileSync(join(resultsDir, "feedback-latest.json"), "utf8"));
  assert.equal(latest.metadata.trainingDataMutation, false);
});

test("feedback:summary CLI returns deterministic safe summary", () => {
  const root = mkdtempSync(join(tmpdir(), "shortsengine-feedback-cli-"));
  const feedbackDir = join(root, "feedback");
  const resultsDir = join(root, "results");
  mkdirSync(feedbackDir, { recursive: true });
  writeFileSync(join(feedbackDir, "feedback.json"), `${JSON.stringify(validFeedback(), null, 2)}\n`, "utf8");
  const result = spawnSync("node", ["eval/run-feedback-summary.mjs", `--feedback=${feedbackDir}`, `--results=${resultsDir}`], {
    cwd: join(__dirname, ".."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.itemCount, 1);
  assert.equal(summary.trainingDataMutation, false);
  assert.doesNotMatch(result.stdout, /\/Users\//);
});
