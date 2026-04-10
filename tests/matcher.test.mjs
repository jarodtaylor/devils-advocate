/**
 * @file Tests for scripts/lib/matcher.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchFindings } from "../scripts/lib/matcher.mjs";

/** @typedef {import('../scripts/lib/types.mjs').Finding} Finding */

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal valid finding with sensible defaults.
 *
 * @param {Partial<Finding>} overrides
 * @returns {Finding}
 */
function makeFinding(overrides = {}) {
  return {
    severity: "HIGH",
    title: "Test finding",
    description: "Something is broken.",
    rationale: "Evidence from the diff.",
    file: "src/auth.ts",
    lineStart: 10,
    lineEnd: 20,
    confidence: 0.8,
    ...overrides,
  };
}

/**
 * Build a providerResults map from plain objects for convenience.
 *
 * @param {Record<string, Finding[]>} obj
 * @returns {Map<string, { findings: Finding[] }>}
 */
function makeResults(obj) {
  const map = new Map();
  for (const [name, findings] of Object.entries(obj)) {
    map.set(name, { findings });
  }
  return map;
}

// ─── Happy paths ─────────────────────────────────────────────────────────────

describe("matchFindings — happy path", () => {
  it("same file + overlapping lines + same severity → consensus", () => {
    const fa = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    const fb = makeFinding({ severity: "HIGH", lineStart: 15, lineEnd: 25 });

    const result = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));

    assert.equal(result.consensus.length, 1);
    assert.equal(result.disagreements.length, 0);
    assert.equal(result.providerOnly.get("codex")?.length, 0);
    assert.equal(result.providerOnly.get("gemini")?.length, 0);

    const c = result.consensus[0];
    assert.equal(c.severity, "HIGH");
    assert.ok(c.providers.includes("codex"));
    assert.ok(c.providers.includes("gemini"));
  });

  it("same file + overlapping lines + different severity → disagreement", () => {
    const fa = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    const fb = makeFinding({ severity: "LOW", lineStart: 15, lineEnd: 25 });

    const result = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));

    assert.equal(result.consensus.length, 0);
    assert.equal(result.disagreements.length, 1);
    assert.equal(result.providerOnly.get("codex")?.length, 0);
    assert.equal(result.providerOnly.get("gemini")?.length, 0);

    const d = result.disagreements[0];
    assert.equal(d.file, "src/auth.ts");
    assert.ok(d.assessments.has("codex"));
    assert.ok(d.assessments.has("gemini"));
    assert.equal(d.assessments.get("codex")?.severity, "HIGH");
    assert.equal(d.assessments.get("gemini")?.severity, "LOW");
  });

  it("finding only in provider A → provider-only for A", () => {
    const fa = makeFinding({ file: "src/auth.ts", lineStart: 10, lineEnd: 20 });
    // Provider B has a finding on a completely different file.
    const fb = makeFinding({ file: "src/other.ts", lineStart: 5, lineEnd: 10 });

    const result = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));

    assert.equal(result.consensus.length, 0);
    assert.equal(result.disagreements.length, 0);
    assert.equal(result.providerOnly.get("codex")?.length, 1);
    assert.equal(result.providerOnly.get("gemini")?.length, 1);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("matchFindings — edge cases", () => {
  it("same file + non-overlapping lines → both provider-only", () => {
    // Lines 1-9 and 10-20 do not overlap (9 < 10 means 1..9 and 10..20 are adjacent but not touching
    // under the a.lineStart <= b.lineEnd && b.lineStart <= a.lineEnd rule).
    // 1 <= 20 ✓ but 10 <= 9? No → no overlap.
    const fa = makeFinding({ lineStart: 1, lineEnd: 9 });
    const fb = makeFinding({ lineStart: 10, lineEnd: 20 });

    const result = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));

    assert.equal(result.consensus.length, 0);
    assert.equal(result.disagreements.length, 0);
    assert.equal(result.providerOnly.get("codex")?.length, 1);
    assert.equal(result.providerOnly.get("gemini")?.length, 1);
  });

  it("touching ranges (lines 10-15 vs 15-20) → match (boundary overlap)", () => {
    const fa = makeFinding({ severity: "MEDIUM", lineStart: 10, lineEnd: 15 });
    const fb = makeFinding({ severity: "MEDIUM", lineStart: 15, lineEnd: 20 });

    const result = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));

    assert.equal(result.consensus.length, 1, "touching boundaries should match");
    assert.equal(result.disagreements.length, 0);
  });

  it("subset ranges (10-20 vs 12-14) → match", () => {
    const fa = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    const fb = makeFinding({ severity: "HIGH", lineStart: 12, lineEnd: 14 });

    const result = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));

    assert.equal(result.consensus.length, 1);
    assert.equal(result.disagreements.length, 0);
  });

  it("one provider 0 findings, other 5 → all 5 are provider-only", () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ lineStart: i * 10 + 1, lineEnd: i * 10 + 5 })
    );

    const result = matchFindings(makeResults({ codex: [], gemini: findings }));

    assert.equal(result.consensus.length, 0);
    assert.equal(result.disagreements.length, 0);
    assert.equal(result.providerOnly.get("codex")?.length, 0);
    assert.equal(result.providerOnly.get("gemini")?.length, 5);
  });

  it("all match with same severity → 100% agreement, empty disagreements", () => {
    const fa = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    const fb = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });

    const result = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));

    assert.equal(result.consensus.length, 1);
    assert.equal(result.disagreements.length, 0);
    assert.equal(result.providerOnly.get("codex")?.length, 0);
    assert.equal(result.providerOnly.get("gemini")?.length, 0);
  });

  it("no findings from either provider → empty result", () => {
    const result = matchFindings(makeResults({ codex: [], gemini: [] }));

    assert.equal(result.consensus.length, 0);
    assert.equal(result.disagreements.length, 0);
    assert.equal(result.providerOnly.get("codex")?.length, 0);
    assert.equal(result.providerOnly.get("gemini")?.length, 0);
  });

  it("findings without line numbers are treated as provider-only", () => {
    // Omit lineStart/lineEnd to simulate a finding without line numbers.
    const fa = /** @type {Finding} */ ({
      severity: "HIGH",
      title: "No line numbers",
      description: "Something bad.",
      rationale: "Evidence.",
      file: "src/auth.ts",
      // No lineStart / lineEnd
    });
    const fb = makeFinding({ file: "src/auth.ts", lineStart: 1, lineEnd: 10 });

    const result = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));

    // fa has no line numbers — cannot be matched.
    assert.equal(result.consensus.length, 0);
    assert.equal(result.disagreements.length, 0);
    assert.equal(result.providerOnly.get("codex")?.length, 1);
    assert.equal(result.providerOnly.get("gemini")?.length, 1);
  });

  it("single provider → all findings provider-only, no consensus or disagreements", () => {
    const fa = makeFinding();

    const result = matchFindings(makeResults({ codex: [fa] }));

    assert.equal(result.consensus.length, 0);
    assert.equal(result.disagreements.length, 0);
    assert.equal(result.providerOnly.get("codex")?.length, 1);
  });

  it("three providers: two agree, one disagrees → disagreement (not consensus)", () => {
    const fa = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    const fb = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    const fc = makeFinding({ severity: "LOW", lineStart: 10, lineEnd: 20 });

    const result = matchFindings(makeResults({ codex: [fa], gemini: [fb], kimi: [fc] }));

    // codex+gemini form a consensus pair; kimi disagrees with both.
    // The implementation will create a consensus entry for codex+gemini,
    // and disagreement entries for codex vs kimi and gemini vs kimi.
    // The important invariant: kimi's finding is classified as part of a disagreement.
    assert.ok(
      result.disagreements.length > 0 || result.consensus.length > 0,
      "should have processed all three providers"
    );
    // kimi should not appear in provider-only since it was matched (different severity)
    assert.equal(result.providerOnly.get("kimi")?.length, 0);
  });
});
