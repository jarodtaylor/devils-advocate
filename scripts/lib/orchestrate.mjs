/**
 * @file Orchestrator — wires diff collection, provider detection, parallel
 * execution, output validation, and the minimum-provider gate (R5).
 *
 * Flow:
 *  a. Pre-flight R5 check: detect() each provider, filter to active ones.
 *     Fail immediately if fewer than 2 are available.
 *  b. Build prompt once from diffResult.
 *  c. Parallel execution via Promise.allSettled(), each with a timeout.
 *  d. Validate each result via validateProviderOutput (R10a).
 *  e. Post-validation R5 recheck: fail if fewer than 2 valid results.
 *  f. Return results and failures maps.
 *
 * @module orchestrate
 */

import { buildPrompt } from "./prompt.mjs";
import { validateProviderOutput } from "./validate.mjs";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;

// ─── Structured error ─────────────────────────────────────────────────────────

/**
 * Structured error thrown when the R5 minimum-provider gate fails.
 * Carries the per-provider status so callers can render actionable messages.
 */
export class R5Error extends Error {
  /**
   * @param {string} message - Human-readable summary.
   * @param {Record<string, {stage: string, reason: string}>} providerStatuses
   *   Map of provider name → status object with stage and reason.
   */
  constructor(message, providerStatuses) {
    super(message);
    this.name = "R5Error";
    /** @type {Record<string, {stage: string, reason: string}>} */
    this.providerStatuses = providerStatuses;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} OrchestrateOptions
 * @property {number} [timeout] - Per-provider timeout in ms (default 120 000).
 */

/**
 * @typedef {Object} ProviderResult
 * @property {import('./types.mjs').Finding[]} findings
 * @property {string} raw
 */

/**
 * @typedef {Object} ProviderFailure
 * @property {string} reason - Short reason category (e.g. "timed out", "malformed output").
 * @property {string} details - Longer detail string for display.
 */

/**
 * @typedef {Object} OrchestrateResult
 * @property {Map<string, ProviderResult>} results - Provider name → validated result.
 * @property {Map<string, ProviderFailure>} failures - Provider name → failure info.
 */

/**
 * Orchestrate a full adversarial review run.
 *
 * @param {import('../lib/diff.mjs').DiffResult} diffResult
 * @param {Array<import('./types.mjs').Provider & { name: string }>} providers
 * @param {OrchestrateOptions} [options={}]
 * @returns {Promise<OrchestrateResult>}
 */
export async function orchestrate(diffResult, providers, options = {}) {
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;

  // ── (a) Pre-flight R5 check ────────────────────────────────────────────────

  const detectResults = await Promise.all(
    providers.map((p) => p.detect().then((r) => ({ provider: p, detect: r })))
  );

  /** @type {Array<import('./types.mjs').Provider & { name: string }>} */
  const activeProviders = [];

  /** @type {Record<string, {stage: string, reason: string}>} */
  const preflightStatuses = {};

  for (const { provider, detect } of detectResults) {
    const name = provider.name;
    if (detect.installed && detect.authenticated) {
      activeProviders.push(provider);
      preflightStatuses[name] = { stage: "pre-flight", reason: "available" };
    } else if (!detect.installed) {
      preflightStatuses[name] = {
        stage: "pre-flight",
        reason: `not installed: ${detect.error ?? "not found on PATH"}`,
      };
    } else {
      preflightStatuses[name] = {
        stage: "pre-flight",
        reason: `not authenticated: ${detect.error ?? "authentication failed"}`,
      };
    }
  }

  if (activeProviders.length < 2) {
    const summary = Object.entries(preflightStatuses)
      .map(([name, s]) => `  ${name}: ${s.reason}`)
      .join("\n");
    throw new R5Error(
      `R5 pre-flight failed: fewer than 2 providers available (${activeProviders.length} of ${providers.length}).\n${summary}`,
      preflightStatuses
    );
  }

  // ── (b) Build prompt once ─────────────────────────────────────────────────

  const prompt = buildPrompt(diffResult.diffText, diffResult.files);

  // ── (c) Parallel execution with per-provider timeouts ─────────────────────

  /**
   * Wrap a provider review() call with an AbortController timeout.
   *
   * @param {import('./types.mjs').Provider & { name: string }} provider
   * @returns {Promise<string>} Raw string output from the provider.
   */
  function runWithTimeout(provider) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Provider "${provider.name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      provider
        .review(diffResult.diffText, diffResult.files, prompt)
        .then((result) => {
          clearTimeout(timer);
          // Providers return {findings, raw} — we want the raw string for R10a validation
          resolve(result.raw);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  const settledResults = await Promise.allSettled(
    activeProviders.map((p) => runWithTimeout(p))
  );

  // ── (d) Collect results, running R10a validation ──────────────────────────

  /** @type {Map<string, ProviderResult>} */
  const results = new Map();

  /** @type {Map<string, ProviderFailure>} */
  const failures = new Map();

  for (let i = 0; i < activeProviders.length; i++) {
    const provider = activeProviders[i];
    const settled = settledResults[i];
    const name = provider.name;

    if (settled.status === "fulfilled") {
      const raw = settled.value;
      const validation = validateProviderOutput(raw);

      if (validation.valid && validation.findings !== null) {
        results.set(name, { findings: validation.findings, raw });
      } else {
        failures.set(name, {
          reason: "malformed output",
          details: `R10a validation failed: ${validation.errors.join("; ")}`,
        });
      }
    } else {
      // rejected: timeout or runtime error
      const err = settled.reason;
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes("timed out");
      failures.set(name, {
        reason: isTimeout ? "timed out" : "runtime error",
        details: message,
      });
    }
  }

  // ── (e) Post-validation R5 recheck ────────────────────────────────────────

  if (results.size < 2) {
    /** @type {Record<string, {stage: string, reason: string}>} */
    const postStatuses = {};

    for (const provider of activeProviders) {
      const name = provider.name;
      if (results.has(name)) {
        postStatuses[name] = { stage: "post-validation", reason: "valid" };
      } else {
        const failure = failures.get(name);
        postStatuses[name] = {
          stage: "post-validation",
          reason: failure ? `${failure.reason}: ${failure.details}` : "unknown failure",
        };
      }
    }

    // Include pre-flight-failed providers in the status map for full context
    for (const [name, status] of Object.entries(preflightStatuses)) {
      if (!(name in postStatuses)) {
        postStatuses[name] = status;
      }
    }

    const summary = Object.entries(postStatuses)
      .map(([name, s]) => `  ${name} [${s.stage}]: ${s.reason}`)
      .join("\n");

    throw new R5Error(
      `R5 post-validation failed: fewer than 2 providers produced valid output (${results.size} of ${activeProviders.length}).\n${summary}`,
      postStatuses
    );
  }

  // ── (f) Return ─────────────────────────────────────────────────────────────

  return { results, failures };
}
