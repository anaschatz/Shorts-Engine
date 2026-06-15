import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";
import { checkEnvironment } from "./check-environment.mjs";
import { checkRenderStaging } from "./check-render-staging.mjs";
import { checkStagingReadiness } from "./check-staging-readiness.mjs";
import { runStagingDeploy } from "./staging-deploy.mjs";

function proofEnvironment(sourceEnv = process.env) {
  return {
    ...sourceEnv,
    SHORTSENGINE_DEPLOY_TARGET: "local",
    SHORTSENGINE_STAGING_DEPLOY_PROVIDER: "none",
    SHORTSENGINE_STAGING_SERVICE_ID: "",
    SHORTSENGINE_STAGING_URL: "",
    SHORTSENGINE_STAGING_DEPLOY_TOKEN: "",
  };
}

function assertNoSensitiveSummary(summary) {
  const leak = findSensitiveLeak(summary);
  if (leak) {
    const error = new Error("Render staging proof contains sensitive data.");
    error.code = "RENDER_PROOF_SUMMARY_LEAK";
    error.details = { leakCode: leak.code, leakPath: leak.path };
    throw error;
  }
}

async function runRenderStagingProof(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const env = proofEnvironment(options.env || process.env);
  const fetchImpl = options.fetchImpl || (async () => {
    throw new Error("Render proof must not make network calls.");
  });

  const environment = checkEnvironment({ env, nowMs });
  const staging = checkStagingReadiness({ env, nowMs });
  const render = checkRenderStaging({ env, nowMs });
  const deploy = await runStagingDeploy({ env, nowMs, fetchImpl });

  const summary = {
    ok: true,
    checkedAt: new Date(nowMs).toISOString(),
    mode: "local-render-staging-proof",
    networkCalls: false,
    deployTriggered: deploy.deployTriggered === true,
    checks: {
      environment: environment.ok === true,
      staging: staging.ok === true,
      render: render.ok === true,
      deployReadinessOnly: deploy.provider === "none" && deploy.deployTriggered === false,
    },
    commandsCovered: [
      "npm run env:check",
      "npm run staging:check",
      "npm run render:check",
      "npm run staging:deploy",
    ],
    nextManualStep: "configure-github-environment-staging-and-dispatch-staging-workflow",
  };
  assertNoSensitiveSummary(summary);
  return summary;
}

function safeError(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "RENDER_PROOF_FAILED",
    message: error && error.message ? error.message : "Render staging proof failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(await runRenderStagingProof(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  proofEnvironment,
  runRenderStagingProof,
  safeError,
};
