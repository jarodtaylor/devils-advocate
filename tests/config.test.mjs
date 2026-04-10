/**
 * @file Tests for scripts/lib/config.mjs
 *
 * Strategy: inject a fake readFileFn so no real filesystem access is needed.
 * The injected fn maps file paths to return values (string content or ENOENT error).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadConfig, DEFAULTS, ConfigError } from "../scripts/lib/config.mjs";

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Build a readFileFn that returns controlled content per path.
 * Any path not in the map throws ENOENT.
 *
 * @param {Record<string, string | Error>} pathMap
 *   Keys are path substrings to match (we check via includes).
 *   Values are either the raw file content (string) or an Error to throw.
 * @returns {(path: string, encoding: string) => Promise<string>}
 */
function makeReadFileFn(pathMap = {}) {
  return async (path) => {
    for (const [key, val] of Object.entries(pathMap)) {
      if (path.includes(key)) {
        if (val instanceof Error) throw val;
        return val;
      }
    }
    // Default: file not found
    const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
    // @ts-ignore
    err.code = "ENOENT";
    throw err;
  };
}

/**
 * Build an ENOENT error for a path.
 * @param {string} path
 * @returns {NodeJS.ErrnoException}
 */
function enoentError(path) {
  const err = /** @type {NodeJS.ErrnoException} */ (
    new Error(`ENOENT: no such file or directory, open '${path}'`)
  );
  err.code = "ENOENT";
  return err;
}

// ─── Happy paths ──────────────────────────────────────────────────────────────

describe("loadConfig — happy paths", () => {
  it("empty overrides and no config files → returns DEFAULTS exactly", async () => {
    const config = await loadConfig({}, { readFileFn: makeReadFileFn() });
    assert.deepEqual(config, DEFAULTS);
  });

  it("user config only → merges on top of defaults", async () => {
    const readFileFn = makeReadFileFn({
      ".devils-advocate/config.json": JSON.stringify({ timeout: 60 }),
    });
    const config = await loadConfig({}, { readFileFn });
    assert.equal(config.timeout, 60);
    // Provider defaults still intact
    assert.deepEqual(config.providers.codex, { enabled: true });
    assert.deepEqual(config.providers.gemini, { enabled: true });
    assert.deepEqual(config.providers.claude, { enabled: true, model: "sonnet" });
  });

  it("project config overlays user config — project wins on conflict", async () => {
    const readFileFn = makeReadFileFn({
      ".devils-advocate/config.json": JSON.stringify({ timeout: 60 }),
      ".da.json": JSON.stringify({ timeout: 30 }),
    });
    const config = await loadConfig({}, { readFileFn });
    assert.equal(config.timeout, 30);
  });

  it("CLI overrides beat all file configs", async () => {
    const readFileFn = makeReadFileFn({
      ".devils-advocate/config.json": JSON.stringify({ timeout: 60 }),
      ".da.json": JSON.stringify({ timeout: 30 }),
    });
    const config = await loadConfig({ timeout: 10 }, { readFileFn });
    assert.equal(config.timeout, 10);
  });

  it("partial config merges without erasing provider defaults", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({ timeout: 60 }),
    });
    const config = await loadConfig({}, { readFileFn });
    assert.equal(config.timeout, 60);
    assert.deepEqual(config.providers.codex, { enabled: true });
    assert.deepEqual(config.providers.gemini, { enabled: true });
    assert.deepEqual(config.providers.claude, { enabled: true, model: "sonnet" });
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("loadConfig — edge cases", () => {
  it("empty {} config file → valid, returns defaults", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({}),
    });
    const config = await loadConfig({}, { readFileFn });
    assert.deepEqual(config, DEFAULTS);
  });

  it("user config disables codex, project config silent about codex → codex stays disabled", async () => {
    const readFileFn = makeReadFileFn({
      ".devils-advocate/config.json": JSON.stringify({
        providers: { codex: { enabled: false } },
      }),
      ".da.json": JSON.stringify({ timeout: 60 }),
    });
    const config = await loadConfig({}, { readFileFn });
    assert.equal(config.providers.codex.enabled, false);
    assert.equal(config.timeout, 60);
  });

  it("deep merge preserves sibling keys — setting claude.model doesn't erase codex.enabled", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({
        providers: { claude: { model: "opus" } },
      }),
    });
    const config = await loadConfig({}, { readFileFn });
    // claude.model updated, but codex and gemini untouched
    assert.equal(config.providers.claude.model, "opus");
    assert.equal(config.providers.claude.enabled, true);
    assert.equal(config.providers.codex.enabled, true);
    assert.equal(config.providers.gemini.enabled, true);
  });

  it("both config files missing → returns defaults (no error)", async () => {
    const config = await loadConfig({}, { readFileFn: makeReadFileFn() });
    assert.deepEqual(config, DEFAULTS);
  });

  it("~/.devils-advocate/ directory doesn't exist → no error, skip user config", async () => {
    // Simulate ENOENT from a missing directory (same code path as missing file)
    const err = enoentError("~/.devils-advocate/config.json");
    const readFileFn = makeReadFileFn({
      ".devils-advocate/config.json": err,
    });
    const config = await loadConfig({}, { readFileFn });
    assert.deepEqual(config, DEFAULTS);
  });

  it("returned config is frozen (immutable)", async () => {
    const config = await loadConfig({}, { readFileFn: makeReadFileFn() });
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.providers));
    assert.ok(Object.isFrozen(config.providers.claude));
  });

  it("returned config is deep-frozen — nested objects are frozen too", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({
        providers: { claude: { model: "opus" } },
      }),
    });
    const config = await loadConfig({}, { readFileFn });
    assert.ok(Object.isFrozen(config.providers.codex));
    assert.ok(Object.isFrozen(config.providers.gemini));
    assert.ok(Object.isFrozen(config.providers.claude));
  });
});

