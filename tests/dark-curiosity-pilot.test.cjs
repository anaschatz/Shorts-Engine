const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");

const { parsePilotArgs } = require("../server/pipelines/narrated-short/pilot/cli.cjs");
const { PILOT_PROFILE, PILOT_PROFILE_VERSION, PILOT_STAGES, PilotStateMachine, normalizePilotReport, pilotRunId } = require("../server/pipelines/narrated-short/pilot/contract.cjs");
const { runPilotWorkflow } = require("../server/pipelines/narrated-short/pilot/orchestrator.cjs");
const { persistPilotReport, readLatestPilotReport } = require("../server/pipelines/narrated-short/pilot/report-store.cjs");

const FIXTURE = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json");
const HASH = "a".repeat(64);
const artifact = (character) => ({ artifactId: `art_${character.repeat(40)}`, hash: character.repeat(64) });
const job = (character) => ({ jobId: `job_${character.repeat(40)}`, exportArtifactId: `art_${character.repeat(40)}`, outputHash: character.repeat(64), status: "completed" });
const READY = { status: "ready", environmentReady: true, ffmpeg: true, ffprobe: true, renderer: true, aligner: true, managedStorage: true, fixtureValid: true, narrationAvailable: true, rightsConfirmed: true, previewCapable: true, technicalFinalCapable: true, blockingReasons: [], nextActions: [] };

function report(overrides = {}) {
  return { schemaVersion: 1, profile: PILOT_PROFILE, profileVersion: PILOT_PROFILE_VERSION, runId: `pilot_${"1".repeat(40)}`, status: "complete", projectId: "prj_11111111-1111-4111-8111-111111111111", projectRevision: 1, fixture: { fixtureId: "fixture.json", hash: HASH }, approvedDraft: artifact("2"), narrationManifest: artifact("3"), narrationAudio: artifact("4"), narrationAlignment: artifact("5"), preview: job("6"), final: job("7"), qa: { report: artifact("8"), blockingGateCount: 4, blockingPassedCount: 4, blockingFailedCount: 0, warningCount: 0 }, contactSheet: artifact("9"), rightsManifest: artifact("a"), provenanceReport: artifact("b"), exportMetadata: artifact("c"), completedStages: [...PILOT_STAGES], failure: null, readiness: READY, technicalFinal: true, qaPassed: true, publishable: false, publishApprovalRequired: true, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000, ...overrides };
}

test("pilot state machine enforces exact ordering and terminal states", () => {
  const machine = new PilotStateMachine();
  assert.throws(() => machine.transition("project_created"), { code: "PILOT_STATE_INVALID" });
  for (const stage of PILOT_STAGES) machine.transition(stage);
  assert.deepEqual(machine.completed, PILOT_STAGES);
  assert.throws(() => machine.transition("pilot_complete"), { code: "PILOT_STATE_INVALID" });
  const failed = new PilotStateMachine(["fixture_validated"]); assert.equal(failed.fail(), "pilot_failed"); assert.throws(() => failed.transition("project_created"), { code: "PILOT_STATE_INVALID" });
});

test("pilot report is strict, deterministic across runtime timings, and always non-publishable", () => {
  const first = normalizePilotReport(report());
  const second = normalizePilotReport(report({ startedAt: "2026-02-01T00:00:00.000Z", completedAt: "2026-02-01T00:00:09.000Z", durationMs: 9000 }));
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.publishable, false);
  assert.equal(first.publishApprovalRequired, true);
  assert.throws(() => normalizePilotReport({ ...first, readiness: { ...first.readiness, storageKey: "secret" } }), { code: "PILOT_REPORT_INVALID" });
  assert.throws(() => normalizePilotReport({ ...first, completedStages: [...first.completedStages, "pilot_complete"] }), { code: "PILOT_REPORT_INVALID" });
  assert.throws(() => normalizePilotReport({ ...first, final: { ...first.final, outputHash: "bad" } }), { code: "PILOT_REPORT_INVALID" });
});

