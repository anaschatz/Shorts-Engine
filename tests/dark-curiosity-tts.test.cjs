const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");

const { normalizeSynthesisRequest, normalizeTtsProvenance, sha256 } = require("../server/pipelines/narrated-short/narration/tts/contract.cjs");
const { createKokoroTtsProvider, createMockTtsProvider, createOpenAiTtsProvider, deterministicMockWav } = require("../server/pipelines/narrated-short/narration/tts/providers.cjs");
const { KOKORO_LICENSE_REFERENCE, KOKORO_MODEL_ID, doctor: kokoroDoctor } = require("../server/pipelines/narrated-short/narration/tts/kokoro-runtime.cjs");
const { inspectTtsNarration, synthesizeTtsNarration, verifyTtsNarration } = require("../server/pipelines/narrated-short/narration/tts/service.cjs");
const { evaluateTtsNarrationRelease } = require("../server/pipelines/narrated-short/publish/publish-guard.cjs");

const FIXTURE = resolve(__dirname, "..", "eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json");
const dirs = []; function temp() { const value = mkdtempSync(join(tmpdir(), "dark-tts-")); dirs.push(value); return value; }
test.after(() => dirs.forEach((value) => rmSync(value, { recursive: true, force: true })));

test("provider-neutral request rejects cloned, impersonated, custom production voices, and invalid rates", () => {
  const base = { script: "Approved exact script.", provider: "openai", model: "gpt-4o-mini-tts", voiceId: "coral", language: "en", speakingRate: 1 };
  assert.equal(normalizeSynthesisRequest(base).scriptHash, sha256(base.script));
  assert.throws(() => normalizeSynthesisRequest({ ...base, voiceCloned: true }), { code: "TTS_VOICE_PROHIBITED" });
  assert.throws(() => normalizeSynthesisRequest({ ...base, impersonated: true }), { code: "TTS_VOICE_PROHIBITED" });
  assert.throws(() => normalizeSynthesisRequest({ ...base, voiceId: "voice_custom" }), { code: "TTS_VOICE_PROHIBITED" });
  assert.throws(() => normalizeSynthesisRequest({ ...base, speakingRate: 5 }), { code: "TTS_PROVENANCE_INVALID" });
});

test("Kokoro local request uses an allowlisted voice, production model, and no API credential", async () => {
  const request = normalizeSynthesisRequest({ script: "Approved exact script.", provider: "kokoro_local", voiceId: "af_heart", language: "en", speakingRate: 1 });
  assert.equal(request.model, KOKORO_MODEL_ID); assert.equal(KOKORO_LICENSE_REFERENCE, "Apache-2.0:hexgrad/Kokoro-82M-v1.0");
  assert.throws(() => normalizeSynthesisRequest({ ...request, voiceId: "celebrity_clone" }), { code: "TTS_VOICE_PROHIBITED" });
  const unavailable = createKokoroTtsProvider({ env: { SHORTSENGINE_KOKORO_PYTHON_BIN: "/missing/kokoro/python" } }); await assert.rejects(() => unavailable.synthesize(request), { code: "TTS_PROVIDER_UNAVAILABLE" });
});

test("Kokoro doctor reports bounded missing state without paths or secrets", () => {
  const result = kokoroDoctor({ SHORTSENGINE_KOKORO_PYTHON_BIN: "/missing/kokoro/python" }); assert.equal(result.status, "python_missing"); assert.equal(result.packageReady, false); assert.doesNotMatch(JSON.stringify(result), /\/missing|OPENAI_API_KEY|traceback/i);
});

test("mock provider is deterministic and returns a valid PCM WAV envelope", async () => {
  const request = normalizeSynthesisRequest({ script: "one two three four", provider: "mock", voiceId: "fixture", language: "en", speakingRate: 1 });
  const first = await createMockTtsProvider().synthesize(request); const second = deterministicMockWav(request);
  assert.deepEqual(first.buffer, second); assert.equal(first.buffer.subarray(0, 4).toString("ascii"), "RIFF"); assert.equal(first.buffer.subarray(8, 12).toString("ascii"), "WAVE"); assert.equal(first.provider, "mock");
});

