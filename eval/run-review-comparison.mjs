import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_REVIEW_THRESHOLD,
  runReviewComparison,
} = require("./review-comparison.cjs");

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.split("=");
  if (key && key.startsWith("--")) args.set(key.replace(/^--/, ""), value || "true");
}

const rootDir = process.cwd();
const inputPath = args.get("input") || args.get("fixture") || "eval/review-fixtures/demo-reference-style-review.json";
const resultsDir = args.get("results") || "eval/review-results";
const minOverallScore = Number(args.get("threshold") || DEFAULT_REVIEW_THRESHOLD);

try {
  const { report, output } = runReviewComparison({
    inputPath,
    rootDir,
    resultsDir,
    minOverallScore,
  });
  const summary = {
    passed: report.passed,
    status: report.status,
    overallScore: report.metrics.overallScore,
    threshold: report.threshold,
    momentTypeMatch: report.metrics.momentTypeMatch,
    noFalseGoalClaim: report.metrics.noFalseGoalClaim,
    captionActionAlignment: report.metrics.captionActionAlignment,
    captionSpecificity: report.metrics.captionSpecificity,
    framingSafety: report.metrics.framingSafety,
    aspectRatioCorrectness: report.metrics.aspectRatioCorrectness,
    animationCueCoverage: report.metrics.animationCueCoverage,
    referenceStyleSimilarity: report.metrics.referenceStyleSimilarity,
    referenceMode: report.input.referenceMode,
    report: output ? output.reportPath : null,
    latest: output ? output.latestPath : null,
    failedCriteria: report.failedCriteria,
    failedCases: report.failedCases,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!report.passed) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || "REVIEW_COMPARISON_FAILED",
    message: error.userMessage || "Review comparison failed.",
  }, null, 2));
  process.exit(1);
}
