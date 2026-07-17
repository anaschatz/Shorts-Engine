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
const { contentHash } = require("../server/pipelines/narrated-short/contracts.cjs");
const { safeSeekSequence } = require("../server/pipelines/narrated-short/animation/render-service.cjs");
const { normalizePilotReport } = require("../server/pipelines/narrated-short/pilot/contract.cjs");
const { normalizeOperatorProof } = require("../server/pipelines/narrated-short/pilot/operator-proof.cjs");
const { validateContentArtifactEnvelope } = require("../server/repositories/content-artifact-repository.cjs");
const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = resolve(ROOT, "eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json");
const PROOF_ROOT = resolve(ROOT, "data/dark-curiosity-production-proof");
const AUDIO_ROOT = resolve(PROOF_ROOT, "narration");
const PYTHON = existsSync(resolve(ROOT, "tmp/faster-whisper-venv/bin/python")) ? resolve(ROOT, "tmp/faster-whisper-venv/bin/python") : process.env.SHORTSENGINE_LOCAL_WHISPER_PYTHON_BIN;
const MODEL_CACHE = resolve(ROOT, "data/models/faster-whisper");
const MAX_OUTPUT = 2 * 1024 * 1024;
// A 38.9-second 1080x1920 final can legitimately spend more than ten minutes
// encoding and auditing without emitting progress on slower local machines.
// Keep the watchdog bounded, but leave enough headroom for the proven workload.
const IDLE_TIMEOUT_MS = Math.max(30000, Math.min(1800000, Number(process.env.SHORTSENGINE_PRODUCTION_PROOF_IDLE_TIMEOUT_MS || 1800000)));

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
  const source = resolve(result.stateRoot, "renders", "narrated", `${result.report.final.jobId}.mp4`);
  if (!existsSync(source) || sha256File(source) !== result.report.final.outputHash) throw new Error("production_proof_final_binding_mismatch");
  return source;
}

function previewSource(result) {
  const source = resolve(result.stateRoot, "renders", "narrated", `${result.report.preview.jobId}.mp4`);
  if (!existsSync(source) || sha256File(source) !== result.report.preview.outputHash) throw new Error("production_proof_preview_binding_mismatch");
  return source;
}

function singleArtifact(result, artifactType, extension) {
  const directory = resolve(result.stateRoot, "artifacts", "content", result.report.projectId, artifactType);
  const matches = readdirSync(directory).map((name) => resolve(directory, name)).filter((path) => path.endsWith(extension));
  if (matches.length !== 1) throw new Error("production_proof_repeat_artifact_missing");
  return matches[0];
}

function contentArtifacts(result, artifactType) {
  const directory = resolve(result.stateRoot, "artifacts", "content", result.report.projectId, artifactType);
  if (!existsSync(directory)) throw new Error("production_proof_repeat_artifact_missing");
  return readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => {
    let envelope;
    try { envelope = validateContentArtifactEnvelope(JSON.parse(readFileSync(resolve(directory, name), "utf8"))); }
    catch { throw new Error("production_proof_repeat_artifact_tampered"); }
    if (envelope.artifactType !== artifactType) throw new Error("production_proof_repeat_artifact_tampered");
    return { ...envelope, artifactId: `art_${name.replace(/\.json$/, "").slice(0, 40)}` };
  });
}

