# Devil's Advocate

Multi-model adversarial code review plugin for [Claude Code](https://claude.ai/code).

Sends your diffs to external AI coding tools in parallel, then synthesizes a **structured disagreement report** — highlighting where models diverge, not flattening to consensus. The disagreements are the signal.

## How It Works

1. You invoke `/da:review` in Claude Code
2. Devil's Advocate collects your diff and sends it to multiple AI reviewers — **Codex**, **Gemini**, and **Claude** — running in parallel
3. Each reviewer independently analyzes the code as an adversarial critic
4. Results are synthesized into a report with four sections:
   - **Consensus** — findings all reviewers agree on (high confidence)
   - **Disagreements** — same location, different severity or interpretation (the interesting ones)
   - **Provider-only** — findings only one reviewer caught (worth investigating)
   - **Summary stats** — agreement rate across reviewers

Claude orchestrates and synthesizes — it never reviews its own code. The external tools do the reviewing. This is a core architectural invariant.

## Example Output

```markdown
## Devil's Advocate Review

**Providers:** codex, gemini, claude (sonnet) | **Timeout:** 120s

**Total findings:** 8
**Consensus:** 2 | **Disagreements:** 3 | **Provider-only:** 3
**Agreement rate:** 40% (among matched findings)

### Consensus

- [HIGH] **SQL injection in user lookup**
  - **Location:** `src/db.ts:42-45`
  - **Providers:** codex, gemini, claude
  - User input flows directly to `db.query()` without parameterization.

### Disagreements

| Finding | Location | codex | gemini | claude |
| --- | --- | --- | --- | --- |
| Unvalidated redirect | `src/auth.ts:110` | [HIGH] Open redirect | [MEDIUM] Should validate target | [LOW] Rate limit recommended |

### Provider-only findings

#### gemini
- [MEDIUM] **Missing null check on optional chain**
  - **Location:** `src/utils.ts:55`
```

## Requirements

- [Claude Code](https://claude.ai/code) installed
- **At least two** of the following AI CLI tools installed and authenticated. Devil's Advocate hard-fails if fewer than 2 are available:

  | Provider | Install | Auth | Notes |
  |----------|---------|------|-------|
  | **Codex** | `npm i -g @openai/codex` | `codex login` (uses ChatGPT subscription) | Works with Plus/Team/Enterprise |
  | **Gemini** | [`@google/gemini-cli`](https://github.com/google-gemini/gemini-cli) | `gemini` (Google OAuth on first run) | Free tier: 1,000 req/day |
  | **Claude** | Already installed if you're using Claude Code | Already authed in Claude Code sessions | Model selection supported (`sonnet`, `opus`, `haiku`) |

## Installation

```bash
# From the Claude Code plugin marketplace (recommended)
/plugin install devils-advocate

# Or directly from GitHub
claude plugin add jarodtaylor/devils-advocate
```

## Usage

### Basic

```bash
# Review uncommitted changes (auto-detects working tree vs staged)
/da:review

# Review a specific branch (diff against merge-base with current)
/da:review --branch feat/user-auth

# Review an explicit git diff range
/da:review --diff main..HEAD

# Limit the review to specific files
/da:review --files src/auth.ts src/middleware/session.ts

# Run from a different git worktree
/da:review --worktree /path/to/other/worktree

# Include raw provider output (debugging)
/da:review --verbose
```

### Configuration overrides

```bash
# Skip a specific provider for this invocation
/da:review --disable gemini

# Skip multiple providers
/da:review --disable codex gemini

# Override the per-provider timeout (seconds)
/da:review --timeout 180

# Combine flags
/da:review --branch main --disable gemini --timeout 60
```

## Configuration

Devil's Advocate resolves configuration from four layers, highest priority first:

1. **CLI flags** — `--disable`, `--timeout` (per-invocation)
2. **Project config** — `.da.json` at the repo root (check into git, team-shared)
3. **User config** — `~/.devils-advocate/config.json` (per-user, never committed)
4. **Built-in defaults** — all providers enabled, Claude uses `sonnet`, 120s timeout

All fields are optional. Missing fields inherit from the next layer down. An empty `{}` file is valid.

### Example: user config

Disable Gemini for all your reviews and bump the timeout:

```json
{
  "providers": {
    "gemini": { "enabled": false }
  },
  "timeout": 180
}
```

### Example: project config

Team-shared settings committed to the repo — enforce Claude on `opus` for this project:

```json
{
  "providers": {
    "claude": { "model": "opus" }
  }
}
```

### Config reference

```json
{
  "providers": {
    "codex":  { "enabled": true },
    "gemini": { "enabled": true },
    "claude": { "enabled": true, "model": "sonnet" }
  },
  "timeout": 120
}
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `providers.codex.enabled` | boolean | `true` | Set to `false` to skip Codex entirely (no detect, no review) |
| `providers.gemini.enabled` | boolean | `true` | Set to `false` to skip Gemini entirely |
| `providers.claude.enabled` | boolean | `true` | Set to `false` to skip Claude entirely |
| `providers.claude.model` | string | `"sonnet"` | Claude model identifier (`sonnet`, `opus`, `haiku`). Only Claude supports model selection in v0.1.0 — Codex and Gemini use their CLI's default model. |
| `timeout` | number | `120` | Per-provider timeout in **seconds**. Applied uniformly to all providers. |

**Unknown provider names or the `model` field on non-Claude providers** produce a clear error with the file path, so typos fail fast.

**Minimum 2 providers:** if your config disables enough providers that fewer than 2 remain enabled, `/da:review` will refuse to run with a clear error message.

## Trust Model

Devil's Advocate sends your code diffs and affected file content to external AI services (OpenAI for Codex, Google for Gemini, Anthropic for Claude) for analysis. This uses the same trust model as the provider CLIs themselves — if you trust running `codex exec`, `gemini -p`, or `claude -p` directly on your code, you trust this plugin.

**Do not use on codebases containing secrets, credentials, or sensitive data you wouldn't send to these services.**

Diff and file content are wrapped in XML delimiter tags (`<diff>`, `<files>`) to reduce the risk of prompt injection from malicious code comments. Provider output is validated through a trust-boundary layer before being synthesized into the report — malformed output is treated as a provider failure, not a user-visible result.

## Troubleshooting

### "At least 2 providers must be enabled"

You hit the minimum-providers gate. Either a provider CLI isn't installed/authed, or your config disabled too many. Check with:

```bash
codex login status       # exit 0 = authed
cat ~/.gemini/oauth_creds.json | grep expiry_date   # should be in the future
command -v claude         # should print a path if Claude Code is installed
```

Then verify your config doesn't disable more than one:

```bash
cat ~/.devils-advocate/config.json 2>/dev/null
cat .da.json 2>/dev/null
```

### "Invalid config at /path/to/.da.json"

Your config file has a JSON syntax error or invalid field. The error message includes the file path and the specific field. Common causes:

- Trailing commas (not valid in JSON)
- Negative or zero `timeout` (must be a positive number)
- `model` field set on Codex or Gemini (only `claude` supports `model` in v0.1.0)
- Unknown provider names (must be `codex`, `gemini`, or `claude`)

### Provider review takes too long

Bump the timeout for that invocation:

```bash
/da:review --timeout 300
```

Or set it globally in your user config.

### Nothing to review / empty diff

Devil's Advocate only reviews actual changes. Either commit your work, stage it, or use `--branch` / `--diff` to target a specific comparison.

## Language & Build

**This project is written in ESM JavaScript (`.mjs` files), not TypeScript.**

If you're expecting `.ts` files when you open the repo, you won't find them. What you *will* find is extensive **JSDoc type annotations** that give the code full TypeScript-grade type checking via `tsc --noEmit --checkJs`. Every function is typed, every parameter is annotated, and `npm run check` fails on any type error — just like a real TypeScript project.

Why this approach instead of TypeScript:

- **No build step.** Contributors clone and go. The source files in `scripts/` are the exact files Node executes. No `dist/` directory, no `npm run build`, no compiled output to audit.
- **Node 18+ compatibility.** Claude Code requires Node >= 18. Node's native TypeScript support (type stripping) only became stable in Node 22.18+ and 23+, so requiring `.ts` files at runtime would narrow our user base.
- **Source is the shipped artifact.** When you inspect the plugin, you inspect the exact code that runs. Nothing compiled, nothing minified. Important for a tool you're giving access to your diffs.
- **Full type safety without the ceremony.** JSDoc is more verbose than TypeScript syntax for complex types, but the type checker catches the same errors. We run `tsc --noEmit --checkJs` in CI on every PR.

Example of how types look:

```javascript
/**
 * @typedef {Object} ReviewArgs
 * @property {string} [branch]
 * @property {number} [timeout]
 * @property {string[]} disable
 */

/**
 * @param {string[]} argv
 * @returns {ReviewArgs}
 */
export function parseArgs(argv) {
  // ...
}
```

If you're used to TypeScript and find this awkward, [JSDoc's type syntax reference](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html) covers everything you need. Most complex types you'd write in TS have a JSDoc equivalent.

## Contributing

Pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Dev setup (`npm install`, `npm test`, `npm run check`)
- Architectural invariants (the non-negotiable rules)
- Branch naming, commit conventions, and review expectations

All contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

**Please do not file public issues for security vulnerabilities.** Report them privately via [GitHub Security Advisories](https://github.com/jarodtaylor/devils-advocate/security/advisories/new). See [SECURITY.md](SECURITY.md) for the full policy, including what's in and out of scope.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes. This project follows [Semantic Versioning](https://semver.org/) — pre-1.0 releases may include breaking changes in minor bumps, as is convention for 0.x.

## License

MIT
