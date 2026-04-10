/**
 * @file Tests for scripts/lib/orchestrate.mjs and scripts/lib/validate.mjs
 *
 * Strategy: mock providers with configurable detect() and review() behavior.
 * No real CLI tools needed — pure unit tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { orchestrate, R5Error } from "../scripts/lib/orchestrate.mjs";
import { validateProviderOutput } from "../scripts/lib/validate.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** @returns {import('../scripts/lib/types.mjs').Finding} */
function validFinding(overrides = {}) {
  return {
    severity: "HIGH",
    title: "SQL injection",
    description: "User input reaches the query unescaped.",
    rationale: "Line 42 interpolates req.params.id directly.",
    file: "src/db.ts",
    lineStart: 40,
    lineEnd: 45,
    confidence: 0.9,
    ...overrides,
  };
}

/** Valid raw JSON string that passes schema validation. */
function validRaw(findings = [validFinding()]) {
  return JSON.stringify({ findings });
}

/**
 * Minimal DiffResult that the orchestrator needs.
 * (Providers under test don't use the diff content — they're mocks.)
 *
 * @returns {import('../scripts/lib/diff.mjs').DiffResult}
 */
function mockDiffResult() {
  return {
    diffText: "diff --git a/src/db.ts b/src/db.ts\n--- a/src/db.ts\n+++ b/src/db.ts\n@@ -40,3 +40,3 @@ ...",
    files: [{ path: "src/db.ts", content: "// placeholder" }],
    target: "main...HEAD",
  };
}

// ─── Mock provider factory ────────────────────────────────────────────────────

/**
 * Build a mock provider with fully controllable behavior.
 *
 * @param {{
 *   name?: string,
 *   installed?: boolean,
 *   authenticated?: boolean,
 *   reviewRaw?: string,
 *   reviewDelay?: number,
 *   reviewError?: Error,
 *   neverResolve?: boolean,
 * }} opts
 * @returns {import('../scripts/lib/types.mjs').Provider & { name: string }}
 */
function mockProvider(opts = {}) {
  const {
    name = "mock",
    installed = true,
    authenticated = true,
    reviewRaw = validRaw(),
    reviewDelay = 0,
    reviewError,
    neverResolve = false,
  } = opts;

  return {
    name,

    async detect() {
      return { name, installed, authenticated };
    },

    async review(_diffText, _files, _prompt) {
      if (neverResolve) {
        // Return a promise that never settles — simulates a hang
        return new Promise(() => {});
      }
      if (reviewError) {
        if (reviewDelay > 0) {
          await new Promise((res) => setTimeout(res, reviewDelay));
        }
        throw reviewError;
      }
      if (reviewDelay > 0) {
        await new Promise((res) => setTimeout(res, reviewDelay));
      }
      return { findings: [], raw: reviewRaw };
    },
  };
}

// ─── validate.mjs tests ───────────────────────────────────────────────────────

describe("validateProviderOutput", () => {
  it("returns valid=true and normalized findings for well-formed JSON", () => {
    const raw = validRaw([validFinding()]);
    const result = validateProviderOutput(raw);
    assert.equal(result.valid, true);
    assert.ok(Array.isArray(result.findings));
    assert.equal(result.findings?.length, 1);
    assert.deepEqual(result.errors, []);
  });

  it("defaults confidence to 0.5 when absent (normalizeFindings applied)", () => {
    const f = validFinding();
    // @ts-ignore — intentional
    delete f.confidence;
    const raw = validRaw([f]);
    const result = validateProviderOutput(raw);
    assert.equal(result.valid, true);
    assert.equal(result.findings?.[0]?.confidence, 0.5);
  });

  it("returns valid=true for empty findings array", () => {
    const raw = validRaw([]);
    const result = validateProviderOutput(raw);
    assert.equal(result.valid, true);
    assert.deepEqual(result.findings, []);
  });

  it("returns valid=false and errors for malformed JSON string", () => {
    const result = validateProviderOutput("not json at all");
    assert.equal(result.valid, false);
    assert.equal(result.findings, null);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes("JSON parse failed"));
  });

  it("returns valid=false for JSON that fails schema validation", () => {
    const raw = JSON.stringify({ findings: [{ severity: "INVALID", title: "x" }] });
    const result = validateProviderOutput(raw);
    assert.equal(result.valid, false);
    assert.equal(result.findings, null);
    assert.ok(result.errors.length > 0);
  });

  it("returns valid=false for JSON with extra top-level properties", () => {
    const raw = JSON.stringify({ findings: [], verdict: "ok" });
    const result = validateProviderOutput(raw);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("verdict")));
  });

  it("returns valid=false when findings key is missing", () => {
    const raw = JSON.stringify({});
    const result = validateProviderOutput(raw);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('"findings"')));
  });
});

// ─── orchestrate.mjs — happy paths ───────────────────────────────────────────

