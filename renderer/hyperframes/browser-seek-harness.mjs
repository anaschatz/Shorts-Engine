import { createHash } from "node:crypto";
import puppeteer from "puppeteer-core";
import { validateCompositionIsolation } from "./composition-isolation.mjs";

const HASH_RE = /^[a-f0-9]{64}$/;
const ALLOWED_PROTOCOLS = new Set(["about:", "data:", "blob:"]);
const RESOURCE_CLASSES = new Set(["document", "stylesheet", "image", "media", "font", "script", "xhr", "fetch", "websocket", "other"]);
const ENTITY_RE = /^[a-z][a-z0-9_-]{2,79}$/;

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
const roundedRect = (rect) => Object.freeze({ x: Number(rect.x.toFixed(3)), y: Number(rect.y.toFixed(3)), width: Number(rect.width.toFixed(3)), height: Number(rect.height.toFixed(3)) });

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
  return [...grouped.entries()].filter(([, hashes]) => hashes.length > 1).map(([frame, hashes]) => Object.freeze({ frame, occurrences: hashes.length, sha256: hashes[0], equal: hashes.every((hash) => hash === hashes[0]) }));
}

function checkedRect(value, field) {
  if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.width <= 0 || value.height <= 0) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID", { field });
  return roundedRect(value);
}

function intersects(a, b) {
  return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5;
}

export function validateGeometrySnapshots(snapshots, width, height) {
  if (!Array.isArray(snapshots) || !snapshots.length || !Number.isInteger(width) || !Number.isInteger(height)) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
  const semanticRoi = checkedRect(snapshots[0]?.semanticRoi, "semanticRoi");
  const captionSafeZone = checkedRect(snapshots[0]?.captionSafeZone, "captionSafeZone");
  if (semanticRoi.x < 0 || semanticRoi.y < 0 || semanticRoi.x + semanticRoi.width > width || semanticRoi.y + semanticRoi.height > height || captionSafeZone.x < 0 || captionSafeZone.y < 0 || captionSafeZone.x + captionSafeZone.width > width || captionSafeZone.y + captionSafeZone.height > height) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
  const clippedEntities = [], captionSafeZoneViolations = [], checkpoints = [];
  let entityObservationCount = 0;
  for (const snapshot of snapshots) {
    if (!snapshot || !Number.isInteger(snapshot.frame) || !Array.isArray(snapshot.entities)) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
    const snapshotRoi = checkedRect(snapshot.semanticRoi, "semanticRoi"), snapshotSafe = checkedRect(snapshot.captionSafeZone, "captionSafeZone");
    if (JSON.stringify(snapshotRoi) !== JSON.stringify(semanticRoi) || JSON.stringify(snapshotSafe) !== JSON.stringify(captionSafeZone)) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
    const visible = [];
    for (const entity of snapshot.entities) {
      if (!entity || !ENTITY_RE.test(entity.entityId || "") || typeof entity.visible !== "boolean" || !new Set(["avoid", "allow"]).has(entity.captionPolicy)) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
      if (!entity.visible) continue;
      const bounds = checkedRect(entity.bounds, `entities.${entity.entityId}`);
      entityObservationCount += 1;
      visible.push(Object.freeze({ entityId: entity.entityId, captionPolicy: entity.captionPolicy, bounds }));
      if (bounds.x < -0.5 || bounds.y < -0.5 || bounds.x + bounds.width > width + 0.5 || bounds.y + bounds.height > height + 0.5) clippedEntities.push(Object.freeze({ frame: snapshot.frame, entityId: entity.entityId, bounds }));
      if (entity.captionPolicy === "avoid" && intersects(bounds, captionSafeZone)) captionSafeZoneViolations.push(Object.freeze({ frame: snapshot.frame, entityId: entity.entityId, bounds }));
    }
    checkpoints.push(Object.freeze({ frame: snapshot.frame, visibleEntities: visible }));
  }
  return Object.freeze({ passed: clippedEntities.length === 0 && captionSafeZoneViolations.length === 0, semanticRoi, captionSafeZone, checkpointCount: snapshots.length, entityObservationCount, clippedEntities, captionSafeZoneViolations, checkpoints });
}

