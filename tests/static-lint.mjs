import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const app = readFileSync("app.js", "utf8");
const serverApp = readFileSync("server/app.cjs", "utf8");
const css = readFileSync("styles.css", "utf8");
const fixtureScript = readFileSync("demo/create-fixture.mjs", "utf8");
const browserSmoke = readFileSync("demo/run-browser-smoke.mjs", "utf8");
const playwrightSmoke = readFileSync("demo/run-playwright-smoke.mjs", "utf8");
const demoSmoke = readFileSync("demo/run-smoke.mjs", "utf8");
const reportSafety = readFileSync("demo/report-safety.mjs", "utf8");
const ciReportValidator = readFileSync("demo/validate-ci-reports.mjs", "utf8");
const envChecker = readFileSync("tools/release/check-environment.mjs", "utf8");
const stagingReadiness = readFileSync("tools/release/check-staging-readiness.mjs", "utf8");
const stagingSmoke = readFileSync("tools/release/check-staging-smoke.mjs", "utf8");
const releaseGateVerifier = readFileSync("tools/release/verify-release-gate.mjs", "utf8");
const releaseEvidenceWriter = readFileSync("tools/release/write-release-evidence.mjs", "utf8");
const envDocs = readFileSync("docs/ENVIRONMENT.md", "utf8");
const envExample = readFileSync(".env.example", "utf8");
const stagingDocs = readFileSync("docs/STAGING_DEPLOYMENT.md", "utf8");
const manualDocs = readFileSync("demo/MANUAL_TESTING.md", "utf8");
const ciDocs = readFileSync("demo/CI.md", "utf8");
const releaseDocs = readFileSync("docs/RELEASE.md", "utf8");
const githubWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const stagingWorkflow = readFileSync(".github/workflows/staging.yml", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assert.match(html, /Content-Security-Policy/, "index.html should include a CSP meta tag");
assert.match(html, /ShortsEngine/, "index.html should use the current user-facing product name");
assert.match(html, /hardening\.js/, "index.html should load the hardening layer before app.js");
assert.match(html, /id="rightsCheckbox"/, "rights consent checkbox must be explicit");
assert.match(html, /id="errorPanel"/, "global error panel must exist");
assert.match(html, /id="downloadLink"[^>]*hidden/, "download link should start hidden");
assert.match(html, /data-testid="video-upload-input"/, "upload input needs a stable browser test selector");
assert.match(html, /data-testid="rights-checkbox"/, "rights checkbox needs a stable browser test selector");
assert.match(html, /data-testid="generate-button"/, "generate button needs a stable browser test selector");
assert.match(html, /data-testid="cancel-job-button"/, "cancel button needs a stable browser test selector");
assert.match(html, /data-testid="export-button"[^>]*disabled/, "export button should start disabled and selectable");
assert.match(html, /data-testid="download-link"[^>]*hidden/, "download link should start hidden and selectable");
assert.match(html, /data-testid="error-panel"/, "error panel needs a stable browser test selector");
assert.match(html, /data-testid="job-progress-bar"/, "progress bar needs a stable browser test selector");
assert.match(html, /data-testid="project-status"/, "project status needs a stable browser test selector");
assert.match(html, /data-export-target="tiktok" disabled/, "export targets should start disabled");
assert.match(html, /accept="\.mp4,\.mov,\.webm,video\/mp4,video\/quicktime,video\/webm"/);

assert.doesNotMatch(app, /\.innerHTML\s*=/, "app.js should not assign raw innerHTML");
assert.doesNotMatch(app, /insertAdjacentHTML/, "app.js should not inject HTML strings");
assert.match(app, /validateUploadFile/, "app.js should validate uploads before preview");
assert.match(app, /validateVideoSignature/, "app.js should inspect media signatures");
assert.match(app, /validateVideoDuration/, "app.js should validate media duration");
assert.match(app, /createIdempotencyKey/, "app.js should use idempotency keys");
assert.match(app, /createRateLimiter/, "app.js should use rate limits");
assert.match(app, /function resetRenderState/, "app.js should clear stale render state on new uploads");
assert.match(app, /function formatJobStep/, "app.js should show friendly analysis progress steps");
assert.match(app, /momentsFromCandidatePlans/, "app.js should render generated candidate moments");
assert.match(app, /validateCompletedJobForExport/, "app.js should validate completed jobs before enabling downloads");
assert.match(app, /EXPORT_NOT_READY/, "app.js should fail closed when download/export is not ready");

assert.match(serverApp, /createLocalJobWorker/, "server should use the durable local worker abstraction");
assert.match(serverApp, /createLocalJobQueue/, "server should use the queue contract adapter boundary");
assert.match(serverApp, /createWorkerSupervisor/, "server should use the worker supervisor abstraction");
assert.match(serverApp, /jobQueue\.enqueue/, "server routes should enqueue through the queue contract boundary");
assert.match(serverApp, /workerSupervisor\.enqueue/, "server routes should delegate render orchestration through the worker supervisor");
assert.doesNotMatch(serverApp, /function renderPipeline|async function renderPipeline/, "server/app.cjs should not own the render pipeline");

assert.match(fixtureScript, /testsrc2/, "demo fixture should be generated deterministically");
assert.match(fixtureScript, /sine=frequency=880/, "demo fixture should include a simple audio track for transcription fallback coverage");
assert.match(demoSmoke, /demo\/results\/latest\.json|RESULTS_DIR/, "demo smoke should write a report");
assert.match(demoSmoke, /invalid_upload_rejected/, "demo smoke should verify invalid upload rejection");
assert.match(demoSmoke, /download_returns_rendered_video/, "demo smoke should verify rendered export download");
assert.match(demoSmoke, /hasSensitiveLeak/, "demo smoke should guard public outputs against leaks");
assert.match(demoSmoke, /findSensitiveLeak/, "demo smoke should report safe leak metadata when fail-closed");
assert.match(browserSmoke, /browser-latest\.json|BROWSER_LATEST/, "browser smoke should write a browser latest report");
assert.match(browserSmoke, /REQUIRED_TEST_IDS/, "browser smoke should assert stable selectors");
assert.match(browserSmoke, /manualChecklistRequired/, "browser smoke should document dependency-light fallback");
assert.match(browserSmoke, /api_demo_smoke_passed/, "browser smoke should include the API E2E fallback");
assert.match(browserSmoke, /findSensitiveLeak/, "browser smoke should fail closed with safe leak metadata");
assert.match(packageJson, /"demo:browser:e2e": "node demo\/run-playwright-smoke\.mjs"/, "package should expose the Playwright browser E2E script");
assert.match(packageJson, /"demo:browser:install": "playwright install chromium"/, "package should expose a Playwright Chromium install helper");
assert.match(packageJson, /"ci:reports": "node demo\/validate-ci-reports\.mjs"/, "package should expose CI report validation");
assert.match(packageJson, /"env:check": "node tools\/release\/check-environment\.mjs"/, "package should expose staging environment validation");
assert.match(packageJson, /"staging:check": "node tools\/release\/check-staging-readiness\.mjs"/, "package should expose staging readiness validation");
assert.match(packageJson, /"staging:smoke": "node tools\/release\/check-staging-smoke\.mjs"/, "package should expose deployed staging smoke");
assert.match(packageJson, /"release:check": "node tools\/release\/verify-release-gate\.mjs"/, "package should expose release gate verification");
assert.match(packageJson, /"release:evidence": "node tools\/release\/write-release-evidence\.mjs"/, "package should expose release evidence generation");
assert.match(packageJson, /"playwright"/, "Playwright should be a scoped dev dependency for browser E2E");
assert.match(playwrightSmoke, /setInputFiles/, "Playwright smoke should upload the fixture through the browser context");
assert.match(playwrightSmoke, /getByTestId\("download-link"\)/, "Playwright smoke should assert download UI state by stable selector");
assert.match(playwrightSmoke, /download_endpoint_returns_video/, "Playwright smoke should verify the rendered MP4 endpoint");
assert.match(playwrightSmoke, /findSensitiveLeak/, "Playwright smoke should fail closed before writing unsafe reports");
assert.match(playwrightSmoke, /PLAYWRIGHT_NOT_AVAILABLE/, "Playwright smoke should report missing runtime safely");
assert.match(playwrightSmoke, /captureFailureScreenshot/, "Playwright smoke should capture screenshots only for failed E2E runs");
assert.match(playwrightSmoke, /SHORTSENGINE_BROWSER_E2E_TRACE/, "Playwright trace capture should require an explicit env flag");
assert.match(playwrightSmoke, /SHORTSENGINE_BROWSER_E2E_VIDEO/, "Playwright video capture should require an explicit env flag");
assert.match(playwrightSmoke, /cleanupPlaywrightArtifacts/, "Playwright smoke should keep report and artifact retention bounded");
assert.match(reportSafety, /SIGNED_DOWNLOAD_TOKEN_RE/, "report safety should treat signed download tokens as sensitive in persisted reports");
assert.match(reportSafety, /UNSAFE_KEYS/, "report safety should block unsafe internal report keys");
assert.match(reportSafety, /redactForLogs/, "report safety should reuse the server log redaction behavior");
assert.match(ciReportValidator, /findSensitiveLeak/, "CI report validator should reuse leak detection");
assert.match(ciReportValidator, /CI_REPORT_STALE/, "CI report validator should reject stale reports");
assert.match(ciReportValidator, /Passing Playwright runs must not publish artifact files/, "CI report validator should enforce failure-only Playwright artifacts");
assert.match(ciReportValidator, /Passing Playwright runs must not leave failure artifact files/, "CI report validator should reject stale Playwright failure artifacts");
assert.match(ciReportValidator, /demo\/results\/playwright-artifacts/, "CI report validator should require managed Playwright artifact refs");
assert.match(envChecker, /ENV_CONTRACT/, "environment checker should define an explicit env contract");
assert.match(envChecker, /ENV_PROVIDER_CREDENTIAL_MISSING/, "environment checker should reject real providers without credentials");
assert.match(envChecker, /ENV_CLOUD_STORAGE_INCOMPLETE/, "environment checker should reject incomplete cloud storage config");
assert.match(envChecker, /ENV_BROWSER_SKIP_UNSAFE/, "environment checker should reject browser skip flags");
assert.match(envChecker, /findSensitiveLeak/, "environment checker should guard readiness output against leaks");
assert.match(stagingReadiness, /STAGING_ENV_CONTRACT/, "staging readiness should define an explicit staging env contract");
assert.match(stagingReadiness, /STAGING_URL_CREDENTIALS_UNSAFE/, "staging readiness should reject credentialed URLs");
assert.match(stagingReadiness, /STAGING_URL_LOCAL_UNSAFE/, "staging readiness should reject localhost without explicit local mode");
assert.match(stagingReadiness, /hostNetworkType/, "staging readiness should classify local private and remote hosts");
assert.match(stagingReadiness, /first === 169 && second === 254/, "staging readiness should reject link-local metadata-style targets without explicit local mode");
assert.match(stagingReadiness, /verifyStagingWorkflowContract/, "staging readiness should validate the staging workflow contract");
assert.match(stagingReadiness, /findSensitiveLeak/, "staging readiness should guard summaries against leaks");
assert.match(stagingSmoke, /SHORTSENGINE_STAGING_URL/, "staging smoke should require an explicit deployed URL");
assert.match(stagingSmoke, /GET/, "staging smoke should perform a health GET");
assert.match(stagingSmoke, /MAX_HEALTH_RESPONSE_BYTES/, "staging smoke should bound health response size");
assert.match(stagingSmoke, /STAGING_HEALTH_JSON_INVALID/, "staging smoke should reject invalid JSON safely");
assert.match(stagingSmoke, /validateHealthPayload/, "staging smoke should validate health response shape");
assert.match(stagingSmoke, /findSensitiveLeak/, "staging smoke should guard health and summary output against leaks");
assert.match(envDocs, /Staging Readiness Checklist/, "environment docs should include a staging readiness checklist");
assert.match(envDocs, /npm run env:check/, "environment docs should document the env check command");
assert.match(envDocs, /npm run staging:check/, "environment docs should document the staging readiness command");
assert.match(envDocs, /SHORTSENGINE_STAGING_URL/, "environment docs should document staging URL config");
assert.match(envDocs, /SHORTSENGINE_STAGING_DEPLOY_PROVIDER/, "environment docs should document staging provider config");
assert.match(envDocs, /MATCHCUTS_TRANSCRIPTION_PROVIDER/, "environment docs should document transcription provider config");
assert.match(envDocs, /MATCHCUTS_STORAGE_ADAPTER/, "environment docs should document storage adapter config");
assert.match(envDocs, /OPENAI_API_KEY/, "environment docs should document provider credential handling");
assert.match(envExample, /MATCHCUTS_TRANSCRIPTION_PROVIDER=mock/, ".env.example should keep mock provider as the default");
assert.match(envExample, /MATCHCUTS_STORAGE_ADAPTER=local/, ".env.example should keep local storage as the default");
assert.match(envExample, /SHORTSENGINE_STAGING_DEPLOY_PROVIDER=none/, ".env.example should keep provider-neutral staging as the default");
assert.match(envExample, /SHORTSENGINE_STAGING_URL=/, ".env.example should leave staging URL empty by default");
assert.doesNotMatch(envExample, /sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,}|Bearer\s+[A-Za-z0-9._-]{10,}/, ".env.example must not contain real-looking secrets");
assert.match(releaseGateVerifier, /checkEnvironment/, "release gate verifier should include environment readiness");
assert.match(releaseGateVerifier, /checkStagingReadiness/, "release gate verifier should include staging readiness");
assert.match(releaseGateVerifier, /validateCiReports/, "release gate verifier should reuse CI report validation");
assert.match(releaseGateVerifier, /REQUIRED_WORKFLOW_COMMANDS/, "release gate verifier should enforce required workflow commands");
assert.match(releaseGateVerifier, /SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP/, "release gate verifier should reject browser skip flags");
assert.match(releaseGateVerifier, /integration:cloud\|MATCHCUTS_RUN_REAL_CLOUD_TESTS/, "release gate verifier should keep real cloud integration out of default CI");
assert.match(releaseGateVerifier, /FAILURE_ARTIFACT_ALLOWLIST/, "release gate verifier should enforce the artifact allowlist");
assert.match(releaseGateVerifier, /read-only-config-inspection/, "release gate verifier should inspect git remote state read-only");
assert.match(releaseEvidenceWriter, /findSensitiveLeak/, "release evidence writer should reject sensitive evidence");
assert.match(releaseEvidenceWriter, /environmentReadiness/, "release evidence should include environment readiness");
assert.match(releaseEvidenceWriter, /stagingReadiness/, "release evidence should include staging readiness");
assert.match(releaseEvidenceWriter, /release\/results/, "release evidence writer should use the release results directory");
assert.doesNotMatch(releaseEvidenceWriter, /\bpath:\s*gate\.reports/, "release evidence should not expose report path keys directly");
assert.match(manualDocs, /npm run demo:fixture/, "manual docs should explain fixture generation");
assert.match(manualDocs, /npm run demo:browser/, "manual docs should explain browser smoke");
assert.match(manualDocs, /UPLOAD_EMPTY/, "manual docs should describe missing upload behavior");
assert.match(manualDocs, /port already used/i, "manual docs should include troubleshooting");
assert.match(ciDocs, /npm run demo:browser:install/, "CI docs should include the Playwright browser install step");
assert.match(ciDocs, /npm run env:check/, "CI docs should include the environment readiness check");
assert.match(ciDocs, /npm run staging:check/, "CI docs should include the staging readiness check");
assert.match(ciDocs, /docs\/STAGING_DEPLOYMENT\.md/, "CI docs should link to staging deployment docs");
assert.match(ciDocs, /npm run demo:browser:ci/, "CI docs should document the CI browser E2E command");
assert.match(ciDocs, /SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP/, "CI docs should make missing-runtime skips explicit");
assert.match(ciDocs, /SHORTSENGINE_BROWSER_E2E_TRACE/, "CI docs should document opt-in trace capture");
assert.match(ciDocs, /SHORTSENGINE_BROWSER_E2E_VIDEO/, "CI docs should document opt-in video capture");
assert.match(ciDocs, /SHORTSENGINE_BROWSER_E2E_RETENTION_MAX/, "CI docs should document bounded artifact retention");
assert.match(ciDocs, /playwright-artifacts/, "CI docs should document failure-only artifact location");
assert.match(ciDocs, /\.github\/workflows\/ci\.yml/, "CI docs should point to the workflow");
assert.match(ciDocs, /uploads artifacts only when the release gate fails/i, "CI docs should describe failure-only uploads");
assert.match(ciDocs, /Real cloud integration stays out of the default gate/i, "CI docs should document opt-in cloud integration");
assert.match(ciDocs, /npm run release:check/, "CI docs should include release gate verification");
assert.match(ciDocs, /npm run release:evidence/, "CI docs should include release evidence generation");
assert.match(releaseDocs, /Branch Protection Checklist/, "release docs should include branch protection guidance");
assert.match(releaseDocs, /npm run env:check/, "release docs should include environment readiness checks");
assert.match(releaseDocs, /npm run staging:check/, "release docs should include staging readiness checks");
assert.match(releaseDocs, /\.github\/workflows\/staging\.yml/, "release docs should mention the staging workflow");
assert.match(releaseDocs, /npm run release:check/, "release docs should explain local release checks");
assert.match(releaseDocs, /release\/results\/latest\.json/, "release docs should explain release evidence output");
assert.match(releaseDocs, /Real cloud integration remains opt-in/i, "release docs should keep cloud integration opt-in");

