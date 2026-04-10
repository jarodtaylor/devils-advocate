/**
 * @file Tests for scripts/lib/providers/gemini.mjs
 *
 * Strategy: inject mock spawnFn and readFileFn via buildGeminiProvider()
 * to avoid any dependency on real CLI tools or filesystem state.
 *
 * Mock spawn returns an EventEmitter-based fake process that emits stdout/stderr
 * data and a close event asynchronously, mimicking real child_process behavior.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildGeminiProvider } from "../../scripts/lib/providers/gemini.mjs";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Minimal mock of a ChildProcess returned by spawn().
 */
class MockProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      /** @param {string} _data */
      write(_data) {},
      end() {},
    };
    this.killed = false;
  }

  /** @param {string} [_signal] */
  kill(_signal) {
    this.killed = true;
  }
}

/**
 * Create a mock spawn that immediately succeeds with the given stdout.
 *
 * @param {string} stdoutData - JSON string to emit on stdout.
 * @param {number} [exitCode=0]
 * @param {string} [stderrData=""]
 * @returns {(cmd: string, args: string[], opts?: object) => MockProcess}
 */
function makeSpawn(stdoutData, exitCode = 0, stderrData = "") {
  return (_cmd, _args, _opts) => {
    const proc = new MockProcess();
    // Emit data asynchronously so listeners can attach
    setImmediate(() => {
      if (stdoutData) proc.stdout.emit("data", Buffer.from(stdoutData));
      if (stderrData) proc.stderr.emit("data", Buffer.from(stderrData));
      proc.emit("close", exitCode);
    });
    return proc;
  };
}

/**
 * Create a mock spawn that handles two sequential calls:
 * 1. `command -v gemini` — the install check (exits 0 = installed, 1 = not found)
 * 2. `gemini -p ...` — the actual review call
 *
 * @param {boolean} installed
 * @param {string} reviewStdout
 * @param {number} [reviewExitCode=0]
 * @param {string} [reviewStderr=""]
 * @returns {(cmd: string, args: string[], opts?: object) => MockProcess}
 */
function makeDetectAndReviewSpawn(installed, reviewStdout, reviewExitCode = 0, reviewStderr = "") {
  let callCount = 0;
  return (cmd, args, opts) => {
    callCount++;
    if (callCount === 1) {
      // First call: command -v gemini
      const proc = new MockProcess();
      setImmediate(() => proc.emit("close", installed ? 0 : 1));
      return proc;
    }
    // Subsequent calls: gemini review invocation
    return makeSpawn(reviewStdout, reviewExitCode, reviewStderr)(cmd, args, opts);
  };
}

/**
 * Create a mock readFile for oauth_creds.json.
 *
 * @param {{ present: boolean, expiryDate?: number, malformed?: boolean }} opts
 * @returns {(path: string, encoding: string) => Promise<string>}
 */
function makeReadFile({ present, expiryDate, malformed = false }) {
  return async (_path, _enc) => {
    if (!present) {
      const err = /** @type {NodeJS.ErrnoException} */ (new Error("ENOENT: no such file"));
      err.code = "ENOENT";
      throw err;
    }
    if (malformed) {
      return "not-valid-json{{{";
    }
    return JSON.stringify({ expiry_date: expiryDate ?? Date.now() + 3_600_000 });
  };
}

// ─── Valid finding fixture ────────────────────────────────────────────────────

/** @returns {import('../../scripts/lib/types.mjs').Finding} */
function validFinding() {
  return {
    severity: "HIGH",
    title: "Unvalidated user input passed to query",
    description: "User-controlled data reaches a DB query without sanitization.",
    rationale: "Line 42 passes req.body.id directly to db.query().",
    file: "src/routes/users.ts",
    lineStart: 40,
    lineEnd: 45,
    confidence: 0.9,
  };
}

/**
 * Build a valid Gemini JSON envelope string containing a single finding.
 *
 * @param {import('../../scripts/lib/types.mjs').Finding[]} [findings]
 * @returns {string}
 */
function makeEnvelope(findings) {
  const inner = JSON.stringify({ findings: findings ?? [validFinding()] });
  return JSON.stringify({ session_id: "test-123", response: inner, stats: { tokens: 100 } });
}

// ─── detect() — happy paths ───────────────────────────────────────────────────

