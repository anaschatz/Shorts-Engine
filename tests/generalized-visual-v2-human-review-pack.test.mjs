import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import {
  normalizeGeneralizedVisualV2HumanReviewPackReport,
  prepareGeneralizedVisualV2HumanReviewPack,
  writeGeneralizedVisualV2HumanReviewPack,
} from "../tools/lib/generalized-visual-v2-human-review-pack.mjs";
import {
  parseGeneralizedVisualV2HumanReviewPackArguments,
} from "../tools/render-generalized-visual-v2-human-review-pack.mjs";
import {
  createGeneralizedVisualV2HumanReviewServer,
  parseGeneralizedVisualV2HumanReviewServerArguments,
} from "../tools/serve-generalized-visual-v2-human-review.mjs";
import {
  finalizeGeneralizedVisualV2HumanReview,
  parseGeneralizedVisualV2HumanReviewFinalizeArguments,
} from "../tools/finalize-generalized-visual-v2-human-review.mjs";

const require = createRequire(import.meta.url);
const {
  BOOLEAN_KEYS,
  RUBRIC_KEYS,
  publicBlindedAssignment,
} = require("../server/pipelines/narrated-short/animation/generalized-visual-v2-human-review-contract.cjs");

const COMMIT = "e157e6306cf5d5ce27f959fc0295afc6b3e9aa4f";

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function questions(storyIndex) {
  return [0, 1, 2, 3].map((questionIndex) => ({
    questionId: `question_${storyIndex}_${questionIndex}`,
    kind: questionIndex < 3 ? "factual" : "uncertainty",
    prompt: `Which bounded outcome was shown in event ${questionIndex + 1}?`,
    options: [0, 1, 2].map((optionIndex) => ({
      optionId: `option_${questionIndex}_${optionIndex}`,
      label: `Outcome ${optionIndex + 1}`,
    })),
    expectedOptionId: `option_${questionIndex}_0`,
  }));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gv2-human-review-pack-test-"));
  const styleHash = sha("one-locked-style");
  const stories = [];
  for (let index = 0; index < 3; index += 1) {
    const storyId = `story_${index}`;
    const media = Buffer.from(`00000020ftypisom-bounded-video-${index}`);
    const mediaPath = join(root, `${storyId}.mp4`);
    const reportPath = join(root, `${storyId}-report.json`);
    await writeFile(mediaPath, media);
    const report = {
      schemaVersion: 1,
      proofProfile: "generalized_visual_composition_v2_video_proof",
      storyId,
      publishable: false,
      humanReviewStatus: "pending",
      style: { contentHash: styleHash },
      fingerprints: {
        program: sha(`program-${index}`),
        composition: sha(`composition-${index}`),
      },
      media: { sha256: sha(media), bytes: media.byteLength },
      gates: {
        technical: "passed",
        deterministicPlan: "passed",
        noRemoteAssets: "passed",
        persistentTitleOcr: "passed",
        semanticComposition: "passed",
        humanPerceptual: "pending",
      },
    };
    await writeFile(reportPath, `${JSON.stringify(report)}\n`);
    stories.push({ storyId, mediaPath, reportPath, questions: questions(index) });
  }
  const comparisonPath = join(root, "comparison.json");
  await writeFile(comparisonPath, `${JSON.stringify({
    schemaVersion: 1,
    proofProfile: "generalized_visual_composition_v2_cross_story_comparison",
    publishable: false,
    humanReviewStatus: "pending",
    stories: stories.map((entry) => entry.storyId),
    sameStyleHash: true,
    distinctProgramHashes: true,
    crossStorySceneFingerprintOverlap: [],
    repetitionReport: { passed: true },
    passed: true,
  })}\n`);
  return {
    root,
    input: {
      schemaVersion: 1,
      profile: "generalized_visual_v2_human_review_input_v1",
      comparisonPath,
      stories,
    },
  };
}

function rawResponse(assignment, item, reviewer = "reviewer_browser_test") {
  return {
    reviewerSessionId: reviewer,
    itemId: item.itemId,
    source: "human",
    playback: { completed: true, normalSpeed: true, replayCount: 0 },
    answers: Object.fromEntries(item.questions.map((question) => [
      question.questionId,
      question.expectedOptionId,
    ])),
    rubric: Object.fromEntries(RUBRIC_KEYS.map((key) => [key, 5])),
    booleans: Object.fromEntries(BOOLEAN_KEYS.map((key) => [
      key,
      key !== "wouldRequireManualEdit",
    ])),
    issueCodes: [],
    reviewerConfirmed: true,
  };
}

test("CLI surfaces remain explicit-write and explicit-human-finalize gated", () => {
  assert.deepEqual(
    parseGeneralizedVisualV2HumanReviewPackArguments(["--input", "input.json", "--dry-run"]),
    { inputPath: join(process.cwd(), "input.json"), mode: "dry_run" },
  );
  assert.equal(
    parseGeneralizedVisualV2HumanReviewPackArguments([
      "--input", "input.json", "--write", "--confirm-human-review-pack",
    ]).mode,
    "write",
  );
  assert.throws(() => parseGeneralizedVisualV2HumanReviewPackArguments(["--input", "input.json", "--write"]));
  assert.deepEqual(
    parseGeneralizedVisualV2HumanReviewFinalizeArguments([
      "--review", "review_0123456789abcdef01234567", "--confirm-human-responses",
    ]),
    { reviewId: "review_0123456789abcdef01234567", reviewerFinalConfirmation: true },
  );
  assert.deepEqual(
    parseGeneralizedVisualV2HumanReviewServerArguments([
      "--review", "review_0123456789abcdef01234567", "--port", "4174",
    ]),
    { reviewId: "review_0123456789abcdef01234567", port: 4174 },
  );
});

