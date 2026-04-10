---
title: "feat: Add layered configuration system"
type: feat
status: completed
date: 2026-04-10
origin: docs/brainstorms/config-system-requirements.md
---

# feat: Add layered configuration system

## Overview

Add a layered config system to Devil's Advocate so users can customize provider selection, model preferences, and timeouts without modifying code. Config resolves from four layers: CLI flags > project `.da.json` > user `~/.devils-advocate/config.json` > built-in defaults.

## Problem Frame

V1 has every value hardcoded — all providers always run, Claude always uses sonnet, timeout is always 120s. Users with missing providers hit failures, users wanting different models can't configure them, and teams can't share review settings. The config system directly affects adoption of this open-source tool. (see origin: docs/brainstorms/config-system-requirements.md)

## Requirements Trace

**Config Layers**
- R1. Layered config priority: CLI flags > project > user > defaults
- R2. User config at `~/.devils-advocate/config.json`
- R3. Project config at `.da.json` (repo root)
- R4. CLI flags: `--timeout <seconds>`, `--disable <provider>`
- R5. Built-in defaults preserve current behavior

**Config Shape**
- R6. Nested provider objects config shape
- R7. All fields optional; empty `{}` valid
- R8. Model field for Claude only in V1.1
- R9. `enabled` field controls provider invocation

**Config Loading**
- R10. Timeout in seconds (global), converted internally to ms
- R11. Deep merge with leaf-key precedence
- R12. CLI flags highest priority
- R13. Config loaded once per invocation, no hot-reload

**Error & Output**
- R14. Invalid config produces clear error with file path + problem
- R15. Resolved config shown in output header

## Scope Boundaries

- Out: `/da:setup` wizard (V1.2), Codex/Gemini model selection (V1.2), prompt customization, per-provider timeout
- In: Provider enable/disable, Claude model, global timeout, config files, CLI overrides, config header, README example

## Context & Research

### Relevant Code and Patterns

- `scripts/review.mjs` — `parseArgs()` (lines 48-114): manual argv walk with `knownFlags` Set, no library. `--files` collects multi-value; `--branch` collects single value. Pattern to follow for `--disable` and `--timeout`.
- `scripts/review.mjs` — `buildProviders()` (lines 181-194): constructs all three providers, passes to orchestrator. Insertion point for config filtering.
- `scripts/lib/orchestrate.mjs` — already accepts `options.timeout` with `DEFAULT_TIMEOUT_MS = 120_000` fallback. Zero changes needed here — just wire config through.
- `scripts/lib/providers/claude.mjs` — `buildClaudeProvider({ spawnFn })`: model `"sonnet"` hardcoded in `runClaude()` args array (line 68). Factory needs `model` param.
- `scripts/lib/providers/gemini.mjs` — auth detection reads `~/.gemini/oauth_creds.json` via injectable `readFileFn`. Established file I/O pattern for config module.
- `scripts/lib/orchestrate.mjs` — `R5Error` class with structured error info. Pattern for `ConfigError`.
- `scripts/review.mjs` — main error handler (lines 215-238): catches typed errors, writes to stderr, exits with code. Config errors follow same pattern.

### Institutional Learnings

- Zero external runtime dependencies — deep merge must be hand-rolled (~15 LOC recursive function)
- Provider DI factories accept `deps` object for testability — `config.mjs` should export `loadConfig(cliOverrides, { readFileFn })` for test injection
- `ENOENT` on config file is silent (no user config = use defaults); `SyntaxError` on JSON parse is loud (ConfigError with path)
- Timeout conversion (`× 1000`) belongs at the call site in review.mjs, not in config.mjs — config stores human-readable seconds per R10

## Key Technical Decisions

