/**
 * @file Tests for scripts/lib/report.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateReport } from "../scripts/lib/report.mjs";
import { matchFindings } from "../scripts/lib/matcher.mjs";

/** @typedef {import('../scripts/lib/types.mjs').Finding} Finding */
/** @typedef {import('../scripts/lib/matcher.mjs').MatchResult} MatchResult */

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * @param {Partial<Finding>} overrides
 * @returns {Finding}
 */
function makeFinding(overrides = {}) {
  return {
    severity: "HIGH",
    title: "SQL injection",
    description: "Unsanitized input reaches the query.",
    rationale: "req.params.id passed directly to db.query at line 42.",
    file: "src/routes/users.ts",
    lineStart: 40,
    lineEnd: 45,
    confidence: 0.9,
    ...overrides,
  };
}

/**
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

/** @type {Map<string, { reason: string }>} */
const noFailures = new Map();

// ─── Happy paths ─────────────────────────────────────────────────────────────

describe("generateReport — happy path", () => {
  it("report has the main header", () => {
    const matchResult = matchFindings(makeResults({ codex: [], gemini: [] }));
    const report = generateReport(matchResult, noFailures);
    assert.ok(report.includes("## Devil's Advocate Review"), "should have main header");
  });

  it("report with findings has all four sections", () => {
    // consensus finding
    const fa = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    const fb = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    // disagreement finding
    const fc = makeFinding({ severity: "LOW", file: "src/db.ts", lineStart: 5, lineEnd: 10 });
    const fd = makeFinding({ severity: "HIGH", file: "src/db.ts", lineStart: 5, lineEnd: 10 });
    // provider-only finding
    const fe = makeFinding({ file: "src/utils.ts", lineStart: 100, lineEnd: 110 });

    const matchResult = matchFindings(
      makeResults({ codex: [fa, fc, fe], gemini: [fb, fd] })
    );
    const report = generateReport(matchResult, noFailures);

    assert.ok(report.includes("### Consensus"), `missing Consensus. got:\n${report}`);
    assert.ok(report.includes("### Disagreements"), `missing Disagreements. got:\n${report}`);
    assert.ok(report.includes("### Provider-only findings"), `missing Provider-only. got:\n${report}`);
  });

  it("consensus section lists severity badge, file:line, title, and description", () => {
    const fa = makeFinding({ severity: "HIGH", lineStart: 40, lineEnd: 45 });
    const fb = makeFinding({ severity: "HIGH", lineStart: 40, lineEnd: 45 });

    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));
    const report = generateReport(matchResult, noFailures);

    assert.ok(report.includes("[HIGH]"), "should have severity badge");
    assert.ok(report.includes("src/routes/users.ts:40-45"), "should have file:lines");
    assert.ok(report.includes("SQL injection"), "should have finding title");
    assert.ok(report.includes("Unsanitized input reaches the query."), "should have description");
  });

  it("disagreements section renders as a Markdown table", () => {
    const fa = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    const fb = makeFinding({ severity: "LOW", lineStart: 10, lineEnd: 20 });

    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));
    const report = generateReport(matchResult, noFailures);

    // Markdown table uses pipe characters and header separator dashes.
    assert.ok(report.includes("| Finding |"), "should have table header");
    assert.ok(report.includes("| --- |"), "should have table separator");
    // Provider names appear as column headers.
    assert.ok(report.includes("codex"), "should have codex column");
    assert.ok(report.includes("gemini"), "should have gemini column");
  });

  it("verbose flag appends raw provider output in collapsible sections", () => {
    const fa = makeFinding();
    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [] }));

    const rawOutputs = new Map([
      ["codex", '{"findings": [...]}'],
      ["gemini", '{"session_id": "abc", "response": "..."}'],
    ]);

    const report = generateReport(matchResult, noFailures, {
      verbose: true,
      rawOutputs,
    });

    assert.ok(report.includes("<details>"), "should have details element");
    assert.ok(report.includes("<summary>Raw output: codex</summary>"), "codex raw section");
    assert.ok(report.includes("<summary>Raw output: gemini</summary>"), "gemini raw section");
    assert.ok(report.includes('{"findings": [...]}'), "codex raw content");
  });

  it("summary stats include agreement rate", () => {
    const fa = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    const fb = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });

    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));
    const report = generateReport(matchResult, noFailures);

    assert.ok(report.includes("Agreement rate"), "should include agreement rate label");
    assert.ok(report.includes("100%"), "should show 100% when all match");
  });

  it("summary stats list provider names", () => {
    const matchResult = matchFindings(makeResults({ codex: [], gemini: [] }));
    // Zero findings — will show "No issues found"
    // But with a non-empty provider set we should see provider names in a normal report.
    const fa = makeFinding();
    const matchResult2 = matchFindings(makeResults({ codex: [fa], gemini: [] }));
    const report = generateReport(matchResult2, noFailures);
    assert.ok(report.includes("codex"), "should list provider names");
    assert.ok(report.includes("gemini"), "should list provider names");
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("generateReport — edge cases", () => {
  it("no findings → 'No issues found by any provider.'", () => {
    const matchResult = matchFindings(makeResults({ codex: [], gemini: [] }));
    const report = generateReport(matchResult, noFailures);
    assert.ok(
      report.includes("No issues found by any provider."),
      `got: ${report}`
    );
  });

  it("empty consensus section is omitted", () => {
    // Disagreement only — consensus section should NOT appear.
    const fa = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    const fb = makeFinding({ severity: "LOW", lineStart: 10, lineEnd: 20 });

    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));
    const report = generateReport(matchResult, noFailures);

    assert.ok(!report.includes("### Consensus"), "Consensus section should be omitted when empty");
    assert.ok(report.includes("### Disagreements"), "Disagreements section should appear");
  });

  it("empty disagreements section is omitted", () => {
    const fa = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    const fb = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });

    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));
    const report = generateReport(matchResult, noFailures);

    assert.ok(!report.includes("### Disagreements"), "Disagreements section should be omitted when empty");
    assert.ok(report.includes("### Consensus"), "Consensus section should appear");
  });

  it("empty provider-only section is omitted", () => {
    // All findings match — no provider-only.
    const fa = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });
    const fb = makeFinding({ severity: "HIGH", lineStart: 10, lineEnd: 20 });

    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));
    const report = generateReport(matchResult, noFailures);

    assert.ok(
      !report.includes("### Provider-only findings"),
      "Provider-only section should be omitted when empty"
    );
  });

  it("provider-only section grouped correctly by provider name", () => {
    const fa = makeFinding({ file: "src/a.ts", lineStart: 1, lineEnd: 5 });
    const fb = makeFinding({ file: "src/b.ts", lineStart: 100, lineEnd: 110 });
    // No matching findings between providers.
    const fc = makeFinding({ file: "src/c.ts", lineStart: 200, lineEnd: 210 });

    const matchResult = matchFindings(makeResults({ codex: [fa, fb], gemini: [fc] }));
    const report = generateReport(matchResult, noFailures);

    assert.ok(report.includes("#### codex"), "should have codex sub-header");
    assert.ok(report.includes("#### gemini"), "should have gemini sub-header");
    assert.ok(report.includes("src/a.ts"), "codex finding 1 should appear");
    assert.ok(report.includes("src/b.ts"), "codex finding 2 should appear");
    assert.ok(report.includes("src/c.ts"), "gemini finding should appear");
  });

  it("verbose section is omitted when verbose option is false", () => {
    const fa = makeFinding();
    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [] }));

    const rawOutputs = new Map([["codex", "raw output here"]]);
    const report = generateReport(matchResult, noFailures, {
      verbose: false,
      rawOutputs,
    });

    assert.ok(!report.includes("<details>"), "details tag should not appear without verbose");
    assert.ok(!report.includes("raw output here"), "raw content should not appear without verbose");
  });

  it("verbose section is omitted when rawOutputs is not provided", () => {
    const fa = makeFinding();
    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [] }));

    const report = generateReport(matchResult, noFailures, { verbose: true });

    assert.ok(!report.includes("<details>"), "details tag should not appear without rawOutputs");
  });

  it("agreement rate is N/A when no matched findings", () => {
    // Two provider-only findings — no matched pairs, so rate should be N/A.
    const fa = makeFinding({ file: "src/a.ts", lineStart: 1, lineEnd: 5 });
    const fb = makeFinding({ file: "src/b.ts", lineStart: 1, lineEnd: 5 });

    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [fb] }));
    const report = generateReport(matchResult, noFailures);

    assert.ok(report.includes("N/A"), `expected N/A in: ${report}`);
  });

  it("provider failures appear in the report", () => {
    const matchResult = matchFindings(makeResults({ codex: [], gemini: [] }));
    const failures = new Map([["kimi", { reason: "not installed" }]]);

    // With failures present but no findings we still get a full report, not "No issues found".
    const report = generateReport(matchResult, failures);

    assert.ok(report.includes("kimi"), "failed provider name should appear");
    assert.ok(report.includes("not installed"), "failure reason should appear");
  });
});