for (const command of [
  "npm run env:check",
  "npm run staging:check",
  "npm run lint",
  "npm run build",
  "npm test",
  "npm run eval",
  "npm run brain:health",
  "npm run demo:fixture",
  "npm run demo:smoke",
  "npm run demo:browser",
  "npm run demo:browser:ci",
  "npm run ci:reports",
  "npm run release:check",
]) {
  assert.match(githubWorkflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `CI workflow should run ${command}`);
}
assert.match(githubWorkflow, /pull_request:/, "CI workflow should run on pull requests");
assert.match(githubWorkflow, /push:[\s\S]*branches:[\s\S]*main[\s\S]*master/, "CI workflow should run on main/master pushes");
assert.match(githubWorkflow, /node-version:\s*"?(?:18|20|22)"?/, "CI workflow should use Node.js 18 or newer");
assert.match(githubWorkflow, /cache:\s*npm/, "CI workflow should cache npm dependencies safely");
assert.match(githubWorkflow, /~\/\.cache\/ms-playwright/, "CI workflow should cache Playwright browser binaries");
assert.match(githubWorkflow, /npm ci/, "CI workflow should use npm ci when a lockfile exists");
assert.match(githubWorkflow, /npm install/, "CI workflow should retain npm install fallback when no lockfile exists");
assert.match(githubWorkflow, /npm run demo:browser:install/, "CI workflow should install Playwright Chromium");
assert.match(githubWorkflow, /uses:\s*actions\/upload-artifact@v4/, "CI workflow should use upload-artifact for failure diagnostics");
assert.match(githubWorkflow, /if:\s*failure\(\)/, "CI workflow should upload artifacts only on failure");
assert.match(githubWorkflow, /demo\/results\/latest\.json/, "CI workflow should upload API smoke latest report on failure");
assert.match(githubWorkflow, /demo\/results\/browser-latest\.json/, "CI workflow should upload browser smoke latest report on failure");
assert.match(githubWorkflow, /demo\/results\/playwright-latest\.json/, "CI workflow should upload Playwright latest report on failure");
assert.match(githubWorkflow, /demo\/results\/playwright-artifacts\//, "CI workflow should upload failure-only Playwright artifacts");
assert.match(githubWorkflow, /eval\/results\/latest\.json/, "CI workflow should upload eval latest report on failure");
assert.doesNotMatch(githubWorkflow, /SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP/, "release gate must not skip missing Playwright runtime");
assert.doesNotMatch(githubWorkflow, /integration:cloud|MATCHCUTS_RUN_REAL_CLOUD_TESTS/, "release gate must not run real cloud integration by default");
assert.doesNotMatch(githubWorkflow, /node_modules|data\/(?:uploads|renders|db|jobs|artifacts)|var\/|\.env|secrets?/i, "CI workflow must not upload unsafe local state");
assert.doesNotMatch(githubWorkflow, /demo\/results\/\*\*|demo\/results\/\*\.json|eval\/results\/\*\.json/, "CI workflow should avoid broad report globs");

assert.match(stagingDocs, /GitHub Environment `staging`/, "staging docs should explain the protected GitHub Environment");
assert.match(stagingDocs, /SHORTSENGINE_STAGING_DEPLOY_TOKEN/, "staging docs should document the provider-neutral deploy credential");
assert.match(stagingDocs, /npm run staging:check/, "staging docs should document readiness command");
assert.match(stagingDocs, /npm run staging:smoke/, "staging docs should document deployed smoke command");
assert.match(stagingDocs, /does not upload videos/i, "staging docs should keep deployed smoke health-only");
assert.match(stagingDocs, /private-network|link-local/i, "staging docs should document private network URL rejection");
assert.match(stagingDocs, /bounded health response size/i, "staging docs should document bounded health payloads");
assert.doesNotMatch(stagingDocs, /sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,}|Bearer\s+[A-Za-z0-9._-]{10,}/, "staging docs must not contain real-looking secrets");

