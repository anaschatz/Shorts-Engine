import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runOcrQaReviewFromFile,
  safeFailureReport,
  writeOcrQaReviewReport,
} from "./ocr-qa-review.mjs";

function inputRefFromArgs(argv = process.argv.slice(2), env = process.env) {
  const inline = argv.find((arg) => arg.startsWith("--input="));
  if (inline) return inline.slice("--input=".length);
  const index = argv.indexOf("--input");
  if (index >= 0) return argv[index + 1] || "";
  return env.SHORTSENGINE_OCR_QA_REVIEW_INPUT || "";
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    const result = runOcrQaReviewFromFile(inputRefFromArgs());
    console.log(JSON.stringify({
      status: result.status,
      passed: result.passed,
      skipped: result.skipped,
      reportPath: result.reportPath,
      latestPath: result.latestPath,
      decisionSupportLevel: result.calibration && result.calibration.decisionSupportLevel,
    }, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    const report = safeFailureReport(error);
    let paths = {};
    try {
      paths = writeOcrQaReviewReport(report);
    } catch {
      paths = {};
    }
    console.error(JSON.stringify({ ...report, ...paths }, null, 2));
    process.exitCode = 1;
  }
}

export {
  inputRefFromArgs,
};
