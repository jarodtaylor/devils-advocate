/**
 * @file Tests for scripts/lib/providers/codex.mjs
 *
 * Strategy: use createCodexProvider(spawnFn) to inject a mock spawn function.
 * This avoids needing to redefine the non-configurable child_process.spawn
 * property, which node:test mock.method cannot do.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { createCodexProvider } from "../../scripts/lib/providers/codex.mjs";

// ─── Mock ChildProcess Factory ────────────────────────────────────────────────

/**
 * Create a minimal mock ChildProcess-like object.
 * stdout and stderr are EventEmitters. stdin is a writable stub that records
 * all data written to it.
 *
 * Call the returned `triggerExit()` to emit data events then the close event.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.stdoutLines]   Lines emitted on stdout (each as a separate data event)
 * @param {string}   [opts.stderrData]    Data emitted on stderr
 * @param {number}   [opts.exitCode]      Exit code for the close event (default 0)
 * @param {number}   [opts.exitDelay]     Delay in ms before emitting close (for timeout tests)
 * @returns {{ proc: object, triggerExit: () => void, stdinChunks: string[] }}
 */
function makeMockProc(opts = {}) {
  const { stdoutLines = [], stderrData = "", exitCode = 0, exitDelay = 0 } = opts;

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  /** @type {string[]} */
  const stdinChunks = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(chunk.toString());
      cb();
    },
  });

  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin });

  function triggerExit() {
    for (const line of stdoutLines) {
      stdout.emit("data", Buffer.from(line + "\n"));
    }
    if (stderrData) {
      stderr.emit("data", Buffer.from(stderrData));
    }
    setTimeout(() => {
      proc.emit("close", exitCode);
    }, exitDelay);
  }

  return { proc, triggerExit, stdinChunks };
}

/**
 * Build a spawn function that returns the given mock proc on first call, then
 * optionally a second mock proc on the second call (used for detect() which
 * spawns `which` then `codex login status`).
 *
 * Each entry is { proc, triggerExit }. The spawn stub calls triggerExit via
 * setImmediate so the caller's listeners are attached before data flows.
 *
 * @param {Array<{ proc: object, triggerExit: () => void }>} sequence
 * @returns {Function}
 */
function makeSpawnSeq(sequence) {
  let idx = 0;
  return function mockSpawn(_cmd, _args, _opts) {
    const entry = sequence[idx++];
    if (!entry) throw new Error(`mockSpawn called more times than expected (call ${idx})`);
    setImmediate(entry.triggerExit);
    return entry.proc;
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_FINDING = {
  severity: /** @type {'HIGH'} */ ("HIGH"),
  title: "SQL injection via unsanitized input",
  description: "User-controlled input is interpolated directly into a query string.",
  rationale: "Line 42 passes req.params.id directly to db.query without parameterization.",
  file: "src/routes/users.ts",
  lineStart: 40,
  lineEnd: 45,
  confidence: 0.9,
};

/**
 * Build a Codex JSONL response.completed event containing the given payload.
 *
 * @param {object} payload
 * @returns {string[]} Array of JSONL lines (one event per element).
 */
function buildJsonlLines(payload) {
  const event = {
    type: "response.completed",
    response: {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(payload) }],
        },
      ],
    },
  };
  return [JSON.stringify(event)];
}

// ─── detect() ────────────────────────────────────────────────────────────────

describe("codexProvider.detect()", () => {
  it("returns installed:true, authenticated:true when codex is on PATH and login status exits 0", async () => {
    const whichMock = makeMockProc({ stdoutLines: ["/usr/local/bin/codex"], exitCode: 0 });
    const loginMock = makeMockProc({ exitCode: 0 });

    const provider = createCodexProvider(makeSpawnSeq([whichMock, loginMock]));
    const result = await provider.detect();

    assert.equal(result.name, "codex");
    assert.equal(result.installed, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.error, undefined);
  });

  it("returns installed:true, authenticated:false when codex is installed but login status exits non-zero", async () => {
    const whichMock = makeMockProc({ stdoutLines: ["/usr/local/bin/codex"], exitCode: 0 });
    const loginMock = makeMockProc({ exitCode: 1, stderrData: "not logged in" });

    const provider = createCodexProvider(makeSpawnSeq([whichMock, loginMock]));
    const result = await provider.detect();

    assert.equal(result.name, "codex");
    assert.equal(result.installed, true);
    assert.equal(result.authenticated, false);
    assert.ok(typeof result.error === "string" && result.error.length > 0, "should include error message");
  });

  it("returns installed:false, authenticated:false when codex is not on PATH", async () => {
    // `which codex` exits 1 — not found
    const whichMock = makeMockProc({ exitCode: 1 });

    const provider = createCodexProvider(makeSpawnSeq([whichMock]));
    const result = await provider.detect();

    assert.equal(result.name, "codex");
    assert.equal(result.installed, false);
    assert.equal(result.authenticated, false);
    assert.ok(typeof result.error === "string" && result.error.length > 0, "should include error message");
  });
});

