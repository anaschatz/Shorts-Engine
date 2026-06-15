import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";

const RENDER_STAGING_CHECKLIST = Object.freeze({
  ok: true,
  title: "ShortsEngine Live Render Staging Checklist",
  mode: "manual-setup",
  secretsIncluded: false,
  networkCalls: false,
  renderService: {
    type: "Node.js Web Service",
    branch: "main",
    buildCommand: "npm ci",
    startCommand: "npm start",
    healthCheckPath: "/health",
    autoDeployRecommendation: "off-or-controlled-until-staging-gate-is-stable",
    port: "provided-by-render",
    requiredTools: ["ffmpeg", "ffprobe"],
  },
  renderEnvironmentVariables: [
    { name: "MATCHCUTS_TRANSCRIPTION_PROVIDER", value: "mock", sensitive: false },
    { name: "MATCHCUTS_PERSISTENCE_ADAPTER", value: "sqlite", sensitive: false },
    { name: "MATCHCUTS_STORAGE_ADAPTER", value: "local-or-mock-cloud", sensitive: false },
    { name: "MATCHCUTS_RUN_REAL_CLOUD_TESTS", value: "0", sensitive: false },
  ],
  githubEnvironmentVariables: [
    { name: "SHORTSENGINE_DEPLOY_TARGET", value: "staging", sensitive: false },
    { name: "SHORTSENGINE_STAGING_DEPLOY_PROVIDER", value: "render", sensitive: false },
    { name: "SHORTSENGINE_STAGING_SERVICE_ID", value: "copy-from-render-dashboard", sensitive: false, commitValue: false },
    { name: "SHORTSENGINE_STAGING_URL", value: "https-placeholder", sensitive: false, commitValue: false },
    { name: "MATCHCUTS_TRANSCRIPTION_PROVIDER", value: "mock", sensitive: false },
    { name: "MATCHCUTS_PERSISTENCE_ADAPTER", value: "sqlite", sensitive: false },
    { name: "MATCHCUTS_STORAGE_ADAPTER", value: "local-or-mock-cloud", sensitive: false },
  ],
  githubEnvironmentSecrets: [
    { name: "SHORTSENGINE_STAGING_DEPLOY_TOKEN", value: "set-in-github-environment", sensitive: true, commitValue: false },
  ],
  liveProof: [
    "manually-dispatch-staging-workflow",
    "confirm-env-check-passed",
    "confirm-staging-check-passed",
    "confirm-render-check-passed",
    "confirm-staging-deploy-triggered-render",
    "confirm-staging-smoke-passed-public-health-url",
  ],
  rollback: [
    "set-SHORTSENGINE_STAGING_DEPLOY_PROVIDER-to-none",
    "remove-staging-url-service-id-and-deploy-token",
    "rerun-staging-workflow-readiness-only",
  ],
  limitations: [
    "render-local-filesystem-is-ephemeral-without-persistent-volume-or-object-store",
    "deployed-smoke-is-health-only-no-video-upload-or-render",
    "real-ai-provider-is-opt-in",
  ],
});

function buildRenderStagingChecklist() {
  const checklist = structuredClone(RENDER_STAGING_CHECKLIST);
  const leak = findSensitiveLeak(checklist);
  if (leak) {
    throw new Error(`Render staging checklist contains sensitive data at ${leak.path}.`);
  }
  return checklist;
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  console.log(JSON.stringify(buildRenderStagingChecklist(), null, 2));
}

export {
  RENDER_STAGING_CHECKLIST,
  buildRenderStagingChecklist,
};
