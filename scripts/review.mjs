#!/usr/bin/env node
/**
 * @file Devil's Advocate companion script.
 * Invoked by the /da:review skill. Orchestrates the full adversarial review
 * pipeline: diff collection → provider detection → parallel review →
 * finding matching → report generation.
 *
 * Exit codes:
 *   0 — report generated successfully
 *   1 — R5 provider error (not enough providers available/valid)
 *   2 — bad arguments (unknown flag, invalid value)
 */

import { collectDiff } from "./lib/diff.mjs";
import { orchestrate, R5Error } from "./lib/orchestrate.mjs";
import { matchFindings } from "./lib/matcher.mjs";
import { generateReport } from "./lib/report.mjs";
import { createCodexProvider } from "./lib/providers/codex.mjs";
import { buildGeminiProvider } from "./lib/providers/gemini.mjs";
import { buildClaudeProvider } from "./lib/providers/claude.mjs";
import { loadConfig, ConfigError } from "./lib/config.mjs";

// ─── Argument parser ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} ReviewArgs
 * @property {string} [branch]   - Diff against this branch via merge-base.
 * @property {string} [worktree] - Run git commands in this directory.
 * @property {string} [diff]     - Explicit diff range (e.g. "main..HEAD").
 * @property {string[]} [files]  - Limit diff to these file paths.
 * @property {boolean} verbose   - Include raw provider output in the report.
 * @property {number} [timeout]  - Per-provider timeout in seconds.
 * @property {string[]} disable  - Provider names to skip. Always an array (possibly empty).
 */

/**
 * Parse CLI arguments from an argv array (typically process.argv.slice(2)).
 *
 * Supported flags:
 *   --branch <name>
 *   --worktree <path>
 *   --diff <range>
 *   --files <path> [<path> ...]   (collects until the next flag or end)
 *   --verbose
 *
 * Throws a descriptive Error for unknown flags.
 *
 * @param {string[]} argv
 * @returns {ReviewArgs}
 */
export function parseArgs(argv) {
  /** @type {ReviewArgs} */
  const args = { verbose: false, files: [], disable: [] };

  const knownFlags = new Set(["--branch", "--worktree", "--diff", "--files", "--verbose", "--timeout", "--disable"]);

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];

    if (!token.startsWith("--")) {
      // Bare values without a preceding flag are not supported.
      throw new Error(
        `Unexpected argument "${token}". ` +
        `Use --branch, --worktree, --diff, --files, --verbose, --timeout, or --disable.`
      );
    }

    if (!knownFlags.has(token)) {
      throw new Error(
        `Unknown flag "${token}". ` +
        `Supported flags: --branch, --worktree, --diff, --files, --verbose, --timeout, --disable.`
      );
    }

    switch (token) {
      case "--verbose":
        args.verbose = true;
        i++;
        break;

      case "--branch":
      case "--worktree":
      case "--diff": {
        const key = /** @type {"branch"|"worktree"|"diff"} */ (token.slice(2));
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`Flag "${token}" requires a value.`);
        }
        args[key] = value;
        i += 2;
        break;
      }

      case "--files": {
        // Collect all following non-flag tokens as file paths.
        const paths = [];
        i++;
        while (i < argv.length && !argv[i].startsWith("--")) {
          paths.push(argv[i]);
          i++;
        }
        if (paths.length === 0) {
          throw new Error(`Flag "--files" requires at least one file path.`);
        }
        args.files = paths;
        break;
      }

      case "--timeout": {
        const raw = argv[i + 1];
        if (raw === undefined || raw.startsWith("--")) {
          throw new Error(`Flag "--timeout" requires a value.`);
        }
        // Use Number() not parseFloat() — parseFloat("60abc") silently returns 60,
        // while Number("60abc") correctly returns NaN.
        const value = Number(raw);
        if (isNaN(value)) {
          throw new Error(`Flag "--timeout" requires a numeric value, got "${raw}".`);
        }
        if (value <= 0) {
          throw new Error(`Flag "--timeout" requires a positive number, got "${raw}".`);
        }
        args.timeout = value;
        i += 2;
        break;
      }

      case "--disable": {
        // Collect all following non-flag tokens as provider names, accumulating
        // across repeated --disable invocations (unlike --files which replaces).
        const names = [];
        i++;
        while (i < argv.length && !argv[i].startsWith("--")) {
          names.push(argv[i]);
          i++;
        }
        if (names.length === 0) {
          throw new Error(`Flag "--disable" requires at least one provider name.`);
        }
        args.disable = args.disable.concat(names);
        break;
      }

      default:
        // Unreachable given the knownFlags check, but keeps TypeScript/checker happy.
        throw new Error(`Unexpected flag "${token}".`);
    }
  }

  return args;
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * Run the full adversarial review pipeline.
 *
 * Exported for unit testing (avoids needing to test the CLI entry point directly).
 *
 * @param {ReviewArgs} args
 * @param {Array<import('./lib/types.mjs').Provider & { name: string }>} [providers]
 *   Override the provider list (used in tests to inject mocks).
 * @returns {Promise<string>} The generated Markdown report.
 */
