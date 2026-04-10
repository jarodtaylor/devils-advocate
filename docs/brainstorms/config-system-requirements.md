---
date: 2026-04-10
topic: config-system
---

# Devil's Advocate Configuration System

## Problem Frame

Devil's Advocate has zero user configuration. Every value is hardcoded — models, timeouts, which providers run. As an open source tool with 3 providers (Codex, Gemini, Claude), users need to customize behavior for their setup: different model preferences, different provider availability, different timeout needs. The config story directly affects adoption.

## Requirements

**Config Layers**

- R1. Support a layered config with clear priority: CLI flags > project config > user config > built-in defaults.
- R2. User-level config stored at `~/.devils-advocate/config.json`. Created manually or copied from README example.
- R3. Project-level config stored at `.da.json` in the repo root. Version-controllable, team-shared.
- R4. CLI flags on `/da:review` for one-off overrides: `--timeout <seconds>`, `--disable <provider>`.
- R5. Built-in defaults match current behavior: all detected providers enabled, Claude uses sonnet, timeout 120s, Codex and Gemini use their CLI defaults.

**Config Shape (Nested)**

- R6. Config file uses nested provider objects:
  ```json
  {
    "providers": {
      "codex": { "enabled": true },
      "gemini": { "enabled": true },
      "claude": { "enabled": true, "model": "sonnet" }
    },
    "timeout": 120
  }
  ```
- R7. All fields are optional. Missing fields inherit from the next config layer down. An empty `{}` file is valid (uses all defaults).
- R8. The `model` field is supported for Claude only in V1.1 (`--model` flag verified). Codex and Gemini model selection is deferred until their CLI model flags are researched. Unknown `model` values for providers that don't support selection are ignored with a warning.
- R9. The `enabled` field controls whether a provider is included in the review. `false` means the provider is not invoked at all — no detect, no review. Disabled providers are filtered out before the orchestrator runs. Default `true` for all installed providers.
- R10. The `timeout` field is global, in seconds (not milliseconds) for human readability. Applied to all providers equally. Converted to milliseconds internally (`× 1000`) before passing to the orchestrator.

**Config Merging**

- R11. Config layers merge via deep merge with leaf-key precedence: start with built-in defaults, overlay user config (only keys present override), overlay project config, overlay CLI flags. For nested objects, each leaf key is resolved independently — e.g., project config setting `providers.codex.enabled` does not erase `providers.claude.model` inherited from user config. Implementation: `scripts/lib/config.mjs` exports `loadConfig(cliOverrides)`, called once in `review.mjs` before building providers.
- R12. CLI flags are the highest priority and override any file-based config for that invocation only.

**Config Loading**

- R13. Config is loaded once at the start of each `/da:review` invocation. No hot-reload, no file watchers.
- R14. Invalid config (malformed JSON, unknown provider names, non-numeric timeout, negative timeout) produces a clear error with the file path and the specific problem. Do not silently ignore bad config.
- R15. When `/da:review` runs, show the resolved config in the output header: "Providers: codex, claude (sonnet) | Timeout: 120s | Disabled: gemini"

## Success Criteria

- A new user installs the plugin and runs `/da:review` with zero configuration — built-in defaults are preserved, behavior is identical to pre-config.
- A user creates `~/.devils-advocate/config.json` with `{"providers": {"gemini": {"enabled": false}}}` and subsequent reviews skip Gemini.
- A team commits `.da.json` to their repo. All team members get the same config without individual setup.
- `/da:review --disable gemini --timeout 180` overrides config for that single invocation.

## Scope Boundaries

- **In scope:** Provider enable/disable, Claude model selection, global timeout, config file loading, CLI flag overrides, config header in output, example config in README.
- **Deferred to V1.2:** `/da:setup` interactive wizard. Users create config manually for now.
- **Deferred to V1.2:** Codex and Gemini model selection (pending CLI flag research).
- **Deferred to V1.2:** `--model <provider>:<model>` CLI flag (only useful once more providers support model selection).
- **Out of scope:** Prompt customization, report format, review focus/lens, per-provider timeout, config migration tooling.

## Key Decisions

- **Nested JSON config (not flat keys):** Provider config groups naturally. Extensible for future per-provider fields. Matches ESLint/tsconfig/Prettier patterns.
- **User-local dotfile (not plugin `userConfig`):** Claude Code's `userConfig` only supports flat string values. Per-provider nested config needs richer structure. Matches claude-octopus pattern.
- **Timeout is global, not per-provider:** Simpler config, matches the R6 structure. Per-provider timeout adds complexity without clear user demand.
- **No wizard for V1.1:** Target audience is devs who can edit JSON. Example config in README + clear error messages is sufficient. Wizard is polish, not necessity.
- **Claude-only model selection for V1.1:** Only Claude's `--model` flag is verified. Don't spec what we can't verify.

## Dependencies / Assumptions

- Claude CLI accepts `--model <name>` flag (verified).
- Codex and Gemini model selection flags are unverified (deferred to V1.2 research).
- `~/.devils-advocate/` directory created automatically on first config write. Missing directory on read is not an error (just no user config).
- Config file I/O in `scripts/lib/config.mjs` using `node:fs/promises`.

## Outstanding Questions

### Deferred to Planning

- [Affects R8][Needs research] Verify Codex CLI and Gemini CLI model selection flags for V1.2.
- [Affects R11][Technical] Deep merge implementation — use a simple recursive merge function, no external dependency.
- [Affects R4][Technical] Extend `parseArgs()` in `review.mjs` to accept `--timeout` and `--disable` flags.

## Next Steps

-> `/ce:plan` for structured implementation planning
