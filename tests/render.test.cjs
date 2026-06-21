const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { renderShort, writeAssSubtitles, createRenderPolishSummary } = require("../server/render.cjs");
const { validateEditPlan } = require("../server/edit-plan.cjs");

const metadata = { durationSeconds: 16, width: 1920, height: 1080 };

function validKineticPlan() {
  return validateEditPlan({
    sourceStart: 0,
    sourceEnd: 12,
    aspectRatio: "9:16",
    highlightType: "crowd_reaction",
    confidence: 0.84,
    hook: "Η ΚΕΡΚΙΔΑ ΤΟ ΕΝΙΩΣΕ",
    title: "Αργεντινή - Αλγερία",
    captions: [
      {
        start: 0,
        end: 2,
        text: "Η ΚΕΡΚΙΔΑ ΤΟ ΕΝΙΩΣΕ",
        role: "opening_hook",
        emphasis: "shout",
        layout: "center",
        style: { fontScale: 1.1, highlightColor: "gold", uppercase: true, maxLines: 2 },
      },
      {
        start: 2.1,
        end: 4,
        text: "Ματς: Αργεντινή - Αλγερία",
        role: "context",
        emphasis: "detail",
        layout: "top",
        style: { fontScale: 0.78, highlightColor: "cyan", uppercase: false, maxLines: 1 },
      },
      {
        start: 4.1,
        end: 6.2,
        text: "ΑΥΤΗ Η ΑΝΤΙΔΡΑΣΗ ΤΑ ΛΕΕΙ ΟΛΑ",
        role: "action_callout",
        emphasis: "strong",
        layout: "bottom",
      },
    ],
    effects: ["wide_safe_framing", "caption_emphasis", "beat_sync_pulse"],
    framingMode: "wide_safe_vertical",
    cropStrategy: {
      type: "wide_safe_contain",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      zoom: 1,
      background: "blurred_fill",
      preserveFullFrame: true,
      maxCropPercent: 0,
    },
    stylePreset: "punchy_highlight",
    captionEmphasis: [{ captionIndex: 0, words: ["ΚΕΡΚΙΔΑ"], style: "kinetic_bold", start: 0, end: 2 }],
    animationCues: [
      { type: "intro_hook", start: 0, end: 1.2 },
      { type: "kinetic_caption", start: 0.1, end: 2.1 },
      { type: "punch_zoom", start: 3.1, end: 4.2 },
      { type: "impact_flash", start: 4.25, end: 4.38 },
      { type: "end_replay_prompt", start: 10.8, end: 12 },
    ],
    reasonCodes: ["crowd_reaction", "audio_energy_spike"],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, metadata);
}

test("ASS renderer writes role-specific kinetic caption styles safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-ass-"));
  const outputPath = join(dir, "captions.ass");
  writeAssSubtitles(validKineticPlan(), outputPath);

  const ass = readFileSync(outputPath, "utf8");
  assert.match(ass, /Style: Caption_opening_hook_0/);
  assert.match(ass, /Style: Caption_context_1/);
  assert.match(ass, /PUNCHY HIGHLIGHT/);
  assert.match(ass, /\\fad\(180,120\)/);
  assert.match(ass, /\\t\(0,180,\\fscx104\\fscy104\)/);
  assert.match(ass, /\\N|Ματς: Αργεντινή - Αλγερία/);
  assert.doesNotMatch(ass, /\bGOAL\b|ΓΚΟΛ/);
  assert.doesNotMatch(ass, /\/Users|OPENAI_API_KEY|storageKey/i);
});

test("ASS renderer writes offside outcome badge without confirmed-goal copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-ass-outcome-"));
  const outputPath = join(dir, "captions.ass");
  const plan = validateEditPlan({
    sourceStart: 0,
    sourceEnd: 22,
    aspectRatio: "9:16",
    highlightType: "goal",
    goalOutcome: {
      eventType: "ball_in_net",
      outcome: "disallowed_offside",
      offsideStatus: "offside",
      decisionEvidence: ["ball_in_net", "offside_commentary", "visual_offside_flag"],
      decisionTimestamp: 18.4,
      postContextSeconds: 12,
      confidence: 0.92,
    },
    confidence: 0.9,
    hook: "OFFSIDE - NO GOAL",
    title: "Offside goal",
    captions: [
      { start: 0, end: 2.2, text: "GOAL... BUT THE FLAG IS UP", role: "opening_hook" },
      { start: 7.5, end: 10.2, text: "OFFSIDE - NO GOAL", role: "action_callout" },
      { start: 18, end: 21, text: "FINISH RULED OUT", role: "closing_punch" },
    ],
    effects: ["wide_safe_framing", "caption_emphasis"],
    framingMode: "wide_safe_vertical",
    stylePreset: "punchy_highlight",
    reasonCodes: ["goal", "visual_ball_in_net", "visual_offside_flag"],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, { durationSeconds: 30, width: 1920, height: 1080 });

  writeAssSubtitles(plan, outputPath);
  const ass = readFileSync(outputPath, "utf8");
  assert.match(ass, /OutcomeBadge/);
  assert.match(ass, /OFFSIDE - NO GOAL/);
  assert.doesNotMatch(ass, /GOAL CONFIRMED|THE FINISH COUNTS|\/Users|storageKey/i);
});

