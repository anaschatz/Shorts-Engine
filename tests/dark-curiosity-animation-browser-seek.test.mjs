import test from "node:test";
import assert from "node:assert/strict";
import { validateCompositionIsolation } from "../renderer/hyperframes/composition-isolation.mjs";
import { runBrowserSeekProof, validateGeometrySnapshots } from "../renderer/hyperframes/browser-seek-harness.mjs";

const geometry = (bounds = { x: 100, y: 300, width: 200, height: 120 }) => ({
  semanticRoi: { x: 36, y: 180, width: 648, height: 740 },
  captionSafeZone: { x: 0, y: 947, width: 720, height: 333 },
  entities: [{ entityId: "signal_wave", captionPolicy: "avoid", visible: true, bounds }],
});

const strictStates = ["observation_record", "frequency_context", "beam_response", "failed_repeat_search", "bounded_candidate"];
const strictFocusIds = strictStates.map((stateId) => `focus_${stateId}`);
const strictTransitionIds = ["signal_transition_1", "signal_transition_2", "signal_transition_3", "signal_transition_4"];
const strictExpectations = {
  expectedPersistentEntityIds: ["signal_evidence"],
  expectedVisualStateIds: strictStates,
  expectedFocusIntervalIds: strictFocusIds,
  expectedTransitionIds: strictTransitionIds,
  legibilityProfile: "mobile_720_v1",
};

function strictSnapshot(frame, stateId, focusIntervalId, transitionId, pathData) {
  const bounds = { x: 100, y: 300, width: 200, height: 120 };
  return {
    frame,
    semanticRoi: { x: 36, y: 180, width: 648, height: 740 },
    captionSafeZone: { x: 0, y: 947, width: 720, height: 333 },
    visualStateId: stateId,
    transitionId,
    focusIntervalId,
    focusPrimaryEntityId: "signal_evidence",
    entities: [{ entityId: "signal_evidence", captionPolicy: "avoid", visible: true, bounds }],
    persistentEntities: [{ entityId: "signal_evidence", stateId, representationId: `rep_${stateId}`, transitionId, visible: true, bounds, pathData }],
    focusTargets: [{ entityId: "signal_evidence", role: "primary", visible: true, bounds }],
    labels: [
      { id: "key_label", role: "key", visible: true, fontSize: 32, foreground: "#e2e8f0", background: "#07121f", bounds: { x: 120, y: 500, width: 240, height: 42 } },
      { id: "secondary_label", role: "secondary", visible: true, fontSize: 24, effectiveFontSize: 24, effectiveFontFloor: 24, glyphCompression: false, foreground: "#a5f3fc", background: "#071827", bounds: { x: 120, y: 560, width: 240, height: 32 } },
    ],
    pathFollowers: [{ followerId: "signal-evidence-marker", pathId: "signal-evidence-path", visible: true, distance: 0.5 }],
  };
}

function strictSnapshots() {
  let frame = 0;
  const snapshots = strictStates.map((stateId, index) => strictSnapshot(frame += 3, stateId, strictFocusIds[index], "none", `M100 360 L${200 + index} 360`));
  strictTransitionIds.forEach((transitionId, index) => {
    for (let sample = 0; sample < 3; sample += 1) snapshots.push(strictSnapshot(frame += 3, strictStates[index + 1], strictFocusIds[index + 1], transitionId, `M100 ${360 + sample} L${240 + index * 10 + sample} ${360 - sample}`));
  });
  return snapshots;
}

