import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  archetypeSceneMarkup,
  semanticPrimitivePaths,
  semanticRoutePath,
  semanticTextLines,
  SUPPORTED_SEMANTIC_ARCHETYPES,
} from "../renderer/hyperframes/primitives/semantic-shapes.mjs";
import { compileGenericSemanticAnimationIRToHtml } from "../renderer/hyperframes/generic-semantic-animation.mjs";

const ROLES = ["hook", "context", "evidence", "turn", "payoff"];
const ARCHETYPES = [
  "document_record_v2",
  "timeline_compare_v2",
  "relationship_graph_v2",
  "map_route_v2",
  "bounded_verdict_v2",
];
const ENTITY_KINDS = ["timestamp_date", "clock_temporal", "radio_relationship", "harbor_route", "bounded_evidence"];

function irFixture() {
  const scenes = ROLES.map((role, index) => {
    const startFrame = index * 120;
    const endFrame = (index + 1) * 120;
    return {
      id: `scene_${role}`,
      startFrame,
      endFrame,
      operations: [
        {
          op: "draw_path",
          targetId: `${role}_primary`,
          from: { resolvedFrame: startFrame + 4 },
          to: { resolvedFrame: startFrame + 52 },
          easing: "ease_in_out_cubic",
        },
        {
          op: "highlight",
          targetId: `${role}_payoff`,
          from: { resolvedFrame: startFrame + 48 },
          to: { resolvedFrame: endFrame - 4 },
          easing: "smoothstep",
        },
      ],
    };
  });
  return {
    width: 720,
    height: 1280,
    fps: 30,
    durationFrames: 600,
    content: {
      compositionId: "generic-semantic-proof",
      kicker: "DARK CURIOSITY",
      titleLines: ["One story,", "five visual arguments"],
      visualPlan: {
        scenes: ROLES.map((role, index) => ({
          id: `visual_${role}`,
          role,
          archetypeId: ARCHETYPES[index],
          heading: `${role} heading`,
          primaryLabel: `${role} evidence`,
          secondaryLabel: `${role} qualifier`,
          entityKind: ENTITY_KINDS[index],
          geometry: { layout: "centered", revision: 2 },
          sourceSceneId: `scene_${role}`,
          sourceOperationIndexes: [0, 1],
          beatId: `beat_${role}`,
          claimIds: [`claim_${role}`],
        })),
      },
    },
    scenes,
  };
}

function channelTimingFixture() {
  const ir = irFixture();
  ir.scenes[0].operations = [
    {
      op: "morph_path",
      targetId: "story_evidence",
      from: { resolvedFrame: 4 },
      to: { resolvedFrame: 28 },
      easing: "ease_in_out_cubic",
    },
    {
      op: "draw_path",
      targetId: "hook_primary",
      from: { resolvedFrame: 40 },
      to: { resolvedFrame: 70 },
      easing: "ease_in_out_cubic",
    },
    {
      op: "highlight",
      targetId: "hook_payoff",
      from: { resolvedFrame: 80 },
      to: { resolvedFrame: 110 },
      easing: "smoothstep",
    },
  ];
  ir.content.visualPlan.scenes[0].sourceOperationIndexes = [0, 1, 2];
  return ir;
}

class RuntimeElement {
  constructor({
    drawPaths = [],
    highlightNodes = [],
    flowPaths = [],
    motionCursors = [],
    clockHands = [],
    motion = null,
    pathLength = 480,
  } = {}) {
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.drawPaths = drawPaths;
    this.highlightNodes = highlightNodes;
    this.flowPaths = flowPaths;
    this.motionCursors = motionCursors;
    this.clockHands = clockHands;
    this.motion = motion;
    this.pathLength = pathLength;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  querySelector(selector) {
    if (selector === ".stage-motion") return this.motion;
    return null;
  }

  querySelectorAll(selector) {
    if (selector === ".semantic-draw-path") return this.drawPaths;
    if (selector === ".semantic-emphasis,[data-legibility-role]") return this.highlightNodes;
    if (selector === ".semantic-flow-path") return this.flowPaths;
    if (selector === ".semantic-motion-cursor") return this.motionCursors;
    if (selector === "[data-semantic-clock-hand]") return this.clockHands;
    return [];
  }

  getTotalLength() {
    return this.pathLength;
  }

  getPointAtLength(distance) {
    return { x: 118 + distance, y: 500 };
  }
}

function executeRendererRuntime(ir) {
  const { html } = compileGenericSemanticAnimationIRToHtml(ir);
  const scriptMatch = html.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "compiled animation must contain an inline runtime");

