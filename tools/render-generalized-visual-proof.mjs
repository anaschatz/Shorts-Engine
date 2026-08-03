#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { hyperframesDoctor } from "../renderer/hyperframes/doctor.mjs";
import { runGeneralizedVisualBrowserProof } from "./lib/generalized-visual-browser-proof.mjs";

const require = createRequire(import.meta.url);
const { CASES, compileCase } = require("../tests/support/generalized-visual-step3-fixtures.cjs");

export function parseGeneralizedVisualProofArguments(argv) {
  if (argv.length === 1 && argv[0] === "--dry-run") return Object.freeze({ mode: "dry_run" });
  if (argv.length === 2 && argv[0] === "--write" && argv[1] === "--confirm-bounded-proof") {
    return Object.freeze({ mode: "write" });
  }
  throw new TypeError("Use --dry-run or --write --confirm-bounded-proof.");
}

function currentCommitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", shell: false, windowsHide: true });
  const sha = String(result.stdout || "").trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("proof_commit_unavailable");
  return sha;
}

export async function runGeneralizedVisualProofCli(argv = process.argv.slice(2)) {
  const args = parseGeneralizedVisualProofArguments(argv);
  const cases = CASES.map((definition) => compileCase(definition));
  if (args.mode === "dry_run") {
    return Object.freeze({
      mode: "dry_run",
      writesAuthorized: false,
      caseCount: cases.length,
      recipeCount: new Set(cases.flatMap((entry) => entry.compiled.visualRecipePlan.scenes.map((scene) => scene.recipeId))).size,
      browserLaunched: false,
    });
  }
  const doctor = await hyperframesDoctor();
  if (!doctor.ready) throw new Error("proof_renderer_not_ready");
  const directory = await mkdtemp(join(tmpdir(), "shortsengine-generalized-proof-"));
  try {
    const report = await runGeneralizedVisualBrowserProof({
      cases,
      commitSha: currentCommitSha(),
      chromePath: doctor.chromePath,
      runtimeVersion: doctor.runtimeVersion,
      artifactDirectory: directory,
    });
    await writeFile(join(directory, "proof.json"), `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 });
    return Object.freeze({ report, artifactsWritten: report.cases.reduce((count, entry) => count + entry.frames.length, 1) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    const cliArguments = process.argv.slice(2);
    const result = await runGeneralizedVisualProofCli(cliArguments);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const known = new Set([
      "proof_commit_unavailable",
      "proof_renderer_not_ready",
      "Use --dry-run or --write --confirm-bounded-proof.",
      "Bounded browser proof input is invalid.",
      "Proof summary is inconsistent.",
    ]);
    const reason = known.has(error?.message) ? error.message : "proof_execution_failed";
    process.stdout.write(`${JSON.stringify({ error: "GENERALIZED_VISUAL_PROOF_FAILED", reason })}\n`);
    process.exitCode = 1;
  }
}
