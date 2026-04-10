---
date: 2026-04-10
topic: devils-advocate-v1
---

# Devil's Advocate — Multi-Model Adversarial Code Review

## Problem Frame

Developers using AI coding tools get reviews from the same model that wrote or assisted with the code. This creates a sycophancy problem — the model is unlikely to catch its own blind spots. Existing multi-model review tools (claude-consensus, multi_mcp, claude-octopus) address this by fanning out to multiple models, but they all share the same weaknesses: they seek consensus instead of surfacing disagreement, they require API keys instead of leveraging existing subscriptions, and they try to do too much beyond code review.

Devil's Advocate is an open source Claude Code plugin focused exclusively on adversarial code review using the AI coding tools developers already pay for. It sends work to external reviewers (never the host model), runs them independently in parallel, and presents results as structured disagreement — highlighting where reviewers diverge, not smoothing it over. The disagreements are the signal.

## User Flow

```
┌─────────────────────────────────────┐
│  Developer working in Claude Code   │
│  on a feature branch                │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Invokes /da:review                 │
│  (auto-detects diff target or       │
│   user specifies --branch, etc.)    │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Devil's Advocate collects diff     │
│  and detects available providers    │
│  (Codex, Gemini CLI installed?)     │
└──────────────┬──────────────────────┘
               │
        ┌──────┴──────┐
        ▼             ▼
┌──────────────┐ ┌──────────────┐
│ Codex review │ │ Gemini review│
│ (parallel)   │ │ (parallel)   │
└──────┬───────┘ └──────┬───────┘
       │                │
       └───────┬────────┘
               ▼
┌─────────────────────────────────────┐
│  Synthesize structured              │
│  disagreement report                │
│  (consensus / disagreements /       │
│   provider-only findings)           │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Present report to developer        │
│  in Claude Code                     │
└─────────────────────────────────────┘
```

## Requirements

**Provider System**

- R1. Define a typed provider interface that each AI tool adapter implements. The interface covers: capability detection (is the CLI installed and authenticated?), review invocation (send diff, receive structured findings), and output normalization (map provider-specific output to a common finding format).
- R2. Ship V1 with two built-in providers: Codex CLI and Gemini CLI.
- R3. Each provider discovers and reuses the user's existing subscription authentication — Codex OAuth via `codex login status`, Gemini OAuth via `~/.gemini/oauth_creds.json`. V1 focuses exclusively on subscription auth; API key support is deferred (see Scope Boundaries).
- R4. Providers run reviews in parallel and independently. No provider sees another provider's output.
- R5. Require a minimum of two active providers to produce a disagreement report. If fewer than two providers are available (not installed, not authenticated, rate-limited, or returning errors), fail with a clear error listing which providers were detected and their status — do not silently degrade to a single-provider review, as the core value proposition requires cross-provider comparison. Provider errors (rate limits, auth expiry, network failures) are treated the same as unavailability for the minimum-provider check.

**Review Target**

- R6. Default review target is auto-detected from git state: uncommitted/staged changes if the working tree is dirty, branch diff against the base branch if clean.
- R7. Support explicit overrides: `--branch <name>`, `--worktree <path>`, `--diff <ref1>..<ref2>`, and `--files <paths>`.
- R8. Work correctly when invoked from within a git worktree, not just the main working tree.

**Review Execution**

- R9. The orchestrator pre-computes the diff (from the review target in R6/R7) and passes it as prompt context to each provider. This is the uniform diff-delivery mechanism — providers do not resolve git state themselves. Each provider receives the diff content and a review prompt that instructs it to act as an adversarial reviewer — find what's wrong, not validate what's right.
- R10. Require each provider to return findings in a structured format: location (file + line range), severity (HIGH/MEDIUM/LOW), description, and rationale. Structured output is enforced via the review prompt (instructing the model to return JSON) and validated by the orchestrator after receipt. Neither Codex's review subcommand nor Gemini CLI support native JSON schema enforcement on output — this is a prompt engineering + post-processing concern, not a CLI flag.
- R11. Set a reasonable timeout per provider. If a provider times out, discard its output and treat it as unavailable per R5. Partial results from interrupted processes may be malformed or incomplete; discarding is simpler and safer than attempting to validate and label fragments.

**Output Validation**

- R10a. Validate provider output against the expected JSON structure before passing it to synthesis. Malformed, truncated, or non-JSON output is treated as a provider failure (provider becomes unavailable per R5). The R5 minimum-provider check is re-evaluated after all provider outputs are validated — if post-validation active provider count drops below two, fail with the same structured error as the pre-dispatch check, identifying which providers returned invalid output. This is the trust boundary between external CLI output and the synthesis logic.

**Output — Structured Disagreement Report**

- R12. Present a synthesized report with four sections: (1) Consensus — findings all active providers agree on, (2) Disagreements — findings where providers assign different severities or contradict each other, (3) Provider-only findings — issues caught by only one provider, (4) Summary statistics (provider count, findings count, agreement rate).
- R13. Match findings across providers by file location (file path + overlapping line range). Exact string matching is too brittle; location-based matching is sufficient for V1 with two providers. Semantic similarity (embeddings) is deferred — it would require an LLM call that either violates "Claude never reviews" or introduces an external API dependency.
- R14. In the disagreements section, show each provider's assessment side-by-side so the developer can make the call.
- R15. Support a `--verbose` flag that appends the full raw review from each provider below the synthesized report.

**Distribution**

- R16. Distribute as a Claude Code plugin. Primary path: plugin marketplace if it accepts third-party submissions. Fallback: direct GitHub install via `claude plugin add <repo>` or manual installation. Distribution path must be verified during planning.
- R17. Invoke via `/da:review` slash command within Claude Code.
- R18. Open source under MIT license.