function mockBrowser() {
  const listeners = new Map();
  let renderedFrame = 0;
  let loads = 0;
  let paintBarrierObserved = false;
  let screenshotCount = 0;
  const screenshotOptions = [];
  const page = {
    setViewport: async () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    setRequestInterception: async () => {},
    on: (event, handler) => { listeners.set(event, handler); },
    setContent: async () => { loads += 1; listeners.get("load")?.(); },
    setBypassCSP: async () => {},
    evaluate: async (fn, input) => {
      if (!input && String(fn).includes("createElement")) {
        listeners.get("request")?.({ url: () => "https://probe.invalid/image.png", resourceType: () => "image", abort: async () => {}, continue: async () => {} });
        return undefined;
      }
      if (!input) return { timelineCount: 1, animationCount: 0, compositionCount: 2 };
      paintBarrierObserved ||= String(fn).includes("requestAnimationFrame");
      renderedFrame = input.requestedFrame;
      if (String(fn).includes("return Number(document.documentElement.dataset.renderedFrame)")) return renderedFrame;
      return { renderedFrame, geometry: geometry() };
    },
    screenshot: async (options) => {
      screenshotCount += 1;
      screenshotOptions.push(options);
      return Buffer.from(`pixels:${renderedFrame}`);
    },
    close: async () => {},
    get loads() { return loads; },
    get paintBarrierObserved() { return paintBarrierObserved; },
    get screenshotCount() { return screenshotCount; },
    get screenshotOptions() { return screenshotOptions; },
  };
  return { browser: { newPage: async () => page, close: async () => {} }, page, listeners };
}

const html = '<!doctype html><main data-composition-id="proof"></main><script>window.__timelines={proof:{seek(){}}}</script>';

test("composition isolation rejects wall-clock, random, frame accumulation and autoplay sources", () => {
  assert.equal(validateCompositionIsolation(html).valid, true);
  const cases = [
    ["Date.now()", "BROWSER_TIME_SOURCE_FORBIDDEN"],
    ["performance.now()", "BROWSER_TIME_SOURCE_FORBIDDEN"],
    ["Math.random()", "BROWSER_RANDOM_SOURCE_FORBIDDEN"],
    ["requestAnimationFrame(run)", "BROWSER_FRAME_ACCUMULATION_FORBIDDEN"],
    ["<video autoplay>", "BROWSER_AUTOPLAY_FORBIDDEN"],
    ["<style>.x{animation: drift 1s}</style>", "BROWSER_CSS_AUTOPLAY_FORBIDDEN"],
  ];
  for (const [source, code] of cases) assert.throws(() => validateCompositionIsolation(`${html}${source}`), { code });
});

test("browser harness loads once and hashes N-M-N pixels without accumulated state", async () => {
  const fixture = mockBrowser();
  const result = await runBrowserSeekProof({ html, width: 720, height: 1280, fps: 30, durationFrames: 300, chromePath: "/mock/chrome", seekSequence: [27, 209, 27, 291, 0, 291] }, { launch: async () => fixture.browser });
  assert.equal(result.loadedOnce, true);
  assert.deepEqual(result.cacheWarmupFrames, [27, 291]);
  assert.equal(fixture.page.loads, 1);
  assert.equal(fixture.page.paintBarrierObserved, true);
  assert.equal(fixture.page.screenshotCount, 8);
  assert.ok(fixture.page.screenshotOptions.every((options) => (
    options.type === "jpeg"
    && options.quality === 90
    && options.captureBeyondViewport === false
    && options.clip.width === 720
    && options.clip.height === 1280
  )));
  assert.deepEqual(result.repeatedFrames.map((entry) => [entry.frame, entry.equal]), [[27, true], [291, true]]);
  assert.equal(result.captures[0].sha256, result.captures[2].sha256);
  assert.equal(result.captures[3].sha256, result.captures[5].sha256);
  assert.equal(result.externalRequestCount, 0);
  assert.equal(result.geometryAudit.passed, true);
  assert.equal(result.passed, true);
});