describe("orchestrate — happy paths", () => {
  it("2 providers both return valid findings → results map has both", async () => {
    const p1 = mockProvider({ name: "alpha", reviewRaw: validRaw([validFinding()]) });
    const p2 = mockProvider({ name: "beta", reviewRaw: validRaw([validFinding({ severity: "LOW" })]) });

    const { results, failures } = await orchestrate(mockDiffResult(), [p1, p2]);

    assert.equal(results.size, 2);
    assert.ok(results.has("alpha"));
    assert.ok(results.has("beta"));
    assert.equal(failures.size, 0);
  });

  it("3 providers all valid → works with N providers", async () => {
    const p1 = mockProvider({ name: "p1", reviewRaw: validRaw() });
    const p2 = mockProvider({ name: "p2", reviewRaw: validRaw() });
    const p3 = mockProvider({ name: "p3", reviewRaw: validRaw() });

    const { results, failures } = await orchestrate(mockDiffResult(), [p1, p2, p3]);

    assert.equal(results.size, 3);
    assert.equal(failures.size, 0);
  });

  it("valid results with 0 findings are still valid", async () => {
    const p1 = mockProvider({ name: "clean1", reviewRaw: validRaw([]) });
    const p2 = mockProvider({ name: "clean2", reviewRaw: validRaw([]) });

    const { results } = await orchestrate(mockDiffResult(), [p1, p2]);

    assert.equal(results.size, 2);
    assert.deepEqual(results.get("clean1")?.findings, []);
    assert.deepEqual(results.get("clean2")?.findings, []);
  });
});

// ─── orchestrate.mjs — R5 pre-flight failures ────────────────────────────────

describe("orchestrate — R5 pre-flight failures", () => {
  it("throws R5Error when only 1 provider is installed", async () => {
    const p1 = mockProvider({ name: "ok" });
    const p2 = mockProvider({ name: "missing", installed: false, authenticated: false });

    await assert.rejects(
      () => orchestrate(mockDiffResult(), [p1, p2]),
      (err) => {
        assert.ok(err instanceof R5Error);
        assert.ok(err.message.includes("R5 pre-flight failed"));
        assert.ok(err.message.includes("1 of 2"));
        return true;
      }
    );
  });

  it("throws R5Error when 0 providers are installed", async () => {
    const p1 = mockProvider({ name: "a", installed: false, authenticated: false });
    const p2 = mockProvider({ name: "b", installed: false, authenticated: false });

    await assert.rejects(
      () => orchestrate(mockDiffResult(), [p1, p2]),
      (err) => {
        assert.ok(err instanceof R5Error);
        assert.ok(err.message.includes("R5 pre-flight failed"));
        assert.ok(err.message.includes("0 of 2"));
        return true;
      }
    );
  });

  it("throws R5Error when provider installed but not authenticated", async () => {
    const p1 = mockProvider({ name: "authed" });
    const p2 = mockProvider({ name: "unauthed", installed: true, authenticated: false });

    await assert.rejects(
      () => orchestrate(mockDiffResult(), [p1, p2]),
      (err) => {
        assert.ok(err instanceof R5Error);
        assert.ok("providerStatuses" in err);
        const statuses = /** @type {R5Error} */ (err).providerStatuses;
        assert.ok(statuses["unauthed"].reason.includes("not authenticated"));
        return true;
      }
    );
  });

  it("pre-flight error includes per-provider status details", async () => {
    const p1 = mockProvider({ name: "a", installed: false, authenticated: false });
    const p2 = mockProvider({ name: "b", installed: true, authenticated: false });

    await assert.rejects(
      () => orchestrate(mockDiffResult(), [p1, p2]),
      (err) => {
        assert.ok(err instanceof R5Error);
        const statuses = /** @type {R5Error} */ (err).providerStatuses;
        assert.ok("a" in statuses);
        assert.ok("b" in statuses);
        assert.ok(statuses["a"].reason.includes("not installed"));
        assert.ok(statuses["b"].reason.includes("not authenticated"));
        return true;
      }
    );
  });
});

// ─── orchestrate.mjs — post-validation R5 failures ───────────────────────────

