import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { hyperframesDoctor } from "../renderer/hyperframes/doctor.mjs";
import {
  normalizeGeneralizedVisualBrowserProof,
  runGeneralizedVisualBrowserProof,
} from "../tools/lib/generalized-visual-browser-proof.mjs";
import {
  parseGeneralizedVisualProofArguments,
  runGeneralizedVisualProofCli,
} from "../tools/render-generalized-visual-proof.mjs";

const require = createRequire(import.meta.url);
const { CASES, compileCase } = require("./support/generalized-visual-step3-fixtures.cjs");

let proofPromise;
async function proof() {
  if (!proofPromise) proofPromise = (async () => {
    const doctor = await hyperframesDoctor();
    assert.equal(doctor.ready, true, "a real local Chromium/Chrome runtime is required");
    const commitSha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    return runGeneralizedVisualBrowserProof({
      cases: CASES.map((definition) => compileCase(definition)),
      commitSha,
      chromePath: doctor.chromePath,
      runtimeVersion: doctor.runtimeVersion,
    });
  })();
  return proofPromise;
}

test("real Chromium proof covers three stories, eight recipes, and five phases per scene", async () => {
  const report = await proof();
  assert.equal(report.summary.passed, true);
  assert.equal(report.summary.allRecipesCovered, true);
  assert.deepEqual(report.canvas, { width: 1080, height: 1920 });
  assert.equal(report.cases.length, 3);
  assert.equal(report.cases.reduce((count, entry) => count + entry.frames.length, 0), 45);
  assert.equal(new Set(report.cases.flatMap((entry) => entry.recipeIds)).size, 8);
  for (const entry of report.cases) {
    assert.deepEqual(new Set(entry.frames.map((frame) => frame.phaseId)), new Set(["enter", "develop", "reveal", "resolve", "hold"]));
    assert.ok(Object.values(entry.gates).every(Boolean));
    assert.ok(entry.frames.every((frame) => frame.activeMotionCount <= 2));
  }
});

test("browser proof report is strict, sanitized, immutable, and hash bound", async () => {
  const report = await proof();
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /https?:\/\/|file:|\/Users\/|authorization|bearer|storage[_-]?key/i);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.cases[0].frames), true);
  const tampered = structuredClone(report);
  tampered.summary.passed = false;
  assert.throws(() => normalizeGeneralizedVisualBrowserProof(tampered), /summary is inconsistent/);
  const extra = structuredClone(report);
  extra.localPath = "/private/proof";
  assert.throws(() => normalizeGeneralizedVisualBrowserProof(extra), /unsupported field/);
});

test("proof CLI is write-gated and dry-run does not launch a browser", async () => {
  assert.deepEqual(parseGeneralizedVisualProofArguments(["--dry-run"]), { mode: "dry_run" });
  assert.deepEqual(parseGeneralizedVisualProofArguments(["--write", "--confirm-bounded-proof"]), { mode: "write" });
  for (const args of [[], ["--write"], ["--confirm-bounded-proof"], ["--dry-run", "extra"]]) {
    assert.throws(() => parseGeneralizedVisualProofArguments(args), /Use --dry-run/);
  }
  assert.deepEqual(await runGeneralizedVisualProofCli(["--dry-run"]), {
    mode: "dry_run",
    writesAuthorized: false,
    caseCount: 3,
    recipeCount: 8,
    browserLaunched: false,
  });
});
