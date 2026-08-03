"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const {
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  validateAnimationIR,
} = require("../server/pipelines/narrated-short/animation/contract.cjs");
const {
  buildStoryIR,
} = require("../server/pipelines/narrated-short/animation/story-ir.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const {
  normalizeVisualProgramProposalV1,
  visualProgramContentHash,
} = require("../server/pipelines/narrated-short/animation/visual-program-contract.cjs");
const {
  compileGeneralizedVisualProgramV1,
  validateGeneralizedVisualProgramAnimationAdapterV1,
} = require("../server/pipelines/narrated-short/animation/visual-program-compiler.cjs");

const ROOT = resolve(__dirname, "..");
const CASES = Object.freeze([
  {
    fixtureId: "001_wow_signal_mystery",
    projectId: "project_visual_signal",
    sequence: [
      ["evidence_inspection", "document", "reveal", "focus_lens"],
      ["bounded_uncertainty", "hypothesis", "compare", "scale_focus"],
      ["comparison", "signal", "resolve", "none"],
    ],
    helper: ["bounded_uncertainty", "uncertainty_boundary"],
  },
  {
    fixtureId: "002_gps_week_rollover",
    projectId: "project_visual_cycle",
    sequence: [
      ["finite_cycle", "counter", "update", "match_morph"],
      ["cause_effect", "receiver", "reveal", "focus_lens"],
      ["comparison", "counter", "compare", "none"],
    ],
    helper: ["cause_effect", "document"],
  },
  {
    fixtureId: "003_baychimo_icebound_drift",
    projectId: "project_visual_route",
    sequence: [
      ["map_route", "vessel", "reveal", "match_morph"],
      ["negative_space_absence", "vessel", "compare", "focus_lens"],
      ["chronology", "timeline", "resolve", "none"],
    ],
    helper: ["negative_space_absence", "uncertainty_boundary"],
  },
]);

function readRaw(fixtureId) {
  return JSON.parse(readFileSync(resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "fixtures",
    `${fixtureId}.json`,
  ), "utf8"));
}

function timingFor(draft, salt) {
  let frame = 0;
  let wordIndex = 0;
  const words = [];
  const beats = [];
  for (const beat of draft.script.beats) {
    const wordStartIndex = wordIndex;
    for (const wordText of beat.spokenText.split(/\s+/).filter(Boolean)) {
      words.push({
        index: wordIndex,
        text: wordText,
        startFrame: frame,
        endFrame: frame + 6,
      });
      wordIndex += 1;
      frame += 8;
    }
    beats.push({
      beatId: beat.id,
      wordStartIndex,
      wordEndIndex: wordIndex,
      startFrame: words[wordStartIndex].startFrame,
      endFrame: words[wordIndex - 1].endFrame,
    });
    frame += 16;
  }
  return normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: 30,
    durationFrames: frame + 30,
    alignmentHash: createHash("sha256").update(`${salt}:${draft.contentHash}`).digest("hex"),
    draftHash: draft.contentHash,
    words,
    beats,
  });
}

function contextFor(caseDefinition) {
  const draft = normalizeDraftBundle(readRaw(caseDefinition.fixtureId));
  const timingContext = timingFor(draft, caseDefinition.fixtureId);
  const storyIR = buildStoryIR({ draft, timingContext });
  return { draft, timingContext, storyIR };
}

function proposalFor(caseDefinition, context) {
  const { storyIR, timingContext } = context;
  const beatGroups = [storyIR.beats.slice(0, 2), storyIR.beats.slice(2, 4), storyIR.beats.slice(4)];
  return {
    schemaVersion: 1,
    profile: "generalized_visual_program_proposal_v1",
    bindings: {
      storyIrHash: storyIR.contentHash,
      timingContextHash: timingContext.contentHash,
      draftHash: storyIR.bindings.draftHash,
      sourceRevisionHash: storyIR.bindings.sourceStoryboardHash,
    },
    styleTokenId: "line_art_dark_v1",
    scenes: beatGroups.map((beats, index) => {
      const [recipeId, role, action, transitionId] = caseDefinition.sequence[index];
      return {
        id: `visual_scene_${index + 1}`,
        purpose: `Clarify narrated evidence group ${index + 1}`,
        semanticFamily: recipeId,
        narrationBeatIds: beats.map((beat) => beat.beatId),
        primary: {
          entityRef: beats[0].source.sceneId,
          role,
          recipeId,
          action,
          fromState: `evidence_state_${index + 1}`,
          toState: `resolved_state_${index + 1}`,
        },
        helper: index === 1
          ? {
            role: caseDefinition.helper[1],
            recipeId: caseDefinition.helper[0],
            dataRefs: [beats[0].claimIds[0]],
          }
          : null,
        transitionId,
      };
    }),
  };
}