// ─── Error paths ──────────────────────────────────────────────────────────────

describe("loadConfig — error paths", () => {
  it("malformed JSON in user config → ConfigError with file path", async () => {
    const readFileFn = makeReadFileFn({
      ".devils-advocate/config.json": "{ bad json }",
    });
    await assert.rejects(
      () => loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError, `Expected ConfigError, got: ${err}`);
        assert.ok(
          err.filePath?.includes(".devils-advocate"),
          `Expected filePath to include '.devils-advocate', got: ${err.filePath}`
        );
        assert.ok(
          err.message.includes("invalid JSON"),
          `Expected message to include 'invalid JSON', got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("malformed JSON in project config → ConfigError with file path", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": "not valid json at all",
    });
    await assert.rejects(
      () => loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(
          err.filePath?.includes(".da.json"),
          `Expected filePath to include '.da.json', got: ${err.filePath}`
        );
        assert.ok(err.message.includes("invalid JSON"));
        return true;
      }
    );
  });

  it("timeout is negative → ConfigError", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({ timeout: -5 }),
    });
    await assert.rejects(
      () => loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.field, "timeout");
        assert.ok(err.message.includes("positive"));
        return true;
      }
    );
  });

  it("timeout is zero → ConfigError (must be positive)", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({ timeout: 0 }),
    });
    await assert.rejects(
      () => loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.field, "timeout");
        assert.ok(err.message.includes("positive"));
        return true;
      }
    );
  });

  it("timeout is not a number (string) → ConfigError", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({ timeout: "sixty" }),
    });
    await assert.rejects(
      () => loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.field, "timeout");
        assert.ok(err.message.includes("number"));
        return true;
      }
    );
  });

  it("unknown provider name in config → ConfigError", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({
        providers: { unknown_provider: { enabled: true } },
      }),
    });
    await assert.rejects(
      () => loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(
          err.field?.includes("providers.unknown_provider"),
          `Expected field to include 'providers.unknown_provider', got: ${err.field}`
        );
        assert.ok(err.message.includes("unknown_provider"));
        return true;
      }
    );
  });

  it("ConfigError is an instance of Error", () => {
    const err = new ConfigError("test message", "/path/to/config", "timeout");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ConfigError);
    assert.equal(err.name, "ConfigError");
    assert.equal(err.filePath, "/path/to/config");
    assert.equal(err.field, "timeout");
    assert.equal(err.message, "test message");
  });
});

// ─── Warning paths (stderr, not errors) ──────────────────────────────────────

describe("loadConfig — warning paths", () => {
  it("model field on codex provider → warning to stderr, config still loads", async () => {
    const stderrWrites = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return origWrite(chunk, ...rest);
    };

    try {
      const readFileFn = makeReadFileFn({
        ".da.json": JSON.stringify({
          providers: { codex: { model: "gpt-4o" } },
        }),
      });
      const config = await loadConfig({}, { readFileFn });

      // Should not throw — config loads successfully
      assert.ok(config !== null);
      // Warning written to stderr
      const allOutput = stderrWrites.join("");
      assert.ok(
        allOutput.includes("codex"),
        `Expected stderr to mention 'codex', got: ${allOutput}`
      );
      assert.ok(
        allOutput.includes("ignored") || allOutput.includes("Warning"),
        `Expected stderr warning, got: ${allOutput}`
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("model field on gemini provider → warning to stderr, not an error", async () => {
    const stderrWrites = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return origWrite(chunk, ...rest);
    };

    try {
      const readFileFn = makeReadFileFn({
        ".da.json": JSON.stringify({
          providers: { gemini: { model: "gemini-pro" } },
        }),
      });
      const config = await loadConfig({}, { readFileFn });

      assert.ok(config !== null);
      const allOutput = stderrWrites.join("");
      assert.ok(allOutput.includes("gemini"));
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// ─── DEFAULTS export ──────────────────────────────────────────────────────────

describe("DEFAULTS", () => {
  it("has expected shape", () => {
    assert.equal(typeof DEFAULTS.timeout, "number");
    assert.equal(DEFAULTS.timeout, 120);
    assert.equal(DEFAULTS.providers.codex.enabled, true);
    assert.equal(DEFAULTS.providers.gemini.enabled, true);
    assert.equal(DEFAULTS.providers.claude.enabled, true);
    assert.equal(DEFAULTS.providers.claude.model, "sonnet");
  });

  it("is frozen", () => {
    assert.ok(Object.isFrozen(DEFAULTS));
    assert.ok(Object.isFrozen(DEFAULTS.providers));
  });
});

// ─── Prototype pollution defense ─────────────────────────────────────────────

describe("loadConfig — prototype pollution defense", () => {
  it("rejects __proto__ as a top-level key in user config", async () => {
    // JSON.parse creates __proto__ as an own property (not via the setter),
    // so we need to test the parse-time rejection via a raw JSON string.
    const maliciousJson = '{"__proto__": {"polluted": true}}';
    const readFileFn = makeReadFileFn({
      ".devils-advocate/config.json": maliciousJson,
    });

    await assert.rejects(
      loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes("forbidden key"), `got: ${err.message}`);
        assert.ok(err.message.includes("__proto__"), `got: ${err.message}`);
        return true;
      }
    );
  });

  it("rejects __proto__ in nested provider config", async () => {
    const maliciousJson = '{"providers": {"__proto__": {"enabled": false}}}';
    const readFileFn = makeReadFileFn({
      ".da.json": maliciousJson,
    });

    await assert.rejects(
      loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes("forbidden key"), `got: ${err.message}`);
        return true;
      }
    );
  });

  it("rejects constructor as a config key", async () => {
    const maliciousJson = '{"constructor": {"prototype": {}}}';
    const readFileFn = makeReadFileFn({
      ".da.json": maliciousJson,
    });

    await assert.rejects(
      loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes("forbidden key"), `got: ${err.message}`);
        return true;
      }
    );
  });

  it("rejects prototype as a nested key", async () => {
    const maliciousJson = '{"nested": {"prototype": {"enabled": false}}}';
    const readFileFn = makeReadFileFn({
      ".da.json": maliciousJson,
    });

    await assert.rejects(
      loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes("forbidden key"), `got: ${err.message}`);
        assert.ok(err.message.includes("prototype"), `got: ${err.message}`);
        return true;
      }
    );
  });

  it("does not pollute Object.prototype after rejected config load", async () => {
    const maliciousJson = '{"__proto__": {"polluted": "yes"}}';
    const readFileFn = makeReadFileFn({
      ".da.json": maliciousJson,
    });

    try {
      await loadConfig({}, { readFileFn });
    } catch {
      // expected
    }

    // Verify Object.prototype was not polluted
    const emptyObj = {};
    assert.equal(
      /** @type {Record<string, unknown>} */ (emptyObj).polluted,
      undefined,
      "Object.prototype should not be polluted"
    );
  });
});

// ─── Provider config shape validation ──────────────────────────────────────

describe("loadConfig — provider config shape validation", () => {
  it("rejects providers.codex = null", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({ providers: { codex: null } }),
    });

    await assert.rejects(
      loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes("providers.codex"), `got: ${err.message}`);
        assert.ok(err.message.includes("must be an object"), `got: ${err.message}`);
        return true;
      }
    );
  });

  it("rejects providers.codex = false", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({ providers: { codex: false } }),
    });

    await assert.rejects(
      loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes("providers.codex"), `got: ${err.message}`);
        return true;
      }
    );
  });

  it("rejects providers.gemini = 'enabled'", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({ providers: { gemini: "enabled" } }),
    });

    await assert.rejects(
      loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes("providers.gemini"), `got: ${err.message}`);
        return true;
      }
    );
  });

  it("rejects providers.claude = [] (array)", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({ providers: { claude: [] } }),
    });

    await assert.rejects(
      loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes("providers.claude"), `got: ${err.message}`);
        return true;
      }
    );
  });

  it("rejects enabled as a string", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({ providers: { codex: { enabled: "true" } } }),
    });

    await assert.rejects(
      loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes("enabled"), `got: ${err.message}`);
        assert.ok(err.message.includes("boolean"), `got: ${err.message}`);
        return true;
      }
    );
  });

  it("rejects enabled as a number", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({ providers: { codex: { enabled: 1 } } }),
    });

    await assert.rejects(
      loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes("boolean"), `got: ${err.message}`);
        return true;
      }
    );
  });

  it("rejects claude.model as a number", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({ providers: { claude: { model: 42 } } }),
    });

    await assert.rejects(
      loadConfig({}, { readFileFn }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes("model"), `got: ${err.message}`);
        assert.ok(err.message.includes("string"), `got: ${err.message}`);
        return true;
      }
    );
  });

  it("accepts valid shape with both enabled and model", async () => {
    const readFileFn = makeReadFileFn({
      ".da.json": JSON.stringify({
        providers: { claude: { enabled: true, model: "opus" } },
      }),
    });

    const config = await loadConfig({}, { readFileFn });
    assert.equal(config.providers.claude.enabled, true);
    assert.equal(config.providers.claude.model, "opus");
  });
});
