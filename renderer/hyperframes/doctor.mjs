import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);

async function executable(path) {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

export async function hyperframesDoctor() {
  let packageVersion = null;
  try { packageVersion = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.resolve("@hyperframes/producer"))), "../package.json"), "utf8")).version; } catch {}
  let chromePath = null;
  for (const candidate of CHROME_CANDIDATES) if (await executable(candidate)) { chromePath = candidate; break; }
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 5000 });
  const ffprobe = spawnSync("ffprobe", ["-version"], { encoding: "utf8", timeout: 5000 });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const checks = { node22: nodeMajor >= 22, packagePinned: packageVersion === "0.7.55", chrome: Boolean(chromePath), ffmpeg: ffmpeg.status === 0, ffprobe: ffprobe.status === 0 };
  return Object.freeze({ ready: Object.values(checks).every(Boolean), provider: "hyperframes_benchmark", runtimeVersion: packageVersion, nodeVersion: process.versions.node, checks, chromePath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(`${JSON.stringify(await hyperframesDoctor())}\n`);