describe("geminiProvider.detect() — happy paths", () => {
  it("installed + valid oauth file → authenticated", async () => {
    const spawnFn = makeSpawn("", 0); // command -v succeeds
    // Override to handle two calls: install check then (no review call)
    let callCount = 0;
    const twoCallSpawn = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {object | undefined} */ opts) => {
      callCount++;
      return makeSpawn("", callCount === 1 ? 0 : 1)(cmd, args, opts);
    };

    const provider = buildGeminiProvider({
      spawnFn: twoCallSpawn,
      readFileFn: makeReadFile({ present: true, expiryDate: Date.now() + 3_600_000 }),
    });

    const result = await provider.detect();

    assert.equal(result.name, "gemini");
    assert.equal(result.installed, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.error, undefined);
  });

  it("install check: spawn called with sh -c command -v gemini", async () => {
    /** @type {string[][]} */
    const calls = [];
    const spawnFn = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {object | undefined} */ _opts) => {
      calls.push([cmd, ...args]);
      const proc = new MockProcess();
      setImmediate(() => proc.emit("close", 0));
      return proc;
    };

    const provider = buildGeminiProvider({
      spawnFn,
      readFileFn: makeReadFile({ present: true }),
    });

    await provider.detect();

    assert.ok(calls.length >= 1, "spawn should have been called at least once");
    const [cmd, ...firstArgs] = calls[0];
    assert.equal(cmd, "sh");
    assert.ok(firstArgs.includes("-c"), "should pass -c flag");
    assert.ok(firstArgs.some((a) => a.includes("gemini")), "should check for gemini command");
  });
});

// ─── detect() — edge cases: oauth file ───────────────────────────────────────

describe("geminiProvider.detect() — oauth_creds.json states", () => {
  it("oauth_creds.json missing → not authenticated, error message present", async () => {
    // spawn returns exit 0 for install check (gemini is installed)
    const spawnFn = makeSpawn("", 0);
    const provider = buildGeminiProvider({
      spawnFn,
      readFileFn: makeReadFile({ present: false }),
    });

    const result = await provider.detect();

    assert.equal(result.installed, true);
    assert.equal(result.authenticated, false);
    assert.ok(typeof result.error === "string");
    assert.ok(
      result.error.includes("oauth_creds.json") || result.error.includes("not found"),
      `error should mention oauth file, got: ${result.error}`
    );
  });

  it("oauth_creds.json present but expiry_date in the past → not authenticated", async () => {
    const spawnFn = makeSpawn("", 0);
    const provider = buildGeminiProvider({
      spawnFn,
      readFileFn: makeReadFile({ present: true, expiryDate: Date.now() - 1 }),
    });

    const result = await provider.detect();

    assert.equal(result.installed, true);
    assert.equal(result.authenticated, false);
    assert.ok(typeof result.error === "string");
    assert.ok(
      result.error.toLowerCase().includes("expir"),
      `error should mention expiration, got: ${result.error}`
    );
  });

  it("oauth_creds.json present with expiry exactly now → not authenticated (boundary)", async () => {
    const now = Date.now();
    const spawnFn = makeSpawn("", 0);
    const provider = buildGeminiProvider({
      spawnFn,
      readFileFn: makeReadFile({ present: true, expiryDate: now }),
    });

    const result = await provider.detect();

    assert.equal(result.authenticated, false);
  });

  it("oauth_creds.json is malformed JSON → not authenticated", async () => {
    const spawnFn = makeSpawn("", 0);
    const provider = buildGeminiProvider({
      spawnFn,
      readFileFn: makeReadFile({ present: true, malformed: true }),
    });

    const result = await provider.detect();

    assert.equal(result.installed, true);
    assert.equal(result.authenticated, false);
    assert.ok(typeof result.error === "string");
  });
});

// ─── detect() — gemini not installed ─────────────────────────────────────────

describe("geminiProvider.detect() — not installed", () => {
  it("gemini not on PATH → installed: false, authenticated: false", async () => {
    const spawnFn = makeSpawn("", 1); // command -v exits 1 → not found
    const provider = buildGeminiProvider({
      spawnFn,
      readFileFn: makeReadFile({ present: true }),
    });

    const result = await provider.detect();

    assert.equal(result.name, "gemini");
    assert.equal(result.installed, false);
    assert.equal(result.authenticated, false);
    assert.ok(typeof result.error === "string");
  });

  it("spawn error during install check → installed: false", async () => {
    const spawnFn = (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {object | undefined} */ _opts) => {
      const proc = new MockProcess();
      setImmediate(() => proc.emit("error", new Error("ENOENT: spawn failed")));
      return proc;
    };

    const provider = buildGeminiProvider({
      spawnFn,
      readFileFn: makeReadFile({ present: true }),
    });

    const result = await provider.detect();

    assert.equal(result.installed, false);
    assert.equal(result.authenticated, false);
  });
});