test("geometry audit rejects real clipping and caption-safe collisions", () => {
  const clipped = validateGeometrySnapshots([{ frame: 0, ...geometry({ x: -4, y: 300, width: 200, height: 120 }) }], 720, 1280);
  assert.equal(clipped.passed, false);
  assert.equal(clipped.clippedEntities.length, 1);
  const collision = validateGeometrySnapshots([{ frame: 0, ...geometry({ x: 100, y: 930, width: 200, height: 80 }) }], 720, 1280);
  assert.equal(collision.passed, false);
  assert.equal(collision.captionSafeZoneViolations.length, 1);
  const offPath = validateGeometrySnapshots([{ frame: 0, ...geometry(), pathFollowers: [{ followerId: "signal-dot", pathId: "signal-curve", visible: true, distance: 2.25 }] }], 720, 1280);
  assert.equal(offPath.passed, false);
  assert.deepEqual(offPath.pathFollowerViolations, [{ frame: 0, followerId: "signal-dot", pathId: "signal-curve", distance: 2.25 }]);
  const onPath = validateGeometrySnapshots([{ frame: 0, ...geometry(), pathFollowers: [{ followerId: "signal-dot", pathId: "signal-curve", visible: true, distance: 0.8 }] }], 720, 1280);
  assert.equal(onPath.passed, true);
  assert.equal(onPath.pathFollowerObservationCount, 1);
  const detachedSemanticRoute = validateGeometrySnapshots([{
    frame: 0,
    ...geometry(),
    semanticRoutes: [{
      routeIndex: 0,
      visible: true,
      distance: 1.25,
      x: 120,
      y: 560,
    }],
  }], 720, 1280);
  assert.equal(detachedSemanticRoute.passed, false);
  assert.deepEqual(detachedSemanticRoute.semanticRouteViolations, [{
    frame: 0,
    routeIndex: 0,
    distance: 1.25,
  }]);
  const groundedSemanticRoute = validateGeometrySnapshots([{
    frame: 0,
    ...geometry(),
    semanticRoutes: [{
      routeIndex: 0,
      visible: true,
      distance: 0.5,
      x: 120,
      y: 560,
    }],
  }], 720, 1280);
  assert.equal(groundedSemanticRoute.passed, true);
  assert.equal(groundedSemanticRoute.semanticRouteObservationCount, 1);
  const hiddenFollower = validateGeometrySnapshots([{ frame: 0, ...geometry(), pathFollowers: [{ followerId: "signal-dot", pathId: "signal-curve", visible: false, distance: null }] }], 720, 1280, ["signal-dot"]);
  assert.equal(hiddenFollower.passed, false);
  assert.deepEqual(hiddenFollower.unobservedPathFollowerIds, ["signal-dot"]);
  const missingFollower = validateGeometrySnapshots([{ frame: 0, ...geometry(), pathFollowers: [] }], 720, 1280, ["signal-dot"]);
  assert.equal(missingFollower.passed, false);
  assert.deepEqual(missingFollower.unobservedPathFollowerIds, ["signal-dot"]);
});

test("geometry audit proves action signatures and clean settled holds", () => {
  const firstSignature = "create:module_primary:entry:reveal";
  const secondSignature = "camera:scene:develop:push_primary";
  const expectations = {
    expectedActionSignatures: [firstSignature, secondSignature],
    expectedSettledHoldFrames: [30],
  };
  const snapshots = [
    { frame: 10, ...geometry(), activeSceneActionSignatures: [firstSignature] },
    { frame: 20, ...geometry(), activeSceneActionSignatures: [secondSignature] },
    { frame: 30, ...geometry(), activeSceneActionSignatures: [] },
  ];
  const passed = validateGeometrySnapshots(
    snapshots,
    720,
    1280,
    [],
    expectations,
  );
  assert.equal(passed.passed, true);
  assert.deepEqual(passed.observedActionSignatures, [
    secondSignature,
    firstSignature,
  ].sort());
  assert.deepEqual(passed.unobservedActionSignatures, []);
  assert.deepEqual(passed.actionCoverageViolations, []);

  const missing = validateGeometrySnapshots(
    snapshots.slice(0, 1).concat(snapshots.slice(2)),
    720,
    1280,
    [],
    expectations,
  );
  assert.equal(missing.passed, false);
  assert.deepEqual(missing.unobservedActionSignatures, [secondSignature]);

  const dirtyHold = validateGeometrySnapshots(
    snapshots.map((snapshot) => snapshot.frame === 30
      ? { ...snapshot, activeSceneActionSignatures: [secondSignature] }
      : snapshot),
    720,
    1280,
    [],
    expectations,
  );
  assert.equal(dirtyHold.passed, false);
  assert.deepEqual(dirtyHold.actionCoverageViolations, [{
    frame: 30,
    reason: "settled_hold_has_active_action",
    activeSceneActionSignatures: [secondSignature],
  }]);
});

