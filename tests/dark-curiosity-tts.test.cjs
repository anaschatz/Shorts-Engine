const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");

const { TTS_PROVENANCE_SCHEMA_V2, TTS_PROVENANCE_SCHEMA_V3, normalizeSynthesisRequest, normalizeTtsProvenance, sha256 } = require("../server/pipelines/narrated-short/narration/tts/contract.cjs");
const { createKokoroTtsProvider, createMockTtsProvider, createOpenAiTtsProvider, deterministicMockWav } = require("../server/pipelines/narrated-short/narration/tts/providers.cjs");
const { KOKORO_LICENSE_REFERENCE, KOKORO_MODEL_ID, doctor: kokoroDoctor } = require("../server/pipelines/narrated-short/narration/tts/kokoro-runtime.cjs");
const { inspectTtsNarration, pacingPlanFor, scriptInfo, synthesizeTtsNarration, verifyTtsNarration } = require("../server/pipelines/narrated-short/narration/tts/service.cjs");
const { DARK_CURIOSITY_COMPREHENSION_PROFILE, GENERIC_ROLE_PACING, MAX_PLAN_SEGMENTS, PROFILE_SEGMENTS, buildPacingPlan, normalizePacingPlan, pacingSummary } = require("../server/pipelines/narrated-short/narration/tts/pacing-plan.cjs");
const { evaluateTtsNarrationRelease } = require("../server/pipelines/narrated-short/publish/publish-guard.cjs");

const FIXTURE = resolve(__dirname, "..", "eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json");
const GPS_FIXTURE = resolve(__dirname, "..", "eval/narrated/dark-curiosity/fixtures/002_gps_week_rollover.json");
const BAYCHIMO_FIXTURE = resolve(__dirname, "..", "eval/narrated/dark-curiosity/fixtures/003_baychimo_icebound_drift.json");
const dirs = []; function temp() { const value = mkdtempSync(join(tmpdir(), "dark-tts-")); dirs.push(value); return value; }
test.after(() => dirs.forEach((value) => rmSync(value, { recursive: true, force: true })));

function fiveBeatScript(texts, idSuffix = "") {
  const roles = ["hook", "context", "evidence", "turn", "payoff"];
  return {
    beats: roles.map((role, index) => ({
      id: `beat_${role}${idSuffix}`,
      role,
      spokenText: texts[index],
    })),
  };
}

const TIMESTAMP_SCRIPT = fiveBeatScript([
  "In 1994, a desert receiver printed a message carrying tomorrow's date before midnight had passed.",
  "The paper log showed today's receipt time beside a header dated exactly one day later.",
  "The station clock and the printed timestamp disagreed, while the original recorder showed no obvious interruption.",
  "Later tests repeated the same window, but none produced another message from the following day.",
  "The timestamp remains unexplained, but one anomalous date is not evidence that information travelled backward.",
]);

test("provider-neutral request rejects cloned, impersonated, custom production voices, and invalid rates", () => {
  const base = { script: "Approved exact script.", provider: "openai", model: "gpt-4o-mini-tts", voiceId: "coral", language: "en", speakingRate: 1 };
  assert.equal(normalizeSynthesisRequest(base).scriptHash, sha256(base.script));
  assert.throws(() => normalizeSynthesisRequest({ ...base, voiceCloned: true }), { code: "TTS_VOICE_PROHIBITED" });
  assert.throws(() => normalizeSynthesisRequest({ ...base, impersonated: true }), { code: "TTS_VOICE_PROHIBITED" });
  assert.throws(() => normalizeSynthesisRequest({ ...base, voiceId: "voice_custom" }), { code: "TTS_VOICE_PROHIBITED" });
  assert.throws(() => normalizeSynthesisRequest({ ...base, speakingRate: 5 }), { code: "TTS_PROVENANCE_INVALID" });
});

