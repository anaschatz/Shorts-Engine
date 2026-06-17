import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { registerReviewDraft } = require("./review-registration.cjs");

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, ...rest] = arg.split("=");
  if (key && key.startsWith("--")) args.set(key.replace(/^--/, ""), rest.join("=") || "true");
}

try {
  const result = registerReviewDraft({
    projectId: args.get("project") || args.get("projectId"),
    jobId: args.get("job") || args.get("jobId"),
    exportId: args.get("export") || args.get("exportId"),
    rightsConfirmed: args.get("rights-confirmed") || args.get("rightsConfirmed"),
    reference: args.get("reference"),
    renderRecord: args.get("render-record") || args.get("renderRecord"),
    projectRecord: args.get("project-record") || args.get("projectRecord"),
    outputDir: args.get("output") || args.get("outputDir"),
    reviewerNotes: args.get("reviewer-notes") || args.get("reviewerNotes"),
    title: args.get("title"),
  });
  const summary = {
    ok: true,
    passed: true,
    status: "registered",
    draft: result.output && result.output.draftPath,
    latest: result.output && result.output.latestPath,
    compareCommand: result.compareCommand,
    comparisonPreview: {
      passed: result.comparisonPreview.passed,
      status: result.comparisonPreview.status,
      overallScore: result.comparisonPreview.metrics.overallScore,
      failedCriteria: result.comparisonPreview.failedCriteria,
      failedCases: result.comparisonPreview.failedCases,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || "REVIEW_REGISTRATION_FAILED",
    message: error.userMessage || "Review registration failed.",
    nextAction: "Confirm the job completed successfully, rights are confirmed, and local generated/source artifacts still exist.",
  }, null, 2));
  process.exit(1);
}
