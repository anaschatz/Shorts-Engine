const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");

const { alignerDoctor, createNarrationPreparation, loadFixture, narrationPreflight, narrationRehearsal } = require("../server/pipelines/narrated-short/pilot/operator-tools.cjs");
const { modelCacheDir } = require("../server/adapters/faster-whisper-adapter.cjs");
const { discoverCompatiblePython, parseBootstrapArgs, runBootstrap } = require("../server/pipelines/narrated-short/pilot/bootstrap.cjs");
const { scriptWords } = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const { runPilotWorkflow } = require("../server/pipelines/narrated-short/pilot/orchestrator.cjs");
const { createOperatorProof, normalizeOperatorProof } = require("../server/pipelines/narrated-short/pilot/operator-proof.cjs");
const { revokeFailedReleaseProof } = require("../server/pipelines/narrated-short/pilot/release-proof.cjs");

const FIXTURE = resolve(__dirname, "..", "eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json");
const READY = { status: "ready", environmentReady: true, ffmpeg: true, ffprobe: true, renderer: true, aligner: true, managedStorage: true, fixtureValid: true, narrationAvailable: true, rightsConfirmed: true, previewCapable: true, technicalFinalCapable: true, blockingReasons: [], nextActions: [] };
function wav(path) { const value = Buffer.alloc(48); value.write("RIFF", 0); value.writeUInt32LE(40, 4); value.write("WAVE", 8); writeFileSync(path, value); }
function probe(overrides = {}) { return { streams: [{ codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "48000", channels: 1 }], format: { format_name: "wav", duration: "32" }, ...overrides }; }

test("aligner doctor exposes only bounded states for disabled, missing Python, package, model, and ready", () => {
  const python = () => ({ status: 0, stdout: "Python 3.11.9", stderr: "" });
  assert.equal(alignerDoctor({ SHORTSENGINE_LOCAL_WHISPER_MODE: "disabled" }, { spawnSync: python }).status, "disabled");
  assert.equal(alignerDoctor({}, { spawnSync: () => ({ status: null, error: { code: "ENOENT" } }) }).status, "python_missing");
  assert.equal(alignerDoctor({}, { spawnSync: python, probeRuntime: () => ({ available: false, reason: "package_missing" }) }).status, "package_missing");
  assert.equal(alignerDoctor({}, { spawnSync: python, probeRuntime: () => ({ available: false, reason: "model_unavailable" }) }).status, "model_missing");
  const ready = alignerDoctor({}, { spawnSync: python, probeRuntime: () => ({ available: true }) }); assert.equal(ready.status, "ready"); assert.doesNotMatch(JSON.stringify(ready), /\/Users|traceback|stdout|stderr|secret/i);
});

test("Whisper model cache override is restricted to managed repo data or temporary storage", () => {
  const managed = resolve(__dirname, "..", "data", "models", "faster-whisper");
  assert.equal(modelCacheDir({ SHORTSENGINE_LOCAL_WHISPER_CACHE_DIR: managed }), managed);
  assert.throws(() => modelCacheDir({ SHORTSENGINE_LOCAL_WHISPER_CACHE_DIR: "/etc/whisper-model" }), /Invalid local Whisper cache directory/);
});

test("bootstrap is dry-run by default and mutations require explicit authorization", () => {
  const options = parseBootstrapArgs([]); let called = false; const result = runBootstrap(options, { doctor: () => ({ status: "package_missing", packageReady: false, modelReady: false }), spawnSync: () => { called = true; } });
  assert.equal(result.dryRun, true); assert.equal(result.changed, false); assert.equal(called, false);
  assert.throws(() => parseBootstrapArgs(["--install-package"]), { code: "OPERATOR_AUTHORIZATION_REQUIRED" });
  assert.throws(() => parseBootstrapArgs(["--download-model", "--model", "large", "--yes"]), { code: "VALIDATION_ERROR" });
});

test("compatible Python discovery is bounded and prefers the highest supported runtime", () => {
  const seen = []; const found = discoverCompatiblePython((command) => { seen.push(command); return command === "python3.11" ? { status: 0, stdout: "Python 3.11.9", stderr: "" } : { status: null, stdout: "", stderr: "" }; });
  assert.deepEqual(found, { available: true, command: "python3.11", version: "3.11.9" }); assert.deepEqual(seen, ["python3.12", "python3.11"]);
  assert.deepEqual(discoverCompatiblePython(() => ({ status: null })), { available: false, command: null, version: null });
});