test("comprehension pacing is exact, hash-bound, and covers every approved word once", () => {
  const script = scriptInfo(FIXTURE);
  const plan = buildPacingPlan(script.draft.script);
  assert.equal(plan.profile, DARK_CURIOSITY_COMPREHENSION_PROFILE);
  assert.equal(plan.contentHash, "9cdeec57c2e5691b89b7e258785e59c80c249de035dce53964b69ad6755b3f3e");
  assert.equal(plan.segments.length, 11);
  assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.segments), true); assert.equal(Object.isFrozen(plan.segments[0]), true);
  assert.equal(plan.totalPauseMs, 4680);
  assert.deepEqual(plan.segments.map((segment) => segment.pauseAfterMs), [600, 500, 100, 180, 600, 80, 200, 650, 450, 120, 1200]);
  assert.deepEqual(plan.segments.map(({ text, speakingRate, pauseAfterMs }) => ({ text, speakingRate, pauseAfterMs })), PROFILE_SEGMENTS.map(({ text, speakingRate, pauseAfterMs }) => ({ text, speakingRate, pauseAfterMs })));
  assert.equal(plan.segments[0].wordStartIndex, 0);
  assert.equal(plan.segments.at(-1).wordEndIndex, 81);
  assert.equal(plan.segments.map((segment) => segment.text).join(" "), script.preparation.spokenText);
  assert.equal(normalizePacingPlan(plan, { script: script.preparation.spokenText }).contentHash, plan.contentHash);
  const request = normalizeSynthesisRequest({ script: script.preparation.spokenText, provider: "kokoro_local", voiceId: "af_heart", pacingPlan: plan });
  assert.equal(request.pacingHash, plan.contentHash);
  assert.equal(request.pacingPlan.segments.length, 11);
  const providerNeutral = normalizeSynthesisRequest({ script: script.preparation.spokenText, provider: "mock", voiceId: "fixture", pacingPlan: plan });
  assert.equal(providerNeutral.pacingHash, request.pacingHash);

  const reordered = structuredClone(plan); delete reordered.contentHash; [reordered.segments[2], reordered.segments[3]] = [reordered.segments[3], reordered.segments[2]];
  assert.throws(() => normalizePacingPlan(reordered, { script: script.preparation.spokenText }), { code: "TTS_PACING_INVALID" });
  const missing = structuredClone(plan); delete missing.contentHash; const [removed] = missing.segments.splice(4, 1); missing.totalPauseMs -= removed.pauseAfterMs;
  assert.throws(() => normalizePacingPlan(missing, { script: script.preparation.spokenText }), { code: "TTS_PACING_INVALID" });
  const changedPause = structuredClone(plan); delete changedPause.contentHash; changedPause.segments[0].pauseAfterMs += 1; changedPause.totalPauseMs += 1;
  assert.notEqual(normalizePacingPlan(changedPause, { script: script.preparation.spokenText }).contentHash, plan.contentHash);
});

test("generic comprehension pacing follows five-beat semantics without depending on Wow wording", () => {
  const first = buildPacingPlan(TIMESTAMP_SCRIPT);
  const second = buildPacingPlan(structuredClone(TIMESTAMP_SCRIPT));
  assert.deepEqual(first, second);
  assert.equal(first.segments.length, 5);
  assert.equal(first.totalPauseMs, 2670);
  assert.deepEqual(first.segments.map((segment) => segment.id), [
    "hook_01", "context_01", "evidence_01", "turn_01", "payoff_01",
  ]);
  assert.deepEqual(first.segments.map((segment) => segment.text), [
    "In 1994, a desert receiver printed a message carrying tomorrow's date before midnight had passed.",
    "The paper log showed today's receipt time beside a header dated exactly one day later.",
    "The station clock and the printed timestamp disagreed, while the original recorder showed no obvious interruption.",
    "Later tests repeated the same window, but none produced another message from the following day.",
    "The timestamp remains unexplained, but one anomalous date is not evidence that information travelled backward.",
  ]);
  assert.deepEqual(first.segments.map((segment) => segment.pauseAfterMs), [450, 350, 450, 520, 900]);
  for (const beat of TIMESTAMP_SCRIPT.beats) {
    const segments = first.segments.filter((segment) => segment.beatId === beat.id);
    assert.ok(segments.length >= 1 && segments.length <= 3);
    assert.ok(segments.every((segment) => segment.speakingRate === GENERIC_ROLE_PACING[beat.role].speakingRate));
  }
  const spokenText = TIMESTAMP_SCRIPT.beats.map((beat) => beat.spokenText).join(" ");
  assert.equal(first.segments.map((segment) => segment.text).join(" "), spokenText);
  assert.equal(normalizePacingPlan(first, { script: spokenText }).contentHash, first.contentHash);
  assert.deepEqual(pacingPlanFor({ draft: { script: TIMESTAMP_SCRIPT } }, { provider: "kokoro_local", pacingProfile: DARK_CURIOSITY_COMPREHENSION_PROFILE }), first);

  const paraphrase = structuredClone(TIMESTAMP_SCRIPT);
  paraphrase.beats[4].spokenText = "The timestamp is unresolved, yet a single date mismatch cannot demonstrate backward communication.";
  assert.notEqual(buildPacingPlan(paraphrase).contentHash, first.contentHash);
});