function compileCase(caseDefinition) {
  const context = contextFor(caseDefinition);
  const proposal = proposalFor(caseDefinition, context);
  const compiled = compileGeneralizedVisualProgramV1({
    ...context,
    proposal,
    projectId: caseDefinition.projectId,
    projectRevision: 1,
  });
  return { context, proposal, compiled };
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  Object.values(value).forEach(assertDeepFrozen);
}

function reverseObjectKeyOrder(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeyOrder(entry)]),
  );
}

function expectBoundaryFailure(action) {
  assert.throws(action, (error) => (
    error?.code === "GENERALIZED_VISUAL_PROGRAM_INVALID"
    && error?.status === 400
  ));
}

test("VisualProgram v1 compiles three tracked stories through one deterministic compiler", () => {
  const outputs = CASES.map((caseDefinition) => {
    const first = compileCase(caseDefinition).compiled;
    const second = compileCase(caseDefinition).compiled;
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.contentHash, second.contentHash);
    assert.deepEqual(
      first.visualProgram.scenes.map((scene) => scene.primary.recipeId),
      caseDefinition.sequence.map(([recipeId]) => recipeId),
    );
    assert.equal(first.visualProgram.bindings.storyIrHash, compileCase(caseDefinition).context.storyIR.contentHash);
    assert.equal(first.visualProgram.scenes[0].startFrame, 0);
    assert.equal(first.visualProgram.scenes.at(-1).endFrame, first.animationIR.durationFrames);
    assert.equal(validateAnimationIR(first.animationIR).contentHash, first.animationIR.contentHash);
    const trusted = compileCase(caseDefinition).context;
    assert.equal(validateGeneralizedVisualProgramAnimationAdapterV1(first, trusted).contentHash, first.contentHash);
    assertDeepFrozen(first);
    return first;
  });
  assert.equal(new Set(outputs.map((output) => output.visualProgram.contentHash)).size, CASES.length);
  assert.equal(new Set(outputs.map((output) => JSON.stringify(
    output.visualProgram.scenes.map((scene) => scene.primary.recipeId),
  ))).size, CASES.length);
});

test("canonical output and hashes do not depend on proposal object key order", () => {
  const caseDefinition = CASES[0];
  const context = contextFor(caseDefinition);
  const proposal = proposalFor(caseDefinition, context);
  const ordered = compileGeneralizedVisualProgramV1({
    ...context,
    proposal,
    projectId: caseDefinition.projectId,
    projectRevision: 1,
  });
  const reordered = compileGeneralizedVisualProgramV1({
    ...context,
    proposal: reverseObjectKeyOrder(proposal),
    projectId: caseDefinition.projectId,
    projectRevision: 1,
  });
  assert.deepEqual(reordered, ordered);
  assert.equal(reordered.contentHash, ordered.contentHash);
});

test("proposal boundary rejects frames, geometry, executable content, and unknown fields", () => {
  const caseDefinition = CASES[0];
  const context = contextFor(caseDefinition);
  const base = proposalFor(caseDefinition, context);
  const mutations = [
    (proposal) => { proposal.scenes[0].startFrame = 0; },
    (proposal) => { proposal.scenes[0].primary.x = 0.5; },
    (proposal) => { proposal.scenes[0].primary.path = "M0 0"; },
    (proposal) => { proposal.scenes[0].purpose = "https://remote.invalid/payload"; },
    (proposal) => { proposal.scenes[0].primary.code = "require('node:fs')"; },
    (proposal) => { proposal.scenes[0].unknown = "field"; },
  ];
  for (const mutate of mutations) {
    const proposal = structuredClone(base);
    mutate(proposal);
    expectBoundaryFailure(() => normalizeVisualProgramProposalV1(proposal));
  }
});

