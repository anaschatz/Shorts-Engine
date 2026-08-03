import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { compileGeneralizedVisualProgramAdapterToHtml } from "../../renderer/hyperframes/animation-ir-adapter.mjs";

const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const UNSAFE_RE = /(?:https?:\/\/|file:|\/Users\/|<\/?html|authorization|bearer|token|storage[_-]?key)/i;
const PROFILE_ID = "generalized_visual_browser_proof_v1";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function contentHash(value) {
  const copy = { ...value };
  delete copy.contentHash;
  return createHash("sha256").update(canonical(copy)).digest("hex");
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

function safeText(value, field, maximum = 96) {
  if (typeof value !== "string" || !value || value.length > maximum || UNSAFE_RE.test(value) || /[\u0000-\u001f]/.test(value)) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

function boolean(value, field) {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean.`);
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`${field} is out of range.`);
  return value;
}

export function normalizeGeneralizedVisualBrowserProof(input) {
  exact(input, ["schemaVersion", "profile", "commitSha", "renderer", "browser", "canvas", "cases", "summary", "contentHash"], "proof");
  if (input.schemaVersion !== 1 || input.profile !== PROFILE_ID) throw new TypeError("Proof profile is unsupported.");
  if (!COMMIT_RE.test(input.commitSha)) throw new TypeError("Proof commit is invalid.");
  exact(input.renderer, ["profile", "version", "runtimeVersion"], "proof.renderer");
  exact(input.browser, ["name", "version", "headless"], "proof.browser");
  exact(input.canvas, ["width", "height"], "proof.canvas");
  if (input.canvas.width !== 1080 || input.canvas.height !== 1920) throw new TypeError("Proof canvas is invalid.");
  [input.renderer.profile, input.renderer.version, input.renderer.runtimeVersion, input.browser.name, input.browser.version]
    .forEach((value, index) => safeText(value, `proof.runtime[${index}]`));
  boolean(input.browser.headless, "proof.browser.headless");
  if (!Array.isArray(input.cases) || input.cases.length !== 3) throw new TypeError("Proof requires three cases.");
  const cases = input.cases.map((entry, caseIndex) => {
    exact(entry, ["caseIndex", "adapterHash", "planHash", "compositionHash", "recipeIds", "frames", "gates"], `proof.cases[${caseIndex}]`);
    if (entry.caseIndex !== caseIndex) throw new TypeError("Proof case order is invalid.");
    [entry.adapterHash, entry.planHash, entry.compositionHash].forEach((value) => {
      if (!HASH_RE.test(value)) throw new TypeError("Proof hash is invalid.");
    });
    if (!Array.isArray(entry.recipeIds) || entry.recipeIds.length !== 3 || new Set(entry.recipeIds).size < 2) throw new TypeError("Proof recipes are invalid.");
    entry.recipeIds.forEach((value) => safeText(value, "proof.recipeId", 80));
    if (!Array.isArray(entry.frames) || entry.frames.length !== 15) throw new TypeError("Proof frame coverage is invalid.");
    entry.frames.forEach((frame) => {
      exact(frame, ["sceneIndex", "phaseId", "frame", "frameHash", "activeMotionCount"], "proof.frame");
      integer(frame.sceneIndex, "proof.frame.sceneIndex", 0, 2);
      safeText(frame.phaseId, "proof.frame.phaseId", 20);
      integer(frame.frame, "proof.frame.frame", 0, 3599);
      if (!HASH_RE.test(frame.frameHash)) throw new TypeError("Proof frame hash is invalid.");
      integer(frame.activeMotionCount, "proof.frame.activeMotionCount", 0, 2);
    });
    exact(entry.gates, ["layoutFidelity", "primaryHelperCollisionFree", "typographyBounded", "markerBounded", "captionSafe", "visibleVisualRoi", "motionBudget", "holdMotionFree", "randomSeekDeterministic", "networkIsolated"], "proof.gates");
    Object.values(entry.gates).forEach((value) => boolean(value, "proof.gate"));
    return entry;
  });
  exact(input.summary, ["allRecipesCovered", "allFramesDeterministic", "allLayoutsSafe", "passed"], "proof.summary");
  Object.values(input.summary).forEach((value) => boolean(value, "proof.summary"));
  const recipeSet = new Set(cases.flatMap((entry) => entry.recipeIds));
  const allRecipesCovered = recipeSet.size === 8;
  const allFramesDeterministic = cases.every((entry) => entry.gates.randomSeekDeterministic);
  const allLayoutsSafe = cases.every((entry) => entry.gates.layoutFidelity && entry.gates.captionSafe && entry.gates.visibleVisualRoi);
  const passed = allRecipesCovered && allFramesDeterministic && allLayoutsSafe
    && cases.every((entry) => Object.values(entry.gates).every(Boolean));
  if (
    input.summary.allRecipesCovered !== allRecipesCovered
    || input.summary.allFramesDeterministic !== allFramesDeterministic
    || input.summary.allLayoutsSafe !== allLayoutsSafe
    || input.summary.passed !== passed
  ) throw new TypeError("Proof summary is inconsistent.");
  const normalized = {
    schemaVersion: 1,
    profile: PROFILE_ID,
    commitSha: input.commitSha,
    renderer: { ...input.renderer },
    browser: { ...input.browser },
    canvas: { width: 1080, height: 1920 },
    cases,
    summary: { allRecipesCovered, allFramesDeterministic, allLayoutsSafe, passed },
  };
  const expectedHash = contentHash(normalized);
  if (input.contentHash !== expectedHash) throw new TypeError("Proof content hash is invalid.");
  return deepFreeze({ ...normalized, contentHash: expectedHash });
}

function sampledFrame(phase) {
  return Math.min(phase.endFrame - 1, phase.startFrame + Math.max(0, Math.floor((phase.endFrame - phase.startFrame) / 2)));
}

async function browserSceneAudit(page, expected) {
  return page.evaluate((value) => {
    const active = document.querySelector(`[data-visual-scene="${value.sceneId}"]`);
    if (!active) return { layoutFidelity: false, primaryHelperCollisionFree: false, typographyBounded: false, markerBounded: false, captionSafe: false, visibleVisualRoi: false, motionBudget: false, holdMotionFree: false };
    const parse = (raw) => raw.split(",").map(Number);
    const sameBounds = (node, bounds) => {
      const values = parse(node?.getAttribute("data-bounds") || "");
      return values.length === 4 && values.every((entry, index) => entry === [bounds.x, bounds.y, bounds.width, bounds.height][index]);
    };
    const primary = active.querySelectorAll("[data-dominant-primary]");
    const helpers = active.querySelectorAll("[data-single-helper]");
    const intersects = (left, right) => left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
    const primaryRect = primary[0]?.getBoundingClientRect();
    const helperRect = helpers[0]?.getBoundingClientRect();
    const primitiveRects = Array.from(active.querySelectorAll("[data-primitive]")).map((node) => node.getBoundingClientRect());
    const textRects = Array.from(active.querySelectorAll("text")).map((node) => node.getBoundingClientRect());
    const boundedMarkers = Array.from(active.querySelectorAll('[data-primitive="bounded_marker"],[data-primitive="route_marker"],[data-primitive="chronology_event_marker"]'));
    const structuralBounds = active.querySelector('[data-primitive="comparison_baseline"],[data-primitive="route_path"],[data-primitive="chronology_axis"]')?.getBoundingClientRect();
    const captionTop = value.captionLane.y;
    const captionSafe = primitiveRects.every((rect) => rect.bottom <= captionTop + .01);
    const canvasSafe = primitiveRects.every((rect) => rect.left >= -.01 && rect.top >= -.01 && rect.right <= 1080.01 && rect.bottom <= 1920.01);
    const visibleVisualRoi = primitiveRects.some((rect) => rect.width > 24 && rect.height > 24)
      && active.querySelectorAll("[data-primitive]").length >= 5;
    return {
      layoutFidelity: primary.length === 1 && helpers.length === (value.helper ? 1 : 0)
        && sameBounds(primary[0], value.primary)
        && (!value.helper || sameBounds(helpers[0], value.helper))
        && canvasSafe,
      primaryHelperCollisionFree: !helperRect || !intersects(primaryRect, helperRect),
      typographyBounded: textRects.every((rect) => rect.left >= -.01 && rect.top >= -.01 && rect.right <= 1080.01 && rect.bottom <= captionTop + .01),
      markerBounded: !boundedMarkers.length || (structuralBounds && boundedMarkers.every((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left >= structuralBounds.left - .01 && rect.right <= structuralBounds.right + .01
          && rect.top >= structuralBounds.top - .01 && rect.bottom <= structuralBounds.bottom + .01;
      })),
      captionSafe,
      visibleVisualRoi,
      motionBudget: Number(document.documentElement.dataset.activeMotionCount) <= 2,
      holdMotionFree: document.documentElement.dataset.holdMotionFree === "true",
    };
  }, expected);
}

export async function runGeneralizedVisualBrowserProof({
  cases,
  commitSha,
  chromePath,
  runtimeVersion,
  artifactDirectory = null,
} = {}) {
  if (!Array.isArray(cases) || cases.length !== 3 || !COMMIT_RE.test(commitSha || "")) {
    throw new TypeError("Bounded browser proof input is invalid.");
  }
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    args: ["--disable-gpu", "--force-color-profile=srgb", "--font-render-hinting=none"],
  });
  try {
    const browserVersion = browser.version().replace(/^HeadlessChrome\//, "").replace(/^Chrome\//, "").slice(0, 48);
    const proofCases = [];
    for (const [caseIndex, entry] of cases.entries()) {
      const composition = compileGeneralizedVisualProgramAdapterToHtml(entry.compiled, entry.context);
      const context = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, colorScheme: "dark" });
      let externalRequests = 0;
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        if (url === "about:blank" || url.startsWith("data:")) await route.continue();
        else { externalRequests += 1; await route.abort(); }
      });
      const page = await context.newPage();
      await page.setContent(composition.html, { waitUntil: "load" });
      const frameReports = [];
      const gateValues = [];
      for (const [sceneIndex, scene] of entry.compiled.visualRecipePlan.scenes.entries()) {
        for (const phase of scene.phases) {
          const frame = sampledFrame(phase);
          await page.evaluate((value) => window.__renderFrame(value), frame);
          const screenshot = await page.screenshot({ type: "png", animations: "disabled", caret: "hide", scale: "css" });
          const frameHash = createHash("sha256").update(screenshot).digest("hex");
          if (artifactDirectory) {
            await writeFile(`${artifactDirectory}/case-${caseIndex}-scene-${sceneIndex}-${phase.id}.png`, screenshot, { flag: "wx", mode: 0o600 });
          }
          const audit = await browserSceneAudit(page, {
            sceneId: scene.id,
            primary: scene.layout.primary.bounds,
            helper: scene.layout.helper?.bounds || null,
            captionLane: scene.layout.regions.captionLane,
          });
          gateValues.push(audit);
          const activeMotionCount = await page.evaluate(() => Number(document.documentElement.dataset.activeMotionCount));
          frameReports.push({ sceneIndex, phaseId: phase.id, frame, frameHash, activeMotionCount });
        }
      }
      const seekFrames = entry.compiled.visualRecipePlan.scenes.map((scene) => sampledFrame(scene.phases.at(-1)));
      await page.evaluate((value) => window.__renderFrame(value), seekFrames[0]);
      const before = createHash("sha256").update(await page.screenshot()).digest("hex");
      await page.evaluate((value) => window.__renderFrame(value), seekFrames[1]);
      await page.evaluate((value) => window.__renderFrame(value), seekFrames[0]);
      const after = createHash("sha256").update(await page.screenshot()).digest("hex");
      const gates = {
        layoutFidelity: gateValues.every((gate) => gate.layoutFidelity),
        primaryHelperCollisionFree: gateValues.every((gate) => gate.primaryHelperCollisionFree),
        typographyBounded: gateValues.every((gate) => gate.typographyBounded),
        markerBounded: gateValues.every((gate) => gate.markerBounded),
        captionSafe: gateValues.every((gate) => gate.captionSafe),
        visibleVisualRoi: gateValues.every((gate) => gate.visibleVisualRoi),
        motionBudget: gateValues.every((gate) => gate.motionBudget),
        holdMotionFree: gateValues.every((gate) => gate.holdMotionFree),
        randomSeekDeterministic: before === after,
        networkIsolated: externalRequests === 0,
      };
      proofCases.push({
        caseIndex,
        adapterHash: entry.compiled.contentHash,
        planHash: entry.compiled.visualRecipePlan.contentHash,
        compositionHash: composition.compositionHash,
        recipeIds: entry.compiled.visualRecipePlan.scenes.map((scene) => scene.recipeId),
        frames: frameReports,
        gates,
      });
      await context.close();
    }
    const recipeSet = new Set(proofCases.flatMap((entry) => entry.recipeIds));
    const base = {
      schemaVersion: 1,
      profile: PROFILE_ID,
      commitSha,
      renderer: {
        profile: "generalized_visual_recipe_renderer_v1",
        version: "1.0.0",
        runtimeVersion: safeText(runtimeVersion, "runtimeVersion", 32),
      },
      browser: { name: "chromium", version: browserVersion, headless: true },
      canvas: { width: 1080, height: 1920 },
      cases: proofCases,
      summary: {
        allRecipesCovered: recipeSet.size === 8,
        allFramesDeterministic: proofCases.every((entry) => entry.gates.randomSeekDeterministic),
        allLayoutsSafe: proofCases.every((entry) => entry.gates.layoutFidelity && entry.gates.captionSafe && entry.gates.visibleVisualRoi),
        passed: proofCases.every((entry) => Object.values(entry.gates).every(Boolean)) && recipeSet.size === 8,
      },
    };
    return normalizeGeneralizedVisualBrowserProof({ ...base, contentHash: contentHash(base) });
  } finally {
    await browser.close();
  }
}

export function generalizedVisualBrowserProofContentHash(value) {
  return contentHash(value);
}
