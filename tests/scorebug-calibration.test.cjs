const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildScorebugAttemptDiagnostic,
  parseScorebugDigitGroups,
  safeScorebugAttemptDiagnostic,
  scorebugTransitionDecision,
} = require("../server/scorebug-calibration.cjs");

test("scorebug calibration parses two score-only digit groups with OCR confusions", () => {
  assert.deepEqual(parseScorebugDigitGroups("O I").score, { home: 0, away: 1, text: "0-1" });
  assert.deepEqual(parseScorebugDigitGroups("1-0").score, { home: 1, away: 0, text: "1-0" });
  assert.equal(parseScorebugDigitGroups("45:00").status, "rejected_clock");
  assert.equal(parseScorebugDigitGroups("ARG 1 0 ALG").status, "rejected_team_text");
  assert.equal(parseScorebugDigitGroups("1 0 44").status, "rejected_noise");
});

test("scorebug transition decision rejects impossible jumps and marks reverts as disallowed context", () => {
  assert.deepEqual(scorebugTransitionDecision({
    previousScore: { home: 0, away: 0 },
    candidateScore: { home: 1, away: 0 },
    confidence: 0.86,
  }).decision, "score_changed");
  assert.deepEqual(scorebugTransitionDecision({
    previousScore: { home: 1, away: 0 },
    candidateScore: { home: 0, away: 0 },
    confidence: 0.86,
  }).decision, "score_reverted_or_disallowed");
  assert.deepEqual(scorebugTransitionDecision({
    previousScore: { home: 0, away: 0 },
    candidateScore: { home: 9, away: 0 },
    confidence: 0.9,
  }).decision, "rejected_impossible_transition");
  assert.deepEqual(scorebugTransitionDecision({
    previousScore: { home: 0, away: 0 },
    candidateScore: { home: 1, away: 0 },
    confidence: 0.4,
  }).decision, "rejected_low_confidence");
});

test("scorebug QA diagnostic reports candidate groups and safe rejection reasons", () => {
  const diagnostic = buildScorebugAttemptDiagnostic({
    layoutId: "broadcast-compact-score-only-v1",
    regionId: "scorebug_broadcast_compact",
    scoreOnlyText: "ARG 1 0 ALG",
    ocrText: "45:00",
    clock: "45:00",
    confidence: 0.8,
    digitReading: {
      status: "ambiguous",
      reasons: ["home_or_away_digit_unreadable"],
      digitBoxes: [{ role: "home", digit: "1" }],
      imageSegmentation: {
        foregroundGroupCount: 4,
        homeDigitCandidates: [{ digit: "1", confidence: 0.7 }],
        awayDigitCandidates: [],
      },
    },
  });

  assert.equal(diagnostic.transitionDecision, "rejected_team_text");
  assert.equal(diagnostic.homeCandidateGroups, 1);
  assert.equal(diagnostic.awayCandidateGroups, 0);
  assert.equal(diagnostic.digitBoxesFound, 1);
  assert.ok(diagnostic.rejectedReasonCodes.includes("team_label_or_noise_rejected"));
  assert.doesNotMatch(JSON.stringify(diagnostic), /\/Users|\/private|token|secret|stdout|stderr|raw/i);
});

test("scorebug QA diagnostic sanitizer rejects unsafe values", () => {
  assert.throws(
    () => safeScorebugAttemptDiagnostic({ transitionDecision: "accepted", localPath: "/Users/example/crop.png" }),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
});
