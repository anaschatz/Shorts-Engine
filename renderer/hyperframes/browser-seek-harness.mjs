import { createHash } from "node:crypto";
import puppeteer from "puppeteer-core";
import { validateCompositionIsolation } from "./composition-isolation.mjs";

const HASH_RE = /^[a-f0-9]{64}$/;
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const RESOURCE_CLASSES = new Set(["document", "stylesheet", "image", "media", "font", "script", "xhr", "fetch", "websocket", "other"]);

export class BrowserSeekError extends Error {
  constructor(code, details = null) {
    super("Browser seek proof failed safely.");
    this.name = "BrowserSeekError";
    this.code = code;
    if (details) this.details = Object.freeze(details);
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const safeClass = (value) => RESOURCE_CLASSES.has(value) ? value : "other";

function validateRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BrowserSeekError("BROWSER_SEEK_REQUEST_INVALID");
  const { html, width, height, fps, durationFrames, seekSequence, chromePath } = input;
  const timeoutMs = input.timeoutMs === undefined ? 30_000 : input.timeoutMs;
  if (typeof chromePath !== "string" || !chromePath || typeof html !== "string") throw new BrowserSeekError("BROWSER_SEEK_REQUEST_INVALID");
  if (![width, height, fps, durationFrames].every(Number.isInteger) || width < 360 || width > 2160 || height < 640 || height > 3840 || fps < 24 || fps > 60 || durationFrames < 30 || durationFrames > 3600) throw new BrowserSeekError("BROWSER_SEEK_REQUEST_INVALID");
  if (!Array.isArray(seekSequence) || seekSequence.length < 2 || seekSequence.length > 40 || seekSequence.some((frame) => !Number.isInteger(frame) || frame < 0 || frame >= durationFrames)) throw new BrowserSeekError("BROWSER_SEEK_SEQUENCE_INVALID");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 120_000) throw new BrowserSeekError("BROWSER_SEEK_TIMEOUT_INVALID");
  return { html, width, height, fps, durationFrames, seekSequence, chromePath, timeoutMs };
}

function repeatedFrameResults(captures) {
  const grouped = new Map();
  captures.forEach((capture) => {
    const entries = grouped.get(capture.frame) || [];
    entries.push(capture.sha256);
    grouped.set(capture.frame, entries);
  });
  return [...grouped.entries()].filter(([, hashes]) => hashes.length > 1).map(([frame, hashes]) => Object.freeze({
    frame,
    occurrences: hashes.length,
    sha256: hashes[0],
    equal: hashes.every((hash) => hash === hashes[0]),
  }));
}

export async function runBrowserSeekProof(input, dependencies = {}) {
  const request = validateRequest(input);
  const isolation = validateCompositionIsolation(request.html);
  const launch = dependencies.launch || ((options) => puppeteer.launch(options));
  let browser, page;
  const counters = { externalRequestCount: 0, blockedExternalRequestCount: 0 };
  const resourceCounts = new Map();
  let pageLoadCount = 0;
  try {
    browser = await launch({
      executablePath: request.chromePath,
      headless: true,
      timeout: Math.min(request.timeoutMs, 15_000),
      protocolTimeout: request.timeoutMs,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-background-networking", "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND"],
    });
    page = await browser.newPage();
    page.setDefaultTimeout(request.timeoutMs);
    page.setDefaultNavigationTimeout(request.timeoutMs);
    await page.setViewport({ width: request.width, height: request.height, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on("request", (networkRequest) => {
      let protocol = "";
      try { protocol = new URL(networkRequest.url()).protocol; } catch { protocol = ""; }
      if (EXTERNAL_PROTOCOLS.has(protocol)) {
        counters.externalRequestCount += 1;
        counters.blockedExternalRequestCount += 1;
        const resourceClass = safeClass(networkRequest.resourceType());
        resourceCounts.set(resourceClass, (resourceCounts.get(resourceClass) || 0) + 1);
        networkRequest.abort("blockedbyclient").catch(() => {});
      } else networkRequest.continue().catch(() => {});
    });
    page.on("load", () => { pageLoadCount += 1; });
    if (input.remoteProbe === true) await page.setBypassCSP(true);
    await page.setContent(request.html, { waitUntil: "load", timeout: Math.min(request.timeoutMs, 15_000) });
    const runtime = await page.evaluate(() => ({
      timelineCount: Object.keys(window.__timelines || {}).length,
      animationCount: document.getAnimations().length,
      compositionCount: document.querySelectorAll("[data-composition-id]").length,
    }));
    if (runtime.timelineCount !== 1 || runtime.animationCount !== 0 || runtime.compositionCount < 1) throw new BrowserSeekError("BROWSER_RUNTIME_ISOLATION_INVALID");
    if (input.remoteProbe === true) {
      await page.evaluate(() => {
        const probe = document.createElement("img");
        probe.alt = "";
        probe.src = "https://browser-seek-probe.invalid/asset.png";
        document.body.appendChild(probe);
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (counters.blockedExternalRequestCount < 1) throw new BrowserSeekError("BROWSER_EXTERNAL_PROBE_NOT_OBSERVED");
      throw new BrowserSeekError("BROWSER_EXTERNAL_REQUEST_BLOCKED", {
        externalRequestCount: counters.externalRequestCount,
        blockedExternalRequestCount: counters.blockedExternalRequestCount,
        resourceClasses: [...resourceCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([resourceClass, count]) => ({ resourceClass, count })),
      });
    }
    const captures = [];
    for (let index = 0; index < request.seekSequence.length; index += 1) {
      const frame = request.seekSequence[index];
      const renderedFrame = await page.evaluate(({ requestedFrame, fps }) => {
        const timeline = Object.values(window.__timelines || {})[0];
        if (!timeline || typeof timeline.seek !== "function") return -1;
        timeline.seek(requestedFrame / fps);
        return Number(document.documentElement.dataset.renderedFrame);
      }, { requestedFrame: frame, fps: request.fps });
      if (renderedFrame !== frame) throw new BrowserSeekError("BROWSER_SEEK_FRAME_MISMATCH");
      const png = await page.screenshot({ type: "png", captureBeyondViewport: false, clip: { x: 0, y: 0, width: request.width, height: request.height } });
      const hash = sha256(png);
      if (!HASH_RE.test(hash)) throw new BrowserSeekError("BROWSER_FRAME_HASH_INVALID");
      captures.push(Object.freeze({ sequenceIndex: index, frame, sha256: hash }));
    }
    const repeatedFrames = repeatedFrameResults(captures);
    if (!repeatedFrames.length || repeatedFrames.some((entry) => !entry.equal)) throw new BrowserSeekError("BROWSER_RANDOM_ACCESS_NONDETERMINISTIC");
    if (counters.externalRequestCount !== 0 || counters.blockedExternalRequestCount !== 0) throw new BrowserSeekError("BROWSER_EXTERNAL_REQUEST_BLOCKED");
    return Object.freeze({
      seekSequence: [...request.seekSequence],
      captures,
      repeatedFrames,
      loadedOnce: pageLoadCount === 1,
      pageLoadCount,
      stateIsolation: isolation,
      externalRequestCount: counters.externalRequestCount,
      blockedExternalRequestCount: counters.blockedExternalRequestCount,
      resourceClasses: [...resourceCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([resourceClass, count]) => ({ resourceClass, count })),
      passed: pageLoadCount === 1 && repeatedFrames.every((entry) => entry.equal),
    });
  } catch (error) {
    if (error instanceof BrowserSeekError) throw error;
    throw new BrowserSeekError("BROWSER_SEEK_RUNTIME_FAILED");
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