  const elements = new Map();
  const stages = new Map();
  for (const role of ROLES) {
    const drawPath = new RuntimeElement();
    const highlightNode = new RuntimeElement();
    const flowPath = new RuntimeElement();
    const motionCursor = new RuntimeElement();
    const clockHand = new RuntimeElement();
    const motion = new RuntimeElement();
    const stage = new RuntimeElement({
      drawPaths: [drawPath],
      highlightNodes: [highlightNode],
      flowPaths: [flowPath],
      motionCursors: [motionCursor],
      clockHands: role === "hook" ? [clockHand] : [],
      motion,
    });
    stages.set(role, {
      stage,
      drawPath,
      highlightNode,
      flowPath,
      motionCursor,
      clockHand,
      motion,
    });
    elements.set(`stage-${role}`, stage);
  }
  for (const id of [
    "story-evidence",
    "story-evidence-marker",
  ]) {
    elements.set(id, new RuntimeElement());
  }

  const document = {
    documentElement: new RuntimeElement(),
    getElementById(id) {
      return elements.get(id) || null;
    },
  };
  const window = {};
  vm.runInNewContext(scriptMatch[1], { document, window });
  return {
    renderFrame: window.__renderFrame,
    timeline: window.__timelines["generic-semantic-proof"],
    root: document.documentElement,
    stages,
    persistent: elements.get("story-evidence"),
    marker: elements.get("story-evidence-marker"),
  };
}

test("d3 semantic primitives are deterministic and vocabulary-specific", () => {
  const temporalFirst = semanticPrimitivePaths("timestamp_date");
  const temporalSecond = semanticPrimitivePaths("clock");
  const maritime = semanticPrimitivePaths("harbor_route");
  const radio = semanticPrimitivePaths("radio_relationship");

  assert.deepEqual(temporalFirst, temporalSecond);
  assert.equal(temporalFirst.clockRing, "M0,-83A83,83,0,1,1,0,83A83,83,0,1,1,0,-83M0,-76A76,76,0,1,0,0,76A76,76,0,1,0,0,-76Z");
  assert.equal(maritime.link, "M176,518C362,518,362,438,548,438");
  assert.equal(radio.relationshipC, "M360,420C360,537,360,537,360,654");
  assert.equal(
    semanticRoutePath([[0.12, 0.72], [0.42, 0.38], [0.86, 0.55]]),
    "M159.36,636C159.36,636,257.369,544.865,317.76,534C385.616,521.792,550.08,585,550.08,585",
  );
  assert.notDeepEqual(temporalFirst, maritime);
  assert.notDeepEqual(maritime, radio);
});

test("all semantic archetypes compile escaped, deterministic SVG markup", () => {
  assert.deepEqual(SUPPORTED_SEMANTIC_ARCHETYPES, [
    "document_record_v2",
    "evidence_card_v2",
    "relationship_graph_v2",
    "map_route_v2",
    "timeline_compare_v2",
    "scale_compare_v2",
    "bounded_verdict_v2",
  ]);
  for (const archetypeId of SUPPORTED_SEMANTIC_ARCHETYPES) {
    const plan = {
      archetypeId,
      heading: "A <record>",
      primaryLabel: "Observed & logged",
      secondaryLabel: "\"Unverified\"",
      entityKind: archetypeId === "map_route_v2" ? "harbor_route" : "timestamp_date",
    };
    const first = archetypeSceneMarkup(plan, "evidence");
    const second = archetypeSceneMarkup(plan, "evidence");
    assert.equal(first, second);
    assert.match(first, new RegExp(`data-archetype-id="${archetypeId}"`));
    assert.match(first, /data-entity-kind="(?:temporal|maritime)"/);
    assert.match(first, /A &lt;record&gt;/);
    assert.match(first, /Observed &amp; logged/);
    assert.doesNotMatch(first, /\bundefined\b|\bnull\b/);
  }
});

