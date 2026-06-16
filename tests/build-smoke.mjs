import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

for (const file of [
  "index.html",
  "styles.css",
  "hardening.js",
  "app.js",
  "eval/run-eval.mjs",
  "eval/scoring.cjs",
  "demo/create-fixture.mjs",
  "demo/print-manual.mjs",
  "demo/run-browser-smoke.mjs",
  "demo/run-smoke.mjs",
  "tools/release/check-environment.mjs",
  "tools/release/check-staging-readiness.mjs",
  "tools/release/check-staging-smoke.mjs",
  "tools/release/check-release-readiness.mjs",
  "tools/release/check-remote-ci.mjs",
  "tools/release/print-github-cli-setup.mjs",
  "tools/release/verify-release-gate.mjs",
  "tools/release/write-remote-ci-proof.mjs",
  "tools/release/write-release-evidence.mjs",
  "server/analysis.cjs",
  "server/config.cjs",
  "server/app.cjs",
  "server/adapters/local-youtube-ingest-adapter.cjs",
  "server/adapters/mock-youtube-ingest-adapter.cjs",
  "server/adapters/youtube-ingest-adapter.cjs",
  "server/edit-plan.cjs",
  "server/errors.cjs",
  "server/job-worker.cjs",
  "server/jobs.cjs",
  "server/media.cjs",
  "server/youtube-ingest.cjs",
  "server/youtube-ingest-service.cjs",
  "server/release-readiness.cjs",
  "server/render-job.cjs",
  "server/render.cjs",
  "server/storage.cjs",
  "server/transcription.cjs",
]) {
  assert.equal(existsSync(file), true, `${file} should exist`);
}

execFileSync("node", ["--check", "hardening.js"], { stdio: "pipe" });
execFileSync("node", ["--check", "app.js"], { stdio: "pipe" });
execFileSync("node", ["--check", "eval/run-eval.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "eval/scoring.cjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "demo/create-fixture.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "demo/print-manual.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "demo/run-browser-smoke.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "demo/run-smoke.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "tools/release/check-environment.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "tools/release/check-staging-readiness.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "tools/release/check-staging-smoke.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "tools/release/check-release-readiness.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "tools/release/check-remote-ci.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "tools/release/print-github-cli-setup.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "tools/release/verify-release-gate.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "tools/release/write-remote-ci-proof.mjs"], { stdio: "pipe" });
execFileSync("node", ["--check", "tools/release/write-release-evidence.mjs"], { stdio: "pipe" });
for (const serverFile of [
  "server/analysis.cjs",
  "server/config.cjs",
  "server/app.cjs",
  "server/adapters/local-youtube-ingest-adapter.cjs",
  "server/adapters/mock-youtube-ingest-adapter.cjs",
  "server/adapters/youtube-ingest-adapter.cjs",
  "server/edit-plan.cjs",
  "server/errors.cjs",
  "server/job-worker.cjs",
  "server/jobs.cjs",
  "server/media.cjs",
  "server/youtube-ingest.cjs",
  "server/youtube-ingest-service.cjs",
  "server/release-readiness.cjs",
  "server/render-job.cjs",
  "server/render.cjs",
  "server/storage.cjs",
  "server/transcription.cjs",
]) {
  execFileSync("node", ["--check", serverFile], { stdio: "pipe" });
}

const html = readFileSync("index.html", "utf8");
for (const asset of ["styles.css", "hardening.js", "app.js"]) {
  assert.match(html, new RegExp(asset.replace(".", "\\.")), `${asset} should be referenced`);
}

const Core = require("../hardening.js");
assert.equal(Core.validateUploadFile({ name: "test.mp4", size: 1024, type: "video/mp4" }).ok, true);
assert.equal(Core.validateAiOutput([{ title: "Goal", caption: "GOAL" }]).ok, true);
assert.equal(Core.validateYouTubeSourceInput({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", rightsConfirmed: true }).ok, true);

console.log("Build smoke checks passed");
