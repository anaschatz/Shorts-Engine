const { AppError } = require("../../../../errors.cjs");

function error(code, message, details = null) { return new AppError(code, message, code === "TTS_CREDENTIALS_MISSING" ? 400 : 502, details); }

function createOpenAiTtsProvider(options = {}) {
  const env = options.env || process.env; const fetchImpl = options.fetch || globalThis.fetch;
  return {
    id: "openai", publishableProvider: true,
    async synthesize(request) {
      const apiKey = String(env.OPENAI_API_KEY || "").trim();
      if (!apiKey) throw error("TTS_CREDENTIALS_MISSING", "OPENAI_API_KEY is required.", { missingEnvironmentVariables: ["OPENAI_API_KEY"] });
      if (typeof fetchImpl !== "function") throw error("TTS_PROVIDER_UNAVAILABLE", "The HTTPS client is unavailable.");
      const timeoutMs = Math.max(1000, Math.min(120000, Number(env.SHORTSENGINE_TTS_TIMEOUT_MS || 60000))); const controller = options.signal ? null : new AbortController(); const signal = options.signal || controller.signal; const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      let response;
      try {
        response = await fetchImpl("https://api.openai.com/v1/audio/speech", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: request.model, input: request.script, voice: request.voiceId, response_format: "wav", speed: request.speakingRate }), signal });
      } catch (cause) { if (signal.aborted) throw error("TTS_PROVIDER_TIMEOUT", "The TTS provider request timed out."); throw error("TTS_PROVIDER_FAILED", "The TTS provider request failed."); }
      finally { if (timeout) clearTimeout(timeout); }
      if (!response || !response.ok) throw error("TTS_PROVIDER_FAILED", "The TTS provider rejected the request.", { status: Number(response && response.status || 0) });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length <= 44) throw error("TTS_AUDIO_INVALID", "The TTS provider returned empty or invalid audio.");
      return { provider: "openai", model: request.model, voiceId: request.voiceId, audioFormat: "wav", buffer, providerRequestId: response.headers && response.headers.get("x-request-id") || null };
    },
  };
}

function wavHeader(dataBytes, sampleRate = 48000) {
  const header = Buffer.alloc(44); header.write("RIFF", 0); header.writeUInt32LE(36 + dataBytes, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(dataBytes, 40); return header;
}
function deterministicMockWav(request) {
  const words = request.script.trim().split(/\s+/).length; const duration = Math.max(1.2, Math.min(120, words / (150 * request.speakingRate) * 60)); const sampleRate = 48000; const samples = Math.floor(duration * sampleRate); const pcm = Buffer.alloc(samples * 2); const seed = parseInt(request.scriptHash.slice(0, 8), 16); const frequency = 180 + seed % 220;
  for (let index = 0; index < samples; index += 1) { const envelope = Math.min(1, index / 1200, (samples - index) / 1200); pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * index / sampleRate) * 3200 * Math.max(0, envelope)), index * 2); }
  return Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
}
function createMockTtsProvider() { return { id: "mock", publishableProvider: false, async synthesize(request) { return { provider: "mock", model: request.model, voiceId: request.voiceId, audioFormat: "wav", buffer: deterministicMockWav(request), providerRequestId: `mock_${request.scriptHash.slice(0, 16)}` }; } }; }
function createKokoroTtsProvider(options = {}) { return { id: "kokoro_local", publishableProvider: true, async synthesize(request) { return require("./kokoro-runtime.cjs").synthesizeWithKokoro(request, options); } }; }
function createTtsProvider(id, options = {}) { if (id === "kokoro_local") return createKokoroTtsProvider(options); if (id === "openai") return createOpenAiTtsProvider(options); if (id === "mock") return createMockTtsProvider(options); throw error("TTS_PROVIDER_UNSUPPORTED", "The TTS provider is unsupported."); }

module.exports = { createKokoroTtsProvider, createMockTtsProvider, createOpenAiTtsProvider, createTtsProvider, deterministicMockWav };
