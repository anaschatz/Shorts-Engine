function finiteDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function safeTitle(value) {
  const title = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return title || null;
}

function createMockYouTubeIngestAdapter(options = {}) {
  const metadataByVideoId = options.metadataByVideoId && typeof options.metadataByVideoId === "object"
    ? options.metadataByVideoId
    : {};
  return {
    mode: "mock",
    enabled: false,
    networkCalls: false,
    downloaderConfigured: false,
    ingestAvailable: false,
    async getMetadata(source) {
      const metadata = metadataByVideoId[source.videoId] || {};
      const durationSeconds = finiteDuration(metadata.durationSeconds);
      return {
        title: safeTitle(metadata.title),
        durationSeconds,
        metadataStatus: durationSeconds ? "mock" : "mock-unavailable",
        ingestAvailable: false,
      };
    },
    health() {
      return {
        ready: true,
        mode: "mock",
        enabled: false,
        networkCalls: false,
        downloaderConfigured: false,
        ingestAvailable: false,
      };
    },
  };
}

module.exports = {
  createMockYouTubeIngestAdapter,
};
