#!/usr/bin/env node

import { readFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  HUMAN_REVIEW_ROOT,
  prepareGeneralizedVisualV2HumanReviewPack,
  resolveHumanReviewInputPaths,
  writeGeneralizedVisualV2HumanReviewPack,
} from "./lib/generalized-visual-v2-human-review-pack.mjs";

export const HUMAN_REVIEW_SEED = "generalized-visual-v2-full-video-human-review-v1";

export function parseGeneralizedVisualV2HumanReviewPackArguments(argv = []) {
  if (argv.length === 3 && argv[0] === "--input" && argv[2] === "--dry-run") {
    return Object.freeze({ inputPath: resolve(argv[1]), mode: "dry_run" });
  }
  if (
    argv.length === 4
    && argv[0] === "--input"
    && argv[2] === "--write"
    && argv[3] === "--confirm-human-review-pack"
  ) return Object.freeze({ inputPath: resolve(argv[1]), mode: "write" });
  throw new TypeError("Use --input <manifest.json> --dry-run or --input <manifest.json> --write --confirm-human-review-pack.");
}

function currentCommitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const sha = String(result.stdout || "").trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("human_review_commit_unavailable");
  return sha;
}

async function loadInput(path) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return resolveHumanReviewInputPaths(raw, path);
}

export async function runGeneralizedVisualV2HumanReviewPackCli(argv = process.argv.slice(2)) {
  const args = parseGeneralizedVisualV2HumanReviewPackArguments(argv);
  const input = await loadInput(args.inputPath);
  const commitSha = currentCommitSha();
  const prepared = await prepareGeneralizedVisualV2HumanReviewPack({
    input,
    commitSha,
    seed: HUMAN_REVIEW_SEED,
  });
  if (args.mode === "dry_run") {
    return Object.freeze({
      mode: "dry_run",
      writesAuthorized: false,
      reviewId: prepared.assignment.reviewId,
      itemCount: prepared.assignment.items.length,
      requiredReviewerCount: prepared.assignment.requiredReviewerCount,
      comparisonHash: prepared.assignment.comparisonHash,
      humanReviewStatus: "pending",
      humanApproved: false,
      publishable: false,
      productionReady: false,
    });
  }
  await mkdir(HUMAN_REVIEW_ROOT, { recursive: true, mode: 0o700 });
  const artifactDirectory = resolve(HUMAN_REVIEW_ROOT, prepared.assignment.reviewId);
  await mkdir(artifactDirectory, { mode: 0o700 });
  const result = await writeGeneralizedVisualV2HumanReviewPack({
    input,
    commitSha,
    artifactDirectory,
    seed: HUMAN_REVIEW_SEED,
    prepared,
  });
  return Object.freeze({
    mode: "write",
    reviewId: result.assignment.reviewId,
    artifactCount: result.artifactCount,
    report: result.report,
  });
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    process.stdout.write(`${JSON.stringify(await runGeneralizedVisualV2HumanReviewPackCli())}\n`);
  } catch (error) {
    const known = error instanceof TypeError || ["EEXIST", "ENOENT"].includes(error?.code);
    process.stdout.write(`${JSON.stringify({
      error: "GENERALIZED_VISUAL_V2_HUMAN_REVIEW_PACK_FAILED",
      reason: known ? (error.code || error.message) : "human_review_pack_execution_failed",
    })}\n`);
    process.exitCode = 1;
  }
}