// ─── review() ────────────────────────────────────────────────────────────────

describe("codexProvider.review()", () => {
  it("parses a valid JSONL response and returns normalized findings", async () => {
    const jsonlLines = buildJsonlLines({ findings: [VALID_FINDING] });
    const reviewMock = makeMockProc({ stdoutLines: jsonlLines, exitCode: 0 });

    const provider = createCodexProvider(makeSpawnSeq([reviewMock]));
    const result = await provider.review("diff text", [], "");

    assert.ok(Array.isArray(result.findings));
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "HIGH");
    assert.equal(result.findings[0].title, VALID_FINDING.title);
    assert.equal(result.findings[0].confidence, 0.9);
    assert.equal(typeof result.raw, "string");
  });

  it("applies confidence default of 0.5 when finding omits confidence field", async () => {
    const findingNoConf = { ...VALID_FINDING };
    // @ts-ignore intentionally removing optional field
    delete findingNoConf.confidence;
    const jsonlLines = buildJsonlLines({ findings: [findingNoConf] });
    const reviewMock = makeMockProc({ stdoutLines: jsonlLines, exitCode: 0 });

    const provider = createCodexProvider(makeSpawnSeq([reviewMock]));
    const result = await provider.review("diff", [], "");

    assert.equal(result.findings[0].confidence, 0.5);
  });

  it("throws a descriptive error when Codex exits with non-zero exit code", async () => {
    const reviewMock = makeMockProc({ exitCode: 2, stderrData: "some codex error" });

    const provider = createCodexProvider(makeSpawnSeq([reviewMock]));
    await assert.rejects(
      () => provider.review("diff", [], ""),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("2"),
          `expected exit code in message: ${err.message}`
        );
        return true;
      }
    );
  });

  it("throws a descriptive error when Codex returns malformed JSON in the text field", async () => {
    const badEvent = JSON.stringify({
      type: "response.completed",
      response: {
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "not valid json {{{" }],
        }],
      },
    });
    const reviewMock = makeMockProc({ stdoutLines: [badEvent], exitCode: 0 });

    const provider = createCodexProvider(makeSpawnSeq([reviewMock]));
    await assert.rejects(
      () => provider.review("diff", [], ""),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes("schema") ||
          err.message.toLowerCase().includes("findings"),
          `expected 'schema' or 'findings' in error: ${err.message}`
        );
        return true;
      }
    );
  });

  it("throws a descriptive error when stdout contains no parseable JSONL events", async () => {
    const reviewMock = makeMockProc({ stdoutLines: ["not json at all"], exitCode: 0 });

    const provider = createCodexProvider(makeSpawnSeq([reviewMock]));
    await assert.rejects(
      () => provider.review("diff", [], ""),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });

  it("throws a timeout error when the process does not complete within timeoutMs", async () => {
    // The mock proc never emits close on its own; the AbortController fires first.
    const { proc } = makeMockProc({ exitCode: 0, exitDelay: 60_000 });

    const spawnFn = /** @type {any} */ ((_cmd, _args, spawnOpts) => {
      // Wire up AbortController signal to emit ABORT_ERR on the proc
      if (spawnOpts && spawnOpts.signal) {
        spawnOpts.signal.addEventListener("abort", () => {
          const err = Object.assign(
            new Error("The operation was aborted"),
            { code: "ABORT_ERR" }
          );
          proc.emit("error", err);
        });
      }
      return proc;
    });

    const provider = createCodexProvider(spawnFn);
    const SHORT_TIMEOUT_MS = 50;

    await assert.rejects(
      () => provider.review("diff", [], "", SHORT_TIMEOUT_MS),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes("timeout") ||
          err.message.toLowerCase().includes("timed out"),
          `expected 'timeout'/'timed out' in message: ${err.message}`
        );
        return true;
      }
    );
  });

  it("delivers the rendered prompt via stdin rather than as a command-line argument", async () => {
    const jsonlLines = buildJsonlLines({ findings: [VALID_FINDING] });
    /** @type {string[]} */
    let capturedArgs = [];
    /** @type {string[]} */
    let capturedStdin = [];

    const spawnFn = /** @type {any} */ ((cmd, args) => {
      capturedArgs = args;
      const { proc, triggerExit } = makeMockProc({ stdoutLines: jsonlLines, exitCode: 0 });

      // Intercept stdin writes to capture prompt delivery
      const origWrite = proc.stdin.write.bind(proc.stdin);
      proc.stdin.write = (data, ...rest) => {
        capturedStdin.push(typeof data === "string" ? data : data.toString());
        return origWrite(data, ...rest);
      };

      setImmediate(triggerExit);
      return proc;
    });

    const provider = createCodexProvider(spawnFn);
    const diffText = "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new";
    await provider.review(diffText, [], "");

    // The diff content / prompt body must NOT appear in the command-line args
    const argsJoined = capturedArgs.join(" ");
    assert.ok(
      !argsJoined.includes("adversarial") && !argsJoined.includes("{{DIFF}}"),
      `prompt template text must not appear in args: ${argsJoined.slice(0, 200)}`
    );

    // stdin must have received the rendered prompt
    assert.ok(capturedStdin.join("").length > 0, "stdin must have received the rendered prompt");
  });

  it("handles JSONL streams with multiple events and returns findings from the last valid one", async () => {
    const inProgressEvent = JSON.stringify({ type: "response.in_progress", delta: {} });
    const completedEvent = JSON.stringify({
      type: "response.completed",
      response: {
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify({ findings: [VALID_FINDING] }) }],
        }],
      },
    });
    const reviewMock = makeMockProc({ stdoutLines: [inProgressEvent, completedEvent], exitCode: 0 });

    const provider = createCodexProvider(makeSpawnSeq([reviewMock]));
    const result = await provider.review("diff", [], "");

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "HIGH");
  });

  it("strips markdown code fences when the model wraps the JSON payload", async () => {
    const textWithFences =
      "```json\n" + JSON.stringify({ findings: [VALID_FINDING] }) + "\n```";
    const event = JSON.stringify({
      type: "response.completed",
      response: {
        output: [{
          type: "message",
          content: [{ type: "output_text", text: textWithFences }],
        }],
      },
    });
    const reviewMock = makeMockProc({ stdoutLines: [event], exitCode: 0 });

    const provider = createCodexProvider(makeSpawnSeq([reviewMock]));
    const result = await provider.review("diff", [], "");

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "HIGH");
  });

  it("raw field contains the complete stdout string", async () => {
    const jsonlLines = buildJsonlLines({ findings: [VALID_FINDING] });
    const reviewMock = makeMockProc({ stdoutLines: jsonlLines, exitCode: 0 });

    const provider = createCodexProvider(makeSpawnSeq([reviewMock]));
    const result = await provider.review("diff", [], "");

    // raw should be the full stdout (each line + newline appended by makeMockProc)
    const expectedRaw = jsonlLines.map((l) => l + "\n").join("");
    assert.equal(result.raw, expectedRaw);
  });

  it("passes --output-schema and --json flags to codex exec", async () => {
    const jsonlLines = buildJsonlLines({ findings: [VALID_FINDING] });
    /** @type {string[]} */
    let capturedArgs = [];

    const spawnFn = /** @type {any} */ ((_cmd, args) => {
      capturedArgs = args;
      const { proc, triggerExit } = makeMockProc({ stdoutLines: jsonlLines, exitCode: 0 });
      setImmediate(triggerExit);
      return proc;
    });

    const provider = createCodexProvider(spawnFn);
    await provider.review("diff", [], "");

    assert.ok(capturedArgs.includes("exec"), "args must include 'exec'");
    assert.ok(capturedArgs.includes("--json"), "args must include '--json'");
    assert.ok(capturedArgs.includes("--output-schema"), "args must include '--output-schema'");
  });
});

