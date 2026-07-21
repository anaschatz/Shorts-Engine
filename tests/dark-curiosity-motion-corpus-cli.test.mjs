import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCli,
} from "../tools/dark-curiosity-motion-corpus.mjs";

const eventLoopTurn = () => new Promise((resolve) => setImmediate(resolve));

test("motion corpus doctor is offline, keyless, and permanently shadowed", async () => {
  const report = await runCli(["doctor"]);
  assert.equal(report.ready, true);
  assert.equal(report.artifactBoundEvidenceRequired, true);
  assert.equal(report.repositoryReadRequired, true);
  assert.equal(report.artifactIdManifestSchemaVersion, 2);
  assert.equal(report.humanReviewRequired, true);
  assert.equal(report.minimumDistinctStories, 10);
  assert.equal(report.productionThresholdsApproved, false);
  assert.equal(report.evidenceTrustLevel, "repository_integrity_only");
  assert.equal(report.externalNetworkRequired, false);
  assert.equal(report.apiKeyRequired, false);
});

test("motion corpus CLI rejects unsupported commands and malformed bundles safely", async () => {
  await assert.rejects(
    runCli(["publish"]),
    /Usage:/,
  );
  await assert.rejects(
    runCli(["compile"]),
    /requires --input/,
  );
  const directory = mkdtempSync(join(tmpdir(), "motion-corpus-cli-"));
  const malformed = join(directory, "malformed.json");
  try {
    writeFileSync(malformed, JSON.stringify({ schemaVersion: 2, cases: [] }));
    await assert.rejects(
      runCli(["compile", "--input", malformed]),
      /contract is invalid/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("motion corpus CLI resolves at most four cases concurrently and preserves input order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "motion-corpus-cli-pool-"));
  const manifest = join(directory, "manifest.json");
  const inputCases = Array.from({ length: 12 }, (_, index) => ({ index }));
  let inFlight = 0;
  let maximumInFlight = 0;
  try {
    writeFileSync(manifest, JSON.stringify({
      schemaVersion: 2,
      cases: inputCases,
    }));
    const result = await runCli(["compile", "--input", manifest], {
      contentArtifactRepository: {},
      async motionCalibrationCaseFromArtifacts(input) {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await eventLoopTurn();
        inFlight -= 1;
        return { resolvedIndex: input.index };
      },
      buildMotionCalibrationCorpusReport({ cases }) {
        return { resolvedOrder: cases.map((entry) => entry.resolvedIndex) };
      },
    });
    assert.equal(maximumInFlight, 4);
    assert.equal(inFlight, 0);
    assert.deepEqual(
      result.report.resolvedOrder,
      inputCases.map((entry) => entry.index),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("motion corpus CLI stops assigning cases after the first resolver error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "motion-corpus-cli-fail-stop-"));
  const manifest = join(directory, "manifest.json");
  const controls = new Map();
  const started = [];
  let reportBuilderCalled = false;
  try {
    writeFileSync(manifest, JSON.stringify({
      schemaVersion: 2,
      cases: Array.from({ length: 8 }, (_, index) => ({ index })),
    }));
    const rejected = assert.rejects(runCli(["compile", "--input", manifest], {
      contentArtifactRepository: {},
      motionCalibrationCaseFromArtifacts(input) {
        started.push(input.index);
        return new Promise((resolve, reject) => {
          controls.set(input.index, { resolve, reject });
        });
      },
      buildMotionCalibrationCorpusReport() {
        reportBuilderCalled = true;
        return {};
      },
    }), /resolver failed/);
    await eventLoopTurn();
    assert.deepEqual(started, [0, 1, 2, 3]);
    controls.get(0).reject(new Error("resolver failed"));
    await eventLoopTurn();
    for (const index of [1, 2, 3]) controls.get(index).resolve({ index });
    await rejected;
    assert.deepEqual(started, [0, 1, 2, 3]);
    assert.equal(reportBuilderCalled, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
