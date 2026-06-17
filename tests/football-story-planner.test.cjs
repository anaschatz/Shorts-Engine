const test = require("node:test");
const assert = require("node:assert/strict");

const { createFootballStoryPlan } = require("../server/football-story-planner.cjs");
const { hasGoalLanguage, validateEditPlan } = require("../server/edit-plan.cjs");

const metadata = { durationSeconds: 24, width: 1920, height: 1080, hasAudio: true };

test("football story planner creates contextual no-goal chance captions", () => {
  const plan = createFootballStoryPlan({
    title: "Argentina vs Algeria - pressure chance",
    language: "English",
    metadata,
    selectedMoment: {
      id: "mom_chance",
      start: 7,
      end: 10,
      center: 8.5,
      highlightType: "big_chance",
      confidence: 0.84,
      reasonCodes: ["visual_shot_like_motion", "visual_ball_visible"],
    },
    moments: [],
    styleTarget: "vertical_9_16",
    editIntensity: "balanced",
  });

  assert.equal(plan.storyType, "chance_story");
  assert.equal(plan.aspectRatio, "9:16");
  assert.equal(plan.export.height, 1920);
  assert.equal(plan.selectedMoment.highlightType, "big_chance");
  assert.equal(plan.captionBeats.some((caption) => /Almost punished them/i.test(caption.text)), true);
  assert.deepEqual(plan.captionBeats.map((caption) => caption.role), [
    "opening_hook",
    "context",
    "action_callout",
    "reaction",
    "closing_punch",
  ]);
  assert.equal(plan.captionBeats[0].emphasis, "shout");
  assert.equal(plan.captionBeats[1].layout, "top");
  assert.equal(hasGoalLanguage(plan.captionBeats.map((caption) => caption.text).join(" ")), false);
});

test("football story planner uses natural Greek title context copy", () => {
  const plan = createFootballStoryPlan({
    title: "Μουντιάλ 2026 | Group J | Αργεντινή - Αλγερία | Highlights",
    language: "Greek",
    metadata,
    selectedMoment: {
      id: "mom_reaction",
      start: 7,
      end: 11,
      center: 9,
      highlightType: "crowd_reaction",
      confidence: 0.8,
      reasonCodes: ["crowd_reaction", "audio_energy_spike"],
    },
    editIntensity: "punchy",
  });

  const text = plan.captionBeats.map((caption) => caption.text).join(" ");
  assert.match(text, /Ματς: Αργεντινή - Αλγερία/);
  assert.doesNotMatch(text, /Ματς: Μουντιάλ 2026/);
  assert.doesNotMatch(text, /context/i);
});

test("football story planner supports square reference-style sports edits", () => {
  const plan = createFootballStoryPlan({
    title: "Crowd reaction after a heavy challenge",
    language: "English",
    metadata,
    selectedMoment: {
      id: "mom_crowd",
      start: 8,
      end: 12,
      center: 10,
      highlightType: "crowd_reaction",
      confidence: 0.8,
      reasonCodes: ["crowd_reaction", "audio_energy_spike", "visual_crowd_reaction"],
    },
    styleTarget: "square_1_1",
    editIntensity: "punchy",
  });

  assert.equal(plan.storyType, "reaction_story");
  assert.equal(plan.aspectRatio, "1:1");
  assert.equal(plan.export.width, 1080);
  assert.equal(plan.export.height, 1080);
  assert.equal(plan.animationIntent.intensity, "punchy");
  assert.equal(plan.animationCues.some((cue) => cue.type === "kinetic_caption"), true);
  assert.equal(plan.animationCues.some((cue) => cue.type === "punch_zoom"), true);
  assert.equal(plan.animationCues.some((cue) => cue.type === "impact_flash"), true);
  assert.equal(plan.captionBeats.some((caption) => /crowd|reaction/i.test(caption.text)), true);
});

test("football story planner downgrades visual-only goal moments without explicit evidence", () => {
  const plan = createFootballStoryPlan({
    title: "Goal area pressure",
    language: "English",
    metadata,
    selectedMoment: {
      id: "mom_visual_goalish",
      start: 5,
      end: 8,
      center: 6.5,
      highlightType: "goal",
      confidence: 0.78,
      reasonCodes: ["visual_goal_area", "visual_shot_like_motion"],
    },
    styleTarget: "vertical_9_16",
  });

  assert.equal(plan.selectedMoment.highlightType, "big_chance");
  assert.equal(hasGoalLanguage(plan.hook), false);
  assert.equal(hasGoalLanguage(plan.captionBeats.map((caption) => caption.text).join(" ")), false);
});

