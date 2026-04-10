/**
 * @file Prompt template builder for adversarial code review.
 * Reads the prompt template from prompts/adversarial-review.md and fills
 * in the diff, file content, and optional context slots.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// ─── Root Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the plugin root directory.
 * Uses CLAUDE_PLUGIN_ROOT env var when available (set by Claude Code at runtime),
 * falling back to the directory two levels above this file at dev/test time.
 *
 * @returns {string} Absolute path to the plugin root.
 */
function getPluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  // import.meta.url → .../scripts/lib/prompt.mjs → up two levels → plugin root
  return fileURLToPath(new URL("../..", import.meta.url));
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Return the absolute path to the finding JSON schema file.
 * Used by Codex `--output-schema` flag.
 *
 * @returns {string}
 */
export function getSchemaPath() {
  return join(getPluginRoot(), "schemas", "finding.schema.json");
}

/**
 * Build the rendered adversarial review prompt by injecting diff, file
 * content, and optional context into the template.
 *
 * Truncation is NOT performed here — that is diff.mjs's responsibility.
 * This function is a pure string transformation.
 *
 * @param {string} diffText - Unified diff output.
 * @param {{ path: string, content: string }[]} files - Affected file contents.
 * @param {string} [context] - Optional free-form context string (e.g. PR description).
 * @returns {string} The fully rendered prompt ready to send to a provider.
 */
export function buildPrompt(diffText, files, context = "") {
  const templatePath = join(getPluginRoot(), "prompts", "adversarial-review.md");
  const template = readFileSync(templatePath, "utf8");

  const filesSection = files.length === 0
    ? ""
    : files
        .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
        .join("\n\n");

  return template
    .replace("{{DIFF}}", diffText)
    .replace("{{FILES}}", filesSection)
    .replace("{{CONTEXT}}", context);
}
