import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { runFeedbackSummary } = require("./feedback-summary.cjs");

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

const feedbackDir = resolveArgPath(args.get("feedback"), join(__dirname, "human-feedback"));
const resultsDir = resolveArgPath(args.get("results"), join(__dirname, "results"));

try {
  const { report, output } = runFeedbackSummary({ feedbackDir, resultsDir });
  const summary = {
    passed: report.failedCases.length === 0,
    itemCount: report.aggregate.itemCount,
    selectedMomentAccuracy: report.aggregate.selectedMomentAccuracy,
    avgCaptionAlignmentScore: report.aggregate.avgCaptionAlignmentScore,
    avgCaptionSpecificityScore: report.aggregate.avgCaptionSpecificityScore,
    falseClaimRate: report.aggregate.falseClaimRate,
    topFalseClaimFlags: report.aggregate.topFalseClaimFlags,
    trainingDataMutation: false,
    report: output ? `eval/results/${output.fileName}` : null,
    latest: output ? "eval/results/feedback-latest.json" : null,
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || "FEEDBACK_SUMMARY_FAILED",
    message: error.userMessage || "Feedback summary failed.",
  }, null, 2));
  process.exit(1);
}
