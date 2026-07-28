import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileWowSignalGoldenHtml,
  validateWowSignalGoldenFixture,
} from "../renderer/hyperframes/wow-signal-golden-segment.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_PATH = resolve(
  ROOT,
  "eval/narrated/dark-curiosity/golden/001_wow_signal_manual_segment.json",
);

function fixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

test("manual Wow golden fixture preserves a 12-second natural-speed frame clock", () => {
  const value = validateWowSignalGoldenFixture(fixture());
  assert.equal(value.durationFrames, 360);
  assert.equal(value.audio.speed, 1);
  assert.equal(value.audio.edits.at(-1).outputEndFrame, value.durationFrames);
  assert.equal(value.anchors.wowWriteLandFrame, 198);
  assert.equal(value.anchors.seventyTwoRevealFrame, 239);
});

test("manual Wow golden HTML is deterministic and contains only narrative-owned motion", () => {
  const first = compileWowSignalGoldenHtml(fixture());
  const second = compileWowSignalGoldenHtml(fixture());
  assert.equal(second.compositionHash, first.compositionHash);
  assert.match(first.html, /id="telescope"/);
  assert.match(first.html, /id="persistentTrace"/);
  assert.match(first.html, /id="evidenceCircle"/);
  assert.match(first.html, /id="wowPath"/);
  assert.match(first.html, /id="durationAxis"/);
  assert.match(first.html, /tracePath\(morph\)/);
  assert.doesNotMatch(first.html, /story_thread|thread_progress|ambient-orbit/i);
  assert.doesNotMatch(first.html, /TIMELINE AXIS|MAPPING TABLE|HYPOTHESIS CARD|FOLLOW THE THREAD/i);
  assert.doesNotMatch(first.html, /https?:\/\/[^\s"']+/);
});

test("manual Wow golden typography is constrained to the approved visible text", () => {
  const value = validateWowSignalGoldenFixture(fixture());
  assert.deepEqual(value.visibleTextAllowlist, [
    "The signal that appeared once",
    "signal strength",
    "Wow!",
    "72 seconds",
  ]);
  const compiled = compileWowSignalGoldenHtml(value);
  const visible = [...compiled.html.matchAll(/data-visible-text="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(visible, value.visibleTextAllowlist);
});
