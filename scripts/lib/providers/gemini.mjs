/**
 * @file Gemini CLI provider adapter.
 * Implements the Provider interface for the Gemini CLI tool.
 *
 * Auth strategy: read ~/.gemini/oauth_creds.json and check expiry_date.
 * No CLI status command available for Gemini.
 *
 * Invocation: `gemini -p <prompt> -o json --approval-mode plan`
 * Output: JSON envelope `{session_id, response, stats}` where `response`
 * is a JSON string containing `{findings: Finding[]}`.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { buildPrompt } from "../prompt.mjs";
import { validateFindings, normalizeFindings } from "../types.mjs";

// ─── Constants ───────────────────────────────────────────────────────────────

const PROVIDER_NAME = "gemini";
const DEFAULT_TIMEOUT_MS = 120_000;

/** Threshold above which the prompt is written to a temp file instead of
 *  passed as a CLI argument. 128 KB matches the plan spec. */
const PROMPT_ARG_SIZE_LIMIT = 128 * 1024;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Check whether the `gemini` binary is on PATH.
 * Uses `command -v` via sh to stay portable (same as Codex adapter).
 *
 * @param {typeof nodeSpawn} spawnFn - Injectable spawn for testing.
 * @returns {Promise<boolean>}
 */
function checkInstalled(spawnFn) {
  return new Promise((resolve) => {
    const proc = spawnFn("sh", ["-c", "command -v gemini"], { shell: false });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

/**
 * Determine whether Gemini has valid OAuth credentials on disk.
 * Reads ~/.gemini/oauth_creds.json and checks that `expiry_date` (epoch ms)
 * is strictly greater than Date.now().
 *
 * @param {typeof readFile} readFileFn - Injectable fs.promises.readFile for testing.
 * @returns {Promise<{authenticated: boolean, error?: string}>}
 */
async function checkAuth(readFileFn) {
  const credPath = join(homedir(), ".gemini", "oauth_creds.json");
  try {
    const raw = await readFileFn(credPath, "utf8");
    /** @type {Record<string, unknown>} */
    let creds;
    try {
      creds = JSON.parse(raw);
    } catch {
      return { authenticated: false, error: "oauth_creds.json is not valid JSON" };
    }

    const expiry = creds["expiry_date"];
    if (typeof expiry !== "number") {
      return {
        authenticated: false,
        error: "oauth_creds.json missing numeric expiry_date field",
      };
    }

    if (expiry <= Date.now()) {
      return { authenticated: false, error: "Gemini OAuth token has expired" };
    }

    return { authenticated: true };
  } catch (/** @type {unknown} */ err) {
    const nodeErr = /** @type {NodeJS.ErrnoException} */ (err);
    if (nodeErr.code === "ENOENT") {
      return {
        authenticated: false,
        error: "~/.gemini/oauth_creds.json not found — run `gemini` to authenticate",
      };
    }
    return {
      authenticated: false,
      error: `Failed to read oauth_creds.json: ${nodeErr.message}`,
    };
  }
}

/**
 * Run the gemini CLI and collect its stdout.
 * Handles the large-prompt case by writing to a temp file and piping via stdin.
 *
 * @param {string} renderedPrompt
 * @param {AbortSignal} signal
 * @param {typeof nodeSpawn} spawnFn
 * @returns {Promise<string>} raw stdout
 */
async function runGemini(renderedPrompt, signal, spawnFn) {
  const promptBytes = Buffer.byteLength(renderedPrompt, "utf8");
  const useTempFile = promptBytes > PROMPT_ARG_SIZE_LIMIT;

  /** @type {string | null} */
  let tempFile = null;

  try {
    /** @type {string[]} */
    let args;
    /** @type {import('node:child_process').SpawnOptions} */
    let spawnOpts;

    if (useTempFile) {
      const tmpDir = await mkdtemp(join(tmpdir(), "da-gemini-"));
      tempFile = join(tmpDir, "prompt.txt");
      await writeFile(tempFile, renderedPrompt, "utf8");
      // Pipe the file as stdin; use `-p -` to read from stdin
      args = ["-p", "-", "-o", "json", "--yolo"];
      spawnOpts = {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      };
    } else {
      args = ["-p", renderedPrompt, "-o", "json", "--yolo"];
      spawnOpts = {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      };
    }

    return await new Promise((resolve, reject) => {
      const proc = spawnFn("gemini", args, spawnOpts);

      /** @type {Buffer[]} */
      const stdoutChunks = [];
      /** @type {Buffer[]} */
      const stderrChunks = [];

      proc.stdout.on("data", (/** @type {Buffer} */ chunk) => stdoutChunks.push(chunk));
      proc.stderr.on("data", (/** @type {Buffer} */ chunk) => stderrChunks.push(chunk));

      // When using stdin pipe, write the prompt file content
      if (useTempFile && proc.stdin) {
        // Import synchronously is not needed — we already have the content
        proc.stdin.write(renderedPrompt, "utf8");
        proc.stdin.end();
      }

      // Handle abort (timeout)
      const onAbort = () => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // already exited
        }
        reject(new Error(`Gemini provider timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      proc.on("error", (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error(`Failed to spawn gemini: ${err.message}`));
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
              `Gemini CLI exited with code ${code}` +
                (stderr ? `: ${stderr}` : "")
            )
          );
          return;
        }

        resolve(stdout);
      });
    });
  } finally {
    if (tempFile) {
      unlink(tempFile).catch(() => {
        // best-effort cleanup
      });
    }
  }
}

// ─── Provider Export ──────────────────────────────────────────────────────────

/**
 * Build the Gemini provider, optionally injecting dependencies for testing.
 *
 * @param {{
 *   spawnFn?: typeof nodeSpawn,
 *   readFileFn?: typeof readFile,
 * }} [deps]
 * @returns {import('../types.mjs').Provider}
 */
export function buildGeminiProvider(deps = {}) {
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const readFileFn = deps.readFileFn ?? readFile;

  return {
    /**
     * Check whether Gemini CLI is installed and authenticated.
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
          error: "gemini CLI not found on PATH — install from https://github.com/google-gemini/gemini-cli",
        };
      }

      const { authenticated, error } = await checkAuth(readFileFn);

      return {
        installed: true,
        authenticated,
        name: PROVIDER_NAME,
        ...(error ? { error } : {}),
      };
    },

    /**
     * Run an adversarial review via the Gemini CLI.
     *
     * @param {string} diffText
     * @param {{ path: string, content: string }[]} files
     * @param {string} prompt - Optional override; buildPrompt is called if empty.
     * @returns {Promise<import('../types.mjs').ReviewResult>}
     */
    async review(diffText, files, prompt) {
      const renderedPrompt = prompt || buildPrompt(diffText, files);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      let raw;
      try {
        raw = await runGemini(renderedPrompt, controller.signal, spawnFn);
      } finally {
        clearTimeout(timeoutId);
      }

      // Parse the outer JSON envelope: {session_id, response, stats}
      /** @type {Record<string, unknown>} */
      let envelope;
      try {
        envelope = JSON.parse(raw);
      } catch {
        throw new Error(
          `Gemini provider returned malformed JSON envelope. Raw output:\n${raw.slice(0, 500)}`
        );
      }

      if (typeof envelope.response !== "string") {
        throw new Error(
          `Gemini envelope missing "response" string field. Keys: ${Object.keys(envelope).join(", ")}`
        );
      }

      // Parse the inner response string: {findings: Finding[]}
      /** @type {unknown} */
      let inner;
      try {
        inner = JSON.parse(envelope.response);
      } catch {
        throw new Error(
          `Gemini "response" field contains invalid JSON:\n${String(envelope.response).slice(0, 500)}`
        );
      }

      const { valid, errors } = validateFindings(inner);
      if (!valid) {
        throw new Error(
          `Gemini findings failed schema validation:\n${errors.join("\n")}\n\nRaw response:\n${String(envelope.response).slice(0, 500)}`
        );
      }

      const parsed = /** @type {{ findings: import('../types.mjs').Finding[] }} */ (inner);
      const findings = normalizeFindings(parsed.findings);

      return { findings, raw };
    },
  };
}

/**
 * Default singleton provider instance using real system dependencies.
 *
 * @type {import('../types.mjs').Provider}
 */
export const geminiProvider = buildGeminiProvider();
