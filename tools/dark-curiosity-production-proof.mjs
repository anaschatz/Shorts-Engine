#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { compareMediaEquivalence } from "./lib/media-equivalence.mjs";

const require = createRequire(import.meta.url);
const { synthesizeTtsNarration } = require("../server/pipelines/narrated-short/narration/tts/service.cjs");
const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = resolve(ROOT, "eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json");
const PROOF_ROOT = resolve(ROOT, "data/dark-curiosity-production-proof");
const AUDIO_ROOT = resolve(PROOF_ROOT, "narration");
const PYTHON = existsSync(resolve(ROOT, "tmp/faster-whisper-venv/bin/python")) ? resolve(ROOT, "tmp/faster-whisper-venv/bin/python") : process.env.SHORTSENGINE_LOCAL_WHISPER_PYTHON_BIN;
const MODEL_CACHE = resolve(ROOT, "data/models/faster-whisper");
const MAX_OUTPUT = 2 * 1024 * 1024;
// A 1080x1920 final can legitimately render for several minutes without
// emitting progress. Keep the watchdog bounded, but do not treat encoding as
// a stalled pilot just because the source grew to the full narration length.
const IDLE_TIMEOUT_MS = Math.max(30000, Math.min(600000, Number(process.env.SHORTSENGINE_PRODUCTION_PROOF_IDLE_TIMEOUT_MS || 600000)));

function safeProgress(index, event) {
  const name = String(event?.event || "unknown").replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 60);
  const stage = event?.stage ? String(event.stage).replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 60) : null;
  const field = event?.field ? String(event.field).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) : null;
  process.stderr.write(`${JSON.stringify({ type: "production_proof_progress", run: index, event: name, stage, field })}\n`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function finalSource(result) {
  return resolve(result.stateRoot, "renders", "narrated", `${result.report.final.jobId}.mp4`);
}

function singleArtifact(result, artifactType, extension) {
  const directory = resolve(result.stateRoot, "artifacts", "content", result.report.projectId, artifactType);
  const matches = readdirSync(directory).map((name) => resolve(directory, name)).filter((path) => path.endsWith(extension));
  if (matches.length !== 1) throw new Error("production_proof_repeat_artifact_missing");
  return matches[0];
}

function finalAnimationProof(result) {
  const directory = resolve(result.stateRoot, "artifacts", "content", result.report.projectId, "animation_render_manifest");
  const manifests = readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(resolve(directory, name), "utf8")));
  const manifest = manifests.find((candidate) => candidate.ownerJobId === result.report.final.jobId);
  const body = manifest?.body;
  if (!body || !/^[a-f0-9]{64}$/.test(body.browserProofHash || "") || !body.provider || !body.runtimeVersion || !body.styleVersion) throw new Error("production_proof_repeat_artifact_missing");
  return Object.freeze({ browserProofHash: body.browserProofHash, provider: body.provider, runtimeVersion: body.runtimeVersion, styleVersion: body.styleVersion });
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
      if (code !== 0 || !parsed || parsed.status !== "complete" || parsed.report?.final?.status !== "completed" || parsed.operatorProof?.release?.downloadVerified !== true) {
        const error = new Error(`production_proof_run_failed_${lastStage}`);
        let persistedReport = null;
        try { persistedReport = JSON.parse(readFileSync(resolve(outputDir, "latest.json"), "utf8")); } catch { /* optional safe diagnostic */ }
        const failureCode = String(parsed?.report?.failure?.code || persistedReport?.failure?.code || "").replace(/[^A-Z0-9_]/g, "").slice(0, 80);
        if (failureCode) error.pilotFailureCode = failureCode;
        finish(error);
      }
      else finish(null, { ...parsed, stateRoot });
    });
  });
}