test("ASS renderer writes VAR check badge for possible offside outcomes", () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-ass-var-outcome-"));
  const outputPath = join(dir, "captions.ass");
  const plan = validateEditPlan({
    sourceStart: 0,
    sourceEnd: 20,
    aspectRatio: "9:16",
    highlightType: "goal",
    goalOutcome: {
      eventType: "ball_in_net",
      outcome: "possible_offside",
      offsideStatus: "possible",
      decisionEvidence: ["ball_in_net", "visual_var_check", "visual_replay_angle"],
      safeCaptionBadge: "VAR CHECK",
      decisionWindow: { start: 9.8, end: 20 },
      confidence: 0.74,
    },
    confidence: 0.82,
    hook: "WAS HE OFF?",
    title: "VAR check",
    captions: [
      { start: 0, end: 2, text: "WAS HE OFF?", role: "opening_hook" },
      { start: 9, end: 12, text: "VAR CHECK", role: "action_callout" },
      { start: 16, end: 19, text: "DECISION NOT CLEAR", role: "closing_punch" },
    ],
    effects: ["wide_safe_framing", "caption_emphasis"],
    framingMode: "wide_safe_vertical",
    stylePreset: "punchy_highlight",
    reasonCodes: ["goal", "visual_ball_in_net", "visual_var_check"],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, { durationSeconds: 24, width: 1920, height: 1080 });

  writeAssSubtitles(plan, outputPath);
  const ass = readFileSync(outputPath, "utf8");
  assert.match(ass, /VAR CHECK/);
  assert.doesNotMatch(ass, /GOAL CONFIRMED|THE FINISH COUNTS|\/Users|storageKey/i);
});

test("reference football style delays confirmed-goal badges until confirmation windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-ass-reference-style-"));
  const outputPath = join(dir, "captions.ass");
  const plan = {
    mode: "multi_moment_compilation",
    sourceStart: 50,
    sourceEnd: 164,
    totalDuration: 48,
    aspectRatio: "9:16",
    highlightType: "generic_highlight",
    hook: "VALID FINISHES ONLY",
    stylePreset: "reference_football_multi_goal_v1",
    framingMode: "wide_safe_vertical",
    export: { width: 1080, height: 1920, format: "mp4" },
    segments: [
      {
        id: "goal_1",
        sourceStart: 50,
        sourceEnd: 74,
        timelineStart: 0,
        timelineEnd: 24,
        goalNumber: 1,
        goalOutcome: {
          eventType: "ball_in_net",
          outcome: "confirmed_goal",
          offsideStatus: "onside",
          safeCaptionBadge: "CONFIRMED GOAL",
        },
        confirmationTime: 72,
      },
      {
        id: "goal_2",
        sourceStart: 140,
        sourceEnd: 164,
        timelineStart: 24,
        timelineEnd: 48,
        goalNumber: 2,
        goalOutcome: {
          eventType: "ball_in_net",
          outcome: "confirmed_goal",
          offsideStatus: "onside",
          safeCaptionBadge: "CONFIRMED GOAL",
        },
        confirmationTime: 162,
      },
    ],
    captions: [
      { start: 0.2, end: 2.2, text: "VALID FINISHES ONLY", role: "opening_hook", emphasis: "strong" },
      { start: 21.8, end: 24, text: "GOAL 1 COUNTS", role: "action_callout", emphasis: "detail" },
      { start: 45.8, end: 48, text: "GOAL 2 COUNTS", role: "closing_punch", emphasis: "detail" },
    ],
  };

  writeAssSubtitles(plan, outputPath);
  const ass = readFileSync(outputPath, "utf8");
  assert.match(ass, /REFERENCE FOOTBALL MULTI GOAL V1/);
  assert.match(ass, /GOAL 1 · CONFIRMED/);
  assert.match(ass, /GOAL 2 · CONFIRMED/);
  assert.match(ass, /Dialogue: 2,0:00:21\.80,0:00:24\.00,OutcomeBadge.*GOAL 1 · CONFIRMED/);
  assert.match(ass, /Dialogue: 2,0:00:45\.79,0:00:48\.00,OutcomeBadge.*GOAL 2 · CONFIRMED/);
  assert.doesNotMatch(ass, /Dialogue: 2,0:00:00\.00.*GOAL 1 · CONFIRMED/);
  assert.doesNotMatch(ass, /\/Users|OPENAI_API_KEY|storageKey/i);
});

