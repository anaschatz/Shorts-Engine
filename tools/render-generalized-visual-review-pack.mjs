#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { hyperframesDoctor } from "../renderer/hyperframes/doctor.mjs";
import { runGeneralizedVisualReviewPack } from "./lib/generalized-visual-review-pack-v1.mjs";

const require = createRequire(import.meta.url);
const { CASES, compileCase } = require("../tests/support/generalized-visual-step3-fixtures.cjs");

export function parseGeneralizedVisualReviewArguments(argv) {
  if (argv.length === 1 && argv[0] === "--dry-run") return Object.freeze({ mode: "dry_run" });
  if (argv.length === 2 && argv[0] === "--write" && argv[1] === "--confirm-bounded-review") return Object.freeze({ mode: "write" });
  throw new TypeError("Use --dry-run or --write --confirm-bounded-review.");
}

function currentCommitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", shell: false, windowsHide: true });
  const sha = String(result.stdout || "").trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("review_commit_unavailable");
  return sha;
}

export async function runGeneralizedVisualReviewCli(argv = process.argv.slice(2)) {
  const args = parseGeneralizedVisualReviewArguments(argv);
  const cases = CASES.map((definition) => compileCase(definition));
  if (args.mode === "dry_run") return Object.freeze({
    mode: "dry_run",
    writesAuthorized: false,
    caseCount: cases.length,
    sceneCount: cases.reduce((count, entry) => count + entry.compiled.visualRecipePlan.scenes.length, 0),
    browserLaunched: false,
    humanApproved: false,
    productionReady: false,
  });
  const doctor = await hyperframesDoctor();
  if (!doctor.ready) throw new Error("review_renderer_not_ready");
  const directory = await mkdtemp(join(tmpdir(), "shortsengine-generalized-review-"));
  try {
    const result = await runGeneralizedVisualReviewPack({
      cases,
      commitSha: currentCommitSha(),
      chromePath: doctor.chromePath,
      runtimeVersion: doctor.runtimeVersion,
      artifactDirectory: directory,
    });
    await writeFile(join(directory, "review.json"), `${JSON.stringify(result.report)}\n`, { flag: "wx", mode: 0o600 });
    return Object.freeze({ report: result.report, artifactsWritten: result.artifactCount + 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    const result = await runGeneralizedVisualReviewCli();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const known = new Set(["review_commit_unavailable", "review_renderer_not_ready", "Use --dry-run or --write --confirm-bounded-review.", "Bounded review-pack input is invalid."]);
    process.stdout.write(`${JSON.stringify({ error: "GENERALIZED_VISUAL_REVIEW_FAILED", reason: known.has(error?.message) ? error.message : "review_execution_failed" })}\n`);
    process.exitCode = 1;
  }
}
