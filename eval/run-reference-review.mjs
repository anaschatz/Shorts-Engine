import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_REFERENCE_THRESHOLD,
  runReferenceReview,
  writeReferenceReviewReport,
} = require("./reference-rubric.cjs");

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

const fixturesDir = resolveArgPath(args.get("fixtures"), join(__dirname, "reference-fixtures"));
const resultsDir = resolveArgPath(args.get("results"), join(__dirname, "results"));
const minAggregateScore = Number(args.get("threshold") || DEFAULT_REFERENCE_THRESHOLD);

try {
  const report = runReferenceReview({ fixturesDir, minAggregateScore });
  const output = writeReferenceReviewReport(report, resultsDir);
  const summary = {
    passed: report.passed,
    aggregateScore: report.aggregate.aggregateScore,
    fixtureCount: report.aggregate.fixtureCount,
    passRate: report.aggregate.passRate,
    failedCount: report.aggregate.failedCount,
    borderlineCount: report.aggregate.borderlineCount,
    noFalseGoalClaim: report.aggregate.metrics.noFalseGoalClaim,
    captionActionAlignment: report.aggregate.metrics.captionActionAlignment,
    animationCueRelevance: report.aggregate.metrics.animationCueRelevance,
    framingSafety: report.aggregate.metrics.framingSafety,
    aspectRatioCorrectness: report.aggregate.metrics.aspectRatioCorrectness,
    report: `eval/results/${output.fileName}`,
    latest: "eval/results/reference-latest.json",
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!report.passed) process.exit(1);
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        code: error.code || "REFERENCE_REVIEW_FAILED",
        message: error.userMessage || "Reference review failed.",
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