test("multi-segment renderer cuts segments, concatenates them, then applies captions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-render-multi-"));
  const outputPath = join(dir, "output.mp4");
  const subtitlesPath = join(dir, "captions.ass");
  const calls = [];
  const plan = validateEditPlan({
    mode: "multi_moment_compilation",
    sourceStart: 0,
    sourceEnd: 72,
    segments: [
      {
        id: "seg_chance",
        sourceStart: 0,
        sourceEnd: 12,
        highlightType: "big_chance",
        reasonCodes: ["big_chance", "visual_shot_like_motion"],
        confidence: 0.9,
        retentionScore: 90,
      },
      {
        id: "seg_save",
        sourceStart: 30,
        sourceEnd: 42,
        highlightType: "save",
        reasonCodes: ["save", "visual_save_like_motion"],
        confidence: 0.88,
        retentionScore: 88,
      },
      {
        id: "seg_foul",
        sourceStart: 60,
        sourceEnd: 72,
        highlightType: "hard_foul",
        reasonCodes: ["hard_foul", "visual_foul_like_contact"],
        confidence: 0.86,
        retentionScore: 86,
      },
    ],
    totalDuration: 36,
    aspectRatio: "9:16",
    highlightType: "generic_highlight",
    confidence: 0.88,
    hook: "BEST PHASES ONLY",
    title: "Multi phase render",
    captions: [
      { start: 0, end: 2, text: "BEST PHASES ONLY", role: "opening_hook" },
      { start: 12.4, end: 14.8, text: "PHASE 2: KEEPER REACTS", role: "action_callout" },
      { start: 33.7, end: 36, text: "RUN THE WHOLE SEQUENCE BACK", role: "closing_punch" },
    ],
    effects: ["wide_safe_framing", "caption_emphasis"],
    framingMode: "wide_safe_vertical",
    cropStrategy: {
      type: "wide_safe_contain",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      zoom: 1,
      background: "blurred_fill",
      preserveFullFrame: true,
      maxCropPercent: 0,
    },
    stylePreset: "punchy_highlight",
    reasonCodes: ["big_chance", "save", "hard_foul"],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, { durationSeconds: 90, width: 1920, height: 1080 });

  await renderShort({
    inputPath: join(dir, "input.mp4"),
    outputPath,
    subtitlesPath,
    plan,
    ffmpegRunner: async (args) => {
      calls.push(args);
      return { stderr: "" };
    },
  });

  assert.equal(calls.length, 5);
  assert.deepEqual(calls.slice(0, 3).map((args) => args[args.indexOf("-ss") + 1]), ["0", "30", "60"]);
  assert.ok(calls.slice(0, 3).every((args) => args.includes("-vf") && /fade=t=in/.test(args[args.indexOf("-vf") + 1]) && /fade=t=out/.test(args[args.indexOf("-vf") + 1])));
  assert.equal(calls[3].includes("concat"), true);
  assert.equal(calls[4].includes("-filter_complex"), true);
  assert.equal(calls[4][calls[4].indexOf("-t") + 1], "36");
  assert.equal(plan.renderPolishQA.renderStylePreset, "punchy_highlight");
  assert.equal(plan.renderPolishQA.transitionRenderedCount, 2);
  assert.equal(plan.renderPolishQA.hardCutFallbackCount, 0);
  assert.equal(plan.renderPolishQA.animatedCaptionCount, 3);
  assert.equal(plan.renderPolishQA.staticCaptionFallbackCount, 0);
  assert.ok(plan.renderPolishQA.overlayRenderedCount >= 2);
  assert.ok(plan.renderPolishQA.visualPolishScore >= 95);
  const ass = readFileSync(subtitlesPath, "utf8");
  assert.match(ass, /BEST PHASES ONLY/);
  assert.doesNotMatch(ass, /\bGOAL\b|ΓΚΟΛ|\/Users|storageKey/i);
});

