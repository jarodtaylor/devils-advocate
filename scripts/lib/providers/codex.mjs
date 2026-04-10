/**
 * @file Codex CLI provider adapter.
 * Implements the Provider interface for OpenAI Codex CLI.
 *
 * Auth detection: `codex login status` (exit 0 = authenticated).
 * Review invocation: `codex exec --json --output-schema <schemaPath>` with
 * rendered prompt delivered via stdin to handle large prompts safely.
 *
 * The module exports `createCodexProvider(spawnFn?)` for dependency injection
 * in tests, and `codexProvider` as the default singleton using the real spawn.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { buildPrompt, getSchemaPath } from "../prompt.mjs";
import { validateFindings, normalizeFindings } from "../types.mjs";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default timeout in milliseconds before killing the Codex process. */
const DEFAULT_TIMEOUT_MS = 120_000;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Build a spawnCollect function bound to a specific spawn implementation.
 * Returns a function that spawns a command, pipes optional stdin data,
 * and resolves with {stdout, stderr, code} when the process closes.
 *
 * @param {typeof nodeSpawn} spawnFn
 * @returns {(cmd: string, args: string[], opts?: { signal?: AbortSignal, stdinData?: string }) => Promise<{stdout: string, stderr: string, code: number}>}
 */
function makeSpawnCollect(spawnFn) {
  return function spawnCollect(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawnFn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        signal: opts.signal,
      });

      /** @type {Buffer[]} */
      const outChunks = [];
      /** @type {Buffer[]} */
      const errChunks = [];

      proc.stdout.on("data", (chunk) => outChunks.push(Buffer.from(chunk)));
      proc.stderr.on("data", (chunk) => errChunks.push(Buffer.from(chunk)));

      proc.on("error", (err) => {
        // AbortError surfaces here when the AbortController fires
        if (/** @type {any} */ (err).code === "ABORT_ERR") {
          reject(new Error("Codex process timed out"));
        } else {
          reject(err);
        }
      });

      proc.on("close", (code) => {
        resolve({
          stdout: Buffer.concat(outChunks).toString("utf8"),
          stderr: Buffer.concat(errChunks).toString("utf8"),
          code: code ?? 1,
        });
      });

      // Deliver prompt via stdin; close signals EOF to the child process
      if (opts.stdinData !== undefined) {
        proc.stdin.write(opts.stdinData, "utf8");
        proc.stdin.end();
      } else {
        proc.stdin.end();
      }
    });
  };
}

// ─── JSONL parser ─────────────────────────────────────────────────────────────

/**
 * Parse the JSONL event stream from `codex exec --json` stdout.
 *
 * Each line is a JSON object. We walk the events in reverse order (preferring
 * the last/most-complete response) and extract candidate text strings from
 * multiple known event shapes. The first candidate that validates as a findings
 * object is returned.
 *
 * Expected primary shape:
 *   {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"..."}]}]}}
 *
 * @param {string} stdout - Raw JSONL output from codex exec.
 * @returns {{ findings: import('../types.mjs').Finding[], raw: string }}
 */
