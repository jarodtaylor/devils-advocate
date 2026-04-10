/**
 * @file Claude Code CLI provider adapter.
 * Implements the Provider interface for the Claude Code CLI (`claude`).
 *
 * Auth detection: `command -v claude` is sufficient — if the user is running
 * this plugin FROM Claude Code, the session is already authenticated. The CLI
 * uses OAuth from the user's existing session; there is no separate login step.
 *
 * Invocation: `claude -p <prompt> --output-format json --model sonnet`
 * Large prompts are delivered via stdin using `-p -`.
 *
 * Output: JSON envelope `{type, subtype, is_error, result, ...}` where
 * `result` is a string containing the model's text response.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { buildPrompt } from "../prompt.mjs";
import { validateFindings, normalizeFindings } from "../types.mjs";

// ─── Constants ────────────────────────────────────────────────────────────────

const PROVIDER_NAME = "claude";
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Threshold above which the prompt is piped via stdin (`-p -`) rather than
 * passed as a CLI argument. Matches the same 128 KB threshold used by Gemini.
 */
const PROMPT_ARG_SIZE_LIMIT = 128 * 1024;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Check whether the `claude` binary is on PATH.
 *
 * @param {typeof nodeSpawn} spawnFn - Injectable spawn for testing.
 * @returns {Promise<boolean>}
 */