## Success Criteria

- A developer with Codex and Gemini CLI installed and authenticated can run `/da:review` and get a structured disagreement report with zero additional configuration.
- Given a test diff of 50+ changed lines across multiple files, providers produce at least one finding where they assign different severities or where only one provider flags the issue. This validates that the tool surfaces divergence rather than producing identical reviews.
- Adding a new provider requires implementing the provider interface only — no changes to orchestration or synthesis logic.
- The tool never uses the host model (Claude) as a reviewer. Claude orchestrates and synthesizes, external tools review.

## Scope Boundaries

- **V1 only:** Independent parallel review mode. Debate-style and roles-based modes are future work.
- **V1 only:** Codex and Gemini CLI providers. Kimi Code, Cursor, Aider are future providers.
- **Out of scope:** API key / OpenRouter integration. V1 focuses on subscription auth reuse.
- **Out of scope:** PR workflow integration (auto-commenting on PRs, CI/CD hooks).
- **Out of scope:** Tmux/multiplexer live visibility of review agents (captured for future exploration).
- **Out of scope:** MCP server distribution. V1 is Claude Code plugin only.
- **Out of scope:** Cost tracking or usage metering.
- **Out of scope:** Secrets scanning/redaction of diff content before transmission. V1 relies on the same trust model as the provider CLIs themselves — if you trust `codex exec` with your code, you trust Devil's Advocate sending it. Document this clearly in the README so users make informed decisions about sensitive codebases.
- **Out of scope:** First-run consent/disclosure prompt. V1 assumes that installing the plugin and having provider CLIs authenticated constitutes informed consent. Consider for V2 if enterprise adoption is a goal.

## Key Decisions

- **TypeScript for implementation:** Claude Code plugins are TypeScript-native, the Claude Agent SDK has a TS package, the codex-plugin-cc reference implementation is JS/TS, and it's the lowest barrier for open source contributions in this ecosystem.
- **CLI-first provider integration (not API):** Shelling out to `codex exec` and `gemini -p` is the only way to reuse subscription OAuth tokens. API adapters can't access CLI-stored OAuth credentials.
- **Structured disagreement over consensus:** Devil's Advocate highlights where models disagree rather than seeking agreement. This is the core product differentiation from claude-consensus, octopus, and multi_mcp.
- **Claude never reviews:** Claude is the orchestrator and synthesizer, never a reviewer. "Claude reviewing its own code is like reviewing your own PR."
- **Provider interface for extensibility:** Typed interface rather than shell-level duck typing (learned from octopus's 85% Bash architecture). Makes adding providers testable and community-friendly.

## Dependencies / Assumptions

- User has Claude Code installed (host environment).
- User has at least one supported provider CLI installed and authenticated.
- Provider CLIs maintain their current headless mode interfaces (`codex exec --json`, `gemini -p --output-format json`). Breaking changes in provider CLIs would require adapter updates.
- Codex subscription (ChatGPT Plus/Pro/Max) includes CLI access with OAuth. Auth detection should use `codex login status` (exit code 0 = authenticated) rather than directly reading token files, as token files lack expiry information and the CLI status check is the canonical pattern used by codex-plugin-cc.
- Gemini CLI works with Google account OAuth at the free tier (1,000 req/day) or paid tiers. Auth credentials are stored at `~/.gemini/oauth_creds.json` with an `expiry_date` epoch-millisecond field that can be checked for token validity.

## Outstanding Questions

### Resolve Before Planning

(All resolved.)

- [Resolved] CLI headless interfaces verified: `codex exec --json "prompt"` and `gemini -p "prompt" -o json` both work. Codex requires prompt as argument or stdin. Gemini uses `-p` for prompt (requires string value) and `-o`/`--output-format` for output format with choices `text`, `json`, `stream-json`.
- [Resolved] Gemini CLI has no auth-check command. Available commands: `mcp`, `extensions`, `skills`, `hooks` — no `auth`, `login`, or `status` subcommand. Auth detection must use the file-read approach (`~/.gemini/oauth_creds.json` with `expiry_date` check) as best-effort, with runtime auth failures during review execution caught by R5.

### Deferred to Planning

- [Affects R10][Needs research] What JSON structure should the adversarial review prompt instruct providers to return? Neither Codex review nor Gemini CLI support native schema enforcement flags — structured output is achieved via prompt engineering and post-receipt validation. Needs testing against real diffs to determine reliability of prompt-only schema enforcement.
- [Affects R13][Technical] Implement location-based finding matching (file path + overlapping line range). Determine thresholds for "overlapping" — exact line match vs. within N lines of each other. Semantic similarity deferred to post-V1.
- [Affects R9, R13][Needs research] How should the adversarial review prompt be structured? The codex-plugin-cc adversarial prompt (`prompts/adversarial-review.md`) is a strong starting point — prioritized attack surfaces, finding bar, grounding rules. The prompt must also specify the line-number coordinate system (file-absolute, not diff-relative) so that R13's location-based matching works across providers.
- [Affects R16][Technical] Claude Code plugin packaging: `plugin.json` manifest structure, command file format, companion script pattern. Reference codex-plugin-cc for the pattern.
- [Affects R16][Needs research] Verify whether the Claude Code plugin marketplace accepts third-party submissions, or if distribution must use `claude plugin add <github-repo>` / manual install. Determines the installation instructions and zero-config feasibility.
- [Affects R7][Technical] User-supplied values for --branch, --worktree, --diff, --files must be passed as discrete arguments to child_process.spawn (never interpolated into shell strings) to prevent command injection. Validate branch/path values against safe patterns.

## Next Steps

-> `/ce:plan` for structured implementation planning
