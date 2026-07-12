const { isAbsolute, relative, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { CONFIG } = require("../../../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");

const REPO_ROOT = resolve(__dirname, "../../../..");
const FIXTURE_ROOT = resolve(REPO_ROOT, "eval/narrated/dark-curiosity/fixtures");
const DEFAULT_OUTPUT_DIR = resolve(REPO_ROOT, "demo/dark-curiosity-pilot-results");
const VALUE_FLAGS = new Set(["--fixture", "--audio", "--operator-id", "--output-dir", "--render-profile", "--timeout-ms"]);
const BOOLEAN_FLAGS = new Set(["--rights-confirmed", "--report-only", "--publish-approve", "--download-proof", "--help"]);

function inside(root, candidate) { const path = relative(resolve(root), resolve(candidate)); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); }
function safeAbsolute(value, field) { if (!value || !isAbsolute(value) || /^https?:/i.test(value) || /^data:/i.test(value)) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field }); return resolve(value); }

function parsePilotArgs(argv = []) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (BOOLEAN_FLAGS.has(key)) { if (values[key]) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: key }); values[key] = true; continue; }
    if (!VALUE_FLAGS.has(key)) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: key });
    const value = argv[index + 1]; if (!value || value.startsWith("--")) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: key }); values[key] = value; index += 1;
  }
  if (values["--help"]) return { help: true };
  const fixturePath = values["--fixture"] ? resolve(REPO_ROOT, values["--fixture"]) : null;
  if (!fixturePath || /^https?:/i.test(values["--fixture"]) || /^data:/i.test(values["--fixture"])) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "fixture" });
  if (!inside(FIXTURE_ROOT, fixturePath)) throw new AppError("PILOT_FIXTURE_UNSAFE", SAFE_MESSAGES.PILOT_FIXTURE_UNSAFE, 403);
  const reportOnly = values["--report-only"] === true;
  const audioPath = values["--audio"] ? safeAbsolute(values["--audio"], "audio") : null;
  const rightsConfirmed = values["--rights-confirmed"] === true;
  if (!reportOnly && (!audioPath || !rightsConfirmed)) throw new AppError("PILOT_READINESS_BLOCKED", SAFE_MESSAGES.PILOT_READINESS_BLOCKED, 409, { nextAction: "provide-authorized-wav-and-confirm-rights" });
  const outputDir = values["--output-dir"] ? safeAbsolute(values["--output-dir"], "outputDir") : DEFAULT_OUTPUT_DIR;
  if (![DEFAULT_OUTPUT_DIR, CONFIG.dataDir, tmpdir()].some((root) => inside(root, outputDir))) throw new AppError("PILOT_OUTPUT_UNSAFE", SAFE_MESSAGES.PILOT_OUTPUT_UNSAFE, 403);
  const renderProfile = String(values["--render-profile"] || "final").toLowerCase();
  if (!['final'].includes(renderProfile)) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "renderProfile" });
  const timeoutMs = Number(values["--timeout-ms"] || 900000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 3600000) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "timeoutMs" });
  const operatorId = String(values["--operator-id"] || "local_operator").trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(operatorId)) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "operatorId" });
  const publishApprove = values["--publish-approve"] === true; const downloadProof = values["--download-proof"] === true;
  if (downloadProof && !publishApprove) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "downloadProof" });
  if (reportOnly && (publishApprove || downloadProof)) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "publishApprove" });
  return { help: false, fixturePath, audioPath, rightsConfirmed, operatorId, outputDir, renderProfile, timeoutMs, reportOnly, publishApprove, downloadProof };
}

const PILOT_HELP = `Usage: npm run dark-curiosity:pilot -- --fixture <managed-fixture.json> [options]\n\nOptions:\n  --audio <absolute.wav>       Authorized local operator narration\n  --rights-confirmed          Confirm commercial-use rights (required for execution)\n  --operator-id <safe-id>     Local operator identity\n  --output-dir <absolute-dir> Managed report directory\n  --render-profile final      Technical-final profile\n  --timeout-ms <10000..3600000>\n  --report-only               Validate without pipeline mutation\n  --publish-approve           Create and verify explicit manual publish approval\n  --download-proof            Verify guarded local final (requires --publish-approve)\n  --help                      Show this help\n`;

module.exports = { DEFAULT_OUTPUT_DIR, FIXTURE_ROOT, PILOT_HELP, parsePilotArgs };
