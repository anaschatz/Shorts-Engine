const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  buildReport,
  loadFixtures,
  overlapRatio,
  reasonCodePrecision,
  reasonCodeRecall,
  runEvaluation,
  sanitizeReportText,
  scoreFixture,
  top3Recall,
  validateFixture,
} = require("../eval/scoring.cjs");

const fixturesDir = join(__dirname, "..", "eval", "fixtures");

test("evaluation fixtures pass schema validation", () => {
  const fixtures = loadFixtures(fixturesDir);
  assert.ok(fixtures.length >= 5);
  fixtures.forEach((fixture) => assert.equal(validateFixture(fixture), true));
});

test("overlap and recall scoring are deterministic", () => {
  assert.equal(overlapRatio({ start: 4, end: 12 }, { start: 6, end: 10 }), 1);
  assert.equal(overlapRatio({ start: 4, end: 8 }, { start: 6, end: 10 }), 0.5);
  assert.equal(
    top3Recall(
      [
        { start: 3, end: 8 },
        { start: 12, end: 18 },
      ],
      [
        { start: 4, end: 7 },
        { start: 13, end: 16 },
      ],
      0.5,
    ),
    1,
  );
});

test("reason code precision and recall score expected labels", () => {
  assert.equal(reasonCodePrecision(["goal_like_phrase", "audio_peak", "noise"], ["goal_like_phrase", "audio_peak"]), 0.6667);
  assert.equal(reasonCodeRecall(["goal_like_phrase"], ["goal_like_phrase", "audio_peak"]), 0.5);
});

test("fixture scoring returns reportable metrics and candidate plans", () => {
  const fixture = loadFixtures(fixturesDir)[0];
  const result = scoreFixture(fixture);
  assert.equal(result.passed, true);
  assert.ok(result.score >= fixture.thresholds.minAggregateScore);
  assert.ok(result.metrics.top1Overlap >= fixture.thresholds.minTop1Overlap);
  assert.ok(result.actual.candidatePlans.length > 0);
});

test("evaluation report has aggregate metrics and no local path leakage", () => {
  const report = runEvaluation({ fixturesDir, minAggregateScore: 70 });
  assert.equal(report.passed, true);
  assert.ok(report.aggregate.aggregateScore >= 70);
  assert.equal(report.aggregate.fixtureCount >= 5, true);
  assert.doesNotMatch(JSON.stringify(report), /\/Users\//);
  assert.doesNotMatch(JSON.stringify(report), /OPENAI_API_KEY/);
});

test("report shape is deterministic for fixed inputs", () => {
  const fixtures = loadFixtures(fixturesDir).slice(0, 2);
  const results = fixtures.map(scoreFixture);
  const first = buildReport({ fixtures, results, minAggregateScore: 70, timestamp: "2026-06-14T00:00:00.000Z" });
  const second = buildReport({ fixtures, results, minAggregateScore: 70, timestamp: "2026-06-14T00:00:00.000Z" });
  first.metadata.workspace = {};
  second.metadata.workspace = {};
  assert.deepEqual(first, second);
});

test("runner writes a JSON report", () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "matchcuts-eval-"));
  const result = spawnSync("node", ["eval/run-eval.mjs", `--results=${resultsDir}`, "--threshold=70"], {
    cwd: join(__dirname, ".."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.passed, true);
  const latest = JSON.parse(readFileSync(join(resultsDir, "latest.json"), "utf8"));
  assert.equal(latest.aggregate.fixtureCount >= 5, true);
});

test("runner exits non-zero when aggregate threshold fails", () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "matchcuts-eval-fail-"));
  const result = spawnSync("node", ["eval/run-eval.mjs", `--results=${resultsDir}`, "--threshold=101"], {
    cwd: join(__dirname, ".."),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.passed, false);
});

test("report sanitizer redacts secrets and local paths", () => {
  const text = sanitizeReportText("/Users/example/project OPENAI_API_KEY=secret Bearer token123 person@example.com");
  assert.doesNotMatch(text, /\/Users\//);
  assert.doesNotMatch(text, /secret/);
  assert.doesNotMatch(text, /person@example/);
});
