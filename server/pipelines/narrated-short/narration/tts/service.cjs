const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { basename, join, relative, resolve } = require("node:path");
const { randomUUID } = require("node:crypto");
const { AppError } = require("../../../../errors.cjs");
const { createNarrationPreparation, loadFixture } = require("../../pilot/operator-tools.cjs");
const { normalizeSynthesisRequest, normalizeTtsProvenance, sha256, TTS_PROVENANCE_SCHEMA, TTS_PROVENANCE_SCHEMA_V3 } = require("./contract.cjs");
const { createTtsProvider } = require("./providers.cjs");
const { normalizeWithFfmpeg, validateNormalizedWav } = require("./audio.cjs");
const { buildPacingPlan, pacingSummary, pacingSummaryMatchesPlan } = require("./pacing-plan.cjs");

const AUDIO_FILE = "narration.wav";
const MANIFEST_FILE = "narration.provenance.json";
const REPO_ROOT = resolve(__dirname, "../../../../..");
function safeError(code, message, details = null) { return new AppError(code, message, code.includes("MISMATCH") ? 409 : 400, details); }
function atomicBuffer(path, value) { const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temp, value, { mode: 0o600 }); renameSync(temp, path); }
function atomicJson(path, value) { atomicBuffer(path, `${JSON.stringify(value, null, 2)}\n`); }
function paths(projectDir) { const root = resolve(projectDir); return { root, audio: join(root, AUDIO_FILE), manifest: join(root, MANIFEST_FILE) }; }
function scriptInfo(fixture) { const loaded = loadFixture(fixture); const preparation = createNarrationPreparation(fixture); const approved = loaded.draft.claimLedger.claims.every((claim) => claim.operatorApproved === true); return { ...loaded, preparation, approved, scriptHash: sha256(preparation.spokenText), approvalReference: `fixture:${loaded.draft.contentHash}` }; }
function pacingPlanFor(script, input = {}) {
  const provider = String(input.provider || "").toLowerCase();
  const requested = input.pacingProfile === undefined ? null : String(input.pacingProfile || "").toLowerCase();
  if (!requested || requested === "none") return null;
  if (provider !== "kokoro_local") throw safeError("TTS_PACING_INVALID", "Segmented narration pacing is supported only by the local Kokoro provider.", { provider });
  return buildPacingPlan(script.draft.script, { profile: requested });
}
function samePacing(manifest, request) {
  if (!request.pacingPlan) return !manifest.pacing;
  return manifest.schemaVersion === TTS_PROVENANCE_SCHEMA_V3
    && pacingSummaryMatchesPlan(manifest.pacing, request.pacingPlan, { requireSemanticBoundaries: true });
}

async function verifyTtsNarration(input = {}, dependencies = {}) {
  const output = paths(input.projectDir); if (!existsSync(output.manifest)) throw safeError("TTS_PROVENANCE_MISSING", "AI narration provenance is missing.");
  let raw; try { raw = JSON.parse(readFileSync(output.manifest, "utf8")); } catch { throw safeError("TTS_PROVENANCE_INVALID", "AI narration provenance is invalid."); }
  const manifest = normalizeTtsProvenance(raw);
  if (!existsSync(output.audio)) throw safeError("TTS_AUDIO_INVALID", "AI narration audio is missing.");
  const media = await validateNormalizedWav(output.audio, dependencies);
  if (media.sha256 !== manifest.audio.sha256 || media.bytes !== manifest.audio.bytes) throw safeError("TTS_AUDIO_TAMPERED", "AI narration audio does not match its provenance.");
  if (input.fixture) {
    const script = scriptInfo(input.fixture);
    if (script.scriptHash !== manifest.script.sha256 || script.approvalReference !== manifest.script.approvalReference || !script.approved) throw safeError("TTS_SCRIPT_TAMPERED", "The approved script does not match the AI narration provenance.");
    if (manifest.pacing) {
      const expectedPacing = buildPacingPlan(script.draft.script, { profile: manifest.pacing.profile });
      if (!pacingSummaryMatchesPlan(manifest.pacing, expectedPacing, { requireSemanticBoundaries: manifest.schemaVersion === TTS_PROVENANCE_SCHEMA_V3 })) throw safeError("TTS_PROVENANCE_MISMATCH", "The narration pacing does not match the approved script.");
    }
  }
  return { status: "verified", valid: true, publishable: manifest.publishable, blockerCodes: manifest.blockerCodes, manifest, audio: media };
}

