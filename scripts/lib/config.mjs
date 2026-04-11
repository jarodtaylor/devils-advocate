/**
 * @file Config module — loads, merges, and validates the four-layer config.
 *
 * Priority order (highest to lowest):
 *   CLI overrides → project config (.da.json) → user config (~/.devils-advocate/config.json) → DEFAULTS
 *
 * @module config
 */

import { readFile as nodeReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Defaults ─────────────────────────────────────────────────────────────────

/**
 * Built-in default configuration. Preserves V1 behavior: all providers enabled,
 * Claude uses sonnet, timeout is 120 seconds.
 *
 * @type {Readonly<ResolvedConfig>}
 */
export const DEFAULTS = Object.freeze({
  providers: Object.freeze({
    codex: Object.freeze({ enabled: true }),
    gemini: Object.freeze({ enabled: true }),
    claude: Object.freeze({ enabled: true, model: "sonnet" }),
  }),
  timeout: 120,
});

// ─── Known provider set ───────────────────────────────────────────────────────

const KNOWN_PROVIDERS = new Set(["codex", "gemini", "claude"]);

// ─── Typed definitions (JSDoc) ────────────────────────────────────────────────

/**
 * @typedef {Object} ProviderConfig
 * @property {boolean} [enabled]
 * @property {string} [model]
 */

/**
 * @typedef {Object} ResolvedConfig
 * @property {{ codex: ProviderConfig, gemini: ProviderConfig, claude: ProviderConfig }} providers
 * @property {number} timeout - Timeout in seconds (human-readable).
 */

// ─── ConfigError ──────────────────────────────────────────────────────────────

/**
 * Structured error thrown when config fails validation.
 * Carries the file path (or layer name) and the specific field that failed.
 * Mirrors the R5Error pattern from orchestrate.mjs.
 */
export class ConfigError extends Error {
  /**
   * @param {string} message - Human-readable description of the problem.
   * @param {string} [filePath] - Path to the config file, or a layer name like "CLI flag".
   * @param {string} [field] - The config field that failed (e.g. "timeout", "providers.unknown").
   */
  constructor(message, filePath, field) {
    super(message);
    this.name = "ConfigError";
    /** @type {string | undefined} */
    this.filePath = filePath;
    /** @type {string | undefined} */
    this.field = field;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Determine whether a value is a plain object (not an array, Date, null, etc.).
 * Uses prototype check per the plan spec.
 *
 * @param {unknown} val
 * @returns {val is Record<string, unknown>}
 */
function isPlainObject(val) {
  if (val === null || typeof val !== "object") return false;
  return Object.getPrototypeOf(val) === Object.prototype;
}

/**
 * Keys that are forbidden from appearing in config objects because merging them
 * could trigger prototype pollution (the `__proto__` setter, or walking up the
 * prototype chain via `constructor.prototype`).
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Deep merge `overlay` onto `base`. Plain objects are merged key-by-key;
 * everything else (arrays, primitives) is leaf-replaced by the overlay value.
 *
 * Prototype pollution defense: forbidden keys (`__proto__`, `constructor`,
 * `prototype`) are silently skipped. `readConfigFile` also checks for these
 * keys at parse time and throws a ConfigError with attribution — this loop is
 * the defense-in-depth backstop.
 *
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} overlay
 * @returns {Record<string, unknown>}
 */
function deepMerge(base, overlay) {
  const result = Object.assign({}, base);
  for (const [key, overlayVal] of Object.entries(overlay)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const baseVal = result[key];
    if (isPlainObject(baseVal) && isPlainObject(overlayVal)) {
      result[key] = deepMerge(baseVal, overlayVal);
    } else {
      result[key] = overlayVal;
    }
  }
  return result;
}

/**
 * Recursively check an object for forbidden keys (prototype pollution vectors).
 * Returns the first forbidden key path found, or null if clean.
 *
 * @param {unknown} obj
 * @param {string} [path]
 * @returns {string | null}
 */
function findForbiddenKey(obj, path = "") {
  if (!isPlainObject(obj)) return null;
  // Object.entries skips inherited properties, so we use Object.getOwnPropertyNames
  // to catch __proto__ set as an own property via JSON.parse (JSON.parse creates
  // __proto__ as a regular own property, not via the setter).
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return path ? `${path}.${key}` : key;
    }
    const nested = findForbiddenKey(
      /** @type {Record<string, unknown>} */ (obj)[key],
      path ? `${path}.${key}` : key
    );
    if (nested) return nested;
  }
  return null;
}

/**
 * Deep-freeze an object and all its plain-object children.
 *
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepFreeze(obj) {
  if (!isPlainObject(/** @type {unknown} */ (obj))) return obj;
  Object.freeze(obj);
  for (const val of Object.values(/** @type {Record<string, unknown>} */ (obj))) {
    deepFreeze(val);
  }
  return obj;
}