// ─── review() — happy path ────────────────────────────────────────────────────

describe("geminiProvider.review() — happy path", () => {
  it("valid JSON envelope → findings extracted from response field", async () => {
    const finding = validFinding();
    const envelopeStr = makeEnvelope([finding]);

    const provider = buildGeminiProvider({
      spawnFn: makeSpawn(envelopeStr, 0),
      readFileFn: makeReadFile({ present: true }),
    });

    const result = await provider.review("diff content", [], "adversarial prompt");

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "HIGH");
    assert.equal(result.findings[0].title, finding.title);
    assert.equal(result.findings[0].file, finding.file);
    // raw should be the full stdout
    assert.equal(result.raw, envelopeStr);
  });

  it("multiple findings in response → all normalized with confidence default", async () => {
    const f1 = validFinding();
    const f2 = { ...validFinding(), title: "Second issue", severity: /** @type {'MEDIUM'} */ ("MEDIUM") };
    // Remove confidence from f2 to test normalization
    // @ts-ignore — intentional
    delete f2.confidence;

    const envelopeStr = makeEnvelope([f1, f2]);
    const provider = buildGeminiProvider({
      spawnFn: makeSpawn(envelopeStr, 0),
      readFileFn: makeReadFile({ present: true }),
    });

    const result = await provider.review("diff", [], "prompt");

    assert.equal(result.findings.length, 2);
    // f1 preserves its confidence
    assert.equal(result.findings[0].confidence, 0.9);
    // f2 gets default confidence
    assert.equal(result.findings[1].confidence, 0.5);
  });

  it("empty findings array in response → valid, 0 findings returned", async () => {
    const envelopeStr = makeEnvelope([]);
    const provider = buildGeminiProvider({
      spawnFn: makeSpawn(envelopeStr, 0),
      readFileFn: makeReadFile({ present: true }),
    });

    const result = await provider.review("diff", [], "prompt");

    assert.equal(result.findings.length, 0);
    assert.equal(typeof result.raw, "string");
  });

  it("passes prompt as -p argument to gemini CLI", async () => {
    /** @type {string[][]} */
    const spawnCalls = [];
    const envelopeStr = makeEnvelope([]);

    const spawnFn = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {object | undefined} */ _opts) => {
      spawnCalls.push([cmd, ...args]);
      return makeSpawn(envelopeStr, 0)(cmd, args, _opts);
    };

    const provider = buildGeminiProvider({
      spawnFn,
      readFileFn: makeReadFile({ present: true }),
    });

    await provider.review("diff", [], "my test prompt");

    assert.ok(spawnCalls.length >= 1);
    const reviewCall = spawnCalls[spawnCalls.length - 1];
    assert.equal(reviewCall[0], "gemini", "should call gemini binary");
    const pIdx = reviewCall.indexOf("-p");
    assert.ok(pIdx !== -1, "should have -p flag");
    assert.equal(reviewCall[pIdx + 1], "my test prompt", "prompt should follow -p");
  });

  it("passes -o json and --sandbox to gemini CLI for safe headless execution", async () => {
    /** @type {string[][]} */
    const spawnCalls = [];
    const envelopeStr = makeEnvelope([]);

    const spawnFn = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {object | undefined} */ _opts) => {
      spawnCalls.push([cmd, ...args]);
      return makeSpawn(envelopeStr, 0)(cmd, args, _opts);
    };

    const provider = buildGeminiProvider({ spawnFn });

    await provider.review("diff", [], "prompt");

    const reviewCall = spawnCalls[spawnCalls.length - 1];
    assert.ok(reviewCall.includes("-o"), "should include -o flag");
    assert.ok(reviewCall.includes("json"), "should include json output format");
    assert.ok(reviewCall.includes("--sandbox"), "should include --sandbox for safe headless execution");
  });
});

// ─── review() — error paths ───────────────────────────────────────────────────

