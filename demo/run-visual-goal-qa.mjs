#!/usr/bin/env node
import { writeVisualGoalQA, safeError } from "./visual-goal-qa.mjs";

try {
  const result = writeVisualGoalQA();
  console.log(JSON.stringify({
    status: result.report.status,
    passed: result.report.passed,
    reportPath: result.reportPath,
    latestPath: result.latestPath,
    contactSheetPath: result.contactSheetPath,
    goalCount: result.report.goalCount,
    expectedGoalCount: result.report.expectedGoalCount,
    overallHumanWatchabilityScore: result.report.rubric.overallHumanWatchabilityScore,
    failedReasons: result.report.failedReasons,
  }, null, 2));
  if (result.report.passed !== true) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify(safeError(error), null, 2));
  process.exitCode = 1;
}