- **Repo root for `.da.json`:** Use `process.cwd()`, not `git rev-parse --show-toplevel`. Claude Code plugins always execute from the repo root. Avoids spawning git and matches the simplicity principle.
- **Deep merge is internal:** ~15 lines of recursive JS. Only merges plain objects; arrays and primitives are leaf-replaced. No need for lodash/deepmerge.
- **ConfigError class (not generic Error):** Structured error with `filePath` and `field` properties, caught specifically in `main()`. Matches the `R5Error` pattern. Exit code 2 (bad arguments).
- **Config object is immutable after load:** `Object.freeze()` the resolved config. Prevents accidental mutation during the pipeline.
- **`--disable` is multi-value, not `--disable=codex,gemini`:** Collect pattern matches `--files`. Allows `--disable codex --disable gemini` or `--disable codex gemini`.
- **buildProviders becomes config-aware:** Instead of always constructing all three providers, it accepts resolved config and only constructs+detects enabled providers. Disabled providers never call `detect()`.
- **Don't break the singleton exports:** Keep `codexProvider`, `geminiProvider`, `claudeProvider` singletons for backward compat and direct test use. `buildProviders(config)` constructs fresh instances from factories when config overrides are needed (e.g., Claude model).

## Open Questions

### Resolved During Planning

- **Deep merge implementation (R11):** Simple recursive function in config.mjs. Plain objects merge key-by-key; everything else (arrays, strings, numbers, booleans) is leaf-replaced by higher-priority layer.
- **CLI flag pattern (R4):** `--timeout` uses single-value pattern (like `--branch`). `--disable` uses multi-value collect pattern (like `--files`). Both added to `knownFlags` Set.
- **Where does loadConfig fit in the pipeline?** Called in `runReview()` after `parseArgs()` but before `buildProviders()`. Receives CLI overrides extracted from parsed args.

### Deferred to Implementation

- Exact `ConfigError` message templates — will be refined during test writing
- Whether `Object.freeze` should be shallow or deep — likely deep-freeze the small config object, but verify no downstream code needs mutation

## Implementation Units

- [ ] **Unit 1: Config module core — `scripts/lib/config.mjs`**

**Goal:** Create the config loading, merging, and validation module that resolves the four-layer config into a single object.

**Requirements:** R1, R2, R3, R5, R6, R7, R10, R11, R13, R14

**Dependencies:** None

**Files:**
- Create: `scripts/lib/config.mjs`
- Test: `tests/config.test.mjs`

**Approach:**
- Export `loadConfig(cliOverrides = {}, { readFileFn } = {})` → async, returns frozen resolved config
- Export `DEFAULTS` constant matching R5/R6 shape
- Internal `deepMerge(base, overlay)` — recursive, plain-object check via `Object.getPrototypeOf(val) === Object.prototype`
- Read user config: `join(homedir(), '.devils-advocate', 'config.json')` — ENOENT → skip silently
- Read project config: `join(process.cwd(), '.da.json')` — ENOENT → skip silently
- Validate after merge: timeout must be positive number, provider names must be in known set (`codex`, `gemini`, `claude`). Unknown provider names → ConfigError. Model on non-claude provider → warn to stderr and continue (per R8: "ignored with a warning"), do not throw.
- Throw `ConfigError` with file path + field on validation failure. Include source layer in error message (e.g., "CLI flag --disable" vs config file path) so users know where the invalid value came from.
- Export `ConfigError` class (extends Error, adds `filePath`, `field` properties)

**Patterns to follow:**
- `scripts/lib/providers/gemini.mjs` — injectable `readFileFn` for file I/O testing
- `scripts/lib/orchestrate.mjs` — `R5Error` class structure

**Test scenarios:**
- Happy path: empty overrides → returns DEFAULTS exactly
- Happy path: user config only → merges on top of defaults
- Happy path: project config overlays user config (project wins on conflict)
- Happy path: CLI overrides beat all file configs
- Happy path: partial config (`{"timeout": 60}`) merges without erasing provider defaults
- Edge case: empty `{}` config file → valid, returns defaults
- Edge case: user config sets `providers.codex.enabled = false`, project config doesn't mention codex → codex stays disabled
- Edge case: deep merge preserves sibling keys — setting `providers.claude.model` doesn't erase `providers.codex.enabled`
- Error path: malformed JSON in user config → ConfigError with file path
- Error path: malformed JSON in project config → ConfigError with file path
- Error path: timeout is negative → ConfigError
- Error path: timeout is zero → ConfigError (must be positive, consistent with CLI `--timeout 0` rejection)
- Error path: timeout is not a number (string) → ConfigError
- Error path: unknown provider name in config → ConfigError
- Error path: model field on codex provider → warning (not error per R8 — "ignored with a warning")
- Edge case: `~/.devils-advocate/` directory doesn't exist → no error, skip user config
- Edge case: both config files missing → returns defaults (no error)

