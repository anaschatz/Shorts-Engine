#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESEARCH_DIR = "shortresearch";
const RUNS_DIR = `${RESEARCH_DIR}/runs`;
const BASELINE_PATH = `${RESEARCH_DIR}/baseline.json`;
const LATEST_PATH = `${RESEARCH_DIR}/latest.json`;
const RESULTS_PATH = `${RESEARCH_DIR}/results.tsv`;
const RESULTS_HEADER = [
  "run_id",
  "commit",
  "quality_score",
  "eval_score",
  "reference_score",
  "focused_tests",
  "status",
  "description",
  "report",
].join("\t");

const MIN_KEEP_DELTA = 0.25;
const EPSILON = 0.0001;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120000;

const COMMANDS = Object.freeze([
  {
    id: "lint",
    command: "npm",
    args: ["run", "lint"],
    hardGate: true,
  },
  {
    id: "build",
    command: "npm",
    args: ["run", "build"],
    hardGate: true,
  },
  {
    id: "eval",
    command: "npm",
    args: ["run", "eval"],
    hardGate: true,
    metricGroup: "eval",
  },
  {
    id: "evalReference",
    command: "npm",
    args: ["run", "eval:reference"],
    hardGate: true,
    metricGroup: "reference",
  },
  {
    id: "focusedTests",
    command: "node",
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-timeout=120000",
      "tests/analysis.test.cjs",
      "tests/caption-generation.test.cjs",
      "tests/football-story-planner.test.cjs",
      "tests/visual-tracking.test.cjs",
    ],
    hardGate: true,
  },
]);

const HIGHER_IS_BETTER_GUARDS = Object.freeze([
  { group: "reference", path: ["noFalseGoalClaim"] },
  { group: "reference", path: ["captionActionAlignment"] },
  { group: "reference", path: ["framingSafety"] },
  { group: "eval", path: ["captionActionAlignment"] },
  { group: "eval", path: ["framingSafety"] },
  { group: "eval", path: ["cropSafetyScore"] },
  { group: "eval", path: ["noFalseGoalFromOcrOnly"] },
]);

const LOWER_IS_BETTER_GUARDS = Object.freeze([
  { group: "eval", path: ["falseGoalRate"] },
  { group: "eval", path: ["falseVisualGoalRate"] },
  { group: "eval", path: ["falseGoalCaptionRate"] },
  { group: "eval", path: ["matchEventTruthFalseGoalRate"] },
  { group: "eval", path: ["textObstructionRisk"] },
]);

function safeRelativeFromRoot(relativePath) {
  const target = resolve(ROOT_DIR, relativePath);
  const fromRoot = relative(ROOT_DIR, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot.includes("\\")) {
    throw new Error(`Unsafe path outside project root: ${relativePath}`);
  }
  return fromRoot;
}

function absolutePath(relativePath) {
  return join(ROOT_DIR, safeRelativeFromRoot(relativePath));
}

