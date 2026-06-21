import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_PROOF_REPORT,
  DEFAULT_REFERENCE_FIXTURE,
  DEFAULT_RESULTS_DIR,
  DEFAULT_THRESHOLD,
  runReferenceComparison,
  safeError,
} = require("./reference-comparison.cjs");

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.split("=");
  if (key && key.startsWith("--")) args.set(key.replace(/^--/, ""), value || "true");
}

try {
  const { report, output } = runReferenceComparison({
    rootDir: process.cwd(),
    proofReport: args.get("proof") || args.get("report") || DEFAULT_PROOF_REPORT,
    fixturePath: args.get("fixture") || DEFAULT_REFERENCE_FIXTURE,
    resultsDir: args.get("results") || DEFAULT_RESULTS_DIR,
    minAggregateScore: Number(args.get("threshold") || DEFAULT_THRESHOLD),
  });
  const summary = {
    passed: report.passed,
    status: report.status,
    aggregateScore: report.metrics.aggregateScore,
    referenceSimilarityScore: report.metrics.referenceSimilarityScore,
    validGoalRecall: report.metrics.validGoalRecall,
    replayOnlySegmentCount: report.metrics.replayOnlySegmentCount,
    phaseCoverageScore: report.metrics.phaseCoverageScore,
    cropSafetyScore: report.metrics.cropSafetyScore,
    captionActionAlignment: report.metrics.captionActionAlignment,
    transitionPolishScore: report.metrics.transitionPolishScore,
    cutSmoothnessScore: report.metrics.cutSmoothnessScore,
    warningCount: report.warnings.length,
    failedCriteria: report.failedCriteria,
    report: output ? output.reportPath : null,
    latest: output ? output.latestPath : null,
    html: output ? output.htmlLatestPath : null,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!report.passed) process.exit(1);
} catch (error) {
  console.error(JSON.stringify(safeError(error), null, 2));
  process.exit(1);
}
