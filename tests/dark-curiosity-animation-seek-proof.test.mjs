import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runSeekCli } from "../tools/dark-curiosity-animation-seek.mjs";

test("browser seek CLI defaults to deterministic no-mutation dry run", async () => {
  const result = await runSeekCli(["proof", "--dry-run"]);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.mutated, false);
  assert.equal(result.deterministicCompilation, true);
  assert.equal(result.seekSequence.length, 11);
  assert.equal(new Set(result.seekSequence.filter((frame, index, values) => values.indexOf(frame) !== index)).size, 5);
  assert.equal(result.adversarial.caseCount, 13);
  assert.equal(result.adversarial.passed, true);
});
test("browser seek CLI rejects unsafe fixture, unknown flags and partial confirmation", async () => {
  await assert.rejects(runSeekCli(["proof", "--fixture", "../../secret"]), /allowlisted/);
  await assert.rejects(runSeekCli(["proof", "--render"]), /requires both/);
  await assert.rejects(runSeekCli(["proof", "--yes"]), /requires both/);
  await assert.rejects(runSeekCli(["proof", "--unknown"]), /arguments are invalid/);
});

test("browser seek dry-run process creates no managed output", () => {
  const isolated = mkdtempSync(join(tmpdir(), "browser-seek-cli-test-"));
  const target = join(isolated, "data/benchmarks/dark-curiosity-animation/wow-signal-browser-seek");
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../tools/dark-curiosity-animation-seek.mjs"), "proof", "--dry-run"], { cwd: isolated, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(target), false);
  assert.doesNotMatch(result.stdout, /\/Users|narration|storageKey|api[_-]?key/i);
});
