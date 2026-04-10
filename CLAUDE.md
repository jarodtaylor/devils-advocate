# Devil's Advocate

Multi-model adversarial code review plugin for Claude Code. Sends diffs to external AI tools (Codex, Gemini CLI) in parallel, then synthesizes a structured disagreement report. Claude orchestrates — it never reviews.

## Project State

Pre-implementation. Requirements finalized at `docs/brainstorms/devils-advocate-v1-requirements.md`. Next step: `/ce:plan` for implementation planning.

## Tech Stack

- **Language:** TypeScript (Claude Code plugin)
- **Distribution:** Claude Code plugin (`/da:review` slash command)
- **V1 Providers:** Codex CLI (`codex exec --json`), Gemini CLI (`gemini -p "..." -o json`)
- **License:** MIT

## Architecture Constraints

- **Claude never reviews.** Claude is the orchestrator and synthesizer. External tools do the reviewing. This is the core invariant.
- **Subscription auth first.** Reuse existing CLI auth (Codex OAuth via `codex login status`, Gemini via `~/.gemini/oauth_creds.json`). No API keys in V1.
- **Minimum 2 providers.** Hard fail if fewer than 2 active providers — the product is disagreement, not single-model review.
- **Structured disagreement, not consensus.** Surface where models diverge. Don't flatten to agreement.
- **Provider interface.** Typed adapter pattern. Adding a provider = implementing the interface, no orchestration changes.
- **Uniform diff delivery.** Orchestrator pre-computes the diff and passes it as prompt context. Providers don't resolve git state.
- **Output validation is the trust boundary.** Validate provider JSON before synthesis. Malformed output = provider failure.

## CLI Reference

```bash
# Codex headless
codex exec --json "prompt"        # JSONL event stream to stdout
codex exec -o result.txt "prompt" # final message to file
codex login status                # exit 0 = authenticated

# Gemini headless
gemini -p "prompt" -o json        # JSON envelope: {session_id, response, stats}
# No auth-check command — read ~/.gemini/oauth_creds.json + expiry_date field
```

## Key Reference Repos

- `openai/codex-plugin-cc` — Codex plugin for Claude Code (OpenAI's reference, JS ESM)
- `nyldn/claude-octopus` — Multi-model orchestrator (85% Bash — learn from its mistakes)
- `AltimateAI/claude-consensus` — Multi-model consensus via OpenRouter (API key approach)

## Development Rules

- Feature branches only. Never commit to main. Branch naming: `<type>/<short-description>`.
- Read existing code before modifying. Follow established patterns.
- Every change needs a clear "why."
- Verify before marking complete — run tests, check types, demonstrate correctness.
- Use `find-docs` skill for library documentation. Don't rely on training data for API signatures.