function parseCodexJsonl(stdout) {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);

  /** @type {string[]} */
  const candidates = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (!event || typeof event !== "object") continue;

    // Pattern 1: response.completed with nested output array
    const response = event.response;
    if (response && Array.isArray(response.output)) {
      for (const outputItem of response.output) {
        if (Array.isArray(outputItem.content)) {
          for (const contentItem of outputItem.content) {
            if (typeof contentItem.text === "string") {
              candidates.push(contentItem.text);
            }
          }
        }
        // Some events embed text directly on the output item
        if (typeof outputItem.text === "string") {
          candidates.push(outputItem.text);
        }
      }
    }

    // Pattern 2: item.completed with text nested under item
    if (event.item && typeof event.item.text === "string") {
      candidates.push(event.item.text);
    }

    // Pattern 3: delta or simple message events with a top-level text field
    if (typeof event.text === "string") {
      candidates.push(event.text);
    }

    // Pattern 4: message with a top-level content array
    if (Array.isArray(event.content)) {
      for (const c of event.content) {
        if (typeof c.text === "string") {
          candidates.push(c.text);
        }
      }
    }
  }

  for (const text of candidates) {
    // Strip markdown fences if the model wrapped the JSON anyway
    const stripped = text.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    let parsed;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      continue;
    }

    const { valid } = validateFindings(parsed);
    if (valid) {
      const findings = normalizeFindings(
        /** @type {{ findings: import('../types.mjs').Finding[] }} */ (parsed).findings
      );
      return { findings, raw: stdout };
    }
  }

  throw new Error(
    `Codex returned output that does not match the findings schema. ` +
    `Raw output (first 500 chars): ${stdout.slice(0, 500)}`
  );
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a Codex provider instance.
 * Pass a custom `spawnFn` in tests to avoid requiring Codex CLI to be installed.
 *
 * @param {typeof nodeSpawn} [spawnFn] - spawn implementation; defaults to node:child_process spawn.
 * @returns {import('../types.mjs').Provider & { name: string }}
 */
export function createCodexProvider(spawnFn = nodeSpawn) {
  const spawnCollect = makeSpawnCollect(spawnFn);

  /**
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async function isOnPath(name) {
    try {
      const result = await spawnCollect("which", [name]);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  return {
    name: "codex",

    /**
     * Check whether Codex CLI is installed and authenticated.
     *
     * @returns {Promise<import('../types.mjs').DetectResult>}
     */
    async detect() {
      const installed = await isOnPath("codex");
      if (!installed) {
        return {
          name: "codex",
          installed: false,
          authenticated: false,
          error: "codex not found on PATH",
        };
      }

      try {
        const result = await spawnCollect("codex", ["login", "status"]);
        const authenticated = result.code === 0;
        return {
          name: "codex",
          installed: true,
          authenticated,
          ...(authenticated ? {} : { error: "codex login status returned non-zero exit code" }),
        };
      } catch (err) {
        return {
          name: "codex",
          installed: true,
          authenticated: false,
          error: `codex login status failed: ${/** @type {Error} */ (err).message}`,
        };
      }
    },

    /**
     * Run adversarial review via Codex CLI and return structured findings.
     *
     * The rendered prompt is delivered via stdin (not a command-line argument)
     * to safely handle large diffs that would exceed shell argument limits.
     *
     * @param {string} diffText
     * @param {{ path: string, content: string }[]} files
     * @param {string} [promptContext] - Optional context string (passed to buildPrompt).
     * @param {number} [timeoutMs]
     * @returns {Promise<import('../types.mjs').ReviewResult>}
     */
    async review(diffText, files, promptContext = "", timeoutMs = DEFAULT_TIMEOUT_MS) {
      const renderedPrompt = buildPrompt(diffText, files, promptContext);
      const schemaPath = getSchemaPath();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let result;
      try {
        // Pass rendered prompt via stdin; `-` as the last arg signals stdin input.
        result = await spawnCollect(
          "codex",
          ["exec", "--json", "--output-schema", schemaPath, "-"],
          { signal: controller.signal, stdinData: renderedPrompt }
        );
      } catch (err) {
        clearTimeout(timer);
        const message = /** @type {Error} */ (err).message;
        if (message.includes("timed out")) {
          throw new Error(`Codex review timed out after ${timeoutMs}ms`);
        }
        throw new Error(`Codex exec failed: ${message}`);
      } finally {
        clearTimeout(timer);
      }

      if (result.code !== 0) {
        throw new Error(
          `Codex exec exited with code ${result.code}. ` +
          `stderr: ${result.stderr.slice(0, 300)}`
        );
      }

      return parseCodexJsonl(result.stdout);
    },
  };
}

// ─── Default singleton ────────────────────────────────────────────────────────

/**
 * Default Codex provider using the real child_process.spawn.
 * Import this for production use.
 *
 * @type {import('../types.mjs').Provider & { name: string }}
 */
export const codexProvider = createCodexProvider();

export default codexProvider;