test("semantic copy wraps long labels without duplicating or truncating their meaning", () => {
  assert.deepEqual(
    semanticTextLines("A GPS DATE SUDDENLY LOOKED WRONG"),
    ["A GPS DATE SUDDENLY", "LOOKED WRONG"],
  );
  assert.deepEqual(
    semanticTextLines("DEVICE INTERPRETATION CAUSED THE WRONG DATE"),
    ["DEVICE INTERPRETATION", "CAUSED THE WRONG DATE"],
  );

  const hook = archetypeSceneMarkup({
    archetypeId: "document_record_v2",
    heading: "A GPS DATE SUDDENLY LOOKED WRONG",
    primaryLabel: "A GPS DATE SUDDENLY LOOKED WRONG",
    secondaryLabel: null,
    entityKind: "document_record",
  }, "hook");
  assert.match(hook, /<tspan x="72" dy="0">A GPS DATE SUDDENLY<\/tspan><tspan x="72" dy="38">LOOKED WRONG<\/tspan>/);
  assert.doesNotMatch(hook, /scene-primary-hook/);

  const payoff = archetypeSceneMarkup({
    archetypeId: "bounded_verdict_v2",
    heading: "THE NUMBER RESET. TIME DID NOT.",
    primaryLabel: "DEVICE INTERPRETATION CAUSED THE WRONG DATE",
    secondaryLabel: null,
    entityKind: "bounded_verdict",
  }, "payoff");
  assert.doesNotMatch(payoff, /scene-primary-payoff/);
  assert.match(payoff, /<tspan x="0" dy="0">DEVICE INTERPRETATION<\/tspan><tspan x="0" dy="36">CAUSED THE WRONG DATE<\/tspan>/);
});