test("generic pacing stays bounded and deterministic for punctuation-dense five-beat scripts", () => {
  const denseBeat = Array.from({ length: 10 }, (_value, index) => `idea${index + 1} remains open${index === 9 ? "." : ","}`).join(" ");
  const script = fiveBeatScript(Array.from({ length: 5 }, () => denseBeat), "-dense");
  const plan = buildPacingPlan(script);
  assert.equal(plan.segments.length, 10);
  assert.ok(plan.segments.length <= MAX_PLAN_SEGMENTS);
  assert.deepEqual(plan, buildPacingPlan(structuredClone(script)));
  for (const beat of script.beats) assert.equal(plan.segments.filter((segment) => segment.beatId === beat.id).length, 2);
  assert.equal(plan.segments.map((segment) => segment.text).join(" "), script.beats.map((beat) => beat.spokenText).join(" "));
});

test("real GPS and Baychimo scripts keep short clauses connected and avoid payoff micro-fragments", () => {
  const cases = [
    { name: "GPS", path: GPS_FIXTURE },
    { name: "Baychimo", path: BAYCHIMO_FIXTURE },
  ];
  for (const fixtureCase of cases) {
    const script = JSON.parse(readFileSync(fixtureCase.path, "utf8")).script;
    const plan = buildPacingPlan(script);
    assert.deepEqual(plan, buildPacingPlan(structuredClone(script)), `${fixtureCase.name} pacing must be deterministic`);
    assert.equal(plan.segments.map((segment) => segment.text).join(" "), script.beats.map((beat) => beat.spokenText).join(" "));
    for (const beat of script.beats) {
      const segments = plan.segments.filter((segment) => segment.beatId === beat.id);
      assert.ok(segments.length >= 1 && segments.length <= 3, `${fixtureCase.name} ${beat.role} must use one to three segments`);
      if (beat.spokenText.split(/\s+/).length <= 18) {
        assert.equal(segments.length, 1, `${fixtureCase.name} ${beat.role} must not split a short beat`);
      }
      assert.ok(segments.every((segment) => segment.text.split(/\s+/).length >= 3), `${fixtureCase.name} ${beat.role} must not create micro-fragments`);
    }
    const payoffSegments = plan.segments.filter((segment) => segment.beatId === "beat_payoff");
    assert.equal(payoffSegments.length, 1, `${fixtureCase.name} payoff must remain a single thought`);
  }
});

test("clause starters without punctuation do not create gaps inside short beats", () => {
  const script = fiveBeatScript([
    "A receiver warmed slowly and its status light remained steady.",
    "The operator watched as the final check completed normally.",
    "The record stayed open but no second anomaly appeared.",
    "The team waited while another receiver repeated the same test.",
    "The mystery remains and the evidence still sets a clear limit.",
  ], "-short-clauses");
  const plan = buildPacingPlan(script);
  assert.equal(plan.segments.length, 5);
  assert.deepEqual(plan.segments.map((segment) => segment.text), script.beats.map((beat) => beat.spokenText));
  assert.ok(plan.segments.every((segment) => !/^(?:and|as)\b/i.test(segment.text)));
});

