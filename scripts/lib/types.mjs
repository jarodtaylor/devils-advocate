/**
 * @file Provider interface types and finding schema definitions.
 * These types form the contract between the orchestrator and provider adapters.
 */

// ─── JSDoc Typedefs ───────────────────────────────────────────────────────────

/**
 * Result of a provider capability detection check.
 *
 * @typedef {Object} DetectResult
 * @property {boolean} installed - Whether the provider CLI is installed on PATH.
 * @property {boolean} authenticated - Whether valid credentials exist.
 * @property {string} name - Provider name (e.g. "codex", "gemini").
 * @property {string} [error] - Human-readable error detail when installed/authenticated is false.
 */

/**
 * A single code review finding produced by a provider.
 * Line numbers are file-absolute (not diff-relative).
 *
 * @typedef {Object} Finding
 * @property {'HIGH'|'MEDIUM'|'LOW'} severity - Severity classification.
 * @property {string} title - Short one-line title for the finding.
 * @property {string} description - What can go wrong and why the code is vulnerable.
 * @property {string} rationale - Concrete evidence from the diff/code supporting this finding.
 * @property {string} file - File path relative to repo root.
 * @property {number} lineStart - First line of the vulnerable region (file-absolute, 1-indexed).
 * @property {number} lineEnd - Last line of the vulnerable region (file-absolute, 1-indexed).
 * @property {number} [confidence] - Model confidence in this finding, 0–1. Defaults to 0.5 when absent.
 */

/**
 * Structured output returned by a provider after reviewing a diff.
 *
 * @typedef {Object} ReviewResult
 * @property {Finding[]} findings - Validated, normalized findings from the provider.
 * @property {string} raw - Unmodified raw output from the provider CLI (for --verbose).
 */

/**
 * Provider interface. Each provider adapter must export an object conforming
 * to this shape.
 *
 * @typedef {Object} Provider
 * @property {() => Promise<DetectResult>} detect - Check installation and auth state.
 * @property {(diffText: string, files: {path: string, content: string}[], prompt: string) => Promise<ReviewResult>} review - Run adversarial review and return structured findings.
 */

// ─── JSON Schema ─────────────────────────────────────────────────────────────

/**
 * JSON Schema for the full response structure: `{findings: Finding[]}`.
 * Used by Codex `--output-schema` and by the post-receipt validator (R10a).
 *
 * @type {Record<string, unknown>}
 */
export const FINDING_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ProviderReviewResponse",
  type: "object",
  required: ["findings"],
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: [
          "severity",
          "title",
          "description",
          "rationale",
          "file",
          "lineStart",
          "lineEnd",
        ],
        additionalProperties: false,
        properties: {
          severity: {
            type: "string",
            enum: ["HIGH", "MEDIUM", "LOW"],
          },
          title: {
            type: "string",
            minLength: 1,
          },
          description: {
            type: "string",
            minLength: 1,
          },
          rationale: {
            type: "string",
            minLength: 1,
          },
          file: {
            type: "string",
            minLength: 1,
          },
          lineStart: {
            type: "integer",
            minimum: 1,
          },
          lineEnd: {
            type: "integer",
            minimum: 1,
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
        },
      },
    },
  },
};

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a parsed object against the expected findings structure.
 * Uses a hand-rolled check to avoid external dependencies.
 *
 * @param {unknown} parsed - The value to validate (typically from JSON.parse).
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateFindings(parsed) {
  /** @type {string[]} */
  const errors = [];

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push("root must be an object");
    return { valid: false, errors };
  }

  const root = /** @type {Record<string, unknown>} */ (parsed);

  // Check for unexpected top-level properties (additionalProperties: false)
  const allowedTopLevel = new Set(["findings"]);
  for (const key of Object.keys(root)) {
    if (!allowedTopLevel.has(key)) {
      errors.push(`unexpected top-level property: "${key}"`);
    }
  }

  if (!("findings" in root)) {
    errors.push('missing required property "findings"');
    return { valid: false, errors };
  }

  if (!Array.isArray(root.findings)) {
    errors.push('"findings" must be an array');
    return { valid: false, errors };
  }

  const findings = /** @type {unknown[]} */ (root.findings);

  for (let i = 0; i < findings.length; i++) {
    const prefix = `findings[${i}]`;
    const finding = findings[i];

    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }

    const f = /** @type {Record<string, unknown>} */ (finding);

    // Required fields
    const required = /** @type {const} */ ([
      "severity",
      "title",
      "description",
      "rationale",
      "file",
      "lineStart",
      "lineEnd",
    ]);
    for (const field of required) {
      if (!(field in f)) {
        errors.push(`${prefix}: missing required field "${field}"`);
      }
    }

    // Reject extra properties
    const allowedFields = new Set([
      "severity",
      "title",
      "description",
      "rationale",
      "file",
      "lineStart",
      "lineEnd",
      "confidence",
    ]);
    for (const key of Object.keys(f)) {
      if (!allowedFields.has(key)) {
        errors.push(`${prefix}: unexpected property "${key}"`);
      }
    }

    // Type + value checks (only when field is present)
    if ("severity" in f) {
      if (f.severity !== "HIGH" && f.severity !== "MEDIUM" && f.severity !== "LOW") {
        errors.push(
          `${prefix}.severity must be "HIGH", "MEDIUM", or "LOW"; got ${JSON.stringify(f.severity)}`
        );
      }
    }

    for (const strField of /** @type {const} */ (["title", "description", "rationale", "file"])) {
      if (strField in f) {
        if (typeof f[strField] !== "string" || /** @type {string} */ (f[strField]).length === 0) {
          errors.push(`${prefix}.${strField} must be a non-empty string`);
        }
      }
    }

    for (const intField of /** @type {const} */ (["lineStart", "lineEnd"])) {
      if (intField in f) {
        const val = f[intField];
        if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
          errors.push(`${prefix}.${intField} must be an integer >= 1`);
        }
      }
    }

    if ("confidence" in f) {
      const val = f.confidence;
      if (typeof val !== "number" || val < 0 || val > 1) {
        errors.push(`${prefix}.confidence must be a number between 0 and 1`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Normalize findings from a provider response: fill in optional defaults.
 * Call this after validateFindings passes.
 *
 * @param {Finding[]} findings
 * @returns {Finding[]}
 */
export function normalizeFindings(findings) {
  return findings.map((f) => ({
    ...f,
    confidence: f.confidence ?? 0.5,
  }));
}