assert.match(stagingWorkflow, /workflow_dispatch:/, "staging workflow should support manual dispatch");
assert.match(stagingWorkflow, /workflow_run:[\s\S]*ShortsEngine CI/, "staging workflow should run after successful CI");
assert.match(stagingWorkflow, /environment:[\s\S]*name:\s*staging/, "staging workflow should use GitHub Environment staging");
assert.match(stagingWorkflow, /npm run env:check/, "staging workflow should run env readiness");
assert.match(stagingWorkflow, /npm run staging:check/, "staging workflow should run staging readiness");
assert.match(stagingWorkflow, /npm run staging:smoke/, "staging workflow should include deployed smoke");
assert.match(stagingWorkflow, /Provider deploy step is not implemented/, "staging workflow should fail closed for configured providers");
assert.doesNotMatch(stagingWorkflow, /SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP/, "staging workflow must not skip required browser/runtime checks");
assert.doesNotMatch(stagingWorkflow, /integration:cloud|MATCHCUTS_RUN_REAL_CLOUD_TESTS/, "staging workflow must not run real cloud integration by default");
assert.doesNotMatch(stagingWorkflow, /uses:\s*actions\/upload-artifact@v4/, "staging workflow should not upload artifacts by default");
assert.doesNotMatch(stagingWorkflow, /node_modules|data\/(?:uploads|renders|db|jobs|artifacts)|var\/|\.env|AKIA[A-Z0-9]{12,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{10,}/i, "staging workflow must not include unsafe local state or hardcoded secrets");

assert.match(css, /\[hidden\]\s*{[^}]*display:\s*none\s*!important/s, "hidden controls must not be overridden by display styles");
assert.match(css, /button:disabled/, "disabled states should be styled");
assert.match(css, /prefers-reduced-motion/, "reduced motion support should remain present");
assert.match(css, /\.error-panel/, "error panel should be styled");
assert.match(css, /\.reason-chip/, "candidate reason chips should be styled");

console.log("Static lint checks passed");
