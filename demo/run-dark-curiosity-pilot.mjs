#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureDataDirs } = require("../server/config.cjs");
const { PILOT_HELP, parsePilotArgs } = require("../server/pipelines/narrated-short/pilot/cli.cjs");
const { runPilotWorkflow } = require("../server/pipelines/narrated-short/pilot/orchestrator.cjs");
const { alignerDoctor, narrationPreflight, narrationRehearsal } = require("../server/pipelines/narrated-short/pilot/operator-tools.cjs");
const { createOperatorProof, persistOperatorProof } = require("../server/pipelines/narrated-short/pilot/operator-proof.cjs");

function safeError(error) {
  return { status: "failed", error: { code: String(error && error.code || "PILOT_FAILED").replace(/[^A-Z0-9_]/g, "_").slice(0, 80), message: "The Dark Curiosity pilot could not complete." } };
}

const PROGRESS_ENABLED = ["1", "true", "on"].includes(String(process.env.SHORTSENGINE_PILOT_PROGRESS_JSONL || "").trim().toLowerCase());
function progress(event, details = {}) {
  if (!PROGRESS_ENABLED) return;
  const stage = details && details.stage ? String(details.stage).replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 60) : null;
  const status = details && details.status ? String(details.status).replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 40) : null;
  const body = { type: "pilot_progress", event: String(event).replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 60), stage, status };
  if (Number.isInteger(details.completedStageCount)) body.completedStageCount = details.completedStageCount;
  if (Number.isInteger(details.elapsedMs)) body.elapsedMs = details.elapsedMs;
  if (details.code) body.code = String(details.code).replace(/[^A-Z0-9_]/gi, "_").toUpperCase().slice(0, 80);
  if (details.field) body.field = String(details.field).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  process.stderr.write(`${JSON.stringify(body)}\n`);
}

try {
  const options = parsePilotArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(PILOT_HELP);
  } else {
    ensureDataDirs();
    progress("doctor_started");
    const doctor = alignerDoctor();
    progress("doctor_completed", { status: doctor.status });
    let preflight = { status: "rights_required", ready: false, expectedWordCount: 0, nextAction: "provide-authorized-wav-and-confirm-rights" };
    let rehearsal = { status: "not_run", exactMatch: false, expectedWordCount: 0, alignedWordCount: 0, firstMismatchIndex: null, mismatchCategory: null, nextAction: "complete-preflight" };
    let gate = { ready: options.reportOnly, code: null, nextAction: null };
    if (!options.reportOnly) {
      progress("preflight_started");
      preflight = await narrationPreflight({ fixture: options.fixturePath, audio: options.audioPath, rightsConfirmed: options.rightsConfirmed });
      progress("preflight_completed", { status: preflight.status });
      if (doctor.status === "ready" && preflight.ready) {
        progress("rehearsal_started");
        rehearsal = await narrationRehearsal({ fixture: options.fixturePath, audio: options.audioPath, preflight });
        progress("rehearsal_completed", { status: rehearsal.status });
      }
      gate = { ready: doctor.status === "ready" && preflight.ready && rehearsal.exactMatch && preflight.fixtureHash === rehearsal.fixtureHash, code: doctor.status !== "ready" ? "ALIGNER_NOT_READY" : !preflight.ready ? "NARRATION_PREFLIGHT_BLOCKED" : !rehearsal.exactMatch ? "NARRATION_REHEARSAL_BLOCKED" : "FIXTURE_HASH_MISMATCH", nextAction: doctor.status !== "ready" ? doctor.nextActions[0] : !preflight.ready ? preflight.nextAction : rehearsal.nextAction };
    }
    progress("runtime_started");
    const runtime = !options.reportOnly && gate.ready ? require("../server/pipelines/narrated-short/pilot/local-runtime.cjs").createLocalPilotRuntime(options) : {};
    progress("runtime_completed", { status: gate.ready || options.reportOnly ? "ready" : "blocked" });
    const result = await runPilotWorkflow(options, { ...runtime, preMutationChecks: gate, onProgress: (event) => progress(event.event, event) });
    let release = null;
    if (result.report.status === "complete" && options.publishApprove) release = runtime.createReleaseProof(result.report);
    const bindings = runtime.operatorBindings ? runtime.operatorBindings(result.report) : {};
    const proof = persistOperatorProof(createOperatorProof({ report: result.report, operatorId: options.operatorId, doctor, preflight, rehearsal, bindings, release }), options.outputDir);
    process.stdout.write(`${JSON.stringify({ status: result.report.status, replayed: result.replayed, report: result.report, operatorProof: proof }, null, 2)}\n`);
    process.exitCode = result.exitCode;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
  process.exitCode = 1;
}