export async function runReview(args, providers) {
  // Step 1: load config (merge CLI overrides with file-based config)
  const cliOverrides = buildCliOverrides(args);
  const config = await loadConfig(cliOverrides);

  // Step 2: collect diff
  const diffResult = await collectDiff({
    branch: args.branch,
    worktree: args.worktree,
    diff: args.diff,
    files: args.files,
  });

  if (!diffResult.diffText) {
    return [
      "## Devil's Advocate Review",
      "",
      `Nothing to review — no changes detected (target: ${diffResult.target}).`,
      "",
      "Make some changes or use --branch, --worktree, --diff, or --files to specify a target.",
    ].join("\n");
  }

  // Step 3: build the providers array (filtered by config, or use test override)
  const resolvedProviders = providers ?? buildProviders(config);

  // Step 4: run orchestrator (detect, parallel review, validate)
  const { results, failures } = await orchestrate(diffResult, resolvedProviders, {
    timeout: config.timeout * 1000,
  });

  // Step 5: match findings across providers
  const matchResult = matchFindings(results);

  // Step 6: collect raw outputs for --verbose mode
  /** @type {Map<string, string>} */
  const rawOutputs = new Map();
  for (const [name, result] of results) {
    rawOutputs.set(name, result.raw);
  }

  // Step 7: generate report
  const report = generateReport(matchResult, failures, {
    verbose: args.verbose,
    rawOutputs,
    config,
  });

  return report;
}

// ─── CLI overrides builder ───────────────────────────────────────────────────

/**
 * Convert parsed CLI args into the config overlay shape expected by loadConfig.
 *
 * @param {ReviewArgs} args
 * @returns {Record<string, unknown>}
 */
function buildCliOverrides(args) {
  /** @type {Record<string, unknown>} */
  const overrides = {};

  if (args.timeout !== undefined) {
    overrides.timeout = args.timeout;
  }

  if (args.disable && args.disable.length > 0) {
    /** @type {Record<string, { enabled: boolean }>} */
    const providers = {};
    for (const name of args.disable) {
      providers[name] = { enabled: false };
    }
    overrides.providers = providers;
  }

  return overrides;
}

// ─── Provider builder ─────────────────────────────────────────────────────────

/**
 * Build the provider list from resolved config. Only constructs providers
 * where `enabled !== false`. Checks that at least 2 providers are enabled
 * before calling detect (fail-fast with config-aware message).
 *
 * @param {import('./lib/config.mjs').ResolvedConfig} config
 * @returns {Array<import('./lib/types.mjs').Provider & { name: string }>}
 */
export function buildProviders(config) {
  const timeoutMs = config.timeout * 1000;

  /** @type {Array<import('./lib/types.mjs').Provider & { name: string }>} */
  const providers = [];

  if (config.providers.codex.enabled !== false) {
    const codex = /** @type {import('./lib/types.mjs').Provider & { name: string }} */ (
      createCodexProvider(undefined, { timeoutMs })
    );
    providers.push(codex);
  }

  if (config.providers.gemini.enabled !== false) {
    const gemini = /** @type {import('./lib/types.mjs').Provider & { name: string }} */ (
      Object.assign(buildGeminiProvider({ timeoutMs }), { name: "gemini" })
    );
    providers.push(gemini);
  }

  if (config.providers.claude.enabled !== false) {
    const claude = /** @type {import('./lib/types.mjs').Provider & { name: string }} */ (
      buildClaudeProvider({ model: config.providers.claude.model, timeoutMs })
    );
    providers.push(claude);
  }

  if (providers.length < 2) {
    const enabled = providers.map((p) => p.name);
    throw new R5Error(
      `At least 2 providers must be enabled. Currently enabled: ${enabled.join(", ") || "none"}. ` +
        `Check your config or --disable flags.`,
      Object.fromEntries(
        enabled.map((n) => [n, { stage: "config", reason: "enabled" }])
      )
    );
  }

  return providers;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

/**
 * Main entry point when the script is invoked directly (not imported).
 */
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (/** @type {unknown} */ err) {
    process.stderr.write(`Error: ${/** @type {Error} */ (err).message}\n`);
    process.exit(2);
  }

  try {
    const report = await runReview(args);
    process.stdout.write(report + "\n");
    process.exit(0);
  } catch (/** @type {unknown} */ err) {
    if (err instanceof ConfigError) {
      const parts = [`Error: ${err.message}`];
      if (err.filePath) parts.push(`  Config source: ${err.filePath}`);
      if (err.field) parts.push(`  Field: ${err.field}`);
      process.stderr.write(parts.join("\n") + "\n");
      process.exit(2);
    }

    if (err instanceof R5Error) {
      // Structured provider error — surface per-provider statuses.
      const lines = [
        "Error: Not enough providers are available to run an adversarial review.",
        "",
        err.message,
        "",
        "Provider status:",
      ];
      for (const [name, status] of Object.entries(err.providerStatuses)) {
        lines.push(`  ${name} [${status.stage}]: ${status.reason}`);
      }
      lines.push("");
      lines.push("Make sure at least two providers are installed and authenticated:");
      lines.push("  Codex: run `codex login`");
      lines.push("  Gemini: run `gemini` (follows OAuth flow on first run)");
      process.stderr.write(lines.join("\n") + "\n");
      process.exit(1);
    }

    // Generic error — no stack trace exposed.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

// Only run main() when this file is the entry point (not when imported).
const isMain = process.argv[1] &&
  (process.argv[1].endsWith("review.mjs") ||
   process.argv[1].includes("/review.mjs"));

if (isMain) {
  main();
}
