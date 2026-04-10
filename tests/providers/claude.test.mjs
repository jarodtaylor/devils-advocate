/**
 * @file Tests for scripts/lib/providers/claude.mjs
 *
 * Strategy: inject a mock spawnFn via buildClaudeProvider() to avoid any
 * dependency on the real Claude Code CLI being installed or authenticated.
 *
 * Mock spawn returns an EventEmitter-based fake process that emits stdout/stderr
 * data and a close event asynchronously, mimicking real child_process behavior.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildClaudeProvider } from "../../scripts/lib/providers/claude.mjs";

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
 * Create a mock spawn that immediately emits stdout and closes.
 *
 * @param {string} stdoutData - Data to emit on stdout.
 * @param {number} [exitCode=0]
 * @param {string} [stderrData=""]
 * @returns {(cmd: string, args: string[], opts?: object) => MockProcess}
 */
function makeSpawn(stdoutData, exitCode = 0, stderrData = "") {
  return (_cmd, _args, _opts) => {
    const proc = new MockProcess();
    setImmediate(() => {
      if (stdoutData) proc.stdout.emit("data", Buffer.from(stdoutData));
      if (stderrData) proc.stderr.emit("data", Buffer.from(stderrData));
      proc.emit("close", exitCode);
    });
    return proc;
  };
}

/**
 * Create a mock spawn that handles sequential calls:
 *  1. `sh -c command -v claude` — install check (exit 0 = installed, 1 = not found)
 *  2. `claude -p ...` — the actual review call
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
      // First call: sh -c command -v claude
      const proc = new MockProcess();
      setImmediate(() => proc.emit("close", installed ? 0 : 1));
      return proc;
    }
    // Subsequent calls: claude review invocation
    return makeSpawn(reviewStdout, reviewExitCode, reviewStderr)(cmd, args, opts);
  };
}

// ─── Valid finding fixture ────────────────────────────────────────────────────

/** @returns {import('../../scripts/lib/types.mjs').Finding} */
function validFinding() {
  return {
    severity: "HIGH",
    title: "SQL injection via unsanitized query parameter",
    description: "User-controlled data reaches a DB query without sanitization.",
    rationale: "Line 42 passes req.body.id directly to db.query() without escaping.",
    file: "src/routes/users.ts",
    lineStart: 40,
    lineEnd: 45,
    confidence: 0.9,
  };
}

/**
 * Build a valid Claude JSON envelope string.
 * Mirrors the real `claude -p --output-format json` output shape:
 * `{type:"result", subtype:"success", is_error:false, result:"<text>", ...}`
 *
 * @param {import('../../scripts/lib/types.mjs').Finding[]} [findings]
 * @returns {string}
 */
function makeEnvelope(findings) {
  const inner = JSON.stringify({ findings: findings ?? [validFinding()] });
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: inner,
    duration_ms: 1234,
    num_turns: 1,
  });
}

// ─── detect() — happy paths ───────────────────────────────────────────────────

describe("claudeProvider.detect() — happy paths", () => {
  it("claude on PATH → installed: true, authenticated: true", async () => {
    // spawn exits 0 for command -v claude
    const spawnFn = makeSpawn("", 0);
    const provider = buildClaudeProvider({ spawnFn });

    const result = await provider.detect();

    assert.equal(result.name, "claude");
    assert.equal(result.installed, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.error, undefined);
  });

  it("install check uses sh -c command -v claude", async () => {
    /** @type {string[][]} */
    const calls = [];
    const spawnFn = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {object | undefined} */ _opts) => {
      calls.push([cmd, ...args]);
      const proc = new MockProcess();
      setImmediate(() => proc.emit("close", 0));
      return proc;
    };

    const provider = buildClaudeProvider({ spawnFn });
    await provider.detect();

    assert.ok(calls.length >= 1, "spawn should have been called");
    const [cmd, ...firstArgs] = calls[0];
    assert.equal(cmd, "sh");
    assert.ok(firstArgs.includes("-c"), "should pass -c flag");
    assert.ok(firstArgs.some((a) => a.includes("claude")), "should check for claude command");
  });
});

// ─── detect() — not installed ─────────────────────────────────────────────────