**Verification:**
- All test scenarios pass
- `loadConfig()` with no args returns object identical to DEFAULTS
- Config validation rejects known-bad inputs with specific error messages including file paths

---

- [ ] **Unit 2: CLI flag extension — `--timeout` and `--disable`**

**Goal:** Extend `parseArgs()` to accept the two new CLI flags that form the highest-priority config layer.

**Requirements:** R4, R12

**Dependencies:** None

**Files:**
- Modify: `scripts/review.mjs`
- Modify: `tests/review.test.mjs`

**Approach:**
- Add `"--timeout"` and `"--disable"` to `knownFlags` Set
- `--timeout` handling: next token parsed as number, validated positive. Stored in `args.timeout`
- `--disable` handling: collect subsequent non-flag tokens and accumulate into `args.disable[]`. Unlike `--files` (which replaces), repeated `--disable` invocations append — `--disable codex --disable gemini` produces `["codex", "gemini"]`
- Extend `ReviewArgs` JSDoc typedef with `timeout?: number` and `disable?: string[]`
- Invalid `--timeout` value (non-numeric, negative, zero) → print usage error and exit (existing pattern)

**Patterns to follow:**
- `--branch` case in `parseArgs()` — single value extraction
- `--files` case in `parseArgs()` — multi-value collection

**Test scenarios:**
- Happy path: `--timeout 60` → `args.timeout === 60`
- Happy path: `--disable gemini` → `args.disable === ["gemini"]`
- Happy path: `--disable codex gemini` → `args.disable === ["codex", "gemini"]`
- Happy path: `--disable codex --disable gemini` → `args.disable === ["codex", "gemini"]`
- Happy path: combined flags `--timeout 60 --disable gemini --branch main` → all parsed correctly
- Edge case: `--timeout` without value → error
- Edge case: `--timeout abc` → error (non-numeric)
- Edge case: `--timeout -5` → error (negative)
- Edge case: `--timeout 0` → error (zero)
- Edge case: `--disable` without value → error: `Flag "--disable" requires at least one provider name.` (matches `--files` pattern)

**Verification:**
- Existing parseArgs tests still pass (no regression)
- New flags parse correctly in isolation and combination
- Invalid values produce clear error messages

---

- [ ] **Unit 3: Claude model and provider timeout injection**

**Goal:** Make `buildClaudeProvider` accept `model` and `timeoutMs` parameters instead of hardcoding `"sonnet"` and `DEFAULT_TIMEOUT_MS`. Each provider factory also needs `timeoutMs` injection so configured timeouts reach provider-level abort controllers.

**Requirements:** R8, R10

**Dependencies:** None

**Files:**
- Modify: `scripts/lib/providers/claude.mjs`
- Modify: `scripts/lib/providers/codex.mjs`
- Modify: `scripts/lib/providers/gemini.mjs`
- Modify: `tests/claude.test.mjs`
- Modify: `tests/codex.test.mjs`
- Modify: `tests/gemini.test.mjs`

**Approach:**
- Claude: Add `model` and `timeoutMs` to deps: `buildClaudeProvider({ spawnFn, model = "sonnet", timeoutMs = DEFAULT_TIMEOUT_MS } = {})`. Close over both in the factory — `model` replaces hardcoded `"sonnet"` in both branches of the args array (stdin and inline-arg paths), `timeoutMs` replaces the hardcoded timeout in the AbortController setTimeout.
- Codex: Add `timeoutMs` to deps: `createCodexProvider(spawnFn, { timeoutMs = DEFAULT_TIMEOUT_MS } = {})`. Use in the internal timeout logic.
- Gemini: Add `timeoutMs` to deps: `buildGeminiProvider({ spawnFn, readFileFn, timeoutMs = DEFAULT_TIMEOUT_MS })`. Use in the internal timeout logic.
- All exported singletons keep defaults (backward compat). Fresh instances with config values created by `buildProviders(config)` in Unit 4.