test("generic semantic renderer emits five bound offline stages with deterministic frame runtime", () => {
  const ir = irFixture();
  const first = compileGenericSemanticAnimationIRToHtml(ir);
  const second = compileGenericSemanticAnimationIRToHtml(ir);

  assert.equal(first.compositionHash, second.compositionHash);
  assert.equal(first.html, second.html);
  assert.equal((first.html.match(/class="semantic-stage"/g) || []).length, 5);
  assert.equal((first.html.match(/data-source-scene-id=/g) || []).length, 5);
  assert.equal((first.html.match(/data-source-operation-indexes="0,1"/g) || []).length, 5);
  assert.equal((first.html.match(/data-source-beat-id=/g) || []).length, 5);
  assert.equal((first.html.match(/data-source-claim-ids=/g) || []).length, 5);
  assert.match(first.html, /data-motif-kind="clock_date"/);
  assert.match(first.html, /data-motif-kind="harbor_route"/);
  assert.match(first.html, /data-motif-kind="radio_relationship"/);
  assert.equal((first.html.match(/class="semantic-flow-path"/g) || []).length, 5);
  assert.equal((first.html.match(/class="semantic-motion-cursor"/g) || []).length, 5);
  assert.match(first.html, /data-semantic-motion-path="hook-temporal-record"/);
  assert.match(first.html, /data-semantic-motion-path="context-timeline-comparison"/);
  assert.match(first.html, /data-semantic-motion-path="turn-maritime-route"/);
  assert.match(first.html, /data-semantic-motion-path="payoff-bounded-verdict"/);
  assert.match(first.html, /data-semantic-clock-hand="rollover"/);
  assert.doesNotMatch(first.html, /semantic-scanner|analysis-scan/);
  assert.match(first.html, /data-semantic-roi="true"/);
  assert.match(first.html, /data-caption-safe-zone="true"/);
  assert.match(first.html, /id="story-evidence" data-entity-id="story_evidence" data-persistent-entity="true"/);
  assert.match(first.html, /id="story-evidence-path" data-persistent-path="true"/);
  assert.match(first.html, /id="story-evidence-marker" data-follow-path-id="story-evidence-path"/);
  assert.match(first.html, /persistent\.dataset\.visualStateId=activeStage\.id/);
  assert.match(first.html, /document\.documentElement\.dataset\.activeVisualStateId=activeStage\.id/);
  assert.match(first.html, /document\.documentElement\.dataset\.activeStateTransitionId="none"/);
  assert.match(first.html, /connect-src 'none'/);
  assert.match(first.html, /window\.__timelines\[["']generic-semantic-proof["']\]=timeline/);
  assert.match(first.html, /function renderFrame\(rawFrame\)/);
  assert.match(first.html, /"startFrame":4,"endFrame":52/);
  assert.doesNotMatch(first.html, /\bhttps?:\/\//i);
  assert.doesNotMatch(first.html, /Math\.random|fetch\(|XMLHttpRequest|WebSocket/i);
});

test("generic semantic renderer keeps later draw and highlight channels hidden after morph completes", () => {
  const runtime = executeRendererRuntime(channelTimingFixture());
  runtime.renderFrame(30);

  const hook = runtime.stages.get("hook");
  assert.equal(hook.stage.dataset.morphPathProgress, "1.0000");
  assert.equal(hook.stage.dataset.drawPathProgress, "0.0000");
  assert.equal(hook.stage.dataset.highlightProgress, "0.0000");
  assert.equal(hook.drawPath.style.strokeDashoffset, "1000");
  assert.equal(hook.highlightNode.getAttribute("opacity"), "0.0000");
  assert.equal(runtime.persistent.dataset.morphPathProgress, "1.0000");
  assert.equal(runtime.marker.getAttribute("cx"), "144.202");
  assert.equal(hook.flowPath.style.strokeDashoffset, "-72.000");
  assert.equal(hook.motionCursor.getAttribute("transform"), "translate(239.008 500.000)");
  assert.equal(hook.clockHand.getAttribute("transform"), "rotate(83.193)");
});

test("generic semantic renderer advances draw and highlight only inside their own windows", () => {
  const runtime = executeRendererRuntime(channelTimingFixture());
  const hook = runtime.stages.get("hook");

  runtime.renderFrame(55);
  assert.equal(hook.stage.dataset.drawPathProgress, "0.5000");
  assert.equal(hook.drawPath.style.strokeDashoffset, "500");
  assert.equal(hook.stage.dataset.highlightProgress, "0.0000");
  assert.equal(hook.highlightNode.getAttribute("opacity"), "0.0000");

  runtime.renderFrame(95);
  assert.equal(hook.stage.dataset.drawPathProgress, "1.0000");
  assert.equal(hook.drawPath.style.strokeDashoffset, "0");
  assert.equal(hook.stage.dataset.highlightProgress, "0.5000");
  assert.equal(hook.highlightNode.getAttribute("opacity"), "0.5000");
});

test("generic semantic activity stays continuous at scene boundaries", () => {
  const runtime = executeRendererRuntime(irFixture());
  runtime.renderFrame(119);
  const before = runtime.marker.getAttribute("cx");
  runtime.renderFrame(120);
  const after = runtime.marker.getAttribute("cx");
  assert.equal(before, "216.000");
  assert.equal(after, "216.000");
  assert.equal(runtime.persistent.dataset.storyProgress, "0.200000");
});

test("generic semantic motion freezes throughout readability holds", () => {
  const ir = irFixture();
  ir.scenes[0].readabilityHolds = [{ startFrame: 100, endFrame: 120 }];
  const runtime = executeRendererRuntime(ir);
  const hook = runtime.stages.get("hook");

  runtime.renderFrame(99);
  const before = {
    cursor: hook.motionCursor.getAttribute("transform"),
    dashOffset: hook.flowPath.style.strokeDashoffset,
    clockHand: hook.clockHand.getAttribute("transform"),
    marker: runtime.marker.getAttribute("cx"),
  };
  runtime.renderFrame(110);
  const during = {
    cursor: hook.motionCursor.getAttribute("transform"),
    dashOffset: hook.flowPath.style.strokeDashoffset,
    clockHand: hook.clockHand.getAttribute("transform"),
    marker: runtime.marker.getAttribute("cx"),
  };

  assert.deepEqual(during, before);
  assert.equal(runtime.stages.get("hook").stage.dataset.stageProgress, "0.9244");
});

test("generic semantic timeline seek preserves exact integer frames across floating-point seconds", () => {
  const runtime = executeRendererRuntime(irFixture());
  runtime.timeline.seek(507 / 30);
  assert.equal(runtime.root.dataset.renderedFrame, "507");
});

test("generic semantic renderer rejects unsupported or remotely sourced plan content", () => {
  const unsupported = irFixture();
  unsupported.content.visualPlan.scenes[0].archetypeId = "telescope_only_v1";
  assert.throws(
    () => compileGenericSemanticAnimationIRToHtml(unsupported),
    /archetype is unsupported/,
  );

  const remote = irFixture();
  remote.content.visualPlan.scenes[0].primaryLabel = "Read https://invalid.example";
  assert.throws(
    () => compileGenericSemanticAnimationIRToHtml(remote),
    /cannot contain a remote URL/,
  );
});
