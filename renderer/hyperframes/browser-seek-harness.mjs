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
  const expectedPathFollowerIds = input.expectedPathFollowerIds === undefined ? [] : input.expectedPathFollowerIds;
  const expectedPersistentEntityIds = input.expectedPersistentEntityIds === undefined ? [] : input.expectedPersistentEntityIds;
  const expectedVisualStateIds = input.expectedVisualStateIds === undefined ? [] : input.expectedVisualStateIds;
  const expectedFocusIntervalIds = input.expectedFocusIntervalIds === undefined ? [] : input.expectedFocusIntervalIds;
  const expectedTransitionIds = input.expectedTransitionIds === undefined ? [] : input.expectedTransitionIds;
  const legibilityProfile = input.legibilityProfile === undefined ? null : input.legibilityProfile;
  if (typeof chromePath !== "string" || !chromePath || typeof html !== "string") throw new BrowserSeekError("BROWSER_SEEK_REQUEST_INVALID");
  if (![width, height, fps, durationFrames].every(Number.isInteger) || width < 360 || width > 2160 || height < 640 || height > 3840 || fps < 24 || fps > 60 || durationFrames < 30 || durationFrames > 3600) throw new BrowserSeekError("BROWSER_SEEK_REQUEST_INVALID");
  if (!Array.isArray(seekSequence) || seekSequence.length < 2 || seekSequence.length > 40 || seekSequence.some((frame) => !Number.isInteger(frame) || frame < 0 || frame >= durationFrames)) throw new BrowserSeekError("BROWSER_SEEK_SEQUENCE_INVALID");
  const cacheWarmupFrames = input.cacheWarmupFrames === undefined ? repeatedSeekFrames(seekSequence) : input.cacheWarmupFrames;
  if (!Array.isArray(cacheWarmupFrames) || cacheWarmupFrames.length > 20 || cacheWarmupFrames.some((frame) => !Number.isInteger(frame) || frame < 0 || frame >= durationFrames || !seekSequence.includes(frame)) || new Set(cacheWarmupFrames).size !== cacheWarmupFrames.length) throw new BrowserSeekError("BROWSER_SEEK_SEQUENCE_INVALID");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 120_000) throw new BrowserSeekError("BROWSER_SEEK_TIMEOUT_INVALID");
  if (!Array.isArray(expectedPathFollowerIds) || expectedPathFollowerIds.length > 20 || expectedPathFollowerIds.some((id) => !ENTITY_RE.test(id)) || new Set(expectedPathFollowerIds).size !== expectedPathFollowerIds.length) throw new BrowserSeekError("BROWSER_SEEK_REQUEST_INVALID");
  for (const [field, values] of Object.entries({ expectedPersistentEntityIds, expectedVisualStateIds, expectedFocusIntervalIds, expectedTransitionIds })) {
    if (!Array.isArray(values) || values.length > 24 || values.some((id) => !ENTITY_RE.test(id)) || new Set(values).size !== values.length) throw new BrowserSeekError("BROWSER_SEEK_REQUEST_INVALID", { field });
  }
  if (![null, "mobile_720_v1"].includes(legibilityProfile)) throw new BrowserSeekError("BROWSER_SEEK_REQUEST_INVALID");
  return { html, width, height, fps, durationFrames, seekSequence, cacheWarmupFrames, chromePath, timeoutMs, expectedPathFollowerIds, expectedPersistentEntityIds, expectedVisualStateIds, expectedFocusIntervalIds, expectedTransitionIds, legibilityProfile };
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

function repeatedSeekFrames(sequence) {
  const counts = new Map();
  for (const frame of sequence) counts.set(frame, (counts.get(frame) || 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([frame]) => frame).sort((a, b) => a - b);
}

function checkedRect(value, field) {
  if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.width <= 0 || value.height <= 0) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID", { field });
  return roundedRect(value);
}

function intersects(a, b) {
  return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5;
}

function contains(outer, inner) {
  return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
}

