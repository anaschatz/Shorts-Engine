import test from "node:test";
import assert from "node:assert/strict";

import { findSensitiveLeak } from "../demo/report-safety.mjs";
import {
  GithubCliSetupError,
  buildGithubCliSetupGuide,
  safeError,
} from "../tools/release/print-github-cli-setup.mjs";

const NOW_MS = Date.parse("2026-06-16T14:00:00.000Z");

test("GitHub CLI setup guide is deterministic documentation-only output", () => {
  const guide = buildGithubCliSetupGuide({ nowMs: NOW_MS });

  assert.equal(guide.ok, true);
  assert.equal(guide.generatedAt, "2026-06-16T14:00:00.000Z");
  assert.equal(guide.mode, "documentation-only");
  assert.equal(guide.safety.networkCalls, false);
  assert.equal(guide.safety.authStarted, false);
  assert.equal(guide.safety.remoteMutation, false);
  assert.equal(guide.safety.tokensRequested, false);
  assert.equal(guide.safety.logsDownloaded, false);
  assert.equal(guide.safety.artifactsDownloaded, false);
  assert.equal(guide.safety.secretsIncluded, false);
  assert.equal(guide.authSetup.manualOnly, true);
  assert.equal(guide.authSetup.writeAccessRequired, false);
  assert.equal(findSensitiveLeak(guide), null);
});

test("GitHub CLI setup guide includes install, auth and post-push commands", () => {
  const guideText = JSON.stringify(buildGithubCliSetupGuide({ nowMs: NOW_MS }));

  assert.match(guideText, /brew install gh/);
  assert.match(guideText, /official GitHub CLI package repository/);
  assert.match(guideText, /winget install --id GitHub\.cli/);
  assert.match(guideText, /gh auth login/);
  assert.match(guideText, /gh auth status/);
  assert.match(guideText, /npm run github:doctor/);
  assert.match(guideText, /npm run remote:ci/);
  assert.match(guideText, /npm run remote:ci:proof/);
  assert.doesNotMatch(guideText, /ghp_|github_pat_|GITHUB_TOKEN\s*=|secret set|repo edit|download-logs|view --log|artifact download/i);
});

test("GitHub CLI setup guide documents safe failure next actions", () => {
  const guide = buildGithubCliSetupGuide({ nowMs: NOW_MS });

  assert.equal(guide.errorGuidance.GITHUB_CLI_MISSING.includes("Install GitHub CLI"), true);
  assert.equal(guide.errorGuidance.GITHUB_AUTH_MISSING.includes("gh auth login"), true);
  assert.equal(guide.errorGuidance.REMOTE_CI_GH_MISSING.includes("npm run github:setup"), true);
  assert.equal(guide.errorGuidance.REMOTE_CI_GH_AUTH_MISSING.includes("gh auth login"), true);
  assert.equal(guide.errorGuidance.GITHUB_BRANCH_PROTECTION_UNKNOWN.includes("GitHub UI"), true);
  assert.equal(guide.nextAction, "install-or-authenticate-gh-then-run-github-doctor");
});

test("GitHub CLI setup safe error redacts unsafe messages", () => {
  const leaked = new GithubCliSetupError("GITHUB_SETUP_OUTPUT_UNSAFE", "/Users/example/private-state");
  const response = safeError(leaked);

  assert.equal(response.ok, false);
  assert.equal(response.code, "GITHUB_SETUP_OUTPUT_UNSAFE");
  assert.equal(response.message, "GitHub CLI setup guide failed.");
  assert.equal(response.nextAction, "inspect-setup-guide-safely");
  assert.equal(findSensitiveLeak(response), null);
});