// ─── Config header (R15) ────────────────────────────────────────────────────

describe("generateReport — config header", () => {
  /** @returns {import('../scripts/lib/config.mjs').ResolvedConfig} */
  function defaultConfig(overrides = {}) {
    return {
      providers: {
        codex: { enabled: true },
        gemini: { enabled: true },
        claude: { enabled: true, model: "sonnet" },
      },
      timeout: 120,
      ...overrides,
    };
  }

  it("shows active providers with model and timeout", () => {
    const fa = makeFinding();
    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [], claude: [] }));
    const config = defaultConfig();
    const report = generateReport(matchResult, noFailures, { config });

    assert.ok(report.includes("claude (sonnet)"), `should show claude model. got:\n${report}`);
    assert.ok(report.includes("**Timeout:** 120s"), `should show timeout. got:\n${report}`);
  });

  it("shows disabled providers", () => {
    const fa = makeFinding();
    const matchResult = matchFindings(makeResults({ codex: [fa], claude: [] }));
    const config = defaultConfig({
      providers: {
        codex: { enabled: true },
        gemini: { enabled: false },
        claude: { enabled: true, model: "sonnet" },
      },
    });
    const report = generateReport(matchResult, noFailures, { config });

    assert.ok(report.includes("**Disabled:** gemini"), `should show disabled. got:\n${report}`);
  });

  it("omits Disabled segment when all providers enabled", () => {
    const fa = makeFinding();
    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [], claude: [] }));
    const config = defaultConfig();
    const report = generateReport(matchResult, noFailures, { config });

    assert.ok(!report.includes("**Disabled:**"), `should not have Disabled. got:\n${report}`);
  });

  it("shows custom timeout", () => {
    const fa = makeFinding();
    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [] }));
    const config = defaultConfig({ timeout: 60 });
    const report = generateReport(matchResult, noFailures, { config });

    assert.ok(report.includes("**Timeout:** 60s"), `should show 60s. got:\n${report}`);
  });

  it("shows custom model", () => {
    const fa = makeFinding();
    const matchResult = matchFindings(makeResults({ codex: [fa], claude: [] }));
    const config = defaultConfig({
      providers: {
        codex: { enabled: true },
        gemini: { enabled: false },
        claude: { enabled: true, model: "opus" },
      },
    });
    const report = generateReport(matchResult, noFailures, { config });

    assert.ok(report.includes("claude (opus)"), `should show opus. got:\n${report}`);
  });

  it("no config passed → no config header (backward compat)", () => {
    const fa = makeFinding();
    const matchResult = matchFindings(makeResults({ codex: [fa], gemini: [] }));
    const report = generateReport(matchResult, noFailures);

    assert.ok(!report.includes("**Timeout:**"), `should not have config header. got:\n${report}`);
    assert.ok(!report.includes("**Disabled:**"), `should not have disabled. got:\n${report}`);
  });

  it("renders config header on zero-findings runs (regression: early-return bypass)", () => {
    // Previously, generateReport's early-return for `totalFindings === 0 &&
    // no failures` bypassed the config header entirely. A user disabling a
    // provider and getting a clean review would see "No issues found" with
    // no indication their config was applied. This test guards that path.
    const matchResult = matchFindings(makeResults({ codex: [], claude: [] }));
    const config = defaultConfig({
      providers: {
        codex: { enabled: true },
        gemini: { enabled: false },
        claude: { enabled: true, model: "opus" },
      },
      timeout: 60,
    });
    const report = generateReport(matchResult, noFailures, { config });

    assert.ok(report.includes("No issues found"), `should show clean-run message. got:\n${report}`);
    assert.ok(report.includes("**Timeout:** 60s"), `should show config timeout. got:\n${report}`);
    assert.ok(report.includes("claude (opus)"), `should show claude model. got:\n${report}`);
    assert.ok(report.includes("**Disabled:** gemini"), `should show disabled list. got:\n${report}`);
  });

  it("clean run without config still uses the terse early-return (backward compat)", () => {
    // When no config is passed, the early-return should stay terse — no
    // config header, just the "No issues found" message.
    const matchResult = matchFindings(makeResults({ codex: [], gemini: [] }));
    const report = generateReport(matchResult, noFailures);

    assert.ok(report.includes("No issues found"), `got:\n${report}`);
    assert.ok(!report.includes("**Timeout:**"), `should not have config header. got:\n${report}`);
    assert.ok(!report.includes("**Providers:**"), `should not have Providers label. got:\n${report}`);
  });

  it("multiple disabled providers listed", () => {
    const fa = makeFinding();
    const matchResult = matchFindings(makeResults({ claude: [fa] }));
    const config = defaultConfig({
      providers: {
        codex: { enabled: false },
        gemini: { enabled: false },
        claude: { enabled: true, model: "sonnet" },
      },
    });
    const report = generateReport(matchResult, noFailures, { config });

    assert.ok(report.includes("codex"), `should list codex as disabled. got:\n${report}`);
    assert.ok(report.includes("gemini"), `should list gemini as disabled. got:\n${report}`);
  });
});
