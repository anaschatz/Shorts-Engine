const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeTranscriptEnergy,
  publicTranscriptEnergySummary,
  transcriptEnergyForWindow,
  validateTranscriptEnergyOutput,
} = require("../server/transcript-energy.cjs");

test("transcript energy detects explicit high-energy goal calls safely", () => {
  const result = analyzeTranscriptEnergy({
    language: "en",
    transcriptSegments: [
      { start: 8, end: 10, text: "WHAT A GOAL! Unbelievable finish into the net!" },
    ],
  });

  assert.equal(result.summary.windowCount, 1);
  assert.equal(result.windows[0].possibleEventType, "goal");
  assert.equal(result.windows[0].goalClaimAllowed, true);
  assert.ok(result.windows[0].commentatorIntensityScore >= 0.66);
  assert.ok(result.windows[0].reasonCodes.includes("goal"));
  assert.ok(result.windows[0].safeReasons.includes("transcript_keyword_match"));
});

test("hype-only transcript is support context and cannot claim goal", () => {
  const result = analyzeTranscriptEnergy({
    transcriptSegments: [
      { start: 20, end: 22, text: "LISTEN TO THAT CROWD!!! The stadium absolutely erupts" },
    ],
  });

  assert.equal(result.windows[0].possibleEventType, "crowd_reaction");
  assert.equal(result.windows[0].goalClaimAllowed, false);
  assert.equal(result.windows[0].reasonCodes.includes("goal"), false);
  assert.ok(result.windows[0].safeReasons.includes("crowd_reaction_support_only"));
});

test("offside and no-goal language blocks goal claims", () => {
  const result = analyzeTranscriptEnergy({
    transcriptSegments: [
      { start: 30, end: 33, text: "Goal... but the flag is up, offside and no goal after VAR" },
    ],
  });

  assert.equal(result.windows[0].possibleEventType, "var_offside");
  assert.equal(result.windows[0].goalClaimAllowed, false);
  assert.equal(result.windows[0].reasonCodes.includes("goal"), false);
  assert.ok(result.windows[0].reasonCodes.includes("replay_worthy_moment"));
});

test("transcript energy lookup returns nearest overlapping window", () => {
  const result = analyzeTranscriptEnergy({
    transcriptSegments: [
      { start: 4, end: 6, text: "Slow build-up in midfield" },
      { start: 11, end: 12.5, text: "WHAT A SAVE from the keeper!" },
    ],
  });
  const window = transcriptEnergyForWindow(result, { start: 10.8, end: 13, center: 11.6 });

  assert.equal(window.possibleEventType, "save");
  assert.ok(window.reasonCodes.includes("save"));
});

test("public transcript energy summary is safe and compact", () => {
  const result = analyzeTranscriptEnergy({
    transcriptSegments: [
      { start: 1, end: 2, text: "Huge chance!" },
      { start: 8, end: 9, text: "The crowd reacts" },
    ],
  });
  const summary = publicTranscriptEnergySummary(result);

  assert.equal(summary.providerMode, "deterministic-transcript-energy");
  assert.equal(summary.topWindows.length, 2);
  assert.doesNotMatch(JSON.stringify(summary), /\/Users|OPENAI_API_KEY|storageKey|token/i);
});

test("transcript energy validation rejects unsafe provider output", () => {
  assert.throws(
    () => validateTranscriptEnergyOutput({
      providerMode: "bad",
      windows: [{ start: 0, end: 1, textPreview: "/Users/name/secret", reasonCodes: [] }],
    }),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
});
