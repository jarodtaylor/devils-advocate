/**
 * @file Tests for scripts/lib/prompt.mjs
 * Covers template rendering, schema inclusion, required sections, and edge cases.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildPrompt, getSchemaPath } from "../scripts/lib/prompt.mjs";

// ─── Happy Path ───────────────────────────────────────────────────────────────

describe("buildPrompt — happy path", () => {
  it("injects diff text at the {{DIFF}} slot", () => {
    const diff = "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,4 @@";
    const result = buildPrompt(diff, []);
    assert.ok(result.includes(diff), "rendered prompt should contain the diff text");
  });

  it("injects file content at the {{FILES}} slot", () => {
    const files = [
      { path: "src/auth.ts", content: "export function login() {}" },
    ];
    const result = buildPrompt("diff text", files);
    assert.ok(result.includes("src/auth.ts"), "rendered prompt should include the file path");
    assert.ok(
      result.includes("export function login() {}"),
      "rendered prompt should include the file content"
    );
  });

  it("positions diff before files section", () => {
    const diff = "UNIQUE_DIFF_MARKER";
    const files = [{ path: "file.ts", content: "UNIQUE_FILE_MARKER" }];
    const result = buildPrompt(diff, files);
    const diffIdx = result.indexOf("UNIQUE_DIFF_MARKER");
    const fileIdx = result.indexOf("UNIQUE_FILE_MARKER");
    assert.ok(diffIdx !== -1, "diff marker must be present");
    assert.ok(fileIdx !== -1, "file marker must be present");
    assert.ok(diffIdx < fileIdx, "diff section should appear before files section");
  });

  it("injects optional context string", () => {
    const context = "This PR fixes the login race condition reported in issue #42.";
    const result = buildPrompt("diff", [], context);
    assert.ok(result.includes(context), "rendered prompt should contain the context string");
  });

  it("rendered prompt includes the full JSON schema inline", () => {
    const result = buildPrompt("diff", []);
    // Key schema markers that must be present
    assert.ok(result.includes("ProviderReviewResponse"), "schema title must be present");
    assert.ok(result.includes('"findings"'), "findings property must be in schema");
    assert.ok(result.includes('"HIGH"'), "severity enum values must be present");
    assert.ok(result.includes('"MEDIUM"'), "severity enum values must be present");
    assert.ok(result.includes('"LOW"'), "severity enum values must be present");
    assert.ok(result.includes('"lineStart"'), "lineStart must be in schema");
    assert.ok(result.includes('"lineEnd"'), "lineEnd must be in schema");
  });

  it("rendered prompt contains all required sections", () => {
    const result = buildPrompt("diff", []);

    // Role declaration
    assert.ok(
      result.includes("adversarial code reviewer"),
      "role declaration must be present"
    );

    // Attack surfaces — all seven priorities
    assert.ok(result.includes("Auth/permissions"), "auth/permissions attack surface must be present");
    assert.ok(result.includes("Data loss/corruption"), "data loss attack surface must be present");
    assert.ok(result.includes("Rollback/idempotency"), "rollback attack surface must be present");
    assert.ok(result.includes("Race conditions"), "race conditions attack surface must be present");
    assert.ok(
      result.includes("Null/timeout/degraded"),
      "null/timeout/degraded deps attack surface must be present"
    );
    assert.ok(result.includes("Schema drift"), "schema drift attack surface must be present");
    assert.ok(result.includes("Observability gaps"), "observability gaps attack surface must be present");

    // Finding bar
    assert.ok(result.includes("What can go wrong"), "finding bar: what can go wrong");
    assert.ok(result.includes("Why this code path is vulnerable"), "finding bar: why vulnerable");
    assert.ok(result.includes("Likely impact"), "finding bar: likely impact");
    assert.ok(result.includes("Concrete fix"), "finding bar: concrete fix");

    // Grounding rules
    assert.ok(result.includes("Grounding Rules"), "grounding rules section must be present");
    assert.ok(
      result.includes("defensible from the provided diff"),
      "grounding rule about provided context must be present"
    );

    // Calibration
    assert.ok(result.includes("Calibration"), "calibration section must be present");
    assert.ok(
      result.includes("empty `findings` array"),
      "calibration must mention empty findings as valid"
    );

    // Line number instruction
    assert.ok(
      result.includes("file-absolute"),
      "line number instruction must mention file-absolute"
    );
    assert.ok(
      result.includes("not relative to the diff"),
      "line number instruction must say not relative to diff"
    );

    // Output contract
    assert.ok(
      result.includes("structured_output_contract"),
      "output contract block must be present"
    );
    assert.ok(
      result.includes("Return ONLY valid JSON"),
      "output contract must include return-only-json instruction"
    );
    assert.ok(
      result.includes("No prose, no markdown fences"),
      "output contract must prohibit prose and fences"
    );
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe("buildPrompt — edge cases", () => {
  it("very large diff content is included without truncation", () => {
    // 200KB of diff content — prompt builder must not truncate (that's diff.mjs's job)
    const largeDiff = "+" + "x".repeat(200 * 1024);
    const result = buildPrompt(largeDiff, []);
    assert.ok(
      result.includes(largeDiff),
      "large diff must be present verbatim in the rendered prompt"
    );
  });

  it("empty files array produces an empty FILES section but valid template", () => {
    const result = buildPrompt("some diff", []);
    // No {{FILES}} placeholder should remain
    assert.ok(!result.includes("{{FILES}}"), "{{FILES}} placeholder must not remain in output");
    // Template structure must still be valid — diff and context slots resolved
    assert.ok(!result.includes("{{DIFF}}"), "{{DIFF}} placeholder must not remain");
    assert.ok(!result.includes("{{CONTEXT}}"), "{{CONTEXT}} placeholder must not remain");
  });

  it("special characters in diff do not break template rendering", () => {
    const specialDiff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      // backticks (could confuse markdown fences)
      "+const x = `template ${literal}`;",
      // dollar signs (could confuse shell or template engines)
      "+const url = `${baseUrl}/api`;",
      // backslashes
      '+const re = /foo\\bar/;',
      // angle brackets (XML-like)
      "+const html = '<script>alert(1)</script>';",
      // curly braces
      "+const obj = { key: 'value' };",
    ].join("\n");

    const result = buildPrompt(specialDiff, []);
    assert.ok(
      result.includes(specialDiff),
      "diff with special characters must be present verbatim"
    );
  });

  it("multiple files are all included in the files section", () => {
    const files = [
      { path: "src/a.ts", content: "const a = 1;" },
      { path: "src/b.ts", content: "const b = 2;" },
      { path: "src/c.ts", content: "const c = 3;" },
    ];
    const result = buildPrompt("diff", files);
    for (const f of files) {
      assert.ok(result.includes(f.path), `file path ${f.path} must be in rendered prompt`);
      assert.ok(result.includes(f.content), `file content for ${f.path} must be in rendered prompt`);
    }
  });

  it("context defaults to empty string when not provided", () => {
    // Should not throw, and no {{CONTEXT}} placeholder should remain
    const result = buildPrompt("diff", []);
    assert.ok(!result.includes("{{CONTEXT}}"), "{{CONTEXT}} placeholder must be replaced");
  });
});

// ─── getSchemaPath ────────────────────────────────────────────────────────────

describe("getSchemaPath", () => {
  it("returns a path that exists on disk", () => {
    const schemaPath = getSchemaPath();
    assert.ok(
      existsSync(schemaPath),
      `getSchemaPath() returned "${schemaPath}" but that path does not exist on disk`
    );
  });

  it("returned path points to a valid JSON schema file", () => {
    const schemaPath = getSchemaPath();
    const content = readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(content); // throws if not valid JSON
    assert.equal(schema.title, "ProviderReviewResponse", "schema title must match");
    assert.ok(Array.isArray(schema.required), "schema must have required array");
  });
});