test("pilot report store atomically updates latest with a validated bounded report", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-report-"));
  try {
    const stored = persistPilotReport(report(), dir);
    assert.equal(readLatestPilotReport(dir).contentHash, stored.contentHash);
    assert.doesNotMatch(readFileSync(join(dir, "latest.json"), "utf8"), /storageKey|\/Users|\/private/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pilot CLI validates managed fixture, operator rights, profiles, and output roots", () => {
  const output = join(tmpdir(), "pilot-safe-output");
  const reportOnly = parsePilotArgs(["--fixture", FIXTURE, "--output-dir", output, "--report-only"]);
  assert.equal(reportOnly.reportOnly, true);
  assert.throws(() => parsePilotArgs(["--fixture", FIXTURE, "--unknown"]), { code: "VALIDATION_ERROR" });
  assert.throws(() => parsePilotArgs(["--fixture", "/tmp/fixture.json", "--report-only"]), { code: "PILOT_FIXTURE_UNSAFE" });
  assert.throws(() => parsePilotArgs(["--fixture", FIXTURE]), { code: "PILOT_READINESS_BLOCKED" });
  assert.throws(() => parsePilotArgs(["--fixture", FIXTURE, "--report-only", "--render-profile", "preview"]), { code: "VALIDATION_ERROR" });
  assert.throws(() => parsePilotArgs(["--fixture", FIXTURE, "--report-only", "--timeout-ms", "2"]), { code: "VALIDATION_ERROR" });
});

test("pilot run identity changes with audio/configuration and contains no operator path", () => {
  const first = pilotRunId({ fixtureHash: HASH, audioHash: "b".repeat(64), operatorId: "operator_1" });
  const second = pilotRunId({ fixtureHash: HASH, audioHash: "c".repeat(64), operatorId: "operator_1" });
  assert.notEqual(first, second); assert.match(first, /^pilot_[a-f0-9]{40}$/);
});

test("pilot orchestrator completes every stage, replays complete reports, and stops on failure", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pilot-orchestrator-"));
  const options = { fixturePath: FIXTURE, audioPath: null, rightsConfirmed: true, operatorId: "operator_1", outputDir: temp, renderProfile: "final", timeoutMs: 10000, reportOnly: false };
  const seen = [];
  const executeStage = async (stage) => {
    seen.push(stage);
    if (stage === "project_created") return { context: { projectId: "prj_11111111-1111-4111-8111-111111111111", projectRevision: 1 } };
    if (stage === "draft_ready") return { evidence: { approvedDraft: artifact("2") } };
    if (stage === "narration_uploaded") return { evidence: { narrationManifest: artifact("3"), narrationAudio: artifact("4") } };
    if (stage === "narration_aligned") return { evidence: { narrationAlignment: artifact("5") } };
    if (stage === "preview_ready") return { evidence: { preview: job("6") } };
    if (stage === "technical_qa_passed") return { evidence: { qa: { report: artifact("8"), blockingGateCount: 1, blockingPassedCount: 1, blockingFailedCount: 0, warningCount: 0 } } };
    if (stage === "evidence_packaged") return { evidence: { contactSheet: artifact("9"), rightsManifest: artifact("a"), provenanceReport: artifact("b"), exportMetadata: artifact("c") } };
    if (stage === "technical_final_committed") return { evidence: { final: job("7") } };
    return {};
  };
  try {
    const deps = { pilotReadiness: () => READY, executeStage, persistPilotReport: (value) => value, readLatestPilotReport: () => null };
    const result = await runPilotWorkflow(options, deps);
    assert.equal(result.report.status, "complete"); assert.deepEqual(seen, PILOT_STAGES.slice(1)); assert.equal(result.report.publishable, false);
    const replay = await runPilotWorkflow(options, { ...deps, readLatestPilotReport: () => result.report, verifyCompletedReport: () => true, executeStage: async () => assert.fail("must not execute") });
    assert.equal(replay.replayed, true);
    const failedSeen = [];
    const failed = await runPilotWorkflow(options, { ...deps, readLatestPilotReport: () => null, executeStage: async (stage) => { failedSeen.push(stage); if (stage === "narration_aligned") { const error = new Error("unsafe detail"); error.code = "NARRATION_ALIGNMENT_FAILED"; throw error; } return executeStage(stage); } });
    assert.equal(failed.report.status, "failed"); assert.equal(failed.report.failure.code, "NARRATION_ALIGNMENT_FAILED"); assert.equal(failedSeen.includes("preview_ready"), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("pilot CLI help is successful and unknown arguments fail with bounded output", () => {
  const cli = resolve(__dirname, "..", "demo", "run-dark-curiosity-pilot.mjs");
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" }); assert.equal(help.status, 0); assert.match(help.stdout, /Usage:/);
  const invalid = spawnSync(process.execPath, [cli, "--bad"], { encoding: "utf8" }); assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stderr, /stack|\/Users|storageKey/i); assert.match(invalid.stderr, /VALIDATION_ERROR/);
});

test("pilot report-only CLI completes without loading the mutation runtime", () => {
  const cli = resolve(__dirname, "..", "demo", "run-dark-curiosity-pilot.mjs"); const output = join(tmpdir(), `pilot-report-only-${process.pid}`);
  try { const run = spawnSync(process.execPath, [cli, "--fixture", FIXTURE, "--output-dir", output, "--report-only"], { encoding: "utf8", timeout: 10000, env: { ...process.env, SHORTSENGINE_LOCAL_WHISPER_MODE: "disabled" } }); assert.equal(run.status, 0); const body = JSON.parse(run.stdout); assert.equal(body.status, "report_only"); assert.equal(body.report.completedStages.at(-1), "fixture_validated"); assert.equal(body.report.projectId, null); assert.doesNotMatch(run.stdout, /storageKey|\/Users|\/private|releaseToken/i); }
  finally { rmSync(output, { recursive: true, force: true }); }
});
