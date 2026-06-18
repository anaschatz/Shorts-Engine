const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analysisHealth,
  createCandidateEditPlans,
  detectHighlights,
  extractMediaSignals,
  highlightTypeForReasons,
  reasonCodesForCaption,
} = require("../server/analysis.cjs");
const { hasGoalLanguage, validateEditPlan } = require("../server/edit-plan.cjs");
const {
  MockTranscriptionProvider,
  OpenAITranscriptionProvider,
  chooseTranscriptionProvider,
  normalizeLanguageCode,
} = require("../server/transcription.cjs");

const metadata = {
  durationSeconds: 22,
  width: 1920,
  height: 1080,
  hasAudio: true,
};

const transcript = {
  provider: "fixture",
  language: "en",
  captions: [
    { start: 1, end: 2.8, text: "The build up starts from the left side" },
    { start: 7.4, end: 9.6, text: "WHAT A GOAL! The keeper cannot reach the finish" },
    { start: 14.2, end: 16, text: "Replay this angle and watch the assist lane" },
  ],
};

test("media signal extraction can use mocked FFmpeg scene and audio outputs", async () => {
  const fakeRunner = async (args) => {
    const text = args.join(" ");
    if (text.includes("showinfo")) {
      return { stderr: "n:1 pts_time:3.24 pos:1\nn:2 pts_time:8.44 pos:2\n" };
    }
    return { stderr: "silence_start: 0.25\nsilence_end: 1.00\nsilence_start: 10.00\nsilence_end: 13.50\n" };
  };
  const signals = await extractMediaSignals({ inputPath: "/tmp/input.mp4", metadata, ffmpegRunner: fakeRunner });
  assert.equal(signals.durationSeconds, 22);
  assert.equal(signals.aspectRatio, 1.778);
  assert.equal(signals.sceneChanges[0].time, 3.24);
  assert.ok(signals.audioPeaks.some((peak) => peak.time > 5 && peak.time < 10));
});

test("media signal extraction keeps late candidates for long sources", async () => {
  const longMetadata = { durationSeconds: 150, width: 1920, height: 1080, hasAudio: true };
  const sceneTimes = Array.from({ length: 28 }, (_, index) => 5 + index * 5);
  const fakeRunner = async (args) => {
    const text = args.join(" ");
    if (text.includes("showinfo")) {
      return { stderr: sceneTimes.map((time, index) => `n:${index} pts_time:${time} pos:${index}`).join("\n") };
    }
    return {
      stderr: [
        "silence_start: 3",
        "silence_end: 12",
        "silence_start: 42",
        "silence_end: 51",
        "silence_start: 92",
        "silence_end: 101",
      ].join("\n"),
    };
  };

  const signals = await extractMediaSignals({ inputPath: "/tmp/input.mp4", metadata: longMetadata, ffmpegRunner: fakeRunner });

  assert.ok(signals.sceneChanges.length <= 12);
  assert.ok(signals.sceneChanges.some((change) => change.time >= 100));
  assert.ok(signals.highMotionCandidates.some((candidate) => candidate.time >= 100));
});

test("highlight detection ranks confirmed goal moments first", () => {
  const signals = {
    durationSeconds: 22,
    hasAudio: true,
    audioPeaks: [{ time: 8.5, energyScore: 0.92, source: "fixture" }],
    sceneChanges: [{ time: 8.4, confidence: 0.81, source: "fixture" }],
  };
  const result = detectHighlights({ transcript, signals, preset: "hype" });
  assert.equal(result.fallback, false);
  assert.equal(result.moments[0].highlightType, "goal");
  assert.equal(result.moments[0].reasonCodes.includes("goal"), true);
  assert.equal(result.moments[0].reasonCodes.includes("audio_energy_spike"), true);
  assert.ok(result.moments[0].retentionScore > result.moments[1].retentionScore);
});

test("candidate edit plans are validated 9:16 MP4 exports", () => {
  const signals = {
    durationSeconds: 22,
    hasAudio: true,
    audioPeaks: [{ time: 8.5, energyScore: 0.92, source: "fixture" }],
    sceneChanges: [{ time: 8.4, confidence: 0.81, source: "fixture" }],
  };
  const { moments } = detectHighlights({ transcript, signals, preset: "hype" });
  const plans = createCandidateEditPlans({
    moments,
    metadata,
    transcript,
    title: "Fixture Derby",
    preset: "hype",
    stylePreset: "punchy_highlight",
  });
  assert.ok(plans.length >= 2);
  assert.equal(plans[0].aspectRatio, "9:16");
  assert.equal(plans[0].export.width, 1080);
  assert.equal(plans[0].export.height, 1920);
  assert.equal(plans[0].highlightType, "goal");
  assert.equal(plans[0].stylePreset, "punchy_highlight");
  assert.equal(plans[0].captions[0].role, "opening_hook");
  assert.equal(plans[0].framingMode, "wide_safe_vertical");
  assert.equal(plans[0].cropStrategy.preserveFullFrame, true);
  assert.ok(plans[0].captionEmphasis.length > 0);
  assert.ok(plans[0].animationCues.length > 0);
  assert.equal(plans[0].reasonCodes.includes("goal"), true);
  assert.ok(plans[0].captions.every((caption) => caption.captionIntent));
  assert.ok(plans[0].captions.every((caption) => caption.captionSource));
  assert.ok(plans[0].captions.every((caption) => caption.captionEvidence && caption.captionEvidence.alignedHighlightType === plans[0].highlightType));
  assert.ok(plans[0].captions.every((caption) => Array.isArray(caption.captionRiskFlags)));
  assert.equal(plans[0].footballStoryPlan.captionGeneration.providerMode, "deterministic");
  assert.equal(plans[0].footballStoryPlan.captionGeneration.fallbackUsed, false);
});

test("reason code extraction recognizes football and replay signals", () => {
  const reasons = reasonCodesForCaption(
    { start: 5, end: 7, text: "Replay the GOAL angle and the crowd roar!" },
    {
      audioPeaks: [{ time: 6, energyScore: 0.9 }],
      sceneChanges: [{ time: 6.2, confidence: 0.8 }],
    },
  );
  assert.equal(reasons.includes("goal"), true);
  assert.equal(reasons.includes("replay_worthy_moment"), true);
  assert.equal(reasons.includes("crowd_reaction"), true);
  assert.equal(reasons.includes("audio_energy_spike"), true);
  assert.equal(reasons.includes("commentator_peak"), true);
});

