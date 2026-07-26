#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TESTS_DIR = resolve(ROOT, "tests");
const TEST_SUFFIXES = [".test.js", ".test.mjs", ".test.cjs"];
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 45 * 60 * 1000;

function configuredTimeout() {
  const requested = Number(process.env.SHORTSENGINE_NODE_TEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(requested) || requested < 60_000 || requested > MAX_TIMEOUT_MS) {
    throw new Error(
      `SHORTSENGINE_NODE_TEST_TIMEOUT_MS must be an integer between 60000 and ${MAX_TIMEOUT_MS}`,
    );
  }
  return requested;
}

const files = readdirSync(TESTS_DIR)
  .filter((name) => TEST_SUFFIXES.some((suffix) => name.endsWith(suffix)))
  .sort()
  .map((name) => resolve(TESTS_DIR, name));

if (files.length === 0) {
  console.error("No Node test files were found.");
  process.exit(1);
}

const suiteTimeoutMs = configuredTimeout();
const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=1", ...files],
  {
    cwd: ROOT,
    env: process.env,
    shell: false,
    stdio: "inherit",
  },
);

let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  console.error(`Node test suite exceeded ${suiteTimeoutMs}ms.`);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
}, suiteTimeoutMs);
timeout.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  clearTimeout(timeout);
  console.error(`Could not start Node tests: ${error.message}`);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  clearTimeout(timeout);
  if (timedOut) process.exitCode = 124;
  else if (signal) process.exitCode = 1;
  else process.exitCode = code ?? 1;
});