test("incompatible Python blocks authorized bootstrap before subprocess mutation", () => {
  let called = false; const options = parseBootstrapArgs(["--install-package", "--yes"]);
  assert.throws(() => runBootstrap(options, { doctor: () => ({ status: "runtime_failed", pythonVersion: "3.14.5", packageReady: false, modelReady: false, nextActions: ["configure-python-3-9-through-3-12"] }), spawnSync: () => { called = true; } }), { code: "ALIGNER_BOOTSTRAP_FAILED" }); assert.equal(called, false);
});

test("authorized package bootstrap verifies every pinned runtime import and ready rerun is idempotent", () => {
  const calls = []; const options = parseBootstrapArgs(["--install-package", "--yes"]); const result = runBootstrap(options, { doctor: () => ({ status: "package_missing", packageReady: false, modelReady: false }), env: { SHORTSENGINE_LOCAL_WHISPER_PYTHON_BIN: "python3.10" }, spawnSync: (command, args) => { calls.push({ command, args }); return { status: 0, stdout: "", stderr: "" }; } });
  assert.equal(result.changed, true); const verify = calls.find((call) => call.args[0] === "-c"); assert.match(verify.args[1], /faster-whisper.*1\.2\.0/); assert.match(verify.args[1], /ctranslate2.*4\.6\.0/); assert.match(verify.args[1], /requests.*2\.32\.5/);
  let rerunCalled = false; const rerun = runBootstrap(options, { doctor: () => ({ status: "ready" }), spawnSync: () => { rerunCalled = true; } }); assert.equal(rerun.status, "ready"); assert.equal(rerun.changed, false); assert.equal(rerunCalled, false);
});

test("preparation package is deterministic and preserves exact beat/script order", () => {
  const first = createNarrationPreparation(FIXTURE); const second = createNarrationPreparation(FIXTURE); const { draft } = loadFixture(FIXTURE);
  assert.deepEqual(first, second); assert.deepEqual(first.beatIds, draft.script.beats.map((beat) => beat.id)); assert.equal(first.spokenText, draft.script.beats.map((beat) => beat.spokenText).join(" ")); assert.equal(first.expectedWordCount, 81); assert.equal(first.publishable, false);
});