**Patterns to follow:**
- Existing `{ spawnFn }` deps pattern in all three providers

**Test scenarios:**
- Happy path: default Claude factory → uses "sonnet" in CLI args
- Happy path: `buildClaudeProvider({ model: "opus" })` → passes "opus" to CLI
- Happy path: `buildClaudeProvider({ model: "haiku" })` → passes "haiku" to CLI
- Happy path: `buildClaudeProvider({ timeoutMs: 60000 })` → abort fires at 60s not 120s
- Happy path: `createCodexProvider(spawn, { timeoutMs: 60000 })` → uses 60s timeout
- Happy path: `buildGeminiProvider({ timeoutMs: 60000 })` → uses 60s timeout
- Integration: model and timeoutMs values flow through to spawned command behavior (verify via mock spawnFn and timer assertions)

**Verification:**
- Existing provider tests pass unchanged (default behavior preserved)
- New params flow through to spawned CLI args and timeout logic
- Custom timeoutMs overrides the internal DEFAULT_TIMEOUT_MS

---

- [ ] **Unit 4: Pipeline integration — wire config into review.mjs**

**Goal:** Connect the config module to the review pipeline: load config, filter providers, pass timeout, inject model.

**Requirements:** R1, R9, R10, R11, R12, R13, R14, R15

**Dependencies:** Unit 1, Unit 2, Unit 3

**Files:**
- Modify: `scripts/review.mjs`
- Modify: `scripts/lib/providers/codex.mjs`
- Modify: `scripts/lib/providers/gemini.mjs`
- Modify: `tests/review.test.mjs`

**Approach:**
- Import `loadConfig` from `./lib/config.mjs`
- In `runReview()`, after `parseArgs()` but before `buildProviders()`:
  - Build CLI overrides object from `args.timeout` and `args.disable`
  - Call `const config = await loadConfig(cliOverrides)`
  - Update the `buildProviders()` call to pass config: `buildProviders(config)`
- Modify `buildProviders(config)`:
  - Only construct providers where `config.providers[name].enabled !== false`
  - Check enabled count ≥ 2 BEFORE calling detect — throw early with config-aware message: "At least 2 providers must be enabled. Currently enabled: [names]. Check your config or --disable flags." This is cheaper than wasting detect calls and gives a better error than orchestrate.mjs's generic R5 gate (which remains as a safety net for detect failures).
  - For Claude: call `buildClaudeProvider({ model: config.providers.claude.model, timeoutMs: config.timeout * 1000 })` instead of using singleton
  - For Codex/Gemini: pass `timeoutMs: config.timeout * 1000` to their factories (each provider has its own internal `DEFAULT_TIMEOUT_MS` that must be overridden — without this, providers self-terminate at 120s regardless of configured timeout)
  - Return array of enabled, detected providers
- Pass timeout: `orchestrate(diffResult, providers, { timeout: config.timeout * 1000 })`
- Pass resolved config to `generateReport()` (for Unit 5)
- Catch `ConfigError` in `main()` → stderr message with file path, exit code 2 (insert before existing generic catch)

**Patterns to follow:**
- Existing `runReview(args, providers?)` optional override pattern for testing
- Existing error catch in `main()` for `R5Error`

**Test scenarios:**
- Happy path: no config files, no CLI flags → all providers enabled, timeout 120s (backward compat)
- Happy path: config disables gemini → only codex + claude passed to orchestrator
- Happy path: `--disable codex` → codex not in provider list
- Happy path: `--timeout 60` → orchestrator receives `timeout: 60000`
- Happy path: config sets `claude.model: "opus"` → Claude provider constructed with opus
- Error path: config disables all providers → R5Error (fewer than 2 active)
- Error path: config disables 2 of 3 → R5Error (fewer than 2 active)
- Error path: ConfigError from malformed config file → caught, stderr, exit 2
- Integration: CLI `--disable` overrides config `enabled: true`
- Edge case: provider disabled by config but also fails detect → only one failure message (not both)

