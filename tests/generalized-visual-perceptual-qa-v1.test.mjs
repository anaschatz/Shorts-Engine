import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  compileGeneralizedVisualPerceptualAudit,
  evaluateGeneralizedVisualBrowserMetrics,
  evaluateGeneralizedVisualStructuralContinuity,
  generalizedVisualPerceptualContentHash,
  PERCEPTUAL_ISSUE_CODES,
} from "../renderer/hyperframes/generalized-visual-perceptual-audit-v1.mjs";

const require = createRequire(import.meta.url);
const { CASES, compileCase } = require("./support/generalized-visual-step3-fixtures.cjs");

function passingBrowserMetrics() {
  return {
    primaryVisible: true,
    helperPresent: true,
    primaryArea: 500000,
    helperArea: 200000,
    primaryHelperAreaRatio: 2.5,
    focalCenterX: 540,
    focalCenterY: 800,
    focalCenterInPrimary: true,
    minimumFontSize: 24,
    maximumTextLines: 2,
    minimumCompressionRatio: 0.9,
    minimumContrastRatio: 7,
    minimumEdgeMargin: 64,
    typographyBounded: true,
    captionSafe: true,
    visiblePrimitiveCount: 8,
    visibleAccentCount: 6,
    mapDisclosureVisible: true,
    duplicateKeyLabels: false,
  };
}

test("perceptual audit binds all three stories to readable, diverse scene programs", () => {
  const audits = CASES.map((definition) => {
    const entry = compileCase(definition);
    return compileGeneralizedVisualPerceptualAudit(entry.compiled, entry.context);
  });
  assert.equal(audits.every((audit) => audit.passed), true);
  assert.equal(new Set(audits.flatMap((audit) => audit.scenes.map((scene) => scene.diversity.structuralSignature))).size, 8);
  for (const audit of audits) {
    assert.equal(Object.isFrozen(audit), true);
    assert.equal(Object.isFrozen(audit.scenes[0].timing.phaseFrames), true);
    const unsigned = structuredClone(audit);
    delete unsigned.contentHash;
    assert.equal(audit.contentHash, generalizedVisualPerceptualContentHash(unsigned));
    for (const scene of audit.scenes) {
      assert.equal(scene.traceability.beatBindingComplete, true);
      assert.equal(scene.traceability.claimBindingComplete, true);
      assert.equal(scene.traceability.recipeSemanticMatch, true);
      assert.equal(scene.traceability.helperGrounded, true);
      assert.equal(scene.traceability.certaintyPreserved, true);
      assert.ok(scene.timing.settledReadabilityFrames >= scene.timing.minimumSettledReadabilityFrames);
      assert.ok(scene.timing.phaseFrames.hold >= 18);
      assert.equal(scene.timing.holdMotionFree, true);
    }
  }
});

test("timing calibration is hash-bound and rejects an undersized hold", () => {
  const regular = compileCase(CASES[0], 1);
  const compressed = compileCase(CASES[0], 0.5);
  const regularAudit = compileGeneralizedVisualPerceptualAudit(regular.compiled, regular.context);
  const compressedAudit = compileGeneralizedVisualPerceptualAudit(compressed.compiled, compressed.context);
  assert.notEqual(regularAudit.contentHash, compressedAudit.contentHash);
  assert.equal(regularAudit.passed, true);
  assert.equal(compressedAudit.passed, false);
  assert.ok(compressedAudit.scenes.some((scene) => scene.issueCodes.includes("HOLD_SHORT")));
});

test("browser metric evaluation covers every bounded perceptual failure category", () => {
  assert.deepEqual(evaluateGeneralizedVisualBrowserMetrics(passingBrowserMetrics()), { issueCodes: [], passed: true });
  const failing = {
    ...passingBrowserMetrics(),
    primaryVisible: false,
    primaryHelperAreaRatio: 1,
    focalCenterInPrimary: false,
    minimumFontSize: 12,
    maximumTextLines: 4,
    minimumCompressionRatio: 0.5,
    minimumContrastRatio: 2,
    minimumEdgeMargin: 10,
    typographyBounded: false,
    captionSafe: false,
    visiblePrimitiveCount: 15,
    visibleAccentCount: 13,
    mapDisclosureVisible: false,
    duplicateKeyLabels: true,
  };
  const result = evaluateGeneralizedVisualBrowserMetrics(failing);
  assert.equal(result.passed, false);
  assert.deepEqual(result.issueCodes, [
    "PRIMARY_NOT_VISIBLE",
    "FOCAL_POINT_OUTSIDE_PRIMARY",
    "PRIMARY_HELPER_HIERARCHY_WEAK",
    "TYPOGRAPHY_TOO_SMALL",
    "TYPOGRAPHY_OVERFLOW",
    "TYPOGRAPHY_OVERCOMPRESSED",
    "TEXT_CONTRAST_LOW",
    "EDGE_MARGIN_LOW",
    "CAPTION_COLLISION",
    "VISUAL_DASHBOARD_DENSITY",
    "ACCENT_COMPETITION",
    "MAP_DISCLOSURE_MISSING",
    "DUPLICATE_RENDERED_LABEL",
  ]);
  assert.ok(result.issueCodes.every((code) => PERCEPTUAL_ISSUE_CODES.includes(code)));
  assert.equal(Object.isFrozen(result), true);
});

test("mutated semantic bindings fail closed before perceptual scoring", () => {
  const { compiled, context } = compileCase(CASES[1]);
  const mutation = structuredClone(compiled);
  mutation.visualProgram.scenes[0].semanticFamily = "chronology";
  assert.throws(
    () => compileGeneralizedVisualPerceptualAudit(mutation, context),
    /validation|contentHash|semantic|recipe/i,
  );
});

test("structural repetition requires state-graph continuity", () => {
  const signature = "a".repeat(64);
  const unjustified = evaluateGeneralizedVisualStructuralContinuity(
    { structuralSignature: signature, identityId: "entity_b", persistent: false },
    { structuralSignature: signature, identityId: "entity_a", persistent: false },
  );
  assert.deepEqual(unjustified, {
    repeatedPreviousStructure: true,
    repetitionJustified: false,
    issueCodes: ["UNJUSTIFIED_REPETITION"],
  });
  const justified = evaluateGeneralizedVisualStructuralContinuity(
    { structuralSignature: signature, identityId: "entity_a", persistent: true },
    { structuralSignature: signature, identityId: "entity_a", persistent: true },
  );
  assert.deepEqual(justified, {
    repeatedPreviousStructure: true,
    repetitionJustified: true,
    issueCodes: [],
  });
});
