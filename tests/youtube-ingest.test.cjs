const test = require("node:test");
const assert = require("node:assert/strict");

const { createMockYouTubeIngestAdapter } = require("../server/adapters/mock-youtube-ingest-adapter.cjs");
const { normalizeYouTubeUrl, validateYouTubeSource, youtubeIngestHealth } = require("../server/youtube-ingest.cjs");

test("youtube url normalization accepts supported video formats", () => {
  assert.deepEqual(normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), {
    sourceType: "youtube",
    kind: "watch",
    videoId: "dQw4w9WgXcQ",
    canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  assert.equal(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ").kind, "shortlink");
  assert.equal(normalizeYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ").kind, "shorts");
});

test("youtube url normalization rejects unsupported and unsafe urls", () => {
  assert.throws(() => normalizeYouTubeUrl("https://vimeo.com/123"), (error) => error.code === "YOUTUBE_URL_INVALID");
  assert.throws(() => normalizeYouTubeUrl("javascript:alert(1)"), (error) => error.code === "YOUTUBE_URL_INVALID");
  assert.throws(
    () => normalizeYouTubeUrl("https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ"),
    (error) => error.code === "YOUTUBE_URL_INVALID",
  );
  assert.throws(
    () => normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123"),
    (error) => error.code === "YOUTUBE_PLAYLIST_UNSUPPORTED",
  );
  assert.throws(
    () => normalizeYouTubeUrl("https://www.youtube.com/live/dQw4w9WgXcQ"),
    (error) => error.code === "YOUTUBE_LIVE_UNSUPPORTED",
  );
});

test("mock youtube ingest adapter is validate-only and no-network", async () => {
  const adapter = createMockYouTubeIngestAdapter({
    metadataByVideoId: {
      dQw4w9WgXcQ: { title: "Safe title", durationSeconds: 120 },
    },
  });
  const source = await validateYouTubeSource({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    rightsConfirmed: true,
    adapter,
    maxDurationSeconds: 180,
  });
  assert.equal(source.videoId, "dQw4w9WgXcQ");
  assert.equal(source.metadataStatus, "mock");
  assert.equal(source.durationSeconds, 120);
  assert.equal(source.ingestAvailable, false);
  assert.equal(source.downloaderConfigured, false);
  assert.equal(source.nextAction, "youtube-ingest-disabled-until-mp4-artifact-exists");
  assert.deepEqual(youtubeIngestHealth(adapter), {
    ready: true,
    mode: "mock",
    enabled: false,
    networkCalls: false,
    downloaderConfigured: false,
    ingestAvailable: false,
  });
});

test("youtube source validation requires rights and enforces duration limits", async () => {
  const adapter = createMockYouTubeIngestAdapter({
    metadataByVideoId: {
      dQw4w9WgXcQ: { durationSeconds: 200 },
    },
  });
  await assert.rejects(
    () => validateYouTubeSource({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", rightsConfirmed: false, adapter }),
    (error) => error.code === "YOUTUBE_RIGHTS_REQUIRED",
  );
  await assert.rejects(
    () => validateYouTubeSource({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      rightsConfirmed: true,
      adapter,
      maxDurationSeconds: 60,
    }),
    (error) => error.code === "YOUTUBE_DURATION_TOO_LONG",
  );
});