test("audio-only spike is not promoted to goal without semantic evidence", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 9, end: 11, text: "Listen to that reaction from the stands" }],
    },
    signals: {
      durationSeconds: 24,
      hasAudio: true,
      audioPeaks: [{ time: 10, energyScore: 0.95, source: "fixture" }],
      sceneChanges: [{ time: 10.1, confidence: 0.75, source: "fixture" }],
    },
    preset: "hype",
  });
  assert.equal(result.moments[0].highlightType, "crowd_reaction");
  assert.equal(result.moments[0].reasonCodes.includes("goal"), false);
  assert.equal(hasGoalLanguage(result.moments[0].hook), false);
});

test("visual shot-like evidence ranks a big chance without inventing a goal", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 7, end: 8.5, text: "The pressure rises in the box" }],
    },
    signals: {
      durationSeconds: 20,
      hasAudio: true,
      audioPeaks: [],
      sceneChanges: [],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        {
          start: 6.8,
          end: 10.2,
          types: ["shot_like_motion", "goal_area_visible", "ball_visible"],
          confidence: 0.86,
        },
      ],
    },
    preset: "hype",
  });

  assert.equal(result.moments[0].highlightType, "big_chance");
  assert.equal(result.moments[0].reasonCodes.includes("visual_shot_like_motion"), true);
  assert.equal(result.moments[0].reasonCodes.includes("goal"), false);
  assert.equal(result.moments[0].evidence.visual.goalClaimAllowed, false);
  assert.equal(hasGoalLanguage(result.moments[0].hook), false);
});

test("action-led visual evidence outranks crowd-only reaction when no goal exists", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [
        { start: 4.2, end: 5.5, text: "Listen to the stands react" },
        { start: 10.1, end: 11.4, text: "The pressure rises in the box" },
      ],
    },
    signals: {
      durationSeconds: 24,
      hasAudio: true,
      audioPeaks: [{ time: 4.8, energyScore: 0.94, source: "fixture" }],
      sceneChanges: [{ time: 10.3, confidence: 0.74, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 4.1, end: 5.7, labels: ["crowd_reaction"], confidence: 0.86 },
        { start: 9.4, end: 12.3, labels: ["shot_like_motion", "goal_area_visible", "ball_visible"], confidence: 0.89 },
      ],
    },
    preset: "hype",
  });

  assert.equal(result.moments[0].highlightType, "big_chance");
  assert.equal(result.moments[0].reasonCodes.includes("visual_shot_like_motion"), true);
  assert.equal(result.moments[0].reasonCodes.includes("goal"), false);
  assert.equal(result.moments[0].rankingExplanation.boostCues.includes("visual_shot_like_motion"), true);
  assert.equal(result.explainability.selectedHighlightType, "big_chance");
  assert.equal(result.explainability.goalClaimRejected, true);

  const plans = createCandidateEditPlans({ moments: result.moments, metadata, transcript: { captions: [] }, title: "Chance clip" });
  const captionText = plans[0].captions.map((caption) => caption.text).join(" ");
  assert.equal(plans[0].highlightType, "big_chance");
  assert.match(captionText, /CHANCE|pressure|danger|timing|run|window/i);
  assert.doesNotMatch(captionText, /THE STADIUM TELLS THE STORY|THE ENERGY JUMPS|RUN IT BACK/i);
  assert.ok(plans[0].captions.every((caption) => caption.captionEvidence.alignedHighlightType === "big_chance"));
  assert.ok(plans[0].captions.every((caption) => caption.captionSource.startsWith("caption_generation:deterministic:big_chance:")));
  assert.ok(plans[0].captions.every((caption) => Array.isArray(caption.captionRiskFlags)));
});

test("explicit goal evidence sequence outranks reaction shots and keeps shot-to-payoff window", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [
        { start: 3, end: 4.2, text: "The crowd starts to rise" },
        { start: 8.4, end: 9.4, text: "The attack reaches the box" },
        { start: 14, end: 15.2, text: "The stadium explodes after the finish" },
      ],
    },
    signals: {
      durationSeconds: 24,
      hasAudio: true,
      audioPeaks: [{ time: 14.2, energyScore: 0.95, source: "fixture" }],
      sceneChanges: [{ time: 8.6, confidence: 0.75, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 2.5, end: 4.6, labels: ["crowd_reaction"], confidence: 0.86 },
        { start: 7.4, end: 9.1, labels: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.91 },
        { start: 9.0, end: 11.2, labels: ["goal_mouth_visible", "keeper_action"], confidence: 0.88 },
        { start: 11.1, end: 12.6, labels: ["ball_in_net"], confidence: 0.9 },
        { start: 12.5, end: 15.4, labels: ["celebration_after_shot", "crowd_reaction"], confidence: 0.87 },
      ],
    },
    preset: "hype",
  });

  const top = result.moments[0];
  assert.equal(top.highlightType, "goal");
  assert.equal(top.source, "vision_goal_sequence");
  assert.equal(top.reasonCodes.includes("goal"), true);
  assert.equal(top.reasonCodes.includes("visual_ball_in_net"), true);
  assert.equal(top.evidence.goalEvidence.goalClaimAllowed, true);
  assert.equal(top.evidence.goalEvidence.evidenceLevel, "strong");
  assert.ok(top.start <= 5);
  assert.ok(top.end >= 16);
  const crowdMoment = result.moments.find((moment) => moment.highlightType === "crowd_reaction");
  if (crowdMoment) assert.ok(top.retentionScore > crowdMoment.retentionScore);

  const plans = createCandidateEditPlans({
    moments: result.moments,
    metadata: { durationSeconds: 24, width: 1920, height: 1080, hasAudio: true },
    transcript: { captions: [] },
    title: "Goal evidence sequence",
    editIntensity: "balanced",
  });
  assert.equal(plans[0].highlightType, "goal");
  assert.ok(plans[0].sourceStart <= 7.4);
  assert.ok(plans[0].sourceEnd >= 15.4);
  assert.equal(plans[0].footballStoryPlan.storyType, "goal_story");
  assert.equal(plans[0].actionSequenceSummary.shotOrContact, true);
  assert.equal(plans[0].actionSequenceSummary.goalmouthOrKeeper, true);
  assert.equal(plans[0].actionSequenceSummary.payoff, true);
  assert.equal(plans[0].actionSequenceSummary.reactionOnly, false);
  assert.equal(plans[0].goalOutcome.outcome, "unknown_decision");
  assert.match(plans[0].captions.map((caption) => caption.text).join(" "), /BALL IN THE NET|DECISION NOT CLEAR/i);
  assert.equal(plans[0].cropStrategy.preserveFullFrame, true);
});

