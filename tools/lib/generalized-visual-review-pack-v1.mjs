import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { compileGeneralizedVisualProgramAdapterToHtml } from "../../renderer/hyperframes/animation-ir-adapter.mjs";
import {
  compileGeneralizedVisualPerceptualAudit,
  evaluateGeneralizedVisualBrowserMetrics,
  assertPerceptualIssueCodes,
} from "../../renderer/hyperframes/generalized-visual-perceptual-audit-v1.mjs";
import { createGeneralizedVisualReviewOverlay } from "../../renderer/hyperframes/generalized-visual-review-overlay-v1.mjs";

const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SAFE_RE = /^[a-z0-9_.:-]{1,96}$/i;
const UNSAFE_RE = /(?:https?:\/\/|file:|\/Users\/|<\/?(?:html|svg)|authorization|bearer|token|storage[_-]?key|environment)/i;
const PROFILE = "generalized_visual_review_pack_v1";
const PHASES = Object.freeze(["enter", "develop", "reveal", "resolve", "hold"]);
const AGENT_ISSUES = new Set([
  "AGENT_REVIEW_PENDING",
  "VISUAL_NARRATION_LINK_WEAK",
  "FOCAL_HIERARCHY_WEAK",
  "PACING_NEEDS_CALIBRATION",
  "TEXT_LEGIBILITY_RISK",
  "VARIETY_NEEDS_CALIBRATION",
]);

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function exact(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object.`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${field} has an unsupported field.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new TypeError(`${field} is missing a field.`);
}

function safe(value, field) {
  if (typeof value !== "string" || !SAFE_RE.test(value) || UNSAFE_RE.test(value)) throw new TypeError(`${field} is unsafe.`);
  return value;
}

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`${field} is out of range.`);
  return value;
}

function boundedNumber(value, field, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new TypeError(`${field} is out of range.`);
  return Number(value.toFixed(3));
}

function normalizeAgentReview(value = null) {
  const review = value || {
    performed: false,
    rubric: { narrationAlignment: 0, focalHierarchy: 0, legibility: 0, pacing: 0, diversity: 0 },
    issueCodes: ["AGENT_REVIEW_PENDING"],
  };
  exact(review, ["performed", "rubric", "issueCodes"], "agent_visual_review");
  if (typeof review.performed !== "boolean") throw new TypeError("agent_visual_review.performed must be boolean.");
  exact(review.rubric, ["narrationAlignment", "focalHierarchy", "legibility", "pacing", "diversity"], "agent_visual_review.rubric");
  const minimum = review.performed ? 1 : 0;
  const maximum = review.performed ? 5 : 0;
  const rubric = Object.fromEntries(Object.entries(review.rubric).map(([key, score]) => [
    key,
    boundedInteger(score, `agent_visual_review.rubric.${key}`, minimum, maximum),
  ]));
  if (!Array.isArray(review.issueCodes) || review.issueCodes.length > 6 || review.issueCodes.some((code) => !AGENT_ISSUES.has(code))) {
    throw new TypeError("agent_visual_review issue codes are invalid.");
  }
  if (new Set(review.issueCodes).size !== review.issueCodes.length || [...review.issueCodes].sort().join("|") !== review.issueCodes.join("|")) {
    throw new TypeError("agent_visual_review issue codes are not canonical.");
  }
  if (review.performed && review.issueCodes.includes("AGENT_REVIEW_PENDING")) throw new TypeError("Completed agent review cannot remain pending.");
  if (!review.performed && !review.issueCodes.includes("AGENT_REVIEW_PENDING")) throw new TypeError("Pending agent review must be explicit.");
  return { performed: review.performed, rubric, issueCodes: [...review.issueCodes] };
}

function validateSanitized(value) {
  const serialized = JSON.stringify(value);
  if (UNSAFE_RE.test(serialized) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(serialized)) {
    throw new TypeError("Review report contains unsafe content.");
  }
}

export function normalizeGeneralizedVisualReviewReport(input) {
  exact(input, ["schemaVersion", "profile", "commitSha", "renderer", "browser", "canvas", "cases", "agent_visual_review", "summary", "humanApproved", "productionReady", "contentHash"], "report");
  if (input.schemaVersion !== 1 || input.profile !== PROFILE || !COMMIT_RE.test(input.commitSha)) throw new TypeError("Review report identity is invalid.");
  exact(input.renderer, ["profile", "version", "runtimeVersion"], "report.renderer");
  exact(input.browser, ["name", "version", "headless"], "report.browser");
  exact(input.canvas, ["width", "height", "contactSheetWidth", "contactSheetHeight"], "report.canvas");
  [input.renderer.profile, input.renderer.version, input.renderer.runtimeVersion, input.browser.name, input.browser.version].forEach((entry, index) => safe(entry, `report.runtime.${index}`));
  if (input.browser.headless !== true || input.canvas.width !== 1080 || input.canvas.height !== 1920 || input.canvas.contactSheetWidth !== 1080 || input.canvas.contactSheetHeight !== 1152) throw new TypeError("Review runtime shape is invalid.");
  if (!Array.isArray(input.cases) || input.cases.length !== 3) throw new TypeError("Review report requires three cases.");
  input.cases.forEach((entry, caseIndex) => {
    exact(entry, ["caseIndex", "adapterHash", "planHash", "compositionHash", "perceptualAuditHash", "contactSheetHash", "recipeIds", "compositionFamilies", "structuralSimilarityMax", "scenes", "gates"], `report.cases.${caseIndex}`);
    if (entry.caseIndex !== caseIndex) throw new TypeError("Review case order is invalid.");
    [entry.adapterHash, entry.planHash, entry.compositionHash, entry.perceptualAuditHash, entry.contactSheetHash].forEach((entryHash) => { if (!HASH_RE.test(entryHash)) throw new TypeError("Review hash is invalid."); });
    if (!Array.isArray(entry.recipeIds) || entry.recipeIds.length !== 3 || !Array.isArray(entry.compositionFamilies) || entry.compositionFamilies.length !== 3) throw new TypeError("Review composition coverage is invalid.");
    [...entry.recipeIds, ...entry.compositionFamilies].forEach((value) => safe(value, "report.composition"));
    boundedInteger(entry.structuralSimilarityMax, "report.structuralSimilarityMax", 0, 10000);
    if (!Array.isArray(entry.scenes) || entry.scenes.length !== 3) throw new TypeError("Review scene coverage is invalid.");
    entry.scenes.forEach((scene, sceneIndex) => {
      exact(scene, ["sceneIndex", "recipeId", "compositionFamily", "styleId", "traceability", "timing", "metrics", "frames", "issueCodes", "passed"], "report.scene");
      if (scene.sceneIndex !== sceneIndex) throw new TypeError("Review scene order is invalid.");
      [scene.recipeId, scene.compositionFamily, scene.styleId].forEach((value) => safe(value, "report.scene.identity"));
      if (!Array.isArray(scene.frames) || scene.frames.length !== 5 || !Array.isArray(scene.issueCodes) || scene.issueCodes.length > 24 || typeof scene.passed !== "boolean") throw new TypeError("Review scene result is invalid.");
      exact(scene.traceability, ["beatCount", "claimCount", "beatBindingComplete", "claimBindingComplete", "recipeSemanticMatch", "helperGrounded", "certaintyPreserved", "stateChangeBound", "revealBound"], "report.scene.traceability");
      boundedInteger(scene.traceability.beatCount, "report.scene.traceability.beatCount", 1, 64);
      boundedInteger(scene.traceability.claimCount, "report.scene.traceability.claimCount", 1, 64);
      for (const key of ["beatBindingComplete", "claimBindingComplete", "recipeSemanticMatch", "helperGrounded", "certaintyPreserved", "stateChangeBound", "revealBound"]) {
        if (typeof scene.traceability[key] !== "boolean") throw new TypeError("Review traceability value is invalid.");
      }
      exact(scene.timing, ["phaseFrames", "settledReadabilityFrames", "minimumSettledReadabilityFrames", "revealLeadFrames", "holdMotionFree"], "report.scene.timing");
      exact(scene.timing.phaseFrames, PHASES, "report.scene.timing.phaseFrames");
      PHASES.forEach((phase) => boundedInteger(scene.timing.phaseFrames[phase], `report.scene.timing.phaseFrames.${phase}`, 1, 3599));
      boundedInteger(scene.timing.settledReadabilityFrames, "report.scene.timing.settledReadabilityFrames", 1, 3599);
      boundedInteger(scene.timing.minimumSettledReadabilityFrames, "report.scene.timing.minimumSettledReadabilityFrames", 1, 3599);
      boundedInteger(scene.timing.revealLeadFrames, "report.scene.timing.revealLeadFrames", 1, 3599);
      if (typeof scene.timing.holdMotionFree !== "boolean") throw new TypeError("Review hold-motion result is invalid.");
      const normalizedMetrics = normalizeMetrics(scene.metrics);
      if (canonical(normalizedMetrics) !== canonical(scene.metrics)) throw new TypeError("Review browser metrics are not canonical.");
      scene.frames.forEach((frame, phaseIndex) => {
        exact(frame, ["phaseId", "frame", "frameHash", "primaryVisible"], "report.frame");
        if (frame.phaseId !== PHASES[phaseIndex] || !HASH_RE.test(frame.frameHash) || typeof frame.primaryVisible !== "boolean") throw new TypeError("Review frame is invalid.");
        boundedInteger(frame.frame, "report.frame.frame", 0, 3599);
      });
      assertPerceptualIssueCodes(scene.issueCodes);
      if (new Set(scene.issueCodes).size !== scene.issueCodes.length || [...scene.issueCodes].sort().join("|") !== scene.issueCodes.join("|")) throw new TypeError("Review issue codes are not canonical.");
      if (scene.passed !== (scene.issueCodes.length === 0)) throw new TypeError("Review scene pass result is inconsistent.");
    });
    exact(entry.gates, ["traceability", "hierarchy", "legibility", "temporalReadability", "diversity", "networkIsolated"], "report.gates");
    if (Object.values(entry.gates).some((value) => typeof value !== "boolean")) throw new TypeError("Review gate is invalid.");
    if (canonical(entry.gates) !== canonical(deriveGates(entry.scenes))) throw new TypeError("Review gates are inconsistent.");
  });
  const agent_visual_review = normalizeAgentReview(input.agent_visual_review);
  exact(input.summary, ["automatedPassed", "agentReviewComplete", "provisionalPassed"], "report.summary");
  if (input.humanApproved !== false || input.productionReady !== false) throw new TypeError("Review report cannot self-approve production.");
  const automatedPassed = input.cases.every((entry) => Object.values(entry.gates).every(Boolean) && entry.scenes.every((scene) => scene.passed));
  const agentReviewComplete = agent_visual_review.performed;
  const provisionalPassed = automatedPassed && agentReviewComplete && Object.values(agent_visual_review.rubric).every((score) => score >= 3);
  if (input.summary.automatedPassed !== automatedPassed || input.summary.agentReviewComplete !== agentReviewComplete || input.summary.provisionalPassed !== provisionalPassed) throw new TypeError("Review summary is inconsistent.");
  const normalized = {
    schemaVersion: 1,
    profile: PROFILE,
    commitSha: input.commitSha,
    renderer: { ...input.renderer },
    browser: { ...input.browser },
    canvas: { ...input.canvas },
    cases: input.cases,
    agent_visual_review,
    summary: { automatedPassed, agentReviewComplete, provisionalPassed },
    humanApproved: false,
    productionReady: false,
  };
  validateSanitized(normalized);
  const expectedHash = hash(normalized);
  if (input.contentHash !== expectedHash) throw new TypeError("Review content hash is invalid.");
  return deepFreeze({ ...normalized, contentHash: expectedHash });
}

function sampledFrame(phase) {
  return Math.min(phase.endFrame - 1, phase.startFrame + Math.floor((phase.endFrame - phase.startFrame) / 2));
}

function structuralSimilarity(left, right) {
  let score = 0;
  if (left.recipeId === right.recipeId) score += 3000;
  if (left.layout.compositionFamily === right.layout.compositionFamily) score += 2500;
  if (left.layout.geometry.kind === right.layout.geometry.kind) score += 1500;
  if (Boolean(left.layout.helper) === Boolean(right.layout.helper)) score += 500;
  if (left.stateGraph.stateProfile === right.stateGraph.stateProfile) score += 500;
  const leftBounds = left.layout.primary.bounds, rightBounds = right.layout.primary.bounds;
  const boundsDifference = ["x", "y", "width", "height"].reduce((sum, key) => (
    sum + Math.abs(leftBounds[key] - rightBounds[key]) / Math.max(1, leftBounds[key], rightBounds[key])
  ), 0) / 4;
  score += Math.round(1000 * Math.max(0, 1 - boundsDifference));
  const leftPoints = left.layout.geometry.points?.length || 0, rightPoints = right.layout.geometry.points?.length || 0;
  score += Math.round(500 * (1 - Math.abs(leftPoints - rightPoints) / Math.max(1, leftPoints, rightPoints)));
  return score;
}

function deriveGates(sceneReports) {
  return {
    traceability: sceneReports.every((scene) => Object.entries(scene.traceability).every(([key, value]) => (
      ["beatCount", "claimCount"].includes(key) ? value > 0 : value === true
    ))),
    hierarchy: sceneReports.every((scene) => !scene.issueCodes.some((code) => ["PRIMARY_NOT_VISIBLE", "FOCAL_POINT_OUTSIDE_PRIMARY", "PRIMARY_HELPER_HIERARCHY_WEAK", "VISUAL_DASHBOARD_DENSITY", "ACCENT_COMPETITION"].includes(code))),
    legibility: sceneReports.every((scene) => !scene.issueCodes.some((code) => code.startsWith("TYPOGRAPHY_") || code === "TEXT_CONTRAST_LOW" || code === "EDGE_MARGIN_LOW" || code === "CAPTION_COLLISION")),
    temporalReadability: sceneReports.every((scene) => !scene.issueCodes.some((code) => ["SETTLED_DWELL_SHORT", "HOLD_SHORT", "HOLD_MOTION_PRESENT", "LATE_REVEAL"].includes(code))),
    diversity: sceneReports.every((scene) => !scene.issueCodes.includes("UNJUSTIFIED_REPETITION")),
    networkIsolated: sceneReports.every((scene) => !scene.issueCodes.includes("NETWORK_REQUEST_OBSERVED")),
  };
}

async function browserMetrics(page, scene) {
  return page.evaluate((expected) => {
    const active = document.querySelector(`[data-visual-scene="${expected.sceneId}"]`);
    const primary = active.querySelector("[data-dominant-primary]");
    const helper = active.querySelector("[data-single-helper]");
    const primaryRect = primary.getBoundingClientRect();
    const helperRect = helper?.getBoundingClientRect() || null;
    const captionTop = expected.captionTop;
    const stageOpacity = Number(active.querySelector("[data-motion-stage]").getAttribute("opacity") || 1);
    const visible = (node) => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > .01 && rect.width > .5 && rect.height > .5;
    };
    const excluded = new Set(["panel_frame", "grounded_label", "certainty_badge", "focus_ring"]);
    const focalCandidates = Array.from(active.querySelectorAll("[data-primitive]"))
      .filter((node) => !excluded.has(node.dataset.primitive) && visible(node))
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
    const focalRect = focalCandidates[0]?.rect || primaryRect;
    const focalX = focalRect.left + focalRect.width / 2, focalY = focalRect.top + focalRect.height / 2;
    const textNodes = Array.from(active.querySelectorAll("text")).filter(visible);
    const parseColor = (raw) => {
      const hex = raw.trim().match(/^#([0-9a-f]{6})$/i);
      if (hex) return [0, 2, 4].map((offset) => parseInt(hex[1].slice(offset, offset + 2), 16));
      const rgb = raw.match(/[\d.]+/g);
      return rgb?.slice(0, 3).map(Number) || [0, 0, 0];
    };
    const lum = (rgb) => rgb.map((part) => part / 255).map((part) => part <= .03928 ? part / 12.92 : ((part + .055) / 1.055) ** 2.4).reduce((sum, part, index) => sum + part * [.2126, .7152, .0722][index], 0);
    const surface = parseColor(getComputedStyle(active).getPropertyValue("--scene-surface") || "#171922");
    const contrast = (node) => {
      const background = node.classList.contains("paper-semantic-copy") ? [241, 232, 209] : surface;
      const values = [lum(parseColor(getComputedStyle(node).fill)), lum(background)].sort((a, b) => b - a);
      return (values[0] + .05) / (values[1] + .05);
    };
    const textRuns = textNodes.flatMap((node) => {
      const spans = Array.from(node.querySelectorAll("tspan"));
      return spans.length ? spans : [node];
    });
    const compressions = textRuns.map((node) => {
      const rect = node.getBoundingClientRect(), size = parseFloat(getComputedStyle(node).fontSize) || 0;
      const estimated = Math.max(1, node.textContent.trim().length * size * .56);
      return node.hasAttribute("textLength") ? Math.min(1, rect.width / estimated) : 1;
    });
    const keyLabels = Array.from(active.querySelectorAll('[data-legibility-role="key"] text')).filter(visible).map((node) => node.textContent.trim().toLowerCase()).filter(Boolean);
    const mapDisclosure = active.querySelector(".disclosure-copy");
    const primitiveNodes = Array.from(active.querySelectorAll("[data-primitive]")).filter(visible);
    const accentNodes = Array.from(active.querySelectorAll(".accent-stroke,.marker-fill,.heading-copy,.badge-copy,.focus-ring,.disclosure-copy")).filter(visible);
    const metrics = {
      primaryVisible: stageOpacity >= .35 && primaryRect.width * primaryRect.height >= 250000 && focalRect.width >= 72 && focalRect.height >= 72,
      helperPresent: Boolean(helperRect),
      primaryArea: Math.round(primaryRect.width * primaryRect.height),
      helperArea: helperRect ? Math.round(helperRect.width * helperRect.height) : 0,
      primaryHelperAreaRatio: helperRect ? primaryRect.width * primaryRect.height / (helperRect.width * helperRect.height) : 99,
      focalCenterX: Math.round(focalX),
      focalCenterY: Math.round(focalY),
      focalCenterInPrimary: focalX >= primaryRect.left && focalX <= primaryRect.right && focalY >= primaryRect.top && focalY <= primaryRect.bottom,
      minimumFontSize: Math.min(...textNodes.map((node) => parseFloat(getComputedStyle(node).fontSize) || 0)),
      maximumTextLines: Math.max(...textNodes.map((node) => Math.max(1, node.querySelectorAll("tspan").length))),
      minimumCompressionRatio: Math.min(...compressions),
      minimumContrastRatio: Math.min(...textNodes.map(contrast)),
      minimumEdgeMargin: Math.min(...textNodes.flatMap((node) => { const rect = node.getBoundingClientRect(); return [rect.left, 1080 - rect.right, rect.top, captionTop - rect.bottom]; })),
      typographyBounded: textNodes.every((node) => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= 1080 && rect.top >= 0 && rect.bottom <= captionTop; }),
      captionSafe: primitiveNodes.every((node) => node.getBoundingClientRect().bottom <= captionTop + .01),
      visiblePrimitiveCount: primitiveNodes.length,
      visibleAccentCount: accentNodes.length,
      mapDisclosureVisible: expected.recipeId !== "map_route" || Boolean(mapDisclosure && visible(mapDisclosure)),
      duplicateKeyLabels: new Set(keyLabels).size !== keyLabels.length,
    };
    return metrics;
  }, {
    sceneId: scene.id,
    recipeId: scene.recipeId,
    captionTop: scene.layout.regions.captionLane.y,
  });
}

function boundedMetrics(raw) {
  return {
    primaryVisible: Boolean(raw.primaryVisible),
    helperPresent: Boolean(raw.helperPresent),
    primaryArea: boundedInteger(raw.primaryArea, "metrics.primaryArea", 0, 2073600),
    helperArea: boundedInteger(raw.helperArea, "metrics.helperArea", 0, 2073600),
    primaryHelperAreaRatio: boundedNumber(raw.primaryHelperAreaRatio, "metrics.primaryHelperAreaRatio", 0, 100),
    focalCenterX: boundedInteger(raw.focalCenterX, "metrics.focalCenterX", 0, 1080),
    focalCenterY: boundedInteger(raw.focalCenterY, "metrics.focalCenterY", 0, 1920),
    focalCenterInPrimary: Boolean(raw.focalCenterInPrimary),
    minimumFontSize: boundedNumber(raw.minimumFontSize, "metrics.minimumFontSize", 0, 200),
    maximumTextLines: boundedInteger(raw.maximumTextLines, "metrics.maximumTextLines", 0, 8),
    minimumCompressionRatio: boundedNumber(raw.minimumCompressionRatio, "metrics.minimumCompressionRatio", 0, 1),
    minimumContrastRatio: boundedNumber(raw.minimumContrastRatio, "metrics.minimumContrastRatio", 0, 30),
    minimumEdgeMargin: boundedNumber(raw.minimumEdgeMargin, "metrics.minimumEdgeMargin", -1920, 1920),
    typographyBounded: Boolean(raw.typographyBounded),
    captionSafe: Boolean(raw.captionSafe),
    visiblePrimitiveCount: boundedInteger(raw.visiblePrimitiveCount, "metrics.visiblePrimitiveCount", 0, 64),
    visibleAccentCount: boundedInteger(raw.visibleAccentCount, "metrics.visibleAccentCount", 0, 64),
    mapDisclosureVisible: Boolean(raw.mapDisclosureVisible),
    duplicateKeyLabels: Boolean(raw.duplicateKeyLabels),
  };
}

function normalizeMetrics(raw) {
  exact(raw, [
    "primaryVisible", "helperPresent", "primaryArea", "helperArea", "primaryHelperAreaRatio",
    "focalCenterX", "focalCenterY", "focalCenterInPrimary", "minimumFontSize", "maximumTextLines",
    "minimumCompressionRatio", "minimumContrastRatio", "minimumEdgeMargin", "typographyBounded",
    "captionSafe", "visiblePrimitiveCount", "visibleAccentCount", "mapDisclosureVisible", "duplicateKeyLabels",
  ], "report.scene.metrics");
  for (const key of ["primaryVisible", "helperPresent", "focalCenterInPrimary", "typographyBounded", "captionSafe", "mapDisclosureVisible", "duplicateKeyLabels"]) {
    if (typeof raw[key] !== "boolean") throw new TypeError("Review browser metric boolean is invalid.");
  }
  const normalized = boundedMetrics(raw);
  if (normalized.primaryVisible && normalized.primaryArea < 250000) throw new TypeError("Review primary visibility is inconsistent.");
  if (normalized.helperPresent !== (normalized.helperArea > 0)) throw new TypeError("Review helper area is inconsistent.");
  return normalized;
}

async function installOverlay(page, descriptor) {
  await page.evaluate((value) => {
    const ns = "http://www.w3.org/2000/svg", svg = document.querySelector("svg");
    const group = document.createElementNS(ns, "g"); group.dataset.reviewOverlay = "true";
    const rectangle = (bounds, color) => { const node = document.createElementNS(ns, "rect"); Object.entries({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, fill: "none", stroke: color, "stroke-width": 6, "stroke-dasharray": "18 12" }).forEach(([key, entry]) => node.setAttribute(key, entry)); group.append(node); };
    rectangle(value.primary, "#22c55e"); if (value.helper) rectangle(value.helper, "#f59e0b"); rectangle(value.captionLane, "#ef4444");
    const circle = document.createElementNS(ns, "circle"); Object.entries({ cx: value.focalCenter.x, cy: value.focalCenter.y, r: 18, fill: "none", stroke: "#ffffff", "stroke-width": 6 }).forEach(([key, entry]) => circle.setAttribute(key, entry)); group.append(circle); svg.append(group);
  }, descriptor);
}

async function contactSheet(browser, images, outputPath) {
  const context = await browser.newContext({ viewport: { width: 1080, height: 1152 }, deviceScaleFactor: 1, colorScheme: "dark" });
  try {
    const page = await context.newPage();
    const markup = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:1080px;height:1152px;background:#050608;overflow:hidden}.grid{display:grid;grid-template-columns:repeat(5,216px);grid-template-rows:repeat(3,384px)}img{display:block;width:216px;height:384px;object-fit:cover}</style><div class="grid">${images.map((buffer) => `<img alt="" src="data:image/png;base64,${buffer.toString("base64")}">`).join("")}</div>`;
    await page.setContent(markup, { waitUntil: "load" });
    const buffer = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
    await writeFile(outputPath, buffer, { flag: "wx", mode: 0o600 });
    return buffer;
  } finally {
    await context.close();
  }
}

