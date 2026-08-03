import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { hyperframesDoctor } from "../renderer/hyperframes/doctor.mjs";
import {
  normalizeGeneralizedVisualCalibrationPackReport,
  writeGeneralizedVisualHumanCalibrationPack,
} from "../tools/lib/generalized-visual-human-calibration-pack-v1.mjs";
import {
  parseGeneralizedVisualCalibrationArguments,
  runGeneralizedVisualCalibrationCli,
} from "../tools/render-generalized-visual-calibration-pack.mjs";

const require = createRequire(import.meta.url);
const { compileGeneralizedVisualCalibrationCorpus } = require("../server/pipelines/narrated-short/animation/generalized-visual-calibration-corpus.cjs");
const COMMIT = "e157e6306cf5d5ce27f959fc0295afc6b3e9aa4f";

let packPromise;
async function pack() {
  if (!packPromise) packPromise = (async () => {
    const doctor = await hyperframesDoctor();
    assert.equal(doctor.ready, true);
    const directory = await mkdtemp(join(tmpdir(), "generalized-calibration-pack-test-"));
    try {
      const result = await writeGeneralizedVisualHumanCalibrationPack({
        corpus: compileGeneralizedVisualCalibrationCorpus(),
        commitSha: COMMIT,
        chromePath: doctor.chromePath,
        runtimeVersion: doctor.runtimeVersion,
        artifactDirectory: directory,
        seed: "test-browser-pack",
      });
      return { directory, result };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  })();
  return packPromise;
}

test.after(async () => {
  if (packPromise) {
    const value = await packPromise.catch(() => null);
    if (value) await rm(value.directory, { recursive: true, force: true });
  }
});

test("calibration CLI is explicit-write gated and dry-run launches no browser", async () => {
  assert.deepEqual(parseGeneralizedVisualCalibrationArguments(["--dry-run"]), { mode: "dry_run" });
  assert.deepEqual(parseGeneralizedVisualCalibrationArguments(["--write", "--confirm-human-calibration"]), { mode: "write" });
  assert.throws(() => parseGeneralizedVisualCalibrationArguments(["--write"]), /Use --dry-run/);
  const dryRun = await runGeneralizedVisualCalibrationCli(["--dry-run"]);
  assert.equal(dryRun.caseCount, 12);
  assert.equal(dryRun.sceneCount, 36);
  assert.equal(dryRun.browserLaunched, false);
  assert.equal(dryRun.humanReviewStatus, "pending");
  assert.equal(dryRun.humanApproved, false);
  assert.equal(dryRun.productionReady, false);
});

test("real Chromium pack renders 36 animated blinded previews at desktop and mobile bounds", async () => {
  const { directory, result } = await pack();
  assert.equal(result.report.browser.externalRequestCount, 0);
  assert.deepEqual(result.report.automation, {
    desktopAnimated: true,
    mobileAnimated: true,
    keyboardReachable: true,
    silentNarratedInteraction: true,
    ariaPresent: true,
    networkIsolated: true,
    cspPresent: true,
  });
  assert.equal(result.report.previewCount, 36);
  assert.ok(result.report.coverage.every((entry) => entry.sceneCount >= 3));
  const index = await readFile(join(directory, "index.html"), "utf8");
  assert.match(index, /Blinded visual calibration/);
  assert.match(index, /aria-live="polite"/);
  assert.match(index, /Content-Security-Policy/);
  assert.doesNotMatch(index, /recipeId|compositionFamily|caseIndex|sceneIndex/);
  assert.equal(result.pendingResult.humanReviewStatus, "pending");
  assert.equal(result.pendingResult.humanApproved, false);
});

test("pack report is exact, sanitized, immutable, and cannot self-approve", async () => {
  const { result } = await pack();
  assert.deepEqual(normalizeGeneralizedVisualCalibrationPackReport(result.report), result.report);
  assert.ok(Object.isFrozen(result.report));
  assert.doesNotMatch(JSON.stringify(result.report), /\/Users\/|https?:\/\/|\.html|\.png|storage[_-]?key/i);
  for (const mutation of [
    (value) => { value.humanApproved = true; },
    (value) => { value.productionReady = true; },
    (value) => { value.sceneCount = 35; },
    (value) => { value.browser.externalRequestCount = 1; },
    (value) => { value.contentHash = "0".repeat(64); },
  ]) {
    const copy = structuredClone(result.report);
    mutation(copy);
    assert.throws(() => normalizeGeneralizedVisualCalibrationPackReport(copy));
  }
});