test("pack is three-video, hash-bound, blinded, strict-CSP, and pending", async () => {
  const value = await fixture();
  try {
    const prepared = await prepareGeneralizedVisualV2HumanReviewPack({
      input: value.input,
      commitSha: COMMIT,
      seed: "pack-test-seed",
    });
    const artifactDirectory = join(value.root, prepared.assignment.reviewId);
    const result = await writeGeneralizedVisualV2HumanReviewPack({
      input: value.input,
      commitSha: COMMIT,
      artifactDirectory,
      seed: "pack-test-seed",
    });
    assert.equal(result.assignment.items.length, 3);
    assert.equal(result.assignment.requiredReviewerCount, 5);
    assert.deepEqual(normalizeGeneralizedVisualV2HumanReviewPackReport(result.report), result.report);
    assert.equal(result.report.humanReviewStatus, "pending");
    assert.equal(result.report.humanApproved, false);
    assert.equal(result.report.publishable, false);
    assert.equal(result.report.productionReady, false);
    assert.equal(result.pendingResult.completeHumanReviewerCount, 0);

    const index = await readFile(join(artifactDirectory, "index.html"), "utf8");
    assert.match(index, /media-src 'self'/);
    assert.match(index, /frame-src 'none'/);
    assert.match(index, /playbackRate=1/);
    assert.match(index, /questions appear only after playback completes/i);
    assert.doesNotMatch(index, /storyId|programHash|compositionHash|expectedOptionId|story_[0-2]/);
    const privateAssignment = JSON.parse(await readFile(join(artifactDirectory, "assignment.json"), "utf8"));
    assert.match(JSON.stringify(privateAssignment), /storyId/);
    assert.match(JSON.stringify(privateAssignment), /expectedOptionId/);
    for (const item of result.assignment.items) {
      assert.equal(sha(await readFile(join(artifactDirectory, item.mediaRef))), item.mediaHash);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("loopback server exposes only index and same-origin hashed MP4 with range support", async () => {
  const value = await fixture();
  let active;
  try {
    const prepared = await prepareGeneralizedVisualV2HumanReviewPack({
      input: value.input,
      commitSha: COMMIT,
      seed: "server-test-seed",
    });
    const packRoot = join(value.root, "packs");
    const artifactDirectory = join(packRoot, prepared.assignment.reviewId);
    const result = await writeGeneralizedVisualV2HumanReviewPack({
      input: value.input,
      commitSha: COMMIT,
      artifactDirectory,
      seed: "server-test-seed",
    });
    active = await createGeneralizedVisualV2HumanReviewServer({
      reviewId: result.assignment.reviewId,
      port: 0,
      root: packRoot,
    });
    const indexResponse = await fetch(active.url);
    assert.equal(indexResponse.status, 200);
    assert.match(indexResponse.headers.get("content-security-policy"), /media-src 'self'/);
    assert.equal(indexResponse.headers.get("x-frame-options"), "DENY");
    assert.match(await indexResponse.text(), /Blinded video review/);

    const privateResponse = await fetch(new URL("assignment.json", active.url));
    assert.equal(privateResponse.status, 404);
    const publicAssignment = publicBlindedAssignment(result.assignment);
    const mediaResponse = await fetch(new URL(publicAssignment.items[0].mediaRef, active.url), {
      headers: { Range: "bytes=0-7" },
    });
    assert.equal(mediaResponse.status, 206);
    assert.equal(mediaResponse.headers.get("content-type"), "video/mp4");
    assert.equal((await mediaResponse.arrayBuffer()).byteLength, 8);

    const raw = rawResponse(result.assignment, result.assignment.items[0]);
    const forbidden = await fetch(new URL("api/responses", active.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(raw),
    });
    assert.equal(forbidden.status, 403);
    const headers = {
      "Content-Type": "application/json",
      "X-Human-Review-Assignment": result.assignment.contentHash,
    };
    const created = await fetch(new URL("api/responses", active.url), {
      method: "POST",
      headers,
      body: JSON.stringify(raw),
    });
    assert.equal(created.status, 201);
    const duplicate = await fetch(new URL("api/responses", active.url), {
      method: "POST",
      headers,
      body: JSON.stringify(raw),
    });
    assert.equal(duplicate.status, 409);

    const finalized = await finalizeGeneralizedVisualV2HumanReview({
      reviewId: result.assignment.reviewId,
      root: packRoot,
    });
    assert.equal(finalized.humanReviewStatus, "partial");
    assert.equal(finalized.completeHumanReviewerCount, 0);
    assert.equal(finalized.humanApproved, false);
    assert.equal(finalized.productionReady, false);
  } finally {
    if (active) await new Promise((resolvePromise) => active.server.close(resolvePromise));
    await rm(value.root, { recursive: true, force: true });
  }
});