function publishCanonical(result) {
  const source = finalSource(result);
  if (!existsSync(source) || sha256File(source) !== result.report.final.outputHash) throw new Error("production_proof_final_binding_mismatch");
  const contactSheetDir = resolve(result.stateRoot, "artifacts", "content", result.report.projectId, "contact_sheet");
  const contactSheetSource = readdirSync(contactSheetDir).map((name) => resolve(contactSheetDir, name)).find((path) => path.endsWith(".png") && sha256File(path) === result.report.contactSheet.hash);
  if (!contactSheetSource) throw new Error("production_proof_contact_sheet_binding_mismatch");
  const finalPath = resolve(PROOF_ROOT, "final-semantic-short.mp4");
  const contactSheetPath = resolve(PROOF_ROOT, "final-semantic-contact-sheet.png");
  copyFileSync(source, finalPath);
  copyFileSync(contactSheetSource, contactSheetPath);
  if (sha256File(finalPath) !== result.report.final.outputHash || sha256File(contactSheetPath) !== result.report.contactSheet.hash) throw new Error("production_proof_canonical_copy_mismatch");
  return { finalPath, contactSheetPath };
}

try {
  mkdirSync(AUDIO_ROOT, { recursive: true });
  let narration;
  const narrationInput = { fixture: FIXTURE, projectDir: AUDIO_ROOT, provider: "kokoro_local", voiceId: "af_heart", pacingProfile: "dark_curiosity_comprehension_v1", commercialUseAttested: true, termsReference: "Apache-2.0", attestedBy: "local-production-proof", regenerate: false };
  try { narration = await synthesizeTtsNarration(narrationInput); }
  catch (error) {
    if (error?.code !== "TTS_OVERWRITE_BLOCKED") throw error;
    narration = await synthesizeTtsNarration({ ...narrationInput, regenerate: true });
  }
  if (!narration.publishable) throw new Error("production_proof_narration_blocked");
  const first = await runPilot(1);
  const second = await runPilot(2);
  if (first.report.qaPassed !== true || second.report.qaPassed !== true) throw new Error("production_proof_repeat_qa_failed");
  const finalByteHashesEqual = first.report.final.outputHash === second.report.final.outputHash;
  const previewHashesEqual = first.report.preview.outputHash === second.report.preview.outputHash;
  const narrationHashesEqual = first.report.narrationAudio.hash === second.report.narrationAudio.hash;
  const firstCaptionHash = sha256File(singleArtifact(first, "caption_ass", ".ass"));
  const secondCaptionHash = sha256File(singleArtifact(second, "caption_ass", ".ass"));
  const captionHashesEqual = firstCaptionHash === secondCaptionHash;
  const firstAnimationProof = finalAnimationProof(first);
  const secondAnimationProof = finalAnimationProof(second);
  const browserProofsEqual = JSON.stringify(firstAnimationProof) === JSON.stringify(secondAnimationProof);
  if (!previewHashesEqual || !narrationHashesEqual || !captionHashesEqual || !browserProofsEqual) throw new Error("production_proof_repeat_artifact_mismatch");
  const mediaEquivalence = await compareMediaEquivalence(finalSource(first), finalSource(second));
  if (!mediaEquivalence.passed) throw new Error("production_proof_repeat_media_mismatch");
  const canonical = publishCanonical(first);
  process.stdout.write(`${JSON.stringify({ status: "complete", runs: 2, outputSha256: first.report.final.outputHash, qaPassed: first.report.qaPassed && second.report.qaPassed, narrationDurationSeconds: narration.manifest.audio.durationSeconds, pacing: narration.manifest.pacing, repeatability: { previewHashesEqual, narrationHashesEqual, captionHashesEqual, browserProofsEqual, finalByteHashesEqual, finalByteHashes: [first.report.final.outputHash, second.report.final.outputHash], mediaEquivalent: mediaEquivalence.passed, mediaEquivalence }, canonical, publishApprovalsVerified: true, guardedDownloadsVerified: true }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "failed", code: String(error?.message || "production_proof_failed").replace(/[^A-Za-z0-9_]/g, "_").toUpperCase().slice(0, 80) })}\n`);
  process.exitCode = 1;
}
