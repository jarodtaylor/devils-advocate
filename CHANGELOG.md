# Changelog

All notable changes to Devil's Advocate will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 versions may include breaking changes in minor bumps, as is convention for 0.x releases.

## [Unreleased]

## [0.1.1] — 2026-04-11

Documentation and messaging clarity patch. No behavior changes.

### Changed

- **Clarified model-selection wording** across the README, CHANGELOG, and the stderr warning in `scripts/lib/config.mjs`. The previous phrasing — "Model selection is Claude-only in V1.1" — was ambiguous and could be misread as "only Claude performs reviews." All three providers (Codex, Gemini, Claude) review every invocation. The limitation is that only Claude supports configurable model selection (`sonnet`, `opus`, `haiku`) via `providers.claude.model`; Codex and Gemini use their CLI's default model.
- Replaced remaining `V1.1` internal shorthand with the actual release version `v0.1.0` in user-facing text.

### Added

- **Language & Build section in README** — prominently documents that this project is ESM JavaScript with JSDoc type annotations, not TypeScript, with the full rationale (Node 18+ compatibility, no build step, source is the shipped artifact). Contributors who open the repo expecting `.ts` files now have a clear explanation and pointer to JSDoc type syntax.
- **Expanded Tech Stack section in CONTRIBUTING.md** — adds a "Why JavaScript + JSDoc and not TypeScript?" subsection covering the same rationale for contributors browsing the contributing guide.
- **Updated CLAUDE.md Language section** — marks the language choice as "Important — not TypeScript" and explains the decision for future Claude Code sessions working on this project.

## [0.1.0] — 2026-04-10

First public release. This version establishes the full adversarial review
pipeline with three providers and a layered configuration system.

### Added

#### Review pipeline

- Multi-model adversarial review via `/da:review` slash command in Claude Code
- **Three provider adapters** — Codex (`@openai/codex`), Gemini (`@google/gemini-cli`), and Claude (the Claude Code CLI). All three use a dependency-injection factory pattern (`createCodexProvider`, `buildGeminiProvider`, `buildClaudeProvider`) for testability.
- **Parallel execution** — all enabled providers review the diff simultaneously, each with its own AbortController-backed timeout
- **Diff collection** with auto-detect — working tree vs staged changes, with override flags for explicit targets
- **Prompt injection defense** — diff and file content wrapped in XML delimiter tags (`<diff>`, `<files>`) before being sent to provider CLIs
- **Output validation (R10a trust boundary)** — parsed provider findings are validated against a JSON schema before synthesis. Malformed output surfaces as a provider failure, not a user-facing result.
- **Structured disagreement report** with four sections: Consensus (all providers agree), Disagreements (same location, different assessments — the interesting ones), Provider-only (only one reviewer caught it), and Summary stats with agreement rate

#### Configuration system

- **Layered config resolution** with four precedence tiers:
  1. CLI flags (`--timeout`, `--disable`)
  2. Project config at `.da.json` in the repo root (version-controllable)
  3. User config at `~/.devils-advocate/config.json`
  4. Built-in defaults (all providers enabled, Claude on `sonnet`, 120s timeout)
- **Deep-merge with leaf-key precedence** — overlays only override present keys, siblings inherit from lower layers
- **Config file I/O** via `node:fs/promises` with injectable `readFileFn` for testing
- **Immutable resolved config** — deep-frozen after load
- **ConfigError class** with structured fields (`filePath`, `field`) and clear error messages that attribute the offending source layer
- **Prototype pollution defense** — `__proto__`, `constructor`, and `prototype` keys rejected at parse time (with defense-in-depth skip in `deepMerge`)
- **Provider config shape validation** — rejects `null`, `false`, strings, and arrays as provider values; requires `enabled` to be boolean and `model` to be string

#### CLI flags

- `--branch <name>` — diff against a branch via merge-base
- `--worktree <path>` — run git commands in a different worktree
- `--diff <range>` — explicit git diff range (e.g. `main..HEAD`)
- `--files <path>...` — limit diff to specific file paths (multi-value)
- `--verbose` — include raw provider output in the report
- `--timeout <seconds>` — override per-provider timeout (validated positive)
- `--disable <provider>...` — skip specific providers for this invocation (accumulates across repeated invocations)

#### Provider-specific features

- **Claude model selection** — configurable via `providers.claude.model` in config file. Supports `sonnet`, `opus`, `haiku`. Codex and Gemini review every invocation but use their CLI's default model — configurable model selection for those two providers is deferred to a future release.
- **Per-provider timeout injection** — `timeoutMs` flows through all three provider factories, overriding internal `DEFAULT_TIMEOUT_MS = 120_000`. Without this, providers would self-terminate at 120s regardless of the configured timeout.
- **Model-on-non-Claude config** — stderr warning rather than hard error (the field is ignored with a clear diagnostic)

#### Output

- **Report header** showing resolved config — active providers (with Claude model annotation), timeout in seconds, disabled providers list. Rendered on both full reports and zero-findings clean runs.
- **Verbose mode raw output** — collapsible HTML `<details>` blocks for each provider's raw CLI output

#### Tooling and safety

- **Minimum 2 providers invariant (R5 gate)** — hard fail with structured error if fewer than 2 providers are enabled/available. Check happens pre-detect in `buildProviders()` for fast failure with config-aware message.
- **Zero runtime dependencies** — ships with its source, auditable. devDependencies are only `typescript` and `@types/node`.
- **265 tests** using `node --test` (built-in runner, `node:assert/strict`). Providers tested with injected spawn mocks — no real CLI execution needed.
- **TypeScript strict mode** via JSDoc (`tsc --noEmit --checkJs`)

### Security

- **GitHub Actions workflows** — automated PR review (Claude Code Action), CodeQL scanning, test runs
- **Dependabot** — weekly updates for npm devDependencies and GitHub Actions
- **Branch protection** on `main` with required status checks (`test`, `Analyze JavaScript`)
- **Secret scanning + push protection** enabled
- **SECURITY.md** with vulnerability reporting policy via GitHub Security Advisories

### Known limitations

- **Model *selection* within a provider** is Claude-only in v0.1.0. All three providers (Codex, Gemini, Claude) perform reviews on every invocation — but only Claude supports choosing which underlying model (`sonnet`, `opus`, `haiku`) via `providers.claude.model` in config. Codex and Gemini use their CLI's default model. Configurable model selection for Codex and Gemini is deferred to a future release pending CLI capability research.
- Config file paths are fixed — `~/.devils-advocate/config.json` and `.da.json` at `process.cwd()`. No environment variable override.
- No interactive setup wizard. Users create config manually based on README examples.

---

[Unreleased]: https://github.com/jarodtaylor/devils-advocate/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/jarodtaylor/devils-advocate/releases/tag/v0.1.1
[0.1.0]: https://github.com/jarodtaylor/devils-advocate/releases/tag/v0.1.0