/**
 * Read and parse a JSON config file. Returns the parsed object, or null if the
 * file does not exist (ENOENT). Throws ConfigError for any other error (including
 * malformed JSON).
 *
 * @param {string} filePath - Absolute path to the config file.
 * @param {typeof nodeReadFile} readFileFn - Injectable for testing.
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readConfigFile(filePath, readFileFn) {
  let raw;
  try {
    raw = await readFileFn(filePath, "utf8");
  } catch (/** @type {unknown} */ err) {
    const nodeErr = /** @type {NodeJS.ErrnoException} */ (err);
    if (nodeErr.code === "ENOENT") {
      return null; // file absent — silent skip
    }
    // Other I/O errors (e.g. EACCES) surface as ConfigError
    throw new ConfigError(
      `Failed to read config file: ${nodeErr.message}`,
      filePath,
      undefined
    );
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new ConfigError(
        `Config file must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        filePath,
        undefined
      );
    }
    // Prototype pollution defense: reject __proto__, constructor, prototype
    // at any nesting depth before the object enters the merge pipeline.
    const forbidden = findForbiddenKey(parsed);
    if (forbidden !== null) {
      throw new ConfigError(
        `Config file contains forbidden key "${forbidden}" (prototype pollution vector)`,
        filePath,
        forbidden
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    const syntaxErr = /** @type {SyntaxError} */ (err);
    throw new ConfigError(
      `Config file contains invalid JSON: ${syntaxErr.message}`,
      filePath,
      undefined
    );
  }
}

/**
 * Validate the resolved config object. Throws ConfigError on hard failures;
 * writes a warning to stderr for soft failures (e.g. model on non-claude provider).
 *
 * @param {Record<string, unknown>} config - The merged (but not yet frozen) config.
 * @param {string} source - Human-readable source label for error messages.
 */
function validateConfig(config, source) {
  // Validate timeout
  if ("timeout" in config) {
    const t = config.timeout;
    if (typeof t !== "number" || !Number.isFinite(t)) {
      throw new ConfigError(
        `Invalid timeout in ${source}: must be a number, got ${JSON.stringify(t)}`,
        source,
        "timeout"
      );
    }
    if (t <= 0) {
      throw new ConfigError(
        `Invalid timeout in ${source}: must be a positive number greater than zero, got ${t}`,
        source,
        "timeout"
      );
    }
  }

  // Validate providers object
  if ("providers" in config) {
    const providers = config.providers;
    if (!isPlainObject(providers)) {
      throw new ConfigError(
        `Invalid providers in ${source}: must be an object`,
        source,
        "providers"
      );
    }

    for (const [name, providerConfig] of Object.entries(providers)) {
      if (!KNOWN_PROVIDERS.has(name)) {
        throw new ConfigError(
          `Unknown provider "${name}" in ${source}. Known providers: ${[...KNOWN_PROVIDERS].join(", ")}`,
          source,
          `providers.${name}`
        );
      }

      // Provider config must be a plain object. Rejects null, false, strings, arrays, etc.
      if (!isPlainObject(providerConfig)) {
        throw new ConfigError(
          `Invalid providers.${name} in ${source}: must be an object, got ${providerConfig === null ? "null" : Array.isArray(providerConfig) ? "array" : typeof providerConfig}`,
          source,
          `providers.${name}`
        );
      }

      // Validate enabled is boolean if present
      if ("enabled" in providerConfig && typeof providerConfig.enabled !== "boolean") {
        throw new ConfigError(
          `Invalid providers.${name}.enabled in ${source}: must be a boolean, got ${typeof providerConfig.enabled}`,
          source,
          `providers.${name}.enabled`
        );
      }

      // Validate model is string if present
      if ("model" in providerConfig && typeof providerConfig.model !== "string") {
        throw new ConfigError(
          `Invalid providers.${name}.model in ${source}: must be a string, got ${typeof providerConfig.model}`,
          source,
          `providers.${name}.model`
        );
      }

      // Warn (not error) if model is set on a non-claude provider (R8)
      if (name !== "claude" && "model" in providerConfig) {
        process.stderr.write(
          `Warning: "model" field on provider "${name}" in ${source} is ignored. ` +
            `Configurable model selection is only supported for the "claude" provider in v0.1.0 — ` +
            `Codex and Gemini use their CLI's default model.\n`
        );
      }
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load, merge, validate, and freeze the resolved configuration.
 *
 * Merge order (lowest → highest priority):
 *   DEFAULTS → user config → project config → cliOverrides
 *
 * @param {Record<string, unknown>} [cliOverrides={}] - Values from CLI flags.
 * @param {{ readFileFn?: typeof nodeReadFile }} [deps={}] - Injectable deps for testing.
 * @returns {Promise<Readonly<ResolvedConfig>>}
 */
export async function loadConfig(cliOverrides = {}, deps = {}) {
  const readFileFn = deps.readFileFn ?? nodeReadFile;

  const userConfigPath = join(homedir(), ".devils-advocate", "config.json");
  const projectConfigPath = join(process.cwd(), ".da.json");

  // Read file layers (ENOENT → null → skip)
  const [userConfig, projectConfig] = await Promise.all([
    readConfigFile(userConfigPath, readFileFn),
    readConfigFile(projectConfigPath, readFileFn),
  ]);

  // Validate each layer before merging so error messages name the right source
  if (userConfig !== null) {
    validateConfig(userConfig, userConfigPath);
  }
  if (projectConfig !== null) {
    validateConfig(projectConfig, projectConfigPath);
  }
  if (Object.keys(cliOverrides).length > 0) {
    validateConfig(cliOverrides, "CLI flags");
  }

  // Merge: DEFAULTS → user → project → CLI
  let merged = /** @type {Record<string, unknown>} */ (
    JSON.parse(JSON.stringify(DEFAULTS))
  );
  if (userConfig !== null) {
    merged = deepMerge(merged, userConfig);
  }
  if (projectConfig !== null) {
    merged = deepMerge(merged, projectConfig);
  }
  if (Object.keys(cliOverrides).length > 0) {
    merged = deepMerge(merged, cliOverrides);
  }

  return /** @type {Readonly<ResolvedConfig>} */ (deepFreeze(merged));
}