test("ball-in-net window keeps post context and labels disallowed offside safely", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [
        { start: 8.2, end: 9.1, text: "The striker is through and finishes into the net" },
        { start: 18.4, end: 20.2, text: "The flag is up, this goal is ruled out for offside" },
      ],
    },
    signals: {
      durationSeconds: 32,
      hasAudio: true,
      audioPeaks: [{ time: 10.4, energyScore: 0.92, source: "fixture" }],
      sceneChanges: [{ time: 8.5, confidence: 0.76, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 6.8, end: 8.2, labels: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.91 },
        { start: 8.2, end: 10.4, labels: ["goal_mouth_visible", "ball_in_net"], confidence: 0.92 },
        { start: 10.4, end: 12.6, labels: ["celebration_after_shot", "crowd_reaction"], confidence: 0.88 },
        { start: 18.2, end: 20.6, labels: ["assistant_referee_flag", "referee_signal"], confidence: 0.86 },
      ],
    },
    preset: "hype",
  });

  const top = result.moments[0];
  assert.equal(top.highlightType, "goal");
  assert.equal(top.evidence.goalOutcome.outcome, "disallowed_offside");
  assert.equal(top.evidence.goalOutcome.offsideStatus, "offside");
  assert.equal(top.evidence.goalOutcome.requiresPostContext, true);
  assert.ok(top.end >= 20);
  assert.ok(top.end - top.start >= 18);

  const plans = createCandidateEditPlans({
    moments: result.moments,
    metadata: { durationSeconds: 32, width: 1920, height: 1080, hasAudio: true },
    transcript: { captions: [] },
    title: "Offside goal clip",
    stylePreset: "punchy_highlight",
  });
  const plan = plans.find((candidate) => candidate.goalOutcome && candidate.goalOutcome.outcome === "disallowed_offside") || plans[0];
  const text = plan.captions.map((caption) => caption.text).join(" ");
  assert.equal(plan.goalOutcome.outcome, "disallowed_offside");
  assert.match(text, /OFFSIDE|NO GOAL|RULED OUT|FLAG/i);
  assert.doesNotMatch(text, /\bGOAL CONFIRMED\b|THE FINISH COUNTS/i);
  assert.equal(plan.captions.some((caption) => caption.captionRiskFlags.includes("offside_decision_context")), true);
});

test("ball-in-net without decision stays neutral instead of confirmed goal", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [
        { start: 7.5, end: 8.8, text: "The shot beats the keeper and hits the net" },
        { start: 16.5, end: 18.2, text: "Players are waiting for the decision" },
      ],
    },
    signals: {
      durationSeconds: 28,
      hasAudio: true,
      audioPeaks: [{ time: 9.2, energyScore: 0.9, source: "fixture" }],
      sceneChanges: [{ time: 8, confidence: 0.74, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 6.8, end: 8.1, labels: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.89 },
        { start: 8.1, end: 10.2, labels: ["goal_mouth_visible", "ball_in_net"], confidence: 0.9 },
      ],
    },
    preset: "hype",
  });

  const top = result.moments[0];
  assert.equal(top.evidence.goalOutcome.outcome, "unknown_decision");
  assert.equal(top.evidence.goalOutcome.offsideStatus, "unknown");
  assert.ok(top.end >= 20);

  const plans = createCandidateEditPlans({
    moments: result.moments,
    metadata: { durationSeconds: 28, width: 1920, height: 1080, hasAudio: true },
    transcript: { captions: [] },
    title: "Unknown decision clip",
  });
  const text = plans[0].captions.map((caption) => caption.text).join(" ");
  assert.match(text, /BALL IN THE NET|DECISION NOT CLEAR/i);
  assert.doesNotMatch(text, /\bGOAL CONFIRMED\b|THE FINISH COUNTS/i);
  assert.equal(plans[0].goalOutcome.outcome, "unknown_decision");
});

test("VAR-only decision context becomes possible offside without confirmed goal copy", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [
        { start: 7.8, end: 9.2, text: "The finish hits the net after the through ball" },
        { start: 15.6, end: 17.2, text: "VAR check for offside, the decision is not clear yet" },
      ],
    },
    signals: {
      durationSeconds: 30,
      hasAudio: true,
      audioPeaks: [{ time: 9.6, energyScore: 0.89, source: "fixture" }],
      sceneChanges: [{ time: 8.1, confidence: 0.72, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 6.6, end: 8.2, labels: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.89 },
        { start: 8.2, end: 10.1, labels: ["goal_mouth_visible", "ball_in_net"], confidence: 0.9 },
        { start: 15.2, end: 17.4, labels: ["var_check_graphic", "replay_angle"], confidence: 0.82 },
      ],
    },
    preset: "hype",
  });

  const top = result.moments[0];
  assert.equal(top.evidence.goalOutcome.outcome, "possible_offside");
  assert.equal(top.evidence.goalOutcome.safeCaptionBadge, "VAR CHECK");
  assert.ok(top.evidence.goalOutcome.decisionEvidence.includes("visual_var_check"));

  const plans = createCandidateEditPlans({
    moments: result.moments,
    metadata: { durationSeconds: 30, width: 1920, height: 1080, hasAudio: true },
    transcript: { captions: [] },
    title: "VAR check clip",
  });
  const text = plans[0].captions.map((caption) => caption.text).join(" ");
  assert.equal(plans[0].goalOutcome.outcome, "possible_offside");
  assert.match(text, /WAS HE OFF|VAR CHECK|DECISION NOT CLEAR/i);
  assert.doesNotMatch(text, /\bGOAL CONFIRMED\b|THE FINISH COUNTS/i);
});