test("comprehension pacing rejects noncanonical five-beat shape before synthesis", () => {
  const missing = structuredClone(TIMESTAMP_SCRIPT); missing.beats.pop();
  assert.throws(() => buildPacingPlan(missing), (error) => error.code === "TTS_PACING_INVALID" && error.details.expectedBeatCount === 5);
  const reordered = structuredClone(TIMESTAMP_SCRIPT); [reordered.beats[1], reordered.beats[2]] = [reordered.beats[2], reordered.beats[1]];
  assert.throws(() => buildPacingPlan(reordered), (error) => error.code === "TTS_PACING_INVALID" && error.details.expectedRole === "context");
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
  const projectDir = temp(); const input = { fixture: FIXTURE, projectDir, provider: "kokoro_local", voiceId: "af_heart", pacingProfile: DARK_CURIOSITY_COMPREHENSION_PROFILE, commercialUseAttested: true, attestedBy: "operator_test" }; const created = await synthesizeTtsNarration(input, { createProvider: () => ({ async synthesize(request) { return { provider: "kokoro_local", model: request.model, voiceId: request.voiceId, audioFormat: "wav", buffer: deterministicMockWav(request), providerRequestId: "local_test" }; } }) });
  assert.equal(created.publishable, true); assert.deepEqual(created.blockerCodes, []); assert.equal(created.manifest.license.termsReference, KOKORO_LICENSE_REFERENCE); assert.equal(created.manifest.provider, "kokoro_local");
  assert.equal(created.manifest.schemaVersion, TTS_PROVENANCE_SCHEMA_V3); assert.deepEqual(created.manifest.pacing, pacingSummary(buildPacingPlan(scriptInfo(FIXTURE).draft.script)));
  assert.equal((await verifyTtsNarration({ projectDir, fixture: FIXTURE })).manifest.pacing.planHash, created.manifest.pacing.planHash);
  const legacyV2 = normalizeTtsProvenance({ ...created.manifest, schemaVersion: TTS_PROVENANCE_SCHEMA_V2, pacing: { profile: created.manifest.pacing.profile, planHash: created.manifest.pacing.planHash, segmentCount: created.manifest.pacing.segmentCount, totalPauseMs: created.manifest.pacing.totalPauseMs }, contentHash: undefined });
  writeFileSync(join(projectDir, "narration.provenance.json"), `${JSON.stringify(legacyV2)}\n`);
  assert.equal((await verifyTtsNarration({ projectDir, fixture: FIXTURE })).manifest.schemaVersion, TTS_PROVENANCE_SCHEMA_V2);
  await assert.rejects(() => synthesizeTtsNarration(input), { code: "TTS_OVERWRITE_BLOCKED" });
});

test("generic Kokoro synthesis remains unpaced unless the caller explicitly opts in", async () => {
  const projectDir = temp();
  const created = await synthesizeTtsNarration({ fixture: FIXTURE, projectDir, provider: "kokoro_local", voiceId: "af_heart", commercialUseAttested: true, attestedBy: "operator_test" }, { createProvider: () => ({ async synthesize(request) { assert.equal(request.pacingPlan, null); return { provider: "kokoro_local", model: request.model, voiceId: request.voiceId, audioFormat: "wav", buffer: deterministicMockWav(request), providerRequestId: "local_unpaced_test" }; } }) });
  assert.equal(created.manifest.schemaVersion, TTS_PROVENANCE_SCHEMA_V3);
  assert.equal(created.manifest.pacing, null);
  assert.equal((await synthesizeTtsNarration({ fixture: FIXTURE, projectDir, provider: "kokoro_local", voiceId: "af_heart", commercialUseAttested: true, attestedBy: "operator_test" })).status, "reused");
});

