import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { runReviewSummary } = require("./review-comparison.cjs");

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.split("=");
  if (key && key.startsWith("--")) args.set(key.replace(/^--/, ""), value || "true");
}

const rootDir = process.cwd();
const resultsDir = args.get("results") || "eval/review-results";

try {
  const { report, output } = runReviewSummary({ rootDir, resultsDir });
  const summary = {
    passed: report.passed,
    status: report.status,
    sampleCount: report.aggregate.sampleCount,
    passRate: report.aggregate.passRate,
    overallScore: report.aggregate.overallScore,
    noFalseGoalClaim: report.aggregate.noFalseGoalClaim,
    captionActionAlignment: report.aggregate.captionActionAlignment,
    framingSafety: report.aggregate.framingSafety,
    referenceStyleSimilarity: report.aggregate.referenceStyleSimilarity,
    latest: output ? output.latestPath : null,
    report: output ? output.reportPath : null,
    failedCases: report.failedCases,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!report.passed) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || "REVIEW_SUMMARY_FAILED",
    message: error.userMessage || "Review summary failed.",
  }, null, 2));
  process.exit(1);
}
