/**
 * @file Output validator — R10a trust boundary.
 *
 * Parses raw provider output as JSON and validates it against the finding
 * schema. This is the single gate that all provider output must pass before
 * it is accepted by the orchestrator.
 *
 * @module validate
 */

import { validateFindings, normalizeFindings } from "./types.mjs";

/**
 * @typedef {Object} ValidateResult
 * @property {boolean} valid - Whether the output passed validation.
 * @property {import('./types.mjs').Finding[]|null} findings - Normalized findings, or null if invalid.
 * @property {string[]} errors - Validation error messages (empty when valid).
 */

/**
 * Validate and normalize raw provider output.
 *
 * Steps:
 *  1. JSON.parse the raw string.
 *  2. Run validateFindings on the parsed value.
 *  3. If valid, normalizeFindings to apply confidence defaults.
 *
 * @param {string} raw - The raw string output from a provider CLI.
 * @returns {ValidateResult}
 */
export function validateProviderOutput(raw) {
  // Step 1: JSON parse
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (/** @type {unknown} */ err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      findings: null,
      errors: [`JSON parse failed: ${message}`],
    };
  }

  // Step 2: Schema validation
  const { valid, errors } = validateFindings(parsed);
  if (!valid) {
    return { valid: false, findings: null, errors };
  }

  // Step 3: Normalize (apply confidence defaults, etc.)
  const inner = /** @type {{ findings: import('./types.mjs').Finding[] }} */ (parsed);
  const findings = normalizeFindings(inner.findings);

  return { valid: true, findings, errors: [] };
}
