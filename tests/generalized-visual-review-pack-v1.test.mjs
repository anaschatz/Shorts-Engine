import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hyperframesDoctor } from "../renderer/hyperframes/doctor.mjs";
import {
  generalizedVisualReviewReportContentHash,
  normalizeGeneralizedVisualReviewReport,
  pendingGeneralizedVisualAgentReview,
  runGeneralizedVisualReviewPack,
} from "../tools/lib/generalized-visual-review-pack-v1.mjs";
import {
  parseGeneralizedVisualReviewArguments,
  runGeneralizedVisualReviewCli,
} from "../tools/render-generalized-visual-review-pack.mjs";

const require = createRequire(import.meta.url);
const { CASES, compileCase } = require("./support/generalized-visual-step3-fixtures.cjs");
const COMMIT = "e157e6306cf5d5ce27f959fc0295afc6b3e9aa4f";
const AGENT_REVIEW = Object.freeze({
  performed: true,
  rubric: Object.freeze({ narrationAlignment: 3, focalHierarchy: 4, legibility: 4, pacing: 4, diversity: 4 }),
  issueCodes: Object.freeze(["VISUAL_NARRATION_LINK_WEAK"]),
});

let artifactDirectory;
let reviewPromise;

async function reviewPack() {
  if (!reviewPromise) reviewPromise = (async () => {
    const doctor = await hyperframesDoctor();
    assert.equal(doctor.ready, true, "a real local Chromium/Chrome runtime is required");
    artifactDirectory = await mkdtemp(join(tmpdir(), "shortsengine-perceptual-review-test-"));
    return runGeneralizedVisualReviewPack({
      cases: CASES.map((definition) => compileCase(definition)),
      commitSha: COMMIT,
      chromePath: doctor.chromePath,
      runtimeVersion: doctor.runtimeVersion,
      artifactDirectory,
      agentVisualReview: AGENT_REVIEW,
    });
  })();
  return reviewPromise;
}

after(async () => {
  if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
});

test("real Chromium review pack measures three cases, nine scenes, and 45 phase frames", async () => {
  const result = await reviewPack();
  const { report } = result;
  assert.equal(result.artifactCount, 57);
  assert.equal(report.cases.length, 3);
  assert.equal(report.cases.reduce((count, entry) => count + entry.scenes.length, 0), 9);
  assert.equal(report.cases.flatMap((entry) => entry.scenes.flatMap((scene) => scene.frames)).length, 45);
  assert.equal(new Set(report.cases.flatMap((entry) => entry.recipeIds)).size, 8);
  assert.equal(report.summary.automatedPassed, true);
  assert.equal(report.summary.agentReviewComplete, true);
  assert.equal(report.summary.provisionalPassed, true);
  assert.deepEqual(report.agent_visual_review, AGENT_REVIEW);
  assert.equal(report.humanApproved, false);
  assert.equal(report.productionReady, false);
  for (const entry of report.cases) {
    assert.ok(Object.values(entry.gates).every(Boolean));
    assert.ok(entry.scenes.every((scene) => scene.passed && scene.frames.length === 5));
    assert.ok(entry.scenes.every((scene) => scene.metrics.minimumFontSize >= 18));
    assert.ok(entry.scenes.every((scene) => scene.metrics.minimumContrastRatio >= 4.5));
  }
});

test("contact sheets are bounded PNGs and never enter the report", async () => {
  const result = await reviewPack();
  assert.equal(result.contactSheetPaths.length, 3);
  assert.doesNotMatch(JSON.stringify(result.report), /contact-sheet-|\.png|\/private\/|\/Users\//);
  for (const path of result.contactSheetPaths) {
    const png = await readFile(path);
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(png.readUInt32BE(16), 1080);
    assert.equal(png.readUInt32BE(20), 1152);
  }
});

test("review report is exact, sanitized, immutable, and content-hash bound", async () => {
  const { report } = await reviewPack();
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.cases[0].scenes[0].metrics), true);
  assert.equal(generalizedVisualReviewReportContentHash(report), report.contentHash);
  assert.doesNotMatch(JSON.stringify(report), /https?:\/\/|file:|\/Users\/|authorization|bearer|token|storage[_-]?key/i);

  const summaryMutation = structuredClone(report);
  summaryMutation.summary.provisionalPassed = false;
  assert.throws(() => normalizeGeneralizedVisualReviewReport(summaryMutation), /summary is inconsistent/);
  const metricMutation = structuredClone(report);
  metricMutation.cases[0].scenes[0].metrics.primaryVisible = "yes";
  assert.throws(() => normalizeGeneralizedVisualReviewReport(metricMutation), /metric boolean is invalid/);
  const issueMutation = structuredClone(report);
  issueMutation.cases[0].scenes[0].issueCodes = ["ARBITRARY_ISSUE"];
  assert.throws(() => normalizeGeneralizedVisualReviewReport(issueMutation), /unsupported/);
  const scenePassMutation = structuredClone(report);
  scenePassMutation.cases[0].scenes[0].passed = false;
  assert.throws(() => normalizeGeneralizedVisualReviewReport(scenePassMutation), /scene pass result is inconsistent/);
  const gateMutation = structuredClone(report);
  gateMutation.cases[0].gates.hierarchy = false;
  assert.throws(() => normalizeGeneralizedVisualReviewReport(gateMutation), /gates are inconsistent/);
  const extra = structuredClone(report);
  extra.localPath = "/private/review";
  assert.throws(() => normalizeGeneralizedVisualReviewReport(extra), /unsupported field/);
  const hashMutation = structuredClone(report);
  hashMutation.contentHash = "0".repeat(64);
  assert.throws(() => normalizeGeneralizedVisualReviewReport(hashMutation), /content hash is invalid/);
});

test("pending agent review is explicit and cannot imply approval", () => {
  const pending = pendingGeneralizedVisualAgentReview();
  assert.deepEqual(pending, {
    performed: false,
    rubric: { narrationAlignment: 0, focalHierarchy: 0, legibility: 0, pacing: 0, diversity: 0 },
    issueCodes: ["AGENT_REVIEW_PENDING"],
  });
  assert.equal(Object.isFrozen(pending), true);
});

test("review CLI is write-gated and dry-run performs no browser or file work", async () => {
  assert.deepEqual(parseGeneralizedVisualReviewArguments(["--dry-run"]), { mode: "dry_run" });
  assert.deepEqual(parseGeneralizedVisualReviewArguments(["--write", "--confirm-bounded-review"]), { mode: "write" });
  for (const args of [[], ["--write"], ["--confirm-bounded-review"], ["--dry-run", "extra"]]) {
    assert.throws(() => parseGeneralizedVisualReviewArguments(args), /Use --dry-run/);
  }
  assert.deepEqual(await runGeneralizedVisualReviewCli(["--dry-run"]), {
    mode: "dry_run",
    writesAuthorized: false,
    caseCount: 3,
    sceneCount: 9,
    browserLaunched: false,
    humanApproved: false,
    productionReady: false,
  });
});

test("production QA modules contain no fixture or story-ID branches", () => {
  const sources = [
    "renderer/hyperframes/generalized-visual-perceptual-audit-v1.mjs",
    "renderer/hyperframes/generalized-visual-review-overlay-v1.mjs",
    "tools/lib/generalized-visual-review-pack-v1.mjs",
  ].map((path) => readFileSync(resolve(path), "utf8")).join("\n");
  assert.doesNotMatch(sources, /001_wow|002_gps|003_baychimo|fixtureId|storyId/i);
});
