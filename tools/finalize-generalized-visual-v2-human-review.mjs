#!/usr/bin/env node

import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

import { HUMAN_REVIEW_ROOT } from "./lib/generalized-visual-v2-human-review-pack.mjs";

const require = createRequire(import.meta.url);
const {
  aggregateHumanReview,
  normalizeHumanReviewAssignment,
  normalizeHumanReviewResponse,
} = require("../server/pipelines/narrated-short/animation/generalized-visual-v2-human-review-contract.cjs");

const REVIEW_RE = /^review_[a-f0-9]{24}$/;

export function parseGeneralizedVisualV2HumanReviewFinalizeArguments(argv = []) {
  if (
    argv.length !== 3
    || argv[0] !== "--review"
    || !REVIEW_RE.test(argv[1])
    || argv[2] !== "--confirm-human-responses"
  ) throw new TypeError("Use --review review_<24 hex> --confirm-human-responses.");
  return Object.freeze({ reviewId: argv[1], reviewerFinalConfirmation: true });
}

export async function finalizeGeneralizedVisualV2HumanReview({
  reviewId,
  root = HUMAN_REVIEW_ROOT,
} = {}) {
  if (!REVIEW_RE.test(reviewId || "") || typeof root !== "string") {
    throw new TypeError("Human review finalize input is invalid.");
  }
  const directory = join(root, reviewId);
  const assignment = normalizeHumanReviewAssignment(JSON.parse(await readFile(join(directory, "assignment.json"), "utf8")));
  if (assignment.reviewId !== reviewId) throw new TypeError("Human review finalize binding is invalid.");
  const responseNames = (await readdir(join(directory, "responses")))
    .filter((name) => /^response_[a-f0-9]{24}\.json$/.test(name))
    .sort();
  const responses = [];
  for (const name of responseNames) {
    responses.push(normalizeHumanReviewResponse(
      JSON.parse(await readFile(join(directory, "responses", name), "utf8")),
      assignment,
    ));
  }
  const result = aggregateHumanReview({
    assignment,
    responses,
    reviewerFinalConfirmation: true,
  });
  const destination = join(directory, "review-result.json");
  const temporary = `${destination}.next`;
  await writeFile(temporary, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  return result;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    const args = parseGeneralizedVisualV2HumanReviewFinalizeArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await finalizeGeneralizedVisualV2HumanReview(args))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      error: "GENERALIZED_VISUAL_V2_HUMAN_REVIEW_FINALIZE_FAILED",
      reason: error instanceof TypeError || error?.code === "ENOENT" ? error.message : "human_review_finalize_failed",
    })}\n`);
    process.exitCode = 1;
  }
}
