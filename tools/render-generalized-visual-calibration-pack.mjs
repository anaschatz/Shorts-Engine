#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { hyperframesDoctor } from "../renderer/hyperframes/doctor.mjs";
import { writeGeneralizedVisualHumanCalibrationPack } from "./lib/generalized-visual-human-calibration-pack-v1.mjs";

const require = createRequire(import.meta.url);
const { compileGeneralizedVisualCalibrationCorpus } = require("../server/pipelines/narrated-short/animation/generalized-visual-calibration-corpus.cjs");
const { createHumanCalibrationAssignment } = require("../server/pipelines/narrated-short/animation/generalized-visual-human-calibration-contract.cjs");

export const CALIBRATION_ROOT = join(tmpdir(), "shortsengine-generalized-visual-calibration-v1");
export const CALIBRATION_SEED = "generalized-visual-calibration-pack-v1.0.7";

export function parseGeneralizedVisualCalibrationArguments(argv) {
  if (argv.length === 1 && argv[0] === "--dry-run") return Object.freeze({ mode: "dry_run" });
  if (argv.length === 2 && argv[0] === "--write" && argv[1] === "--confirm-human-calibration") return Object.freeze({ mode: "write" });
  throw new TypeError("Use --dry-run or --write --confirm-human-calibration.");
}

function currentCommitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", shell: false, windowsHide: true });
  const sha = String(result.stdout || "").trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("calibration_commit_unavailable");
  return sha;
}

export async function runGeneralizedVisualCalibrationCli(argv = process.argv.slice(2)) {
  const args = parseGeneralizedVisualCalibrationArguments(argv);
  const commitSha = currentCommitSha();
  const corpus = compileGeneralizedVisualCalibrationCorpus();
  const assignment = createHumanCalibrationAssignment({ corpus, commitSha, seed: CALIBRATION_SEED });
  if (args.mode === "dry_run") {
    return Object.freeze({
      mode: "dry_run",
      writesAuthorized: false,
      caseCount: corpus.manifest.caseCount,
      sceneCount: corpus.manifest.sceneCount,
      recipeSceneCounts: corpus.manifest.recipeSceneCounts,
      semanticUncertaintyCoverage: corpus.manifest.semanticUncertaintyCoverage,
      assignmentItemCount: assignment.items.length,
      browserLaunched: false,
      humanReviewStatus: "pending",
      calibrationStatus: "insufficient_evidence",
      humanApproved: false,
      productionReady: false,
    });
  }
  const doctor = await hyperframesDoctor();
  if (!doctor.ready) throw new Error("calibration_renderer_not_ready");
  await mkdir(CALIBRATION_ROOT, { recursive: true, mode: 0o700 });
  const artifactDirectory = join(CALIBRATION_ROOT, assignment.calibrationId);
  const result = await writeGeneralizedVisualHumanCalibrationPack({
    corpus,
    commitSha,
    chromePath: doctor.chromePath,
    runtimeVersion: doctor.runtimeVersion,
    artifactDirectory,
    seed: CALIBRATION_SEED,
  });
  return Object.freeze({
    mode: "write",
    packId: result.assignment.calibrationId,
    artifactsWritten: result.artifactCount,
    report: result.report,
  });
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    process.stdout.write(`${JSON.stringify(await runGeneralizedVisualCalibrationCli())}\n`);
  } catch (error) {
    const known = new Set([
      "Use --dry-run or --write --confirm-human-calibration.",
      "calibration_commit_unavailable",
      "calibration_renderer_not_ready",
      "calibration_preview_not_visible",
      "EEXIST",
    ]);
    process.stdout.write(`${JSON.stringify({ error: "GENERALIZED_VISUAL_CALIBRATION_FAILED", reason: known.has(error?.message) || error?.code === "EEXIST" ? (error.code || error.message) : "calibration_execution_failed" })}\n`);
    process.exitCode = 1;
  }
}
