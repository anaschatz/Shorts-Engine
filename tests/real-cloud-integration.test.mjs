import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("real cloud integration script skips safely unless explicitly enabled", () => {
  const env = { ...process.env };
  delete env.MATCHCUTS_RUN_REAL_CLOUD_TESTS;
  const result = spawnSync(process.execPath, ["scripts/run-real-cloud-integration.mjs"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.skipped, true);
  assert.match(payload.reason, /not enabled/i);
  assert.doesNotMatch(result.stdout, /secret|accessKey|\/Users|\/private|storageKey/i);
});