**Verification:**
- Full pipeline runs with default config (zero regression from V1)
- Disabled providers are never constructed or detected
- Timeout reaches orchestrator in milliseconds
- ConfigError displays file path and field in error message

---

- [ ] **Unit 5: Config header in report output**

**Goal:** Display the resolved configuration in the review output header per R15.

**Requirements:** R15

**Dependencies:** Unit 4

**Files:**
- Modify: `scripts/lib/report.mjs`
- Modify: `tests/report.test.mjs`

**Approach:**
- Add `config` to `generateReport(matchResult, failures, options)` options object
- Render config line at the top of the report: `Providers: codex, claude (sonnet) | Timeout: 120s | Disabled: gemini`
- "Providers" segment shows actually-active providers (those that produced results — derived from `matchResult` keys), not merely config-enabled. A provider can be enabled but fail detect.
- "Disabled" segment shows config-disabled providers (from `config.providers` where `enabled === false`).
- Format: active provider names, parenthetical model if non-default, timeout in seconds (from config object, which stores human-readable seconds), disabled list (if any)
- If no providers are disabled, omit the `Disabled:` segment

**Patterns to follow:**
- Existing `generateReport` options parameter pattern

**Test scenarios:**
- Happy path: all providers enabled, default model → `Providers: codex, gemini, claude (sonnet) | Timeout: 120s`
- Happy path: gemini disabled → `Providers: codex, claude (sonnet) | Timeout: 120s | Disabled: gemini`
- Happy path: custom timeout → `Timeout: 60s`
- Happy path: custom model → `claude (opus)` in provider list
- Edge case: no config passed (backward compat) → no config header line (graceful absence)
- Edge case: multiple disabled → `Disabled: codex, gemini`

**Verification:**
- Report output contains config header matching the format spec
- Existing report tests pass (no config = no header = no regression)

## System-Wide Impact

- **Interaction graph:** Config is loaded once in `runReview()` and flows one-way through `buildProviders()`, `orchestrate()`, and `generateReport()`. No callbacks, no observers, no circular dependencies.
- **Error propagation:** `ConfigError` thrown during load, caught in `main()`, rendered to stderr. Does not reach orchestrator or providers.
- **State lifecycle risks:** Config is frozen after load — no mutation, no partial-write risk. File reads are atomic (JSON.parse of full file content).
- **API surface parity:** The `/da:review` slash command in `skills/review/SKILL.md` passes `$ARGUMENTS` to review.mjs. New `--timeout` and `--disable` flags are automatically available to the skill. No SKILL.md changes needed.
- **Integration coverage:** Unit 4 tests must verify the full pipeline (args → config → provider filtering → orchestrator options) with mock providers, not just individual functions.
- **Unchanged invariants:** R5 gate (minimum 2 providers) still enforced by orchestrate.mjs. Provider detection still runs for enabled providers. Output validation (R10a) unchanged. Prompt template unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Config disables too many providers → R5Error | Clear error message: "At least 2 providers must be enabled. Currently enabled: [list]" |
| User creates malformed JSON → confusing failure | R14: ConfigError includes exact file path, JSON parse position, and the specific validation failure |
| `process.cwd()` not repo root in edge cases | Claude Code plugins always run from repo root. Document assumption. If wrong, `.da.json` simply isn't found (silent, uses defaults). |
| Deep merge edge case with arrays | Arrays are leaf-replaced, not concatenated. Document in README config example. |

## Sources & References

- **Origin document:** [docs/brainstorms/config-system-requirements.md](docs/brainstorms/config-system-requirements.md)
- Related code: `scripts/review.mjs`, `scripts/lib/orchestrate.mjs`, `scripts/lib/providers/claude.mjs`
- Existing DI pattern: `scripts/lib/providers/gemini.mjs` (injectable readFileFn)
- Error pattern: `scripts/lib/orchestrate.mjs` (R5Error class)
