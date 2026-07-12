import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveSceneRenderer, RENDERER_VERSION } = require("../../server/pipelines/narrated-short/scene-renderer-registry.cjs");
const { verticalDescriptor } = require("../../server/pipelines/narrated-short/vertical-registry.cjs");

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function visualTrack(timeline, expectedType) {
  return timeline.tracks.find((track) => track.type === expectedType);
}

function sceneText(scene, script) {
  const beats = scene.beatIds.map((beatId) => script.beats.find((beat) => beat.id === beatId)).filter(Boolean);
  return beats.map((beat) => beat.onScreenText).join(" · ");
}

function safeFileToken(value) {
  return String(value || "scene").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
}

export function resolveChromeExecutable(configured = process.env.NARRATED_CHROME_BIN) {
  if (configured) {
    const candidate = resolve(configured);
    if (!existsSync(candidate)) throw new Error("Configured headless Chromium executable does not exist");
    return candidate;
  }
  const candidate = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (!candidate) throw new Error("A Chromium-based browser is required for narrated keyframe rendering");
  return candidate;
}

function runChromeScreenshot({ chromeBin, htmlPath, outputPath, profileDir, width, height, timeoutMs = 30000 }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(chromeBin, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--force-device-scale-factor=1",
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
      `--screenshot=${outputPath}`,
      pathToFileURL(htmlPath).href,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    let lastSize = -1;
    let stableChecks = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(outputPoll);
      if (error) reject(error);
      else resolvePromise();
    };
    const outputPoll = setInterval(() => {
      if (!existsSync(outputPath)) return;
      const size = statSync(outputPath).size;
      stableChecks = size > 24 && size === lastSize ? stableChecks + 1 : 0;
      lastSize = size;
      if (stableChecks >= 2) {
        child.kill("SIGTERM");
        finish();
      }
    }, 100);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Headless Chromium screenshot timed out"));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0 || !existsSync(outputPath)) {
        finish(new Error(`Headless Chromium screenshot failed: ${stderr.slice(-400)}`));
        return;
      }
      finish();
    });
  });
}

export async function renderKeyframes({ timeline, draftBundle, outputDir, chromeBin } = {}) {
  if (!timeline || !draftBundle || !outputDir) throw new Error("timeline, draftBundle and outputDir are required");
  const vertical = verticalDescriptor(timeline.verticalId || draftBundle.verticalId, timeline.formatId || draftBundle.brief?.formatId);
  if (timeline.verticalId && draftBundle.verticalId && timeline.verticalId !== draftBundle.verticalId) {
    throw new Error("Timeline and draft verticals do not match");
  }
  const targetDir = resolve(outputDir);
  mkdirSync(targetDir, { recursive: true });
  const track = visualTrack(timeline, vertical.timelineTrackType);
  if (!track || !Array.isArray(track.clips) || !track.clips.length) throw new Error(`${vertical.timelineTrackType} track is required`);
  const executable = resolveChromeExecutable(chromeBin);
  const profileRoot = mkdtempSync(join(targetDir, ".chrome-profiles-"));
  const frames = [];
  try {
    for (const clip of track.clips) {
      const scene = draftBundle.storyboard.scenes.find((candidate) => candidate.id === clip.sceneId);
      if (!scene) throw new Error(`Missing storyboard scene ${clip.sceneId}`);
      const localScene = { ...scene, startFrame: clip.startFrame, endFrame: clip.endFrame };
      const sceneRenderer = resolveSceneRenderer({
        verticalId: vertical.verticalId,
        formatId: timeline.formatId || draftBundle.brief?.formatId,
        template: clip.template || scene.template,
        templateVersion: clip.templateVersion || timeline.templateVersions?.[scene.template],
      });
      for (const localFrame of sceneRenderer.planKeyframes(localScene)) {
        const fileName = `${safeFileToken(scene.id)}-${String(localFrame).padStart(5, "0")}.png`;
        const outputPath = join(targetDir, fileName);
        const htmlPath = join(targetDir, `.${fileName}.html`);
        const svg = sceneRenderer.render(scene, {
          width: timeline.width,
          height: timeline.height,
          frame: localFrame,
          title: draftBundle.script.title,
          text: sceneText(scene, draftBundle.script),
          draftBundle,
        });
        writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#07120e}svg{display:block}</style></head><body>${svg}</body></html>`, "utf8");
        const profileDir = join(profileRoot, safeFileToken(fileName));
        try {
          await runChromeScreenshot({ chromeBin: executable, htmlPath, outputPath, profileDir, width: timeline.width, height: timeline.height });
        } finally {
          rmSync(htmlPath, { force: true });
        }
        frames.push({
          sceneId: scene.id,
          template: scene.template,
          templateVersion: sceneRenderer.templateVersion,
          localFrame,
          globalFrame: clip.startFrame + localFrame,
          fileName,
          outputPath,
        });
      }
    }
  } finally {
    rmSync(profileRoot, { recursive: true, force: true });
  }
  frames.sort((a, b) => a.globalFrame - b.globalFrame || a.fileName.localeCompare(b.fileName));
  const manifest = {
    schemaVersion: 2,
    renderer: "headless_chromium_cli",
    rendererVersion: RENDERER_VERSION,
    verticalId: vertical.verticalId,
    formatId: timeline.formatId || draftBundle.brief?.formatId,
    templateVersions: timeline.templateVersions,
    width: timeline.width,
    height: timeline.height,
    fps: timeline.fps,
    totalFrames: timeline.totalFrames,
    timelineHash: timeline.contentHash,
    frames,
  };
  const manifestPath = join(targetDir, "keyframes-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ...manifest, manifestPath };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const timelinePath = argValue(args, "--timeline");
  const draftPath = argValue(args, "--draft");
  const outputDir = argValue(args, "--output");
  if (!timelinePath || !draftPath || !outputDir) throw new Error("Usage: --timeline file --draft file --output dir");
  const timeline = JSON.parse(readFileSync(resolve(timelinePath), "utf8"));
  const draftBundle = JSON.parse(readFileSync(resolve(draftPath), "utf8"));
  const result = await renderKeyframes({ timeline, draftBundle, outputDir });
  process.stdout.write(`${JSON.stringify({ manifestPath: result.manifestPath, frameCount: result.frames.length })}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  process.stderr.write(`${error.message || "Narrated keyframe render failed."}\n`);
  process.exitCode = 1;
});
