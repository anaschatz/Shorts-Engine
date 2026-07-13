import test from "node:test";
import assert from "node:assert/strict";
import { validateCompositionIsolation } from "../renderer/hyperframes/composition-isolation.mjs";
import { runBrowserSeekProof } from "../renderer/hyperframes/browser-seek-harness.mjs";

function mockBrowser() {
  const listeners = new Map();
  let renderedFrame = 0;
  let loads = 0;
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
      renderedFrame = input.requestedFrame;
      return renderedFrame;
    },
    screenshot: async () => Buffer.from(`pixels:${renderedFrame}`),
    close: async () => {},
    get loads() { return loads; },
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
  assert.equal(fixture.page.loads, 1);
  assert.deepEqual(result.repeatedFrames.map((entry) => [entry.frame, entry.equal]), [[27, true], [291, true]]);
  assert.equal(result.captures[0].sha256, result.captures[2].sha256);
  assert.equal(result.captures[3].sha256, result.captures[5].sha256);
  assert.equal(result.externalRequestCount, 0);
  assert.equal(result.passed, true);
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