function animationProofs(result) {
  const manifests = contentArtifacts(result, "animation_render_manifest");
  const qaReports = contentArtifacts(result, "animation_qa_report");
  const animationIrs = contentArtifacts(result, "animation_ir");
  const expectedStates = ["beam_response", "bounded_candidate", "failed_repeat_search", "frequency_context", "observation_record"];
  const requiredChecks = ["geometryAudit", "persistentContinuity", "focusExclusivity", "primaryRoi", "mobileLegibility", "captionSafeZone", "clipping"];
  const proof = {};
  for (const profile of ["preview", "final"]) {
    const jobId = result.report[profile]?.jobId;
    const matchingManifests = manifests.filter((candidate) => candidate.ownerJobId === jobId);
    const matchingQa = qaReports.filter((candidate) => candidate.ownerJobId === jobId);
    const matchingIr = animationIrs.filter((candidate) => candidate.ownerJobId === jobId);
    if (matchingManifests.length !== 1 || matchingQa.length !== 1 || matchingIr.length !== 1) throw new Error("production_proof_repeat_artifact_missing");
    const manifestEnvelope = matchingManifests[0], qaEnvelope = matchingQa[0], irEnvelope = matchingIr[0];
    const manifest = manifestEnvelope.body, qa = qaEnvelope.body, animationIr = irEnvelope.body, browser = qa?.browser, motion = qa?.motion, geometry = browser?.geometryAudit;
    const expectedSeekSequence = safeSeekSequence(animationIr);
    const repeatedFrames = expectedSeekSequence.filter((frame, index) => expectedSeekSequence.indexOf(frame) !== index);
    const expectedWarmupFrames = [...new Set([...animationIr.visualStateGraph.focusIntervals.map((interval) => Math.floor((interval.startFrame + interval.endFrame - 1) / 2)), ...repeatedFrames])];
    const hashesValid = [manifest?.browserProofHash, manifest?.motionProofHash, manifest?.animationQaHash, qa?.browserProofHash, qa?.motionProofHash].every((value) => /^[a-f0-9]{64}$/.test(value || ""));
    const versionsValid = manifest?.provider === "hyperframes_local" && manifest?.runtimeVersion === "0.7.55" && manifest?.styleVersion === "1.9.0" && qa?.provider === manifest.provider && qa?.runtimeVersion === manifest.runtimeVersion && qa?.styleVersion === manifest.styleVersion && animationIr?.renderer?.provider === manifest.provider && animationIr?.renderer?.runtimeVersion === manifest.runtimeVersion && animationIr?.renderer?.styleVersion === manifest.styleVersion;
    const bindingsValid = manifest?.animationIRArtifactId === irEnvelope.artifactId && manifest?.animationIRHash === irEnvelope.contentHash && qa?.animationIRHash === irEnvelope.contentHash && manifest?.animationQaArtifactId === qaEnvelope.artifactId && manifest?.animationQaHash === qaEnvelope.contentHash && manifest?.browserProofHash === qa?.browserProofHash && manifest?.motionProofHash === qa?.motionProofHash && qa?.browserProofHash === contentHash(browser) && qa?.motionProofHash === contentHash(motion);
    const geometryValid = geometry?.passed === true && geometry.persistentObservationCount > 0 && geometry.labelObservationCount > 0 && geometry.markedLabelIds?.length > 0 && JSON.stringify(geometry.markedLabelIds) === JSON.stringify(geometry.observedLabelIds) && geometry.unobservedLabelCount === 0 && geometry.unobservedPathFollowerCount === 0 && geometry.unobservedFocusIntervalCount === 0 && geometry.clippedEntityCount === 0 && geometry.captionSafeZoneViolationCount === 0 && geometry.pathFollowerViolationCount === 0 && geometry.persistentContinuityViolationCount === 0 && geometry.focusViolationCount === 0 && geometry.primaryRoiViolationCount === 0 && geometry.legibilityViolationCount === 0 && geometry.contrastViolationCount === 0 && JSON.stringify(geometry.persistentStateCoverage?.signal_evidence || []) === JSON.stringify(expectedStates) && geometry.observedTransitionIds?.length === 4 && geometry.observedFocusIntervalIds?.length === 14;
    const warmupValid = JSON.stringify(browser?.seekSequence) === JSON.stringify(expectedSeekSequence) && JSON.stringify(browser?.cacheWarmupFrames) === JSON.stringify(expectedWarmupFrames);
    const qaValid = qa?.status === "passed" && browser?.passed === true && browser?.loadedOnce === true && browser?.externalRequestCount === 0 && browser?.blockedExternalRequestCount === 0 && warmupValid && motion?.passed === true && requiredChecks.every((key) => motion?.checks?.[key] === true);
    if (!hashesValid || !versionsValid || !bindingsValid || !geometryValid || !qaValid) throw new Error("production_proof_animation_qa_invalid");
    proof[profile] = Object.freeze({
      browserProofHash: manifest.browserProofHash,
      motionProofHash: manifest.motionProofHash,
      animationQaHash: manifest.animationQaHash,
      provider: manifest.provider,
      runtimeVersion: manifest.runtimeVersion,
      styleVersion: manifest.styleVersion,
      geometryAudit: geometry,
      motionChecks: motion.checks,
    });
  }
  return Object.freeze(proof);
}

