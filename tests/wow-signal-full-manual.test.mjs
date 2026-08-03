import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileWowSignalFullManualHtml,
  validateWowSignalFullManualFixture,
} from "../renderer/hyperframes/wow-signal-full-manual.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_PATH = resolve(
  ROOT,
  "eval/narrated/dark-curiosity/golden/002_wow_signal_full_manual.json",
);

function fixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

test("full Wow fixture covers all 1031 natural-speed narration frames", () => {
  const value = validateWowSignalFullManualFixture(fixture());
  assert.equal(value.durationFrames, 1031);
  assert.equal(value.audio.speed, 1);
  assert.equal(value.audio.transformation, "complete_source_loudness_normalization_only");
  assert.equal(value.storyboard.length, 10);
  assert.equal(value.storyboard.at(-1).endFrame, 1031);
  assert.equal(value.anchors.wowWriteLandFrame, 187);
  assert.equal(value.anchors.seventyTwoRevealFrame, 374);
});

test("full Wow fixture uses only real semantic changes with bounded gaps", () => {
  const value = validateWowSignalFullManualFixture(fixture());
  const gaps = value.meaningfulChanges.slice(1).map(
    (event, index) => event.frame - value.meaningfulChanges[index].frame,
  );
  assert.ok(Math.max(...gaps) <= value.fps * 3);
  assert.equal(
    value.meaningfulChanges.some((event) => /focus_shift/i.test(event.id)),
    false,
  );
});

test("full Wow HTML is deterministic and contains the story-owned stages", () => {
  const first = compileWowSignalFullManualHtml(fixture());
  const second = compileWowSignalFullManualHtml(fixture());
  assert.equal(second.compositionHash, first.compositionHash);
  for (const id of [
    "overviewStage",
    "printoutStage",
    "frequencyStage",
    "durationStage",
    "beamStage",
    "interferenceStage",
    "searchStage",
    "matchStage",
    "honestStage",
    "finalStage",
    "persistentTrace",
  ]) {
    assert.match(first.html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(first.html, /story_thread|thread_progress|ambient-orbit/i);
  assert.doesNotMatch(first.html, /TIMELINE AXIS|MAPPING TABLE|HYPOTHESIS CARD|FOLLOW THE THREAD/i);
  assert.doesNotMatch(first.html, /https?:\/\/[^\s"']+/);
});

test("full Wow typography is constrained to approved semantic labels", () => {
  const value = validateWowSignalFullManualFixture(fixture());
  const compiled = compileWowSignalFullManualHtml(value);
  const visible = [...compiled.html.matchAll(/data-visible-text="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(visible, value.visibleTextAllowlist);
});