test("scoreboard and referee confirmation are required for confirmed goal outcome", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [
        { start: 8, end: 9.2, text: "The striker finishes into the net" },
        { start: 13.6, end: 14.8, text: "Goal confirmed, it counts" },
      ],
    },
    signals: {
      durationSeconds: 26,
      hasAudio: true,
      audioPeaks: [{ time: 9.5, energyScore: 0.91, source: "fixture" }],
      sceneChanges: [{ time: 8.2, confidence: 0.75, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 6.9, end: 8.1, labels: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
        { start: 8.1, end: 10.3, labels: ["goal_mouth_visible", "ball_in_net"], confidence: 0.9 },
        { start: 13.4, end: 15, labels: ["scoreboard_goal_confirmed", "referee_goal_signal"], confidence: 0.83 },
      ],
    },
    preset: "hype",
  });

  const top = result.moments[0];
  assert.equal(top.evidence.goalOutcome.outcome, "confirmed_goal");
  assert.equal(top.evidence.goalOutcome.offsideStatus, "onside");
  assert.equal(top.evidence.goalOutcome.safeCaptionBadge, "CONFIRMED GOAL");
  assert.equal(top.evidence.goalOutcome.requiresPostContext, false);
});

test("edit-plan validation rejects inconsistent offside goal outcomes", () => {
  assert.throws(() => validateEditPlan({
    sourceStart: 0,
    sourceEnd: 18,
    aspectRatio: "9:16",
    highlightType: "goal",
    goalOutcome: {
      eventType: "ball_in_net",
      outcome: "disallowed_offside",
      offsideStatus: "onside",
    },
    confidence: 0.8,
    hook: "OFFSIDE - NO GOAL",
    title: "Invalid outcome",
    captions: [{ start: 0, end: 2, text: "OFFSIDE - NO GOAL", role: "opening_hook" }],
    effects: ["wide_safe_framing"],
    framingMode: "wide_safe_vertical",
    stylePreset: "punchy_highlight",
    reasonCodes: ["goal", "visual_ball_in_net"],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, { durationSeconds: 22, width: 1920, height: 1080 }), /Disallowed offside outcome needs offside status/);
});

test("partial goal-mouth sequence stays a big chance and does not claim goal", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [
        { start: 4, end: 5.4, text: "The shot opens inside the box" },
        { start: 11, end: 12.2, text: "The crowd reacts to the chance" },
      ],
    },
    signals: {
      durationSeconds: 20,
      hasAudio: true,
      audioPeaks: [{ time: 11.1, energyScore: 0.9, source: "fixture" }],
      sceneChanges: [{ time: 5.1, confidence: 0.7, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 4.4, end: 6.8, labels: ["shot_like_motion", "goal_mouth_visible", "ball_visible"], confidence: 0.88 },
        { start: 10.6, end: 12.4, labels: ["crowd_reaction"], confidence: 0.84 },
      ],
    },
    preset: "hype",
  });

  assert.equal(result.moments[0].highlightType, "big_chance");
  assert.equal(result.moments[0].reasonCodes.includes("goal"), false);
  assert.equal(result.moments[0].evidence.goalEvidence.goalClaimAllowed, false);
  assert.equal(result.moments[0].evidence.goalEvidence.evidenceLevel, "weak");

  const plans = createCandidateEditPlans({
    moments: result.moments,
    metadata: { durationSeconds: 20, width: 1920, height: 1080, hasAudio: true },
    transcript: { captions: [] },
    title: "Chance without goal",
  });
  const text = plans[0].captions.map((caption) => caption.text).join(" ");
  assert.equal(plans[0].highlightType, "big_chance");
  assert.equal(hasGoalLanguage(text), false);
});

test("animation cues stay evidence-aligned and avoid reaction-only punch effects", () => {
  const reactionResult = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 8.8, end: 10.1, text: "Listen to the stands react" }],
    },
    signals: {
      durationSeconds: 24,
      hasAudio: true,
      audioPeaks: [{ time: 9.4, energyScore: 0.94, source: "fixture" }],
      sceneChanges: [{ time: 9.5, confidence: 0.72, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [{ start: 8.2, end: 11.2, labels: ["crowd_reaction"], confidence: 0.82 }],
    },
    preset: "hype",
  });
  const reactionPlan = createCandidateEditPlans({
    moments: reactionResult.moments,
    metadata,
    transcript: { captions: [] },
    title: "Crowd reaction",
    editIntensity: "punchy",
  })[0];
  const reactionCueTypes = reactionPlan.animationCues.map((cue) => cue.type);
  assert.equal(reactionPlan.highlightType, "crowd_reaction");
  assert.equal(reactionPlan.actionSequenceSummary.reactionOnly, true);
  assert.equal(reactionCueTypes.includes("punch_zoom"), false);
  assert.equal(reactionCueTypes.includes("impact_flash"), false);
  assert.equal(reactionCueTypes.includes("freeze_frame"), false);

  const foulResult = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 6.5, end: 8.2, text: "Heavy contact changes the tempo" }],
    },
    signals: {
      durationSeconds: 18,
      hasAudio: true,
      audioPeaks: [{ time: 7.1, energyScore: 0.89, source: "fixture" }],
      sceneChanges: [{ time: 7.0, confidence: 0.75, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [{ start: 6.2, end: 8.7, labels: ["foul_like_contact", "ball_visible"], confidence: 0.88 }],
    },
    preset: "hype",
  });
  const foulPlan = createCandidateEditPlans({
    moments: foulResult.moments,
    metadata: { durationSeconds: 18, width: 1920, height: 1080, hasAudio: true },
    transcript: { captions: [] },
    title: "Foul impact",
    editIntensity: "punchy",
  })[0];
  const foulCueTypes = foulPlan.animationCues.map((cue) => cue.type);
  assert.equal(foulPlan.highlightType, "hard_foul");
  assert.equal(foulPlan.actionSequenceSummary.shotOrContact, true);
  assert.equal(foulCueTypes.includes("punch_zoom"), true);
  assert.equal(foulCueTypes.includes("impact_flash"), true);
  assert.equal(foulCueTypes.includes("freeze_frame"), true);
  assert.equal(foulCueTypes.includes("end_replay_prompt"), true);
});