function ensureResearchDirs() {
  mkdirSync(absolutePath(RESEARCH_DIR), { recursive: true });
  mkdirSync(absolutePath(RUNS_DIR), { recursive: true });
  const resultsPath = absolutePath(RESULTS_PATH);
  if (!existsSync(resultsPath)) writeFileSync(resultsPath, `${RESULTS_HEADER}\n`);
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function sanitizeTsv(value) {
  return String(value ?? "")
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function sanitizeOutput(value) {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/OPENAI_API_KEY=[^\s]+/g, "OPENAI_API_KEY=[redacted]")
    .replace(/\/Users\/[^\s"']+/g, "[redacted-path]")
    .replace(/\/private\/[^\s"']+/g, "[redacted-path]")
    .split(/\r?\n/)
    .slice(-80)
    .join("\n")
    .slice(0, 8000);
}

function extractJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runCommand(step) {
  const startedAt = new Date().toISOString();
  try {
    const stdout = execFileSync(step.command, step.args, {
      cwd: ROOT_DIR,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COMMAND_TIMEOUT_MS,
    });
    return {
      id: step.id,
      ok: true,
      command: [step.command, ...step.args].join(" "),
      startedAt,
      finishedAt: new Date().toISOString(),
      summary: step.metricGroup ? extractJsonObject(stdout) : null,
    };
  } catch (error) {
    return {
      id: step.id,
      ok: false,
      command: [step.command, ...step.args].join(" "),
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: error.status ?? null,
      signal: error.signal ?? null,
      output: sanitizeOutput(`${error.stdout || ""}\n${error.stderr || ""}`),
      summary: error.stdout ? extractJsonObject(error.stdout) : null,
    };
  }
}

function readGitValue(args, fallback = "unknown") {
  try {
    return execFileSync("git", args, {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function readGitMetadata() {
  const status = readGitValue(["status", "--short"], "");
  return {
    commit: readGitValue(["rev-parse", "--short=7", "HEAD"]),
    branch: readGitValue(["branch", "--show-current"], "detached"),
    dirty: status.length > 0,
    changedFiles: status
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function metricAt(source, group, path) {
  const root = source && source.metrics && source.metrics[group] ? source.metrics[group] : null;
  let current = root;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) return null;
    current = current[key];
  }
  const number = Number(current);
  return Number.isFinite(number) ? number : null;
}

function commandById(commands, id) {
  return commands.find((command) => command.id === id) || null;
}

function extractEvalMetrics(summary) {
  if (summary && summary.aggregate && typeof summary.aggregate === "object") return summary.aggregate;
  return summary && typeof summary === "object" ? summary : {};
}

function extractReferenceMetrics(summary) {
  if (summary && summary.aggregate && summary.aggregate.metrics && typeof summary.aggregate.metrics === "object") {
    return summary.aggregate;
  }
  if (summary && typeof summary === "object") {
    return {
      aggregateScore: Number(summary.aggregateScore) || 0,
      metrics: summary,
    };
  }
  return { aggregateScore: 0, metrics: {} };
}

function computeQualityScore({ evalSummary, referenceSummary, focusedTestsOk }) {
  const evalScore = Number(evalSummary && evalSummary.aggregateScore) || 0;
  const referenceScore = Number(referenceSummary && referenceSummary.aggregateScore) || 0;
  const focusedScore = focusedTestsOk ? 100 : 0;
  return {
    qualityScore: round((0.35 * evalScore) + (0.55 * referenceScore) + (0.10 * focusedScore), 4),
    evalScore: round(evalScore, 4),
    referenceScore: round(referenceScore, 4),
    focusedScore,
  };
}

function summarizeRun(commands) {
  const evalCommand = commandById(commands, "eval");
  const referenceCommand = commandById(commands, "evalReference");
  const focusedCommand = commandById(commands, "focusedTests");
  const evalMetrics = extractEvalMetrics(evalCommand && evalCommand.summary);
  const referenceAggregate = extractReferenceMetrics(referenceCommand && referenceCommand.summary);
  const score = computeQualityScore({
    evalSummary: evalMetrics,
    referenceSummary: referenceAggregate,
    focusedTestsOk: Boolean(focusedCommand && focusedCommand.ok),
  });
  return {
    ...score,
    metrics: {
      eval: evalMetrics,
      reference: referenceAggregate.metrics || {},
    },
  };
}

function guardName(guard) {
  return `${guard.group}.${guard.path.join(".")}`;
}

function compareGuardrails(current, baseline) {
  if (!baseline) return [];
  const regressions = [];
  for (const guard of HIGHER_IS_BETTER_GUARDS) {
    const currentValue = metricAt(current, guard.group, guard.path);
    const baselineValue = metricAt(baseline, guard.group, guard.path);
    if (currentValue === null || baselineValue === null) continue;
    if (currentValue + EPSILON < baselineValue) {
      regressions.push({
        metric: guardName(guard),
        direction: "higher_is_better",
        current: currentValue,
        baseline: baselineValue,
      });
    }
  }
  for (const guard of LOWER_IS_BETTER_GUARDS) {
    const currentValue = metricAt(current, guard.group, guard.path);
    const baselineValue = metricAt(baseline, guard.group, guard.path);
    if (currentValue === null || baselineValue === null) continue;
    if (currentValue > baselineValue + EPSILON) {
      regressions.push({
        metric: guardName(guard),
        direction: "lower_is_better",
        current: currentValue,
        baseline: baselineValue,
      });
    }
  }
  return regressions;
}

function decideExperiment(current, baseline, commands, { baselineMode = false, minKeepDelta = MIN_KEEP_DELTA } = {}) {
  const failedHardGates = commands.filter((command) => command.hardGate !== false && !command.ok).map((command) => command.id);
  if (failedHardGates.length > 0) {
    return {
      status: "crash",
      reason: "one_or_more_hard_gates_failed",
      failedHardGates,
      scoreDelta: baseline ? round(current.qualityScore - baseline.qualityScore, 4) : 0,
      guardrailRegressions: [],
    };
  }
  if (baselineMode || !baseline) {
    return {
      status: "baseline",
      reason: "baseline_recorded",
      failedHardGates: [],
      scoreDelta: 0,
      guardrailRegressions: [],
    };
  }
  const guardrailRegressions = compareGuardrails(current, baseline);
  const scoreDelta = round(current.qualityScore - baseline.qualityScore, 4);
  if (guardrailRegressions.length > 0) {
    return {
      status: "discard",
      reason: "safety_guardrail_regressed",
      failedHardGates: [],
      scoreDelta,
      guardrailRegressions,
    };
  }
  if (scoreDelta >= minKeepDelta) {
    return {
      status: "keep",
      reason: "quality_score_improved",
      failedHardGates: [],
      scoreDelta,
      guardrailRegressions: [],
    };
  }
  return {
    status: "discard",
    reason: "quality_score_did_not_improve_enough",
    failedHardGates: [],
    scoreDelta,
    guardrailRegressions: [],
  };
}

function readJsonIfExists(relativePath) {
  const path = absolutePath(relativePath);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(relativePath, value) {
  writeFileSync(absolutePath(relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function createRunId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

function appendResultsRow(run) {
  const row = [
    run.runId,
    run.git.commit,
    run.summary.qualityScore.toFixed(4),
    run.summary.evalScore.toFixed(4),
    run.summary.referenceScore.toFixed(4),
    run.summary.focusedScore,
    run.decision.status,
    sanitizeTsv(run.description),
    `${RUNS_DIR}/${run.runId}.json`,
  ].join("\t");
  appendFileSync(absolutePath(RESULTS_PATH), `${row}\n`);
}

function parseArgs(argv) {
  const options = {
    baselineMode: false,
    description: "manual ShortsEngine autoresearch run",
    minKeepDelta: MIN_KEEP_DELTA,
  };
  for (const arg of argv) {
    if (arg === "--baseline") {
      options.baselineMode = true;
      options.description = "baseline";
      continue;
    }
    if (arg.startsWith("--description=")) {
      options.description = arg.slice("--description=".length);
      continue;
    }
    if (arg.startsWith("--min-delta=")) {
      const parsed = Number(arg.slice("--min-delta=".length));
      if (Number.isFinite(parsed) && parsed >= 0) options.minKeepDelta = parsed;
    }
  }
  return options;
}

function createRunRecord({ options, commands, baseline }) {
  const runId = createRunId();
  const summary = summarizeRun(commands);
  const decision = decideExperiment(summary, baseline && baseline.summary, commands, options);
  return {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    description: options.description,
    objective: {
      weights: {
        referenceAggregateScore: 0.55,
        evalAggregateScore: 0.35,
        focusedTests: 0.10,
      },
      minKeepDelta: options.minKeepDelta,
    },
    git: readGitMetadata(),
    baselineRef: baseline ? {
      runId: baseline.runId,
      qualityScore: baseline.summary && baseline.summary.qualityScore,
      generatedAt: baseline.generatedAt,
    } : null,
    commands,
    summary,
    decision,
  };
}

function printSummary(run) {
  const output = {
    ok: run.decision.status === "keep" || run.decision.status === "baseline",
    status: run.decision.status,
    reason: run.decision.reason,
    runId: run.runId,
    qualityScore: run.summary.qualityScore,
    evalScore: run.summary.evalScore,
    referenceScore: run.summary.referenceScore,
    focusedScore: run.summary.focusedScore,
    scoreDelta: run.decision.scoreDelta,
    failedHardGates: run.decision.failedHardGates,
    guardrailRegressions: run.decision.guardrailRegressions,
    report: `${RUNS_DIR}/${run.runId}.json`,
    latest: LATEST_PATH,
  };
  console.log(JSON.stringify(output, null, 2));
}

function runAutoresearch(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  ensureResearchDirs();
  const baseline = options.baselineMode ? null : readJsonIfExists(BASELINE_PATH);
  const commands = COMMANDS.map(runCommand);
  const run = createRunRecord({ options, commands, baseline });
  writeJson(`${RUNS_DIR}/${run.runId}.json`, run);
  writeJson(LATEST_PATH, run);
  appendResultsRow(run);
  if (options.baselineMode || !baseline) writeJson(BASELINE_PATH, run);
  printSummary(run);
  if (run.decision.status === "crash" || run.decision.status === "discard") process.exitCode = 1;
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAutoresearch();
}

export {
  BASELINE_PATH,
  COMMANDS,
  HIGHER_IS_BETTER_GUARDS,
  LOWER_IS_BETTER_GUARDS,
  RESULTS_HEADER,
  computeQualityScore,
  compareGuardrails,
  createRunId,
  decideExperiment,
  extractJsonObject,
  parseArgs,
  runAutoresearch,
  summarizeRun,
};