test("strict geometry audit proves persistent morphs, exclusive focus, and mobile legibility", () => {
  const result = validateGeometrySnapshots(strictSnapshots(), 720, 1280, ["signal-evidence-marker"], strictExpectations);
  assert.equal(result.passed, true);
  assert.deepEqual(result.persistentStateCoverage.signal_evidence, [...strictStates].sort());
  assert.deepEqual(result.observedTransitionIds, [...strictTransitionIds].sort());
  assert.deepEqual(result.observedFocusIntervalIds, [...strictFocusIds].sort());
  assert.equal(result.persistentContinuityViolations.length, 0);
  assert.equal(result.focusViolations.length, 0);
  assert.equal(result.primaryRoiViolations.length, 0);
  assert.equal(result.legibilityViolations.length, 0);
  assert.equal(result.contrastViolations.length, 0);
  assert.deepEqual(result.markedLabelIds, ["key_label", "secondary_label"]);
  assert.deepEqual(result.observedLabelIds, ["key_label", "secondary_label"]);
  assert.deepEqual(result.unobservedLabelIds, []);
});

test("strict geometry audit rejects continuity, focus, ROI, path, and typography bypasses", () => {
  const audit = (mutate) => {
    const snapshots = structuredClone(strictSnapshots());
    mutate(snapshots);
    return validateGeometrySnapshots(snapshots, 720, 1280, ["signal-evidence-marker"], strictExpectations);
  };
  assert.ok(audit((snapshots) => snapshots[0].entities.push(structuredClone(snapshots[0].entities[0]))).persistentContinuityViolations.length > 0);
  assert.ok(audit((snapshots) => { snapshots[0].persistentEntities[0].visible = false; }).persistentContinuityViolations.length > 0);
  assert.throws(() => audit((snapshots) => { snapshots[0].persistentEntities[0].stateId = "frequency_context"; }), { code: "BROWSER_GEOMETRY_AUDIT_INVALID" });
  assert.ok(audit((snapshots) => { for (const snapshot of snapshots.filter((entry) => entry.transitionId === "signal_transition_1")) snapshot.persistentEntities[0].pathData = "M100 360 L240 360"; }).persistentContinuityViolations.length > 0);
  assert.ok(audit((snapshots) => snapshots[0].focusTargets.push({ entityId: "other_primary", role: "primary", visible: true, bounds: { x: 120, y: 320, width: 80, height: 80 } })).focusViolations.length > 0);
  assert.ok(audit((snapshots) => { snapshots[0].focusTargets[0].visible = false; }).focusViolations.length > 0);
  assert.ok(audit((snapshots) => { snapshots[0].persistentEntities[0].bounds.x = 0; snapshots[0].focusTargets[0].bounds.x = 0; }).primaryRoiViolations.length > 0);
  assert.ok(audit((snapshots) => { snapshots[0].pathFollowers[0].distance = 2.25; }).pathFollowerViolations.length > 0);
  assert.ok(audit((snapshots) => { snapshots[0].labels[0].fontSize = 31; }).legibilityViolations.length > 0);
  assert.ok(audit((snapshots) => { snapshots[0].labels[1].fontSize = 23; }).legibilityViolations.length > 0);
  assert.ok(audit((snapshots) => { snapshots[0].labels[1].effectiveFontSize = 23; }).legibilityViolations.some((violation) => violation.reason === "effective_font_size"));
  assert.ok(audit((snapshots) => { snapshots[0].labels[1].glyphCompression = true; }).legibilityViolations.some((violation) => violation.reason === "glyph_compression"));
  assert.ok(audit((snapshots) => { snapshots[0].labels[0].foreground = snapshots[0].labels[0].background; }).contrastViolations.length > 0);
  assert.ok(audit((snapshots) => { snapshots[0].labels[0].bounds = { x: 120, y: 960, width: 240, height: 42 }; }).legibilityViolations.length > 0);
  const hiddenLabel = audit((snapshots) => { for (const snapshot of snapshots) snapshot.labels.find((label) => label.id === "key_label").visible = false; });
  assert.deepEqual(hiddenLabel.unobservedLabelIds, ["key_label"]);
  assert.ok(hiddenLabel.legibilityViolations.some((violation) => violation.reason === "label_unobserved" && violation.labelId === "key_label"));
  assert.ok(audit((snapshots) => { snapshots[1].labels.pop(); }).legibilityViolations.some((violation) => violation.reason === "label_set_changed"));
  assert.ok(audit((snapshots) => { for (const snapshot of snapshots) snapshot.labels = []; }).legibilityViolations.some((violation) => violation.reason === "labels_unobserved"));
});

