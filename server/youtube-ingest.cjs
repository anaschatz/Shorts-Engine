const { URL } = require("node:url");
const { CONFIG } = require("./config.cjs");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");

const MAX_YOUTUBE_URL_LENGTH = 2048;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

function fail(code, status = 400) {
  throw new AppError(code, SAFE_MESSAGES[code], status);
}

function cleanInputUrl(value) {
  if (typeof value !== "string") fail("YOUTUBE_URL_INVALID");
  const raw = value.trim();
  if (!raw || raw.length > MAX_YOUTUBE_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) {
    fail("YOUTUBE_URL_INVALID");
  }
  return raw;
}

function normalizedHostname(hostname) {
  return String(hostname || "").toLowerCase().replace(/\.$/, "");
}

function validateVideoId(value) {
  const id = String(value || "").trim();
  return VIDEO_ID_PATTERN.test(id) ? id : null;
}

function pathSegments(pathname) {
  return String(pathname || "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function parseYouTubeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail("YOUTUBE_URL_INVALID");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) fail("YOUTUBE_URL_INVALID");
  if (parsed.username || parsed.password) fail("YOUTUBE_URL_INVALID");
  const host = normalizedHostname(parsed.hostname);
  const segments = pathSegments(parsed.pathname);
  if (parsed.searchParams.has("list") || segments[0] === "playlist") fail("YOUTUBE_PLAYLIST_UNSUPPORTED");
  if (segments[0] === "live" || parsed.searchParams.get("live") === "1") fail("YOUTUBE_LIVE_UNSUPPORTED");

  if (host === "youtu.be") {
    return {
      kind: "shortlink",
      videoId: validateVideoId(segments[0]),
    };
  }
  if (!YOUTUBE_HOSTS.has(host)) fail("YOUTUBE_URL_INVALID");
  if (segments.length === 0 || segments[0] === "watch") {
    return {
      kind: "watch",
      videoId: validateVideoId(parsed.searchParams.get("v")),
    };
  }
  if (segments[0] === "shorts") {
    return {
      kind: "shorts",
      videoId: validateVideoId(segments[1]),
    };
  }
  fail("YOUTUBE_URL_INVALID");
}

function normalizeYouTubeUrl(value) {
  const parsed = parseYouTubeUrl(cleanInputUrl(value));
  if (!parsed.videoId) fail("YOUTUBE_URL_INVALID");
  return {
    sourceType: "youtube",
    kind: parsed.kind,
    videoId: parsed.videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${parsed.videoId}`,
  };
}

function safeMetadata(metadata = {}) {
  const duration = Number(metadata.durationSeconds);
  return {
    title: metadata.title ? String(metadata.title).slice(0, 120) : null,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    metadataStatus: String(metadata.metadataStatus || "unavailable").slice(0, 40),
    ingestAvailable: metadata.ingestAvailable === true,
  };
}

function validateRightsConfirmed(value) {
  if (value !== true) fail("YOUTUBE_RIGHTS_REQUIRED");
}

async function readAdapterMetadata(adapter, source) {
  if (!adapter || typeof adapter.getMetadata !== "function") return safeMetadata();
  try {
    return safeMetadata(await adapter.getMetadata(source));
  } catch {
    fail("YOUTUBE_INGEST_NOT_ENABLED", 503);
  }
}

async function validateYouTubeSource(input = {}) {
  validateRightsConfirmed(input.rightsConfirmed);
  const source = normalizeYouTubeUrl(input.url);
  const adapter = input.adapter;
  const maxDurationSeconds = Number(input.maxDurationSeconds || CONFIG.maxDurationSeconds);
  const metadata = await readAdapterMetadata(adapter, source);
  const health = youtubeIngestHealth(adapter);
  if (metadata.durationSeconds && metadata.durationSeconds > maxDurationSeconds) {
    fail("YOUTUBE_DURATION_TOO_LONG");
  }
  const ingestAvailable = Boolean(health.ingestAvailable || metadata.ingestAvailable);
  return {
    ...source,
    title: metadata.title,
    durationSeconds: metadata.durationSeconds,
    metadataStatus: metadata.metadataStatus,
    ingestAvailable,
    downloaderConfigured: Boolean(health.downloaderConfigured),
    nextAction: ingestAvailable ? "youtube-ingest-ready" : "youtube-ingest-disabled-until-mp4-artifact-exists",
  };
}

function youtubeIngestHealth(adapter) {
  if (!adapter || typeof adapter.health !== "function") {
    return {
      ready: true,
      mode: "mock",
      enabled: false,
      networkCalls: false,
      downloaderConfigured: false,
      ingestAvailable: false,
    };
  }
  let health = null;
  try {
    health = adapter.health();
  } catch {
    return {
      ready: false,
      mode: "unknown",
      enabled: false,
      networkCalls: false,
      downloaderConfigured: false,
      ingestAvailable: false,
    };
  }
  if (!health || typeof health !== "object" || Array.isArray(health)) {
    return {
      ready: false,
      mode: "unknown",
      enabled: false,
      networkCalls: false,
      downloaderConfigured: false,
      ingestAvailable: false,
    };
  }
  const mode = safeHealthMode(health.mode);
  const ready = strictHealthBoolean(health, "ready");
  const enabled = strictHealthBoolean(health, "enabled");
  const networkCalls = strictHealthBoolean(health, "networkCalls");
  const downloaderConfigured = strictHealthBoolean(health, "downloaderConfigured");
  const ingestAvailable = strictHealthBoolean(health, "ingestAvailable");
  if ([ready, enabled, networkCalls, downloaderConfigured, ingestAvailable].some((value) => value === null)) {
    return {
      ready: false,
      mode,
      enabled: false,
      networkCalls: false,
      downloaderConfigured: false,
      ingestAvailable: false,
    };
  }
  return {
    ready,
    mode,
    enabled,
    networkCalls,
    downloaderConfigured,
    ingestAvailable: Boolean(ready && enabled && downloaderConfigured && ingestAvailable),
  };
}

function safeHealthMode(value) {
  const mode = String(value || "unknown").trim().toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(mode) ? mode : "unknown";
}

function strictHealthBoolean(health, key) {
  if (!Object.prototype.hasOwnProperty.call(health, key)) return null;
  return typeof health[key] === "boolean" ? health[key] : null;
}

module.exports = {
  MAX_YOUTUBE_URL_LENGTH,
  normalizeYouTubeUrl,
  validateYouTubeSource,
  youtubeIngestHealth,
};