test("WAV preflight blocks rights, invalid signature, unsupported media, silence, and clipping without path leakage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "operator-wav-")); const audio = join(dir, "authorized.wav"); wav(audio);
  try {
    assert.equal((await narrationPreflight({ fixture: FIXTURE, audio, rightsConfirmed: false })).status, "rights_required");
    const invalid = join(dir, "invalid.wav"); writeFileSync(invalid, Buffer.alloc(48)); assert.equal((await narrationPreflight({ fixture: FIXTURE, audio: invalid, rightsConfirmed: true })).status, "invalid_wav");
    const unsupported = await narrationPreflight({ fixture: FIXTURE, audio, rightsConfirmed: true }, { ffprobeJson: async () => probe({ streams: [{ codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 1 }] }) }); assert.equal(unsupported.status, "unsupported_audio");
    const silent = await narrationPreflight({ fixture: FIXTURE, audio, rightsConfirmed: true }, { ffprobeJson: async () => probe(), analyzeAudio: async () => ({ meanDb: -80, peakDb: -20 }) }); assert.equal(silent.status, "silence_detected");
    const clipping = await narrationPreflight({ fixture: FIXTURE, audio, rightsConfirmed: true }, { ffprobeJson: async () => probe(), analyzeAudio: async () => ({ meanDb: -18, peakDb: 0 }) }); assert.equal(clipping.status, "clipping_risk"); assert.doesNotMatch(JSON.stringify(clipping), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("WAV preflight and exact rehearsal succeed without project or artifact mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "operator-rehearse-")); const audio = join(dir, "authorized.wav"); wav(audio); const { draft } = loadFixture(FIXTURE); const expected = scriptWords(draft.script);
  const dependencies = { ffprobeJson: async () => probe(), analyzeAudio: async () => ({ meanDb: -18, peakDb: -3 }), alignerDoctor: () => ({ status: "ready", nextActions: [] }), transcribe: async () => ({ segments: [{ words: expected.map((word, index) => ({ word: word.text, start: index * 0.2, end: index * 0.2 + 0.1, probability: 1 })) }] }) };
  try { const preflight = await narrationPreflight({ fixture: FIXTURE, audio, rightsConfirmed: true }, dependencies); assert.equal(preflight.status, "ready"); const rehearsal = await narrationRehearsal({ fixture: FIXTURE, audio, preflight }, dependencies); assert.equal(rehearsal.exactMatch, true); assert.equal(rehearsal.alignedWordCount, 81); assert.doesNotMatch(JSON.stringify(rehearsal), /transcript|\/Users|stdout|stderr/i); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rehearsal returns bounded missing/extra/reordered/changed mismatch metadata", async () => {
  const { draft } = loadFixture(FIXTURE); const words = scriptWords(draft.script); const base = { fixture: FIXTURE, audio: "/tmp/test-only.wav", preflight: { ready: true, media: { durationSeconds: 32 }, readingRateWpm: 151 } }; const deps = { alignerDoctor: () => ({ status: "ready", nextActions: [] }) };
  const run = (values) => narrationRehearsal(base, { ...deps, transcribe: async () => ({ segments: [{ words: values.map((word, index) => ({ word: word.text || word, start: index, end: index + 0.5 })) }] }) });
  assert.equal((await run(words.slice(0, -1))).mismatchCategory, "missing_word"); assert.equal((await run([...words, { text: "extra" }])).mismatchCategory, "extra_word"); const swapped = [...words]; [swapped[0], swapped[1]] = [swapped[1], swapped[0]]; assert.equal((await run(swapped)).mismatchCategory, "reordered_word"); const changed = [...words]; changed[0] = { text: "changed" }; const result = await run(changed); assert.equal(result.mismatchCategory, "changed_word"); assert.equal(Object.hasOwn(result, "transcript"), false);
});

test("pilot pre-mutation gate failure never executes a stage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-gate-")); let executed = false;
  try { const result = await runPilotWorkflow({ fixturePath: FIXTURE, audioPath: null, rightsConfirmed: true, operatorId: "operator_1", outputDir: dir, renderProfile: "final", timeoutMs: 10000, reportOnly: false }, { pilotReadiness: () => READY, preMutationChecks: { ready: false, code: "NARRATION_PREFLIGHT_BLOCKED", nextAction: "fix-wav" }, executeStage: async () => { executed = true; } }); assert.equal(result.report.status, "failed"); assert.equal(result.report.completedStages.length, 1); assert.equal(executed, false); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("operator proof is deterministic, strict, non-publishable, and token-safe", () => {
  const report = { runId: `pilot_${"a".repeat(40)}`, status: "report_only", projectId: null, projectRevision: null, fixture: { fixtureId: "fixture.json", hash: "b".repeat(64) }, approvedDraft: null, narrationManifest: null, narrationAudio: null, narrationAlignment: null, preview: null, final: null, qa: null, contactSheet: null, rightsManifest: null, provenanceReport: null, exportMetadata: null, completedStages: ["fixture_validated"], failure: { code: "PILOT_READINESS_BLOCKED" }, technicalFinal: false, durationMs: 10, contentHash: "c".repeat(64) };
  const doctor = { status: "model_missing", pythonAvailable: true, pythonVersion: "3.11.9", packageReady: true, modelReady: false, helperAvailable: true, cacheWritable: true, freeDiskMb: 1000, model: "base", device: "cpu", computeType: "int8", alignerVersion: "local_faster_whisper_test", nextActions: ["acquire-allowlisted-local-model"] };
  const preflight = { status: "rights_required", ready: false, expectedWordCount: 0 }; const rehearsal = { status: "not_run", exactMatch: false, expectedWordCount: 0, alignedWordCount: 0, firstMismatchIndex: null, mismatchCategory: null };
  const first = createOperatorProof({ report, operatorId: "operator_1", doctor, preflight, rehearsal }); const second = createOperatorProof({ report, operatorId: "operator_1", doctor, preflight, rehearsal }); assert.deepEqual(first, second); assert.equal(first.publishable, false); assert.equal(first.release, null); assert.doesNotMatch(JSON.stringify(first), /releaseToken|tokenHash|\/Users|storageKey/i); assert.throws(() => normalizeOperatorProof({ ...first, rawToken: "secret" }), { code: "OPERATOR_PROOF_INVALID" });
});

test("complete operator proof strips in-memory release fields and persists only allowlisted release evidence", () => {
  const ref = (character) => ({ artifactId: `art_${character.repeat(40)}`, hash: character.repeat(64) }); const report = { runId: `pilot_${"1".repeat(40)}`, status: "complete", projectId: "prj_11111111-1111-4111-8111-111111111111", projectRevision: 1, fixture: { fixtureId: "fixture.json", hash: "2".repeat(64) }, approvedDraft: ref("3"), narrationManifest: ref("4"), narrationAudio: ref("5"), narrationAlignment: ref("6"), preview: { exportArtifactId: ref("7").artifactId, outputHash: "7".repeat(64) }, final: { exportArtifactId: ref("8").artifactId, outputHash: "8".repeat(64) }, qa: { report: ref("9"), blockingGateCount: 2, blockingPassedCount: 2, blockingFailedCount: 0, warningCount: 0 }, contactSheet: ref("a"), rightsManifest: ref("b"), provenanceReport: ref("c"), exportMetadata: ref("d"), completedStages: ["fixture_validated", "project_created", "draft_ready", "content_approved", "narration_uploaded", "narration_aligned", "preview_ready", "technical_final_staged", "technical_qa_passed", "evidence_packaged", "technical_final_committed", "pilot_complete"], failure: null, technicalFinal: true, durationMs: 1000, contentHash: "e".repeat(64) };
  const doctor = { status: "ready", pythonAvailable: true, pythonVersion: "3.10.20", packageReady: true, modelReady: true, helperAvailable: true, cacheWritable: true, freeDiskMb: 1000, model: "base", device: "cpu", computeType: "int8", alignerVersion: "local_faster_whisper_test", nextActions: [] }; const preflight = { status: "ready", ready: true, expectedWordCount: 81, media: { durationSeconds: 32 }, readingRateWpm: 151, audioHash: "f".repeat(64) }; const rehearsal = { status: "exact_match", exactMatch: true, expectedWordCount: 81, alignedWordCount: 81, firstMismatchIndex: null, mismatchCategory: null };
  const release = { contentApprovalId: `capr_${"1".repeat(40)}`, publishApprovalId: `papr_${"2".repeat(40)}`, approvalArtifactId: ref("f").artifactId, approvalArtifactHash: "f".repeat(64), outputHash: "8".repeat(64), tokenIssued: true, tokenVerified: true, releaseExpiresAt: "2026-07-12T18:00:00.000Z", guardedDownloadIssued: true, downloadExpiresAt: "2026-07-12T17:50:00.000Z", downloadVerified: false, releaseToken: "must-never-persist", downloadUrl: "must-never-persist" };
  const proof = createOperatorProof({ report, operatorId: "operator_1", doctor, preflight, rehearsal, release }); assert.equal(proof.status, "complete"); assert.equal(proof.contentApprovalId, release.contentApprovalId); assert.equal(proof.release.tokenVerified, true); assert.doesNotMatch(JSON.stringify(proof), /must-never-persist|releaseToken|downloadUrl|tokenHash/);
});

test("failed release verification revokes the active proof approval without exposing token state", () => {
  const calls = []; const repository = { revokeRevision: (...args) => { calls.push(args); return 1; } }; const project = { id: "prj_11111111-1111-4111-8111-111111111111", input: { revision: 7 } }; const created = { approval: { publishApprovalId: `papr_${"1".repeat(40)}` }, releaseToken: "memory-only" };
  assert.equal(revokeFailedReleaseProof(created, repository, project), 1); assert.deepEqual(calls, [[project.id, 7, "release_proof_failed"]]); assert.equal(revokeFailedReleaseProof(null, repository, project), 0);
});

test("pilot interruptions at upload, preview, QA, and release-adjacent boundaries stop deterministically", async () => {
  const boundaries = ["narration_aligned", "technical_final_staged", "evidence_packaged", "pilot_complete"];
  for (const boundary of boundaries) { const dir = mkdtempSync(join(tmpdir(), "pilot-interrupt-")); const seen = []; try { const result = await runPilotWorkflow({ fixturePath: FIXTURE, audioPath: null, rightsConfirmed: true, operatorId: "operator_1", outputDir: dir, renderProfile: "final", timeoutMs: 10000, reportOnly: false }, { pilotReadiness: () => READY, preMutationChecks: { ready: true }, persistPilotReport: (value) => value, readLatestPilotReport: () => null, executeStage: async (stage) => { seen.push(stage); if (stage === boundary) { const error = new Error("interrupted"); error.code = "PROCESS_INTERRUPTED"; throw error; } return stage === "project_created" ? { context: { projectId: "prj_11111111-1111-4111-8111-111111111111", projectRevision: 1 } } : {}; } }); assert.equal(result.report.status, "failed"); assert.equal(result.report.failure.code, "PROCESS_INTERRUPTED"); assert.equal(seen.at(-1), boundary); }
    finally { rmSync(dir, { recursive: true, force: true }); } }
});

test("real pilot CLI remains no-mutation when an operator gate fails", () => {
  const root = mkdtempSync(join(tmpdir(), "pilot-cli-gate-")); const audio = join(root, "invalid.wav"); writeFileSync(audio, Buffer.alloc(48)); const output = join(root, "reports"); const cli = resolve(__dirname, "../demo/run-dark-curiosity-pilot.mjs"); const result = spawnSync(process.execPath, [cli, "--fixture", FIXTURE, "--audio", audio, "--rights-confirmed", "--output-dir", output], { cwd: resolve(__dirname, ".."), encoding: "utf8", env: { ...process.env, MATCHCUTS_DATA_DIR: join(root, "data"), SHORTSENGINE_LOCAL_WHISPER_PYTHON_BIN: resolve(__dirname, "../.venv-dark-curiosity/bin/python") } });
  try { assert.equal(result.status, 1); const projects = join(root, "data/projects"); assert.equal(existsSync(projects) ? readdirSync(projects).length : 0, 0); assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("doctor CLI output is bounded and bootstrap help performs no install", () => {
  const doctor = spawnSync(process.execPath, [resolve(__dirname, "../tools/dark-curiosity-aligner-doctor.mjs")], { encoding: "utf8" }); assert.equal(doctor.status, 0); assert.doesNotMatch(doctor.stdout, /\/Users|traceback|stdout|stderr|secret/i);
  const help = spawnSync(process.execPath, [resolve(__dirname, "../tools/dark-curiosity-aligner-bootstrap.mjs"), "--help"], { encoding: "utf8" }); assert.equal(help.status, 0); assert.match(help.stdout, /Default is a no-mutation dry run/);
});

test("model probe verifies managed snapshot integrity without loading the model runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "managed-model-probe-")); const revision = "a".repeat(40); const repository = join(root, "models--Systran--faster-whisper-base"); const snapshot = join(repository, "snapshots", revision); require("node:fs").mkdirSync(join(repository, "refs"), { recursive: true }); require("node:fs").mkdirSync(snapshot, { recursive: true }); writeFileSync(join(repository, "refs", "main"), revision); writeFileSync(join(snapshot, "config.json"), "{}"); writeFileSync(join(snapshot, "tokenizer.json"), "{}"); writeFileSync(join(snapshot, "vocabulary.txt"), "ok"); writeFileSync(join(snapshot, "model.bin"), Buffer.alloc(1024 * 1024));
  try { const helper = resolve(__dirname, "../tools/faster-whisper-transcribe.py"); const ready = spawnSync("python3", [helper, "--probe-model", "--model", "base", "--device", "cpu", "--compute-type", "int8", "--cache-dir", root], { encoding: "utf8", timeout: 5000 }); assert.equal(ready.status, 0); assert.match(ready.stdout, /"available": true/); writeFileSync(join(snapshot, "model.bin"), Buffer.alloc(8)); const incomplete = spawnSync("python3", [helper, "--probe-model", "--model", "base", "--device", "cpu", "--compute-type", "int8", "--cache-dir", root], { encoding: "utf8", timeout: 5000 }); assert.equal(incomplete.status, 1); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