test("candidate plans include visual evidence summary and safe framing reason", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 10, end: 11.4, text: "Everyone reacts to the save" }],
    },
    signals: { durationSeconds: 22, hasAudio: true, audioPeaks: [], sceneChanges: [] },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [{ start: 9.7, end: 12.8, type: "save_like_motion", confidence: 0.88 }],
    },
    preset: "hype",
  });
  const plans = createCandidateEditPlans({ moments: result.moments, metadata, transcript: { captions: [] }, title: "Save clip" });

  assert.equal(plans[0].highlightType, "save");
  assert.equal(plans[0].visualEvidenceSummary.goalClaimAllowed, false);
  assert.equal(plans[0].visualEvidenceSummary.topTypes.includes("save_like_motion"), true);
  assert.equal(plans[0].actionFocusConfidence, 0.88);
  assert.match(plans[0].framingReason, /^wide_safe_/);
  assert.equal(plans[0].framingMode, "wide_safe_vertical");
  assert.equal(plans[0].cropStrategy.preserveFullFrame, true);
});

test("visual-only save moments use aligned fallback captions instead of generic transcript copy", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 10, end: 11.4, text: "Everyone reacts in the box" }],
    },
    signals: { durationSeconds: 22, hasAudio: true, audioPeaks: [], sceneChanges: [] },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [{ start: 9.7, end: 12.8, labels: ["save_like_motion"], confidence: 0.88 }],
    },
    preset: "hype",
  });
  const plans = createCandidateEditPlans({ moments: result.moments, metadata, transcript: { captions: [] }, title: "Save clip" });

  assert.equal(plans[0].highlightType, "save");
  assert.match(plans[0].captions.map((caption) => caption.text).join(" "), /HUGE SAVE|keeper|Watch/i);
  assert.equal(hasGoalLanguage(plans[0].captions.map((caption) => caption.text).join(" ")), false);
  assert.ok(plans[0].captions.every((caption) => caption.captionEvidence.alignedHighlightType === "save"));
  assert.ok(plans[0].captions.every((caption) => caption.captionIntent.includes("keeper_save")));
  assert.equal(plans[0].captions.flatMap((caption) => caption.captionRiskFlags).includes("goal_language_without_evidence"), false);
});

test("candidate plans support square reference-style output with contextual captions", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 8.8, end: 10.1, text: "Listen to the stands react" }],
    },
    signals: {
      durationSeconds: 24,
      hasAudio: true,
      audioPeaks: [{ time: 9.4, energyScore: 0.92, source: "fixture" }],
      sceneChanges: [{ time: 9.5, confidence: 0.76, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [{ start: 8.2, end: 11.2, labels: ["crowd_reaction"], confidence: 0.82 }],
    },
    preset: "hype",
  });
  const plans = createCandidateEditPlans({
    moments: result.moments,
    metadata,
    transcript: { captions: [] },
    title: "Reference-style crowd reaction",
    styleTarget: "square_1_1",
    editIntensity: "punchy",
    stylePreset: "punchy_highlight",
  });

  assert.equal(plans[0].aspectRatio, "1:1");
  assert.equal(plans[0].export.width, 1080);
  assert.equal(plans[0].export.height, 1080);
  assert.equal(plans[0].footballStoryPlan.storyType, "reaction_story");
  assert.equal(plans[0].stylePreset, "punchy_highlight");
  assert.equal(plans[0].captions.some((caption) => /crowd|reaction/i.test(caption.text)), true);
  assert.equal(plans[0].captions.some((caption) => /STADIUM TELLS THE STORY|RUN IT BACK/.test(caption.text)), false);
  assert.equal(plans[0].animationCues.some((cue) => cue.type === "kinetic_caption"), true);
  assert.equal(hasGoalLanguage(plans[0].captions.map((caption) => caption.text).join(" ")), false);
});

test("visual crowd reaction plus audio ranks as crowd reaction without goal claim", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 8.8, end: 10.1, text: "Listen to the stands react" }],
    },
    signals: {
      durationSeconds: 24,
      hasAudio: true,
      audioPeaks: [{ time: 9.4, energyScore: 0.92, source: "fixture" }],
      sceneChanges: [{ time: 9.5, confidence: 0.76, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [{ start: 8.2, end: 11.2, labels: ["crowd_reaction"], confidence: 0.82 }],
    },
    preset: "hype",
  });

  assert.equal(result.moments[0].highlightType, "crowd_reaction");
  assert.equal(result.moments[0].reasonCodes.includes("visual_crowd_reaction"), true);
  assert.equal(result.moments[0].reasonCodes.includes("goal"), false);
  assert.equal(result.moments[0].evidence.visual.goalClaimAllowed, false);
});