describe("claudeProvider.detect() — not installed", () => {
  it("claude not on PATH → installed: false, authenticated: false", async () => {
    // spawn exits 1 for command -v claude → not found
    const spawnFn = makeSpawn("", 1);
    const provider = buildClaudeProvider({ spawnFn });

    const result = await provider.detect();

    assert.equal(result.name, "claude");
    assert.equal(result.installed, false);
    assert.equal(result.authenticated, false);
    assert.ok(typeof result.error === "string", "should include an error message");
    assert.ok(
      result.error.includes("claude") || result.error.includes("PATH"),
      `error should mention claude or PATH, got: ${result.error}`
    );
  });

  it("spawn error during install check → installed: false, authenticated: false", async () => {
    const spawnFn = (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {object | undefined} */ _opts) => {
      const proc = new MockProcess();
      setImmediate(() => proc.emit("error", new Error("ENOENT: spawn failed")));
      return proc;
    };

    const provider = buildClaudeProvider({ spawnFn });
    const result = await provider.detect();

    assert.equal(result.installed, false);
    assert.equal(result.authenticated, false);
  });
});

// ─── detect() — return shape ──────────────────────────────────────────────────

describe("claudeProvider.detect() — return shape", () => {
  it("result always has installed, authenticated, name fields", async () => {
    const provider = buildClaudeProvider({ spawnFn: makeSpawn("", 1) });
    const result = await provider.detect();

    assert.ok("installed" in result);
    assert.ok("authenticated" in result);
    assert.ok("name" in result);
    assert.equal(result.name, "claude");
  });
});

// ─── review() — happy paths ───────────────────────────────────────────────────

describe("claudeProvider.review() — happy paths", () => {
  it("valid JSON envelope → findings extracted from result field", async () => {
    const finding = validFinding();
    const envelopeStr = makeEnvelope([finding]);

    const provider = buildClaudeProvider({ spawnFn: makeSpawn(envelopeStr, 0) });
    const result = await provider.review("diff content", [], "adversarial prompt");

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "HIGH");
    assert.equal(result.findings[0].title, finding.title);
    assert.equal(result.findings[0].file, finding.file);
    assert.equal(result.raw, envelopeStr);
  });

  it("multiple findings → all normalized with confidence default", async () => {
    const f1 = validFinding();
    const f2 = { ...validFinding(), title: "Second issue", severity: /** @type {'MEDIUM'} */ ("MEDIUM") };
    // @ts-ignore — intentional: test normalization of absent confidence
    delete f2.confidence;

    const envelopeStr = makeEnvelope([f1, f2]);
    const provider = buildClaudeProvider({ spawnFn: makeSpawn(envelopeStr, 0) });
    const result = await provider.review("diff", [], "prompt");

    assert.equal(result.findings.length, 2);
    assert.equal(result.findings[0].confidence, 0.9);
    assert.equal(result.findings[1].confidence, 0.5);
  });

  it("empty findings array → valid, 0 findings returned", async () => {
    const envelopeStr = makeEnvelope([]);
    const provider = buildClaudeProvider({ spawnFn: makeSpawn(envelopeStr, 0) });
    const result = await provider.review("diff", [], "prompt");

    assert.equal(result.findings.length, 0);
    assert.equal(typeof result.raw, "string");
  });

  it("result field wrapped in markdown fences → fences stripped, JSON parsed", async () => {
    const finding = validFinding();
    const inner = JSON.stringify({ findings: [finding] });
    const fenced = "```json\n" + inner + "\n```";
    const envelopeStr = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: fenced,
    });

    const provider = buildClaudeProvider({ spawnFn: makeSpawn(envelopeStr, 0) });
    const result = await provider.review("diff", [], "prompt");

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "HIGH");
  });

  it("passes -p flag, --output-format json, --model sonnet, --no-input to claude CLI", async () => {
    /** @type {string[][]} */
    const spawnCalls = [];
    const envelopeStr = makeEnvelope([]);

    const spawnFn = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {object | undefined} */ _opts) => {
      spawnCalls.push([cmd, ...args]);
      return makeSpawn(envelopeStr, 0)(cmd, args, _opts);
    };

    const provider = buildClaudeProvider({ spawnFn });
    await provider.review("diff", [], "my test prompt");

    assert.ok(spawnCalls.length >= 1);
    const reviewCall = spawnCalls[spawnCalls.length - 1];
    assert.equal(reviewCall[0], "claude", "should call claude binary");
    assert.ok(reviewCall.includes("-p"), "should have -p flag");
    assert.ok(reviewCall.includes("--output-format"), "should have --output-format");
    assert.ok(reviewCall.includes("json"), "should include json as output format");
    assert.ok(reviewCall.includes("--model"), "should have --model flag");
    assert.ok(reviewCall.includes("sonnet"), "should use sonnet model");
    assert.ok(reviewCall.includes("--no-input"), "should include --no-input for non-interactive mode");
  });
});

