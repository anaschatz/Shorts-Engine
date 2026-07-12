const { existsSync, rmSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const { CONFIG } = require("../../../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { MODEL_ALLOWLIST, alignerDoctor } = require("./operator-tools.cjs");
const { fasterWhisperConfig } = require("../../../adapters/faster-whisper-adapter.cjs");

const REPO_ROOT = resolve(__dirname, "../../../..");
const VENV_DIR = resolve(REPO_ROOT, ".venv-dark-curiosity");
const REQUIREMENTS = resolve(REPO_ROOT, "requirements-dark-curiosity-aligner.txt");
const MODEL_HELPER = resolve(REPO_ROOT, "tools/dark-curiosity-model-bootstrap.py");
function invalid(field) { throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field }); }

function parseBootstrapArgs(argv = []) {
  const valueFlags = new Set(["--model", "--device", "--compute-type", "--timeout-ms"]); const booleanFlags = new Set(["--dry-run", "--install-package", "--download-model", "--yes", "--help"]); const values = {};
  for (let i = 0; i < argv.length; i += 1) { const key = argv[i]; if (booleanFlags.has(key)) { if (values[key]) invalid(key); values[key] = true; continue; } if (!valueFlags.has(key)) invalid(key); const value = argv[++i]; if (!value || value.startsWith("--")) invalid(key); values[key] = value; }
  if (values["--help"]) return { help: true };
  const model = values["--model"] || "base"; if (!MODEL_ALLOWLIST.includes(model)) invalid("model");
  const device = values["--device"] || "cpu"; const computeType = values["--compute-type"] || "int8"; if (device !== "cpu") invalid("device"); if (computeType !== "int8") invalid("computeType");
  const timeoutMs = Number(values["--timeout-ms"] || 600000); if (!Number.isInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 1800000) invalid("timeoutMs");
  const installPackage = values["--install-package"] === true; const downloadModel = values["--download-model"] === true; const authorized = values["--yes"] === true;
  if ((installPackage || downloadModel) && !authorized) throw new AppError("OPERATOR_AUTHORIZATION_REQUIRED", "Explicit operator authorization is required.", 409);
  return { help: false, dryRun: !installPackage && !downloadModel || values["--dry-run"] === true, installPackage, downloadModel, authorized, model, device, computeType, timeoutMs };
}

function safeRun(command, args, timeoutMs, dependency = spawnSync) { const result = dependency(command, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true }); return result.status === 0; }
function discoverCompatiblePython(dependency = spawnSync) {
  for (const command of ["python3.12", "python3.11", "python3.10", "python3.9"]) {
    let result; try { result = dependency(command, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 8192, windowsHide: true }); } catch { continue; }
    const match = `${result.stdout || ""} ${result.stderr || ""}`.match(/Python\s+(3\.(?:9|10|11|12)\.\d+)/i); if (result.status === 0 && match) return { available: true, command, version: match[1] };
  }
  return { available: false, command: null, version: null };
}
function runBootstrap(options, dependencies = {}) {
  const before = (dependencies.doctor || alignerDoctor)(dependencies.env || process.env, dependencies); const actions = [];
  if (before.status === "ready") return { status: "ready", dryRun: options.dryRun, changed: false, model: options.model, device: options.device, computeType: options.computeType, actions, nextActions: [] };
  if (options.dryRun) { if (!before.packageReady) actions.push("create-project-venv", "install-pinned-aligner-packages"); if (!before.modelReady) actions.push("acquire-allowlisted-model"); return { status: "dry_run", dryRun: true, changed: false, model: options.model, device: options.device, computeType: options.computeType, actions: [...new Set(actions)], nextActions: ["rerun-with-explicit-flags-and-yes"] }; }
  if (before.status === "runtime_failed" && before.nextActions && before.nextActions.includes("configure-python-3-9-through-3-12")) throw new AppError("ALIGNER_BOOTSTRAP_FAILED", "The local aligner bootstrap failed.", 503, { nextAction: "configure-python-3-9-through-3-12" });
  const execute = dependencies.spawnSync || spawnSync; let changed = false;
  if (options.installPackage) {
    const configuredPython = fasterWhisperConfig(dependencies.env || process.env).pythonBin; const createdNow = !existsSync(VENV_DIR); if (createdNow && !safeRun(configuredPython, ["-m", "venv", VENV_DIR], options.timeoutMs, execute)) { try { rmSync(VENV_DIR, { recursive: true, force: true }); } catch {} throw new AppError("ALIGNER_BOOTSTRAP_FAILED", "The local aligner bootstrap failed.", 503, { nextAction: "inspect-project-python" }); }
    const python = resolve(VENV_DIR, "bin/python"); const verify = "import importlib.metadata as m; assert m.version('faster-whisper') == '1.2.0'; assert m.version('ctranslate2') == '4.6.0'; assert m.version('requests') == '2.32.5'; import faster_whisper, ctranslate2, requests"; if (!safeRun(python, ["-m", "pip", "install", "--disable-pip-version-check", "--requirement", REQUIREMENTS], options.timeoutMs, execute) || !safeRun(python, ["-c", verify], 15000, execute)) { if (createdNow) try { rmSync(VENV_DIR, { recursive: true, force: true }); } catch {} throw new AppError("ALIGNER_BOOTSTRAP_FAILED", "The local aligner bootstrap failed.", 503, { nextAction: "retry-authorized-package-install" }); }
    actions.push("installed-pinned-aligner-packages"); changed = true;
  }
  if (options.downloadModel) { const python = resolve(VENV_DIR, "bin/python"); if (!existsSync(python)) throw new AppError("ALIGNER_BOOTSTRAP_FAILED", "The local aligner bootstrap failed.", 503, { nextAction: "install-project-package-first" }); const cache = resolve(CONFIG.dataDir, "models/faster-whisper"); if (!safeRun(python, [MODEL_HELPER, "--model", options.model, "--cache-dir", cache, "--device", options.device, "--compute-type", options.computeType], options.timeoutMs, execute)) throw new AppError("ALIGNER_BOOTSTRAP_FAILED", "The local aligner bootstrap failed.", 503, { nextAction: "retry-authorized-model-acquisition" }); actions.push("acquired-allowlisted-model"); changed = true; }
  return { status: "completed", dryRun: false, changed, model: options.model, device: options.device, computeType: options.computeType, actions, nextActions: ["run-aligner-doctor"] };
}

module.exports = { MODEL_HELPER, REQUIREMENTS, VENV_DIR, discoverCompatiblePython, parseBootstrapArgs, runBootstrap };
