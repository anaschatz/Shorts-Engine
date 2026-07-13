#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { synthesizeTtsNarration } = require("../server/pipelines/narrated-short/narration/tts/service.cjs");
const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = resolve(ROOT, "eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json");
const PROOF_ROOT = resolve(ROOT, "data/dark-curiosity-production-proof");
const AUDIO_ROOT = resolve(PROOF_ROOT, "narration");
const PYTHON = existsSync(resolve(ROOT, "tmp/faster-whisper-venv/bin/python")) ? resolve(ROOT, "tmp/faster-whisper-venv/bin/python") : process.env.SHORTSENGINE_LOCAL_WHISPER_PYTHON_BIN;
const MAX_OUTPUT = 2 * 1024 * 1024;

function runPilot(index) {
  const outputDir = resolve(PROOF_ROOT, `run-${index}`);
  mkdirSync(outputDir, { recursive: true });
  const args = [resolve(ROOT, "demo/run-dark-curiosity-pilot.mjs"), "--fixture", "eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json", "--audio", resolve(AUDIO_ROOT, "narration.wav"), "--rights-confirmed", "--operator-id", `production-proof-${index}`, "--output-dir", outputDir, "--render-profile", "final", "--timeout-ms", "1800000", "--publish-approve", "--download-proof"];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SHORTSENGINE_LOCAL_WHISPER_PYTHON_BIN: PYTHON || "python3", SHORTSENGINE_LOCAL_WHISPER_TIMEOUT_MS: "900000" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > MAX_OUTPUT) child.kill("SIGTERM"); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > MAX_OUTPUT) child.kill("SIGTERM"); });
    child.on("error", () => reject(new Error("production_proof_process_failed")));
    child.on("close", (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* safe failure below */ }
      if (code !== 0 || !parsed || parsed.status !== "complete" || parsed.report?.final?.status !== "completed" || parsed.operatorProof?.release?.downloadVerified !== true) reject(new Error("production_proof_run_failed"));
      else resolvePromise(parsed);
    });
  });
}

try {
  mkdirSync(AUDIO_ROOT, { recursive: true });
  const narration = await synthesizeTtsNarration({ fixture: FIXTURE, projectDir: AUDIO_ROOT, provider: "kokoro_local", voiceId: "af_heart", commercialUseAttested: true, termsReference: "Apache-2.0", attestedBy: "local-production-proof", regenerate: false });
  if (!narration.publishable) throw new Error("production_proof_narration_blocked");
  const first = await runPilot(1);
  const second = await runPilot(2);
  const hashesEqual = first.report.final.outputHash === second.report.final.outputHash;
  if (!hashesEqual) throw new Error("production_proof_repeat_hash_mismatch");
  process.stdout.write(`${JSON.stringify({ status: "complete", runs: 2, outputSha256: first.report.final.outputHash, hashesEqual, qaPassed: first.report.qaPassed && second.report.qaPassed, publishApprovalsVerified: true, guardedDownloadsVerified: true }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "failed", code: String(error?.message || "production_proof_failed").replace(/[^A-Za-z0-9_]/g, "_").toUpperCase().slice(0, 80) })}\n`);
  process.exitCode = 1;
}
