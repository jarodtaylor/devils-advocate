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
import { codexProvider } from "./lib/providers/codex.mjs";
import { geminiProvider } from "./lib/providers/gemini.mjs";

// ─── Argument parser ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} ReviewArgs
 * @property {string} [branch]    - Diff against this branch via merge-base.
 * @property {string} [worktree]  - Run git commands in this directory.
 * @property {string} [diff]      - Explicit diff range (e.g. "main..HEAD").
 * @property {string[]} [files]   - Limit diff to these file paths.
 * @property {boolean} verbose    - Include raw provider output in the report.
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
  const args = { verbose: false, files: [] };

  const knownFlags = new Set(["--branch", "--worktree", "--diff", "--files", "--verbose"]);

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];

    if (!token.startsWith("--")) {
      // Bare values without a preceding flag are not supported.
      throw new Error(
        `Unexpected argument "${token}". ` +
        `Use --branch, --worktree, --diff, --files, or --verbose.`
      );
    }

    if (!knownFlags.has(token)) {
      throw new Error(
        `Unknown flag "${token}". ` +
        `Supported flags: --branch, --worktree, --diff, --files, --verbose.`
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
  // Step 1: collect diff
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

  // Step 2: build the providers array (default: codex + gemini)
  const resolvedProviders = providers ?? buildProviders();

  // Step 3: run orchestrator (detect, parallel review, validate)
  const { results, failures } = await orchestrate(diffResult, resolvedProviders);

  // Step 4: match findings across providers
  const matchResult = matchFindings(results);

  // Step 5: collect raw outputs for --verbose mode
  /** @type {Map<string, string>} */
  const rawOutputs = new Map();
  for (const [name, result] of results) {
    rawOutputs.set(name, result.raw);
  }

  // Step 6: generate report
  const report = generateReport(matchResult, failures, {
    verbose: args.verbose,
    rawOutputs,
  });

  return report;
}

// ─── Provider builder ─────────────────────────────────────────────────────────

/**
 * Build the default provider list, ensuring each has a `name` property.
 * The gemini provider's `name` comes from detect() results only, so we
 * attach it here for the orchestrator.
 *
 * @returns {Array<import('./lib/types.mjs').Provider & { name: string }>}
 */
function buildProviders() {
  // codexProvider already has `name: "codex"` on the object.
  const codex = /** @type {import('./lib/types.mjs').Provider & { name: string }} */ (codexProvider);

  // geminiProvider exposes `name` in detect() results only — add it to the object.
  const gemini = /** @type {import('./lib/types.mjs').Provider & { name: string }} */ (
    Object.assign(geminiProvider, { name: "gemini" })
  );

  return [codex, gemini];
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