test("long source opening ceremony context is demoted below later match reaction", () => {
  const longTranscript = {
    provider: "fixture",
    language: "en",
    captions: [
      { start: 0, end: 4.35, text: "The pressure jumps" },
      { start: 4.5, end: 8.85, text: "The build-up is clean" },
      { start: 9, end: 13.35, text: "Watch the next touch" },
      { start: 13.5, end: 17.85, text: "This is the key phase" },
    ],
  };
  const result = detectHighlights({
    transcript: longTranscript,
    signals: {
      durationSeconds: 370,
      hasAudio: true,
      audioPeaks: [
        { time: 24.24, energyScore: 0.95, source: "fixture" },
        { time: 61.74, energyScore: 0.95, source: "fixture" },
      ],
      sceneChanges: [
        { time: 7.08, confidence: 0.74, source: "fixture" },
        { time: 10.08, confidence: 0.74, source: "fixture" },
        { time: 61.16, confidence: 0.74, source: "fixture" },
      ],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 5.58, end: 8.58, labels: ["unknown_visual_action"], confidence: 0.58 },
        { start: 22.74, end: 25.74, labels: ["unknown_visual_action"], confidence: 0.78 },
        { start: 60.24, end: 63.24, labels: ["crowd_reaction"], confidence: 0.78 },
      ],
    },
    preset: "hype",
  });

  assert.equal(result.moments[0].highlightType, "crowd_reaction");
  assert.ok(result.moments[0].start >= 50);
  assert.equal(result.moments[0].reasonCodes.includes("audio_energy_spike"), true);
  assert.equal(result.moments[0].reasonCodes.includes("goal"), false);
  const openingMoment = result.moments.find((moment) => moment.start < 15);
  assert.ok(openingMoment);
  assert.equal(
    openingMoment.rankingExplanation.suppressedCues.includes("opening_context_without_action"),
    true,
  );
  const plans = createCandidateEditPlans({
    moments: result.moments,
    metadata: { durationSeconds: 370, width: 1920, height: 1080, hasAudio: true },
    transcript: longTranscript,
    title: "Long source no goal",
  });
  assert.ok(plans[0].sourceStart <= result.moments[0].start - 5);
  assert.ok(plans[0].sourceEnd >= result.moments[0].end);
});

test("long football sources produce a chronological multi-moment compilation without intro filler", () => {
  const longMetadata = { durationSeconds: 130, width: 1920, height: 1080, hasAudio: true };
  const longTranscript = {
    provider: "fixture",
    language: "en",
    captions: [
      { start: 4, end: 6, text: "Opening ceremony and crowd noise before kick off" },
      { start: 25, end: 27, text: "Huge chance opens from the left side" },
      { start: 48, end: 50, text: "The keeper makes a strong save under pressure" },
      { start: 72, end: 74, text: "Heavy contact changes the tempo" },
      { start: 96, end: 98, text: "The crowd reacts after the phase" },
    ],
  };
  const result = detectHighlights({
    transcript: longTranscript,
    signals: {
      durationSeconds: 130,
      hasAudio: true,
      audioPeaks: [
        { time: 5, energyScore: 0.9, source: "fixture" },
        { time: 25.8, energyScore: 0.89, source: "fixture" },
        { time: 48.8, energyScore: 0.9, source: "fixture" },
        { time: 72.6, energyScore: 0.88, source: "fixture" },
        { time: 96.4, energyScore: 0.92, source: "fixture" },
      ],
      sceneChanges: [
        { time: 26, confidence: 0.78, source: "fixture" },
        { time: 49, confidence: 0.8, source: "fixture" },
        { time: 73, confidence: 0.77, source: "fixture" },
        { time: 96.5, confidence: 0.73, source: "fixture" },
      ],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 3.5, end: 6.5, labels: ["crowd_reaction"], confidence: 0.78 },
        { start: 24.2, end: 27.4, labels: ["shot_like_motion", "goal_area_visible", "ball_visible"], confidence: 0.9 },
        { start: 47.2, end: 50.8, labels: ["save_like_motion", "keeper_action", "ball_visible"], confidence: 0.91 },
        { start: 71.2, end: 74.5, labels: ["foul_like_contact", "ball_visible"], confidence: 0.88 },
        { start: 95.2, end: 98.5, labels: ["crowd_reaction"], confidence: 0.83 },
      ],
    },
    preset: "hype",
  });
  assert.ok(result.moments.length >= 4);
  assert.equal(result.moments.some((moment) => (
    moment.start < 12 &&
    moment.rankingExplanation.suppressedCues.includes("opening_context_without_action")
  )), true);

  const plans = createCandidateEditPlans({
    moments: result.moments,
    metadata: longMetadata,
    transcript: longTranscript,
    title: "Long multi-phase fixture",
    editIntensity: "balanced",
    stylePreset: "punchy_highlight",
  });
  const plan = validateEditPlan(plans[0], longMetadata);
  assert.equal(plan.mode, "multi_moment_compilation");
  assert.ok(plan.segments.length >= 3);
  assert.ok(plan.totalDuration >= 45);
  assert.ok(plan.totalDuration <= 90);
  assert.deepEqual(
    plan.segments.map((segment) => segment.sourceStart),
    [...plan.segments.map((segment) => segment.sourceStart)].sort((a, b) => a - b),
  );
  assert.equal(plan.segments.some((segment) => segment.sourceStart < 12), false);
  assert.equal(plan.segments.some((segment) => segment.highlightType === "big_chance"), true);
  assert.equal(plan.segments.some((segment) => segment.highlightType === "save"), true);
  assert.equal(plan.segments.some((segment) => segment.highlightType === "hard_foul"), true);
  assert.equal(hasGoalLanguage(plan.captions.map((caption) => caption.text).join(" ")), false);
  assert.equal(plan.framingMode, "wide_safe_vertical");
  assert.equal(plan.cropStrategy.preserveFullFrame, true);
});

test("long source highlight detection keeps late visual candidates", () => {
  const visualWindows = [
    18, 36, 54, 72, 108, 138,
  ].map((start, index) => ({
    start,
    end: start + 3,
    labels: index % 2 === 0 ? ["unknown_visual_action"] : ["crowd_reaction"],
    confidence: 0.76 + index * 0.01,
  }));
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 2, end: 3.5, text: "Opening context before the match moments" }],
    },
    signals: {
      durationSeconds: 150,
      hasAudio: true,
      audioPeaks: [
        { time: 20, energyScore: 0.88, source: "fixture" },
        { time: 74, energyScore: 0.89, source: "fixture" },
        { time: 140, energyScore: 0.9, source: "fixture" },
      ],
      sceneChanges: [
        { time: 54, confidence: 0.77, source: "fixture" },
        { time: 108, confidence: 0.78, source: "fixture" },
      ],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: visualWindows,
    },
    preset: "hype",
  });

  assert.ok(result.moments.some((moment) => moment.start >= 100));
});