describe("orchestrate — post-validation R5 failures", () => {
  it("both providers return malformed JSON → post-validation R5 failure", async () => {
    const p1 = mockProvider({ name: "bad1", reviewRaw: "this is not json" });
    const p2 = mockProvider({ name: "bad2", reviewRaw: "{broken" });

    await assert.rejects(
      () => orchestrate(mockDiffResult(), [p1, p2]),
      (err) => {
        assert.ok(err instanceof R5Error);
        assert.ok(err.message.includes("R5 post-validation failed"));
        const statuses = /** @type {R5Error} */ (err).providerStatuses;
        assert.ok(statuses["bad1"].reason.includes("malformed output"));
        assert.ok(statuses["bad2"].reason.includes("malformed output"));
        return true;
      }
    );
  });

  it("one provider returns malformed JSON, one is valid → post-validation R5 failure", async () => {
    const p1 = mockProvider({ name: "good", reviewRaw: validRaw() });
    const p2 = mockProvider({ name: "bad", reviewRaw: "not json" });

    await assert.rejects(
      () => orchestrate(mockDiffResult(), [p1, p2]),
      (err) => {
        assert.ok(err instanceof R5Error);
        assert.ok(err.message.includes("post-validation"));
        assert.ok(err.message.includes("1 of 2"));
        return true;
      }
    );
  });

  it("provider passes pre-flight but fails validation → post-validation path triggered", async () => {
    // The pre-flight succeeds (both installed+authenticated).
    // But p2 returns JSON that fails schema validation (extra property).
    const badRaw = JSON.stringify({ findings: [], unexpectedProp: true });

    const p1 = mockProvider({ name: "ok", reviewRaw: validRaw() });
    const p2 = mockProvider({ name: "schemafail", reviewRaw: badRaw });

    await assert.rejects(
      () => orchestrate(mockDiffResult(), [p1, p2]),
      (err) => {
        assert.ok(err instanceof R5Error, `Expected R5Error, got: ${err}`);
        // Should be a post-validation failure, not pre-flight
        assert.ok(err.message.includes("post-validation"), `message: ${err.message}`);
        const statuses = /** @type {R5Error} */ (err).providerStatuses;
        assert.ok(statuses["schemafail"].reason.includes("malformed output"));
        assert.equal(statuses["schemafail"].stage, "post-validation");
        return true;
      }
    );
  });
});

// ─── orchestrate.mjs — timeout and error handling ────────────────────────────

describe("orchestrate — timeout and runtime errors", () => {
  it("one provider times out, one succeeds → post-validation R5 failure (only 1 valid)", async () => {
    const p1 = mockProvider({ name: "fast", reviewRaw: validRaw() });
    const p2 = mockProvider({ name: "slow", neverResolve: true });

    await assert.rejects(
      () => orchestrate(mockDiffResult(), [p1, p2], { timeout: 50 }),
      (err) => {
        assert.ok(err instanceof R5Error);
        assert.ok(err.message.includes("post-validation"));
        const statuses = /** @type {R5Error} */ (err).providerStatuses;
        assert.ok(statuses["slow"].reason.includes("timed out"));
        return true;
      }
    );
  });

  it("one provider throws during review() → caught by allSettled, treated as failure", async () => {
    const p1 = mockProvider({ name: "ok", reviewRaw: validRaw() });
    const p2 = mockProvider({
      name: "crashes",
      reviewError: new Error("Unexpected runtime crash"),
    });

    await assert.rejects(
      () => orchestrate(mockDiffResult(), [p1, p2]),
      (err) => {
        assert.ok(err instanceof R5Error);
        const statuses = /** @type {R5Error} */ (err).providerStatuses;
        assert.ok(statuses["crashes"].reason.includes("runtime error"));
        return true;
      }
    );
  });

  it("both providers time out → post-validation R5 failure", async () => {
    const p1 = mockProvider({ name: "a", neverResolve: true });
    const p2 = mockProvider({ name: "b", neverResolve: true });

    await assert.rejects(
      () => orchestrate(mockDiffResult(), [p1, p2], { timeout: 50 }),
      (err) => {
        assert.ok(err instanceof R5Error);
        assert.ok(err.message.includes("post-validation"));
        return true;
      }
    );
  });
});

// ─── orchestrate.mjs — parallel execution ────────────────────────────────────

describe("orchestrate — parallel execution", () => {
  it("two 100ms providers complete in ~100ms not ~200ms", async () => {
    const DELAY = 100;
    const TOLERANCE = 80; // allow up to 80ms overhead

    const p1 = mockProvider({ name: "slow1", reviewDelay: DELAY, reviewRaw: validRaw() });
    const p2 = mockProvider({ name: "slow2", reviewDelay: DELAY, reviewRaw: validRaw() });

    const start = Date.now();
    await orchestrate(mockDiffResult(), [p1, p2]);
    const elapsed = Date.now() - start;

    // If serial: elapsed ≈ 200ms. If parallel: elapsed ≈ 100ms.
    assert.ok(
      elapsed < DELAY * 2 + TOLERANCE,
      `Expected parallel execution (~${DELAY}ms), got ${elapsed}ms`
    );
  });
});

// ─── R5Error ──────────────────────────────────────────────────────────────────

describe("R5Error", () => {
  it("is an instance of Error", () => {
    const err = new R5Error("test", {});
    assert.ok(err instanceof Error);
    assert.ok(err instanceof R5Error);
  });

  it("has name 'R5Error'", () => {
    const err = new R5Error("test", {});
    assert.equal(err.name, "R5Error");
  });

  it("exposes providerStatuses", () => {
    const statuses = { alpha: { stage: "pre-flight", reason: "not installed: foo" } };
    const err = new R5Error("test", statuses);
    assert.deepEqual(err.providerStatuses, statuses);
  });
});