function runPilot(index) {
  const stateRoot = resolve(tmpdir(), "dark-curiosity-production-proof", `run-${index}`);
  const outputDir = resolve(stateRoot, "reports");
  rmSync(stateRoot, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const args = [resolve(ROOT, "demo/run-dark-curiosity-pilot.mjs"), "--fixture", "eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json", "--audio", resolve(AUDIO_ROOT, "narration.wav"), "--rights-confirmed", "--operator-id", `production-proof-${index}`, "--output-dir", outputDir, "--render-profile", "final", "--timeout-ms", "3600000", "--publish-approve", "--download-proof"];
  return new Promise((resolvePromise, reject) => {
    const processGroup = process.platform !== "win32";
    const child = spawn(process.execPath, args, { cwd: ROOT, detached: processGroup, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MATCHCUTS_DATA_DIR: stateRoot, SHORTSENGINE_LOCAL_WHISPER_CACHE_DIR: MODEL_CACHE, SHORTSENGINE_LOCAL_WHISPER_PYTHON_BIN: PYTHON || "python3", SHORTSENGINE_LOCAL_WHISPER_TIMEOUT_MS: "900000", SHORTSENGINE_PILOT_PROGRESS_JSONL: "1" } });
    let stdout = "", stderr = "", stderrBuffer = "", lastStage = "process_started", settled = false;
    const terminateChild = () => {
      if (processGroup && Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, "SIGTERM"); return; } catch { /* fall back to the direct child below */ }
      }
      child.kill("SIGTERM");
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      if (error) reject(error); else resolvePromise(value);
    };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        terminateChild();
        finish(new Error(`production_proof_idle_${lastStage}`));
      }, IDLE_TIMEOUT_MS);
    };
    let idleTimer = null;
    armIdleTimer();
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > MAX_OUTPUT) terminateChild(); });
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
      if (stderr.length > MAX_OUTPUT || stderrBuffer.length > 65536) terminateChild();
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

async function runPilotWithRetries(index, maximumAttempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try { return await runPilot(index); }
    catch (error) {
      lastError = error;
      const retryable = ["ANIMATION_RENDER_FAILED", "ANIMATION_RENDER_TIMEOUT"].includes(error?.pilotFailureCode);
      if (!retryable || attempt === maximumAttempts) throw error;
      safeProgress(index, { event: "pilot_retrying", stage: String(error.pilotFailureCode).toLowerCase() });
    }
  }
  throw lastError;
}