test("long goal compilations include every detected confirmed goal before filler", () => {
  const longMetadata = { durationSeconds: 150, width: 1920, height: 1080, hasAudio: true };
  const longTranscript = {
    provider: "fixture",
    language: "en",
    captions: [
      { start: 2, end: 4, text: "Opening atmosphere before the match settles" },
      { start: 26.8, end: 28.1, text: "Goal confirmed, it counts" },
      { start: 68.8, end: 70.1, text: "Goal confirmed, it counts" },
      { start: 112.8, end: 114.1, text: "Goal confirmed, it counts" },
      { start: 130, end: 132, text: "The crowd reacts after the final phase" },
    ],
  };
  const result = detectHighlights({
    transcript: longTranscript,
    signals: {
      durationSeconds: 150,
      hasAudio: true,
      audioPeaks: [
        { time: 24.4, energyScore: 0.92, source: "fixture" },
        { time: 66.4, energyScore: 0.93, source: "fixture" },
        { time: 110.4, energyScore: 0.94, source: "fixture" },
        { time: 130.5, energyScore: 0.89, source: "fixture" },
      ],
      sceneChanges: [
        { time: 22.8, confidence: 0.78, source: "fixture" },
        { time: 64.8, confidence: 0.8, source: "fixture" },
        { time: 108.8, confidence: 0.81, source: "fixture" },
      ],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 20.6, end: 22.2, labels: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
        { start: 22.2, end: 24.2, labels: ["goal_mouth_visible", "ball_in_net"], confidence: 0.91 },
        { start: 26.6, end: 28.3, labels: ["scoreboard_goal_confirmed", "referee_goal_signal"], confidence: 0.84 },
        { start: 62.6, end: 64.2, labels: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
        { start: 64.2, end: 66.2, labels: ["goal_mouth_visible", "ball_in_net"], confidence: 0.91 },
        { start: 68.6, end: 70.3, labels: ["scoreboard_goal_confirmed", "referee_goal_signal"], confidence: 0.84 },
        { start: 106.6, end: 108.2, labels: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
        { start: 108.2, end: 110.2, labels: ["goal_mouth_visible", "ball_in_net"], confidence: 0.91 },
        { start: 112.6, end: 114.3, labels: ["scoreboard_goal_confirmed", "referee_goal_signal"], confidence: 0.84 },
        { start: 129.6, end: 132.2, labels: ["crowd_reaction"], confidence: 0.82 },
      ],
    },
    preset: "hype",
  });

  const goalMoments = result.moments.filter((moment) => moment.highlightType === "goal");
  assert.ok(goalMoments.length >= 3);

  const plans = createCandidateEditPlans({
    moments: result.moments,
    metadata: longMetadata,
    transcript: longTranscript,
    title: "Three valid goals fixture",
    editIntensity: "balanced",
    stylePreset: "punchy_highlight",
  });
  const plan = validateEditPlan(plans[0], longMetadata);
  const goalSegments = plan.segments.filter((segment) => segment.highlightType === "goal");

  assert.equal(plan.mode, "multi_moment_compilation");
  assert.equal(goalSegments.length, 3);
  assert.ok(goalSegments.some((segment) => segment.sourceStart <= 20.6 && segment.sourceEnd >= 28.3));
  assert.ok(goalSegments.some((segment) => segment.sourceStart <= 62.6 && segment.sourceEnd >= 70.3));
  assert.ok(goalSegments.some((segment) => segment.sourceStart <= 106.6 && segment.sourceEnd >= 114.3));
  assert.ok(goalSegments.every((segment) => segment.duration > 18));
  assert.ok(goalSegments.every((segment) => segment.goalOutcome.outcome === "confirmed_goal"));
  assert.ok(plan.totalDuration <= 90);
});

test("replay-heavy evidence becomes replay-worthy without inventing action or goal", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [
        { start: 5, end: 6.5, text: "Watch the replay angle" },
        { start: 9, end: 10.5, text: "The detail is easy to miss" },
        { start: 13, end: 14.4, text: "Run it back once" },
      ],
    },
    signals: {
      durationSeconds: 24,
      hasAudio: true,
      audioPeaks: [{ time: 9.7, energyScore: 0.72, source: "fixture" }],
      sceneChanges: [{ time: 9.4, confidence: 0.79, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [{ start: 8.4, end: 11.4, labels: ["replay_indicator"], confidence: 0.81 }],
    },
    preset: "hype",
  });

  assert.equal(result.moments[0].highlightType, "replay_worthy_moment");
  assert.equal(result.moments[0].reasonCodes.includes("replay_worthy_moment"), true);
  assert.equal(result.moments[0].reasonCodes.includes("visual_replay_indicator"), true);
  assert.equal(result.moments[0].reasonCodes.includes("goal"), false);

  const plans = createCandidateEditPlans({ moments: result.moments, metadata, transcript: { captions: [] }, title: "Replay detail" });
  const byRole = Object.fromEntries(plans[0].captions.map((caption) => [caption.role, caption.text]));
  assert.match(byRole.opening_hook, /timing/i);
  assert.match(byRole.action_callout, /angle/i);
  assert.match(byRole.closing_punch, /run.*back|back.*run/i);
  assert.equal(hasGoalLanguage(plans[0].captions.map((caption) => caption.text).join(" ")), false);
});

test("commentary and crowd spike evidence keeps reaction wording without false goal", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [
        { start: 5, end: 6.4, text: "THE CALL TELLS THE STORY" },
        { start: 9, end: 10.5, text: "The commentator feels the pressure" },
        { start: 13, end: 14.4, text: "The crowd rises with the moment" },
      ],
    },
    signals: {
      durationSeconds: 24,
      hasAudio: true,
      audioPeaks: [{ time: 9.7, energyScore: 0.95, source: "fixture" }],
      sceneChanges: [{ time: 9.8, confidence: 0.66, source: "fixture" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [{ start: 8.7, end: 11.2, labels: ["camera_pan", "crowd_reaction"], confidence: 0.72 }],
    },
    preset: "hype",
  });

  assert.equal(result.moments[0].highlightType, "crowd_reaction");
  assert.equal(result.moments.some((moment) => moment.reasonCodes.includes("commentator_peak")), true);
  assert.equal(result.moments[0].reasonCodes.includes("audio_energy_spike"), true);
  assert.equal(result.moments[0].reasonCodes.includes("goal"), false);

  const plans = createCandidateEditPlans({ moments: result.moments, metadata, transcript: { captions: [] }, title: "Commentary reaction" });
  const byRole = Object.fromEntries(plans[0].captions.map((caption) => [caption.role, caption.text]));
  assert.match(byRole.opening_hook, /crowd|stadium/i);
  assert.match(byRole.action_callout, /reaction/i);
  assert.match(byRole.closing_punch, /watch/i);
  assert.equal(hasGoalLanguage(plans[0].captions.map((caption) => caption.text).join(" ")), false);
});