function checkInstalled(spawnFn) {
  return new Promise((resolve) => {
    const proc = spawnFn("sh", ["-c", "command -v claude"], { shell: false });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

/**
 * Run the claude CLI and collect its stdout.
 * Handles the large-prompt case by piping via stdin (`-p -`).
 *
 * Flags used:
 *   `-p <prompt>` — print mode (non-interactive, exits after response)
 *   `--output-format json` — structured JSON envelope
 *   `--model sonnet` — Sonnet for speed/cost; different perspective from Opus
 *   `--no-input` — disables any interactive stdin prompts from Claude Code itself
 *
 * @param {string} renderedPrompt
 * @param {AbortSignal} signal
 * @param {typeof nodeSpawn} spawnFn
 * @returns {Promise<string>} raw stdout
 */
function runClaude(renderedPrompt, signal, spawnFn) {
  const promptBytes = Buffer.byteLength(renderedPrompt, "utf8");
  const useStdin = promptBytes > PROMPT_ARG_SIZE_LIMIT;

  /** @type {string[]} */
  const args = useStdin
    ? ["-p", "-", "--output-format", "json", "--model", "sonnet", "--no-input"]
    : ["-p", renderedPrompt, "--output-format", "json", "--model", "sonnet", "--no-input"];

  /** @type {import('node:child_process').SpawnOptions} */
  const spawnOpts = {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  };

  return new Promise((resolve, reject) => {
    const proc = spawnFn("claude", args, spawnOpts);

    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];

    proc.stdout.on("data", (/** @type {Buffer} */ chunk) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (/** @type {Buffer} */ chunk) => stderrChunks.push(chunk));

    // Write prompt via stdin for large prompts; always close stdin to signal EOF
    if (useStdin && proc.stdin) {
      proc.stdin.write(renderedPrompt, "utf8");
      proc.stdin.end();
    } else if (proc.stdin) {
      proc.stdin.end();
    }

    // Handle abort (timeout)
    const onAbort = () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already exited
      }
      reject(new Error(`Claude provider timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);

      if (signal.aborted) {
        // reject already called via onAbort
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (code !== 0) {
        reject(
          new Error(
            `Claude CLI exited with code ${code}` +
              (stderr ? `: ${stderr}` : "")
          )
        );
        return;
      }

      resolve(stdout);
    });
  });
}

// ─── Response parser ──────────────────────────────────────────────────────────

/**
 * Parse the JSON envelope from `claude -p --output-format json` stdout and
 * extract the findings from the model's text response.
 *
 * Envelope shape: `{type: "result", subtype: "success"|..., is_error: bool, result: string, ...}`
 * The `result` field contains the model's text, which must be (or contain) a
 * JSON object matching `{findings: Finding[]}`.
 *
 * @param {string} stdout - Raw stdout from the claude CLI.
 * @returns {{ findings: import('../types.mjs').Finding[], raw: string }}
 */
function parseClaudeOutput(stdout) {
  /** @type {Record<string, unknown>} */
  let envelope;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      `Claude provider returned malformed JSON envelope. Raw output:\n${stdout.slice(0, 500)}`
    );
  }

  // Detect explicit error responses from the CLI
  if (envelope.is_error === true || envelope.subtype === "error") {
    throw new Error(
      `Claude CLI returned an error response. result: ${String(envelope.result ?? "").slice(0, 300)}`
    );
  }

  if (typeof envelope.result !== "string") {
    throw new Error(
      `Claude envelope missing "result" string field. Keys: ${Object.keys(envelope).join(", ")}`
    );
  }

  const resultText = envelope.result;

  // The model should return a JSON object. Strip markdown fences if present.
  const stripped = resultText.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  /** @type {unknown} */
  let inner;
  try {
    inner = JSON.parse(stripped);
  } catch {
    throw new Error(
      `Claude "result" field contains invalid JSON:\n${resultText.slice(0, 500)}`
    );
  }

  const { valid, errors } = validateFindings(inner);
  if (!valid) {
    throw new Error(
      `Claude findings failed schema validation:\n${errors.join("\n")}\n\nRaw result:\n${resultText.slice(0, 500)}`
    );
  }

  const parsed = /** @type {{ findings: import('../types.mjs').Finding[] }} */ (inner);
  const findings = normalizeFindings(parsed.findings);

  return { findings, raw: stdout };
}

// ─── Provider Export ──────────────────────────────────────────────────────────

/**
 * Build the Claude provider, optionally injecting dependencies for testing.
 *
 * @param {{
 *   spawnFn?: typeof nodeSpawn,
 * }} [deps]
 * @returns {import('../types.mjs').Provider & { name: string }}
 */
export function buildClaudeProvider(deps = {}) {
  const spawnFn = deps.spawnFn ?? nodeSpawn;

  return {
    name: PROVIDER_NAME,

    /**
     * Check whether Claude Code CLI is installed and available.
     *
     * Auth check is intentionally trivial: if `claude` is on PATH, the user
     * is running this plugin from within Claude Code and is already authenticated
     * via their existing OAuth session. No separate credential file to inspect.
     *
     * @returns {Promise<import('../types.mjs').DetectResult>}
     */
    async detect() {
      const installed = await checkInstalled(spawnFn);

      if (!installed) {
        return {
          installed: false,
          authenticated: false,
          name: PROVIDER_NAME,
          error: "claude CLI not found on PATH — install Claude Code from https://claude.ai/download",
        };
      }

      return {
        installed: true,
        authenticated: true,
        name: PROVIDER_NAME,
      };
    },

    /**
     * Run an adversarial review via the Claude Code CLI.
     *
     * @param {string} diffText
     * @param {{ path: string, content: string }[]} files
     * @param {string} prompt - Rendered prompt string (from buildPrompt or orchestrator).
     * @returns {Promise<import('../types.mjs').ReviewResult>}
     */
    async review(diffText, files, prompt) {
      const renderedPrompt = prompt || buildPrompt(diffText, files);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      let raw;
      try {
        raw = await runClaude(renderedPrompt, controller.signal, spawnFn);
      } finally {
        clearTimeout(timeoutId);
      }

      return parseClaudeOutput(raw);
    },
  };
}

// ─── Default singleton ────────────────────────────────────────────────────────

/**
 * Default singleton provider instance using real system dependencies.
 *
 * @type {import('../types.mjs').Provider & { name: string }}
 */
export const claudeProvider = buildClaudeProvider();

export default claudeProvider;