function loadCompletedPilot(index) {
  const stateRoot = resolve(tmpdir(), "dark-curiosity-production-proof", `run-${index}`);
  const report = normalizePilotReport(JSON.parse(readFileSync(resolve(stateRoot, "reports/latest.json"), "utf8")));
  const operatorProof = normalizeOperatorProof(JSON.parse(readFileSync(resolve(stateRoot, "reports/operator-proof-latest.json"), "utf8")));
  const audioHash = sha256File(resolve(AUDIO_ROOT, "narration.wav"));
  if (report.status !== "complete" || report.qaPassed !== true || report.preview?.status !== "completed" || report.final?.status !== "completed" || report.technicalFinal !== true) throw new Error("production_proof_resume_invalid");
  if (operatorProof.status !== "complete" || operatorProof.release?.downloadVerified !== true || operatorProof.release?.outputHash !== report.final.outputHash || operatorProof.outputs?.preview?.hash !== report.preview.outputHash || operatorProof.outputs?.final?.hash !== report.final.outputHash || operatorProof.pilotReport?.hash !== report.contentHash || operatorProof.preflight?.audioHash !== audioHash) throw new Error("production_proof_resume_invalid");
  finalSource({ report, stateRoot });
  previewSource({ report, stateRoot });
  return Object.freeze({ report, operatorProof, stateRoot, resumed: true });
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
  const first = process.env.SHORTSENGINE_PRODUCTION_PROOF_RESUME_RUN_ONE === "1" ? loadCompletedPilot(1) : await runPilotWithRetries(1);
  const second = process.env.SHORTSENGINE_PRODUCTION_PROOF_RESUME_RUN_TWO === "1" ? loadCompletedPilot(2) : await runPilotWithRetries(2);
  if (first.report.qaPassed !== true || second.report.qaPassed !== true) throw new Error("production_proof_repeat_qa_failed");
  const finalByteHashesEqual = first.report.final.outputHash === second.report.final.outputHash;
  const previewHashesEqual = first.report.preview.outputHash === second.report.preview.outputHash;
  const narrationHashesEqual = first.report.narrationAudio.hash === second.report.narrationAudio.hash;
  const firstCaptionHash = sha256File(singleArtifact(first, "caption_ass", ".ass"));
  const secondCaptionHash = sha256File(singleArtifact(second, "caption_ass", ".ass"));
  const captionHashesEqual = firstCaptionHash === secondCaptionHash;
  const firstAnimationProof = animationProofs(first);
  const secondAnimationProof = animationProofs(second);
  const browserProofsEqual = ["preview", "final"].every((profile) => firstAnimationProof[profile].browserProofHash === secondAnimationProof[profile].browserProofHash && JSON.stringify(firstAnimationProof[profile].geometryAudit) === JSON.stringify(secondAnimationProof[profile].geometryAudit));
  const motionProofsEqual = ["preview", "final"].every((profile) => firstAnimationProof[profile].motionProofHash === secondAnimationProof[profile].motionProofHash && JSON.stringify(firstAnimationProof[profile].motionChecks) === JSON.stringify(secondAnimationProof[profile].motionChecks));
  const comparableAnimationProof = (value) => Object.fromEntries(["preview", "final"].map((profile) => {
    const { animationQaHash: _runBoundQaHash, ...comparable } = value[profile];
    return [profile, comparable];
  }));
  const animationProofsEqual = JSON.stringify(comparableAnimationProof(firstAnimationProof)) === JSON.stringify(comparableAnimationProof(secondAnimationProof));
  if (!narrationHashesEqual || !captionHashesEqual || !browserProofsEqual || !motionProofsEqual || !animationProofsEqual) throw new Error("production_proof_repeat_artifact_mismatch");
  const previewMediaEquivalence = await compareMediaEquivalence(previewSource(first), previewSource(second));
  if (!previewMediaEquivalence.passed) throw new Error("production_proof_repeat_preview_media_mismatch");
  const mediaEquivalence = await compareMediaEquivalence(finalSource(first), finalSource(second));
  if (!mediaEquivalence.passed) throw new Error("production_proof_repeat_media_mismatch");
  const canonical = publishCanonical(first);
  process.stdout.write(`${JSON.stringify({ status: "complete", runs: 2, outputSha256: first.report.final.outputHash, qaPassed: first.report.qaPassed && second.report.qaPassed, narrationDurationSeconds: narration.manifest.audio.durationSeconds, pacing: narration.manifest.pacing, animationProof: firstAnimationProof, repeatability: { previewHashesEqual, previewMediaEquivalent: previewMediaEquivalence.passed, previewMediaEquivalence, narrationHashesEqual, captionHashesEqual, browserProofsEqual, motionProofsEqual, animationProofsEqual, finalByteHashesEqual, finalByteHashes: [first.report.final.outputHash, second.report.final.outputHash], mediaEquivalent: mediaEquivalence.passed, mediaEquivalence }, canonical, publishApprovalsVerified: true, guardedDownloadsVerified: true }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "failed", code: String(error?.message || "production_proof_failed").replace(/[^A-Za-z0-9_]/g, "_").toUpperCase().slice(0, 80) })}\n`);
  process.exitCode = 1;
}