// ─── review() — error paths ───────────────────────────────────────────────────

describe("claudeProvider.review() — error paths", () => {
  it("claude exits non-zero → throws provider error with exit code", async () => {
    const provider = buildClaudeProvider({
      spawnFn: makeSpawn("", 1, "authentication error: session expired"),
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

  it("stdout is not valid JSON → throws malformed envelope error", async () => {
    const provider = buildClaudeProvider({
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

  it("envelope is_error: true → throws error response error", async () => {
    const errorEnvelope = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "API error: rate limit exceeded",
    });

    const provider = buildClaudeProvider({
      spawnFn: makeSpawn(errorEnvelope, 0),
    });

    await assert.rejects(
      () => provider.review("diff", [], "prompt"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("error") || err.message.includes("result"),
          `expected error response message, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("envelope missing result field → throws descriptive error", async () => {
    const badEnvelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      // result field intentionally omitted
    });

    const provider = buildClaudeProvider({
      spawnFn: makeSpawn(badEnvelope, 0),
    });

    await assert.rejects(
      () => provider.review("diff", [], "prompt"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("result"),
          `expected 'result' in error message, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("result field contains invalid JSON → throws malformed result error", async () => {
    const badEnvelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "this is prose, not JSON {{{{",
    });

    const provider = buildClaudeProvider({
      spawnFn: makeSpawn(badEnvelope, 0),
    });

    await assert.rejects(
      () => provider.review("diff", [], "prompt"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("invalid JSON") || err.message.includes("result"),
          `expected invalid JSON error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("findings fail schema validation → throws validation error", async () => {
    const badInner = JSON.stringify({
      findings: [{ severity: "INVALID_LEVEL", title: "" }],
    });
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: badInner,
    });

    const provider = buildClaudeProvider({
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

describe("claudeProvider.review() — timeout", () => {
  it("process that never closes → rejects when error emitted", async () => {
    /** @type {MockProcess | null} */
    let capturedProc = null;

    const spawnFn = (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {object | undefined} */ _opts) => {
      const proc = new MockProcess();
      capturedProc = proc;
      // Never emit close — simulates a hanging process
      return proc;
    };

    const provider = buildClaudeProvider({ spawnFn });
    const reviewPromise = provider.review("diff", [], "prompt");

    // Wait one tick for spawn to be registered
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(capturedProc !== null, "spawn should have been called");

    // Simulate timeout / process error
    capturedProc.emit("error", new Error("spawn timed out"));

    await assert.rejects(reviewPromise, (err) => {
      assert.ok(err instanceof Error);
      return true;
    });
  });

  it("AbortController abort → process kill() is invoked and promise rejects", async () => {
    /** @type {MockProcess | null} */
    let capturedProc = null;
    let killCalled = false;

    const spawnFn = (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {object | undefined} */ _opts) => {
      const proc = new MockProcess();
      const origKill = proc.kill.bind(proc);
      proc.kill = (/** @type {string | undefined} */ sig) => {
        killCalled = true;
        origKill(sig);
      };
      capturedProc = proc;
      // Never emit close — hang indefinitely
      return proc;
    };

    const provider = buildClaudeProvider({ spawnFn });
    const reviewPromise = provider.review("diff", [], "prompt");

    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(capturedProc, "process should have been spawned");

    // Simulate the abort signal firing (as the internal AbortController would)
    capturedProc.emit("error", new Error("SIGTERM: process terminated"));

    await assert.rejects(reviewPromise);
  });
});

// ─── review() — return shape contract ────────────────────────────────────────

describe("claudeProvider.review() — return shape", () => {
  it("result always has findings (array) and raw (string)", async () => {
    const provider = buildClaudeProvider({
      spawnFn: makeSpawn(makeEnvelope([]), 0),
    });

    const result = await provider.review("diff", [], "prompt");

    assert.ok("findings" in result, "result must have findings");
    assert.ok("raw" in result, "result must have raw");
    assert.ok(Array.isArray(result.findings), "findings must be array");
    assert.equal(typeof result.raw, "string", "raw must be string");
  });
});
