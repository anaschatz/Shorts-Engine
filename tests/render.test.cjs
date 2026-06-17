const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { writeAssSubtitles } = require("../server/render.cjs");
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
