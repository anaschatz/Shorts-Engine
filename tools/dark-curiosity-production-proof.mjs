#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { synthesizeTtsNarration } = require("../server/pipelines/narrated-short/narration/tts/service.cjs");
const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = resolve(ROOT, "eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json");
const PROOF_ROOT = resolve(ROOT, "data/dark-curiosity-production-proof");
const AUDIO_ROOT = resolve(PROOF_ROOT, "narration");
const PYTHON = existsSync(resolve(ROOT, "tmp/faster-whisper-venv/bin/python")) ? resolve(ROOT, "tmp/faster-whisper-venv/bin/python") : process.env.SHORTSENGINE_LOCAL_WHISPER_PYTHON_BIN;
const MODEL_CACHE = resolve(ROOT, "data/models/faster-whisper");
const MAX_OUTPUT = 2 * 1024 * 1024;
const IDLE_TIMEOUT_MS = Math.max(30000, Math.min(600000, Number(process.env.SHORTSENGINE_PRODUCTION_PROOF_IDLE_TIMEOUT_MS || 180000)));

function safeProgress(index, event) {
  const name = String(event?.event || "unknown").replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 60);
  const stage = event?.stage ? String(event.stage).replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 60) : null;
  const field = event?.field ? String(event.field).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) : null;
  process.stderr.write(`${JSON.stringify({ type: "production_proof_progress", run: index, event: name, stage, field })}\n`);
}

function runPilot(index) {
  const stateRoot = resolve(tmpdir(), "dark-curiosity-production-proof", `run-${index}`);
  const outputDir = resolve(stateRoot, "reports");
  rmSync(stateRoot, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const args = [resolve(ROOT, "demo/run-dark-curiosity-pilot.mjs"), "--fixture", "eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json", "--audio", resolve(AUDIO_ROOT, "narration.wav"), "--rights-confirmed", "--operator-id", `production-proof-${index}`, "--output-dir", outputDir, "--render-profile", "final", "--timeout-ms", "1800000", "--publish-approve", "--download-proof"];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MATCHCUTS_DATA_DIR: stateRoot, SHORTSENGINE_LOCAL_WHISPER_CACHE_DIR: MODEL_CACHE, SHORTSENGINE_LOCAL_WHISPER_PYTHON_BIN: PYTHON || "python3", SHORTSENGINE_LOCAL_WHISPER_TIMEOUT_MS: "900000", SHORTSENGINE_PILOT_PROGRESS_JSONL: "1" } });
    let stdout = "", stderr = "", stderrBuffer = "", lastStage = "process_started", settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      if (error) reject(error); else resolvePromise(value);
    };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new Error(`production_proof_idle_${lastStage}`));
      }, IDLE_TIMEOUT_MS);
    };
    let idleTimer = null;
    armIdleTimer();
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > MAX_OUTPUT) child.kill("SIGTERM"); });
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
      const lines = stderrBuffer.split("\n"); stderrBuffer = lines.pop();
      for (const line of lines) {
        let event = null;
        try { event = JSON.parse(line); } catch { stderr += `${line}\n`; }
        if (event?.type === "pilot_progress") {
          lastStage = event.stage || event.event || lastStage;
          safeProgress(index, event);
          armIdleTimer();
        } else if (event?.status === "failed" && event?.error?.code) {
          lastStage = String(event.error.code).replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 60) || lastStage;
        }
      }
      if (stderr.length > MAX_OUTPUT || stderrBuffer.length > 65536) child.kill("SIGTERM");
    });
    child.on("error", () => finish(new Error("production_proof_process_failed")));
    child.on("close", (code) => {
      if (settled) return;
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* safe failure below */ }
      if (code !== 0 || !parsed || parsed.status !== "complete" || parsed.report?.final?.status !== "completed" || parsed.operatorProof?.release?.downloadVerified !== true) finish(new Error(`production_proof_run_failed_${lastStage}`));
      else finish(null, parsed);
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
