/**
 * @file Tests for scripts/lib/types.mjs — finding schema validation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateFindings, normalizeFindings } from "../scripts/lib/types.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** @returns {import('../scripts/lib/types.mjs').Finding} */
function validFinding() {
  return {
    severity: "HIGH",
    title: "SQL injection via unsanitized input",
    description: "User-controlled input is interpolated directly into a query string.",
    rationale: "Line 42 passes req.params.id directly to db.query without parameterization.",
    file: "src/routes/users.ts",
    lineStart: 40,
    lineEnd: 45,
    confidence: 0.9,
  };
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("validateFindings", () => {
  it("accepts a valid finding with all fields", () => {
    const result = validateFindings({ findings: [validFinding()] });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("accepts a valid finding without optional confidence field", () => {
    const f = validFinding();
    // @ts-ignore — intentionally removing optional field
    delete f.confidence;
    const result = validateFindings({ findings: [f] });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("accepts an empty findings array (no issues found)", () => {
    const result = validateFindings({ findings: [] });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("accepts MEDIUM and LOW severity values", () => {
    const medium = { ...validFinding(), severity: /** @type {'MEDIUM'} */ ("MEDIUM") };
    const low = { ...validFinding(), severity: /** @type {'LOW'} */ ("LOW") };
    assert.equal(validateFindings({ findings: [medium] }).valid, true);
    assert.equal(validateFindings({ findings: [low] }).valid, true);
  });

  // ─── Missing required fields ────────────────────────────────────────────────

  it("rejects a finding missing the 'file' field", () => {
    const f = validFinding();
    // @ts-ignore — intentional
    delete f.file;
    const result = validateFindings({ findings: [f] });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('"file"')), `errors: ${result.errors}`);
  });

  it("rejects a finding missing 'severity'", () => {
    const f = validFinding();
    // @ts-ignore — intentional
    delete f.severity;
    const result = validateFindings({ findings: [f] });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('"severity"')));
  });

  it("rejects a finding missing 'lineStart'", () => {
    const f = validFinding();
    // @ts-ignore — intentional
    delete f.lineStart;
    const result = validateFindings({ findings: [f] });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('"lineStart"')));
  });

  it("rejects when 'findings' property itself is missing", () => {
    const result = validateFindings({});
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('"findings"')));
  });

  // ─── Invalid severity value ──────────────────────────────────────────────────

  it("rejects an invalid severity value", () => {
    const f = { ...validFinding(), severity: /** @type {never} */ ("CRITICAL") };
    const result = validateFindings({ findings: [f] });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes("severity")),
      `errors: ${result.errors}`
    );
  });

  it("rejects lowercase severity", () => {
    const f = { ...validFinding(), severity: /** @type {never} */ ("high") };
    const result = validateFindings({ findings: [f] });
    assert.equal(result.valid, false);
  });

  // ─── Extra properties rejected (strict mode) ────────────────────────────────

  it("rejects a finding with extra properties", () => {
    const f = /** @type {Record<string, unknown>} */ ({ ...validFinding(), extraField: "oops" });
    const result = validateFindings({ findings: [f] });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes("extraField")),
      `errors: ${result.errors}`
    );
  });

  it("rejects extra top-level properties on the response object", () => {
    const result = validateFindings({ findings: [], verdict: "looks fine" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("verdict")));
  });

  // ─── Type checks ────────────────────────────────────────────────────────────

  it("rejects non-array 'findings'", () => {
    const result = validateFindings({ findings: "not-an-array" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('"findings" must be an array')));
  });

  it("rejects non-object root", () => {
    const result = validateFindings(["findings"]);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("root must be an object")));
  });

  it("rejects lineStart of 0 (must be >= 1)", () => {
    const f = { ...validFinding(), lineStart: 0 };
    const result = validateFindings({ findings: [f] });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("lineStart")));
  });

  it("rejects confidence outside 0-1 range", () => {
    const f = { ...validFinding(), confidence: 1.5 };
    const result = validateFindings({ findings: [f] });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("confidence")));
  });

  it("rejects empty string for required string fields", () => {
    const f = { ...validFinding(), title: "" };
    const result = validateFindings({ findings: [f] });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("title")));
  });
});

// ─── normalizeFindings ────────────────────────────────────────────────────────

describe("normalizeFindings", () => {
  it("preserves confidence when present", () => {
    const findings = [validFinding()];
    const normalized = normalizeFindings(findings);
    assert.equal(normalized[0].confidence, 0.9);
  });

  it("defaults confidence to 0.5 when absent", () => {
    const f = validFinding();
    // @ts-ignore — intentionally removing optional field
    delete f.confidence;
    const normalized = normalizeFindings([f]);
    assert.equal(normalized[0].confidence, 0.5);
  });

  it("does not mutate the input finding", () => {
    const f = validFinding();
    // @ts-ignore — intentionally removing optional field
    delete f.confidence;
    const copy = { ...f };
    normalizeFindings([f]);
    assert.deepEqual(f, copy); // original unchanged
  });
});
