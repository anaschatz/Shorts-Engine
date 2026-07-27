import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import {
  compileAnimationIRToHtml,
} from "../renderer/hyperframes/animation-ir-adapter.mjs";

const require = createRequire(import.meta.url);
const {
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  compileProductionAnimation,
} = require(
  "../server/pipelines/narrated-short/animation/production-plan-compiler.cjs",
);
const {
  normalizeAnimationTimingContext,
} = require(
  "../server/pipelines/narrated-short/animation/timing-contract.cjs",
);

if (!process.argv.includes("--confirm-write")) {
  throw new Error("Pass --confirm-write to generate the checked-in golden preview.");
}

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(
  root,
  "eval/narrated/dark-curiosity/semantic-events/002_gps_week_rollover.json",
), "utf8"));
const draft = normalizeDraftBundle(JSON.parse(readFileSync(
  resolve(root, manifest.sourceBindings.fixturePath),
  "utf8",
)));
const timingContext = normalizeAnimationTimingContext(JSON.parse(readFileSync(
  resolve(
    root,
    "eval/narrated/dark-curiosity/semantic-events/timing/002_gps_week_rollover.timing.json",
  ),
  "utf8",
)));
const compiled = compileProductionAnimation({
  draft,
  timingContext,
  projectId: "prj_educational_golden",
  projectRevision: 1,
  renderProfile: "preview",
  animationProfile: "educational-explainer-v1",
});
const composition = compileAnimationIRToHtml(compiled.animationIR);
const staging = mkdtempSync(join(tmpdir(), "shortsengine-educational-golden-"));
const htmlPath = join(staging, "golden.html");
writeFileSync(htmlPath, composition.html, "utf8");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
  await page.goto(`file://${htmlPath}`);
  await page.evaluate(() => document.fonts.ready);
  const frameRate = 7;
  const durationSeconds = 12;
  for (let index = 0; index < frameRate * durationSeconds; index += 1) {
    await page.evaluate((seconds) => {
      const timeline = Object.values(window.__timelines)[0];
      timeline.seek(seconds);
    }, index / frameRate);
    await page.screenshot({
      path: join(staging, `frame-${String(index).padStart(3, "0")}.png`),
    });
  }
  const output = resolve(
    root,
    "showcase/assets/educational-explainer-golden.gif",
  );
  const ffmpeg = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-framerate",
    String(frameRate),
    "-i",
    join(staging, "frame-%03d.png"),
    "-vf",
    "fps=7,scale=360:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer",
    "-loop",
    "0",
    output,
  ], { encoding: "utf8" });
  if (ffmpeg.status !== 0) {
    throw new Error(`FFmpeg failed: ${String(ffmpeg.stderr || "").slice(0, 500)}`);
  }
  process.stdout.write(`${JSON.stringify({
    output,
    compositionHash: composition.compositionHash,
    animationIRHash: compiled.animationIR.contentHash,
    directorPlanHash: compiled.directorPlan.contentHash,
  }, null, 2)}\n`);
} finally {
  await browser.close();
  rmSync(staging, { recursive: true, force: true });
}
