const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateEvidenceAwareCaptions,
  validateCaptionGenerationResult,
} = require("../server/caption-generation.cjs");
const {
  createDisabledCaptionProvider,
  generateCaptionsWithProvider,
} = require("../server/adapters/caption-provider-adapter.cjs");
const { hasGoalLanguage } = require("../server/edit-plan.cjs");

const chanceCopy = Object.freeze({
  storyType: "chance_story",
  hook: "THE BIG CHANCE OPENS",
  context: "The danger builds quickly",
  main: "Almost punished them",
  reaction: "The crowd felt that",
  closing: "Replay the timing",
});

test("deterministic caption generation keeps action evidence primary over crowd support", () => {
  const result = generateEvidenceAwareCaptions({
    copy: chanceCopy,
    title: "Chance with crowd",
    highlightType: "big_chance",
    reasonCodes: ["visual_shot_like_motion", "audio_energy_spike", "crowd_spike"],
    duration: 10,
    language: "English",
  });

  assert.equal(result.providerMode, "deterministic");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.captions.length, 5);
  const byRole = Object.fromEntries(result.captions.map((caption) => [caption.role, caption.text]));
  assert.match(byRole.opening_hook, /chance/i);
  assert.doesNotMatch(byRole.opening_hook, /crowd|stadium/i);
  assert.match(byRole.reaction, /crowd|reaction/i);
  assert.equal(hasGoalLanguage(result.captions.map((caption) => caption.text).join(" ")), false);
  assert.ok(result.captions.every((caption) => caption.captionEvidence.alignedHighlightType === "big_chance"));
  assert.ok(result.captions.every((caption) => caption.captionSource.startsWith("caption_generation:deterministic:big_chance:")));
});

test("provider failures fall back without leaking raw provider output", () => {
  const result = generateCaptionsWithProvider({
    copy: chanceCopy,
    highlightType: "big_chance",
    reasonCodes: ["visual_shot_like_motion"],
    duration: 8,
    language: "English",
  }, {
    provider: {
      providerMode: "future_llm",
      generateCaptions() {
        throw Object.assign(new Error("raw provider secret /Users/example OPENAI_API_KEY=secret"), {
          code: "CAPTION_PROVIDER_TIMEOUT",
        });
      },
    },
  });

  assert.equal(result.providerMode, "deterministic");
  assert.equal(result.fallbackUsed, true);
  assert.match(result.warnings.join(" "), /provider_fallback:CAPTION_PROVIDER_TIMEOUT/);
  assert.doesNotMatch(JSON.stringify(result), /OPENAI_API_KEY|\/Users\/|raw provider secret/);
});

test("disabled future caption provider uses deterministic fallback", () => {
  const result = generateCaptionsWithProvider({
    copy: chanceCopy,
    highlightType: "save",
    reasonCodes: ["visual_save_like_motion"],
    duration: 8,
    language: "English",
  }, {
    provider: createDisabledCaptionProvider(),
  });

  assert.equal(result.fallbackUsed, true);
  assert.equal(result.captions.some((caption) => /save|keeper|stop/i.test(caption.text)), true);
});

test("malformed provider output and unsupported goal claims are rejected", () => {
  assert.throws(() => validateCaptionGenerationResult({
    providerMode: "bad_provider",
    captions: [{ start: 0, end: 1.2, text: "WHAT A GOAL" }],
  }, {
    highlightType: "big_chance",
    reasonCodes: ["visual_shot_like_motion"],
    duration: 8,
  }), /AI output did not pass validation/);

  const fullCaptions = ["WHAT A GOAL", "The danger builds", "Almost punished them"].map((text, index) => ({
    start: index * 1.2,
    end: index * 1.2 + 1,
    text,
    role: index === 0 ? "opening_hook" : index === 1 ? "context" : "closing_punch",
    emphasis: "strong",
    layout: "bottom",
    captionIntent: "big_chance_pressure",
    captionSource: "bad_provider:caption",
    captionEvidence: {
      alignedHighlightType: "big_chance",
      highlightType: "big_chance",
      reasonCodes: ["visual_shot_like_motion"],
      visualReasonCodes: ["visual_shot_like_motion"],
      goalEvidence: false,
      role: "opening_hook",
    },
    captionRiskFlags: [],
  }));
  assert.throws(() => validateCaptionGenerationResult({
    providerMode: "bad_provider",
    captions: fullCaptions,
  }, {
    highlightType: "big_chance",
    reasonCodes: ["visual_shot_like_motion"],
    duration: 8,
  }), /AI output did not pass validation/);
});

test("crowd-only captions stay reaction-oriented and weak evidence stays neutral", () => {
  const crowdOnly = generateEvidenceAwareCaptions({
    copy: {
      hook: "THE CROWD FELT THAT",
      context: "The stadium reacts before the replay",
      main: "That reaction says enough",
      reaction: "The energy jumps",
      closing: "Watch what caused it",
    },
    highlightType: "crowd_reaction",
    reasonCodes: ["audio_energy_spike", "crowd_spike"],
    duration: 8,
    language: "English",
  });
  assert.match(crowdOnly.captions.map((caption) => caption.text).join(" "), /crowd|stadium|reaction/i);
  assert.ok(crowdOnly.captions.some((caption) => caption.captionRiskFlags.includes("crowd_context_only")));

  const weak = generateEvidenceAwareCaptions({
    copy: chanceCopy,
    highlightType: "unknown_action",
    reasonCodes: ["visual_goal_area", "visual_scoreboard_context"],
    duration: 8,
    language: "English",
  });
  const text = weak.captions.map((caption) => caption.text).join(" ");
  assert.match(text, /pressure|play|develop|detail/i);
  assert.doesNotMatch(text, /goal|save|foul|counter/i);
});
