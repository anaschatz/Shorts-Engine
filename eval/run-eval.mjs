import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DEFAULT_THRESHOLDS, runEvaluation, writeReport } = require("./scoring.cjs");

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.split("=");
  if (key && key.startsWith("--")) args.set(key.replace(/^--/, ""), value || "true");
}

function resolveArgPath(value, fallback) {
  if (!value) return fallback;
  return isAbsolute(value) ? value : join(process.cwd(), value);
}

const fixturesDir = resolveArgPath(args.get("fixtures"), join(__dirname, "fixtures"));
const resultsDir = resolveArgPath(args.get("results"), join(__dirname, "results"));
const minAggregateScore = Number(args.get("threshold") || DEFAULT_THRESHOLDS.minAggregateScore);

try {
  const report = runEvaluation({ fixturesDir, minAggregateScore });
  const output = writeReport(report, resultsDir);
  const summary = {
    passed: report.passed,
    aggregateScore: report.aggregate.aggregateScore,
    fixtureCount: report.aggregate.fixtureCount,
    passRate: report.aggregate.passRate,
    top1Overlap: report.aggregate.top1Overlap,
    top3Recall: report.aggregate.top3Recall,
    reasonCodePrecision: report.aggregate.reasonCodePrecision,
    highlightTypeAccuracy: report.aggregate.highlightTypeAccuracy,
    falseGoalCaptionRate: report.aggregate.falseGoalCaptionRate,
    framingSafety: report.aggregate.framingSafety,
    animationCueValidity: report.aggregate.animationCueValidity,
    fallbackUsageRate: report.aggregate.fallbackUsageRate,
    report: `eval/results/${output.fileName}`,
    latest: "eval/results/latest.json",
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!report.passed) process.exit(1);
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        code: error.code || "EVAL_FAILED",
        message: error.userMessage || "Evaluation failed.",
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
