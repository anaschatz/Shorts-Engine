const { readFileSync } = require("node:fs");
const { basename } = require("node:path");
const { CONFIG } = require("./config.cjs");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");

class TranscriptionProvider {
  async transcribe() {
    throw new Error("transcribe() must be implemented");
  }
}

class MockTranscriptionProvider extends TranscriptionProvider {
  async transcribe({ metadata, preset = "hype", language = "auto" }) {
    const duration = Math.min(Number(metadata.durationSeconds || 18), 18);
    const cueTexts = {
      hype: ["The pressure jumps", "The build-up is clean", "Watch the next touch", "This is the key phase"],
      drama: ["Everything changes here", "One pass opens the game", "The stadium reacts", "Replay this angle"],
      tactical: ["Look at the run", "The passing lane opens", "The defender steps late", "That is the pattern"],
      fan: ["The crowd reacts", "Look at the pressure", "That first touch matters", "Run this phase back"],
    };
    const lines = cueTexts[preset] || cueTexts.hype;
    const segment = Math.max(1.6, duration / lines.length);
    const captions = lines.map((text, index) => ({
      start: Number((index * segment).toFixed(2)),
      end: Number(Math.min(duration, index * segment + segment - 0.15).toFixed(2)),
      text,
    }));
    return {
      provider: "mock",
      language: normalizeLanguageCode(language) || "auto",
      text: captions.map((caption) => caption.text).join(" "),
      segments: captions,
      captions,
    };
  }
}

class OpenAITranscriptionProvider extends TranscriptionProvider {
  constructor({ apiKey, model, fetchImpl, timeoutMs, retries }) {
    super();
    this.apiKey = apiKey;
    this.model = model || process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.timeoutMs = Number(timeoutMs || CONFIG.transcriptionTimeoutMs);
    this.retries = Math.max(0, Number(retries ?? CONFIG.transcriptionRetries) || 0);
  }

  async transcribe({ audioPath, language = "auto" }) {
    if (!this.apiKey) throw new AppError("TRANSCRIPTION_FAILED", SAFE_MESSAGES.TRANSCRIPTION_FAILED, 503);
    if (typeof this.fetchImpl !== "function" || typeof FormData !== "function" || typeof Blob !== "function") {
      throw new AppError("TRANSCRIPTION_FAILED", SAFE_MESSAGES.TRANSCRIPTION_FAILED, 503);
    }
    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        return await this.requestTranscription({ audioPath, language });
      } catch (error) {
        lastError = error;
        if (error.code === "TRANSCRIPTION_TIMEOUT" || attempt >= this.retries) break;
      }
    }
    throw lastError instanceof AppError
      ? lastError
      : new AppError("TRANSCRIPTION_FAILED", SAFE_MESSAGES.TRANSCRIPTION_FAILED, 503);
  }

  async requestTranscription({ audioPath, language }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      const form = new FormData();
      form.append("model", this.model);
      form.append("file", new Blob([readFileSync(audioPath)]), basename(audioPath));
      form.append("response_format", "verbose_json");
      const languageCode = normalizeLanguageCode(language);
      if (languageCode && languageCode !== "auto") form.append("language", languageCode);
      response = await this.fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error && error.name === "AbortError") {
        throw new AppError("TRANSCRIPTION_TIMEOUT", SAFE_MESSAGES.TRANSCRIPTION_TIMEOUT, 504);
      }
      throw new AppError("TRANSCRIPTION_FAILED", SAFE_MESSAGES.TRANSCRIPTION_FAILED, 503);
    }
    clearTimeout(timeout);
    if (!response || !response.ok) {
      throw new AppError("TRANSCRIPTION_FAILED", SAFE_MESSAGES.TRANSCRIPTION_FAILED, 503, {
        status: response && response.status,
      });
    }
    const json = await response.json().catch(() => {
      throw new AppError("TRANSCRIPTION_FAILED", SAFE_MESSAGES.TRANSCRIPTION_FAILED, 503);
    });
    const rawSegments = Array.isArray(json.segments) ? json.segments : [];
    const segments = rawSegments.slice(0, 60).map((segment) => ({
      start: Number(segment.start || 0),
      end: Number(segment.end || Number(segment.start || 0) + 1.5),
      text: sanitizeText(segment.text, 160),
    })).filter((segment) => segment.text && segment.end > segment.start);
    const fallbackText = sanitizeText(json.text || "", 4000);
    const captions = segments.length
      ? segments.slice(0, 16)
      : fallbackText
          .split(/[.!?]+/)
          .map((text, index) => ({
            start: index * 2,
            end: index * 2 + 1.7,
            text: sanitizeText(text, 120),
          }))
          .filter((segment) => segment.text)
          .slice(0, 8);
    return {
      provider: "openai",
      language: sanitizeText(json.language || "auto", 24),
      text: fallbackText,
      segments,
      captions,
    };
  }
}

function normalizeLanguageCode(language) {
  const value = sanitizeText(language, 32).toLowerCase();
  if (!value || value === "auto") return "auto";
  if (value.includes("ελλην") || value === "el" || value === "greek") return "el";
  if (value.includes("english") || value === "en") return "en";
  if (value.includes("spanish") || value === "es") return "es";
  if (value.includes("arabic") || value === "ar") return "ar";
  return "auto";
}

function chooseTranscriptionProvider(options = {}) {
  if (!options.forceMock && process.env.MATCHCUTS_TRANSCRIPTION_PROVIDER === "openai" && process.env.OPENAI_API_KEY) {
    return new OpenAITranscriptionProvider({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_TRANSCRIPTION_MODEL,
    });
  }
  return new MockTranscriptionProvider();
}

function transcriptionHealth() {
  const requested = sanitizeText(process.env.MATCHCUTS_TRANSCRIPTION_PROVIDER || "mock", 40).toLowerCase();
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
  const activeProvider = requested === "openai" && openaiConfigured ? "openai" : "mock";
  return {
    requestedProvider: requested,
    activeProvider,
    ready: activeProvider === "mock" || openaiConfigured,
    fallback: activeProvider === "mock" && requested === "openai" && !openaiConfigured,
    supportsSegments: true,
  };
}

module.exports = {
  TranscriptionProvider,
  MockTranscriptionProvider,
  OpenAITranscriptionProvider,
  chooseTranscriptionProvider,
  normalizeLanguageCode,
  transcriptionHealth,
};