test("segmented Kokoro helper trims deterministic edges and inserts exact zero-sample pauses", () => {
  const root = temp();
  const fakeModule = join(root, "kokoro_onnx.py");
  const modelPath = join(root, "model.onnx");
  const voicesPath = join(root, "voices.bin");
  const firstPath = join(root, "first.wav");
  const secondPath = join(root, "second.wav");
  writeFileSync(modelPath, "model"); writeFileSync(voicesPath, "voices");
  writeFileSync(fakeModule, [
    "from array import array",
    "class Kokoro:",
    "    instances = 0",
    "    def __init__(self, model, voices):",
    "        Kokoro.instances += 1",
    "        if Kokoro.instances != 1: raise RuntimeError('model loaded twice')",
    "    def create(self, text, voice, speed, lang):",
    "        active = max(240, round(480 / speed))",
    "        return array('f', [0.0] * 1500 + [0.25] * active + [0.0] * 1500), 24000",
    "",
  ].join("\n"));
  const segments = [{ text: "First segment.", speed: 0.9, pauseAfterMs: 350 }, { text: "Second segment.", speed: 0.94, pauseAfterMs: 1200 }];
  const run = (outputPath) => spawnSync("python3", [resolve(__dirname, "..", "tools/dark-curiosity-kokoro-synthesize.py")], { encoding: "utf8", timeout: 30000, input: JSON.stringify({ segments, voice: "af_heart", language: "en", modelPath, voicesPath, outputPath }), env: { ...process.env, PYTHONPATH: root } });
  const first = run(firstPath); const second = run(secondPath);
  assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr);
  const result = JSON.parse(first.stdout); assert.equal(result.segmentCount, 2); assert.equal(result.totalPauseMs, 1550); assert.equal(result.totalPauseSamples, 37200); assert.equal(result.pauseRanges.length, 2);
  const firstWav = readFileSync(firstPath); const secondWav = readFileSync(secondPath); assert.deepEqual(firstWav, secondWav); assert.equal(firstWav.subarray(0, 4).toString("ascii"), "RIFF"); assert.equal(firstWav.readUInt32LE(24), 24000);
  for (const range of result.pauseRanges) {
    const samples = firstWav.subarray(44 + range.startSample * 2, 44 + (range.startSample + range.sampleCount) * 2);
    assert.equal(samples.length, range.sampleCount * 2);
    assert.ok(samples.every((byte) => byte === 0));
  }
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
  await assert.rejects(() => synthesizeTtsNarration({ fixture: FIXTURE, projectDir, provider: "openai", model: "gpt-4o-mini-tts", voiceId: "coral", pacingProfile: DARK_CURIOSITY_COMPREHENSION_PROFILE, dryRun: true }), { code: "TTS_PACING_INVALID" });
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

test("CLI defaults to free unpaced local Kokoro and requires an explicit Wow pacing opt-in", () => {
  const projectDir = temp(); const result = spawnSync(process.execPath, ["tools/dark-curiosity-tts.mjs", "synthesize", "--fixture", FIXTURE, "--project", projectDir, "--dry-run", "--json"], { cwd: resolve(__dirname, ".."), encoding: "utf8", env: { ...process.env, SHORTSENGINE_TTS_PROVIDER: "", SHORTSENGINE_TTS_MODEL: "", SHORTSENGINE_TTS_VOICE: "" } });
  assert.equal(result.status, 0); const output = JSON.parse(result.stdout); assert.equal(output.provider, "kokoro_local"); assert.equal(output.model, KOKORO_MODEL_ID); assert.equal(output.voiceId, "af_heart"); assert.deepEqual(output.requiredEnvironmentVariables, []); assert.equal(output.pacing, null);
  const paced = spawnSync(process.execPath, ["tools/dark-curiosity-tts.mjs", "synthesize", "--fixture", FIXTURE, "--project", projectDir, "--pacing-profile", DARK_CURIOSITY_COMPREHENSION_PROFILE, "--dry-run", "--json"], { cwd: resolve(__dirname, ".."), encoding: "utf8" });
  assert.equal(paced.status, 0); const pacedOutput = JSON.parse(paced.stdout); assert.equal(pacedOutput.pacing.profile, DARK_CURIOSITY_COMPREHENSION_PROFILE); assert.equal(pacedOutput.pacing.segmentCount, 11); assert.equal(pacedOutput.pacing.totalPauseMs, 4680); assert.equal(pacedOutput.pacing.semanticBoundaryWordIndices.length, 10);
});
