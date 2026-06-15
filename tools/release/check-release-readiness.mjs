import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createReleaseReadiness } = require("../../server/release-readiness.cjs");

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function safeError(error) {
  return {
    ready: false,
    code: error && error.code ? error.code : "RELEASE_READINESS_FAILED",
    message: error && error.message ? error.message : "Release readiness check failed.",
    nextAction: "fix-release-readiness-contract",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    const result = createReleaseReadiness({ rootDir: ROOT_DIR });
    console.log(JSON.stringify(result, null, 2));
    if (result.ready !== true) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  safeError,
};