test("browser harness forwards strict persistent expectations into geometry validation", async () => {
  const fixture = mockBrowser();
  const result = await runBrowserSeekProof({ html, width: 720, height: 1280, fps: 30, durationFrames: 300, chromePath: "/mock/chrome", seekSequence: [0, 1, 0], expectedPersistentEntityIds: ["signal_evidence"] }, { launch: async () => fixture.browser });
  assert.equal(result.passed, false);
  assert.ok(result.geometryAudit.persistentContinuityViolations.length > 0);
});

test("browser harness rejects invalid sequences before browser launch", async () => {
  let launched = false;
  await assert.rejects(
    runBrowserSeekProof({ html, width: 720, height: 1280, fps: 30, durationFrames: 300, chromePath: "/mock/chrome", seekSequence: [300] }, { launch: async () => { launched = true; } }),
    { code: "BROWSER_SEEK_SEQUENCE_INVALID" },
  );
  assert.equal(launched, false);
  await assert.rejects(
    runBrowserSeekProof({ html, width: 720, height: 1280, fps: 30, durationFrames: 300, chromePath: "/mock/chrome", seekSequence: [0, 1], timeoutMs: 100 }, { launch: async () => { launched = true; } }),
    { code: "BROWSER_SEEK_TIMEOUT_INVALID" },
  );
  assert.equal(launched, false);
});

test("browser launch failures are reduced to a stable safe code", async () => {
  await assert.rejects(
    runBrowserSeekProof({ html, width: 720, height: 1280, fps: 30, durationFrames: 300, chromePath: "/mock/chrome", seekSequence: [0, 1] }, { launch: async () => { throw new Error("/Users/private raw browser output"); } }),
    (error) => error.code === "BROWSER_SEEK_RUNTIME_FAILED" && !JSON.stringify(error).includes("/Users"),
  );
});

test("browser harness blocks and safely summarizes an injected external request", async () => {
  const fixture = mockBrowser();
  await assert.rejects(
    runBrowserSeekProof({ html, width: 720, height: 1280, fps: 30, durationFrames: 300, chromePath: "/mock/chrome", seekSequence: [0, 1], remoteProbe: true }, { launch: async () => fixture.browser }),
    (error) => {
      assert.equal(error.code, "BROWSER_EXTERNAL_REQUEST_BLOCKED");
      assert.deepEqual(error.details, { externalRequestCount: 1, blockedExternalRequestCount: 1, resourceClasses: [{ resourceClass: "image", count: 1 }] });
      assert.doesNotMatch(JSON.stringify(error.details), /https|probe|url|header|cookie/i);
      return true;
    },
  );
});