test("OpenAI adapter fails early without credentials and redacts provider secrets and bodies", async () => {
  await assert.rejects(() => createOpenAiTtsProvider({ env: {} }).synthesize(normalizeSynthesisRequest({ script: "approved", provider: "openai", voiceId: "coral" })), { code: "TTS_CREDENTIALS_MISSING" });
  const secret = "sk-do-not-leak"; const provider = createOpenAiTtsProvider({ env: { OPENAI_API_KEY: secret }, fetch: async () => ({ ok: false, status: 401 }) });
  try { await provider.synthesize(normalizeSynthesisRequest({ script: "approved", provider: "openai", voiceId: "coral" })); assert.fail("expected failure"); } catch (error) { assert.equal(error.code, "TTS_PROVIDER_FAILED"); assert.doesNotMatch(JSON.stringify(error), new RegExp(secret)); }
});

test("OpenAI adapter applies a bounded timeout without exposing credentials", async () => {
  const provider = createOpenAiTtsProvider({ env: { OPENAI_API_KEY: "sk-secret", SHORTSENGINE_TTS_TIMEOUT_MS: "1000" }, fetch: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
  await assert.rejects(() => provider.synthesize(normalizeSynthesisRequest({ script: "approved", provider: "openai", voiceId: "coral" })), { code: "TTS_PROVIDER_TIMEOUT" });
});

test("mock synthesis normalizes to 48 kHz mono PCM, writes provenance, reuses idempotently, and stays non-publishable", async () => {
  const projectDir = temp(); const input = { fixture: FIXTURE, projectDir, provider: "mock", voiceId: "fixture", commercialUseAttested: true, termsReference: "test-license-ref", attestedBy: "operator_test" };
  const created = await synthesizeTtsNarration(input); assert.equal(created.status, "synthesized"); assert.equal(created.publishable, false); assert.deepEqual(created.blockerCodes, ["TTS_MOCK_NON_PUBLISHABLE"]);
  const verified = await verifyTtsNarration({ projectDir, fixture: FIXTURE }); assert.equal(verified.valid, true); assert.equal(verified.audio.sampleRate, 48000); assert.equal(verified.audio.channels, 1); assert.equal(verified.audio.codec, "pcm_s16le");
  const reused = await synthesizeTtsNarration(input); assert.equal(reused.status, "reused"); assert.equal(reused.reused, true);
  const inspected = inspectTtsNarration(projectDir); assert.equal(inspected.valid, true); assert.equal(inspected.publishable, false);
});

test("Kokoro service path is publishable with local license provenance and no API key", async () => {
  const projectDir = temp(); const created = await synthesizeTtsNarration({ fixture: FIXTURE, projectDir, provider: "kokoro_local", voiceId: "af_heart", commercialUseAttested: true, attestedBy: "operator_test" }, { createProvider: () => ({ async synthesize(request) { return { provider: "kokoro_local", model: request.model, voiceId: request.voiceId, audioFormat: "wav", buffer: deterministicMockWav(request), providerRequestId: "local_test" }; } }) });
  assert.equal(created.publishable, true); assert.deepEqual(created.blockerCodes, []); assert.equal(created.manifest.license.termsReference, KOKORO_LICENSE_REFERENCE); assert.equal(created.manifest.provider, "kokoro_local");
});

test("missing commercial attestation remains a machine-readable publish blocker", async () => {
  const projectDir = temp(); const created = await synthesizeTtsNarration({ fixture: FIXTURE, projectDir, provider: "mock", voiceId: "fixture", commercialUseAttested: false, attestedBy: "operator_test" });
  assert.equal(created.publishable, false); assert.ok(created.blockerCodes.includes("TTS_COMMERCIAL_ATTESTATION_REQUIRED"));
});

test("audio tampering is detected and mismatched existing output requires explicit regeneration", async () => {
  const projectDir = temp(); const base = { fixture: FIXTURE, projectDir, provider: "mock", voiceId: "fixture", commercialUseAttested: true, attestedBy: "operator_test" };
  await synthesizeTtsNarration(base); const audioPath = join(projectDir, "narration.wav"); const audio = readFileSync(audioPath); audio[audio.length - 1] ^= 0xff; writeFileSync(audioPath, audio);
  await assert.rejects(() => verifyTtsNarration({ projectDir, fixture: FIXTURE }), { code: "TTS_AUDIO_TAMPERED" });
  await assert.rejects(() => synthesizeTtsNarration(base), { code: "TTS_OVERWRITE_BLOCKED" });
  const regenerated = await synthesizeTtsNarration({ ...base, regenerate: true }); assert.equal(regenerated.status, "synthesized");
  const manifestPath = join(projectDir, "narration.provenance.json"); const raw = JSON.parse(readFileSync(manifestPath, "utf8")); const scriptTampered = normalizeTtsProvenance({ ...raw, script: { ...raw.script, sha256: "f".repeat(64) }, contentHash: undefined }); writeFileSync(manifestPath, `${JSON.stringify(scriptTampered)}\n`);
  await assert.rejects(() => verifyTtsNarration({ projectDir, fixture: FIXTURE }), { code: "TTS_SCRIPT_TAMPERED" });
});

test("dry run makes no provider call and creates no artifacts", async () => {
  const projectDir = temp(); let called = false; const result = await synthesizeTtsNarration({ fixture: FIXTURE, projectDir, provider: "openai", model: "gpt-4o-mini-tts", voiceId: "coral", dryRun: true }, { createProvider: () => { called = true; } });
  assert.equal(result.status, "dry_run"); assert.equal(result.publishable, false); assert.deepEqual(result.requiredEnvironmentVariables, ["OPENAI_API_KEY"]); assert.equal(called, false); assert.equal(inspectTtsNarration(projectDir).status, "missing");
});

test("failed explicit regeneration restores the previously verified artifact pair", async () => {
  const projectDir = temp(); const base = { fixture: FIXTURE, projectDir, provider: "mock", voiceId: "fixture", commercialUseAttested: true, attestedBy: "operator_test" }; await synthesizeTtsNarration(base);
  const beforeAudio = readFileSync(join(projectDir, "narration.wav")); const beforeManifest = readFileSync(join(projectDir, "narration.provenance.json"));
  await assert.rejects(() => synthesizeTtsNarration({ ...base, regenerate: true }, { createProvider: () => { const error = new Error("provider failed"); error.code = "TTS_PROVIDER_FAILED"; throw error; } }), { code: "TTS_PROVIDER_FAILED" });
  assert.deepEqual(readFileSync(join(projectDir, "narration.wav")), beforeAudio); assert.deepEqual(readFileSync(join(projectDir, "narration.provenance.json")), beforeManifest); assert.equal((await verifyTtsNarration({ projectDir, fixture: FIXTURE })).valid, true);
});

test("release guard rejects mock, unattested, and tampered TTS while human narration remains compatible", () => {
  assert.deepEqual(evaluateTtsNarrationRelease({ rights: { ownershipBasis: "self_recorded" } }, { audioHash: "a".repeat(64) }), { applicable: false, publishable: true });
  const audioHash = "a".repeat(64); const manifest = normalizeTtsProvenance({ schemaVersion: "dark_curiosity_tts_provenance_v1", projectId: "dcp_test", runId: "tts_test", script: { path: "fixture.json", sha256: "b".repeat(64), approvalReference: "approval-test", approved: true }, provider: "mock", model: "fixture", voiceId: "fixture", language: "en", speakingRate: 1, synthesizedAt: "2026-07-12T00:00:00.000Z", license: { termsReference: "terms", commercialUseAttested: true, attestedBy: "operator" }, voiceCloned: false, impersonated: false, audio: { path: "narration.wav", sha256: audioHash, container: "wav", codec: "pcm_s16le", sampleRate: 48000, channels: 1, durationSeconds: 10, bytes: 1000, validated: true }, dryRun: false });
  assert.throws(() => evaluateTtsNarrationRelease({ rights: { ownershipBasis: "ai_generated_licensed" }, ttsProvenance: manifest }, { audioHash }), (error) => error.code === "PUBLISH_GUARD_BLOCKED" && error.details.blockerCodes[0] === "TTS_MOCK_NON_PUBLISHABLE");
  assert.throws(() => evaluateTtsNarrationRelease({ rights: { ownershipBasis: "ai_generated_licensed" }, ttsProvenance: manifest }, { audioHash: "c".repeat(64) }), (error) => error.details.blockerCodes[0] === "TTS_PROVENANCE_MISMATCH");
  const local = normalizeTtsProvenance({ ...manifest, provider: "kokoro_local", model: KOKORO_MODEL_ID, license: { ...manifest.license, termsReference: KOKORO_LICENSE_REFERENCE }, contentHash: undefined }); assert.equal(evaluateTtsNarrationRelease({ rights: { ownershipBasis: "ai_generated_licensed" }, ttsProvenance: local }, { audioHash }).publishable, true);
});

test("Kokoro bootstrap arguments are dry-run by default and mutations require authorization", async () => {
  const { parseArgs } = await import("../tools/dark-curiosity-kokoro-bootstrap.mjs"); assert.equal(parseArgs([]).dryRun, true); assert.throws(() => parseArgs(["--install-package"]), { code: "OPERATOR_AUTHORIZATION_REQUIRED" }); assert.deepEqual(parseArgs(["--download-model", "--yes"]), { installPackage: false, downloadModel: true, authorized: true, dryRun: false });
});

test("provenance schema rejects unknown fields, wrong versions, and unsafe artifact paths", () => {
  const base = { schemaVersion: "dark_curiosity_tts_provenance_v1", projectId: "dcp_test", runId: "tts_test", script: { path: "fixture.json", sha256: "b".repeat(64), approvalReference: "approval-test", approved: true }, provider: "mock", model: "fixture", voiceId: "fixture", language: "en", speakingRate: 1, synthesizedAt: "2026-07-12T00:00:00.000Z", license: { termsReference: "terms", commercialUseAttested: true, attestedBy: "operator" }, voiceCloned: false, impersonated: false, audio: { path: "narration.wav", sha256: "a".repeat(64), container: "wav", codec: "pcm_s16le", sampleRate: 48000, channels: 1, durationSeconds: 10, bytes: 1000, validated: true }, dryRun: false };
  assert.throws(() => normalizeTtsProvenance({ ...base, secret: "unexpected" }), { code: "TTS_PROVENANCE_INVALID" });
  assert.throws(() => normalizeTtsProvenance({ ...base, schemaVersion: "v2" }), { code: "TTS_PROVENANCE_INVALID" });
  assert.throws(() => normalizeTtsProvenance({ ...base, audio: { ...base.audio, path: "../narration.wav" } }), { code: "TTS_PROVENANCE_INVALID" });
});

test("CLI exposes stable dry-run JSON and a distinct missing-credential exit code", () => {
  const projectDir = temp(); const dry = spawnSync(process.execPath, ["tools/dark-curiosity-tts.mjs", "synthesize", "--fixture", FIXTURE, "--project", projectDir, "--provider", "openai", "--voice", "coral", "--dry-run", "--json"], { cwd: resolve(__dirname, ".."), encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "" } });
  assert.equal(dry.status, 0); assert.equal(JSON.parse(dry.stdout).status, "dry_run");
  const missing = spawnSync(process.execPath, ["tools/dark-curiosity-tts.mjs", "synthesize", "--fixture", FIXTURE, "--project", projectDir, "--provider", "openai", "--voice", "coral"], { cwd: resolve(__dirname, ".."), encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "" } });
  assert.equal(missing.status, 3); const output = JSON.parse(missing.stderr); assert.equal(output.code, "TTS_CREDENTIALS_MISSING"); assert.deepEqual(output.missingEnvironmentVariables, ["OPENAI_API_KEY"]);
});

test("CLI defaults to free local Kokoro for synthesis dry runs", () => {
  const projectDir = temp(); const result = spawnSync(process.execPath, ["tools/dark-curiosity-tts.mjs", "synthesize", "--fixture", FIXTURE, "--project", projectDir, "--dry-run", "--json"], { cwd: resolve(__dirname, ".."), encoding: "utf8", env: { ...process.env, SHORTSENGINE_TTS_PROVIDER: "", SHORTSENGINE_TTS_MODEL: "", SHORTSENGINE_TTS_VOICE: "" } });
  assert.equal(result.status, 0); const output = JSON.parse(result.stdout); assert.equal(output.provider, "kokoro_local"); assert.equal(output.model, KOKORO_MODEL_ID); assert.equal(output.voiceId, "af_heart"); assert.deepEqual(output.requiredEnvironmentVariables, []);
});