function rgb(value) {
  const hex = String(value || "").match(/^#([a-f0-9]{6})$/i);
  if (hex) return [0, 2, 4].map((offset) => Number.parseInt(hex[1].slice(offset, offset + 2), 16));
  const functional = String(value || "").match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (functional) return functional.slice(1, 4).map(Number);
  throw new BrowserSeekError("BROWSER_LEGIBILITY_AUDIT_INVALID");
}

function luminance(value) {
  const channels = rgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export function validateGeometrySnapshots(snapshots, width, height, expectedPathFollowerIds = [], expectations = {}) {
  if (!Array.isArray(snapshots) || !snapshots.length || !Number.isInteger(width) || !Number.isInteger(height)) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
  if (!Array.isArray(expectedPathFollowerIds) || expectedPathFollowerIds.some((id) => !ENTITY_RE.test(id)) || new Set(expectedPathFollowerIds).size !== expectedPathFollowerIds.length) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
  const semanticRoi = checkedRect(snapshots[0]?.semanticRoi, "semanticRoi");
  const captionSafeZone = checkedRect(snapshots[0]?.captionSafeZone, "captionSafeZone");
  if (semanticRoi.x < 0 || semanticRoi.y < 0 || semanticRoi.x + semanticRoi.width > width || semanticRoi.y + semanticRoi.height > height || captionSafeZone.x < 0 || captionSafeZone.y < 0 || captionSafeZone.x + captionSafeZone.width > width || captionSafeZone.y + captionSafeZone.height > height) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
  const expectedPersistentEntityIds = expectations.expectedPersistentEntityIds || [];
  const expectedVisualStateIds = expectations.expectedVisualStateIds || [];
  const expectedFocusIntervalIds = expectations.expectedFocusIntervalIds || [];
  const expectedTransitionIds = expectations.expectedTransitionIds || [];
  const legibilityProfile = expectations.legibilityProfile || null;
  for (const values of [expectedPersistentEntityIds, expectedVisualStateIds, expectedFocusIntervalIds, expectedTransitionIds]) if (!Array.isArray(values) || values.some((id) => !ENTITY_RE.test(id))) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
  const clippedEntities = [], captionSafeZoneViolations = [], pathFollowerViolations = [], persistentContinuityViolations = [], focusViolations = [], primaryRoiViolations = [], legibilityViolations = [], contrastViolations = [], checkpoints = [];
  let entityObservationCount = 0, pathFollowerObservationCount = 0, persistentObservationCount = 0, labelObservationCount = 0;
  const observedPathFollowerIds = new Set();
  const observedLabelIds = new Set();
  let markedLabelIds = null;
  const persistentStateCoverage = new Map(expectedPersistentEntityIds.map((entityId) => [entityId, new Set()]));
  const observedFocusIntervalIds = new Set();
  const transitionPathHashes = new Map(expectedTransitionIds.map((transitionId) => [transitionId, new Set()]));
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
    if (expectedVisualStateIds.length && (!ENTITY_RE.test(snapshot.visualStateId || "") || !expectedVisualStateIds.includes(snapshot.visualStateId))) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
    if (expectedFocusIntervalIds.length && (!ENTITY_RE.test(snapshot.focusIntervalId || "") || !expectedFocusIntervalIds.includes(snapshot.focusIntervalId) || !ENTITY_RE.test(snapshot.focusPrimaryEntityId || ""))) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
    const persistentEntities = snapshot.persistentEntities === undefined ? [] : snapshot.persistentEntities;
    if (!Array.isArray(persistentEntities)) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
    for (const expectedEntityId of expectedPersistentEntityIds) {
      const matches = persistentEntities.filter((entity) => entity.entityId === expectedEntityId);
      const domMatches = snapshot.entities.filter((entity) => entity.entityId === expectedEntityId);
      if (matches.length !== 1 || domMatches.length !== 1) {
        persistentContinuityViolations.push(Object.freeze({ frame: snapshot.frame, entityId: expectedEntityId, reason: "dom_count" }));
        continue;
      }
      const entity = matches[0];
      if (typeof entity.visible !== "boolean" || typeof entity.pathData !== "string" || !entity.pathData || entity.pathData.length > 32768 || entity.stateId !== snapshot.visualStateId) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
      if (!entity.visible) {
        persistentContinuityViolations.push(Object.freeze({ frame: snapshot.frame, entityId: expectedEntityId, reason: "not_visible" }));
        continue;
      }
      const bounds = checkedRect(entity.bounds, `persistentEntities.${expectedEntityId}`);
      persistentObservationCount += 1;
      persistentStateCoverage.get(expectedEntityId)?.add(snapshot.visualStateId);
      if (!contains(semanticRoi, bounds)) primaryRoiViolations.push(Object.freeze({ frame: snapshot.frame, entityId: expectedEntityId, bounds }));
      if (snapshot.transitionId && snapshot.transitionId !== "none" && transitionPathHashes.has(snapshot.transitionId)) transitionPathHashes.get(snapshot.transitionId).add(sha256(entity.pathData));
    }
    const focusTargets = snapshot.focusTargets === undefined ? [] : snapshot.focusTargets;
    if (!Array.isArray(focusTargets)) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
    if (expectedFocusIntervalIds.length) {
      if (focusTargets.some((target) => !ENTITY_RE.test(target.entityId || "") || !["primary", "supporting", "dimmed"].includes(target.role) || typeof target.visible !== "boolean")) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
      const primaryTargets = focusTargets.filter((target) => target.role === "primary");
      const visiblePrimaries = primaryTargets.filter((target) => target.visible);
      if (primaryTargets.length !== 1) focusViolations.push(Object.freeze({ frame: snapshot.frame, reason: "primary_role_count", count: primaryTargets.length }));
      if (visiblePrimaries.length !== 1) focusViolations.push(Object.freeze({ frame: snapshot.frame, reason: "visible_primary_count", count: visiblePrimaries.length }));
      const focusedPrimary = primaryTargets.find((target) => target.entityId === snapshot.focusPrimaryEntityId);
      if (!focusedPrimary) focusViolations.push(Object.freeze({ frame: snapshot.frame, reason: "primary_binding_missing" }));
      if (focusedPrimary?.visible) {
        const bounds = checkedRect(focusedPrimary.bounds, `focusTargets.${focusedPrimary.entityId}`);
        observedFocusIntervalIds.add(snapshot.focusIntervalId);
        if (!contains(semanticRoi, bounds)) primaryRoiViolations.push(Object.freeze({ frame: snapshot.frame, entityId: focusedPrimary.entityId, bounds }));
      }
    }
    const labels = snapshot.labels === undefined ? [] : snapshot.labels;
    if (!Array.isArray(labels)) throw new BrowserSeekError("BROWSER_LEGIBILITY_AUDIT_INVALID");
    if (legibilityProfile === "mobile_720_v1") {
      const snapshotLabelIds = labels.map((label) => {
        if (!label || !ENTITY_RE.test(label.id || "") || !["key", "secondary"].includes(label.role) || typeof label.visible !== "boolean") throw new BrowserSeekError("BROWSER_LEGIBILITY_AUDIT_INVALID");
        return label.id;
      });
      if (new Set(snapshotLabelIds).size !== snapshotLabelIds.length) throw new BrowserSeekError("BROWSER_LEGIBILITY_AUDIT_INVALID");
      if (markedLabelIds === null) markedLabelIds = new Set(snapshotLabelIds);
      else {
        const current = new Set(snapshotLabelIds);
        const missingLabelIds = [...markedLabelIds].filter((labelId) => !current.has(labelId)).sort();
        const unexpectedLabelIds = [...current].filter((labelId) => !markedLabelIds.has(labelId)).sort();
        if (missingLabelIds.length || unexpectedLabelIds.length) legibilityViolations.push(Object.freeze({ frame: snapshot.frame, reason: "label_set_changed", missingLabelIds, unexpectedLabelIds }));
      }
      for (const label of labels) {
        if (!label.visible) continue;
        const bounds = checkedRect(label.bounds, `labels.${label.id}`);
        const minimum = label.role === "key" ? 32 : 24;
        labelObservationCount += 1;
        observedLabelIds.add(label.id);
        if (!Number.isFinite(label.fontSize) || label.fontSize + 0.01 < minimum) legibilityViolations.push(Object.freeze({ frame: snapshot.frame, labelId: label.id, role: label.role, minimum, actual: Number(label.fontSize?.toFixed?.(3) || 0) }));
        if (intersects(bounds, captionSafeZone)) legibilityViolations.push(Object.freeze({ frame: snapshot.frame, labelId: label.id, role: label.role, reason: "caption_overlap" }));
        const contrast = contrastRatio(label.foreground, label.background);
        if (contrast < 4.5) contrastViolations.push(Object.freeze({ frame: snapshot.frame, labelId: label.id, contrast: Number(contrast.toFixed(3)) }));
      }
    }
    const pathFollowers = snapshot.pathFollowers === undefined ? [] : snapshot.pathFollowers;
    if (!Array.isArray(pathFollowers)) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
    for (const follower of pathFollowers) {
      if (!follower || !ENTITY_RE.test(follower.followerId || "") || !ENTITY_RE.test(follower.pathId || "") || typeof follower.visible !== "boolean") throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
      if (!follower.visible) continue;
      if (!Number.isFinite(follower.distance) || follower.distance < 0) throw new BrowserSeekError("BROWSER_GEOMETRY_AUDIT_INVALID");
      pathFollowerObservationCount += 1;
      observedPathFollowerIds.add(follower.followerId);
      if (follower.distance > 1.5) pathFollowerViolations.push(Object.freeze({ frame: snapshot.frame, followerId: follower.followerId, pathId: follower.pathId, distance: Number(follower.distance.toFixed(3)) }));
    }
    checkpoints.push(Object.freeze({ frame: snapshot.frame, visualStateId: snapshot.visualStateId || null, focusIntervalId: snapshot.focusIntervalId || null, visibleEntities: visible }));
  }
  const unobservedPathFollowerIds = expectedPathFollowerIds.filter((id) => !observedPathFollowerIds.has(id));
  const persistentStateCoverageSummary = Object.fromEntries([...persistentStateCoverage.entries()].map(([entityId, states]) => [entityId, [...states].sort()]));
  for (const [entityId, states] of persistentStateCoverage.entries()) for (const stateId of expectedVisualStateIds) if (!states.has(stateId)) persistentContinuityViolations.push(Object.freeze({ entityId, stateId, reason: "state_unobserved" }));
  const markedLabelIdList = [...(markedLabelIds || [])].sort();
  const observedLabelIdList = [...observedLabelIds].sort();
  const unobservedLabelIds = markedLabelIdList.filter((labelId) => !observedLabelIds.has(labelId));
  if (legibilityProfile === "mobile_720_v1" && labelObservationCount === 0) legibilityViolations.push(Object.freeze({ reason: "labels_unobserved" }));
  for (const labelId of unobservedLabelIds) legibilityViolations.push(Object.freeze({ labelId, reason: "label_unobserved" }));
  const unobservedFocusIntervalIds = expectedFocusIntervalIds.filter((id) => !observedFocusIntervalIds.has(id));
  for (const intervalId of unobservedFocusIntervalIds) focusViolations.push(Object.freeze({ intervalId, reason: "focus_unobserved" }));
  const observedTransitionIds = [];
  for (const [transitionId, hashes] of transitionPathHashes.entries()) {
    if (hashes.size < 3) persistentContinuityViolations.push(Object.freeze({ transitionId, reason: "transition_geometry_unproven" }));
    else observedTransitionIds.push(transitionId);
  }
  const passed = clippedEntities.length === 0 && captionSafeZoneViolations.length === 0 && pathFollowerViolations.length === 0 && unobservedPathFollowerIds.length === 0 && persistentContinuityViolations.length === 0 && focusViolations.length === 0 && primaryRoiViolations.length === 0 && legibilityViolations.length === 0 && contrastViolations.length === 0;
  return Object.freeze({ passed, semanticRoi, captionSafeZone, checkpointCount: snapshots.length, entityObservationCount, pathFollowerObservationCount, persistentObservationCount, labelObservationCount, markedLabelIds: markedLabelIdList, observedLabelIds: observedLabelIdList, unobservedLabelIds, observedPathFollowerIds: [...observedPathFollowerIds].sort(), unobservedPathFollowerIds, persistentStateCoverage: persistentStateCoverageSummary, observedTransitionIds: observedTransitionIds.sort(), observedFocusIntervalIds: [...observedFocusIntervalIds].sort(), unobservedFocusIntervalIds, clippedEntities, captionSafeZoneViolations, pathFollowerViolations, persistentContinuityViolations, focusViolations, primaryRoiViolations, legibilityViolations, contrastViolations, checkpoints });
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
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-lcd-text", "--font-render-hinting=none", "--force-color-profile=srgb", "--disable-background-networking", "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND"],
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
    stage = "seek_warmup";
    for (const frame of request.cacheWarmupFrames) {
      const renderedFrame = await page.evaluate(async ({ requestedFrame, fps }) => {
        const timeline = Object.values(window.__timelines || {})[0];
        if (!timeline || typeof timeline.seek !== "function") return -1;
        timeline.seek(requestedFrame / fps);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        document.documentElement.getBoundingClientRect();
        return Number(document.documentElement.dataset.renderedFrame);
      }, { requestedFrame: frame, fps: request.fps });
      if (renderedFrame !== frame) throw new BrowserSeekError("BROWSER_SEEK_FRAME_MISMATCH");
      await page.screenshot({ type: "png", captureBeyondViewport: false, clip: { x: 0, y: 0, width: request.width, height: request.height } });
    }
    const captures = [], geometrySnapshots = [];
    stage = "seek_capture";
    for (let index = 0; index < request.seekSequence.length; index += 1) {
      const frame = request.seekSequence[index];
      const result = await page.evaluate(async ({ requestedFrame, fps }) => {
        const timeline = Object.values(window.__timelines || {})[0];
        if (!timeline || typeof timeline.seek !== "function") return { renderedFrame: -1, geometry: null };
        timeline.seek(requestedFrame / fps);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        document.documentElement.getBoundingClientRect();
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
          visualStateId: document.documentElement.dataset.activeVisualStateId || null,
          transitionId: document.documentElement.dataset.activeStateTransitionId || null,
          focusIntervalId: document.documentElement.dataset.focusIntervalId || null,
          focusPrimaryEntityId: document.documentElement.dataset.focusPrimaryEntityId || null,
          entities: [...document.querySelectorAll("[data-entity-id]")].map((entity) => ({
            entityId: entity.dataset.entityId,
            captionPolicy: entity.dataset.captionPolicy === "allow" ? "allow" : "avoid",
            visible: effectiveOpacity(entity) > 0.01,
            bounds: rect(entity),
          })),
          persistentEntities: [...document.querySelectorAll('[data-persistent-entity="true"]')].map((entity) => ({
            entityId: entity.dataset.entityId,
            stateId: entity.dataset.visualStateId,
            representationId: entity.dataset.representationId,
            transitionId: entity.dataset.activeTransitionId,
            visible: effectiveOpacity(entity) > 0.01,
            bounds: rect(entity),
            pathData: entity.querySelector('path[data-persistent-path="true"], path#signal-evidence-path')?.getAttribute("d") || "",
          })),
          focusTargets: [...document.querySelectorAll("[data-focus-target]")].map((entity) => ({
            entityId: entity.dataset.focusTarget,
            role: entity.dataset.focusRole,
            visible: effectiveOpacity(entity) > 0.01,
            bounds: rect(entity),
          })),
          labels: [...document.querySelectorAll("[data-legibility-role]")].map((label) => ({
            id: label.id,
            role: label.dataset.legibilityRole,
            visible: effectiveOpacity(label) > 0.01,
            fontSize: Number.parseFloat(getComputedStyle(label).fontSize),
            foreground: label.getAttribute("fill") || getComputedStyle(label).fill,
            background: label.dataset.contrastBackground,
            bounds: rect(label),
          })),
          pathFollowers: [...document.querySelectorAll("[data-follow-path-id]")].map((follower) => {
            const pathId = follower.dataset.followPathId || "", path = document.getElementById(pathId), visible = effectiveOpacity(follower) > 0.01;
            const x = Number(follower.getAttribute("cx")), y = Number(follower.getAttribute("cy"));
            let distance = null;
            if (visible && path && typeof path.getTotalLength === "function" && Number.isFinite(x) && Number.isFinite(y)) {
              const length = path.getTotalLength(), steps = 1024;
              let nearest = Number.POSITIVE_INFINITY;
              for (let sample = 0; sample <= steps; sample += 1) {
                const point = path.getPointAtLength(length * sample / steps), delta = Math.hypot(point.x - x, point.y - y);
                if (delta < nearest) nearest = delta;
              }
              distance = nearest;
            }
            return { followerId: follower.id, pathId, visible, distance };
          }),
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
    if (!repeatedFrames.length || repeatedFrames.some((entry) => !entry.equal)) {
      const mismatches = repeatedFrames.filter((entry) => !entry.equal).map((entry) => ({
        frame: entry.frame,
        hashes: captures.filter((capture) => capture.frame === entry.frame).map((capture) => capture.sha256),
      }));
      throw new BrowserSeekError("BROWSER_RANDOM_ACCESS_NONDETERMINISTIC", { mismatches });
    }
    if (counters.externalRequestCount !== 0 || counters.blockedExternalRequestCount !== 0) throw new BrowserSeekError("BROWSER_EXTERNAL_REQUEST_BLOCKED");
    stage = "geometry_audit";
    const geometryAudit = validateGeometrySnapshots(geometrySnapshots, request.width, request.height, request.expectedPathFollowerIds, {
      expectedPersistentEntityIds: request.expectedPersistentEntityIds,
      expectedVisualStateIds: request.expectedVisualStateIds,
      expectedFocusIntervalIds: request.expectedFocusIntervalIds,
      expectedTransitionIds: request.expectedTransitionIds,
      legibilityProfile: request.legibilityProfile,
    });
    return Object.freeze({
      seekSequence: [...request.seekSequence], cacheWarmupFrames: [...request.cacheWarmupFrames], captures, repeatedFrames,
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
