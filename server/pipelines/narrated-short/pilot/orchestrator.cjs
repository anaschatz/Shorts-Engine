const { readFileSync } = require("node:fs");
const { basename } = require("node:path");
const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { normalizeDraftBundle } = require("../contracts.cjs");
const { PILOT_PROFILE, PILOT_PROFILE_VERSION, PILOT_STAGES, PilotStateMachine, normalizePilotReport, pilotRunId } = require("./contract.cjs");
const { pilotReadiness } = require("./readiness.cjs");
const { persistPilotReport, readLatestPilotReport } = require("./report-store.cjs");

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function emptyEvidence() { return { approvedDraft: null, narrationManifest: null, narrationAudio: null, narrationAlignment: null, preview: null, final: null, qa: null, contactSheet: null, rightsManifest: null, provenanceReport: null, exportMetadata: null }; }
function safeFailure(error, stage) { const code = String(error && error.code || "PILOT_FAILED").replace(/[^A-Z0-9_]/g, "_").slice(0, 80) || "PILOT_FAILED"; const nextAction = String(error && error.details && error.details.nextAction || "inspect-pilot-readiness-and-safe-error-code").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120); return { stage, code, nextAction }; }

function reportInput({ runId, status, fixtureId, fixtureHash, readiness, machine, evidence, context, failure, startedAt, startedMs, now }) {
  const completedAt = now().toISOString();
  return { schemaVersion: 1, profile: PILOT_PROFILE, profileVersion: PILOT_PROFILE_VERSION, runId, status, projectId: context.projectId || null, projectRevision: context.projectRevision || null, fixture: { fixtureId, hash: fixtureHash }, ...evidence, completedStages: machine.completed, failure, readiness, technicalFinal: status === "complete", qaPassed: status === "complete", publishable: false, publishApprovalRequired: true, startedAt, completedAt, durationMs: Math.max(0, now().getTime() - startedMs) };
}

function verifyReplay(report, input) {
  if (!report || report.runId !== input.runId) return null;
  if (report.status !== "complete" || report.fixture.hash !== input.fixtureHash || report.publishable !== false || report.technicalFinal !== true || !report.final || !report.exportMetadata) throw new AppError("PILOT_CHECKPOINT_INVALID", SAFE_MESSAGES.PILOT_CHECKPOINT_INVALID, 409);
  if (input.verifyCompletedReport && input.verifyCompletedReport(report) !== true) throw new AppError("PILOT_CHECKPOINT_INVALID", SAFE_MESSAGES.PILOT_CHECKPOINT_INVALID, 409);
  return report;
}

async function runPilotWorkflow(options = {}, dependencies = {}) {
  const now = dependencies.now || (() => new Date()); const started = now(); const startedAt = started.toISOString(); const startedMs = started.getTime();
  const fixtureBuffer = readFileSync(options.fixturePath); const fixture = normalizeDraftBundle(JSON.parse(fixtureBuffer.toString("utf8"))); const fixtureHash = fixture.contentHash; const fixtureId = basename(options.fixturePath);
  const audioHash = options.audioPath ? sha256(readFileSync(options.audioPath)) : null;
  const runId = pilotRunId({ fixtureHash, audioHash, renderProfile: options.renderProfile, operatorId: options.operatorId });
  const readiness = await (dependencies.pilotReadiness || pilotReadiness)({ fixtureValid: true, audioPath: options.audioPath, rightsConfirmed: options.rightsConfirmed, reportOnly: options.reportOnly }, dependencies);
  const machine = new PilotStateMachine(); const evidence = emptyEvidence(); const context = { fixture, fixtureHash, audioHash, runId, signal: null };
  machine.transition("fixture_validated");
  if (options.reportOnly) {
    const report = normalizePilotReport(reportInput({ runId, status: "report_only", fixtureId, fixtureHash, readiness, machine, evidence, context, failure: readiness.blockingReasons.length ? { stage: "readiness", code: "PILOT_READINESS_BLOCKED", nextAction: readiness.nextActions[0] || "provide-required-local-assets" } : null, startedAt, startedMs, now }));
    return { report: (dependencies.persistPilotReport || persistPilotReport)(report, options.outputDir), replayed: false, exitCode: 0 };
  }
  if (readiness.status !== "ready") {
    machine.fail();
    const report = normalizePilotReport(reportInput({ runId, status: "failed", fixtureId, fixtureHash, readiness, machine, evidence, context, failure: { stage: "readiness", code: "PILOT_READINESS_BLOCKED", nextAction: readiness.nextActions[0] || "provide-required-local-assets" }, startedAt, startedMs, now }));
    return { report: (dependencies.persistPilotReport || persistPilotReport)(report, options.outputDir), replayed: false, exitCode: 1 };
  }
  if (dependencies.preMutationChecks && dependencies.preMutationChecks.ready !== true) {
    machine.fail(); const gate = dependencies.preMutationChecks;
    const report = normalizePilotReport(reportInput({ runId, status: "failed", fixtureId, fixtureHash, readiness, machine, evidence, context, failure: { stage: "readiness", code: String(gate.code || "PILOT_PREFLIGHT_BLOCKED"), nextAction: String(gate.nextAction || "fix-operator-preflight") }, startedAt, startedMs, now }));
    return { report: (dependencies.persistPilotReport || persistPilotReport)(report, options.outputDir), replayed: false, exitCode: 1 };
  }
  const latest = (dependencies.readLatestPilotReport || readLatestPilotReport)(options.outputDir);
  if (latest && latest.runId === runId && latest.status === "failed") throw new AppError("PILOT_CHECKPOINT_INVALID", SAFE_MESSAGES.PILOT_CHECKPOINT_INVALID, 409, { nextAction: "inspect-failed-run-before-retry" });
  const replay = verifyReplay(latest, { runId, fixtureHash, verifyCompletedReport: dependencies.verifyCompletedReport });
  if (replay) return { report: replay, replayed: true, exitCode: 0 };
  if (typeof dependencies.executeStage !== "function") throw new AppError("PIPELINE_HANDLER_UNAVAILABLE", "The pilot execution runtime is unavailable.", 503);
  const controller = new AbortController(); context.signal = controller.signal;
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs); let currentStage = "project_created";
  try {
    for (const stage of PILOT_STAGES.slice(1)) {
      currentStage = stage;
      const result = await dependencies.executeStage(stage, context);
      if (result && typeof result === "object") {
        if (result.context) Object.assign(context, result.context);
        if (result.evidence) Object.assign(evidence, result.evidence);
      }
      machine.transition(stage);
    }
    const report = normalizePilotReport(reportInput({ runId, status: "complete", fixtureId, fixtureHash, readiness, machine, evidence, context, failure: null, startedAt, startedMs, now }));
    return { report: (dependencies.persistPilotReport || persistPilotReport)(report, options.outputDir), replayed: false, exitCode: 0 };
  } catch (error) {
    try { machine.fail(); } catch { /* retain original failure */ }
    if (typeof dependencies.cleanup === "function") await dependencies.cleanup(context, error);
    const failure = controller.signal.aborted ? { stage: currentStage, code: "JOB_CANCELLED", nextAction: "increase-timeout-or-fix-blocked-stage" } : safeFailure(error, currentStage);
    const report = normalizePilotReport(reportInput({ runId, status: "failed", fixtureId, fixtureHash, readiness, machine, evidence, context, failure, startedAt, startedMs, now }));
    return { report: (dependencies.persistPilotReport || persistPilotReport)(report, options.outputDir), replayed: false, exitCode: 1 };
  } finally { clearTimeout(timeout); }
}

module.exports = { runPilotWorkflow };
