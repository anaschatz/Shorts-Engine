#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { MODEL, VOICES, config, doctor, verifyFile } = require("../server/pipelines/narrated-short/narration/tts/kokoro-runtime.cjs");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fail(code, field) { const error = new Error("Kokoro bootstrap failed."); error.code = code; error.field = field; throw error; }
function parseArgs(argv = []) { const allowed = new Set(["--install-package", "--download-model", "--yes", "--dry-run", "--help"]); const values = {}; for (const value of argv) { if (!allowed.has(value) || values[value]) fail("VALIDATION_ERROR", value); values[value] = true; } if (values["--help"]) return { help: true }; const installPackage = values["--install-package"] === true; const downloadModel = values["--download-model"] === true; const authorized = values["--yes"] === true; if ((installPackage || downloadModel) && !authorized) fail("OPERATOR_AUTHORIZATION_REQUIRED", "--yes"); return { installPackage, downloadModel, authorized, dryRun: values["--dry-run"] === true || (!installPackage && !downloadModel) }; }
function compatiblePython(run = spawnSync) { for (const command of ["python3.12", "python3.11", "python3.10", resolve(REPO, ".venv-dark-curiosity/bin/python")]) { const result = run(command, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 8192 }); const match = `${result.stdout || ""} ${result.stderr || ""}`.match(/Python\s+3\.(10|11|12|13)\./); if (result.status === 0 && match) return command; } return null; }
function runChecked(command, args, timeout, run = spawnSync) { const result = run(command, args, { cwd: REPO, encoding: "utf8", timeout, maxBuffer: 128 * 1024 }); if (!result || result.status !== 0) fail("KOKORO_BOOTSTRAP_FAILED", "runtime"); }
function download(expected, target, run = spawnSync) { if (verifyFile(target, expected)) return false; mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); const temp = `${target}.${process.pid}.download`; rmSync(temp, { force: true }); runChecked("curl", ["--fail", "--location", "--silent", "--show-error", "--output", temp, expected.url], 900000, run); if (!verifyFile(temp, expected)) { rmSync(temp, { force: true }); fail("KOKORO_MODEL_CHECKSUM_INVALID", expected.fileName); } renameSync(temp, target); return true; }
function runBootstrap(options, dependencies = {}) { const env = dependencies.env || process.env; const run = dependencies.spawnSync || spawnSync; const before = (dependencies.doctor || doctor)(env, dependencies); if (options.dryRun) return { status: before.status, dryRun: true, changed: false, readiness: before, actions: before.nextActions };
  const runtime = config(env); let changed = false;
  if (options.installPackage && !before.packageReady) { const base = compatiblePython(run); if (!base) fail("KOKORO_PYTHON_UNAVAILABLE", "python"); if (!existsSync(runtime.pythonBin)) { mkdirSync(dirname(runtime.pythonBin), { recursive: true, mode: 0o700 }); runChecked(base, ["-m", "venv", resolve(REPO, ".venv-kokoro")], 120000, run); } runChecked(runtime.pythonBin, ["-m", "pip", "install", "--disable-pip-version-check", "--requirement", resolve(REPO, "requirements-dark-curiosity-kokoro.txt")], 900000, run); changed = true; }
  if (options.downloadModel) { changed = download(MODEL, runtime.modelPath, run) || changed; changed = download(VOICES, runtime.voicesPath, run) || changed; }
  const readiness = (dependencies.doctor || doctor)(env, dependencies); if (options.installPackage && !readiness.packageReady) fail("KOKORO_BOOTSTRAP_INCOMPLETE", "package"); if (options.downloadModel && (!readiness.modelReady || !readiness.voicesReady)) fail("KOKORO_BOOTSTRAP_INCOMPLETE", "model"); return { status: readiness.status, dryRun: false, changed, readiness, actions: readiness.nextActions }; }
const HELP = `Usage:\n  node tools/dark-curiosity-kokoro-bootstrap.mjs --dry-run\n  node tools/dark-curiosity-kokoro-bootstrap.mjs --install-package --yes\n  node tools/dark-curiosity-kokoro-bootstrap.mjs --download-model --yes\n`;
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const options = parseArgs(process.argv.slice(2)); if (options.help) process.stdout.write(HELP); else process.stdout.write(`${JSON.stringify(runBootstrap(options), null, 2)}\n`); } catch (error) { process.stderr.write(`${JSON.stringify({ status: "failed", code: String(error && error.code || "KOKORO_BOOTSTRAP_FAILED").replace(/[^A-Z0-9_]/g, "_").slice(0, 80), nextAction: "inspect-kokoro-runtime" })}\n`); process.exitCode = 1; }
}

export { compatiblePython, parseArgs, runBootstrap };