test("edit plan validation ignores unsupported animation cues with safe fallback metadata", () => {
  const story = createFootballStoryPlan({
    title: "Keeper save",
    language: "English",
    metadata,
    selectedMoment: {
      id: "mom_save",
      start: 7,
      end: 11,
      center: 9,
      highlightType: "save",
      confidence: 0.87,
      reasonCodes: ["visual_save_like_motion"],
    },
  });
  const plan = validateEditPlan({
    sourceStart: story.selectedMoment.start,
    sourceEnd: story.selectedMoment.end,
    aspectRatio: story.aspectRatio,
    highlightType: story.selectedMoment.highlightType,
    confidence: story.confidence,
    hook: story.hook,
    title: "Keeper save",
    captions: story.captionBeats,
    effects: ["wide_safe_framing", "social_caption_pop"],
    framingMode: story.framingIntent.mode,
    framingReason: story.framingIntent.reason,
    visualEvidenceSummary: { providerMode: "fixture", fallbackUsed: false, windowCount: 1, topTypes: ["save_like_motion"], reasonCodes: ["visual_save_like_motion"], actionFocusConfidence: 0.87 },
    actionFocusConfidence: 0.87,
    cropStrategy: story.cropStrategy,
    stylePreset: "punchy_highlight",
    captionEmphasis: story.captionEmphasis,
    animationCues: [{ type: "kinetic_caption", start: 0, end: 1 }, { type: "unsafe_spin", start: 1, end: 2 }],
    reasonCodes: ["visual_save_like_motion"],
    export: story.export,
  }, metadata);

  assert.equal(plan.animationCues.some((cue) => cue.type === "kinetic_caption"), true);
  assert.equal(plan.stylePreset, "punchy_highlight");
  assert.equal(plan.captions[0].role, "opening_hook");
  assert.equal(plan.captions[1].role, "context");
  assert.equal(plan.unsupportedAnimationCues.length, 1);
  assert.equal(plan.unsupportedAnimationCues[0].type, "unsafe_spin");
});

test("edit plan validation bounds animation cues and rejects unknown render styles", () => {
  const story = createFootballStoryPlan({
    title: "Crowd reaction after a foul",
    language: "English",
    metadata,
    selectedMoment: {
      id: "mom_bound",
      start: 4,
      end: 9,
      center: 6.5,
      highlightType: "foul",
      confidence: 0.84,
      reasonCodes: ["visual_foul_like_contact", "audio_energy_spike"],
    },
    editIntensity: "punchy",
  });
  const base = {
    sourceStart: story.selectedMoment.start,
    sourceEnd: story.selectedMoment.end,
    aspectRatio: story.aspectRatio,
    highlightType: story.selectedMoment.highlightType,
    confidence: story.confidence,
    hook: story.hook,
    title: "Crowd reaction after a foul",
    captions: story.captionBeats,
    effects: ["wide_safe_framing", "caption_emphasis"],
    framingMode: story.framingIntent.mode,
    framingReason: story.framingIntent.reason,
    visualEvidenceSummary: { providerMode: "fixture", fallbackUsed: false, windowCount: 1, topTypes: ["foul_like_contact"], reasonCodes: ["visual_foul_like_contact"], actionFocusConfidence: 0.86 },
    actionFocusConfidence: 0.86,
    cropStrategy: story.cropStrategy,
    stylePreset: "social_sports_v1",
    captionEmphasis: story.captionEmphasis,
    animationCues: [{ type: "impact_flash", start: 1, end: 2.5 }],
    reasonCodes: ["visual_foul_like_contact"],
    export: story.export,
  };

  const plan = validateEditPlan(base, metadata);
  assert.equal(plan.animationCues[0].type, "impact_flash");
  assert.ok(plan.animationCues[0].end - plan.animationCues[0].start <= 0.18);

  assert.throws(
    () => validateEditPlan({ ...base, stylePreset: "chaos_mode" }, metadata),
    (error) => error.code === "VALIDATION_ERROR",
  );
});