export async function runBrowserSeekProof(input, dependencies = {}) {
  const request = validateRequest(input);
  const isolation = validateCompositionIsolation(request.html);
  const launch = dependencies.launch || ((options) => puppeteer.launch(options));
  let browser, page, resolveBlockedRequest, stage = "launch";
  const blockedRequestObserved = new Promise((resolve) => { resolveBlockedRequest = resolve; });
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
    stage = "new_page";
    page = await browser.newPage();
    page.setDefaultTimeout(request.timeoutMs);
    page.setDefaultNavigationTimeout(request.timeoutMs);
    await page.setViewport({ width: request.width, height: request.height, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on("request", (networkRequest) => {
      let protocol = "";
      try { protocol = new URL(networkRequest.url()).protocol; } catch { protocol = ""; }
      if (!ALLOWED_PROTOCOLS.has(protocol)) {
        counters.externalRequestCount += 1;
        counters.blockedExternalRequestCount += 1;
        const resourceClass = safeClass(networkRequest.resourceType());
        resourceCounts.set(resourceClass, (resourceCounts.get(resourceClass) || 0) + 1);
        resolveBlockedRequest();
        networkRequest.abort("blockedbyclient").catch(() => {});
      } else networkRequest.continue().catch(() => {});
    });
    page.on("load", () => { pageLoadCount += 1; });
    if (input.remoteProbe === true) await page.setBypassCSP(true);
    stage = "set_content";
    await page.setContent(request.html, { waitUntil: "load", timeout: Math.min(request.timeoutMs, 15_000) });
    stage = "fonts_ready";
    await page.evaluate(async () => { await document.fonts.ready; return true; });
    stage = "runtime_isolation";
    const runtime = await page.evaluate(() => ({ timelineCount: Object.keys(window.__timelines || {}).length, animationCount: document.getAnimations().length, compositionCount: document.querySelectorAll("[data-composition-id]").length }));
    if (runtime.timelineCount !== 1 || runtime.animationCount !== 0 || runtime.compositionCount < 1) throw new BrowserSeekError("BROWSER_RUNTIME_ISOLATION_INVALID");
    if (input.remoteProbe === true) {
      stage = "remote_probe";
      await page.evaluate(() => {
        const probe = document.createElement("img");
        probe.alt = "";
        probe.src = "https://browser-seek-probe.invalid/asset.png";
        document.body.appendChild(probe);
      });
      await Promise.race([blockedRequestObserved, new Promise((_, reject) => setTimeout(() => reject(new BrowserSeekError("BROWSER_EXTERNAL_PROBE_NOT_OBSERVED")), Math.min(2_000, request.timeoutMs)))]);
      throw new BrowserSeekError("BROWSER_EXTERNAL_REQUEST_BLOCKED", {
        externalRequestCount: counters.externalRequestCount,
        blockedExternalRequestCount: counters.blockedExternalRequestCount,
        resourceClasses: [...resourceCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([resourceClass, count]) => ({ resourceClass, count })),
      });
    }
    const captures = [], geometrySnapshots = [];
    stage = "seek_capture";
    for (let index = 0; index < request.seekSequence.length; index += 1) {
      const frame = request.seekSequence[index];
      const result = await page.evaluate(({ requestedFrame, fps }) => {
        const timeline = Object.values(window.__timelines || {})[0];
        if (!timeline || typeof timeline.seek !== "function") return { renderedFrame: -1, geometry: null };
        timeline.seek(requestedFrame / fps);
        const rect = (element) => {
          if (!element) return null;
          const value = element.getBoundingClientRect();
          return { x: value.x, y: value.y, width: value.width, height: value.height };
        };
        const effectiveOpacity = (element) => {
          let opacity = 1, current = element;
          while (current && current instanceof Element) {
            const style = getComputedStyle(current);
            if (style.display === "none" || style.visibility === "hidden") return 0;
            opacity *= Number(style.opacity || 1);
            current = current.parentElement;
          }
          return opacity;
        };
        const geometry = {
          semanticRoi: rect(document.querySelector("[data-semantic-roi]")),
          captionSafeZone: rect(document.querySelector("[data-caption-safe-zone]")),
          entities: [...document.querySelectorAll("[data-entity-id]")].map((entity) => ({
            entityId: entity.dataset.entityId,
            captionPolicy: entity.dataset.captionPolicy === "allow" ? "allow" : "avoid",
            visible: effectiveOpacity(entity) > 0.01,
            bounds: rect(entity),
          })),
        };
        return { renderedFrame: Number(document.documentElement.dataset.renderedFrame), geometry };
      }, { requestedFrame: frame, fps: request.fps });
      if (result.renderedFrame !== frame) throw new BrowserSeekError("BROWSER_SEEK_FRAME_MISMATCH");
      geometrySnapshots.push({ frame, ...result.geometry });
      const png = await page.screenshot({ type: "png", captureBeyondViewport: false, clip: { x: 0, y: 0, width: request.width, height: request.height } });
      const hash = sha256(png);
      if (!HASH_RE.test(hash)) throw new BrowserSeekError("BROWSER_FRAME_HASH_INVALID");
      captures.push(Object.freeze({ sequenceIndex: index, frame, sha256: hash }));
    }
    const repeatedFrames = repeatedFrameResults(captures);
    if (!repeatedFrames.length || repeatedFrames.some((entry) => !entry.equal)) throw new BrowserSeekError("BROWSER_RANDOM_ACCESS_NONDETERMINISTIC");
    if (counters.externalRequestCount !== 0 || counters.blockedExternalRequestCount !== 0) throw new BrowserSeekError("BROWSER_EXTERNAL_REQUEST_BLOCKED");
    stage = "geometry_audit";
    const geometryAudit = validateGeometrySnapshots(geometrySnapshots, request.width, request.height);
    return Object.freeze({
      seekSequence: [...request.seekSequence], captures, repeatedFrames,
      loadedOnce: pageLoadCount === 1, pageLoadCount, stateIsolation: isolation,
      externalRequestCount: counters.externalRequestCount, blockedExternalRequestCount: counters.blockedExternalRequestCount,
      resourceClasses: [...resourceCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([resourceClass, count]) => ({ resourceClass, count })),
      geometryAudit,
      passed: pageLoadCount === 1 && repeatedFrames.every((entry) => entry.equal) && geometryAudit.passed,
    });
  } catch (error) {
    if (error instanceof BrowserSeekError) throw error;
    throw new BrowserSeekError("BROWSER_SEEK_RUNTIME_FAILED", { stage });
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