async function synthesizeTtsNarration(input = {}, dependencies = {}) {
  const output = paths(input.projectDir); const script = scriptInfo(input.fixture);
  if (!script.approved) throw safeError("TTS_SCRIPT_NOT_APPROVED", "The narration script is not approved.");
  const pacingPlan = pacingPlanFor(script, input);
  const request = normalizeSynthesisRequest({ script: script.preparation.spokenText, language: script.draft.brief.language, provider: input.provider, model: input.model, voiceId: input.voiceId, speakingRate: input.speakingRate, pacingPlan, voiceCloned: input.voiceCloned, impersonated: input.impersonated });
  const plan = { status: "dry_run", provider: request.provider, model: request.model, voiceId: request.voiceId, language: request.language, speakingRate: request.speakingRate, scriptSha256: request.scriptHash, pacing: pacingSummary(request.pacingPlan), approved: true, outputFiles: [AUDIO_FILE, MANIFEST_FILE], requiredEnvironmentVariables: request.provider === "openai" ? ["OPENAI_API_KEY"] : [], publishable: false };
  if (input.dryRun) return plan;
  mkdirSync(output.root, { recursive: true, mode: 0o700 });
  if ((existsSync(output.audio) || existsSync(output.manifest)) && !input.regenerate) {
    try {
      const current = await verifyTtsNarration({ projectDir: output.root, fixture: input.fixture }, dependencies); const manifest = current.manifest;
      const same = manifest.provider === request.provider && manifest.model === request.model && manifest.voiceId === request.voiceId && manifest.language === request.language && manifest.speakingRate === request.speakingRate && manifest.script.sha256 === request.scriptHash && samePacing(manifest, request);
      if (same) return { ...current, status: "reused", reused: true };
    } catch { /* existing partial or mismatched output is handled below */ }
    throw safeError("TTS_OVERWRITE_BLOCKED", "Existing narration requires --regenerate.");
  }
  const previous = input.regenerate ? { audio: existsSync(output.audio) ? readFileSync(output.audio) : null, manifest: existsSync(output.manifest) ? readFileSync(output.manifest) : null } : null;
  const rawPath = join(output.root, `.narration-source-${process.pid}-${randomUUID()}.wav`); const normalizedPath = join(output.root, `.narration-normalized-${process.pid}-${randomUUID()}.wav`);
  try {
    const provider = (dependencies.createProvider || createTtsProvider)(request.provider, { env: dependencies.env || process.env, fetch: dependencies.fetch, signal: input.signal });
    const result = await provider.synthesize(request);
    if (!result || !Buffer.isBuffer(result.buffer) || result.buffer.length <= 44) throw safeError("TTS_AUDIO_INVALID", "The TTS provider returned invalid audio.");
    if (result.provider !== request.provider || result.model !== request.model || result.voiceId !== request.voiceId || result.audioFormat !== "wav") throw safeError("TTS_PROVIDER_FAILED", "The TTS provider response did not match the synthesis request.");
    writeFileSync(rawPath, result.buffer, { mode: 0o600 });
    (dependencies.normalizeWithFfmpeg || normalizeWithFfmpeg)(rawPath, normalizedPath, dependencies);
    const media = await validateNormalizedWav(normalizedPath, dependencies);
    const synthesizedAt = (dependencies.now || (() => new Date()))().toISOString();
    const projectId = input.projectId || `dcp_${script.draft.contentHash.slice(0, 24)}`;
    const defaultTerms = request.provider === "kokoro_local" ? require("./kokoro-runtime.cjs").KOKORO_LICENSE_REFERENCE : "operator-attestation:provider-terms-reviewed";
    const manifest = normalizeTtsProvenance({ schemaVersion: TTS_PROVENANCE_SCHEMA, projectId, runId: `tts_${sha256(`${request.scriptHash}:${request.provider}:${request.model}:${request.voiceId}:${request.speakingRate}:${request.pacingHash || "unpaced"}`).slice(0, 32)}`, script: { path: relative(REPO_ROOT, script.path) || basename(script.path), sha256: request.scriptHash, approvalReference: script.approvalReference, approved: true }, provider: result.provider, model: result.model, voiceId: result.voiceId, language: request.language, speakingRate: request.speakingRate, pacing: pacingSummary(request.pacingPlan), synthesizedAt, providerRequestId: result.providerRequestId || null, license: { termsReference: input.termsReference || defaultTerms, commercialUseAttested: input.commercialUseAttested === true, attestedBy: input.attestedBy || "local_operator" }, voiceCloned: false, impersonated: false, audio: { path: AUDIO_FILE, ...media }, dryRun: false });
    renameSync(normalizedPath, output.audio); atomicJson(output.manifest, manifest);
    return { status: "synthesized", reused: false, publishable: manifest.publishable, blockerCodes: manifest.blockerCodes, manifestPath: output.manifest, audioPath: output.audio, manifest };
  } catch (error) {
    rmSync(normalizedPath, { force: true });
    if (previous) { if (previous.audio) atomicBuffer(output.audio, previous.audio); else rmSync(output.audio, { force: true }); if (previous.manifest) atomicBuffer(output.manifest, previous.manifest); else rmSync(output.manifest, { force: true }); }
    else if (!existsSync(output.manifest)) rmSync(output.audio, { force: true });
    throw error;
  } finally { rmSync(rawPath, { force: true }); rmSync(normalizedPath, { force: true }); }
}

function inspectTtsNarration(projectDir) {
  const output = paths(projectDir); if (!existsSync(output.manifest)) return { status: "missing", valid: false, publishable: false, blockerCodes: ["TTS_PROVENANCE_MISSING"] };
  try { const manifest = normalizeTtsProvenance(JSON.parse(readFileSync(output.manifest, "utf8"))); return { status: "present", valid: true, publishable: manifest.publishable, blockerCodes: manifest.blockerCodes, manifest }; } catch (error) { return { status: "invalid", valid: false, publishable: false, blockerCodes: [String(error.code || "TTS_PROVENANCE_INVALID")] }; }
}

module.exports = { AUDIO_FILE, MANIFEST_FILE, inspectTtsNarration, pacingPlanFor, paths, scriptInfo, synthesizeTtsNarration, verifyTtsNarration };
