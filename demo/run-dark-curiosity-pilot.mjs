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

try {
  const options = parsePilotArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(PILOT_HELP);
  } else {
    ensureDataDirs();
    const doctor = alignerDoctor();
    let preflight = { status: "rights_required", ready: false, expectedWordCount: 0, nextAction: "provide-authorized-wav-and-confirm-rights" };
    let rehearsal = { status: "not_run", exactMatch: false, expectedWordCount: 0, alignedWordCount: 0, firstMismatchIndex: null, mismatchCategory: null, nextAction: "complete-preflight" };
    let gate = { ready: options.reportOnly, code: null, nextAction: null };
    if (!options.reportOnly) {
      preflight = await narrationPreflight({ fixture: options.fixturePath, audio: options.audioPath, rightsConfirmed: options.rightsConfirmed });
      if (doctor.status === "ready" && preflight.ready) rehearsal = await narrationRehearsal({ fixture: options.fixturePath, audio: options.audioPath, preflight });
      gate = { ready: doctor.status === "ready" && preflight.ready && rehearsal.exactMatch && preflight.fixtureHash === rehearsal.fixtureHash, code: doctor.status !== "ready" ? "ALIGNER_NOT_READY" : !preflight.ready ? "NARRATION_PREFLIGHT_BLOCKED" : !rehearsal.exactMatch ? "NARRATION_REHEARSAL_BLOCKED" : "FIXTURE_HASH_MISMATCH", nextAction: doctor.status !== "ready" ? doctor.nextActions[0] : !preflight.ready ? preflight.nextAction : rehearsal.nextAction };
    }
    const runtime = !options.reportOnly && gate.ready ? require("../server/pipelines/narrated-short/pilot/local-runtime.cjs").createLocalPilotRuntime(options) : {};
    const result = await runPilotWorkflow(options, { ...runtime, preMutationChecks: gate });
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