test("proposal boundary never invokes accessors and rejects hostile object graphs", () => {
  let getterCalls = 0;
  const withGetter = {};
  Object.defineProperty(withGetter, "schemaVersion", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  expectBoundaryFailure(() => normalizeVisualProgramProposalV1(withGetter));
  assert.equal(getterCalls, 0);

  const cyclic = {};
  cyclic.self = cyclic;
  expectBoundaryFailure(() => normalizeVisualProgramProposalV1(cyclic));

  const sparse = [];
  sparse.length = 2;
  expectBoundaryFailure(() => normalizeVisualProgramProposalV1(sparse));

  const polluted = Object.create({ injected: true });
  polluted.schemaVersion = 1;
  expectBoundaryFailure(() => normalizeVisualProgramProposalV1(polluted));

  const symbolKey = { schemaVersion: 1 };
  symbolKey[Symbol("hidden")] = "value";
  expectBoundaryFailure(() => normalizeVisualProgramProposalV1(symbolKey));
});

test("compiler rejects stale bindings, recipe misuse, untrusted references, and scene excess", () => {
  const caseDefinition = CASES[0];
  const context = contextFor(caseDefinition);
  const compile = (proposal) => compileGeneralizedVisualProgramV1({
    ...context,
    proposal,
    projectId: caseDefinition.projectId,
    projectRevision: 1,
  });

  const stale = proposalFor(caseDefinition, context);
  stale.bindings.storyIrHash = "0".repeat(64);
  expectBoundaryFailure(() => compile(stale));

  const unknownRecipe = proposalFor(caseDefinition, context);
  unknownRecipe.scenes[0].primary.recipeId = "unknown_recipe";
  unknownRecipe.scenes[0].semanticFamily = "unknown_recipe";
  expectBoundaryFailure(() => compile(unknownRecipe));

  const badAction = proposalFor(caseDefinition, context);
  badAction.scenes[0].primary.action = "exit";
  expectBoundaryFailure(() => compile(badAction));

  const badTransition = proposalFor(caseDefinition, context);
  badTransition.scenes[0].transitionId = "untrusted_transition";
  expectBoundaryFailure(() => compile(badTransition));

  const badStyle = proposalFor(caseDefinition, context);
  badStyle.styleTokenId = "untrusted_style";
  expectBoundaryFailure(() => compile(badStyle));

  const untrustedEntity = proposalFor(caseDefinition, context);
  untrustedEntity.scenes[0].primary.entityRef = "invented_entity";
  expectBoundaryFailure(() => compile(untrustedEntity));

  const foreignCase = CASES[1];
  const foreignContext = contextFor(foreignCase);
  const foreignProposal = proposalFor(foreignCase, foreignContext);
  foreignProposal.bindings = structuredClone(proposalFor(caseDefinition, context).bindings);
  expectBoundaryFailure(() => compile(foreignProposal));

  const foreignData = proposalFor(caseDefinition, context);
  foreignData.scenes[1].helper.dataRefs = [foreignContext.storyIR.beats[2].claimIds[0]];
  expectBoundaryFailure(() => compile(foreignData));

  const excessiveText = proposalFor(caseDefinition, context);
  excessiveText.scenes[0].purpose = "a".repeat(161);
  expectBoundaryFailure(() => compile(excessiveText));

  const excessiveHelpers = proposalFor(caseDefinition, context);
  excessiveHelpers.scenes[0].helpers = [
    structuredClone(excessiveHelpers.scenes[1].helper),
    structuredClone(excessiveHelpers.scenes[1].helper),
  ];
  expectBoundaryFailure(() => compile(excessiveHelpers));

  const tooMany = proposalFor(caseDefinition, context);
  tooMany.scenes = Array.from({ length: 7 }, (_, index) => ({
    ...structuredClone(tooMany.scenes[0]),
    id: `visual_extra_${index}`,
  }));
  expectBoundaryFailure(() => compile(tooMany));
});

test("adapter rejects tampering even when an attacker recomputes the inner program hash", () => {
  const { compiled } = compileCase(CASES[1]);
  const tampered = structuredClone(compiled);
  tampered.visualProgram.scenes[0].purpose = "Tampered purpose";
  tampered.visualProgram.contentHash = visualProgramContentHash(tampered.visualProgram);
  const context = contextFor(CASES[1]);
  expectBoundaryFailure(() => validateGeneralizedVisualProgramAnimationAdapterV1(tampered, context));
});

test("adapter requires trusted context and rejects fresh-hash story rebinding", () => {
  const source = compileCase(CASES[0]);
  const foreign = compileCase(CASES[2]);
  expectBoundaryFailure(() => validateGeneralizedVisualProgramAnimationAdapterV1(source.compiled));
  expectBoundaryFailure(() => validateGeneralizedVisualProgramAnimationAdapterV1(
    source.compiled,
    foreign.context,
  ));
});

test("new compiler is isolated from production paths and filesystem/media side effects", () => {
  const compilerSource = readFileSync(resolve(
    ROOT,
    "server/pipelines/narrated-short/animation/visual-program-compiler.cjs",
  ), "utf8");
  const productionSource = readFileSync(resolve(
    ROOT,
    "server/pipelines/narrated-short/animation/production-plan-compiler.cjs",
  ), "utf8");
  assert.doesNotMatch(compilerSource, /node:(?:fs|child_process)|\.\/experimental\//);
  assert.doesNotMatch(productionSource, /visual-program-(?:contract|compiler)|visual-recipe-registry/);
  assert.doesNotMatch(compilerSource, /(?:001_wow|002_gps|003_baychimo|wow|gps|baychimo)/i);
});