export async function runGeneralizedVisualReviewPack({
  cases,
  commitSha,
  chromePath,
  runtimeVersion,
  artifactDirectory,
  agentVisualReview = null,
} = {}) {
  if (!Array.isArray(cases) || cases.length !== 3 || !COMMIT_RE.test(commitSha || "") || typeof artifactDirectory !== "string") throw new TypeError("Bounded review-pack input is invalid.");
  const browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ["--disable-gpu", "--force-color-profile=srgb", "--font-render-hinting=none"] });
  try {
    const browserVersion = browser.version().replace(/^HeadlessChrome\//, "").replace(/^Chrome\//, "").slice(0, 48);
    const caseReports = [], contactSheetPaths = [];
    let artifactCount = 0;
    for (const [caseIndex, entry] of cases.entries()) {
      const composition = compileGeneralizedVisualProgramAdapterToHtml(entry.compiled, entry.context);
      const staticAudit = compileGeneralizedVisualPerceptualAudit(entry.compiled, entry.context);
      const context = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, colorScheme: "dark" });
      let externalRequests = 0;
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        if (url === "about:blank" || url.startsWith("data:")) await route.continue();
        else { externalRequests += 1; await route.abort(); }
      });
      const page = await context.newPage();
      await page.setContent(composition.html, { waitUntil: "load" });
      const sceneReports = [], sheetImages = [];
      for (const [sceneIndex, scene] of entry.compiled.visualRecipePlan.scenes.entries()) {
        const frames = [];
        for (const phase of scene.phases) {
          const frame = sampledFrame(phase);
          await page.evaluate((value) => window.__renderFrame(value), frame);
          const buffer = await page.screenshot({ type: "png", animations: "disabled", caret: "hide", scale: "css" });
          await writeFile(`${artifactDirectory}/review-${caseIndex}-${sceneIndex}-${phase.id}.png`, buffer, { flag: "wx", mode: 0o600 });
          artifactCount += 1; sheetImages.push(buffer);
          const primaryVisible = await page.evaluate(() => Number(document.querySelector('[data-motion-stage]')?.getAttribute("opacity") || 0) >= .35);
          frames.push({ phaseId: phase.id, frame, frameHash: hash(buffer), primaryVisible });
        }
        const holdFrame = sampledFrame(scene.phases.at(-1));
        await page.evaluate((value) => window.__renderFrame(value), holdFrame);
        const metrics = boundedMetrics(await browserMetrics(page, scene));
        const evaluated = evaluateGeneralizedVisualBrowserMetrics(metrics);
        const staticScene = staticAudit.scenes[sceneIndex];
        const issueCodes = [...new Set([...staticScene.issueCodes, ...evaluated.issueCodes, ...(externalRequests ? ["NETWORK_REQUEST_OBSERVED"] : [])])].sort();
        const overlay = createGeneralizedVisualReviewOverlay(scene);
        await installOverlay(page, {
          ...overlay,
          focalCenter: { x: metrics.focalCenterX, y: metrics.focalCenterY },
        });
        await page.screenshot({ path: `${artifactDirectory}/overlay-${caseIndex}-${sceneIndex}.png`, type: "png", animations: "disabled", caret: "hide" });
        artifactCount += 1;
        sceneReports.push({
          sceneIndex,
          recipeId: scene.recipeId,
          compositionFamily: scene.layout.compositionFamily,
          styleId: staticScene.styleId,
          traceability: staticScene.traceability,
          timing: staticScene.timing,
          metrics,
          frames,
          issueCodes,
          passed: issueCodes.length === 0,
        });
        await page.evaluate(() => document.querySelector('[data-review-overlay="true"]')?.remove());
      }
      const sheetPath = `${artifactDirectory}/contact-sheet-${caseIndex}.png`;
      const sheet = await contactSheet(browser, sheetImages, sheetPath);
      contactSheetPaths.push(sheetPath); artifactCount += 1;
      const planScenes = entry.compiled.visualRecipePlan.scenes;
      const similarities = planScenes.slice(1).map((scene, index) => structuralSimilarity(planScenes[index], scene));
      const gates = deriveGates(sceneReports);
      caseReports.push({
        caseIndex,
        adapterHash: entry.compiled.contentHash,
        planHash: entry.compiled.visualRecipePlan.contentHash,
        compositionHash: composition.compositionHash,
        perceptualAuditHash: staticAudit.contentHash,
        contactSheetHash: hash(sheet),
        recipeIds: planScenes.map((scene) => scene.recipeId),
        compositionFamilies: planScenes.map((scene) => scene.layout.compositionFamily),
        structuralSimilarityMax: Math.max(0, ...similarities),
        scenes: sceneReports,
        gates,
      });
      await context.close();
    }
    const review = normalizeAgentReview(agentVisualReview);
    const automatedPassed = caseReports.every((entry) => Object.values(entry.gates).every(Boolean) && entry.scenes.every((scene) => scene.passed));
    const base = {
      schemaVersion: 1,
      profile: PROFILE,
      commitSha,
      renderer: { profile: "generalized_visual_recipe_renderer_v1", version: "1.0.0", runtimeVersion: safe(runtimeVersion, "runtimeVersion") },
      browser: { name: "chromium", version: browserVersion, headless: true },
      canvas: { width: 1080, height: 1920, contactSheetWidth: 1080, contactSheetHeight: 1152 },
      cases: caseReports,
      agent_visual_review: review,
      summary: {
        automatedPassed,
        agentReviewComplete: review.performed,
        provisionalPassed: automatedPassed && review.performed && Object.values(review.rubric).every((score) => score >= 3),
      },
      humanApproved: false,
      productionReady: false,
    };
    const report = normalizeGeneralizedVisualReviewReport({ ...base, contentHash: hash(base) });
    return Object.freeze({ report, contactSheetPaths: Object.freeze(contactSheetPaths), artifactCount });
  } finally {
    await browser.close();
  }
}

export function generalizedVisualReviewReportContentHash(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Review report must be an object.");
  const unsigned = { ...value };
  delete unsigned.contentHash;
  return hash(unsigned);
}

export function pendingGeneralizedVisualAgentReview() {
  return deepFreeze(normalizeAgentReview());
}