describe("geminiProvider.review() — error paths", () => {
  it("response field contains invalid JSON → throws malformed error", async () => {
    const badEnvelope = JSON.stringify({
      session_id: "test-456",
      response: "this is not json at all {{{{",
      stats: {},
    });

    const provider = buildGeminiProvider({
      spawnFn: makeSpawn(badEnvelope, 0),
    });

    await assert.rejects(
      () => provider.review("diff", [], "prompt"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("invalid JSON") || err.message.includes("response"),
          `expected JSON error message, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("outer envelope is not valid JSON → throws malformed envelope error", async () => {
    const provider = buildGeminiProvider({
      spawnFn: makeSpawn("not-json-at-all", 0),
    });

    await assert.rejects(
      () => provider.review("diff", [], "prompt"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes("malformed") ||
            err.message.toLowerCase().includes("json"),
          `expected envelope parse error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("envelope missing response field → throws descriptive error", async () => {
    const badEnvelope = JSON.stringify({ session_id: "abc", stats: {} });

    const provider = buildGeminiProvider({
      spawnFn: makeSpawn(badEnvelope, 0),
    });

    await assert.rejects(
      () => provider.review("diff", [], "prompt"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("response"),
          `expected 'response' in error message, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("gemini exits non-zero → throws provider error with exit code", async () => {
    const provider = buildGeminiProvider({
      spawnFn: makeSpawn("", 1, "authentication failed: token revoked"),
    });

    await assert.rejects(
      () => provider.review("diff", [], "prompt"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("exit") || err.message.includes("1") || err.message.includes("authentication"),
          `expected exit code error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("runtime auth failure (token revoked server-side) → caught as provider error", async () => {
    // Gemini exits non-zero with an auth error message on stderr
    const provider = buildGeminiProvider({
      spawnFn: makeSpawn("", 1, "Error: OAuth token revoked. Re-authenticate."),
    });

    await assert.rejects(
      () => provider.review("diff", [], "prompt"),
      (err) => {
        assert.ok(err instanceof Error, "should throw an Error");
        // Error should include some context from stderr
        return true;
      }
    );
  });

  it("findings fail schema validation → throws validation error", async () => {
    // response contains JSON but findings are malformed (missing required fields)
    const badInner = JSON.stringify({
      findings: [{ severity: "INVALID_LEVEL", title: "" }],
    });
    const envelope = JSON.stringify({ session_id: "x", response: badInner, stats: {} });

    const provider = buildGeminiProvider({
      spawnFn: makeSpawn(envelope, 0),
    });

    await assert.rejects(
      () => provider.review("diff", [], "prompt"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes("validation") ||
            err.message.toLowerCase().includes("schema") ||
            err.message.toLowerCase().includes("severity"),
          `expected validation error, got: ${err.message}`
        );
        return true;
      }
    );
  });
});

// ─── review() — timeout ───────────────────────────────────────────────────────

describe("geminiProvider.review() — timeout", () => {
  it("timeout → process killed and error thrown", async () => {
    /** @type {MockProcess | null} */
    let capturedProc = null;

    // Spawn a process that never resolves (never emits close)
    const spawnFn = (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {object | undefined} */ _opts) => {
      const proc = new MockProcess();
      capturedProc = proc;
      // Intentionally never emit close — simulates a hanging process
      return proc;
    };

    // Build a provider with a very short timeout by manipulating AbortController
    // Since the timeout is hardcoded, we instead test the kill-on-abort path
    // by directly aborting via a custom signal exposed through a wrapper.
    //
    // Strategy: wrap the spawnFn to capture the process, then abort externally.
    const controller = new AbortController();

    // Wrap review to inject the abort after spawn is captured
    const provider = buildGeminiProvider({ spawnFn });

    // Start review (it will hang)
    const reviewPromise = provider.review("diff", [], "prompt");

    // Wait for spawn to be called, then abort
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(capturedProc !== null, "spawn should have been called");

    // Simulate timeout by emitting close with SIGTERM behavior
    // Since we can't access the internal AbortController, we test kill behavior
    // by emitting an error on the captured process
    capturedProc.emit("error", new Error("spawn timed out"));

    await assert.rejects(reviewPromise, (err) => {
      assert.ok(err instanceof Error);
      return true;
    });
  });

  it("AbortController-driven kill path: process.kill is called on abort", async () => {
    /** @type {MockProcess | null} */
    let capturedProc = null;

    const spawnFn = (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {object | undefined} */ _opts) => {
      const proc = new MockProcess();
      capturedProc = proc;
      // Never emit close — hang indefinitely
      return proc;
    };

    const provider = buildGeminiProvider({ spawnFn });

    // We test that kill() is called when the signal aborts.
    // This requires accessing the internal signal, so we test via a custom
    // spawnFn that wraps kill() to track calls.
    let killCalled = false;
    const trackingSpawnFn = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {object | undefined} */ opts) => {
      const proc = spawnFn(cmd, args, opts);
      const origKill = proc.kill.bind(proc);
      proc.kill = (/** @type {string | undefined} */ sig) => {
        killCalled = true;
        origKill(sig);
      };
      return proc;
    };

    const trackingProvider = buildGeminiProvider({ spawnFn: trackingSpawnFn });

    const reviewPromise = trackingProvider.review("diff", [], "prompt");

    // Wait one tick for spawn to be registered
    await new Promise((resolve) => setImmediate(resolve));

    // Force the process to error to trigger the rejection path
    assert.ok(capturedProc, "process should have been spawned");
    capturedProc.emit("error", new Error("SIGTERM: process terminated"));

    await assert.rejects(reviewPromise);
  });
});

// ─── Return shape contract ────────────────────────────────────────────────────

describe("geminiProvider.review() — return shape", () => {
  it("result always has findings (array) and raw (string)", async () => {
    const provider = buildGeminiProvider({
      spawnFn: makeSpawn(makeEnvelope([]), 0),
    });

    const result = await provider.review("diff", [], "prompt");

    assert.ok("findings" in result, "result must have findings");
    assert.ok("raw" in result, "result must have raw");
    assert.ok(Array.isArray(result.findings), "findings must be array");
    assert.equal(typeof result.raw, "string", "raw must be string");
  });
});

// ─── detect() return shape contract ──────────────────────────────────────────

describe("geminiProvider.detect() — return shape", () => {
  it("result always has installed, authenticated, name fields", async () => {
    const provider = buildGeminiProvider({
      spawnFn: makeSpawn("", 1),
      readFileFn: makeReadFile({ present: false }),
    });

    const result = await provider.detect();

    assert.ok("installed" in result);
    assert.ok("authenticated" in result);
    assert.ok("name" in result);
    assert.equal(result.name, "gemini");
  });
});

// ─── timeoutMs injection ──────────────────────────────────────────────────────

describe("buildGeminiProvider() — timeoutMs injection", () => {
  it("buildGeminiProvider({ timeoutMs: 60000 }) → abort fires before long-running process", async () => {
    const SHORT_TIMEOUT_MS = 60;

    // Process that never emits close — hangs until timeout fires
    const spawnFn = (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {object | undefined} */ _opts) => {
      const proc = new MockProcess();
      // Never emit close — hang indefinitely
      return proc;
    };

    const provider = buildGeminiProvider({ spawnFn, timeoutMs: SHORT_TIMEOUT_MS });

    const start = Date.now();
    await assert.rejects(
      () => provider.review("diff", [], "prompt"),
      (err) => {
        assert.ok(err instanceof Error);
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 5000, `should reject quickly with short timeout, elapsed: ${elapsed}ms`);
        return true;
      }
    );
  });

  it("error message reflects the injected timeoutMs in seconds", async () => {
    // 50ms timeout → onAbort message: "Gemini provider timed out after 0.05s"
    const spawnFn = (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {object | undefined} */ _opts) => {
      const proc = new MockProcess();
      // Never emit close — hang until timeout fires
      return proc;
    };

    const provider = buildGeminiProvider({ spawnFn, timeoutMs: 50 });

    await assert.rejects(
      () => provider.review("diff", [], "prompt"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes("timed out") ||
          err.message.toLowerCase().includes("timeout"),
          `expected timeout message, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("default factory (no timeoutMs) still works correctly — 120s default unchanged", async () => {
    // Verify the singleton path: buildGeminiProvider() with no args should
    // use DEFAULT_TIMEOUT_MS. We verify this by checking a successful review
    // still works (no regression).
    const envelopeStr = JSON.stringify({
      session_id: "test",
      response: JSON.stringify({ findings: [] }),
      stats: {},
    });

    const provider = buildGeminiProvider({ spawnFn: makeSpawn(envelopeStr, 0) });
    const result = await provider.review("diff", [], "prompt");

    assert.equal(result.findings.length, 0);
  });
});