test("scoreboard and visual shot-like context still fail closed for goal inference", () => {
  assert.equal(highlightTypeForReasons(["visual_replay_indicator", "scene_change_cluster"]), "replay_or_reaction");
  assert.equal(highlightTypeForReasons(["visual_replay_indicator", "replay_worthy_moment"]), "replay_worthy_moment");
  assert.equal(highlightTypeForReasons(["visual_scoreboard_context", "scene_change_cluster"]), "unknown_action");
  assert.equal(highlightTypeForReasons(["visual_goal_area", "visual_shot_like_motion"]), "big_chance");
});

test("visual scoreboard context does not become a goal or action claim", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 5, end: 6.2, text: "The camera cuts to the scoreboard" }],
    },
    signals: { durationSeconds: 18, hasAudio: true, audioPeaks: [], sceneChanges: [] },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [{ start: 4.8, end: 7.2, labels: ["scoreboard_context"], confidence: 0.78 }],
    },
    preset: "hype",
  });

  assert.notEqual(result.moments[0].highlightType, "goal");
  assert.equal(result.moments[0].highlightType, "unknown_action");
  assert.equal(result.moments[0].reasonCodes.includes("goal"), false);
  assert.equal(result.moments[0].reasonCodes.includes("visual_scoreboard_context"), true);
});

test("scoreboard-only context suppresses weak touch or turn skill claims", () => {
  const reasons = reasonCodesForCaption(
    { start: 7, end: 8.3, text: "The next touch matters" },
    {
      durationSeconds: 18,
      audioPeaks: [],
      sceneChanges: [{ time: 8, confidence: 0.58, source: "fixture" }],
    },
    {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [{ start: 6.8, end: 9.5, types: ["scoreboard_context"], confidence: 0.74 }],
    },
  );

  assert.equal(reasons.includes("visual_scoreboard_context"), true);
  assert.equal(reasons.includes("skill_move"), false);
  assert.equal(reasons.includes("goal"), false);
});

test("finish phrasing alone is not goal evidence", () => {
  const reasons = reasonCodesForCaption(
    { start: 3, end: 5, text: "What a finish" },
    {
      audioPeaks: [{ time: 4, energyScore: 0.9 }],
      sceneChanges: [{ time: 4.1, confidence: 0.8 }],
    },
  );
  assert.equal(reasons.includes("goal"), false);
  assert.equal(hasGoalLanguage("What a finish"), false);
});

test("mock fallback transcription does not invent goal captions", async () => {
  const provider = chooseTranscriptionProvider({ forceMock: true });
  const result = await provider.transcribe({ metadata, preset: "hype", language: "English" });
  const text = result.captions.map((caption) => caption.text).join(" ");
  assert.equal(hasGoalLanguage(text), false);
  assert.doesNotMatch(text, /finish/i);
});

test("save and foul language map to football-aware non-goal types", () => {
  const saveReasons = reasonCodesForCaption(
    { start: 11, end: 13, text: "Huge save by the keeper after the shot!" },
    { audioPeaks: [{ time: 12, energyScore: 0.9 }], sceneChanges: [{ time: 12, confidence: 0.8 }] },
  );
  assert.equal(saveReasons.includes("save"), true);
  assert.equal(saveReasons.includes("shot_on_target"), true);
  assert.equal(saveReasons.includes("goal"), false);

  const foulReasons = reasonCodesForCaption(
    { start: 7, end: 9, text: "Heavy contact! That late challenge changes the tempo" },
    { audioPeaks: [{ time: 8, energyScore: 0.88 }], sceneChanges: [{ time: 8.1, confidence: 0.76 }] },
  );
  assert.equal(foulReasons.includes("hard_foul"), true);
  assert.equal(foulReasons.includes("foul"), true);
  assert.equal(foulReasons.includes("goal"), false);
});

test("non-event goal context does not create goal evidence", () => {
  const reasons = reasonCodesForCaption(
    { start: 12, end: 14, text: "Replay the angle from behind the goal" },
    { audioPeaks: [], sceneChanges: [] },
  );
  assert.equal(reasons.includes("goal"), false);
  assert.equal(reasons.includes("replay_worthy_moment"), true);
});

test("transcription provider keeps mock fallback and language normalization", async () => {
  const provider = chooseTranscriptionProvider({ forceMock: true });
  assert.equal(provider instanceof MockTranscriptionProvider, true);
  assert.equal(normalizeLanguageCode("Ελληνικά"), "el");
  const result = await provider.transcribe({ metadata, preset: "hype", language: "English" });
  assert.equal(result.provider, "mock");
  assert.equal(result.language, "en");
  assert.ok(result.segments.length > 0);
});

test("OpenAI transcription adapter returns safe structured failures", async () => {
  const provider = new OpenAITranscriptionProvider({
    apiKey: "sk-secret-that-must-not-leak",
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    retries: 0,
    timeoutMs: 50,
  });
  await assert.rejects(
    () => provider.transcribe({ audioPath: __filename, language: "English" }),
    (error) => error.code === "TRANSCRIPTION_FAILED" && !String(error.message).includes("sk-secret"),
  );
});

test("analysis health reports deterministic readiness", () => {
  const health = analysisHealth();
  assert.equal(health.ready, true);
  assert.equal(health.features.includes("highlight_ranking"), true);
  assert.equal(health.features.includes("football_highlight_taxonomy"), true);
  assert.equal(health.features.includes("false_goal_guard"), true);
  assert.equal(health.features.includes("vision_safe_action_signals"), true);
});