// ─── timeoutMs factory injection ──────────────────────────────────────────────

describe("createCodexProvider() — timeoutMs injection", () => {
  it("createCodexProvider(spawn, { timeoutMs }) → factory-level timeout fires before long-running process", async () => {
    // Use a 60ms timeout (not 60s) to keep the test fast. The value is arbitrary
    // — we only need it to fire before the spawned process resolves.
    const SHORT_TIMEOUT_MS = 60;

    const spawnFn = /** @type {any} */ ((_cmd, _args, spawnOpts) => {
      const { proc } = makeMockProc({ exitCode: 0, exitDelay: 60_000 });

      // Wire abort signal to emit ABORT_ERR so makeSpawnCollect rejects
      if (spawnOpts && spawnOpts.signal) {
        spawnOpts.signal.addEventListener("abort", () => {
          const err = Object.assign(
            new Error("The operation was aborted"),
            { code: "ABORT_ERR" }
          );
          proc.emit("error", err);
        });
      }
      return proc;
    });

    const provider = createCodexProvider(spawnFn, { timeoutMs: SHORT_TIMEOUT_MS });

    const start = Date.now();
    await assert.rejects(
      () => provider.review("diff", [], ""),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes("timeout") ||
          err.message.toLowerCase().includes("timed out"),
          `expected timeout error, got: ${err.message}`
        );
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 5000, `should reject quickly with short timeout, elapsed: ${elapsed}ms`);
        return true;
      }
    );
  });

  it("factory timeoutMs is used as default when review() called without 4th arg", async () => {
    // Verify the factory timeout flows through as default to review() when
    // no explicit timeoutMs arg is passed.
    const SHORT_TIMEOUT_MS = 60;

    const spawnFn = /** @type {any} */ ((_cmd, _args, spawnOpts) => {
      const { proc } = makeMockProc({ exitCode: 0, exitDelay: 60_000 });
      if (spawnOpts && spawnOpts.signal) {
        spawnOpts.signal.addEventListener("abort", () => {
          proc.emit("error", Object.assign(
            new Error("The operation was aborted"),
            { code: "ABORT_ERR" }
          ));
        });
      }
      return proc;
    });

    // Pass timeoutMs via factory opts; call review with NO 4th argument
    const provider = createCodexProvider(spawnFn, { timeoutMs: SHORT_TIMEOUT_MS });

    await assert.rejects(
      // Three args only — timeoutMs comes from factory
      () => provider.review("diff", [], ""),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes("timeout") ||
          err.message.toLowerCase().includes("timed out"),
          `expected timeout error from factory timeoutMs, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("review() 4th-arg timeoutMs still overrides factory timeoutMs (backward compat)", async () => {
    // The existing test at line ~249 passes timeoutMs as 4th arg.
    // Confirm that calling review("diff", [], "", SHORT_MS) still works when
    // factory has a different value.
    const FACTORY_TIMEOUT_MS = 10_000; // 10s — longer than test duration
    const CALL_TIMEOUT_MS = 60;        // 60ms — short enough to fire

    const spawnFn = /** @type {any} */ ((_cmd, _args, spawnOpts) => {
      const { proc } = makeMockProc({ exitCode: 0, exitDelay: 60_000 });
      if (spawnOpts && spawnOpts.signal) {
        spawnOpts.signal.addEventListener("abort", () => {
          proc.emit("error", Object.assign(
            new Error("The operation was aborted"),
            { code: "ABORT_ERR" }
          ));
        });
      }
      return proc;
    });

    const provider = createCodexProvider(spawnFn, { timeoutMs: FACTORY_TIMEOUT_MS });

    const start = Date.now();
    await assert.rejects(
      () => provider.review("diff", [], "", CALL_TIMEOUT_MS),
      (err) => {
        assert.ok(err instanceof Error);
        const elapsed = Date.now() - start;
        // Should reject at ~60ms, not at 10000ms
        assert.ok(elapsed < 5000, `should reject at call-level timeout, elapsed: ${elapsed}ms`);
        return true;
      }
    );
  });
});