test("multi-segment renderer accepts full valid-goal compilations up to 100 seconds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortsengine-render-long-goals-"));
  const outputPath = join(dir, "output.mp4");
  const subtitlesPath = join(dir, "captions.ass");
  const calls = [];
  const plan = validateEditPlan({
    mode: "multi_moment_compilation",
    sourceStart: 120,
    sourceEnd: 392,
    segments: [
      {
        id: "goal_1",
        sourceStart: 120,
        sourceEnd: 152,
        highlightType: "goal",
        reasonCodes: ["goal", "visual_shot_contact", "visual_ball_in_net", "scoreboard_backed_goal_sequence"],
        goalOutcome: { eventType: "ball_in_net", outcome: "confirmed_goal", offsideStatus: "onside" },
        shotStart: 126,
        finishTime: 142,
        confirmationTime: 150,
        phaseCoverage: { hasBuildup: true, hasShot: true, hasFinish: true, hasConfirmation: true },
        confidence: 0.92,
        retentionScore: 92,
      },
      {
        id: "goal_2",
        sourceStart: 240,
        sourceEnd: 272,
        highlightType: "goal",
        reasonCodes: ["goal", "visual_shot_contact", "visual_ball_in_net", "scoreboard_backed_goal_sequence"],
        goalOutcome: { eventType: "ball_in_net", outcome: "confirmed_goal", offsideStatus: "onside" },
        shotStart: 246,
        finishTime: 262,
        confirmationTime: 270,
        phaseCoverage: { hasBuildup: true, hasShot: true, hasFinish: true, hasConfirmation: true },
        confidence: 0.92,
        retentionScore: 92,
      },
      {
        id: "goal_3",
        sourceStart: 360,
        sourceEnd: 392,
        highlightType: "goal",
        reasonCodes: ["goal", "visual_shot_contact", "visual_ball_in_net", "scoreboard_backed_goal_sequence"],
        goalOutcome: { eventType: "ball_in_net", outcome: "confirmed_goal", offsideStatus: "onside" },
        shotStart: 366,
        finishTime: 382,
        confirmationTime: 390,
        phaseCoverage: { hasBuildup: true, hasShot: true, hasFinish: true, hasConfirmation: true },
        confidence: 0.92,
        retentionScore: 92,
      },
    ],
    totalDuration: 96,
    aspectRatio: "9:16",
    highlightType: "generic_highlight",
    confidence: 0.92,
    hook: "VALID FINISHES ONLY",
    title: "Three valid goals",
    captions: [
      { start: 0, end: 2, text: "VALID FINISHES ONLY", role: "opening_hook" },
      { start: 32.4, end: 35, text: "MOMENT 2: FINISH COUNTS", role: "action_callout" },
      { start: 93, end: 96, text: "ONLY VALID FINISHES", role: "closing_punch" },
    ],
    effects: ["wide_safe_framing", "caption_emphasis"],
    framingMode: "wide_safe_vertical",
    stylePreset: "reference_football_multi_goal_v1",
    reasonCodes: ["goal", "scoreboard_backed_goal_sequence"],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, { durationSeconds: 420, width: 1920, height: 1080 });

  await renderShort({
    inputPath: join(dir, "input.mp4"),
    outputPath,
    subtitlesPath,
    plan,
    ffmpegRunner: async (args) => {
      calls.push(args);
      return { stderr: "" };
    },
  });

  assert.equal(plan.totalDuration, 96);
  assert.equal(calls.length, 5);
  assert.equal(calls[4][calls[4].indexOf("-t") + 1], "96");
  assert.equal(plan.renderPolishQA.transitionRenderedCount, 2);
  assert.equal(plan.renderPolishQA.hardCutFallbackCount, 0);
});

test("render polish summary reports transition fallback when no multi-segment render happened", () => {
  const summary = createRenderPolishSummary({
    stylePreset: "reference_football_multi_goal_v1",
    totalDuration: 48,
    segments: [
      { id: "goal_1", sourceStart: 10, sourceEnd: 34, timelineStart: 0, timelineEnd: 24 },
      { id: "goal_2", sourceStart: 80, sourceEnd: 104, timelineStart: 24, timelineEnd: 48 },
    ],
    captions: [{ start: 0.2, end: 2.2, text: "VALID FINISHES ONLY" }],
    transitionPlan: [{ fromSegmentId: "goal_1", toSegmentId: "goal_2", timelineStart: 24, type: "short_fade" }],
    export: { width: 1080, height: 1920, format: "mp4" },
  }, { transitionRenderedCount: 0 });

  assert.equal(summary.renderStylePreset, "reference_football_multi_goal_v1");
  assert.equal(summary.transitionRenderedCount, 0);
  assert.equal(summary.hardCutFallbackCount, 1);
  assert.equal(summary.animatedCaptionCount, 1);
  assert.ok(summary.renderPolishWarnings.includes("hard_cut_fallback_used"));
  assert.doesNotMatch(JSON.stringify(summary), /\/Users|OPENAI_API_KEY|storageKey/i);
});
