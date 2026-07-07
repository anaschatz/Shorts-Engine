import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { safeError, writeReferenceStyleQA } from "./reference-style-qa.mjs";

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

function runCli() {
  try {
    const result = writeReferenceStyleQA();
    const summary = {
      status: result.report.status,
      passed: result.report.passed,
      reportPath: result.reportPath,
      latestPath: result.latestPath,
      outputMp4: result.report.outputMp4?.relativePath || null,
      expectedGoalCount: result.report.expectedGoalCount,
      goalCount: result.report.goalCount,
      overallWatchabilityScore: result.report.overallWatchabilityScore,
      totalDeadAirSeconds: result.report.pacing?.totalDeadAirSeconds ?? null,
      failedReasons: result.report.failedReasons,
      tuningNotes: result.report.tuningNotes,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return result.report.passed ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(safeError(error), null, 2)}\n`);
    return 1;
  }
}

if (isMainModule()) {
  process.exitCode = runCli();
}
